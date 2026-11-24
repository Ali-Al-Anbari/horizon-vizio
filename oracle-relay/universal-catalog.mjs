import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { catalogKey, normalizedAlias, requestUpstream, textContent } from "./catalog.mjs";

const MAPPING_TTL = 12 * 3600_000;
const MISS_TTL = 60_000;
const COOLDOWN = 30_000;
const TRANSIENT = new Set(["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "EPIPE",
  "ERR_STREAM_PREMATURE_CLOSE", "UND_ERR_CONNECT_TIMEOUT", "TimeoutError"]);
const MP4PLUS_CODE = /^[a-z0-9]{10,16}$/i;
const CATALOGS = Object.freeze({
  laroza: { origin: "https://laroza1.study", embedPath: "/play.php" },
  qfilm: { origin: "https://a.qfilm.tv", embedPath: "/embed.php" },
});

function transient(error) {
  return TRANSIENT.has(error.code || error.name) || [408, 500, 502, 503, 504].includes(error.status);
}

export function createCatalogTransport({ agent, request = requestUpstream, now = Date.now } = {}) {
  const hosts = new Map();
  return async function get(url, options = {}) {
    const host = url.hostname;
    const prior = hosts.get(host);
    if (prior?.until > now()) throw new Error("upstream_cooldown");
    const { signal, expected = 200, ...rest } = options;
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      try {
        const result = await request(url, {
          ...rest, agent, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(2200)]) : AbortSignal.timeout(2200),
        });
        if (result.status !== expected) throw Object.assign(new Error("upstream_status"), { status: result.status });
        hosts.delete(host);
        return result;
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error.status === 429) hosts.set(host, { count: 0, until: now() + COOLDOWN });
        if (!transient(error)) throw error;
        if (attempt === 2) {
          const count = (hosts.get(host)?.count || 0) + 1;
          hosts.set(host, { count, until: count >= 2 ? now() + COOLDOWN : 0 });
          throw error;
        }
      }
    }
  };
}

const comparable = value => normalizedAlias(textContent(String(value))).replace(/ة/g, "ه");
const DECOY = /(?:^| )(?:trailer|teaser|preview|promo|clip|اعلان|تريلر|برومو|مقطع|تشويقي)(?: |$)/;
const LEADING = /^(?:(?:مشاهده|فيلم|مسلسل|watch|movie|series) )+/;
const TRAILING = /(?: (?:كامل|اون لاين|اونلاين|hd|web dl|full hd|مترجم|حصريا))+$/;
const YEAR = /(?:^| )((?:19|20)\d{2})$/;
const EPISODE = /(?:^| )(?:الحلقه|حلقه|episode|ep) *(\d{1,3})(?= |$)/;
const SEASON = /(?:^| )(?:الموسم|الجزء|season|part) +(\d{1,3}|الاول|الاولي|الثاني|الثانيه|الثالث|الثالثه|الرابع|الرابعه|الخامس|السادس)(?= |$)/;
const ORDINALS = { الاول: 1, الاولي: 1, الثاني: 2, الثانيه: 2, الثالث: 3,
  الثالثه: 3, الرابع: 4, الرابعه: 4, الخامس: 5, السادس: 6 };
const EPISODE_ORDINALS = ["الاولي", "الثانيه", "الثالثه", "الرابعه", "الخامسه", "السادسه", "السابعه", "الثامنه", "التاسعه", "العاشره"];

function episodeOrdinal(number) {
  if (number <= 10) return EPISODE_ORDINALS[number - 1];
  if (number === 20) return "العشرون";
  if (number === 30) return "الثلاثون";
  const unit = number % 10;
  if (number > 30) return null;
  return (unit === 1 ? "الحاديه" : EPISODE_ORDINALS[unit - 1]) + (number < 20 ? " عشر" : " والعشرون");
}

