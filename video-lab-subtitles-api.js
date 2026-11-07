// SubDL stays server-side. Only authenticated Video Lab sessions may spend its quota.
const MAX_DOWNLOAD = 2 * 1024 * 1024;
const MAX_TEXT = 750 * 1024;
const memory = new Map();

function json(status, code) {
  return new Response(JSON.stringify({ code }), { status, headers: {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
  } });
}

function subtitleResponse(body) {
  return new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer" } });
}

function identity(url) {
  const allowed = new Set(["type", "tmdb_id", "season", "episode"]);
  if ([...url.searchParams.keys()].some(key => !allowed.has(key))) return null;
  const type = url.searchParams.get("type");
  const id = url.searchParams.get("tmdb_id");
  const season = url.searchParams.get("season");
  const episode = url.searchParams.get("episode");
  if (!/^[1-9]\d{0,8}$/.test(id || "") || !["movie", "tv"].includes(type)) return null;
  if (type === "movie" && (season !== null || episode !== null)) return null;
  if (type === "tv" && (!/^[1-9]\d{0,2}$/.test(season || "")
      || !/^[1-9]\d{0,2}$/.test(episode || ""))) return null;
  return { type, id: Number(id), season: Number(season), episode: Number(episode) };
}

function isEnglish(lang) {
  if (!lang) return true;
  return /^(?:en|eng|english)$/i.test(String(lang).trim());
}

function episodeMatch(entry, target, parent) {
  if (target.type !== "tv") return true;
  const s = Number(entry?.season) || Number(parent?.season) || null;
  const e = Number(entry?.episode) || null;
  if (s !== null && s !== target.season) return false;
  if (e !== null && e === target.episode) return true;
  const token = new RegExp("(?:s|season)[ ._-]*0?" + target.season
    + "[ ._-]*(?:e|episode)[ ._-]*0?" + target.episode + "(?!\\d)", "i");
  if (token.test(entry?.name || "") || token.test(entry?.release_name || "")) return true;
  const epOnly = new RegExp("(?:e|episode)[ ._-]*0?" + target.episode + "(?!\\d)|\\b0?" + target.episode + "\\b", "i");
  if (epOnly.test(entry?.name || "")) return true;
  return false;
}

function rawPath(path) {
  if (typeof path !== "string" || !path.trim() || path.includes("..")) return null;
  try {
    const url = new URL(path, "https://dl.subdl.com");
    if (url.origin !== "https://dl.subdl.com") return null;
    if (!/^\/subtitles?\/[a-zA-Z0-9_./\-+~%()[\]@ ]{1,250}$/.test(url.pathname)) return null;
    return url.href;
  } catch (_error) { return null; }
}

// Prefer exact episode files. A pack is usable only when unpack exposes that episode or as ZIP fallback.
export function selectSubtitle(data, target) {
  if (!data || data.status !== true || !Array.isArray(data.subtitles)) return null;
  if (Array.isArray(data.results) && data.results.length > 0) {
    const matchingId = data.results.some(r => Number(r.tmdb_id) === target.id
      && (!r.type || r.type === target.type));
    if (!matchingId) return null;
  }
  const matches = [];
  for (const row of data.subtitles.slice(0, 30)) {
    if (!row || typeof row !== "object") continue;
    if (!isEnglish(row.language || row.lang)) continue;
    const files = Array.isArray(row.unpack_files) ? row.unpack_files : [];
    for (const file of files.slice(0, 100)) {
      if (target.type === "tv" && !episodeMatch(file, target, row)) continue;
      if (!isEnglish(file.language || file.lang)) continue;
      if (!/\.(?:srt|vtt)$/i.test(file.name || "") && !/^(?:srt|vtt)$/i.test(file.format || "")) continue;
      const url = rawPath(file.url || file.download_link);
      if (url) matches.push({ url, zip: false, score: 100 + (row.hi ? 0 : 5),
        release: String(file.release_name || row.release_name || "").slice(0, 120) });
    }
    const isSeasonPack = !!row.full_season;
    const rowSeason = Number(row.season);
    const seasonOk = target.type === "movie" || !rowSeason || rowSeason === target.season;
    if (target.type === "movie" || episodeMatch(row, target, null) || (isSeasonPack && seasonOk)) {
      const rowPath = row.url || row.download_link;
      const url = rawPath(rowPath);
      const isZip = /\.zip$/i.test(rowPath || "") || isSeasonPack;
      if (url) {
        const score = (target.type === "movie" || episodeMatch(row, target, null))
          ? (50 + (row.hi ? 0 : 5))
          : (25 + (row.hi ? 0 : 5));
        matches.push({ url, zip: isZip, score,
          release: String(row.release_name || row.name || "").slice(0, 120) });
      }
    }
  }
  matches.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  return matches[0] || null;
}

