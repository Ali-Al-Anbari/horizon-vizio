import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import https from "node:https";
import { Readable, Writable } from "node:stream";
import { rootCertificates } from "node:tls";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCatalog, mediaSignature, publicLookup } from "../oracle-relay/catalog.mjs";
import { createHardenedRelay, signPlaybackTicket, validMediaRange } from "../oracle-relay/relay-service.mjs";

const roots = {
  "tv-297621-s2": "/series/20/series",
  "movie-1316421": "/movie/13/movie",
};
const episode = "tv-297621-s2-e30";
const movie = "movie-1316421";
const media = "https://s1d1.downet.net/video.mp4";
const link = url => '<a href="' + url + '">Watch</a>';
function fixture() {
  const pages = new Map([
    ["/series/20/series", link("/episode/30/series/الحلقة-30") + link("/episode/31/series/الحلقة-31")],
    ["/episode/30/series/الحلقة-30", link("/watch/300/30/series/الحلقة-30") + link("/watch/301/31/series/الحلقة-30")],
    ["/movie/13/movie", link("/watch/130/13/movie") + link("/watch/140/14/movie")],
    ["/watch/300/30/series/الحلقة-30", '<source src="' + media + '">'],
    ["/watch/130/13/movie", '<source src="' + media + '">'],
  ]);
  const calls = [];
  const request = async (url, options) => {
    const path = decodeURIComponent(url.pathname);
    calls.push([url.hostname,path,options.range]);
    if (options.range) {
      assert.equal(options.range, "bytes=0-11");
      return { status: 206, headers: { "content-range": "bytes 0-11/100", "content-type": "application/octet-stream" },
        bytes: Buffer.from("000000186674797069736F6D", "hex") };
    }
    const html = pages.get(path);
    return { status: html ? 200 : 404, headers: { "content-type": "text/html" }, html };
  };
  return { roots, pages, request, calls };
}

test("catalog resolves exact movies and late episodes, deduplicates, and refuses season and identity guesses", async () => {
  const data = fixture();
  const catalog = createCatalog(data);
  assert.deepEqual(await Promise.all([catalog.resolve(episode),catalog.resolve(episode)]), [media,media]);
  assert.equal(await catalog.resolve(movie), media);
  assert.equal(data.calls.filter(([,path]) => path === "/watch/300/30/series/الحلقة-30").length, 1);
  assert.ok(!data.calls.some(([,path]) => path.startsWith("/watch/301/") || path.startsWith("/watch/140/")));
  await assert.rejects(catalog.resolve("tv-297621-s1-e30"), /metadata_unverified/);
  await assert.rejects(catalog.resolve("tv-297621-s2-e3"), /episode_missing/);
  data.pages.set("/series/20/series", link("/episode/30/series/الحلقة-30") + link("/episode/35/series/الحلقة-30"));
  await assert.rejects(createCatalog(data).resolve(episode), /ambiguous_episode/);
});

test("catalog discovers a numbered season by trusted aliases and year, then rejects ambiguous or wrong editions", async () => {
  const data = fixture();
  const root = "/series/4/المداح-ج4-أسطورة-العودة";
  const wrong = "/series/6/المداح-ج6-أسطورة-النهاية";
  const duplicate = "/series/5/المداح-ج4-أسطورة-العودة";
  data.pages.set("/search",link(wrong) + link(root) + link(duplicate));
  const heading = (year) => "<h1>المداح ج4: أسطورة العودة</h1><span> السنة : " + year + "</span>";
  data.pages.set(root, heading(2024) + link("/episode/41/المداح-ج4-أسطورة-العودة/الحلقة-1"));
  data.pages.set(wrong, "<h1>المداح ج6: أسطورة النهاية</h1><span>السنة : 2026</span>");
  data.pages.set(duplicate, heading(2025));
  data.pages.set("/episode/41/المداح-ج4-أسطورة-العودة/الحلقة-1",
    link("/watch/400/41/المداح-ج4-أسطورة-العودة/الحلقة-1"));
  data.pages.set("/watch/400/41/المداح-ج4-أسطورة-العودة/الحلقة-1", '<source src="' + media + '">');
  const options = { ...data, roots: {}, getIdentity: async key => ({
    aliases: ["المداح", "Al Maddah"], year: "2024", season: key.season, seasonTitle: "أسطورة العودة",
    episodes: [1],
  }) };
  const catalog = createCatalog(options);
  assert.equal(await catalog.resolve("tv-122543-s4-e1"), media);
  assert.ok(!data.calls.some(([,path]) => path === wrong));
  await assert.rejects(catalog.resolve("tv-122543-s4-e30"), /metadata_episode_missing/);
  data.pages.set(duplicate, heading(2024));
  await assert.rejects(createCatalog(options).resolve("tv-122543-s4-e1"), /ambiguous_title/);
});

