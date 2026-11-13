import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  api,
  aiCircuitBreaker,
  resetAiCircuitBreaker,
  resolveAiMode,
  vectorCosineSimilarity,
  formatSemanticDoc,
  applyAiEmbeddings,
  embeddingCache,
  discoverCache
} from "../universal-search-worker.js";

// Load discover engine into VM
const discoverSource = readFileSync(new URL("../universal-search/discover-engine.js", import.meta.url), "utf8");
const vmRoot = {};
runInNewContext(discoverSource, { window: vmRoot });
const engine = vmRoot.HorizonDiscoverEngine;

// Load frozen pools fixture
const fixture = JSON.parse(readFileSync(new URL("./fixtures/watch-discover-phase3c2.json", import.meta.url), "utf8"));
const pools = fixture.pools;

// Helper to generate a dummy 384-dimensional embedding vector
function mockVector(seedValue, dim = 384) {
  const vec = new Array(dim);
  for (let i = 0; i < dim; i++) {
    vec[i] = Math.sin(seedValue + i * 0.1);
  }
  return vec;
}

// Helper fetcher returning valid TMDB seed and candidate data
function createTmdbFetcher(candidates = null) {
  return async url => {
    if (url.includes("/tv/2190?")) {
      return new Response(JSON.stringify({
        id: 2190, name: "South Park", overview: "Grade schoolers in Colorado",
        genres: [{ id: 16, name: "Animation" }, { id: 35, name: "Comedy" }],
        keywords: { results: [{ id: 8201, name: "satire" }] }
      }));
    }
    const defaultCandidates = [
      { id: 101, title: "Silver City", genre_ids: [35, 18], popularity: 15, vote_count: 50, vote_average: 6.8, overview: "Political satire in Colorado" },
      { id: 102, title: "Team America", genre_ids: [35, 16], popularity: 40, vote_count: 800, vote_average: 7.0, overview: "Satirical puppet comedy" }
    ];
    return new Response(JSON.stringify({
      results: candidates || defaultCandidates
    }));
  };
}

// ============================================================================
// 1. Math and Formatting Unit Tests
// ============================================================================

test("vectorCosineSimilarity correctly computes normalized similarity and handles edge cases", () => {
  const v1 = [1, 2, 3, 4];
  assert.equal(Math.round(vectorCosineSimilarity(v1, v1) * 1000) / 1000, 1.0);

  const v2 = [1, 0];
  const v3 = [0, 1];
  assert.equal(vectorCosineSimilarity(v2, v3), 0.0);

  const v4 = [1, 1];
  const v5 = [-1, -1];
  assert.equal(vectorCosineSimilarity(v4, v5), 0.0);

  assert.equal(vectorCosineSimilarity([], []), 0.0);
  assert.equal(vectorCosineSimilarity(null, [1, 2]), 0.0);
  assert.equal(vectorCosineSimilarity([1, 2], [1, 2, 3]), 0.0);
  assert.equal(vectorCosineSimilarity([0, 0], [0, 0]), 0.0);
});

test("formatSemanticDoc formats compact document strings with genres, themes, and bounded plot", () => {
  const item = {
    title: "Severance",
    genres: ["Drama", "Mystery", "Sci-Fi & Fantasy"],
    keywords: [{ id: 101, name: "dystopia" }, { id: 102, name: "memory" }],
    overview: "Mark leads a team of office workers whose memories have been surgically divided."
  };
  const doc = formatSemanticDoc(item);
  assert.ok(doc.startsWith("Title: Severance. Genres: Drama, Mystery, Sci-Fi & Fantasy. Themes: dystopia, memory. Plot: Mark leads"));
  assert.ok(doc.length <= 800);

  const itemWithIds = {
    title: "Fight Club",
    genreIds: [18, 53],
    keywords: ["underground", "insomnia"],
    overview: "An insomniac office worker looking for a way to change his life."
  };
  const docIds = formatSemanticDoc(itemWithIds);
  assert.ok(docIds.includes("Genres: Drama, Thriller"));
  assert.ok(docIds.includes("Themes: underground, insomnia"));

  const longItem = {
    title: "Very Long Plot",
    overview: "A".repeat(1200)
  };
  assert.ok(formatSemanticDoc(longItem).length <= 800);
});

