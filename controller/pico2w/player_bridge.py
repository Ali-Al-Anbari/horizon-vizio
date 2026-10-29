"""Opt-in, outbound WebSocket for the isolated Horizon Video Lab.

No key is replayed after a missing acknowledgement or network failure.
"""

import binascii
import hashlib
import json
import os
import select
import socket
import time

import config


HOST = "horizon-video-lab-preview.ali-al-anbari.workers.dev"
PATH = "/api/player/connect"
GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_MESSAGE = 512
LEASE_MS = 8000
RECONNECT_MS = 3000
SEEK_COUNTS = (1, 3, 6, 12, 30, 60)
BATCH_LIFETIME_MS = 90000


def _seek_mode():
    # Only an explicit debug choice retains the old sequential executor.
    # Missing settings and the former "verified" value both use KEYLIST.
    return "sequential" if getattr(config, "PLAYER_SEEK_MODE", None) == "sequential" else "all_keylist"


def _b64(value):
    return binascii.b2a_base64(value).strip()


def _frame(payload, opcode=1):
    if len(payload) > MAX_MESSAGE:
        raise ValueError("player message too large")
    mask = os.urandom(4)
    size = len(payload)
    header = bytes((0x80 | opcode, 0x80 | size)) if size < 126 else bytes(
        (0x80 | opcode, 0x80 | 126, size >> 8, size & 255))
    return header + mask + bytes(payload[i] ^ mask[i % 4] for i in range(size))


def _next_frame(buffer):
    if len(buffer) < 2:
        return None
    first, second = buffer[0], buffer[1]
    if first & 0x70 or second & 0x80 or not first & 0x80:
        raise ValueError("invalid server WebSocket frame")
    size = second & 127
    offset = 2
    if size == 126:
        if len(buffer) < 4:
            return None
        size = (buffer[2] << 8) | buffer[3]
        offset = 4
    elif size == 127:
        raise ValueError("oversized WebSocket frame")
    if size > MAX_MESSAGE:
        raise ValueError("oversized WebSocket frame")
    if len(buffer) < offset + size:
        return None
    payload = bytes(buffer[offset:offset + size])
    buffer[:offset + size] = b""
    return first & 15, payload


