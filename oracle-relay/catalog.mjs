import https from "node:https";
import dns from "node:dns";
import { BlockList } from "node:net";

const WATCH_HOST = /^akwam\.ss$/i;
export const MEDIA_HOST = /^s\d+d\d+\.downet\.net$/i;
const APEX = "https://akwam.ss";
const METADATA_ORIGIN = "https://horizon-universal-search-preview.ali-al-anbari.workers.dev";
const TTL = 300_000;
const MISS_TTL = 45_000;
const ROOT_MISSES = new Set(["title_not_found", "title_identity_mismatch", "ambiguous_title"]);
const ASSET_MISSES = new Set(["metadata_episode_missing", "episode_identity_mismatch", "episode_missing", "ambiguous_episode", "watch_link_unverified"]);
const MAX_HTML = 1_048_576;
const MP4_PROBE_BYTES = 12;
const FORMAT_PROBE_BYTES = 512;
const blocked = new BlockList();
for (const [ip, bits] of [
  ["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],
  ["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.88.99.0",24],["192.168.0.0",16],
  ["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",3],
]) blocked.addSubnet(ip,bits);

export function publicLookup(host, options, done) {
  dns.lookup(host, { family: 4, all: true }, (error, addresses) => {
    if (error) return done(error);
    if (!addresses.length || addresses.some(({address}) => blocked.check(address))) {
      return done(new Error("non_public_dns"));
    }
    if (options.all) return done(null, addresses);
    done(null, addresses[0].address, 4);
  });
}

export function safeUrl(value, hosts, base) {
  const url = new URL(value, base);
  if (url.protocol !== "https:" || url.port || url.username || url.password || !hosts.test(url.hostname)) {
    throw new Error("disallowed_url");
  }
  url.hash = "";
  return url;
}

export const TITLE_ROOTS = Object.freeze({
  "tv-297621-s1": "/series/5289/فخر-الدلتا",
  "tv-304331-s1": "/series/5296/توابع",
  "tv-122543-s5": "/series/4909/المداح-ج5-أسطورة-العهد",
  "tv-122543-s6": "/series/5301/المداح-ج6-أسطورة-النهاية",
  "tv-301322-s1": "/series/5300/إفراج",
  "movie-1316421": "/movie/10120/المشروع-إكس",
  "movie-917242": "/movie/11705/الجواهرجي",
});

export function catalogKey(id) {
  if (typeof id !== "string" || id.trim() !== id) return null;
  const tv = /^(tv-[1-9]\d{0,8}-s[1-9]\d{0,2})-e([1-9]\d{0,2})$/.exec(id);
  if (tv) {
    const [,tmdbId,season] = tv[1].split("-");
    return { root: tv[1], type: "tv", tmdbId: Number(tmdbId), season: Number(season.slice(1)), episode: tv[2] };
  }
  if (/^movie-[1-9]\d{0,8}$/.test(id)) return { root: id, type: "movie", tmdbId: Number(id.slice(6)) };
  return null;
}

function textContent(value) {
  return value.replace(/<[^>]*>/g, " ").replace(/&(?:amp|nbsp|quot|apos|#(?:[0-9]{1,7}|x[0-9a-f]{1,6}));/gi, entity => {
    const named = { "&amp;": "&", "&nbsp;": " ", "&quot;": '"', "&apos;": "'" };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const hex = entity[2]?.toLowerCase() === "x";
    const code = parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  }).trim();
}

function normalizedAlias(value) {
  return value.normalize("NFKC").toLowerCase()
    .replace(/[أإآٱ]/g, "ا").replace(/[ىی]/g, "ي").replace(/ک/g, "ك")
    .replace(/[٠-٩۰-۹]/g, digit => String(digit.charCodeAt(0) & 15))
    .replace(/[\u061c\u0640\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\p{M}+/gu, "").replace(/[^\p{L}\p{N}+]+/gu, " ")
    .replace(/\s*\+\s*/g, "+").trim();
}

const ORDINALS = ["الاول", "الثاني", "الثالث", "الرابع", "الخامس", "السادس",
  "السابع", "الثامن", "التاسع", "العاشر"];
const SEASON_MARKER = /^(?:(?:الموسم|الجزء|season|part)\s+|[جs]\s*)(\d+|ال[\p{L}]+)(?: |$)/u;

function seasonMarker(value) {
  const match = SEASON_MARKER.exec(value) || /^(\d+)(?: |$)/.exec(value);
  if (!match) return null;
  return { number: /^\d+$/.test(match[1]) ? Number(match[1]) : ORDINALS.indexOf(match[1]) + 1,
    rest: value.slice(match[0].length).trim() };
}

function titleMatches(value, identity, { slug = false } = {}) {
  const text = normalizedAlias(value);
  const aliases = identity.aliases.map(normalizedAlias).filter(Boolean);
  const subtitle = identity.seasonTitle ? normalizedAlias(identity.seasonTitle) : "";
  const uniqueSeasonTitle = subtitle && !aliases.includes(subtitle) && !seasonMarker(subtitle);
  const fullSeasonTitle = uniqueSeasonTitle && aliases.some(alias => {
    const wordForm = subtitle.replace(/\+/g, " ").trim();
    return wordForm === alias || wordForm.startsWith(alias + " ");
  });
  // Akwam may append a collision counter to the URL slug. Only the page
  // heading can prove identity, and its digits and plus signs are significant.
  for (const form of slug ? [text, text.replace(/ \d+$/, "")] : [text]) {
    if (identity.season && fullSeasonTitle && form === subtitle) return true;
    for (const alias of aliases) {
      if (form === alias && (!identity.season || identity.season === 1)) return true;
      if (!identity.season || !form.startsWith(alias + " ")) continue;
      const suffix = form.slice(alias.length + 1);
      const marker = seasonMarker(suffix);
      if (marker) {
        if (marker.number === identity.season && (!marker.rest || slug || !uniqueSeasonTitle || marker.rest === subtitle)) return true;
      } else if (uniqueSeasonTitle && suffix === subtitle) return true;
    }
  }
  return false;
}

const movieVariant = title => normalizedAlias(title).replace(/ة(?= |$)/g, "ه").replace(/\b(?:el|al) /g, "el ");

function movieTitleScore(value, { aliases }) {
  const title = normalizedAlias(value);
  if (!title) return 0;
  if (aliases.some(alias => normalizedAlias(alias) === title)) return 8;
  return aliases.some(alias => movieVariant(alias) === movieVariant(value)) ? 5 : 0;
}

function overlapsNames(a, b) {
  return new Set(a.map(normalizedAlias).filter(name => name && b.some(other => normalizedAlias(other) === name))).size;
}

function movieScore(heading, year, identity, evidence) {
  const title = movieTitleScore(heading, identity);
  if (!title) return null;
  const primaryYear = Number(identity.year);
  const hasPrimary = primaryYear >= 1888 && primaryYear <= 2100;
  if (year && hasPrimary && Math.abs(primaryYear - Number(year)) > 2) return null;
  const years = [identity.year, ...(identity.releaseYears || [])].map(Number).filter(y => y >= 1888 && y <= 2100
    && (!hasPrimary || Math.abs(primaryYear - y) <= 2));
  const gap = year && years.length ? Math.min(...years.map(y => Math.abs(y - Number(year)))) : null;
  if (gap > 2) return null;
  const idMatch = !!(identity.imdbId && evidence.imdbId && identity.imdbId === evidence.imdbId);
  if (identity.imdbId && evidence.imdbId && !idMatch) return null;
  const director = overlapsNames(identity.directors || [], evidence.directors);
  const isArabic = name => /\p{Script=Arabic}/u.test(name);
  if (!idMatch && !director && evidence.directors.some(candidate =>
    (identity.directors || []).some(known => isArabic(candidate) === isArabic(known)))) return null;
  const cast = overlapsNames(identity.cast || [], evidence.cast);
  const runtimeGap = identity.runtime && evidence.runtime ? Math.abs(identity.runtime - evidence.runtime) : null;
  if (runtimeGap !== null && runtimeGap > Math.max(15, identity.runtime * 0.2)) return null;
  const runtime = runtimeGap !== null && runtimeGap <= 5;
  const corroborated = idMatch || director && (runtime || cast > 0) || cast >= 2 && runtime;
  if ((gap === null || gap === 2) && !corroborated) return null;
  if (title === 5 && gap !== 0 && !corroborated) return null;
  const score = title + (gap === 0 ? 3 : gap === 1 ? 2 : 0)
    + (idMatch ? 8 : 0) + (director ? 3 : 0) + Math.min(cast, 2) + (runtime ? 1 : 0);
  return score >= 8 ? score : null;
}

function moviePageEvidence(html) {
  // Only explicitly labeled properties of this page count. Ignore cast or
  // runtimes in related-title cards and free-form descriptions.
  const fields = new Map();
  for (const match of html.matchAll(/<(?:span|li)\b[^>]*>\s*(المدة|مدة العرض|إخراج|اخراج|المخرج|بطولة|طاقم العمل)\s*:\s*([^<]{1,220})<\/(?:span|li)>/gi)) {
    fields.set(normalizedAlias(match[1]), textContent(match[2]));
  }
  const split = value => value ? value.split(/[,،|]/).map(name => name.trim()).filter(Boolean).slice(0, 6) : [];
  const runtime = /^(\d{1,3})(?: دقيقة| دقائق| min)?$/.exec(normalizedAlias(fields.get("المده") || fields.get("المدة") || fields.get("مدة العرض") || ""));
  const imdbId = /<meta\b[^>]*\bitemprop=["']identifier["'][^>]*\bcontent=["'](tt\d{5,12})["']/i.exec(html)?.[1];
  return { runtime: runtime ? Number(runtime[1]) : null, imdbId,
    directors: split(fields.get("اخراج") || fields.get("المخرج")), cast: split(fields.get("بطولة") || fields.get("طاقم العمل")) };
}

function searchAliases(identity) {
  const aliases = [...new Set(identity.aliases)].filter(Boolean);
  const primary = aliases.find(alias => /\p{Script=Arabic}/u.test(alias)) || aliases[0];
  const english = aliases.find(alias => /[a-z]/i.test(alias) && !/\p{Script=Arabic}/u.test(alias));
  const season = identity.season > 1 && identity.seasonTitle && !seasonMarker(normalizedAlias(identity.seasonTitle))
    ? identity.seasonTitle : null;
  const numbered = identity.season > 1 ? primary + " " + identity.season : null;
  const normalized = normalizedAlias(primary).replace(/\+/g, " ").trim();
  const short = primary.split(/[:：–—]/)[0].trim();
  return { primary, first: [...new Set([primary, numbered, ...aliases])].filter(Boolean).slice(0, 3),
    fallback: [...new Set([primary, season?.replace(/\+/g, " ").trim(), short, normalized, english])].filter(Boolean).slice(0, 4) };
}

function isEpisodeLabel(value, episode) {
  const number = /^(?:الحلق[ةه](?: رقم)?|episode) (\d+)$/.exec(normalizedAlias(value));
  return !!number && Number(number[1]) === Number(episode);
}

export async function findCatalogRoots(type, aliases, agent) {
  const kind = type === "tv" ? "series" : type === "movie" ? "movie" : null;
  if (!kind || !aliases.length || aliases.length > 4 || aliases.some(alias => !alias || alias.length > 100)) {
    throw new Error("invalid_catalog_search");
  }
  const matches = new Set();
  const exact = new Set(aliases.map(normalizedAlias));
  for (const alias of aliases) {
    const url = new URL("/search", APEX);
    url.searchParams.set("q", alias);
    const response = await requestUpstream(url, { agent, signal: AbortSignal.timeout(6000) });
    if (response.status !== 200 || typeof response.html !== "string"
      || /cf-chl-|<title>\s*(?:Just a moment|Access denied)/i.test(response.html)) throw new Error("catalog_search_unavailable");
    for (const candidate of links(response.html,url, p => p.length === 3 && p[0] === kind
      && /^\d+$/.test(p[1]) && exact.has(normalizedAlias(p[2])) ? p[1] : null).values()) {
      matches.add(decodeURIComponent(candidate.pathname));
    }
  }
  return [...matches];
}

function links(html, base, accept) {
  const found = new Map();
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) {
    try {
      const url = safeUrl(match[1].replaceAll("&amp;", "&"), WATCH_HOST, base);
      const parts = decodeURIComponent(url.pathname).split("/").slice(1);
      const key = accept(parts);
      if (key) found.set(key, url);
    } catch { /* Ignore unrelated or malformed links. */ }
  }
  return found;
}

function pageHeading(html) {
  const heading = html.match(/<h1\b[^>]*>([\s\S]{1,400}?)<\/h1>/i)?.[1];
  return heading ? normalizedAlias(textContent(heading)) : "";
}

function addShortEpisodes(candidates, html, root, title, episode) {
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([^<]{1,250})<\/a>/gi)) {
    const label = /^حلق[ةه] (\d+) مسلسل (.+)$/.exec(normalizedAlias(textContent(match[2])));
    if (!label || Number(label[1]) !== Number(episode) || label[2] !== title) continue;
    try {
      const url = safeUrl(match[1], WATCH_HOST, root);
      const source = /^\/episode\/(\d+)$/.exec(url.pathname)?.[1];
      if (source && !url.search && !candidates.has(source)) candidates.set(source, url);
    } catch { /* Ignore links outside the publisher origin. */ }
  }
}

