import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { api } from "../universal-search-worker.js";

const window = {};
for (const file of ["core.js", "recommendations.js", "mock-data.js"])
  runInNewContext(readFileSync(new URL("../universal-search/" + file, import.meta.url), "utf8"),
    { window, URL, URLSearchParams, Map, Date });
const core = window.HorizonSearchCore, engine = window.HorizonWatchRecommendations;
const mock = window.HorizonSearchMock;
const now = 1_800_000_000_000;
const progress = (at, completed = false) => ({ position: completed ? 1000 : 300, duration: 1000,
  updatedAt: at, provider: "vidbolt", completed });
function store(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value) };
}
const row = (type, id, title, at, completed = false, season = 1, episode = 1) =>
  core.item(type, id, title, type === "tv" ? season : null, type === "tv" ? episode : null,
    "off", at, { progress: progress(at, completed) });
const candidate = (type, id, title, genreIds, sources = [{ kind: "trending" }], more = {}) =>
  ({ type, id, title, poster: "/poster.jpg", genreIds, keywordIds: [], sources, popularity: 50, voteCount: 500,
    voteAverage: 7, ...more });
const source = (kind, seed) => ({ kind, seed });

test("versioned ratings are mutually exclusive, clearable, upgrade safe, and never touch history", () => {
  const storage = store();
  core.writeHistory(storage, row("movie", 1, "A", now - 1000));
  const oldHistory = storage.getItem(core.HISTORY_KEY);
  assert.equal(engine.setFeedback(storage, "movie", 1, "liked"), true);
  assert.equal(engine.setFeedback(storage, "movie", 1, "disliked"), true);
  assert.deepEqual(JSON.parse(JSON.stringify(engine.readFeedback(storage).ratings)), { "movie:1": "disliked" });
  assert.equal(engine.setFeedback(storage, "movie", 1, "neutral"), true);
  assert.deepEqual(JSON.parse(JSON.stringify(engine.readFeedback(storage).ratings)), {});
  assert.equal(storage.getItem(core.HISTORY_KEY), oldHistory);
  assert.equal(engine.readFeedback(storage).revision, 3);
  const future = store({ [engine.FEEDBACK_KEY]: JSON.stringify({ version: 2, ratings: { "movie:1": "liked" } }) });
  assert.equal(engine.setFeedback(future, "movie", 1, "disliked"), false);
  assert.equal(JSON.parse(future.getItem(engine.FEEDBACK_KEY)).version, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(engine.readFeedback(future).ratings)), {});
  assert.deepEqual(JSON.parse(JSON.stringify(engine.readFeedback(store({ [engine.FEEDBACK_KEY]: "bad" })).ratings)), {});
  const corrupt = store({ [engine.FEEDBACK_KEY]: "bad" });
  assert.equal(engine.setFeedback(corrupt, "movie", 1, "liked"), true);
  assert.deepEqual(JSON.parse(JSON.stringify(engine.readFeedback(corrupt).ratings)), { "movie:1": "liked" });
  assert.equal(engine.setFeedback(storage, "tv", -1, "liked"), false);
});

test("all six Details feedback transitions persist by movie or show identity", () => {
  const storage = store();
  const state = (type, id) => engine.readFeedback(storage).ratings[type + ":" + id] || "neutral";
  const toggle = (type, id, choice) => {
    const next = state(type, id) === choice ? "neutral" : choice;
    assert.equal(engine.setFeedback(storage, type, id, next), true);
    return state(type, id);
  };
  assert.equal(toggle("movie", 550, "liked"), "liked"); // neutral to like
  assert.equal(toggle("movie", 550, "liked"), "neutral"); // like to neutral
  assert.equal(toggle("movie", 550, "disliked"), "disliked"); // neutral to dislike
  assert.equal(toggle("movie", 550, "disliked"), "neutral"); // dislike to neutral
  assert.equal(toggle("movie", 550, "liked"), "liked");
  assert.equal(toggle("movie", 550, "disliked"), "disliked"); // like to dislike
  assert.equal(toggle("movie", 550, "liked"), "liked"); // dislike to like
  assert.equal(toggle("tv", 550, "disliked"), "disliked");
  assert.equal(state("movie", 550), "liked");
  assert.equal(state("tv", 550), "disliked");
  const reloaded = store({ [engine.FEEDBACK_KEY]: storage.getItem(engine.FEEDBACK_KEY) });
  assert.equal(engine.readFeedback(reloaded).ratings["movie:550"], "liked");
  assert.equal(engine.readFeedback(reloaded).ratings["tv:550"], "disliked");
});

