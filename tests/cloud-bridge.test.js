import assert from "node:assert/strict";
import { before, test } from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { CommandQueue, QUEUED_MS, PROCESSING_MS } from "../cloud/queue.js";
import { DevicePairing, PAIR_MS, ROTATE_AFTER_MS, SESSION_ABSOLUTE_MS, SESSION_MS } from "../cloud/pairing.js";
import { handleApi } from "../cloud/api.js";

const ORIGIN = "https://horizon.example";
const TEAM = "https://unit.cloudflareaccess.com";
const AUD = "horizon-owner";
const SECRET = "controller-secret-with-at-least-thirty-two-random-characters";
let privateKey;
let jwks;
before(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "unit-key", alg: "RS256" }] });
});

async function ownerHeaders(email = "owner@example.com", audience = AUD) {
  const jwt = await new SignJWT({ email }).setProtectedHeader({ alg: "RS256", kid: "unit-key" })
    .setIssuer(TEAM).setAudience(audience).setIssuedAt().setExpirationTime("5m").sign(privateKey);
  return { ...browserHeaders("", "owner-pair"), "cf-access-jwt-assertion": jwt };
}
function browserHeaders(cookie = "", action = "") {
  return { Cookie: cookie, Origin: ORIGIN, "X-Horizon-Action": action, "Content-Type": "application/json" };
}
function fixture() {
  let now = 1_000_000;
  const state = new Map();
  const kv = { get: key => structuredClone(state.get(key)), put: (key, value) => state.set(key, structuredClone(value)) };
  const commands = new CommandQueue(kv, () => now);
  const pairing = new DevicePairing(kv, () => now);
  const stub = {
    pairStart: (...args) => pairing.start(...args),
    pairLookup: (...args) => pairing.lookup(...args),
    pairDecide: (...args) => pairing.decide(...args),
    pairPoll: (...args) => pairing.poll(...args),
    pairAuthenticate: (...args) => pairing.authenticate(...args),
    pairRotate: (...args) => pairing.rotate(...args),
    pairDevices: () => pairing.devices(),
    pairRevoke: id => {
      const result = pairing.revoke(id);
      if (result.revoked) commands.cancelQueuedByDevice(id);
      return result;
    },
    enqueue: (app, hash) => {
      const device = pairing.authenticate(hash);
      return device ? commands.enqueue(app, device.deviceId) : { error: "not_authorized" };
    },
    status: (id, hash) => {
      const device = pairing.authenticate(hash);
      return device ? commands.status(id, device.deviceId) : { error: "not_authorized" };
    },
    claim: () => commands.claim(),
    report: (...args) => commands.report(...args),
  };
  const env = {
    TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, OWNER_EMAIL: "owner@example.com",
    CONTROLLER_TOKEN: SECRET,
    LAUNCH_QUEUE: { idFromName: () => "primary-tv", get: () => stub },
  };
  return { env, commands, pairing, advance: delta => { now += delta; } };
}
async function api(env, path, method = "GET", headers = {}, body) {
  const request = new Request(ORIGIN + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handleApi(request, env, { jwks });
}
function cookieFrom(response, name) {
  const value = new RegExp(`${name}=([0-9a-f]{64})`).exec(response.headers.get("set-cookie") || "")?.[1];
  assert.ok(value, `missing ${name}`);
  return `${name}=${value}`;
}
async function start(env) {
  const response = await api(env, "/api/pair/start", "POST", browserHeaders("", "pair"));
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.match(body.code, /^[A-HJ-NP-Z2-9]{10}$/);
  return { code: body.code, pending: cookieFrom(response, "__Host-horizon_pending") };
}
async function pair(env) {
  const owner = await ownerHeaders();
  const started = await start(env);
  const lookup = await api(env, "/api/owner/lookup", "POST", owner, { code: started.code });
  assert.equal(lookup.status, 200);
  const { id } = await lookup.json();
  assert.equal((await api(env, "/api/owner/decide", "POST", owner,
    { id, code: started.code, decision: "approve" })).status, 200);
  const poll = await api(env, "/api/pair/status", "POST", browserHeaders(started.pending, "pair"));
  assert.equal((await poll.json()).state, "paired");
  const devices = await (await api(env, "/api/owner/devices", "GET", owner)).json();
  return { owner, pendingId: id, deviceId: devices.devices.at(-1).id,
    ...started, session: cookieFrom(poll, "__Host-horizon_session") };
}

test("owner approval pairs a TV; controller claims once and reports observed launch", async () => {
  const { env, advance } = fixture();
  const device = await pair(env);
  const queuedResponse = await api(env, "/api/apps/launch", "POST",
    browserHeaders(device.session, "launch-app"), { app: "youtube" });
  assert.equal(queuedResponse.status, 202);
  const queued = await queuedResponse.json();
  assert.equal(queued.queuedAt, 1_000_000);
  assert.equal((await api(env, "/api/controller/claim", "POST")).status, 403);
  const controller = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };
  advance(100);
  const claimed = await (await api(env, "/api/controller/claim", "POST", controller)).json();
  assert.equal(claimed.app, "youtube");
  const processing = await (await api(env, `/api/apps/commands/${queued.id}`, "GET",
    { Cookie: device.session })).json();
  assert.equal(processing.state, "processing");
  assert.equal(processing.claimedAt - processing.queuedAt, 100);
  assert.equal((await api(env, "/api/controller/claim", "POST", controller)).status, 204);
  advance(2500);
  const reported = await api(env, "/api/controller/result", "POST", controller,
    { id: claimed.id, claimId: claimed.claimId, outcome: "verified", code: "app_confirmed" });
  assert.equal(reported.status, 200);
  assert.equal((await reported.json()).elapsedMs, 2600);
  assert.equal((await (await api(env, `/api/apps/commands/${queued.id}`, "GET",
    { Cookie: device.session })).json()).state, "verified");
  assert.equal((await api(env, "/api/controller/result", "POST", controller,
    { id: claimed.id, claimId: claimed.claimId, outcome: "verified", code: "app_confirmed" })).status, 409);
});

