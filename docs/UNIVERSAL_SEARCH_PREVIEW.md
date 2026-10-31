# Universal Search preview

The user-facing experience is **Horizon Watch**. The deployed Worker and
source directory retain their existing names.

This is a separate Cloudflare Worker named `horizon-universal-search-preview`.
It does not replace production Horizon or the Video Lab preview. Its static
assets live in `universal-search/`, and `universal-search-worker.js` proxies
only four fixed TMDB operations. The browser never receives the TMDB token.

## Manual setup and deployment

From the repository root, enter the TMDB API Read Access Token at Wrangler's
interactive prompt, then deploy this preview only:

```sh
npx wrangler secret put TMDB_TOKEN --config wrangler.universal-search-preview.jsonc
npx wrangler deploy --config wrangler.universal-search-preview.jsonc
```

Do not put the token in source, a query string, or a shell command argument.
This Worker uses its own name and static asset directory. It does not change
the existing Video Lab Worker, pairing, Access policies, or controller secrets.
The TV must separately be paired with the existing Video Lab preview for its
playback controls to operate after opening a TV episode.

To launch the deployed preview on the TV through the existing authenticated
Conjure launcher, run manually:

```sh
python3 controller/horizon-controller.py launch \
  --tv 192.168.12.196 \
  --auth-file "$HOME/.config/vizio-smartcast/auth-192.168.12.196.json" \
  --url 'https://horizon-universal-search-preview.ali-al-anbari.workers.dev/'
```

Substitute the TV address and private auth-file path if they differ. The
`--url` contains no credentials. These are instructions only; no deployment,
TV command, or Pico upload is performed by the implementation work.

## Data and playback behavior

- Search supports combined movie/TV, Movies, and TV Shows views. The Worker
  limits queries, returns at most 18 titles, times out upstream requests, and
  keeps title/provider/season metadata in response cache headers. Browser
  searches are debounced and stale results are ignored. The Worker's simple
  per-isolate rate bucket is best effort, not a global quota.
- Details show TMDB synopsis/images and US JustWatch provider categories via
  TMDB: subscription, free/ads, rent, and buy. Availability can change and
  does not confirm playback. Provider subscriptions are local preferences.
- Provider buttons save local subscription highlights; they do not claim a
  title-specific app launch. The TMDB/JustWatch URL returned for the selected
  US title is offered only after exact TMDB-origin and title-path validation.
  It opens an external TMDB page, not a native provider app; browser support
  for that handoff still requires physical Vizio verification. If TMDB gives
  no valid link, provider listings remain informational.
- TV seasons and episodes come from TMDB metadata. Season 0 and unaired
  episodes are omitted. TMDB metadata does not prove a YapGrid stream exists.
  Watch in Horizon opens the existing Video Lab player with validated TMDB
  show ID, season, episode, subtitle mode, and a fixed `from=search` return
  marker. The player bridge and SmartCast protocol remain unchanged.
- Subtitle mode defaults to Off when no preference has been saved. Watch stores
  explicit On/Off choices on its own origin and includes the mode in every
  player and episode URL. Returning from Video Lab carries the chosen mode
  back to Watch and updates that preference. A direct Vizio Home exit from the
  separate player origin cannot update Watch storage; no cross-origin storage
  access or subtitle-language detection is attempted.
- Movies open the existing Video Lab player using the TMDB movie ID at
  `https://yapgrid.com/embed/movie/{tmdbId}`. The movie route uses the same
  focus, Back, and bridge controls; episode controls and the unverified movie
  subtitle toggle are hidden. An iframe load does not prove that video played.
  Physical Vizio playback and remote behavior still require verification.
- Versioned local history stores **started** TV episodes, subtitle preference,
  and timestamp. The version 2 model retains up to 100 distinct
  started episodes and movies, deduplicated by TMDB ID and episode coordinates.
  The existing version 1 store is read and migrated when a new start is saved.
  Artwork paths and episode titles are validated before storage. No playback
  position or completion is inferred. Movie starts update one record per TMDB
  movie ID, and relaunch from History begins at the start.
- Home and Watch are separate origins. On normal Watch → Home navigation,
  Watch sends only the six grouped, validated recent rows in a URL fragment.
  Home validates that snapshot and stores it in its own localStorage. The
  fragment is removed from Home's address bar after loading. It contains no
  credential or token and is never sent to a server. A forged fragment can
  alter local display history, but cannot call a privileged API; Home only
  constructs fixed, validated Watch routes. This avoids a public write API.
  Direct Vizio Home exits and browser storage eviction can leave Home's copy
  stale until the next normal Watch return. There is no cross-device sync.
