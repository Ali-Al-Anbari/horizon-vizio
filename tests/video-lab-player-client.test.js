import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";

const script = readFileSync(new URL("../video-lab/player-bridge-client.js", import.meta.url), "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(respond) {
  const calls = [];
  const timers = new Map();
  let next = 1;
  const clock = {
    crypto: webcrypto,
    setTimeout(fn, ms) { const id = next++; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const fetch = async (path, options) => {
    calls.push({ path, options });
    const result = await respond(path, options);
    return { ok: result.ok !== false, json: async () => result.data || {} };
  };
  runInNewContext(script, { window: clock, fetch, Promise, Uint8Array, Date });
  return { adapter: clock.HorizonPlayerBridge.create(clock), calls, timers,
    fire(ms) { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); } } };
}

test("only a visible session opens, renews, sends distinct commands and closes", async () => {
  const f = fixture(async path => ({ data: path.endsWith("/status") ? { state: "ready" } : { accepted: true } }));
  await f.adapter.open();
  await f.adapter.send("seek_forward");
  await f.adapter.send("seek_forward");
  const commands = f.calls.filter(call => call.path.endsWith("/command"));
  assert.equal(commands.length, 2);
  const first = JSON.parse(commands[0].options.body);
  const second = JSON.parse(commands[1].options.body);
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.notEqual(first.id, second.id);
  f.fire(2000);
  await flush();
  assert.equal(f.calls.some(call => call.path.endsWith("/renew")), true);
  await f.adapter.close();
  assert.equal(f.calls.at(-1).path, "/api/player/close");
  assert.equal(f.timers.size, 0);
});

test("command failure closes session and never resubmits ambiguous key", async () => {
  const f = fixture(async path => path.endsWith("/command")
    ? { ok: false, data: { error: "outcome_unknown" } }
    : { data: path.endsWith("/status") ? { state: "ready" } : {} });
  await f.adapter.open();
  await assert.rejects(f.adapter.send("pause_toggle"), /outcome_unknown/);
  await flush();
  assert.equal(f.calls.filter(call => call.path.endsWith("/command")).length, 1);
  assert.equal(f.calls.some(call => call.path.endsWith("/close")), true);
});

test("close during slow preparation eventually closes the server session", async () => {
  let resolveOpen;
  const f = fixture(async path => {
    if (path.endsWith("/open")) return new Promise(resolve => { resolveOpen = resolve; });
    return { data: {} };
  });
  const opening = f.adapter.open();
  await flush();
  const closing = f.adapter.close();
  resolveOpen({ data: { state: "preparing" } });
  await assert.rejects(opening, /session_closed/);
  await closing;
  assert.equal(f.calls.at(-1).path, "/api/player/close");
});

test("close does not wait for an unanswered readiness status request", async () => {
  let resolveStatus;
  const f = fixture(async path => {
    if (path.endsWith("/status")) return new Promise(resolve => { resolveStatus = resolve; });
    return { data: { state: "preparing" } };
  });
  const opening = f.adapter.open();
  await flush();
  assert.equal(typeof resolveStatus, "function");
  await f.adapter.close();
  assert.equal(f.calls.at(-1).path, "/api/player/close");
  resolveStatus({ data: { state: "preparing" } });
  await assert.rejects(opening, /session_closed/);
});

test("command intent uses bridge time when TV wall clock differs", async () => {
  const offset = 60_000;
  const f = fixture(async path => ({ data: path.endsWith("/status")
    ? { state: "ready", serverNow: Date.now() + offset } : { accepted: true } }));
  await f.adapter.open();
  await f.adapter.send("seek_backward");
  const command = JSON.parse(f.calls.find(call => call.path.endsWith("/command")).options.body);
  assert.ok(Math.abs(command.issuedAt - (Date.now() + offset)) < 1000);
  await f.adapter.close();
});

test("one seek batch POST carries count and uses separate status and cancellation routes", async () => {
  const f = fixture(async path => ({ data: path.endsWith("/status") ? { state: "ready" }
    : path.endsWith("/batch") ? { accepted: true, id: "batch-id", count: 30 }
      : path.includes("/batch/status") ? { state: "running", acknowledged: 8 }
        : { state: "cancelling" } }));
  await f.adapter.open();
  const result = await f.adapter.sendBatch("seek_forward", 30);
  assert.equal(result.count, 30);
  const commands = f.calls.filter(call => call.path.endsWith("/batch"));
  assert.equal(commands.length, 1);
  assert.equal(JSON.parse(commands[0].options.body).count, 30);
  assert.equal(JSON.parse(commands[0].options.body).sequence, 1);
  assert.equal((await f.adapter.batchStatus("batch-id")).acknowledged, 8);
  await f.adapter.cancelBatch("batch-id");
  assert.equal(f.calls.filter(call => call.path.endsWith("/batch/cancel")).length, 1);
  await f.adapter.close();
});

test("uncertain batch acceptance is never resubmitted", async () => {
  const f = fixture(async path => path.endsWith("/batch")
    ? { ok: false, data: { error: "outcome_unknown" } }
    : { data: path.endsWith("/status") ? { state: "ready" } : {} });
  await f.adapter.open();
  await assert.rejects(f.adapter.sendBatch("seek_forward", 60), /outcome_unknown/);
  await flush();
  assert.equal(f.calls.filter(call => call.path.endsWith("/batch")).length, 1);
  assert.equal(f.calls.some(call => call.path.endsWith("/close")), true);
});
