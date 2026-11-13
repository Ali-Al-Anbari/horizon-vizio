import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Load discover engine
const engineModule = {};
const engineSource = readFileSync(new URL("../universal-search/discover-engine.js", import.meta.url), "utf8");
new Function("window", "globalThis", engineSource)(engineModule, engineModule);
const engine = engineModule.HorizonDiscoverEngine;

// ============================================================================
// PHASE 3C.4 COMPREHENSIVE REGRESSION TEST SUITE
// ============================================================================

test("1. Animation-only genre overlap gives zero similarity", () => {
  // Candidate only shares Animation (16) with seed
  const seedGenres = [16];
  const candidateGenres = [16];
  const sim = engine.genreOverlapSimilarity(seedGenres, candidateGenres);
  assert.equal(sim, 0, "Animation (16) alone must yield 0 genre similarity");
});

test("2. Meaningful genre overlap remains fully functional", () => {
  // Candidate shares Comedy (35) and Drama (18)
  const seedGenres = [35, 18, 16]; // includes animation
  const candidateGenres = [35, 18];
  const sim = engine.genreOverlapSimilarity(seedGenres, candidateGenres);
  assert.ok(sim > 0.5, `Story genres must produce strong similarity: ${sim}`);

  // Distinctive genres like Sci-Fi (878) and Mystery (9648)
  const sciFiSim = engine.genreOverlapSimilarity([878, 9648], [878, 9648]);
  assert.equal(sciFiSim, 1.0, "Identical distinctive story genres must yield 1.0 similarity");
});

test("3. Animation is a presentation filter, not a genre similarity signal", () => {
  // South Park (Satire/Comedy + Animation) vs Grave of the Fireflies (War/Drama + Animation)
  const southPark = {
    type: "tv", id: 2190, title: "South Park",
    genreIds: [16, 35],
    overview: "Four boys in Colorado navigate satirical adventures.",
    keywords: [{ id: 1, name: "satire" }]
  };
  const graveOfTheFireflies = {
    type: "movie", id: 12477, title: "Grave of the Fireflies",
    genreIds: [16, 18, 10752],
    overview: "A young boy and his little sister struggle to survive in Japan during World War II.",
    keywords: [{ id: 2, name: "world war ii" }]
  };

  const score = engine.scoreCandidate(southPark, graveOfTheFireflies);
  assert.equal(score.breakdown.genre, 0, "Grave of the Fireflies must receive 0 genre similarity to South Park");
  assert.equal(score.scores.closest, 0, "Animation alone must not qualify for Closest Matches");
  assert.ok(!score.matchReason.includes("Animation"), `Match reason must not cite Animation: ${score.matchReason}`);
});

test("4. All / Animated / Live Action filtering semantics", () => {
  const animatedMovie = { type: "movie", id: 1, title: "Spider-Verse", genreIds: [16, 28, 12] };
  const liveActionMovie = { type: "movie", id: 2, title: "The Dark Knight", genreIds: [28, 80, 18] };
  const animatedShow = { type: "tv", id: 3, title: "Arcane", genreIds: [16, 10765, 10759] };
  const liveActionShow = { type: "tv", id: 4, title: "Severance", genreIds: [18, 9648, 10765] };

  // Filter: all
  assert.equal(engine.matchesDiscoverFilters(animatedMovie, { style: "all" }), true);
  assert.equal(engine.matchesDiscoverFilters(liveActionMovie, { style: "all" }), true);
  assert.equal(engine.matchesDiscoverFilters(animatedShow, { style: "all" }), true);
  assert.equal(engine.matchesDiscoverFilters(liveActionShow, { style: "all" }), true);

  // Filter: animated
  assert.equal(engine.matchesDiscoverFilters(animatedMovie, { style: "animated" }), true);
  assert.equal(engine.matchesDiscoverFilters(liveActionMovie, { style: "animated" }), false);
  assert.equal(engine.matchesDiscoverFilters(animatedShow, { style: "animated" }), true);
  assert.equal(engine.matchesDiscoverFilters(liveActionShow, { style: "animated" }), false);

  // Filter: live_action
  assert.equal(engine.matchesDiscoverFilters(animatedMovie, { style: "live_action" }), false);
  assert.equal(engine.matchesDiscoverFilters(liveActionMovie, { style: "live_action" }), true);
  assert.equal(engine.matchesDiscoverFilters(animatedShow, { style: "live_action" }), false);
  assert.equal(engine.matchesDiscoverFilters(liveActionShow, { style: "live_action" }), true);
});

