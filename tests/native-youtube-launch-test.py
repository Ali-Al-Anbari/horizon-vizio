#!/usr/bin/env python3
"""Guarded, single-app SmartCast launch test. Never prints the AUTH token."""

import argparse
import importlib.util
import pathlib
import sys
import time


ROOT = pathlib.Path(__file__).resolve().parent.parent
CONTROLLER = ROOT / "controller/horizon-controller.py"
YOUTUBE = {"APP_ID": "1", "NAME_SPACE": 5, "MESSAGE": None}


def load_controller():
    spec = importlib.util.spec_from_file_location("horizon_controller", CONTROLLER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def active_config(controller, tv, token):
    response = controller.tv_request(tv, token, "GET", "/app/current")
    if not controller.status_ok(response):
        raise RuntimeError("TV rejected current-app readback")
    item = response.get("ITEM")
    if not isinstance(item, dict) or not isinstance(item.get("VALUE"), dict):
        raise RuntimeError("TV returned an unrecognized current-app response")
    value = item["VALUE"]
    return {key: value.get(key) for key in ("APP_ID", "NAME_SPACE", "MESSAGE")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tv", required=True, help="paired TV LAN IP")
    parser.add_argument("--auth-file", required=True, help="private pairing JSON file")
    parser.add_argument("--approved-launch", action="store_true",
                        help="explicit approval to replace the TV's current screen")
    args = parser.parse_args()
    controller = load_controller()
    token = controller.load_auth(args.auth_file)
    if controller.current_power(args.tv, token) != 1:
        raise RuntimeError("TV is not on; launch test stopped")
    before = active_config(controller, args.tv, token)
    print("Current app:", before)
    print("Candidate YouTube launch:", YOUTUBE)
    if not args.approved_launch:
        print("PREPARED ONLY: no launch request sent. --approved-launch changes the TV screen.")
        return
    if controller.app_configs_match(before, YOUTUBE):
        print("YouTube candidate is already current; no transition tested")
        return
    response = controller.tv_request(args.tv, token, "PUT", "/app/launch",
                                     {"VALUE": YOUTUBE}, timeout=5)
    print("Launch API result:", response.get("STATUS", {}).get("RESULT", "missing"))
    if not controller.status_ok(response):
        raise RuntimeError("TV rejected YouTube launch request")
    for attempt in range(24):
        current = active_config(controller, args.tv, token)
        if controller.app_configs_match(current, YOUTUBE):
            print("VERIFIED BY TV /app/current: YouTube configuration is active")
            print("Please also confirm the visible screen is the native YouTube app.")
            return
        if attempt < 23:
            time.sleep(0.5)
    raise RuntimeError("Launch API accepted the request, but /app/current did not confirm YouTube")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("Test failed:", type(error).__name__, str(error), file=sys.stderr)
        sys.exit(1)