export function exactCatalogTitle(label, key, identity) {
  const title = comparable(label);
  if (DECOY.test(title)) return false;
  const aliases = new Set((identity.aliases || []).map(comparable).filter(Boolean));
  const clean = title.replace(LEADING, "").replace(TRAILING, "");
  const movie = key.type === "movie";
  if (movie) {
    if (!identity.year) return false;
    const year = YEAR.exec(clean);
    return year?.[1] === String(identity.year) && aliases.has(clean.slice(0, year.index).trim());
  }
  if (!identity.episodes?.includes(Number(key.episode)) || identity.season !== key.season) return false;
  const packed = /(?:^| )s(\d{1,3})e(\d{1,3})(?= |$)/.exec(clean);
  const episode = EPISODE.exec(clean);
  const season = SEASON.exec(clean);
  if (!packed && !episode) return false;
  const seasonLabel = season?.[1];
  const numberedSeason = /^d+$/.test(seasonLabel || "") ? Number(seasonLabel) : ORDINALS[seasonLabel];
  const candidateSeason = packed ? Number(packed[1]) : season ? numberedSeason
    : identity.seasonCount === 1 && identity.season === 1 ? 1 : null;
  if (candidateSeason !== key.season || Number(packed?.[2] ?? episode?.[1]) !== Number(key.episode)) return false;
  if (packed && (episode && Number(episode[1]) !== Number(key.episode) || season && numberedSeason !== key.season)) return false;
  let remainder = clean.replace(packed?.[0] || /$^/, " ").replace(episode?.[0] || /$^/, " ")
    .replace(season?.[0] || /$^/, " ").replace(/ +/g, " ").trim();
  const ordinal = episodeOrdinal(Number(key.episode));
  if (ordinal && remainder.endsWith(" " + ordinal)) remainder = remainder.slice(0, -1 - ordinal.length);
  if (Number(key.episode) === Math.max(...identity.episodes)) remainder = remainder.replace(/ (?:والاخيره|الاخيره)$/, "");
  const year = YEAR.exec(remainder);
  return year ? year[1] === String(identity.year) && aliases.has(remainder.slice(0, year.index).trim())
    : aliases.has(remainder);
}

function attribute(tag, key) {
  return new RegExp("\\s" + key + "\\s*=\\s*[\"']([^\"']*)[\"']", "i").exec(tag)?.[1] || "";
}

