# Video Lab player bridge (isolated preview)

This is local source, not a deployed feature. The existing production Horizon,
Pico app launcher, TV firmware, and subtitle modes are unchanged. SmartCast
`SUCCESS` means the TV accepted a key request; YapGrid playback must be checked
visually on the physical Vizio.

The progressive batch seek implementation and staged physical test procedure
are in [VIDEO_LAB_PROGRESSIVE_SEEK.md](VIDEO_LAB_PROGRESSIVE_SEEK.md). The
single-key description below documents the original verified command path.

## Architecture and trust

The Video Lab browser uses its preview-origin, owner-approved pairing cookie.
The preview Worker validates that cookie against its own `LaunchQueue` Durable
Object and checks same-origin write headers. A separate `PlayerBridge` Durable
Object permits only one approved player session and three fixed commands. The
Pico keeps an outbound CA-verified `wss://` connection authenticated with a
preview-only `PLAYER_BRIDGE_TOKEN`. The SmartCast credential and certificate pin
remain private on the Pico. No browser request can specify a TV key code.

On reveal, the browser opens an eight-second renewable session. The Pico makes
an authenticated, read-only `/app/current` request to establish a pinned TV
socket. It reports ready only if the TV keeps that socket open. The browser
waits for ready before focusing YapGrid. It then sends one command with a fresh
ID and sequence number. The Pico sends one SmartCast request and acknowledges
its result. Horizon restores its selected button on acknowledgment or its
three-second focus watchdog. Commands with stale creation/deadline timestamps
are rejected. The browser uses the bridge's reported time to account for TV
clock skew. An uncertain key is never automatically replayed.

While controls remain visible, the browser renews every two seconds and the
Pico sends a read-only TV heartbeat every 2.5 seconds when needed. The TV socket
closes when controls hide, the page exits, Wi-Fi drops, or the lease expires.
Closing the overlay does not wait for an outstanding readiness poll; once the
session-open request settles, the browser sends the close request.
The Pico's verified eight-request socket cap remains. It prepares a new socket
after rotation without sending a fake key. A hidden overlay does not keep a TV
TLS socket open. The Pico's outbound cloud WebSocket can remain connected.

The Pico is still a single-loop controller. While a player session is active,
an otherwise due native-app queue claim is deferred for at most eight seconds.
An active progressive seek batch uses a separate 20-second maximum deferral;
see the linked validation guide.
Power and iHeartRadio monitoring continue. Their blocking TV requests and any
claim after the deferral cap can still delay a player command. No sub-500-ms
claim is made from local tests.

## Preview setup (manual, no production changes)

1. Create a Cloudflare Access application protecting this preview Worker's
   `/owner*` and `/api/owner/*` paths. Restrict it to your owner identity.
   Set the new preview application AUD and your team domain through the Worker
   secrets below. The Worker also verifies the Access JWT and owner email.
2. Generate a distinct random bridge token of at least 32 characters privately.
   Enter the same value into the preview Worker secret and the Pico's private
   `secrets.py` as `PLAYER_BRIDGE_TOKEN`. Do not place it in source control or
   paste it into diagnostic output. Do not reuse `CONTROLLER_TOKEN`.
3. In the repository on the Mac, provision the four preview secrets through
   interactive prompts, then deploy only the preview config:

   ```sh
   npx wrangler secret put TEAM_DOMAIN --config wrangler.video-lab-preview.jsonc
   npx wrangler secret put ACCESS_AUD --config wrangler.video-lab-preview.jsonc
   npx wrangler secret put OWNER_EMAIL --config wrangler.video-lab-preview.jsonc
   npx wrangler secret put PLAYER_BRIDGE_TOKEN --config wrangler.video-lab-preview.jsonc
   npx wrangler deploy --config wrangler.video-lab-preview.jsonc
   ```

   This configuration adds **new preview-only** `LAUNCH_QUEUE` and
   `PLAYER_BRIDGE` SQLite Durable Objects under migration `v1`; it does not
   bind to production Durable Object storage. The preview assets still come
   from `./video-lab` and its media routes are unchanged. Check the target
   Worker name `horizon-video-lab-preview` before deployment.

