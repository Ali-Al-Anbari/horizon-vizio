// One durable command slot per TV. Every transition is a synchronous read/write
// of one SQLite-backed Durable Object KV value; no await can split a claim.
export const VERIFIED_APPS = Object.freeze([
  "youtube", "prime-video", "disney-plus", "live-tv", "plex",
]);

export const QUEUED_MS = 30_000;
export const PROCESSING_MS = 35_000;
export const RESULT_MS = 120_000;
export const COOLDOWN_MS = 12_000;

const KEY = "command_queue_v1";
const terminal = new Set(["verified", "failed", "expired"]);

function publicCommand(command) {
  return {
    id: command.id,
    app: command.app,
    state: command.state,
    code: command.code || null,
    queuedAt: command.queuedAt ?? null,
    claimedAt: command.claimedAt ?? null,
    finishedAt: command.finishedAt ?? null,
    elapsedMs: Number.isFinite(command.finishedAt) && Number.isFinite(command.queuedAt)
      ? command.finishedAt - command.queuedAt : null,
  };
}

export class CommandQueue {
  constructor(kv, now = () => Date.now(), newId = () => crypto.randomUUID()) {
    this.kv = kv;
    this.now = now;
    this.newId = newId;
  }

  read() {
    return this.kv.get(KEY) || { active: null, recent: [], cooldownUntil: 0 };
  }

  save(state) {
    this.kv.put(KEY, state);
  }

  reconcile() {
    const state = this.read();
    const now = this.now();
    let changed = false;
    if (state.active && now >= state.active.expiresAt) {
      const expiredAt = state.active.expiresAt;
      state.active.state = "expired";
      state.active.code = state.active.claimId ? "controller_timeout" : "controller_offline";
      state.active.finishedAt = expiredAt;
      delete state.active.claimId;
      state.recent.unshift(state.active);
      state.active = null;
      state.cooldownUntil = Math.max(state.cooldownUntil, expiredAt + COOLDOWN_MS);
      changed = true;
    }
    const kept = state.recent.filter(item => now < item.finishedAt + RESULT_MS).slice(0, 8);
    if (kept.length !== state.recent.length) {
      state.recent = kept;
      changed = true;
    }
    if (changed) this.save(state);
    return state;
  }

  enqueue(app, deviceId) {
    if (!VERIFIED_APPS.includes(app)) return { error: "unsupported_app" };
    if (!deviceId) return { error: "not_authorized" };
    const state = this.reconcile();
    if (state.active) {
      if (state.active.app === app && state.active.deviceId === deviceId) return { ...publicCommand(state.active), duplicate: true };
      return { error: "busy" };
    }
    if (this.now() < state.cooldownUntil) return { error: "cooldown" };
    const now = this.now();
    const command = {
      id: this.newId(), app, deviceId, state: "queued", code: null,
      queuedAt: now,
      expiresAt: now + QUEUED_MS,
    };
    state.active = command;
    this.save(state);
    return publicCommand(command);
  }

  claim() {
    const state = this.reconcile();
    if (!state.active || state.active.state !== "queued") return null;
    const command = state.active;
    command.state = "processing";
    command.claimedAt = this.now();
    command.claimId = this.newId();
    command.expiresAt = this.now() + PROCESSING_MS;
    this.save(state);
    return { id: command.id, app: command.app, claimId: command.claimId };
  }

  cancelQueuedByDevice(deviceId) {
    const state = this.reconcile();
    const command = state.active;
    if (!command || command.deviceId !== deviceId || command.state !== "queued") return false;
    command.state = "failed";
    command.code = "device_revoked";
    command.finishedAt = this.now();
    state.recent.unshift(command);
    state.recent = state.recent.slice(0, 8);
    state.active = null;
    state.cooldownUntil = this.now() + COOLDOWN_MS;
    this.save(state);
    return true;
  }

  report(id, claimId, outcome, code) {
    const state = this.reconcile();
    const command = state.active;
    if (!command || command.id !== id || command.state !== "processing" || command.claimId !== claimId) {
      return { error: "stale_claim" };
    }
    if (!terminal.has(outcome) || outcome === "expired") return { error: "invalid_result" };
    command.state = outcome;
    command.code = code;
    command.finishedAt = this.now();
    delete command.claimId;
    state.recent.unshift(command);
    state.recent = state.recent.slice(0, 8);
    state.active = null;
    state.cooldownUntil = this.now() + COOLDOWN_MS;
    this.save(state);
    return publicCommand(command);
  }

  status(id, deviceId) {
    const state = this.reconcile();
    const command = state.active?.id === id ? state.active : state.recent.find(item => item.id === id);
    return command && command.deviceId === deviceId ? publicCommand(command) : null;
  }

  nextDeadline() {
    const state = this.reconcile();
    const deadlines = [
      state.active?.expiresAt,
      ...state.recent.map(item => item.finishedAt + RESULT_MS),
    ].filter(Boolean);
    return deadlines.length ? Math.min(...deadlines) : null;
  }
}
