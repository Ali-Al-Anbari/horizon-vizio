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
WIFI_CONNECT_TIMEOUT_MS = 10000
WIFI_RETRY_MS = (1000, 2000, 4000, 8000, 15000, 30000, 60000)
NTP_RETRY_MS = (1000, 3000, 8000)
LAUNCH_RETRY_MS = (3000, 5000, 10000, 20000, 40000, 60000)
NTP_REFRESH_MS = 24 * 60 * 60 * 1000
POWER_POLL_MS = 3000


def ticks():
    return time.ticks_ms()


def due(when):
    return time.ticks_diff(ticks(), when) >= 0


def token_value():
    token = getattr(secrets, "SMARTCAST_TOKEN", "")
    if not token or token.startswith("YOUR_"):
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
        address = socket.getaddrinfo(config.TV_IP, 7345)[0][-1]
        raw = socket.socket()
        raw.settimeout(config.SOCKET_TIMEOUT_S)
        raw.connect(address)
        # Default handshake is synchronous. On error, no HTTP bytes are sent.
        return context.wrap_socket(raw, server_hostname=config.TV_TLS_NAME)
    except Exception:
        if raw is not None:
            raw.close()
        raise


def tls_probe(context):
    wrapped = open_pinned_socket(context)
    wrapped.close()


def tv_request(context, token, method, path, body=None):
    payload = b"" if body is None else json.dumps(body).encode()
    header = (method + " " + path + " HTTP/1.0\r\n"
             + "Host: " + config.TV_TLS_NAME + "\r\n"
             + "AUTH: " + token + "\r\n"
             + "Content-Type: application/json\r\n"
             + "Content-Length: " + str(len(payload)) + "\r\n"
             + "Connection: close\r\n\r\n").encode()
    wrapped = None
    try:
        wrapped = open_pinned_socket(context)
        wrapped.write(header)
        if payload:
            wrapped.write(payload)
        response = bytearray()
        while True:
            chunk = wrapped.read(512)
            if not chunk:
                break
            if len(response) + len(chunk) > MAX_RESPONSE:
                raise RuntimeError("TV response too large")
            response.extend(chunk)
        head, separator, body_bytes = bytes(response).partition(b"\r\n\r\n")
        if not separator or not head.startswith(b"HTTP/"):
            raise RuntimeError("invalid TV HTTP response")
        if b" 200 " not in head.split(b"\r\n", 1)[0]:
            raise RuntimeError("TV HTTP status not 200")
        return json.loads(body_bytes)
    finally:
        if wrapped is not None:
            wrapped.close()
        gc.collect()


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
    checked_request(context, token, "PUT", "/app/launch", body)


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
        return
    mode = power_state(context, token)
    app = current_app(context, token)
    print("SmartCast: read-only requests succeeded")
    print("TV power:", "on" if mode else "off")
    print("Current app ID:", app.get("APP_ID"), "namespace:", app.get("NAME_SPACE"))


def unattended_watch():
    token = token_value()
    if token is None:
        raise RuntimeError("private SmartCast token is not configured")
    wlan = network.WLAN(network.WLAN.IF_STA)
    last_power = load_power()
    pending_launch = False
    pending_at = None
    launch_attempts = 0
    context = None
    time_sync_due = 0
    wifi_failures = 0

    while True:
        try:
            if not connect_wifi(wlan):
                raise OSError("Wi-Fi unavailable")
            wifi_failures = 0
            if time_sync_due == 0 or due(time_sync_due):
                synchronize_time()
                time_sync_due = time.ticks_add(ticks(), NTP_REFRESH_MS)
            if context is None:
                context = tls_context()

            mode = power_state(context, token)
            if last_power is None:
                last_power = mode  # First read is a baseline, never a launch.
                save_power(mode)
                print("Power baseline:", "on" if mode else "off")
            elif mode != last_power:
                previous = last_power
                last_power = mode
                save_power(mode)
                if previous == 0 and mode == 1:
                    pending_launch = True
                    pending_at = time.ticks_add(ticks(), 3000)
                    launch_attempts = 0
                    print("Confirmed TV off-to-on transition")
                elif mode == 0:
                    pending_launch = False
                    pending_at = None

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

        except (OSError, ValueError, RuntimeError) as error:
            print("Controller waiting:", type(error).__name__, str(error))
            if not wlan.isconnected():
                context = None
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
        time.sleep_ms(getattr(config, "POLL_MS", POWER_POLL_MS))


def main():
    # Require the literal True value; strings such as "False" stay supervised.
    if getattr(config, "AUTO_LAUNCH_ON_POWER", False) is not True:
        supervised_check()
        return
    print("Automatic power-transition launching is enabled")
    unattended_watch()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Do not print configuration values, tokens, URLs, or fingerprints.
        print("Controller stopped:", type(error).__name__, str(error))
