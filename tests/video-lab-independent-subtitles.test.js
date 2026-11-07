import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { deflateRawSync } from "node:zlib";
import { createHash, webcrypto } from "node:crypto";
import { selectSubtitle, subtitleApi, extractSubtitleZip } from "../video-lab-subtitles-api.js";

const script = readFileSync(new URL("../video-lab/independent-subtitles.js", import.meta.url), "utf8");
const fixture = readFileSync(new URL("./fixtures/south-park-s15e7-demo.srt", import.meta.url), "utf8");
function module(hostname) {
  const window = hostname ? { location: { hostname } } : {};
  runInNewContext(script, { window, URLSearchParams });
  return window.HorizonIndependentSubtitles;
}

test("production hostname never requests the synthetic fixture", async () => {
  const requested = [];
  const captions = module("horizon-video-lab-preview.ali-al-anbari.workers.dev");
  const track = captions.create({ caption: { textContent: "", hidden: true },
    fetch: async url => { requested.push(String(url)); return { ok: false,
      json: async () => ({ code: "subtitle_unavailable" }) }; } });
  track.setTarget({ type: "tv", id: 2190, season: 15, episode: 7 }, false);
  await track.load();
  assert.equal(requested.length, 1);
  assert.match(requested[0], /^\/api\/subtitles\?/);
  assert.equal(track.state().available, false);
});

test("Video Lab Worker subtitle route accepts its own paired cookie and rejects missing or invalid sessions", async () => {
  const authSource = readFileSync(new URL("../video-lab-player-api.js", import.meta.url), "utf8")
    .replace(/^import .*\n/gm, "").replace(/^export \{.*\};\n/gm, "")
    .replace("export async function playerApi", "async function playerApi");
  const authContext = { crypto: webcrypto, Request, Response, URL, Headers, TextEncoder, TextDecoder,
    handleApi: () => new Response("pairing route"), Set, JSON };
  runInNewContext(authSource, authContext);
  const workerSource = readFileSync(new URL("../video-lab-preview-worker.js", import.meta.url), "utf8")
    .replace(/^import .*\n/gm, "").replace(/^export \{.*\};\n/gm, "")
    .replace("export default", "globalThis.videoLabWorker =");
  const workerContext = { URL, subtitleApi, pairedSessionAuthorized: authContext.pairedSessionAuthorized,
    playerApi: authContext.playerApi, media: { fetch: () => new Response("asset") } };
  runInNewContext(workerSource, workerContext);
  const videoLabWorker = workerContext.videoLabWorker;
  const cookie = "__Host-horizon_session=" + "a".repeat(64);
  const expectedHash = createHash("sha256").update("a".repeat(64)).digest("hex");
  const env = { LAUNCH_QUEUE: { idFromName: () => "primary-tv", get: () => ({
    pairAuthenticate: async hash => hash === expectedHash
      ? { deviceId: "approved-video-lab-tv" } : null,
  }) } };
  const url = "https://video.example/api/subtitles?type=tv&tmdb_id=2190&season=15&episode=7";
  assert.equal((await videoLabWorker.fetch(new Request(url), env)).status, 403);
  assert.equal((await videoLabWorker.fetch(new Request(url, { headers: { Cookie: cookie } }), env)).status, 503,
    "paired request reaches the missing-key check instead of failing authorization");
  assert.equal((await videoLabWorker.fetch(new Request(url, { headers: {
    Cookie: "__Host-horizon_session=" + "b".repeat(64),
  } }), env)).status, 403);
});

test("SRT cue lookup handles boundaries, overlaps, malformed blocks, and backward seeks", () => {
  const captions = module();
  const cues = captions.parse(fixture + "\nBAD\n00:00:30,000 --> invalid\nBroken\n");
  assert.equal(cues.length, 3);
  assert.equal(captions.cueAt(cues, 5)?.text, "[Local subtitle timing demonstration]");
  assert.equal(captions.cueAt(cues, 8), null);
  assert.equal(captions.cueAt(cues, 22)?.text, "Adjust timing by half a second if needed.");
  assert.equal(captions.cueAt(cues, 12)?.text, "This text is synthetic and is not an episode transcript.");
});