test("empty history uses ranked popular fallback, with no invented personal reason", () => {
  const payload = { seeds: [], candidates: [candidate("movie", 2, "B", [1], [{ kind: "trending" }],
    { popularity: 200, voteCount: 4000 }), candidate("tv", 3, "C", [2], [{ kind: "trending" }]) ] };
  const ranked = engine.rank([], engine.readFeedback(store()), payload, { now });
  assert.deepEqual(Array.from(ranked, item => item.id), [2, 3]);
  assert.deepEqual(JSON.parse(JSON.stringify(ranked[0].reason)), { code: "popular" });
  assert.equal(engine.rank([], { ratings: {} }, { seeds: [], candidates: [
    candidate("movie", 4, "Unexplained stale related title", [], [source("similar", "movie:99")]) ] },
  { now }).length, 0);
});

test("taste profile ignores brief starts and short ambiguous media, caps series repetition", () => {
  const brief = core.item("tv", 9, "Brief", 1, 1, "off", now, { progress: {
    position: 12, duration: 1300, updatedAt: now, provider: "vidbolt", completed: false } });
  const ad = core.item("tv", 10, "Short timeline", 1, 1, "off", now, { progress: {
    position: 22, duration: 22, updatedAt: now, provider: "vidbolt", completed: true } });
  const episodes = Array.from({ length: 30 }, (_, i) => row("tv", 11, "Long show", now - i * 1000,
    i === 0, 1, i + 1));
  const profile = engine.tasteProfile([brief, ad, ...episodes], { ratings: {} },
    { seeds: [{ type: "tv", id: 11, genreIds: [35], keywordIds: [123] }] }, now);
  assert.equal(profile.positive.length, 1);
  assert.equal(profile.positive[0].count, 3);
  assert.ok(profile.positive[0].strength < 34);
  assert.ok(profile.genres["tv:35"] > 0 && profile.keywords["tv:123"] > 0);
});

test("resetting recommendation choices preserves playback history and rejects future schemas", () => {
  const storage = store();
  core.writeHistory(storage, row("movie", 1, "A", now));
  const historyBefore = storage.getItem(core.HISTORY_KEY);
  engine.setFeedback(storage, "movie", 1, "liked");
  assert.equal(engine.resetFeedback(storage), true);
  assert.equal(Object.keys(engine.readFeedback(storage).ratings).length, 0);
  assert.equal(storage.getItem(core.HISTORY_KEY), historyBefore);
  assert.equal(engine.readFeedback(storage).revision, 2);
  const future = store({ [engine.FEEDBACK_KEY]: JSON.stringify({ version: 9, ratings: {} }) });
  assert.equal(engine.resetFeedback(future), false);
});

test("Love It changes the same candidate pool and reset restores deterministic order", () => {
  const storage = store();
  const payload = { seeds: [{ type: "movie", id: 1, title: "Comedy seed", genreIds: [35] }],
    candidates: [candidate("movie", 2, "Related", [35], [source("recommendation", "movie:1")]),
      candidate("movie", 3, "Popular", [18], [{ kind: "trending" }], { popularity: 250 })] };
  const baseline = engine.rank([], engine.readFeedback(storage), payload, { now }).map(item => item.id);
  engine.setFeedback(storage, "movie", 1, "liked");
  const liked = engine.rank([], engine.readFeedback(storage), payload, { now }).map(item => item.id);
  assert.equal(liked[0], 2);
  assert.notDeepEqual(liked, baseline);
  engine.resetFeedback(storage);
  assert.deepEqual(engine.rank([], engine.readFeedback(storage), payload, { now }).map(item => item.id), baseline);
});

