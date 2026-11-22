import { handleApi } from "./cloud/api.js";
import { watchRelayAvailability, watchRelayCatalog, watchRelayTicket } from "./cloud/watch-relay-api.js";

const TMDB = "https://api.themoviedb.org/3";
const SHOOFAFLAM_BASE = "https://shoofaflam.tv";
const TYPES = new Set(["movie", "tv"]);
const buckets = new Map(); // Best-effort per-isolate guard; Cloudflare edge cache is the main cost control.
const searchCache = new Map();
const arabicSearchCache = new Map();
const recommendationCache = new Map();
const discoverCache = new Map();
const embeddingCache = new Map();
const SEARCH_LIMIT = 18;
const ARABIC_SEARCH_LIMIT = 24;
const EXPANSIONS = "etaoinsh"; // Common next letters, including continuations such as t and h.
const SEARCH_CACHE_MS = 5 * 60 * 1000;
const SHOOFAFLAM_CACHE_MS = 6 * 60 * 60 * 1000;
let shoofAflamCache = { at: 0, titles: null, platformsBySlug: null, promise: null };

const GENRE_NAMES = {
  12: "Adventure", 14: "Fantasy", 16: "Animation", 18: "Drama", 27: "Horror",
  28: "Action", 35: "Comedy", 36: "History", 37: "Western", 53: "Thriller",
  80: "Crime", 99: "Documentary", 878: "Sci-Fi", 9648: "Mystery", 10402: "Music",
  10749: "Romance", 10751: "Family", 10752: "War", 10759: "Action & Adventure",
  10762: "Kids", 10763: "News", 10764: "Reality", 10765: "Sci-Fi & Fantasy",
  10766: "Soap", 10767: "Talk", 10768: "War & Politics", 10770: "TV Movie"
};

const aiCircuitBreaker = {
  lockedUntil: 0,
  reason: null,
  code: null
};

function resetAiCircuitBreaker() {
  aiCircuitBreaker.lockedUntil = 0;
  aiCircuitBreaker.reason = null;
  aiCircuitBreaker.code = null;
}

function nextUtcMidnightWithJitter() {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime() + Math.floor(Math.random() * 60000);
}

function cacheVector(key, vec) {
  if (embeddingCache.size >= 250) {
    embeddingCache.delete(embeddingCache.keys().next().value);
  }
  embeddingCache.set(key, vec);
}

function formatSemanticDoc(item) {
  const name = String(item.title || item.name || "Untitled").trim();
  const rawGenres = Array.isArray(item.genres) && item.genres.length
    ? item.genres.map(g => (typeof g === "object" ? g.name : String(g)))
    : Array.isArray(item.genreIds)
      ? item.genreIds.map(id => GENRE_NAMES[id] || "")
      : [];
  // Animation (16) is a presentation style, not a thematic similarity genre.
  const genres = rawGenres
    .filter(g => g && g !== "Animation" && g !== "16")
    .slice(0, 4)
    .join(", ");
  const keywords = Array.isArray(item.keywords) && item.keywords.length
    ? item.keywords.map(k => typeof k === "object" ? k.name : String(k)).filter(Boolean).slice(0, 6).join(", ")
    : "";
  const plot = String(item.overview || "").trim();
  const parts = [`Title: ${name}`];
  if (genres) parts.push(`Genres: ${genres}`);
  if (keywords) parts.push(`Themes: ${keywords}`);
  if (plot) parts.push(`Plot: ${plot}`);
  return parts.join(". ").slice(0, 800);
}

function vectorCosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA <= 0 || normB <= 0) return 0;
  const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Math.min(1, Math.max(0, sim));
}

function resolveAiMode(env, url, request, options = {}) {
  const configured = String(env?.AI_RECOMMENDATIONS_MODE || "off").toLowerCase().trim();
  const serverMode = ["on", "shadow", "off"].includes(configured) ? configured : "off";

  // Programmatic internal option (e.g., test runner)
  if (options && options.aiMode && ["on", "shadow", "off"].includes(options.aiMode)) {
    return options.aiMode;
  }

  const queryAi = url ? url.searchParams.get("ai") : null;
  if (!queryAi) return serverMode;

  const requestedMode = queryAi.toLowerCase().trim();
  if (!["on", "shadow", "off"].includes(requestedMode)) {
    return null; // Malformed -> trigger 400 invalid_query
  }

  // Check if caller provides an authorized operator secret
  const authHeader = request?.headers ? request.headers.get("x-horizon-ai-auth") : null;
  const isAuthorized = Boolean(env?.AI_OVERRIDE_SECRET && authHeader && authHeader === env.AI_OVERRIDE_SECRET);

  if (isAuthorized) return requestedMode;

  // Unauthenticated public request:
  // Can only de-escalate (e.g. "on" -> "off", "shadow" -> "off")
  // Can NEVER escalate mode from "off" to "on"/"shadow", or "shadow" to "on"
  if (serverMode === "off") {
    return "off";
  }
  if (serverMode === "shadow" && requestedMode === "on") {
    return "shadow";
  }
  return requestedMode;
}

async function applyAiEmbeddings(env, seed, candidates, effectiveAiMode) {
  if (effectiveAiMode === "off" || !candidates || !candidates.length) {
    return { mode: "off", status: "disabled" };
  }

  const now = Date.now();
  if (now < aiCircuitBreaker.lockedUntil) {
    return {
      mode: effectiveAiMode,
      status: "circuit_broken",
      reason: aiCircuitBreaker.reason,
      code: aiCircuitBreaker.code,
      retryAfterMs: Math.max(0, aiCircuitBreaker.lockedUntil - now)
    };
  }

  if (!env || !env.AI || typeof env.AI.run !== "function") {
    return {
      mode: effectiveAiMode,
      status: "unavailable",
      reason: "missing_ai_binding"
    };
  }

  const startTime = Date.now();
  const candidateLimit = 20; // Bounded batch for budget safety
  const targetCandidates = candidates.slice(0, candidateLimit);

  const seedKey = `v1:${seed.type}:${seed.id}:${(seed.overview || "").slice(0, 40)}`;
  let seedVec = embeddingCache.get(seedKey);

  const toFetch = [];
  const textToIndex = new Map();
  const fetchIndices = [];

  if (!seedVec) {
    const seedDoc = formatSemanticDoc(seed);
    toFetch.push(seedDoc);
    textToIndex.set(seedDoc, 0);
    fetchIndices.push({ type: "seed", fetchIndex: 0 });
  }

  targetCandidates.forEach((cand, i) => {
    const cKey = `v1:${cand.type}:${cand.id}:${(cand.overview || "").slice(0, 40)}`;
    const cVec = embeddingCache.get(cKey);
    if (cVec) {
      cand._cachedVec = cVec;
    } else {
      const doc = formatSemanticDoc(cand);
      let fIndex = textToIndex.get(doc);
      if (fIndex === undefined) {
        fIndex = toFetch.length;
        toFetch.push(doc);
        textToIndex.set(doc, fIndex);
      }
      fetchIndices.push({ type: "candidate", index: i, key: cKey, fetchIndex: fIndex });
    }
  });

  if (toFetch.length > 0) {
    let timer;
    try {
      const aiPromise = env.AI.run("@cf/baai/bge-small-en-v1.5", { text: toFetch });
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("ai_inference_timeout")), 2500);
      });
      const res = await Promise.race([aiPromise, timeoutPromise]);
      clearTimeout(timer);

      let vectors = null;
      if (Array.isArray(res?.data)) {
        if (toFetch.length === 1 && typeof res.data[0] === "number") {
          vectors = [res.data];
        } else {
          vectors = res.data;
        }
      }

      if (!vectors || vectors.length !== toFetch.length) {
        throw new Error("malformed_ai_response");
      }

      for (let k = 0; k < fetchIndices.length; k++) {
        const item = fetchIndices[k];
        const vec = vectors[item.fetchIndex];
        if (!Array.isArray(vec) || !Number.isFinite(vec[0]) || vec.length !== 384) {
          throw new Error("invalid_vector_dimensions");
        }
        if (item.type === "seed") {
          seedVec = vec;
          cacheVector(seedKey, vec);
        } else {
          targetCandidates[item.index]._cachedVec = vec;
          cacheVector(item.key, vec);
        }
      }
    } catch (err) {
      if (timer) clearTimeout(timer);
      const errMsg = String(err?.message || err);
      const errCode = err?.code || (errMsg.includes("3036") ? 3036 : errMsg.includes("3040") ? 3040 : null);

      let safeReason = "inference_error";
      if (errCode === 3036 || errMsg.includes("allowance") || errMsg.includes("quota")) {
        aiCircuitBreaker.lockedUntil = nextUtcMidnightWithJitter();
        aiCircuitBreaker.reason = "quota_exhausted";
        aiCircuitBreaker.code = 3036;
        safeReason = "quota_exhausted";
      } else if (errCode === 3040 || errMsg.includes("capacity") || errMsg.includes("429")) {
        aiCircuitBreaker.lockedUntil = Date.now() + 60000;
        aiCircuitBreaker.reason = "temporary_capacity";
        aiCircuitBreaker.code = 3040;
        safeReason = "temporary_capacity";
      } else if (errMsg.includes("timeout")) {
        aiCircuitBreaker.lockedUntil = Date.now() + 30000;
        aiCircuitBreaker.reason = "timeout";
        aiCircuitBreaker.code = "timeout";
        safeReason = "timeout";
      } else if (errMsg.includes("invalid_vector_dimensions") || errMsg.includes("malformed")) {
        aiCircuitBreaker.lockedUntil = Date.now() + 30000;
        aiCircuitBreaker.reason = "malformed_output";
        aiCircuitBreaker.code = "malformed_output";
        safeReason = "malformed_output";
      } else {
        aiCircuitBreaker.lockedUntil = Date.now() + 30000;
        aiCircuitBreaker.reason = "inference_error";
        aiCircuitBreaker.code = errCode || "inference_error";
        safeReason = "inference_error";
      }

      targetCandidates.forEach(cand => { delete cand._cachedVec; });

      return {
        mode: effectiveAiMode,
        status: "fallback_statistical",
        reason: safeReason,
        circuitLockedUntil: aiCircuitBreaker.lockedUntil
      };
    }
  }

  if (!seedVec) {
    targetCandidates.forEach(cand => { delete cand._cachedVec; });
    return { mode: effectiveAiMode, status: "fallback_statistical", reason: "missing_seed_vector" };
  }

  let scoredCount = 0;
  targetCandidates.forEach(cand => {
    const cVec = cand._cachedVec;
    delete cand._cachedVec;
    if (cVec) {
      const sim = vectorCosineSimilarity(seedVec, cVec);
      if (effectiveAiMode === "on") {
        cand.semanticSim = Math.round(sim * 10000) / 10000;
      }
      scoredCount++;
    }
  });

  return {
    mode: effectiveAiMode,
    status: "ok",
    model: "@cf/baai/bge-small-en-v1.5",
    candidatesScored: scoredCount,
    latencyMs: Date.now() - startTime
  };
}

