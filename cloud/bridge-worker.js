import { DurableObject } from "cloudflare:workers";
import { CommandQueue } from "./queue.js";
import { DevicePairing } from "./pairing.js";
import { lookupWithDiagnostic, startWithDiagnostic } from "./pairing-diagnostics.js";
import { handleApi } from "./api.js";

export class LaunchQueue extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.queue = new CommandQueue(ctx.storage.kv);
    this.pairing = new DevicePairing(ctx.storage.kv);
    this.objectTag = ctx.id.toString().slice(0, 12);
  }

  async schedule() {
    const next = [this.queue.nextDeadline(), this.pairing.nextDeadline()].filter(Boolean).sort((a, b) => a - b)[0];
    if (next) await this.ctx.storage.setAlarm(next);
  }

  async enqueue(app, sessionHash) {
    const device = this.pairing.authenticate(sessionHash);
    if (!device) return { error: "not_authorized" };
    const result = this.queue.enqueue(app, device.deviceId);
    await this.schedule();
    return result;
  }

  async claim() {
    const result = this.queue.claim();
    await this.schedule();
    return result;
  }

  async report(id, claimId, outcome, code) {
    const result = this.queue.report(id, claimId, outcome, code);
    await this.schedule();
    return result;
  }

  async status(id, sessionHash) {
    const device = this.pairing.authenticate(sessionHash);
    if (!device) return { error: "not_authorized" };
    const result = this.queue.status(id, device.deviceId);
    await this.schedule();
    return result;
  }

  async pairStart(pendingHash, codeHash, sourceKey, details, previousHash) {
    const result = startWithDiagnostic(this.pairing,
      [pendingHash, codeHash, sourceKey, details, previousHash], this.objectTag);
    await this.schedule();
    return result;
  }

  async pairLookup(codeHash) {
    return lookupWithDiagnostic(this.pairing, codeHash, this.objectTag);
  }
  async pairDecide(id, codeHash, decision) {
    const result = this.pairing.decide(id, codeHash, decision);
    await this.schedule();
    return result;
  }
  async pairPoll(pendingHash, sessionHash) {
    const result = this.pairing.poll(pendingHash, sessionHash);
    await this.schedule();
    return result;
  }
  async pairAuthenticate(sessionHash) { return this.pairing.authenticate(sessionHash); }
  async pairRotate(oldHash, newHash) { return this.pairing.rotate(oldHash, newHash); }
  async pairDevices() { return this.pairing.devices(); }
  async pairRevoke(id) {
    const result = this.pairing.revoke(id);
    if (result.revoked) this.queue.cancelQueuedByDevice(id);
    await this.schedule();
    return result;
  }

  async alarm() {
    this.queue.reconcile();
    this.pairing.reconcile();
    await this.schedule();
  }
}

export default {
  async fetch(request, env) {
    if (!new URL(request.url).pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }
    return handleApi(request, env);
  },
};