- A Home Continue Watching card sends a validated selection to Horizon Watch,
  which records the start on its own origin, saves episode return context,
  and immediately opens the existing Video Lab player. This brief Watch
  transit is needed for cross-origin history consistency. Player Back returns
  to the episode list, then Details, then Watch, then Home.
- Search waits 300 ms after typing at least two characters; OK on the query
  or the on-screen Search key submits immediately, including one character.
  Obsolete requests are aborted and stale responses ignored. Successful
  queries remain in a 40-entry, seven-minute cache. 429 responses show a
  bounded Retry-After hint and require an explicit retry.
- For three- and four-letter ASCII queries, the Worker combines the first
  TMDB search page, a second page when available, and eight common next-letter
  prefixes (at most ten upstream requests). Longer queries use up to three
  pages, with one shorter stem lookup for five- and six-letter words. Results
  are deduplicated by media type and TMDB ID, then ranked by visible or original
  title match, TMDB popularity, and vote count. The All, Movies, and TV filters
  use their matching TMDB search endpoints. These bounded probes cannot
  guarantee that TMDB returns every relevant title; live `sou`, `sout`, and
  `south` response checks are required before claiming acceptance.
- The player has no trusted automatic episode-ended signal. This preview does
  not introduce one or enable automatic end-of-episode autoplay.

## Local checks

The integrated local flow begins at `frontend/index.html`. From the repository
root, serve the whole repository on port 4173:

```sh
python3 -m http.server 4173 --bind 127.0.0.1
```

Open `http://127.0.0.1:4173/frontend/index.html`. The Home Search button
opens the existing Search page in localhost mock mode. The mock supplies
metadata without a TMDB token. Search episode selection still constructs the
real Video Lab preview URL; the local browser integration test blocks that
outbound request and verifies its parameters. Actual playback and bridge
commands require the separate deployed Video Lab preview and physical TV.

Back closes Search's keyboard, then returns to Home. Back from episodes
returns to details, and Back from details returns to the selected result.
The player continues to return to Search using its fixed, validated return
route. Search restores the selected episode when metadata is available, and
Home highlights Search on return. The physical Home button remains owned by
Vizio.

The Home source changes remain local until a separately authorized Home
deployment. Deploying the Search preview alone does not update the currently
deployed Home page. There is no checked-in production Wrangler configuration
for `horizon-vizio`; do not use `wrangler.production-repair.jsonc` as a Home
deployment command. Reconcile the actual deployed Worker configuration before
publishing Home changes.

```sh
node --test tests/frontend-performance.test.js tests/universal-search-core.test.js tests/universal-search-worker.test.js tests/video-lab-player-overlay.test.js
node --check universal-search-worker.js
node --check universal-search/core.js
node --check universal-search/search.js
node --check frontend/horizon.js
git diff --check
```

The browser E2E test uses the explicit localhost mock and a local Chrome CDP
port. With the repository root server running, start headless Chrome on
debugging port `9227`, then run:

```sh
HORIZON_SEARCH_URL='http://127.0.0.1:4173/universal-search/index.html?mock=1' node tests/universal-search-e2e.mjs
node tests/horizon-integration-e2e.mjs
```

Both use UI readiness checks rather than sleeps and need no TMDB token.
The integration test blocks the remote player URL, so it validates routes and
return context without contacting the bridge or hardware.

## Physical acceptance sequence

1. Launch the preview. Use arrows/OK to enter a TV title with the on-screen
   keyboard. Use Back to close it, move through All/Movies/TV and results,
   then open Details. Try physical keyboard input if available.
2. Confirm title, artwork, synopsis, and provider categories. Mark a provider
   subscribed; reload and confirm the highlight persists. An app action
   should open only the existing production Horizon launcher.
3. Browse seasons and aired episodes. Select South Park S13E2 as a known
   Video Lab baseline; confirm the Video Lab player opens and playback works.
   Test subtitles off before launch and confirm the player URL and behavior.
4. Use the player's normal Back exit, then verify Details or Episodes returns
   with focus, subtitle mode, and last selected episode intact. Confirm
   Continue Watching resumes that episode, without a progress percentage.
5. Try a movie: metadata and providers should appear, and Play should open
   the same Video Lab shell with YapGrid's movie URL. Confirm Back returns to
   movie details, History contains one movie record, and a History relaunch
   starts the same movie from the beginning. Try empty and failed searches
   and the Retry action.

If the browser traps focus after following an external site, physical Home
and an approved Conjure relaunch remain the recovery path. TV remote handling,
storage persistence, and the cross-origin return flow require physical Vizio
verification; desktop tests cannot establish them.
