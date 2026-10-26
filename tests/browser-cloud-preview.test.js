import test from "node:test";
import assert from "node:assert/strict";
import { allowedRequestUrl, BrowserSessionManager, fixtureUrl, mapPoint, permittedUrl, validCommand,
  IDLE_MS, MAX_ACTIVE_MS, MAX_FRAMES } from "../cloud/browser-preview-core.js";
import { DevicePairing } from "../cloud/pairing.js";
import { capturePageFrame, executePageCommand } from "../cloud/browser-preview-page.js";
import { browserWriteAllowed, pairedBrowserDevice } from "../cloud/browser-preview-auth.js";
import "../frontend/browser-cloud-core.js";
const cloudUi = globalThis.HorizonCloudBrowserCore;

const ORIGIN = "https://horizon-cloud-browser-preview.example.workers.dev/";
function kv() {
  const values = new Map();
  return { get: key => values.get(key), put: (key, value) => values.set(key, structuredClone(value)),
    delete: key => values.delete(key) };
}
function setup() {
  let now = 1_000_000;
  const storage = kv(), calls = [];
  const adapter = {
    async create(url, hosts) { calls.push(["create", url, hosts]);
      return { browserSessionId: "mock-session", frame: Uint8Array.of(255, 216, 0), url }; },
    async perform(_id, command) { calls.push(["perform", command.type]);
      return { frame: Uint8Array.of(255, 216, command.seq), url: command.url || fixtureUrl(ORIGIN) }; },
    async capture() { calls.push(["capture"]);
      return { frame: Uint8Array.of(255, 216, 99), url: fixtureUrl(ORIGIN) }; },
    async close() { calls.push(["close"]); },
  };
  const manager = new BrowserSessionManager(storage, adapter, ORIGIN, () => now);
  return { storage, adapter, manager, calls, advance(ms) { now += ms; } };
}

test("fixed public HTTPS destination policy rejects private and unsafe URLs", () => {
  for (const url of ["http://example.com", "file:///etc/passwd", "https://127.0.0.1/",
    "https://169.254.169.254/", "https://10.0.0.1/", "https://example.com:8443/",
    "https://user:secret@example.com/", "https://evil.example/", "data:text/html,hi",
    "https://horizon-cloud-browser-preview.example.workers.dev/api/owner/devices"])
    assert.equal(permittedUrl(url, ORIGIN), null, url);
  assert.equal(permittedUrl("https://example.com/", ORIGIN), "https://example.com/");
  assert.equal(permittedUrl(fixtureUrl(ORIGIN), ORIGIN), fixtureUrl(ORIGIN));
  const hosts = ["example.com", "www.wikipedia.org"];
  assert.equal(allowedRequestUrl("https://example.com/image.png", hosts), true);
  for (const blocked of ["http://example.com/", "https://127.0.0.1/", "https://internal.local/",
    "https://example.com:8443/", "file:///etc/passwd"])
    assert.equal(allowedRequestUrl(blocked, hosts), false);
});

test("exact command shapes, coordinates, text limits and sequence numbers", () => {
  assert.deepEqual(validCommand({ seq: 1, type: "click", x: 10, y: 20 }, ORIGIN),
    { seq: 1, type: "click", x: 10, y: 20 });
  for (const bad of [{ seq: 0, type: "click", x: 1, y: 1 },
    { seq: 1, type: "click", x: 1280, y: 1 }, { seq: 1, type: "click", x: 1, y: 1, extra: true },
    { seq: 1, type: "text", text: "x".repeat(161) }, { seq: 1, type: "key", key: "F12" },
    { seq: 1, url: "http://example.com" }]) assert.equal(validCommand(bad, ORIGIN), null);
});

test("letterboxed client coordinates map identically in Worker and TV helper", () => {
  const rect = { left: 100, top: 40, width: 1000, height: 700 };
  const point = { x: 600, y: 390 };
  assert.deepEqual(mapPoint(point.x, point.y, rect), { x: 640, y: 360 });
  assert.deepEqual(cloudUi.mapPoint(point.x, point.y, rect), mapPoint(point.x, point.y, rect));
  assert.equal(mapPoint(100, 40, rect), null);
  assert.equal(cloudUi.mapPoint(1100, 390, rect), null);
});

