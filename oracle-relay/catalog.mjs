import https from "node:https";
import dns from "node:dns";
import { BlockList } from "node:net";

const WATCH_HOST = /^akwam\.ss$/i;
export const MEDIA_HOST = /^s\d+d\d+\.downet\.net$/i;
const APEX = "https://akwam.ss";
const METADATA_ORIGIN = "https://horizon-universal-search-preview.ali-al-anbari.workers.dev";
const TTL = 300_000;
const MAX_HTML = 1_048_576;
const MP4_PROBE_BYTES = 12;
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

function normalizedAlias(value) {
  return value.normalize("NFKC").toLowerCase().replace(/[أإآ]/g,"ا").replace(/ى/g,"ي")
    .replace(/[\u064B-\u065F\u0640]/g,"").replace(/[^\p{L}\p{N}]+/gu," ").trim();
}

const ORDINALS = ["الاول", "الثاني", "الثالث", "الرابع", "الخامس", "السادس",
  "السابع", "الثامن", "التاسع", "العاشر"];

function cleanTitle(value) {
  return normalizedAlias(value.replace(/[\u0660-\u0669]/g, digit => String(digit.charCodeAt(0) - 0x660)));
}

function titleMatches(value, identity, { slug = false } = {}) {
  const text = cleanTitle(value);
  const aliases = identity.aliases.map(cleanTitle).filter(Boolean);
  for (const alias of aliases) {
    const forms = slug ? [text, text.replace(/ \d+$/, "")] : [text];
    for (const form of forms) {
      if (form === alias && (!identity.season || identity.season === 1)) return true;
      if (!identity.season || !form.startsWith(alias + " ")) continue;
      const suffix = form.slice(alias.length + 1);
      const marker = /^(?:ج\s*|(?:الموسم|الجزء|season) )([\p{L}\d]+)(?: |$)/u.exec(suffix);
      const number = marker && (/^\d+$/.test(marker[1]) ? Number(marker[1]) : ORDINALS.indexOf(marker[1]) + 1);
      if (marker && number !== identity.season) continue;
      const rest = marker ? suffix.slice(marker[0].length).trim() : suffix;
      const subtitle = identity.seasonTitle ? cleanTitle(identity.seasonTitle) : "";
      if (marker && !rest || subtitle && rest === subtitle) return true;
    }
  }
  return false;
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
      const url = safeUrl(match[1], WATCH_HOST, base);
      const parts = decodeURIComponent(url.pathname).split("/").slice(1);
      const key = accept(parts);
      if (key) found.set(key, url);
    } catch { /* Ignore unrelated or malformed links. */ }
  }
  return found;
}

