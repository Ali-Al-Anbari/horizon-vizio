import { DurableObject } from "cloudflare:workers";
import { handleApi, verifyOwner } from "./api.js";
import { DevicePairing } from "./pairing.js";
import { allowedHosts, BrowserSessionManager, previewOrigin, validCommand } from "./browser-preview-core.js";
import { CloudflareBrowserEngine } from "./browser-preview-engine.js";
import { browserWriteAllowed, pairedBrowserDevice } from "./browser-preview-auth.js";

const SAFE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-origin" };

function json(status, value) {
  return new Response(JSON.stringify(value), { status, headers: { ...SAFE, "Content-Type": "application/json; charset=utf-8" } });
}

async function body(request) {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  let total = 0;
  const parts = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 2048) { await reader.cancel(); return null; }
    parts.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch (_error) { return null; }
}

function response(result) {
  if (result?.error) {
    const status = result.error === "not_authorized" ? 403
      : result.error === "session_expired" ? 410
        : ["session_busy", "session_owned_elsewhere", "stale_sequence", "action_unconfirmed"].includes(result.error) ? 409
        : result.error === "rate_limited" ? 429
          : ["browser_unavailable", "frame_unavailable"].includes(result.error) ? 503
            : result.error === "unsafe_browser_result" ? 502 : 400;
    return json(status, { code: result.error, expectedSeq: result.expectedSeq, seq: result.seq });
  }
  if (result?.frame) {
    const headers = { ...SAFE, "Content-Type": "image/jpeg", "X-Browser-Seq": String(result.seq),
      "X-Browser-Action-Ms": String(result.timings?.actionMs ?? 0),
      "X-Browser-Capture-Ms": String(result.timings?.captureMs ?? 0),
      "X-Browser-Bytes": String(result.frame.byteLength) };
    return new Response(result.frame, { status: 200, headers });
  }
  return json(200, result);
}

function timedResponse(result, receivedAt, waitMs) {
  const reply = response(result);
  reply.headers.set("X-Browser-Queue-Ms", String(waitMs));
  reply.headers.set("X-Browser-Handler-Ms", String(Math.max(0, Math.round(performance.now() - receivedAt))));
  return reply;
}

