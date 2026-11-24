import { createHash } from "node:crypto";
import { mediaSignature, safeUrl } from "./catalog.mjs";
import { createPlaybackProvider } from "./playback-provider.mjs";

export const MP4PLUS_HEADERS = Object.freeze({
  "User-Agent": "Horizon Watch", Accept: "video/mp4", "Accept-Encoding": "identity",
});
const EMBED = /^mp4plus\.org$/;
const CDN = /^[a-z0-9-]+\.cdnz\.quest$/;
const HEADER_CHUNK = 128 * 1024;
const MAX_MOOV_SIZE = 32 * 1024 * 1024;
const METADATA_WINDOW = 16 * 1024;

function boxAt(data, offset, end) {
  if (offset + 8 > end) return null;
  let size = data.readUInt32BE(offset);
  let header = 8;
  if (size === 1) {
    if (offset + 16 > end) return null;
    size = Number(data.readBigUInt64BE(offset + 8));
    header = 16;
  }
  if (!Number.isSafeInteger(size) || size < header || !Number.isSafeInteger(offset + size)) return null;
  return { name: data.toString("ascii", offset + 4, offset + 8), start: offset + header, end: offset + size };
}

function* boxes(data, start, end) {
  for (let offset = start, count = 0; count < 256 && offset < end; count++) {
    const box = boxAt(data, offset, end);
    if (!box || box.end > end) return;
    yield box;
    offset = box.end;
  }
}

function findBox(data, parent, name, skip = 0) {
  if (parent) for (const box of boxes(data, parent.start + skip, parent.end)) if (box.name === name) return box;
  return null;
}

function movieHeader(data) {
  for (let offset = 0, count = 0; count < 32; count++) {
    const box = boxAt(data, offset, data.length);
    if (!box || box.end > MAX_MOOV_SIZE || box.name === "mdat") return null;
    if (box.name === "moov") return box;
    offset = box.end;
  }
  return null;
}

function descriptorAt(data, start, end, tag) {
  if (start >= end || data[start++] !== tag) return null;
  for (let count = 0, size = 0; count < 4 && start < end; count++) {
    const byte = data[start++];
    size = size * 128 + (byte & 127);
    if (!(byte & 128)) return start + size <= end ? { start, end: start + size } : null;
  }
  return null;
}

function isAac(data, entry) {
  if (entry.end - entry.start < 28 || data.readUInt16BE(entry.start + 8) !== 0) return false;
  const esds = findBox(data, entry, "esds", 28);
  if (!esds) return false;
  const stream = descriptorAt(data, esds.start + 4, esds.end, 3);
  if (!stream || stream.end - stream.start < 3) return false;
  const flags = data[stream.start + 2];
  let offset = stream.start + 3 + ((flags & 128) ? 2 : 0);
  if (flags & 64) {
    if (offset >= stream.end) return false;
    offset += 1 + data[offset];
  }
  if (flags & 32) offset += 2;
  const decoder = descriptorAt(data, offset, stream.end, 4);
  if (!decoder || decoder.end - decoder.start < 13 || data[decoder.start] !== 0x40) return false;
  const config = descriptorAt(data, decoder.start + 13, decoder.end, 5);
  return config && config.end > config.start && [2, 5, 29].includes(data[config.start] >> 3);
}

function movieDuration(data, mvhd) {
  if (!mvhd) return NaN;
  const version = data[mvhd.start];
  const wide = version === 1;
  if ((version !== 0 && !wide) || mvhd.end - mvhd.start < (wide ? 32 : 20)) return NaN;
  const scale = data.readUInt32BE(mvhd.start + (wide ? 20 : 12));
  const ticks = wide ? Number(data.readBigUInt64BE(mvhd.start + 24)) : data.readUInt32BE(mvhd.start + 16);
  return scale ? ticks / scale : NaN;
}

