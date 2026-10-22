#!/usr/bin/env python3
"""Local, opt-in SmartCast power watcher and Conjure launcher.

The watcher only reacts to a confirmed 0 -> 1 power-state edge. Network errors
are unknown state, never power-off. Pairing credentials stay on the controller.
"""

import argparse
import errno
import http.server
import json
import os
import pathlib
import plistlib
import ssl
import sys
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone


TV_DEFAULT = os.environ.get("VIZIO_TV_IP", "192.168.1.50")
PORT = 7345
NAMESPACE = 4
APP_ID = "17"
HOSTED_HORIZON_URL = "https://horizon-vizio.ali-al-anbari.workers.dev/"
AUTH_DEFAULT = pathlib.Path(os.environ.get(
    "VIZIO_AUTH_FILE", "~/.config/vizio-smartcast/auth.json"
)).expanduser()
STATE_DEFAULT = (
    pathlib.Path.home() / "Library/Application Support/HorizonController/state.json"
    if sys.platform == "darwin"
    else pathlib.Path.home() / ".config/horizon-controller/state.json"
)
ALLOWED_PATHS = {
    "/horizon.html", "/horizon.css", "/horizon-config.js",
    "/horizon.js", "/horizon-diagnostics.js",
}
REQUIRED_ASSETS = set(ALLOWED_PATHS)
RETRY_SECONDS = (5, 10, 20, 40, 60, 60, 60)
POLL_SECONDS = 3


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_auth(path):
    # Never log the token or the auth file contents.
    return json.loads(pathlib.Path(path).expanduser().read_text())["auth_token"]


def tv_request(tv, token, method, path, body=None, timeout=3):
    data = None if body is None else json.dumps(body, separators=(",", ":")).encode()
    request = urllib.request.Request(
        f"https://{tv}:{PORT}{path}", data=data,
        headers={"AUTH": token, "Content-Type": "application/json"}, method=method,
    )
    context = ssl._create_unverified_context()
    with urllib.request.urlopen(request, context=context, timeout=timeout) as response:
        return json.load(response)


def status_ok(response):
    return response.get("STATUS", {}).get("RESULT") == "SUCCESS"


def current_power(tv, token):
    response = tv_request(tv, token, "GET", "/state/device/power_mode")
    if not status_ok(response):
        raise RuntimeError("TV rejected the power-state request")
    for item in response.get("ITEMS", []):
        if item.get("CNAME") == "power_mode":
            value = item.get("VALUE")
            if value in (0, "0", False):
                return 0
            if value in (1, "1", True):
                return 1
    raise RuntimeError("TV did not return a recognized power state")


def current_app_id(tv, token):
    response = tv_request(tv, token, "GET", "/app/current")
    if not status_ok(response):
        raise RuntimeError("TV rejected the current-app request")
    candidates = [response.get("ITEM"), response]
    candidates.extend(response.get("ITEMS", []))
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        value = candidate.get("VALUE", candidate)
        if isinstance(value, dict) and "APP_ID" in value:
            return str(value["APP_ID"])
    return None


def launch_horizon(tv, token, url):
    body = {"VALUE": {"APP_ID": APP_ID, "NAME_SPACE": NAMESPACE, "MESSAGE": url}}
    response = tv_request(tv, token, "PUT", "/app/launch", body, timeout=5)
    if not status_ok(response):
        raise RuntimeError("TV rejected the Conjure launch request")


def default_state():
    return {
        "enabled": False,
        "last_power": None,
        "pending": None,
        "last_event": None,
    }


def read_state(path):
    try:
        value = json.loads(pathlib.Path(path).expanduser().read_text())
        state = default_state()
        state.update(value)
        return state
    except FileNotFoundError:
        return default_state()


def write_state(path, state):
    path = pathlib.Path(path).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        path.parent.chmod(0o700)
    except OSError:
        pass
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(state, indent=2) + "\n")
    try:
        temporary.chmod(0o600)
    except OSError:
        pass
    temporary.replace(path)


def horizon_url(args):
    return args.url or f"http://{args.host_ip}:8765/horizon.html"


class HorizonHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, directory, **kwargs):
        self.directory = str(directory)
        super().__init__(*args, directory=self.directory, **kwargs)

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path not in ALLOWED_PATHS:
            self.send_error(404)
            return
        super().do_GET()
        self.server.assets_seen.add(path)
        if REQUIRED_ASSETS.issubset(self.server.assets_seen):
            self.server.assets_event.set()

    def log_message(self, fmt, *args):
        # Avoid noisy request logs in the unattended watcher.
        return


