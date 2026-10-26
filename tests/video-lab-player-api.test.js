import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";

const source = readFileSync(new URL("../video-lab-player-api.js", import.meta.url), "utf8")
  .replace(/^import .*\n/gm, "")
  .replace(/^export \{.*\};\n/gm, "")
  .replace("export async function playerApi", "async function playerApi")
  + "\nglobalThis.playerApi = playerApi;";
const context = { crypto: webcrypto, Request, Response, URL, Headers, TextEncoder, TextDecoder,
  handleApi: () => new Response("pairing route"), Set, JSON };
runInNewContext(source, context);
const ORIGIN = "https://horizon-video-lab-preview.example";
const TOKEN = "preview-controller-token-with-at-least-thirty-two-bytes";
const COOKIE = "__Host-horizon_session=" + "a".repeat(64);

function fixture() {
  const calls = [];
  const bridge = {
    async open(owner) { calls.push(["open", owner]); return { state: "preparing" }; },
    async command(owner, id, sequence, command, issuedAt) {
      calls.push(["command", owner, id, sequence, command, issuedAt]); return { accepted: true };
    },
    async fetch() { calls.push(["connect"]); return new Response("connected"); },
  };
  const env = {
    PLAYER_BRIDGE_TOKEN: TOKEN,
    LAUNCH_QUEUE: { idFromName: () => "primary-tv", get: () => ({
      pairAuthenticate: async () => ({ deviceId: "approved-tv" }),
    }) },
    PLAYER_BRIDGE: { idFromName: () => "single-tv", get: () => bridge },
  };
  return { env, calls };
}

function post(path, headers, body = {}) {
  return new Request(ORIGIN + path, { method: "POST", headers,
    body: JSON.stringify(body) });
}

test("player writes require paired cookie, same origin, action header and allowlisted command", async () => {
  const f = fixture();
  const headers = { Cookie: COOKIE, Origin: ORIGIN, "X-Horizon-Action": "player",
    "Content-Type": "application/json" };
  assert.equal((await context.playerApi(post("/api/player/open", {}, {}), f.env)).status, 403);
  assert.equal((await context.playerApi(post("/api/player/open", { ...headers, Origin: "https://evil.example" }), f.env)).status, 403);
  assert.equal((await context.playerApi(post("/api/player/open", headers), f.env)).status, 200);
  assert.equal(f.calls.at(-1)[1], "approved-tv");
  const id = "11111111-1111-4111-8111-111111111111";
  assert.equal((await context.playerApi(post("/api/player/command", headers,
    { id, sequence: 1, command: "arbitrary_key", issuedAt: Date.now() }), f.env)).status, 400);
  assert.equal((await context.playerApi(post("/api/player/command", headers,
    { id, sequence: 1, command: "seek_forward", issuedAt: Date.now() }), f.env)).status, 200);
  assert.equal(f.calls.at(-1)[4], "seek_forward");
  const before = f.calls.length;
  const oversized = new Request(ORIGIN + "/api/player/command", { method: "POST",
    headers: { ...headers, "Content-Length": "0" }, body: "x".repeat(300) });
  assert.equal((await context.playerApi(oversized, f.env)).status, 400);
  assert.equal(f.calls.length, before);
});

test("Pico socket upgrade requires controller bearer, not browser cookie or Origin", async () => {
  const f = fixture();
  const make = token => new Request(ORIGIN + "/api/player/connect", { headers: {
    Upgrade: "websocket", Authorization: "Bearer " + token,
  } });
  assert.equal((await context.playerApi(make("wrong"), f.env)).status, 403);
  assert.equal(f.calls.length, 0);
  assert.equal((await context.playerApi(make(TOKEN), f.env)).status, 200);
  assert.deepEqual(f.calls, [["connect"]]);
});
