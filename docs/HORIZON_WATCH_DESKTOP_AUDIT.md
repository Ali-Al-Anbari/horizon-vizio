# Horizon Watch interaction audit

Scope: `universal-search/index.html`, `search.js`, `core.js`, `search.css`, and the shared `video-lab/player-overlay.*` reached by Watch. The Watch Worker supplies TMDB metadata; the player overlay is hosted by the Video Lab preview. This inventory describes code paths and focused test evidence. Browser and physical Vizio results remain unverified until run on those devices.

## Findings and disposition

| Severity | Finding | Disposition |
| --- | --- | --- |
| P0 | Watch launched YapGrid because player URLs omitted a provider. | Watch movie and exact episode URLs now request `provider=vidbolt`; the overlay's explicit switch keeps YapGrid available. |
| P0 | The overlay's Episode List led to a placeholder even when launched from Watch. | Watch launches now return to the real Watch episode list with the same TMDB show, season, and episode. |
| P1 | The player had no mouse path to reveal controls or exit through the page. | Watch launches show Exit to Watch. Desktop Watch keeps its Horizon controls visible; Vizio retains pointer capture. Video Lab routes retain their old behavior. |
| P1 | Browser fullscreen was unavailable from the Watch player. | Desktop Watch requests fullscreen on the entire player container from the existing control row and tracks independent exits; the iframe is retained. Actual Chrome/Safari behavior remains unverified. |
| P1 | A prior desktop native-click experiment exposed VidBolt's iframe and added a Show/Hide toolbar. | Removed. Desktop Watch again blocks iframe pointer input and keeps Horizon controls visible. The pre-existing native-focus diagnostic remains available on Vizio and standalone Video Lab only. |
| P1 | A visible Hide Keyboard control did not hide anything; physical keyboard arrows could be captured in the search field. | Toggle now changes visibility; desktop starts with the TV keyboard hidden; editing keys remain native for desktop input. |
| P1 | Rebuilding TV action buttons during metadata loading could detach the focused button. | Rebuilt action regains focus or moves to enabled Episode List. |
| P1 | Browser Back could leave Watch from Details rather than walk its screens. | Desktop Watch views now use History API entries; browser Back/Forward restores view and focus. |
| P1 | YapGrid bridge preparation could leave an indefinite “Preparing” status. | The overlay reports an unready bridge after five seconds. VidBolt and navigation remain independent. |
| P2 | New result sets could retain the previous scroll position. | Search and History lists reset to their first row on re-render. |

## Button and interaction matrix

“Mouse” and “keyboard” describe the implemented action path, not a live browser result. Native buttons accept click, Enter, and Space. D-pad uses the geometric focus navigator in `search.js` or the player overlay's control navigator. “Unverified” means live browser/TV verification remains outstanding. “Fixed (unit)” means the state transition is covered by unit fixtures. Handler names refer to `search.js` unless another file is named.

