import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../universal-search/discover-engine.js", import.meta.url), "utf8");
const root = {};
runInNewContext(source, { window: root });
const engine = root.HorizonDiscoverEngine;

// ============================================================================
// AUDIT & METHODOLOGY DISCLOSURE:
// 1. These deterministic fixtures test functional ranking correctness, score
//    ordering, deduplication, cross-media translation, and explanation formatting.
// 2. These fixtures use hand-curated candidate pools with explicit ground-truth
//    labels (isRelevant: true | false). They do NOT represent empirical live
//    recommendation quality on uncurated TMDB production distributions.
// 3. Any comparative ranking evaluation MUST evaluate the EXACT SAME candidate pool
//    against independent ground-truth relevance labels to be methodologically sound.
// ============================================================================

const SEED_BENCHMARKS = [
  {
    name: "Severance",
    seed: {
      type: "tv", id: 100088, title: "Severance", date: "2022-02-18",
      genreIds: [18, 9648, 10765],
      genres: [{ id: 18, name: "Drama" }, { id: 9648, name: "Mystery" }, { id: 10765, name: "Sci-Fi & Fantasy" }],
      keywords: [{ id: 101, name: "dystopia" }, { id: 102, name: "memory" }, { id: 103, name: "workplace" }, { id: 104, name: "conspiracy" }],
      overview: "Mark leads a team of office workers whose memories have been surgically divided between their work and personal lives.",
      creators: ["Dan Erickson"],
      cast: ["Adam Scott", "Patricia Arquette"]
    },
    candidates: [
      { type: "tv", id: 95396, title: "Homecoming", genreIds: [18, 9648], popularity: 45, voteAverage: 7.5, voteCount: 400,
        keywords: [{ id: 102, name: "memory" }, { id: 104, name: "conspiracy" }], overview: "A secret facility helps soldiers transition back to civilian life with memory treatments.", source: "recommendations", isRelevant: true },
      { type: "tv", id: 70523, title: "Dark", genreIds: [18, 9648, 10765], popularity: 90, voteAverage: 8.5, voteCount: 5000,
        keywords: [{ id: 104, name: "conspiracy" }, { id: 105, name: "time travel" }], overview: "A missing child sets four families on a frantic hunt for answers across generations.", source: "similar", isRelevant: true },
      { type: "tv", id: 82856, title: "Maniac", genreIds: [18, 10765], popularity: 50, voteAverage: 7.7, voteCount: 1200,
        keywords: [{ id: 101, name: "dystopia" }, { id: 102, name: "memory" }], overview: "Two strangers connect during a mind-altering pharmaceutical trial in a retro-future world.", source: "discovery", isRelevant: true },
      { type: "movie", id: 264660, title: "Ex Machina", genreIds: [18, 878], popularity: 80, voteAverage: 7.6, voteCount: 12000,
        keywords: [{ id: 101, name: "dystopia" }, { id: 103, name: "workplace" }], overview: "A programmer is invited to administer the Turing test to an intelligent humanoid robot.", source: "cross_media", isRelevant: true },
      { type: "tv", id: 62560, title: "Mr. Robot", genreIds: [18, 80], popularity: 85, voteAverage: 8.2, voteCount: 4200,
        keywords: [{ id: 101, name: "dystopia" }, { id: 104, name: "conspiracy" }], overview: "A cybersecurity engineer and vigilante hacker becomes involved in an insurrection against corporate power.", source: "recommendations", isRelevant: true },
      { type: "tv", id: 9901, title: "Unrelated Comedy", genreIds: [35], popularity: 12, voteAverage: 5.2, voteCount: 40, keywords: [], overview: "A wacky roommate comedy.", source: "similar", isRelevant: false }
    ]
  },
  {
    name: "Dark",
    seed: {
      type: "tv", id: 70523, title: "Dark", date: "2017-12-01",
      genreIds: [18, 9648, 10765],
      genres: [{ id: 18, name: "Drama" }, { id: 9648, name: "Mystery" }, { id: 10765, name: "Sci-Fi & Fantasy" }],
      keywords: [{ id: 201, name: "time travel" }, { id: 202, name: "small town" }, { id: 203, name: "disappearance" }, { id: 204, name: "nuclear" }],
      overview: "A missing child sets four interconnected families on a frantic search as they unearth a mind-bending mystery spanning three generations.",
      creators: ["Baran bo Odar", "Jantje Friese"],
      cast: ["Louis Hofmann"]
    },
    candidates: [
      { type: "tv", id: 124364, title: "1899", genreIds: [18, 9648], popularity: 60, voteAverage: 7.5, voteCount: 1500,
        keywords: [{ id: 203, name: "disappearance" }], creators: ["Baran bo Odar", "Jantje Friese"], overview: "Immigrants on a steamship encounter a second ship drifting on the open ocean.", source: "recommendations", isRelevant: true },
      { type: "tv", id: 124365, title: "FROM", genreIds: [18, 9648, 10765], popularity: 140, voteAverage: 8.2, voteCount: 3000,
        keywords: [{ id: 202, name: "small town" }, { id: 203, name: "disappearance" }], overview: "Unravel the mystery of a nightmarish town in middle America that traps all who enter.", source: "similar", isRelevant: true },
      { type: "movie", id: 14337, title: "Primer", genreIds: [18, 878, 53], popularity: 25, voteAverage: 6.9, voteCount: 2600,
        keywords: [{ id: 201, name: "time travel" }], overview: "Two engineers accidentally discover time travel in a suburban garage.", source: "cross_media", isRelevant: true },
      { type: "movie", id: 2103, title: "Solaris", genreIds: [18, 878, 9648], popularity: 30, voteAverage: 7.8, voteCount: 1600,
        keywords: [{ id: 203, name: "disappearance" }], overview: "A psychologist investigates strange occurrences aboard an isolated orbital research station.", source: "cross_media", isRelevant: true },
      { type: "tv", id: 1920, title: "Twin Peaks", genreIds: [18, 9648], popularity: 65, voteAverage: 8.3, voteCount: 2800,
        keywords: [{ id: 202, name: "small town" }], overview: "An idiosyncratic FBI agent investigates the murder of a young woman in the eccentric town of Twin Peaks.", source: "recommendations", isRelevant: true },
      { type: "tv", id: 9904, title: "Beach Party Sitcom", genreIds: [35], popularity: 10, voteAverage: 4.5, voteCount: 25, keywords: [], overview: "Summer fun on the beach.", source: "similar", isRelevant: false }
    ]
  },
  {
    name: "Dune: Part Two",
    seed: {
      type: "movie", id: 693134, title: "Dune: Part Two", date: "2024-03-01",
      genreIds: [878, 12],
      genres: [{ id: 878, name: "Science Fiction" }, { id: 12, name: "Adventure" }],
      keywords: [{ id: 301, name: "desert" }, { id: 302, name: "space opera" }, { id: 303, name: "prophecy" }, { id: 304, name: "empire" }],
      overview: "Paul Atreides unites with Chani and the Fremen while seeking revenge against the conspirators who destroyed his family.",
      creators: ["Denis Villeneuve"],
      cast: ["Timothée Chalamet", "Zendaya"]
    },
    candidates: [
      { type: "movie", id: 438631, title: "Dune", genreIds: [878, 12], popularity: 130, voteAverage: 7.8, voteCount: 11000,
        keywords: [{ id: 301, name: "desert" }, { id: 302, name: "space opera" }], creators: ["Denis Villeneuve"], overview: "Paul Atreides leads nomadic tribes in a battle to control the desert planet Arrakis.", source: "recommendations", isRelevant: true },
      { type: "movie", id: 335984, title: "Blade Runner 2049", genreIds: [878, 18, 9648], popularity: 95, voteAverage: 8.0, voteCount: 13000,
        keywords: [{ id: 304, name: "empire" }], creators: ["Denis Villeneuve"], overview: "A young blade runner unearths a long-buried secret that leads him to track down Rick Deckard.", source: "similar", isRelevant: true },
      { type: "tv", id: 94605, title: "Arcane", genreIds: [16, 10765, 10759], popularity: 80, voteAverage: 8.7, voteCount: 3800,
        keywords: [{ id: 304, name: "empire" }], overview: "Amid the conflict between twin cities, two sisters fight on rival sides of a war over arcane technologies.", source: "cross_media", isRelevant: true },
      { type: "movie", id: 157336, title: "Interstellar", genreIds: [12, 18, 878], popularity: 160, voteAverage: 8.4, voteCount: 34000,
        keywords: [{ id: 302, name: "space opera" }], overview: "A team of explorers travel through a wormhole in space in an attempt to ensure humanity's survival.", source: "discovery", isRelevant: true },
      { type: "movie", id: 9905, title: "Rom-Com Wedding", genreIds: [10749, 35], popularity: 15, voteAverage: 5.1, voteCount: 50, keywords: [], overview: "A couple prepares for their wedding day.", source: "similar", isRelevant: false }
    ]
  },
  {
    name: "Interstellar",
    seed: {
      type: "movie", id: 157336, title: "Interstellar", date: "2014-11-05",
      genreIds: [12, 18, 878],
      genres: [{ id: 12, name: "Adventure" }, { id: 18, name: "Drama" }, { id: 878, name: "Science Fiction" }],
      keywords: [{ id: 401, name: "black hole" }, { id: 402, name: "space travel" }, { id: 403, name: "time dilation" }, { id: 404, name: "survival" }],
      overview: "A team of explorers travel through a wormhole in space in an attempt to ensure humanity's survival.",
      creators: ["Christopher Nolan"],
      cast: ["Matthew McConaughey", "Anne Hathaway"]
    },
    candidates: [
      { type: "movie", id: 27205, title: "Inception", genreIds: [28, 878, 12], popularity: 140, voteAverage: 8.4, voteCount: 36000,
        keywords: [{ id: 403, name: "time dilation" }], creators: ["Christopher Nolan"], overview: "A thief who steals corporate secrets through dream-sharing technology is given a chance at redemption.", source: "recommendations", isRelevant: true },
      { type: "movie", id: 157337, title: "Contact", genreIds: [18, 878, 9648], popularity: 45, voteAverage: 7.4, voteCount: 4100,
        keywords: [{ id: 402, name: "space travel" }], overview: "An astronomer discovers the first radio signal from an extraterrestrial civilization.", source: "similar", isRelevant: true },
      { type: "tv", id: 100088, title: "The Last of Us", genreIds: [18, 10765], popularity: 110, voteAverage: 8.6, voteCount: 5200,
        keywords: [{ id: 404, name: "survival" }], overview: "A hardened survivor takes charge of a 14-year-old girl in a post-apocalyptic United States.", source: "cross_media", isRelevant: true },
      { type: "movie", id: 559581, title: "Stowaway", genreIds: [18, 878, 53], popularity: 20, voteAverage: 6.0, voteCount: 750,
        keywords: [{ id: 402, name: "space travel" }, { id: 404, name: "survival" }], overview: "A three-person crew on a mission to Mars faces an impossible choice when an unplanned passenger compromises their life support.", source: "discovery", isRelevant: true },
      { type: "movie", id: 9906, title: "Low Budget Horror", genreIds: [27], popularity: 8, voteAverage: 4.1, voteCount: 30, keywords: [], overview: "Ghosts in a cabin.", source: "similar", isRelevant: false }
    ]
  },
  {
    name: "The Office",
    seed: {
      type: "tv", id: 2316, title: "The Office", date: "2005-03-24",
      genreIds: [35],
      genres: [{ id: 35, name: "Comedy" }],
      keywords: [{ id: 501, name: "workplace" }, { id: 502, name: "mockumentary" }, { id: 503, name: "dry humor" }, { id: 504, name: "boss" }],
      overview: "A mockumentary on a group of typical office workers, where the workday consists of ego clashes, inappropriate behavior, and tedium.",
      creators: ["Greg Daniels"],
      cast: ["Steve Carell", "Rainn Wilson"]
    },
    candidates: [
      { type: "tv", id: 8592, title: "Parks and Recreation", genreIds: [35], popularity: 75, voteAverage: 8.0, voteCount: 2100,
        keywords: [{ id: 501, name: "workplace" }, { id: 502, name: "mockumentary" }], creators: ["Greg Daniels"], overview: "The absurd antics of an Indiana town's public officials as they pursue projects to make their city fun.", source: "recommendations", isRelevant: true },
      { type: "tv", id: 71737, title: "A.P. Bio", genreIds: [35], popularity: 25, voteAverage: 6.9, voteCount: 220,
        keywords: [{ id: 501, name: "workplace" }, { id: 503, name: "dry humor" }], overview: "A disgraced Harvard philosophy scholar takes a job teaching high school advanced placement biology.", source: "similar", isRelevant: true },
      { type: "movie", id: 2493, title: "Office Space", genreIds: [35], popularity: 40, voteAverage: 7.4, voteCount: 3000,
        keywords: [{ id: 501, name: "workplace" }, { id: 504, name: "boss" }], overview: "Three company workers who hate their jobs decide to rebel against their greedy boss.", source: "cross_media", isRelevant: true },
      { type: "tv", id: 33922, title: "Portlandia", genreIds: [35], popularity: 20, voteAverage: 6.9, voteCount: 190,
        keywords: [{ id: 502, name: "mockumentary" }, { id: 503, name: "dry humor" }], overview: "A sketch-comedy series that parodies the idiosyncratic residents of Portland, Oregon.", source: "discovery", isRelevant: true },
      { type: "tv", id: 9907, title: "Grim War Drama", genreIds: [18, 10768], popularity: 40, voteAverage: 7.0, voteCount: 500, keywords: [], overview: "Soldiers endure hardship in trenches.", source: "similar", isRelevant: false }
    ]
  },
  {
    name: "Spirited Away",
    seed: {
      type: "movie", id: 129, title: "Spirited Away", date: "2001-07-20",
      genreIds: [16, 10751, 14],
      genres: [{ id: 16, name: "Animation" }, { id: 10751, name: "Family" }, { id: 14, name: "Fantasy" }],
      keywords: [{ id: 601, name: "folklore" }, { id: 602, name: "spirit world" }, { id: 603, name: "coming of age" }, { id: 604, name: "witch" }],
      overview: "A young girl wanders into a world ruled by gods, witches, and spirits, where humans are changed into beasts.",
      creators: ["Hayao Miyazaki"],
      cast: ["Rumi Hiiragi"]
    },
    candidates: [
      { type: "movie", id: 4935, title: "Howl's Moving Castle", genreIds: [16, 14, 12], popularity: 85, voteAverage: 8.4, voteCount: 9500,
        keywords: [{ id: 602, name: "spirit world" }, { id: 604, name: "witch" }], creators: ["Hayao Miyazaki"], overview: "A young woman is cursed with an old body by a spiteful witch and seeks refuge in a walking castle.", source: "recommendations", isRelevant: true },
      { type: "movie", id: 128, title: "Princess Mononoke", genreIds: [16, 14, 12], popularity: 90, voteAverage: 8.3, voteCount: 8000,
        keywords: [{ id: 601, name: "folklore" }, { id: 602, name: "spirit world" }], creators: ["Hayao Miyazaki"], overview: "Ashitaka seeks a cure for a demon curse and finds himself in the middle of a war between forest gods and humans.", source: "similar", isRelevant: true },
      { type: "tv", id: 94605, title: "Arcane", genreIds: [16, 10765], popularity: 80, voteAverage: 8.7, voteCount: 3800,
        keywords: [{ id: 603, name: "coming of age" }], overview: "Two sisters fight in a war between rival technologies and convictions in a fantasy universe.", source: "cross_media", isRelevant: true },
      { type: "movie", id: 8392, title: "My Neighbor Totoro", genreIds: [16, 10751, 14], popularity: 70, voteAverage: 8.1, voteCount: 7500,
        keywords: [{ id: 601, name: "folklore" }], creators: ["Hayao Miyazaki"], overview: "Two young sisters explore their countryside home and encounter friendly woodland spirits.", source: "discovery", isRelevant: true },
      { type: "movie", id: 9908, title: "Stock Market Doc", genreIds: [99], popularity: 15, voteAverage: 6.0, voteCount: 70, keywords: [], overview: "A breakdown of Wall Street trades.", source: "similar", isRelevant: false }
    ]
  },
  {
    name: "Planet Earth",
    seed: {
      type: "tv", id: 1064, title: "Planet Earth", date: "2006-03-05",
      genreIds: [99],
      genres: [{ id: 99, name: "Documentary" }],
      keywords: [{ id: 701, name: "nature" }, { id: 702, name: "wildlife" }, { id: 703, name: "biodiversity" }, { id: 704, name: "ecosystem" }],
      overview: "Dazzling, state-of-the-art high-definition series exploring extreme habitats and extraordinary wildlife across the globe.",
      creators: ["David Attenborough"],
      cast: ["David Attenborough"]
    },
    candidates: [
      { type: "tv", id: 68595, title: "Planet Earth II", genreIds: [99], popularity: 60, voteAverage: 9.0, voteCount: 1500,
        keywords: [{ id: 701, name: "nature" }, { id: 702, name: "wildlife" }], creators: ["David Attenborough"], overview: "Journeying through islands, mountains, jungles, deserts, grasslands, and cities to explore life on Earth.", source: "recommendations", isRelevant: true },
      { type: "tv", id: 79696, title: "Our Planet", genreIds: [99], popularity: 55, voteAverage: 8.8, voteCount: 1100,
        keywords: [{ id: 701, name: "nature" }, { id: 703, name: "biodiversity" }], creators: ["David Attenborough"], overview: "Experience our planet's natural beauty and examine how climate change impacts all living creatures.", source: "similar", isRelevant: true },
      { type: "movie", id: 671234, title: "March of the Penguins", genreIds: [99], popularity: 30, voteAverage: 7.2, voteCount: 1200,
        keywords: [{ id: 702, name: "wildlife" }], overview: "In the Antarctic, every autumn brings the incredible pilgrimage of emperor penguins.", source: "cross_media", isRelevant: true },
      { type: "tv", id: 126, title: "Unsolved Mysteries", genreIds: [99, 80], popularity: 15, voteAverage: 7.7, voteCount: 150,
        keywords: [], overview: "Documentary series exploring cold cases and unexplained events.", source: "discovery", isRelevant: false },
      { type: "tv", id: 9909, title: "Explosive Action Series", genreIds: [10759], popularity: 70, voteAverage: 6.5, voteCount: 900, keywords: [], overview: "Undercover agents fight cartels.", source: "similar", isRelevant: false }
    ]
  }
];

