const TMDB = "https://api.themoviedb.org/3";
const TYPES = new Set(["movie", "tv"]);
const buckets = new Map(); // Best-effort per-isolate guard; Cloudflare edge cache is the main cost control.
const searchCache = new Map();
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
  if (url.pathname === "/api/search") {
    const query = (url.searchParams.get("q") || "").trim();
    const type = url.searchParams.get("type") || "all";
    if (!/^[\p{L}\p{N} .,'!?:&+\-]{1,80}$/u.test(query) || !["all", "movie", "tv"].includes(type)
        || [...url.searchParams.keys()].some(k => !["q", "type"].includes(k))) return json(400, { error: "invalid_query" });
    path = null;
    shape = null;
    ttl = 120;
    var search = { query, type };
  } else {
    const parts = url.pathname.split("/");
    const kind = parts[2], type = parts[3], id = positive(parts[4]);
    if (url.search || !id || !TYPES.has(type) || parts.length !== (kind === "season" ? 6 : 5))
      return json(400, { error: "invalid_route" });
    if (kind === "title") { path = `/${type}/${id}?language=en-US${type === "tv" ? "&append_to_response=external_ids" : ""}`; shape = value => title(value, type); ttl = 1800; }
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
    return json(200, shape(await response.json()), ttl);
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
