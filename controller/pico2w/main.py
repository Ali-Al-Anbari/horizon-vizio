"""Supervised-first Horizon controller for Pico 2 W / MicroPython v1.29.0.

The default boot path performs a read-only health check and exits. Automatic
Horizon launching requires the explicit device-local AUTO_LAUNCH_ON_POWER flag.
"""

import binascii
import gc
import json
import network
import ntptime
import os
import socket
import ssl
import time

import config
import secrets


STATE_FILE = "state.json"
STATE_TMP = "state.json.tmp"
MAX_RESPONSE = 6144
MAX_CLOUD_RESPONSE = 4096
MAX_CLOUD_HEADERS = 1536
WIFI_CONNECT_TIMEOUT_MS = 10000
WIFI_RETRY_MS = (1000, 2000, 4000, 8000, 15000, 30000, 60000)
NTP_RETRY_MS = (1000, 3000, 8000)
LAUNCH_RETRY_MS = (3000, 5000, 10000, 20000, 40000, 60000)
NTP_REFRESH_MS = 24 * 60 * 60 * 1000
POWER_POLL_MS = 3000
FRESH_POWER_HINT_MS = 1000
CLOUD_CONFIRM_MS = 15000
IHEART_MESSAGE = "https://tvclient.iheart.com/vizio"
IHEART_RETRY_AFTER_MS = 8000
IHEART_CONFIRM_MS = 20000
IHEART_COOLDOWN_MS = 15000
CLOUD_HOST = "horizon-vizio.ali-al-anbari.workers.dev"
CLOUD_PORT = 443
CLOUD_CLAIM_PATH = "/api/controller/claim"
CLOUD_RESULT_PATH = "/api/controller/result"
CLOUD_RETRY_MS = (3000, 5000, 10000, 20000, 40000, 60000)
CLOUD_KEEPALIVE_IDLE_MS = 5000
CLOUD_KEEPALIVE_MAX_REQUESTS = 12
CLOUD_APPS = {
    "youtube": {"APP_ID": "1", "NAME_SPACE": 5, "MESSAGE": None},
    "prime-video": {"APP_ID": "3", "NAME_SPACE": 3, "MESSAGE": None},
    "disney-plus": {"APP_ID": "75", "NAME_SPACE": 2, "MESSAGE": None},
    "live-tv": {"APP_ID": "3014", "NAME_SPACE": 2,
                 "MESSAGE": "http://127.0.0.1:12345/scfs/sctv/main.html#/watchfreeplus"},
    "plex": {"APP_ID": "9", "NAME_SPACE": 2, "MESSAGE": None},
}
CLOUD_APP_STATES = {
    "youtube": [{"APP_ID": "1", "NAME_SPACE": 5, "MESSAGE": None}],
    "prime-video": [{"APP_ID": "3", "NAME_SPACE": 3, "MESSAGE": None}],
    "disney-plus": [{"APP_ID": "75", "NAME_SPACE": 4,
                      "MESSAGE": "https://cd-dmgz.bamgrid.com/bbd/vizio_tv/index.html"}],
    "live-tv": [{"APP_ID": "3014", "NAME_SPACE": 4,
                  "MESSAGE": "http://127.0.0.1:12345/scfs/sctv/main.html#/watchfreeplus"}],
    "plex": [{"APP_ID": "9", "NAME_SPACE": 4,
              "MESSAGE": "https://app.plex.tv/tv-smartcast"}],
}
CLOUD_RESULT_CODES = ("app_confirmed", "tv_rejected", "tv_unconfirmed", "tv_unavailable", "controller_error")
CLOUD_APP_NAMES = {"youtube": "YouTube", "prime-video": "Prime Video", "disney-plus": "Disney+",
                   "live-tv": "Live TV", "plex": "Plex"}
NETWORK_TIMING = {"tv_dns": 0, "tv_tcp": 0, "tv_tls": 0, "tv_gc": 0,
                  "cloud_dns": 0, "cloud_tcp": 0, "cloud_tls": 0, "cloud_gc": 0}


def ticks():
    return time.ticks_ms()


def due(when):
    return time.ticks_diff(ticks(), when) >= 0


def next_watch_sleep_ms(now_tick, power_due, cloud_due, pending_due, cloud_enabled, cap_ms,
                        shortcut_due=None):
    """Wake for the next scheduled job; cap preserves periodic Wi-Fi checks."""
    wait = cap_ms
    deadlines = [power_due]
    if cloud_enabled:
        deadlines.append(cloud_due)
    if pending_due is not None:
        deadlines.append(pending_due)
    if shortcut_due is not None:
        deadlines.append(shortcut_due)
    for deadline in deadlines:
        remaining = time.ticks_diff(deadline, now_tick)
        if remaining < wait:
            wait = remaining
    return max(20, wait)


def next_periodic_due(previous_due, interval, completed_at):
    """Keep a request-start cadence, skipping missed slots after slow work."""
    next_due = time.ticks_add(previous_due, interval)
    return (time.ticks_add(completed_at, interval)
            if time.ticks_diff(completed_at, next_due) >= 0 else next_due)


def perf_start():
    return ticks() if getattr(config, "PERF_TIMING", False) is True else None


def perf_end(stage, started):
    if started is not None:
        print("Timing %s: %d ms" % (stage, time.ticks_diff(ticks(), started)))


def perf_network(stage, kind):
    if getattr(config, "PERF_TIMING", False) is True:
        print("Timing %s network: DNS %d ms, TCP %d ms, TLS %d ms, GC %d ms" %
              (stage, NETWORK_TIMING[kind + "_dns"], NETWORK_TIMING[kind + "_tcp"],
               NETWORK_TIMING[kind + "_tls"], NETWORK_TIMING[kind + "_gc"]))
        if hasattr(gc, "mem_free"):
            print("Timing free heap: %d B" % gc.mem_free())


def perf_slow(stage, started, kind, threshold_ms=750):
    if started is not None:
        elapsed = time.ticks_diff(ticks(), started)
        if elapsed > threshold_ms:
            print("Timing slow %s: %d ms" % (stage, elapsed))
            perf_network(stage, kind)


def token_value():
    token = getattr(secrets, "SMARTCAST_TOKEN", "")
    if not token or token.startswith("YOUR_"):
        return None
    return token


def controller_token():
    token = getattr(secrets, "CONTROLLER_TOKEN", "")
    if not isinstance(token, str) or len(token) < 32 or token.startswith("YOUR_"):
        return None
    return token


def validate_config():
    required = ("WIFI_SSID", "WIFI_PASSWORD", "TV_IP", "TV_TLS_NAME",
                "TV_CERT_SHA256", "HORIZON_URL")
    for name in required:
        value = getattr(config, name, "")
        if not isinstance(value, str) or not value or value.startswith("YOUR_"):
            raise RuntimeError("device config missing: " + name)
    if not config.HORIZON_URL.startswith("https://"):
        raise RuntimeError("Horizon URL must use HTTPS")
    pin = config.TV_CERT_SHA256.lower()
    if len(pin) != 64 or any(char not in "0123456789abcdef" for char in pin):
        raise RuntimeError("TV certificate pin must be 64 hexadecimal characters")
    return binascii.unhexlify(pin)