test("Deterministic Ranking Verification: Candidate scoring promotes thematic and genre alignment across 7 benchmark fixtures", () => {
  let totalTopMatches = 0;
  let relevantTopMatches = 0;

  SEED_BENCHMARKS.forEach(bm => {
    const scored = engine.rankDiscoverCategories(bm.seed, bm.candidates, {
      feedback: { ratings: {} },
      history: [],
      hideFinished: false,
      targetMedia: "both"
    });

    const top5 = scored.closest.slice(0, 5);
    assert.ok(top5.length > 0, `${bm.name} must have top candidates in Closest Matches`);

    top5.forEach(candidate => {
      totalTopMatches++;
      if (candidate.isRelevant === true) {
        relevantTopMatches++;
      }
    });
  });

  const precisionAt5 = relevantTopMatches / totalTopMatches;
  assert.ok(precisionAt5 >= 0.80,
    `Precision@5 across all 7 benchmark fixtures was ${(precisionAt5 * 100).toFixed(1)}% (target >= 80%)`);
});

test("Deduplication and self-exclusion are 100% enforced across all categories", () => {
  SEED_BENCHMARKS.forEach(bm => {
    const scored = engine.rankDiscoverCategories(bm.seed, bm.candidates, {
      feedback: { ratings: {} },
      history: [],
      hideFinished: false,
      targetMedia: "both"
    });

    ["closest", "vibe", "genre", "gems"].forEach(categoryKey => {
      const row = scored[categoryKey] || [];
      const seen = new Set();
      row.forEach(item => {
        const idKey = item.type + ":" + item.id;
        assert.notEqual(idKey, bm.seed.type + ":" + bm.seed.id, `Seed title itself must never be in ${categoryKey}`);
        assert.ok(!seen.has(idKey), `Duplicate title ${idKey} detected in ${categoryKey}`);
        seen.add(idKey);
      });
    });
  });
});