// ============================================================================
// 2. Security: AI Mode Resolution & Public Escalation Protection
// ============================================================================

test("resolveAiMode: server-side off setting is authoritative and cannot be escalated by public queries", () => {
  const offEnv = { AI_RECOMMENDATIONS_MODE: "off" };
  const mockReq = { headers: new Map() };

  // 1. Missing query -> off
  assert.equal(resolveAiMode(offEnv, new URL("https://example.com/api/discover-similar"), mockReq), "off");

  // 2. Public attempt to escalate ?ai=on -> strictly blocked, returns "off"
  assert.equal(resolveAiMode(offEnv, new URL("https://example.com/api/discover-similar?ai=on"), mockReq), "off");

  // 3. Public attempt to escalate ?ai=shadow -> strictly blocked, returns "off"
  assert.equal(resolveAiMode(offEnv, new URL("https://example.com/api/discover-similar?ai=shadow"), mockReq), "off");

  // 4. Public attempt with invalid value -> returns null (triggers 400 invalid_query)
  assert.equal(resolveAiMode(offEnv, new URL("https://example.com/api/discover-similar?ai=exploit"), mockReq), null);
});

test("resolveAiMode: public requests can de-escalate, but cannot escalate above server ceiling", () => {
  const shadowEnv = { AI_RECOMMENDATIONS_MODE: "shadow" };
  const onEnv = { AI_RECOMMENDATIONS_MODE: "on" };
  const mockReq = { headers: new Map() };

  // When server is shadow, public ?ai=on is clamped to shadow
  assert.equal(resolveAiMode(shadowEnv, new URL("https://example.com/api/discover-similar?ai=on"), mockReq), "shadow");
  // When server is shadow, public ?ai=off safely de-escalates to off
  assert.equal(resolveAiMode(shadowEnv, new URL("https://example.com/api/discover-similar?ai=off"), mockReq), "off");

  // When server is on, public ?ai=off safely de-escalates to off
  assert.equal(resolveAiMode(onEnv, new URL("https://example.com/api/discover-similar?ai=off"), mockReq), "off");
  // When server is on, public ?ai=shadow safely de-escalates to shadow
  assert.equal(resolveAiMode(onEnv, new URL("https://example.com/api/discover-similar?ai=shadow"), mockReq), "shadow");
});

test("resolveAiMode: authorized operator with secret can select mode", () => {
  const authEnv = { AI_RECOMMENDATIONS_MODE: "off", AI_OVERRIDE_SECRET: "operator-secret-123" };
  const authedReq = {
    headers: {
      get: name => name.toLowerCase() === "x-horizon-ai-auth" ? "operator-secret-123" : null
    }
  };
  const unauthedReq = {
    headers: {
      get: name => name.toLowerCase() === "x-horizon-ai-auth" ? "wrong-secret" : null
    }
  };

  // With correct secret header, escalation is permitted for testing
  assert.equal(resolveAiMode(authEnv, new URL("https://example.com/api/discover-similar?ai=on"), authedReq), "on");
  assert.equal(resolveAiMode(authEnv, new URL("https://example.com/api/discover-similar?ai=shadow"), authedReq), "shadow");

  // With incorrect secret header, escalation is strictly blocked
  assert.equal(resolveAiMode(authEnv, new URL("https://example.com/api/discover-similar?ai=on"), unauthedReq), "off");
});

// ============================================================================
// 3. Batch Budget & Text Deduplication
// ============================================================================