def needs_local_server(args):
    parsed = urllib.parse.urlsplit(horizon_url(args))
    return parsed.scheme == "http" and parsed.hostname == args.host_ip and parsed.port == 8765


def start_local_server(args):
    server = http.server.ThreadingHTTPServer(
        (args.host_ip, 8765),
        lambda *a, **kw: HorizonHandler(*a, directory=pathlib.Path(__file__).resolve().parent.parent / "frontend", **kw),
    )
    server.assets_seen = set()
    server.assets_event = threading.Event()
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, name="HorizonStaticServer", daemon=True)
    thread.start()
    return server


def app_url(args):
    return horizon_url(args)


def command_status(args):
    state = read_state(args.state_file)
    print("Automation:", "enabled" if state["enabled"] else "disabled")
    print("Last observed power:", {0: "off", 1: "on"}.get(state["last_power"], "unknown"))
    print("Pending launch:", "yes" if state.get("pending") else "no")
    token = load_auth(args.auth_file)
    mode = current_power(args.tv, token)
    print("Current TV power:", "on" if mode else "off")
    print("Quick Start/Eco preference: not reported by this TV's read-only API response")


def command_enable(args):
    token = load_auth(args.auth_file)
    mode = current_power(args.tv, token)
    state = read_state(args.state_file)
    state.update(enabled=True, last_power=mode, pending=None)
    write_state(args.state_file, state)
    print("Power watcher enabled; baseline is", "on" if mode else "off")


def command_disable(args):
    state = read_state(args.state_file)
    state.update(enabled=False, pending=None)
    write_state(args.state_file, state)
    print("Power watcher disabled; pending launch cleared")


def run_launch(args, token):
    server = None
    if needs_local_server(args):
        try:
            server = start_local_server(args)
        except OSError as error:
            if getattr(error, "errno", None) != errno.EADDRINUSE:
                raise
            # If the always-on watcher owns the port, verify it serves Horizon.
            try:
                with urllib.request.urlopen(app_url(args), timeout=2) as response:
                    if b"Horizon" not in response.read(2048):
                        raise RuntimeError("Port 8765 is occupied by a non-Horizon server")
            except Exception as probe_error:
                raise RuntimeError("Local Horizon server is unavailable on port 8765") from probe_error
    try:
        launch_horizon(args.tv, token, app_url(args))
        print("Horizon launch accepted")
        if server:
            if server.assets_event.wait(20):
                print("TV fetched the Horizon page assets")
            else:
                print("The TV has not fetched every Horizon asset yet; keep this process available or use the hosted URL")
    finally:
        if server:
            server.shutdown()
            server.server_close()


def maybe_process_pending(args, token, state, mode, dry_run):
    pending = state.get("pending")
    if not pending:
        return
    if mode != 1:
        state["pending"] = None
        write_state(args.state_file, state)
        print("Pending launch cancelled because the TV is off")
        return
    if time.time() < pending.get("retry_at", 0):
        return
    try:
        # Avoid a duplicate if a previous launch succeeded but its response was lost.
        if current_app_id(args.tv, token) == APP_ID:
            state["last_event"] = pending["id"]
            state["pending"] = None
            write_state(args.state_file, state)
            print("Horizon is already active; power-on event completed")
            return
        if dry_run:
            print("DRY RUN: confirmed off-to-on event; would launch Horizon")
            state["last_event"] = pending["id"]
            state["pending"] = None
            write_state(args.state_file, state)
            return
        launch_horizon(args.tv, token, app_url(args))
        state["last_event"] = pending["id"]
        state["pending"] = None
        write_state(args.state_file, state)
        print("Horizon launched for confirmed off-to-on event")
    except Exception as error:
        attempt = pending.get("attempt", 0) + 1
        if attempt > len(RETRY_SECONDS):
            print("Auto-launch stopped after retries:", type(error).__name__)
            state["pending"] = None
        else:
            delay = RETRY_SECONDS[attempt - 1]
            pending.update(attempt=attempt, retry_at=time.time() + delay)
            print(f"TV still initializing or unreachable; retry {attempt} in {delay}s ({type(error).__name__})")
        write_state(args.state_file, state)


