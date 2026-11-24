import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import https from "node:https";
import { rootCertificates } from "node:tls";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMySeedProvider } from "../oracle-relay/myseed-provider.mjs";
import { createHardenedRelay, signPlaybackTicket, verifyPlaybackTicket } from "../oracle-relay/relay-service.mjs";

const primary = "movie-1316421";
const fallback = "movie-1316416";
const episode = "tv-304229-s1-e1";
const host = "media.myseed.example";
const issuer = "local-fixture-issuer";
const secret = "fixture-signing-key".repeat(3);
const prefix = Buffer.from("000000186674797069736f6d", "hex");
const rangeHeaders = {
  "content-range": "bytes 0-11/100", "content-type": "video/mp4", "content-length": "12",
};
const probe = { status: 206, headers: rangeHeaders, bytes: prefix };
const descriptor = (assetId, overrides) => ({
  assetId, workId: "sample-work", renditionId: "sample-rendition", format: "mp4",
  url: "https://" + host + "/original.mp4", expiresAtMs: Date.now() + 300_000, ...overrides,
});

test("MySeed requires permission, exact identity, an approved host, expiry and verified MP4 Range", async () => {
  let calls = 0;
  let value = descriptor(episode);
  let response = probe;
  const options = {
    enabled: true, relayPermitted: true, hosts: [host],
    loadDescriptor: async () => value,
    request: async (_url, { range }) => {
      calls++;
      assert.equal(range, "bytes=0-11");
      return response;
    },
  };
  await assert.rejects(createMySeedProvider({ ...options, relayPermitted: false }).getPlaybackSource(episode),
    /provider_unavailable/);
  await assert.rejects(createMySeedProvider({ ...options, enabled: false, hosts: ["*.example"] }).getPlaybackSource(episode),
    /provider_unavailable/);
  const provider = createMySeedProvider(options);
  for (const [invalid, error] of [
    [{ assetId: "tv-304229-s1-e2" }, /asset_unavailable/],
    [{ format: "hls" }, /invalid_or_expired/],
    [{ expiresAtMs: Date.now() - 1000 }, /invalid_or_expired/],
    [{ url: "https://" + host + ".other.example/video.mp4" }, /disallowed_url/],
    [{ url: "https://127.0.0.1/video.mp4" }, /disallowed_url/],
  ]) {
    value = descriptor(episode, invalid);
    await assert.rejects(provider.getPlaybackSource(episode), error);
  }
  assert.equal(calls, 0);
  value = descriptor(episode);
  response = { ...probe, headers: { ...rangeHeaders, "content-encoding": "gzip" } };
  await assert.rejects(provider.getPlaybackSource(episode), /mp4_unverified/);
  response = probe;
  assert.equal((await provider.getPlaybackSource(episode)).work, "myseed:" + value.workId);
  delete value.expiresAtMs;
  assert.equal((await provider.getPlaybackSource(episode)).sources[0].expiresAtMs, undefined);
});

