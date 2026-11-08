#!/usr/bin/env node
// Local structural preflight and optional unauthenticated post-activation smoke.
// No Cloudflare credentials, version queries, uploads, or deployment mutations.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targets = {
  watch: { config: "wrangler.universal-search-preview.jsonc",
    name: "horizon-universal-search-preview", main: "./universal-search-worker.js",
    assets: "./universal-search", routes: ["/api/*"],
    secrets: ["TMDB_TOKEN"], page: "/index.html", marker: "Horizon Watch" },
  "video-lab": { config: "wrangler.video-lab-preview.jsonc",
    name: "horizon-video-lab-preview", main: "./video-lab-preview-worker.js",
    assets: "./video-lab", routes: ["/media/*", "/api/*"],
    secrets: ["TEAM_DOMAIN", "ACCESS_AUD", "OWNER_EMAIL", "PLAYER_BRIDGE_TOKEN", "SUBDL_API_KEY"],
    page: "/player-overlay.html", marker: "player-frame" },
};

function requireCheck(ok, message) { if (!ok) throw Error(message); }
async function source(file) { return readFile(path.join(root, file), "utf8"); }
export async function localPreflight(role) {
  const target = targets[role]; requireCheck(target, "unknown target");
  const config = JSON.parse(await source(target.config));
  requireCheck(config.name === target.name, "Worker name mismatch");
  requireCheck(config.main === target.main, "Worker entrypoint mismatch");
  requireCheck(config.workers_dev === true, "workers.dev route is disabled in config");
  requireCheck(config.keep_vars === true, "keep_vars must preserve configured secrets");
  requireCheck(config.assets?.directory === target.assets && config.assets?.binding === "ASSETS",
    "assets directory or binding mismatch");
  requireCheck(JSON.stringify(config.assets.run_worker_first) === JSON.stringify(target.routes),
    "API/media worker-first routing mismatch");
  requireCheck(JSON.stringify(config.secrets?.required) === JSON.stringify(target.secrets),
    "required secret names mismatch");
  requireCheck(!target.secrets.some(name => Object.hasOwn(config.vars || {}, name)),
    "secret name also appears as a plain variable");
  const main = await source(config.main);
  const page = await source(path.join(config.assets.directory, target.page));
  requireCheck(page.includes(target.marker), "expected entry page marker missing");
  if (role === "watch") {
    requireCheck(main.includes('url.pathname === "/api/recommendations"')
      && main.includes("env.TMDB_TOKEN") && main.includes("env.ASSETS.fetch(request)"),
    "Watch API, secret lookup, or asset fallback missing");
  } else {
    requireCheck(config.vars?.PAIRING_ONLY === true, "Video Lab pairing-only mode missing");
    const bindings = config.durable_objects?.bindings || [];
    requireCheck(["LAUNCH_QUEUE", "PLAYER_BRIDGE"].every(name => bindings.some(b => b.name === name)),
      "Video Lab Durable Object binding missing");
    requireCheck(main.includes('path === "/api/subtitles"')
      && main.includes("pairedSessionAuthorized(request, env)")
      && main.includes("env.ASSETS") === false,
      "Video Lab subtitle auth routing changed");
    requireCheck((await source("video-lab-subtitles-api.js")).includes("env.SUBDL_API_KEY"),
      "SubDL secret lookup missing");
  }
  return { target: target.name, config: target.config, requiredSecrets: target.secrets,
    note: "Local checks cannot prove encrypted bindings exist on an inactive or active Cloudflare version." };
}

export async function smoke(role, base, fetcher = fetch) {
  const target = targets[role]; requireCheck(target, "unknown target");
  const origin = new URL(base);
  requireCheck(origin.protocol === "https:" || origin.hostname === "127.0.0.1"
    || origin.hostname === "localhost", "smoke URL must be HTTPS or loopback");
  const check = async (label, pathname, expectedStatus, expectedCode) => {
    const requestUrl = new URL(pathname, origin);
    let response;
    try { response = await fetcher(requestUrl, { redirect: "follow",
      credentials: "omit", signal: AbortSignal.timeout(6000) }); }
    catch (error) {
      const code = error && error.cause && typeof error.cause.code === "string"
        ? error.cause.code.replace(/[^A-Z0-9_]/gi, "").slice(0, 32) : "unavailable";
      throw Error(`${label} request failed (${error && error.name === "AbortError" ? "AbortError" : "network error"}; cause code ${code})`);
    }
    requireCheck(new URL(response.url || requestUrl).origin === origin.origin,
      `${label} redirected outside the supplied Worker origin`);
    requireCheck(response.status === expectedStatus,
      `${pathname.split("?")[0]} returned HTTP ${response.status}; expected ${expectedStatus}`);
    if (expectedCode) {
      const body = await response.json();
      requireCheck(body?.code === expectedCode || body?.error === expectedCode,
        `${pathname.split("?")[0]} returned an unexpected sanitized error code`);
    } else {
      const body = await response.text();
      requireCheck(body.includes(target.marker), "entry page marker missing");
    }
  };
  await check("player page", target.page, 200);
  if (role === "watch") await check("recommendations API", "/api/recommendations?seeds=invalid", 400, "invalid_query");
  else await check("subtitle API", "/api/subtitles?type=tv&tmdb_id=2190&season=15&episode=7", 403, "not_authorized");
  return { target: target.name, note: role === "video-lab"
    ? "Unauthenticated smoke proves pairing protection, not live SubDL secret availability."
    : "Invalid-query response also confirms the Watch TMDB binding was present for this request." };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, role, base] = process.argv.slice(2);
  try {
    requireCheck(["local", "smoke"].includes(mode) && targets[role]
      && (mode === "local" ? !base : !!base),
    "Usage: check-media-release.mjs local|smoke watch|video-lab [https://worker.workers.dev]");
    const result = mode === "local" ? await localPreflight(role) : await smoke(role, base);
    console.log(`PASS ${mode} ${result.target}: ${result.note}`);
  } catch (error) { console.error(`FAIL ${mode || "preflight"} ${role || "target"}: ${error.message}`);
    process.exitCode = 1; }
}
