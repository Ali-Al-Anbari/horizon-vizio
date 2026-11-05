# Horizon Watch UI Investigation Handoff

**Repository:** `/Users/alialanbari/vizio-home-prototype`  
**Date:** 2026-11-05  
**Scope:** Watch homepage visual defects, homepage percentage copy, browser verification status, history provenance, navigation and Settings diagnosis. This handoff records findings and planned repairs; no application code was changed.

## Current project state

- The Watch homepage has a focus-driven hero, Continue Watching landscape cards, Recently Finished poster cards, a four-button left rail (Watch Home, Search, History, Settings), and a shared vertical scroll surface.
- The latest accessible physical screenshot is `curr.jpg` (4032×3024 photo). The user identified `curr.png` as the intended screenshot, but `curr.png` and `IMG_9783.jpeg` were not found in the workspace. Confirm whether `curr.jpg` is the same capture before using it as final acceptance evidence.
- The approved reference is `Horizon Watch Home Screen.png` (1672×941). It shows a fictional title and fictional history; artwork and number of populated cards are not data requirements.
- No application files were modified during the diagnostic or Playwright access check. No deployment, upload, or Git operation occurred.
- Browser rendering is currently unverified. Playwright MCP tools are not connected. Local Playwright packages are absent. A single headless Chrome screenshot attempt exited with status 134 and produced no image. The prior local-server attempt was rejected by sandbox approval policy; do not repeat the same blocked command without a newly authorized preview method.

## Reference versus physical Vizio

The reference has a narrow inset navigation rail blended into full-bleed artwork; a large cinematic hero; title and compact metadata near the upper-left; a soft fade behind landscape Continue cards; and a poster-format Recently Finished row. The Vizio photo shows an edge-attached dark rail, a bounded hero with a hard lower transition into a blue-gray region, visible percentage text in card captions, two Continue cards, an empty Recently Finished state, and a strong focus glow.

The difference in card count is consistent with available real data and should not be “fixed” with fabricated titles. The structural rail, backdrop, and percentage differences are code defects independent of content.

| Finding | Evidence label | Source / explanation |
| --- | --- | --- |
| Left rail is a reserved black column rather than floating over the art | Confirmed from screenshot and code | `.shell` uses a dedicated 78–106px grid column and paints it black (`universal-search/search.css:23–28`, `712`). The hero is in the adjacent content column. The inset gradient is only a pseudo-element inside the rail (`718–721`), so it cannot reveal artwork behind the rail. |
| Backdrop ends at the hero, with a distinct lower surface | Confirmed from screenshot and code | `.watch-hero` has fixed/clamped height and `overflow:hidden`; the image is sized inside that box (`737–743`). `.watch-home` paints a separate background (`735–736`), while rows overlap with negative margin (`754–756`). This produces a transition between separate surfaces instead of one continuous backdrop/fade. |
| Hero artwork changes immediately, not by crossfade | Confirmed from code | `paintHomeHero` calls `art.replaceChildren()` and appends a new image (`universal-search/search.js:253–265`). `showHomeHero` updates synchronously, then paints metadata when its asynchronous fetch resolves (`282–287`). No two-layer image transition exists. Rapid changes use a token to reject stale metadata results, but there is no equivalent image-preload/crossfade layer. |
| Percentage text remains on homepage cards | Confirmed from code | `homeContext` formats `Math.round(fraction * 100) + "% watched"` (`search.js:240–245`), then `paintHomepage` inserts it in the card caption (`306–326`). The hero metadata does not use this formatter. |
| Dark shows “0% watched” while in Continue | Confirmed from screenshot; exact stored position unavailable | Progress records require position > 0 and duration > 0 (`universal-search/core.js:21–29`), so a positive position smaller than half a percent can round to `0%`. Continue candidates require a progress record (`191–194`). Visiting or launching a title alone should not satisfy this filter. Inspect the Vizio’s record before concluding whether Dark has a tiny positive position or whether deployed code/data differs. |
| Card/row density differs | Confirmed from screenshot; partly data-dependent | The reference’s four Continue cards and six finished posters are fictional example content. The Vizio screenshot has two eligible Continue entries and no finished entry. `paintHomepage` shows a “No finished titles yet” message when there are continuing rows but no finished rows (`search.js:345–354`), leaving substantial empty space. Do not fabricate data to fill it. |
| Focus glow is stronger than the reference | Confirmed from screenshot and code | Homepage cards use a 3px white outline with offset and strong shadow (`search.css:775–776`). The photo shows this strong aura. Reducing it requires rendered comparison so it remains visible on the TV. |