test("generic For You rows exclude watched and duplicate identities", () => {
  const watched = row("movie", 1, "Watched", now);
  const payload = { seeds: [], candidates: [candidate("movie", 1, "Watched", [18]),
    candidate("movie", 2, "Duplicate", [18]), candidate("movie", 2, "Duplicate", [18]),
    candidate("movie", 3, "Other", [35])] };
  const result = engine.selectRows([watched], { ratings: {} }, payload, { now });
  const groups = [result.forYou.top, result.forYou.trending, result.forYou.gems, result.forYou.explore];
  groups.forEach(group => assert.equal(new Set(group.map(item => item.type + ":" + item.id)).size, group.length));
  assert.equal(groups.flat().some(item => item.id === 1), false);
});

test("one verified watch is moderate evidence; unverified launches and missing progress are not", () => {
  const watched = row("movie", 1, "Seed", now - 86400000);
  const launch = core.item("movie", 5, "Only opened", null, null, "off", now);
  const payload = { seeds: [{ type: "movie", id: 1, title: "Seed", genreIds: [7], keywordIds: [70] }],
    candidates: [candidate("movie", 2, "Related", [7], [source("recommendation", "movie:1")]),
      candidate("movie", 3, "Popular", [1], [{ kind: "trending" }], { popularity: 200 })] };
  const ranked = engine.rank([watched, launch], { ratings: {} }, payload, { now });
  assert.equal(ranked[0].id, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(ranked[0].reason)), { code: "watched", title: "Seed" });
  assert.equal(engine.signals([launch], { ratings: {} }, now).length, 0);
  assert.equal(engine.signals([watched], { ratings: {} }, now)[0].strength < 34, true);
  const storage = store();
  core.writeHistory(storage, watched);
  core.setContinueHidden(storage, watched, true);
  assert.equal(engine.signals(core.readHistory(storage), engine.readFeedback(storage), now).length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(engine.readFeedback(storage).ratings)), {});
});

test("completed, unfinished, disliked, duplicate, and reserved row identities are excluded", () => {
  const rows = [row("movie", 1, "Finished", now - 500, true),
    row("tv", 2, "In progress", now - 1000, false),
    row("tv", 2, "In progress", now - 3000, true, 1, 2),
    core.item("movie", 6, "Manually completed", null, null, "off", now - 2000,
      { manualWatched: true })];
  const payload = { seeds: [], candidates: [
    candidate("movie", 1, "Finished", [1]), candidate("tv", 2, "In progress", [1]),
    candidate("movie", 3, "Disliked", [1]), candidate("movie", 4, "Reserved", [1]),
    candidate("movie", 5, "Unique", [1]), candidate("movie", 5, "Duplicate", [1]),
    candidate("movie", 6, "Manually completed", [1]),
    candidate("tv", 5, "Different medium", [2]) ] };
  const ranked = engine.rank(rows, { ratings: { "movie:3": "disliked" } }, payload,
    { now, reserved: ["movie:4"] });
  assert.deepEqual(Array.from(ranked, item => item.type + ":" + item.id).sort(), ["movie:5", "tv:5"]);
  assert.equal(engine.signals(rows, { ratings: {} }, now).find(item => item.id === 2).count, 2);
});

test("Like dominates weak viewing; clearing it changes rank without changing history", () => {
  const storage = store(), rows = [row("movie", 1, "Watched", now - 1000)];
  core.writeHistory(storage, rows[0]);
  const payload = { seeds: [{ type: "movie", id: 1, title: "Watched", genreIds: [1] },
    { type: "tv", id: 8, title: "Liked show", genreIds: [2] }], candidates: [
    candidate("movie", 2, "Watch related", [1], [source("similar", "movie:1")]),
    candidate("tv", 9, "Like related", [2], [source("recommendation", "tv:8")]) ] };
  engine.setFeedback(storage, "tv", 8, "liked");
  assert.equal(engine.rank(core.readHistory(storage), engine.readFeedback(storage), payload, { now })[0].id, 9);
  engine.setFeedback(storage, "tv", 8, "neutral");
  assert.equal(engine.rank(core.readHistory(storage), engine.readFeedback(storage), payload, { now })[0].id, 2);
  assert.equal(core.readHistory(storage).length, 1);
});

