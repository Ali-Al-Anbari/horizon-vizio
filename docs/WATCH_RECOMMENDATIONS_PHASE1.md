# Horizon Watch recommendations, Phase 1

This document records the Phase 1 foundation. The homepage integration is documented in [Phase 3](WATCH_RECOMMENDATIONS_PHASE3.md).

The engine is available as `window.HorizonWatchRecommendations`. Pass Watch's local storage and same-origin `fetch` to `load(storage, fetch)` for ranked results. Ranking is pure and can be called as `rank(history, feedback, workerPayload, { now, limit, reserved })`.

## Feedback and viewing evidence

Feedback is stored on the Watch origin in `horizon-watch-feedback-v1` as `{ version: 1, revision, ratings: { "movie:123": "liked", "tv:456": "disliked" } }`. Neutral removes an entry. Reader validation rejects malformed identities and values. Malformed JSON reads as neutral and can be replaced by a new rating. An unknown future version reads as neutral and is never overwritten by this version. Storage failures return a safe empty state or `false`; no history key is changed. The `revision` helps a future UI detect feedback changes, but the loader already reads feedback again after every network response.

Only validated VidBolt progress records create inferred interest. An unverified launch, Home metadata import, missing progress, or Continue Watching hide action contributes nothing. A verified completion adds a small positive interest bonus but is not treated as Like. Distinct verified TV episodes raise confidence up to a cap. The existing history schema collapses repeated movie plays into one record, so repeated movie viewing cannot be counted reliably in Phase 1. Explicit Like works without history and is stronger than a verified watch. Explicit Dislike excludes the exact movie or show identity.

## Candidate generation

`GET /api/recommendations?seeds=movie:123,tv:456&avoid=movie:789` accepts up to three positive and two disliked canonical identities. The Watch client chooses the three strongest positive seeds and up to two deterministic disliked identities. The Worker keeps the TMDB token server side and fetches details plus keywords for those identities, the first page of TMDB recommendations and similar titles for each positive seed, one genre/keyword filtered discovery page per represented medium, and one weekly trending page per medium. The query is capped at **15 TMDB requests**; the Vizio makes **one** request. Each source contributes at most 20 titles, and the response contains at most 180 unique candidates. Candidate genres come from TMDB results; a keyword is attached only when a `with_keywords` discovery query proves the match. Adult titles and invalid identities are discarded.

Each upstream response is independently settled. A failed similar, recommendation, discovery, or trending response does not discard other candidate sources. If every candidate source fails, the Worker returns an error and does not cache an empty success. The Worker has a five second deadline, a ten minute per-isolate cache keyed by positive and disliked identities, a 600 second public cache header, and the existing request rate limit. The client has a ten minute **raw candidate** cache keyed by positive seeds. Every `load` ranks that payload against current feedback and history; there is no personalized ranked-result cache. A newly selected positive seed triggers a fresh request. A Dislike that leaves the selected positive seeds unchanged reuses candidates and immediately excludes the disliked title. When that title is in the cached candidate set, its TMDB features also update the negative affinity immediately. Feature penalties for a newly disliked title outside the cached set become available after the next candidate refresh. If a request fails, the client can rerank the last cached candidate set; a cold failure returns an empty result rather than fabricated TMDB data. The two trending pages supply popular fallback candidates when history is empty or sparse.

## Deterministic rank

The engine scores unique `type:id` candidates, excluding verified in-progress and completed history, manually completed history, Dislikes, and identities passed in `reserved` for another proposed row. It also merges duplicate candidates and their source evidence. Genre and keyword affinity is scoped by medium, so a disliked movie does not penalize a TV show solely because TMDB uses the same numeric feature ID. `reserved` is the Phase 2 row allocation hook: after selecting one row, pass its identities when selecting the next row.

Initial score components:

| Component | Formula / cap |
| --- | --- |
| Verified watch strength | Base 12, plus up to 6 for distinct verified episodes, plus 4 for completion; multiplied by `0.5 + 0.5 × exp(-ageDays / 90)` |
| Explicit Like strength | 34, plus up to 6 from corroborating verified activity |
| Source similarity | Strongest seed strength × 0.8 for TMDB recommendations or × 0.58 for similar titles; second seed adds at most 5 |
| Genre affinity | Up to 18, from matched TMDB genre IDs and positive seed strengths |
| Keyword affinity | Up to 10, only for proven keyword IDs |
| Quality and popularity | Up to 10 from log vote count, 6 from log popularity, and 4 from vote average |
| Disliked feature penalty | Up to 12 from genres and keywords verified on up to two disliked titles; exact disliked identities are excluded |
| Greedy diversity | After each selection, subtract 9 per previous item from the same leading seed, 1.5 per prior item of the same medium, and up to 6 per shared genre |

Ties resolve by canonical identity. The returned `score` includes the diversity penalty at selection time. `reason` is a compact code plus evidence: `liked` or `watched` with an available seed title, `genres` or `keywords` with matched IDs, `category` with the discovery genre ID, or `popular` for a broad discovery/trending fallback. The UI should turn IDs into display labels only when it has matching TMDB metadata. It should not claim a specific title when `reason.title` is `null`.

## Details integration

Movie and TV Details use `readFeedback(storage)` and `setFeedback(storage, type, id, "liked" | "disliked" | "neutral")` for their two controls. Feedback stays separate from Settings history and progress controls. The Phase 3 homepage row controller uses `loadBundle` to get candidates, then `selectRows` to reserve Top Picks identities before building the seed row. It recomputes results after rating changes without writing recommendations or fixtures into history. Home, player navigation, episode targeting, and Settings remain outside this work.
