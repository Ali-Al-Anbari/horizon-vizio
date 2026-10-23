// All state transitions happen synchronously inside one Durable Object instance.
// Browser secrets are stored only as hashes. A lost session delivery requires
// pairing again; the approved code cannot be used twice.
export const PAIR_MS = 5 * 60_000;
export const SESSION_MS = 7 * 24 * 60 * 60_000;
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60_000;
export const ROTATE_AFTER_MS = 24 * 60 * 60_000;
const START_WINDOW_MS = 10 * 60_000;
const LOOKUP_WINDOW_MS = 5 * 60_000;
const KEY = "device_pairing_v1";

export class DevicePairing {
  constructor(kv, now = () => Date.now(), newId = () => crypto.randomUUID()) {
    this.kv = kv;
    this.now = now;
    this.newId = newId;
  }

  read() {
    return this.kv.get(KEY) || { pending: [], devices: [], starts: [], lookups: [] };
  }

  save(state) { this.kv.put(KEY, state); }

  reconcile() {
    const state = this.read();
    const now = this.now();
    const pending = state.pending.filter(item => now < item.expiresAt);
    const devices = state.devices.filter(item => now < item.maxExpiresAt);
    const starts = state.starts.filter(item => now - item.at < START_WINDOW_MS);
    const lookups = state.lookups.filter(at => now - at < LOOKUP_WINDOW_MS);
    if (pending.length !== state.pending.length || devices.length !== state.devices.length
      || starts.length !== state.starts.length || lookups.length !== state.lookups.length) {
      Object.assign(state, { pending, devices, starts, lookups });
      this.save(state);
    }
    return state;
  }

  start(pendingHash, codeHash, sourceKey, details, previousHash) {
    const state = this.reconcile();
    const now = this.now();
    if (state.starts.length >= 30 || state.starts.filter(item => item.sourceKey === sourceKey).length >= 5) {
      return { error: "rate_limited" };
    }
    if (previousHash) state.pending = state.pending.filter(item => item.pendingHash !== previousHash);
    if (state.pending.length >= 8) return { error: "pairing_busy" };
    if (state.pending.some(item => item.codeHash === codeHash || item.pendingHash === pendingHash)) {
      return { error: "collision" };
    }
    const item = {
      id: this.newId(), pendingHash, codeHash, sourceKey,
      details: { label: "Horizon on Vizio (claimed)", userAgent: String(details.userAgent || "").slice(0, 120) },
      createdAt: now, expiresAt: now + PAIR_MS, state: "pending",
    };
    state.pending.push(item);
    state.starts.push({ at: now, sourceKey });
    this.save(state);
    return { id: item.id, expiresAt: item.expiresAt };
  }

  lookup(codeHash) {
    const state = this.reconcile();
    if (state.lookups.length >= 20) return { error: "rate_limited" };
    state.lookups.push(this.now());
    this.save(state);
    const item = state.pending.find(value => value.codeHash === codeHash && value.state === "pending");
    return item ? {
      id: item.id, details: item.details, createdAt: item.createdAt, expiresAt: item.expiresAt,
    } : { error: "code_unavailable" };
  }

  decide(id, codeHash, decision) {
    const state = this.reconcile();
    const item = state.pending.find(value => value.id === id && value.codeHash === codeHash);
    if (!item || item.state !== "pending") return { error: "code_unavailable" };
    if (decision === "reject") {
      item.state = "rejected";
      this.save(state);
      return { state: "rejected" };
    }
    if (decision !== "approve") return { error: "invalid_decision" };
    if (state.devices.filter(device => !device.revoked && this.now() < device.expiresAt).length >= 4) {
      return { error: "device_limit" };
    }
    item.state = "approved";
    this.save(state);
    return { state: "approved" };
  }

  poll(pendingHash, sessionHash) {
    const state = this.reconcile();
    const item = state.pending.find(value => value.pendingHash === pendingHash);
    if (!item) return { state: "expired" };
    if (item.state === "approved") {
      if (!sessionHash) return { state: "approved" };
      const now = this.now();
      const device = {
        id: this.newId(), label: item.details.label, approvedAt: now,
        expiresAt: now + SESSION_MS, maxExpiresAt: now + SESSION_ABSOLUTE_MS,
        rotatedAt: now, sessionHash, revoked: false,
      };
      state.devices.push(device);
      item.state = "consumed";
      item.pendingHash = null;
      this.save(state);
      return { state: "paired", deviceId: device.id, expiresAt: device.expiresAt };
    }
    return { state: item.state, expiresAt: item.expiresAt };
  }

  authenticate(sessionHash) {
    const state = this.reconcile();
    const now = this.now();
    const device = state.devices.find(value => value.sessionHash === sessionHash
      && !value.revoked && now < value.expiresAt);
    return device ? {
      deviceId: device.id, expiresAt: device.expiresAt,
      rotationDue: now - device.rotatedAt >= ROTATE_AFTER_MS,
    } : null;
  }

  rotate(oldHash, newHash) {
    if (oldHash === newHash) return { error: "invalid_rotation" };
    const state = this.reconcile();
    const now = this.now();
    const device = state.devices.find(value => value.sessionHash === oldHash
      && !value.revoked && now < value.expiresAt);
    if (!device) return { error: "session_expired" };
    if (now - device.rotatedAt < ROTATE_AFTER_MS) return { error: "rotation_not_due" };
    device.sessionHash = newHash;
    device.rotatedAt = now;
    device.expiresAt = Math.min(now + SESSION_MS, device.maxExpiresAt);
    this.save(state);
    return { deviceId: device.id, expiresAt: device.expiresAt };
  }

  devices() {
    return this.reconcile().devices.map(({ id, label, approvedAt, expiresAt, revoked }) =>
      ({ id, label, approvedAt, expiresAt, revoked }));
  }

  revoke(id) {
    const state = this.reconcile();
    const device = state.devices.find(value => value.id === id);
    if (!device || device.revoked) return { error: "device_unavailable" };
    device.revoked = true;
    device.sessionHash = null;
    this.save(state);
    return { revoked: true, id };
  }

  nextDeadline() {
    const state = this.reconcile();
    const deadlines = [
      ...state.pending.map(item => item.expiresAt),
      ...state.devices.map(item => item.maxExpiresAt),
    ];
    return deadlines.length ? Math.min(...deadlines) : null;
  }
}