def save_power(value):
    # Write only on a confirmed state transition to limit flash wear.
    with open(STATE_TMP, "w") as file:
        file.write(json.dumps({"last_power": value}))
    try:
        os.remove(STATE_FILE)
    except OSError:
        pass
    os.rename(STATE_TMP, STATE_FILE)


def load_power():
    try:
        with open(STATE_FILE) as file:
            value = json.loads(file.read()).get("last_power")
        return value if value in (0, 1) else None
    except (OSError, ValueError):
        return None


def connect_wifi(wlan):
    if wlan.isconnected():
        address = wlan.ifconfig()[0]
        return address not in ("", "0.0.0.0")
    wlan.active(True)
    try:
        wlan.disconnect()
    except OSError:
        pass
    wlan.connect(config.WIFI_SSID, config.WIFI_PASSWORD)
    deadline = time.ticks_add(ticks(), WIFI_CONNECT_TIMEOUT_MS)
    while not due(deadline):
        if wlan.isconnected():
            address = wlan.ifconfig()[0]
            if address not in ("", "0.0.0.0"):
                return True
        time.sleep_ms(250)
    return False


def synchronize_time():
    host = getattr(config, "NTP_HOST", "pool.ntp.org")
    ntptime.host = host
    last_error = None
    for delay in NTP_RETRY_MS:
        try:
            ntptime.settime()
            if time.gmtime()[0] < 2025:
                raise RuntimeError("NTP returned an implausible clock")
            return True
        except (OSError, ValueError, RuntimeError) as error:
            last_error = error
            time.sleep_ms(delay)
    raise RuntimeError("NTP synchronization failed: " + type(last_error).__name__)


def tls_context():
    pin = validate_config()
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.verify_mode = ssl.CERT_REQUIRED

    # The custom API belongs to the native mbedTLS context exposed by this
    # firmware. Do not fall back to a Python wrapper callback or unverified TLS.
    native_context = getattr(context, "_context", None)
    set_pin = getattr(native_context, "set_pin_sha256", None)
    if set_pin is None:
        raise RuntimeError("native certificate-pinning API unavailable")
    set_pin(pin)
    if context.verify_mode != ssl.CERT_REQUIRED:
        raise RuntimeError("TLS verification mode is not CERT_REQUIRED")
    return context


def open_pinned_socket(context):
    raw = None
    try:
        started = perf_start()
        address = socket.getaddrinfo(config.TV_IP, 7345)[0][-1]
        if started is not None:
            NETWORK_TIMING["tv_dns"] = time.ticks_diff(ticks(), started)
        raw = socket.socket()
        raw.settimeout(config.SOCKET_TIMEOUT_S)
        started = perf_start()
        raw.connect(address)
        if started is not None:
            NETWORK_TIMING["tv_tcp"] = time.ticks_diff(ticks(), started)
        # Default handshake is synchronous. On error, no HTTP bytes are sent.
        started = perf_start()
        wrapped = context.wrap_socket(raw, server_hostname=config.TV_TLS_NAME)
        if started is not None:
            NETWORK_TIMING["tv_tls"] = time.ticks_diff(ticks(), started)
        return wrapped
    except Exception:
        if raw is not None:
            raw.close()
        raise


def cloud_tls_context():
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.verify_mode = ssl.CERT_REQUIRED
    # A separate public CA trust anchor for Cloudflare. The Vizio leaf pin is
    # private to the TV context and is never loaded into this context.
    context.load_verify_locations(cafile=getattr(config, "CLOUD_CA_FILE", "cloud-root-isrg-x1.pem"))
    if context.verify_mode != ssl.CERT_REQUIRED:
        raise RuntimeError("Cloud TLS verification is not CERT_REQUIRED")
    return context


def open_cloud_socket(context):
    raw = None
    try:
        started = perf_start()
        address = socket.getaddrinfo(CLOUD_HOST, CLOUD_PORT)[0][-1]
        if started is not None:
            NETWORK_TIMING["cloud_dns"] = time.ticks_diff(ticks(), started)
        raw = socket.socket()
        raw.settimeout(getattr(config, "CLOUD_SOCKET_TIMEOUT_S", 8))
        started = perf_start()
        raw.connect(address)
        if started is not None:
            NETWORK_TIMING["cloud_tcp"] = time.ticks_diff(ticks(), started)
        # TLS handshake and hostname verification complete before the bearer
        # credential is written. Redirects are not followed by this client.
        started = perf_start()
        wrapped = context.wrap_socket(raw, server_hostname=CLOUD_HOST)
        if started is not None:
            NETWORK_TIMING["cloud_tls"] = time.ticks_diff(ticks(), started)
        return wrapped
    except Exception:
        if raw is not None:
            raw.close()
        raise


def cloud_tls_probe(context):
    wrapped = open_cloud_socket(context)
    wrapped.close()


class _IncompleteHTTPResponse(RuntimeError):
    pass


def _decode_chunked(body, max_body, strict=False):
    output = bytearray()
    offset = 0
    while True:
        end = body.find(b"\r\n", offset)
        if end < 0:
            raise _IncompleteHTTPResponse()
        size_text = body[offset:end].split(b";", 1)[0]
        if strict and (not size_text or any(char not in b"0123456789abcdefABCDEF" for char in size_text)):
            raise RuntimeError("invalid chunked HTTP size")
        try:
            size = int(size_text, 16)
        except ValueError:
            raise RuntimeError("invalid chunked Cloud response")
        offset = end + 2
        if size == 0:
            if not strict:
                return bytes(output)
            if body[offset:offset + 2] == b"\r\n":
                if offset + 2 != len(body):
                    raise RuntimeError("unexpected bytes after chunked HTTP body")
                return bytes(output)
            trailers_end = body.find(b"\r\n\r\n", offset)
            if trailers_end < 0:
                line_end = body.find(b"\r\n", offset)
                if line_end >= 0 and b":" not in body[offset:line_end]:
                    raise RuntimeError("invalid chunked HTTP trailer")
                raise _IncompleteHTTPResponse()
            for line in body[offset:trailers_end].split(b"\r\n"):
                if b":" not in line:
                    raise RuntimeError("invalid chunked HTTP trailer")
            if trailers_end + 4 != len(body):
                raise RuntimeError("unexpected bytes after chunked HTTP body")
            return bytes(output)
        next_offset = offset + size
        if next_offset + 2 > len(body):
            raise _IncompleteHTTPResponse()
        if body[next_offset:next_offset + 2] != b"\r\n":
            raise RuntimeError("invalid chunked HTTP delimiter")
        if len(output) + size > max_body:
            raise RuntimeError("HTTP response body too large")
        output.extend(body[offset:next_offset])
        offset = next_offset + 2


