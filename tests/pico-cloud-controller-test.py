"""Host tests for Pico cloud queue logic; all TLS, sockets, and TV APIs are mocked."""

import importlib.util
import json
import pathlib
import sys
import time
import types
import unittest
from unittest.mock import patch


ROOT = pathlib.Path(__file__).resolve().parents[1]
PICO = ROOT / "controller/pico2w"
sys.path.insert(0, str(PICO))
class FakeWLAN:
    IF_STA = 0

    def __init__(self, *_args):
        pass

    def isconnected(self):
        return True


sys.modules["network"] = types.SimpleNamespace(WLAN=FakeWLAN)
sys.modules["ntptime"] = types.SimpleNamespace()
sys.modules["config"] = types.SimpleNamespace(
    WIFI_SSID="ssid", WIFI_PASSWORD="password", TV_IP="192.0.2.2",
    TV_TLS_NAME="MT5581.prod.vizio.com", TV_CERT_SHA256="0" * 64,
    HORIZON_URL="https://horizon-vizio.ali-al-anbari.workers.dev/",
    CLOUD_CA_FILE="cloud-root-isrg-x1.pem", AUTO_LAUNCH_ON_POWER=False,
    SOCKET_TIMEOUT_S=4,
    CLOUD_LIVE_CLAIMING=False,
    IHEART_RETURNS_TO_HORIZON=False, IHEART_POLL_MS=2000,
)
sys.modules["secrets"] = types.SimpleNamespace(
    SMARTCAST_TOKEN="private-tv-test-token", CONTROLLER_TOKEN="private-cloud-test-token-1234567890",
)
spec = importlib.util.spec_from_file_location("horizon_pico_main", PICO / "main.py")
pico = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pico)
import player_bridge


def response(status, body=None, extra_headers=""):
    payload = b"" if body is None else json.dumps(body).encode()
    return (b"HTTP/1.1 %d Test\r\nContent-Length: %d\r\n%s\r\n" %
            (status, len(payload), extra_headers.encode())) + payload


class FakeSocket:
    def __init__(self, data, max_write=None):
        self.data = data
        self.writes = []
        self.closed = False
        self.max_write = max_write

    def write(self, data):
        part = data if self.max_write is None else data[:self.max_write]
        self.writes.append(part)
        return len(part)

    def read(self, _size):
        if self.data == "TIMEOUT":
            raise OSError("read timed out")
        data, self.data = self.data, b""
        return data

    def close(self):
        self.closed = True


class StreamSocket(FakeSocket):
    """One persistent TLS stream; reads never cross the requested byte count."""
    def __init__(self, data, max_write=None, max_read=None):
        super().__init__(data, max_write)
        self.fail_read = False
        self.max_read = max_read

    def read(self, size):
        if self.closed or self.fail_read:
            raise OSError("closed or timed out")
        if self.max_read is not None:
            size = min(size, self.max_read)
        part, self.data = self.data[:size], self.data[size:]
        return part


class ScriptedTVSocket:
    """Framed replies appear only after each complete request is written."""
    def __init__(self, replies, max_write=11):
        self.replies = list(replies)
        self.max_write = max_write
        self.sent = bytearray()
        self.ready = bytearray()
        self.requests = []
        self.closed = False
        self.fail_writes = False

    def write(self, data):
        if self.closed or self.fail_writes:
            raise OSError("stale TV socket")
        part = data[:self.max_write]
        self.sent.extend(part)
        while True:
            marker = self.sent.find(b"\r\n\r\n")
            if marker < 0:
                break
            headers = bytes(self.sent[:marker]).lower()
            length_line = next((line for line in headers.split(b"\r\n")
                                if line.startswith(b"content-length:")), None)
            # Read-only GET has no body; key PUT must carry Content-Length.
            if length_line is None and not headers.startswith(b"get "):
                raise AssertionError("player request must be framed")
            length = int(length_line.split(b":", 1)[1].strip()) if length_line else 0
            end = marker + 4 + length
            if len(self.sent) < end:
                break
            self.requests.append(bytes(self.sent[:end]))
            del self.sent[:end]
            self.ready.extend(self.replies.pop(0))
        return len(part)

    def read(self, size):
        if self.closed or not self.ready:
            raise OSError("TV kept the socket open without more response bytes")
        part = bytes(self.ready[:size])
        del self.ready[:size]
        return part

    def close(self):
        self.closed = True


class ExactReadTVSocket(ScriptedTVSocket):
    """Model a TLS stream whose read(n) waits for n bytes while kept open."""
    def read(self, size):
        if len(self.ready) < size:
            raise OSError("read blocked waiting for requested byte count")
        return super().read(size)