class PlayerBridgeClient:
    def __init__(self, controller, cloud_context, cloud_token, tv_context, tv_token):
        self.controller = controller
        self.cloud_context = cloud_context
        self.cloud_token = cloud_token
        self.tv_context = tv_context
        self.tv_token = tv_token
        self.socket = None
        self.raw = None
        self.poller = None
        self.poll_raw = False
        self.buffer = bytearray()
        self.session = None
        self.tv = None
        self.dispatcher = None
        self.expires = None
        self.heartbeat = None
        self.retry_at = 0
        self.batch = None
        self.disconnected_at = None

    def close_session(self):
        self.batch = None
        if self.tv is not None:
            self.tv.close("player_session_closed")
        self.tv = None
        self.dispatcher = None
        self.session = None
        self.expires = None
        self.heartbeat = None
        print("Player session closed")

    def close(self):
        self.close_session()
        wrapped = self.socket
        raw = self.raw
        self.socket = None
        self.raw = None
        self.poller = None
        self.poll_raw = False
        self.buffer = bytearray()
        if wrapped is not None:
            try:
                wrapped.close()
            except (OSError, ValueError):
                pass
        elif raw is not None:
            try:
                raw.close()
            except (OSError, ValueError):
                pass
        self.retry_at = time.ticks_add(self.controller.ticks(), RECONNECT_MS)
        if wrapped is not None or raw is not None:
            self.disconnected_at = self.controller.ticks()

    def connect(self):
        started = self.controller.ticks()
        raw = None
        wrapped = None
        try:
            address = socket.getaddrinfo(HOST, 443)[0][-1]
            raw = socket.socket()
            raw.settimeout(getattr(config, "CLOUD_SOCKET_TIMEOUT_S", 8))
            raw.connect(address)
            wrapped = self.cloud_context.wrap_socket(raw, server_hostname=HOST)
            key = _b64(os.urandom(16))
            request = (b"GET " + PATH.encode() + b" HTTP/1.1\r\nHost: " + HOST.encode()
                       + b"\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                       + b"Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: " + key
                       + b"\r\nAuthorization: Bearer " + self.cloud_token.encode()
                       + b"\r\n\r\n")
            self.controller.write_all(wrapped, request)
            reply = bytearray()
            while not reply.endswith(b"\r\n\r\n"):
                if len(reply) >= 2048:
                    raise ValueError("WebSocket handshake too large")
                part = wrapped.read(1)
                if not part:
                    raise OSError("WebSocket handshake incomplete")
                reply.extend(part)
            lines = bytes(reply).split(b"\r\n")
            if lines[0] != b"HTTP/1.1 101 Switching Protocols":
                raise OSError("WebSocket upgrade rejected")
            headers = {}
            for line in lines[1:]:
                if b":" in line:
                    name, value = line.split(b":", 1)
                    headers[name.lower()] = value.strip()
            expected = _b64(hashlib.sha1(key + GUID).digest())
            if (headers.get(b"sec-websocket-accept") != expected
                    or headers.get(b"upgrade", b"").lower() != b"websocket"
                    or b"upgrade" not in [part.strip().lower() for part in
                                          headers.get(b"connection", b"").split(b",")]):
                raise ValueError("invalid WebSocket handshake")
            raw.settimeout(0)
            poller = select.poll()
            poll_raw = False
            try:
                poller.register(wrapped, select.POLLIN)
            except (OSError, TypeError, ValueError, AttributeError):
                # Some MicroPython SSL streams do not implement poll/ioctl;
                # the underlying socket can still signal encrypted data.
                poller.register(raw, select.POLLIN)
                poll_raw = True
            self.socket = wrapped
            self.raw = raw
            self.poller = poller
            self.poll_raw = poll_raw
            print("Player bridge connected: handshake %d ms; reconnect %s ms" %
                  (time.ticks_diff(self.controller.ticks(), started),
                   time.ticks_diff(self.controller.ticks(), self.disconnected_at)
                   if self.disconnected_at is not None else "initial"))
            self.disconnected_at = None
        except Exception:
            if wrapped is not None:
                wrapped.close()
            elif raw is not None:
                raw.close()
            raise

    def send(self, value):
        if self.socket is None:
            raise OSError("player bridge disconnected")
        payload = json.dumps(value).encode()
        frame = _frame(payload)
        # Bounded write; never leave a partly written frame on the connection.
        self.raw.settimeout(2)
        try:
            self.controller.write_all(self.socket, frame)
        except Exception:
            self.close()
            raise
        finally:
            if self.socket is not None:
                self.raw.settimeout(0)

    def _open(self, value):
        session = value.get("session")
        if not isinstance(session, str) or len(session) != 36:
            return
        self.close_session()
        self.session = session
        self.expires = time.ticks_add(self.controller.ticks(), LEASE_MS)
        self.tv = self.controller.TVPlayerConnection(self.tv_context)
        self.dispatcher = self.controller.PlayerCommandDispatcher()
        started = self.controller.ticks()
        try:
            ready = self.tv.prewarm(self.tv_token) and self.tv.wrapped is not None
        except (OSError, ValueError, RuntimeError):
            ready = False
        print("Player session prepare: %s, %d ms" %
              ("ready" if ready else "failed", time.ticks_diff(self.controller.ticks(), started)))
        self.send({"type": "session_ready", "session": session, "ready": ready})
        if ready:
            self.heartbeat = time.ticks_add(self.controller.ticks(),
                                            self.controller.PLAYER_SESSION_HEARTBEAT_MS)
        else:
            self.close_session()

    def _command(self, value):
        if value.get("session") != self.session or self.tv is None:
            return
        command = value.get("command")
        sequence = value.get("sequence")
        command_id = value.get("id")
        if not isinstance(command_id, str) or len(command_id) != 36:
            return
        if self.batch is not None:
            self.send({"type": "command_ack", "session": self.session, "id": command_id,
                       "sequence": sequence, "accepted": False, "code": "busy"})
            return
        deadline = value.get("deadlineAt")
        epoch_offset = 946684800 if time.gmtime(0)[0] == 2000 else 0
        wall_ms = (time.time() + epoch_offset) * 1000
        if (not isinstance(deadline, int) or isinstance(deadline, bool)
                or wall_ms > deadline or deadline - wall_ms > 5000):
            self.send({"type": "command_ack", "session": self.session, "id": command_id,
                       "sequence": sequence, "accepted": False, "code": "expired"})
            return
        outcome = self.dispatcher.offer(sequence, command)
        if outcome != "queued":
            self.send({"type": "command_ack", "session": self.session, "id": command_id,
                       "sequence": sequence, "accepted": False, "code": outcome})
            return
        started = self.controller.ticks()
        # A read-only probe before an old idle socket avoids replaying an
        # ambiguous keypress on a connection that the TV already closed.
        prewarm_failed = False
        try:
            if (self.tv.last_used is None or time.ticks_diff(started, self.tv.last_used)
                    >= self.controller.PLAYER_SESSION_STALE_MS):
                if not self.tv.prewarm(self.tv_token):
                    raise RuntimeError("TV status rejected")
                if self.tv.wrapped is None:
                    raise RuntimeError("TV did not retain player socket")
            _, accepted = self.dispatcher.run_next(self.tv_context, self.tv_token, self.tv)
        except (OSError, ValueError, RuntimeError):
            accepted = False
            prewarm_failed = bool(self.dispatcher.pending)
            self.dispatcher.pending.clear()
            self.tv.close("player_command_error")
        self.heartbeat = time.ticks_add(self.controller.ticks(),
                                        self.controller.PLAYER_SESSION_HEARTBEAT_MS)
        print("Player bridge command %s %s: %s, %d ms" %
              (command_id[:8], command, "accepted" if accepted else "failed",
               time.ticks_diff(self.controller.ticks(), started)))
        self.send({"type": "command_ack", "session": self.session, "id": command_id,
                   "sequence": sequence, "accepted": accepted,
                   "code": "accepted" if accepted else "rejected"})
        if prewarm_failed:
            self.send({"type": "session_ready", "session": self.session, "ready": False})
            self.close_session()
        elif self.tv is not None and self.tv.wrapped is None:
            # Rotate after the bounded request cap. The command ACK is already
            # on the wire; this read-only preparation cannot repeat a key.
            try:
                if not self.tv.prewarm(self.tv_token) or self.tv.wrapped is None:
                    raise RuntimeError("TV did not retain player socket")
                print("Player socket rotated")
            except (OSError, ValueError, RuntimeError):
                self.send({"type": "session_ready", "session": self.session, "ready": False})
                self.close_session()

    def _batch(self, value):
        if value.get("session") != self.session or self.tv is None:
            return
        command = value.get("command")
        count = value.get("count")
        sequence = value.get("sequence")
        command_id = value.get("id")
        if not isinstance(command_id, str) or len(command_id) != 36:
            return
        code = None
        if self.batch is not None or self.dispatcher.pending:
            code = "busy"
        elif (command not in ("seek_forward", "seek_backward")
              or type(count) is not int or count not in SEEK_COUNTS):
            code = "invalid"
        else:
            deadline = value.get("deadlineAt")
            epoch_offset = 946684800 if time.gmtime(0)[0] == 2000 else 0
            wall_ms = (time.time() + epoch_offset) * 1000
            if (type(deadline) is not int or wall_ms > deadline
                    or deadline - wall_ms > 5000):
                code = "expired"
            elif (type(sequence) is not int or
                  sequence != self.dispatcher.last_sequence + 1):
                code = "sequence"
        if code is not None:
            self.send({"type": "batch_accepted", "session": self.session, "id": command_id,
                       "sequence": sequence, "accepted": False, "code": code})
            return
        self.dispatcher.last_sequence = sequence
        now = self.controller.ticks()
        self.batch = {"id": command_id, "sequence": sequence, "command": command,
                      "count": count, "ack": 0, "failures": 0, "started": now,
                      "expires": time.ticks_add(now, BATCH_LIFETIME_MS),
                      "min": None, "max": 0, "total": 0, "requests": 0,
                      "attempted": 0,
                      "warm": 0, "new": 0,
                      "keylist": _seek_mode() == "all_keylist"}
        print("Player batch accepted %s %s x%d" % (command_id[:8], command, count))
        self.send({"type": "batch_accepted", "session": self.session, "id": command_id,
                   "sequence": sequence, "accepted": True})

    def _batch_done(self, state, code):
        batch = self.batch
        if batch is None:
            return
        self.batch = None
        ack = batch["ack"]
        metrics = {"picoMs": time.ticks_diff(self.controller.ticks(), batch["started"]),
                   "minMs": batch["min"], "avgMs": batch["total"] // batch["requests"]
                   if batch["requests"] else None,
                   "maxMs": batch["max"], "warm": batch["warm"], "new": batch["new"],
                   "smartcastRequests": batch["attempted"]}
        print("Player batch %s %s: %s %d/%d, %d failures, %d ms, min/avg/max %s/%s/%s ms, warm/new %d/%d, code %s" %
              (batch["id"][:8], batch["command"], state, ack, batch["count"], batch["failures"],
               metrics["picoMs"], metrics["minMs"], metrics["avgMs"],
               metrics["maxMs"], metrics["warm"], metrics["new"], code))
        self.send({"type": "batch_done", "session": self.session, "id": batch["id"],
                   "sequence": batch["sequence"], "state": state, "code": code,
                   "acknowledged": ack, "failures": batch["failures"], "metrics": metrics})

    def _batch_step(self):
        batch = self.batch
        if batch is None or self.tv is None:
            return
        now = self.controller.ticks()
        if time.ticks_diff(now, batch["expires"]) >= 0:
            self._batch_done("failed", "lifetime")
            return
        if batch["ack"] >= batch["count"]:
            self._batch_done("complete", "acknowledged")
            return
        timing = {}
        # This read-only warmup may rotate the TV's eight-request socket.
        # A failed keypress is never retried, even if delivery is uncertain.
        try:
            if (self.tv.wrapped is None or self.tv.last_used is None
                    or time.ticks_diff(now, self.tv.last_used)
                    >= self.controller.PLAYER_SESSION_STALE_MS):
                if not self.tv.prewarm(self.tv_token) or self.tv.wrapped is None:
                    raise RuntimeError("TV warmup rejected")
        except (OSError, ValueError, RuntimeError) as error:
            batch["failures"] = 1
            print("Player batch read-only warmup failed before key: %s" % type(error).__name__)
            self._batch_done("failed", "warmup_failed")
            return
        codeset, code = self.controller.PLAYER_KEYS[batch["command"]]
        count = batch["count"] if batch["keylist"] else 1
        try:
            body = {"KEYLIST": [{"CODESET": codeset, "CODE": code, "ACTION": "KEYPRESS"}
                                for _ in range(count)]}
        except MemoryError:
            batch["failures"] = 1
            self._batch_done("failed", "request_not_built")
            return
        try:
            batch["attempted"] += 1
            result = self.tv.keypress(self.tv_token, body, timing)
            status = result.get("STATUS") if isinstance(result, dict) else None
            if not isinstance(status, dict) or "RESULT" not in status:
                batch["failures"] = 1
                print("Player batch ambiguous response for %d keys; HTTP %s" %
                      (count, timing.get("http_status", "?")))
                self._batch_done("unknown", "ambiguous_response")
                return
            if status.get("RESULT") != "SUCCESS":
                batch["failures"] = 1
                print("Player batch TV rejection at request for %d keys: STATUS %s; HTTP %s" %
                      (count, status, timing.get("http_status", "?")))
                self._batch_done("failed", "tv_rejected")
                return
        except (OSError, ValueError, RuntimeError, MemoryError) as error:
            batch["failures"] = 1
            not_sent = timing.get("request_not_sent") is True
            print("Player batch %s request for %d keys: %s %s; phase %s; HTTP %s; socket %s" %
                  ("not-sent" if not_sent else "uncertain", count,
                   type(error).__name__, str(error),
                   timing.get("failed_phase", timing.get("phase", "warmup")),
                   timing.get("http_status", "?"), timing.get("connection", "?")))
            self._batch_done("failed" if not_sent else "unknown",
                             "request_not_sent" if not_sent else "transport_" + type(error).__name__)
            return
        latency = timing.get("request_ms")
        if type(latency) is int:
            batch["min"] = latency if batch["min"] is None else min(batch["min"], latency)
            batch["max"] = max(batch["max"], latency)
            batch["total"] += latency
        batch["requests"] += 1
        if timing.get("connection") == "warm":
            batch["warm"] += 1
        else:
            batch["new"] += 1
        # One SUCCESS acknowledges one KEYLIST request, not observed YapGrid
        # movement or an independent response for each entry in that list.
        batch["ack"] += count
        self.heartbeat = time.ticks_add(self.controller.ticks(),
                                        self.controller.PLAYER_SESSION_HEARTBEAT_MS)
        self.send({"type": "batch_progress", "session": self.session, "id": batch["id"],
                   "sequence": batch["sequence"], "acknowledged": batch["ack"]})
        if batch["ack"] == batch["count"]:
            self._batch_done("complete", "keylist_acknowledged" if batch["keylist"]
                             else "acknowledged")

    def _message(self, payload):
        try:
            value = json.loads(payload.decode())
        except (ValueError, TypeError):
            return
        if not isinstance(value, dict):
            return
        kind = value.get("type")
        if kind == "player_session_open":
            self._open(value)
        elif kind == "player_session_renew" and value.get("session") == self.session:
            self.expires = time.ticks_add(self.controller.ticks(), LEASE_MS)
        elif kind == "player_session_close" and value.get("session") == self.session:
            self.close_session()
        elif kind == "player_command":
            self._command(value)
        elif kind == "player_batch":
            self._batch(value)
        elif kind == "player_batch_cancel" and self.batch is not None:
            if value.get("session") == self.session and value.get("id") == self.batch["id"]:
                self._batch_done("cancelled", "user_cancelled")

    def step(self):
        now = self.controller.ticks()
        if self.socket is None:
            if time.ticks_diff(now, self.retry_at) >= 0:
                try:
                    self.connect()
                except (OSError, ValueError, RuntimeError, TypeError, AttributeError, MemoryError) as error:
                    print("Player bridge waiting:", type(error).__name__)
                    self.close()
            return
        try:
            if self.expires is not None and time.ticks_diff(now, self.expires) >= 0:
                self.close_session()
            if self.poller.poll(0) or self.poll_raw:
                try:
                    part = self.socket.read(512)
                except OSError as error:
                    if error.args and error.args[0] in (11, 35):
                        part = None
                    else:
                        raise
                if part == b"":
                    raise OSError("player bridge closed")
                if part:
                    self.buffer.extend(part)
                    if len(self.buffer) > 1024:
                        raise ValueError("player frame buffer exceeded")
                    while True:
                        frame = _next_frame(self.buffer)
                        if frame is None:
                            break
                        opcode, payload = frame
                        if opcode == 1:
                            self._message(payload)
                        elif opcode == 9:
                            self.raw.settimeout(2)
                            self.controller.write_all(self.socket, _frame(payload, 10))
                            self.raw.settimeout(0)
                        elif opcode == 8:
                            # A close code distinguishes a server ACK timeout
                            # (1011) from a hibernation reconnect (1012).
                            close_code = (payload[0] << 8) | payload[1] if len(payload) >= 2 else 0
                            print("Player bridge close code:", close_code)
                            raise OSError("player bridge closed")
                        else:
                            raise ValueError("unsupported player frame")
            if (self.tv is not None and self.heartbeat is not None
                    and time.ticks_diff(self.controller.ticks(), self.heartbeat) >= 0):
                try:
                    if not self.tv.prewarm(self.tv_token):
                        raise RuntimeError("TV status rejected")
                    if self.tv.wrapped is None:
                        if not self.tv.prewarm(self.tv_token) or self.tv.wrapped is None:
                            raise RuntimeError("TV did not retain player socket")
                    print("Player heartbeat: read-only")
                    self.heartbeat = time.ticks_add(self.controller.ticks(),
                                                    self.controller.PLAYER_SESSION_HEARTBEAT_MS)
                except (OSError, ValueError, RuntimeError):
                    self.close_session()
            if self.batch is not None:
                self._batch_step()
        except (OSError, ValueError, RuntimeError, TypeError, AttributeError, MemoryError) as error:
            print("Player bridge reconnect:", type(error).__name__)
            import sys
            sys.print_exception(error)
            self.close()
