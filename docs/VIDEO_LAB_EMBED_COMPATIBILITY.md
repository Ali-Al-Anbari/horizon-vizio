# Video Lab · Embed Compatibility Experiment (Concluded)

**Status:** concluded on 2026-10-25 from physical Vizio observations reported by the owner.
**Scope:** isolated Horizon Video Lab preview only (`wrangler.video-lab-preview.jsonc`, assets `./video-lab`). Main Horizon (`./frontend`) has never referenced the embed pages or any embed provider.
**Decision:** VidLove is **not compatible** with Horizon's iframe security policy. No permissions will be loosened to make it play. The pages stay in the isolated preview only so the results can be reproduced.

## Compatibility matrix

Every row used the same iframe markup: `allow="autoplay; fullscreen"`, `referrerpolicy="no-referrer"`, `tabindex="-1"`, `pointer-events: none`. Popups, modals, forms, downloads, and top-level navigation are not permitted in any row.

| Page | Mode | Source | `sandbox` | Physical Vizio result (owner-confirmed) |
| --- | --- | --- | --- | --- |
| `embed-lab.html` | Fixture A | `embed-fixture.html?view=a` (same preview origin, opaque because no `allow-same-origin`) | `allow-scripts allow-presentation` | **Rendered** |
| `embed-lab.html` | Fixture B | `embed-fixture.html?view=b` (re-navigates the same frame) | `allow-scripts allow-presentation` | **Rendered** (label/color changed) |
| `embed-matrix.html` | VidLove · strict | `https://player.vidlove.cc/embed/tv/2190/13/2` | `allow-scripts allow-presentation` | **Blank** |
| `embed-matrix.html` | VidLove · same-origin | same URL | `allow-scripts allow-same-origin allow-presentation` | **Provider error page**: "This site broke the player" and a statement that the embedding configuration disables part of its functionality. A **small ad or overlay** also appeared inside the frame. |
| `embed-matrix.html` | YouTube official sample · strict | `https://www.youtube.com/embed/M7lc1UVf-VE` | `allow-scripts allow-presentation` | **Black** |

Also confirmed on the same TV, outside this experiment: direct MP4 playback, the Cloudflare Flower relay, the 25-minute diagnostic playback, and CSS (viewport) fullscreen all work.

### What the results show, and what they don't

- **Fixtures A and B rendering** shows that the Vizio browser renders sandboxed iframes and handles parent-directed re-navigation of the same frame. So the provider failures are not caused by the TV failing to draw an iframe.
- **VidLove same-origin**: the provider itself detects the restricted embedding and refuses to play. The frame could not open popups or navigate the top window, which is exactly what we intend to keep blocking. *Inference (not proven):* the player needs capabilities we deliberately withhold, such as popups or top navigation, which ad-funded players often depend on. The ad or overlay was drawn **inside** the sandboxed frame. The sandbox does not stop a frame from drawing its own content, but nested frames inherit the same sandbox flags, so they can't open popups or navigate Horizon either.
- **VidLove strict, blank**: without `allow-same-origin`, the frame runs in an opaque origin with no cookies or storage. *Inference:* the player script fails earlier than in the same-origin mode. The parent page can't read the frame's errors across origins, so the exact cause can't be known.
- **YouTube strict, black**: *Inference:* the YouTube embed player needs its own origin and storage. Under our strict sandbox it doesn't work. This says nothing about YouTube's native Vizio app, which remains the authorized YouTube path.
- A parent `load` event never proved that anything rendered. All outcomes above are manual TV observations.
- Rights to the candidate episode were never established. That alone rules out pursuing this provider.

## The 30-second automatic unload

**Why the frame disappears:** both embed pages start a 30-second safety timer when a frame is **requested** (when OK is pressed). The timer is unconditional: it fires whether or not the frame rendered, whether or not you recorded an observation, and without any remote key. It is only cancelled by Stop, Back, leaving the page, or `pagehide`. So a frame that rendered vanishes about 30 seconds after OK, and the status shows "Frame auto-unloaded after 30 seconds". The signal trail ends with `30-second safety unload → unloaded`. That explains the disappearing frame and is not a fault.

**How unload releases resources (hardened in this change):**

- *Before:* unload set `frame.src = "about:blank"`. That unloads the third-party document, but it is itself a navigation. It adds a session-history entry for the frame, so a platform-level history Back could navigate the frame back to the provider with no safety timer running.
- *Now:* unload, auto-unload, `pagehide`, and any switch to or from the third-party candidate **remove the iframe element** and put in a never-navigated clone of the same markup (same `sandbox`, `allow`, `referrerpolicy`, `tabindex`, `title`, no `src`). Removing the element destroys its whole browsing context: the document, media decoders, network requests, timers, and nested ad frames. It also drops the frame's history entries. The clone's first navigation replaces its initial `about:blank` entry instead of adding a new one. Late events from a discarded frame are ignored.
- All timers (12 s no-load, 7 s observation, 30 s safety, focus-guard check) are cleared on every unload path.
- Fixture A → B still re-navigates the same frame, exactly as verified on the TV.

## Security guarantees for embedded content

| Risk | Mechanism | Test coverage |
| --- | --- | --- |
| Opening popups or new windows | No `allow-popups` or `allow-popups-to-escape-sandbox` in any mode; also no `allow-modals` | Exact per-mode token check against a forbidden list |
| Navigating Horizon or the lab page | No `allow-top-navigation*` tokens. The lab runs on a separate origin from Horizon; only the parent's own "Back to Horizon" control goes there | Same as above, plus isolation test |
| Same-origin escape | `allow-same-origin` is used only with the cross-origin VidLove URL. The matrix CSP has no `'self'` in `frame-src`, and the fixture lab never sets `allow-same-origin` | Existing CSP tests plus pairing assertion |
| Trapping remote input | `tabindex="-1"`, `pointer-events: none`, no `frame.focus()`. Refocus when the iframe fires `focus`. **New:** a window-`blur` check returns focus to the parent controls if the iframe became the active element. Back unloads first. The 30 s unload needs no key. TV Home is the last resort | Focus, blur, and safety-timer tests |
| Frame outliving its trial | Element discard on every unload path; history entries dropped | `assertDiscarded` checks (detached, fresh clone, no `src`, no navigations) |

