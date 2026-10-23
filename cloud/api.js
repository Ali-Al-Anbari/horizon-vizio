import { VERIFIED_APPS } from "./queue.js";
import { verifyOwner } from "./access.js";
export { verifyOwner } from "./access.js";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESULT_CODES = new Set(["app_confirmed", "tv_rejected", "tv_unconfirmed", "tv_unavailable", "controller_error"]);
const PENDING_COOKIE = "__Host-horizon_pending";
const SESSION_COOKIE = "__Host-horizon_session";
const CODE = /^[A-HJ-NP-Z2-9]{10}$/;

function randomSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function randomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, byte => alphabet[byte & 31]).join("");
}

async function hash(value) {
  if (!value) return null;
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function cookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  const pair = raw.split(";").map(value => value.trim()).find(value => value.startsWith(`${name}=`));
  const value = pair?.slice(name.length + 1);
  return value && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

function setCookie(response, name, value, age) {
  response.headers.append("Set-Cookie", `${name}=${value}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Strict`);
  return response;
}

function browserWrite(request, url, action) {
  return request.headers.get("origin") === url.origin && request.headers.get("x-horizon-action") === action;
}

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

async function smallJson(request, maxBytes = 256) {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new Error("invalid_content_type");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new Error("empty_body");
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error("body_too_large");
    }
    chunks.push(value);
  }
  const raw = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
}

