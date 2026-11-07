# Watch motion diagnostics

These modes are opt-in and affect only the current Watch page load. Normal Watch URLs retain all motion. The modes do not change D-pad targets, row order, focus memory, playback handoff, or stored history.

| Query parameter | Visual change |
| --- | --- |
| `?watch-motion=profile` | No visual change; collect bounded rendering samples. |
| `?watch-motion=glide-off` | Use the existing static poster focus outline instead of the shared moving ring. |
| `?watch-motion=art-off` | Keep the first hero image while titles and metadata continue updating. |
| `?watch-motion=scroll-off` | Move vertically to the selected row immediately. |
| `?watch-motion=all-off` | Combine the three switches and disable decorative Watch transitions. |

On the physical TV, focus the **Watch Home** icon at the top of the floating rail and press **Up five separate times within four seconds**. Held-key repeat does not count. A small diagnostic panel opens without moving focus. Press **Up/Down** to choose a mode, **OK** to apply it immediately, and **Back** to close the panel. To reopen it, repeat the five Up presses. The panel remains hidden during ordinary use and closes when leaving Watch Home. The selected mode remains active for this page load.

The original URL switches remain available. For example, append `?watch-motion=glide-off` to the Watch URL. The local mock preview can combine a mode with `?mock=1&preview-history=multi-ratings`.

When browser developer tools are available, `window.HorizonWatchMotionDiagnostics.snapshot()` returns only bounded numeric samples: input-to-next-animation-frame times, frame intervals, hero image load times, long tasks where supported, artwork request count, and concurrent motion counts. Each sample array holds at most 120 entries. Sampling starts after a D-pad input and stops 650ms after the last input; it makes no network request and stores no viewing data. `longTasks` may stay empty because SmartCast WebKit does not expose that API. Image load time is not a reliable decode or paint time. Chrome metrics are diagnostic and must not be reported as Vizio FPS.

The focused browser regression is `tests/watch-row-gap-motion-e2e.mjs`. Run it against the loopback mock preview and an isolated Chrome CDP port. It checks the actual heading-to-poster gap at 1920×1080 and 1024×768, horizontal vertical-scroll stability, remote activation, and each mode's behavior.
