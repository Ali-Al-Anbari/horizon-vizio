"""Manual, Pico-only KEYLIST experiment. Never imported by the boot controller.

Batch trials send 2, 6, 12, 30, or 60 fixed seek KEYPRESS actions in one
authenticated, pinned TV request. Large trials require supervised TV testing.
"""

ALLOWED_BATCH_COUNTS = (2, 6, 12, 30, 60)
FORWARD_KEY = (3, 7)
BACKWARD_KEY = (3, 1)
SEQUENTIAL_COUNTS = (2, 3, 6, 12, 30, 60)


def _batch_body(count, command="seek_forward"):
    if type(count) is not int or count not in ALLOWED_BATCH_COUNTS:
        raise ValueError("batch count must be 2, 6, 12, 30, or 60")
    if command not in ("seek_forward", "seek_backward"):
        raise ValueError("only seek inputs are permitted")
    codeset, code = FORWARD_KEY if command == "seek_forward" else BACKWARD_KEY
    return {"KEYLIST": [
        {"CODESET": codeset, "CODE": code, "ACTION": "KEYPRESS"}
        for _ in range(count)
    ]}


def _forward_body(count):
    return _batch_body(count)


def _check_mapping():
    import main as controller
    if (controller.PLAYER_KEYS.get("seek_forward") != FORWARD_KEY or
            controller.PLAYER_KEYS.get("seek_backward") != BACKWARD_KEY):
        raise RuntimeError("seek key mapping changed; no key sent")
    return controller


def prepare_trial():
    """Prepare Wi-Fi, clock and pinned TLS context; send no TV request."""
    controller = _check_mapping()
    return controller.prepare_supervised_player_session()


def _warm(trial):
    """Open the pinned socket using only the existing read-only TV request."""
    try:
        return trial.connection.prewarm(trial._token) and trial.connection.wrapped is not None
    except (OSError, ValueError, RuntimeError):
        return False


def batched_pair(trial):
    """Send one two-key request, then close. Never retry an uncertain request."""
    timing = {}
    try:
        _check_mapping()
        if trial._token is None:
            raise RuntimeError("trial is closed")
        if not _warm(trial):
            return {"outcome": "not_sent", "requested_keys": 0,
                    "reason": "read_only_warmup_failed"}
        try:
            result = trial.connection.keypress(trial._token, _forward_body(2), timing)
        except (OSError, ValueError, RuntimeError) as error:
            return {"outcome": "unknown", "requested_keys": 2,
                    "error_type": type(error).__name__,
                    "request_ms": timing.get("request_ms")}
        status = result.get("STATUS") if isinstance(result, dict) else None
        code = status.get("RESULT") if isinstance(status, dict) else None
        return {"outcome": "acknowledged" if code == "SUCCESS" else
                "rejected" if code is not None else "unknown",
                "requested_keys": 2, "request_ms": timing.get("request_ms")}
    finally:
        trial.close()


def batched_trial(trial, count, command="seek_forward"):
    """Send one KEYLIST containing an allowed number of fixed seek keypresses."""
    timing = {}
    try:
        body = _batch_body(count, command)
        _check_mapping()
        if trial._token is None:
            raise RuntimeError("trial is closed")
        if not _warm(trial):
            result = {"outcome": "not_sent", "requested_keys": count,
                      "request_ms": None, "reason": "read_only_warmup_failed"}
        else:
            try:
                response = trial.connection.keypress(trial._token, body, timing)
                status = response.get("STATUS") if isinstance(response, dict) else None
                code = status.get("RESULT") if isinstance(status, dict) else None
                outcome = "acknowledged" if code == "SUCCESS" else (
                    "rejected" if code is not None else "unknown")
                result = {"outcome": outcome, "requested_keys": count,
                          "request_ms": timing.get("request_ms")}
            except (OSError, ValueError, RuntimeError) as error:
                result = {"outcome": "unknown", "requested_keys": count,
                          "error_type": type(error).__name__,
                          "request_ms": timing.get("request_ms")}
    finally:
        trial.close()
    print("SmartCast KEYLIST %s: requested %d keys; acknowledgment %s; request %s ms" %
          (command, count, result["outcome"], result.get("request_ms")))
    return result