test("homepage rows use a real seed, exclude watched and rated identities, and never overlap", () => {
  const history = [row("tv", 10, "Watched Show", now - 1000),
    row("movie", 20, "Finished Film", now - 2000, true)];
  const feedback = { ratings: { "movie:30": "liked", "tv:40": "disliked" } };
  const payload = { seeds: [
    { type: "movie", id: 30, title: "Liked Film", genreIds: [1] },
    { type: "tv", id: 10, title: "Watched Show", genreIds: [2] }], candidates: [
    candidate("movie", 30, "Liked seed itself", [1], [source("recommendation", "movie:30")]),
    candidate("tv", 10, "Watched itself", [2], [source("recommendation", "tv:10")]),
    candidate("movie", 20, "Completed itself", [1], [{ kind: "trending" }]),
    candidate("tv", 40, "Disliked", [2], [{ kind: "trending" }]),
    candidate("movie", 31, "Liked related A", [1], [source("recommendation", "movie:30")]),
    candidate("movie", 31, "Duplicate A", [1], [source("similar", "movie:30")]),
    candidate("movie", 32, "Liked related B", [1], [source("similar", "movie:30")]),
    candidate("movie", 33, "Liked related C", [1], [source("recommendation", "movie:30")]),
    candidate("tv", 11, "Watched related A", [2], [source("recommendation", "tv:10")]),
    candidate("tv", 12, "Watched related B", [2], [source("similar", "tv:10")]),
    candidate("movie", 90, "Trending", [4], [{ kind: "trending" }]) ] };
  const rows = engine.selectRows(history, feedback, payload, { now, topLimit: 1 });
  assert.equal(rows.seed.title, "Liked Film");
  assert.equal(rows.seed.liked, true);
  assert.ok(rows.top.length === 1 && rows.because.length >= 2);
  const ids = [...rows.top, ...rows.because].map(item => item.type + ":" + item.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const excluded of ["movie:30", "tv:10", "movie:20", "tv:40"])
    assert.equal(ids.includes(excluded), false);
  assert.ok(rows.because.every(item => payload.candidates.some(candidate => candidate.id === item.id
    && candidate.sources.some(source => source.seed === "movie:30"))));
});

test("cold start shows Top Picks only; a sparse seed without remaining related titles omits Because", () => {
  const payload = { seeds: [{ type: "tv", id: 10, title: "Show", genreIds: [2] }], candidates: [
    candidate("tv", 11, "Related", [2], [source("similar", "tv:10")]),
    candidate("movie", 12, "Popular", [1], [{ kind: "trending" }]) ] };
  const cold = engine.selectRows([], { ratings: {} }, payload, { now });
  assert.equal(cold.top.length, 1);
  assert.equal(cold.seed, null);
  const sparse = engine.selectRows([row("tv", 10, "Show", now - 1000)], { ratings: {} }, payload, { now });
  assert.equal(sparse.top.length, 2);
  assert.equal(sparse.seed, null);
});

test("South Park preview fills a long related row from real TMDB identities without weak or duplicate picks", () => {
  const history = mock.previewHistory("south-park"), payload = mock.recommendations();
  const selected = engine.selectRows(history, { ratings: {} }, payload, { now: Date.now() });
  assert.equal(selected.seed.title, "South Park");
  // Top Picks now keeps more strong seed matches; the related row gets the
  // remaining eligible, nonduplicate titles in this finite preview pool.
  assert.ok(selected.because.length >= 2 && selected.because.length <= 12);
  const topIds = new Set(selected.top.map(item => item.type + ":" + item.id));
  assert.ok(selected.because.every(item => item.poster && item.score > 0
    && !topIds.has(item.type + ":" + item.id)
    && item.sources.some(source => source.seed === "tv:2190")));
  const disliked = engine.selectRows(history, { ratings: { "tv:1433": "disliked" } }, payload,
    { now: Date.now() });
  assert.equal([...disliked.top, ...disliked.because].some(item => item.id === 1433), false);
  assert.equal(new Set(selected.because.map(item => item.type + ":" + item.id)).size,
    selected.because.length);
});

