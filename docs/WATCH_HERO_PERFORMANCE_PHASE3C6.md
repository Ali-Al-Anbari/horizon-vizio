# Watch hero performance experiment (Phase 3C.6)

This is a temporary, opt-in Watch diagnostic. The production default remains the
existing 110ms settling delay until physical Vizio testing supports a change.
No mode is written to viewing history, feedback, or localStorage. The chosen mode
lasts until the page reloads; Baseline restores 110ms during the current visit.

## Remote controls

1. On Watch Home, focus the **Settings** circle at the bottom of the left rail.
   From Home on the rail, press Down five times.
2. While Settings is focused, press **Down five more times within 2.2 seconds**.
   The fifth press opens the `WATCH HERO TEST` selector. These Down presses are
   normally no-ops on the last rail control. Use separate presses; held-key
   repeat events do not count.
3. Press Left/Right or Up/Down to choose Baseline, Immediate, 150ms, 250ms,
   300ms, 400ms, 500ms, or Fixed Hero. Press OK to apply. Press Right from the
   rail to return to the remembered poster. The small HUD then records metrics.
4. To change modes, return to the Settings rail circle and press Down five times.
   Press Back to hide the HUD. Back in the selector cancels the choice.

Fixed Hero holds both image and metadata. All other modes update the selected
title only after the configured quiet period and after its image is ready. The
current poster, D-pad focus, Details target, and carousel position update
immediately. Returning from Details keeps the selected mode for that page visit.

## Fair physical-TV comparison

Use the same populated row and input sequence for each mode. Rotate mode order
instead of always starting with Immediate. For each mode:

- Browse 20–30 titles quickly, then pause on the final title.
- Browse five titles slowly, pausing on each. Judge whether hero updates feel late.
- Complete ten forward carousel cycles and watch each last-to-first transition.
- Repeat on a row with different backdrops, then enter and leave the rail.
- Try Discover seed/filter changes and Details/Back.

Record subjective responsiveness and any teleport, blank frame, mismatched
title/artwork, or lost focus. Compare Fixed Hero with Baseline first: if Fixed
Hero is not noticeably smoother, longer debounces are unlikely to solve the
main carousel lag. Reset to Baseline before ordinary use, or reload Watch.

## Interpreting the HUD

The HUD samples at most 128 frame intervals and redraws once per second. It
shows keydown-to-logical-focus, handler duration, keydown-to-next-rAF, image
load/decode attempts, actual artwork swaps, and estimated missed frames from
large rAF gaps. `PerformanceObserver` long tasks and JS heap appear only when
supported. `n/a` or `unsupported` is expected on some SmartCast engines.

These are browser-side estimates. They do **not** measure remote hardware
delivery time, physical screen presentation, decoded texture memory, or true TV
FPS. The HUD itself adds a small amount of work, consistently across modes.

## Implementation boundaries

The carousel, row order, AI recommendations, playback, history, and subtitle
systems are unchanged by this experiment. A new hero request is started only
after the delay expires. A generation token rejects stale load/decode results;
leaving Watch or changing tabs/Discover filters cancels pending work. The old
hero pair stays visible until replacement artwork is ready, then image and text
change in one task. This temporarily uses an atomic hero swap instead of the
old image-only crossfade to avoid pairing a new title with old artwork.