class PicoCloudTests(unittest.TestCase):
    def setUp(self):
        for name, value in (("ticks_ms", lambda: int(time.monotonic() * 1000)),
                            ("ticks_diff", lambda a, b: a - b),
                            ("ticks_add", lambda a, b: a + b)):
            clock_patch = patch.object(pico.time, name, side_effect=value, create=True)
            clock_patch.start()
            self.addCleanup(clock_patch.stop)

    def test_player_keys_are_exact_allowlist_and_never_retry(self):
        for name, (codeset, code) in pico.PLAYER_KEYS.items():
            with self.subTest(name=name), patch.object(pico, "tv_request", return_value={
                    "STATUS": {"RESULT": "SUCCESS"}}) as request:
                self.assertTrue(pico.send_player_command(object(), "test-token", name))
                request.assert_called_once_with(request.call_args.args[0], "test-token", "PUT",
                    "/key_command/", {"KEYLIST": [{"CODESET": codeset, "CODE": code,
                                                     "ACTION": "KEYPRESS"}]}, timing=request.call_args.kwargs["timing"])
        with patch.object(pico, "tv_request") as request:
            with self.assertRaises(ValueError):
                pico.send_player_command(object(), "test-token", "arbitrary_key")
            with self.assertRaises(RuntimeError):
                pico.send_player_command(object(), "", "pause_toggle")
            request.assert_not_called()

    def test_player_rejection_and_ambiguous_transport_failure_are_not_success(self):
        with patch.object(pico, "tv_request", return_value={"STATUS": {"RESULT": "FAILURE"}}) as request:
            self.assertFalse(pico.send_player_command(object(), "test-token", "pause_toggle"))
            request.assert_called_once()
        with patch.object(pico, "tv_request", side_effect=OSError("lost response")) as request:
            self.assertFalse(pico.send_player_command(object(), "test-token", "seek_forward"))
            request.assert_called_once()  # An ambiguous keypress is never replayed.

    def test_player_request_uses_pinned_socket_and_framed_response(self):
        body = {"STATUS": {"RESULT": "SUCCESS"}}
        fake = FakeSocket(response(200, body), max_write=7)
        with patch.object(pico, "open_pinned_socket", return_value=fake) as connect:
            self.assertTrue(pico.send_player_command(object(), "test-token", "seek_backward"))
        connect.assert_called_once()
        sent = b"".join(fake.writes)
        self.assertIn(b"PUT /key_command/ HTTP/1.1\r\n", sent)
        self.assertIn(b"AUTH: test-token\r\n", sent)
        self.assertIn(b'"CODESET": 3', sent)
        self.assertIn(b'"CODE": 1', sent)
        self.assertTrue(fake.closed)

    def test_player_dispatcher_preserves_order_and_rejects_duplicates_and_overflow(self):
        dispatcher = pico.PlayerCommandDispatcher()
        self.assertEqual(dispatcher.offer(1, "seek_forward"), "queued")
        self.assertEqual(dispatcher.offer(1, "seek_forward"), "duplicate")
        self.assertEqual(dispatcher.offer(3, "pause_toggle"), "gap")
        self.assertEqual(dispatcher.offer(2, "seek_backward"), "queued")
        self.assertEqual(dispatcher.offer(3, "arbitrary"), "invalid")
        with patch.object(pico, "send_player_command", side_effect=[True, False]) as send:
            self.assertEqual(dispatcher.run_next(object(), "test-token"), (1, True))
            self.assertEqual(dispatcher.run_next(object(), "test-token"), (2, False))
            self.assertIsNone(dispatcher.run_next(object(), "test-token"))
            self.assertEqual([call.args[2] for call in send.call_args_list],
                             ["seek_forward", "seek_backward"])
        full = pico.PlayerCommandDispatcher()
        for sequence in range(1, pico.PLAYER_QUEUE_LIMIT + 1):
            self.assertEqual(full.offer(sequence, "seek_forward"), "queued")
        self.assertEqual(full.offer(pico.PLAYER_QUEUE_LIMIT + 1, "seek_forward"), "full")
        self.assertEqual(len(full.pending), pico.PLAYER_QUEUE_LIMIT)

    def test_supervised_player_action_requires_explicit_call_and_pinned_context(self):
        with patch.object(pico, "connect_wifi", return_value=True), \
             patch.object(pico, "synchronize_time"), \
             patch.object(pico, "tls_context", return_value="pinned-context") as context, \
             patch.object(pico, "send_player_command", return_value=True) as send:
            self.assertTrue(pico.supervised_player_command("pause_toggle"))
        context.assert_called_once()
        send.assert_called_once_with("pinned-context", "private-tv-test-token", "pause_toggle")
        with patch.object(pico, "send_player_command") as send:
            with self.assertRaises(ValueError):
                pico.supervised_player_command("back")
            send.assert_not_called()

    def test_prepared_player_session_does_not_send_or_connect_before_explicit_action(self):
        with patch.object(pico, "connect_wifi", return_value=True), \
             patch.object(pico, "synchronize_time"), \
             patch.object(pico, "tls_context", return_value="pinned-context"), \
             patch.object(pico, "open_pinned_socket") as connect, \
             patch.object(pico, "send_player_command", return_value=True) as send:
            prepared = pico.prepare_supervised_player_session()
            connect.assert_not_called()
            send.assert_not_called()
            self.assertTrue(prepared.send("seek_forward"))
            send.assert_called_once_with("pinned-context", "private-tv-test-token",
                                         "seek_forward", prepared.connection)
            prepared.close()
            with self.assertRaises(RuntimeError):
                prepared.send("seek_forward")

    def test_player_keepalive_reuses_one_pinned_tls_socket_with_partial_writes(self):
        ack = response(200, {"STATUS": {"RESULT": "SUCCESS"}})
        fake = ExactReadTVSocket([ack, ack])
        session = pico.TVPlayerConnection(object())
        with patch.object(pico, "open_pinned_socket", return_value=fake) as connect:
            self.assertTrue(pico.send_player_command(session.context, "test-token", "seek_forward", session))
            self.assertTrue(pico.send_player_command(session.context, "test-token", "seek_forward", session))
        connect.assert_called_once()
        self.assertEqual(len(fake.requests), 2)
        self.assertEqual(session.requests, 2)
        self.assertFalse(fake.closed)
        for request in fake.requests:
            self.assertIn(b"Connection: keep-alive\r\n", request)
            self.assertIn(b"AUTH: test-token\r\n", request)
            self.assertIn(b'"CODESET": 3', request)
            self.assertIn(b'"CODE": 7', request)
        session.close()
        self.assertTrue(fake.closed)

    def test_player_keepalive_request_differs_from_one_shot_only_in_connection_header(self):
        ack = response(200, {"STATUS": {"RESULT": "SUCCESS"}})
        one_shot = FakeSocket(ack)
        with patch.object(pico, "open_pinned_socket", return_value=one_shot):
            self.assertTrue(pico.send_player_command(object(), "test-token", "seek_forward"))
        keepalive = ExactReadTVSocket([ack])
        session = pico.TVPlayerConnection(object())
        with patch.object(pico, "open_pinned_socket", return_value=keepalive):
            self.assertTrue(pico.send_player_command(session.context, "test-token", "seek_forward", session))
        self.assertEqual(bytes(keepalive.requests[0]),
                         b"".join(one_shot.writes).replace(b"Connection: close\r\n",
                                                         b"Connection: keep-alive\r\n"))
        session.close()

    def test_player_keepalive_reads_exact_body_without_waiting_for_eof(self):
        ack = response(200, {"STATUS": {"RESULT": "SUCCESS"}})
        legacy = ExactReadTVSocket([])
        legacy.ready.extend(ack)
        with self.assertRaises(OSError):
            pico.read_http_response(legacy, pico.MAX_RESPONSE, pico.MAX_RESPONSE,
                                    pico.MAX_CLOUD_HEADERS, require_framing=True, strict=True)
        fake = ExactReadTVSocket([ack])
        session = pico.TVPlayerConnection(object())
        timing = {"connection": "new"}
        body = {"KEYLIST": [{"CODESET": 0, "CODE": 32, "ACTION": "KEYPRESS"}]}
        with patch.object(pico, "open_pinned_socket", return_value=fake):
            result = session.keypress("test-token", body, timing)
        self.assertEqual(result["STATUS"]["RESULT"], "SUCCESS")
        self.assertEqual(timing["framing"], "content_length")
        self.assertEqual(timing["phase"], "complete")
        self.assertIn("headers_ms", timing)
        self.assertIn("body_ms", timing)
        self.assertFalse(fake.closed)  # The server remains open after complete response.
        self.assertEqual(fake.ready, b"")
        session.close()

    def test_large_keylist_extends_warm_raw_socket_timeout_then_restores_it(self):
        ack = response(200, {"STATUS": {"RESULT": "SUCCESS"}})
        wrapped = ScriptedTVSocket([ack, ack, ack])
        class Raw:
            def __init__(self): self.timeouts = []
            def settimeout(self, value): self.timeouts.append(value)
        raw = Raw()
        session = pico.TVPlayerConnection(object())
        def body(count):
            return {"KEYLIST": [{"CODESET": 3, "CODE": 7, "ACTION": "KEYPRESS"}
                                for _ in range(count)]}
        with patch.object(pico, "open_pinned_socket", return_value=(wrapped, raw)) as connect:
            for count in (1, 30, 60):
                result = session.keypress("test-token", body(count), {})
                self.assertEqual(result["STATUS"]["RESULT"], "SUCCESS")
        connect.assert_called_once()
        self.assertEqual(raw.timeouts, [12, pico.config.SOCKET_TIMEOUT_S,
                                        12, pico.config.SOCKET_TIMEOUT_S])
        self.assertEqual(len(wrapped.requests), 3)
        session.close()

    def test_cold_large_keylist_opens_pinned_socket_with_bounded_timeout(self):
        ack = response(200, {"STATUS": {"RESULT": "SUCCESS"}})
        wrapped = ScriptedTVSocket([ack])
        class Raw:
            def __init__(self): self.timeouts = []
            def settimeout(self, value): self.timeouts.append(value)
        raw = Raw()
        session = pico.TVPlayerConnection(object())
        body = {"KEYLIST": [{"CODESET": 3, "CODE": 1, "ACTION": "KEYPRESS"}
                            for _ in range(60)]}
        with patch.object(pico, "open_pinned_socket", return_value=(wrapped, raw)) as connect:
            self.assertEqual(session.keypress("test-token", body, {})["STATUS"]["RESULT"], "SUCCESS")
        self.assertEqual(connect.call_args.kwargs["timeout_s"], 12)
        self.assertTrue(connect.call_args.kwargs["return_raw"])
        self.assertEqual(raw.timeouts, [pico.config.SOCKET_TIMEOUT_S])
        self.assertEqual(len(wrapped.requests), 1)
        session.close()

    def test_pinned_socket_applies_large_timeout_to_raw_socket(self):
        class Raw:
            def __init__(self): self.timeouts = []
            def settimeout(self, value): self.timeouts.append(value)
            def connect(self, _address): pass
            def close(self): pass
        raw = Raw()
        wrapped = types.SimpleNamespace(close=lambda: None)
        context = types.SimpleNamespace(wrap_socket=lambda source, server_hostname:
                                        wrapped if source is raw and server_hostname ==
                                        pico.config.TV_TLS_NAME else None)
        with patch.object(pico.socket, "getaddrinfo", return_value=[(0, 0, 0, "", ("192.0.2.2", 7345))]), \
             patch.object(pico.socket, "socket", return_value=raw):
            self.assertEqual(pico.open_pinned_socket(context, {}, timeout_s=12,
                                                      return_raw=True), (wrapped, raw))
        self.assertEqual(raw.timeouts, [12])

    def test_large_keylist_timeout_setup_failure_sends_no_key(self):
        ack = response(200, {"STATUS": {"RESULT": "SUCCESS"}})
        wrapped = ScriptedTVSocket([ack])
        class Raw:
            def settimeout(self, value):
                if value == 12: raise OSError("timeout unsupported")
        session = pico.TVPlayerConnection(object())
        body = {"KEYLIST": [{"CODESET": 3, "CODE": 7, "ACTION": "KEYPRESS"}
                            for _ in range(60)]}
        with patch.object(pico, "open_pinned_socket", return_value=(wrapped, Raw())):
            self.assertTrue(session.prewarm("test-token"))
            timing = {}
            with self.assertRaises(OSError):
                session.keypress("test-token", body, timing)
        self.assertTrue(timing["request_not_sent"])
        self.assertEqual(len(wrapped.requests), 1)  # Only the read-only warmup.
        session.close()

    def test_player_keepalive_fully_consumes_chunked_reply_before_next_key(self):
        payload = json.dumps({"STATUS": {"RESULT": "SUCCESS"}}).encode()
        chunked = (b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"
                   + (b"%X\r\n" % len(payload)) + payload + b"\r\n0\r\n\r\n")
        fake = ExactReadTVSocket([chunked, response(200, {"STATUS": {"RESULT": "SUCCESS"}})])
        session = pico.TVPlayerConnection(object())
        with patch.object(pico, "open_pinned_socket", return_value=fake) as connect:
            self.assertTrue(pico.send_player_command(session.context, "test-token", "pause_toggle", session))
            self.assertTrue(pico.send_player_command(session.context, "test-token", "seek_backward", session))
        connect.assert_called_once()
        self.assertEqual(len(fake.requests), 2)
        self.assertEqual(fake.ready, b"")
        session.close()

    def test_player_keepalive_honors_close_and_idle_expiry(self):
        ack_close = response(200, {"STATUS": {"RESULT": "SUCCESS"}}, "Connection: close\r\n")
        ack = response(200, {"STATUS": {"RESULT": "SUCCESS"}})
        first = ScriptedTVSocket([ack_close])
        second = ScriptedTVSocket([ack])
        session = pico.TVPlayerConnection(object())
        with patch.object(pico, "open_pinned_socket", side_effect=[first, second]) as connect:
            self.assertTrue(pico.send_player_command(session.context, "test-token", "pause_toggle", session))
            self.assertTrue(first.closed)
            self.assertTrue(pico.send_player_command(session.context, "test-token", "pause_toggle", session))
        self.assertEqual(connect.call_count, 2)
        session.close()
        clock = {"now": 100}
        third = ScriptedTVSocket([ack])
        fourth = ScriptedTVSocket([ack])
        session = pico.TVPlayerConnection(object())
        with patch.object(pico.time, "ticks_ms", side_effect=lambda: clock["now"], create=True), \
             patch.object(pico, "open_pinned_socket", side_effect=[third, fourth]) as connect:
            self.assertTrue(pico.send_player_command(session.context, "test-token", "seek_forward", session))
            clock["now"] += pico.PLAYER_KEEPALIVE_IDLE_MS
            self.assertTrue(pico.send_player_command(session.context, "test-token", "seek_forward", session))
        self.assertEqual(connect.call_count, 2)
        self.assertTrue(third.closed)
        session.close()

    def test_player_stale_socket_failure_is_not_replayed_and_next_key_reconnects(self):
        ack = response(200, {"STATUS": {"RESULT": "SUCCESS"}})
        stale = ScriptedTVSocket([ack])
        fresh = ScriptedTVSocket([ack])
        session = pico.TVPlayerConnection(object())
        with patch.object(pico, "open_pinned_socket", side_effect=[stale, fresh]) as connect:
            self.assertTrue(pico.send_player_command(session.context, "test-token", "seek_forward", session))
            stale.fail_writes = True
            self.assertFalse(pico.send_player_command(session.context, "test-token", "seek_forward", session))
            self.assertEqual(len(stale.requests), 1)
            self.assertTrue(stale.closed)
            self.assertTrue(pico.send_player_command(session.context, "test-token", "seek_backward", session))
        self.assertEqual(connect.call_count, 2)  # No retry of the ambiguous second key.
        self.assertEqual(len(fresh.requests), 1)
        session.close()

    def test_player_tls_failure_and_partial_reply_close_without_replay(self):
        session = pico.TVPlayerConnection(object())
        with patch.object(pico, "open_pinned_socket", side_effect=OSError("pin mismatch")) as connect:
            self.assertFalse(pico.send_player_command(session.context, "test-token", "pause_toggle", session))
        connect.assert_called_once()
        self.assertIsNone(session.wrapped)
        partial = ScriptedTVSocket([b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{}"])
        session = pico.TVPlayerConnection(object())
        with patch.object(pico, "open_pinned_socket", return_value=partial) as connect, \
             patch("builtins.print") as log:
            self.assertFalse(pico.send_player_command(session.context, "test-token", "seek_forward", session))
        connect.assert_called_once()
        self.assertEqual(len(partial.requests), 1)
        self.assertTrue(partial.closed)
        self.assertIn("phase read_body", log.call_args.args[0])
        self.assertNotIn("test-token", log.call_args.args[0])

    def test_player_header_timeout_reports_header_phase_without_private_data(self):
        partial = ScriptedTVSocket([b"HTTP/1.1 200 OK\r\nContent-Len"])
        session = pico.TVPlayerConnection(object())
        with patch.object(pico, "open_pinned_socket", return_value=partial), \
             patch("builtins.print") as log:
            self.assertFalse(pico.send_player_command(session.context, "test-token", "pause_toggle", session))
        self.assertIn("phase read_headers", log.call_args.args[0])
        self.assertNotIn("test-token", log.call_args.args[0])
        self.assertTrue(partial.closed)

    def test_player_keepalive_request_cap_forces_new_pinned_connection(self):
        ack = response(200, {"STATUS": {"RESULT": "SUCCESS"}})
        first = ScriptedTVSocket([ack] * pico.PLAYER_KEEPALIVE_MAX_REQUESTS)
        second = ScriptedTVSocket([ack])
        session = pico.TVPlayerConnection(object())
        with patch.object(pico, "open_pinned_socket", side_effect=[first, second]) as connect:
            for _ in range(pico.PLAYER_KEEPALIVE_MAX_REQUESTS + 1):
                self.assertTrue(pico.send_player_command(session.context, "test-token", "seek_forward", session))
        self.assertEqual(connect.call_count, 2)
        self.assertTrue(first.closed)
        self.assertEqual(len(first.requests), pico.PLAYER_KEEPALIVE_MAX_REQUESTS)
        self.assertEqual(len(second.requests), 1)
        session.close()

    def test_player_malformed_or_rejected_reply_closes_before_reuse(self):
        bad_replies = (
            b"HTTP/1.1 200 OK\r\n\r\n{}",
            b"HTTP/1.1 200 OK\r\nContent-Length: 99999\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nZ\r\n",
            response(500, {"STATUS": {"RESULT": "FAILURE"}}),
            response(200, {"STATUS": {"RESULT": "FAILURE"}}),
        )
        for reply in bad_replies:
            with self.subTest(reply=reply[:20]):
                fake = ScriptedTVSocket([reply])
                session = pico.TVPlayerConnection(object())
                with patch.object(pico, "open_pinned_socket", return_value=fake) as connect:
                    self.assertFalse(pico.send_player_command(session.context, "test-token", "pause_toggle", session))
                connect.assert_called_once()
                self.assertTrue(fake.closed)
                self.assertIsNone(session.wrapped)

    def test_player_supervised_sequence_reuses_only_when_explicitly_requested(self):
        ack = response(200, {"STATUS": {"RESULT": "SUCCESS"}})
        fake = ScriptedTVSocket([ack, ack])
        with patch.object(pico, "connect_wifi", return_value=True), \
             patch.object(pico, "synchronize_time"), \
             patch.object(pico, "tls_context", return_value=object()), \
             patch.object(pico, "open_pinned_socket", return_value=fake) as connect:
            self.assertEqual(pico.supervised_player_sequence(("seek_forward", "seek_forward"), reuse=True),
                             [True, True])
        connect.assert_called_once()
        self.assertTrue(fake.closed)
        with patch.object(pico, "connect_wifi", return_value=True), \
             patch.object(pico, "synchronize_time"), \
             patch.object(pico, "tls_context", return_value=object()), \
             patch.object(pico, "send_player_command", side_effect=[False, True]) as send:
            self.assertEqual(pico.supervised_player_sequence(("seek_forward", "seek_forward")), [False])
        send.assert_called_once()

    def test_http_statuses_and_chunked_json(self):
        for status in (200, 403, 429, 500, 503):
            with self.subTest(status=status):
                self.assertEqual(pico.parse_cloud_response(response(status, {"state": "failed"})),
                                 (status, {"state": "failed"}))
        self.assertEqual(pico.parse_cloud_response(response(204)), (204, None))
        chunked = (b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"
                   b"8\r\n{\"ok\":1}\r\n0\r\n\r\n")
        self.assertEqual(pico.parse_cloud_response(chunked), (200, {"ok": 1}))

    def test_tv_content_length_response_stops_while_tls_socket_stays_open(self):
        tv_body = {"STATUS": {"RESULT": "SUCCESS"}, "ITEMS": [{"VALUE": 1}]}
        payload = json.dumps(tv_body).encode()
        raw = (b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
               + str(len(payload)).encode() + b"\r\n\r\n" + payload)
        fake = FakeSocket(raw)

        def read_once(_size):
            if fake.data:
                data, fake.data = fake.data, b""
                return data
            raise OSError("TLS connection remained open")

        fake.read = read_once
        context = object()
        with patch.object(pico, "open_pinned_socket", return_value=fake) as connect:
            result = pico.tv_request(context, "tv-auth-test", "GET", "/state/device/power_mode")
        connect.assert_called_once_with(context)
        self.assertEqual(result, tv_body)
        self.assertTrue(fake.closed)
        sent = b"".join(fake.writes).decode()
        self.assertIn("GET /state/device/power_mode HTTP/1.1\r\n", sent)
        self.assertIn("Host: 192.0.2.2:7345\r\n", sent)
        self.assertIn("Accept: application/json\r\n", sent)
        self.assertIn("Connection: close\r\n", sent)
        self.assertNotIn("Content-Type:", sent)
        self.assertNotIn("Content-Length:", sent)

    def test_tv_chunked_response_stops_when_terminal_chunk_arrives(self):
        tv_body = {"STATUS": {"RESULT": "SUCCESS"}}
        payload = json.dumps(tv_body).encode()
        chunked = (b"%X\r\n" % len(payload) + payload + b"\r\n0\r\n\r\n")
        raw = (b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n"
               b"Content-Type: application/json\r\n\r\n" + chunked)
        fake = FakeSocket(raw, max_write=5)

        def read_once(_size):
            if fake.data:
                data, fake.data = fake.data, b""
                return data
            raise OSError("TLS connection remained open")

        fake.read = read_once
        body = {"VALUE": {"APP_ID": "1", "NAME_SPACE": 5, "MESSAGE": None}}
        with patch.object(pico, "open_pinned_socket", return_value=fake):
            self.assertEqual(pico.tv_request(object(), "tv-auth-test", "PUT", "/app/launch", body), tv_body)
        sent = b"".join(fake.writes)
        headers, sent_body = sent.split(b"\r\n\r\n", 1)
        body_json = json.dumps(body).encode()
        self.assertTrue(headers.startswith(b"PUT /app/launch HTTP/1.1\r\n"))
        self.assertIn(b"Host: 192.0.2.2:7345\r\n", headers)
        self.assertIn(b"Content-Type: application/json\r\n", headers)
        self.assertIn(b"Content-Length: " + str(len(body_json)).encode(), headers)
        self.assertEqual(sent_body, body_json)

    def test_tv_incomplete_oversized_and_malformed_responses_fail(self):
        cases = [
            b"HTTP/1.1 200 OK\r\nContent-Length: 12\r\n\r\n{}",
            b"HTTP/1.1 200 OK\r\nContent-Length: 99999\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nZ\r\n",
            b"HTTP/1.1 200 OK\r\n\r\n{}",
        ]
        for raw in cases:
            with self.subTest(raw=raw[:40]), patch.object(pico, "open_pinned_socket", return_value=FakeSocket(raw)):
                with self.assertRaises(RuntimeError):
                    pico.tv_request(object(), "tv-auth-test", "GET", "/state/device/power_mode")

    def test_cloud_request_is_fixed_host_authenticated_and_does_not_follow_redirects(self):
        fake = FakeSocket(response(302, {"redirect": "ignored"}, "Location: https://attacker.invalid/\r\n"))
        with patch.object(pico, "open_cloud_socket", return_value=fake):
            status, body = pico.cloud_request(pico.CLOUD_CLAIM_PATH, "C" * 40,
                                               context=object())
        sent = b"".join(fake.writes)
        self.assertEqual(status, 302)
        self.assertEqual(body, {"redirect": "ignored"})
        self.assertIn(("Host: " + pico.CLOUD_HOST).encode(), sent)
        self.assertIn(b"Authorization: Bearer " + b"C" * 40, sent)
        self.assertTrue(fake.closed)

    def test_cloud_request_completes_partial_tls_writes(self):
        fake = FakeSocket(response(204), max_write=7)
        with patch.object(pico, "open_cloud_socket", return_value=fake):
            self.assertEqual(pico.cloud_request(pico.CLOUD_CLAIM_PATH, "C" * 40,
                                                context=object()), (204, None))
        sent = b"".join(fake.writes)
        self.assertTrue(sent.startswith(b"POST /api/controller/claim HTTP/1.1\r\n"))
        self.assertIn(b"Authorization: Bearer " + b"C" * 40, sent)
        self.assertGreater(len(fake.writes), 1)

    def test_cloud_keepalive_reuses_one_verified_stream_with_exact_framing(self):
        first = response(204)
        second = response(200, {"id": "ok"})
        fake = StreamSocket(first + second, max_write=7, max_read=3)
        session = pico.CloudConnection(object())
        with patch.object(pico, "open_cloud_socket", return_value=fake) as connect:
            self.assertEqual(pico.cloud_request(pico.CLOUD_CLAIM_PATH, "C" * 40,
                                                context=object(), session=session), (204, None))
            self.assertEqual(fake.data, second)
            self.assertEqual(pico.cloud_request(pico.CLOUD_CLAIM_PATH, "C" * 40,
                                                context=object(), session=session), (200, {"id": "ok"}))
        connect.assert_called_once()
        self.assertEqual(session.requests, 2)
        self.assertFalse(fake.closed)
        self.assertEqual(b"".join(fake.writes).count(b"Connection: keep-alive"), 2)
        session.close()
        self.assertTrue(fake.closed)

    def test_cloud_keepalive_chunked_trailer_and_next_response(self):
        chunked = (b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"
                   b"8\r\n{\"ok\":1}\r\n0\r\nX-Test: yes\r\n\r\n")
        next_response = response(204)
        fake = StreamSocket(chunked + next_response)
        session = pico.CloudConnection(object())
        with patch.object(pico, "open_cloud_socket", return_value=fake) as connect:
            self.assertEqual(session.exchange(b"POST / HTTP/1.1\r\n\r\n", b""),
                             (200, {"ok": 1}))
            self.assertEqual(fake.data, next_response)
            self.assertEqual(session.exchange(b"POST / HTTP/1.1\r\n\r\n", b""), (204, None))
        connect.assert_called_once()
        session.close()

    def test_cloud_keepalive_closes_on_server_close_idle_and_request_limit(self):
        close_reply = response(204, extra_headers="Connection: close\r\n")
        first = StreamSocket(close_reply)
        second = StreamSocket(response(204))
        third = StreamSocket(response(204))
        session = pico.CloudConnection(object())
        clock = {"now": 0}
        with patch.object(pico, "open_cloud_socket", side_effect=[first, second, third]) as connect, \
             patch.object(pico.time, "ticks_ms", side_effect=lambda: clock["now"], create=True), \
             patch.object(pico.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True):
            self.assertEqual(session.exchange(b"request", b""), (204, None))
            self.assertTrue(first.closed)
            self.assertEqual(session.exchange(b"request", b""), (204, None))
            clock["now"] = pico.CLOUD_KEEPALIVE_IDLE_MS
            self.assertEqual(session.exchange(b"request", b""), (204, None))
        self.assertTrue(second.closed)
        self.assertEqual(connect.call_count, 3)
        session.close()
        self.assertTrue(third.closed)

        limit = StreamSocket(response(204) * pico.CLOUD_KEEPALIVE_MAX_REQUESTS)
        session = pico.CloudConnection(object())
        with patch.object(pico, "open_cloud_socket", return_value=limit) as connect:
            for _ in range(pico.CLOUD_KEEPALIVE_MAX_REQUESTS):
                self.assertEqual(session.exchange(b"request", b""), (204, None))
        connect.assert_called_once()
        self.assertTrue(limit.closed)
        self.assertIsNone(session.wrapped)

    def test_cloud_keepalive_stale_socket_is_closed_without_replaying_post(self):
        first = StreamSocket(response(204))
        second = StreamSocket(response(204))
        session = pico.CloudConnection(object())
        with patch.object(pico, "open_cloud_socket", side_effect=[first, second]) as connect:
            self.assertEqual(session.exchange(b"POST request", b"payload"), (204, None))
            first.fail_read = True
            with self.assertRaises(OSError):
                session.exchange(b"POST request", b"payload")
            self.assertTrue(first.closed)
            self.assertIsNone(session.wrapped)
            self.assertEqual(connect.call_count, 1)
            self.assertEqual(session.exchange(b"POST request", b"payload"), (204, None))
        self.assertEqual(connect.call_count, 2)
        session.close()

    def test_cloud_keepalive_claim_result_and_next_claim_share_one_socket(self):
        command = {"id": "11111111-1111-4111-8111-111111111111",
                   "claimId": "22222222-2222-4222-8222-222222222222", "app": "youtube"}
        fake = StreamSocket(response(200, command)
                            + response(200, {"id": command["id"], "state": "verified"})
                            + response(204))
        session = pico.CloudConnection(object())
        with patch.object(pico, "open_cloud_socket", return_value=fake) as connect, \
             patch.object(pico, "launch_cloud_app", return_value=("verified", "app_confirmed")) as launch:
            self.assertTrue(pico.cloud_poll_once(object(), object(), "C" * 40,
                                                 "T" * 40, cloud_session=session))
            self.assertFalse(pico.cloud_poll_once(object(), object(), "C" * 40,
                                                  "T" * 40, cloud_session=session))
        connect.assert_called_once()
        launch.assert_called_once_with(unittest.mock.ANY, "T" * 40, "youtube")
        self.assertEqual(session.requests, 3)
        self.assertEqual(b"".join(fake.writes).count(b"POST /api/controller/claim"), 2)
        self.assertEqual(b"".join(fake.writes).count(b"POST /api/controller/result"), 1)
        session.close()

    def test_cloud_keepalive_handles_two_distinct_commands_sequentially(self):
        youtube = {"id": "11111111-1111-4111-8111-111111111111",
                   "claimId": "22222222-2222-4222-8222-222222222222", "app": "youtube"}
        prime = {"id": "33333333-3333-4333-8333-333333333333",
                 "claimId": "44444444-4444-4444-8444-444444444444", "app": "prime-video"}
        replies = (response(200, youtube) + response(200, {"id": youtube["id"], "state": "verified"})
                   + response(200, prime) + response(200, {"id": prime["id"], "state": "verified"}))
        fake = StreamSocket(replies)
        session = pico.CloudConnection(object())
        with patch.object(pico, "open_cloud_socket", return_value=fake) as connect, \
             patch.object(pico, "launch_cloud_app", return_value=("verified", "app_confirmed")) as launch:
            self.assertTrue(pico.cloud_poll_once(object(), object(), "C" * 40,
                                                 "T" * 40, cloud_session=session))
            self.assertTrue(pico.cloud_poll_once(object(), object(), "C" * 40,
                                                 "T" * 40, cloud_session=session))
        connect.assert_called_once()
        self.assertEqual([call.args[2] for call in launch.call_args_list],
                         ["youtube", "prime-video"])
        session.close()

    def test_cloud_keepalive_tls_failure_and_bad_framing_fail_closed(self):
        session = pico.CloudConnection(object())
        with patch.object(pico, "open_cloud_socket", side_effect=OSError("certificate rejected")) as connect:
            with self.assertRaises(OSError):
                session.exchange(b"POST request", b"payload")
        connect.assert_called_once()
        self.assertIsNone(session.wrapped)
        bad_replies = (
            b"HTTP/1.1 200 OK\r\n\r\n{}",
            b"HTTP/1.1 200 OK\r\nContent-Length: 99999\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\n{}",
            b"HTTP/1.1 204 OK\r\nContent-Length: 3\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nZ\r\n",
        )
        for reply in bad_replies:
            with self.subTest(reply=reply[:40]):
                fake = StreamSocket(reply)
                session = pico.CloudConnection(object())
                with patch.object(pico, "open_cloud_socket", return_value=fake):
                    with self.assertRaises((OSError, RuntimeError)):
                        session.exchange(b"POST request", b"payload")
                self.assertTrue(fake.closed)
                self.assertIsNone(session.wrapped)

    def test_http_error_and_auth_probe_do_not_claim(self):
        with patch.object(pico, "cloud_request", return_value=(204, None)) as request:
            self.assertFalse(pico.cloud_poll_once(object(), object(), "C" * 40, "T" * 40))
            request.assert_called_once_with(pico.CLOUD_CLAIM_PATH, "C" * 40, "POST", None, request.call_args.args[4])
        with patch.object(pico, "cloud_request", return_value=(405, {"code": "method_not_allowed"})) as request:
            pico.cloud_auth_probe(object(), "C" * 40)
            self.assertEqual(request.call_args.args[:3], (pico.CLOUD_CLAIM_PATH, "C" * 40, "GET"))
        for status in (403, 429, 500, 503):
            with self.subTest(status=status), patch.object(pico, "cloud_request", return_value=(status, None)):
                with self.assertRaises(RuntimeError):
                    pico.cloud_poll_once(object(), object(), "C" * 40, "T" * 40)

    def test_cloud_tls_failure_sends_no_authorization(self):
        with patch.object(pico, "open_cloud_socket", side_effect=OSError("TLS verify failed")) as connect:
            with self.assertRaises(OSError):
                pico.cloud_request(pico.CLOUD_CLAIM_PATH, "C" * 40, context=object())
        connect.assert_called_once()

    def test_cloud_tls_requires_ca_and_uses_fixed_hostname_for_sni(self):
        class Context:
            def __init__(self, _protocol):
                self.verify_mode = None
                self.ca_file = None
                self.hostname = None

            def load_verify_locations(self, cafile=None):
                self.ca_file = cafile

            def wrap_socket(self, sock, server_hostname=None):
                self.hostname = server_hostname
                return sock

        with patch.object(pico.ssl, "SSLContext", Context):
            context = pico.cloud_tls_context()
        self.assertEqual(context.verify_mode, pico.ssl.CERT_REQUIRED)
        self.assertEqual(context.ca_file, sys.modules["config"].CLOUD_CA_FILE)

        raw = FakeSocket(b"")
        raw.settimeout = lambda _timeout: None
        raw.connect = lambda _address: None
        with patch.object(pico.socket, "getaddrinfo", return_value=[(None, None, None, None, ("198.51.100.4", 443))]), \
             patch.object(pico.socket, "socket", return_value=raw):
            self.assertIs(pico.open_cloud_socket(context), raw)
        self.assertEqual(context.hostname, pico.CLOUD_HOST)

    def test_cloud_response_ends_at_content_length_without_waiting_for_close(self):
        fake = FakeSocket(response(200, {"ok": True}))

        def read_once(_size):
            if isinstance(fake.data, bytes):
                data, fake.data = fake.data, "TIMEOUT"
                return data
            raise OSError("peer left connection open")

        fake.read = read_once
        with patch.object(pico, "open_cloud_socket", return_value=fake):
            self.assertEqual(pico.cloud_request(pico.CLOUD_CLAIM_PATH, "C" * 40,
                                                context=object()), (200, {"ok": True}))

    def test_request_path_and_header_injection_are_rejected(self):
        with patch.object(pico, "open_cloud_socket") as connect:
            with self.assertRaises(RuntimeError):
                pico.cloud_request("/arbitrary", "C" * 40, context=object())
            with self.assertRaises(RuntimeError):
                pico.cloud_request(pico.CLOUD_CLAIM_PATH, "C" * 40 + "\r\nX: y", context=object())
        connect.assert_not_called()

    def test_claim_executes_only_fixed_mapping_and_reports_result(self):
        command = {"id": "11111111-1111-4111-8111-111111111111",
                   "claimId": "22222222-2222-4222-8222-222222222222", "app": "youtube"}
        result = {"id": command["id"], "state": "verified"}
        with patch.object(pico, "cloud_request", side_effect=[(200, command), (200, result)]) as cloud, \
             patch.object(pico, "launch_cloud_app", return_value=("verified", "app_confirmed")) as launch:
            self.assertTrue(pico.cloud_poll_once(object(), object(), "C" * 40, "T" * 40))
        launch.assert_called_once_with(unittest.mock.ANY, "T" * 40, "youtube")
        report = cloud.call_args_list[1]
        self.assertEqual(report.args[0:3], (pico.CLOUD_RESULT_PATH, "C" * 40, "POST"))
        self.assertEqual(report.args[3], {"id": command["id"], "claimId": command["claimId"],
                                          "outcome": "verified", "code": "app_confirmed"})

    def test_mismatched_result_acknowledgement_is_rejected(self):
        command = {"id": "11111111-1111-4111-8111-111111111111",
                   "claimId": "22222222-2222-4222-8222-222222222222", "app": "youtube"}
        with patch.object(pico, "cloud_request", side_effect=[(200, command),
             (200, {"id": "33333333-3333-4333-8333-333333333333", "state": "verified"})]), \
             patch.object(pico, "launch_cloud_app", return_value=("verified", "app_confirmed")):
            with self.assertRaises(RuntimeError):
                pico.cloud_poll_once(object(), object(), "C" * 40, "T" * 40)

    def test_unsupported_app_is_never_launched_and_reports_controller_error(self):
        command = {"id": "11111111-1111-4111-8111-111111111111",
                   "claimId": "22222222-2222-4222-8222-222222222222", "app": "arbitrary"}
        with patch.object(pico, "cloud_request", side_effect=[(200, command),
             (200, {"id": command["id"], "state": "failed"})]) as cloud, \
             patch.object(pico, "launch_cloud_app") as launch:
            self.assertTrue(pico.cloud_poll_once(object(), object(), "C" * 40, "T" * 40))
        launch.assert_not_called()
        self.assertEqual(cloud.call_args_list[1].args[3], {
            "id": command["id"], "claimId": command["claimId"],
            "outcome": "failed", "code": "controller_error",
        })

    def test_claim_id_validation_and_duplicate_active_app(self):
        with patch.object(pico, "cloud_request", return_value=(200, {
            "id": "bad", "claimId": "22222222-2222-4222-8222-222222222222", "app": "youtube",
        })), patch.object(pico, "launch_cloud_app") as launch:
            with self.assertRaises(RuntimeError):
                pico.cloud_poll_once(object(), object(), "C" * 40, "T" * 40)
            launch.assert_not_called()

        with patch.object(pico, "power_state", return_value=1), \
             patch.object(pico, "requested_app_active", return_value=True), \
             patch.object(pico, "tv_request") as send:
            self.assertEqual(pico.launch_cloud_app(object(), "T" * 40, "youtube"),
                             ("verified", "app_confirmed"))
            send.assert_not_called()

    def test_launch_success_rejection_timeout_and_tv_unavailable(self):
        success = {"STATUS": {"RESULT": "SUCCESS"}}
        with patch.object(pico, "power_state", return_value=1), \
             patch.object(pico, "requested_app_active", side_effect=[False, True]), \
             patch.object(pico.time, "ticks_ms", return_value=0, create=True), \
             patch.object(pico.time, "ticks_add", side_effect=lambda a, b: a + b, create=True), \
             patch.object(pico.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True), \
             patch.object(pico, "tv_request", return_value=success) as send:
            self.assertEqual(pico.launch_cloud_app(object(), "T" * 40, "prime-video"),
                             ("verified", "app_confirmed"))
        self.assertEqual(send.call_args.args[4], {"VALUE": pico.CLOUD_APPS["prime-video"]})

        with patch.object(pico, "power_state", return_value=1), \
             patch.object(pico, "requested_app_active", return_value=False), \
             patch.object(pico, "tv_request", return_value={"STATUS": {"RESULT": "FAILURE"}}):
            self.assertEqual(pico.launch_cloud_app(object(), "T" * 40, "youtube"),
                             ("failed", "tv_rejected"))

        clock = {"now": 0}
        with patch.object(pico, "power_state", return_value=1), \
             patch.object(pico, "requested_app_active", return_value=False), \
             patch.object(pico, "tv_request", return_value=success), \
             patch.object(pico.time, "ticks_ms", side_effect=lambda: clock["now"], create=True), \
             patch.object(pico.time, "ticks_add", side_effect=lambda a, b: a + b, create=True), \
             patch.object(pico.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True), \
             patch.object(pico.time, "sleep_ms", side_effect=lambda ms: clock.__setitem__("now", clock["now"] + ms), create=True):
            self.assertEqual(pico.launch_cloud_app(object(), "T" * 40, "youtube"),
                             ("failed", "tv_unconfirmed"))

        with patch.object(pico, "power_state", side_effect=OSError("TV offline")):
            self.assertEqual(pico.launch_cloud_app(object(), "T" * 40, "youtube"),
                             ("failed", "tv_unavailable"))

    def test_slow_confirmation_reads_respect_wall_time_budget(self):
        clock = {"now": 0}
        checks = []
        calls = {"count": 0}

        def slow_check(*_args):
            calls["count"] += 1
            if calls["count"] == 1:
                return False  # Prelaunch duplicate check.
            checks.append(clock["now"])
            clock["now"] += 3000
            return False

        with patch.object(pico, "power_state", return_value=1), \
             patch.object(pico, "requested_app_active", side_effect=slow_check), \
             patch.object(pico, "tv_request", return_value={"STATUS": {"RESULT": "SUCCESS"}}), \
             patch.object(pico.time, "ticks_ms", side_effect=lambda: clock["now"], create=True), \
             patch.object(pico.time, "ticks_add", side_effect=lambda a, b: a + b, create=True), \
             patch.object(pico.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True), \
             patch.object(pico.time, "sleep_ms", side_effect=lambda ms: clock.__setitem__("now", clock["now"] + ms), create=True):
            self.assertEqual(pico.launch_cloud_app(None, None, "youtube"),
                             ("failed", "tv_unconfirmed"))
        self.assertLessEqual(len(checks), 6)
        self.assertLessEqual(clock["now"], pico.CLOUD_CONFIRM_MS + 3000)

    def test_fresh_positive_power_read_is_reused_but_stale_or_off_is_not(self):
        with patch.object(sys.modules["config"], "CLOUD_REUSE_RECENT_POWER", True, create=True), \
             patch.object(pico.time, "ticks_ms", return_value=1500, create=True), \
             patch.object(pico.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True), \
             patch.object(pico, "power_state", return_value=1) as read, \
             patch.object(pico, "requested_app_active", return_value=True):
            self.assertEqual(pico.launch_cloud_app(None, None, "youtube", (1, 1000)),
                             ("verified", "app_confirmed"))
            read.assert_not_called()
            self.assertEqual(pico.launch_cloud_app(None, None, "youtube", (1, 100)),
                             ("verified", "app_confirmed"))
            self.assertEqual(pico.launch_cloud_app(None, None, "youtube", (0, 1400)),
                             ("verified", "app_confirmed"))
            self.assertEqual(read.call_count, 2)
            with patch.object(sys.modules["config"], "CLOUD_REUSE_RECENT_POWER", False, create=True):
                self.assertEqual(pico.launch_cloud_app(None, None, "youtube", (1, 1400)),
                                 ("verified", "app_confirmed"))
            self.assertEqual(read.call_count, 3)

    def test_live_claiming_and_power_automation_remain_disabled_by_default(self):
        self.assertFalse(sys.modules["config"].CLOUD_LIVE_CLAIMING)
        self.assertFalse(sys.modules["config"].AUTO_LAUNCH_ON_POWER)
        self.assertFalse(sys.modules["config"].IHEART_RETURNS_TO_HORIZON)
        with patch.object(pico, "supervised_check") as check:
            pico.main()
            check.assert_called_once_with()

    def test_iheart_identity_requires_namespace_id_and_matching_optional_message(self):
        correct = {"NAME_SPACE": 4, "APP_ID": "6", "MESSAGE": "https://tvclient.iheart.com/vizio"}
        self.assertTrue(pico.iheart_app_matches(correct))
        self.assertTrue(pico.iheart_app_matches({"NAME_SPACE": "4", "APP_ID": 6,
                                                 "MESSAGE": "https://tvclient.iheart.com/vizio/"}))
        self.assertTrue(pico.iheart_app_matches({"NAME_SPACE": 4, "APP_ID": "6"}))
        for wrong in ({"NAME_SPACE": 5, "APP_ID": "6"},
                      {"NAME_SPACE": 4, "APP_ID": "1"},
                      {"NAME_SPACE": 3, "APP_ID": "3"},
                      {"NAME_SPACE": 4, "APP_ID": "17"},
                      {"NAME_SPACE": 4, "APP_ID": "6", "MESSAGE": "https://elsewhere.invalid"}):
            with self.subTest(wrong=wrong):
                self.assertFalse(pico.iheart_app_matches(wrong))
        self.assertFalse(pico.shortcut_horizon_matches({"NAME_SPACE": 4, "APP_ID": "17",
                                                         "MESSAGE": "https://wrong.invalid/"}))

    def test_iheart_shortcut_launches_once_and_confirms_horizon(self):
        state = {"observed": False, "latched": False, "pending_at": None,
                 "cooldown_at": None, "detected_at": None}
        youtube = {"NAME_SPACE": 5, "APP_ID": "1"}
        iheart = {"NAME_SPACE": 4, "APP_ID": "6", "MESSAGE": pico.IHEART_MESSAGE}
        horizon = {"NAME_SPACE": 4, "APP_ID": "17",
                   "MESSAGE": sys.modules["config"].HORIZON_URL}
        clock = {"now": 0}
        with patch.object(pico.time, "ticks_ms", side_effect=lambda: clock["now"], create=True), \
             patch.object(pico.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True), \
             patch.object(pico.time, "ticks_add", side_effect=lambda a, b: a + b, create=True), \
             patch.object(pico, "current_app", side_effect=[youtube, iheart, iheart, horizon, horizon,
                                                            horizon, iheart, youtube, iheart, horizon, horizon]) as read, \
             patch.object(pico, "launch_horizon") as launch:
            pico.iheart_shortcut_step(None, None, state)  # baseline
            clock["now"] = 2000
            pico.iheart_shortcut_step(None, None, state)
            self.assertEqual(state["pending_at"], 2000)
            clock["now"] = 4000
            pico.iheart_shortcut_step(None, None, state)
            clock["now"] = 6000
            pico.iheart_shortcut_step(None, None, state)
            self.assertEqual(state["pending_at"], 2000)
            clock["now"] = 8000
            pico.iheart_shortcut_step(None, None, state)
            self.assertIsNone(state["pending_at"])
            self.assertEqual(launch.call_count, 1)
            for tick in (10000, 12000, 14000, 24000, 26000, 28000):
                clock["now"] = tick
                pico.iheart_shortcut_step(None, None, state)
            self.assertEqual(launch.call_count, 2)
            self.assertIsNone(state["pending_at"])
            self.assertEqual(read.call_count, 11)

    def test_iheart_baseline_timeout_and_failed_put_do_not_repeat(self):
        state = {"observed": False, "latched": False, "pending_at": None,
                 "cooldown_at": None, "detected_at": None}
        iheart = {"NAME_SPACE": 4, "APP_ID": "6", "MESSAGE": pico.IHEART_MESSAGE}
        youtube = {"NAME_SPACE": 5, "APP_ID": "1"}
        clock = {"now": 0}
        with patch.object(pico.time, "ticks_ms", side_effect=lambda: clock["now"], create=True), \
             patch.object(pico.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True), \
             patch.object(pico.time, "ticks_add", side_effect=lambda a, b: a + b, create=True), \
             patch.object(pico, "current_app", side_effect=lambda *_args: youtube if clock["now"] in (4000, 30000) else iheart), \
             patch.object(pico, "power_state", return_value=1), \
             patch.object(pico, "launch_horizon", side_effect=OSError("lost response")) as launch:
            for tick in (0, 2000, 4000, 6000, 8000, 14000, 16000, 28000, 30000, 32000):
                clock["now"] = tick
                pico.iheart_shortcut_step(None, None, state)
            self.assertEqual(launch.call_count, 2)
            self.assertIsNone(state["pending_at"])

    def test_iheart_does_not_launch_when_horizon_is_already_active(self):
        state = {"observed": False, "latched": False, "pending_at": None,
                 "cooldown_at": None, "detected_at": None}
        horizon = {"NAME_SPACE": 4, "APP_ID": "17",
                   "MESSAGE": sys.modules["config"].HORIZON_URL}
        with patch.object(pico.time, "ticks_ms", return_value=0, create=True), \
             patch.object(pico, "current_app", return_value=horizon), \
             patch.object(pico, "launch_horizon") as launch:
            pico.iheart_shortcut_step(None, None, state)
            pico.iheart_shortcut_step(None, None, state)
        launch.assert_not_called()

    def test_iheart_tv_read_failure_does_not_create_transition(self):
        state = {"observed": True, "latched": False, "pending_at": None,
                 "cooldown_at": None, "detected_at": None}
        with patch.object(pico.time, "ticks_ms", return_value=0, create=True), \
             patch.object(pico, "current_app", side_effect=OSError("TV offline")), \
             patch.object(pico, "launch_horizon") as launch:
            with self.assertRaises(OSError):
                pico.iheart_shortcut_step(None, None, state)
            launch.assert_not_called()
            self.assertFalse(state["latched"])

    def test_iheart_transient_confirmation_read_failure_does_not_repeat_put(self):
        state = {"observed": True, "latched": False, "pending_at": None,
                 "cooldown_at": None, "detected_at": None}
        iheart = {"NAME_SPACE": 4, "APP_ID": "6", "MESSAGE": pico.IHEART_MESSAGE}
        horizon = {"NAME_SPACE": 4, "APP_ID": "17",
                   "MESSAGE": sys.modules["config"].HORIZON_URL}
        clock = {"now": 1000}
        with patch.object(sys.modules["config"], "IHEART_DIAGNOSTICS", True, create=True), \
             patch.object(pico.time, "ticks_ms", side_effect=lambda: clock["now"], create=True), \
             patch.object(pico.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True), \
             patch.object(pico.time, "ticks_add", side_effect=lambda a, b: a + b, create=True), \
             patch.object(pico, "current_app", side_effect=[iheart, OSError("TV offline"), horizon, horizon]), \
             patch.object(pico, "launch_horizon") as launch, \
             patch("builtins.print") as output:
            pico.iheart_shortcut_step(None, None, state)
            clock["now"] = 3000
            pico.iheart_shortcut_step(None, None, state)
            self.assertEqual(state["pending_at"], 1000)
            clock["now"] = 5000
            pico.iheart_shortcut_step(None, None, state)
            self.assertEqual(state["pending_at"], 1000)
            clock["now"] = 7000
            pico.iheart_shortcut_step(None, None, state)
            self.assertIsNone(state["pending_at"])
            launch.assert_called_once()
        self.assertTrue(any("confirmed_after_read_error" in str(call)
                            for call in output.call_args_list))

    def test_five_consecutive_iheart_returns(self):
        state = {"observed": False, "latched": False, "pending_at": None,
                 "cooldown_at": None, "detected_at": None}
        youtube = {"NAME_SPACE": 5, "APP_ID": "1"}
        iheart = {"NAME_SPACE": 4, "APP_ID": "6", "MESSAGE": pico.IHEART_MESSAGE}
        horizon = {"NAME_SPACE": 4, "APP_ID": "17",
                   "MESSAGE": sys.modules["config"].HORIZON_URL}
        samples = [youtube]
        for _ in range(5):
            samples.extend((iheart, horizon, horizon, youtube))
        clock = {"now": 0}
        with patch.object(pico.time, "ticks_ms", side_effect=lambda: clock["now"], create=True), \
             patch.object(pico.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True), \
             patch.object(pico.time, "ticks_add", side_effect=lambda a, b: a + b, create=True), \
             patch.object(pico, "current_app", side_effect=samples), \
             patch.object(pico, "launch_horizon") as launch:
            pico.iheart_shortcut_step(None, None, state)
            for cycle in range(5):
                for offset in (2000, 4000, 6000, 8000):
                    clock["now"] = cycle * 30000 + offset
                    pico.iheart_shortcut_step(None, None, state)
                self.assertIsNone(state["pending_at"])
            self.assertEqual(launch.call_count, 5)

    def test_iheart_slow_startup_retries_once_only_while_tv_still_on_iheart(self):
        state = {"observed": True, "latched": False, "pending_at": None,
                 "cooldown_at": None, "detected_at": None}
        iheart = {"NAME_SPACE": 4, "APP_ID": "6", "MESSAGE": pico.IHEART_MESSAGE}
        horizon = {"NAME_SPACE": 4, "APP_ID": "17",
                   "MESSAGE": sys.modules["config"].HORIZON_URL}
        clock = {"now": 2000}
        with patch.object(pico.time, "ticks_ms", side_effect=lambda: clock["now"], create=True), \
             patch.object(pico.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True), \
             patch.object(pico.time, "ticks_add", side_effect=lambda a, b: a + b, create=True), \
             patch.object(pico, "current_app", side_effect=lambda *_args: horizon if clock["now"] >= 12000 else iheart), \
             patch.object(pico, "power_state", return_value=1) as power, \
             patch.object(pico, "launch_horizon") as launch:
            for tick in (2000, 4000, 6000, 8000, 10000, 12000, 14000, 16000):
                clock["now"] = tick
                pico.iheart_shortcut_step(None, None, state)
            self.assertEqual(launch.call_count, 2)
            power.assert_called_once()
            self.assertEqual(state["retry_count"], 1)
            self.assertIsNone(state["pending_at"])

    def test_iheart_rejected_launch_and_safe_diagnostics(self):
        state = {"observed": True, "latched": False, "pending_at": None,
                 "cooldown_at": None, "detected_at": None, "last_app": "5/1"}
        iheart = {"NAME_SPACE": 4, "APP_ID": "6", "MESSAGE": pico.IHEART_MESSAGE}
        with patch.object(sys.modules["config"], "IHEART_DIAGNOSTICS", True, create=True), \
             patch.object(pico.time, "ticks_ms", return_value=2000, create=True), \
             patch.object(pico.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True), \
             patch.object(pico, "current_app", return_value=iheart), \
             patch.object(pico, "launch_horizon", side_effect=RuntimeError("TV API rejected request")), \
             patch("builtins.print") as output:
            pico.iheart_shortcut_step(None, None, state)
        lines = "\n".join(str(call.args[0]) for call in output.call_args_list)
        self.assertIn("prev=5/1 current=4/6", lines)
        self.assertIn("launch=rejected", lines)
        self.assertNotIn(pico.IHEART_MESSAGE, lines)
        self.assertNotIn("private-tv-test-token", lines)
        self.assertEqual(state["pending_at"], 2000)

    def test_explicit_iheart_rejection_allows_next_guarded_poll_retry(self):
        state = {"observed": True, "latched": False, "pending_at": None,
                 "cooldown_at": None, "detected_at": None}
        iheart = {"NAME_SPACE": 4, "APP_ID": "6", "MESSAGE": pico.IHEART_MESSAGE}
        clock = {"now": 2000}
        with patch.object(pico.time, "ticks_ms", side_effect=lambda: clock["now"], create=True), \
             patch.object(pico.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True), \
             patch.object(pico.time, "ticks_add", side_effect=lambda a, b: a + b, create=True), \
             patch.object(pico, "current_app", return_value=iheart), \
             patch.object(pico, "power_state", return_value=1) as power, \
             patch.object(pico, "launch_horizon", side_effect=[RuntimeError("TV API rejected request"), None]) as launch:
            pico.iheart_shortcut_step(None, None, state)
            clock["now"] = 4000
            pico.iheart_shortcut_step(None, None, state)
        self.assertEqual(launch.call_count, 2)
        power.assert_called_once()
        self.assertEqual(state["retry_count"], 1)

    def test_iheart_accepted_but_unconfirmed_times_out_after_one_retry(self):
        state = {"observed": True, "latched": False, "pending_at": None,
                 "cooldown_at": None, "detected_at": None}
        iheart = {"NAME_SPACE": 4, "APP_ID": "6", "MESSAGE": pico.IHEART_MESSAGE}
        clock = {"now": 2000}
        with patch.object(pico.time, "ticks_ms", side_effect=lambda: clock["now"], create=True), \
             patch.object(pico.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True), \
             patch.object(pico.time, "ticks_add", side_effect=lambda a, b: a + b, create=True), \
             patch.object(pico, "current_app", return_value=iheart), \
             patch.object(pico, "power_state", return_value=1), \
             patch.object(pico, "launch_horizon") as launch, \
             patch("builtins.print") as output:
            for tick in (2000, 4000, 10000, 12000, 22000, 24000):
                clock["now"] = tick
                pico.iheart_shortcut_step(None, None, state)
        self.assertEqual(launch.call_count, 2)
        self.assertIsNone(state["pending_at"])
        self.assertTrue(any("Horizon not confirmed (timeout)" in str(call)
                            for call in output.call_args_list))

    def test_iheart_retry_rechecks_fresh_app_and_does_not_override_new_selection(self):
        state = {"observed": True, "latched": False, "pending_at": None,
                 "cooldown_at": None, "detected_at": None}
        iheart = {"NAME_SPACE": 4, "APP_ID": "6", "MESSAGE": pico.IHEART_MESSAGE}
        youtube = {"NAME_SPACE": 5, "APP_ID": "1"}
        clock = {"now": 2000}
        with patch.object(pico.time, "ticks_ms", side_effect=lambda: clock["now"], create=True), \
             patch.object(pico.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True), \
             patch.object(pico.time, "ticks_add", side_effect=lambda a, b: a + b, create=True), \
             patch.object(pico, "current_app", side_effect=[iheart, iheart, youtube]), \
             patch.object(pico, "power_state", return_value=1), \
             patch.object(pico, "launch_horizon") as launch:
            pico.iheart_shortcut_step(None, None, state)
            clock["now"] = 10000
            pico.iheart_shortcut_step(None, None, state)
        launch.assert_called_once()
        self.assertIsNone(state["pending_at"])

    def test_iheart_tv_unavailable_at_confirmation_deadline(self):
        state = {"observed": True, "latched": False, "pending_at": None,
                 "cooldown_at": None, "detected_at": None}
        iheart = {"NAME_SPACE": 4, "APP_ID": "6", "MESSAGE": pico.IHEART_MESSAGE}
        clock = {"now": 2000}
        with patch.object(pico.time, "ticks_ms", side_effect=lambda: clock["now"], create=True), \
             patch.object(pico.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True), \
             patch.object(pico.time, "ticks_add", side_effect=lambda a, b: a + b, create=True), \
             patch.object(pico, "current_app", side_effect=[iheart, OSError("TV offline")]), \
             patch.object(pico, "launch_horizon") as launch, \
             patch("builtins.print") as output:
            pico.iheart_shortcut_step(None, None, state)
            clock["now"] = 24000
            pico.iheart_shortcut_step(None, None, state)
        launch.assert_called_once()
        self.assertIsNone(state["pending_at"])
        self.assertTrue(any("Horizon not confirmed (tv_unavailable)" in str(call)
                            for call in output.call_args_list))

    def test_iheart_horizon_sample_then_unrelated_app_prevents_retry(self):
        state = {"observed": True, "latched": False, "pending_at": None,
                 "cooldown_at": None, "detected_at": None}
        iheart = {"NAME_SPACE": 4, "APP_ID": "6", "MESSAGE": pico.IHEART_MESSAGE}
        horizon = {"NAME_SPACE": 4, "APP_ID": "17",
                   "MESSAGE": sys.modules["config"].HORIZON_URL}
        youtube = {"NAME_SPACE": 5, "APP_ID": "1"}
        clock = {"now": 2000}
        with patch.object(pico.time, "ticks_ms", side_effect=lambda: clock["now"], create=True), \
             patch.object(pico.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True), \
             patch.object(pico.time, "ticks_add", side_effect=lambda a, b: a + b, create=True), \
             patch.object(pico, "current_app", side_effect=[iheart, horizon, youtube, youtube]), \
             patch.object(pico, "launch_horizon") as launch, \
             patch("builtins.print") as output:
            for tick in (2000, 4000, 6000, 8000):
                clock["now"] = tick
                pico.iheart_shortcut_step(None, None, state)
        launch.assert_called_once()
        self.assertIsNone(state["pending_at"])
        self.assertTrue(any("Horizon appeared, then another app" in str(call)
                            for call in output.call_args_list))

    def test_iheart_unrelated_app_and_power_off_block_retry(self):
        iheart = {"NAME_SPACE": 4, "APP_ID": "6", "MESSAGE": pico.IHEART_MESSAGE}
        youtube = {"NAME_SPACE": 5, "APP_ID": "1"}
        for second_app, expected in ((youtube, "app_changed"), (iheart, "tv_off")):
            with self.subTest(expected=expected):
                state = {"observed": True, "latched": False, "pending_at": None,
                         "cooldown_at": None, "detected_at": None}
                clock = {"now": 2000}
                with patch.object(pico.time, "ticks_ms", side_effect=lambda: clock["now"], create=True), \
                     patch.object(pico.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True), \
                     patch.object(pico.time, "ticks_add", side_effect=lambda a, b: a + b, create=True), \
                     patch.object(pico, "current_app", side_effect=[iheart, second_app, second_app]), \
                     patch.object(pico, "power_state", return_value=0), \
                     patch.object(pico, "launch_horizon") as launch, \
                     patch("builtins.print") as output:
                    pico.iheart_shortcut_step(None, None, state)
                    clock["now"] = 10000 if expected == "tv_off" else 4000
                    pico.iheart_shortcut_step(None, None, state)
                launch.assert_called_once()
                self.assertIsNone(state["pending_at"])
                self.assertTrue(any(expected in str(call) or
                                    (expected == "app_changed" and "another app" in str(call)) or
                                    (expected == "tv_off" and "TV turned off" in str(call))
                                    for call in output.call_args_list))

    def test_iheart_cooldown_defers_new_entry_without_repeat_launch(self):
        state = {"observed": True, "latched": False, "pending_at": None,
                 "cooldown_at": None, "detected_at": None}
        iheart = {"NAME_SPACE": 4, "APP_ID": "6", "MESSAGE": pico.IHEART_MESSAGE}
        horizon = {"NAME_SPACE": 4, "APP_ID": "17",
                   "MESSAGE": sys.modules["config"].HORIZON_URL}
        clock = {"now": 2000}
        with patch.object(pico.time, "ticks_ms", side_effect=lambda: clock["now"], create=True), \
             patch.object(pico.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True), \
             patch.object(pico.time, "ticks_add", side_effect=lambda a, b: a + b, create=True), \
             patch.object(pico, "current_app", side_effect=[iheart, horizon, horizon, iheart,
                                                            iheart, iheart, iheart]), \
             patch.object(pico, "launch_horizon") as launch:
            for tick in (2000, 4000, 6000, 8000, 12000, 20000, 22000):
                clock["now"] = tick
                pico.iheart_shortcut_step(None, None, state)
        self.assertEqual(launch.call_count, 2)
        self.assertEqual(state["pending_at"], 22000)

    def test_cloud_claim_supersedes_pending_iheart_shortcut(self):
        class EndLoop(Exception):
            pass

        clock = {"now": 0}
        youtube = {"NAME_SPACE": 5, "APP_ID": "1"}
        iheart = {"NAME_SPACE": 4, "APP_ID": "6", "MESSAGE": pico.IHEART_MESSAGE}

        def sleep(milliseconds):
            clock["now"] += milliseconds
            if clock["now"] >= 13000:
                raise EndLoop()

        with patch.object(sys.modules["config"], "IHEART_RETURNS_TO_HORIZON", True), \
             patch.object(sys.modules["config"], "CLOUD_LIVE_CLAIMING", True), \
             patch.object(sys.modules["config"], "CLOUD_POLL_MS", 1000, create=True), \
             patch.object(pico.time, "ticks_ms", side_effect=lambda: clock["now"], create=True), \
             patch.object(pico.time, "ticks_add", side_effect=lambda a, b: a + b, create=True), \
             patch.object(pico.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True), \
             patch.object(pico.time, "sleep_ms", side_effect=sleep, create=True), \
             patch.object(pico, "load_power", return_value=1), \
             patch.object(pico, "connect_wifi", return_value=True), \
             patch.object(pico, "synchronize_time", return_value=True), \
             patch.object(pico, "tls_context", return_value=object()), \
             patch.object(pico, "cloud_tls_context", return_value=object()), \
             patch.object(pico, "power_state", return_value=1), \
             patch.object(pico, "cloud_poll_once", side_effect=lambda *_args: clock["now"] == 3000), \
             patch.object(pico, "current_app", side_effect=lambda *_args: youtube if clock["now"] == 0 else iheart), \
             patch.object(pico, "launch_horizon") as launch, \
             patch("builtins.print") as output:
            with self.assertRaises(EndLoop):
                pico.unattended_watch()
        launch.assert_called_once()
        self.assertTrue(any("superseded by cloud app launch" in str(call)
                            for call in output.call_args_list))

    def test_cloud_claim_cancels_shortcut_even_when_result_report_fails(self):
        state = {"observed": True, "latched": True, "pending_at": 1000,
                 "cooldown_at": None, "detected_at": 1000}
        command = {"id": "11111111-1111-4111-8111-111111111111",
                   "claimId": "22222222-2222-4222-8222-222222222222", "app": "youtube"}
        with patch.object(pico.time, "ticks_ms", return_value=3000, create=True), \
             patch.object(pico.time, "ticks_add", side_effect=lambda a, b: a + b, create=True), \
             patch.object(pico, "cloud_request", side_effect=[(200, command), OSError("result lost")]), \
             patch.object(pico, "launch_cloud_app", return_value=("verified", "app_confirmed")):
            with self.assertRaises(OSError):
                pico.cloud_poll_once(None, None, "C" * 40, "T" * 40, state)
        self.assertIsNone(state["pending_at"])
        self.assertTrue(state["latched"])

    def test_iheart_watch_keeps_cloud_claims_and_power_monitoring(self):
        class EndLoop(Exception):
            pass

        clock = {"now": 0}
        power_reads = []
        cloud_claims = []
        app_reads = []
        youtube = {"NAME_SPACE": 5, "APP_ID": "1"}
        iheart = {"NAME_SPACE": 4, "APP_ID": "6", "MESSAGE": pico.IHEART_MESSAGE}
        horizon = {"NAME_SPACE": 4, "APP_ID": "17",
                   "MESSAGE": sys.modules["config"].HORIZON_URL}

        def sleep(milliseconds):
            clock["now"] += milliseconds
            if clock["now"] >= 5000:
                raise EndLoop()

        def read_app(*_args):
            app_reads.append(clock["now"])
            return youtube if clock["now"] == 0 else iheart if clock["now"] < 4000 else horizon

        with patch.object(sys.modules["config"], "IHEART_RETURNS_TO_HORIZON", True), \
             patch.object(sys.modules["config"], "CLOUD_LIVE_CLAIMING", True), \
             patch.object(sys.modules["config"], "CLOUD_POLL_MS", 1000, create=True), \
             patch.object(sys.modules["config"], "POLL_MS", 3000, create=True), \
             patch.object(pico.time, "ticks_ms", side_effect=lambda: clock["now"], create=True), \
             patch.object(pico.time, "ticks_add", side_effect=lambda a, b: a + b, create=True), \
             patch.object(pico.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True), \
             patch.object(pico.time, "sleep_ms", side_effect=sleep, create=True), \
             patch.object(pico, "load_power", return_value=1), \
             patch.object(pico, "connect_wifi", return_value=True), \
             patch.object(pico, "synchronize_time", return_value=True), \
             patch.object(pico, "tls_context", return_value=object()), \
             patch.object(pico, "cloud_tls_context", return_value=object()), \
             patch.object(pico, "power_state", side_effect=lambda *_args: power_reads.append(clock["now"]) or 1), \
             patch.object(pico, "cloud_poll_once", side_effect=lambda *_args: cloud_claims.append(clock["now"]) or False), \
             patch.object(pico, "current_app", side_effect=read_app), \
             patch.object(pico, "launch_horizon") as launch:
            with self.assertRaises(EndLoop):
                pico.unattended_watch()
        self.assertEqual(app_reads, [0, 2000, 4000])
        self.assertEqual(power_reads, [0, 3000])
        self.assertGreaterEqual(len(cloud_claims), 5)
        launch.assert_called_once()

    def test_second_iheart_confirmation_precedes_slow_due_cloud_claim(self):
        class EndLoop(Exception):
            pass

        clock = {"now": 0}
        events = []

        def sleep(milliseconds):
            clock["now"] += milliseconds
            if clock["now"] >= 6400:
                raise EndLoop()

        def poll_cloud(*_args):
            events.append(("cloud", clock["now"]))
            clock["now"] += 2200  # Physical empty-claim order of magnitude.
            return False

        def poll_shortcut(_context, _token, state):
            events.append(("shortcut", clock["now"]))
            if state.get("horizon_seen_at") is None:
                state["pending_at"] = clock["now"]
                state["horizon_seen_at"] = clock["now"]
            else:
                state["pending_at"] = None
                state["horizon_seen_at"] = None

        with patch.object(sys.modules["config"], "IHEART_RETURNS_TO_HORIZON", True), \
             patch.object(sys.modules["config"], "CLOUD_LIVE_CLAIMING", True), \
             patch.object(sys.modules["config"], "CLOUD_POLL_MS", 1500, create=True), \
             patch.object(sys.modules["config"], "IHEART_POLL_MS", 2000), \
             patch.object(pico.time, "ticks_ms", side_effect=lambda: clock["now"], create=True), \
             patch.object(pico.time, "ticks_add", side_effect=lambda a, b: a + b, create=True), \
             patch.object(pico.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True), \
             patch.object(pico.time, "sleep_ms", side_effect=sleep, create=True), \
             patch.object(pico, "load_power", return_value=1), \
             patch.object(pico, "connect_wifi", return_value=True), \
             patch.object(pico, "synchronize_time", return_value=True), \
             patch.object(pico, "tls_context", return_value=object()), \
             patch.object(pico, "cloud_tls_context", return_value=object()), \
             patch.object(pico, "power_state", return_value=1), \
             patch.object(pico, "cloud_poll_once", side_effect=poll_cloud), \
             patch.object(pico, "iheart_shortcut_step", side_effect=poll_shortcut):
            with self.assertRaises(EndLoop):
                pico.unattended_watch()
        self.assertEqual(events[:4], [("cloud", 0), ("shortcut", 2200),
                                      ("shortcut", 4200), ("cloud", 4200)])

    def test_iheart_watch_skips_tv_reads_when_power_off(self):
        class EndLoop(Exception):
            pass

        clock = {"now": 0}

        def sleep(milliseconds):
            clock["now"] += milliseconds
            if clock["now"] >= 4000:
                raise EndLoop()

        with patch.object(sys.modules["config"], "IHEART_RETURNS_TO_HORIZON", True), \
             patch.object(pico.time, "ticks_ms", side_effect=lambda: clock["now"], create=True), \
             patch.object(pico.time, "ticks_add", side_effect=lambda a, b: a + b, create=True), \
             patch.object(pico.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True), \
             patch.object(pico.time, "sleep_ms", side_effect=sleep, create=True), \
             patch.object(pico, "load_power", return_value=0), \
             patch.object(pico, "connect_wifi", return_value=True), \
             patch.object(pico, "synchronize_time", return_value=True), \
             patch.object(pico, "tls_context", return_value=object()), \
             patch.object(pico, "power_state", return_value=0), \
             patch.object(pico, "current_app") as read, \
             patch.object(pico, "launch_horizon") as launch:
            with self.assertRaises(EndLoop):
                pico.unattended_watch()
        read.assert_not_called()
        launch.assert_not_called()

    def test_scheduler_wakes_for_cloud_without_changing_power_interval(self):
        class EndLoop(Exception):
            pass

        clock = {"now": 0}
        power_calls = []
        cloud_calls = []

        def read_power(_context, _token):
            power_calls.append(clock["now"])
            clock["now"] += 50
            return 1

        def poll_cloud(*_args):
            cloud_calls.append(clock["now"])
            clock["now"] += 100
            return False

        def sleep(milliseconds):
            clock["now"] += milliseconds
            if clock["now"] >= 4400:
                raise EndLoop()

        with patch.object(sys.modules["config"], "AUTO_LAUNCH_ON_POWER", True), \
             patch.object(sys.modules["config"], "CLOUD_LIVE_CLAIMING", True), \
             patch.object(sys.modules["config"], "CLOUD_POLL_MS", 1000, create=True), \
             patch.object(sys.modules["config"], "POLL_MS", 3000, create=True), \
             patch.object(pico.time, "ticks_ms", side_effect=lambda: clock["now"], create=True), \
             patch.object(pico.time, "ticks_add", side_effect=lambda value, delta: value + delta, create=True), \
             patch.object(pico.time, "ticks_diff", side_effect=lambda left, right: left - right, create=True), \
             patch.object(pico.time, "sleep_ms", side_effect=sleep, create=True), \
             patch.object(pico, "load_power", return_value=1), \
             patch.object(pico, "connect_wifi", return_value=True), \
             patch.object(pico, "synchronize_time", return_value=True), \
             patch.object(pico, "tls_context", return_value=object()), \
             patch.object(pico, "cloud_tls_context", return_value=object()), \
             patch.object(pico, "power_state", side_effect=read_power), \
             patch.object(pico, "cloud_poll_once", side_effect=poll_cloud), \
             patch.object(pico, "launch_horizon") as launch_horizon:
            with self.assertRaises(EndLoop):
                pico.unattended_watch()
            launch_horizon.assert_not_called()
        self.assertGreaterEqual(len(cloud_calls), 4)
        self.assertEqual(power_calls[:2], [0, 3000])
        self.assertEqual(cloud_calls[:3], [50, 1000, 2000])

    def test_periodic_cloud_schedule_skips_missed_slots_without_burst(self):
        with patch.object(pico.time, "ticks_add", side_effect=lambda a, b: a + b, create=True), \
             patch.object(pico.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True):
            self.assertEqual(pico.next_periodic_due(0, 3000, 400), 3000)
            self.assertEqual(pico.next_periodic_due(0, 3000, 4500), 7500)

    def test_cloud_error_backoff_does_not_stop_power_watching(self):
        class EndLoop(Exception):
            pass

        clock = {"now": 0}
        power_calls = []
        cloud_calls = []

        def read_power(_context, _token):
            power_calls.append(clock["now"])
            return 1

        def poll_cloud(*_args):
            cloud_calls.append(clock["now"])
            raise OSError("temporary network failure")

        def sleep(milliseconds):
            clock["now"] += milliseconds
            if clock["now"] >= 6100:
                raise EndLoop()

        with patch.object(sys.modules["config"], "CLOUD_LIVE_CLAIMING", True), \
             patch.object(sys.modules["config"], "CLOUD_POLL_MS", 1000, create=True), \
             patch.object(sys.modules["config"], "POLL_MS", 3000, create=True), \
             patch.object(pico.time, "ticks_ms", side_effect=lambda: clock["now"], create=True), \
             patch.object(pico.time, "ticks_add", side_effect=lambda value, delta: value + delta, create=True), \
             patch.object(pico.time, "ticks_diff", side_effect=lambda left, right: left - right, create=True), \
             patch.object(pico.time, "sleep_ms", side_effect=sleep, create=True), \
             patch.object(pico, "load_power", return_value=1), \
             patch.object(pico, "connect_wifi", return_value=True), \
             patch.object(pico, "synchronize_time", return_value=True), \
             patch.object(pico, "tls_context", return_value=object()), \
             patch.object(pico, "cloud_tls_context", return_value=object()), \
             patch.object(pico, "power_state", side_effect=read_power), \
             patch.object(pico, "cloud_poll_once", side_effect=poll_cloud):
            with self.assertRaises(EndLoop):
                pico.unattended_watch()
        self.assertEqual(power_calls[:3], [0, 3000, 6000])
        self.assertEqual(cloud_calls[:2], [0, 3000])

    def test_wifi_reconnect_resumes_cloud_polling(self):
        class EndLoop(Exception):
            pass

        clock = {"now": 0}
        claims = []

        class FlakyWLAN(FakeWLAN):
            def isconnected(self):
                return clock["now"] >= 1000

        def sleep(milliseconds):
            clock["now"] += milliseconds
            if clock["now"] >= 2200:
                raise EndLoop()

        with patch.object(sys.modules["config"], "CLOUD_LIVE_CLAIMING", True), \
             patch.object(sys.modules["config"], "CLOUD_POLL_MS", 1000, create=True), \
             patch.object(pico.network, "WLAN", FlakyWLAN), \
             patch.object(pico.time, "ticks_ms", side_effect=lambda: clock["now"], create=True), \
             patch.object(pico.time, "ticks_add", side_effect=lambda value, delta: value + delta, create=True), \
             patch.object(pico.time, "ticks_diff", side_effect=lambda left, right: left - right, create=True), \
             patch.object(pico.time, "sleep_ms", side_effect=sleep, create=True), \
             patch.object(pico, "load_power", return_value=1), \
             patch.object(pico, "connect_wifi", side_effect=lambda _wlan: clock["now"] >= 1000), \
             patch.object(pico, "synchronize_time", return_value=True), \
             patch.object(pico, "tls_context", return_value=object()), \
             patch.object(pico, "cloud_tls_context", return_value=object()), \
             patch.object(pico, "power_state", return_value=1), \
             patch.object(pico, "cloud_poll_once", side_effect=lambda *_args: claims.append(clock["now"]) or False):
            with self.assertRaises(EndLoop):
                pico.unattended_watch()
        self.assertEqual(claims[0], 1000)

    def test_power_edge_launches_once_then_app_switch_does_not_relaunch(self):
        class EndLoop(Exception):
            pass

        clock = {"now": 0}
        modes = iter((0, 1, 1, 1, 1))

        def sleep(milliseconds):
            clock["now"] += milliseconds
            if clock["now"] >= 12000:
                raise EndLoop()

        with patch.object(sys.modules["config"], "AUTO_LAUNCH_ON_POWER", True), \
             patch.object(sys.modules["config"], "CLOUD_LIVE_CLAIMING", False), \
             patch.object(sys.modules["config"], "POLL_MS", 3000, create=True), \
             patch.object(pico.time, "ticks_ms", side_effect=lambda: clock["now"], create=True), \
             patch.object(pico.time, "ticks_add", side_effect=lambda value, delta: value + delta, create=True), \
             patch.object(pico.time, "ticks_diff", side_effect=lambda left, right: left - right, create=True), \
             patch.object(pico.time, "sleep_ms", side_effect=sleep, create=True), \
             patch.object(pico, "load_power", return_value=0), \
             patch.object(pico, "save_power"), \
             patch.object(pico, "connect_wifi", return_value=True), \
             patch.object(pico, "synchronize_time", return_value=True), \
             patch.object(pico, "tls_context", return_value=object()), \
             patch.object(pico, "power_state", side_effect=lambda *_args: next(modes)), \
             patch.object(pico, "horizon_is_active", side_effect=[False, True]), \
             patch.object(pico, "launch_horizon") as launch:
            with self.assertRaises(EndLoop):
                pico.unattended_watch()
        launch.assert_called_once()

    def test_stage_timing_is_off_unless_explicitly_enabled(self):
        self.assertIsNone(pico.perf_start())
        with patch.object(sys.modules["config"], "PERF_TIMING", True, create=True), \
             patch.object(pico.time, "ticks_ms", return_value=125, create=True), \
             patch.object(pico.time, "ticks_diff", side_effect=lambda left, right: left - right, create=True), \
             patch("builtins.print") as output:
            started = pico.perf_start()
            pico.perf_end("TV power read", started)
        output.assert_called_once_with("Timing TV power read: 0 ms")

    def test_slow_request_timing_is_opt_in_and_uses_safe_phase_names(self):
        with patch.object(pico.time, "ticks_ms", return_value=1000, create=True), \
             patch.object(pico.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True), \
             patch("builtins.print") as output:
            pico.perf_slow("power watch read", None, "tv")
            output.assert_not_called()
            with patch.object(sys.modules["config"], "PERF_TIMING", True, create=True):
                pico.perf_slow("power watch read", 0, "tv")
            self.assertEqual(output.call_count, 2)
            self.assertIn("Timing slow power watch read: 1000 ms", output.call_args_list[0].args[0])
            self.assertIn("DNS", output.call_args_list[1].args[0])


class PlayerBridgeTests(unittest.TestCase):
    def test_live_player_defers_blocking_power_and_iheart_reads_but_only_for_eight_seconds(self):
        class EndLoop(Exception):
            pass

        clock = {"now": 0}
        power_reads, shortcut_reads = [], []

        class ActiveBridge:
            session = "active"
            batch = None

            def __init__(self, *_args):
                pass

            def step(self):
                pass

        def sleep(milliseconds):
            clock["now"] += milliseconds
            if clock["now"] >= 8100:
                raise EndLoop()

        with patch.object(sys.modules["config"], "PLAYER_BRIDGE_ENABLED", True, create=True), \
             patch.object(sys.modules["config"], "IHEART_RETURNS_TO_HORIZON", True), \
             patch.object(sys.modules["secrets"], "PLAYER_BRIDGE_TOKEN", "x" * 32, create=True), \
             patch.object(pico.time, "ticks_ms", side_effect=lambda: clock["now"], create=True), \
             patch.object(pico.time, "ticks_add", side_effect=lambda a, b: a + b, create=True), \
             patch.object(pico.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True), \
             patch.object(pico.time, "sleep_ms", side_effect=sleep, create=True), \
             patch.object(pico, "load_power", return_value=1), \
             patch.object(pico, "connect_wifi", return_value=True), \
             patch.object(pico, "synchronize_time"), \
             patch.object(pico, "tls_context", return_value=object()), \
             patch.object(pico, "cloud_tls_context", return_value=object()), \
             patch.object(pico, "power_state", side_effect=lambda *_: power_reads.append(clock["now"]) or 1), \
             patch.object(pico, "poll_shortcut_once", side_effect=lambda *_: shortcut_reads.append(clock["now"]) or clock["now"] + 2000), \
             patch.object(player_bridge, "PlayerBridgeClient", ActiveBridge):
            with self.assertRaises(EndLoop):
                pico.unattended_watch()
        self.assertEqual(power_reads, [8000])
        self.assertEqual(shortcut_reads, [8000])

    def test_main_script_starts_bridge_without_sys_modules_main_entry(self):
        class BridgeReached(Exception):
            pass

        captured = []

        def construct(*args):
            captured.append(args)
            raise BridgeReached()

        with patch.dict(sys.modules):
            sys.modules.pop("__main__", None)
            with self.assertRaises(KeyError):
                sys.modules["__main__"]  # The previous startup lookup failed here.
            with patch.object(pico, "__name__", "__main__"), \
                 patch.object(sys.modules["config"], "PLAYER_BRIDGE_ENABLED", True, create=True), \
                 patch.object(sys.modules["secrets"], "PLAYER_BRIDGE_TOKEN", "x" * 32, create=True), \
                 patch.object(pico.time, "ticks_ms", return_value=100, create=True), \
                 patch.object(pico.time, "ticks_add", side_effect=lambda a, b: a + b, create=True), \
                 patch.object(pico, "load_power", return_value=1), \
                 patch.object(pico, "connect_wifi", return_value=True), \
                 patch.object(pico, "synchronize_time"), \
                 patch.object(pico, "tls_context", return_value="tv-context"), \
                 patch.object(pico, "cloud_tls_context", return_value="cloud-context"), \
                 patch.object(player_bridge, "PlayerBridgeClient", side_effect=construct):
                with self.assertRaises(BridgeReached):
                    pico.unattended_watch()
        self.assertEqual(len(captured), 1)
        self.assertIs(captured[0][0], pico.PlayerBridgeController)
        self.assertEqual(captured[0][1], "cloud-context")
        self.assertEqual(captured[0][3], "tv-context")
        self.assertIs(pico.PlayerBridgeController.TVPlayerConnection, pico.TVPlayerConnection)
        self.assertIs(pico.PlayerBridgeController.PlayerCommandDispatcher, pico.PlayerCommandDispatcher)

    def test_startup_error_uses_micropython_traceback(self):
        failure = RuntimeError("test startup failure")
        with patch.object(pico.sys, "print_exception", create=True) as traceback, \
             patch("builtins.print") as output:
            pico.report_startup_error(failure)
        traceback.assert_called_once_with(failure)
        output.assert_called_once_with("Controller stopped:", "RuntimeError")

    def test_visible_player_defers_cloud_claim_for_at_most_eight_seconds(self):
        with patch.object(pico.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True):
            started, defer = pico.player_cloud_deferral(True, None, 100)
            self.assertEqual((started, defer), (100, True))
            self.assertEqual(pico.player_cloud_deferral(True, started, 8099), (100, True))
            self.assertEqual(pico.player_cloud_deferral(True, started, 8100), (100, False))
            self.assertEqual(pico.player_cloud_deferral(True, started, 20099, 20000), (100, True))
            self.assertEqual(pico.player_cloud_deferral(True, started, 20100, 20000), (100, False))
            self.assertEqual(pico.player_cloud_deferral(False, started, 150), (None, False))

    def test_bridge_handshake_uses_verified_context_and_raw_socket_timeout(self):
        import base64
        import hashlib

        class Raw:
            def __init__(self):
                self.timeouts = []
                self.closed = False

            def settimeout(self, value):
                self.timeouts.append(value)

            def connect(self, _address):
                pass

            def close(self):
                self.closed = True

        class TLS:
            def __init__(self):
                self.reply = b""
                self.closed = False

            def write(self, request):
                key = request.split(b"Sec-WebSocket-Key: ", 1)[1].split(b"\r\n", 1)[0]
                accept = base64.b64encode(hashlib.sha1(key + player_bridge.GUID).digest())
                self.reply = (b"HTTP/1.1 101 Switching Protocols\r\n"
                              b"Upgrade: websocket\r\nConnection: Upgrade\r\n"
                              b"Sec-WebSocket-Accept: " + accept + b"\r\n\r\n")
                return len(request)

            def read(self, count):
                part, self.reply = self.reply[:count], self.reply[count:]
                return part

            def close(self):
                self.closed = True

        class Poll:
            def __init__(self):
                self.target = None

            def register(self, target, _event):
                if target is tls:
                    raise TypeError("SSL stream cannot be polled")
                self.target = target

        raw = Raw()
        tls = TLS()  # Deliberately has no settimeout method.
        poll = Poll()
        context = types.SimpleNamespace(wrap_socket=lambda _raw, server_hostname: tls)
        controller = types.SimpleNamespace(write_all=pico.write_all, ticks=lambda: 100)
        client = player_bridge.PlayerBridgeClient(controller, context, "dummy-token", object(), "tv")
        with patch.object(player_bridge.socket, "getaddrinfo", return_value=[(0, 0, 0, "", ("127.0.0.1", 443))]), \
             patch.object(player_bridge.socket, "socket", return_value=raw), \
             patch.object(player_bridge.select, "poll", return_value=poll), \
             patch.object(player_bridge.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True), \
             patch.object(player_bridge.time, "ticks_add", side_effect=lambda a, b: a + b, create=True):
            client.connect()
            self.assertIs(client.socket, tls)
            self.assertIs(client.raw, raw)
            self.assertIs(poll.target, raw)
            self.assertTrue(client.poll_raw)
            self.assertEqual(raw.timeouts[-1], 0)
            client.close()
        self.assertTrue(tls.closed)

    def test_warmup_is_read_only_and_reuses_framed_socket(self):
        ack = response(200, {"STATUS": {"RESULT": "SUCCESS"}})
        fake = ScriptedTVSocket([ack, ack])
        session = pico.TVPlayerConnection(object())
        with patch.object(pico.time, "ticks_ms", return_value=100, create=True), \
             patch.object(pico.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True), \
             patch.object(pico, "open_pinned_socket", return_value=fake) as connect:
            self.assertTrue(session.prewarm("test-token"))
            self.assertTrue(pico.send_player_command(session.context, "test-token",
                                                     "seek_forward", session))
        connect.assert_called_once()
        self.assertTrue(fake.requests[0].startswith(b"GET /app/current HTTP/1.1\r\n"))
        self.assertNotIn(b"KEYLIST", fake.requests[0])
        self.assertTrue(fake.requests[1].startswith(b"PUT /key_command/ HTTP/1.1\r\n"))
        session.close()

    def test_websocket_frame_incremental_and_client_masked(self):
        class NoDeleteBuffer(bytearray):
            def __delitem__(self, _key):
                raise AssertionError("MicroPython bytearray deletion is unsupported")

        payload = b'{"type":"player_session_open"}'
        encoded = player_bridge._frame(payload)
        self.assertEqual(encoded[1] & 128, 128)
        self.assertNotIn(payload, encoded)
        frame = NoDeleteBuffer(bytes((0x81, len(payload))) + payload[:4])
        self.assertIsNone(player_bridge._next_frame(frame))
        frame.extend(payload[4:])
        self.assertEqual(player_bridge._next_frame(frame), (1, payload))
        self.assertEqual(frame, b"")
        self.assertEqual(player_bridge._next_frame(NoDeleteBuffer(b"\x88\x02\x03\xf3")),
                         (8, b"\x03\xf3"))  # Server close 1011, without bytearray deletion.
        with self.assertRaises(ValueError):
            player_bridge._next_frame(bytearray(b"\x81\xff"))

    def test_expired_player_command_is_acknowledged_without_sending_key(self):
        controller = types.SimpleNamespace(ticks=lambda: 100,
            PlayerCommandDispatcher=pico.PlayerCommandDispatcher)
        client = player_bridge.PlayerBridgeClient(controller, object(), "cloud", object(), "tv")
        client.session = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        client.tv = object()
        client.dispatcher = pico.PlayerCommandDispatcher()
        sent = []
        client.send = sent.append
        with patch.object(pico, "send_player_command") as key:
            client._command({"session": client.session, "id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                             "sequence": 1, "command": "seek_forward", "deadlineAt": 1})
        key.assert_not_called()
        self.assertEqual(sent[-1]["code"], "expired")
        self.assertEqual(client.dispatcher.last_sequence, 0)

    def test_session_prepares_without_key_and_repeated_seeks_are_ordered_once(self):
        class FakeTV:
            instances = []

            def __init__(self, _context):
                self.last_used = 100
                self.wrapped = object()
                self.prewarms = 0
                self.closed = False
                FakeTV.instances.append(self)

            def prewarm(self, _token):
                self.prewarms += 1
                return True

            def close(self, _reason="closed"):
                self.closed = True

        controller = types.SimpleNamespace(ticks=lambda: 100,
            TVPlayerConnection=FakeTV, PlayerCommandDispatcher=pico.PlayerCommandDispatcher,
            PLAYER_SESSION_HEARTBEAT_MS=2500, PLAYER_SESSION_STALE_MS=3500)
        client = player_bridge.PlayerBridgeClient(controller, object(), "cloud-token",
                                                  object(), "tv-token")
        sent = []
        client.send = sent.append
        with patch.object(player_bridge.time, "ticks_add", side_effect=lambda a, b: a + b, create=True), \
             patch.object(player_bridge.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True), \
             patch.object(pico, "send_player_command", return_value=True) as key:
            client._message(b'{"type":"player_session_open","session":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}')
            self.assertEqual(FakeTV.instances[-1].prewarms, 1)
            self.assertEqual(sent[-1]["type"], "session_ready")
            self.assertEqual(key.call_count, 0)
            for number in (1, 2, 3):
                client._message(json.dumps({"type": "player_command", "session": client.session,
                    "id": "bbbbbbbb-bbbb-4bbb-8bbb-%012d" % number,
                    "sequence": number, "command": "seek_forward",
                    "deadlineAt": int(time.time() * 1000) + 1200}).encode())
            self.assertEqual(key.call_count, 3)
            client._message(json.dumps({"type": "player_command", "session": client.session,
                "id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                "sequence": 3, "command": "seek_forward",
                "deadlineAt": int(time.time() * 1000) + 1200}).encode())
            self.assertEqual(key.call_count, 3)
            self.assertEqual(sent[-1]["code"], "duplicate")
            client._message(json.dumps({"type": "player_session_close",
                "session": client.session}).encode())
            self.assertTrue(FakeTV.instances[-1].closed)
            self.assertIsNone(client.tv)

    def test_player_batch_explicit_sequential_debug_mode_can_cancel(self):
        class FakeTV:
            def __init__(self):
                self.wrapped = object()
                self.last_used = 100
                self.keys = []
            def prewarm(self, _token):
                self.wrapped = object()
                return True
            def keypress(self, _token, body, timing):
                self.keys.append(body)
                timing.update({"request_ms": 120, "connection": "warm"})
                return {"STATUS": {"RESULT": "SUCCESS"}}
            def close(self, _reason="closed"):
                self.wrapped = None

        tv = FakeTV()
        controller = types.SimpleNamespace(ticks=lambda: 100, PLAYER_KEYS=pico.PLAYER_KEYS,
            PLAYER_SESSION_HEARTBEAT_MS=2500, PLAYER_SESSION_STALE_MS=3500)
        client = player_bridge.PlayerBridgeClient(controller, object(), "cloud", object(), "tv")
        client.session = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        client.tv = tv
        client.dispatcher = pico.PlayerCommandDispatcher()
        sent = []
        client.send = sent.append
        value = {"session": client.session, "id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                 "sequence": 1, "command": "seek_forward", "count": 30,
                 "deadlineAt": int(time.time() * 1000) + 1200}
        with patch.object(player_bridge.config, "PLAYER_SEEK_MODE", "sequential", create=True), \
             patch.object(player_bridge.time, "ticks_add", side_effect=lambda a, b: a + b, create=True), \
             patch.object(player_bridge.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True):
            client._batch(value)
            self.assertEqual(sent[-1]["type"], "batch_accepted")
            self.assertTrue(sent[-1]["accepted"])
            client._batch(value)
            self.assertEqual(sent[-1]["code"], "busy")
            client._batch_step()
            client._batch_step()
            self.assertEqual(len(tv.keys), 2)
            self.assertEqual([key["KEYLIST"][0] for key in tv.keys], [
                {"CODESET": 3, "CODE": 7, "ACTION": "KEYPRESS"}] * 2)
            client._message(json.dumps({"type": "player_batch_cancel", "session": client.session,
                "id": value["id"]}).encode())
            self.assertEqual(sent[-1]["type"], "batch_done")
            self.assertEqual(sent[-1]["state"], "cancelled")
            self.assertEqual(sent[-1]["acknowledged"], 2)
            client._batch_step()
            self.assertEqual(len(tv.keys), 2)
            value.update({"id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "sequence": 2,
                          "command": "seek_backward", "count": 3})
            client._batch(value)
            for _ in range(3): client._batch_step()
            self.assertEqual(sent[-1]["state"], "complete")
            self.assertEqual(sent[-1]["acknowledged"], 3)
            self.assertEqual(sent[-1]["metrics"]["avgMs"], 120)
            self.assertEqual(sent[-1]["metrics"]["smartcastRequests"], 3)
            self.assertEqual(tv.keys[-1]["KEYLIST"][0]["CODE"], 1)
            value.update({"id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "sequence": 3,
                          "command": "seek_forward", "count": 60})
            client._batch(value)
            for _ in range(60): client._batch_step()
            self.assertEqual(sent[-1]["state"], "complete")
            self.assertEqual(sent[-1]["acknowledged"], 60)
            self.assertEqual(len(tv.keys), 65)

    def test_player_keylist_uses_one_request_for_verified_counts_and_both_directions(self):
        class FakeTV:
            wrapped = object()
            last_used = 100
            def __init__(self): self.requests = []
            def keypress(self, _token, body, timing):
                self.requests.append(body)
                timing.update({"request_ms": 531, "connection": "warm"})
                return {"STATUS": {"RESULT": "SUCCESS"}}
            def close(self, _reason="closed"): pass

        controller = types.SimpleNamespace(ticks=lambda: 100, PLAYER_KEYS=pico.PLAYER_KEYS,
            PLAYER_SESSION_HEARTBEAT_MS=2500, PLAYER_SESSION_STALE_MS=3500)
        with patch.object(player_bridge.time, "ticks_add", side_effect=lambda a, b: a + b, create=True), \
             patch.object(player_bridge.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True):
            for mode, counts in ((None, (1, 3, 6, 12, 30, 60)),
                                 ("verified", (1, 3, 6, 12, 30, 60)),
                                 ("all_keylist", (1, 3, 6, 12, 30, 60))):
                with patch.object(player_bridge.config, "PLAYER_SEEK_MODE", mode, create=True):
                    for command, code in (("seek_forward", 7), ("seek_backward", 1)):
                        for count in counts:
                            with self.subTest(mode=mode, command=command, count=count):
                                tv = FakeTV()
                                client = player_bridge.PlayerBridgeClient(controller, object(),
                                                                           "cloud", object(), "tv")
                                client.session = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
                                client.tv = tv
                                client.dispatcher = pico.PlayerCommandDispatcher()
                                sent = []
                                client.send = sent.append
                                value = {"session": client.session,
                                    "id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "sequence": 1,
                                    "command": command, "count": count,
                                    "deadlineAt": int(time.time() * 1000) + 1200}
                                client._batch(value)
                                self.assertEqual(sent[-1]["type"], "batch_accepted")
                                self.assertTrue(sent[-1]["accepted"])
                                client._batch_step()
                                self.assertEqual(len(tv.requests), 1)
                                self.assertEqual(tv.requests[0], {"KEYLIST": [
                                    {"CODESET": 3, "CODE": code, "ACTION": "KEYPRESS"}
                                    for _ in range(count)]})
                                self.assertEqual([item["type"] for item in sent],
                                                 ["batch_accepted", "batch_progress", "batch_done"])
                                self.assertEqual(sent[-1]["state"], "complete")
                                self.assertEqual(sent[-1]["code"], "keylist_acknowledged")
                                self.assertEqual(sent[-1]["acknowledged"], count)
                                self.assertEqual(sent[-1]["metrics"]["smartcastRequests"], 1)
                                self.assertEqual(sent[-1]["metrics"]["avgMs"], 531)
                                client._batch_step()
                                self.assertEqual(len(tv.requests), 1)

    def test_player_batch_invalid_and_uncertain_key_stops_without_retry(self):
        class FakeTV:
            wrapped = object()
            last_used = 100
            calls = 0
            def keypress(self, _token, _body, timing):
                self.calls += 1
                timing["failed_phase"] = "read_body"
                raise OSError("response lost after write")
            def close(self, _reason="closed"): pass

        controller = types.SimpleNamespace(ticks=lambda: 100, PLAYER_KEYS=pico.PLAYER_KEYS,
            PLAYER_SESSION_HEARTBEAT_MS=2500, PLAYER_SESSION_STALE_MS=3500)
        client = player_bridge.PlayerBridgeClient(controller, object(), "cloud", object(), "tv")
        client.session = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        client.tv = FakeTV()
        client.dispatcher = pico.PlayerCommandDispatcher()
        sent = []
        client.send = sent.append
        value = {"session": client.session, "id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                 "sequence": 1, "command": "seek_forward", "count": 60,
                 "deadlineAt": int(time.time() * 1000) + 1200}
        with patch.object(player_bridge.time, "ticks_add", side_effect=lambda a, b: a + b, create=True), \
             patch.object(player_bridge.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True):
            bad = dict(value, count=2)
            client._batch(bad)
            self.assertEqual(sent[-1]["code"], "invalid")
            self.assertEqual(client.dispatcher.last_sequence, 0)
            client._batch(value)
            client._batch_step()
            self.assertEqual(client.tv.calls, 1)
            self.assertEqual(sent[-1]["state"], "unknown")
            self.assertEqual(sent[-1]["failures"], 1)
            client._batch_step()
            self.assertEqual(client.tv.calls, 1)

    def test_player_keylist_rejection_uncertainty_warmup_and_cancel_never_replay(self):
        class FakeTV:
            def __init__(self, outcome):
                self.outcome = outcome
                self.wrapped = object() if outcome != "warmup" else None
                self.last_used = 100 if outcome != "warmup" else None
                self.calls = 0
            def prewarm(self, _token): return False
            def keypress(self, _token, _body, timing):
                self.calls += 1
                if self.outcome == "rejected":
                    return {"STATUS": {"RESULT": "FAILURE"}}
                if self.outcome == "malformed":
                    return {"unexpected": "response"}
                if self.outcome == "not_sent":
                    timing["request_not_sent"] = True
                    raise OSError("timeout setup failed before any write")
                timing["failed_phase"] = "read_body"
                raise OSError("response lost after write")
            def close(self, _reason="closed"): pass

        controller = types.SimpleNamespace(ticks=lambda: 100, PLAYER_KEYS=pico.PLAYER_KEYS,
            PLAYER_SESSION_HEARTBEAT_MS=2500, PLAYER_SESSION_STALE_MS=3500)
        with patch.object(player_bridge.time, "ticks_add", side_effect=lambda a, b: a + b, create=True), \
             patch.object(player_bridge.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True):
            for outcome, state, code, calls in (("rejected", "failed", "tv_rejected", 1),
                                                ("malformed", "unknown", "ambiguous_response", 1),
                                                ("not_sent", "failed", "request_not_sent", 1),
                                                ("timeout", "unknown", "transport_OSError", 1),
                                                ("warmup", "failed", "warmup_failed", 0)):
                with self.subTest(outcome=outcome):
                    tv = FakeTV(outcome)
                    client = player_bridge.PlayerBridgeClient(controller, object(),
                                                               "cloud", object(), "tv")
                    client.session = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
                    client.tv = tv
                    client.dispatcher = pico.PlayerCommandDispatcher()
                    sent = []
                    client.send = sent.append
                    value = {"session": client.session,
                        "id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "sequence": 1,
                        "command": "seek_forward", "count": 60,
                        "deadlineAt": int(time.time() * 1000) + 1200}
                    client._batch(value)
                    if outcome == "rejected":
                        client._message(json.dumps({"type": "player_batch_cancel",
                            "session": client.session, "id": value["id"]}).encode())
                        self.assertEqual(sent[-1]["state"], "cancelled")
                        self.assertEqual(tv.calls, 0)
                        value["id"] = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
                        value["sequence"] = 2
                        client._batch(value)
                    client._batch_step()
                    self.assertEqual(sent[-1]["state"], state)
                    self.assertEqual(sent[-1]["code"], code)
                    self.assertEqual(sent[-1]["acknowledged"], 0)
                    self.assertEqual(sent[-1]["metrics"]["smartcastRequests"], calls)
                    client._batch_step()
                    self.assertEqual(tv.calls, calls)

    def test_player_sequential_debug_mode_uses_original_one_key_requests(self):
        class FakeTV:
            wrapped = object()
            last_used = 100
            def __init__(self): self.requests = []
            def keypress(self, _token, body, timing):
                self.requests.append(body)
                timing["request_ms"] = 120
                return {"STATUS": {"RESULT": "SUCCESS"}}
            def close(self, _reason="closed"): pass
        tv = FakeTV()
        controller = types.SimpleNamespace(ticks=lambda: 100, PLAYER_KEYS=pico.PLAYER_KEYS,
            PLAYER_SESSION_HEARTBEAT_MS=2500, PLAYER_SESSION_STALE_MS=3500)
        client = player_bridge.PlayerBridgeClient(controller, object(), "cloud", object(), "tv")
        client.session = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        client.tv = tv
        client.dispatcher = pico.PlayerCommandDispatcher()
        sent = []
        client.send = sent.append
        with patch.object(player_bridge.config, "PLAYER_SEEK_MODE", "sequential", create=True), \
             patch.object(player_bridge.time, "ticks_add", side_effect=lambda a, b: a + b, create=True), \
             patch.object(player_bridge.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True):
            client._batch({"session": client.session,
                "id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "sequence": 1,
                "command": "seek_forward", "count": 6,
                "deadlineAt": int(time.time() * 1000) + 1200})
            for _ in range(6): client._batch_step()
        self.assertEqual(len(tv.requests), 6)
        self.assertTrue(all(len(body["KEYLIST"]) == 1 for body in tv.requests))
        self.assertEqual(sent[-1]["state"], "complete")
        self.assertEqual(sent[-1]["metrics"]["smartcastRequests"], 6)

    def test_player_batch_session_close_drops_remaining_inputs(self):
        class FakeTV:
            wrapped = object()
            last_used = 100
            calls = 0
            def keypress(self, _token, _body, timing):
                self.calls += 1
                timing.update({"request_ms": 110, "connection": "warm"})
                return {"STATUS": {"RESULT": "SUCCESS"}}
            def close(self, _reason="closed"): pass

        controller = types.SimpleNamespace(ticks=lambda: 100, PLAYER_KEYS=pico.PLAYER_KEYS,
            PLAYER_SESSION_HEARTBEAT_MS=2500, PLAYER_SESSION_STALE_MS=3500)
        client = player_bridge.PlayerBridgeClient(controller, object(), "cloud", object(), "tv")
        client.session = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        client.tv = FakeTV()
        tv = client.tv
        client.dispatcher = pico.PlayerCommandDispatcher()
        client.send = lambda _value: None
        value = {"session": client.session, "id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                 "sequence": 1, "command": "seek_forward", "count": 30,
                 "deadlineAt": int(time.time() * 1000) + 1200}
        with patch.object(player_bridge.config, "PLAYER_SEEK_MODE", "sequential", create=True), \
             patch.object(player_bridge.time, "ticks_add", side_effect=lambda a, b: a + b, create=True), \
             patch.object(player_bridge.time, "ticks_diff", side_effect=lambda a, b: a - b, create=True):
            client._batch(value)
            client._batch_step()
            self.assertEqual(tv.calls, 1)
            client._message(json.dumps({"type": "player_session_close",
                "session": client.session}).encode())
            client._batch_step()
            self.assertIsNone(client.batch)
            self.assertEqual(tv.calls, 1)


if __name__ == "__main__":
    unittest.main()