function sampleEntries(data, stsd) {
  let height = 0;
  let audio = false;
  for (const entry of boxes(data, stsd.start + 8, stsd.end)) {
    if (entry.name === "mp4a" && isAac(data, entry)) audio = true;
    if (entry.name !== "avc1" && entry.name !== "avc3") continue;
    if (entry.end - entry.start < 78) continue;
    const avc = findBox(data, entry, "avcC", 78);
    if (avc && avc.end - avc.start >= 7 && data[avc.start] === 1) {
      height = Math.max(height, data.readUInt16BE(entry.start + 26));
    }
  }
  return { height, audio };
}

export function inspectMp4Header(data, moov = movieHeader(data)) {
  if (!moov || moov.end > data.length) return null;
  const duration = movieDuration(data, findBox(data, moov, "mvhd"));
  if (!Number.isFinite(duration)) return null;
  let height = 0;
  let audio = false;
  for (const track of boxes(data, moov.start, moov.end)) {
    if (track.name !== "trak") continue;
    const mdia = findBox(data, track, "mdia");
    const minf = findBox(data, mdia, "minf");
    const stbl = findBox(data, minf, "stbl");
    const stsd = findBox(data, stbl, "stsd");
    if (!stsd) continue;
    const entries = sampleEntries(data, stsd);
    height = Math.max(height, entries.height);
    audio ||= entries.audio;
  }
  return height && audio ? { duration, height } : null;
}

async function inspectSparseMetadata(initial, moov, get, media, signal, proof) {
  if (moov.end > initial.size) return null;
  const windows = [{ offset: 0, bytes: initial.bytes }];
  async function read(offset, size) {
    if (size > METADATA_WINDOW || offset + size > moov.end) throw new Error("mp4plus_invalid_metadata");
    let window = windows.find(w => offset >= w.offset && offset + size <= w.offset + w.bytes.length);
    if (!window) {
      if (windows.length > 8) throw new Error("mp4plus_metadata_budget");
      const { bytes } = await rangeProbe(get, media, offset, Math.min(moov.end - 1, offset + METADATA_WINDOW - 1), signal, initial.size);
      window = { offset, bytes };
      windows.push(window);
    }
    return window.bytes.subarray(offset - window.offset, offset - window.offset + size);
  }
  async function* children(parent) {
    if (!parent) return;
    for (let offset = parent.start, count = 0; offset + 8 <= parent.end && count < 64; count++) {
      const bytes = await read(offset, Math.min(16, parent.end - offset));
      const box = boxAt(bytes, 0, bytes.length);
      if (!box || offset + box.end > parent.end) throw new Error("mp4plus_invalid_metadata");
      yield { name: box.name, start: offset + box.start, end: offset + box.end };
      offset += box.end;
    }
  }
  async function findChild(parent, name) {
    for await (const box of children(parent)) if (box.name === name) return box;
    return null;
  }
  const mvhd = await findChild(moov, "mvhd");
  if (!mvhd) return null;
  const durationHeader = await read(mvhd.start, Math.min(mvhd.end - mvhd.start, 32));
  const duration = movieDuration(durationHeader, { start: 0, end: durationHeader.length });
  if (!Number.isFinite(duration)) return null;
  proof.update(durationHeader);
  let height = 0;
  let audio = false;
  for await (const track of children(moov)) {
    if (track.name !== "trak") continue;
    let node = track;
    for (const name of ["mdia", "minf", "stbl", "stsd"]) {
      node = await findChild(node, name);
    }
    if (!node) continue;
    const bytes = await read(node.start, node.end - node.start);
    proof.update(bytes);
    const entries = sampleEntries(bytes, { start: 0, end: bytes.length });
    height = Math.max(height, entries.height);
    audio ||= entries.audio;
    if (height && audio) return { duration, height };
  }
  return null;
}