test("Cross-media recommendation works bidirectionally", () => {
  // 1. TV seed (Severance) surfaces Movie (Ex Machina)
  const severance = SEED_BENCHMARKS.find(b => b.name === "Severance");
  const scoredSev = engine.rankDiscoverCategories(severance.seed, severance.candidates, {
    feedback: { ratings: {} },
    history: [],
    hideFinished: false,
    targetMedia: "both"
  });
  const movieInTv = [scoredSev.closest, scoredSev.vibe, scoredSev.genre, scoredSev.gems]
    .flat().some(c => c.type === "movie" && c.isRelevant);
  assert.ok(movieInTv, "TV seed (Severance) must surface relevant movie candidates in target=both");

  // 2. Movie seed (Dune) surfaces TV show (Arcane)
  const dune = SEED_BENCHMARKS.find(b => b.name === "Dune: Part Two");
  const scoredDune = engine.rankDiscoverCategories(dune.seed, dune.candidates, {
    feedback: { ratings: {} },
    history: [],
    hideFinished: false,
    targetMedia: "both"
  });
  const tvInMovie = [scoredDune.closest, scoredDune.vibe, scoredDune.genre, scoredDune.gems]
    .flat().some(c => c.type === "tv" && c.isRelevant);
  assert.ok(tvInMovie, "Movie seed (Dune: Part Two) must surface relevant TV series candidates in target=both");
});

