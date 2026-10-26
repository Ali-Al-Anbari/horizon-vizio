# Video Lab episode navigation, Up Next, and Quick Pause

This is confined to the isolated Video Lab preview. The Cloudflare/Pico command protocol, SmartCast mapping, and seek batch engine are unchanged.

## Episode routing and availability

YapGrid documents `https://yapgrid.com/embed/tv/{tmdbId}/{season}/{episode}` in its [TV embed guide](https://github.com/enikqi/yapgrid/blob/main/docs/tv-embed.md). The physical baseline verifies South Park TMDB `2190`, Season 13 Episode 2. Season and episode are validated positive integers before any URL is built.

The preview retrieves aired South Park episode metadata from TVmaze show 112 using its [public API](https://www.tvmaze.com/api). The common S13E2 title, “The Coon,” guards against a mismatched show index. Results are cached in memory and, when available, session storage for one hour. No season length is hardcoded. TVmaze metadata is attributed in the player and remains separate from YapGrid availability: **a TVmaze listing does not confirm that YapGrid can play the episode**. YapGrid's [FAQ](https://github.com/enikqi/yapgrid/blob/main/docs/faq.md) says playback availability varies. No documented YapGrid episode availability endpoint was found. An iframe load, HTTP 200, or buffering screen is not an availability signal.

Next looks for `(season, episode + 1)`, then `(season + 1, 1)` when no aired entry is listed for the first candidate. Previous looks for `(season, episode - 1)` when positive, then the last listed episode of the latest earlier season; this can skip seasons absent from metadata. Missing current metadata, HTTP errors, and timeouts all produce **unknown**, never “series ended.” If no later aired entry is listed, the UI says that no later episode is known and that series status is unknown. Future and nonregular entries are excluded.

Manual Previous/Next uses two OK presses: the first resolves metadata and states that YapGrid playability is unknown; the second explicitly tries the listed episode. Changing focus cancels that confirmation. This prevents a catalog entry from silently being treated as a playable stream. The player URL carries `season`, `episode`, and `sub=on|off`, including cross-season transitions. The existing off mode uses `empty.vtt`; the on mode uses `lang=en`. No browser storage or bridge credential is needed for subtitle persistence. The Episode List destination remains a labeled placeholder.

## Remote navigation

Top row: Rewind, Play/Pause, Forward. Lower row: Previous Episode, Subtitles, Episode List, Next Episode. Down from Rewind goes to Previous; Down from Play/Pause goes to Subtitles; Down from Forward goes to Next. Left and Right traverse the lower row. Up returns to a top control. Seek buttons retain their existing Left/Right duration adjustment. Back hides controls or leaves the player according to the existing behavior.

## End-of-episode behavior

YapGrid's [player controls](https://github.com/enikqi/yapgrid/blob/main/docs/player-controls.md) and [embed parameters](https://github.com/enikqi/yapgrid/blob/main/docs/parameters.md) document no ended event, trusted parent `postMessage` contract, or loop-off option. Horizon never reloads the iframe on a playback-end event; it has no such event handler. The observed replay therefore appears to originate inside YapGrid, but that attribution needs provider or physical instrumentation to be conclusive. The cross-origin iframe prevents Horizon from reading the video element. **Automatic end detection remains disabled.** There is no guessed runtime timer, DOM access, or unvalidated message handler.

The existing ten-second Up Next state machine remains available for manual preview tests only. Use `&testEnd=1` at the exact preview origin. From Play/Pause, press Down twice and OK on **Test: episode ended**. It resolves a listed next episode, shows the countdown, and offers Play now or Cancel. Play now or zero navigates once; Cancel or Back goes to the Episode List placeholder. The panel labels YapGrid playability unverified. If metadata is unknown or no later episode is listed, no countdown starts. Enabling automatic triggering later requires a supported end signal, origin and source validation, and physical Vizio verification. A provider loop-off option would also be needed to stop YapGrid from replaying before the prompt.

Manual test URL:

`https://horizon-video-lab-preview.ali-al-anbari.workers.dev/player-overlay.html?season=13&episode=2&sub=off&testEnd=1`

## Quick Pause and startup buffering

One hidden OK makes the control bar visible without the normal 160 ms reveal fade, highlights Play/Pause, then reuses the current open promise or starts the existing secure session. The command waits for readiness, gives iframe focus one browser frame, sends one authenticated `pause_toggle`, and restores Play/Pause focus. The status now records browser-side bar, readiness, bridge reply, and focus times in milliseconds. These are transport timings, not measured time to a paused video frame. Prior physical observations put Pico SmartCast key execution at roughly 110–170 ms and cold session preparation at roughly 350–450 ms; the new stage metrics need physical measurement after preview deployment. Keeping the existing focus turn and closing sessions when controls hide avoids a speculative optimization that could lose a command or extend session lifetime.

The parent page has no supported YapGrid buffering or playback-state event. The reported two-to-three-minute startup stall could be source selection, provider/CDN latency, or TV networking; it cannot be attributed to the Pico from available evidence. No automatic reload loop was added. A manual page reload can retry the same episode and `sub` mode, but loses playback position; it is intentionally not presented as a buffering fix.

## Manual release checks

1. Deploy the isolated preview manually with `npx wrangler deploy --config wrangler.video-lab-preview.jsonc`.
2. Open S13E2, reveal controls, select Next and press OK. Confirm the TVmaze listing and YapGrid-unknown text; press OK again to try S13E3. Verify actual picture, audio, and title. Repeat Previous to S13E2.
3. Test S13E14 Next and S14E1 Previous to check season crossings. Test the current last aired episode: no later aired episode should be claimed. Disconnect network or block metadata access in a local browser test: the status must say unknown, not finished.
4. Repeat with `sub=off`. Check both Horizon URL and YapGrid subtitle behavior.
5. Use the manual test URL above. Check countdown, Play now, Cancel, Back, and no delayed second navigation. Observe a natural episode end separately; no automatic prompt is expected until a supported signal exists.
6. Press OK with hidden controls; the bar should appear at once and focus return to Play/Pause. Record the four Quick Pause stage timings and compare the actual TV pause. Repeat after a recent visible session and after a cold reveal. Check seeking, focus restoration, five-second auto-hide, and Home.

No Pico upload is required.