function json(status, value, ttl = 0, retryAfter = 0) {
  return new Response(JSON.stringify(value), { status, headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": ttl ? `public, max-age=${ttl}` : "no-store",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    "X-Horizon-Arabic-Api": "1",
    ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}),
  } });
}
function positive(text, maximum = 999999999) {
  return /^[1-9][0-9]*$/.test(text || "") && Number(text) <= maximum ? Number(text) : null;
}
function image(path) { return typeof path === "string" && /^\/[a-zA-Z0-9._-]{1,90}$/.test(path) ? path : null; }
function watchLink(link, type, id) {
  if (typeof link !== "string") return null;
  try { const url = new URL(link);
    return url.protocol === "https:" && url.hostname === "www.themoviedb.org"
      && url.pathname === `/${type}/${id}/watch` && url.searchParams.get("locale") === "US"
      ? url.href : null;
  } catch { return null; }
}
function title(row, type) {
  return { type, id: row.id, title: String(row.title || row.name || "Untitled").slice(0, 160),
    date: String(row.release_date || row.first_air_date || "").slice(0, 10),
    popularity: Number.isFinite(row.popularity) ? Math.max(0, Math.min(row.popularity, 1000000000)) : 0,
    voteCount: Number.isSafeInteger(row.vote_count) ? Math.max(0, Math.min(row.vote_count, 1000000000)) : 0,
    originalTitle: String(row.original_title || row.original_name || "").slice(0, 160),
    originalLanguage: typeof row.original_language === "string" && /^[a-z]{2,3}$/.test(row.original_language)
      ? row.original_language : "",
    overview: String(row.overview || "").slice(0, 1800),
    genres: Array.isArray(row.genres) ? row.genres.filter(genre => genre && Number.isInteger(genre.id)
      && typeof genre.name === "string").slice(0, 8).map(genre => String(genre.name).slice(0, 40)) : [],
    poster: image(row.poster_path), backdrop: image(row.backdrop_path),
    tvdbId: type === "tv" && Number.isSafeInteger(row.external_ids?.tvdb_id)
      && row.external_ids.tvdb_id > 0 ? row.external_ids.tvdb_id : null,
    seasons: type === "tv" && Array.isArray(row.seasons) ? row.seasons
      .filter(s => Number.isInteger(s.season_number) && s.season_number > 0 && s.season_number <= 100
        && Number.isInteger(s.episode_count) && s.episode_count > 0)
      .map(s => ({ number: s.season_number, count: s.episode_count,
        name: String(s.name || `Season ${s.season_number}`).slice(0, 100) })) : undefined };
}
function recommendationTitle(row, type) {
  const base = title(row, type);
  return { ...base, genreIds: Array.isArray(row.genre_ids) ? row.genre_ids.filter(id => Number.isInteger(id) && id > 0).slice(0, 8) : [],
    keywordIds: [], voteAverage: Number.isFinite(row.vote_average) ? Math.max(0, Math.min(10, row.vote_average)) : 0,
    sources: [] };
}
function recommendationSeeds(text) {
  if (!text) return [];
  const parts = text.split(",");
  if (parts.length > 3 || new Set(parts).size !== parts.length) return null;
  return parts.map(part => {
    const match = /^(movie|tv):([1-9][0-9]*)$/.exec(part);
    return match && positive(match[2]) ? { type: match[1], id: Number(match[2]), key: part } : null;
  }).every(Boolean) ? parts.map(part => { const [type, id] = part.split(":");
    return { type, id: Number(id), key: part }; }) : null;
}
async function recommendTmdb(fetcher, env, seeds, avoids, signal) {
  const details = async seed => {
    try {
      const data = await tmdbJson(fetcher, env,
        `/${seed.type}/${seed.id}?language=en-US&append_to_response=keywords`, signal);
      const keywords = seed.type === "movie" ? data.keywords?.keywords : data.keywords?.results;
      return { type: seed.type, id: seed.id, title: String(data.title || data.name || "").slice(0, 160),
        originalLanguage: typeof data.original_language === "string" && /^[a-z]{2,3}$/.test(data.original_language)
          ? data.original_language : "",
        genreIds: (data.genres || []).filter(g => Number.isInteger(g.id) && g.id > 0).slice(0, 8).map(g => g.id),
        keywordIds: (Array.isArray(keywords) ? keywords : []).filter(k => Number.isInteger(k.id) && k.id > 0)
          .slice(0, 8).map(k => k.id) };
    } catch { return { type: seed.type, id: seed.id, title: "", genreIds: [], keywordIds: [] }; }
  };
  const [seedDetails, avoidDetails] = await Promise.all([
    Promise.all(seeds.map(details)), Promise.all(avoids.map(details))]);
  const queries = [];
  seeds.forEach(seed => {
    for (const kind of ["recommendation", "similar"])
      queries.push({ path: `/${seed.type}/${seed.id}/${kind === "recommendation" ? "recommendations" : "similar"}?language=en-US&page=1`,
        type: seed.type, source: { kind, seed: seed.key } });
  });
  for (const type of ["movie", "tv"]) {
    const seed = seedDetails.find(item => item.type === type && item.genreIds.length);
    if (seed) {
      const genreId = seed.genreIds[0], keywordId = seed.keywordIds[0];
      queries.push({ path: `/discover/${type}?language=en-US&sort_by=popularity.desc&include_adult=false&vote_count.gte=100&with_genres=${genreId}${keywordId ? `&with_keywords=${keywordId}` : ""}&page=1`,
        type, source: { kind: "discovery", genreId, keywordId: keywordId || null } });
    }
    queries.push({ path: `/trending/${type}/week?language=en-US&page=1`, type,
      source: { kind: "trending" } });
  }
  // At most 3 seed details + 2 disliked details + 6 related lists + 2 discovery + 2 trending = 15 TMDB calls.
  const settled = await Promise.allSettled(queries.map(query => tmdbJson(fetcher, env, query.path, signal)));
  if (!settled.some(result => result.status === "fulfilled")) {
    const error = new Error("metadata_unavailable"); error.status = 502; throw error;
  }
  const candidates = new Map();
  settled.forEach((result, index) => {
    if (result.status !== "fulfilled") return;
    const query = queries[index], rows = Array.isArray(result.value.results) ? result.value.results : [];
    rows.slice(0, 20).forEach(row => {
      if (!Number.isInteger(row.id) || row.id <= 0 || row.adult) return;
      const identity = `${query.type}:${row.id}`;
      let candidate = candidates.get(identity);
      if (!candidate) { candidate = recommendationTitle(row, query.type); candidates.set(identity, candidate); }
      candidate.sources.push(query.source);
      if (query.source.kind === "discovery" && query.source.keywordId
          && !candidate.keywordIds.includes(query.source.keywordId))
        candidate.keywordIds.push(query.source.keywordId); // Proven by the discover filter.
    });
  });
  return { seeds: seedDetails, avoids: avoidDetails, candidates: [...candidates.values()].slice(0, 180) };
}
const WORKER_MOVIE_TO_TV_GENRES = {
  28: [10759], 12: [10759], 16: [16], 35: [35], 80: [80], 99: [99], 18: [18],
  10751: [10751, 10762], 14: [10765], 36: [18, 10768], 27: [9648, 18],
  10402: [10402], 9648: [9648], 10749: [18, 10766], 878: [10765], 53: [9648, 80],
  10752: [10768], 37: [37]
};
const WORKER_TV_TO_MOVIE_GENRES = {
  10759: [28, 12], 16: [16], 35: [35], 80: [80], 99: [99], 18: [18],
  10751: [10751], 10762: [16, 10751], 9648: [9648, 53], 10765: [878, 14],
  10766: [10749, 18], 10768: [10752, 36], 37: [37]
};
function mapWorkerGenres(sourceType, targetType, genreIds) {
  if (!Array.isArray(genreIds) || !genreIds.length) return [];
  if (sourceType === targetType) return genreIds.slice();
  const mapping = sourceType === "movie" ? WORKER_MOVIE_TO_TV_GENRES : WORKER_TV_TO_MOVIE_GENRES;
  const mapped = new Set();
  genreIds.forEach(g => {
    const targets = mapping[g] || [g];
    targets.forEach(t => mapped.add(t));
  });
  return Array.from(mapped);
}
const CROSS_MEDIA_GENRE_PRIORITY = [878, 10765, 9648, 14, 80, 27, 99, 53, 12, 10759, 28, 35, 18];
const BROAD_CROSS_MEDIA_KEYWORDS = new Set(["office", "workplace", "office politics", "colorado",
  "family", "friendship", "love", "school", "elementary school"]);