test("captions stay Off, follow reported timestamps only, and clear on unreliable timelines", async () => {
  const captions = module();
  const caption = { textContent: "", hidden: true };
  const track = captions.create({ caption, fetch: async () => ({ ok: true,
    json: async () => ({ text: fixture, release: "Local demonstration fixture" }) }) });
  track.setTarget({ type: "tv", id: 2190, season: 15, episode: 7 }, false);
  await track.load();
  track.update(5.5, true);
  assert.equal(caption.hidden, true, "availability never enables subtitles");
  track.setEnabled(true);
  assert.equal(caption.textContent, "[Local subtitle timing demonstration]");
  track.update(12.1, true);
  assert.match(caption.textContent, /synthetic/);
  track.update(21.2, false);
  assert.equal(caption.hidden, true, "ad or unreliable timeline is blank");
  track.update(21.2, true);
  assert.match(caption.textContent, /Adjust timing/);
  track.adjust(1);
  assert.equal(track.state().offset, 0.5);
  track.update(12.2, true);
  assert.equal(caption.hidden, true, "positive offset delays subtitle so it has not appeared yet at 12.2s");
  track.update(12.6, true);
  assert.match(caption.textContent, /synthetic/, "delayed subtitle appears once video passes 12.5s");
  track.adjust(-1);
  track.adjust(-1);
  assert.equal(track.state().offset, -0.5);
  track.update(11.7, true);
  assert.match(caption.textContent, /synthetic/, "negative offset advances subtitle so it appears earlier at 11.7s");
  track.setTarget({ type: "tv", id: 2190, season: 15, episode: 8 }, true);
  assert.equal(caption.hidden, true);
  assert.equal(track.state().enabled, true, "explicit choice survives an episode switch");
  assert.equal(track.state().offset, 0, "offset resets to 0.0s for a different episode/file");
});

test("stale subtitle response cannot replace a newer episode", async () => {
  const captions = module();
  let resolveOld;
  const track = captions.create({ caption: { textContent: "", hidden: true },
    fetch: () => new Promise(resolve => { resolveOld = resolve; }) });
  track.setTarget({ type: "tv", id: 2190, season: 15, episode: 7 }, false);
  const pending = track.load();
  track.setTarget({ type: "tv", id: 2190, season: 15, episode: 8 }, true);
  resolveOld({ ok: true, json: async () => ({ text: fixture }) });
  await pending;
  assert.equal(track.state().available, false);
});

test("SubDL selection accepts only exact episode files, including unpacked season packs", () => {
  const target = { type: "tv", id: 2190, season: 15, episode: 7 };
  const chosen = selectSubtitle({ status: true, results: [{ tmdb_id: 2190 }], subtitles: [
    { full_season: true, unpack_files: [
      { season: 15, episode: 6, language: "EN", format: "srt", url: "/subtitle/1/wrong", name: "S15E06.srt" },
      { season: 15, episode: 7, language: "EN", format: "srt", url: "/subtitle/1/right", name: "S15E07.srt" },
    ] },
  ] }, target);
  assert.equal(chosen.url, "https://dl.subdl.com/subtitle/1/right");
  assert.equal(selectSubtitle({ status: true, results: [{ tmdb_id: 999 }], subtitles: [] }, target), null);
});

test("SubDL selection handles realistic API structures: missing file.language, pack fallbacks, and movie URLs with brackets", () => {
  const spTarget = { type: "tv", id: 2190, season: 15, episode: 7 };
  // 1. South Park S15E7 unpacked file where language is on parent and season is omitted from unpack_file
  const spUnpacked = selectSubtitle({
    status: true,
    results: [{ tmdb_id: 2190, type: "tv" }],
    subtitles: [{
      season: 15,
      full_season: true,
      lang: "English",
      language: "english",
      unpack_files: [
        { name: "South.Park.S15E06.HDTV.srt", episode: 6, url: "/subtitle/2190/ep6.srt" },
        { name: "South.Park.S15E07.HDTV.srt", episode: 7, url: "/subtitle/2190/ep7.srt" },
      ]
    }]
  }, spTarget);
  assert.ok(spUnpacked);
  assert.equal(spUnpacked.url, "https://dl.subdl.com/subtitle/2190/ep7.srt");
  assert.equal(spUnpacked.zip, false);

  // 2. South Park S15E7 season pack fallback when unpack_files is absent
  const spPack = selectSubtitle({
    status: true,
    results: [{ tmdb_id: 2190, type: "tv" }],
    subtitles: [{
      season: 15,
      full_season: true,
      language: "English",
      url: "/subtitle/2190-season-15.zip",
      release_name: "South.Park.S15.720p.HDTV"
    }]
  }, spTarget);
  assert.ok(spPack);
  assert.equal(spPack.url, "https://dl.subdl.com/subtitle/2190-season-15.zip");
  assert.equal(spPack.zip, true);

  // 3. The Dark Knight (2008) with brackets, parentheses, and download_link
  const tdkTarget = { type: "movie", id: 155 };
  const tdk = selectSubtitle({
    status: true,
    results: [{ tmdb_id: 155, type: "movie" }],
    subtitles: [{
      language: "english",
      download_link: "https://dl.subdl.com/subtitle/155-The.Dark.Knight.(2008).[YTS].zip",
      release_name: "The.Dark.Knight.2008.720p.BluRay.x264-[YTS.AM]"
    }]
  }, tdkTarget);
  assert.ok(tdk);
  assert.equal(tdk.url, "https://dl.subdl.com/subtitle/155-The.Dark.Knight.(2008).[YTS].zip");
  assert.equal(tdk.zip, true);

  // 4. Non-English subtitle rows are ignored
  const foreignOnly = selectSubtitle({
    status: true,
    results: [{ tmdb_id: 155, type: "movie" }],
    subtitles: [{
      language: "Spanish",
      url: "/subtitle/155-spanish.srt"
    }]
  }, tdkTarget);
  assert.equal(foreignOnly, null);
});