export class BrowserCoordinator extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.pairing = new DevicePairing(ctx.storage.kv);
    this.browser = new BrowserSessionManager(ctx.storage.kv,
      new CloudflareBrowserEngine(env.BROWSER, allowedHosts(env.BROWSER_PREVIEW_ORIGIN)), env.BROWSER_PREVIEW_ORIGIN);
  }

  async schedule() {
    const next = [this.pairing.nextDeadline(), this.browser.deadline()].filter(Boolean).sort((a, b) => a - b)[0];
    if (next) await this.ctx.storage.setAlarm(next);
  }
  async pairStart(...args) { const result = this.pairing.start(...args); await this.schedule(); return result; }
  async pairLookup(...args) { return this.pairing.lookup(...args); }
  async pairDecide(...args) { const result = this.pairing.decide(...args); await this.schedule(); return result; }
  async pairPoll(...args) { const result = this.pairing.poll(...args); await this.schedule(); return result; }
  async pairAuthenticate(...args) { return this.pairing.authenticate(...args); }
  async pairRotate(...args) { return this.pairing.rotate(...args); }
  async pairDevices() { return this.pairing.devices(); }
  async pairRevoke(id) {
    const result = this.pairing.revoke(id);
    if (result.revoked) await this.browser.enqueue(() => this.browser.revoke(id));
    await this.schedule();
    return result;
  }
  async alarm() {
    this.pairing.reconcile();
    await this.browser.enqueue(() => this.browser.expire());
    await this.schedule();
  }
  async adminTerminate() {
    await this.browser.enqueue(() => this.browser.close());
    await this.schedule();
    return { active: false };
  }

  async fetch(request) {
    const receivedAt = performance.now();
    const url = new URL(request.url);
    const path = url.pathname;
    const allowed = {
      "/api/browser/session": ["POST", "DELETE"],
      "/api/browser/status": ["GET"],
      "/api/browser/frame": ["GET"],
      "/api/browser/navigate": ["POST"],
      "/api/browser/input": ["POST"],
    };
    if (!allowed[path]?.includes(request.method)) return json(404, { code: "not_found" });
    if (request.method !== "GET" && !browserWriteAllowed(request, url.origin))
      return json(403, { code: "invalid_origin" });
    const deviceId = await pairedBrowserDevice(request, this.pairing);
    if (!deviceId) return json(403, { code: "not_authorized" });
    if (request.method === "POST") {
      const parsed = await body(request);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json(400, { code: "invalid_request" });
      if (path === "/api/browser/session" && (Array.isArray(parsed) || Object.keys(parsed).length))
        return json(400, { code: "invalid_request" });
      if (path === "/api/browser/navigate" && Object.keys(parsed).sort().join(",") !== "seq,url")
        return json(400, { code: "invalid_request" });
      if (path === "/api/browser/input" && parsed.url !== undefined)
        return json(400, { code: "invalid_request" });
      const command = path === "/api/browser/session" ? null : validCommand(parsed, this.browser.origin);
      if (path !== "/api/browser/session" && !command) return json(400, { code: "invalid_command" });
      const queuedAt = performance.now();
      return this.browser.enqueue(async () => {
        const waitMs = Math.max(0, Math.round(performance.now() - queuedAt));
        const result = path === "/api/browser/session" ? await this.browser.start(deviceId)
          : await this.browser.perform(deviceId, command);
        await this.schedule();
        return timedResponse(result, receivedAt, waitMs);
      });
    }
    const queuedAt = performance.now();
    return this.browser.enqueue(async () => {
      const waitMs = Math.max(0, Math.round(performance.now() - queuedAt));
      const result = path === "/api/browser/status" ? await this.browser.status(deviceId)
        : path === "/api/browser/frame" ? await this.browser.frame(deviceId)
          : await this.browser.end(deviceId);
      await this.schedule();
      return timedResponse(result, receivedAt, waitMs);
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/owner/browser/terminate" && request.method === "POST") {
      if (!browserWriteAllowed(request, url.origin, "browser-admin"))
        return json(403, { code: "invalid_origin" });
      if (!env.TEAM_DOMAIN || !env.ACCESS_AUD || !env.OWNER_EMAIL || !(await verifyOwner(request, env)))
        return json(403, { code: "not_authorized" });
      const stub = env.BROWSER_COORDINATOR.get(env.BROWSER_COORDINATOR.idFromName("primary-tv"));
      return json(200, await stub.adminTerminate());
    }
    if (url.pathname.startsWith("/api/pair/") || url.pathname.startsWith("/api/owner/")) {
      return handleApi(request, { ...env, LAUNCH_QUEUE: env.BROWSER_COORDINATOR, PAIRING_ONLY: true });
    }
    if (url.pathname.startsWith("/api/browser/")) {
      if (!previewOrigin(env.BROWSER_PREVIEW_ORIGIN) || url.origin !== previewOrigin(env.BROWSER_PREVIEW_ORIGIN))
        return json(503, { code: "preview_origin_unconfigured" });
      return env.BROWSER_COORDINATOR.get(env.BROWSER_COORDINATOR.idFromName("primary-tv")).fetch(request);
    }
    if (url.pathname.startsWith("/api/")) return json(404, { code: "not_found" });
    if (url.pathname === "/owner") {
      const assetUrl = new URL(request.url);
      assetUrl.pathname = "/owner.html";
      return env.ASSETS.fetch(new Request(assetUrl, request));
    }
    if (url.pathname === "/") {
      return Response.redirect(`${url.origin}/browser-cloud-lab.html`, 302);
    }
    if (url.pathname === "/browser-cloud-lab.html") {
      const asset = await env.ASSETS.fetch(request);
      const guarded = new Response(asset.body, asset);
      guarded.headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      guarded.headers.set("X-Frame-Options", "DENY");
      guarded.headers.set("Referrer-Policy", "no-referrer");
      return guarded;
    }
    return env.ASSETS.fetch(request);
  },
};