def _parse_http_head(raw, max_headers, strict=False):
    head, separator, body = raw.partition(b"\r\n\r\n")
    if not separator:
        raise _IncompleteHTTPResponse()
    if len(head) > max_headers:
        raise RuntimeError("HTTP response headers too large")
    lines = head.decode().split("\r\n")
    status_line = lines[0].split()
    if len(status_line) < 2 or not status_line[0].startswith("HTTP/"):
        raise RuntimeError("invalid HTTP status")
    try:
        status = int(status_line[1])
    except ValueError:
        raise RuntimeError("invalid HTTP status")
    headers = {}
    for line in lines[1:]:
        if ":" not in line:
            raise RuntimeError("invalid HTTP header")
        name, value = line.split(":", 1)
        name = name.strip().lower()
        if strict and name in headers:
            raise RuntimeError("duplicate HTTP header")
        headers[name] = value.strip().lower()
    if strict and "content-length" in headers and "transfer-encoding" in headers:
        raise RuntimeError("ambiguous HTTP body framing")
    if strict and "transfer-encoding" in headers and headers["transfer-encoding"] != "chunked":
        raise RuntimeError("unsupported HTTP transfer encoding")
    return status, headers, body


def parse_http_response(raw, max_body, max_headers, require_framing=False, strict=False):
    status, headers, body = _parse_http_head(raw, max_headers, strict)
    if status == 204:
        return status, None
    if "chunked" in headers.get("transfer-encoding", ""):
        body = _decode_chunked(body, max_body, strict)
    elif "content-length" in headers:
        length_text = headers["content-length"]
        if strict and (not length_text or any(char not in "0123456789" for char in length_text)):
            raise RuntimeError("invalid HTTP content length")
        try:
            length = int(length_text)
        except ValueError:
            raise RuntimeError("invalid HTTP content length")
        if length < 0 or length > max_body:
            raise RuntimeError("HTTP response body too large")
        if len(body) < length:
            raise _IncompleteHTTPResponse()
        if strict and len(body) > length:
            raise RuntimeError("unexpected bytes after HTTP response body")
        body = body[:length]
    elif require_framing:
        raise RuntimeError("HTTP response is missing body framing")
    if len(body) > max_body:
        raise RuntimeError("HTTP response body too large")
    if not body:
        return status, None
    try:
        return status, json.loads(body)
    except (ValueError, TypeError):
        raise RuntimeError("invalid HTTP JSON response")


def parse_cloud_response(raw):
    return parse_http_response(raw, MAX_CLOUD_RESPONSE, MAX_CLOUD_HEADERS)


def http_response_complete(raw, max_body, max_headers, require_framing=False, strict=False):
    try:
        status, headers, body = _parse_http_head(raw, max_headers, strict)
    except _IncompleteHTTPResponse:
        return False
    if status == 204:
        return True
    if "chunked" in headers.get("transfer-encoding", ""):
        try:
            _decode_chunked(body, max_body, strict)
            return True
        except _IncompleteHTTPResponse:
            return False
    if "content-length" in headers:
        length_text = headers["content-length"]
        if strict and (not length_text or any(char not in "0123456789" for char in length_text)):
            raise RuntimeError("invalid HTTP content length")
        try:
            length = int(length_text)
        except ValueError:
            raise RuntimeError("invalid HTTP content length")
        if length < 0 or length > max_body:
            raise RuntimeError("HTTP response body too large")
        return len(body) >= length
    if require_framing:
        raise RuntimeError("HTTP response is missing body framing")
    return False


def read_http_response(wrapped, max_total, max_body, max_headers, require_framing=False, strict=False):
    response = bytearray()
    while True:
        block = wrapped.read(512)
        if not block:
            break
        if len(response) + len(block) > max_total:
            raise RuntimeError("HTTP response too large")
        response.extend(block)
        if http_response_complete(response, max_body, max_headers, require_framing, strict):
            break
    return bytes(response)


def write_all(wrapped, data):
    offset = 0
    while offset < len(data):
        written = wrapped.write(data[offset:])
        if not isinstance(written, int) or written <= 0:
            raise RuntimeError("socket write failed")
        offset += written


def cloud_response_complete(raw):
    # Compatibility wrapper retained for the cloud client and its tests.
    try:
        return http_response_complete(raw, MAX_CLOUD_RESPONSE, MAX_CLOUD_HEADERS)
    except RuntimeError:
        return False


def _cloud_read_exact(wrapped, length):
    data = bytearray()
    while len(data) < length:
        block = wrapped.read(min(512, length - len(data)))
        if not block:
            raise _IncompleteHTTPResponse()
        if len(block) > length - len(data):
            raise RuntimeError("Cloud response exceeded framed length")
        data.extend(block)
    return data


def _cloud_read_line(wrapped, limit):
    line = bytearray()
    while len(line) < limit:
        byte = wrapped.read(1)
        if not byte:
            raise _IncompleteHTTPResponse()
        if len(byte) != 1:
            raise RuntimeError("Cloud response exceeded framed line")
        line.extend(byte)
        if len(line) >= 2 and line[-2:] == b"\r\n":
            return line
    raise RuntimeError("Cloud response line too long")


def read_persistent_cloud_response(wrapped):
    """Read exactly one HTTP/1.1 response; leave the next response untouched."""
    raw = bytearray()
    while len(raw) < MAX_CLOUD_HEADERS + 4:
        byte = wrapped.read(1)
        if not byte:
            raise _IncompleteHTTPResponse()
        if len(byte) != 1:
            raise RuntimeError("Cloud response exceeded framed header")
        raw.extend(byte)
        if raw[-4:] == b"\r\n\r\n":
            break
    else:
        raise RuntimeError("Cloud response headers too large")
    status, headers, _body = _parse_http_head(raw, MAX_CLOUD_HEADERS, strict=True)
    if status != 204:
        if headers.get("transfer-encoding") == "chunked":
            decoded_length = 0
            while True:
                line = _cloud_read_line(wrapped, 96)
                size_text = line[:-2].split(b";", 1)[0]
                if not size_text or any(char not in b"0123456789abcdefABCDEF" for char in size_text):
                    raise RuntimeError("invalid chunked Cloud size")
                size = int(size_text, 16)
                decoded_length += size
                if decoded_length > MAX_CLOUD_RESPONSE:
                    raise RuntimeError("Cloud response body too large")
                raw.extend(line)
                if size:
                    raw.extend(_cloud_read_exact(wrapped, size + 2))
                else:
                    while True:
                        trailer = _cloud_read_line(wrapped, 256)
                        raw.extend(trailer)
                        if len(raw) > MAX_CLOUD_RESPONSE + MAX_CLOUD_HEADERS + 4:
                            raise RuntimeError("Cloud response too large")
                        if trailer == b"\r\n":
                            break
                    break
                if len(raw) > MAX_CLOUD_RESPONSE + MAX_CLOUD_HEADERS + 4:
                    raise RuntimeError("Cloud response too large")
        elif "content-length" in headers:
            length_text = headers["content-length"]
            if not length_text or any(char not in "0123456789" for char in length_text):
                raise RuntimeError("invalid Cloud content length")
            length = int(length_text)
            if length > MAX_CLOUD_RESPONSE:
                raise RuntimeError("Cloud response body too large")
            raw.extend(_cloud_read_exact(wrapped, length))
        else:
            raise RuntimeError("persistent Cloud response lacks framing")
    elif (headers.get("transfer-encoding") is not None
          or headers.get("content-length", "0") != "0"):
        raise RuntimeError("invalid no-content Cloud response")
    if len(raw) > MAX_CLOUD_RESPONSE + MAX_CLOUD_HEADERS + 4:
        raise RuntimeError("Cloud response too large")
    parsed_status, body = parse_http_response(raw, MAX_CLOUD_RESPONSE, MAX_CLOUD_HEADERS,
                                              require_framing=True, strict=True)
    return parsed_status, body, headers, raw[:9] == b"HTTP/1.1 "


