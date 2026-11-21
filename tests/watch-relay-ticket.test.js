import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { api } from "../universal-search-worker.js";

const ORIGIN = "https://horizon-universal-search-preview.ali-al-anbari.workers.dev";
const EP = "fakhr-el-delta-s01e01";
const OLD = "old." + "a".repeat(43);
const NEXT = "new." + "b".repeat(43);
const SESSION = "3".repeat(64);
const ISSUER = "unit-test-issuer-placeholder-not-a-credential";
const cookie = "__Host-horizon_session=" + SESSION;
const RAY = "0123456789abcdef-IAD";

function request(body, headers = {}) {
  return new Request(ORIGIN + "/api/arabic/relay-ticket", {
    method: "POST", body: JSON.stringify(body),
    headers: { Origin: ORIGIN, "X-Horizon-Action": "ticket", "Content-Type": "application/json", Cookie: cookie, ...headers },
  });
}

function fixture() {
  let revoked = false;
  const env = {
    AKWAM_RELAY_ENABLED: "true", ISSUER_SECRET: ISSUER,
    LAUNCH_QUEUE: {
      idFromName: name => name,
      get: name => ({ async pairAuthenticate(hash) {
        assert.equal(name, "primary-tv");
        return !revoked && hash === createHash("sha256").update(SESSION).digest("hex") ? { deviceId: "test-device" } : null;
      } }),
    },
  };
  return { env, revoke: () => { revoked = true; } };
}

function forbiddenFetch() { assert.fail("must not reach Oracle"); }

test("Watch accepts only bounded asset IDs and exposes a same-asset catalog boolean", async t => {
  t.mock.method(console, "warn", () => {});
  const { env } = fixture();
  const path = ORIGIN + "/api/arabic/relay-catalog?id=";
  const asset = "movie-1316421";
  assert.equal((await api(new Request(path + "https://example.test"), env, { fetch: forbiddenFetch })).status, 400);
  assert.equal((await api(new Request(path + asset + "%0A"), env, { fetch: forbiddenFetch })).status, 400);
  const good = await api(new Request(path + asset), env, { fetch: async (url, init) => {
    const target = new URL(url);
    assert.equal(target.pathname, "/catalog");
    assert.equal(target.searchParams.get("id"), asset);
    assert.equal(init.redirect, "manual");
    assert.deepEqual(init.headers, { Authorization: "Bearer " + ISSUER });
    return Response.json({ available: true, episodeId: asset, url: "private" });
  } });
  assert.deepEqual(await good.json(), { available: true });
  const wrong = await api(new Request(path + asset), env, { fetch: async () =>
    Response.json({ available: true, episodeId: EP }) });
  assert.deepEqual(await wrong.json(), { available: false });
  const unauthenticated = await api(request({ episodeId: asset }, { Cookie: "" }), env, { fetch: forbiddenFetch });
  assert.equal(unauthenticated.status, 401);
  const unavailable = await api(request({ episodeId: asset }), env, { fetch: async () => new Response(null, { status: 404 }) });
  assert.equal(unavailable.status, 404);
  assert.deepEqual(await unavailable.json(), { code: "relay_asset_unavailable" });
});

test("Watch exposes only non-cacheable relay availability to an unauthenticated browser", async () => {
  const { env } = fixture();
  const url = ORIGIN + "/api/arabic/relay-availability?enabled=true";
  const fetch = forbiddenFetch;
  for (const [bindings, enabled] of [[env, true], [{ ...env, AKWAM_RELAY_ENABLED: "false" }, false],
    [{ ...env, AKWAM_RELAY_ENABLED: true }, false], [{ ...env, ISSUER_SECRET: "" }, false],
    [{ ...env, LAUNCH_QUEUE: undefined }, false]]) {
    const response = await api(new Request(url), bindings, { fetch });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
    assert.deepEqual(await response.json(), { enabled });
  }
  assert.equal((await api(new Request(url, { method: "POST" }), env, { fetch })).status, 405);
  const disabled = await api(request({ episodeId: EP }, { Cookie: "" }),
    { ...env, AKWAM_RELAY_ENABLED: "false" }, { fetch });
  assert.deepEqual(await disabled.json(), { code: "relay_unconfigured" });
  assert.equal(disabled.status, 503);
});