test("catalog distinguishes same-title films by exact release year and does not play mislabeled MKV", async () => {
  const data = fixture();
  data.pages.set("/search", link("/movie/13/الست") + link("/movie/14/الست-2"));
  data.pages.set("/movie/13/الست", "<h1>الست</h1><span>السنة : 2025</span>" + link("/watch/130/13/الست"));
  data.pages.set("/movie/14/الست-2", "<h1>الست</h1><span>السنة : 2020</span>" + link("/watch/140/14/الست"));
  data.pages.set("/watch/130/13/الست", '<source type="video/mp4" src="https://s1d1.downet.net/movie.mkv">');
  const options = { ...data, roots: {}, getIdentity: async () => ({ aliases: ["الست", "El Sett"], year: "2025" }),
    request: async (url, options) => options.range
      ? { status: 206, headers: { "content-range": "bytes 0-11/100", "content-type": "application/octet-stream" },
        bytes: Buffer.from("1a45dfa30102030405060708", "hex") } : data.request(url,options) };
  const probes = [];
  await assert.rejects(createCatalog(options).resolve(movie, { onProbe: p => probes.push(p) }), /range_mp4_unverified/);
  assert.equal(probes[0]?.ebmlHeader, true);
  assert.ok(!data.calls.some(([,path]) => path.startsWith("/watch/140/")));
});

test("season-number variants and localized episode labels still require the exact season and source ID", async () => {
  const data = fixture();
  const season = "/series/50/كامل-العدد-3";
  const wrong = "/series/51/كامل-العدد-2";
  const target = "/episode/63/كامل-العدد-3/الحلقه-۱۵";
  const watch = "/watch/777/63/كامل-العدد-3/الحلقة-١٥";
  data.pages.set("/search", link(wrong) + link(season));
  data.pages.set(season, "<h1><span>كَامِل العدد ٣</span></h1><span>السنة : ۲۰۲۵</span>" + link(target));
  data.pages.set(target, link(watch) + link("/watch/778/63/كامل-العدد-3/الحلقة-١٤")
    + link("/watch/779/64/كامل-العدد-3/الحلقة-١٥"));
  data.pages.set(watch, '<source src="' + media + '">');
  const catalog = createCatalog({ ...data, roots: {}, getIdentity: async () => ({
    aliases: ["كامل العدد", "Kamel El Adad"], seasonTitle: "+ + كامل العدد", season: 3, year: "2025", episodes: [15],
  }) });
  assert.equal(await catalog.resolve("tv-218324-s3-e15"), media);
  assert.deepEqual(data.calls.filter(([,path]) => path.startsWith("/watch/")).map(([,path]) => path), [watch]);
});