def separate_pair(trial):
    """Run the two existing single-key commands in order; stop on uncertainty."""
    acknowledged = 0
    try:
        _check_mapping()
        if trial._token is None:
            raise RuntimeError("trial is closed")
        if not _warm(trial):
            return {"outcome": "not_sent", "acknowledged_requests": 0,
                    "reason": "read_only_warmup_failed"}
        for _ in range(2):
            try:
                accepted = trial.send("seek_forward")
            except (OSError, ValueError, RuntimeError):
                accepted = False
            if not accepted:
                return {"outcome": "stopped_unknown_or_rejected",
                        "acknowledged_requests": acknowledged}
            acknowledged += 1
        return {"outcome": "acknowledged", "acknowledged_requests": 2}
    finally:
        trial.close()


def sequential_trial(trial, count, command="seek_forward"):
    """Manual Pico-local trial: one pinned SmartCast request per key, no retry.

    The allowed counts are the staged Video Lab UX experiments. They are not
    a claim about the TV's maximum supported batch size.
    """
    if type(count) is not int or count not in SEQUENTIAL_COUNTS:
        raise ValueError("choose a staged trial count: 2, 3, 6, 12, 30, or 60")
    if command not in ("seek_forward", "seek_backward"):
        raise ValueError("only seek inputs are permitted")
    controller = _check_mapping()
    if controller.PLAYER_KEYS.get("seek_backward") != (3, 1):
        raise RuntimeError("backward key mapping changed; no key sent")
    started = controller.ticks()
    acknowledged = 0
    warm = 0
    fresh = 0
    latencies = []
    failure = None
    try:
        if trial._token is None:
            raise RuntimeError("trial is closed")
        if not _warm(trial):
            failure = {"kind": "warmup_failed", "input": 0}
        else:
            codeset, code = controller.PLAYER_KEYS[command]
            for index in range(count):
                timing = {}
                try:
                    if trial.connection.wrapped is None:
                        if not trial.connection.prewarm(trial._token):
                            failure = {"kind": "warmup_rejected", "input": index + 1}
                            break
                    result = trial.connection.keypress(trial._token, {"KEYLIST": [{
                        "CODESET": codeset, "CODE": code, "ACTION": "KEYPRESS"}]}, timing)
                    status = result.get("STATUS") if isinstance(result, dict) else None
                    if not isinstance(status, dict) or status.get("RESULT") != "SUCCESS":
                        failure = {"kind": "tv_rejected", "input": index + 1,
                                   "status": status}
                        break
                except (OSError, ValueError, RuntimeError) as error:
                    failure = {"kind": "uncertain_transport", "input": index + 1,
                               "error_type": type(error).__name__,
                               "error": str(error),
                               "phase": timing.get("failed_phase", timing.get("phase"))}
                    break
                acknowledged += 1
                if timing.get("connection") == "warm":
                    warm += 1
                else:
                    fresh += 1
                if type(timing.get("request_ms")) is int:
                    latencies.append(timing["request_ms"])
        return {"requested": count, "acknowledged": acknowledged,
                "failures": 1 if failure else 0, "failure": failure,
                "pico_ms": controller.time.ticks_diff(controller.ticks(), started),
                "min_ms": min(latencies) if latencies else None,
                "avg_ms": sum(latencies) // len(latencies) if latencies else None,
                "max_ms": max(latencies) if latencies else None,
                "warm_requests": warm, "fresh_requests": fresh,
                "websocket": "not_applicable_in_manual_REPL",
                "yapgrid_movement": "record_manually"}
    finally:
        trial.close()