export function requestUpstream(url, { agent, range, signal, json = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      agent, lookup: publicLookup, signal, headers: {
        "User-Agent": "Horizon Watch", Accept: range ? "video/mp4" : json ? "application/json" : "text/html",
        ...(range ? { Range: range } : {}),
      },
    }, res => {
      const status = res.statusCode;
      if (status !== (range ? 206 : 200)) {
        res.destroy();
        return resolve({ status, headers: res.headers });
      }
      const chunks = [];
      let size = 0;
      res.on("data", chunk => {
        size += chunk.length;
        if (size > (range ? MP4_PROBE_BYTES : MAX_HTML)) req.destroy(new Error("response_size_limit"));
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

export function createCatalog({ roots = TITLE_ROOTS, agent, request = requestUpstream, metadataRequest = request,
  getIdentity } = {}) {
  const pages = new Map();
  const pending = new Map();
  const verifiedRoots = new Map();
  const rootLookups = new Map();

  async function readIdentity(key, signal) {
    if (getIdentity) return getIdentity(key, signal);
    const suffix = "/" + key.type + "/" + key.tmdbId;
    async function get(path) {
      const response = await metadataRequest(new URL(path, METADATA_ORIGIN), { signal, json: true });
      if (response.status !== 200) return null;
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
    if (key.season && (!seasonInfo || season?.number !== key.season ||
      !season.episodes?.some(row => row.number === Number(key.episode)))) throw new Error("metadata_episode_missing");
    const date = key.season
      ? season.episodes.find(row => row.number === 1)?.date || (key.season === 1 ? arabic.date : "")
      : arabic.date;
    const year = /^\d{4}/.exec(date || "")?.[0];
    const aliases = [...new Set([arabic.originalTitle, arabic.titleAr, arabic.title,
      english?.id === key.tmdbId ? english.title : null])].filter(value => typeof value === "string" && value.trim() && value.length <= 100);
    if (!year || !aliases.length) throw new Error("metadata_unverified");
    return { aliases, year, season: key.season, seasonTitle: seasonInfo?.name,
      episodes: season?.episodes?.map(row => row.number) };
  }

  function lookupRoot(key, signal) {
    const cached = verifiedRoots.get(key.root);
    if (cached && cached.until > Date.now()) return Promise.resolve(cached.value);
    if (rootLookups.has(key.root)) return rootLookups.get(key.root);
    const task = (async () => {
      const identity = await readIdentity(key, signal);
      const kind = key.episode ? "series" : "movie";
      // Search both original and translated aliases. The broad series name can
      // surface season pages that the provider omits for subtitle-only searches.
      const aliases = identity.aliases.slice(0, 3);
      async function search(alias, filtered) {
        const url = new URL("/search", APEX);
        url.searchParams.set("q", alias);
        if (filtered) {
          url.searchParams.set("section", kind);
          url.searchParams.set("year", identity.year);
        }
        return links(await page(url, signal), url, parts => parts.length === 3 && parts[0] === kind
          && /^\d+$/.test(parts[1]) && titleMatches(parts[2], identity, { slug: true }) ? parts[1] : null);
      }
      const searches = await Promise.all(aliases.map(alias => search(alias, true)));
      const candidates = new Map(searches.flatMap(results => [...results]));
      if (!candidates.size) {
        // The provider occasionally omits a correct result from filtered search.
        // The title page must still pass the same year and identity checks.
        const fallback = await search(aliases[0], false);
        for (const [id, url] of fallback) candidates.set(id, url);
      }
      if (!candidates.size) throw new Error("title_not_found");
      if (candidates.size > 4) throw new Error("ambiguous_title");
      const checked = await Promise.all([...candidates.values()].map(async url => {
        if (url.search) return null;
        const html = await page(url, signal);
        const heading = html.match(/<h1\b[^>]*>([^<]+)<\/h1>/i)?.[1];
        const year = html.match(/<span\b[^>]*>\s*السنة\s*:\s*(\d{4})\s*<\/span>/i)?.[1];
        if (!heading || year !== String(identity.year) || !titleMatches(heading, identity)) return null;
        return { url, heading, episodes: identity.episodes };
      }));
      const valid = checked.filter(Boolean);
      if (valid.length !== 1) throw new Error(valid.length ? "ambiguous_title" : "title_identity_mismatch");
      if (!verifiedRoots.has(key.root) && verifiedRoots.size >= 64) verifiedRoots.delete(verifiedRoots.keys().next().value);
      verifiedRoots.set(key.root, { value: valid[0], until: Date.now() + TTL });
      return valid[0];
    })().finally(() => rootLookups.delete(key.root));
    rootLookups.set(key.root, task);
    return task;
  }

  async function page(url, signal) {
    const identity = decodeURIComponent(url.pathname);
    const key = url.href;
    const cached = pages.get(key);
    if (cached && cached.until > Date.now()) return cached.html;
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
        if (pages.size >= 16) pages.delete(pages.keys().next().value);
        pages.set(key, { html: reply.html, until: Date.now() + TTL });
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
    onTitleMatch?.();
    let target = root;
    let sourceId = rootId;
    let sourceSlug = slug;
    if (key.episode) {
      let candidates = links(await page(root,signal),root, p => (
        p.length === 4 && p[0] === "episode" && /^\d+$/.test(p[1])
          && (p[2] === slug || found.heading && cleanTitle(p[2]) === cleanTitle(found.heading))
          && p[3] === "الحلقة-" + key.episode ? p[1] : null));
      if (candidates.size !== 1) throw new Error(candidates.size ? "ambiguous_episode" : "episode_missing");
      [[sourceId,target]] = candidates;
      sourceSlug = decodeURIComponent(target.pathname).split("/")[3];
    }
    if (force) pages.delete(target.href);
    const watch = links(await page(target,signal),target, p => (
      p[0] === "watch" && /^\d+$/.test(p[1]) && p[2] === sourceId
        && (p[3] === sourceSlug || !key.episode && found.heading && cleanTitle(p[3]) === cleanTitle(found.heading))
        && (key.episode ? p.length === 5 && p[4] === "الحلقة-" + key.episode : p.length === 4) ? p[1] : null));
    if (!watch.size || watch.size > 4) throw new Error("watch_link_unverified");
    return [...watch.values()];
  }

  function resolve(id, { force = false, onTitleMatch, onWatchMatch, onProbe } = {}) {
    if (pending.has(id)) return pending.get(id);
    if (pending.size >= 3) return Promise.reject(new Error("catalog_busy"));
    const task = (async () => {
      const signal = AbortSignal.timeout(6500);
      const matches = await discover(id,signal,force,onTitleMatch);
      onWatchMatch?.();
      for (const watch of matches) {
        const html = await page(watch,signal);
        const sources = [...new Set([...html.matchAll(/<source\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map(match => match[1]))];
        if (sources.length > 3) continue;
        for (const raw of sources) {
        const url = safeUrl(raw.replaceAll("&amp;", "&"),MEDIA_HOST);
        const ext = /\.(mp4|mkv)$/i.exec(url.pathname)?.[1]?.toLowerCase();
        if (ext !== "mp4" && !(ext === "mkv" && onProbe)) continue;
        const probe = await request(url, { agent, range: "bytes=0-11", signal });
        const length = /^bytes 0-11\/(\d+)$/.exec(probe.headers["content-range"] || "");
        const mime = String(probe.headers["content-type"] || "").split(";")[0].toLowerCase();
        const rangeValid = Number(length?.[1]) > 11;
        const mp4Header = probe.bytes?.length === MP4_PROBE_BYTES
          && probe.bytes.subarray(4, 8).equals(Buffer.from("ftyp")) && probe.bytes.readUInt32BE(0) >= 16;
        const ebmlHeader = probe.bytes?.length >= 4 && probe.bytes.readUInt32BE(0) === 0x1a45dfa3;
        onProbe?.({ status: probe.status, rangeValid, mp4Header: !!mp4Header, ebmlHeader: !!ebmlHeader, extension: ext,
          mime: ["video/mp4", "application/octet-stream", "text/html"].includes(mime) ? mime : "other" });
        if (ext === "mp4" && probe.status === 206 && rangeValid && mp4Header
            && (mime === "video/mp4" || mime === "application/octet-stream")) return url.href;
        }
      }
      throw new Error("range_mp4_unverified");
    })().finally(() => pending.delete(id));
    pending.set(id,task);
    return task;
  }

  return { has, resolve };
}