test("type-only fallback revalidates a cached miss and keeps release-year checks", async () => {
  const data = fixture();
  const root = "/movie/13/العنوان";
  const watch = "/watch/130/13/العنوان";
  let now = 0;
  let searchCount = 0;
  const request = (url, options) => {
    if (url.pathname !== "/search") return data.request(url, options);
    searchCount++;
    const found = now >= 45_000 && url.searchParams.get("section") === "movie" && !url.searchParams.has("year");
    return Promise.resolve({ status: 200, headers: { "content-type": "text/html" }, html: found ? link(root) : "<p>Empty</p>" });
  };
  data.pages.set(root, "<h1>العنوان</h1><span>السنة : 2025</span>" + link(watch));
  data.pages.set(watch, '<source src="' + media + '">');
  const catalog = createCatalog({ ...data, request, now: () => now, roots: {},
    getIdentity: async () => ({ aliases: ["العنوان", "The Title"], year: "2025" }) });
  await assert.rejects(catalog.resolve(movie), /title_not_found/);
  const before = searchCount;
  await assert.rejects(catalog.resolve(movie), /title_not_found/);
  assert.equal(searchCount, before);
  now = 45_001;
  assert.equal(await catalog.resolve(movie), media);
});

test("a missing episode does not poison a verified season and stale episode HTML is reread", async () => {
  const data = fixture();
  let now = 0;
  data.pages.set("/series/20/series", "<h1>Series 2</h1><span>السنة : 2025</span>");
  data.pages.set("/search", link("/series/20/series-2"));
  const request = (url, options) => decodeURIComponent(url.pathname) === "/series/20/series-2"
    ? data.request(new URL("/series/20/series", url), options) : data.request(url, options);
  const catalog = createCatalog({ ...data, request, roots: {}, now: () => now,
    getIdentity: async () => ({ aliases: ["Series"], season: 2, year: "2025", episodes: [30] }) });
  await assert.rejects(catalog.resolve("tv-297621-s2-e99"), /metadata_episode_missing/);
  await assert.rejects(catalog.resolve(episode), /episode_missing/);
  data.pages.set("/series/20/series", data.pages.get("/series/20/series") + link("/episode/30/series-2/الحلقة-30"));
  data.pages.set("/episode/30/series-2/الحلقة-30", link("/watch/300/30/series-2/الحلقة-30"));
  data.pages.set("/watch/300/30/series-2/الحلقة-30", '<source src="' + media + '">');
  await assert.rejects(catalog.resolve(episode), /episode_missing/);
  now = 45_001;
  assert.equal(await catalog.resolve(episode), media);
});

test("short episode links require the season label, exact episode heading and matching watch ID", async () => {
  const data = fixture();
  const root = "/series/325/الإختيار-4";
  const watch = "/watch/13187/4528";
  data.pages.set("/search", link(root));
  data.pages.set(root, "<h1>الإختيار</h1><span>السنة : 2020</span>" +
    '<a href="/episode/4528">حلقة 1 : مسلسل الإختيار</a>' +
    '<a href="/episode/4631">حلقة 3 : مسلسل الإختيار</a>' +
    '<a href="/episode/9999">حلقة 1 : مسلسل آخر</a>');
  data.pages.set("/episode/4528", "<h1>الإختيار \n الحلقة 1</h1>" + link(watch) + link("/watch/13186/4631"));
  data.pages.set(watch, '<source src="' + media + '">');
  const options = { ...data, roots: {},
    getIdentity: async () => ({ aliases: ["الاختيار"], season: 1, year: "2020", episodes: [1, 3] }) };
  assert.equal(await createCatalog(options).resolve("tv-102045-s1-e1"), media);
  assert.deepEqual(data.calls.filter(([,path]) => path.startsWith("/watch/")).map(([,path]) => path), [watch]);
  data.pages.set("/episode/4528", "<h1>الإختيار الحلقة 2</h1>" + link(watch));
  await assert.rejects(createCatalog(options).resolve("tv-102045-s1-e1"), /episode_identity_mismatch/);
});

