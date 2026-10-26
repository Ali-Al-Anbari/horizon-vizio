import { handleApi } from "./cloud/api.js";
import { LaunchQueue } from "./cloud/bridge-worker.js";
import { PlayerBridge } from "./video-lab-player-bridge.js";

export { LaunchQueue, PlayerBridge };

const COOKIE = "__Host-horizon_session";
const COMMANDS = new Set(["pause_toggle", "seek_backward", "seek_forward"]);
const SEEK_COUNTS = new Set([1, 3, 6, 12, 30, 60]);

function json(status, value) {
  return new Response(JSON.stringify(value), { status, headers: {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
  } });
}

function pairedCookie(request) {
  const item = (request.headers.get("cookie") || "").split(";").map(s => s.trim())
    .find(s => s.startsWith(COOKIE + "="));
  const value = item?.slice(COOKIE.length + 1);
  return value && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

async function sha256(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function sameSecret(left, right) {
  if (!left || !right || right.length < 32) return false;
  const a = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)));
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)));
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

async function body(request) {
  if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") throw Error();
  if (Number(request.headers.get("content-length") || 0) > 256) throw Error();
  const reader = request.body?.getReader();
  if (!reader) throw Error();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 256) { await reader.cancel(); throw Error(); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function exact(value, names) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join() === names.slice().sort().join();
}

export async function playerApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path.startsWith("/api/pair/") || path.startsWith("/api/owner/")) {
    return handleApi(request, { ...env, PAIRING_ONLY: true });
  }
  if (!path.startsWith("/api/player/")) return json(404, { code: "not_found" });
  if (!env.LAUNCH_QUEUE || !env.PLAYER_BRIDGE || !env.PLAYER_BRIDGE_TOKEN) {
    return json(503, { code: "bridge_unconfigured" });
  }
  const bridge = env.PLAYER_BRIDGE.get(env.PLAYER_BRIDGE.idFromName("single-tv"));
  if (path === "/api/player/connect") {
    const bearer = /^Bearer (.+)$/.exec(request.headers.get("authorization") || "");
    if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket"
        || !(await sameSecret(bearer?.[1], env.PLAYER_BRIDGE_TOKEN))) {
      return json(403, { code: "not_authorized" });
    }
    return bridge.fetch(request);
  }
  const cookie = pairedCookie(request);
  if (!cookie) return json(403, { code: "not_authorized" });
  const owner = (await env.LAUNCH_QUEUE.get(env.LAUNCH_QUEUE.idFromName("primary-tv"))
    .pairAuthenticate(await sha256(cookie)))?.deviceId;
  if (!owner) return json(403, { code: "not_authorized" });
  if (path === "/api/player/status" && request.method === "GET") {
    return json(200, await bridge.status(owner));
  }
  if (path === "/api/player/batch/status" && request.method === "GET") {
    return json(200, await bridge.batchStatus(owner, url.searchParams.get("id")));
  }
  if (request.method !== "POST" || request.headers.get("origin") !== url.origin
      || request.headers.get("x-horizon-action") !== "player") {
    return json(403, { code: "invalid_origin" });
  }
  let data;
  try { data = await body(request); } catch (_error) { return json(400, { code: "invalid_request" }); }
  let result;
  if (path === "/api/player/open" && exact(data, [])) result = await bridge.open(owner);
  else if (path === "/api/player/renew" && exact(data, [])) result = await bridge.renew(owner);
  else if (path === "/api/player/close" && exact(data, [])) result = await bridge.close(owner);
  else if (path === "/api/player/command" && exact(data, ["id", "sequence", "command", "issuedAt"])
      && COMMANDS.has(data.command)) result = await bridge.command(owner, data.id, data.sequence, data.command, data.issuedAt);
  else if (path === "/api/player/batch" && exact(data, ["id", "sequence", "command", "count", "issuedAt"])
      && (data.command === "seek_forward" || data.command === "seek_backward")
      && SEEK_COUNTS.has(data.count)) result = await bridge.batch(owner, data.id, data.sequence, data.command, data.count, data.issuedAt);
  else if (path === "/api/player/batch/cancel" && exact(data, ["id"])) result = await bridge.cancelBatch(owner, data.id);
  else return json(400, { code: "invalid_request" });
  return json(result.error ? 409 : 200, result);
}
