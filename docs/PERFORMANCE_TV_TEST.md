# Horizon Vizio performance comparison

This source change is local only. Use an approved isolated preview origin or LAN
server before navigating the TV; do not point the production Conjure launch at
these query variants until an explicit deployment decision. Opening a variant
on the TV changes its screen and requires separate approval.

## Profiles

Open these paths on the **same** preview origin, through Conjure app 17:

| Path | Purpose |
| --- | --- |
| `/index.html?perf=optimized&diagnostics=1` | Optimized focus transition and less duplicate focus work |
| `/index.html?perf=baseline&diagnostics=1` | Original focus rendering and behavior, with measurements |
| `/index.html?perf=minimal&diagnostics=1` | Same navigation grid; solid background, text cards, no wallpaper or tile-icon loads |
| `/horizon-minimal.html?diagnostics=1` | Existing bare remote-input page; useful as an input-runtime control |

An ordinary `/` or `/index.html` uses the optimized profile with diagnostics off.
Omit `&diagnostics=1` for a final subjective comparison without the overlay.
Reload each variant before measuring it. The diagnostic overlay summarizes its
last 120 key and frame samples once per second; it does not send data anywhere.

## Repeatable remote test

1. Use the same TV, resolution, remote, distance, and network. Wait for the
   page and wallpaper to settle after each navigation.
2. From YouTube, press Right twice and Left twice as separate taps. Repeat ten
   times. Then press Left twice quickly and observe whether each card appears.
   Record the overlay's `quick arrow pairs`, `multiple keys before frame`,
   `handler p95`, `focus→frame p95`, `next frame p95`, and `frame gap p95` values. A frame callback
   is only a scheduling proxy; it does not prove that pixels were displayed.
3. Make 30 horizontal and 30 vertical deliberate moves, including crossing
   between tile rows. Check `unexpected focus count` and `native focus scrolls`.
   Hold an arrow briefly to check repeat handling; do not infer dropped input
   solely from the number of cards traversed during a held key.
4. Repeat with the slideshow on and paused. Note whether a freeze coincides
   with an image load or wallpaper change. The minimal profile intentionally
   does not load those assets.
5. Test Up to Settings, Back to the same tile, the pairing panel if available,
   and rapid OK on one tile. Do not press a supported app tile unless a live
   app-launch test has been separately approved.
6. A high-frame-rate phone video that shows both the remote button and TV can
   estimate physical press-to-visible focus. Browser timing alone cannot.

Interpretation: two key events counted before one frame suggests rendering or
frame scheduling delayed visible updates. Two key events arriving late together
with short handler and frame times points toward input delivery before JavaScript.
Long handlers point toward JavaScript or browser focus/scroll work. Compare
baseline, optimized, and minimal on the TV before keeping an optimized style.

## Pico stage timing

The Pico source adds independent wake deadlines for power and cloud polling,
but retains the configured intervals. `PERF_TIMING = False` is the default.
After supervised installation, setting it to `True` in private device-local
`config.py` prints stage names and elapsed milliseconds only when a command is
claimed. It does not print credentials, command identifiers, or private URLs.
Measure queue wait using Cloudflare's `queuedAt` and `claimedAt`; compare it with
Pico claim, TV power, prelaunch app, PUT acceptance, confirmation, and result
durations. Capture first **visible** native-app response separately on video.
Do not subtract clocks belonging to different devices without synchronization.