test("server route keeps key off the client and caches successful subtitle text", async () => {
  const calls = [];
  const cache = { item: null, async match() { return this.item?.clone(); }, async put(_key, value) { this.item = value.clone(); } };
  const upstream = async url => {
    calls.push(String(url).replace(/api_key=[^&]+/, "api_key=REDACTED"));
    if (String(url).includes("api.subdl.com")) return new Response(JSON.stringify({ status: true,
      results: [{ tmdb_id: 2190 }], subtitles: [{ season: 15, episode: 7, full_season: false,
        url: "/subtitle/123.srt", release_name: "S15E07" }] }),
    { headers: { "content-type": "application/json" } });
    return new Response(fixture);
  };
  const request = new Request("https://video.example/api/subtitles?type=tv&tmdb_id=2190&season=15&episode=7");
  const first = await subtitleApi(request, { SUBDL_API_KEY: "private-test-key" }, true, upstream, cache);
  assert.equal(first.status, 200);
  const payload = await first.json();
  assert.equal(payload.text, fixture);
  assert.equal(JSON.stringify(payload).includes("private-test-key"), false);
  assert.match(calls[0], /season_number=15&episode_number=7&languages=EN&unpack=1/);
  const second = await subtitleApi(request, { SUBDL_API_KEY: "private-test-key" }, true, upstream, cache);
  assert.equal(second.status, 200);
  assert.equal(calls.length, 2, "search and download are reused from cache");
  assert.equal((await subtitleApi(request, {}, true, upstream, cache)).status, 503);
  assert.equal((await subtitleApi(request, { SUBDL_API_KEY: "x" }, false, upstream, cache)).status, 403);
});

test("movie search uses its TMDB identity without TV parameters and accepts a matching file", async () => {
  const calls = [];
  const upstream = async url => {
    calls.push(new URL(String(url)));
    if (calls.length === 1) return new Response(JSON.stringify({ status: true,
      results: [{ tmdb_id: 155, type: "movie" }], subtitles: [{
        url: "/subtitle/155.srt", release_name: "The.Dark.Knight.2008" }] }));
    return new Response(fixture);
  };
  const request = new Request("https://video.example/api/subtitles?type=movie&tmdb_id=155");
  const response = await subtitleApi(request, { SUBDL_API_KEY: "private-test-key" }, true, upstream, null);
  assert.equal(response.status, 200);
  assert.equal(calls[0].searchParams.get("tmdb_id"), "155");
  assert.equal(calls[0].searchParams.get("type"), "movie");
  assert.equal(calls[0].searchParams.get("languages"), "EN");
  assert.equal(calls[0].searchParams.has("season_number"), false);
  assert.equal(calls[0].searchParams.has("episode_number"), false);
  assert.equal((await response.json()).text, fixture);
});

test("search failures and malformed responses never report genuine subtitle absence", async () => {
  const key = { SUBDL_API_KEY: "private-test-key" };
  const cases = [
    [new Response("", { status: 401 }), 502, "subdl_auth_failed"],
    [new Response("", { status: 429 }), 503, "subdl_rate_limited"],
    [new Response(JSON.stringify({ status: false, error: "invalid key" })), 502, "subdl_auth_failed"],
    [new Response(JSON.stringify({ status: false, error: "quota exceeded" })), 503, "subdl_rate_limited"],
    [new Response(JSON.stringify({ status: false, error: "temporary problem" })), 502, "subdl_unavailable"],
    [new Response(JSON.stringify({ status: true, results: [], subtitles: {} })), 502, "subdl_invalid_response"],
    [new Response(JSON.stringify({ status: true, results: [{ tmdb_id: 999, type: "movie" }], subtitles: [] })), 502, "subdl_identity_mismatch"],
    [new Response(JSON.stringify({ status: true, results: [{ tmdb_id: 155, type: "movie" }], subtitles: [] })), 404, "subtitle_unavailable"],
  ];
  for (const [index, [upstreamResponse, status, code]] of cases.entries()) {
    const request = new Request("https://video-case-" + index + ".example/api/subtitles?type=movie&tmdb_id=155");
    const response = await subtitleApi(request, key, true, async () => upstreamResponse, null);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { code });
  }
});