test("relay keeps Akwam primary and pins fallback, renewal, range and request policy to the signed identity", async t => {
  const directory = await mkdtemp(join(tmpdir(), "horizon-myseed-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const caBundlePath = join(directory, "ca.pem");
  await writeFile(caBundlePath, rootCertificates[0]);

  let loadCalls = 0;
  let nextDescriptor = descriptor(fallback);
  let upstreamStatus = 410;
  const mediaCalls = [];
  const serverHeaders = { ...rangeHeaders, "content-range": "bytes 12-23/100" };
  t.mock.method(https, "request", (url, options, callback) => {
    assert.equal(url.hostname, host);
    assert.equal(options.agent.options.rejectUnauthorized, true);
    assert.equal(typeof options.lookup, "function");
    assert.deepEqual(options.headers, {
      "User-Agent": "Horizon Watch", Accept: "video/mp4", "Accept-Encoding": "identity", Range: "bytes=12-23",
    });
    mediaCalls.push(url.pathname);
    const status = upstreamStatus;
    if (status === 410) {
      nextDescriptor = descriptor(fallback, { url: "https://" + host + "/renewed.mp4" });
      upstreamStatus = 206;
    }
    const req = new EventEmitter();
    req.end = () => {
      const res = Readable.from(status === 206 ? [prefix] : [], { objectMode: false });
      res.statusCode = status;
      res.headers = status === 206 ? serverHeaders : { location: "https://unapproved.example" };
      queueMicrotask(() => callback(res));
    };
    req.destroy = () => {};
    return req;
  });
  const { server, stats } = createHardenedRelay({
    caBundlePath, issuerSecret: issuer, ticketSigningSecret: secret, akwamProxyPermitted: true,
    allowlist: {}, maxTicketRefreshes: 1,
    catalog: {
      roots: { [primary]: "/movie/13/movie" }, getIdentity: async () => null,
      request: async (url, { range }) => range ? probe : {
        status: 200, headers: { "content-type": "text/html" },
        html: url.pathname.startsWith("/watch/")
          ? '<source src="https://s1d1.downet.net/original.mp4">' : '<a href="/watch/130/13/movie">Watch</a>',
      },
    },
    myseed: {
      enabled: true, relayPermitted: true, hosts: [host],
      loadDescriptor: async () => { loadCalls++; return nextDescriptor; },
      request: async () => probe,
    },
  });
  t.after(() => server.emit("close"));
  const call = (path, params, { method = "GET", headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = Object.assign(new EventEmitter(), {
      url: path + "?" + new URLSearchParams(params), method, headers, socket: { remoteAddress: "127.0.0.1" },
    });
    const chunks = [];
    const res = new Writable({ write(chunk, _encoding, next) { chunks.push(chunk); next(); } });
    res.writeHead = (status, values) => { res.status = status; res.headers = values; res.headersSent = true; };
    res.once("finish", () => resolve({ status: res.status, headers: res.headers, body: Buffer.concat(chunks) }));
    res.once("error", reject);
    server.listeners("request")[0](req, res).catch(reject);
  });
  const issue = (id, prev) => call("/ticket", { id, ...(prev ? { prev } : {}) },
    { method: "POST", headers: { authorization: "Bearer " + issuer } });
  const stream = (id, ticket) => call("/relay", { id, ticket, refresh: "1" },
    { headers: { range: "bytes=12-23", authorization: "client-value", cookie: "client=value", referer: "https://other.example/" } });
  const issueToken = async id => {
    const response = await issue(id);
    assert.equal(response.status, 200);
    return JSON.parse(response.body).ticket;
  };

  const primaryTicket = await issueToken(primary);
  assert.equal(verifyPlaybackTicket(primaryTicket, secret, primary).payload.provider, "akwam");
  assert.equal(loadCalls, 0);
  const unsigned = await call("/relay", { id: fallback });
  assert.equal(unsigned.status, 401);
  const ticket = await issueToken(fallback);
  const { payload } = verifyPlaybackTicket(ticket, secret, fallback);
  assert.deepEqual([payload.provider, payload.ep, payload.work, payload.sources, payload.refreshLimit, payload.recovery],
    ["myseed", fallback, "myseed:sample-work", ["sample-rendition"], 1, 1]);
  assert.equal(payload.mediaExpiresAt, nextDescriptor.expiresAtMs);
  assert.equal((await stream(primary, ticket)).status, 403);
  assert.equal((await stream(fallback, signPlaybackTicket({ ...payload, provider: "foreign" }, secret))).status, 403);
  assert.deepEqual(mediaCalls, []);
  const delivered = await stream(fallback, ticket);
  assert.equal(delivered.status, 206);
  assert.equal(delivered.headers["content-range"], "bytes 12-23/100");
  assert.deepEqual(delivered.body, prefix);
  assert.deepEqual(mediaCalls, ["/original.mp4", "/renewed.mp4"]);
  assert.equal(stats.expiredAutoRetries, 1);

  upstreamStatus = 302;
  assert.equal((await stream(fallback, ticket)).status, 502);
  assert.equal(mediaCalls.length, 3);
  const renewed = await issue(fallback, ticket);
  assert.equal(renewed.status, 200);
  const renewedTicket = JSON.parse(renewed.body).ticket;
  assert.equal(verifyPlaybackTicket(renewedTicket, secret, fallback).payload.provider, "myseed");
  assert.equal((await issue(fallback, renewedTicket)).status, 403);
  const dispute = signPlaybackTicket({ ...payload, sources: ["unknown-rendition"] }, secret);
  assert.equal((await stream(fallback, dispute)).status, 404);
  assert.equal((await issue(fallback, dispute)).status, 403);
  assert.equal(mediaCalls.length, 3);

  const afterExpiry = nextDescriptor.expiresAtMs + 1000;
  t.mock.method(Date, "now", () => afterExpiry);
  const expired = await stream(fallback, ticket);
  assert.equal(expired.status, 502);
  assert.equal(mediaCalls.length, 3);
  nextDescriptor = descriptor(fallback, { url: "https://" + host + "/rotated.mp4" });
  upstreamStatus = 206;
  assert.equal((await stream(fallback, ticket)).status, 206);
  assert.equal(mediaCalls.at(-1), "/rotated.mp4");

  nextDescriptor = descriptor(episode, { expiresAtMs: undefined });
  const noMediaExpiry = await issueToken(episode);
  const claims = verifyPlaybackTicket(noMediaExpiry, secret, episode).payload;
  assert.equal(Object.hasOwn(claims, "mediaExpiresAt"), false);
  assert.ok(claims.exp > claims.iat);
  assert.equal((await stream(episode, noMediaExpiry)).status, 206);
});
