import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { catalogKey } from "../oracle-relay/catalog.mjs";
import {
  createApprovedCatalogSources, createCatalogTransport, createUniversalCatalog, exactCatalogTitle, openSecondaryCache,
} from "../oracle-relay/universal-catalog.mjs";
import { createMp4PlusDelivery, createMp4PlusProvider, inspectMp4Header } from "../oracle-relay/mp4plus-provider.mjs";

const movie = "movie-629040";
const episode = "tv-297621-s1-e5";
const ref = "example000001";
const required = { aliases: ["ولاد رزق 3: القاضية", "Welad Rizk 3"], year: "2024", runtime: 120 };
const show = { aliases: ["فخر الدلتا"], season: 1, seasonCount: 1, episodes: [1, 5, 30], year: "2026" };
const candidate = (id, reference = ref) => ({
  assetId: id, work: "mp4plus:" + reference,
  sources: [{ key: "480p:stable", url: "https://media.cdnz.quest/example/v.mp4", format: "mp4", verified: true }],
});

test("matches normalized exact editions and episodes without dropping sequel numbers", () => {
  const one = label => exactCatalogTitle(label, catalogKey(movie), required);
  assert.ok(one("مشاهدة فيلم ولاد رزق ٣ - القَاضية (٢٠٢٤) HD اون لاين"));
  assert.ok(one("Welad Rizk 3 2024"));
  for (const label of ["ولاد رزق القاضية 2024", "ولاد رزق 2: القاضية 2024", "Welad Rizk 3 2023",
    "Welad Rizk 3", "Welad Rizk 3 2024 teaser", "Welad Rizk 3 2024 unrelated"]) assert.equal(one(label), false, label);
  const tv = (label, meta = show) => exactCatalogTitle(label, catalogKey(episode), meta);
  assert.ok(tv("مسلسل فخر الدلتا الحلقة ٥ الخامسة"));
  assert.ok(tv("فخر الدلتا الموسم الاول الحلقة 5", { ...show, seasonCount: 2 }));
  assert.ok(tv("فخر الدلتا S01E05", { ...show, seasonCount: 2 }));
  for (const label of ["فخر الدلتا الموسم الثاني الحلقة 5", "فخر الدلتا الحلقة 6",
    "فخر الدلتا الحلقة 5 الرابعة", "فخر الدلتا S02E05", "فخر الدلتا 2 الحلقة 5"]) assert.equal(tv(label), false, label);
  assert.equal(tv("فخر الدلتا الحلقة 5", { ...show, seasonCount: 2 }), false);
});

test("approved catalog returns only independently matched MP4Plus references and does not fetch foreign links", async () => {
  const hits = '<a title="Welad Rizk 3 2024" href="/watch.php?vid=known123">&gt;</a>'
    + '<a title="Welad Rizk 3 2024" href="https://unknown.example/watch.php?vid=bad123">bad</a>'
    + '<a title="Welad Rizk 2 2024" href="/watch.php?vid=wrong123">wrong</a>';
  const requests = [];
  const [source] = createApprovedCatalogSources(["qfilm"], async url => {
    requests.push(url.pathname);
    return { headers: {}, html: url.pathname === "/search.php" ? hits :
      '<iframe src="https://mp4plus.org/embed-' + ref + '.html"></iframe>' };
  });
  assert.deepEqual(await source.search(catalogKey(movie), required), [ref]);
  assert.deepEqual(requests, ["/search.php", "/embed.php"]);
  assert.throws(() => createApprovedCatalogSources(["other"], () => {}), /unknown_secondary_catalog/);
});

test("parallel resolver accepts the first verified result, cancels slow work and deduplicates callers and references", async () => {
  let canceled = 0;
  let checked = 0;
  const resolver = createUniversalCatalog({
    sources: [
      { id: "slow", search: (_key, _identity, signal) => new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => { canceled++; reject(signal.reason); }, { once: true })) },
      { id: "first", search: async () => [ref] },
      { id: "same", search: async () => [ref] },
    ],
    database: openSecondaryCache(":memory:"), readIdentity: async () => required,
    verify: async id => { checked++; return candidate(id); },
  });
  try {
    const tasks = [resolver.resolve(movie), resolver.resolve(movie)];
    assert.equal(tasks[0], tasks[1]);
    await Promise.all(tasks);
    assert.deepEqual([canceled, checked], [1, 1]);
  } finally { resolver.close(); }
});