test("Watch requires a paired session in addition to its same-origin action header", async () => {
  const { env, revoke } = fixture();
  const fetch = forbiddenFetch;
  assert.equal((await api(request({ episodeId: EP }, { Cookie: "" }), env, { fetch })).status, 401);
  assert.equal((await api(request({ episodeId: EP }, { Cookie: "__Host-horizon_session=invalid" }), env, { fetch })).status, 401);
  assert.equal((await api(request({ episodeId: EP }, { Origin: "https://different.example" }), env, { fetch })).status, 403);
  assert.equal((await api(request({ episodeId: EP }, { "X-Horizon-Action": "pair" }), env, { fetch })).status, 403);
  revoke();
  assert.equal((await api(request({ episodeId: EP }), env, { fetch })).status, 401);
});

test("Watch rejects invalid input, an unlisted episode, and a disabled or unconfigured relay", async () => {
  const { env } = fixture();
  const fetch = forbiddenFetch;
  for (const body of [{ episodeId: EP, previousTicket: "malformed" }, { episodeId: EP, previousTicket: null },
    { episodeId: EP, url: "https://example.test" }, { episodeId: "x".repeat(3000) }, {}]) {
    assert.equal((await api(request(body), env, { fetch })).status, 400);
  }
  assert.equal((await api(request({ episodeId: "fakhr-el-delta-s01e02" }), env, { fetch })).status, 403);
  assert.equal((await api(request({ episodeId: EP }), { ...env, ISSUER_SECRET: "" }, { fetch })).status, 503);
  assert.equal((await api(request({ episodeId: EP }), { ...env, AKWAM_RELAY_ENABLED: "false" }, { fetch })).status, 503);
});

test("Watch forwards only the episode and prior ticket to the fixed issuer, returning a minimal non-cacheable descriptor", async () => {
  const { env } = fixture();
  const visited = [];
  const fetch = async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://horizon.129-213-139-127.sslip.io");
    assert.equal(url.pathname, "/ticket");
    assert.equal(url.searchParams.get("id"), EP);
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "manual");
    assert.deepEqual(init.headers, { Authorization: "Bearer " + ISSUER });
    visited.push(url.searchParams.get("prev"));
    return Response.json({ ok: true, episodeId: EP, ticket: NEXT, ttlSeconds: 1800,
      expiresAt: "2030-01-01T00:00:00.000Z", refreshesRemaining: 2, relayPath: "/private", secret: ISSUER });
  };
  for (const previousTicket of [undefined, OLD]) {
    const response = await api(request({ episodeId: EP, previousTicket }), env, { fetch });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
    assert.deepEqual(await response.json(), { ticket: NEXT, ttlSeconds: 1800, refreshesRemaining: 2 });
  }
  assert.deepEqual(visited, [null, OLD]);
});

test("Watch logs an invalid ticket response and preserves renewal rejection without reminting", async t => {
  const warn = t.mock.method(console, "warn", () => {});
  const { env } = fixture();
  const wrong = await api(request({ episodeId: EP }), env, { fetch: async () => Response.json({
    ok: true, episodeId: "other", ticket: NEXT, ttlSeconds: 1800,
    expiresAt: "2030-01-01T00:00:00.000Z", refreshesRemaining: 2,
  }) });
  assert.equal(wrong.status, 502);
  let calls = 0;
  const rejected = await api(request({ episodeId: EP, previousTicket: OLD }), env, { fetch: async () => {
    calls++;
    return Response.json({ error: "ticket_refresh_limit_exceeded" }, { status: 403 });
  } });
  assert.equal(rejected.status, 403);
  assert.deepEqual(await rejected.json(), { code: "ticket_renewal_rejected" });
  assert.equal(calls, 1);
  assert.deepEqual(warn.mock.calls.map(call => call.arguments), [
    [{ event: "watch_relay_ticket_failure", category: "invalid_ticket_response", upstreamStatus: 200 }],
    [{ event: "watch_relay_ticket_failure", category: "upstream_http_error", upstreamStatus: 403 }],
  ]);
});

for (const { category, status, fetch, ray = RAY } of [
  { category: "fetch_error", ray: "ticket=" + OLD, fetch: async () => {
    throw new TypeError("Private exception data " + ISSUER + " " + cookie);
  } },
  { category: "upstream_http_error", status: 500, fetch: async () => new Response(OLD, { status: 500 }) },
  { category: "unexpected_redirect", status: 307, fetch: async () =>
    Response.redirect("https://redirect.example/?ticket=" + OLD, 307) },
  { category: "invalid_json", status: 200, fetch: async () => new Response("Private response data " + NEXT) },
]) {
  test("Watch logs " + category + " without leaking request or response details", async t => {
    const warn = t.mock.method(console, "warn", () => {});
    const { env } = fixture();
    const response = await api(request({ episodeId: EP, previousTicket: OLD }, { "CF-Ray": ray }), env, { fetch });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { code: "relay_ticket_unavailable" });
    assert.deepEqual(warn.mock.calls.map(call => call.arguments), [[{
      event: "watch_relay_ticket_failure",
      category,
      ...(status === undefined ? {} : { upstreamStatus: status }),
      ...(ray === RAY ? { rayId: RAY } : {}),
    }]]);
  });
}

