# Supervised SmartCast KEYLIST experiment

This is a manual, Pico-only test for the isolated Horizon Video Lab. Nothing in
the browser player, Cloudflare bridge, or unattended controller imports
`seek_batch_experiment.py`. The **KEYLIST trial** permits only the existing forward
(codeset 3, code 7) and backward (codeset 3, code 1) seek keys, with 2, 6, 12,
30, or 60 `KEYPRESS` entries. Each batch trial sends exactly one authenticated
`PUT /key_command/` containing that many identical entries. The 30- and 60-key
requests are unverified on the physical Vizio and require staged testing.
The comparison sends two separate existing `seek_forward` requests in order.
The same helper now also has a distinct Pico-local sequential trial for the
progressive seek project; see [VIDEO_LAB_PROGRESSIVE_SEEK.md](VIDEO_LAB_PROGRESSIVE_SEEK.md).

Both trials use the Pico's existing private SmartCast credential and
`TVPlayerConnection`. Each trial opens its pinned TLS socket with a read-only
`/app/current` request immediately before sending any key. No credential or
full HTTP request is printed.
An API `SUCCESS` is only an acknowledgment by the TV; visible YapGrid movement
must be checked separately. An uncertain response is never retried.

## Preparation you perform

1. Keep production Horizon and the deployed Video Lab unchanged. On the
   Windows/Thonny machine, copy **only** this repo's
   `controller/pico2w/seek_batch_experiment.py` to the Pico root as
   `/seek_batch_experiment.py`. Keep the already working `/main.py`, firmware,
   private `/config.py`, private `/secrets.py`, certificate pin, and CA file as
   they are. No firmware flashing is required.
2. On the TV, manually open the existing **Video Lab focus-switch experiment**,
   which uses `https://yapgrid.com/embed/tv/2190/13/2`. Let the episode play
   and move to a position well away from the beginning and end. If YapGrid's
   visible clock is available, record it before and after each trial. A phone
   video of the screen is useful for comparing movement and timing.
3. In Thonny, stop the running controller before using the REPL. Import the
   already installed controller and the isolated experiment helper:

   ```python
   import main as horizon
   import seek_batch_experiment as probe
   ```

   Importing these modules sends **no** key. `main.py` runs its unattended
   controller only when started as `__main__`.

## Trial A: two separate known-working seeks

First, prepare a trial in Thonny. This step connects Wi-Fi, synchronizes time,
and creates the existing pinned TLS context, but sends **no TV request or key**:

```python
trial = probe.prepare_trial()
```

On the focus-switch page, select **Window: 15 s** and **Arm Focus Transfer**.
Confirm the page reports iframe focus and its countdown has begun. Then enter
this REPL line promptly, within that window:

```python
print(probe.separate_pair(trial))
```

`separate_pair()` makes one read-only authenticated TV request to warm the
pinned socket, then calls the existing single-key `trial.send("seek_forward")`
twice. It stops if warmup fails or either key request is rejected or uncertain,
and closes the trial socket automatically.
Expect two `Player key seek_forward` timing lines and
`{'outcome': 'acknowledged', 'acknowledged_requests': 2}` when the TV accepted
both requests. Verify visually whether the episode moved about 20 seconds.
For transport comparison, add the two logged `SmartCast ... ms` request times;
keep the separate visible press-to-settled-picture observation.

## Trial B: two keys in one KEYLIST

After the screen settles, record a new starting playback time or scene. Prepare
a **new** trial in Thonny before re-arming the 15-second focus window:

```python
trial = probe.prepare_trial()
```

After the page reports iframe focus and its countdown begins, enter:

```python
print(probe.batched_pair(trial))
```

This makes the same read-only warmup, then **one** authenticated pinned
`PUT /key_command/` with exactly two identical forward `KEYPRESS` actions.
It closes the socket automatically. An acknowledged response resembles:

```text
{'outcome': 'acknowledged', 'requested_keys': 2, 'request_ms': 150}
```

