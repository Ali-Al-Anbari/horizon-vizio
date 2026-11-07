# Watch progress and persistent hero, Phase 5

## Playback boundary

VidBolt `timeupdate`, `pause`, and `ended` messages already write verified checkpoints to Video Lab's version 1 progress store. A healthy timeline reaching 95% is completed; a partial exit stays incomplete. `dispose()` flushes the last confirmed checkpoint before a page navigation or observable `pagehide`. The external iframe cannot be inspected for a shutdown or an episode change that it does not announce.

Watch and Video Lab use separate origins. Previously, a Watch return URL carried only the current episode; earlier episodes in an app-managed Next/Previous sequence stayed in Video Lab storage. A Watch launch now sends its handoff creation time, and app-managed episode transitions preserve that time and a bounded trail of opened episode identities. On return, Video Lab includes up to 16 verified records from that launch for the same TMDB show. Watch accepts the trail and records only after validating the existing one-use handoff token. The trail records opens; only verified VidBolt records contribute positive progress. No history or feedback schema was replaced.

## Show completion

Watch stores a separate version 1 cache of TMDB season episode counts. TV shows are Finished only when every episode in every numbered season in that catalog has confirmed completion or an explicit manual watched mark. Unknown catalogs leave shows in Continue Watching. A completed show's catalog is refreshed on Watch Home when older than six hours, at most six recent shows per render and one concurrent request per show. Failed refreshes wait ten minutes before retrying. Opening Details also updates the catalog. A larger episode count moves an otherwise completed show back to Continue Watching. TMDB counts can include future or missing metadata, so classification deliberately favors Continue Watching until the catalog and completion evidence agree. Specials are excluded from this completion test.

## Homepage

The hero occupies 54% of the Watch viewport. Only `#watch-rows-scroll` scrolls vertically. Existing full-width horizontal scrollports, rail, focus memory, and art crossfade remain. Recommendation cards now supply their own TMDB identity and available artwork, title, type, and vote average to the hero without issuing a title-detail request on every focus movement. Loaded history cards continue using the existing cached detail path.

## Device limits

The parent cannot reliably detect a SmartCast shutdown or a cross-origin provider's internal autoplay when VidBolt does not send an episode identity or new parent navigation. The last received verified checkpoint remains in Video Lab storage, but Watch can import it only on an observable return. Physical Vizio testing should confirm `pagehide` timing, VidBolt message delivery, and memory pressure with many art changes.