test("format probes identify Matroska, WebM and HLS from bytes and stay separate from MP4 playback", async () => {
  assert.equal(mediaSignature(Buffer.from("1a45dfa38b4282886d6174726f736b61", "hex")), "matroska");
  assert.equal(mediaSignature(Buffer.from("1a45dfa3874282847765626d", "hex")), "webm");
  assert.equal(mediaSignature(Buffer.from("#EXTM3U\n#EXT-X-VERSION:3\n")), "hls");
  assert.equal(mediaSignature(Buffer.from("<html>\n#EXTM3U\n#EXT-X-VERSION:3\n")), "unknown");
  assert.equal(mediaSignature(Buffer.from("#EXTM3U\n#EXTINF:90,Title\n")), "unknown");

  const data = fixture();
  data.pages.set("/watch/130/13/movie", '<source src="https://s1d1.downet.net/a.mkv">');
  const probes = [];
  const request = (url, options) => {
    if (!options.range) return data.request(url, options);
    assert.equal(options.range, "bytes=0-511");
    const bytes = Buffer.from("1a45dfa38b4282886d6174726f736b61", "hex");
    return { status: 206, headers: { "content-range": "bytes 0-15/16", "content-type": "video/mp4" }, bytes };
  };
  await assert.rejects(createCatalog({ ...data, request, probeFormats: true }).resolve(movie,
    { onProbe: probe => probes.push(probe) }), /range_mp4_unverified/);
  assert.equal(probes[0].format, "matroska");
  assert.equal(probes[0].rangeValid, true);

  data.pages.set("/watch/130/13/movie", '<source src="https://s1d1.downet.net/asset.bin">');
  assert.equal(await createCatalog(data).resolve(movie), "https://s1d1.downet.net/asset.bin");
});

test("catalog refuses untrusted media and private or special-use IPs", async () => {
  const data = fixture();
  data.pages.set("/watch/130/13/movie", '<source src="https://offsite.example/test.mp4">');
  await assert.rejects(createCatalog(data).resolve(movie), /disallowed_url/);
  assert.ok(!data.calls.some(([host]) => host === "offsite.example"));
  for (const ip of ["127.0.0.1", "169.254.169.254", "192.0.2.1", "100.64.0.1"]) {
    await assert.rejects(new Promise((resolve, reject) => {
      publicLookup(ip, {}, error => error ? reject(error) : resolve());
    }), /non_public_dns/);
  }
});

test("movie ranking accepts one-year drift, outranks a weaker title, and refuses close ties", async () => {
  const data = fixture();
  const strong = "/movie/13/الحريفة-2";
  const weaker = "/movie/14/الحريفه-2";
  const sequel = "/movie/15/الحريفة-3";
  const watch = "/watch/130/13/الحريفة-2";
  data.pages.set("/search", link(strong) + link(weaker) + link(sequel));
  data.pages.set(strong, "<h1>الحريفة ٢</h1><span>السنة : 2025</span>" + link(watch));
  data.pages.set(weaker, "<h1>الحريفه 2</h1><span>السنة : 2024</span>");
  data.pages.set(sequel, "<h1>الحريفة 3</h1><span>السنة : 2024</span>");
  data.pages.set(watch, '<source src="' + media + '">');
  const options = { ...data, roots: {}, getIdentity: async () => ({ aliases: ["الحريفة 2"], year: "2024" }) };
  assert.equal(await createCatalog(options).resolve(movie), media);
  assert.ok(!data.calls.some(([,path]) => path === sequel));
  data.pages.set(weaker, "<h1>الحريفة 2</h1><span>السنة : 2024</span>");
  await assert.rejects(createCatalog(options).resolve(movie), /ambiguous_title/,
    "one point of separation is insufficient");
});