class CloudConnection:
    """One CA-verified socket; never replay a failed or ambiguous POST."""
    def __init__(self, context):
        self.context = context
        self.wrapped = None
        self.last_used = None
        self.requests = 0

    def close(self):
        wrapped = self.wrapped
        self.wrapped = None
        self.last_used = None
        self.requests = 0
        if wrapped is not None:
            try:
                wrapped.close()
            except (OSError, ValueError, RuntimeError):
                pass

    def exchange(self, headers, payload):
        if self.wrapped is not None and (self.last_used is None
                or time.ticks_diff(ticks(), self.last_used) >= CLOUD_KEEPALIVE_IDLE_MS
                or self.requests >= CLOUD_KEEPALIVE_MAX_REQUESTS):
            self.close()
        reused = self.wrapped is not None
        if reused and getattr(config, "PERF_TIMING", False) is True:
            NETWORK_TIMING["cloud_dns"] = 0
            NETWORK_TIMING["cloud_tcp"] = 0
            NETWORK_TIMING["cloud_tls"] = 0
        if self.wrapped is None:
            self.wrapped = open_cloud_socket(self.context)
        try:
            write_all(self.wrapped, headers)
            if payload:
                write_all(self.wrapped, payload)
            status, body, response_headers, http11 = read_persistent_cloud_response(self.wrapped)
            self.requests += 1
            connection = response_headers.get("connection", "")
            if (not http11 or any(part.strip() == "close" for part in connection.split(","))
                    or status not in (200, 204)
                    or self.requests >= CLOUD_KEEPALIVE_MAX_REQUESTS):
                self.close()
            else:
                self.last_used = ticks()
            if getattr(config, "PERF_TIMING", False) is True:
                print("Timing Cloud connection: %s" % ("reused" if reused else "new"))
            return status, body
        except Exception:
            self.close()
            raise


def cloud_request(path, credential, method="POST", body=None, context=None, session=None):
    if path not in (CLOUD_CLAIM_PATH, CLOUD_RESULT_PATH):
        raise RuntimeError("Cloud path is not allowlisted")
    if method not in ("POST", "GET") or (method == "GET" and path != CLOUD_CLAIM_PATH):
        raise RuntimeError("Cloud method is not allowlisted")
    if not isinstance(credential, str) or len(credential) < 32 or "\r" in credential or "\n" in credential:
        raise RuntimeError("Cloud controller credential is invalid")
    payload = b"" if body is None else json.dumps(body).encode()
    headers = (method + " " + path + " HTTP/1.1\r\n"
               + "Host: " + CLOUD_HOST + "\r\n"
               + "Authorization: Bearer " + credential + "\r\n"
               + "Content-Type: application/json\r\n"
               + "Content-Length: " + str(len(payload)) + "\r\n"
               + "Cache-Control: no-store\r\n"
               + ("Connection: keep-alive\r\n\r\n" if session is not None
                  else "Connection: close\r\n\r\n")).encode()
    if session is not None:
        try:
            return session.exchange(headers, payload)
        finally:
            started = perf_start()
            gc.collect()
            if started is not None:
                NETWORK_TIMING["cloud_gc"] = time.ticks_diff(ticks(), started)
    wrapped = None
    try:
        wrapped = open_cloud_socket(cloud_tls_context() if context is None else context)
        write_all(wrapped, headers)
        if payload:
            write_all(wrapped, payload)
        response = bytearray()
        while True:
            block = wrapped.read(512)
            if not block:
                break
            if len(response) + len(block) > MAX_CLOUD_RESPONSE + MAX_CLOUD_HEADERS + 4:
                raise RuntimeError("Cloud response too large")
            response.extend(block)
            if cloud_response_complete(response):
                break
        return parse_cloud_response(bytes(response))
    finally:
        if wrapped is not None:
            wrapped.close()
        started = perf_start()
        gc.collect()
        if started is not None:
            NETWORK_TIMING["cloud_gc"] = time.ticks_diff(ticks(), started)


def tls_probe(context):
    wrapped = open_pinned_socket(context)
    wrapped.close()


def tv_request(context, token, method, path, body=None):
    payload = b"" if body is None else json.dumps(body).encode()
    header = (method + " " + path + " HTTP/1.1\r\n"
              + "Host: " + config.TV_IP + ":7345\r\n"
              + "AUTH: " + token + "\r\n"
              + "Accept: application/json\r\n"
              + "Connection: close\r\n")
    if body is not None:
        header += ("Content-Type: application/json\r\n"
                   + "Content-Length: " + str(len(payload)) + "\r\n")
    header = (header + "\r\n").encode()
    wrapped = None
    try:
        wrapped = open_pinned_socket(context)
        write_all(wrapped, header)
        if payload:
            write_all(wrapped, payload)
        response = read_http_response(wrapped, MAX_RESPONSE, MAX_RESPONSE,
                                      MAX_CLOUD_HEADERS, require_framing=True, strict=True)
        status, result = parse_http_response(response, MAX_RESPONSE,
                                             MAX_CLOUD_HEADERS, require_framing=True, strict=True)
        if status != 200:
            raise RuntimeError("TV HTTP status not 200")
        if not isinstance(result, dict):
            raise RuntimeError("TV HTTP response is not a JSON object")
        return result
    finally:
        if wrapped is not None:
            wrapped.close()
        started = perf_start()
        gc.collect()
        if started is not None:
            NETWORK_TIMING["tv_gc"] = time.ticks_diff(ticks(), started)


def checked_request(context, token, method, path, body=None):
    result = tv_request(context, token, method, path, body)
    if result.get("STATUS", {}).get("RESULT") != "SUCCESS":
        raise RuntimeError("TV API rejected request")
    return result


