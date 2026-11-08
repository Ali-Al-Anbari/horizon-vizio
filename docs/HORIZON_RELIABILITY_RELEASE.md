# Horizon reliability and controlled release notes

## Boundaries and current behavior

- Home, Watch, and Video Lab have separate Workers and origins. Home's combined Worker and encrypted bindings require the stricter [Home release procedure](HOME_CLOUDFLARE_RELEASE.md). Never use the assets-only Home config for that release.
- Watch keeps verified history and explicit Like/Dislike feedback separate. Its homepage uses instant circular Left/Right focus, a bounded attached poster window, and a 110 ms hero artwork settling delay. A TV show is Finished only when every numbered episode in its available TMDB catalog has confirmed completion or an explicit watched mark. A completed show's catalog is refreshed after six hours for up to six recent shows per home render; unknown catalogs favor Continue Watching. Specials and future-episode metadata remain potential catalog ambiguities.
- Video Lab uses a validated VidBolt message source, exact episode identity, checkpointed progress, and a manual Next Episode action. English SubDL subtitles are independently rendered, Off at fresh-session start, and require a Video Lab paired session. Home's paired cookie does not authorize Video Lab. `TMDB_TOKEN` and `SUBDL_API_KEY` stay in Worker secret bindings; do not place them in client code or shell command arguments.

## Completion confidence

VidBolt does not report a content identity that distinguishes an episode from advertising. A reported media duration below 60 seconds is therefore **ambiguous**, not classified as an ad. Horizon retains existing partial progress and does not use that timeline's 95% or `ended` event as proof of completion. A later credible timeline can complete normally. This bound protects the observed 22-second case, but longer ads remain indistinguishable. Genuinely shorter titles can retain partial progress; use the existing manual watched action when automatic completion cannot be proven. No exit event is assumed to be available from a cross-origin player.

## Watch performance probe and artwork trial

The performance probe is hidden and inactive by default. On Watch Home, focus the **first rail icon (Watch Home)** and press **Up five times within 2.2 seconds**. Back closes the panel; OK resets its counters. Ordinary navigation keeps working while it is open. The panel contains only counts and timings: input-to-next-`requestAnimationFrame` latency (a pre-paint proxy), recent frame intervals, image load counts, available image-load timing, DOM node count, and optional browser heap size. Missing browser APIs display `n/a` or `unavailable`. It records no titles, history, URLs, or credentials. It creates no sampling loop when closed. Chrome measurements are diagnostic only; physical Vizio measurements must be recorded separately.

`?art-window=1` is an **opt-in experiment**, not the default. It delays initial homepage poster sources until their card enters the existing visible window and requests TMDB `w342` poster files instead of `w500` for homepage poster cards. It retains the 110 ms hero behavior and normal details artwork. On a 1024px Chrome fixture it reduced initially attached cards from 23 to 21, but both modes recorded 22 image resource entries. At 1920px the short fixture rows fit without reduction. There is no proven Vizio speed improvement; compare the two modes on the TV and reject the trial if a card flashes, looks soft, or navigation slows. The trial may be removed without changing persistent data.

## Manual Watch and Video Lab release checks

`maintenance/check-media-release.mjs` makes **no Cloudflare version queries or mutations**. `local` checks the intended Worker name, entrypoint, asset directory, worker-first API route, required secret **names**, and Video Lab pairing bindings. It cannot prove that encrypted bindings exist on a particular Cloudflare version. `smoke` makes two unauthenticated GETs against the URL supplied after manual activation: the entry asset and a safe API error. Watch's `invalid_query` response indirectly confirms its TMDB binding was available for that request. Video Lab's `not_authorized` response confirms pairing protection, but cannot prove a live SubDL binding; that requires a legitimately paired authenticated lookup.

Run before upload:

```sh
node maintenance/check-media-release.mjs local watch
node maintenance/check-media-release.mjs local video-lab
node --test tests/media-release-preflight.test.js
npx wrangler deploy --dry-run --config wrangler.universal-search-preview.jsonc
npx wrangler deploy --dry-run --config wrangler.video-lab-preview.jsonc
```

The owner then uploads each changed Worker as an **inactive version** using its own Wrangler config, records the returned version ID, and manually activates that ID. Do not use the Home assets-only config. After activation, run each smoke check with that Worker's actual HTTPS origin:

```sh
node maintenance/check-media-release.mjs smoke watch https://<watch-worker>.workers.dev
node maintenance/check-media-release.mjs smoke video-lab https://<video-lab-worker>.workers.dev
```

For Video Lab, also verify one subtitle request in an already paired session on the TV or a trusted browser. A 403 means unpaired, a 503 `subdl_unconfigured` means the required secret is absent, and other provider/download errors have separate sanitized codes. Never copy the paired cookie into documentation or test output. Keep the last known good version ID for manual rollback. These checks do not inspect live traffic allocation or modify persistent state.

## Metadata investigation status

Watch uses TMDB season counts and aired-episode data. Video Lab already consults TVmaze for episode navigation when a TVDB identity is available; this does not automatically override Watch's canonical TMDB identity. No specific show with a verified numbering mismatch was established in this work, so no new mapping or TVmaze request was added. Investigate a real mismatched title and its air-order/specials data before changing completion rules.
