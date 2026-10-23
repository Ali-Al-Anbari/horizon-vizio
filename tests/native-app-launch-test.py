#!/usr/bin/env python3
"""Guarded real-TV app test using fixed candidates from Vizio's current catalog."""

import argparse
import importlib.util
import pathlib
import sys
import time


ROOT = pathlib.Path(__file__).resolve().parent.parent
CONTROLLER = ROOT / "controller/horizon-controller.py"
CANDIDATES = {
    "prime-video": ("Prime Video", {"APP_ID": "3", "NAME_SPACE": 3, "MESSAGE": None}),
    "disney-plus": ("Disney+", {"APP_ID": "75", "NAME_SPACE": 2, "MESSAGE": None}),
    "plex": ("Plex", {"APP_ID": "9", "NAME_SPACE": 2, "MESSAGE": None}),
    "live-tv": ("Live TV (WatchFree+)", {
        "APP_ID": "3014", "NAME_SPACE": 2,
        "MESSAGE": "http://127.0.0.1:12345/scfs/sctv/main.html#/watchfreeplus",
    }),
}


def load_controller():
    spec = importlib.util.spec_from_file_location("horizon_controller", CONTROLLER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def current_config(controller, tv, token):
    return controller.current_app_config(tv, token)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", choices=sorted(CANDIDATES))
    parser.add_argument("--tv", required=True, help="paired TV LAN IP")
    parser.add_argument("--auth-file", required=True, help="private pairing JSON file")
    parser.add_argument("--approved-launch", action="store_true",
                        help="approval to replace the TV's current screen with the named app")
    args = parser.parse_args()
    controller = load_controller()
    name, config = CANDIDATES[args.app]
    token = controller.load_auth(args.auth_file)
    if controller.current_power(args.tv, token) != 1:
        raise RuntimeError("TV is not on; launch test stopped")
    before = current_config(controller, args.tv, token)
    print("Current app:", {k: before.get(k) for k in ("APP_ID", "NAME_SPACE", "MESSAGE")})
    print("Catalog candidate:", name, config)
    if not args.approved_launch:
        print("PREPARED ONLY: no launch request sent. --approved-launch changes the TV screen.")
        return
    if controller.app_configs_match(before, config):
        print("Candidate is already current; no transition tested")
        return
    response = controller.tv_request(args.tv, token, "PUT", "/app/launch",
                                     {"VALUE": config}, timeout=5)
    result = response.get("STATUS", {}).get("RESULT", "missing")
    print("Launch API result:", result)
    if not controller.status_ok(response):
        raise RuntimeError("TV rejected the app launch request")
    expected_states = controller.NATIVE_APP_EXPECTED_STATES.get(args.app, [config])
    for attempt in range(90):
        current = current_config(controller, args.tv, token)
        if any(controller.app_configs_match(current, expected) for expected in expected_states):
            print("VERIFIED BY TV /app/current:", name, {k: current.get(k) for k in ("APP_ID", "NAME_SPACE", "MESSAGE")})
            print("Confirm that the visible screen is the requested native app.")
            return
        if attempt < 89:
            time.sleep(0.5)
    raise RuntimeError("Launch API accepted the request, but /app/current did not confirm the candidate")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("Test failed:", type(error).__name__, str(error), file=sys.stderr)
        sys.exit(1)
