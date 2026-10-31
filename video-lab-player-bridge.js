import { DurableObject } from "cloudflare:workers";

const COMMANDS = new Set(["pause_toggle", "seek_backward", "seek_forward"]);
const LEASE_MS = 8000;
const ACK_MS = 2200;
const MAX_QUEUE = 8;
const SEEK_COUNTS = new Set([1, 3, 6, 12, 30, 60]);
const BATCH_MAX_MS = 90000; // finite operation lifetime, not a key-count limit

export class PlayerBridge extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.controller = null;
    this.session = null;
    this.pending = [];
    this.active = null;
    this.seekBatch = null;
    this.batchAcceptance = null;
    this.lastIds = new Map();
    this.leaseTimer = null;
    const sockets = ctx.getWebSockets?.() || [];
    if (sockets.length === 1) {
      const socket = sockets[0];
      let saved;
      try { saved = socket.deserializeAttachment?.(); }
      catch (_error) { socket.close(1012, "reconnect required"); return; }
      if (saved?.kind === "idle") {
        this.controller = socket;
      } else if (saved?.kind === "player" && saved.session
          && typeof saved.session.id === "string" && typeof saved.session.owner === "string"
          && Number.isSafeInteger(saved.session.expires)
          && Date.now() < saved.session.expires
          && Number.isSafeInteger(saved.session.sequence)) {
        // An active HTTP command prevents hibernation. Only settled session
        // metadata is restored; commands themselves are never replayed.
        this.controller = socket;
        this.session = saved.session;
        this.seekBatch = saved.seekBatch || null;
        this.armLease();
      } else {
        socket.close(1012, "reconnect required");
      }
    } else if (sockets.length) {
      for (const socket of sockets) socket.close(1012, "reconnect required");
    }
  }

  persistSession() {
    this.controller?.serializeAttachment?.(this.session
      ? { kind: "player", session: this.session, seekBatch: this.seekBatch } : { kind: "idle" });
  }

  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Unavailable", { status: 409 });
    }
    // The authenticated Pico reconnects only after its old socket fails or
    // misses a heartbeat. A half-open socket can remain registered here, so
    // replace it instead of rejecting recovery forever. Outstanding command
    // outcomes remain unknown and are never replayed.
    if (this.controller) this.disconnect();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    this.controller = server;
    this.persistSession();
    return new Response(null, { status: 101, webSocket: client });
  }

  live() {
    if (this.session && Date.now() >= this.session.expires) this.end("expired");
    return this.session;
  }

  armLease() {
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = setTimeout(() => {
      this.leaseTimer = null;
      if (this.session && Date.now() >= this.session.expires) this.end("expired");
    }, Math.max(1, this.session.expires - Date.now() + 1));
  }

  async open(owner) {
    if (!this.controller) return { error: "controller_offline" };
    const previous = this.live();
    if (previous || this.active || this.closingSession) return { error: "busy" };
    const id = crypto.randomUUID();
    this.session = { id, owner, expires: Date.now() + LEASE_MS, ready: false, sequence: 0 };
    this.lastIds.clear();
    this.seekBatch = null;
    this.persistSession();
    this.armLease();
    if (!this.send({ type: "player_session_open", session: id })) {
      return { error: "controller_offline" };
    }
    return { state: "preparing", expiresAt: this.session.expires };
  }

  async renew(owner) {
    const session = this.live();
    if (!session || session.owner !== owner) return { error: "no_session" };
    session.expires = Date.now() + LEASE_MS;
    this.persistSession();
    this.armLease();
    if (this.controller && !this.send({ type: "player_session_renew", session: session.id })) {
      return { error: "controller_offline" };
    }
    return { state: session.ready ? "ready" : "preparing", expiresAt: session.expires,
      serverNow: Date.now() };
  }

  async close(owner) {
    const session = this.live();
    if (session && session.owner === owner) this.end("closed");
    return { state: "closed" };
  }

  async status(owner) {
    const session = this.live();
    if (!session || session.owner !== owner) return { state: "closed" };
    return { state: session.ready && this.controller ? "ready" : "preparing",
      expiresAt: session.expires, queued: this.pending.length + (this.active ? 1 : 0),
      serverNow: Date.now() };
  }

  async batchStatus(owner, id) {
    const session = this.live();
    if (!session || session.owner !== owner) return { error: "no_session" };
    const batch = this.seekBatch;
    if (!batch || batch.id !== id) return { error: "unknown_batch" };
    if (batch.state === "running" || batch.state === "cancelling" || batch.state === "sent") {
      if (Date.now() >= batch.expiresAt) this.failBatch("outcome_unknown");
    }
    return this.batchView();
  }

  batchView() {
    const batch = this.seekBatch;
    return { id: batch.id, state: batch.state, count: batch.count,
      acknowledged: batch.acknowledged, failures: batch.failures,
      code: batch.code || null, metrics: batch.metrics || null };
  }

  failBatch(code) {
    if (!this.seekBatch || ["complete", "cancelled", "failed", "unknown"].includes(this.seekBatch.state)) return;
    this.seekBatch.state = "unknown";
    this.seekBatch.code = code;
    this.persistSession();
    if (this.batchAcceptance) {
      clearTimeout(this.batchAcceptance.timer);
      this.batchAcceptance.resolve({ error: code });
      this.batchAcceptance = null;
    }
    // The Pico stops its batch when this authenticated socket disappears.
    this.disconnect();
  }

  async batch(owner, id, sequence, command, count, issuedAt) {
    const session = this.live();
    if (!session || session.owner !== owner) return { error: "no_session" };
    if (!this.controller || !session.ready) return { error: "controller_offline" };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id || "")
        || (command !== "seek_forward" && command !== "seek_backward")
        || !SEEK_COUNTS.has(count) || !Number.isSafeInteger(sequence) || sequence < 1) return { error: "invalid_batch" };
    if (!Number.isSafeInteger(issuedAt) || Date.now() - issuedAt > 1000
        || issuedAt - Date.now() > 2000) return { error: "expired_intent" };
    if (this.lastIds.size >= 256) return { error: "session_limit" };
    if (this.lastIds.has(id)) return { error: "duplicate" };
    if (sequence !== session.sequence + 1) return { error: "sequence_gap" };
    if (this.active || this.pending.length || this.batchAcceptance
        || (this.seekBatch && ["sent", "running", "cancelling"].includes(this.seekBatch.state))) return { error: "busy" };
    session.sequence = sequence;
    this.lastIds.set(id, true);
    const deadlineAt = Math.min(issuedAt + 2500, Date.now() + 1200);
    const serverQueuedAt = Date.now();
    this.seekBatch = { id, sequence, command, count, queuedAt: serverQueuedAt,
      state: "sent", acknowledged: 0,
      failures: 0, expiresAt: Date.now() + BATCH_MAX_MS };
    this.persistSession();
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (this.batchAcceptance?.id === id) this.failBatch("outcome_unknown");
      }, ACK_MS);
      this.batchAcceptance = { id, resolve, timer };
      if (!this.send({ type: "player_batch", session: session.id, id, sequence,
        command, count, deadlineAt })) this.failBatch("controller_offline");
    });
  }

  async cancelBatch(owner, id) {
    const session = this.live();
    if (!session || session.owner !== owner) return { error: "no_session" };
    const batch = this.seekBatch;
    if (!batch || batch.id !== id) return { error: "unknown_batch" };
    if (["complete", "cancelled", "failed", "unknown"].includes(batch.state)) return this.batchView();
    batch.state = "cancelling";
    this.persistSession();
    if (!this.send({ type: "player_batch_cancel", session: session.id, id })) {
      return { error: "outcome_unknown" };
    }
    return this.batchView();
  }

  async command(owner, id, sequence, command, issuedAt) {
    const session = this.live();
    if (!session || session.owner !== owner) return { error: "no_session" };
    if (!this.controller) return { error: "controller_offline" };
    if (!COMMANDS.has(command) || typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
        || !Number.isSafeInteger(sequence) || sequence < 1) return { error: "invalid_command" };
    if (!Number.isSafeInteger(issuedAt) || Date.now() - issuedAt > 1000
        || issuedAt - Date.now() > 2000) return { error: "expired_intent" };
    if (this.lastIds.size >= 256) return { error: "session_limit" };
    if (this.lastIds.has(id)) return { error: "duplicate" };
    if (sequence !== session.sequence + 1) return { error: "sequence_gap" };
    if (this.seekBatch && ["sent", "running", "cancelling"].includes(this.seekBatch.state)) return { error: "busy" };
    if (this.pending.length + (this.active ? 1 : 0) >= MAX_QUEUE) return { error: "queue_full" };
    session.sequence = sequence;
    this.lastIds.set(id, true);
    this.persistSession();
    return new Promise(resolve => {
      this.pending.push({ id, sequence, command, session: session.id,
        deadlineAt: Math.min(issuedAt + 2500, Date.now() + 1200), resolve });
      this.pump();
    });
  }

  send(message) {
    try { this.controller.send(JSON.stringify(message)); return true; }
    catch (_error) { this.disconnect(); return false; }
  }

  pump() {
    if (this.active || !this.session?.ready || !this.controller || !this.pending.length) return;
    const item = this.pending.shift();
    if (Date.now() >= item.deadlineAt) {
      item.resolve({ error: "expired_intent" });
      this.pump();
      return;
    }
    this.active = item;
    item.timer = setTimeout(() => {
      if (this.active === item) {
        this.active = null;
        item.resolve({ error: "outcome_unknown" });
        // Never send a later key on a possibly stalled controller socket.
        this.disconnect();
      }
    }, ACK_MS);
    this.send({ type: "player_command", session: item.session, id: item.id,
      sequence: item.sequence, command: item.command, deadlineAt: item.deadlineAt });
  }

  end(reason) {
    const session = this.session;
    if (this.batchAcceptance) {
      clearTimeout(this.batchAcceptance.timer);
      this.batchAcceptance.resolve({ error: "outcome_unknown" });
      this.batchAcceptance = null;
    }
    if (this.seekBatch && ["sent", "running", "cancelling"].includes(this.seekBatch.state)) {
      this.seekBatch.state = "unknown";
      this.seekBatch.code = reason;
    }
    this.session = null;
    this.persistSession();
    if (this.leaseTimer) { clearTimeout(this.leaseTimer); this.leaseTimer = null; }
    if (session && this.controller && this.active) {
      // Let the one already-delivered key finish, but discard unsent keys.
      this.closingSession = session.id;
    } else if (session && this.controller) {
      this.send({ type: "player_session_close", session: session.id });
    }
    // A delivered command may already have reached the TV. Do not replay it.
    if (this.active && !this.controller) {
      clearTimeout(this.active.timer);
      this.active.resolve({ error: "outcome_unknown" });
      this.active = null;
    }
    for (const item of this.pending.splice(0)) item.resolve({ error: reason });
  }

  disconnect() {
    const socket = this.controller;
    this.controller = null;
    this.end("controller_offline");
    this.closingSession = null;
    try { socket?.close(1011, "connection lost"); } catch (_error) { /* already closed */ }
  }

  async webSocketMessage(socket, raw) {
    if (socket !== this.controller || typeof raw !== "string" || raw.length > 512) return;
    let value;
    try { value = JSON.parse(raw); } catch (_error) { return; }
    if (!value || typeof value !== "object") return;
    if (value.type === "bridge_heartbeat" && Number.isSafeInteger(value.nonce)
        && value.nonce >= 0 && value.nonce <= 0x7fffffff) {
      this.send({ type: "bridge_heartbeat_ack", nonce: value.nonce });
      return;
    }
    if (this.closingSession && this.active && value.type === "command_ack"
        && value.session === this.closingSession && value.id === this.active.id) {
      const item = this.active;
      clearTimeout(item.timer);
      this.active = null;
      item.resolve({ accepted: value.accepted === true, code: value.code === "accepted" ? "accepted" : "rejected" });
      this.send({ type: "player_session_close", session: this.closingSession });
      this.closingSession = null;
      return;
    }
    if (!this.live() || value.session !== this.session.id) return;
    if (value.type === "session_ready") {
      if (value.ready !== true) { this.end("tv_unavailable"); return; }
      this.session.ready = value.ready === true;
      this.persistSession();
      if (this.session.ready) this.pump();
    } else if (value.type === "command_ack" && this.active && value.id === this.active.id
        && value.sequence === this.active.sequence) {
      const item = this.active;
      clearTimeout(item.timer);
      this.active = null;
      item.resolve({ accepted: value.accepted === true, code: value.code === "accepted" ? "accepted" : "rejected" });
      this.pump();
    } else if (this.seekBatch && value.id === this.seekBatch.id
        && value.sequence === this.seekBatch.sequence) {
      const batch = this.seekBatch;
      if (value.type === "batch_accepted" && this.batchAcceptance?.id === batch.id) {
        clearTimeout(this.batchAcceptance.timer);
        const resolve = this.batchAcceptance.resolve;
        this.batchAcceptance = null;
        if (value.accepted === true) {
          batch.state = "running";
          this.persistSession();
          resolve({ accepted: true, id: batch.id, count: batch.count,
            serverQueuedAt: batch.queuedAt, serverAcceptedAt: Date.now() });
        } else {
          batch.state = "failed";
          batch.code = value.code || "rejected";
          this.persistSession();
          resolve({ error: batch.code });
        }
      } else if (value.type === "batch_progress" && ["running", "cancelling"].includes(batch.state)
          && Number.isInteger(value.acknowledged) && value.acknowledged >= batch.acknowledged
          && value.acknowledged <= batch.count) {
        batch.acknowledged = value.acknowledged;
        this.persistSession();
      } else if (value.type === "batch_done" && ["running", "cancelling"].includes(batch.state)
          && Number.isInteger(value.acknowledged) && value.acknowledged >= batch.acknowledged
          && value.acknowledged <= batch.count
          && ["complete", "cancelled", "failed", "unknown"].includes(value.state)) {
        batch.acknowledged = value.acknowledged;
        batch.failures = value.failures === 1 ? 1 : 0;
        batch.state = value.state;
        batch.code = typeof value.code === "string" ? value.code.slice(0, 48) : null;
        batch.metrics = value.metrics && typeof value.metrics === "object" ? value.metrics : null;
        this.persistSession();
      }
    }
  }

  async webSocketClose(socket) { if (socket === this.controller) this.disconnect(); }
  async webSocketError(socket) { if (socket === this.controller) this.disconnect(); }
}

export { COMMANDS, LEASE_MS };
