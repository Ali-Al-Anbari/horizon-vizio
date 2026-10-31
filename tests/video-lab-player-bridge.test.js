import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";

const source = readFileSync(new URL("../video-lab-player-bridge.js", import.meta.url), "utf8")
  .replace(/^import .*\n/m, "")
  .replace("export class PlayerBridge", "class PlayerBridge")
  .replace("export { COMMANDS, LEASE_MS };", "globalThis.PlayerBridge = PlayerBridge;");
const context = { crypto: webcrypto, Date, Promise, Map, Set, JSON,
  WebSocketPair: class { constructor() {
    this.client = {}; this.server = { sent: [], closed: [],
      send(raw) { this.sent.push(JSON.parse(raw)); },
      close(code) { this.closed.push(code); } };
  } },
  DurableObject: class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } },
  setTimeout, clearTimeout, Response: class { constructor(_body, init) { Object.assign(this, init); } } };
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

test("idle heartbeat acknowledges the authenticated controller, including after a wake", async () => {
  const f = fixture();
  try {
    await f.bridge.webSocketMessage(f.socket, JSON.stringify({ type: "bridge_heartbeat", nonce: 7 }));
    assert.deepEqual(f.sent.at(-1), { type: "bridge_heartbeat_ack", nonce: 7 });
    await f.bridge.webSocketMessage(f.socket, JSON.stringify({ type: "bridge_heartbeat", nonce: "7" }));
    assert.equal(f.sent.length, 1);
    const socket = { sent: [], attachment: { kind: "idle" },
      send(raw) { this.sent.push(JSON.parse(raw)); }, close() {},
      deserializeAttachment() { return this.attachment; },
      serializeAttachment(value) { this.attachment = value; } };
    const restored = new PlayerBridge({ getWebSockets: () => [socket] }, {});
    await restored.webSocketMessage(socket, JSON.stringify({ type: "bridge_heartbeat", nonce: 8 }));
    assert.equal(socket.sent[0].nonce, 8);
    restored.disconnect();
  } finally { f.dispose(); }
});

test("heartbeat leaves an active ready player session and command sequence intact", async () => {
  const f = fixture();
  try {
    await f.bridge.open("owner-a");
    const session = f.bridge.session.id;
    await f.bridge.webSocketMessage(f.socket, JSON.stringify({ type: "session_ready", session, ready: true }));
    const before = f.bridge.session.sequence;
    await f.bridge.webSocketMessage(f.socket, JSON.stringify({ type: "bridge_heartbeat", nonce: 42 }));
    assert.equal(f.bridge.session.id, session);
    assert.equal(f.bridge.session.ready, true);
    assert.equal(f.bridge.session.sequence, before);
    assert.equal(f.sent.at(-1).type, "bridge_heartbeat_ack");
  } finally { f.dispose(); }
});

test("authenticated reconnect replaces an orphaned socket and never replays a command", async () => {
  const old = { closed: [], sent: [], send(raw) { this.sent.push(JSON.parse(raw)); },
    close(code) { this.closed.push(code); } };
  const accepted = [];
  const bridge = new PlayerBridge({ getWebSockets: () => [], acceptWebSocket: socket => accepted.push(socket) }, {});
  bridge.controller = old;
  await bridge.open("owner-a");
  const session = bridge.session.id;
  await bridge.webSocketMessage(old, JSON.stringify({ type: "session_ready", session, ready: true }));
  const command = bridge.command("owner-a", ID1, 1, "pause_toggle", Date.now());
  const response = await bridge.fetch({ headers: new Headers({ Upgrade: "websocket" }) });
  assert.equal(response.status, 101);
  assert.equal((await command).error, "outcome_unknown");
  assert.equal(old.closed[0], 1011);
  assert.equal(accepted.length, 1);
  assert.equal(bridge.controller, accepted[0]);
  assert.equal((await bridge.open("owner-a")).state, "preparing");
  assert.equal(old.sent.filter(v => v.type === "player_command").length, 1);
  assert.equal(bridge.controller.sent.filter(v => v.type === "player_command").length, 0);
  bridge.disconnect();
});

test("server close and error clear controller presence for a later reconnect", async () => {
  for (const event of ["webSocketClose", "webSocketError"]) {
    const f = fixture();
    await f.bridge[event](f.socket);
    assert.equal(f.bridge.controller, null);
    assert.equal((await f.bridge.open("owner-a")).error, "controller_offline");
  }
});

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

