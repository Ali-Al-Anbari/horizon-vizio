import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("../universal-search/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../universal-search/search.css", import.meta.url), "utf8");
const searchSource = readFileSync(new URL("../universal-search/search.js", import.meta.url), "utf8");
const recSource = readFileSync(new URL("../universal-search/recommendations.js", import.meta.url), "utf8");
const mockSource = readFileSync(new URL("../universal-search/mock-data.js", import.meta.url), "utf8");
const coreSource = readFileSync(new URL("../universal-search/core.js", import.meta.url), "utf8");

const root = {};
runInNewContext(coreSource, { window: root });
runInNewContext(recSource, { window: root });
runInNewContext(mockSource, { window: root });
runInNewContext(searchSource, { window: root });

const engine = root.HorizonWatchRecommendations;
const core = root.HorizonSearchCore;
const mock = root.HorizonSearchMock;

test("Phase 1A: Left rail exposes all discovery destinations in exact order", () => {
  const rail = html.match(/<nav class="watch-rail"[\s\S]*?<\/nav>/)[0];
  assert.ok(rail, "Left rail exists in HTML");
  const buttons = Array.from(rail.matchAll(/id="([^"]+-toggle)"/g), match => match[1]);
  assert.deepEqual(buttons, [
    "search-toggle",
    "watch-toggle",
    "tv-toggle",
    "movies-toggle",
    "discover-toggle",
    "history-toggle",
    "settings-toggle"
  ]);

  assert.match(html, /id="search-toggle"[^>]*aria-label="Search"/);
  assert.match(html, /id="watch-toggle"[^>]*aria-label="Watch Home"/);
  assert.match(html, /id="tv-toggle"[^>]*aria-label="TV Shows"/);
  assert.match(html, /id="movies-toggle"[^>]*aria-label="Movies"/);
  assert.match(html, /id="discover-toggle"[^>]*aria-label="Discover"/);
  assert.match(html, /id="history-toggle"[^>]*aria-label="Watch History"/);
  assert.match(html, /id="settings-toggle"[^>]*aria-label="Watch Settings"/);

  assert.match(css, /body\.watch-active \.rail-action\.is-current\s*\{[^}]*border-color:\s*rgba\(138,\s*186,\s*255/);
  assert.match(css, /body\.watch-active \.rail-action:focus,\s*body\.watch-active \.rail-action\.is-focused\s*\{[^}]*outline:\s*1px solid/);
});

test("Phase 1A: D-pad navigation maps rail, filter strip, content rows, and current-cycle boundary correctly", () => {
  assert.match(searchSource, /railButtons = \[get\("search-toggle"\), get\("watch-toggle"\), get\("tv-toggle"\), get\("movies-toggle"\), get\("discover-toggle"\), get\("history-toggle"\), get\("settings-toggle"\)\]/);
  assert.match(searchSource, /current\.classList\.contains\("filter-chip"\)/);
  assert.match(searchSource, /current\.classList\.contains\("filter-menu-option"\)/);

  // Home entry rule: Left from first card of current cycle enters left rail with Home focused
  assert.match(searchSource, /if \(rowCycleIndex\[groupName\] <= 0\) \{\s*focus\(get\("watch-toggle"\)\);/);

  // Up from first row in For You reaches Home on rail; in TV/Movies reaches filter strip
  assert.match(searchSource, /state\.watchTab === "tv" \|\| state\.watchTab === "movies"[\s\S]*?get\("filter-btn-genre"\)[\s\S]*?get\("watch-toggle"\)/);

  // Left from filter chip reaches Home on rail
  assert.match(searchSource, /if \(chipIdx > 0\) focus\(chips\[chipIdx - 1\]\);\s*else focus\(get\("watch-toggle"\)\);/);

  // Back key returns to For You from TV/Movies without accidental app exit
  assert.match(searchSource, /if \(state\.watchTab !== "for-you"\) \{\s*setWatchTab\("for-you"\);/);

  // Back key at root stays in Watch with Home focused
  assert.match(searchSource, /else \{\s*focus\(get\("watch-toggle"\)\);\s*\}/);

  // Back from details restores originating tab and rows
  assert.match(searchSource, /setWatchTab\(state\.detailSourceTab \|\| "for-you"\);/);
});

test("Phase 1B: Expanded recommendations build candidate rows for For You, TV, and Movies", () => {
  const seeds = [
    { type: "tv", id: 2190, title: "South Park", genreIds: [16, 35], keywordIds: [] },
    { type: "movie", id: 157336, title: "Interstellar", genreIds: [12, 18, 878], keywordIds: [] }
  ];
  const candidates = [
    // TV candidates
    { type: "tv", id: 74204, title: "Big Mouth", poster: "/bm.jpg", genreIds: [35, 16], popularity: 80, voteCount: 1200, voteAverage: 7.6, sources: [{ kind: "recommendation", seed: "tv:2190" }] },
    { type: "tv", id: 709, title: "Robot Chicken", poster: "/rc.jpg", genreIds: [35, 16], popularity: 60, voteCount: 600, voteAverage: 7.6, sources: [{ kind: "recommendation", seed: "tv:2190" }] },
    { type: "tv", id: 1434, title: "Family Guy", poster: "/fg.jpg", genreIds: [16, 35], popularity: 200, voteCount: 5000, voteAverage: 7.4, sources: [{ kind: "trending" }] },
    { type: "tv", id: 1396, title: "Breaking Bad", poster: "/bb.jpg", genreIds: [18, 80], popularity: 150, voteCount: 12000, voteAverage: 8.9, sources: [{ kind: "trending" }] },
    { type: "tv", id: 70523, title: "Dark", poster: "/dark.jpg", genreIds: [18, 9648], popularity: 90, voteCount: 5000, voteAverage: 8.5, sources: [{ kind: "trending" }] },
    { type: "tv", id: 3540, title: "Kenny vs. Spenny", poster: "/kvs.jpg", genreIds: [35], popularity: 12, voteCount: 66, voteAverage: 7.3, sources: [{ kind: "trending" }] },
    // Movie candidates
    { type: "movie", id: 670292, title: "The Creator", poster: "/tc.jpg", genreIds: [878, 28], popularity: 110, voteCount: 4200, voteAverage: 7.1, sources: [{ kind: "recommendation", seed: "movie:157336" }] },
    { type: "movie", id: 299534, title: "Avengers: Endgame", poster: "/av.jpg", genreIds: [12, 878, 28], popularity: 250, voteCount: 29000, voteAverage: 8.3, sources: [{ kind: "trending" }] },
    { type: "movie", id: 14337, title: "Primer", poster: "/pr.jpg", genreIds: [878, 53], popularity: 25, voteCount: 2500, voteAverage: 7.2, sources: [{ kind: "recommendation", seed: "movie:157336" }] },
    { type: "movie", id: 550, title: "Fight Club", poster: "/fc.jpg", genreIds: [18, 53], popularity: 90, voteCount: 24000, voteAverage: 8.4, sources: [{ kind: "trending" }] },
    { type: "movie", id: 187, title: "Sin City", poster: "/sc.jpg", genreIds: [80, 53], popularity: 40, voteCount: 9000, voteAverage: 7.5, sources: [{ kind: "trending" }] }
  ];

  const payload = { seeds, avoids: [], candidates };
  const history = [
    core.item("tv", 2190, "South Park", 1, 1, "off", 1000, { progress: { position: 500, duration: 1200, updatedAt: 1000, provider: "vidbolt", completed: false } }),
    core.item("movie", 157336, "Interstellar", null, null, "off", 2000, { progress: { position: 5000, duration: 10000, updatedAt: 2000, provider: "vidbolt", completed: false } })
  ];

  const rows = engine.selectRows(history, { ratings: {} }, payload, { now: 3000 });
  assert.ok(rows.forYou, "For You row bundle exists");
  assert.ok(rows.tv, "TV row bundle exists");
  assert.ok(rows.movies, "Movies row bundle exists");

  // TV tab rows must contain TV media only
  for (const group of ["recommended", "trending", "genres", "short", "gems", "acclaimed"]) {
    const list = rows.tv[group] || [];
    for (const item of list) {
      assert.equal(item.type, "tv", `TV ${group} row item must be TV media`);
    }
  }

  // Movie tab rows must contain Movie media only
  for (const group of ["recommended", "trending", "genres", "short", "gems", "acclaimed"]) {
    const list = rows.movies[group] || [];
    for (const item of list) {
      assert.equal(item.type, "movie", `Movie ${group} row item must be Movie media`);
    }
  }

  // Deduplication check: no duplicate IDs within any single row
  for (const tab of [rows.forYou, rows.tv, rows.movies]) {
    for (const [name, list] of Object.entries(tab)) {
      if (Array.isArray(list)) {
        const ids = list.map(item => item.type + ":" + item.id);
        const unique = new Set(ids);
        assert.equal(ids.length, unique.size, `Row ${name} must have unique IDs`);
      }
    }
  }
});

test("Phase 1B: Details feedback buttons are Love It and Not Interested", () => {
  assert.match(searchSource, /add\("liked", "Love It", "love-it"\)/);
  assert.match(searchSource, /add\("disliked", "Not Interested", "not-interested"\)/);

  // Disliked title is excluded from recommendations without erasing history
  const history = [core.item("movie", 550, "Fight Club", null, null, "off", 1000, { progress: { position: 500, duration: 1000, updatedAt: 1000, provider: "vidbolt", completed: false } })];
  const payload = { seeds: [], avoids: [], candidates: [
    { type: "movie", id: 550, title: "Fight Club", poster: "/fc.jpg", sources: [{ kind: "trending" }] },
    { type: "movie", id: 187, title: "Sin City", poster: "/sc.jpg", sources: [{ kind: "trending" }], popularity: 50 }
  ] };
  const feedback = { ratings: { "movie:550": "disliked" } };
  const ranked = engine.rank(history, feedback, payload, { now: 2000 });
  assert.equal(ranked.some(r => r.id === 550), false, "Disliked movie must not appear in recommendations");
  assert.equal(history.some(r => r.id === 550), true, "Disliked movie remains in history");
});

test("Phase 1C: TV-friendly filtering strip markup and styles are complete", () => {
  const strip = html.match(/<div id="watch-filter-strip"[\s\S]*?<\/div>/)[0];
  assert.ok(strip, "Filter strip exists");
  assert.match(strip, /id="filter-btn-genre"/);
  assert.match(strip, /id="filter-btn-length"/);
  assert.match(strip, /id="filter-btn-rating"/);
  assert.match(strip, /id="filter-btn-year"/);
  assert.match(strip, /id="filter-btn-sort"/);
  assert.match(strip, /id="filter-btn-clear"/);

  const menu = html.match(/<div id="watch-filter-menu"[\s\S]*?<\/div>/)[0];
  assert.ok(menu, "Filter menu container exists");

  assert.match(html, /id="watch-filtered-section"/);
  assert.match(html, /id="watch-filter-empty"/);

  assert.match(css, /body\.watch-active \.watch-filter-strip\s*\{[^}]*position: absolute/);
  assert.match(css, /body\.watch-active \.filter-chip\s*\{[^}]*border-radius: 18px/);
  assert.match(css, /body\.watch-active \.watch-filter-menu\s*\{[^}]*backdrop-filter: blur\(16px\)/);
});

test("Phase 1 Runtime: Bounded runtime row filtering excludes non-short and unknown metadata without genre proxies", () => {
  const candidates = [
    // Movie candidates
    { type: "movie", id: 101, title: "Short Movie 99", poster: "/m1.jpg", runtime: 99, genreIds: [18] },
    { type: "movie", id: 102, title: "Exact Boundary Movie 100", poster: "/m2.jpg", runtime: 100, genreIds: [18] },
    { type: "movie", id: 103, title: "Long Movie 101", poster: "/m3.jpg", runtime: 101, genreIds: [18] },
    { type: "movie", id: 104, title: "Comedy Movie No Runtime", poster: "/m4.jpg", runtime: null, genreIds: [35] },
    { type: "movie", id: 105, title: "Animation Movie No Runtime", poster: "/m5.jpg", runtime: null, genreIds: [16] },
    { type: "movie", id: 106, title: "Horror Movie No Runtime", poster: "/m6.jpg", runtime: null, genreIds: [27] },
    { type: "movie", id: 107, title: "Invalid Runtime Movie", poster: "/m7.jpg", runtime: 0, genreIds: [18] },
    { type: "movie", id: 108, title: "Short Movie 80", poster: "/m8.jpg", runtime: 80, genreIds: [28] },

    // TV candidates
    { type: "tv", id: 201, title: "Exact Boundary TV 30", poster: "/t1.jpg", episodeRuntime: 30, genreIds: [18] },
    { type: "tv", id: 202, title: "Over Boundary TV 31", poster: "/t2.jpg", episodeRuntime: 31, genreIds: [18] },
    { type: "tv", id: 203, title: "Long Episode TV 55", poster: "/t3.jpg", episodeRuntime: 55, genreIds: [18] },
    { type: "tv", id: 204, title: "Comedy TV No Runtime", poster: "/t4.jpg", episodeRuntime: null, genreIds: [35] },
    { type: "tv", id: 205, title: "Animation TV No Runtime", poster: "/t5.jpg", episodeRuntime: null, genreIds: [16] },
    { type: "tv", id: 206, title: "Invalid TV Runtime", poster: "/t6.jpg", episodeRuntime: 0, genreIds: [18] },
    { type: "tv", id: 207, title: "Short TV 22", poster: "/t7.jpg", episodeRuntime: 22, genreIds: [35] }
  ];

  const payload = { seeds: [], avoids: [], candidates };
  const rows = engine.selectRows([], { ratings: {} }, payload, { now: 1000, tabRankedLimit: 0 });

  // Movies: Under 100 Minutes
  const movieShortIds = (rows.movies.short || []).map(m => m.id);
  assert.ok(movieShortIds.includes(101), "Movie with 99 min must be included in short row");
  assert.ok(movieShortIds.includes(108), "Movie with 80 min must be included in short row");
  assert.equal(movieShortIds.includes(102), false, "Movie with 100 min is NOT under 100 minutes");
  assert.equal(movieShortIds.includes(103), false, "Movie with 101 min is NOT under 100 minutes");
  assert.equal(movieShortIds.includes(104), false, "Comedy movie without runtime must NOT proxy into short row");
  assert.equal(movieShortIds.includes(105), false, "Animation movie without runtime must NOT proxy into short row");
  assert.equal(movieShortIds.includes(106), false, "Horror movie without runtime must NOT proxy into short row");
  assert.equal(movieShortIds.includes(107), false, "Movie with 0 runtime must NOT be included");

  // TV: Short Episodes (<= 30 min)
  const tvShortIds = (rows.tv.short || []).map(t => t.id);
  assert.ok(tvShortIds.includes(201), "TV show with 30 min must be included in short episodes row");
  assert.ok(tvShortIds.includes(207), "TV show with 22 min must be included in short episodes row");
  assert.equal(tvShortIds.includes(202), false, "TV show with 31 min is NOT <= 30 minutes");
  assert.equal(tvShortIds.includes(203), false, "TV show with 55 min is NOT <= 30 minutes");
  assert.equal(tvShortIds.includes(204), false, "Comedy TV show without runtime must NOT proxy into short row");
  assert.equal(tvShortIds.includes(205), false, "Animation TV show without runtime must NOT proxy into short row");
  assert.equal(tvShortIds.includes(206), false, "TV show with 0 runtime must NOT be included");

  // Verify external runtime enrichment option is respected
  const enrichedRows = engine.selectRows([], { ratings: {} }, payload, {
    now: 1000,
    tabRankedLimit: 0,
    runtimes: { "movie:104": 85, "tv:204": 25 }
  });
  const enrichedMovieShortIds = (enrichedRows.movies.short || []).map(m => m.id);
  const enrichedTvShortIds = (enrichedRows.tv.short || []).map(t => t.id);
  assert.ok(enrichedMovieShortIds.includes(104), "Enriched movie runtime of 85 min qualifies for short row");
  assert.ok(enrichedTvShortIds.includes(204), "Enriched TV runtime of 25 min qualifies for short row");
});

test("Phase 1 Discover: Rating classification enforces child safety and excludes unknown ratings", () => {
  // Test mock discover with rating filter
  const movieG = mock.discover(new URLSearchParams("type=movie&rating=G"));
  assert.ok(movieG.results.length > 0, "G-rated movies found");
  movieG.results.forEach(m => assert.equal(m.rating, "G", "Every result must be G-rated"));

  const moviePG13 = mock.discover(new URLSearchParams("type=movie&rating=PG-13"));
  assert.ok(moviePG13.results.length > 0, "PG-13 rated movies found");
  moviePG13.results.forEach(m => assert.equal(m.rating, "PG-13", "Every result must be PG-13 rated"));

  const movieR = mock.discover(new URLSearchParams("type=movie&rating=R"));
  assert.ok(movieR.results.length > 0, "R rated movies found");
  movieR.results.forEach(m => assert.equal(m.rating, "R", "Every result must be R rated"));

  // Mystery Indie Film has rating: null - verify it is NEVER returned under any rating
  for (const rating of ["G", "PG", "PG-13", "R", "NC-17"]) {
    const res = mock.discover(new URLSearchParams("type=movie&rating=" + rating));
    assert.equal(res.results.some(m => m.id === 999999), false, `Unknown rating title 999999 must NOT appear in rating=${rating}`);
  }

  // TV ratings
  const tvMA = mock.discover(new URLSearchParams("type=tv&rating=TV-MA"));
  assert.ok(tvMA.results.length > 0, "TV-MA shows found");
  tvMA.results.forEach(t => assert.equal(t.rating, "TV-MA", "Every result must be TV-MA rated"));

  const tv14 = mock.discover(new URLSearchParams("type=tv&rating=TV-14"));
  assert.ok(tv14.results.length > 0, "TV-14 shows found");
  tv14.results.forEach(t => assert.equal(t.rating, "TV-14", "Every result must be TV-14 rated"));

  // Unknown Indie Show has rating: null - verify it is NEVER returned under any TV rating
  for (const rating of ["TV-Y", "TV-Y7", "TV-G", "TV-PG", "TV-14", "TV-MA"]) {
    const res = mock.discover(new URLSearchParams("type=tv&rating=" + rating));
    assert.equal(res.results.some(t => t.id === 888888), false, `Unknown rating TV title 888888 must NOT appear in rating=${rating}`);
  }
});

test("Phase 1 Discover: Combined filters strictly enforce all dimensions end-to-end", () => {
  // Combined filter: Movie + Sci-Fi (878) + Short (<90m) + PG-13
  const combined = mock.discover(new URLSearchParams("type=movie&with_genres=878&length=short&rating=PG-13"));
  assert.ok(combined.results.length > 0, "Found matching combined movie");
  combined.results.forEach(m => {
    assert.equal(m.type, "movie");
    assert.ok(m.genreIds.includes(878), "Must have Sci-Fi genre 878");
    assert.ok(m.runtime < 90, "Runtime must be under 90 minutes");
    assert.equal(m.rating, "PG-13", "Rating must be PG-13");
  });
  // Primer (id: 14337, runtime: 77, rating: PG-13, genre: 878) satisfies all 4
  assert.ok(combined.results.some(m => m.id === 14337), "Primer must be in combined results");
  // The Creator (id: 670292, runtime: 133) fails short length -> excluded
  assert.equal(combined.results.some(m => m.id === 670292), false, "Longer movie must be excluded from short filter");
  // Mystery Indie Film (id: 999999, runtime: null) fails runtime -> excluded
  assert.equal(combined.results.some(m => m.id === 999999), false, "Missing metadata title must be excluded");

  // Combined filter: TV + Animation (16) + Comedy (35) + Short (<=30m) + TV-14
  const tvCombined = mock.discover(new URLSearchParams("type=tv&with_genres=16&length=short&rating=TV-14"));
  assert.ok(tvCombined.results.length > 0, "Found matching TV shows");
  tvCombined.results.forEach(t => {
    assert.equal(t.type, "tv");
    assert.ok(t.genreIds.includes(16), "Must have Animation genre 16");
    assert.ok(t.episodeRuntime <= 30, "Episode runtime must be <= 30 minutes");
    assert.equal(t.rating, "TV-14", "Rating must be TV-14");
  });
  // Family Guy (id: 1434, ep: 22, rating: TV-14, genre: 16) matches
  assert.ok(tvCombined.results.some(t => t.id === 1434), "Family Guy matches combined TV filter");
  // Big Mouth (id: 74204, rating: TV-MA) fails rating -> excluded
  assert.equal(tvCombined.results.some(t => t.id === 74204), false, "TV-MA show must be excluded from TV-14 filter");
});

test("Phase 1 Discover: UI handles empty results and API errors with safe recovery", () => {
  // Empty result query
  const emptyRes = mock.discover(new URLSearchParams("type=movie&with_genres=99999"));
  assert.equal(emptyRes.results.length, 0, "Non-existent genre produces 0 results");

  // Verify searchSource handles empty state and error state correctly
  assert.match(searchSource, /text\("watch-filtered-heading", isTv \? "Matching TV Shows" : "Matching Movies"\);/);
  assert.match(searchSource, /emptySec\.hidden = filtered\.length > 0;/);
  assert.match(searchSource, /p\.textContent = "No matching titles found\.";/);
  assert.match(searchSource, /p\.textContent = "Unable to load matching titles\. Please check your connection or clear filters\.";/);
  assert.match(searchSource, /function clearActiveFilters\(\)/);
});
