# Pico 2 W Horizon controller

The Pico runs the existing custom MicroPython v1.29.0 firmware. Its Vizio
SmartCast connection still uses the native SHA-256 leaf pin in a dedicated TLS
context. Cloudflare uses a separate `CERT_REQUIRED` context, a fixed hostname
for SNI and certificate hostname validation, and the public ISRG Root X1 CA in
`cloud-root-isrg-x1.pem`. The live `workers.dev` certificate chain observed for
the production endpoint led to this root. If that chain changes to another
public CA, Cloudflare requests fail closed until the CA bundle is deliberately
updated. There is no HTTP fallback or redirect following.

MicroPython 1.29 documents `SSLContext.load_verify_locations(cafile=...)`,
`CERT_REQUIRED`, and `server_hostname`; its docs also require a valid clock for
certificate date checks. The controller synchronizes NTP before either HTTPS
connection. [MicroPython v1.29 `ssl` documentation](https://docs.micropython.org/en/v1.29.0/library/ssl.html).

## Modes

### Isolated player-key engine (supervised only)

`main.py` exposes `supervised_player_command("pause_toggle")`,
`supervised_player_command("seek_backward")`, and
`supervised_player_command("seek_forward")` for an explicit Thonny REPL test.
They use the existing pinned SmartCast TLS and private device token. They are
not called by boot, the cloud queue, or the unattended loop. Stop the running
controller in Thonny before testing, and make sure YapGrid has focus on the TV.
Each call reports a local monotonic receipt tick, connection/TLS/request
durations, and API acceptance. Acceptance does not prove YapGrid acted. The
bounded `PlayerCommandDispatcher` is a future transport seam; no browser-to-Pico
transport or automatic key delivery exists yet. Copy only the updated `main.py`
to `/main.py` for this test; keep private config and secrets unchanged.

For a same-session cold/warm comparison, keep YapGrid focused and explicitly
run `supervised_player_sequence(("seek_forward", "seek_forward"), reuse=True)`
from Thonny after `import main as horizon` (prefix the call with `horizon.`).
The first log should say `socket new`; the second says `socket warm` only if the
TV kept the HTTP/1.1 connection open. `reuse=False` sends each key on a new
pinned connection for a control comparison. The experimental socket closes
after five seconds idle, eight requests, a server close, or any error. A failed
or ambiguous command stops the supervised sequence and is never replayed.
No keep-alive socket is opened by unattended startup or existing TV polling.
The first physical `reuse=True` trial timed out on its first response after a
successful pinned TLS handshake; its old reader requested 512 bytes at once.
The revised opt-in path reads headers one byte at a time and then exactly the
declared Content-Length or chunked body. It logs only the safe phase, framing
type, and elapsed times. For the next test, run `import main as horizon` and
`trial = horizon.prepare_supervised_player_session()` in Thonny **before**
transferring TV focus. Preparing connects Wi-Fi and synchronizes NTP but sends
no key and opens no TV socket. After focusing YapGrid, run
`trial.send("seek_forward")` once, then `trial.close()`. Confirm one successful
`socket new` request before interpreting any `socket warm` timings. If it still
fails, report the phase line and use the existing one-shot path; do not repeat
an ambiguous key command automatically. A later warm test can call `send()`
twice on a new prepared trial, within the five-second idle limit.

`config.example.py` defaults both `CLOUD_LIVE_CLAIMING` and
`AUTO_LAUNCH_ON_POWER` to `False`. It also defaults
`IHEART_RETURNS_TO_HORIZON` to `False`.

- **Default supervised run:** checks Wi-Fi, NTP, pinned Vizio TLS, read-only TV
  state when the SmartCast token is configured, CA-verified Cloudflare TLS,
  and—when the private controller token is configured—a safe authorization
  probe. That probe sends authenticated `GET /api/controller/claim`; the Worker
  validates the token then returns 405 before any command can be claimed.
- **Live cloud mode:** set `CLOUD_LIVE_CLAIMING = True` only for a supervised
  queue test. It polls every 3 seconds by default. It claims and runs commands,
  so leave it `False` until the connectivity probe has passed and you are ready
  for the requested TV app to open.
- **Power-on Horizon:** remains independently disabled. `AUTO_LAUNCH_ON_POWER`
  must be the literal boolean `True` to launch Horizon on a confirmed TV
  off-to-on transition. Home and native-app changes are not power transitions.
  Leave it `False` through cloud testing; enable it later only after the cloud
  launch tests pass and you explicitly choose to turn it on.
- **iHeart return shortcut:** `IHEART_RETURNS_TO_HORIZON = True` makes the Pico
  read `/app/current` every `IHEART_POLL_MS` (default 2000 ms) while the TV is
  confirmed on. A new, exact iHeartRadio app state (namespace 4, app ID 6)
  triggers the existing pinned local Horizon launch. The Pico confirms Horizon
  through `/app/current`, suppresses duplicates and applies a 15-second
  cooldown. If Horizon remains unconfirmed after 8 seconds, it permits one
  retry only after fresh reads confirm both TV power-on and iHeartRadio still
  active. Verification ends after 20 seconds. A cloud claim or a different app
  cancels the attempt. This is independent of cloud claiming and power-on launch.

The cloud client accepts only the five verified app keys and uses fixed native
launch mappings. It checks `/app/current` before launching and after the PUT;
only an exact expected app state is reported as `verified/app_confirmed`. A
lost claim response is ambiguous: the Pico does not retry that claimed command
locally, and the queue may expire it. A lost result response may leave the
result unknown. No retry path blindly repeats a native launch. Cloud HTTP
responses are capped at 4 KiB, headers at 1.5 KiB; Content-Length, chunked
responses, 204, and close-delimited responses are handled in the default
single-request mode. Connection reuse requires explicit response framing.
Redirects are returned as errors and never followed with the bearer credential.

`CLOUD_KEEPALIVE = False` is the safe default. For a supervised trial, setting
it to `True` permits sequential claim and result requests on one CA-verified
HTTP/1.1 TLS socket. The client reads exactly one framed response, closes on a
server `Connection: close`, any error, five seconds idle, or 12 requests, and
verifies the certificate again on each new socket. It never replays a failed
POST because a failed read can leave the server-side claim outcome unknown.
The Pico and Cloudflare must both keep the socket open for reuse to help;
physical Pico heap use and stale-connection behavior remain unverified.

## Files to copy to the Pico

Copy these four files from this directory to a private USB drive:

- `main.py`
- `config.example.py`
- `secrets.example.py`
- `cloud-root-isrg-x1.pem` (public CA certificate, not a credential)

On Windows Thonny, save them to the Pico as `/main.py`, `/config.py`,
`/secrets.py`, and `/cloud-root-isrg-x1.pem`, respectively. Keep both flags
`False`. Edit `/config.py` on the Pico with the Wi-Fi name/password, TV IP,
previously verified TV TLS name and pin, and CA filename. The TV IP remains
configurable; a DHCP reservation is recommended so it stays stable.

## Private credential provisioning

The template contains placeholders only. On the Windows laptop, open
`/secrets.py` from the **device pane** in Thonny and enter the paired SmartCast
token and Cloudflare `CONTROLLER_TOKEN` directly into that device file. Do not
save the populated file to the PC, USB drive, repository, or a cloud-synced
folder. Keep the Thonny shell clear of credential-printing commands; never
paste credentials into this chat or a screenshot. The Pico filesystem is not
encrypted, so physical possession can expose credentials.

The token value must exactly match the existing production `CONTROLLER_TOKEN`.
This implementation does not read or alter the Mac’s private token file.

## First supervised test on Windows

After copying files and privately populating `/config.py` and `/secrets.py`,
run `/main.py` with F5 while both flags remain `False`. Expected messages:

```text
Horizon Pico supervised check: read-only; no app launch
Wi-Fi: connected; address <Pico LAN address>
NTP: synchronized; UTC <current time>
Vizio TLS: pinned handshake accepted
SmartCast: read-only requests succeeded
TV power: <on or off>
Current app ID: <current ID> namespace: <current namespace>
Cloudflare TLS: CA-verified handshake accepted
Cloud controller auth: accepted; queue was not claimed
```

If the controller token is not configured, auth is reported as skipped. If CA
loading, certificate validation, hostname verification, or clock validation
fails, the run stops; it does not disable verification or send the bearer
token. This test performs no claim, native-app launch, or TV screen change.

## Supervised YouTube queue test

Only after the previous test passes:

1. Keep `AUTO_LAUNCH_ON_POWER = False`.
2. Set `CLOUD_LIVE_CLAIMING = True` on the Pico and run `/main.py` again. It
   begins polling, but does not claim when the queue is empty.
3. With Horizon visible on the TV, press OK on YouTube once. The Pico claims
   the command, launches only its fixed YouTube mapping, and reads `/app/current`
   until it confirms the expected app state.
4. Expect `Cloud command claimed: youtube` followed by
   `Cloud launch YouTube: verified (app_confirmed)`. Confirm YouTube is
   visibly open. A different state should produce `tv_unconfirmed`; TV/network
   failure produces `tv_unavailable`; API rejection produces `tv_rejected`.
5. Set `CLOUD_LIVE_CLAIMING = False` when the test is complete.

This repository has mock tests only. The above is the first physical Pico test;
do not describe it as passed until it is run on the board. After YouTube passes,
Prime Video can be tested with the same process. The other verified mappings
are preserved in source but should be exercised on the Pico before unattended
use.

## Always-on operation and return to Horizon

Once supervised cloud launches pass, run with `CLOUD_LIVE_CLAIMING = True` for
always-on queue handling. To also enable automatic Horizon startup after a
confirmed TV off-to-on transition, separately change
`AUTO_LAUNCH_ON_POWER = True`. Its first power reading is only a baseline; Home
or opening a streaming app cannot trigger another Horizon launch. This is not
enabled by these source changes. Vizio Home may still be the result of pressing
the TV Home button; seamless return from a native app is not promised.

## Supervised iHeart return test

Back up the existing Pico `/main.py` to a local Windows file using Thonny's
device Files pane. Transfer the updated `main.py` and save it as `/main.py` on
the Pico. Add `IHEART_RETURNS_TO_HORIZON = False`, `IHEART_POLL_MS = 2000`, and
`IHEART_DIAGNOSTICS = False` to the private device `/config.py`. Do not replace
its existing Wi-Fi, TV, TLS, or cloud settings with template placeholders.
With the TV on and the Pico connected, set the shortcut flag to `True` and
restart `/main.py` in Thonny. Leave the existing cloud and power flags as
already configured. Open YouTube or Prime Video normally, then press the
physical iHeartRadio button once. Look for `iHeart shortcut: Horizon confirmed`
and confirm Horizon visibly opens. With `PERF_TIMING = True`, the Pico logs the
app-state read, launch request, and detection-to-confirmation times without
printing credentials. For a failed return, set `IHEART_DIAGNOSTICS = True` on
the Pico and restart it before repeating the test. Diagnostic lines contain
relative monotonic milliseconds, previous and current numeric app identities,
launch outcome, retry count, cooldown state, and categorical result. No URL,
token, certificate pin, or HTTP header is logged. Turn diagnostics off after
testing. To disable the shortcut, set `IHEART_RETURNS_TO_HORIZON = False` and
restart the controller. To roll back the code, restore the backed-up `/main.py`;
leave `/config.py` and `/secrets.py` untouched.

Relevant diagnostic outcomes are `launch=rejected` for a SmartCast rejection,
`launch=accepted` followed by `finish ... detail=timeout` when Horizon was
never observed, `detail=horizon_lost` when Horizon was seen and then an
unrelated app remained active, `detail=confirmed_after_read_error` when a
temporary read failure was followed by confirmation, and
`detail=tv_unavailable` when TV state could not be read at the deadline.
`detail=app_changed`, `detail=superseded`, and `detail=tv_off` suppress retries.
An accepted SmartCast response is never treated as proof that Horizon opened.

The default two-second cadence adds up to 30 pinned TV reads per minute while
the TV is on; confirmation uses those same scheduled reads. A retry eligibility
check adds one power read and one fresh app read. Detection is bounded
by the polling interval and network request duration while the loop is idle;
a cloud launch or network outage can delay it further. Pico logs measure from
the first observed iHeart state, not from the physical button press. Host tests
do not establish actual TV latency or display timing.

## Launch latency measurements

Set `PERF_TIMING = True` in the private Pico `/config.py` for a supervised
measurement run. The Pico reports safe durations for cloud claim, TV power
read or reuse, current-app precheck, SmartCast launch acceptance, app-state
confirmation, and result reporting. DNS, TCP, TLS handshake, and garbage
collection are broken out for completed requests. `IHEART_DIAGNOSTICS = True`
adds relative detection, retry, and verification events with numeric app IDs.
Both flags default to `False`; switch them off after collecting a short sample.

Cloud claim polling is scheduled from its previous due time and skips missed
slots after slow work. This removes the request duration from the normal idle
poll interval without bursting to catch up. The example keeps
`CLOUD_POLL_MS = 3000` and `IHEART_POLL_MS = 2000`. For a controlled comparison,
try `CLOUD_POLL_MS = 1500` or `IHEART_POLL_MS = 1000` one at a time, then
restore the original value if errors, stalls, or excess TV load appear.
`POLL_MS` caps idle sleep; the earlier cloud and iHeart deadlines still wake
the loop. The iHeart retry may happen on the next scheduled app sample after
an explicit SmartCast rejection, but transport errors keep the conservative
eight-second retry gate. Every retry still requires fresh TV-on and iHeart
state reads.

For a supervised trial, `CLOUD_REUSE_RECENT_POWER = True` lets the Pico reuse a
successful TV-on power read for a cloud launch only when it is at most one
second old. It defaults to `False`, which keeps the normal separate power read.
It still reads `/app/current` before the PUT and verifies the native app
afterward. Native app verification keeps its 24-read cap and adds a 15-second
monotonic budget by default (`CLOUD_CONFIRM_MS = 15000`), so slow
responses cannot multiply a fixed attempt count into a much longer stall;
one in-flight socket operation can still overrun that budget. Neither
TV connections remain separate and certificate-pinned. Cloudflare connections
are reused only if `CLOUD_KEEPALIVE = True`; otherwise each request retains
the previous close-after-response behavior. During a pending iHeart return,
once Horizon has been seen once, a due cloud claim may wait up to one second
for the second confirmation sample. The claim runs immediately afterward, so
the queue remains serviced and a claimed command still supersedes the shortcut.
Set `IHEART_CONFIRM_PRIORITY_MS = 0` in the private config to restore the
original cloud-first ordering independently of connection reuse.
The frontend's opt-in `?diagnostics=1` overlay shows local OK-to-request and
result-observation durations plus queue-to-claim and claim-to-result intervals
from the Durable Object's own timestamps. Those server timestamps must not be
subtracted from Pico or browser monotonic time. Record the first visible app
change separately with a phone video showing the remote and TV; API acceptance
and final confirmation may occur at different times from visible startup.

For the keep-alive trial, keep the existing cloud and iHeart poll intervals
unchanged. Enable only `CLOUD_KEEPALIVE` and `PERF_TIMING` temporarily, then
compare `Timing Cloud connection: new/reused`, empty-claim duration, heap free
before/after the run, cloud claim-to-result time, and iHeart confirmation time.
If the Pico reports repeated timeouts, runs low on heap, or claims become
unreliable, set `CLOUD_KEEPALIVE = False` and restart `/main.py`. A stale socket
failure closes the socket and uses the existing cloud retry schedule; it never
automatically resends the failed request.

## Local tests

From the repository root on Mac:

```sh
python3 tests/pico-cloud-controller-test.py
python3 tests/cloud-controller-test.py
python3 -m py_compile controller/pico2w/main.py
```

These tests mock Cloudflare, TLS, sockets, and SmartCast. They do not replace
supervised validation on the physical Pico. No firmware rebuild is required.