test("SQLite mappings survive restart, hold stable references only, and expire after 12 hours", async t => {
  const dir = await mkdtemp(join(tmpdir(), "horizon-secondary-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "test.sqlite");
  let now = 100;
  let queries = 0;
  let reads = 0;
  let fail = false;
  const setup = () => {
    const database = openSecondaryCache(path);
    const resolver = createUniversalCatalog({
      sources: [{ id: "one", search: async () => { queries++; return [ref]; } }],
      database, now: () => now, readIdentity: async () => { reads++; return required; },
      verify: async (id, stable, identity) => {
        assert.equal(identity.runtime, 120);
        if (fail) throw new Error("mp4plus_no_verified_media");
        return candidate(id, stable);
      },
    });
    return { database, resolver };
  };
  let { database, resolver } = setup();
  await resolver.resolve(movie);
  const saved = database.prepare("SELECT reference,runtime,expires FROM horizon_secondary").get();
  assert.deepEqual({ ...saved }, { reference: ref, runtime: 120, expires: now + 43_200_000 });
  resolver.close();
  ({ resolver } = setup());
  try {
    await resolver.resolve(movie);
    assert.deepEqual([queries, reads], [1, 1]);
    now += 43_200_001;
    await resolver.resolve(movie);
    assert.deepEqual([queries, reads], [2, 2]);
    fail = true;
    await assert.rejects(resolver.resolve(movie), /unavailable/);
    await assert.rejects(resolver.resolve(movie), /catalog_miss/);
  } finally { resolver.close(); }
});

test("definitive misses are cached for 60 seconds; outages leave discovery retryable", async () => {
  let calls = 0;
  let fail = true;
  let now = 20;
  const resolver = createUniversalCatalog({
    sources: [{ id: "one", search: async () => { calls++; if (fail) throw new Error("network"); return [ref, "example000002"]; } }],
    database: openSecondaryCache(":memory:"), readIdentity: async () => required, now: () => now,
    verify: async () => assert.fail("ambiguous results must not reach media verification"),
  });
  try {
    await assert.rejects(resolver.resolve(movie), /unavailable/);
    fail = false;
    await assert.rejects(resolver.resolve(movie), /unavailable/);
    await assert.rejects(resolver.resolve(movie), /catalog_miss/);
    assert.equal(calls, 2);
    now += 60001;
    await assert.rejects(resolver.resolve(movie), /unavailable/);
    assert.equal(calls, 3);
  } finally { resolver.close(); }
});

test("only transient errors are retried, repeated upstream failures cool down, and status 403 is never retried", async () => {
  let status = 503;
  let calls = 0;
  let now = 100;
  const get = createCatalogTransport({ now: () => now, request: async () => { calls++; return { status }; } });
  const url = new URL("https://one.example/");
  await assert.rejects(get(url), { status: 503 });
  await assert.rejects(get(url), { status: 503 });
  await assert.rejects(get(url), /cooldown/);
  assert.equal(calls, 6);
  now += 30001;
  status = 403;
  await assert.rejects(get(url), { status: 403 });
  assert.equal(calls, 7);
  status = 200;
  assert.equal((await get(url)).status, 200);
});

function box(name, ...data) {
  const body = Buffer.concat(data);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length);
  header.write(name, 4, "ascii");
  return Buffer.concat([header, body]);
}
function mp4Prefix(duration, height, audioType = 0x40) {
  const mvhd = Buffer.alloc(20);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(duration * 1000, 16);
  const visual = Buffer.alloc(78);
  visual.writeUInt16BE(height, 26);
  const es = Buffer.from([3, 22, 0, 1, 0, 4, 17, audioType, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 2, 0x12, 0x10]);
  const video = box("avc1", visual, box("avcC", Buffer.from([1, 100, 0, 40, 255, 225, 0])));
  const audio = box("mp4a", Buffer.alloc(28), box("esds", Buffer.alloc(4), es));
  const track = entry => box("trak", box("mdia", box("minf", box("stbl", box("stsd", Buffer.alloc(8), entry)))));
  const header = Buffer.concat([box("ftyp", Buffer.alloc(12)), box("moov", box("mvhd", mvhd), track(video), track(audio))]);
  return Buffer.concat([header, Buffer.alloc(131072 - header.length)]);
}

test("verifies codecs, duration and both ranges, ranks compatible sources, and pins URL renewal to the same representation", async () => {
  let token = "original";
  let badRange = false;
  let blocked = false;
  const requestHosts = [];
  const verify = createMp4PlusDelivery(async (url, options) => {
    requestHosts.push(url.hostname);
    if (url.hostname === "mp4plus.org") return { html: [
      'file: "https://unapproved.example/path/v.mp4", label: "1080p"',
      'file: "https://decoy.cdnz.quest/path/v.mp4", label: "720p"',
      'file: "https://a.cdnz.quest/' + token + '/v.mp4", label: "480p"',
      'file: "https://b.cdnz.quest/' + token + '/v.mp4", label: "320p"',
    ].join(",") };
    const [, first, last] = /bytes=(\d+)-(\d+)/.exec(options.range).map(Number);
    const fake = url.hostname === "decoy.cdnz.quest";
    const total = 40_000_000;
    const bytes = first ? Buffer.alloc(12) : mp4Prefix(fake ? 90 : 7200, fake ? 720 : url.hostname === "a.cdnz.quest" ? 480 : 320);
    assert.equal(bytes.length, options.maxBytes);
    if (blocked) throw Object.assign(new Error("upstream_status"), { status: 403 });
    return { status: 206, bytes, headers: { "content-type": "video/mp4",
      "content-range": "bytes " + first + "-" + last + "/" + (badRange && first ? total + 1 : total) } };
  });
  assert.equal(inspectMp4Header(mp4Prefix(7200, 480, 0x69)), null);
  const backend = createMp4PlusProvider({ resolve: id => verify(id, ref, required, new AbortController().signal) });
  const before = await backend.getPlaybackSource(movie);
  assert.deepEqual(before.sources.map(source => source.key.split(":")[0]), ["480p", "320p"]);
  token = "rotated";
  const after = await backend.getPlaybackSource(movie, { force: true });
  assert.deepEqual(before.sources.map(s => s.key), after.sources.map(s => s.key));
  assert.notEqual(before.sources[0].url, after.sources[0].url);
  assert.ok(!requestHosts.includes("unapproved.example"));
  badRange = true;
  await assert.rejects(backend.getPlaybackSource(movie), /mp4plus_no_verified_media/);
  blocked = true;
  await assert.rejects(backend.getPlaybackSource(movie), { status: 403 });
});