Typography/content also differs: the physical screenshot shows a detailed synopsis and title/episode metadata, while the reference uses concise hero metadata and no card percentage copy. The angled photo prevents precise pixel measurements of the physical display; use a straight-on capture for geometry checks.

## Image-to-code / Impeccable process evidence

Accessible execution records for the preceding homepage pass show:

- Impeccable’s `context --target universal-search/index.html` ran and reported an incumbent implementation but no `PRODUCT.md`, `DESIGN.md`, or surface brief.
- The Impeccable skill and craft-floor reference were read. No Impeccable `critique`, `audit`, or `polish` command is recorded.
- The reference and Vizio photos were inspected. Some rough geometry was discussed, but no revised browser screenshot was captured and compared with the reference.
- The previous work was treated as complete after automated checks despite visual verification being blocked. The earlier `design-qa.md` in this repository is from an unrelated Horizon Home interface, dated 2026-10-22; it is not evidence for Watch homepage fidelity.

Therefore the previous visual approval claim was not supported by a rendered comparison of the changed Watch UI. Unit tests do not validate CSS compositing, actual viewport geometry, image crop, or SmartCast rendering.

## Navigation diagnosis

### Watch Home → Search

`move()` contains an explicit rail array and clamps Up/Down through Watch Home → Search → History → Settings (`universal-search/search.js:954–962`). `keyName()` maps standard Arrow keys and legacy key codes (`1092–1101`), and a single document `keydown` listener calls `onKey` (`1165`). The branch is correct if actual DOM focus is on the rail button and the remote produces one of the handled key values.

The code does not prove the physical failure’s root cause. Homepage card focus and rail “current section” styling are separate: clicking/OK on Watch Home calls `showWatch(true)`, while startup/return may restore focus to a saved homepage card (`focusHomeTarget`, `search.js:225–238`). In the screenshot, a card is focused while the Watch Home icon can still indicate the current section. The Home→Search failure could therefore be a focus-target mismatch, remote key mapping, event timing, or deployed script difference. Capture `event.key`, key code, `document.activeElement`, view name, and selected target on the Vizio before changing this path. Desktop unit tests cannot establish Vizio remote behavior.

### Settings scrolling and focus

Settings renders multiple inline controls for each record, not one title row plus an Edit action (`search.js:487–531`). Its directional handler walks a flat button list one button at a time; Left returns to the rail, and after edits/deletion rendering sends focus to the Settings rail (`963–972`, `499`, `517`, `524`). This is a confirmed structural explanation for cumbersome navigation and loss of place.

`.settings-view` has `overflow-y:auto` (`search.css:783`), but the fixed viewport-height rule is applied under `body.watch-active` (`109`), while entering Settings removes that class (`search.js:75–85`). This can let the settings content grow instead of making the intended inner region scroll. The exact SmartCast scroll behavior is a runtime hypothesis until element dimensions and scroll offsets are inspected in a rendered TV/browser session.

## History and recoverability

- Watch history storage key: `horizon-universal-search-history-v1` (`universal-search/core.js:5`). Watch history is device-local to the Watch origin and accepts schema versions 1 and 2 (`53–65`).
- Video Lab progress key: `horizon-video-lab-progress-v1` (`video-lab/player-overlay.js:118`). It belongs to a different origin; Watch cannot read that localStorage directly.
- Horizon Home uses `horizon.watch.home.v1` (`frontend/horizon.js:155–180`). Home passes a limited metadata snapshot in a `#watch-import=` fragment when launching Watch (`frontend/horizon.js:130–138`, `184–207`). Watch imports only when that fragment exists (`search.js:1172–1175`). The current handoff has no verified playback position/completion fields.
- `importHomeSnapshot` accepts v2/v3 snapshots with at most six items, validates identities, backs up existing Watch history before first import, skips duplicates and honors deletion tombstones (`core.js:103–117`). It does not import Video Lab’s cross-origin storage.
- Homepage Continue requires a validated progress record and excludes completed rows (`core.js:188–199`). Recently Finished requires `progress.completed` or explicit `manualWatched === true`. A Home metadata-only row without progress/completion will not populate either homepage category.

