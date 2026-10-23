import assert from "node:assert/strict";
import { before, test } from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { handleAccessProbe } from "../cloud/access-probe-worker.js";

const origin = "https://horizon-access-probe-staging.example.workers.dev";
const env = {
  TEAM_DOMAIN: "https://unit.cloudflareaccess.com",
  ACCESS_AUD: "staging-probe-audience",
  OWNER_EMAIL: "owner@example.com",
  ASSETS: { fetch: async () => new Response("test page", { headers: { "Content-Type": "text/html" } }) },
};
let privateKey;
let jwks;

before(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "probe-key", alg: "RS256" }] });
});

async function token(email = "owner@example.com", audience = env.ACCESS_AUD) {
  return new SignJWT({ email }).setProtectedHeader({ alg: "RS256", kid: "probe-key" })
    .setIssuer(env.TEAM_DOMAIN).setAudience(audience).setIssuedAt().setExpirationTime("5m").sign(privateKey);
}

function req(path, method = "GET", headers = {}) {
  return new Request(origin + path, { method, headers });
}

test("public page is read-only and sensitive API routes do not exist", async () => {
  const page = await handleAccessProbe(req("/"), env);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal((await handleAccessProbe(req("/api/apps/launch", "POST"), env)).status, 404);
  assert.equal((await handleAccessProbe(req("/api/controller/claim"), env)).status, 404);
  assert.equal((await handleAccessProbe(req("/api/auth/probe", "POST"), env)).status, 405);
});

test("missing configuration and Access assertion fail closed without credentials in response", async () => {
  const unconfigured = await handleAccessProbe(req("/api/auth/probe"), { ASSETS: env.ASSETS });
  assert.equal(unconfigured.status, 503);
  assert.deepEqual(await unconfigured.json(), { authenticated: false, code: "authorization_unconfigured" });
  const missing = await handleAccessProbe(req("/api/auth/probe"), env);
  assert.equal(missing.status, 403);
  assert.deepEqual(await missing.json(), { authenticated: false, code: "access_assertion_missing" });
});

test("only the signed owner with the staging audience passes", async () => {
  for (const assertion of ["forged", await token("stranger@example.com"), await token("owner@example.com", "production-audience")]) {
    const result = await handleAccessProbe(req("/api/auth/probe", "GET", { "cf-access-jwt-assertion": assertion }), env, { jwks });
    assert.equal(result.status, 403);
    assert.deepEqual(await result.json(), { authenticated: false, code: "authorization_rejected" });
  }
  const assertion = await token();
  const response = await handleAccessProbe(req("/api/auth/probe", "GET", { "cf-access-jwt-assertion": assertion }), env, { jwks });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authenticated: true, code: "owner_verified" });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("authorized top-level navigation returns to public page without credential in URL", async () => {
  const response = await handleAccessProbe(req("/api/auth/start", "GET", { "cf-access-jwt-assertion": await token() }), env, { jwks });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), origin + "/?access=returned");
  assert.equal(response.headers.get("set-cookie"), null);
});

test("cookie diagnostic proves only cookie transport and rejects cross-site writes", async () => {
  const missing = await handleAccessProbe(req("/api/cookie/check"), env);
  assert.deepEqual(await missing.json(), { cookieSeen: false });
  const denied = await handleAccessProbe(req("/api/cookie/start", "POST"), env);
  assert.equal(denied.status, 403);

  const headers = { Origin: origin, "X-Horizon-Probe": "cookie" };
  const first = await handleAccessProbe(req("/api/cookie/start", "POST", headers), env);
  const second = await handleAccessProbe(req("/api/cookie/start", "POST", headers), env);
  assert.equal(first.status, 204);
  const cookie = first.headers.get("set-cookie");
  assert.match(cookie, /^__Host-horizon_probe=[0-9a-f-]{36}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=86400$/i);
  assert.notEqual(cookie, second.headers.get("set-cookie"));
  const present = await handleAccessProbe(req("/api/cookie/check", "GET", { Cookie: cookie.split(";", 1)[0] }), env);
  assert.deepEqual(await present.json(), { cookieSeen: true });

  const clear = await handleAccessProbe(req("/api/cookie/clear", "POST", headers), env);
  assert.equal(clear.status, 204);
  assert.match(clear.headers.get("set-cookie"), /Max-Age=0$/);
  assert.equal((await handleAccessProbe(req("/cookie"), env)).status, 200);
  assert.equal((await handleAccessProbe(req("/cookie.html"), env)).status, 200);
});