def power_state(context, token):
    result = checked_request(context, token, "GET", "/state/device/power_mode")
    for item in result.get("ITEMS", ()):
        if item.get("CNAME") == "power_mode":
            value = item.get("VALUE")
            if value in (0, "0", False):
                return 0
            if value in (1, "1", True):
                return 1
    raise RuntimeError("unrecognized TV power state")


def current_app(context, token):
    result = checked_request(context, token, "GET", "/app/current")
    candidates = [result.get("ITEM"), result] + result.get("ITEMS", [])
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        value = candidate.get("VALUE", candidate)
        if isinstance(value, dict) and "APP_ID" in value:
            return value
    raise RuntimeError("TV did not report current app")


def horizon_is_active(context, token):
    return str(current_app(context, token).get("APP_ID")) == "17"


def launch_horizon(context, token):
    body = {"VALUE": {"APP_ID": "17", "NAME_SPACE": 4,
                      "MESSAGE": config.HORIZON_URL}}
    return checked_request(context, token, "PUT", "/app/launch", body)


def iheart_app_matches(app):
    if not isinstance(app, dict) or str(app.get("NAME_SPACE")) != "4" or str(app.get("APP_ID")) != "6":
        return False
    message = app.get("MESSAGE")
    return (message is None or message == "" or
            (isinstance(message, str) and message.strip().rstrip("/") == IHEART_MESSAGE))


def shortcut_horizon_matches(app):
    return (isinstance(app, dict) and str(app.get("NAME_SPACE")) == "4"
            and str(app.get("APP_ID")) == "17"
            and isinstance(app.get("MESSAGE"), str)
            and app["MESSAGE"].strip().rstrip("/") == config.HORIZON_URL.rstrip("/"))


def shortcut_app_label(app):
    """Only numeric namespace/app IDs are eligible for diagnostic output."""
    if not isinstance(app, dict):
        return "?/?"
    namespace = str(app.get("NAME_SPACE"))
    app_id = str(app.get("APP_ID"))
    if not (namespace.isdigit() and app_id.isdigit()
            and len(namespace) <= 3 and len(app_id) <= 6):
        return "?/?"
    return namespace + "/" + app_id


def shortcut_diag(state, event, now, app=None, detail="-"):
    if getattr(config, "IHEART_DIAGNOSTICS", False) is not True:
        return
    detected = state.get("detected_at")
    elapsed = time.ticks_diff(now, detected) if detected is not None else 0
    cooldown = state.get("cooldown_at")
    cooling = cooldown is not None and time.ticks_diff(now, cooldown) < 0
    print("iHeart diag +%dms %s prev=%s current=%s launch=%s retry=%d poll_lag=%dms cooldown=%s detail=%s" %
          (elapsed, event, state.get("previous_app", "?/?"), shortcut_app_label(app),
           state.get("launch_outcome", "none"), state.get("retry_count", 0),
           state.get("poll_lag_ms", 0),
           "active" if cooling else "ready", detail))


def shortcut_finish(state, now, outcome, app=None):
    detail = outcome
    if outcome == "confirmed" and state.get("had_read_error"):
        detail = "confirmed_after_read_error"
    elif outcome == "confirmed" and state.get("horizon_missing_count"):
        detail = "confirmed_after_nonmatching_sample"
    shortcut_diag(state, "finish", now, app, detail)
    state["pending_at"] = None
    state["cooldown_at"] = time.ticks_add(now, IHEART_COOLDOWN_MS)
    state["horizon_seen_at"] = None
    if outcome == "confirmed":
        if getattr(config, "PERF_TIMING", False) is True:
            print("Timing iHeart detection to Horizon confirmation: %d ms" %
                  time.ticks_diff(now, state["detected_at"]))
        print("iHeart shortcut: Horizon confirmed")
    elif outcome == "horizon_lost":
        print("iHeart shortcut: Horizon appeared, then another app became active")
    elif outcome == "superseded":
        print("iHeart shortcut: superseded by cloud app launch")
    elif outcome == "app_changed":
        print("iHeart shortcut: another app became active; no retry")
    elif outcome == "tv_off":
        print("iHeart shortcut: TV turned off; no retry")
    else:
        print("iHeart shortcut: Horizon not confirmed (%s)" % outcome)


def shortcut_send_launch(context, token, state, retry=False):
    started = perf_start()
    try:
        launch_horizon(context, token)
        outcome = "accepted"
    except RuntimeError as error:
        outcome = "rejected" if str(error) == "TV API rejected request" else "invalid_response"
    except (OSError, ValueError):
        outcome = "transport_error"
    state["launch_outcome"] = outcome
    shortcut_diag(state, "retry_launch" if retry else "launch", ticks(), detail=outcome)
    if outcome == "accepted":
        perf_end("iHeart Horizon launch request", started)
        perf_network("iHeart launch", "tv")
    elif outcome == "rejected":
        perf_network("iHeart rejected launch", "tv")
    else:
        print("iHeart shortcut: launch %s; awaiting TV state" % outcome)
    if outcome == "rejected":
        print("iHeart shortcut: launch rejected; awaiting TV state")


def shortcut_superseded_by_cloud(state):
    if state["pending_at"] is not None:
        shortcut_finish(state, ticks(), "superseded")
    state["observed"] = True
    state["latched"] = True