test("Watch logs its own eight-second deadline as a timeout", async t => {
  const warn = t.mock.method(console, "warn", () => {});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { env } = fixture();
  const started = Promise.withResolvers();
  const pending = api(request({ episodeId: EP }, { "CF-Ray": RAY }), env, {
    fetch: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      started.resolve(signal);
    }),
  });
  const signal = await started.promise;
  t.mock.timers.tick(7999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  const response = await pending;
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { code: "relay_ticket_unavailable" });
  assert.deepEqual(warn.mock.calls.map(call => call.arguments), [[{
    event: "watch_relay_ticket_failure", category: "timeout", rayId: RAY,
  }]]);
});

test("Arabic relay preserves the legacy episode and requires exact verification for dynamic assets", () => {
  const item = { id: 297621, type: "tv", titleAr: "فخر الدلتا", titleEn: "Pride of the Delta", date: "2026-02-19",
    seasonEpisodes: { 1: [{ number: 1 }, { number: 2 }], 2: [{ number: 1 }] } };
  const context = vm.createContext({ HorizonArabicCatalog: {
    findByKey: (type, id) => type === "tv" && id === item.id ? item : null,
    getCombinedTitles: () => [item],
  } });
  vm.runInContext(readFileSync(new URL("../universal-search/arabic-providers.js", import.meta.url), "utf8"), context);
  const providers = context.HorizonArabicProviders;
  const input = { type: "tv", tmdbId: item.id, titleAr: item.titleAr, season: 1, episode: 1 };
  const resolve = (overrides = {}) => providers.resolveForProvider("akwam_relay", { ...input, ...overrides }, true);
  assert.equal(resolve().relayEpisodeId, EP);
  assert.equal(resolve().format, "mp4");
  assert.equal(resolve().streamUrl, null);
  for (const draft of [{ tmdbId: 99 }, { season: 2 }, { episode: 2 }, { type: "movie" }]) {
    assert.equal(resolve(draft).availability, "unavailable");
  }
  assert.equal(providers.preferredDefaultProvider(input, true), "akwam_relay");
  for (const [query, id] of [
    [{ type: "movie", tmdbId: 1316421 }, "movie-1316421"],
    [{ ...input, season: 2, episode: 30 }, "tv-297621-s2-e30"],
  ]) {
    assert.ok(!providers.resolveAll(query, true).some(option => option.providerId === "akwam_relay"));
    assert.equal(providers.resolveForProvider("akwam_relay", { ...query, relayVerified: id }, true).relayEpisodeId, id);
    assert.equal(providers.resolveForProvider("akwam_relay", { ...query, relayVerified: EP }, true).availability, "unavailable");
  }
  for (const unavailable of [undefined, false, "true"]) {
    const option = providers.resolveForProvider("akwam_relay", input, unavailable);
    assert.equal(option.availability, "unavailable");
    assert.equal(option.ticketUrl, undefined);
    assert.ok(!providers.resolveAll(input, unavailable).some(candidate => candidate.providerId === "akwam_relay"));
    assert.notEqual(providers.preferredDefaultProvider(input, unavailable), "akwam_relay");
  }
  for (const id of ["archive_pd", "youtube_official", "roya_tv", "official_app_handoff"]) {
    assert.ok(providers.PROVIDERS.some(provider => provider.id === id));
  }
});

test("relay progress survives the history codec and appears in Continue Watching", () => {
  const context = vm.createContext({});
  vm.runInContext(readFileSync(new URL("../universal-search/core.js", import.meta.url), "utf8"), context);
  const core = context.HorizonSearchCore;
  const values = new Map();
  const store = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const now = Date.now();
  core.writeHistory(store, core.item("tv", 297621, "فخر الدلتا", 1, 1, "off", now, {
    episodeTitle: "الحلقة الأولى", progress: { position: 24, duration: 2300, updatedAt: now, provider: "akwam_relay" },
  }));
  const [row] = core.continueRows(core.readHistory(store));
  assert.equal(row.episode, 1);
  assert.equal(row.season, 1);
  assert.equal(row.progress.position, 24);
  assert.equal(row.progress.provider, "akwam_relay");
});