test("frozen live TMDB pools keep clear seed matches above unrelated trending titles", () => {
  const pools = JSON.parse(readFileSync(new URL("./fixtures/watch-ranking-phase3c1.json", import.meta.url), "utf8")).pools;
  // Human judgments about these title pairs are independent of genre IDs and rank scores.
  const judgments = {
    southpark: ["Big Mouth", "Spider-Man: Brand New Day"],
    severance: ["Emergence", "Spider-Man: Brand New Day"],
    breakingbad: ["Better Call Saul", "Spider-Man: Brand New Day"],
    interstellar: ["A.I. Artificial Intelligence", "One Piece"],
    bladerunner2049: ["Blade Runner", "One Piece"],
    spiritedaway: ["Mary and The Witch's Flower", "MobLand"]
  };
  for (const [name, payload] of Object.entries(pools)) {
    const seed = payload.seeds[0];
    const watched = [row(seed.type, seed.id, seed.title, now - 86400000)];
    const result = engine.rank(watched, { ratings: {} }, payload, { now, limit: 10 });
    assert.equal(result.length, 10, name);
    assert.equal(new Set(result.map(item => item.type + ":" + item.id)).size, 10, name);
    assert.ok(result.every(item => item.poster), name);
    assert.deepEqual(engine.rank(watched, { ratings: {} }, payload, { now, limit: 10 })
      .map(item => item.type + ":" + item.id), result.map(item => item.type + ":" + item.id), name);
    if (judgments[name]) {
      const [relevant, weak] = judgments[name];
      const titles = result.map(item => item.title);
      assert.ok(titles.includes(relevant), name + ": missing " + relevant);
      assert.ok(!titles.includes(weak) || titles.indexOf(relevant) < titles.indexOf(weak), name);
    }
  }
});

test("profile confidence bounds generic quality while cold start retains popular fallback", () => {
  const payload = { seeds: [{ type: "movie", id: 1, title: "Seed", genreIds: [878] }], candidates: [
    candidate("movie", 2, "Relevant", [878], [source("recommendation", "movie:1")],
      { popularity: 20, voteCount: 100 }),
    candidate("tv", 3, "Broadly popular", [80], [{ kind: "trending" }],
      { popularity: 10000, voteCount: 100000, voteAverage: 9 }) ] };
  const cold = engine.rank([], { ratings: {} }, payload, { now });
  const watched = engine.rank([row("movie", 1, "Seed", now - 1000)], { ratings: {} }, payload, { now });
  const loved = engine.rank([], { ratings: { "movie:1": "liked" } }, payload, { now });
  assert.equal(cold[0].id, 3);
  assert.equal(watched[0].id, 2);
  assert.equal(loved[0].id, 2);
  assert.ok(watched.some(item => item.id === 3), "exploration candidate remains eligible");
  assert.ok(loved.find(item => item.id === 3).score < cold[0].score);
});

test("diversity still acts within relevant results without burying a second seed match", () => {
  const history = [row("tv", 1, "Watched", now - 1000)];
  const payload = { seeds: [{ type: "tv", id: 1, title: "Watched", genreIds: [35] }], candidates: [
    candidate("tv", 2, "Related A", [35], [source("recommendation", "tv:1")]),
    candidate("tv", 3, "Related B", [35], [source("recommendation", "tv:1")]),
    candidate("tv", 4, "Other related", [80], [source("recommendation", "tv:1")]),
    candidate("movie", 5, "Trending", [28], [{ kind: "trending" }],
      { popularity: 5000, voteCount: 20000 }) ] };
  const result = engine.rank(history, { ratings: {} }, payload, { now });
  assert.ok(result.findIndex(item => item.id === 3) < result.findIndex(item => item.id === 5));
  assert.ok(result.some(item => item.id === 4));
});

test("mixed interests share the first ten across seeds and cold start stays populated", () => {
  const pools = JSON.parse(readFileSync(new URL("./fixtures/watch-ranking-phase3c1.json", import.meta.url), "utf8")).pools;
  const names = ["southpark", "severance", "interstellar"];
  const payload = { seeds: names.flatMap(name => pools[name].seeds),
    candidates: names.flatMap(name => pools[name].candidates) };
  const watched = payload.seeds.map(seed => row(seed.type, seed.id, seed.title, now - 1000));
  const ranked = engine.rank(watched, { ratings: {} }, payload, { now, limit: 10 });
  const counts = new Map();
  for (const item of ranked) if (item.reason.code === "watched")
    counts.set(item.reason.title, (counts.get(item.reason.title) || 0) + 1);
  assert.equal(ranked.length, 10);
  assert.equal(counts.size, 3);
  assert.ok(Math.max(...counts.values()) <= 5);
  const cold = engine.rank([], { ratings: {} }, payload, { now, limit: 10 });
  assert.equal(cold.length, 10);
  assert.ok(cold.every(item => item.poster && item.reason.code === "popular"));
});

