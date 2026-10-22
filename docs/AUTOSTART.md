# Power-on controller

`controller/horizon-controller.py` is a Python standard-library controller. It reads the paired SmartCast `auth_token` only on the controller and never sends it to Horizon or to a static host. Its state file is stored outside the repository with owner-only permissions.

## Commands

Run from the repository root (after configuring `.env`, or pass the options directly):

```sh
python3 controller/horizon-controller.py status
python3 controller/horizon-controller.py launch
python3 controller/horizon-controller.py enable
python3 controller/horizon-controller.py disable
python3 controller/horizon-controller.py watch --dry-run
python3 controller/horizon-controller.py watch
python3 controller/horizon-controller.py install-agent
python3 controller/horizon-controller.py remove-agent
```

`launch` sends one app ID 17 / namespace 4 request. By default it serves `frontend/` on the controller's LAN address at port 8765. Set `HORIZON_HOST_IP` or pass `--host-ip` if the address differs. For independent HTTPS hosting, set `HORIZON_URL` or pass `--url https://YOUR-PROJECT.pages.dev/horizon.html`.

The watcher is disabled by default. `enable` reads the current power state and records it as a baseline, so enabling while the TV is already on does not launch Horizon. `disable` clears pending work. The watcher reacts only to a reported 0/off→1/on transition. Home, app switching, and input switching do not trigger another launch.

`install-agent` writes a user LaunchAgent plist but does not load it. Review the generated file, then run the printed `launchctl bootstrap` command if you want it to run after login. The agent remains disabled until the controller's enable command is run. `remove-agent` removes it. A Mac that sleeps or loses Wi-Fi cannot monitor power. For a Raspberry Pi, run the same script through a user-managed systemd unit with a private auth file and persistent state path; keep the device on the TV's LAN.

## Power detection and safe test

The controller polls authenticated `GET /state/device/power_mode` every three seconds (`1` means on, `0` means off). There is no documented SmartCast REST push event for this transition. Network/API failures are treated as unknown, never as off, to avoid false launches. If the API is unavailable for the whole off/on cycle, that cycle can be missed.

Start with a dry run:

1. With the TV on, run `python3 controller/horizon-controller.py enable` to record an on baseline.
2. Run `python3 controller/horizon-controller.py watch --dry-run`.
3. Turn the TV off and wait for `Detected TV power-off`.
4. Turn it on and wait for `DRY RUN: confirmed off-to-on event; would launch Horizon`.
5. Stop with Ctrl+C. Dry-run never sends an app launch request.

When live mode is used, the controller waits three seconds after observing the power-on edge, checks whether app ID 17 is already active, then sends one launch request. If services are still initializing or the request fails, it retries at 5, 10, 20, 40, then 60-second intervals while the TV stays on. A later Home press does not create a power edge or relaunch Horizon. Stop the watcher with Ctrl+C; use `disable` to prevent a later manual watcher start from launching.

The VQD50R-1007 was tested with one dry-run power cycle and one approved live power cycle; both transitions were detected, and the live launch opened Horizon. This is one-device evidence, not a compatibility guarantee.

## Standby and Quick Start

The SmartCast API may become unreachable in Eco standby. The VQD50R-1007 manual describes Quick Start under **All Settings > System > Power Mode** for network/voice-assistant wake and reports higher standby power use than Eco. It does not guarantee that the REST API stays reachable. The controller does not read or change this setting. Check the TV's own settings if detection fails; do not assume a network timeout means the TV is off.

## Static HTTPS hosting

`frontend/` is the static deployment root and contains no controller or credentials. Upload its contents to a static HTTPS host such as Cloudflare Pages. The `pages.dev` domain can be used without buying a custom domain. Hosting removes the need for the Mac to serve the page, but it does not remove the need for an always-on private controller for power detection and SmartCast authentication.