async function rangeProbe(get, url, first, last, signal, total) {
  const range = "bytes=" + first + "-" + last;
  const result = await get(url, { range, signal, expected: 206, maxBytes: last - first + 1, headers: MP4PLUS_HEADERS });
  const mime = String(result.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(result.headers["content-range"] || "");
  const size = Number(match?.[3]);
  const count = last - first + 1;
  if (!match || Number(match[1]) !== first || Number(match[2]) !== last || size <= last
    || !Number.isSafeInteger(size) || total !== undefined && size !== total
    || result.bytes?.length !== count || result.headers["content-encoding"]
    || result.headers["content-length"] != null && Number(result.headers["content-length"]) !== count
    || !["video/mp4", "application/octet-stream"].includes(mime)) throw new Error("mp4plus_invalid_range");
  return { bytes: result.bytes, size };
}

export function createMp4PlusDelivery(get) {
  return async function verify(assetId, ref, identity, signal) {
    if (!/^[a-z0-9]{10,16}$/i.test(ref)) throw new Error("mp4plus_invalid_reference");
    const url = safeUrl("https://mp4plus.org/embed-" + ref + ".html", EMBED);
    const page = await get(url, { signal, maxBytes: 256 * 1024 });
    const urls = new Map();
    const duplicates = new Set();
    for (const [, raw, quality] of page.html.matchAll(/\bfile\s*:\s*"([^"]{1,4096})"\s*,\s*label\s*:\s*"(\d{3,4})p"/gi)) {
      try {
        const media = safeUrl(raw, CDN);
        if (!media.pathname.endsWith("/v.mp4") || Number(quality) < 240 || Number(quality) > 1080) continue;
        if (urls.has(quality) && urls.get(quality).href !== media.href) duplicates.add(quality);
        urls.set(quality, media);
      } catch { /* Only the scoped MP4Plus CDN is eligible. */ }
    }
    const sources = [];
    let transientFailure;
    const movie = assetId.startsWith("movie-");
    if (movie && (!Number.isFinite(identity.runtime) || identity.runtime < 35)) throw new Error("mp4plus_runtime_missing");
    for (const [quality, media] of [...urls].sort((a, b) => Number(b[0]) - Number(a[0])).slice(0, 4)) {
      if (duplicates.has(quality) || sources.some(source => source.url === media.href)) continue;
      const attemptSignal = sources.length ? AbortSignal.any([signal, AbortSignal.timeout(1700)]) : signal;
      try {
        const initial = await rangeProbe(get, media, 0, HEADER_CHUNK - 1, attemptSignal);
        if (mediaSignature(initial.bytes) !== "mp4") continue;
        const moov = movieHeader(initial.bytes);
        if (!moov) continue;
        const proof = createHash("sha256").update(String(initial.size)).update(initial.bytes.subarray(0, moov.end));
        const info = moov.end <= initial.bytes.length ? inspectMp4Header(initial.bytes, moov)
          : await inspectSparseMetadata(initial, moov, get, media, attemptSignal, proof);
        if (!info || info.height > Number(quality) || info.height < 200
          || info.duration < (movie ? 2100 : 420) || info.duration > (movie ? 21600 : 9000)
          || initial.size < info.duration * 5000
          || Number.isFinite(identity.runtime) && Math.abs(info.duration - 60 * identity.runtime) > Math.max(180, 4.8 * identity.runtime)) continue;
        const middle = Math.floor(initial.size / 2);
        const sample = await rangeProbe(get, media, middle, middle + 11, attemptSignal, initial.size);
        const fingerprint = proof.update(sample.bytes).digest("hex");
        sources.push({ key: quality + "p:" + fingerprint, url: media.href, format: "mp4", verified: true, totalBytes: initial.size });
        if (sources.length === 2) break;
      } catch (error) {
        if (sources.length && attemptSignal.aborted) break;
        signal.throwIfAborted();
        if (error.status === 401 || error.status === 403 || error.status === 429) throw error;
        if (error.status !== undefined ? error.status >= 500 || error.status === 408
          : error.code || error.name === "TimeoutError" || error.message === "upstream_cooldown") transientFailure ||= error;
      }
    }
    if (!sources.length) throw transientFailure || new Error("mp4plus_no_verified_media");
    return { assetId, work: "mp4plus:" + ref, sources };
  };
}

export function createMp4PlusProvider(catalog) {
  return createPlaybackProvider({
    enabled: !!catalog, relayPermitted: !!catalog, mediaHosts: CDN, bindEpisodeWork: true, episodeRenditions: 2,
    resolveSources: (id, options) => catalog.resolve(id, options),
  });
}

export const MP4PLUS_MEDIA_HOST = CDN;