No actual Vizio storage export was available in this investigation. No Cyberpunk or movie record can be claimed recovered. They might be in Watch’s own history, accessible Home snapshot metadata, a different origin, a legacy key, or absent. Safe recovery requires user-authorized read-only exports from the relevant browser origins and record-by-record comparison. Do not infer completion from a title launch or manufacture viewing events.

## Deployment and cache status

- `wrangler.universal-search-preview.jsonc` points the Watch Worker at `./universal-search` assets. `index.html` uses unversioned `search.css`, `core.js`, `player-adapter.js`, `mock-data.js`, and `search.js` paths (`universal-search/index.html:9–13`).
- A read-only HEAD request to the preview CSS returned HTTP 200, `cf-cache-status: HIT`, `cache-control: public, max-age=0, must-revalidate`, and an ETag. A later request reported a byte count matching the local CSS length (31,217 bytes).
- Subsequent DNS lookups failed, so response bodies and local/remote hashes could not be compared consistently. The active deployed Worker version and the Vizio’s cached asset bytes remain unknown. `cf-cache-status: HIT` alone does not prove stale data; the cache policy requests revalidation.
- Settings appearing in the Vizio image suggests at least some recent UI reached the device, but does not establish CSS/JS parity. This is an inference only.
- No deployment, cache purge, or Cloudflare configuration change was attempted.

## Planned repairs (not implemented)

1. **Establish a real browser preview.** Connect Playwright MCP or provide an authorized preview browser and a URL for the uncommitted local Watch page. Capture the deployed baseline and local changed version at 1920×1080 and 1440×900. Confirm the page actually rendered, verify console/network, and keep screenshots as evidence. If tools are unavailable, stop visual edits until a working path is provided.
2. **Repair rail structure.** Let the page artwork/gradient extend behind the rail; remove the independent black painted column. Keep rail controls and D-pad wiring unchanged. Validate actual insets, transparency, focus ring and rail bounds against the reference screenshot.
3. **Repair continuous hero composition.** Extend the artwork/gradient through the transition area, remove the separate blue-gray visual seam, preserve readable text and natural scrolling. Compare the hero height, title position, crop and row start to Option C at both sizes.
4. **Add two-layer image crossfade.** Preload the new image, keep the old image visible until ready, fade between layers with a modest opacity transition, reject stale loads for quickly changing focus, and honor `prefers-reduced-motion`. Verify rapid focus sequences with screenshots/video and confirm no blank flash.
5. **Remove homepage percentage copy.** Keep progress bars and stored values intact; use episode identity/title metadata without percentages. Do not alter completion filters or Resume routing.
6. **Run navigation and data regression checks.** Confirm card focus, Left/Right row movement, rail Up/Down, OK/Back and focus restoration. Inspect Dark’s exact validated progress record before explaining its rounded 0%. Do not modify history migrations or Settings in this focused repair pass.
7. **Compare and iterate.** After local implementation, capture changed screenshots and list the three largest remaining differences. Correct them before declaring visual progress. Then validate with a straight-on physical Vizio capture for SmartCast-specific compositing and remote input.

## Verification matrix

- **Unit tests:** formatter output, progress classification, stale-image token logic, D-pad mapping logic, routing/data invariants.
- **Rendered browser:** actual grid geometry, transparency, gradients, stacking, hero crop, crossfade, overflow and focus visibility at both target viewports.
- **Physical Vizio:** SmartCast rendering differences, remote event mapping, safe-area placement, cached assets and visual result on the deployed version.

A passed unit suite is not visual approval. Do not call the repair complete until the changed local page has a rendered screenshot comparison; do not claim SmartCast behavior until the user tests the Vizio.