def iheart_shortcut_step(context, token, state):
    """Read app state and allow one guarded retry for an unconfirmed launch."""
    read_started = perf_start()
    try:
        app = current_app(context, token)
    except (OSError, ValueError, RuntimeError):
        now = ticks()
        if state["pending_at"] is None:
            raise
        state["had_read_error"] = True
        shortcut_diag(state, "verification_error", now, detail="tv_state_unavailable")
        if time.ticks_diff(now, state["pending_at"]) >= IHEART_CONFIRM_MS:
            shortcut_finish(state, now, "tv_unavailable")
        return
    now = ticks()
    iheart = iheart_app_matches(app)
    if not iheart:
        perf_slow("iHeart app-state read", read_started, "tv")
    app_label = shortcut_app_label(app) if getattr(config, "IHEART_DIAGNOSTICS", False) is True else None
    if not state["observed"]:
        # A reboot while iHeart is active is a baseline, not a new button press.
        state["observed"] = True
        state["latched"] = iheart
        if app_label is not None:
            state["last_app"] = app_label
        return

    if state["pending_at"] is not None:
        if shortcut_horizon_matches(app):
            shortcut_diag(state, "horizon_sample", now, app)
            if state.get("horizon_seen_at") is None:
                state["horizon_seen_at"] = now
                state["horizon_missing_count"] = 0
            else:
                shortcut_finish(state, now, "confirmed", app)
        elif state.get("horizon_seen_at") is not None:
            state["horizon_missing_count"] = state.get("horizon_missing_count", 0) + 1
            if state["horizon_missing_count"] >= 2:
                shortcut_finish(state, now, "horizon_lost", app)
            else:
                shortcut_diag(state, "horizon_missing_sample", now, app)
        elif not iheart:
            shortcut_finish(state, now, "app_changed", app)
        elif time.ticks_diff(now, state["pending_at"]) >= IHEART_CONFIRM_MS:
            shortcut_finish(state, now, "timeout", app)
        elif (state.get("retry_count", 0) == 0
              and (state.get("launch_outcome") == "rejected"
                   or time.ticks_diff(now, state["pending_at"]) >= IHEART_RETRY_AFTER_MS)):
            # Recheck both power and app after the first sample. A cloud claim
            # or an unrelated app transition must not be overwritten.
            try:
                mode = power_state(context, token)
                fresh_app = current_app(context, token) if mode == 1 else None
            except (OSError, ValueError, RuntimeError):
                state["had_read_error"] = True
                shortcut_diag(state, "retry_gate", ticks(), detail="tv_state_unavailable")
                return
            now = ticks()
            if mode != 1:
                shortcut_finish(state, now, "tv_off")
            elif shortcut_horizon_matches(fresh_app):
                state["horizon_seen_at"] = now
                shortcut_diag(state, "retry_gate", now, fresh_app, "horizon_seen")
            elif not iheart_app_matches(fresh_app):
                shortcut_finish(state, now, "app_changed", fresh_app)
            else:
                state["retry_count"] = 1
                shortcut_diag(state, "retry_gate", now, fresh_app, "tv_on_iheart")
                shortcut_send_launch(context, token, state, retry=True)
        else:
            shortcut_diag(state, "verification_sample", now, app, "iheart_active")
        if app_label is not None:
            state["last_app"] = app_label
        if state["pending_at"] is not None:
            return
        state["latched"] = iheart
        return

    if not iheart:
        state["latched"] = False
        if app_label is not None:
            state["last_app"] = app_label
        return
    if state["latched"]:
        return
    if state["cooldown_at"] is not None and time.ticks_diff(now, state["cooldown_at"]) < 0:
        shortcut_diag(state, "cooldown", now, app, "new_entry_deferred")
        return

    state["latched"] = True
    perf_end("iHeart app-state read", read_started)
    perf_network("iHeart app-state read", "tv")
    state["detected_at"] = now
    state["previous_app"] = state.get("last_app", "?/?")
    if app_label is not None:
        state["last_app"] = app_label
    state["retry_count"] = 0
    state["horizon_seen_at"] = None
    state["horizon_missing_count"] = 0
    state["had_read_error"] = False
    state["launch_outcome"] = "none"
    shortcut_diag(state, "detected", now, app)
    # Latch before PUT: an ambiguous response must not cause another launch.
    state["pending_at"] = now
    shortcut_send_launch(context, token, state)


def valid_command_id(value):
    if not isinstance(value, str) or len(value) != 36:
        return False
    for index, char in enumerate(value.lower()):
        if index in (8, 13, 18, 23):
            if char != "-":
                return False
        elif char not in "0123456789abcdef":
            return False
    return True


def native_app_matches(actual, expected):
    return (isinstance(actual, dict)
            and str(actual.get("APP_ID")) == expected["APP_ID"]
            and actual.get("NAME_SPACE") == expected["NAME_SPACE"]
            and (actual.get("MESSAGE") or "") == (expected.get("MESSAGE") or ""))


def requested_app_active(context, token, app):
    actual = current_app(context, token)
    return any(native_app_matches(actual, expected)
               for expected in CLOUD_APP_STATES[app])


def launch_cloud_app(context, token, app, power_hint=None):
    if app not in CLOUD_APPS:
        return "failed", "controller_error"
    try:
        hint_age = (time.ticks_diff(ticks(), power_hint[1])
                    if (getattr(config, "CLOUD_REUSE_RECENT_POWER", False) is True
                        and power_hint is not None and power_hint[0] == 1) else -1)
        if 0 <= hint_age <= FRESH_POWER_HINT_MS:
            mode = 1
            if getattr(config, "PERF_TIMING", False) is True:
                print("Timing TV power reused: %d ms old" % hint_age)
        else:
            started = perf_start()
            mode = power_state(context, token)
            perf_end("TV power read", started)
            perf_network("TV power read", "tv")
        if mode != 1:
            return "failed", "tv_unavailable"
        # Do not send another PUT if the requested native state is already live.
        started = perf_start()
        already_active = requested_app_active(context, token, app)
        perf_end("TV prelaunch app read", started)
        perf_network("TV prelaunch app read", "tv")
        if already_active:
            return "verified", "app_confirmed"
        try:
            started = perf_start()
            response = tv_request(context, token, "PUT", "/app/launch",
                                  {"VALUE": CLOUD_APPS[app]})
            perf_end("TV launch acceptance", started)
            perf_network("TV launch acceptance", "tv")
        except (OSError, ValueError, RuntimeError):
            # A lost PUT response is ambiguous; inspect TV state before calling
            # it unavailable, and never blindly repeat the launch.
            if requested_app_active(context, token, app):
                return "verified", "app_confirmed"
            return "failed", "tv_unavailable"
        if response.get("STATUS", {}).get("RESULT") != "SUCCESS":
            return "failed", "tv_rejected"
        started = perf_start()
        deadline = time.ticks_add(ticks(), getattr(config, "CLOUD_CONFIRM_MS", CLOUD_CONFIRM_MS))
        attempts = 0
        while attempts < 24 and time.ticks_diff(deadline, ticks()) > 0:
            attempts += 1
            if requested_app_active(context, token, app):
                perf_end("TV app confirmation", started)
                return "verified", "app_confirmed"
            remaining = time.ticks_diff(deadline, ticks())
            if remaining > 0:
                time.sleep_ms(min(500, remaining))
        perf_end("TV app confirmation timeout", started)
        return "failed", "tv_unconfirmed"
    except (OSError, ValueError, RuntimeError, KeyError):
        return "failed", "tv_unavailable"


def report_cloud_result(credential, context, command, outcome, code, session=None):
    body = {"id": command["id"], "claimId": command["claimId"],
            "outcome": outcome, "code": code}
    started = perf_start()
    if session is None:
        status, result = cloud_request(CLOUD_RESULT_PATH, credential, "POST", body, context)
    else:
        status, result = cloud_request(CLOUD_RESULT_PATH, credential, "POST", body, context, session)
    perf_end("Cloud result report", started)
    perf_network("Cloud result report", "cloud")
    if (status != 200 or not isinstance(result, dict)
            or result.get("id") != command["id"] or result.get("state") != outcome):
        raise RuntimeError("Cloud result was not accepted (HTTP %d)" % status)
    print("Cloud launch %s: %s (%s)" % (CLOUD_APP_NAMES.get(command["app"], "unsupported"), outcome, code))