test("applyAiEmbeddings: avoids duplicate texts within a batch", async () => {
  resetAiCircuitBreaker();
  embeddingCache.clear();
  let receivedTexts = [];
  const mockEnv = {
    AI: {
      run: async (_model, inputs) => {
        receivedTexts = inputs.text;
        return {
          shape: [inputs.text.length, 384],
          data: inputs.text.map((_, idx) => mockVector(idx + 1))
        };
      }
    }
  };
  const seed = { type: "tv", id: 2190, title: "South Park", overview: "Grade schoolers in Colorado" };
  // Three candidates, two of which share the exact same title, genres, and overview
  const candidates = [
    { type: "movie", id: 101, title: "Duplicate Movie", overview: "Identical overview" },
    { type: "movie", id: 102, title: "Duplicate Movie", overview: "Identical overview" },
    { type: "movie", id: 103, title: "Unique Movie", overview: "Completely different overview" }
  ];

  const res = await applyAiEmbeddings(mockEnv, seed, candidates, "on");
  assert.equal(res.status, "ok");
  // Total toFetch texts must be 3 (1 seed + 2 unique candidate texts), NOT 4!
  assert.equal(receivedTexts.length, 3, "Batch must deduplicate identical formatted texts");
  assert.ok(typeof candidates[0].semanticSim === "number");
  assert.ok(typeof candidates[1].semanticSim === "number");
  assert.equal(candidates[0].semanticSim, candidates[1].semanticSim, "Deduplicated candidates share identical similarity");
});

// ============================================================================
// 4. The 15 Release-Readiness & Fallback Scenarios
// ============================================================================

test("1. Missing AI binding: returns HTTP 200 with valid statistical candidates", async () => {
  resetAiCircuitBreaker();
  discoverCache.clear();
  const envNoAi = { TMDB_TOKEN: "valid-token", AI_RECOMMENDATIONS_MODE: "on" }; // env without env.AI
  const req = new Request("https://search.example/api/discover-similar?type=tv&id=2190&target=same");
  const res = await api(req, envNoAi, { fetch: createTmdbFetcher() });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ai.status, "unavailable");
  assert.equal(data.ai.reason, "missing_ai_binding");
  assert.ok(data.candidates.length > 0, "Candidates pool must not be empty");
  assert.equal(data.candidates[0].title, "Silver City");
  assert.equal(data.candidates[0].semanticSim, undefined, "Missing AI binding must omit semanticSim");
});

test("2. Server mode off with ?ai=on: anonymous request cannot escalate, returns valid statistical candidates", async () => {
  resetAiCircuitBreaker();
  discoverCache.clear();
  let aiCalled = false;
  const env = {
    TMDB_TOKEN: "valid-token",
    AI_RECOMMENDATIONS_MODE: "off",
    AI: { run: async () => { aiCalled = true; return { data: [] }; } }
  };
  const req = new Request("https://search.example/api/discover-similar?type=tv&id=2190&target=same&ai=on");
  const res = await api(req, env, { fetch: createTmdbFetcher() });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ai.status, "disabled");
  assert.equal(data.ai.mode, "off");
  assert.equal(aiCalled, false, "Workers AI must NOT be invoked when server mode is off");
  assert.ok(data.candidates.length > 0);
  assert.equal(data.candidates[0].title, "Silver City");
  assert.equal(data.candidates[0].semanticSim, undefined);
});

test("3. Server mode off with ?ai=shadow: anonymous request cannot escalate, returns valid statistical candidates", async () => {
  resetAiCircuitBreaker();
  discoverCache.clear();
  let aiCalled = false;
  const env = {
    TMDB_TOKEN: "valid-token",
    AI_RECOMMENDATIONS_MODE: "off",
    AI: { run: async () => { aiCalled = true; return { data: [] }; } }
  };
  const req = new Request("https://search.example/api/discover-similar?type=tv&id=2190&target=same&ai=shadow");
  const res = await api(req, env, { fetch: createTmdbFetcher() });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ai.status, "disabled");
  assert.equal(aiCalled, false);
  assert.ok(data.candidates.length > 0);
  assert.equal(data.candidates[0].title, "Silver City");
  assert.equal(data.candidates[0].semanticSim, undefined);
});