test("one authenticated batch instruction carries each allowed count and reports progress", async () => {
  const f = fixture();
  try {
    await f.bridge.open("owner-a");
    const session = f.sent[0].session;
    await f.bridge.webSocketMessage(f.socket, JSON.stringify({ type: "session_ready", session, ready: true }));
    let sequence = 0;
    for (const count of [1, 3, 6, 12, 30, 60]) {
      sequence += 1;
      const id = `${String(sequence).repeat(8)}-${String(sequence).repeat(4)}-4${String(sequence).repeat(3)}-8${String(sequence).repeat(3)}-${String(sequence).repeat(12)}`;
      const pending = f.bridge.batch("owner-a", id, sequence, "seek_forward", count, Date.now());
      assert.equal(f.sent.at(-1).type, "player_batch");
      assert.equal(f.sent.at(-1).count, count);
      assert.equal(f.sent.filter(v => v.type === "player_batch" && v.id === id).length, 1);
      assert.equal((await f.bridge.batch("owner-a", id, sequence, "seek_forward", count, Date.now())).error, "duplicate");
      await f.bridge.webSocketMessage(f.socket, JSON.stringify({ type: "batch_accepted", session,
        id, sequence, accepted: true }));
      const acceptance = await pending;
      assert.equal(acceptance.accepted, true);
      assert.ok(acceptance.serverAcceptedAt >= acceptance.serverQueuedAt);
      assert.equal((await f.bridge.batchStatus("owner-a", id)).state, "running");
      await f.bridge.webSocketMessage(f.socket, JSON.stringify({ type: "batch_progress", session,
        id, sequence, acknowledged: count }));
      assert.equal((await f.bridge.batchStatus("owner-a", id)).acknowledged, count);
      await f.bridge.webSocketMessage(f.socket, JSON.stringify({ type: "batch_done", session,
        id, sequence, state: "complete", acknowledged: count, failures: 0,
        metrics: { picoMs: 100 } }));
      assert.equal((await f.bridge.batchStatus("owner-a", id)).state, "complete");
    }
  } finally { f.dispose(); }
});

test("batch rejects invalid, stale, overlapping and other-owner requests; cancellation is bounded", async () => {
  const f = fixture();
  try {
    await f.bridge.open("owner-a");
    const session = f.sent[0].session;
    await f.bridge.webSocketMessage(f.socket, JSON.stringify({ type: "session_ready", session, ready: true }));
    assert.equal((await f.bridge.batch("owner-b", ID1, 1, "seek_forward", 3, Date.now())).error, "no_session");
    assert.equal((await f.bridge.batch("owner-a", ID1, 1, "pause_toggle", 3, Date.now())).error, "invalid_batch");
    assert.equal((await f.bridge.batch("owner-a", ID1, 1, "seek_forward", 2, Date.now())).error, "invalid_batch");
    assert.equal((await f.bridge.batch("owner-a", ID1, 1, "seek_forward", 3, Date.now() - 2000)).error, "expired_intent");
    const pending = f.bridge.batch("owner-a", ID1, 1, "seek_backward", 6, Date.now());
    assert.equal((await f.bridge.batch("owner-a", ID2, 2, "seek_forward", 3, Date.now())).error, "busy");
    assert.equal((await f.bridge.command("owner-a", ID2, 2, "pause_toggle", Date.now())).error, "busy");
    await f.bridge.webSocketMessage(f.socket, JSON.stringify({ type: "batch_accepted", session,
      id: ID1, sequence: 1, accepted: true }));
    await pending;
    assert.equal((await f.bridge.cancelBatch("owner-b", ID1)).error, "no_session");
    assert.equal((await f.bridge.cancelBatch("owner-a", ID1)).state, "cancelling");
    assert.equal(f.sent.at(-1).type, "player_batch_cancel");
    await f.bridge.webSocketMessage(f.socket, JSON.stringify({ type: "batch_done", session,
      id: ID1, sequence: 1, state: "cancelled", acknowledged: 2, failures: 0 }));
    assert.equal((await f.bridge.batchStatus("owner-a", ID1)).acknowledged, 2);
    assert.equal((await f.bridge.batchStatus("owner-a", ID1)).state, "cancelled");
  } finally { f.dispose(); }
});

test("running batch survives Durable Object wake without replay, and socket loss ends session", async () => {
  const sent = [];
  const socket = {
    attachment: null,
    send(raw) { sent.push(JSON.parse(raw)); }, close() {},
    serializeAttachment(value) { this.attachment = structuredClone(value); },
    deserializeAttachment() { return structuredClone(this.attachment); },
  };
  const first = new PlayerBridge({ getWebSockets: () => [] }, {});
  first.controller = socket;
  first.persistSession();
  await first.open("owner-a");
  const session = first.session.id;
  await first.webSocketMessage(socket, JSON.stringify({ type: "session_ready", session, ready: true }));
  const pending = first.batch("owner-a", ID1, 1, "seek_forward", 30, Date.now());
  await first.webSocketMessage(socket, JSON.stringify({ type: "batch_accepted", session,
    id: ID1, sequence: 1, accepted: true }));
  await pending;
  await first.webSocketMessage(socket, JSON.stringify({ type: "batch_progress", session,
    id: ID1, sequence: 1, acknowledged: 8 }));
  clearTimeout(first.leaseTimer);
  const restored = new PlayerBridge({ getWebSockets: () => [socket] }, {});
  try {
    assert.equal((await restored.batchStatus("owner-a", ID1)).acknowledged, 8);
    assert.equal(sent.filter(value => value.type === "player_batch").length, 1);
    await restored.webSocketMessage(socket, JSON.stringify({ type: "batch_done", session,
      id: ID1, sequence: 1, state: "complete", acknowledged: 30, failures: 0 }));
    assert.equal((await restored.batchStatus("owner-a", ID1)).state, "complete");
    const second = restored.batch("owner-a", ID2, 2, "seek_forward", 60, Date.now());
    await restored.webSocketMessage(socket, JSON.stringify({ type: "batch_accepted", session,
      id: ID2, sequence: 2, accepted: true }));
    await second;
    restored.disconnect();
    assert.equal((await restored.batchStatus("owner-a", ID2)).error, "no_session");
    assert.equal(sent.filter(value => value.type === "player_batch" && value.id === ID2).length, 1);
  } finally { restored.disconnect(); }
});