def cloud_poll_once(cloud_context, tv_context, cloud_credential_value, tv_credential,
                    shortcut_state=None, power_hint=None, cloud_session=None):
    started = perf_start()
    if cloud_session is None:
        status, command = cloud_request(CLOUD_CLAIM_PATH, cloud_credential_value,
                                        "POST", None, cloud_context)
    else:
        status, command = cloud_request(CLOUD_CLAIM_PATH, cloud_credential_value,
                                        "POST", None, cloud_context, cloud_session)
    if status == 204:
        perf_end("empty cloud claim", started)
        perf_network("empty cloud claim", "cloud")
        return False
    perf_end("Cloud claim response", started)
    perf_network("Cloud claim response", "cloud")
    if status == 403:
        raise RuntimeError("Cloud controller authorization rejected (403)")
    if status == 429:
        raise RuntimeError("Cloud controller rate limited (429)")
    if status != 200 or not isinstance(command, dict):
        raise RuntimeError("Cloud claim failed (HTTP %d)" % status)

    # Fail closed on any response outside the exact queue contract. Do not use
    # response data as a URL, SmartCast namespace, message, or app identifier.
    if set(command.keys()) != {"id", "claimId", "app"}:
        raise RuntimeError("Cloud claim response has invalid fields")
    if not valid_command_id(command.get("id")) or not valid_command_id(command.get("claimId")):
        raise RuntimeError("Cloud claim response has invalid identifiers")
    app = command.get("app")
    if shortcut_state is not None:
        # Claim is real even if TV execution or result reporting later fails.
        shortcut_superseded_by_cloud(shortcut_state)
    if app not in CLOUD_APPS:
        report_cloud_result(cloud_credential_value, cloud_context, command,
                            "failed", "controller_error", cloud_session)
        return True

    print("Cloud command claimed:", app)
    claimed_at = perf_start()
    if power_hint is None:
        outcome, code = launch_cloud_app(tv_context, tv_credential, app)
    else:
        outcome, code = launch_cloud_app(tv_context, tv_credential, app, power_hint)
    perf_end("Cloud claim to TV result", claimed_at)
    if code not in CLOUD_RESULT_CODES or (outcome == "verified") != (code == "app_confirmed"):
        outcome, code = "failed", "controller_error"
    report_cloud_result(cloud_credential_value, cloud_context, command, outcome, code, cloud_session)
    perf_end("Cloud claim to result acknowledged", claimed_at)
    return True


def cloud_auth_probe(cloud_context, credential):
    # The API validates the bearer token before method dispatch. GET therefore
    # returns 405 for an authorized controller without claiming a queue item.
    status, _result = cloud_request(CLOUD_CLAIM_PATH, credential, "GET", None, cloud_context)
    if status != 405:
        raise RuntimeError("Cloud controller authentication check failed (HTTP %d)" % status)


def poll_shortcut_once(context, token, state, last_power, pending_launch,
                       scheduled_due, interval):
    """Run one due TV sample and skip missed slots after slow network work."""
    state["poll_lag_ms"] = max(0, time.ticks_diff(ticks(), scheduled_due))
    if last_power == 1 and not pending_launch:
        try:
            iheart_shortcut_step(context, token, state)
        except (OSError, ValueError, RuntimeError):
            # Unknown TV state is never interpreted as a button press.
            print("iHeart shortcut: TV state unavailable")
    return next_periodic_due(scheduled_due, interval, ticks())


def supervised_check():
    print("Horizon Pico supervised check: read-only; no app launch")
    validate_config()
    wlan = network.WLAN(network.WLAN.IF_STA)
    if not connect_wifi(wlan):
        raise RuntimeError("Wi-Fi unavailable")
    print("Wi-Fi: connected; address", wlan.ifconfig()[0])
    synchronize_time()
    print("NTP: synchronized; UTC", time.gmtime())

    context = tls_context()
    tls_probe(context)
    print("Vizio TLS: pinned handshake accepted")

    token = token_value()
    if token is None:
        print("SmartCast status: skipped; private token is not configured")
    else:
        mode = power_state(context, token)
        app = current_app(context, token)
        print("SmartCast: read-only requests succeeded")
        print("TV power:", "on" if mode else "off")
        print("Current app ID:", app.get("APP_ID"), "namespace:", app.get("NAME_SPACE"))

    cloud_context = cloud_tls_context()
    cloud_tls_probe(cloud_context)
    print("Cloudflare TLS: CA-verified handshake accepted")
    cloud_secret = controller_token()
    if cloud_secret is None:
        print("Cloud controller auth: skipped; private controller token is not configured")
    else:
        cloud_auth_probe(cloud_context, cloud_secret)
        print("Cloud controller auth: accepted; queue was not claimed")


