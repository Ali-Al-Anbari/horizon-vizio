import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";

const source = readFileSync(new URL("../video-lab-player-bridge.js", import.meta.url), "utf8")
  .replace(/^import .*\n/m, "")
  .replace("export class PlayerBridge", "class PlayerBridge")
  .replace("export { COMMANDS, LEASE_MS };", "globalThis.PlayerBridge = PlayerBridge;");
const context = { crypto: webcrypto, Date, Promise, Map, Set, JSON, WebSocketPair: class {},
  DurableObject: class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } },
  setTimeout, clearTimeout, Response };
runInNewContext(source, context);
const { PlayerBridge } = context;
const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";

function fixture() {
  const sent = [];
  const socket = { send(raw) { sent.push(JSON.parse(raw)); }, close() {} };
  const bridge = new PlayerBridge({ getWebSockets: () => [] }, {});
  bridge.controller = socket;
  return { bridge, socket, sent, dispose() { bridge.disconnect(); } };
}

test("open prepares, read-only readiness gates ordered commands, and close releases session", async () => {
  const f = fixture();
  try {
    assert.equal((await f.bridge.open("owner-a")).state, "preparing");
    const session = f.sent[0].session;
    assert.equal((await f.bridge.status("owner-a")).state, "preparing");
    const first = f.bridge.command("owner-a", ID1, 1, "seek_forward", Date.now());
    const second = f.bridge.command("owner-a", ID2, 2, "seek_forward", Date.now());
    assert.equal(f.sent.filter(v => v.type === "player_command").length, 0);
    await f.bridge.webSocketMessage(f.socket, JSON.stringify({ type: "session_ready", session, ready: true }));
    assert.equal(f.sent.filter(v => v.type === "player_command").length, 1);
    await f.bridge.webSocketMessage(f.socket, JSON.stringify({ type: "command_ack", session,
      id: ID1, sequence: 1, accepted: true, code: "accepted" }));
    assert.equal((await first).accepted, true);
    assert.equal(f.sent.filter(v => v.type === "player_command").length, 2);
    assert.equal(f.sent.at(-1).id, ID2);
    await f.bridge.webSocketMessage(f.socket, JSON.stringify({ type: "command_ack", session,
      id: ID2, sequence: 2, accepted: true, code: "accepted" }));
    assert.equal((await second).accepted, true);
    assert.equal((await f.bridge.close("owner-a")).state, "closed");
    assert.equal(f.sent.at(-1).type, "player_session_close");
  } finally { f.dispose(); }
});

test("duplicate, gap, unsupported input and other owner cannot execute", async () => {
  const f = fixture();
  try {
    await f.bridge.open("owner-a");
    const session = f.sent[0].session;
    await f.bridge.webSocketMessage(f.socket, JSON.stringify({ type: "session_ready", session, ready: true }));
    assert.equal((await f.bridge.command("owner-b", ID1, 1, "seek_forward", Date.now())).error, "no_session");
    assert.equal((await f.bridge.command("owner-a", ID1, 2, "seek_forward", Date.now())).error, "sequence_gap");
    assert.equal((await f.bridge.command("owner-a", ID1, 1, "arbitrary_key", Date.now())).error, "invalid_command");
    const pending = f.bridge.command("owner-a", ID1, 1, "pause_toggle", Date.now());
    assert.equal((await f.bridge.command("owner-a", ID1, 1, "pause_toggle", Date.now())).error, "duplicate");
    await f.bridge.webSocketMessage(f.socket, JSON.stringify({ type: "command_ack", session,
      id: ID1, sequence: 1, accepted: true, code: "accepted" }));
    assert.equal((await pending).accepted, true);
    assert.equal(f.sent.filter(v => v.type === "player_command").length, 1);
  } finally { f.dispose(); }
});

test("closing mid-command waits for its acknowledgment and drops unsent seek", async () => {
  const f = fixture();
  try {
    await f.bridge.open("owner-a");
    const session = f.sent[0].session;
    await f.bridge.webSocketMessage(f.socket, JSON.stringify({ type: "session_ready", session, ready: true }));
    const first = f.bridge.command("owner-a", ID1, 1, "seek_forward", Date.now());
    const second = f.bridge.command("owner-a", ID2, 2, "seek_forward", Date.now());
    await f.bridge.close("owner-a");
    assert.equal((await second).error, "closed");
    assert.equal(f.sent.filter(v => v.type === "player_session_close").length, 0);
    await f.bridge.webSocketMessage(f.socket, JSON.stringify({ type: "command_ack", session,
      id: ID1, sequence: 1, accepted: true, code: "accepted" }));
    assert.equal((await first).accepted, true);
    assert.equal(f.sent.at(-1).type, "player_session_close");
    assert.equal(f.sent.filter(v => v.type === "player_command").length, 1);
  } finally { f.dispose(); }
});

test("connection loss fails pending command without replay", async () => {
  const f = fixture();
  await f.bridge.open("owner-a");
  const session = f.sent[0].session;
  await f.bridge.webSocketMessage(f.socket, JSON.stringify({ type: "session_ready", session, ready: true }));
  const pending = f.bridge.command("owner-a", ID1, 1, "pause_toggle", Date.now());
  f.bridge.disconnect();
  assert.equal((await pending).error, "outcome_unknown");
  assert.equal(f.sent.filter(v => v.type === "player_command").length, 1);
  assert.equal((await f.bridge.status("owner-a")).state, "closed");
});

test("stale intent and expired visible lease never dispatch a key", async () => {
  const f = fixture();
  try {
    await f.bridge.open("owner-a");
    const session = f.sent[0].session;
    await f.bridge.webSocketMessage(f.socket, JSON.stringify({ type: "session_ready", session, ready: true }));
    assert.equal((await f.bridge.command("owner-a", ID1, 1, "seek_forward", Date.now() - 2000)).error,
      "expired_intent");
    assert.equal(f.sent.filter(v => v.type === "player_command").length, 0);
    f.bridge.session.expires = Date.now() - 1;
    assert.equal((await f.bridge.status("owner-a")).state, "closed");
    assert.equal(f.sent.at(-1).type, "player_session_close");
  } finally { f.dispose(); }
});

test("hibernation restores settled session metadata without replaying commands", async () => {
  const sent = [];
  const socket = {
    attachment: null,
    send(raw) { sent.push(JSON.parse(raw)); },
    close() {},
    serializeAttachment(value) { this.attachment = structuredClone(value); },
    deserializeAttachment() { return structuredClone(this.attachment); },
  };
  const first = new PlayerBridge({ getWebSockets: () => [] }, {});
  first.controller = socket;
  first.persistSession();
  await first.open("approved-tv");
  const session = first.session.id;
  await first.webSocketMessage(socket, JSON.stringify({ type: "session_ready", session, ready: true }));
  clearTimeout(first.leaseTimer); // Simulate the old in-memory instance being evicted.
  const restored = new PlayerBridge({ getWebSockets: () => [socket] }, {});
  try {
    assert.equal((await restored.status("approved-tv")).state, "ready");
    assert.equal(restored.session.id, session);
    assert.equal(sent.filter(value => value.type === "player_command").length, 0);
    await restored.close("approved-tv");
    assert.equal(socket.attachment.kind, "idle");
  } finally { restored.disconnect(); }
});
