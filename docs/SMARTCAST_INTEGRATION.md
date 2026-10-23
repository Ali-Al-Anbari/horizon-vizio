# Native app launch integration

## Verified on this TV

On VQD50R-1007, firmware 86.920.9.3-2, the authenticated SmartCast API on port 7345 accepted `PUT /app/launch` with:

```json
{"VALUE":{"APP_ID":"1","NAME_SPACE":5,"MESSAGE":null}}
```

The owner saw native YouTube open. A later read of `GET /app/current` returned app ID `1`, namespace `5`, and an empty `MESSAGE`. The TV normalizes the catalog's null message to an empty string. HTTP `SUCCESS` alone is not proof of a transition.

The YouTube configuration came from Vizio's current `app_availability_prod.json` catalog, joined to YouTube in `vizio_apps_prod.json`. The TV reports `BINARIES.ViziOS` as `mtk5586-1.8.1768.1`, so chipset-specific catalog entries must be selected for MT5586. The public catalog describes available apps, not the specific apps installed or enabled on a given TV. The local SmartCast API does not expose a verified installed-app list. The older app table in `exiva/Vizio_SmartCast_API` differs from the current catalog; it is not a device-specific launch mapping.

Prime Video has been visually verified with namespace `3`, app ID `3`, and a null message (the catalog's MT5586 entry).

Disney+ was launched using its catalog configuration, namespace `2`, app ID `75`, and a null message. The owner visually confirmed Disney+ opened. After transition, `GET /app/current` reported namespace `4`, app ID `75`, and `https://cd-dmgz.bamgrid.com/bbd/vizio_tv/index.html`. The controller therefore keeps separate launch and expected-current configurations for Disney+ and accepts the observed namespace-4 state as confirmation.

WatchFree+ is listed in the current catalog as namespace `2`, app ID `3014`, with message `http://127.0.0.1:12345/scfs/sctv/main.html#/watchfreeplus`. On the tested TV, the approved `/app/launch` request succeeded and the owner confirmed Live TV/WatchFree+ visibly opened. `GET /app/current` reported namespace `4`, app ID `3014`, and that same URL. The tile now launches the namespace-2 catalog configuration and verifies the observed namespace-4 active state. The TV also advertises `TUNER`, `TUNER_OTA`, and `WF_OTA_CAPABLE`; its input catalog includes a separate `TV` tuner input, selected through the authenticated `current_input` API. That tuner-input action has not been tested or mapped to the tile.

Plex is listed in the current catalog as namespace `2`, app ID `9`, with a null message. The owner confirmed Plex visibly opened after the authenticated launch. `GET /app/current` reported namespace `4`, app ID `9`, and `https://app.plex.tv/tv-smartcast`. The controller uses the catalog configuration for launch and verifies this observed namespace-4 state.

## Conjure boundary

The existing controller launches Horizon through namespace `4`, app ID `17`, with the Horizon page URL in `MESSAGE`. Horizon is an ordinary web page in that Conjure session. The reviewed public Conjure launch references describe an external paired sender; none provides a supported JavaScript interface for this retail web page to launch another native app. The page's CSP and the TV's SmartCast authentication and certificate requirements also prevent a direct browser request. A normal navigation to a streaming website is web navigation and has no verified native-app behavior. No privileged webview or firmware modification is used.

## Local controller bridge

The Python controller can serve `frontend/` at `http://CONTROLLER_LAN_IP:8765/horizon.html`. The page sends one same-origin `POST /api/apps/launch` with a fixed app identifier. Only the controller stores and sends the SmartCast token. The bridge binds to a private LAN address, checks the TV's configured source IP, exact `Host` and `Origin`, JSON content type, an action header, and an exact request body. It exposes no arbitrary URL, key command, or SmartCast proxy. Unsupported identifiers are rejected before the TV is contacted. The endpoint has no CORS grant and is not included in Cloudflare static assets. The controller checks `/app/current` before returning success, and suppresses rapid repeat requests.

This source-IP and same-origin protection assumes a trusted home LAN. Plain HTTP on the LAN is not a strong identity mechanism against an adversary on that LAN. Do not forward port 8765, publish this endpoint, or put the TV token in the page. The existing controller uses a certificate-unverified TLS connection to the TV, so a hostile LAN could intercept SmartCast traffic; certificate pinning is a separate controller hardening task.

The Cloudflare-hosted page remains a preview and can show a clear local-controller-required message on YouTube OK. Browser mixed-content and private-network restrictions prevent treating the public HTTPS page as a reliable client of an HTTP LAN bridge. To use the launch button, launch the **local** Horizon URL through the existing Conjure mechanism and keep `serve` running:

```sh
python3 controller/horizon-controller.py serve --tv TV_LAN_IP --auth-file /private/path/auth.json --host-ip CONTROLLER_LAN_IP
python3 controller/horizon-controller.py launch --tv TV_LAN_IP --auth-file /private/path/auth.json --host-ip CONTROLLER_LAN_IP --url http://CONTROLLER_LAN_IP:8765/horizon.html
```

The second command changes the TV screen and requires the owner's approval before live testing. `serve` does not enable or alter power-on automation. The controller process must remain available while Horizon is in use. Returning after YouTube requires launching Horizon again with the existing app ID `17` request; the remote Home button may return to stock Vizio Home. A seamless native-app-to-Horizon return has not been verified. A Pico 2 W watcher draft exists, but it has no bridge server and cannot support the OK-button flow as written.

## Test status

`tests/native-youtube-launch-test.py` performed the guarded real-TV YouTube check. The owner then approved launching the locally served Horizon page from YouTube and confirmed that pressing OK on its focused YouTube tile with the physical remote opened native YouTube. A subsequent `GET /app/current` confirmed app ID `1`, namespace `5`, and an empty message. Prime Video, Disney+, WatchFree+, and Plex were also visually confirmed. `tests/native-app-bridge-test.py` uses a mock TV to cover success, unauthorized and unsupported requests, offline errors, stale mappings, duplicate suppression, and local asset access. Its five tests pass. Headless Chrome checked the rendered local page, focus retention, unsupported-app notice, offline feedback, and one request after three rapid OK presses.

The page can be hosted at a static HTTPS address. Hosting does not replace the always-on controller for automatic power-on detection. See [AUTOSTART.md](AUTOSTART.md).