def unattended_watch():
    token = token_value()
    if token is None:
        raise RuntimeError("private SmartCast token is not configured")
    cloud_enabled = getattr(config, "CLOUD_LIVE_CLAIMING", False) is True
    cloud_keepalive = getattr(config, "CLOUD_KEEPALIVE", False) is True
    shortcut_enabled = getattr(config, "IHEART_RETURNS_TO_HORIZON", False) is True
    cloud_secret = controller_token() if cloud_enabled else None
    if cloud_enabled and cloud_secret is None:
        raise RuntimeError("private Cloudflare controller token is not configured")
    cloud_interval = getattr(config, "CLOUD_POLL_MS", POWER_POLL_MS)
    if cloud_enabled and not 1000 <= cloud_interval <= 30000:
        raise RuntimeError("Cloud poll interval must be 1000 to 30000 ms")
    confirm_interval = getattr(config, "CLOUD_CONFIRM_MS", CLOUD_CONFIRM_MS)
    if cloud_enabled and not 10000 <= confirm_interval <= 20000:
        raise RuntimeError("Cloud confirmation budget must be 10000 to 20000 ms")
    shortcut_interval = getattr(config, "IHEART_POLL_MS", 2000)
    if shortcut_enabled and not 1000 <= shortcut_interval <= 10000:
        raise RuntimeError("iHeart poll interval must be 1000 to 10000 ms")
    shortcut_priority_ms = getattr(config, "IHEART_CONFIRM_PRIORITY_MS", 1000)
    if shortcut_enabled and not 0 <= shortcut_priority_ms <= 1000:
        raise RuntimeError("iHeart confirmation priority must be 0 to 1000 ms")
    wlan = network.WLAN(network.WLAN.IF_STA)
    last_power = load_power()
    last_power_at = None
    pending_launch = False
    pending_at = None
    launch_attempts = 0
    context = None
    cloud_context = None
    cloud_session = None
    time_sync_due = 0
    wifi_failures = 0
    cloud_failures = 0
    power_poll_due = ticks()
    cloud_poll_due = ticks()
    shortcut_poll_due = ticks()
    shortcut_state = {"observed": False, "latched": False, "pending_at": None,
                      "cooldown_at": None, "detected_at": None}

    while True:
        try:
            if cloud_session is not None and not wlan.isconnected():
                cloud_session.close()
                cloud_session = None
            if not connect_wifi(wlan):
                raise OSError("Wi-Fi unavailable")
            wifi_failures = 0
            if time_sync_due == 0 or due(time_sync_due):
                synchronize_time()
                time_sync_due = time.ticks_add(ticks(), NTP_REFRESH_MS)
            if context is None:
                context = tls_context()
            if cloud_enabled and cloud_context is None:
                cloud_context = cloud_tls_context()
            if cloud_enabled and cloud_keepalive and cloud_session is None:
                cloud_session = CloudConnection(cloud_context)

            if due(power_poll_due):
                # Keep the power watcher on its own cadence when cloud polling
                # is configured more frequently than power polling.
                power_poll_due = time.ticks_add(ticks(), POWER_POLL_MS)
                power_started = perf_start()
                mode = power_state(context, token)
                perf_slow("power watch read", power_started, "tv")
                last_power_at = ticks()
                if last_power is None:
                    last_power = mode  # First read is a baseline, never a launch.
                    save_power(mode)
                    print("Power baseline:", "on" if mode else "off")
                elif mode != last_power:
                    previous = last_power
                    last_power = mode
                    save_power(mode)
                    if previous == 0 and mode == 1:
                        if getattr(config, "AUTO_LAUNCH_ON_POWER", False) is True:
                            pending_launch = True
                            pending_at = time.ticks_add(ticks(), 3000)
                            launch_attempts = 0
                            print("Confirmed TV off-to-on transition")
                    elif mode == 0:
                        pending_launch = False
                        pending_at = None
                        if shortcut_state["pending_at"] is not None:
                            shortcut_finish(shortcut_state, ticks(), "tv_off")
                        shortcut_state["observed"] = False
                        shortcut_state["latched"] = False
                        shortcut_state["pending_at"] = None

            if pending_launch and pending_at is not None and due(pending_at):
                # Read current app before each attempt, so a lost PUT response
                # cannot cause a duplicate if Horizon already opened.
                if horizon_is_active(context, token):
                    pending_launch = False
                    pending_at = None
                    print("Horizon is already active; launch suppressed")
                elif launch_attempts >= len(LAUNCH_RETRY_MS):
                    pending_launch = False
                    pending_at = None
                    print("Horizon launch not confirmed; stopping retries")
                else:
                    delay = LAUNCH_RETRY_MS[launch_attempts]
                    launch_attempts += 1
                    launch_horizon(context, token)
                    # The following pass confirms app 17 before any retry.
                    pending_at = time.ticks_add(ticks(), delay)

            if (cloud_enabled and shortcut_enabled
                    and shortcut_state.get("horizon_seen_at") is not None
                    and due(cloud_poll_due)):
                until_confirmation = time.ticks_diff(shortcut_poll_due, ticks())
                if 0 < until_confirmation <= shortcut_priority_ms:
                    # Defer this claim only until the next confirmation sample.
                    # The queue claim still runs immediately after that sample.
                    cloud_poll_due = shortcut_poll_due

            if (shortcut_enabled and shortcut_state.get("horizon_seen_at") is not None
                    and due(shortcut_poll_due)):
                # A second Horizon sample is due. Read it before an expensive
                # empty claim; the claim still runs in this same loop pass.
                shortcut_poll_due = poll_shortcut_once(
                    context, token, shortcut_state, last_power, pending_launch,
                    shortcut_poll_due, shortcut_interval)

            if cloud_enabled and due(cloud_poll_due):
                try:
                    poll_lag = max(0, time.ticks_diff(ticks(), cloud_poll_due))
                    if getattr(config, "PERF_TIMING", False) is True and poll_lag > 250:
                        print("Timing cloud poll overdue: %d ms" % poll_lag)
                    claimed = cloud_poll_once(cloud_context, context, cloud_secret, token,
                                              shortcut_state if shortcut_enabled else None,
                                              (last_power, last_power_at) if last_power_at is not None else None,
                                              cloud_session)
                    if claimed and shortcut_enabled:
                        shortcut_superseded_by_cloud(shortcut_state)
                    cloud_failures = 0
                    cloud_poll_due = next_periodic_due(cloud_poll_due, cloud_interval, ticks())
                except (OSError, ValueError, RuntimeError) as error:
                    print("Cloud queue waiting:", type(error).__name__)
                    delay = CLOUD_RETRY_MS[min(cloud_failures, len(CLOUD_RETRY_MS) - 1)]
                    cloud_failures += 1
                    cloud_poll_due = time.ticks_add(ticks(), delay)

            if shortcut_enabled and due(shortcut_poll_due):
                shortcut_poll_due = poll_shortcut_once(
                    context, token, shortcut_state, last_power, pending_launch,
                    shortcut_poll_due, shortcut_interval)

        except (OSError, ValueError, RuntimeError) as error:
            print("Controller waiting:", type(error).__name__)
            if not wlan.isconnected():
                if cloud_session is not None:
                    cloud_session.close()
                    cloud_session = None
                context = None
                cloud_context = None
                time_sync_due = 0
                delay = WIFI_RETRY_MS[min(wifi_failures, len(WIFI_RETRY_MS) - 1)]
                wifi_failures += 1
                time.sleep_ms(delay)
                continue
            if pending_launch:
                if launch_attempts >= len(LAUNCH_RETRY_MS):
                    pending_at = time.ticks_add(ticks(), LAUNCH_RETRY_MS[-1])
                else:
                    pending_at = time.ticks_add(ticks(), LAUNCH_RETRY_MS[launch_attempts])
        time.sleep_ms(next_watch_sleep_ms(ticks(), power_poll_due, cloud_poll_due,
                                         pending_at if pending_launch else None, cloud_enabled,
                                         getattr(config, "POLL_MS", POWER_POLL_MS),
                                         shortcut_poll_due if shortcut_enabled else None))


def main():
    # Live queue claiming, power-on launch, and iHeart shortcut are independent opt-ins.
    if (getattr(config, "AUTO_LAUNCH_ON_POWER", False) is not True
            and getattr(config, "CLOUD_LIVE_CLAIMING", False) is not True
            and getattr(config, "IHEART_RETURNS_TO_HORIZON", False) is not True):
        supervised_check()
        return
    if getattr(config, "CLOUD_LIVE_CLAIMING", False) is True:
        print("Cloud app-launch claiming is enabled")
    if getattr(config, "AUTO_LAUNCH_ON_POWER", False) is True:
        print("Automatic power-transition launching is enabled")
    if getattr(config, "IHEART_RETURNS_TO_HORIZON", False) is True:
        print("iHeart return shortcut is enabled")
    unattended_watch()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Do not print configuration values, tokens, URLs, or fingerprints.
        print("Controller stopped:", type(error).__name__, str(error))
