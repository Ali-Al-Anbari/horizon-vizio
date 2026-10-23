import { verifyOwner } from "./access.js";

const STATIC_PATHS = new Set(["/", "/index.html", "/probe.js", "/probe.css", "/cookie", "/cookie.html", "/cookie-probe.js"]);
const AUTH_PATHS = new Set(["/api/auth/start", "/api/auth/probe"]);
const COOKIE_PATHS = new Set(["/api/cookie/check", "/api/cookie/start", "/api/cookie/clear"]);
const COOKIE_NAME = "__Host-horizon_probe";
const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

function json(status, code, authenticated = false) {
  return new Response(JSON.stringify({ authenticated, code }), {
    status,
    headers: { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}

function cookieJson(seen) {
  return new Response(JSON.stringify({ cookieSeen: seen }), {
    status: 200,
    headers: { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}

export async function handleAccessProbe(request, env, options = {}) {
  const url = new URL(request.url);
  if (!STATIC_PATHS.has(url.pathname) && !AUTH_PATHS.has(url.pathname) && !COOKIE_PATHS.has(url.pathname)) return json(404, "not_found");

  if (COOKIE_PATHS.has(url.pathname)) {
    if (url.pathname === "/api/cookie/check" && request.method === "GET") {
      const seen = (request.headers.get("cookie") || "").split(";").some(part =>
        /^__Host-horizon_probe=[0-9a-f-]{36}$/i.test(part.trim()));
      return cookieJson(seen);
    }
    if (request.method !== "POST") return json(405, "method_not_allowed");
    if (request.headers.get("origin") !== url.origin || request.headers.get("x-horizon-probe") !== "cookie") {
      return json(403, "invalid_origin");
    }
    const value = url.pathname === "/api/cookie/start" ? crypto.randomUUID() : "";
    const attributes = "Path=/; Secure; HttpOnly; SameSite=Strict";
    const cookie = `${COOKIE_NAME}=${value}; ${attributes}; Max-Age=${value ? 86400 : 0}`;
    return new Response(null, { status: 204, headers: { ...SECURITY_HEADERS, "Set-Cookie": cookie } });
  }

  if (request.method !== "GET") return json(405, "method_not_allowed");

  if (AUTH_PATHS.has(url.pathname)) {
    if (!env.TEAM_DOMAIN || !env.ACCESS_AUD || !env.OWNER_EMAIL) {
      return json(503, "authorization_unconfigured");
    }
    if (!request.headers.has("cf-access-jwt-assertion")) {
      return json(403, "access_assertion_missing");
    }
    if (!(await verifyOwner(request, env, options.jwks))) {
      return json(403, "authorization_rejected");
    }
    if (url.pathname === "/api/auth/start") {
      return new Response(null, {
        status: 303,
        headers: { ...SECURITY_HEADERS, Location: new URL("/?access=returned", url).toString() },
      });
    }
    return json(200, "owner_verified", true);
  }

  if (!env.ASSETS) return json(503, "assets_unavailable");
  const asset = await env.ASSETS.fetch(request);
  const headers = new Headers(asset.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  return new Response(asset.body, { status: asset.status, headers });
}

export default {
  fetch(request, env) {
    return handleAccessProbe(request, env);
  },
};