function exactShape(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function queueStub(env) {
  return env.LAUNCH_QUEUE.get(env.LAUNCH_QUEUE.idFromName("primary-tv"));
}

async function sameSecret(presented, expected) {
  if (!presented || !expected || expected.length < 32) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let different = 0;
  for (let index = 0; index < a.length; index++) different |= a[index] ^ b[index];
  return different === 0;
}

export async function handleApi(request, env, options = {}) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!env.LAUNCH_QUEUE) return json(503, { state: "failed", code: "queue_unavailable" });
  if (env.PAIRING_ONLY && (path.startsWith("/api/apps/") || path.startsWith("/api/controller/"))) {
    return json(404, { state: "failed", code: "not_found" });
  }
  const queue = queueStub(env);

  if (path === "/api/pair/start" && request.method === "POST") {
    if (!browserWrite(request, url, "pair")) return json(403, { code: "invalid_origin" });
    const pending = randomSecret();
    const code = randomCode();
    const sourceKey = await hash(request.headers.get("cf-connecting-ip") || "local-test");
    const result = await queue.pairStart(await hash(pending), await hash(code), sourceKey,
      { userAgent: request.headers.get("user-agent") }, await hash(cookie(request, PENDING_COOKIE)));
    if (result.error) return json(result.error === "rate_limited" ? 429 : 409, { code: result.error });
    return setCookie(json(201, { state: "pending", code, expiresAt: result.expiresAt,
      pairingUrl: `${url.origin}/owner` }), PENDING_COOKIE, pending, 300);
  }

  if (path === "/api/pair/status" && request.method === "POST") {
    if (!browserWrite(request, url, "pair")) return json(403, { code: "invalid_origin" });
    const pending = cookie(request, PENDING_COOKIE);
    if (!pending) return json(200, { state: "unpaired" });
    const session = randomSecret();
    const result = await queue.pairPoll(await hash(pending), await hash(session));
    if (result.state !== "paired") return json(200, result);
    const response = setCookie(json(200, { state: "paired", expiresAt: result.expiresAt }),
      SESSION_COOKIE, session, 7 * 24 * 60 * 60);
    return setCookie(response, PENDING_COOKIE, "", 0);
  }

  if (path === "/api/pair/session" && request.method === "GET") {
    const presented = cookie(request, SESSION_COOKIE);
    if (!presented) return json(401, { state: "unpaired", code: "not_authorized" });
    const sessionHash = await hash(presented);
    const result = await queue.pairAuthenticate(sessionHash);
    if (!result) return setCookie(json(401, { state: "unpaired", code: "not_authorized" }), SESSION_COOKIE, "", 0);
    return json(200, { state: "paired", expiresAt: result.expiresAt, rotationDue: result.rotationDue });
  }

  if (path === "/api/pair/rotate" && request.method === "POST") {
    if (!browserWrite(request, url, "pair")) return json(403, { code: "invalid_origin" });
    const presented = cookie(request, SESSION_COOKIE);
    if (!presented) return json(401, { state: "unpaired", code: "not_authorized" });
    const sessionHash = await hash(presented);
    if (!(await queue.pairAuthenticate(sessionHash))) return json(401, { state: "unpaired", code: "not_authorized" });
    const rotated = randomSecret();
    const renewal = await queue.pairRotate(sessionHash, await hash(rotated));
    if (renewal.error) return json(401, { state: "unpaired", code: "not_authorized" });
    return setCookie(json(200, { state: "paired", expiresAt: renewal.expiresAt }),
      SESSION_COOKIE, rotated, 7 * 24 * 60 * 60);
  }

  if (path.startsWith("/api/owner/")) {
    if (!env.TEAM_DOMAIN || !env.ACCESS_AUD || !env.OWNER_EMAIL) {
      return json(503, { code: "authorization_unconfigured" });
    }
    if (!(await verifyOwner(request, env, options.jwks))) return json(403, { code: "not_authorized" });
    if (path === "/api/owner/devices" && request.method === "GET") {
      return json(200, { devices: await queue.pairDevices() });
    }
    if (!browserWrite(request, url, "owner-pair")) return json(403, { code: "invalid_origin" });
    let body;
    try { body = await smallJson(request, 128); }
    catch (_error) { return json(400, { code: "invalid_request" }); }
    if (path === "/api/owner/lookup" && request.method === "POST") {
      if (!exactShape(body, ["code"]) || typeof body.code !== "string" || !CODE.test(body.code)) {
        return json(400, { code: "invalid_code" });
      }
      const result = await queue.pairLookup(await hash(body.code));
      return result.error ? json(result.error === "rate_limited" ? 429 : 404, { code: result.error }) : json(200, result);
    }
    if (path === "/api/owner/decide" && request.method === "POST") {
      if (!exactShape(body, ["id", "code", "decision"]) || !ID.test(body.id)
        || typeof body.code !== "string" || !CODE.test(body.code)
        || !["approve", "reject"].includes(body.decision)) return json(400, { code: "invalid_request" });
      const result = await queue.pairDecide(body.id, await hash(body.code), body.decision);
      return result.error ? json(409, { code: result.error }) : json(200, result);
    }
    if (path === "/api/owner/revoke" && request.method === "POST") {
      if (!exactShape(body, ["id"]) || !ID.test(body.id)) return json(400, { code: "invalid_request" });
      const result = await queue.pairRevoke(body.id);
      return result.error ? json(404, { code: result.error }) : json(200, result);
    }
    return json(404, { code: "not_found" });
  }

  if (path === "/api/apps/launch" || /^\/api\/apps\/commands\/[0-9a-f-]+$/i.test(path)) {
    const presented = cookie(request, SESSION_COOKIE);
    if (!presented || !(await queue.pairAuthenticate(await hash(presented)))) {
      return json(403, { state: "failed", code: "not_authorized" });
    }
    if (!env.CONTROLLER_TOKEN || env.CONTROLLER_TOKEN.length < 32) {
      return json(503, { state: "failed", code: "controller_unconfigured" });
    }
    const sessionHash = await hash(presented);
    if (path === "/api/apps/launch" && request.method === "POST") {
      if (!browserWrite(request, url, "launch-app")) {
        return json(403, { state: "failed", code: "invalid_origin" });
      }
      let body;
      try { body = await smallJson(request, 128); }
      catch (_error) { return json(400, { state: "failed", code: "invalid_request" }); }
      if (!exactShape(body, ["app"]) || typeof body.app !== "string" || !VERIFIED_APPS.includes(body.app)) {
        return json(400, { state: "failed", code: "unsupported_app" });
      }
      if (env.STAGING_YOUTUBE_ONLY && body.app !== "youtube") {
        return json(403, { state: "failed", code: "staging_app_disabled" });
      }
      const result = await queue.enqueue(body.app, sessionHash);
      if (result.error) return json(result.error === "not_authorized" ? 403
        : result.error === "busy" || result.error === "cooldown" ? 409 : 400,
        { state: "failed", code: result.error });
      return json(202, result);
    }
    const match = /^\/api\/apps\/commands\/([0-9a-f-]+)$/i.exec(path);
    if (match && request.method === "GET" && ID.test(match[1])) {
      const result = await queue.status(match[1], sessionHash);
      if (result?.error === "not_authorized") return json(403, { state: "failed", code: "not_authorized" });
      return result ? json(200, result) : json(404, { state: "expired", code: "result_unavailable" });
    }
    return json(405, { state: "failed", code: "method_not_allowed" });
  }

  if (path === "/api/controller/claim" || path === "/api/controller/result") {
    const bearer = /^Bearer (.+)$/.exec(request.headers.get("authorization") || "");
    if (!bearer || !(await sameSecret(bearer[1], env.CONTROLLER_TOKEN))) {
      return json(403, { state: "failed", code: "not_authorized" });
    }
    if (request.method !== "POST") return json(405, { state: "failed", code: "method_not_allowed" });
    if (path.endsWith("/claim")) {
      const command = await queueStub(env).claim();
      return command ? json(200, command) : new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    }
    let body;
    try { body = await smallJson(request); }
    catch (_error) { return json(400, { state: "failed", code: "invalid_request" }); }
    if (!exactShape(body, ["id", "claimId", "outcome", "code"])
      || !ID.test(body.id) || !ID.test(body.claimId)
      || !["verified", "failed"].includes(body.outcome)
      || !RESULT_CODES.has(body.code)
      || (body.outcome === "verified") !== (body.code === "app_confirmed")) {
      return json(400, { state: "failed", code: "invalid_result" });
    }
    const result = await queueStub(env).report(body.id, body.claimId, body.outcome, body.code);
    return result.error ? json(409, { state: "failed", code: result.error }) : json(200, result);
  }

  return json(404, { state: "failed", code: "not_found" });
}