test("5. Unknown animation metadata handling policy", () => {
  // Title with missing or empty genre metadata
  const missingGenres = { type: "movie", id: 5, title: "Mystery Indie Film" };
  const emptyGenres = { type: "tv", id: 6, title: "Obscure Pilot", genreIds: [] };

  // Included under "all"
  assert.equal(engine.matchesDiscoverFilters(missingGenres, { style: "all" }), true);
  assert.equal(engine.matchesDiscoverFilters(emptyGenres, { style: "all" }), true);

  // Excluded under specific style to prevent silent misclassification
  assert.equal(engine.matchesDiscoverFilters(missingGenres, { style: "animated" }), false);
  assert.equal(engine.matchesDiscoverFilters(missingGenres, { style: "live_action" }), false);
  assert.equal(engine.matchesDiscoverFilters(emptyGenres, { style: "animated" }), false);
  assert.equal(engine.matchesDiscoverFilters(emptyGenres, { style: "live_action" }), false);
});

test("6. Media-mode and style-filter combinations", () => {
  const seed = { type: "tv", id: 2190, title: "South Park", genreIds: [35, 16], overview: "Satire." };
  const candidates = [
    { type: "movie", id: 10, title: "Airplane!", genreIds: [35], overview: "Live action satire.", voteCount: 4000, voteAverage: 7.8 },
    { type: "movie", id: 11, title: "Shrek", genreIds: [16, 35, 14], overview: "Animated comedy.", voteCount: 12000, voteAverage: 7.7 },
    { type: "tv", id: 12, title: "The Simpsons", genreIds: [16, 35], overview: "Animated sitcom.", voteCount: 9000, voteAverage: 7.9 },
    { type: "tv", id: 13, title: "Veep", genreIds: [35], overview: "Political satire.", voteCount: 2000, voteAverage: 8.3 }
  ];

  // Target: movie + style: live_action -> only Airplane!
  const resMovieLive = engine.rankDiscoverCategories(seed, candidates, {
    targetMedia: "movie",
    filters: { style: "live_action" }
  });
  assert.equal(resMovieLive.totalCandidates, 1);
  const movieLiveTitles = [...resMovieLive.closest, ...resMovieLive.vibe, ...resMovieLive.genre, ...resMovieLive.gems].map(c => c.title);
  assert.ok(movieLiveTitles.includes("Airplane!"));
  assert.ok(!movieLiveTitles.includes("Shrek"));

  // Target: tv + style: animated -> only The Simpsons
  const resTvAnim = engine.rankDiscoverCategories(seed, candidates, {
    targetMedia: "tv",
    filters: { style: "animated" }
  });
  assert.equal(resTvAnim.totalCandidates, 1);
  const tvAnimTitles = [...resTvAnim.closest, ...resTvAnim.vibe, ...resTvAnim.genre, ...resTvAnim.gems].map(c => c.title);
  assert.ok(tvAnimTitles.includes("The Simpsons"));
  assert.ok(!tvAnimTitles.includes("Veep"));
});