test("conflicting genre interests retain distinct types and diversify a single seed", () => {
  const history = [row("movie", 1, "Action", now - 1000), row("tv", 2, "Drama", now - 2000)];
  const payload = { seeds: [{ type: "movie", id: 1, title: "Action", genreIds: [10] },
    { type: "tv", id: 2, title: "Drama", genreIds: [20] }], candidates: [
    candidate("movie", 3, "A", [10], [source("recommendation", "movie:1")]),
    candidate("movie", 4, "B", [10], [source("recommendation", "movie:1")]),
    candidate("tv", 5, "C", [20], [source("recommendation", "tv:2")]) ] };
  const result = engine.rank(history, { ratings: {} }, payload, { now });
  assert.equal(result[0].id, 3);
  assert.equal(result[1].id, 5);
  assert.equal(result[2].id, 4);
  const base = engine.rank(history, { ratings: {} }, { seeds: payload.seeds,
    candidates: [candidate("movie", 6, "One source", [10], [source("recommendation", "movie:1")])] }, { now });
  const duplicatedSource = engine.rank(history, { ratings: {} }, { seeds: payload.seeds,
    candidates: [candidate("movie", 6, "Two endpoints, one seed", [10], [
      source("recommendation", "movie:1"), source("similar", "movie:1")])] }, { now });
  assert.equal(base[0].score, duplicatedSource[0].score);
});

test("Dislike lowers matching genre and keyword affinity without banning an entire genre", () => {
  const payload = { seeds: [], avoids: [{ type: "movie", id: 7, genreIds: [10], keywordIds: [99] }],
    candidates: [candidate("movie", 8, "Genre match", [10], [{ kind: "trending" }],
      { keywordIds: [99] }), candidate("movie", 9, "Different", [20], [{ kind: "trending" }]) ] };
  const result = engine.rank([], { ratings: { "movie:7": "disliked" } }, payload, { now });
  assert.deepEqual(Array.from(result, item => item.id), [9, 8]);
  assert.equal(result.length, 2);
  const tvCandidate = candidate("tv", 10, "Same number, other medium", [10], [{ kind: "trending" }],
    { keywordIds: [99] });
  const tvWithDislike = engine.rank([], { ratings: { "movie:7": "disliked" } },
    { seeds: [], avoids: payload.avoids, candidates: [tvCandidate] }, { now });
  const tvNeutral = engine.rank([], { ratings: {} }, { seeds: [], candidates: [tvCandidate] }, { now });
  assert.equal(tvWithDislike[0].score, tvNeutral[0].score);
  const dislikedHistory = [row("movie", 7, "Avoid", now - 1000)];
  assert.equal(engine.seedQuery(dislikedHistory, { ratings: { "movie:7": "disliked" } }, now), "");
});

test("load reranks after feedback changes without refetching reusable candidates", async () => {
  const storage = store(), pending = {}, requests = [];
  const payload = { seeds: [], candidates: [candidate("movie", 7, "Now disliked", [1]),
    candidate("movie", 8, "Allowed", [1])] };
  const fetcher = url => { requests.push(url);
    return requests.length === 1 ? new Promise(resolve => { pending.resolve = resolve; })
      : Promise.resolve({ ok: true, json: async () => payload }); };
  const first = engine.load(storage, fetcher, { now });
  engine.setFeedback(storage, "movie", 7, "disliked");
  pending.resolve({ ok: true, json: async () => payload });
  const result = await first;
  assert.deepEqual(Array.from(result, item => item.id), [8]);
  assert.equal(requests.length, 1, "a Dislike during an in-flight request only reranks the candidates");
  engine.setFeedback(storage, "movie", 7, "neutral");
  const fromCache = await engine.load(storage, () => { throw Error("should use cache"); }, { now });
  assert.equal(fromCache.length, 2);
  engine.setFeedback(storage, "movie", 99, "liked");
  const expanded = await engine.load(storage, async url => {
    requests.push(url);
    return { ok: true, json: async () => ({ seeds: [{ type: "movie", id: 99, title: "New seed", genreIds: [3] }],
      candidates: [candidate("movie", 98, "New recommendation", [3], [source("recommendation", "movie:99")])] }) };
  }, { now });
  assert.equal(expanded[0].id, 98);
  assert.equal(requests.length, 2, "a new positive seed requests its TMDB candidates");
  const failed = await engine.load(storage, async () => { throw Error("network"); }, { now: now + 11 * 60 * 1000 });
  assert.ok(failed.length > 0);
});

