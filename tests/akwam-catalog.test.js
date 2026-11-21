import test from "node:test";
import assert from "node:assert/strict";
import { rootCertificates } from "node:tls";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCatalog, publicLookup } from "../oracle-relay/catalog.mjs";
import { createHardenedRelay } from "../oracle-relay/relay-service.mjs";

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
    const other = id === movie ? episode : movie;
    const denied = await call("/relay?id=" + other + "&ticket=" + encodeURIComponent(value.ticket));
    assert.equal(denied.status, 403);
  }
  assert.equal((await call("/ticket?id=tv-297621-s2-e3", { headers, method: "POST" })).status,404);
});
