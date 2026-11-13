import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const root = {};
runInNewContext(readFileSync(new URL("../universal-search/discover-engine.js", import.meta.url), "utf8"),
  { window: root });
const engine = root.HorizonDiscoverEngine;
const pools = JSON.parse(readFileSync(new URL("./fixtures/watch-discover-phase3c2.json", import.meta.url), "utf8")).pools;
const categories = ["closest", "vibe", "genre", "gems"];
const items = result => categories.flatMap(category => result[category]);
const identity = item => item.type + ":" + item.id;
const options = targetMedia => ({ targetMedia, hideFinished: false, feedback: { ratings: {} } });

test("four frozen live Discover pools allocate each canonical title once and keep category purposes distinct", () => {
  const targets = { southpark: "movie", severance: "both", interstellar: "tv", darkknight: "movie" };
  for (const [name, target] of Object.entries(targets)) {
    const pool = pools[name];
    const result = engine.rankDiscoverCategories(pool.seed, pool.candidates, options(target));
    const all = items(result), keys = all.map(identity);
    assert.equal(new Set(keys).size, keys.length, name);
    assert.ok(all.length > 0 && all.length <= pool.candidates.length, name);
    assert.ok(categories.every(category => result[category].length <= 12), name);
    assert.deepEqual(items(engine.rankDiscoverCategories(pool.seed, pool.candidates, options(target)))
      .map(identity), keys, name + " must be deterministic");
    assert.ok(result.genre.length > 0, name + " retains broader genre discoveries");
  }
  const interstellar = engine.rankDiscoverCategories(pools.interstellar.seed,
    pools.interstellar.candidates, options("tv"));
  assert.ok(interstellar.closest.some(item => ["Farscape", "Firefly"].includes(item.title)));
  assert.ok(items(interstellar).some(item => item.type === "tv" && item.title.includes("Stargate")));
  assert.notDeepEqual(interstellar.closest.map(identity), interstellar.vibe.map(identity));
});

test("cross-media retrieval without content evidence cannot create a close match or fan claim", () => {
  const pool = pools.southpark;
  const weak = pool.candidates.find(item => item.title === "All About Steve");
  const scored = engine.scoreCandidate(pool.seed, weak, {});
  assert.equal(scored.scores.closest, 0);
  assert.equal(scored.scores.vibe, 0);
  assert.equal(scored.matchReason, "Shares Comedy genre");
  const result = engine.rankDiscoverCategories(pool.seed, pool.candidates, options("movie"));
  assert.equal(result.closest.some(item => item.id === weak.id), false);
  assert.ok(items(result).every(item => !item.matchReason.startsWith("Recommended for fans of")));
});

test("movie and TV identities with the same number remain separate; scarcity never causes filler", () => {
  const seed = { type: "movie", id: 1, title: "Seed", genreIds: [878], keywordIds: [12],
    keywords: [{ id: 12, name: "space travel" }], overview: "A crew travels through space to survive." };
  const candidate = (type, id, title, genreIds, keywordIds, overview) => ({ type, id, title,
    genreIds, keywordIds, overview, voteCount: 500, voteAverage: 8, sources: [{ kind: "cross_media" }] });
  const pool = [candidate("movie", 7, "Movie Seven", [878], [12], "A crew travels through space."),
    candidate("tv", 7, "TV Seven", [10765], [12], "A space crew struggles to survive."),
    candidate("tv", 8, "Unrelated", [35], [], "Friends compete in a cooking contest.")];
  const result = engine.rankDiscoverCategories(seed, pool, options("both"));
  assert.deepEqual(new Set(items(result).map(identity)), new Set(["movie:7", "tv:7"]));
  assert.ok(categories.some(category => result[category].length === 0));
  assert.equal(engine.rankDiscoverCategories(seed, [], options("both")).closest.length, 0);
});

test("filters and Not Interested apply before global allocation", () => {
  const pool = pools.severance;
  const unfiltered = engine.rankDiscoverCategories(pool.seed, pool.candidates, options("both"));
  const disliked = items(unfiltered)[0];
  const filtered = engine.rankDiscoverCategories(pool.seed, pool.candidates, {
    ...options("both"), feedback: { ratings: { [identity(disliked)]: "disliked" } },
    filters: { genre: "18" }
  });
  assert.ok(items(filtered).every(item => item.genreIds.includes(18) && identity(item) !== identity(disliked)));
  assert.equal(new Set(items(filtered).map(identity)).size, items(filtered).length);
});