test("single session starts on fixture, reuses browser, and isolates owner", async () => {
  const { manager, calls } = setup();
  const first = await manager.start("device-a");
  assert.equal(first.seq, 0);
  assert.equal(first.frame[2], 0);
  assert.equal(calls[0][0], "create");
  assert.deepEqual(calls[0][2], ["horizon-cloud-browser-preview.example.workers.dev",
    "example.com", "www.wikipedia.org", "www.google.com"]);
  assert.equal((await manager.start("device-a")).reused, true);
  assert.equal((await manager.start("device-b")).error, "session_busy");
  assert.equal((await manager.frame("device-b")).error, "not_authorized");
  assert.equal(calls.filter(item => item[0] === "create").length, 1);
});

test("real pairing state can authorize one device and revocation closes its browser", async () => {
  const { storage, manager, calls } = setup();
  const pairing = new DevicePairing(storage, () => 1_000_000, () => "device-a");
  const pending = pairing.start("pending-hash", "code-hash", "source-hash", { userAgent: "test" });
  assert.equal(pairing.lookup("code-hash").id, pending.id);
  assert.equal(pairing.decide(pending.id, "code-hash", "approve").state, "approved");
  assert.equal(pairing.poll("pending-hash", "session-hash").state, "paired");
  const authorized = pairing.authenticate("session-hash");
  assert.ok(authorized);
  await manager.start(authorized.deviceId);
  assert.equal(pairing.revoke(authorized.deviceId).revoked, true);
  await manager.revoke(authorized.deviceId);
  assert.equal(pairing.authenticate("session-hash"), null);
  assert.equal((await manager.status(authorized.deviceId)).active, false);
  assert.ok(calls.some(item => item[0] === "close"));
});

test("browser requests require an approved cookie; origin and action header block CSRF", async () => {
  const storage = kv();
  const pairing = new DevicePairing(storage, () => 1_000_000, () => "device-a");
  const secret = "a".repeat(64);
  const hashBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)));
  const sessionHash = Array.from(hashBytes, b => b.toString(16).padStart(2, "0")).join("");
  const pending = pairing.start("pending-hash", "code-hash", "source-hash", {});
  pairing.decide(pending.id, "code-hash", "approve");
  pairing.poll("pending-hash", sessionHash);
  const allowed = new Request(`${ORIGIN}api/browser/input`, { method: "POST",
    headers: { cookie: `__Host-horizon_session=${secret}`, origin: new URL(ORIGIN).origin,
      "x-horizon-action": "browser" } });
  assert.equal(await pairedBrowserDevice(allowed, pairing), "device-a");
  assert.equal(browserWriteAllowed(allowed, new URL(ORIGIN).origin), true);
  const withoutCookie = new Request(allowed, { headers: { origin: new URL(ORIGIN).origin,
    "x-horizon-action": "browser" } });
  assert.equal(await pairedBrowserDevice(withoutCookie, pairing), null);
  const crossSite = new Request(allowed, { headers: { cookie: `__Host-horizon_session=${secret}`,
    origin: "https://attacker.example", "x-horizon-action": "browser" } });
  assert.equal(browserWriteAllowed(crossSite, new URL(ORIGIN).origin), false);
  pairing.revoke("device-a");
  assert.equal(await pairedBrowserDevice(allowed, pairing), null);
});

test("one coordinate click changes the mock screenshot and cannot be replayed", async () => {
  const { manager, calls } = setup();
  await manager.start("device-a");
  const click = { seq: 1, type: "click", x: 300, y: 200 };
  const result = await manager.perform("device-a", click);
  assert.equal(result.frame[2], 1);
  assert.equal((await manager.perform("device-a", click)).error, "stale_sequence");
  assert.deepEqual(calls.filter(item => item[0] === "perform"), [["perform", "click"]]);
});