The time shown is an example, not an expected result. Record the actual value,
the visible seek distance, any buffering, and the time until playback settles.
Compare this `request_ms` with the sum from Trial A. The batch helper never
prints the token or the full TV response.

If the 15-second focus window expires before a send, call `trial.close()` if a
trial is open, then re-arm before preparing a new trial. Do not interpret a
request sent while Horizon has focus as a YapGrid batching result. Wait for the
page's automatic Horizon focus restoration after each trial. TV Home and the
existing authenticated relaunch are available if remote focus becomes trapped.

## Larger supervised KEYLIST trials

The 6- and 12-key requests have been physically checked. Test 30 first, then
60 only if 30 produces the expected visible movement without errors. For each
trial, prepare a **new** one-use session in Thonny before arming focus:

```python
trial = probe.prepare_trial()
```

On the Video Lab **focus-switch** page, choose **Window: 30 s**, select
**Arm Focus Transfer**, and confirm the page reports YapGrid iframe focus.
Then promptly run exactly one of these commands in Thonny:

```python
print(probe.batched_trial(trial, 30, "seek_forward"))
```

After checking the actual scene/time shift and letting playback settle,
prepare another trial, re-arm the 30-second focus window, and run:

```python
print(probe.batched_trial(trial, 60, "seek_forward"))
```

For rewind, start well away from the beginning, prepare a new trial and
re-arm focus for **each** command:

```python
print(probe.batched_trial(trial, 30, "seek_backward"))
```

```python
print(probe.batched_trial(trial, 60, "seek_backward"))
```

Each result prints direction, requested key count, one-request latency, and
whether SmartCast acknowledged, rejected, or left the request uncertain. It
closes its socket automatically and never retries. Record YapGrid's visible
starting and ending time or scene, request latency, buffering, and focus
restoration. A SmartCast acknowledgment alone does **not** prove all seek
inputs affected playback. If a request is rejected or uncertain, stop rather
than sending a compensating seek. The focus-switch page restores Horizon
focus after 30 seconds; this is separate from the player's completion-based
focus lease.

## Interpret and report

| Observation | Meaning for the next phase |
| --- | --- |
| Separate requests visibly move about 20 s; one batch visibly moves about 20 s | Small-batch KEYLIST is promising. It still needs repeated and larger-batch physical validation before any player integration. |
| Separate requests move about 20 s; batch moves about 10 s or not at all | Repeated entries were likely merged, dropped, or ignored by this player. Favor Pico-local sequential seeking. |
| Batch moves unpredictably, overshoots, freezes, or disrupts focus | Do not use KEYLIST batching for long seeks. |
| `outcome` is `not_sent` | Read-only warmup failed; no key request was sent. Inspect the existing Pico connection before another trial. |
| `outcome` is `unknown` or `stopped_unknown_or_rejected` | Stop. A key may have reached the TV despite a lost response; do not retry automatically. Check the picture and share the safe outcome/timing only. |
| TV acknowledges but visible time is unavailable | The experiment is inconclusive. `SUCCESS` alone does not prove either seek occurred. |

For a fair comparison, note each trial's start/end visible time and the elapsed
wall time while video was playing. Near episode boundaries, a 20-second jump
may be clamped. Do not automatically seek backward to reset position. Please
share only the observed deltas, timing lines **after removing any sensitive
information**, buffering/focus behavior, and whether each request was
acknowledged. Do not share credentials, private configuration, or full headers.

## Host-only verification

From the repository root on the Mac (no TV or Pico access):

```sh
PYTHONPYCACHEPREFIX=/private/tmp/horizon-keylist-pycache python3 tests/pico-seek-batch-experiment-test.py
```

The tests verify the fixed request shapes and allowed counts, no-key preparation and
read-only warmup, single-request behavior, and stop-without-retry behavior.
They cannot prove that YapGrid processes every KEYLIST entry.