test("Worker bounds TMDB calls, annotates real sources and survives partial failures", async () => {
  const paths = [];
  const fetch = async (url, options) => {
    assert.equal(options.headers.Authorization, "Bearer secret");
    const path = new URL(url).pathname.replace(/^\/3/, ""); paths.push(path);
    if (path === "/movie/1") return new Response(JSON.stringify({ id: 1, title: "Seed",
      genres: [{ id: 10 }], keywords: { keywords: [{ id: 99 }] } }));
    if (path.endsWith("/similar")) return new Response("", { status: 500 });
    if (path.endsWith("/recommendations")) return new Response(JSON.stringify({ results: [
      { id: 4, title: "Related", genre_ids: [10], popularity: 40, vote_count: 200 } ] }));
    if (path === "/discover/movie") return new Response(JSON.stringify({ results: [
      { id: 4, title: "Related", genre_ids: [10] }, { id: 5, title: "Keyword match", genre_ids: [10] } ] }));
    return new Response(JSON.stringify({ results: [{ id: path.includes("movie") ? 6 : 7,
      title: "Trending", name: "Trending", genre_ids: [20], popularity: 50 }] }));
  };
  const response = await api(new Request("https://watch.example/api/recommendations?seeds=movie%3A1"),
    { TMDB_TOKEN: "secret" }, { fetch });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.candidates.filter(item => item.type === "movie" && item.id === 4).length, 1);
  assert.deepEqual(data.candidates.find(item => item.id === 5).keywordIds, [99]);
  assert.ok(data.candidates.some(item => item.type === "tv"));
  assert.ok(paths.length <= 15);
  assert.equal(JSON.stringify(data).includes("secret"), false);
  const called = paths.length;
  const cached = await api(new Request("https://watch.example/api/recommendations?seeds=movie%3A1"),
    { TMDB_TOKEN: "secret" }, { fetch });
  assert.equal(cached.status, 200);
  assert.equal(paths.length, called);
  for (const bad of ["movie:0", "person:1", "movie:1,movie:1", "movie:1,tv:2,movie:3,tv:4"])
    assert.equal((await api(new Request("https://watch.example/api/recommendations?seeds="
      + encodeURIComponent(bad)), { TMDB_TOKEN: "secret" })).status, 400);
  assert.equal((await api(new Request("https://watch.example/api/recommendations?seeds=movie%3A1&avoid=movie%3A1"),
    { TMDB_TOKEN: "secret" })).status, 400);
});

test("Worker returns disliked title metadata without fetching related lists for it", async () => {
  const paths = [];
  const response = await api(new Request("https://watch.example/api/recommendations?seeds=&avoid=movie%3A77"),
    { TMDB_TOKEN: "secret" }, { fetch: async url => {
      const path = new URL(url).pathname.replace(/^\/3/, ""); paths.push(path);
      return new Response(JSON.stringify(path === "/movie/77"
        ? { id: 77, title: "Avoid", genres: [{ id: 10 }], keywords: { keywords: [{ id: 99 }] } }
        : { results: [] }));
    } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).avoids[0].keywordIds, [99]);
  assert.deepEqual(paths.sort(), ["/movie/77", "/trending/movie/week", "/trending/tv/week"].sort());
});

test("total TMDB failure is not cached as an empty successful recommendation", async () => {
  let calls = 0;
  const request = new Request("https://watch.example/api/recommendations?seeds=movie%3A993191");
  const failed = await api(request, { TMDB_TOKEN: "secret" }, { fetch: async () => {
    calls += 1; return new Response("", { status: 500 });
  } });
  assert.equal(failed.status, 502);
  const before = calls;
  const recovered = await api(request, { TMDB_TOKEN: "secret" }, { fetch: async () => {
    calls += 1; return new Response(JSON.stringify({ results: [] }));
  } });
  assert.equal(recovered.status, 200);
  assert.ok(calls > before);
});