test("ambiguous browser failure spends sequence and never retries input", async () => {
  const { manager, adapter, calls } = setup();
  await manager.start("device-a");
  adapter.perform = async () => { calls.push(["attempt"]); throw new Error("network lost"); };
  assert.equal((await manager.perform("device-a", { seq: 1, type: "click", x: 1, y: 1 })).error, "action_unconfirmed");
  assert.equal((await manager.perform("device-a", { seq: 1, type: "click", x: 1, y: 1 })).error, "stale_sequence");
  assert.equal(calls.filter(item => item[0] === "attempt").length, 1);
  assert.equal((await manager.status("device-a")).seq, 1);
});

test("known navigation and input failures return safe categorical errors", async () => {
  const { manager, adapter } = setup();
  await manager.start("device-a");
  adapter.perform = async () => { throw new Error("navigation_failed"); };
  assert.equal((await manager.perform("device-a", { seq: 1, type: "navigate", url: "https://example.com/" })).error,
    "navigation_failed");
  adapter.perform = async () => { throw new Error("text_target_unavailable"); };
  assert.equal((await manager.perform("device-a", { seq: 2, type: "text", text: "hello" })).error,
    "text_target_unavailable");
  adapter.perform = async () => { throw new Error("Bearer private-token"); };
  assert.equal((await manager.perform("device-a", { seq: 3, type: "refresh" })).error,
    "action_unconfirmed");
});

test("expired remote browser clears stale metadata; transient status errors remain unconfirmed", async () => {
  const gone = setup();
  await gone.manager.start("device-a");
  gone.adapter.perform = async () => { throw new Error("browser disconnected"); };
  gone.adapter.exists = async () => false;
  assert.equal((await gone.manager.perform("device-a", { seq: 1, type: "refresh" })).error, "session_expired");
  assert.equal((await gone.manager.status("device-a")).active, false);
  const transient = setup();
  await transient.manager.start("device-a");
  transient.adapter.perform = async () => { throw new Error("temporary timeout"); };
  transient.adapter.exists = async () => { throw new Error("status unavailable"); };
  assert.equal((await transient.manager.perform("device-a", { seq: 1, type: "refresh" })).error,
    "action_unconfirmed");
  assert.equal((await transient.manager.status("device-a")).active, true);
});

