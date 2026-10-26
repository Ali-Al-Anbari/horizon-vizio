# Video Lab batch focus and arrow seeking

This is local source for the isolated `horizon-video-lab-preview` Worker.
It has not been deployed or tested on the TV. Production Horizon is untouched.

## Remote interaction

Press an arrow or OK once to reveal controls. On a focused seek button,
horizontal arrows immediately change that direction's amount. Forward Right
increases and Left decreases. Rewind Left increases and Right decreases. The
button itself shows its selected amount:

| Amount | SmartCast seek inputs |
|---|---:|
| 10s | 1 |
| 30s | 3 |
| 1m | 6 |
| 2m | 12 |
| 5m | 30 |
| 10m | 60 |

The amount stops at 10s and 10m. **OK** sends exactly one batch at that
amount. Up from Rewind or Forward moves to Play/Pause; Down moves to Subtitles.
From Play/Pause, Left and Right select the seek buttons and Down opens the
lower row. In the lower row, Left and Right select Subtitles and Episodes; Up
returns to Play/Pause. This keeps all controls reachable while horizontal
arrows adjust the selected seek.

Both seek amounts persist through OK, batch completion or failure, direction
changes, and navigation while the control bar is open. There is no seek
selection inactivity timer. Both amounts reset to 10s only when the control
bar hides or the player closes, exits, or reloads. Repeated OK does not
accelerate or queue another seek.

Play/Pause uses the existing single-command path. The default 10s seek also
retains a short focus lease. Longer batches keep the YapGrid iframe focused
until the matching batch status says `complete`, `failed`, `cancelled`, or
`unknown`. Cloudflare acceptance alone does not restore focus. A 30-second
watchdog restores Horizon focus and asks the Pico to cancel remaining inputs.
If status is still absent after five more seconds, the bridge session closes
and the UI reports an unknown partial result. Neither a SmartCast
acknowledgment nor the progress label confirms YapGrid's actual playback
position.

While YapGrid owns focus, Horizon may not receive Back or OK. Remote Back
cannot be relied on for immediate cancellation during a long batch. The
watchdog bounds focus capture; TV Home remains a physical escape. Already
delivered seek inputs cannot be undone. Do not start a second seek until the
first reaches terminal status. The preview allows no overlapping batches.

## Existing transport

One authenticated browser `POST /api/player/batch` with a fixed allowlisted
count produces one authenticated Cloudflare-to-Pico `player_batch` instruction.
The Pico sends that many sequential fixed SmartCast KEYPRESS requests on its
warm, pinned TLS connection. Browser status polling issues no seek inputs.
The Pico accepts cancellation between individual inputs and never retries
an input with uncertain delivery. The Pico's WebSocket parser consumes
`bytearray` frames with slice assignment, retaining MicroPython compatibility.

## Manual preview deployment and physical check

The current change edits only preview overlay source, documentation, and
tests. If the Pico already runs the working batch bridge that produced the
reported 1, 3, 6, 12, 30, and isolated 60-input results, **no Pico file
needs reuploading for this change**. Do not change its credentials, pin,
firmware, or private configuration.

When ready, from the repository root on the Mac, deploy only the preview:

```sh
npx wrangler deploy --config wrangler.video-lab-preview.jsonc
```

Launch the preview player using the existing controller utility:

```sh
python3 controller/horizon-controller.py launch \
  --tv 192.168.12.196 \
  --auth-file "$HOME/.config/vizio-smartcast/auth-192.168.12.196.json" \
  --url 'https://horizon-video-lab-preview.ali-al-anbari.workers.dev/player-overlay.html?sub=on'
```

Start well away from an episode boundary. Press an arrow to reveal controls,
then select Forward. On Forward, press Right the specified number of times,
then OK. To repeat each as an independent trial from 10s, wait for terminal
status, press Back to hide the bar, reveal it again, and reselect Forward.
Hiding the bar is the only action here that resets the amount.

| Trial | Right presses | Expected label | Input count |
|---|---:|---|---:|
| +30s | 1 | +30s | 3 |
| +1m | 2 | +1m | 6 |
| +2m | 3 | +2m | 12 |
| +5m | 4 | +5m | 30 |
| +10m | 5 | +10m | 60 |

Wait for the previous trial's terminal status and Horizon focus before the
next. Confirm each selected label persists after OK and completion. Confirm YapGrid movement
from its displayed time or an identifiable scene before and after, allowing
for playback that continues during the trial. Write down elapsed time, scene
movement, acknowledged count, buffering, and any missed seek. Do not infer
movement from HTTP 200 or a full acknowledgment count. Stop at the first
unexpected result and preserve Pico logs. Rewind can be checked separately
using Up then Left on the Rewind button.

The focused local checks are:

```sh
node --test tests/video-lab-player-*.test.js tests/video-lab-media-worker.test.js
python3 -B tests/pico-cloud-controller-test.py
python3 -B tests/pico-seek-batch-experiment-test.py
```

These tests mock the TV and cannot validate YapGrid movement or physical
remote routing. The 30-second focus watchdog may cancel a slow 60-input run;
the measured isolated ~15-second run is the current basis for this bound.