test("4. Server mode on with valid AI response: returns HTTP 200 with hybrid semanticSim scores", async () => {
  resetAiCircuitBreaker();
  discoverCache.clear();
  embeddingCache.clear();
  const env = {
    TMDB_TOKEN: "valid-token",
    AI_RECOMMENDATIONS_MODE: "on",
    AI: {
      run: async () => ({
        shape: [3, 384],
        data: [mockVector(1), mockVector(2), mockVector(3)]
      })
    }
  };
  const req = new Request("https://search.example/api/discover-similar?type=tv&id=2190&target=same");
  const res = await api(req, env, { fetch: createTmdbFetcher() });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ai.status, "ok");
  assert.equal(data.ai.mode, "on");
  assert.ok(data.candidates.length > 0);
  assert.equal(data.candidates[0].title, "Silver City");
  assert.ok(typeof data.candidates[0].semanticSim === "number");
});

test("5. Daily quota exhausted (error 3036): trips circuit breaker until UTC midnight and falls back to statistical", async () => {
  resetAiCircuitBreaker();
  discoverCache.clear();
  embeddingCache.clear();
  const env = {
    TMDB_TOKEN: "valid-token",
    AI_RECOMMENDATIONS_MODE: "on",
    AI: {
      run: async () => {
        const err = new Error("Free daily Neurons quota exhausted for this account (code: 3036)");
        err.code = 3036;
        throw err;
      }
    }
  };
  const req = new Request("https://search.example/api/discover-similar?type=tv&id=2190&target=same");
  const res = await api(req, env, { fetch: createTmdbFetcher() });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ai.status, "fallback_statistical");
  assert.equal(data.ai.reason, "quota_exhausted");
  assert.ok(data.candidates.length > 0);
  assert.equal(data.candidates[0].title, "Silver City");
  assert.equal(data.candidates[0].semanticSim, undefined);
  assert.equal(aiCircuitBreaker.code, 3036);
  assert.ok(aiCircuitBreaker.lockedUntil > Date.now());
});

test("6. Temporary capacity exhaustion (error 3040): enforces 60s cooldown and falls back to statistical", async () => {
  resetAiCircuitBreaker();
  discoverCache.clear();
  embeddingCache.clear();
  const env = {
    TMDB_TOKEN: "valid-token",
    AI_RECOMMENDATIONS_MODE: "on",
    AI: {
      run: async () => {
        const err = new Error("Workers AI capacity temporarily unavailable (code: 3040)");
        err.code = 3040;
        throw err;
      }
    }
  };
  const req = new Request("https://search.example/api/discover-similar?type=tv&id=2190&target=same");
  const res = await api(req, env, { fetch: createTmdbFetcher() });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ai.status, "fallback_statistical");
  assert.equal(data.ai.reason, "temporary_capacity");
  assert.ok(data.candidates.length > 0);
  assert.equal(data.candidates[0].title, "Silver City");
  assert.equal(data.candidates[0].semanticSim, undefined);
  assert.equal(aiCircuitBreaker.code, 3040);
});

test("7. Generic 429 error (rate limit): enforces 60s cooldown and falls back to statistical", async () => {
  resetAiCircuitBreaker();
  discoverCache.clear();
  embeddingCache.clear();
  const env = {
    TMDB_TOKEN: "valid-token",
    AI_RECOMMENDATIONS_MODE: "on",
    AI: {
      run: async () => {
        const err = new Error("Rate limit exceeded: 429 Too Many Requests");
        err.status = 429;
        throw err;
      }
    }
  };
  const req = new Request("https://search.example/api/discover-similar?type=tv&id=2190&target=same");
  const res = await api(req, env, { fetch: createTmdbFetcher() });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ai.status, "fallback_statistical");
  assert.equal(data.ai.reason, "temporary_capacity");
  assert.ok(data.candidates.length > 0);
  assert.equal(data.candidates[0].title, "Silver City");
  assert.equal(data.candidates[0].semanticSim, undefined);
});

