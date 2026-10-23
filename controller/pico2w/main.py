"""Conservative Pico 2 W Horizon watcher for MicroPython v1.29.0.

Pins the TV's exact certificate before sending the SmartCast token.
The first readable power state is a baseline; only an observed off-to-on edge
can launch Horizon. This design favors avoiding duplicates over guaranteed
delivery after a reset at the exact launch instant.
"""

import gc
import hashlib
import binascii
import json
import network
import os
import socket
import ssl
import time

import config
import secrets


STATE_FILE = "state.json"
STATE_TMP = "state.json.tmp"
MAX_RESPONSE = 6144
RETRY_MS = (5000, 10000, 20000, 40000, 60000, 60000, 60000)


def ticks():
    return time.ticks_ms()


def due(when):
    return time.ticks_diff(ticks(), when) >= 0


def save_power(value):
    # Write only on state transitions, limiting flash wear.
    with open(STATE_TMP, "w") as file:
        file.write(json.dumps({"last_power": value}))
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
        return True
    wlan.active(True)
    # Some RP2 builds keep retrying indefinitely; reset the interface so
    # each attempt has a bounded wait controlled by this loop.
    try:
        wlan.disconnect()
    except OSError:
        pass
    wlan.connect(config.WIFI_SSID, config.WIFI_PASSWORD)
    deadline = time.ticks_add(ticks(), 10000)
    while not due(deadline):
        if wlan.isconnected():
            return True
        time.sleep_ms(250)
    wlan.active(False)
    return False


def tls_context():
    expected = config.TV_CERT_SHA256.lower()
    if len(expected) != 64 or any(c not in "0123456789abcdef" for c in expected):
        raise RuntimeError("invalid TV certificate pin")
    pin = {"seen": False, "match": False}

    def verify(cert, depth):
        if depth == 0:
            pin["seen"] = True
            actual = binascii.hexlify(hashlib.sha256(cert).digest()).decode()
            pin["match"] = actual == expected
            if not pin["match"]:
                return -0x3000  # mbedTLS fatal certificate verification error
        return 0

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    # v1.29.0 mbedTLS exposes verify_callback. CERT_OPTIONAL lets a pinned
    # Vizio leaf work without its absent issuer; the callback plus the
    # post-handshake check below enforce identity before AUTH is sent.
    context.verify_mode = ssl.CERT_OPTIONAL
    context.verify_callback = verify
    return context, pin


def tv_request(context, pin, token, method, path, body=None):
    payload = b"" if body is None else json.dumps(body).encode()
    header = (method + " " + path + " HTTP/1.0\r\n"
              + "Host: " + config.TV_TLS_NAME + "\r\n"
              + "AUTH: " + token + "\r\n"
              + "Content-Type: application/json\r\n"
              + "Content-Length: " + str(len(payload)) + "\r\n"
              + "Connection: close\r\n\r\n").encode()
    raw = None
    wrapped = None
    try:
        address = socket.getaddrinfo(config.TV_IP, 7345)[0][-1]
        raw = socket.socket()
        raw.settimeout(config.SOCKET_TIMEOUT_S)
        raw.connect(address)
        pin["seen"] = False
        pin["match"] = False
        wrapped = context.wrap_socket(raw, server_hostname=config.TV_TLS_NAME)
        if not pin["seen"] or not pin["match"]:
            raise RuntimeError("TV certificate pin not verified")
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
        elif raw is not None:
            raw.close()
        gc.collect()


def checked_request(context, pin, token, method, path, body=None):
    result = tv_request(context, pin, token, method, path, body)
    if result.get("STATUS", {}).get("RESULT") != "SUCCESS":
        raise RuntimeError("TV API rejected request")
    return result


def power_state(context, pin, token):
    result = checked_request(context, pin, token, "GET", "/state/device/power_mode")
    for item in result.get("ITEMS", ()):
        if item.get("CNAME") == "power_mode":
            value = item.get("VALUE")
            if value in (0, "0", False):
                return 0
            if value in (1, "1", True):
                return 1
    raise RuntimeError("unrecognized TV power state")


def horizon_is_active(context, pin, token):
    result = checked_request(context, pin, token, "GET", "/app/current")
    candidates = [result.get("ITEM"), result] + result.get("ITEMS", [])
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        value = candidate.get("VALUE", candidate)
        if isinstance(value, dict) and str(value.get("APP_ID")) == "17":
            return True
    return False


def launch_horizon(context, pin, token):
    body = {"VALUE": {"APP_ID": "17", "NAME_SPACE": 4,
                      "MESSAGE": config.HORIZON_URL}}
    checked_request(context, pin, token, "PUT", "/app/launch", body)


def main():
    token = secrets.SMARTCAST_TOKEN
    if not token or token.startswith("YOUR_"):
        raise RuntimeError("SmartCast token is not provisioned")
    if not config.HORIZON_URL.startswith("https://"):
        raise RuntimeError("Horizon URL must use HTTPS")
    wlan = network.WLAN(network.WLAN.IF_STA)
    last_power = load_power()
    pending_at = None
    attempts = 0
    context = None
    pin = None
    while True:
        try:
            if not connect_wifi(wlan):
                raise OSError("Wi-Fi unavailable")
            if context is None:
                context, pin = tls_context()
            mode = power_state(context, pin, token)
            if last_power is None:
                save_power(mode)
                last_power = mode
            elif mode != last_power:
                # Persist 'on' before a launch attempt. A reset cannot replay it.
                save_power(mode)
                if last_power == 0 and mode == 1:
                    pending_at = time.ticks_add(ticks(), 3000)
                    attempts = 0
                elif mode == 0:
                    pending_at = None
                last_power = mode
            if mode == 1 and pending_at is not None and due(pending_at):
                try:
                    active = horizon_is_active(context, pin, token)
                except (OSError, ValueError, RuntimeError):
                    if attempts >= len(RETRY_MS):
                        pending_at = None
                    else:
                        pending_at = time.ticks_add(ticks(), RETRY_MS[attempts])
                        attempts += 1
                else:
                    # Consume before the PUT. If its response is lost, retrying
                    # could relaunch after Home or another app has taken focus.
                    pending_at = None
                    if not active:
                        launch_horizon(context, pin, token)
        except (OSError, ValueError, RuntimeError) as error:
            # Unknown network/API state never counts as TV power-off.
            print("Watcher waiting:", type(error).__name__)
            if not wlan.isconnected():
                context = None
                pin = None
        time.sleep_ms(config.POLL_MS)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # No token or URL is logged. Restart after unexpected failures.
        print("Watcher restarting:", type(error).__name__)
        time.sleep(5)
        import machine
        machine.reset()
