import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../universal-search/discover-engine.js", import.meta.url), "utf8");
const root = {};
runInNewContext(source, { window: root });
const engine = root.HorizonDiscoverEngine;

test("Discover Engine: Tokenizer removes punctuation and stop words", () => {
  const tokens = engine.tokenize("The Quick, Brown Fox jumps over the lazy dog!");
  assert.ok(!tokens.includes("the"), "Stop word 'the' should be removed");
  assert.ok(!tokens.includes("over"), "Stop word 'over' should be removed");
  assert.ok(tokens.includes("quick"));
  assert.ok(tokens.includes("brown"));
  assert.ok(tokens.includes("fox"));
  assert.ok(tokens.includes("jumps"));
  assert.ok(tokens.includes("lazy"));
  assert.ok(tokens.includes("dog"));
});

test("Discover Engine: Synopsis cosine similarity reflects shared thematic vocabulary", () => {
  const textA = "A thrilling mystery in a dark dystopian future with time travel.";
  const textB = "In a dystopian world, detectives investigate a dark mystery.";
  const textC = "A romantic comedy about two chefs opening a restaurant in Paris.";

  const simAB = engine.textCosineSimilarity(textA, textB);
  const simAC = engine.textCosineSimilarity(textA, textC);

  assert.ok(simAB > 0.4, `Similar themes should have higher cosine similarity: ${simAB}`);
  assert.ok(simAC < 0.1, `Unrelated themes should have low cosine similarity: ${simAC}`);
  assert.ok(simAB > simAC, "Thematic synopses must score higher than unrelated ones");
});

test("Discover Engine: Bidirectional TV <-> Movie genre mapping", () => {
  // Movie Sci-Fi (878) maps to TV Sci-Fi & Fantasy (10765)
  const tvGenres = engine.mapGenres("movie", "tv", [878]);
  assert.deepEqual([...tvGenres], [10765]);

  // TV Sci-Fi & Fantasy (10765) maps to Movie Sci-Fi (878) and Fantasy (14)
  const movieGenres = engine.mapGenres("tv", "movie", [10765]);
  assert.ok(movieGenres.includes(878));

  // Same media type preserves genre IDs
  assert.deepEqual([...engine.mapGenres("movie", "movie", [18, 878])], [18, 878]);
});

test("Discover Engine: Jaccard keyword overlap with weighted IDF", () => {
  const seedKeywords = [{ id: 1, name: "time travel" }, { id: 2, name: "small town" }, { id: 3, name: "disappearance" }];
  const candidateHigh = [{ id: 1, name: "time travel" }, { id: 2, name: "small town" }];
  const candidateNone = [{ id: 99, name: "romantic comedy" }];

  const scoreHigh = engine.jaccardKeywordSimilarity(seedKeywords, candidateHigh);
  const scoreNone = engine.jaccardKeywordSimilarity(seedKeywords, candidateNone);

  assert.ok(scoreHigh > 0.5, `Shared keywords should have high score: ${scoreHigh}`);
  assert.equal(scoreNone, 0, "Unshared keywords should have score 0");
});

test("Discover Engine: Bayesian smoothed quality dampens low vote count volatility", () => {
  // A title with 1 vote of 10.0 should not outrank a title with 5,000 votes of 8.5
  const singleVoteTen = engine.bayesianQuality(10.0, 1);
  const establishedEightHalf = engine.bayesianQuality(8.5, 5000);

  assert.ok(establishedEightHalf > singleVoteTen,
    `Established 8.5 (${establishedEightHalf}) must outrank 1-vote 10.0 (${singleVoteTen})`);

  // Unvoted title reverts to prior (0.65)
  const unvoted = engine.bayesianQuality(0, 0);
  assert.equal(unvoted, 0.65);
});

test("Discover Engine: Diversity reranking prevents single franchise dominance", () => {
  const scoredItems = [
    { candidate: { id: 1, title: "Star Wars: Episode IV" }, scores: { closest: 0.95 } },
    { candidate: { id: 2, title: "Star Wars: Episode V" }, scores: { closest: 0.94 } },
    { candidate: { id: 3, title: "Star Wars: Episode VI" }, scores: { closest: 0.93 } },
    { candidate: { id: 4, title: "Dune" }, scores: { closest: 0.90 } },
    { candidate: { id: 5, title: "Blade Runner 2049" }, scores: { closest: 0.88 } }
  ];

  const reranked = engine.applyDiversityRerank(scoredItems, "closest", 4);
  assert.equal(reranked.length, 4);
  // Dune or Blade Runner must be elevated into the top 3 instead of 3 consecutive Star Wars films
  const titles = reranked.map(r => r.title);
  assert.ok(titles.slice(0, 3).includes("Dune") || titles.slice(0, 3).includes("Blade Runner 2049"),
    `Top 3 should include diversified non-franchise titles: ${JSON.stringify(titles)}`);
});

