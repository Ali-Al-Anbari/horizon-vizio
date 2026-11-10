const TMDB = "https://api.themoviedb.org/3";
const TYPES = new Set(["movie", "tv"]);
const buckets = new Map(); // Best-effort per-isolate guard; Cloudflare edge cache is the main cost control.
const searchCache = new Map();
const recommendationCache = new Map();
const discoverCache = new Map();
const SEARCH_LIMIT = 18;
const EXPANSIONS = "etaoinsh"; // Common next letters, including continuations such as t and h.
const SEARCH_CACHE_MS = 5 * 60 * 1000;

function json(status, value, ttl = 0, retryAfter = 0) {
  return new Response(JSON.stringify(value), { status, headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": ttl ? `public, max-age=${ttl}` : "no-store",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
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
async function discoverSimilarTmdb(fetcher, env, type, id, target, avoids, signal) {
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

  if (includeSame) {
    queries.push({ path: `/${type}/${id}/recommendations?language=en-US&page=1`, type, kind: "recommendation" });
    queries.push({ path: `/${type}/${id}/similar?language=en-US&page=1`, type, kind: "similar" });
    if (seedDetail.genreIds.length) {
      const g = seedDetail.genreIds[0], k = seedDetail.keywordIds[0];
      queries.push({
        path: `/discover/${type}?language=en-US&sort_by=popularity.desc&include_adult=false&vote_count.gte=30&with_genres=${g}${k ? `&with_keywords=${k}` : ""}&page=1`,
        type, kind: "discovery", keywordId: k || null
      });
    }
  }

  if (includeOpposite) {
    const mapped = mapWorkerGenres(type, oppType, seedDetail.genreIds);
    const k = seedDetail.keywordIds[0];
    if (mapped.length) {
      queries.push({
        path: `/discover/${oppType}?language=en-US&sort_by=popularity.desc&include_adult=false&vote_count.gte=30&with_genres=${mapped[0]}${k ? `&with_keywords=${k}` : ""}&page=1`,
        type: oppType, kind: "cross_media", keywordId: k || null
      });
      queries.push({
        path: `/discover/${oppType}?language=en-US&sort_by=vote_average.desc&vote_count.gte=80&include_adult=false&with_genres=${mapped[0]}&page=1`,
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
      if (q.keywordId && !cand.keywordIds.includes(q.keywordId)) {
        cand.keywordIds.push(q.keywordId);
      }
    });
  });

  return {
    seed: seedDetail,
    candidates: [...candidates.values()].slice(0, 180)
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
    const allowed = new Set(["type", "id", "target", "avoid"]);
    if ([...url.searchParams.keys()].some(k => !allowed.has(k))) return json(400, { error: "invalid_query" });
    const type = url.searchParams.get("type");
    const id = positive(url.searchParams.get("id"));
    const target = url.searchParams.get("target") || "same";
    if (!TYPES.has(type) || !id || !["same", "movie", "tv", "both"].includes(target))
      return json(400, { error: "invalid_query" });
    const avoidParam = url.searchParams.get("avoid");
    const avoids = avoidParam ? recommendationSeeds(avoidParam) : [];
    if (avoidParam && !avoids) return json(400, { error: "invalid_query" });
    path = null; shape = null; ttl = 1200;
    var discoverParams = { type, id, target, avoids: avoids || [] };
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
      const cacheKey = `${discoverParams.type}:${discoverParams.id}:${discoverParams.target}|`
        + (discoverParams.avoids || []).map(s => s.key).join(",");
      const cached = discoverCache.get(cacheKey);
      if (cached && Date.now() - cached.at < 15 * 60 * 1000) return json(200, cached.value, ttl);
      const value = await discoverSimilarTmdb(fetcher, env, discoverParams.type, discoverParams.id,
        discoverParams.target, discoverParams.avoids, controller.signal);
      if (discoverCache.size >= 40) discoverCache.delete(discoverCache.keys().next().value);
      discoverCache.set(cacheKey, { at: Date.now(), value });
      return json(200, value, ttl);
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
export default { fetch(request, env) {
  return new URL(request.url).pathname.startsWith("/api/") ? api(request, env) : env.ASSETS.fetch(request);
} };
