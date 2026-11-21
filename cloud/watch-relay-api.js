import { smallJson } from "./api.js";
import { browserWriteAllowed, pairedBrowserDevice } from "./browser-preview-auth.js";

const RELAY_ORIGIN = "https://horizon.129-213-139-127.sslip.io";
const EPISODES = new Set(["fakhr-el-delta-s01e01"]);
const TICKET = /^[A-Za-z0-9_-]{1,1536}\.[A-Za-z0-9_-]{43}$/;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RAY_ID = /^[a-f0-9]{16}(?:-[a-z]{3})?$/i;

function logTicketFailure(request, category, status) {
  const event = { event: "watch_relay_ticket_failure", category };
  if (Number.isInteger(status) && status >= 100 && status <= 599) event.upstreamStatus = status;
  const rayId = request.headers.get("cf-ray");
  if (rayId && RAY_ID.test(rayId)) event.rayId = rayId;
  console.warn(event);
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  } });
}

function relayConfigured(env) {
  return env.AKWAM_RELAY_ENABLED === "true"
    && typeof env.ISSUER_SECRET === "string" && env.ISSUER_SECRET.length >= 32
    && !!env.LAUNCH_QUEUE;
}

export function watchRelayAvailability(request, env) {
  if (request.method !== "GET") return json(405, { code: "method_not_allowed" });
  return json(200, { enabled: relayConfigured(env) });
}

export async function watchRelayTicket(request, env, fetcher = fetch) {
  const url = new URL(request.url);
  if (request.method !== "POST") return json(405, { code: "method_not_allowed" });
  if (!browserWriteAllowed(request, url.origin, "ticket")) return json(403, { code: "invalid_origin" });
  if (!env.LAUNCH_QUEUE) return json(503, { code: "pairing_unconfigured" });
  if (!relayConfigured(env)) return json(503, { code: "relay_unconfigured" });

  try {
    const companion = env.LAUNCH_QUEUE.get(env.LAUNCH_QUEUE.idFromName("primary-tv"));
    if (!(await pairedBrowserDevice(request, { authenticate: hash => companion.pairAuthenticate(hash) }))) {
      return json(401, { code: "pairing_required" });
    }
  } catch {
    return json(503, { code: "pairing_unavailable" });
  }

  let data;
  try { data = await smallJson(request, 2048); }
  catch { return json(400, { code: "invalid_request" }); }
  if (!data || typeof data !== "object" || Array.isArray(data)
    || Object.keys(data).some(key => key !== "episodeId" && key !== "previousTicket")
    || typeof data.episodeId !== "string"
    || (data.previousTicket !== undefined && (typeof data.previousTicket !== "string" || !TICKET.test(data.previousTicket)))) {
    return json(400, { code: "invalid_request" });
  }
  if (!EPISODES.has(data.episodeId)) return json(403, { code: "episode_not_allowlisted" });
  const target = new URL("/ticket", RELAY_ORIGIN);
  target.searchParams.set("id", data.episodeId);
  if (data.previousTicket) target.searchParams.set("prev", data.previousTicket);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let upstreamStatus;
  try {
    const issued = await fetcher(target.toString(), {
      method: "POST",
      headers: { Authorization: "Bearer " + env.ISSUER_SECRET },
      // Inspect redirects without forwarding the issuer credential to another destination.
      redirect: "manual",
      signal: controller.signal,
    });
    upstreamStatus = issued.status;
    if (issued.type === "opaqueredirect" || REDIRECT_STATUSES.has(upstreamStatus)) {
      logTicketFailure(request, "unexpected_redirect", upstreamStatus);
      return json(502, { code: "relay_ticket_unavailable" });
    }
    if (!issued.ok) {
      logTicketFailure(request, "upstream_http_error", upstreamStatus);
      if (issued.status === 429) return json(429, { code: "relay_rate_limited" });
      if (data.previousTicket && (issued.status === 401 || issued.status === 403)) {
        return json(403, { code: "ticket_renewal_rejected" });
      }
      return json(502, { code: "relay_ticket_unavailable" });
    }
    const value = await issued.json();
    if (value?.ok !== true || value.episodeId !== data.episodeId
      || typeof value.ticket !== "string" || !TICKET.test(value.ticket)
      || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))
      || !Number.isSafeInteger(value.ttlSeconds) || value.ttlSeconds < 1
      || !Number.isSafeInteger(value.refreshesRemaining) || value.refreshesRemaining < 0) {
      logTicketFailure(request, "invalid_ticket_response", upstreamStatus);
      return json(502, { code: "relay_ticket_unavailable" });
    }
    return json(200, { ticket: value.ticket, ttlSeconds: value.ttlSeconds, refreshesRemaining: value.refreshesRemaining });
  } catch (error) {
    let category = "fetch_error";
    if (controller.signal.aborted) category = "timeout";
    else if (upstreamStatus !== undefined && error instanceof SyntaxError) category = "invalid_json";
    logTicketFailure(request, category, upstreamStatus);
    return json(502, { code: "relay_ticket_unavailable" });
  } finally {
    clearTimeout(timer);
  }
}