async function discoverSimilarTmdb(fetcher, env, type, id, target, avoids, signal, aiMode = "off") {
  const seedRaw = await tmdbJson(fetcher, env,
    `/${type}/${id}?language=en-US&append_to_response=keywords,credits,${type === "tv" ? "content_ratings" : "release_dates"}`, signal);
  const seedDetail = detail(seedRaw, type);
  const kwList = type === "movie" ? seedRaw.keywords?.keywords : seedRaw.keywords?.results;
  seedDetail.keywords = Array.isArray(kwList) ? kwList.slice(0, 15).map(k => ({ id: k.id, name: String(k.name || "").slice(0, 50) })) : [];
  seedDetail.keywordIds = seedDetail.keywords.map(k => k.id);
  seedDetail.genreIds = (seedRaw.genres || []).filter(g => Number.isInteger(g.id) && g.id > 0).map(g => g.id);

  const queries = [];
  const includeSame = target === "same" || target === "both" || target === type;
  const oppType = type === "movie" ? "tv" : "movie";
  const includeOpposite = target === "both" || target === oppType;

  const validKeywords = (seedDetail.keywords || []).filter(k => k && k.name && !BROAD_CROSS_MEDIA_KEYWORDS.has(String(k.name).toLowerCase())).slice(0, 5);
  const kwIds = validKeywords.map(k => k.id);
  const kwParam = kwIds.length ? `&with_keywords=${kwIds.join("|")}` : "";

  if (includeSame) {
    queries.push({ path: `/${type}/${id}/recommendations?language=en-US&page=1`, type, kind: "recommendation" });
    queries.push({ path: `/${type}/${id}/similar?language=en-US&page=1`, type, kind: "similar" });
    if (seedDetail.genreIds.length) {
      const g = seedDetail.genreIds[0];
      queries.push({
        path: `/discover/${type}?language=en-US&sort_by=popularity.desc&include_adult=false&vote_count.gte=30&with_genres=${g}${kwParam}&page=1`,
        type, kind: "discovery", keywordIds: kwIds
      });
    }
  }

  if (includeOpposite) {
    const mapped = mapWorkerGenres(type, oppType, seedDetail.genreIds);
    const genre = CROSS_MEDIA_GENRE_PRIORITY.find(g => mapped.includes(g)) || mapped[0];
    if (mapped.length) {
      queries.push({
        path: `/discover/${oppType}?language=en-US&sort_by=popularity.desc&include_adult=false&vote_count.gte=30&with_genres=${genre}${kwParam}&page=1`,
        type: oppType, kind: "cross_media", keywordIds: kwIds
      });
      queries.push({
        path: `/discover/${oppType}?language=en-US&sort_by=vote_average.desc&vote_count.gte=80&include_adult=false&with_genres=${genre}&page=1`,
        type: oppType, kind: "cross_media"
      });
    }
  }

  const settled = await Promise.allSettled(queries.map(q => tmdbJson(fetcher, env, q.path, signal)));
  const candidates = new Map();
  const avoidKeys = new Set((avoids || []).map(a => a.key));

  settled.forEach((result, idx) => {
    if (result.status !== "fulfilled") return;
    const q = queries[idx], rows = Array.isArray(result.value.results) ? result.value.results : [];
    rows.slice(0, 20).forEach((row, rank) => {
      if (!Number.isInteger(row.id) || row.id <= 0 || row.adult) return;
      const key = `${q.type}:${row.id}`;
      if (key === `${type}:${id}` || avoidKeys.has(key)) return;
      let cand = candidates.get(key);
      if (!cand) {
        cand = recommendationTitle(row, q.type);
        candidates.set(key, cand);
      }
      cand.sources.push({ kind: q.kind, rank });
      if (Array.isArray(q.keywordIds)) {
        q.keywordIds.forEach(kId => {
          if (!cand.keywordIds.includes(kId)) cand.keywordIds.push(kId);
        });
      } else if (q.keywordId && !cand.keywordIds.includes(q.keywordId)) {
        cand.keywordIds.push(q.keywordId);
      }
    });
  });

  const candidatesList = [...candidates.values()].slice(0, 180);
  const aiDiagnostics = await applyAiEmbeddings(env, seedDetail, candidatesList, aiMode);

  return {
    seed: seedDetail,
    candidates: candidatesList,
    ai: aiDiagnostics
  };
}
function detail(row, type) {
  const base = title(row, type);
  const names = values => Array.isArray(values) ? values.filter(value => value && typeof value.name === "string")
    .slice(0, 5).map(value => value.name.slice(0, 70)) : [];
  const crew = Array.isArray(row.credits?.crew) ? row.credits.crew : [];
  const cast = Array.isArray(row.credits?.cast) ? row.credits.cast : [];
  const directors = type === "movie" ? names(crew.filter(value => value.job === "Director")) : [];
  const creators = type === "tv" ? names(row.created_by) : [];
  const usRating = type === "tv"
    ? row.content_ratings?.results?.find(value => value.iso_3166_1 === "US")?.rating
    : row.release_dates?.results?.find(value => value.iso_3166_1 === "US")?.release_dates
      ?.find(value => typeof value.certification === "string" && value.certification)?.certification;
  return { ...base,
    cast: names(cast), directors, creators,
    networks: type === "tv" ? names(row.networks) : [],
    studios: type === "movie" ? names(row.production_companies) : [],
    runtime: type === "movie" && Number.isInteger(row.runtime) && row.runtime > 0 ? row.runtime : null,
    episodeRuntime: type === "tv" && Array.isArray(row.episode_run_time)
      ? row.episode_run_time.find(value => Number.isInteger(value) && value > 0) || null : null,
    status: typeof row.status === "string" ? row.status.slice(0, 60) : "",
    originalLanguage: typeof row.original_language === "string" && /^[a-z]{2,3}$/.test(row.original_language)
      ? row.original_language : "",
    rating: typeof usRating === "string" ? usRating.slice(0, 12) : "" };
}
function arabicMovieIdentity(row) {
  const years = new Set();
  const regions = row.release_dates?.results;
  for (const region of Array.isArray(regions) ? regions : []) {
    for (const release of Array.isArray(region?.release_dates) ? region.release_dates : []) {
      if (![1, 2, 3, 4].includes(release.type)) continue;
      const year = /^\d{4}(?=-)/.exec(release.release_date || "")?.[0];
      if (year) years.add(year);
    }
  }
  const alternatives = row.alternative_titles?.titles;
  const titles = (Array.isArray(alternatives) ? alternatives : []).filter(item => typeof item?.title === "string" && item.title.trim()
    && (/\p{Script=Arabic}/u.test(item.title) || /^(?:US|GB|CA|AU)$/.test(item.iso_3166_1)))
    .map(item => item.title.trim().slice(0, 100));
  const original = list => (Array.isArray(list) ? list : [])
    .slice(0, 6).map(item => typeof item.original_name === "string" ? item.original_name.slice(0, 70) : "").filter(Boolean);
  const crew = Array.isArray(row.credits?.crew) ? row.credits.crew : [];
  return {
    alternativeTitles: [...new Set(titles)].slice(0, 8),
    releaseYears: [...years].sort().slice(0, 12),
    originalCast: original(row.credits?.cast),
    originalDirectors: original(crew.filter(item => item.job === "Director")),
  };
}