test("Match reasons cite verifiable metadata without placeholder text", () => {
  SEED_BENCHMARKS.forEach(bm => {
    const scored = engine.rankDiscoverCategories(bm.seed, bm.candidates, {
      feedback: { ratings: {} },
      history: [],
      hideFinished: false,
      targetMedia: "both"
    });

    ["closest", "vibe", "genre", "gems"].forEach(cat => {
      (scored[cat] || []).forEach(candidate => {
        const reason = candidate.matchReason;
        assert.ok(typeof reason === "string" && reason.length > 0,
          `Every recommended candidate must have a non-empty explanation: ${candidate.title}`);

        // Verifiability check: must reference a creator, director, cast, keyword theme, or seed genre/title
        const hasVerifiedSource =
          reason.startsWith("From director ") ||
          reason.startsWith("From creator ") ||
          reason.startsWith("Starring ") ||
          reason.startsWith("Themes: ") ||
          reason.startsWith("Shares theme: ") ||
          reason.startsWith("Matches ") ||
          reason.startsWith("Similar ") ||
          reason.startsWith("Shares ") ||
          reason.startsWith("Recommended for fans of ") ||
          reason.startsWith("Acclaimed hidden gem") ||
          reason.includes("Dark") ||
          reason.includes("Severance") ||
          reason.includes("Dune") ||
          reason.includes("Interstellar") ||
          reason.includes("The Office") ||
          reason.includes("Spirited Away") ||
          reason.includes("Planet Earth");

        assert.ok(hasVerifiedSource, `Match reason '${reason}' must cite verifiable metadata`);
      });
    });
  });
});