| Screen / element | Action and handler / destination | Dependency | Mouse | Keyboard | D-pad | Status / evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Rail / Home | `exitToHome` → launcher with Watch history snapshot | launcher origin | click | Enter/Space | OK | Unverified; Home return in `horizon-integration-e2e.mjs` |
| Rail / Search | `setView`, `scheduleSearch`, focus query | none | click | Enter/Space | OK | Unverified; search E2E |
| Rail / Continue | `showContinue` → stored title cards | local history | click | Enter/Space | OK | Unverified; core history tests |
| Rail / History | `showHistory` → grouped starts | local history | click | Enter/Space | OK | Unverified; search E2E |
| Search / query field | `input` → debounced `searchNow`; Enter submits | metadata API or localhost mock | click/type | type, edit, Enter; arrows native on desktop | OK opens TV keyboard when empty | Unverified; interaction policy unit test |
| Search / Show or Hide Keyboard | `toggleKeyboard` | none | click | Enter/Space | OK | Unverified; E2E updated |
| Search / TV keyboard letters, digits, Space, delete, Clear | `buildKeyboard` → query update and search | none | click | Tab + Enter/Space | arrows + OK | Unverified; existing search E2E |
| Search / All, Movies, TV Shows | filter click → `scheduleSearch` | metadata API | click | Enter/Space | arrows + OK | Unverified; core and E2E tests |
| Search / result poster cards | `openDetails` for exact TMDB ID | title metadata API | click | Tab + Enter/Space | arrows + OK | Unverified; search E2E |
| Search / Retry on error | `searchNow(true)` | metadata API | click | Enter/Space | OK | Unverified; search E2E |
| Details / Results | `backToResults` with focus restoration | saved result list | click | Enter/Space, Escape | OK/Back | Unverified; E2E, History API code |
| Details / Play movie | `launchMovie` → VidBolt overlay | valid TMDB movie ID | click | Enter/Space | OK | Fixed (unit); URL test; stream unverified |
| Details / Start or Continue TV | `launchEpisode` for exact selected episode | validated aired episode or stored selection | click | Enter/Space | OK | Fixed (unit); URL test; stream unverified |
| Details / Episode List | `browseEpisodes` | season metadata | click | Enter/Space | OK | Unverified; search E2E |
| Details / season selector | `toggleSeasonMenu` | title seasons | click | Enter/Space, Escape closes | OK/Back | Unverified; search E2E |
| Details / season options | `loadSeason`, return focus to selector | season metadata | click | Enter/Space | arrows + OK | Unverified; search E2E |
| Details / compact episode cards | `launchEpisode` with card season/episode | validated aired episode | click | Enter/Space | arrows + OK | Fixed (unit); route; stream unverified |
| Details / provider logos when actionable | `updateProviders` → validated title-specific TMDB `/watch` page | TMDB / JustWatch URL validation | click | Enter/Space | OK | Fixed (unit); URL validation; live link U |
| Episodes / Details | `backToDetails` | current title | click | Enter/Space, Escape | OK/Back | Unverified; search E2E |
| Episodes / seasons | `loadSeason` | season metadata | click | Enter/Space | arrows + OK | Unverified; search E2E |
| Episodes / episode cards | `launchEpisode` | valid TMDB show/season/episode | click | Enter/Space | arrows + OK | Fixed (unit); route; stream unverified |
| History / Back | `leaveHistory` | previous Watch view | click | Enter/Space, Escape | OK/Back | Unverified; search E2E |
| History / title cards | `launchHistory`; movies relaunch, TV retains exact saved episode | local history | click | Enter/Space | arrows + OK | Fixed (unit); core identity; browser unverified |
| History / Clear History | two-click confirmation, then `core.clearHistory` | local storage | click twice | Enter/Space twice | OK twice | Fixed (unit); core clear; browser unverified |
| Footer / TMDB | standard external link | TMDB site | click | Tab + Enter | Tab + OK | Unverified; link is now tabbable |
| Player / full-screen capture | `showControls` on pointer move/click for Vizio Watch route | overlay loaded | pointer move/click on TV route | arrow, OK, Space | arrow/OK | Fixed (unit); TV path preserved; physical unverified |
| Player / desktop Fullscreen control | `requestFullscreen` / `exitFullscreen` on player shell; `fullscreenchange` sync | desktop browser Fullscreen API | click in existing control row | Tab + Enter/Space; Escape exits fullscreen | TV button hidden | Fixed (unit); API and focus fixture; browser chrome behavior unverified |
| Player / rewind, forward | `sendBoltSeek` absolute validated time; YapGrid uses bridge batch | VidBolt position or connected bridge | click | Tab + Enter/Space | arrows accelerate, OK confirms | Fixed (unit); overlay regressions; stream unverified |
| Player / Play or Pause | `toggleBoltPlayPause`; YapGrid bridge command | provider state or bridge | click | Enter/Space | OK | Fixed (unit); overlay tests; stream unverified |
| Player / previous, next episode | `transitionEpisode`, then explicit confirmation | TVmaze metadata | click | Enter/Space | OK | Fixed (unit); overlay tests; stream unverified |
| Player / Subtitles | YapGrid mode menu; VidBolt displays its unsupported parent-control limitation | YapGrid reload; VidBolt native menu remains outside Horizon control | click | Enter/Space | OK | Fixed (unit); handler; VidBolt parent selection unsupported |
| Player / Episode List | Watch route returns to Watch episode list; lab route keeps placeholder | selected episode | click | Enter/Space | OK | Fixed (unit); overlay Watch test |
| Player / Provider | `switchProvider` between VidBolt and YapGrid | active title | click | Enter/Space | OK | Fixed (unit); overlay Watch test |
| Player / Recover or Reload | `recoverBolt` with valid saved position or `reloadYapGrid` from start | active iframe | click | Enter/Space | OK | Fixed (unit); overlay tests; Vizio manual recovery previously verified |
| Player / Diagnostics | `openDiagnostics` / close | none | click | Enter/Space, Escape | OK/Back | Fixed (unit); overlay regressions |
| Player / Exit to Watch | `exitPlayer` → Watch return URL and clean unload | Watch route | click | Enter/Space, Escape outside fullscreen | OK/Back | Fixed (unit); overlay Watch test; browser unverified |
| Player / VidBolt diagnostic actions | autoplay option, auto-recover option, Stop/Unload; native focus trial on Vizio/Video Lab | active VidBolt iframe | click | Tab + Enter/Space | arrows + OK | Fixed (unit); overlay regressions; physical effects unverified |
| Player / YapGrid subtitle menu | cancel or confirmed reload with chosen mode | YapGrid iframe | click | Tab + Enter/Space, Escape | arrows + OK/Back | Fixed (unit); overlay regressions |
| Player / Up Next actions (test route only) | play next or return to episode list | TVmaze lookup, test flag | click | Tab + Enter/Space | arrows + OK | Fixed (unit); overlay tests; hidden in normal Watch |

Informational provider icons without a validated TMDB link are spans, not dead buttons. Experimental provider controls and the test-only end button are hidden from normal Watch. No Watch control invokes Pico hardware directly; only YapGrid transport commands depend on the Player Bridge. Watch metadata and local history use browser storage and same-origin Worker API. The player overlay and Watch Worker remain separately hosted preview origins; offline use and third-party stream availability are outside local UI verification.

## Manual coverage still needed

Run the browser journey on Chrome (macOS and Windows), Edge, Safari, and Firefox at 1024×720, 1280×720, 1440×900, and 1920×1080. Verify pointer, Tab/Shift+Tab, Enter, Space, Escape, arrows, browser Back/Forward, wheel scrolling, season menu placement, and no clipping. In Chrome and Safari, use Fullscreen in the Horizon control row and confirm the address bar disappears without reloading the iframe; exit with the button and Escape. Confirm Horizon controls remain visible and clickable in both sizes, and VidBolt's native controls are not exposed to pointer input. Confirm VidBolt playback, audio, recovery, and YapGrid fallback on the Vizio separately. Local browser automation was unavailable because this environment denied binding a localhost test server.
