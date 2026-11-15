# Video Lab Phase 5A: LookMovie source feasibility

## Conclusion

LookMovie is **not connected** to Horizon. PandaFlix's current Go provider uses
LookMovie website pages and a short-lived `hash`/`expires` pair extracted from a
play page to call the site's internal `movie-access` or `episode-access` route.
No documented third-party playback interface or authorization for Horizon was
found. This is a source-access gate, independent of whether Horizon's existing
HLS player can decode the resulting format. We did not call those routes, copy
session credentials, resolve a stream, or test a LookMovie manifest.

Source reviewed: <https://github.com/MADPANDA3D/pandaflix/blob/master/core/providers/lookmovie.go>
and repository README and GPL-3.0 license. This document describes behavior;
no PandaFlix code was copied.

## Published implementation

- Search queries the site's own movie/show search routes. Results contain
  LookMovie slugs and site-specific IDs, rather than canonical TMDB IDs.
- For a TMDB-based fallback request, PandaFlix asks TMDB for an IMDb ID, then
  matches a LookMovie search result by IMDb-prefixed slug or exact title/year.
  A title/year fallback is not sufficient proof of media identity.
- TV resolution requires season and episode. The Go provider reads season data
  embedded in the play page and maps the requested episode number to a site
  episode ID. Missing seasons or episodes fail explicitly.
- Movie and episode access use separate internal `security/*-access` routes.
  The play-page `hash` and `expires` values are part of those requests. The
  response may contain quality-keyed streams and English subtitle file paths.
- PandaFlix checks that the stream begins with `#EXTM3U`. This establishes
  playlist syntax, not codec, CORS, playback rights, or SmartCast support.
  Its README targets desktop players such as mpv/VLC/IINA, not a TV browser.

The provider's Go HTTP client sends a browser-like User-Agent, Referer, and
XHR header. Horizon does not reproduce those headers or use its Worker as an
authorization-bypassing proxy. We have not established whether LookMovie's
manifests and segments expose CORS to the Video Lab origin. No playback
availability claim can be made for an untested title or episode.

## Existing Horizon adapter boundary

The manually selected Apple Bip Bop HLS control remains the only registered
HLS source. Its `mediaKind: "hls"` registration passes the source URL to the
existing `chooseHls()` path, which reuses the same `<video>`, native/MSE
capability gate, local hls.js build, controls, events, cleanup, and manual retry.
There is no LookMovie entry in the source picker or production provider list.

A future authorized provider would need, before registration:

1. A documented grant or integration agreement covering playback and source
   retrieval, plus a stable interface that does not rely on scraping site
   session credentials.
2. Canonical movie or exact show/season/episode mapping, with a fail-closed
   response for ambiguous identity.
3. HTTPS HLS manifest and segment access with CORS from Horizon's Video Lab
   origin, and compatible H.264/AAC variants confirmed on the physical Vizio.
4. An explicit CSP origin update and a manually selected source registration.
   The current CSP permits the Apple control CDN only; adding an arbitrary URL
   or wildcard is not part of this experiment.
5. A separate decision about progress/history semantics. The isolated HLS lab
   page is not the Watch playback overlay; it currently writes no Watch
   progress. Do not imply production integration from a successful lab test.

## Physical Vizio test after an authorized source exists

First replay the Apple Bip Bop control. Then verify the exact movie and episode
identity, video and audible audio, remote Play/Pause, seek in both directions,
timeline accuracy, subtitle Off default, source switching, manual retry, and
cleanup on exit. Confirm no automatic Next Episode action. A successful desktop
browser run or `canplay` event alone is insufficient.