export function requestUpstream(url, { agent, range, signal, json = false, allowPrefix = false } = {}) {
  const lastByte = /^bytes=0-(\d{1,3})$/.exec(range || "")?.[1];
  const limit = range ? Math.min(Number(lastByte ?? -1) + 1, FORMAT_PROBE_BYTES) : MAX_HTML;
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      agent, lookup: publicLookup, signal, headers: {
        "User-Agent": "Horizon Watch", Accept: range ? (limit > MP4_PROBE_BYTES ? "*/*" : "video/mp4") : json ? "application/json" : "text/html",
        ...(range ? { Range: range } : {}),
      },
    }, res => {
      const status = res.statusCode;
      if (range && status === 200 && allowPrefix && !res.headers["content-encoding"]) {
        const mime = String(res.headers["content-type"] || "").split(";")[0].toLowerCase();
        if (mime === "video/mp4" || mime === "application/octet-stream") {
          const chunks = [];
          let size = 0;
          res.on("data", chunk => {
            const slice = chunk.subarray(0, limit - size);
            chunks.push(slice);
            size += slice.length;
            if (size === limit) {
              resolve({ status, headers: res.headers, bytes: Buffer.concat(chunks) });
              res.destroy();
            }
          });
          res.on("end", () => resolve({ status, headers: res.headers, bytes: Buffer.concat(chunks) }));
          res.on("error", reject);
          return;
        }
      }
      if (status !== (range ? 206 : 200)) {
        res.destroy();
        return resolve({ status, headers: res.headers });
      }
      const chunks = [];
      let size = 0;
      res.on("data", chunk => {
        size += chunk.length;
        if (size > limit) req.destroy(new Error("response_size_limit"));
        else chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        resolve({ status, headers: res.headers, ...(range ? { bytes: body } : { html: body.toString() }) });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function ebmlSize(bytes, offset, maskLength = true) {
  const header = bytes[offset];
  let length = 1;
  let bit = 0x80;
  while (bit && !(header & bit)) { bit >>= 1; length++; }
  if (!bit || offset + length > bytes.length || length > 4) return null;
  let value = maskLength ? header & (bit - 1) : header;
  for (let i = 1; i < length; i++) value = value * 256 + bytes[offset + i];
  return { next: offset + length, value };
}

export function mediaSignature(bytes) {
  if (!Buffer.isBuffer(bytes)) return "unknown";
  if (bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp" && bytes.readUInt32BE(0) >= 16) return "mp4";
  if (bytes.length >= 5 && bytes.readUInt32BE(0) === 0x1a45dfa3) {
    const header = ebmlSize(bytes, 4);
    if (header && header.next + header.value <= bytes.length) {
      const end = header.next + header.value;
      for (let offset = header.next; offset < end;) {
        const type = ebmlSize(bytes, offset, false);
        const size = type && ebmlSize(bytes, type.next);
        if (!size || size.next + size.value > end) break;
        if (type.value === 0x4282) {
          const docType = bytes.toString("ascii", size.next, size.next + size.value);
          if (docType === "matroska" || docType === "webm") return docType;
        }
        offset = size.next + size.value;
      }
    }
    return "ebml";
  }
  if (/^#EXTM3U\r?\n(?:[^\r\n]*\r?\n)*#EXT-X-[A-Z-]+:/.test(bytes.toString("utf8"))) return "hls";
  return "unknown";
}

export function createCatalog({ roots = TITLE_ROOTS, agent, request = requestUpstream, metadataRequest = request,
  getIdentity, now = Date.now, probeFormats = false } = {}) {
  const pages = new Map();
  const pending = new Map();
  const verifiedRoots = new Map();
  const rootLookups = new Map();
  const misses = new Map();

  function remember(map, key, value, limit) {
    map.delete(key);
    if (map.size >= limit) map.delete(map.keys().next().value);
    map.set(key, value);
  }

  async function readIdentity(key, signal) {
    if (getIdentity) return getIdentity(key, signal);
    const suffix = "/" + key.type + "/" + key.tmdbId;
    async function get(path) {
      const response = await metadataRequest(new URL(path, METADATA_ORIGIN), { signal, json: true });
      if (response.status === 404) return null;
      if (response.status !== 200) throw new Error("metadata_http_" + response.status);
      return JSON.parse(response.html);
    }
    const [arabic, english, season] = await Promise.all([
      get("/api/arabic/title" + suffix),
      get("/api/title" + suffix).catch(() => null),
      key.season ? get("/api/arabic/season" + suffix + "/" + key.season) : null,
    ]);
    if (arabic?.id !== key.tmdbId || arabic.type !== key.type || arabic.originalLanguage !== "ar") {
      throw new Error("metadata_unverified");
    }
    const seasonInfo = arabic.seasons?.find(row => row.number === key.season);
    if (key.season && (!seasonInfo || season?.number !== key.season || !Array.isArray(season.episodes))) {
      throw new Error("metadata_episode_missing");
    }
    const date = key.season
      ? season.episodes.find(row => row.number === 1)?.date || seasonInfo.date || (key.season === 1 ? arabic.date : "")
      : arabic.date;
    const year = /^\d{4}/.exec(date || "")?.[0];
    const translated = english?.id === key.tmdbId && english.type === key.type ? english : null;
    const movie = key.type === "movie" ? arabic.movieIdentity : null;
    const alternatives = Array.isArray(movie?.alternativeTitles) ? movie.alternativeTitles.slice(0, 8) : [];
    const aliases = [...new Set([arabic.originalTitle, arabic.titleAr, arabic.title, arabic.titleEn, translated?.title, ...alternatives])]
      .filter(value => typeof value === "string" && value.trim() && value.length <= 100).map(value => value.trim());
    if ((key.season && !year) || !aliases.length) throw new Error("metadata_unverified");
    if (key.type === "movie") {
      const names = rows => Array.isArray(rows) ? rows.filter(name => typeof name === "string").slice(0, 6) : [];
      return { aliases, year, releaseYears: Array.isArray(movie?.releaseYears) ? movie.releaseYears.slice(0, 12) : [],
        cast: [...names(arabic.cast), ...names(translated?.cast), ...names(movie?.originalCast)],
        directors: [...names(arabic.directors), ...names(translated?.directors), ...names(movie?.originalDirectors)],
        runtime: arabic.runtime, imdbId: arabic.imdbId };
    }
    return { aliases, year, season: key.season, seasonTitle: seasonInfo?.name,
      episodes: season?.episodes?.map(row => row.number) };
  }

  function lookupRoot(key, signal) {
    const cached = verifiedRoots.get(key.root);
    if (cached && cached.until > now()) {
      if (cached.error) return Promise.reject(new Error(cached.error));
      return Promise.resolve(cached.value);
    }
    if (rootLookups.has(key.root)) return rootLookups.get(key.root);
    const task = (async () => {
      const identity = await readIdentity(key, signal);
      const kind = key.episode ? "series" : "movie";
      const queries = searchAliases(identity);
      const searched = new Set();
      const checked = new Set();
      let foundCandidate = false;
      let searchError;
      const ranked = [];
      const isMovie = !key.episode;

      async function search(alias, filters, year = identity.year) {
        const url = new URL("/search", APEX);
        url.searchParams.set("q", alias);
        if (filters) url.searchParams.set("section", kind);
        if (filters === "year" && year) url.searchParams.set("year", year);
        if (searched.has(url.href)) return new Map();
        searched.add(url.href);
        return links(await page(url, signal, !!cached?.error), url, parts => parts.length === 3 && parts[0] === kind
          && /^\d+$/.test(parts[1]) && (isMovie ? movieTitleScore(parts[2], identity)
            || movieTitleScore(parts[2].replace(/-\d+$/, ""), identity) : titleMatches(parts[2], identity, { slug: true })) ? parts[1] : null);
      }

      const year = Number(identity.year);
      const movieYears = [...new Set([year, ...(identity.releaseYears || []).map(Number), year - 1, year + 1])]
        .filter(value => value >= 1888 && value <= 2100 && (!year || Math.abs(value - year) <= 2)).slice(0, 3);
      const phases = isMovie ? [[
        ...[...new Set([queries.primary, ...identity.aliases, ...queries.fallback])].slice(0, 4).map(alias => [alias, "type"]),
        ...movieYears.map(value => [queries.primary, "year", value]),
      ]] : [[queries.first, "year"], [queries.fallback, "type"], [[queries.primary], null]]
        .map(([aliases, filters]) => aliases.map(alias => [alias, filters]));
      for (const searches of phases) {
        const matches = await Promise.all(searches.map(args => search(...args).catch(error => {
          if (signal.aborted || /^(?:catalog_challenge|catalog_http_(?:401|403|429))$/.test(error.message)) throw error;
          searchError ||= error;
          return new Map();
        })));
        const candidates = new Map(matches.flatMap(results => [...results]));
        for (const id of checked) candidates.delete(id);
        if (!candidates.size) continue;
        foundCandidate = true;
        if (checked.size + candidates.size > (isMovie ? 6 : 4)) throw new Error("ambiguous_title");
        for (const id of candidates.keys()) checked.add(id);
        const verified = await Promise.all([...candidates.values()].map(async url => {
          if (url.search) return null;
          const html = await page(url, signal, !!cached?.error);
          const heading = pageHeading(html);
          const year = html.match(/<span\b[^>]*>\s*السنة\s*:\s*([0-9٠-٩۰-۹]{4})\s*<\/span>/i)?.[1];
          if (!heading) return null;
          if (isMovie) {
            const score = movieScore(heading, year ? normalizedAlias(year) : null, identity, moviePageEvidence(html));
            return score === null ? null : { url, heading, score };
          }
          if (!year || normalizedAlias(year) !== String(identity.year) || !titleMatches(heading, identity)) return null;
          return { url, heading, episodes: identity.episodes };
        }));
        const valid = verified.filter(Boolean);
        if (isMovie) { ranked.push(...valid); continue; }
        if (valid.length > 1) throw new Error("ambiguous_title");
        if (valid.length) {
          remember(verifiedRoots, key.root, { value: valid[0], until: now() + TTL }, 64);
          return valid[0];
        }
      }
      if (searchError) throw searchError;
      ranked.sort((left, right) => right.score - left.score);
      if (ranked.length && ranked[1] && ranked[0].score - ranked[1].score < 2) throw new Error("ambiguous_title");
      if (ranked.length) {
        remember(verifiedRoots, key.root, { value: ranked[0], until: now() + TTL }, 64);
        return ranked[0];
      }
      throw new Error(foundCandidate ? "title_identity_mismatch" : "title_not_found");
    })().catch(error => {
      if (ROOT_MISSES.has(error.message)) {
        remember(verifiedRoots, key.root, { error: error.message, until: now() + MISS_TTL }, 64);
      }
      throw error;
    }).finally(() => rootLookups.delete(key.root));
    rootLookups.set(key.root, task);
    return task;
  }

  async function page(url, signal, force = false) {
    const identity = decodeURIComponent(url.pathname);
    const key = url.href;
    const cached = pages.get(key);
    if (!force && cached && cached.until > now()) return cached.html;
    for (let hop = 0; hop <= 2; hop++) {
      const reply = await request(url, { agent, signal });
      if ([301, 302, 303, 307, 308].includes(reply.status) && reply.headers.location) {
        url = safeUrl(reply.headers.location, WATCH_HOST, url);
        if (decodeURIComponent(url.pathname) !== identity || url.search) throw new Error("identity_redirect");
        continue;
      }
      if (reply.status !== 200) throw new Error("catalog_http_" + reply.status);
      if (!/^text\/html\b/i.test(reply.headers["content-type"] || "") || typeof reply.html !== "string") {
        throw new Error("invalid_catalog_page");
      }
      if (/cf-chl-|<title>\s*(?:Just a moment|Access denied)/i.test(reply.html)) throw new Error("catalog_challenge");
      if (!identity.startsWith("/watch/")) {
        remember(pages, key, { html: reply.html, until: now() + TTL }, 16);
      }
      return reply.html;
    }
    throw new Error("catalog_redirect_limit");
  }

  function has(id) {
    const key = catalogKey(id);
    return !!key && Object.hasOwn(roots,key.root);
  }

  async function discover(id, signal, force = false, onTitleMatch) {
    const key = catalogKey(id);
    if (!key) throw new Error("title_unmapped");
    const found = Object.hasOwn(roots, key.root)
      ? { url: safeUrl(roots[key.root], WATCH_HOST, APEX) } : await lookupRoot(key, signal);
    const root = found.url;
    if (found.episodes && !found.episodes.includes(Number(key.episode))) throw new Error("metadata_episode_missing");
    const [,kind,rootId,slug] = decodeURIComponent(root.pathname).split("/");
    if ((key.episode ? kind !== "series" : kind !== "movie") || !/^\d+$/.test(rootId) || !slug || root.search) {
      throw new Error("invalid_title_root");
    }
    onTitleMatch?.(key.type === "movie" ? rootId : null);
    let target = root;
    let sourceId = rootId;
    let sourceSlug = slug;
    const title = normalizedAlias(found.heading || slug);
    if (key.episode) {
      const season = await page(root, signal, force);
      const candidates = links(season, root, p => (
        p.length === 4 && p[0] === "episode" && /^\d+$/.test(p[1])
          && (normalizedAlias(p[2]) === normalizedAlias(slug) || found.heading && normalizedAlias(p[2]) === normalizedAlias(found.heading))
          && isEpisodeLabel(p[3], key.episode) ? p[1] : null));
      addShortEpisodes(candidates, season, root, title, key.episode);
      if (candidates.size !== 1) throw new Error(candidates.size ? "ambiguous_episode" : "episode_missing");
      [[sourceId,target]] = candidates;
      sourceSlug = decodeURIComponent(target.pathname).split("/")[3];
    }
    const html = await page(target, signal, force);
    if (!key.episode && found.heading && pageHeading(html) !== normalizedAlias(found.heading)) {
      throw new Error("title_identity_mismatch");
    }
    const shortEpisode = key.episode && !sourceSlug;
    if (shortEpisode) {
      const heading = /^(.*) (الحلق[ةه] \d+)$/.exec(pageHeading(html));
      if (heading?.[1] !== title || !isEpisodeLabel(heading[2], key.episode)) throw new Error("episode_identity_mismatch");
    }
    const watch = links(html, target, p => {
      if (p[0] !== "watch" || !/^\d+$/.test(p[1]) || p[2] !== sourceId) return null;
      if (shortEpisode) return p.length === 3 ? p[1] : null;
      const matchingSlug = p[3] && (normalizedAlias(p[3]) === normalizedAlias(sourceSlug)
        || !key.episode && found.heading && normalizedAlias(p[3]) === title);
      const matchingEpisode = key.episode ? p.length === 5 && isEpisodeLabel(p[4], key.episode) : p.length === 4;
      return matchingSlug && matchingEpisode ? p[1] : null;
    });
    if (!watch.size || watch.size > 4) throw new Error("watch_link_unverified");
    return [...watch.values()];
  }

  function resolveSources(id, { force = false, onTitleMatch, onWatchMatch, onProbe } = {}) {
    if (pending.has(id)) return pending.get(id);
    if (force) misses.delete(id);
    const miss = misses.get(id);
    if (miss && miss.until > now()) {
      if (miss.titleMatch) onTitleMatch?.();
      return Promise.reject(new Error(miss.error));
    }
    if (pending.size >= 3) return Promise.reject(new Error("catalog_busy"));
    let titleMatch = false;
    let work = null;
    const task = (async () => {
      const signal = AbortSignal.timeout(6500);
      const matches = await discover(id, signal, force || !!miss, rootId => {
        work = rootId;
        titleMatch = true;
        onTitleMatch?.();
      });
      onWatchMatch?.();
      const movie = !!work;
      const candidates = [];
      const seen = new Set();
      const found = () => ({ work, sources: candidates.sort((a, b) => Number(b.verified) - Number(a.verified)) });
      let networkError;
      for (const watch of matches) {
        let html;
        try { html = await page(watch, signal); }
        catch (error) {
          if (!movie || /^(?:catalog_challenge|catalog_http_(?:401|403|429))$/.test(error.message)) throw error;
          if (candidates.length && signal.aborted) return found();
          networkError ||= error;
          continue;
        }
        const sources = [...new Set([...html.matchAll(/<source\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map(match => match[1]))];
        if (sources.length > 3) continue;
        let disallowedSource = false;
        for (const [slot, raw] of sources.entries()) {
          let url;
          try { url = safeUrl(raw.replaceAll("&amp;", "&"), MEDIA_HOST); }
          catch { disallowedSource = true; continue; }
          const ext = /\.(mp4|mkv|m3u8)$/i.exec(url.pathname)?.[1]?.toLowerCase();
          const count = probeFormats && onProbe && ext !== "mp4" ? FORMAT_PROBE_BYTES : MP4_PROBE_BYTES;
          if (seen.has(url.href)) continue;
          seen.add(url.href);
          let probe;
          try {
            probe = await request(url, { agent, range: "bytes=0-" + (count - 1),
              signal: movie ? AbortSignal.any([signal, AbortSignal.timeout(1600)]) : signal, allowPrefix: movie });
          } catch (error) {
            if (!movie) throw error;
            if (candidates.length && signal.aborted) return found();
            networkError ||= error;
            continue;
          }
          const range = /^bytes 0-(\d+)\/(\d+)$/.exec(probe.headers["content-range"] || "");
          const size = Number(range?.[2]);
          const returned = Math.min(count, size);
          const rangeValid = probe.status === 206 && Number.isSafeInteger(size) && returned > 0
            && Number(range[1]) === returned - 1 && probe.bytes?.length === returned;
          const format = mediaSignature(probe.bytes);
          const mime = String(probe.headers["content-type"] || "").split(";")[0].toLowerCase();
          onProbe?.({ status: probe.status, rangeValid, format, extension: ext,
            mp4Header: format === "mp4", ebmlHeader: ["ebml", "matroska", "webm"].includes(format),
            mime: ["video/mp4", "video/x-matroska", "application/vnd.apple.mpegurl", "application/octet-stream", "text/html"].includes(mime)
              ? mime : "other" });
          if (format !== "mp4" || (mime !== "video/mp4" && mime !== "application/octet-stream")) continue;
          const verified = rangeValid && probe.bytes.readUInt32BE(0) <= size;
          const bestEffort = movie && probe.status === 200 && !probe.headers["content-encoding"];
          if (!verified && !bestEffort) continue;
          candidates.push({ url: url.href, verified, key: watch.pathname.split("/")[2] + ":" + slot });
          if (!movie || candidates.length === 2) return found();
        }
        if (!movie && disallowedSource && sources.length === 1) throw new Error("disallowed_url");
      }
      if (candidates.length) return found();
      if (networkError) throw networkError;
      throw new Error(seen.size ? "range_mp4_unverified" : "disallowed_url");
    })().catch(error => {
      if (ASSET_MISSES.has(error.message)) remember(misses, id, { error: error.message, titleMatch, until: now() + MISS_TTL }, 128);
      throw error;
    }).finally(() => pending.delete(id));
    pending.set(id,task);
    return task;
  }

  return { has, resolveSources, resolve: async (id, options) => (await resolveSources(id, options)).sources[0].url };
}