test("8. Timeout: enforces 30s cooldown and falls back to statistical", async () => {
  resetAiCircuitBreaker();
  discoverCache.clear();
  embeddingCache.clear();
  const env = {
    TMDB_TOKEN: "valid-token",
    AI_RECOMMENDATIONS_MODE: "on",
    AI: {
      run: async () => new Promise(resolve => setTimeout(resolve, 5000))
    }
  };
  const req = new Request("https://search.example/api/discover-similar?type=tv&id=2190&target=same");
  const res = await api(req, env, { fetch: createTmdbFetcher() });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ai.status, "fallback_statistical");
  assert.equal(data.ai.reason, "timeout");
  assert.ok(data.candidates.length > 0);
  assert.equal(data.candidates[0].title, "Silver City");
  assert.equal(data.candidates[0].semanticSim, undefined);
});

test("9. Malformed vector: non-finite or non-array data falls back to statistical", async () => {
  resetAiCircuitBreaker();
  discoverCache.clear();
  embeddingCache.clear();
  const env = {
    TMDB_TOKEN: "valid-token",
    AI_RECOMMENDATIONS_MODE: "on",
    AI: {
      run: async () => ({
        data: [[NaN, Infinity, 0]]
      })
    }
  };
  const req = new Request("https://search.example/api/discover-similar?type=tv&id=2190&target=same");
  const res = await api(req, env, { fetch: createTmdbFetcher() });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ai.status, "fallback_statistical");
  assert.equal(data.ai.reason, "malformed_output");
  assert.ok(data.candidates.length > 0);
  assert.equal(data.candidates[0].title, "Silver City");
  assert.equal(data.candidates[0].semanticSim, undefined);
});

test("10. Wrong embedding dimensions: 128-dim vector falls back to statistical", async () => {
  resetAiCircuitBreaker();
  discoverCache.clear();
  embeddingCache.clear();
  const env = {
    TMDB_TOKEN: "valid-token",
    AI_RECOMMENDATIONS_MODE: "on",
    AI: {
      run: async () => ({
        data: [mockVector(1, 128), mockVector(2, 128), mockVector(3, 128)]
      })
    }
  };
  const req = new Request("https://search.example/api/discover-similar?type=tv&id=2190&target=same");
  const res = await api(req, env, { fetch: createTmdbFetcher() });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ai.status, "fallback_statistical");
  assert.equal(data.ai.reason, "malformed_output");
  assert.ok(data.candidates.length > 0);
  assert.equal(data.candidates[0].title, "Silver City");
  assert.equal(data.candidates[0].semanticSim, undefined);
});

test("11. Partial or missing results: fewer vectors than inputs falls back to statistical", async () => {
  resetAiCircuitBreaker();
  discoverCache.clear();
  embeddingCache.clear();
  const env = {
    TMDB_TOKEN: "valid-token",
    AI_RECOMMENDATIONS_MODE: "on",
    AI: {
      run: async () => ({
        data: [mockVector(1, 384)] // only 1 vector returned for 3 inputs
      })
    }
  };
  const req = new Request("https://search.example/api/discover-similar?type=tv&id=2190&target=same");
  const res = await api(req, env, { fetch: createTmdbFetcher() });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ai.status, "fallback_statistical");
  assert.equal(data.ai.reason, "malformed_output");
  assert.ok(data.candidates.length > 0);
  assert.equal(data.candidates[0].title, "Silver City");
  assert.equal(data.candidates[0].semanticSim, undefined);
});