test("actions serialize and one pending command cannot race another", async () => {
  const { manager, adapter, calls } = setup();
  await manager.start("device-a");
  let release;
  adapter.perform = async (_id, command) => { calls.push(["start", command.seq]);
    if (command.seq === 1) await new Promise(resolve => { release = resolve; });
    calls.push(["end", command.seq]);
    return { frame: Uint8Array.of(255, 216, command.seq), url: fixtureUrl(ORIGIN) }; };
  const first = manager.enqueue(() => manager.perform("device-a", { seq: 1, type: "refresh" }));
  const second = manager.enqueue(() => manager.perform("device-a", { seq: 2, type: "back" }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.slice(-1), [["start", 1]]);
  release(); await Promise.all([first, second]);
  assert.deepEqual(calls.slice(-4), [["start", 1], ["end", 1], ["start", 2], ["end", 2]]);
});

test("idle and absolute deadlines close browser without new actions", async () => {
  const idle = setup(); await idle.manager.start("device-a"); idle.advance(IDLE_MS + 1);
  assert.equal((await idle.manager.status("device-a")).active, false);
  assert.ok(idle.calls.some(item => item[0] === "close"));
  const absolute = setup(); await absolute.manager.start("device-a");
  for (let i = 0; i < 3; i++) { absolute.advance(IDLE_MS - 1000);
    await absolute.manager.perform("device-a", { seq: i + 1, type: "refresh" }); }
  absolute.advance(MAX_ACTIVE_MS);
  assert.equal((await absolute.manager.status("device-a")).active, false);
});

test("frame refresh is bounded, closes on unsafe navigation and supports clean end", async () => {
  const { manager, adapter, calls } = setup();
  await manager.start("device-a");
  assert.equal((await manager.frame("device-a")).frame[2], 99);
  adapter.perform = async () => ({ frame: Uint8Array.of(255, 216, 1), url: "https://127.0.0.1/" });
  assert.equal((await manager.perform("device-a", { seq: 1, type: "refresh" })).error, "unsafe_browser_result");
  assert.equal((await manager.status("device-a")).active, false);
  await manager.start("device-a");
  assert.equal((await manager.end("device-a")).active, false);
  assert.ok(calls.filter(item => item[0] === "close").length >= 2);
  assert.ok(MAX_FRAMES > 0);
});

test("rate limit, expired browser and unavailable acquisition are categorical", async () => {
  const { manager, adapter, advance } = setup();
  await manager.start("device-a");
  for (let seq = 1; seq <= 30; seq++) assert.equal((await manager.perform("device-a", { seq, type: "refresh" })).seq, seq);
  assert.equal((await manager.perform("device-a", { seq: 31, type: "refresh" })).error, "rate_limited");
  advance(IDLE_MS + 1);
  assert.equal((await manager.perform("device-a", { seq: 31, type: "refresh" })).error, "not_authorized");
  adapter.create = async () => { throw new Error("account limit reached"); };
  assert.equal((await manager.start("device-a")).error, "browser_unavailable");
});

test("explicit screenshot refresh is bounded per minute", async () => {
  const { manager, advance } = setup();
  await manager.start("device-a");
  for (let i = 0; i < 20; i++) assert.ok((await manager.frame("device-a")).frame);
  assert.equal((await manager.frame("device-a")).error, "rate_limited");
  advance(60_001);
  assert.ok((await manager.frame("device-a")).frame);
});

test("browser-level click, scroll, text, keyboard and history use supported page methods", async () => {
  const calls = [];
  const page = {
    mouse: { click: async (...args) => calls.push(["click", ...args]),
      wheel: async (...args) => calls.push(["wheel", ...args]) },
    keyboard: { insertText: async value => calls.push(["text", value]),
      press: async value => calls.push(["key", value]) },
    evaluate: async () => true,
    goto: async url => { calls.push(["goto", url]); return { status: () => 200 }; },
    goBack: async () => calls.push(["back"]),
    goForward: async () => calls.push(["forward"]),
    reload: async () => calls.push(["refresh"]),
  };
  await executePageCommand(page, { type: "click", x: 123, y: 456 });
  await executePageCommand(page, { type: "scroll", deltaY: 300 });
  await executePageCommand(page, { type: "text", text: "search" });
  await executePageCommand(page, { type: "key", key: "Enter" });
  await executePageCommand(page, { type: "navigate", url: fixtureUrl(ORIGIN) });
  for (const type of ["back", "forward", "refresh"]) await executePageCommand(page, { type });
  assert.deepEqual(calls, [["click", 123, 456], ["wheel", 0, 300], ["text", "search"],
    ["key", "Enter"], ["goto", fixtureUrl(ORIGIN)], ["back"], ["forward"], ["refresh"]]);
  page.evaluate = async () => false;
  await assert.rejects(executePageCommand(page, { type: "text", text: "blocked" }), /text_target_unavailable/);
  assert.equal(calls.filter(item => item[0] === "text").length, 1);
});

test("screenshot capture returns bounded binary JPEG metadata, not a base64 URL", async () => {
  let options;
  const page = { screenshot: async supplied => { options = supplied; return Uint8Array.of(255, 216, 255); },
    url: () => fixtureUrl(ORIGIN) };
  let at = 10;
  const result = await capturePageFrame(page, 7, () => { at += 5; return at; });
  assert.deepEqual(options, { type: "jpeg", quality: 65, timeout: 7000, animations: "disabled" });
  assert.equal(result.frame.byteLength, 3);
  assert.equal(result.timings.bytes, 3);
  assert.equal(result.timings.actionMs, 7);
  assert.equal(result.timings.captureMs, 5);
});
