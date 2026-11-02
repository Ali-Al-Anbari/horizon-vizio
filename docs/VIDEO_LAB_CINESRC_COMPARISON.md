# Video Lab CineSrc experiment

This experiment changes only the isolated Video Lab player. YapGrid remains the default. The `Provider: YapGrid` button is reachable from the movie controls with Down twice and from the TV controls with Down three times; press OK to switch. Switching reloads the same TMDB movie or episode in the chosen provider and may lose playback position. No automatic provider fallback or History write occurs here.

Owner's physical test: the same CineSrc movie plays in Mac Chrome, but its Vizio iframe cycles through servers without video; YapGrid plays on the Vizio. The cause inside CineSrc's cross-origin player is not yet known.

The Vizio diagnostic probe reports MediaSource and tested MP4/TS AVC/AAC support, probable HTML5 H.264/AAC, no native HLS, and iframe autoplay permission. It received no CineSrc `postMessage` events or source IDs during 25+ seconds without video. These probes narrow the question but do not establish the actual stream codec, decoder result, or provider network error.

The CineSrc embed URLs and postMessage shapes follow [CineSrc's documentation](https://cinesrc.st/docs). Its documentation describes embedding but does not establish rights to every title it may display. Use content you are authorized to access. This implementation does not inspect or relay media segments, bypass access controls, or assume the advertised player events work on the TV.

## Controlled comparison

For each authorized title, test the same TMDB ID and, for TV, the same season and episode in both providers. Use at least two movies, two episodes from different shows, and one anime episode with an authorized English dub if available. Alternate provider order between titles. Record the requested ID and the title/episode actually shown before judging startup or accuracy.

| Metric | YapGrid | CineSrc | How to record |
| --- | --- | --- | --- |
| First real picture and audio | Works on owner's Vizio; timing unmeasured | No start on owner's Vizio; works in Mac Chrome | Seconds from switching until moving video **and** audible program sound; iframe load and `ready` do not count. |
| Buffering | Unverified | Unverified | Stall count, total stalled seconds, and whether playback recovers within two minutes. |
| Episode accuracy | Unverified | Unverified | Compare the requested season/episode with the on-screen episode. |
| Audio | Unverified | Unverified | English availability, selected track, and whether a change sticks after reload. |
| Subtitles | Unverified | Unverified | Availability, default, selection, and persistence after reload. |
| Seeking | Unverified | Unverified | Test short and long forward/backward inputs; note actual response and position. |
| Remote / Back | Unverified | Unverified | Test pause, play, D-pad, Pico bridge recovery, provider switch, and return to Watch. |
| Errors / stops | Unverified | Unverified | Time, visible error, source change, and whether the same provider recovers. |
| Quality / compatibility | Unverified | Unverified | Actual picture quality, audio/video sync, codec errors, and fullscreen behavior on Vizio. |
| Events / commands | Unverified | Unverified | Compare CineSrc-reported ready, play, time, duration, end, episode, source, and errors to the picture. |
| Security / redirects | Unverified | Unverified | Record unexpected ads, domains, permissions, navigation, and popups without following them. |

The documented `cinesrc:ready` event means player readiness, not decoded video. The overlay displays CineSrc time reports for inspection only and does not save a resume point. Pico KEYLIST remains the normal playback command path. The compatibility panel sends a single documented CineSrc `play` command only when the user explicitly selects **Send play**; no uncertain command is replayed. CineSrc internal episode changes are reported but do not change Horizon's selected episode or History.

## Temporary Vizio diagnostics

On a movie, press Down three times from hidden controls, then OK on **Diagnostics**. On TV, press Down four times, then OK. Back closes the panel, the next Back hides controls, and the next Back returns from the player. The panel records only local browser capability probes, iframe permission attributes, and validated CineSrc message types with the last eight sanitized server IDs and an attempt count. It does not inspect media requests or iframe DOM and does not send diagnostics anywhere.

Run the same authorized movie on Vizio and Mac Chrome. Record the user agent, MSE fMP4 AVC/AAC, native HLS, HTML5 MP4 AVC/AAC, iframe permissions, **iframe load/error**, **provider ready/play/sourceused/error**, ignored direct-frame origin/envelope counts, source order, and elapsed time at 10, 30, and 60 seconds. Photograph the Vizio panel if convenient. A positive capability probe means *likely* support, not successful decoding; a frame `load`, provider `ready`, or provider `play` is also not proof of moving picture and audio. If the provider emits no source or error messages, its internal server loop remains invisible to Horizon.

The listener uses the documented `event.data.type` envelope and exact `https://cinesrc.st` origin and also requires the active iframe as `event.source`. A nonzero ignored-origin count suggests a direct-frame message arrived from another origin; a nonzero ignored-envelope count suggests the direct frame sent a message that did not match the accepted CineSrc event shapes. Neither count accepts or records the message body or origin value.

### One-variable CineSrc compatibility matrix

All rows use the same authorized TMDB movie ID. Start each row with **Reset default**. From the panel's Close button, Down focuses **Quality 480**; Left/Right moves through **Autoplay off**, **Send play**, and **Reset default**. OK activates the focused choice. Wait for the iframe load report before **Send play**. Record actual moving video and sound separately from player events.

| Test | Embed change | Action | A successful result would suggest |
| --- | --- | --- | --- |
| Baseline | None; original CineSrc URL | Wait 30–60 seconds | Confirms whether the original failure is reproducible. |
| Baseline + manual play | None | Press **Send play** once after iframe load | A manual start path may work; it does not prove why autoplay failed. |
| Quality 480 | `quality=480` only | Wait 30–60 seconds | A lower quality/source variant may be compatible; it does not identify the exact codec or failure. |
| Autoplay off + manual play | `autoplay=false` only | Press **Send play** once after iframe load | Autoplay or player startup timing may be involved, especially if baseline + manual play fails. |
| Reset | Removes the test parameter | Wait again | Confirms whether any improvement repeats only with the selected setting. |

Do not combine `quality=480` and `autoplay=false` in this first pass. CineSrc documents `quality` examples `1080`, `720`, and `480`, `autoplay=false`, and the `play` postMessage command; it does not promise that every title or server has a 480p source. If every variant cycles servers, the iframe alone still cannot distinguish provider network failures, stream codec/profile differences, and TV decoder behavior.

## Compatibility and promotion gate

Desktop Chrome playback cannot prove support on the physical Vizio. Check on the television whether the CineSrc iframe loads, decodes video/audio, accepts focus and D-pad commands, enters fullscreen, survives idle periods, and returns with Back. Its use of Media Source Extensions, codecs, and any third-party redirects is not established by the embed documentation. Do not promote CineSrc until authorized-content tests show the correct media, stable playback, usable controls, and better results than YapGrid. Keep explicit manual switching and rollback to YapGrid; do not auto-switch on slow startup or unknown command outcomes.

The provider adapter exposes `PRIMARY` and `FALLBACK` plus URL, event-validation, and command helpers. A later controlled change can set CineSrc as primary only after Vizio evidence, while retaining YapGrid as the alternate. History remains keyed by media identity in Watch, independent of provider, so a provider switch must not create another entry.

## Manual Video Lab-only version preparation

From the repository root, after local review:

```sh
npx wrangler versions upload --strict --config wrangler.video-lab-preview.jsonc --message "Video Lab CineSrc comparison"
npx wrangler versions view '<NEW_VERSION_ID>' --config wrangler.video-lab-preview.jsonc --json
```

Confirm the inactive version is for `horizon-video-lab-preview`, includes the current `./video-lab` assets and fetch handler, retains `ASSETS`, `LAUNCH_QUEUE`, `PLAYER_BRIDGE`, `PAIRING_ONLY`, and the four existing encrypted binding names `TEAM_DOMAIN`, `ACCESS_AUD`, `OWNER_EMAIL`, `PLAYER_BRIDGE_TOKEN`, and keeps migration tag `v1`. Verify the current active Video Lab version before any activation. Uploading a version does not change live traffic; activation requires a separate explicit decision. Do not use a Home Worker configuration.