test("public visitor, unauthorized owner, CSRF, and unsupported app fail closed", async () => {
  const { env } = fixture();
  assert.equal((await api(env, "/api/apps/launch", "POST",
    browserHeaders("", "launch-app"), { app: "youtube" })).status, 403);
  const started = await start(env);
  assert.equal((await api(env, "/api/owner/lookup", "POST",
    await ownerHeaders("stranger@example.com"), { code: started.code })).status, 403);
  assert.equal((await api(env, "/api/owner/lookup", "POST",
    await ownerHeaders("owner@example.com", "wrong-aud"), { code: started.code })).status, 403);
  const device = await pair(env);
  assert.equal((await api(env, "/api/apps/launch", "POST",
    { ...browserHeaders(device.session, "launch-app"), Origin: "https://attacker.example" },
    { app: "youtube" })).status, 403);
  assert.equal((await api(env, "/api/apps/launch", "POST",
    { ...browserHeaders(device.session, "launch-app"), "X-Horizon-Action": "wrong" },
    { app: "youtube" })).status, 403);
  assert.equal((await api(env, "/api/apps/launch", "POST",
    browserHeaders(device.session, "launch-app"), { app: "netflix" })).status, 400);
});

test("pairing-only staging hides every app and controller command route", async () => {
  const { env } = fixture();
  env.PAIRING_ONLY = true;
  const device = await pair(env);
  assert.equal((await api(env, "/api/apps/launch", "POST",
    browserHeaders(device.session, "launch-app"), { app: "youtube" })).status, 404);
  assert.equal((await api(env, "/api/controller/claim", "POST",
    { Authorization: `Bearer ${SECRET}` })).status, 404);
  assert.equal((await api(env, "/api/pair/session", "GET",
    { Cookie: device.session })).status, 200);
});

test("enabled launch routes still fail closed without a controller credential", async () => {
  const { env } = fixture();
  const device = await pair(env);
  delete env.CONTROLLER_TOKEN;
  assert.equal((await api(env, "/api/apps/launch", "POST",
    browserHeaders(device.session, "launch-app"), { app: "youtube" })).status, 503);
});

test("first staging launch enables YouTube alone while preserving the five-app registry", async () => {
  const { env } = fixture();
  env.STAGING_YOUTUBE_ONLY = true;
  const device = await pair(env);
  assert.equal((await api(env, "/api/apps/launch", "POST",
    browserHeaders(device.session, "launch-app"), { app: "plex" })).status, 403);
  assert.equal((await api(env, "/api/apps/launch", "POST",
    browserHeaders(device.session, "launch-app"), { app: "youtube" })).status, 202);
});