test("missing and two-year movie dates require corroboration and regional dates can supply exact evidence", async () => {
  const data = fixture();
  const root = "/movie/13/فيلم-مميز";
  const watch = "/watch/130/13/فيلم-مميز";
  data.pages.set("/search", link(root));
  data.pages.set(watch, '<source src="' + media + '">');
  const evidence = "<span>إخراج : أحمد حسن</span><span>المدة : 94 دقيقة</span>";
  const setPage = metadata => data.pages.set(root, "<h1>فيلم مميز</h1>" + metadata + link(watch));
  const run = metadata => createCatalog({ ...data, roots: {}, getIdentity: async () => ({
    aliases: ["فيلم مميز"], ...metadata,
  }) }).resolve(movie);
  setPage("<span>السنة : 2026</span>");
  await assert.rejects(run({ year: "2024" }), /title_identity_mismatch/);
  assert.equal(await run({ year: "2024", releaseYears: ["2026"] }), media);
  setPage("<span>السنة : 2026</span>" + evidence);
  assert.equal(await run({ year: "2024", directors: ["أحمد حسن"], runtime: 94 }), media);
  setPage(evidence);
  await assert.rejects(run({}), /title_identity_mismatch/);
  assert.equal(await run({ directors: ["أحمد حسن"], runtime: 94 }), media);
});

test("movie source discovery accepts an MP4 prefix on HTTP 200, rejects HTML, and ranks valid 206 first", async () => {
  const data = fixture();
  const bestEffort = "https://s1d1.downet.net/candidate.mp4";
  const html = "https://s1d1.downet.net/html.mp4";
  data.pages.set("/watch/130/13/movie", [bestEffort, html, media].map(src => '<source src="' + src + '">').join(""));
  const request = async (url, options) => {
    if (!options.range || ![bestEffort, html].includes(url.href)) return data.request(url, options);
    assert.equal(options.allowPrefix, true);
    return { status: 200, headers: { "content-type": "application/octet-stream" },
      bytes: url.href === html ? Buffer.from("<html>denied") : Buffer.from("000000186674797069736F6D", "hex") };
  };
  const sources = await createCatalog({ ...data, request }).resolveSources(movie);
  assert.equal(sources.work, "13");
  assert.deepEqual(sources.sources.map(({url, verified}) => [url, verified]), [[media, true], [bestEffort, false]]);
  data.pages.set("/watch/130/13/movie", '<source src="' + html + '">');
  await assert.rejects(createCatalog({ ...data, request }).resolveSources(movie), /range_mp4_unverified/);
});

test("relay validates upstream Range, including tail metadata seeks and end-of-file requests", () => {
  assert.equal(validMediaRange("bytes=944-", { "content-range": "bytes 944-1023/1024", "content-length": "80" }), true);
  assert.equal(validMediaRange("bytes=-80", { "content-range": "bytes 944-1023/1024", "content-length": "80" }), true);
  assert.equal(validMediaRange("bytes=960-2048", { "content-range": "bytes 960-1023/1024" }), true);
  assert.equal(validMediaRange("bytes=945-", { "content-range": "bytes 944-1023/1024" }), false);
  assert.equal(validMediaRange("bytes=944-", { "content-range": "bytes 944-1023/1024", "content-length": "81" }), false);
});