test("7. Removed Discover filters no longer appear in Discover mode", () => {
  const html = readFileSync(new URL("../universal-search/index.html", import.meta.url), "utf8");
  const searchSource = readFileSync(new URL("../universal-search/search.js", import.meta.url), "utf8");

  // New style filter button exists
  assert.match(html, /id="filter-btn-style"/);

  // In search.js updateFilterStripUI, verify Length, Rating, Mode, Year, Sort are hidden when isDiscover
  assert.match(searchSource, /if \(modeBtn\) \{\s*modeBtn\.hidden = true;\s*\}/);
  assert.match(searchSource, /if \(lengthBtn\) \{\s*lengthBtn\.hidden = isDiscover;/);
  assert.match(searchSource, /if \(ratingBtn\) \{\s*ratingBtn\.hidden = isDiscover;/);
  assert.match(searchSource, /if \(yearBtn\) \{\s*yearBtn\.hidden = isDiscover;/);
  assert.match(searchSource, /if \(sortBtn\) \{\s*sortBtn\.hidden = isDiscover;/);
});

test("8. D-pad interaction with redesigned filter controls", () => {
  const searchSource = readFileSync(new URL("../universal-search/search.js", import.meta.url), "utf8");
  // ArrowLeft from chips[0] enters left rail with Home focused
  assert.match(searchSource, /if \(chipIdx > 0\) focus\(chips\[chipIdx - 1\]\);\s*else focus\(get\("watch-toggle"\)\);/);
  // ArrowRight moves to next chip
  assert.match(searchSource, /else if \(key === "ArrowRight" && chipIdx < chips\.length - 1\) \{\s*focus\(chips\[chipIdx \+ 1\]\);/);
});

test("9. Escape/Back closing dropdowns", () => {
  const searchSource = readFileSync(new URL("../universal-search/search.js", import.meta.url), "utf8");
  assert.match(searchSource, /if \(key === "Back"\) \{\s*event\.preventDefault\(\); if \(event\.repeat\) return;\s*if \(activeFilterMenuType\) \{\s*closeFilterMenu\(\);\s*return;\s*\}/);
});

test("10. Focus restoration from filter overlays", () => {
  const searchSource = readFileSync(new URL("../universal-search/search.js", import.meta.url), "utf8");
  assert.match(searchSource, /function closeFilterMenu\(\) \{\s*var prevType = activeFilterMenuType;\s*activeFilterMenuType = null;\s*var menu = get\("watch-filter-menu"\);\s*if \(menu\) menu\.hidden = true;\s*if \(prevType\) \{\s*var originatingBtn = get\("filter-btn-" \+ prevType\);\s*if \(originatingBtn\) focus\(originatingBtn\);\s*\}/);
});

test("11. Stable title and explanation geometry in CSS", () => {
  const css = readFileSync(new URL("../universal-search/search.css", import.meta.url), "utf8");
  // watch-hero-context has nowrap, overflow hidden, and bounded line-height
  assert.match(css, /body\.watch-active \.watch-hero-context\s*\{[^}]*white-space:\s*nowrap/);
  assert.match(css, /body\.watch-active \.watch-hero-context\s*\{[^}]*text-overflow:\s*ellipsis/);
  assert.match(css, /body\.watch-active \.watch-hero-context\s*\{[^}]*max-height:\s*1\.35em/);
  // card-match-reason has stable line-height and height
  assert.match(css, /body\.watch-active \.home-card \.card-match-reason\s*\{[^}]*height:\s*1\.25em/);
});

test("12. First-card left alignment on initial load", () => {
  const searchSource = readFileSync(new URL("../universal-search/search.js", import.meta.url), "utf8");
  // revealHomeWindow unconditionally resets attached[0] === cards[0] and scrollLeft = 0
  assert.match(searchSource, /if \(element === cards\[0\]\) \{\s*if \(attached\[0\] !== cards\[0\] \|\| row\.scrollLeft > 2 \|\| track\.style\.transform !== ""\)/);
});

test("13. No stale transform or focus memory after seed changes", () => {
  const searchSource = readFileSync(new URL("../universal-search/search.js", import.meta.url), "utf8");
  // Seed selection clears tabRowMemory and homeRowMemory
  assert.match(searchSource, /tabRowMemory\["discover"\] = Object\.create\(null\);/);
  assert.match(searchSource, /tabLastContent\["discover"\] = null;/);
});

test("14. Correct carousel geometry after filtering", () => {
  const searchSource = readFileSync(new URL("../universal-search/search.js", import.meta.url), "utf8");
  // style filter selection resets rowCycleIndex and re-renders
  assert.match(searchSource, /if \(filterType === "style"\) \{\s*discoverStyle = value \|\| "all";\s*discoverFilters\.style = discoverStyle;\s*closeFilterMenu\(\);\s*rowCycleIndex = Object\.create\(null\);/);
});

test("15. Correct first-card Left behavior", () => {
  const searchSource = readFileSync(new URL("../universal-search/search.js", import.meta.url), "utf8");
  assert.match(searchSource, /if \(rowCycleIndex\[groupName\] <= 0\) \{\s*focus\(get\("watch-toggle"\)\);\s*\} else \{/);
});

test("16. Forward looping without backward-cycle access", () => {
  const searchSource = readFileSync(new URL("../universal-search/search.js", import.meta.url), "utf8");
  assert.match(searchSource, /if \(index === group\.length - 1\) rowCycleIndex\[groupName\] = 0;\s*else rowCycleIndex\[groupName\] \+= 1;/);
  assert.match(searchSource, /rowCycleIndex\[groupName\] -= 1;\s*focus\(group\[circularIndex\(index, group\.length, -1\)\], true, -1\);/);
});

test("17. Rapid async response race protection", () => {
  const searchSource = readFileSync(new URL("../universal-search/search.js", import.meta.url), "utf8");
  assert.match(searchSource, /var token = \+\+discoverFetchToken;/);
  assert.match(searchSource, /if \(disposed \|\| token !== discoverFetchToken \|\| state\.view !== "watch"\) return;/);
});

test("18. One-title row behavior", () => {
  const seed = { type: "tv", id: 2190, title: "South Park", genreIds: [35] };
  const singleCandidate = [{ type: "tv", id: 60625, title: "Rick and Morty", genreIds: [35], voteCount: 5000, voteAverage: 8.5 }];
  const res = engine.rankDiscoverCategories(seed, singleCandidate);
  assert.equal(res.totalCandidates, 1);
  // Exactly 1 title placed across all rows
  const allTitles = [...res.closest, ...res.vibe, ...res.genre, ...res.gems];
  assert.equal(allTitles.length, 1);
  assert.equal(allTitles[0].title, "Rick and Morty");
});

test("19. Proper poster and title rendering in card creation", () => {
  const searchSource = readFileSync(new URL("../universal-search/search.js", import.meta.url), "utf8");
  assert.match(searchSource, /var reasonEl = doc\.createElement\("small"\);\s*reasonEl\.className = "card-match-reason";/);
  assert.match(searchSource, /card\.appendChild\(verticalPosterArt\(candidate, true\)\); card\.appendChild\(title\);/);
});

test("20. AI fallback and mode-security regression", () => {
  const workerSource = readFileSync(new URL("../universal-search-worker.js", import.meta.url), "utf8");
  // resolveAiMode ceiling enforcement
  assert.match(workerSource, /function resolveAiMode\(env, url, request, options = \{\}\)/);
  // formatSemanticDoc excludes Animation (16)
  assert.match(workerSource, /const genres = rawGenres\s*\.filter\(g => g && g !== "Animation" && g !== "16"\)/);
});

test("21. No duplicate canonical identities across Discover rows", () => {
  const seed = { type: "tv", id: 95396, title: "Severance", genreIds: [18, 9648, 10765], overview: "Dystopian office mystery." };
  const candidates = [];
  for (let i = 1; i <= 20; i++) {
    candidates.push({
      type: "tv", id: 1000 + i, title: `Show ${i}`,
      genreIds: [18, 9648], voteCount: 1000 + i * 100, voteAverage: 7.5 + (i % 10) * 0.1,
      overview: `Story about mystery and secret memories ${i}.`
    });
  }

  const res = engine.rankDiscoverCategories(seed, candidates);
  const seen = new Set();
  let duplicates = 0;
  for (const group of ["closest", "vibe", "genre", "gems"]) {
    for (const card of res[group]) {
      const key = `${card.type}:${card.id}`;
      if (seen.has(key)) duplicates++;
      seen.add(key);
    }
  }
  assert.equal(duplicates, 0, "Zero duplicate identities across all four Discover rows");
});