test("expired, rejected, and reused codes cannot create sessions", async () => {
  const expired = fixture();
  const old = await start(expired.env);
  expired.advance(PAIR_MS + 1);
  assert.equal((await api(expired.env, "/api/owner/lookup", "POST",
    await ownerHeaders(), { code: old.code })).status, 404);
  assert.equal((await (await api(expired.env, "/api/pair/status", "POST",
    browserHeaders(old.pending, "pair"))).json()).state, "expired");
  const rejected = fixture();
  const attempt = await start(rejected.env);
  const owner = await ownerHeaders();
  const found = await (await api(rejected.env, "/api/owner/lookup", "POST",
    owner, { code: attempt.code })).json();
  assert.equal((await api(rejected.env, "/api/owner/decide", "POST", owner,
    { id: found.id, code: attempt.code, decision: "reject" })).status, 200);
  assert.equal((await (await api(rejected.env, "/api/pair/status", "POST",
    browserHeaders(attempt.pending, "pair"))).json()).state, "rejected");
  assert.equal((await api(rejected.env, "/api/owner/decide", "POST", owner,
    { id: found.id, code: attempt.code, decision: "approve" })).status, 409);
  const used = fixture();
  const device = await pair(used.env);
  assert.equal((await api(used.env, "/api/owner/decide", "POST", device.owner,
    { id: device.pendingId, code: device.code, decision: "approve" })).status, 409);
  assert.equal((await (await api(used.env, "/api/pair/status", "POST",
    browserHeaders(device.pending, "pair"))).json()).state, "expired");
});

test("revocation cuts off launches; another device cannot read a command", async () => {
  const { env } = fixture();
  const first = await pair(env);
  const queued = await (await api(env, "/api/apps/launch", "POST",
    browserHeaders(first.session, "launch-app"), { app: "plex" })).json();
  const second = await pair(env);
  assert.equal((await api(env, `/api/apps/commands/${queued.id}`, "GET",
    { Cookie: second.session })).status, 404);
  assert.equal((await api(env, "/api/owner/revoke", "POST",
    first.owner, { id: first.deviceId })).status, 200);
  assert.equal((await api(env, "/api/controller/claim", "POST",
    { Authorization: `Bearer ${SECRET}` })).status, 204);
  assert.equal((await api(env, "/api/apps/launch", "POST",
    browserHeaders(first.session, "launch-app"), { app: "plex" })).status, 403);
});

test("duplicate requests and controller outages do not create extra launches", async () => {
  const instance = fixture();
  const first = await pair(instance.env);
  const second = await pair(instance.env);
  const launch = () => api(instance.env, "/api/apps/launch", "POST",
    browserHeaders(first.session, "launch-app"), { app: "plex" });
  const initial = await (await launch()).json();
  const duplicate = await (await launch()).json();
  assert.equal(duplicate.id, initial.id);
  assert.equal(duplicate.duplicate, true);
  assert.equal((await api(instance.env, "/api/apps/launch", "POST",
    browserHeaders(second.session, "launch-app"), { app: "plex" })).status, 409);
  instance.advance(QUEUED_MS + 1);
  assert.equal((await (await api(instance.env, `/api/apps/commands/${initial.id}`,
    "GET", { Cookie: first.session })).json()).code, "controller_offline");
  assert.equal(instance.commands.claim(), null);
  const claimed = fixture();
  const device = await pair(claimed.env);
  await api(claimed.env, "/api/apps/launch", "POST",
    browserHeaders(device.session, "launch-app"), { app: "live-tv" });
  const claim = claimed.commands.claim();
  claimed.advance(PROCESSING_MS + 1);
  assert.equal(claimed.commands.report(claim.id, claim.claimId, "verified", "app_confirmed").error, "stale_claim");
});

test("session rotation and absolute expiry; pairing starts are rate limited", async () => {
  const instance = fixture();
  const device = await pair(instance.env);
  instance.advance(ROTATE_AFTER_MS + 1);
  const sessionCheck = await api(instance.env, "/api/pair/session", "GET", { Cookie: device.session });
  assert.equal((await sessionCheck.json()).rotationDue, true);
  const renewal = await api(instance.env, "/api/pair/rotate", "POST", browserHeaders(device.session, "pair"));
  assert.equal(renewal.status, 200);
  const next = cookieFrom(renewal, "__Host-horizon_session");
  assert.notEqual(next, device.session);
  assert.equal((await api(instance.env, "/api/apps/launch", "POST",
    browserHeaders(device.session, "launch-app"), { app: "youtube" })).status, 403);
  assert.equal((await api(instance.env, "/api/pair/session", "GET", { Cookie: next })).status, 200);
  instance.advance(SESSION_ABSOLUTE_MS + 1);
  assert.equal((await api(instance.env, "/api/pair/session", "GET", { Cookie: next })).status, 401);
  const inactive = fixture();
  const staleDevice = await pair(inactive.env);
  inactive.advance(SESSION_MS + 1);
  assert.equal((await api(inactive.env, "/api/apps/launch", "POST",
    browserHeaders(staleDevice.session, "launch-app"), { app: "youtube" })).status, 403);
  const limited = fixture();
  for (let i = 0; i < 5; i++) assert.equal((await api(limited.env, "/api/pair/start", "POST",
    browserHeaders("", "pair"))).status, 201);
  assert.equal((await api(limited.env, "/api/pair/start", "POST",
    browserHeaders("", "pair"))).status, 429);
});