def command_watch(args):
    state_path = pathlib.Path(args.state_file).expanduser()
    print("Horizon power watcher running; automatic launch", "dry-run" if args.dry_run else "ready")
    print("Press Ctrl+C to stop. Controller state:", state_path)
    server = start_local_server(args) if needs_local_server(args) and not args.dry_run else None
    last_error_log = 0.0
    try:
        while True:
            state = read_state(state_path)
            if not state["enabled"]:
                time.sleep(1)
                continue
            try:
                token = load_auth(args.auth_file)
                mode = current_power(args.tv, token)
                if state.get("last_power") is None:
                    state["last_power"] = mode
                    write_state(state_path, state)
                    print("Observed initial state:", "on" if mode else "off", "(no launch on startup baseline)")
                elif mode != state["last_power"]:
                    old_mode = state["last_power"]
                    state["last_power"] = mode
                    if old_mode == 0 and mode == 1:
                        event_id = utc_now()
                        state["pending"] = {"id": event_id, "attempt": 0, "retry_at": time.time() + 3}
                        print("Detected TV power-on; waiting briefly for app services")
                    elif old_mode == 1 and mode == 0:
                        state["pending"] = None
                        print("Detected TV power-off")
                    write_state(state_path, state)
                maybe_process_pending(args, token, state, mode, args.dry_run)
                last_error_log = 0.0
            except Exception as error:
                # Keep the previous power value. An API outage must never look like power-off.
                if time.monotonic() - last_error_log > 30:
                    print("TV state temporarily unavailable; retaining last known state:", type(error).__name__)
                    last_error_log = time.monotonic()
            time.sleep(POLL_SECONDS)
    except KeyboardInterrupt:
        print("Horizon power watcher stopped")
    finally:
        if server:
            server.shutdown()
            server.server_close()


def launch_agent_path():
    return pathlib.Path.home() / "Library/LaunchAgents/com.horizon.vizio-controller.plist"


def command_install_agent(args):
    target = launch_agent_path()
    log_dir = pathlib.Path.home() / "Library/Logs/HorizonController"
    log_dir.mkdir(parents=True, exist_ok=True)
    arguments = [sys.executable, str(pathlib.Path(__file__).resolve()), "watch",
                 "--tv", args.tv, "--auth-file", str(pathlib.Path(args.auth_file).expanduser()),
                 "--state-file", str(pathlib.Path(args.state_file).expanduser()),
                 "--host-ip", args.host_ip]
    if args.url:
        arguments.extend(["--url", args.url])
    if args.dry_run:
        arguments.append("--dry-run")
    payload = {
        "Label": "com.horizon.vizio-controller",
        "ProgramArguments": arguments,
        "RunAtLoad": True,
        "KeepAlive": True,
        "ProcessType": "Background",
        "StandardOutPath": str(log_dir / "controller.log"),
        "StandardErrorPath": str(log_dir / "controller-error.log"),
    }
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(plistlib.dumps(payload))
    target.chmod(0o600)
    print("LaunchAgent prepared at", target)
    print("Load it with: launchctl bootstrap gui/$(id -u)", target)
    print("The agent remains disabled until the controller's enable command is run.")


def command_remove_agent(_args):
    target = launch_agent_path()
    subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}", str(target)],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    try:
        target.unlink()
        print("LaunchAgent removed")
    except FileNotFoundError:
        print("LaunchAgent was not installed")


def add_connection_options(parser):
    parser.add_argument("--tv", default=TV_DEFAULT, help="TV IP address")
    parser.add_argument("--auth-file", default=str(AUTH_DEFAULT), help="private paired-token JSON file")
    parser.add_argument("--state-file", default=str(STATE_DEFAULT), help="local enable and power-edge state file")


def add_host_options(parser):
    parser.add_argument("--host-ip", default=os.environ.get("HORIZON_HOST_IP", "192.168.1.20"), help="controller LAN IP reachable by the TV")
    parser.add_argument("--url", default=os.environ.get("HORIZON_URL") or HOSTED_HORIZON_URL,
                        help="Horizon page URL (defaults to the public HTTPS site)")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name, handler in (("status", command_status), ("enable", command_enable), ("disable", command_disable), ("launch", None), ("watch", command_watch), ("install-agent", command_install_agent), ("remove-agent", command_remove_agent)):
        command = sub.add_parser(name)
        add_connection_options(command)
        if name in ("launch", "watch", "install-agent"):
            add_host_options(command)
        if name in ("watch", "install-agent"):
            command.add_argument("--dry-run", action="store_true", help="log detected power-on events without launching")
        command.set_defaults(handler=handler)
    args = parser.parse_args()
    if args.command == "launch":
        run_launch(args, load_auth(args.auth_file))
    else:
        args.handler(args)


if __name__ == "__main__":
    main()
