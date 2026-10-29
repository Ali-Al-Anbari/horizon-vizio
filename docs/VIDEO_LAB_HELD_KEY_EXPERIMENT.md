# Supervised SmartCast held-key seek experiment

This isolated Pico REPL experiment tests only whether a timed SmartCast
`KEYDOWN`/`KEYUP` on the existing seek-forward mapping produces continuous
YapGrid seeking. It does not modify the player, batch engine, bridge, or
production code. The request uses the Pico's existing authenticated,
certificate-pinned `TVPlayerConnection` and the fixed `(codeset 3, code 7)`
mapping. SmartCast acknowledgments do not prove visible seeking.

The payload uses the API's existing action fields:

```json
{"KEYLIST":[{"CODESET":3,"CODE":7,"ACTION":"KEYDOWN"}]}
{"KEYLIST":[{"CODESET":3,"CODE":7,"ACTION":"KEYUP"}]}
```

The existing host utility and `tests/smartcast-key-test.py` verify `KEYDOWN`
and `KEYUP` as the exact supported action strings. Each action is sent once;
an uncertain response is not retried. The helper caps holds at three seconds,
uses the configured SmartCast socket timeout, attempts `KEYUP` in `finally`
after any attempted `KEYDOWN`, closes its supervised session, and rejects
overlapping runs.

## Copy to Pico and prepare

Using Thonny's device pane, copy only
`controller/pico2w/held_seek_experiment.py` to the Pico root as
`/held_seek_experiment.py`. Do not replace `/main.py` or any private
configuration, token, certificate, or firmware file.

On the physical Vizio, open the already deployed isolated Video Lab focus
switch page, let the South Park episode play, and place it away from the
beginning and end. The existing authenticated launcher command is:

```sh
python3 controller/horizon-controller.py launch \
  --tv 192.168.12.196 \
  --auth-file "$HOME/.config/vizio-smartcast/auth-192.168.12.196.json" \
  --url 'https://horizon-video-lab-preview.ali-al-anbari.workers.dev/focus-switch.html'
```

In Thonny, stop the unattended controller, then import the helpers and
prepare the trial. Preparing connects Wi-Fi, synchronizes time, and creates
the existing pinned TLS context; it sends no key and opens no TV socket:

```python
import main as horizon
import held_seek_experiment as probe
trial = probe.prepare_trial()
```

## Run each hold

On the TV, select **Window: 30 s**, then **Arm Focus Transfer**. Confirm the
page reports that iframe focus was requested and the countdown is running.
Immediately run one of these in Thonny, while the 30-second lease is active:

```python
result = probe.held_seek(trial, 0.5)
print(result)
```

The helper first makes one read-only `/app/current` request to warm the pinned
connection, sends one `KEYDOWN`, waits for the selected interval, and sends
one `KEYUP` in a `finally` path. It prints no credential or raw response body.
The returned dictionary reports the warmup, each action result, HTTP status,
request latency, connection reuse, hold duration, total elapsed time, and
whether the outcome was acknowledged, not sent, or partial/uncertain. The
30-second iframe lease covers the bounded 3-second hold, read-only warmup, and
both SmartCast actions, each using the configured socket timeout (4 seconds in
the tracked example). The parent automatically requests Horizon focus at
expiry.

For a new duration, wait for the old lease to restore Horizon focus, then
prepare a fresh trial, re-arm focus, and run one of:

```python
trial = probe.prepare_trial()
result = probe.held_seek(trial, 1)
print(result)
```

Repeat with `2` and `3`. Every call closes its trial; do not call it twice with
the same `trial`. Do not touch the remote during the held-key test. If either
response is uncertain, stop before another trial and observe whether the
video continued moving. Do not resend KEYDOWN automatically. The finally
block makes one best-effort release after an attempted press, but no software
can confirm release if the TV response is lost. The focus-switch page restores
Horizon after 15 seconds; use TV Home if controls appear stuck.

Record for each duration:

- Requested hold duration and `hold_ms` / `total_ms`.
- KEYDOWN and KEYUP outcomes, HTTP status, and request times.
- Visible YapGrid time/scene before and after, if available.
- Whether seeking continued throughout the hold, stopped at release, or
  advanced only once; note buffering and whether focus returned.

An acknowledged KEYDOWN followed by an acknowledged KEYUP is not evidence of
continuous video movement. Only the visual observation answers the question.

## Host-only tests

```sh
PYTHONPYCACHEPREFIX=/private/tmp/horizon-held-key-pycache python3 tests/pico-held-key-seek-experiment-test.py
PYTHONPYCACHEPREFIX=/private/tmp/horizon-held-key-pycache python3 tests/smartcast-key-test.py
```

These tests verify the exact action payloads, fixed mapping, duration bounds,
warmup, non-overlap, elapsed timing, and best-effort release on transport or
hold failure. They do not contact the TV or establish continuous seeking.