test("Oracle verifies dynamic catalog entries before minting and scopes tickets to one movie or episode", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "akwam-test-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const caBundlePath = join(tmp, "test-ca.pem");
  await writeFile(caBundlePath, rootCertificates[0]);
  const issuerSecret = "test-issuer-secret-placeholder-0000001";
  const { server } = createHardenedRelay({ caBundlePath, issuerSecret, ticketSigningSecret: "s".repeat(40),
    akwamProxyPermitted: true, catalog: fixture() });
  t.after(() => server.emit("close"));
  function call(url, { method = "GET", headers = {} } = {}) {
    return new Promise((resolve,reject) => {
      const req = { url, method, headers, socket: { remoteAddress: "127.0.0.1" } };
      let status;
      const res = {
        writeHead(code) { status = code; this.headersSent = true; },
        end(body) { resolve(new Response(body, { status })); },
      };
      server.listeners("request")[0](req,res).catch(reject);
    });
  }
  const headers = { authorization: "Bearer " + issuerSecret };
  assert.equal((await call("/catalog?id=" + movie)).status, 401);
  const found = await call("/catalog?id=" + movie, { headers });
  assert.deepEqual(await found.json(), { available: true, episodeId: movie });
  for (const id of [movie, episode, "fakhr-el-delta-s01e01"]) {
    const action = await call("/ticket?id=" + id, { headers, method: "POST" });
    assert.equal(action.status,200);
    const value = await action.json();
    assert.equal(value.episodeId,id);
    if (id === movie) {
      const disputed = signPlaybackTicket({ ep: movie, exp: Date.now() / 1000 + 60,
        work: "99", sources: ["130:0"] }, "s".repeat(40));
      const rejected = await call("/relay?id=" + movie + "&ticket=" + encodeURIComponent(disputed));
      assert.equal(rejected.status, 404);
      const alternate = await call("/relay?id=" + movie + "&variant=1&ticket=" + encodeURIComponent(value.ticket));
      assert.equal(alternate.status, 404, "a single-source ticket cannot add an alternate later");
    }
    const other = id === movie ? episode : movie;
    const denied = await call("/relay?id=" + other + "&ticket=" + encodeURIComponent(value.ticket));
    assert.equal(denied.status, 403);
  }
  assert.equal((await call("/ticket?id=tv-297621-s2-e3", { headers, method: "POST" })).status,404);
});

test("Oracle refreshes one expired rendition and preserves the signed work and requested bytes", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "akwam-refresh-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const caBundlePath = join(tmp, "test-ca.pem");
  await writeFile(caBundlePath, rootCertificates[0]);
  const ticketSigningSecret = "x".repeat(36);
  const data = fixture();
  const fresh = "https://s1d1.downet.net/refreshed.mp4";
  const originalBytes = Buffer.from("000000186674797069736F6D", "hex");
  const mediaRequests = [];
  t.mock.method(https, "request", (url, { headers }, callback) => {
    const stale = mediaRequests.length === 0;
    mediaRequests.push({ url: url.href, range: headers.Range });
    if (stale) data.pages.set("/watch/130/13/movie", '<source src="' + fresh + '">');
    const req = new EventEmitter();
    req.end = () => {
      const res = Readable.from(stale ? [] : [originalBytes], { objectMode: false });
      res.statusCode = stale ? 410 : 206;
      res.headers = stale ? {} : { "content-range": "bytes 0-11/100", "content-type": "video/mp4", "content-length": "12" };
      queueMicrotask(() => callback(res));
    };
    req.destroy = () => {};
    return req;
  });
  const { server, stats } = createHardenedRelay({ caBundlePath, issuerSecret: "fixture-issuer", ticketSigningSecret,
    akwamProxyPermitted: true, catalog: data });
  t.after(() => server.emit("close"));
  const ticket = signPlaybackTicket({ ep: movie, exp: Date.now() / 1000 + 60, work: "13", sources: ["130:0"] }, ticketSigningSecret);
  const req = Object.assign(new EventEmitter(), {
    url: "/relay?id=" + movie + "&ticket=" + encodeURIComponent(ticket), method: "GET",
    headers: { range: "bytes=0-11" }, socket: { remoteAddress: "127.0.0.1" },
  });
  const observed = await new Promise((resolve, reject) => {
    const chunks = [];
    const res = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk); callback(); } });
    res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers; res.headersSent = true; };
    res.on("error", reject);
    res.on("finish", () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    server.listeners("request")[0](req, res).catch(reject);
  });
  assert.deepEqual(mediaRequests, [{ url: media, range: "bytes=0-11" }, { url: fresh, range: "bytes=0-11" }]);
  assert.equal(observed.status, 206);
  assert.equal(observed.headers["content-range"], "bytes 0-11/100");
  assert.deepEqual(observed.bytes, originalBytes);
  assert.equal(stats.expiredAutoRetries, 1);
});