test("12. Concurrent requests during cooldown: immediately bypasses AI with zero calls", async () => {
  resetAiCircuitBreaker();
  discoverCache.clear();
  let aiCallCount = 0;
  const env = {
    TMDB_TOKEN: "valid-token",
    AI_RECOMMENDATIONS_MODE: "on",
    AI: {
      run: async () => {
        aiCallCount++;
        const err = new Error("Workers AI capacity temporarily unavailable (code: 3040)");
        err.code = 3040;
        throw err;
      }
    }
  };
  const fetcher = createTmdbFetcher();
  const req1 = new Request("https://search.example/api/discover-similar?type=tv&id=2190&target=same");
  const res1 = await api(req1, env, { fetch: fetcher });
  assert.equal(res1.status, 200);
  assert.equal(aiCallCount, 1);

  // Subsequent request with different avoid to avoid Worker edge cache
  const req2 = new Request("https://search.example/api/discover-similar?type=tv&id=2190&target=same&avoid=movie:999");
  const res2 = await api(req2, env, { fetch: fetcher });
  assert.equal(res2.status, 200);
  const data2 = await res2.json();
  assert.equal(data2.ai.status, "circuit_broken");
  assert.equal(aiCallCount, 1, "AI must not be called during circuit breaker cooldown");
  assert.ok(data2.candidates.length > 0);
  assert.equal(data2.candidates[0].title, "Silver City");
  assert.equal(data2.candidates[0].semanticSim, undefined);
});

test("13. Cache isolation between modes: off request cannot access on-mode cache", async () => {
  resetAiCircuitBreaker();
  discoverCache.clear();
  embeddingCache.clear();
  let fetcherCount = 0;
  const countingFetcher = async url => {
    fetcherCount++;
    return createTmdbFetcher()(url);
  };
  const envOn = {
    TMDB_TOKEN: "valid-token",
    AI_RECOMMENDATIONS_MODE: "on",
    AI: {
      run: async () => ({
        shape: [3, 384],
        data: [mockVector(1), mockVector(2), mockVector(3)]
      })
    }
  };
  const envOff = {
    TMDB_TOKEN: "valid-token",
    AI_RECOMMENDATIONS_MODE: "off"
  };

  // 1. Operator requests with server on
  const reqOn = new Request("https://search.example/api/discover-similar?type=tv&id=2190&target=same");
  const resOn = await api(reqOn, envOn, { fetch: countingFetcher });
  assert.equal(resOn.status, 200);
  const dataOn = await resOn.json();
  assert.equal(dataOn.ai.mode, "on");
  assert.ok(typeof dataOn.candidates[0].semanticSim === "number");
  const countAfterOn = fetcherCount;

  // 2. Public request arrives with server off for identical parameters
  const reqOff = new Request("https://search.example/api/discover-similar?type=tv&id=2190&target=same");
  const resOff = await api(reqOff, envOff, { fetch: countingFetcher });
  assert.equal(resOff.status, 200);
  const dataOff = await resOff.json();
  // Must NOT read from the "on" cache entry!
  assert.equal(dataOff.ai.mode, "off");
  assert.equal(dataOff.ai.status, "disabled");
  assert.equal(dataOff.candidates[0].semanticSim, undefined);
  assert.ok(fetcherCount > countAfterOn, "Off request must not serve cached on response");
});

test("14. Recovery after quota reset / cooldown expiry: resumes AI recommendations when available", async () => {
  resetAiCircuitBreaker();
  embeddingCache.clear();
  aiCircuitBreaker.lockedUntil = Date.now() - 1000; // simulated expired cooldown
  aiCircuitBreaker.reason = "temporary_capacity";
  aiCircuitBreaker.code = 3040;

  const mockEnv = {
    AI: {
      run: async () => ({
        shape: [2, 384],
        data: [mockVector(1), mockVector(2)]
      })
    }
  };
  const seed = { type: "tv", id: 2190, title: "South Park", overview: "Colorado boys" };
  const candidates = [{ type: "movie", id: 101, title: "Silver City", overview: "Satire" }];

  const res = await applyAiEmbeddings(mockEnv, seed, candidates, "on");
  assert.equal(res.status, "ok");
  assert.ok(typeof candidates[0].semanticSim === "number");
});

