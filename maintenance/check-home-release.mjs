#!/usr/bin/env node
// Read-only guard for a manually uploaded or activated horizon-vizio version.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const ACCOUNT = "d5a1f0de26db9b9ab0166715a99df692";
const WORKER = "horizon-vizio";
const BASELINE = "e6da0eff-01d6-4488-9b3c-7bee7777b308";
const NAMESPACE = "3e81b6c93f6f45fb8595e8280201fd7a";
const ORIGIN = "https://horizon-vizio.ali-al-anbari.workers.dev";
const SECRET_NAMES = ["ACCESS_AUD", "CONTROLLER_TOKEN", "OWNER_EMAIL", "TEAM_DOMAIN"];
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function requireCheck(ok, message) { if (!ok) throw Error(message); }
function digest(module) {
  requireCheck(module?.content_type === "application/javascript+module" &&
    module.name === "bridge-worker.js" && typeof module.content_base64 === "string",
  "Combined Worker module is missing or unexpected");
  return createHash("sha256").update(Buffer.from(module.content_base64, "base64")).digest("hex");
}
function verifyVersion(version, baseline) {
  requireCheck(version.main_module === "bridge-worker.js" && version.modules?.length === 1,
    "Combined Worker handler is missing");
  requireCheck(digest(version.modules[0]) === digest(baseline.modules?.[0]),
    "Worker handler differs from the known combined Home version");
  requireCheck(version.compatibility_date === baseline.compatibility_date &&
    same(version.compatibility_flags || [], baseline.compatibility_flags || []) &&
    version.usage_model === baseline.usage_model, "Worker runtime settings changed");
  requireCheck(baseline.migration_tag === "v1" && version.migrations == null &&
    version.exports == null && (version.migration_tag == null || version.migration_tag === "v1"),
    "Durable Object migration state changed");
  const expected = ["ASSETS", "LAUNCH_QUEUE", ...SECRET_NAMES].sort();
  function bindingMap(value) {
    const list = value.bindings || [];
    const map = new Map(list.map(binding => [binding.name, binding]));
    requireCheck(map.size === expected.length && list.length === expected.length &&
      same([...map.keys()].sort(), expected), "Worker binding names changed");
    requireCheck(map.get("ASSETS")?.type === "assets", "ASSETS binding is missing");
    const queue = map.get("LAUNCH_QUEUE");
    requireCheck(queue?.type === "durable_object_namespace" && queue.class_name === "LaunchQueue" &&
      queue.namespace_id === NAMESPACE, "Original LAUNCH_QUEUE binding changed");
    for (const name of SECRET_NAMES) requireCheck(map.get(name)?.type === "secret_text",
      `Encrypted binding ${name} is missing`);
  }
  bindingMap(baseline); bindingMap(version);
  requireCheck(same(version.assets?.config, baseline.assets?.config) &&
    same(version.assets?.config?.run_worker_first, ["/api/*"]),
    "ASSETS configuration or /api/* routing changed");
}
async function authToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const file = path.join(homedir(), "Library/Preferences/.wrangler/config/default.toml");
  const match = (await readFile(file, "utf8")).match(/^oauth_token\s*=\s*"([^"]+)"/m);
  requireCheck(match, "Existing Wrangler authentication unavailable");
  return match[1];
}
export async function checkHomeRelease(mode, id, { fetcher = fetch, token } = {}) {
  requireCheck(["pre", "post", "route"].includes(mode) &&
    (mode === "route" ? id === undefined : /^[0-9a-f-]{36}$/.test(id || "")),
    "Usage: node maintenance/check-home-release.mjs route|pre <version-id>|post <version-id>");
  requireCheck(typeof token === "string" && token.length > 0, "Cloudflare authentication unavailable");
  async function cf(route) {
    let response;
    try { response = await fetcher(API + route, { headers: { Authorization: `Bearer ${token}` } }); }
    catch { throw Error("Cloudflare read failed: API network unavailable; route state cannot be verified"); }
    const body = await response.json();
    requireCheck(response.ok && body.success === true, `Cloudflare read failed: HTTP ${response.status}`);
    return body.result;
  }
  const subdomain = await cf(`/workers/scripts/${WORKER}/subdomain`);
  requireCheck(subdomain?.enabled === true, `${WORKER}.workers.dev is disabled; stop and inspect Domains & Routes`);
  if (mode === "route") return { routeEnabled: true };
  const [version, baseline] = await Promise.all([
    cf(`/workers/workers/${WORKER}/versions/${id}?include=modules`),
    cf(`/workers/workers/${WORKER}/versions/${BASELINE}?include=modules`),
  ]);
  requireCheck(version?.id === id && baseline?.id === BASELINE, "Worker version identity changed");
  verifyVersion(version, baseline);
  if (mode === "post") {
    let home, claim;
    try { [home, claim] = await Promise.all([
      fetcher(ORIGIN + "/", { redirect: "manual", headers: { "Cache-Control": "no-cache" } }),
      fetcher(ORIGIN + "/api/controller/claim", { redirect: "manual", headers: { "Cache-Control": "no-cache" } }),
    ]); } catch { throw Error("Home smoke check failed: workers.dev network unavailable"); }
    requireCheck(home.status === 200, `Home smoke check failed: HTTP ${home.status}, expected 200`);
    requireCheck(claim.status === 403, `Unauthenticated controller claim failed: HTTP ${claim.status}, expected 403`);
    const after = await cf(`/workers/scripts/${WORKER}/subdomain`);
    requireCheck(after?.enabled === true, `${WORKER}.workers.dev became disabled after smoke checks`);
  }
  return { routeEnabled: true, version: id, structure: "verified", smoke: mode === "post" ? "verified" : "not-run" };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [mode, id] = process.argv.slice(2);
  authToken().then(token => checkHomeRelease(mode, id, { token })).then(result => {
    console.log(`PASS: ${WORKER} workers.dev enabled; ${result.version || "route"} ${result.structure || "checked"}; smoke ${result.smoke || "not-run"}.`);
  }).catch(error => { console.error(`Home release guard stopped: ${error.message}`); process.exitCode = 1; });
}
