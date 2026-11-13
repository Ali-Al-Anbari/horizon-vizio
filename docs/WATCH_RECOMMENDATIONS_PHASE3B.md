# Watch recommendations Phase 3B

The existing Worker remains the sole candidate source. It requests at most three positive seed details, two negative details, related lists, discovery, and trending within its existing five-second deadline. The client retains the ten-minute candidate cache; feedback and meaningful history changes rerank those candidates locally. No episode request is made for preference extraction.

## Taste evidence

`recommendations.js` groups verified VidBolt progress by canonical `movie:id` or `tv:id`. A timeline shorter than 60 seconds, less than 60 seconds of viewing, or an otherwise brief start is neutral. The signal requires at least 10% of a title or 10 minutes of a movie / 5 minutes of an episode. Missing and malformed progress, details openings, and provider events without verified progress do not contribute. Completion adds four points to interest, never an explicit Love It. Repeated episodes add at most four points after the first episode; thirty episodes do not outweigh an explicit Love It. Interest decays toward half strength over 90 days. Love It starts at 34 points; Not Interested excludes the exact identity and applies a bounded genre/keyword penalty. Genre and keyword affinity is computed only from TMDB seed metadata and capped per feature. Movie and TV feature keys remain separate.

No profile operation reads or writes the active episode pointer. The profile describes historical consumption; current rewatch targeting stays in the existing progression code.

## Ranking and rows

The existing deterministic ranker combines related-source evidence (0.8 × seed strength for TMDB recommendations, 0.58 × for similar), bounded genre (18), keyword (10), quality/popularity (20), and negative metadata (12) scores. Greedy reranking penalizes repeated leading seeds (9 per prior result), repeated genres (up to 6 per genre), and media-type concentration (1.5 per prior result). Exact identity ties sort consistently. Related, trending, and discovery candidates are deduplicated by canonical identity. Generic For You rows also exclude consumed and explicitly rated titles, keeping completed and unfinished titles out of discovery rows. Top Picks retains the existing popularity/trending cold start. Because You Liked/Watched requires a real positive seed and a TMDB related source. No new row or network service was added.

Settings now offers a two-step **Reset recommendation choices** action. It clears only version-1 Love It / Not Interested ratings, increments the feedback revision, and triggers a local rerank. It does not delete history, progress, or active episode state. Unknown future feedback storage versions are preserved.

## Evaluation limits

The new tests compare fixed candidate pools and verify evidence thresholds, series caps, reset isolation, identity exclusion, and deterministic ordering. These are regression properties, not empirical relevance labels. Precision@K and NDCG are intentionally omitted because the project has no independent relevance judgments. Chrome browser checks validate rendering and navigation; only physical Vizio testing can establish device smoothness.