function results(payload, filter) {
  return (Array.isArray(payload.results) ? payload.results : []).filter(row => {
    const type = filter === "all" ? row.media_type : filter;
    return TYPES.has(type) && Number.isInteger(row.id) && row.id > 0 && !row.adult;
  }).map(row => title(row, filter === "all" ? row.media_type : filter));
}
function matchQuality(value, query) {
  const name = String(value || "").toLocaleLowerCase().trim();
  if (!name) return 0;
  if (name === query) return query.length <= 5 ? 95 : 125;
  if (name.startsWith(query)) return 80;
  if (name.split(/[^\p{L}\p{N}]+/u).some(word => word.startsWith(query))) return 35;
  return name.includes(query) ? 22 : 0;
}
function score(row, query) {
  const primary = matchQuality(row.title, query);
  const original = matchQuality(row.originalTitle, query);
  const relevance = Math.max(primary, original ? original - 8 : 0);
  const popularity = Math.log1p(row.popularity || 0) * 8;
  const votes = Math.log1p(row.voteCount || 0) * 7;
  return relevance + popularity + votes;
}
function rankCandidates(candidates, query) {
  const unique = new Map();
  for (const row of candidates) unique.set(`${row.type}:${row.id}`, row);
  return [...unique.values()].sort((a, b) => score(b, query) - score(a, query)
    || (b.voteCount || 0) - (a.voteCount || 0) || a.id - b.id).slice(0, SEARCH_LIMIT);
}
async function tmdbJson(fetcher, env, path, signal) {
  const response = await fetcher(TMDB + path, { headers: {
    Authorization: `Bearer ${env.TMDB_TOKEN}`, Accept: "application/json" }, signal });
  if (!response.ok) {
    const error = new Error("tmdb_request_failed"); error.status = response.status;
    const seconds = Number(response.headers.get("Retry-After"));
    error.retryAfter = Number.isFinite(seconds) ? Math.max(1, Math.min(60, Math.ceil(seconds))) : 10;
    throw error;
  }
  return response.json();
}
async function searchTmdb(fetcher, env, query, filter, signal) {
  const endpoint = filter === "all" ? "multi" : filter;
  const path = (text, page) => `/search/${endpoint}?query=${encodeURIComponent(text)}&include_adult=false&language=en-US&page=${page}`;
  const first = await tmdbJson(fetcher, env, path(query, 1), signal);
  const candidates = results(first, filter);
  if ((query.length === 3 || query.length === 4) && /^[a-z]+$/i.test(query)) {
    // TMDB can put obscure exact matches ahead of popular longer titles. Probe
    // a fixed, bounded set of next-letter prefixes regardless of the first
    // page's quality; unrelated matches must not suppress candidate retrieval.
    const requests = [...EXPANSIONS].map(letter =>
      tmdbJson(fetcher, env, path(query + letter, 1), signal));
    if (Number(first.total_pages) > 1) requests.push(tmdbJson(fetcher, env, path(query, 2), signal));
    const pages = await Promise.all(requests);
    pages.forEach(page => candidates.push(...results(page, filter)));
  } else {
    const count = Math.min(3, Number.isInteger(first.total_pages) ? first.total_pages : 1);
    const requests = Array.from({ length: count - 1 }, (_, i) =>
      tmdbJson(fetcher, env, path(query, i + 2), signal));
    // A four-letter stem recovers longer prefix titles that TMDB's full-query
    // ordering may place beyond the bounded page window.
    if (query.length >= 5 && query.length <= 6 && /^[a-z]+$/i.test(query))
      requests.push(tmdbJson(fetcher, env, path(query.slice(0, 4), 1), signal));
    if (requests.length) {
      const pages = await Promise.all(requests);
      pages.forEach(page => candidates.push(...results(page, filter)));
    }
  }
  return { results: rankCandidates(candidates, query.toLocaleLowerCase()) };
}
function providers(payload, type, id) {
  const us = payload.results && payload.results.US || {};
  const group = list => (Array.isArray(list) ? list : []).filter(p => Number.isInteger(p.provider_id))
    .slice(0, 24).map(p => ({ id: p.provider_id, name: String(p.provider_name || "").slice(0, 90),
      logo: image(p.logo_path) }));
  return { stream: group(us.flatrate), free: group(us.free).concat(group(us.ads)),
    rent: group(us.rent), buy: group(us.buy),
    link: watchLink(us.link, type, id),
    source: "TMDB / JustWatch", checkedAt: new Date().toISOString() };
}
function season(payload, today) {
  return { number: payload.season_number, episodes: (Array.isArray(payload.episodes) ? payload.episodes : [])
    .filter(e => Number.isInteger(e.episode_number) && e.episode_number > 0
      && typeof e.air_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.air_date)
      && e.air_date <= today && e.episode_type !== "special")
    .slice(0, 80).map(e => ({ number: e.episode_number, title: String(e.name || "Episode").slice(0, 160),
      date: e.air_date, overview: String(e.overview || "").slice(0, 1000), still: image(e.still_path) })) };
}