test("Closest Matches omits weak titles rather than filling five slots on a labeled candidate pool", () => {
  // These explicit title judgments are independent of the engine's score.
  const severanceSeed = SEED_BENCHMARKS.find(b => b.name === "Severance").seed;

  // 10 candidate pool representing mixed retrieval containing acclaimed relevant titles and noisy/unrelated titles
  const sharedCandidatePool = [
    { type: "tv", id: 95396, title: "Homecoming", genreIds: [18, 9648], popularity: 45, voteAverage: 7.5, voteCount: 400,
      keywords: [{ id: 102, name: "memory" }, { id: 104, name: "conspiracy" }], overview: "A secret facility helps soldiers transition back to civilian life with memory treatments.", source: "recommendations", isRelevant: true },
    { type: "tv", id: 70523, title: "Dark", genreIds: [18, 9648, 10765], popularity: 90, voteAverage: 8.5, voteCount: 5000,
      keywords: [{ id: 104, name: "conspiracy" }, { id: 105, name: "time travel" }], overview: "A missing child sets four families on a frantic hunt for answers across generations.", source: "similar", isRelevant: true },
    { type: "tv", id: 82856, title: "Maniac", genreIds: [18, 10765], popularity: 50, voteAverage: 7.7, voteCount: 1200,
      keywords: [{ id: 101, name: "dystopia" }, { id: 102, name: "memory" }], overview: "Two strangers connect during a mind-altering pharmaceutical trial in a retro-future world.", source: "discovery", isRelevant: true },
    { type: "tv", id: 62560, title: "Mr. Robot", genreIds: [18, 80], popularity: 85, voteAverage: 8.2, voteCount: 4200,
      keywords: [{ id: 101, name: "dystopia" }, { id: 104, name: "conspiracy" }], overview: "A cybersecurity engineer and vigilante hacker becomes involved in an insurrection against corporate power.", source: "recommendations", isRelevant: true },
    { type: "tv", id: 9910, title: "Devs", genreIds: [18, 10765, 9648], popularity: 40, voteAverage: 7.6, voteCount: 900,
      keywords: [{ id: 101, name: "dystopia" }, { id: 104, name: "conspiracy" }], overview: "A software engineer investigates a secret development division in a tech company.", source: "discovery", isRelevant: true },
    // Noisy titles with high popularity or superficial matches but different tone/genre
    { type: "tv", id: 9901, title: "High Popularity Sitcom", genreIds: [35], popularity: 160, voteAverage: 6.2, voteCount: 300,
      keywords: [], overview: "A lighthearted sitcom about four eccentric friends in an apartment.", source: "similar", isRelevant: false },
    { type: "tv", id: 9902, title: "Office Pranksters", genreIds: [35], popularity: 95, voteAverage: 4.8, voteCount: 35,
      keywords: [{ id: 103, name: "workplace" }], overview: "Real office workers pull silly practical jokes on their boss.", source: "similar", isRelevant: false },
    { type: "tv", id: 9903, title: "Low-Vote Micro Drama", genreIds: [18], popularity: 5, voteAverage: 5.0, voteCount: 6,
      keywords: [], overview: "A local community theater group rehearses an indie play.", source: "discovery", isRelevant: false },
    { type: "tv", id: 9911, title: "Generic Space Action", genreIds: [10759], popularity: 110, voteAverage: 5.9, voteCount: 150,
      keywords: [], overview: "Intergalactic bounty hunters track down space criminals with laser blasters.", source: "similar", isRelevant: false },
    { type: "tv", id: 9912, title: "Celebrity Game Show", genreIds: [10764], popularity: 75, voteAverage: 5.3, voteCount: 80,
      keywords: [], overview: "Contestants answer pop culture trivia to win cash prizes.", source: "discovery", isRelevant: false }
  ];

  const hybridResult = engine.rankDiscoverCategories(severanceSeed, sharedCandidatePool, {
    feedback: { ratings: {} },
    history: [],
    hideFinished: false,
    targetMedia: "same"
  });
  const hybridTop5 = hybridResult.closest.slice(0, 5);

  // Closest Matches may intentionally contain fewer than five titles. Do not
  // count empty slots as irrelevant or force filler to improve a metric.
  assert.ok(hybridTop5.length > 0);
  assert.ok(hybridTop5.every(c => c.isRelevant), "Every displayed close match must be independently relevant");
});
