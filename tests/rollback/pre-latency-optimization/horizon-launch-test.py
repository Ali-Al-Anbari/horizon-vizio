#!/usr/bin/env python3
"""Opt-in, temporary Horizon Conjure test. Never prints the pairing token."""

import argparse
import http.server
import json
import os
import pathlib
import ssl
import time
import urllib.request


TV = "192.168.1.50"
AUTH_FILE = pathlib.Path.home() / ".config/vizio-smartcast/auth.json"
ROOT = pathlib.Path(__file__).resolve().parent
ALLOWED_PATHS = {
    "/horizon.html", "/horizon.css", "/horizon-config.js", "/horizon.js",
}


class HorizonHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        if self.path.split("?", 1)[0] not in ALLOWED_PATHS:
            self.send_error(404)
            return
        super().do_GET()


def tv_request(tv, token, method, path, body=None):
    data = None if body is None else json.dumps(body, separators=(",", ":")).encode()
    request = urllib.request.Request(
        f"https://{tv}:7345{path}",
        data=data,
        headers={"AUTH": token, "Content-Type": "application/json"},
        method=method,
    )
    with urllib.request.urlopen(request, context=ssl._create_unverified_context(), timeout=3) as response:
        return json.load(response)


def successful(response):
    return response.get("STATUS", {}).get("RESULT") == "SUCCESS"


def current_app_id(response):
    candidates = [response.get("ITEM"), response]
    candidates.extend(response.get("ITEMS", []))
    for candidate in candidates:
        if isinstance(candidate, dict):
            value = candidate.get("VALUE", candidate)
            if isinstance(value, dict) and "APP_ID" in value:
                return str(value["APP_ID"])
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--approved-launch", action="store_true", help="send the one TV launch request")
    parser.add_argument("--tv", default=os.environ.get("VIZIO_TV_IP", TV), help="TV IP address")
    parser.add_argument("--auth-file", default=os.environ.get("VIZIO_AUTH_FILE", str(AUTH_FILE)), help="private paired-token JSON file")
    parser.add_argument("--host-ip", default=os.environ.get("HORIZON_HOST_IP", "192.168.1.20"), help="Mac LAN IP reachable by the TV")
    parser.add_argument("--duration", type=int, default=90, help="test duration in seconds, maximum 180")
    args = parser.parse_args()
    if not args.approved_launch:
        parser.error("No TV request sent. Run only after approval with --approved-launch.")
    if not 1 <= args.duration <= 180:
        parser.error("--duration must be between 1 and 180 seconds")

    token = json.loads(pathlib.Path(args.auth_file).expanduser().read_text())["auth_token"]
    with http.server.ThreadingHTTPServer((args.host_ip, 8765), HorizonHandler) as server:
        url = f"http://{args.host_ip}:8765/horizon.html?diagnostics=1"
        launch = {"VALUE": {"APP_ID": "17", "NAME_SPACE": 4, "MESSAGE": url}}
        print(f"Serving Horizon at {url}")
        response = tv_request(args.tv, token, "PUT", "/app/launch", launch)
        if not successful(response):
            raise RuntimeError(f"TV rejected launch: {response.get('STATUS', {}).get('RESULT', 'unknown status')}")
        print("Horizon launch accepted. Press Home to exit, or Ctrl+C to finish early.")
        server.timeout = 0.5
        deadline = time.monotonic() + args.duration
        try:
            while time.monotonic() < deadline:
                server.handle_request()
        except KeyboardInterrupt:
            pass
        try:
            current = tv_request(args.tv, token, "GET", "/app/current")
            if current_app_id(current) == "17":
                home = {"VALUE": {"APP_ID": "1", "NAME_SPACE": 4, "MESSAGE": '{"app":"home","bundle":"bundles/home"}'}}
                restored = tv_request(args.tv, token, "PUT", "/app/launch", home)
                print("Returned to Vizio Home." if successful(restored) else "Restore response failed; use the remote Home button.")
            else:
                print("TV has left Horizon; no restore request sent.")
        except Exception:
            print("Could not confirm TV state; use the remote Home button if needed.")


if __name__ == "__main__":
    main()