const ARABIC_DIACRITICS_RE = /[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;
const ARABIC_SUBSCRIPTION_SLUGS = new Set(["shahid", "netflix", "watchit", "osn", "starzplay", "tod", "disney", "prime", "yango"]);

function normalizeArabicText(value) {
  return String(value || "")
    .replace(ARABIC_DIACRITICS_RE, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .toLowerCase()
    .trim();
}

function stableSynthId(prefixBase, keyStr) {
  let hash = 0;
  for (let i = 0; i < keyStr.length; i++) {
    hash = ((hash * 33) ^ keyStr.charCodeAt(i)) >>> 0;
  }
  return prefixBase + (hash % 900000);
}

function classifyShoofPlatform(slug, info) {
  const s = String(slug || "").toLowerCase();
  const isSub = ARABIC_SUBSCRIPTION_SLUGS.has(s);
  return {
    slug: s.slice(0, 40),
    nameAr: info && typeof info.name_ar === "string" ? info.name_ar.slice(0, 60) : s,
    nameEn: info && typeof info.name_en === "string" ? info.name_en.slice(0, 60) : s,
    tier: isSub ? "subscription" : "listed",
    url: info && typeof info.url === "string" ? info.url.slice(0, 160) : ""
  };
}

async function loadShoofAflamIndex(fetcher, signal) {
  if (shoofAflamCache.titles && Date.now() - shoofAflamCache.at < SHOOFAFLAM_CACHE_MS) {
    return shoofAflamCache;
  }
  if (shoofAflamCache.promise) return shoofAflamCache.promise;
  shoofAflamCache.promise = (async () => {
    try {
      const innerCtrl = new AbortController();
      const t = setTimeout(() => innerCtrl.abort(), 3500);
      const onAbort = () => innerCtrl.abort();
      if (signal) {
        if (signal.aborted) innerCtrl.abort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      try {
        const [titlesRes, platRes] = await Promise.allSettled([
          fetcher(`${SHOOFAFLAM_BASE}/api/titles.json`, { headers: { Accept: "application/json" }, signal: innerCtrl.signal }),
          fetcher(`${SHOOFAFLAM_BASE}/api/platforms.json`, { headers: { Accept: "application/json" }, signal: innerCtrl.signal })
        ]);
        if (titlesRes.status !== "fulfilled" || !titlesRes.value.ok) return { titles: [], platformsBySlug: {} };
        const rawTitles = await titlesRes.value.json();
        const rawPlats = platRes.status === "fulfilled" && platRes.value.ok ? await platRes.value.json() : [];
        const platformsBySlug = {};
        if (Array.isArray(rawPlats)) {
          for (const p of rawPlats) {
            if (p && typeof p.slug === "string") platformsBySlug[p.slug.toLowerCase()] = p;
          }
        }
        const list = Array.isArray(rawTitles) ? rawTitles : (rawTitles && Array.isArray(rawTitles.titles) ? rawTitles.titles : []);
        const indexed = list.filter(x => x && typeof x.slug === "string").map(x => {
          const mediaType = x.type === "movie" ? "movie" : "tv";
          const titleAr = String(x.title_ar || "").slice(0, 160);
          const titleEn = String(x.title_en || "").slice(0, 160);
          return {
            slug: x.slug.slice(0, 100),
            type: mediaType,
            titleAr,
            titleEn,
            normAr: normalizeArabicText(titleAr),
            normEn: normalizeArabicText(titleEn),
            year: Number.isInteger(x.year) ? x.year : (Number(String(x.year || "").slice(0, 4)) || 0),
            poster: image(x.poster_path),
            genre: typeof x.genre === "string" ? x.genre.slice(0, 40) : "",
            rating: Number.isFinite(x.vote_average) ? x.vote_average : (Number.isFinite(x.rating) ? x.rating : 0),
            platforms: Array.isArray(x.platforms) ? x.platforms.slice(0, 12).map(p => String(p).toLowerCase()) : []
          };
        });
        shoofAflamCache = { at: Date.now(), titles: indexed, platformsBySlug, promise: null };
        return shoofAflamCache;
      } finally {
        clearTimeout(t);
        if (signal) signal.removeEventListener("abort", onAbort);
      }
    } catch {
      return { titles: shoofAflamCache.titles || [], platformsBySlug: shoofAflamCache.platformsBySlug || {} };
    } finally {
      shoofAflamCache.promise = null;
    }
  })();
  return shoofAflamCache.promise;
}

function searchShoofAflamLocal(index, query, filter) {
  const normQ = normalizeArabicText(query);
  if (!normQ || !index || !Array.isArray(index.titles)) return [];
  const tokens = normQ.split(" ").filter(Boolean);
  const scored = [];
  for (const entry of index.titles) {
    if (filter !== "all" && entry.type !== filter) continue;
    const matched = (entry.normAr && (entry.normAr.includes(normQ) || tokens.every(tok => entry.normAr.includes(tok))))
      || (entry.normEn && (entry.normEn.includes(normQ) || tokens.every(tok => entry.normEn.includes(tok))));
    if (!matched) continue;
    let s = 0;
    if (entry.normAr === normQ || entry.normEn === normQ) s += 1000;
    else if (entry.normAr.startsWith(normQ) || entry.normEn.startsWith(normQ)) s += 600;
    else s += 300;
    if (entry.platforms.length) s += 40;
    if (entry.year >= 2020) s += 20;
    scored.push({ entry, s });
  }
  scored.sort((a, b) => b.s - a.s || (b.entry.year || 0) - (a.entry.year || 0));
  return scored.slice(0, 30).map(x => x.entry);
}

function matchShoofForTitle(index, titleAr, titleEn, type, year) {
  if (!index || !Array.isArray(index.titles)) return null;
  const nAr = normalizeArabicText(titleAr);
  const nEn = normalizeArabicText(titleEn);
  const yr = Number(String(year || "").slice(0, 4)) || 0;
  let best = null;
  for (const entry of index.titles) {
    if (type && entry.type !== type) continue;
    const exactMatch = (nAr && entry.normAr === nAr) || (nEn && entry.normEn === nEn);
    if (!exactMatch) continue;
    if (yr && entry.year && Math.abs(yr - entry.year) > 1) continue;
    best = entry;
    break;
  }
  return best;
}

function formatArabicSearchTitle(row, sfMatch, queryNorm) {
  const ar = String(row.title || row.name || row.original_title || row.original_name || "").slice(0, 160);
  const orig = String(row.original_title || row.original_name || "").slice(0, 160);
  const base = title(row, row.media_type || row._type || "tv");
  const titleAr = /[\u0600-\u06FF]/.test(ar) ? ar : (/[\u0600-\u06FF]/.test(orig) ? orig : (sfMatch ? sfMatch.titleAr : ""));
  const titleEn = sfMatch && sfMatch.titleEn ? sfMatch.titleEn : (!/[\u0600-\u06FF]/.test(ar) ? ar : "");
  return {
    ...base,
    tmdbId: base.id,
    hasTmdbId: true,
    titleAr: titleAr || base.title,
    titleEn,
    shoofSlug: sfMatch ? sfMatch.slug : null,
    regionalPlatforms: sfMatch ? sfMatch.platforms : [],
    sources: sfMatch ? ["tmdb", "shoofaflam"] : ["tmdb"],
    _qMatch: queryNorm ? (normalizeArabicText(titleAr || base.title).includes(queryNorm) ? 1 : 0) : 0
  };
}

function rankArabicCandidates(rows, normQuery) {
  const tokens = normQuery.split(" ").filter(Boolean);
  function arabicScore(row) {
    const ar = normalizeArabicText(row.titleAr || row.title || "");
    const orig = normalizeArabicText(row.originalTitle || "");
    const en = normalizeArabicText(row.titleEn || "");
    let s = 0;
    if (ar === normQuery || orig === normQuery || en === normQuery) s += 1000;
    else if (ar.startsWith(normQuery) || orig.startsWith(normQuery) || en.startsWith(normQuery)) s += 650;
    else if (tokens.length > 1 && tokens.every(t => ar.includes(t) || orig.includes(t))) s += 450;
    else if (ar.includes(normQuery) || orig.includes(normQuery) || en.includes(normQuery)) s += 260;
    if (row.originalLanguage === "ar") s += 180;
    if (row.regionalPlatforms && row.regionalPlatforms.length) s += 45;
    s += Math.log1p(row.popularity || 0) * 8 + Math.log1p(row.voteCount || 0) * 5;
    return s;
  }
  return rows.sort((a, b) => arabicScore(b) - arabicScore(a) || (b.popularity || 0) - (a.popularity || 0))
    .slice(0, ARABIC_SEARCH_LIMIT);
}

async function searchArabicMultiSource(fetcher, env, query, filter, signal, options = {}) {
  const endpoint = filter === "all" ? "multi" : filter;
  const path = (lang, page) => `/search/${endpoint}?query=${encodeURIComponent(query)}&include_adult=false&language=${lang}&page=${page}`;
  const tmdbPromise = (async () => {
    const first = await tmdbJson(fetcher, env, path("ar", 1), signal);
    const list = (Array.isArray(first.results) ? first.results : []).map(r => ({ ...r, _type: filter === "all" ? r.media_type : filter }));
    if (Number(first.total_pages) > 1 && list.length < 18) {
      try {
        const second = await tmdbJson(fetcher, env, path("ar", 2), signal);
        for (const r of (Array.isArray(second.results) ? second.results : [])) {
          list.push({ ...r, _type: filter === "all" ? r.media_type : filter });
        }
      } catch { /* Non-fatal second page */ }
    }
    return list.filter(r => TYPES.has(r._type) && Number.isInteger(r.id) && r.id > 0 && !r.adult);
  })();

  const shoofPromise = options.shoofAflam === false
    ? Promise.resolve({ titles: [], platformsBySlug: {} })
    : loadShoofAflamIndex(fetcher, signal);

  const [tmdbRes, shoofRes] = await Promise.allSettled([tmdbPromise, shoofPromise]);
  if (tmdbRes.status !== "fulfilled" && (shoofRes.status !== "fulfilled" || !shoofRes.value.titles.length)) {
    throw tmdbRes.reason || new Error("arabic_search_unavailable");
  }
  const tmdbRows = tmdbRes.status === "fulfilled" ? tmdbRes.value : [];
  const shoofIndex = shoofRes.status === "fulfilled" ? shoofRes.value : { titles: [], platformsBySlug: {} };
  const normQuery = normalizeArabicText(query);
  const shoofHits = searchShoofAflamLocal(shoofIndex, query, filter);
  const usedShoofSlugs = new Set();
  const byKey = new Map();

  for (const row of tmdbRows) {
    const mType = row._type;
    const key = `${mType}:${row.id}`;
    if (byKey.has(key)) continue;
    const yr = String(row.release_date || row.first_air_date || "").slice(0, 4);
    const rowNormAr = normalizeArabicText(row.title || row.name || row.original_title || row.original_name || "");
    const sfMatch = shoofHits.find(sf => sf.type === mType
      && ((sf.normAr && rowNormAr && sf.normAr === rowNormAr) || (row.original_language === "ar" && sf.normAr === rowNormAr))
      && (!yr || !sf.year || Math.abs(Number(yr) - sf.year) <= 1))
      || matchShoofForTitle(shoofIndex, row.title || row.name, row.original_title || row.original_name, mType, yr);
    if (sfMatch) usedShoofSlugs.add(sfMatch.slug);
    const formatted = formatArabicSearchTitle(row, sfMatch, normQuery);
    formatted.regionalPlatforms = (formatted.regionalPlatforms || []).map(slug =>
      classifyShoofPlatform(slug, shoofIndex.platformsBySlug[slug]));
    byKey.set(key, formatted);
  }

  for (const sf of shoofHits) {
    if (usedShoofSlugs.has(sf.slug)) continue;
    const dup = [...byKey.values()].some(existing => existing.type === sf.type
      && ((sf.normAr && normalizeArabicText(existing.titleAr || existing.title) === sf.normAr)
        || (sf.normEn && normalizeArabicText(existing.titleEn || existing.title) === sf.normEn))
      && (!existing.date || !sf.year || Math.abs(Number(existing.date.slice(0, 4)) - sf.year) <= 1));
    if (dup) continue;
    const synthId = stableSynthId(8000000, `${sf.type}:${sf.slug}`);
    byKey.set(`sf:${sf.slug}`, {
      type: sf.type,
      id: synthId,
      tmdbId: null,
      hasTmdbId: false,
      shoofSlug: sf.slug,
      title: sf.titleAr || sf.titleEn || sf.slug,
      titleAr: sf.titleAr || sf.titleEn || sf.slug,
      titleEn: sf.titleEn || "",
      date: sf.year ? `${sf.year}-01-01` : "",
      popularity: sf.platforms.length ? 40 : 18,
      voteCount: 0,
      originalTitle: sf.titleAr || sf.titleEn || "",
      originalLanguage: "ar",
      overview: "",
      genres: sf.genre ? [sf.genre] : [],
      poster: sf.poster,
      backdrop: null,
      regionalPlatforms: sf.platforms.map(slug => classifyShoofPlatform(slug, shoofIndex.platformsBySlug[slug])),
      sources: ["shoofaflam"]
    });
  }

  return {
    results: rankArabicCandidates([...byKey.values()], normQuery),
    sources: {
      tmdb: tmdbRes.status === "fulfilled",
      shoofAflam: Boolean(shoofIndex.titles && shoofIndex.titles.length)
    },
    attribution: { tmdb: "TMDB", shoofAflam: "shoofaflam.tv" }
  };
}

function arabicRegionalProviders(payload) {
  const regions = ["EG", "SA", "AE", "JO", "US"];
  const seen = new Map();
  const rawResults = (payload && payload.results) || {};
  for (const region of regions) {
    const bucket = rawResults[region];
    if (!bucket) continue;
    for (const [tierKey, list] of [["subscription", bucket.flatrate], ["free", bucket.free], ["free", bucket.ads]]) {
      for (const p of (Array.isArray(list) ? list : [])) {
        if (!p || !Number.isInteger(p.provider_id)) continue;
        const name = String(p.provider_name || "").slice(0, 90);
        const key = `${region}:${p.provider_id}`;
        if (!seen.has(key)) {
          seen.set(key, {
            id: p.provider_id,
            name,
            region,
            tier: tierKey,
            logo: image(p.logo_path)
          });
        }
      }
    }
  }
  return [...seen.values()].slice(0, 24);
}
function limited(request, now) {
  const key = request.headers.get("cf-connecting-ip") || "local";
  const previous = buckets.get(key);
  const bucket = previous && now - previous.at < 10000 ? previous : { at: now, count: 0 };
  bucket.count += 1; buckets.set(key, bucket);
  if (buckets.size > 1000) buckets.clear();
  return bucket.count > 30;
}
export async function api(request, env, options = {}) {
  const url = new URL(request.url);
  if (url.pathname === "/api/arabic/relay-availability") return watchRelayAvailability(request, env);
  if (url.pathname === "/api/arabic/relay-ticket") return watchRelayTicket(request, env, options.fetch);
  if (url.pathname === "/api/arabic/relay-catalog") {
    if (limited(request, Date.now())) return json(429, { code: "rate_limited" }, 0, 10);
    return watchRelayCatalog(request, env, options.fetch);
  }
  if (url.pathname.startsWith("/api/pair/") || url.pathname.startsWith("/api/owner/")) {
    return handleApi(request, { ...env, PAIRING_ONLY: true }, options);
  }
  if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
  if (!env.TMDB_TOKEN) return json(503, { error: "metadata_unconfigured" });
  if (limited(request, Date.now())) return json(429, { error: "rate_limited" }, 0, 10);
  let path, shape, ttl;
  if (url.pathname === "/api/recommendations") {
    if ([...url.searchParams.keys()].some(k => !["seeds", "avoid"].includes(k))
        || url.searchParams.getAll("seeds").length !== 1 || url.searchParams.getAll("avoid").length > 1)
      return json(400, { error: "invalid_query" });
    var recommendationSeedsValue = recommendationSeeds(url.searchParams.get("seeds"));
    var recommendationAvoidsValue = recommendationSeeds(url.searchParams.get("avoid"));
    if (!recommendationSeedsValue || !recommendationAvoidsValue || recommendationAvoidsValue.length > 2
        || recommendationAvoidsValue.some(seed => recommendationSeedsValue.some(item => item.key === seed.key)))
      return json(400, { error: "invalid_query" });
    path = null; shape = null; ttl = 600;
  } else if (url.pathname === "/api/discover-similar") {
    const allowed = new Set(["type", "id", "target", "avoid", "ai"]);
    if ([...url.searchParams.keys()].some(k => !allowed.has(k))) return json(400, { error: "invalid_query" });
    const type = url.searchParams.get("type");
    const id = positive(url.searchParams.get("id"));
    const target = url.searchParams.get("target") || "same";
    if (!TYPES.has(type) || !id || !["same", "movie", "tv", "both"].includes(target))
      return json(400, { error: "invalid_query" });
    const effectiveAiMode = resolveAiMode(env, url, request, options);
    if (!effectiveAiMode) return json(400, { error: "invalid_query" });
    const avoidParam = url.searchParams.get("avoid");
    const avoids = avoidParam ? recommendationSeeds(avoidParam) : [];
    if (avoidParam && !avoids) return json(400, { error: "invalid_query" });
    path = null; shape = null; ttl = 1200;
    var discoverParams = { type, id, target, avoids: avoids || [], aiMode: effectiveAiMode };
  } else if (url.pathname === "/api/arabic/search") {
    const query = (url.searchParams.get("q") || "").trim();
    const type = url.searchParams.get("type") || "all";
    if (!/^[\p{L}\p{N} .,'!?:&+\-]{1,80}$/u.test(query) || !["all", "movie", "tv"].includes(type)
        || [...url.searchParams.keys()].some(k => !["q", "type"].includes(k))) return json(400, { error: "invalid_query" });
    path = null;
    shape = null;
    ttl = 180;
    var arabicSearch = { query, type };
  } else if (url.pathname.startsWith("/api/arabic/")) {
    const parts = url.pathname.split("/");
    const kind = parts[3], type = parts[4], id = positive(parts[5]);
    if (url.search || !id || !TYPES.has(type) || parts.length !== (kind === "season" ? 7 : 6))
      return json(400, { error: "invalid_route" });
    if (kind === "title") {
      path = null; shape = null; ttl = 1800;
      var arabicDetail = { type, id };
    } else if (kind === "season" && type === "tv") {
      const number = positive(parts[6], 100);
      if (!number) return json(400, { error: "invalid_season" });
      path = `/tv/${id}/season/${number}?language=ar`;
      shape = value => {
        const today = new Date().toISOString().slice(0, 10);
        return {
          number: value.season_number,
          episodes: (Array.isArray(value.episodes) ? value.episodes : [])
            .filter(e => Number.isInteger(e.episode_number) && e.episode_number > 0
              && e.episode_type !== "special"
              && (!e.air_date || !/^\d{4}-\d{2}-\d{2}$/.test(e.air_date) || e.air_date <= today))
            .slice(0, 80)
            .map(e => ({
              number: e.episode_number,
              title: String(e.name || `الحلقة ${e.episode_number}`).slice(0, 160),
              date: e.air_date || "",
              overview: String(e.overview || "").slice(0, 1000),
              still: image(e.still_path)
            }))
        };
      };
      ttl = 1800;
    } else return json(400, { error: "invalid_route" });
  } else if (url.pathname === "/api/search") {
    const query = (url.searchParams.get("q") || "").trim();
    const type = url.searchParams.get("type") || "all";
    if (!/^[\p{L}\p{N} .,'!?:&+\-]{1,80}$/u.test(query) || !["all", "movie", "tv"].includes(type)
        || [...url.searchParams.keys()].some(k => !["q", "type"].includes(k))) return json(400, { error: "invalid_query" });
    path = null;
    shape = null;
    ttl = 120;
    var search = { query, type };
  } else if (url.pathname === "/api/discover") {
    const allowed = new Set(["type", "sort_by", "with_genres", "year", "length", "rating", "page"]);
    if ([...url.searchParams.keys()].some(k => !allowed.has(k))) return json(400, { error: "invalid_query" });
    const type = url.searchParams.get("type");
    if (!TYPES.has(type)) return json(400, { error: "invalid_query" });
    const sort = url.searchParams.get("sort_by") || "popularity.desc";
    const allowedSorts = new Set(["popularity.desc", "vote_average.desc", "primary_release_date.desc", "first_air_date.desc"]);
    if (!allowedSorts.has(sort)) return json(400, { error: "invalid_query" });
    const genre = url.searchParams.get("with_genres");
    if (genre && !/^[0-9,]{1,50}$/.test(genre)) return json(400, { error: "invalid_query" });
    const year = url.searchParams.get("year");
    if (year && !/^(19|20)\d{2}s?$|^older$/.test(year)) return json(400, { error: "invalid_query" });
    const length = url.searchParams.get("length");
    if (length && !["short", "medium", "long"].includes(length)) return json(400, { error: "invalid_query" });
    const rating = url.searchParams.get("rating");
    const movieRatings = new Set(["G", "PG", "PG-13", "R", "NC-17"]);
    const tvRatings = new Set(["TV-Y", "TV-Y7", "TV-G", "TV-PG", "TV-14", "TV-MA"]);
    if (rating && !((type === "movie" && movieRatings.has(rating)) || (type === "tv" && tvRatings.has(rating))))
      return json(400, { error: "invalid_query" });
    const pageStr = url.searchParams.get("page") || "1";
    const page = positive(pageStr, 10) || 1;

    let yearParams = "";
    if (year) {
      if (year === "2020s") yearParams = type === "movie" ? "&primary_release_date.gte=2020-01-01" : "&first_air_date.gte=2020-01-01";
      else if (year === "2010s") yearParams = type === "movie" ? "&primary_release_date.gte=2010-01-01&primary_release_date.lte=2019-12-31" : "&first_air_date.gte=2010-01-01&first_air_date.lte=2019-12-31";
      else if (year === "2000s") yearParams = type === "movie" ? "&primary_release_date.gte=2000-01-01&primary_release_date.lte=2009-12-31" : "&first_air_date.gte=2000-01-01&first_air_date.lte=2009-12-31";
      else if (year === "older") yearParams = type === "movie" ? "&primary_release_date.lte=1999-12-31" : "&first_air_date.lte=1999-12-31";
      else yearParams = type === "movie" ? `&primary_release_year=${year}` : `&first_air_date_year=${year}`;
    }

    let sortParam = `&sort_by=${sort}`;
    if (sort === "vote_average.desc") sortParam += "&vote_count.gte=50";

    if (type === "movie") {
      let lengthParam = "";
      if (length === "short") lengthParam = "&with_runtime.lte=89";
      else if (length === "medium") lengthParam = "&with_runtime.gte=90&with_runtime.lte=120";
      else if (length === "long") lengthParam = "&with_runtime.gte=121";

      let ratingParam = "";
      if (rating) ratingParam = `&certification_country=US&certification=${encodeURIComponent(rating)}`;

      path = `/discover/movie?language=en-US&include_adult=false${sortParam}&page=${page}`
        + (genre ? `&with_genres=${genre}` : "")
        + yearParams + lengthParam + ratingParam;
      shape = value => ({ results: (Array.isArray(value.results) ? value.results : []).filter(r => Number.isInteger(r.id) && r.id > 0 && !r.adult).map(r => Object.assign(title(r, "movie"), rating ? { rating } : {})) });
      ttl = 600;
    } else {
      path = `/discover/tv?language=en-US&include_adult=false${sortParam}&page=${page}`
        + (genre ? `&with_genres=${genre}` : "")
        + yearParams;
      if (rating || length) {
        shape = async value => {
          const list = (Array.isArray(value.results) ? value.results : []).filter(r => Number.isInteger(r.id) && r.id > 0 && !r.adult).slice(0, 15);
          const settled = await Promise.allSettled(list.map(r => tmdbJson(fetcher, env, `/tv/${r.id}?language=en-US&append_to_response=content_ratings`, controller.signal)));
          const matching = [];
          settled.forEach((res, i) => {
            if (res.status !== "fulfilled") return;
            const det = res.value;
            const r = list[i];
            const usRating = det.content_ratings?.results?.find(x => x.iso_3166_1 === "US")?.rating;
            if (rating) {
              if (!usRating || usRating.toUpperCase() !== rating.toUpperCase()) return;
            }
            const epTime = Array.isArray(det.episode_run_time) ? det.episode_run_time.find(v => Number.isInteger(v) && v > 0) : null;
            if (length) {
              if (!Number.isFinite(epTime) || epTime <= 0) return;
              if (length === "short" && epTime > 30) return;
              if (length === "medium" && (epTime <= 30 || epTime > 60)) return;
              if (length === "long" && epTime <= 60) return;
            }
            const t = title(r, "tv");
            if (usRating) t.rating = usRating;
            if (epTime) t.episodeRuntime = epTime;
            matching.push(t);
          });
          return { results: matching };
        };
      } else {
        shape = value => ({ results: (Array.isArray(value.results) ? value.results : []).filter(r => Number.isInteger(r.id) && r.id > 0 && !r.adult).map(r => title(r, "tv")) });
      }
      ttl = 600;
    }
  } else {
    const parts = url.pathname.split("/");
    const kind = parts[2], type = parts[3], id = positive(parts[4]);
    if (url.search || !id || !TYPES.has(type) || parts.length !== (kind === "season" ? 6 : 5))
      return json(400, { error: "invalid_route" });
    if (kind === "title") { path = `/${type}/${id}?language=en-US&append_to_response=${type === "tv" ? "external_ids,credits,content_ratings" : "credits,release_dates"}`; shape = value => detail(value, type); ttl = 1800; }
    else if (kind === "providers") { path = `/${type}/${id}/watch/providers`; shape = value => providers(value, type, id); ttl = 900; }
    else if (kind === "season" && type === "tv") {
      const number = positive(parts[5], 100);
      if (!number) return json(400, { error: "invalid_season" });
      path = `/tv/${id}/season/${number}?language=en-US`;
      shape = value => season(value, new Date().toISOString().slice(0, 10)); ttl = 1800;
    } else return json(400, { error: "invalid_route" });
  }
  const fetcher = options.fetch || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    if (recommendationSeedsValue) {
      const cacheKey = recommendationSeedsValue.map(seed => seed.key).join(",") + "|"
        + recommendationAvoidsValue.map(seed => seed.key).join(",");
      const cached = recommendationCache.get(cacheKey);
      if (cached && Date.now() - cached.at < 10 * 60 * 1000) return json(200, cached.value, ttl);
      const value = await recommendTmdb(fetcher, env, recommendationSeedsValue,
        recommendationAvoidsValue, controller.signal);
      if (recommendationCache.size >= 24) recommendationCache.delete(recommendationCache.keys().next().value);
      recommendationCache.set(cacheKey, { at: Date.now(), value });
      return json(200, value, ttl);
    }
    if (discoverParams) {
      const cacheKey = `${discoverParams.type}:${discoverParams.id}:${discoverParams.target}:${discoverParams.aiMode}|`
        + (discoverParams.avoids || []).map(s => s.key).join(",");
      const cached = discoverCache.get(cacheKey);
      if (cached && Date.now() - cached.at < 15 * 60 * 1000) return json(200, cached.value, ttl);
      const value = await discoverSimilarTmdb(fetcher, env, discoverParams.type, discoverParams.id,
        discoverParams.target, discoverParams.avoids, controller.signal, discoverParams.aiMode);
      if (discoverCache.size >= 40) discoverCache.delete(discoverCache.keys().next().value);
      discoverCache.set(cacheKey, { at: Date.now(), value });
      return json(200, value, ttl);
    }
    if (arabicSearch) {
      const key = `${arabicSearch.type}:${normalizeArabicText(arabicSearch.query)}`;
      const cached = arabicSearchCache.get(key);
      if (cached && Date.now() - cached.at < SEARCH_CACHE_MS) return json(200, cached.value, ttl);
      const value = await searchArabicMultiSource(fetcher, env, arabicSearch.query, arabicSearch.type, controller.signal, options);
      if (arabicSearchCache.size >= 40) arabicSearchCache.delete(arabicSearchCache.keys().next().value);
      arabicSearchCache.set(key, { at: Date.now(), value });
      return json(200, value, ttl);
    }
    if (arabicDetail) {
      const append = arabicDetail.type === "tv" ? "external_ids,credits,content_ratings" : "credits,release_dates,alternative_titles";
      const [arRes, provRes, shoofRes] = await Promise.allSettled([
        tmdbJson(fetcher, env, `/${arabicDetail.type}/${arabicDetail.id}?language=ar&append_to_response=${append}`, controller.signal),
        tmdbJson(fetcher, env, `/${arabicDetail.type}/${arabicDetail.id}/watch/providers`, controller.signal),
        options.shoofAflam === false ? Promise.resolve({ titles: [], platformsBySlug: {} }) : loadShoofAflamIndex(fetcher, controller.signal)
      ]);
      if (arRes.status !== "fulfilled") throw arRes.reason;
      const raw = arRes.value;
      const out = detail(raw, arabicDetail.type);
      if (arabicDetail.type === "movie") out.movieIdentity = arabicMovieIdentity(raw);
      const enTitleFallback = String(raw.original_title || raw.original_name || "").slice(0, 160);
      let enOverview = "";
      if (!out.overview) {
        try {
          const enRaw = await tmdbJson(fetcher, env, `/${arabicDetail.type}/${arabicDetail.id}?language=en-US`, controller.signal);
          enOverview = String(enRaw.overview || "").slice(0, 1800);
          out.titleEn = String(enRaw.title || enRaw.name || "").slice(0, 160);
        } catch { /* Non-fatal English fallback */ }
      }
      if (!out.overview && enOverview) out.overview = enOverview;
      const rawArName = String(raw.title || raw.name || "").slice(0, 160);
      out.titleAr = /[\u0600-\u06FF]/.test(rawArName) ? rawArName : (/[\u0600-\u06FF]/.test(enTitleFallback) ? enTitleFallback : rawArName);
      out.imdbId = typeof raw.external_ids?.imdb_id === "string" && /^tt\d{5,12}$/.test(raw.external_ids.imdb_id)
        ? raw.external_ids.imdb_id : (typeof raw.imdb_id === "string" && /^tt\d{5,12}$/.test(raw.imdb_id) ? raw.imdb_id : null);
      const shoofIdx = shoofRes.status === "fulfilled" ? shoofRes.value : { titles: [], platformsBySlug: {} };
      const sfMatch = matchShoofForTitle(shoofIdx, out.titleAr || out.title, out.titleEn || out.originalTitle, arabicDetail.type, out.date);
      out.regionalPlatforms = sfMatch ? sfMatch.platforms.map(slug => classifyShoofPlatform(slug, shoofIdx.platformsBySlug[slug])) : [];
      out.watchProviders = provRes.status === "fulfilled" ? arabicRegionalProviders(provRes.value) : [];
      out.attribution = sfMatch ? { tmdb: "TMDB", shoofAflam: "shoofaflam.tv" } : { tmdb: "TMDB" };
      return json(200, out, ttl);
    }
    if (search) {
      const key = `${search.type}:${search.query.toLocaleLowerCase()}`;
      const cached = searchCache.get(key);
      if (cached && Date.now() - cached.at < SEARCH_CACHE_MS) return json(200, cached.value, ttl);
      const value = await searchTmdb(fetcher, env, search.query, search.type, controller.signal);
      if (searchCache.size >= 40) searchCache.delete(searchCache.keys().next().value);
      searchCache.set(key, { at: Date.now(), value });
      return json(200, value, ttl);
    }
    const response = await fetcher(TMDB + path, { headers: {
      Authorization: `Bearer ${env.TMDB_TOKEN}`, Accept: "application/json" }, signal: controller.signal });
    if (!response.ok) {
      if (response.status === 429) {
        const seconds = Number(response.headers.get("Retry-After"));
        return json(429, { error: "rate_limited" }, 0,
          Number.isFinite(seconds) ? Math.max(1, Math.min(60, Math.ceil(seconds))) : 10);
      }
      return json(response.status === 404 ? 404 : 502,
        { error: response.status === 404 ? "not_found" : "metadata_unavailable" });
    }
    return json(200, await shape(await response.json()), ttl);
  } catch (error) {
    if (error.status === 429) return json(429, { error: "rate_limited" }, 0, error.retryAfter);
    if (error.status) return json(error.status === 404 ? 404 : 502,
      { error: error.status === 404 ? "not_found" : "metadata_unavailable" });
    return json(504, { error: "metadata_timeout_or_network" });
  }
  finally { clearTimeout(timer); }
}
export {
  aiCircuitBreaker,
  resetAiCircuitBreaker,
  resolveAiMode,
  vectorCosineSimilarity,
  formatSemanticDoc,
  applyAiEmbeddings,
  discoverCache,
  embeddingCache,
  arabicSearchCache,
  normalizeArabicText
};
export default { fetch(request, env) {
  return new URL(request.url).pathname.startsWith("/api/") ? api(request, env) : env.ASSETS.fetch(request);
} };