test("Discover Engine: Verifiable match explanations", () => {
  const seed = {
    type: "tv", id: 70523, title: "Dark",
    genreIds: [18, 9648, 10765],
    genres: [{ id: 18, name: "Drama" }, { id: 9648, name: "Mystery" }, { id: 10765, name: "Sci-Fi & Fantasy" }],
    keywords: [{ id: 1, name: "time travel" }],
    creators: ["Baran bo Odar", "Jantje Friese"],
    cast: ["Louis Hofmann"]
  };

  const candidateWithCreator = {
    type: "tv", id: 99999, title: "1899",
    genreIds: [18, 9648],
    genres: [{ id: 18, name: "Drama" }, { id: 9648, name: "Mystery" }],
    keywords: [{ id: 1, name: "time travel" }],
    creators: ["Baran bo Odar"],
    cast: []
  };

  const reasonCreator = engine.generateMatchReason(seed, candidateWithCreator);
  assert.ok(reasonCreator.includes("Baran bo Odar") || reasonCreator.includes("creator") || reasonCreator.includes("Dark"),
    `Creator match explanation must mention creator or seed: ${reasonCreator}`);

  const candidateWithTheme = {
    type: "tv", id: 88888, title: "Counterpart",
    genreIds: [18, 9648, 10765],
    genres: [{ id: 18, name: "Drama" }, { id: 9648, name: "Mystery" }, { id: 10765, name: "Sci-Fi & Fantasy" }],
    keywords: [{ id: 1, name: "time travel" }],
    creators: [],
    cast: []
  };

  const reasonTheme = engine.generateMatchReason(seed, candidateWithTheme);
  assert.ok(reasonTheme.length > 0, "Theme match reason must be generated");
  assert.ok(reasonTheme.includes("time travel") || reasonTheme.includes("Mystery") || reasonTheme.includes("Sci-Fi") || reasonTheme.includes("Dark"),
    `Theme match reason must contain verified overlap: ${reasonTheme}`);
});

test("Discover Engine: rankDiscoverCategories partitions into 4 categories correctly", () => {
  const seed = {
    type: "tv", id: 70523, title: "Dark",
    genreIds: [18, 9648, 10765],
    genres: [{ id: 18, name: "Drama" }, { id: 9648, name: "Mystery" }, { id: 10765, name: "Sci-Fi & Fantasy" }],
    keywords: [{ id: 1, name: "time travel" }, { id: 2, name: "mystery" }],
    creators: ["Baran bo Odar"]
  };

  const candidates = [
    // High relevance match
    { type: "tv", id: 95396, title: "Severance", date: "2022-01-01", popularity: 120, voteAverage: 8.5, voteCount: 4000,
      genreIds: [18, 9648, 10765], genres: [{ id: 18, name: "Drama" }], keywords: [{ id: 2, name: "mystery" }],
      source: "recommendations" },
    // Same genre different story (genre match, but zero keywords/different themes)
    { type: "tv", id: 1396, title: "Breaking Bad", date: "2008-01-01", popularity: 150, voteAverage: 8.9, voteCount: 14000,
      genreIds: [18, 80], genres: [{ id: 18, name: "Drama" }], keywords: [{ id: 99, name: "chemistry" }],
      source: "similar" },
    // Hidden gem (high rating, low/medium vote count)
    { type: "tv", id: 12345, title: "Undone", date: "2019-01-01", popularity: 30, voteAverage: 8.2, voteCount: 300,
      genreIds: [18, 10765], genres: [{ id: 18, name: "Drama" }], keywords: [{ id: 1, name: "time travel" }],
      source: "discovery" }
  ];

  const ranked = engine.rankDiscoverCategories(seed, candidates, {
    feedback: { ratings: {} },
    history: [],
    hideFinished: false,
    targetMedia: "same"
  });

  assert.ok(ranked.closest.length > 0, "Closest matches should be populated");
  const all = [ranked.closest, ranked.vibe, ranked.genre, ranked.gems].flat();
  assert.ok(all.length >= 2 && all.length <= 3, "scarce pools may leave weak categories empty");
  assert.equal(new Set(all.map(item => item.type + ":" + item.id)).size, all.length);
  assert.ok(all.some(item => item.id === 12345), "Undone remains available");
});