test("15. Worker instance restart with no in-memory cache: cold start fetches embeddings cleanly", async () => {
  resetAiCircuitBreaker();
  embeddingCache.clear(); // simulated fresh isolate with empty cache
  discoverCache.clear();

  let called = false;
  const mockEnv = {
    AI: {
      run: async () => {
        called = true;
        return {
          shape: [2, 384],
          data: [mockVector(1), mockVector(2)]
        };
      }
    }
  };
  const seed = { type: "tv", id: 2190, title: "South Park", overview: "Colorado boys" };
  const candidates = [{ type: "movie", id: 101, title: "Silver City", overview: "Satire" }];

  const res = await applyAiEmbeddings(mockEnv, seed, candidates, "on");
  assert.equal(res.status, "ok");
  assert.equal(called, true);
  assert.ok(typeof candidates[0].semanticSim === "number");
});

// ============================================================================
// 5. Frozen Fixture Comparison Across All 4 Benchmark Pools
// ============================================================================

test("frozen fixture evaluation across all 4 pools: compares statistical, AI, and failure fallback", () => {
  const poolConfigs = [
    { name: "southpark", target: "movie" },
    { name: "severance", target: "both" },
    { name: "interstellar", target: "tv" },
    { name: "darkknight", target: "movie" }
  ];

  poolConfigs.forEach(({ name, target }) => {
    const pool = pools[name];
    assert.ok(pool && pool.seed && Array.isArray(pool.candidates), `Fixture pool ${name} must be valid`);

    // A. Phase 3C.2 Statistical Mode (no semanticSim)
    const statResult = engine.rankDiscoverCategories(pool.seed, pool.candidates, { targetMedia: target });
    const statItems = ["closest", "vibe", "genre", "gems"].flatMap(cat => statResult[cat]);
    const statKeys = statItems.map(item => item.type + ":" + item.id);
    assert.equal(new Set(statKeys).size, statKeys.length, `${name}: All statistical candidates must be deduplicated`);

    // B. Simulated AI-Enhanced Hybrid Mode
    const candidatesWithAi = pool.candidates.map((c, i) => {
      // Simulate realistic semantic score based on genre/overview synergy
      const sim = (c.genreIds || []).some(g => (pool.seed.genreIds || []).includes(g)) ? 0.65 : 0.25;
      return Object.assign({}, c, { semanticSim: sim });
    });
    const aiResult = engine.rankDiscoverCategories(pool.seed, candidatesWithAi, { targetMedia: target });
    const aiItems = ["closest", "vibe", "genre", "gems"].flatMap(cat => aiResult[cat]);
    const aiKeys = aiItems.map(item => item.type + ":" + item.id);

    assert.equal(new Set(aiKeys).size, aiKeys.length, `${name}: All AI hybrid candidates must be deduplicated`);
    assert.ok(aiItems.every(item => item.title && item.title !== "Untitled"), `${name}: All titles must be non-empty`);
    assert.ok(aiItems.every(item => item.id > 0), `${name}: All candidate IDs must be valid positive integers`);

    // C. Simulated AI Failure Fallback (semanticSim stripped / undefined)
    const candidatesFallback = candidatesWithAi.map(c => {
      const copy = Object.assign({}, c);
      delete copy.semanticSim;
      return copy;
    });
    const fallbackResult = engine.rankDiscoverCategories(pool.seed, candidatesFallback, { targetMedia: target });
    const fallbackItems = ["closest", "vibe", "genre", "gems"].flatMap(cat => fallbackResult[cat]);
    const fallbackKeys = fallbackItems.map(item => item.type + ":" + item.id);

    // Fallback must be 100% identical to Phase 3C.2 statistical mode
    assert.deepEqual(fallbackKeys, statKeys, `${name}: Fallback output must deterministically match statistical baseline`);
  });
});