4. Use the existing authenticated controller only when you are ready to change
   the TV screen. First open the pairing setup page:

   ```sh
   python3 controller/horizon-controller.py launch \
     --tv 192.168.12.196 \
     --auth-file "$HOME/.config/vizio-smartcast/auth-192.168.12.196.json" \
     --url https://horizon-video-lab-preview.ali-al-anbari.workers.dev/player-setup.html
   ```

   Press **Show pairing code** once on the TV. On a Mac signed in through
   Access, open `https://horizon-video-lab-preview.ali-al-anbari.workers.dev/owner`,
   review the fresh TV code and approve. The TV setup page should say paired.
   Never post the active code in logs or reports.

## Pico update (manual, through Windows and Thonny)

Transfer only `controller/pico2w/main.py` and
`controller/pico2w/player_bridge.py` from the Mac to the Windows laptop. In
Thonny, save a local backup of the Pico's existing `/main.py`, then copy those
two files to the Pico root as `/main.py` and `/player_bridge.py`. Keep its
working firmware, CA file, TV certificate pin, Wi-Fi settings, and SmartCast
token. In its private `/secrets.py`, add `PLAYER_BRIDGE_TOKEN` with the
preview-only value. In private `/config.py`, set `PLAYER_BRIDGE_ENABLED = True`.
The tracked examples retain `False` and a placeholder; do not copy examples
over the live private files.

Soft reset in Thonny. Expect `Preview player bridge is enabled`, then
`Player bridge connected`. If the second line never appears, stop before
trying a playback button; check Wi-Fi, NTP, CA trust, preview secret match, and
whether this MicroPython build permits polling its TLS stream. These capabilities
still require validation on the physical Pico.

## Supervised TV test

1. With the Pico connected, manually launch the paired player:

   ```sh
   python3 controller/horizon-controller.py launch \
     --tv 192.168.12.196 \
     --auth-file "$HOME/.config/vizio-smartcast/auth-192.168.12.196.json" \
     --url 'https://horizon-video-lab-preview.ali-al-anbari.workers.dev/player-overlay.html?sub=on'
   ```

2. Let video start with the overlay hidden. Press one arrow or OK. It must
   reveal controls without sending a key. Confirm `Player session prepare:
   ready` on Pico. Wait five seconds: controls hide and Pico logs `Player
   session closed`. Repeat this reveal/hide cycle before testing commands.
3. Reveal again. Press OK on Play/Pause once. Verify picture pauses, Horizon
   regains button focus, and the Pico reports exactly one `pause_toggle`.
   Repeat once to resume. Do not infer the video state from HTTP 200 alone.
4. Select Forward and press OK once. Verify one `seek_forward` input and one
   visible seek. Follow the staged progressive trials in the linked document
   before trying larger jumps. Measure focus-to-result time from the browser
   message and the Pico's per-command timing; do not subtract their
   unsynchronized clocks.
5. Test Back while visible (hide), Back while hidden (return to selector),
   subtitle ON/OFF reload confirmation, Home, and a Wi-Fi disconnect/reconnect.
   If focus gets trapped, use physical TV Home, then relaunch the preview.

To roll back, set private `PLAYER_BRIDGE_ENABLED = False` and restore the saved
Pico `/main.py`; remove `/player_bridge.py` only after it is no longer used.
No firmware flash is involved. The preview Worker can stay deployed with no
Pico connection; player commands then fail closed.

## Local checks

```sh
node --test tests/video-lab-player-*.test.js tests/video-lab-media-worker.test.js
PYTHONPYCACHEPREFIX=/private/tmp/horizon-pycache python3 tests/pico-cloud-controller-test.py
npm run test:cloud
WRANGLER_LOG_PATH=/private/tmp/horizon-wrangler.log npx wrangler deploy --config wrangler.video-lab-preview.jsonc --dry-run
```

The local tests simulate Worker and Pico behavior. They do not prove the Vizio
focus handoff timing, WebSocket compatibility, command reception by YapGrid, or
the total round trip. The warm SmartCast request itself was physically measured
at about 143 ms before this bridge existed; the cloud and browser portions are
still unmeasured.

The isolated local Wrangler runtime returned 201 for pairing start, 200 for
`/owner`, 403 for unpaired player routes, and 101 for a WebSocket upgrade using
a dummy local credential. The dev server was deliberately stopped with Ctrl-C
(exit 130). Wrangler 4.151.0's bundled local runtime only accepts compatibility
dates through 2026-10-19, so that run used `--compatibility-date 2026-10-19`
without changing the preview deployment configuration. A deployed Cloudflare
Worker and the Pico's MicroPython TLS polling remain untested.
