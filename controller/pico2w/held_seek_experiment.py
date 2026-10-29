"""Manual, Pico-only timed KEYDOWN/KEYUP seek experiment.

Never imported by the boot controller or player bridge. Only the existing
forward mapping (codeset 3, code 7) is allowed. Any positive finite hold time
is accepted; the hold cooperatively sleeps in short slices.
"""

import math

FORWARD_KEY = (3, 7)
_active = False


def _body(action):
    if action not in ("KEYDOWN", "KEYUP"):
        raise ValueError("unsupported key action")
    return {"KEYLIST": [{"CODESET": FORWARD_KEY[0], "CODE": FORWARD_KEY[1],
                         "ACTION": action}]}


def _controller():
    import main as controller
    if controller.PLAYER_KEYS.get("seek_forward") != FORWARD_KEY:
        raise RuntimeError("forward key mapping changed; no key sent")
    if not hasattr(controller.time, "sleep_ms"):
        raise RuntimeError("MicroPython sleep_ms is required; no key sent")
    return controller


def prepare_trial():
    """Prepare Wi-Fi, NTP, and the pinned TLS context; sends no TV request."""
    return _controller().prepare_supervised_player_session()


def _response(result, timing):
    status = result.get("STATUS") if isinstance(result, dict) else None
    code = status.get("RESULT") if isinstance(status, dict) else None
    return {"outcome": "acknowledged" if code == "SUCCESS" else
            "rejected" if code is not None else "unknown",
            "result": code, "http_status": timing.get("http_status"),
            "request_ms": timing.get("request_ms"),
            "connection": timing.get("connection"),
            "phase": timing.get("failed_phase", timing.get("phase"))}


def _send(trial, action):
    timing = {}
    try:
        result = trial.connection.keypress(trial._token, _body(action), timing)
        return _response(result, timing)
    except Exception as error:
        # Delivery may be uncertain after a write. Never retry either action.
        return {"outcome": "unknown", "error_type": type(error).__name__,
                "phase": timing.get("failed_phase", timing.get("phase")),
                "http_status": timing.get("http_status"),
                "request_ms": timing.get("request_ms"),
                "connection": timing.get("connection")}


def _hold(controller, duration_ms):
    remaining = duration_ms
    elapsed = 0
    while remaining > 0:
        interval = min(remaining, 50)
        started = controller.ticks()
        controller.time.sleep_ms(interval)
        measured = controller.time.ticks_diff(controller.ticks(), started)
        if measured > 0:
            elapsed += measured
        remaining -= interval
    return elapsed


def _duration_ms(value):
    if type(value) is int:
        if value <= 0:
            raise ValueError("duration must be positive and finite")
        return value * 1000
    if type(value) is not float or not math.isfinite(value) or value <= 0:
        raise ValueError("duration must be positive and finite")
    whole_seconds = int(value)
    milliseconds = whole_seconds * 1000 + int((value - whole_seconds) * 1000)
    return max(1, milliseconds)


def held_seek(trial, duration_seconds):
    """Hold forward seek, then release it, always attempting KEYUP after KEYDOWN.

    Run only while the isolated focus-switch page has YapGrid focused. The
    returned SmartCast acknowledgments do not establish visible video movement.
    """
    global _active
    if _active:
        raise RuntimeError("a held-seek experiment is already active")
    duration_ms = _duration_ms(duration_seconds)
    controller = _controller()
    if trial is None or trial._token is None:
        raise RuntimeError("prepare a live supervised trial first")

    _active = True
    started = controller.ticks()
    result = {"requested_hold_ms": duration_ms, "keydown": None, "keyup": None,
              "hold_ms": 0, "warmup": None}
    keydown_attempted = False
    try:
        # Use the existing read-only request to warm the authenticated pinned
        # connection before the key interval. This cannot start video seeking.
        try:
            warmed = trial.connection.prewarm(trial._token)
            result["warmup"] = "acknowledged" if warmed else "rejected"
        except Exception as error:
            result["warmup"] = "unknown:" + type(error).__name__
            return result
        if not warmed:
            return result

        keydown_attempted = True
        result["keydown"] = _send(trial, "KEYDOWN")
        if result["keydown"]["outcome"] == "acknowledged":
            try:
                result["hold_ms"] = _hold(controller, duration_ms)
            except Exception as error:
                result["hold_error"] = type(error).__name__
    finally:
        try:
            if keydown_attempted:
                result["keyup"] = _send(trial, "KEYUP")
        finally:
            try:
                result["total_ms"] = controller.time.ticks_diff(controller.ticks(), started)
                if result["warmup"] != "acknowledged":
                    result["outcome"] = "not_sent"
                elif (result.get("keydown", {}).get("outcome") == "acknowledged"
                        and result.get("keyup", {}).get("outcome") == "acknowledged"
                        and "hold_error" not in result):
                    result["outcome"] = "acknowledged"
                else:
                    result["outcome"] = "partial_or_uncertain"
            finally:
                try:
                    trial.close()
                finally:
                    _active = False
    return result
