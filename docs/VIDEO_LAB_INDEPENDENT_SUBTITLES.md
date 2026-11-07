# Video Lab independent VidBolt subtitles

Horizon renders optional English captions above the full-size VidBolt iframe. They use only accepted `vidbolt:timeupdate` events from the current iframe. Captions start Off for a fresh playback session. The explicit choice and ±10-second timing adjustment transfer across same-origin episode navigation and a short return through the Watch episode list; a fresh Watch launch starts Off.

## Retrieval and configuration

`GET /api/subtitles?type=tv&tmdb_id=2190&season=15&episode=7` is a Video Lab Worker route. It requires the Video Lab preview's paired-session cookie before accessing SubDL. Horizon Home pairing is separate: its host-only cookie and Durable Object pairing record cannot authenticate Video Lab, even when Watch opens the Video Lab player normally. VidBolt playback itself does not prove Video Lab pairing. If the subtitle menu reports missing authorization, its Connect Video Lab action opens the existing `player-setup.html` flow, then returns to the selected player URL after approval. Valid Video Lab sessions are checked and rotated when due after subtitle lookup, without delaying playback. A session that has already expired or been revoked requires approval through that existing flow again.

Set the `SUBDL_API_KEY` Worker secret manually for live retrieval; it is never sent to the browser. No key is present in this repository. The endpoint returns `subdl_unconfigured` without it.

The Worker searches SubDL API v1 with `tmdb_id`, `type`, English, season/episode, and `unpack=1`. It accepts exact episode entries or episode-specific files exposed inside a season pack. It downloads only from `dl.subdl.com`, with size and time limits, and extracts a matching SRT or WebVTT file from a ZIP when necessary. It rejects mismatched TMDB results and ambiguous multi-file archives. Browser memory caches parsed cues for one hour; the Worker uses a bounded isolate cache and its Cache API when available. Cloudflare Access can make the Cache API unavailable; the isolate and browser caches still work.

SubDL's API quota and terms apply. Confirm that the API plan and subtitle rights cover the intended use before configuring the key. The Worker intentionally does not log the key, subtitle text, or download URL. The synthetic `tests/fixtures/south-park-s15e7-demo.srt` is available only when serving the repository root on loopback; it is outside deployed Video Lab assets.

## Synchronization and limits

The parser accepts SRT and simple WebVTT. A sorted cue array is searched by binary search on each valid timestamp. The caption DOM changes only when the displayed text changes. Pauses and buffering do not advance a separate clock. Captions clear on episode changes, end events, and unreliable timelines. TV timelines shorter than ten minutes and movie timelines shorter than twenty minutes are treated as possible ads and do not show captions; this catches the observed 22-second pre-roll. It cannot identify a longer ad or prove VidBolt's current stream is the requested title because VidBolt's time events carry no content identifier. Out-of-order events from the same live iframe are also indistinguishable from a real seek. The manual offset corrects a constant timing difference, not a mismatched release or frame-rate drift.

External subtitles are inserted with `textContent`, not HTML. Release names are discovery hints only; VidBolt does not expose its stream release identifier, so an exact release match cannot be confirmed.

## Manual deployment

1. Obtain a SubDL API key and confirm its plan and subtitle rights for this use.
2. In the Video Lab Worker environment, set the secret: `npx wrangler secret put SUBDL_API_KEY --config wrangler.video-lab-preview.jsonc`. Enter the key at the prompt; do not put it in a file or command argument.
3. Run `node --test tests/video-lab*.test.js` and `npx wrangler deploy --dry-run --config wrangler.video-lab-preview.jsonc` locally.
4. Deploy Video Lab manually using the existing project process. No Watch or Home deployment is needed for the subtitle feature.
5. On the Vizio, open South Park S15E7 in VidBolt, select Horizon Subtitles → English, seek in both directions, adjust timing, pause, switch episodes, and verify Off on a fresh launch. Confirm caption placement at the TV's native resolution.