`allow="autoplay; fullscreen"` is kept as tested so the matrix stays reproducible. A frame can only enter fullscreen after a user interaction inside the frame, and that can't happen here (no pointer events, no focus).

## Isolation from main Horizon

- Only `wrangler.video-lab-preview.jsonc` serves `./video-lab`. All other Wrangler configs serve `./frontend` or `./access-probe`.
- No file under `frontend/` mentions VidLove, `embed-lab`, `embed-matrix`, or `video-lab`.
- The main Video Lab page (`video-lab/index.html`) has `frame-src 'none'`. Only the two embed pages can create frames, and each allows only its fixed origins.
- The media worker has no VidLove or YouTube references.
- All of the above is enforced by the test "failed embed provider stays isolated from the main Horizon interface".

## Recommended next physical stress test

**Sintel (Blender Foundation, full film), Internet Archive original upload**
`https://archive.org/download/Sintel/sintel-2048-stereo.mp4`

| Property | Value (from archive.org metadata and response headers; file not downloaded) |
| --- | --- |
| License | CC BY 3.0 (credit: © Blender Foundation · durian.blender.org, already shown in Video Lab) |
| Duration | 888 s (14 min 48 s), full film |
| Frame | 2048 × 872 |
| Size | 282,690,045 bytes → about **2.55 Mbit/s** average, roughly 4× the Sintel trailer (about 0.67 Mbit/s) and roughly 30× the 25-minute diagnostic clip (about 0.08 Mbit/s) |
| Delivery | `Content-Type: video/mp4`, `Accept-Ranges: bytes`, `Access-Control-Allow-Origin: *`; `archive.org/download/...` returns **302** to a storage host (e.g. `dn720709.ca.archive.org`), and that host can change |

Why this one: it is the same content family that already plays on the TV (trailer, faststart, and Baseline variants), so a failure isolates **bitrate, duration, and resolution** rather than a new content type. It is the authorized full-length MP4 we found that plays directly. Blender's own server only offers zipped MOV or MKV files, and the common Google sample-bucket MP4s now return 403.

Before using it (not done in this change):

1. **Direct playback** needs Video Lab's `media-src` to allow `https://archive.org https://*.archive.org`, because CSP also checks redirect targets.
2. The **Cloudflare relay** would reject it as it stands: the relay uses `redirect: "manual"` and a fixed allowlist, so relaying it needs a reviewed change to follow one redirect to an allowlisted archive host.
3. The H.264 profile/level and `moov` position were **not probed**. 2048 px wide is above 1080p width but fits H.264 level 4.x limits; the TV may scale it or reject it, and that is part of what the test measures. Range support means a trailing `moov` still works, just with a slower start.

## Manual verification steps (owner performs; nothing here was run on the TV)

Use the isolated Video Lab preview only, published or run locally by you (`wrangler dev --config wrangler.video-lab-preview.jsonc`). Do not use production Horizon.

1. **MP4 regression (files unchanged; spot check):** Video Lab → *Flower · Cloudflare relay* plays; *25-minute test* → *Next checkpoint* seeks; *Fullscreen* fills the screen, and Back exits fullscreen and then returns to Horizon.
2. **Fixtures still render:** Video Lab → *Experimental embed test* → *Load fixture A*: fixture A fills the stage. *Load fixture B*: the label changes to "Fixture B" with the new color. *Stop and unload*: the placeholder returns and focus is on *Stop*.
3. **Auto-unload explanation:** *Load fixture A* and press nothing. At about 30 s the frame disappears, the status reads "Frame auto-unloaded after 30 seconds", and the signals end with `30-second safety unload → unloaded`. Arrow keys still move focus.
4. **No history trap:** *Load candidate embed* → *Stop and unload* → press **Back once**. You should land on the Video Lab index, and VidLove must not reappear. Back again returns to Horizon.
5. **Matrix reproduction (optional):** *Candidate sandbox matrix* → *VidLove · same-origin*. Expect the same provider error page and overlay. Confirm that no new window or tab opens, the page doesn't navigate away, arrow keys keep moving focus between parent buttons, and Back unloads the frame (picture and any audio stop at once). Repeat load/Back 5 times and watch for slowdown.
6. **Focus guard:** in any loaded mode, arrows and OK must always act on the parent buttons. If the remote ever stops responding, wait 30 s for auto-unload; if it still doesn't respond, press TV Home and report it.
7. **Stress test (next session, after the CSP change above):** play the recommended Sintel MP4 from start to finish without seeking, then repeat with seeks every 3 minutes. Record startup time, any stalls (with timestamps), whether the picture is scaled, and audio/video sync near the end.

## Remaining limitations

- The element-discard unload and the blur focus guard are covered by unit tests with a fake DOM only. **Not yet verified on the physical Vizio.** Steps 2–6 cover them.
- The page can't measure memory, decoder release, or network teardown on the TV. Resource release relies on standard browser behavior when an iframe is removed, plus the observations in step 5.
- The VidLove and YouTube results are owner observations. Their causes above are inferences, because cross-origin frames can't report errors to the parent page.
- VidLove modes stay loadable inside the isolated preview so the results can be reproduced. Delete `embed-matrix.*` and the candidate button if you want the provider removed entirely.