test("download and unreadable subtitle failures stay distinct from an empty search", async () => {
  const searchBody = JSON.stringify({ status: true, results: [{ tmdb_id: 155, type: "movie" }],
    subtitles: [{ url: "/subtitle/155.srt", release_name: "The.Dark.Knight.2008" }] });
  for (const [suffix, downloaded, expectedStatus, expectedCode] of [
    ["download", new Response("", { status: 503 }), 502, "download_unavailable"],
    ["parse", new Response("not an SRT file"), 422, "unsupported_subtitle"],
  ]) {
    let calls = 0;
    const response = await subtitleApi(new Request("https://video-" + suffix
      + ".example/api/subtitles?type=movie&tmdb_id=155"),
    { SUBDL_API_KEY: "private-test-key" }, true, async () => ++calls === 1
      ? new Response(searchBody) : downloaded, null);
    assert.equal(response.status, expectedStatus);
    assert.deepEqual(await response.json(), { code: expectedCode });
  }
});


test("ZIP extraction refuses an archive without an episode subtitle", async () => {
  await assert.rejects(extractSubtitleZip(new Uint8Array([1, 2, 3]),
    { type: "tv", season: 15, episode: 7 }), /invalid_zip/);
});

test("ZIP extraction selects and inflates the requested episode", async () => {
  const name = Buffer.from("South.Park.S15E07.srt");
  const plain = Buffer.from(fixture);
  const compressed = deflateRawSync(plain);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(plain.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(plain.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + compressed.length, 16);
  const archive = Buffer.concat([local, name, compressed, central, name, end]);
  assert.equal(await extractSubtitleZip(archive, { type: "tv", season: 15, episode: 7 }), fixture);
  await assert.rejects(extractSubtitleZip(archive, { type: "tv", season: 15, episode: 8 }),
    /no_episode_file/);
});

test("subtitle offset strictly clamps to ±10.0 seconds in 0.5s steps and resets on 0", async () => {
  const captions = module();
  const caption = { textContent: "", hidden: true };
  const track = captions.create({ caption, fetch: async () => ({ ok: true,
    json: async () => ({ text: fixture, release: "Local demo" }) }) });
  track.setTarget({ type: "tv", id: 2190, season: 15, episode: 7 }, false);
  await track.load();
  track.setEnabled(true);

  // Initial offset is 0.0s
  assert.equal(track.state().offset, 0);

  // Positive direction increments by 0.5s
  track.adjust(1);
  assert.equal(track.state().offset, 0.5);
  track.adjust(1);
  assert.equal(track.state().offset, 1.0);

  // Clamp at +10.0s max
  for (let i = 0; i < 25; i++) track.adjust(1);
  assert.equal(track.state().offset, 10.0);

  // adjust(0) resets to 0.0s
  track.adjust(0);
  assert.equal(track.state().offset, 0);

  // Negative direction decrements by 0.5s
  track.adjust(-1);
  assert.equal(track.state().offset, -0.5);

  // Clamp at -10.0s min
  for (let i = 0; i < 25; i++) track.adjust(-1);
  assert.equal(track.state().offset, -10.0);

  // resetOffset() method resets to 0.0s
  track.resetOffset();
  assert.equal(track.state().offset, 0);
});

test("timing adjustment immediately resynchronizes captions while paused", async () => {
  const captions = module();
  const caption = { textContent: "", hidden: true };
  const track = captions.create({ caption, fetch: async () => ({ ok: true,
    json: async () => ({ text: fixture, release: "Local demo" }) }) });
  track.setTarget({ type: "tv", id: 2190, season: 15, episode: 7 }, false);
  await track.load();
  track.setEnabled(true);

  // Video was playing and then paused at 12.2s (Cue 2: 12.0s -> 15.5s)
  track.update(12.2, true);
  assert.equal(caption.hidden, false);
  assert.match(caption.textContent, /synthetic/);

  // User pauses, and adjusts timing by +0.5s (delay subtitles):
  // At 12.2s, effective subtitle time is 12.2 - 0.5 = 11.7s (< 12.0s start)
  // Caption must immediately hide while paused without waiting for playback!
  track.adjust(1);
  assert.equal(caption.hidden, true);

  // User resets timing to 0.0s with adjust(0):
  // At 12.2s, effective subtitle time is 12.2s.
  // Caption must immediately reappear while paused!
  track.adjust(0);
  assert.equal(caption.hidden, false);
  assert.match(caption.textContent, /synthetic/);

  // User adjusts timing by -0.5s (advance subtitles):
  // At 12.2s, effective subtitle time is 12.2 - (-0.5) = 12.7s.
  // Caption remains visible!
  track.adjust(-1);
  assert.equal(caption.hidden, false);
  assert.match(caption.textContent, /synthetic/);
});