async function boundedBytes(response, max) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > max) throw Error("too_large");
  const reader = response.body?.getReader();
  if (!reader) throw Error("empty");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw Error("too_large");
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  return bytes;
}

// ZIP central directory avoids relying on local headers' optional data descriptors.
export async function extractSubtitleZip(bytes, target) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
    if (view.getUint32(p, true) === 0x06054b50) { end = p; break; }
  }
  if (end < 0) throw Error("invalid_zip");
  const count = Math.min(100, view.getUint16(end + 10, true));
  let pos = view.getUint32(end + 16, true);
  const files = [];
  for (let i = 0; i < count; i++) {
    if (pos + 46 > bytes.length || view.getUint32(pos, true) !== 0x02014b50) break;
    const method = view.getUint16(pos + 10, true);
    const compressed = view.getUint32(pos + 20, true);
    const uncompressed = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const offset = view.getUint32(pos + 42, true);
    const name = new TextDecoder().decode(bytes.slice(pos + 46, pos + 46 + nameLen));
    if (/\.(?:srt|vtt)$/i.test(name) && uncompressed <= MAX_TEXT && compressed <= MAX_DOWNLOAD)
      files.push({ name, method, compressed, offset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  const token = target.type === "tv" ? new RegExp("(?:s|season)[ ._-]*0?" + target.season
    + "[ ._-]*(?:e|episode)[ ._-]*0?" + target.episode + "(?!\\d)", "i") : null;
  files.sort((a, b) => Number(!!token && token.test(b.name)) - Number(!!token && token.test(a.name))
    || a.name.localeCompare(b.name));
  const file = files.find(f => target.type === "movie" || token.test(f.name))
    || (target.type === "tv" && files.length === 1
      && !/(?:s|season)[ ._-]*\d+[ ._-]*(?:e|episode)[ ._-]*\d+/i.test(files[0].name)
      ? files[0] : null);
  if (!file) throw Error("no_episode_file");
  const start = file.offset;
  if (start + 30 > bytes.length || view.getUint32(start, true) !== 0x04034b50) throw Error("invalid_zip");
  const dataStart = start + 30 + view.getUint16(start + 26, true) + view.getUint16(start + 28, true);
  const payload = bytes.slice(dataStart, dataStart + file.compressed);
  if (payload.length !== file.compressed) throw Error("invalid_zip");
  if (file.method === 0) return new TextDecoder("utf-8").decode(payload);
  if (file.method !== 8 || typeof DecompressionStream === "undefined") throw Error("zip_method_unavailable");
  const stream = new Blob([payload]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new TextDecoder("utf-8").decode(await boundedBytes(new Response(stream), MAX_TEXT));
}

export async function subtitleApi(request, env, authorized, fetchUpstream = fetch, cache = globalThis.caches?.default) {
  const url = new URL(request.url);
  if (request.method !== "GET") return json(405, "method_not_allowed");
  const target = identity(url);
  if (!target) return json(400, "invalid_identity");
  if (!authorized) return json(403, "not_authorized");
  if (!env.SUBDL_API_KEY) return json(503, "subdl_unconfigured");
  const key = new Request(url.origin + url.pathname + "?type=" + target.type + "&tmdb_id=" + target.id
    + (target.type === "tv" ? "&season=" + target.season + "&episode=" + target.episode : ""));
  const inMemory = memory.get(key.url);
  if (inMemory && inMemory.expires > Date.now()) return subtitleResponse(inMemory.body);
  let cached = null;
  try { cached = await cache?.match(key); } catch (_error) { /* Cache API unavailable under Access. */ }
  if (cached) {
    const body = await cached.text();
    memory.set(key.url, { body, expires: Date.now() + 3600000 });
    return subtitleResponse(body);
  }
  const search = new URL("https://api.subdl.com/api/v1/subtitles");
  search.searchParams.set("api_key", env.SUBDL_API_KEY);
  search.searchParams.set("tmdb_id", String(target.id));
  search.searchParams.set("type", target.type);
  if (target.type === "tv") {
    search.searchParams.set("season_number", String(target.season));
    search.searchParams.set("episode_number", String(target.episode));
  }
  search.searchParams.set("languages", "EN");
  search.searchParams.set("unpack", "1");
  search.searchParams.set("subs_per_page", "20");
  search.searchParams.set("client", "custom_integration");
  let result;
  try {
    const found = await fetchUpstream(search, { headers: { Accept: "application/json" },
      redirect: "manual", signal: AbortSignal.timeout(4500) });
    if (found.status === 401 || found.status === 403) return json(502, "subdl_auth_failed");
    if (found.status === 429) return json(503, "subdl_rate_limited");
    if (!found.ok) return json(502, "subdl_unavailable");
    result = JSON.parse(new TextDecoder().decode(await boundedBytes(found, 300 * 1024)));
  } catch (_error) { return json(502, "subdl_unavailable"); }
  if (result?.status === false) {
    const reason = String(result.error || "").slice(0, 160).toLowerCase();
    if (/api.?key|invalid.?key|unauthori[sz]ed|forbidden/.test(reason))
      return json(502, "subdl_auth_failed");
    if (/rate.?limit|quota|too many requests/.test(reason))
      return json(503, "subdl_rate_limited");
    return json(502, "subdl_unavailable");
  }
  if (result?.status !== true || !Array.isArray(result.results)
      || !Array.isArray(result.subtitles)) return json(502, "subdl_invalid_response");
  if (Array.isArray(result.results) && result.results.length > 0) {
    const hasMatch = result.results.some(r => Number(r.tmdb_id) === target.id
      && (!r.type || r.type === target.type));
    if (!hasMatch) return json(502, "subdl_identity_mismatch");
  }
  const chosen = selectSubtitle(result, target);
  if (!chosen) return json(404, "subtitle_unavailable");
  let text;
  try {
    const download = await fetchUpstream(chosen.url, { redirect: "manual", signal: AbortSignal.timeout(5000) });
    if (!download.ok) return json(502, "download_unavailable");
    const bytes = await boundedBytes(download, MAX_DOWNLOAD);
    text = chosen.zip ? await extractSubtitleZip(bytes, target) : new TextDecoder("utf-8").decode(bytes);
  } catch (_error) { return json(502, "download_unavailable"); }
  if (!text || text.length > MAX_TEXT || !/\d\d:\d\d:\d\d[,.]\d{2,3}/.test(text))
    return json(422, "unsupported_subtitle");
  const body = JSON.stringify({ language: "en", format: /^WEBVTT/.test(text) ? "vtt" : "srt",
    text, release: chosen.release });
  if (memory.size >= 16) memory.delete(memory.keys().next().value);
  memory.set(key.url, { body, expires: Date.now() + 3600000 });
  if (cache) {
    const stored = subtitleResponse(body);
    stored.headers.set("Cache-Control", "public, max-age=3600");
    await cache.put(key, stored).catch(() => {});
  }
  return subtitleResponse(body);
}