export function createApprovedCatalogSources(names, get) {
  return names.map(id => {
    if (!Object.hasOwn(CATALOGS, id)) throw new Error("unknown_secondary_catalog");
    const { origin, embedPath } = CATALOGS[id];
    const host = new URL(origin).hostname;
    return {
      id,
      async search(key, identity, signal) {
        const queries = [...new Map(identity.aliases.map(alias => [comparable(alias), alias])).values()].slice(0, 3);
        for (const alias of queries) {
          const url = new URL("/search.php", origin);
          url.searchParams.set("keywords", key.episode ? alias + " الحلقة " + key.episode : alias);
          const page = await get(url, { signal, maxBytes: 512 * 1024 });
          if (page.headers["cf-mitigated"] === "challenge" || /<title>Just a moment/i.test(page.html)) {
            throw new Error("catalog_challenge");
          }
          const candidates = new Set();
          for (const [tag] of page.html.matchAll(/<a\b[^>]{1,4096}>/gi)) {
            const label = attribute(tag, "title");
            if (!label || !exactCatalogTitle(label, key, identity)) continue;
            let link;
            try { link = new URL(textContent(attribute(tag, "href")), origin); } catch { continue; }
            const vid = link.searchParams.get("vid");
            if (link.protocol === "https:" && !link.port && !link.username && !link.password
              && link.hostname === host && /^\/(?:watch|video)\.php$/.test(link.pathname)
              && /^[a-z0-9]{4,32}$/i.test(vid || "")) candidates.add(vid);
          }
          if (candidates.size > 3) return [];
          if (!candidates.size) continue;
          const refs = new Set();
          // Check every exact candidate in this result set before accepting a unique asset.
          await Promise.all([...candidates].map(async id => {
            const embed = new URL(embedPath, origin);
            embed.searchParams.set("vid", id);
            const response = await get(embed, { signal, maxBytes: 256 * 1024 });
            for (const [, raw] of response.html.matchAll(/https?:\/\/mp4plus\.org\/(?:embed-)?([a-z0-9]{10,16})(?=\.html|[\s"'<>?#]|$)/gi)) {
              refs.add(raw);
            }
          }));
          if (refs.size) return [...refs];
        }
        return [];
      },
    };
  });
}

export function openSecondaryCache(filename) {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  return new DatabaseSync(filename);
}

export function createUniversalCatalog({ sources, readIdentity, verify, database, now = Date.now }) {
  const scope = createHash("sha256").update(JSON.stringify(sources.map(source => source.id).sort())).digest("hex");
  database.exec(`CREATE TABLE IF NOT EXISTS horizon_secondary (
    scope TEXT NOT NULL, asset TEXT NOT NULL, source TEXT, reference TEXT, runtime REAL, expires INTEGER NOT NULL,
    PRIMARY KEY (scope, asset)
  )`);
  const read = database.prepare("SELECT source, reference, runtime, expires FROM horizon_secondary WHERE scope=? AND asset=?");
  const remove = database.prepare("DELETE FROM horizon_secondary WHERE scope=? AND asset=?");
  const prune = database.prepare("DELETE FROM horizon_secondary WHERE expires <= ?");
  const trim = database.prepare("DELETE FROM horizon_secondary WHERE rowid IN (SELECT rowid FROM horizon_secondary ORDER BY expires DESC LIMIT -1 OFFSET 4096)");
  const put = database.prepare("INSERT OR REPLACE INTO horizon_secondary VALUES (?, ?, ?, ?, ?, ?)");
  const inflight = new Map();
  function remember(id, source, ref, runtime = null) {
    prune.run(now());
    put.run(scope, id, source, ref, runtime, now() + (ref ? MAPPING_TTL : MISS_TTL));
    trim.run();
  }
  async function resolve(assetId, force) {
    const key = catalogKey(assetId);
    if (!key) throw new Error("secondary_identity_missing");
    const cached = read.get(scope, assetId);
    if (!force && cached?.expires > now() && !cached.reference) throw new Error("secondary_catalog_miss");
    const stop = new AbortController();
    const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(6500)]);
    const attempted = new Map();
    const check = (ref, identity) => {
      if (!attempted.has(ref)) attempted.set(ref, Promise.resolve().then(() => verify(assetId, ref, identity, signal)));
      return attempted.get(ref);
    };
    try {
      if (cached?.expires > now() && cached.reference && sources.some(source => source.id === cached.source)
        && MP4PLUS_CODE.test(cached.reference)) {
        try { return await check(cached.reference, { runtime: cached.runtime }); }
        catch {
          remove.run(scope, assetId);
        }
      }
      const identity = await readIdentity(key, signal);
      if (!identity?.aliases?.length || key.type === "movie" && !identity.year) throw new Error("secondary_identity_missing");
      let complete = 0;
      try {
        return await Promise.any(sources.map(async source => {
          const refs = [...new Set(await source.search(key, identity, signal))];
          if (refs.length !== 1 || !MP4PLUS_CODE.test(refs[0])) {
            complete++;
            throw new Error("secondary_catalog_miss");
          }
          try {
            const result = await check(refs[0], identity);
            signal.throwIfAborted();
            return { result, source: source.id, ref: refs[0] };
          } catch (error) {
            if ([404, 410].includes(error.status) || error.message === "mp4plus_no_verified_media") complete++;
            throw error;
          }
        })).then(({ result, source, ref }) => {
          remember(assetId, source, ref, Number.isFinite(identity.runtime) ? identity.runtime : null);
          return result;
        });
      } catch {
        if (complete === sources.length) remember(assetId, null, null);
        throw new Error("secondary_asset_unavailable");
      }
    } finally {
      stop.abort();
    }
  }
  return {
    resolve(assetId, { force = false } = {}) {
      if (inflight.has(assetId)) return inflight.get(assetId);
      if (inflight.size >= 3) return Promise.reject(new Error("secondary_catalog_busy"));
      const work = resolve(assetId, force).finally(() => inflight.delete(assetId));
      inflight.set(assetId, work);
      return work;
    },
    close: () => database.close(),
  };
}
