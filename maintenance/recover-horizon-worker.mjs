#!/usr/bin/env node
// Single-use, production-specific recovery. Never deploys or changes Durable Object storage.
// Run `node maintenance/recover-horizon-worker.mjs inspect` first.
// Run `node maintenance/recover-horizon-worker.mjs verify-existing <version-id>` to recheck an inactive version.
// Run `node maintenance/recover-horizon-worker.mjs create-inactive` only after reviewing inspect.

import { readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { hash: blake3Hash } = require("blake3-wasm");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS_DIR = path.join(ROOT, "frontend");
const ACCOUNT_ID = "d5a1f0de26db9b9ab0166715a99df692";
const WORKER = "horizon-vizio";
const UI_VERSION = "161f0cd6-9377-4932-895a-cf5573a7fff9";
const SECRET_VERSION = "0bb797c6-6d50-413f-90a0-4ef322daa83a";
const NAMESPACE_ID = "3e81b6c93f6f45fb8595e8280201fd7a";
const SECRET_NAMES = ["ACCESS_AUD", "CONTROLLER_TOKEN", "OWNER_EMAIL", "TEAM_DOMAIN"];
const UI_MODULE_SHA256 = "08440e92511f420e933e5a4239ad6567e0b59f1d43a03bd259fd06a227c7c68c";
// Pinned from the local frontend snapshot inspected after the v28 upload.
const ASSET_COUNT = 53;
const ASSET_MANIFEST_SHA256 = "5872f980795f102f3556779303b6ad5a452c62cc1d99037a6cd72434c7e534ed";
const UI_UPLOADED_AT_MS = Date.parse("2026-10-29T04:57:00.729Z");
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function getAuthToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const wranglerAuth = path.join(homedir(), "Library/Preferences/.wrangler/config/default.toml");
  const text = await readFile(wranglerAuth, "utf8");
  const match = text.match(/^oauth_token\s*=\s*"([^"]+)"/m);
  assert(match, "Existing Wrangler OAuth token unavailable; run `npx wrangler whoami` or use an existing API token.");
  return match[1];
}

async function api(token, method, route, body) {
  const response = await fetch(`${API}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  // Deliberately omit raw response bodies and request payloads from errors/logs.
  let result;
  try { result = await response.json(); } catch { throw new Error(`${method} ${route} returned non-JSON HTTP ${response.status}`); }
  if (!response.ok || result.success !== true) {
    const codes = (result.errors || []).map((error) => error.code).join(",");
    throw new Error(`${method} ${route} failed: HTTP ${response.status}, Cloudflare codes ${codes || "unknown"}`);
  }
  return result.result;
}

async function getVersion(token, id) {
  return api(token, "GET", `/workers/workers/${WORKER}/versions/${id}?include=modules`);
}

function bindingMap(version) {
  return new Map((version.bindings || []).map((binding) => [binding.name, binding]));
}

function verifyVersions(ui, secret) {
  assert(ui.id === UI_VERSION && secret.id === SECRET_VERSION, "Version identity changed");
  assert(ui.main_module === "bridge-worker.js", "Unexpected UI main module");
  assert(ui.compatibility_date === "2026-10-19", "Unexpected UI compatibility date");
  assert(ui.migration_tag === "v1", "UI migration tag changed");
  assert(ui.usage_model === "standard", "Unexpected UI usage model");
  assert(!ui.compatibility_flags?.length, "Unexpected UI compatibility flags");
  assert(Array.isArray(ui.modules) && ui.modules.length === 1, "Unexpected UI module set");
  const module = ui.modules[0];
  assert(module.name === ui.main_module && module.content_type === "application/javascript+module", "Unexpected UI module metadata");
  assert(typeof module.content_base64 === "string", "UI module content was not returned");
  const digest = createHash("sha256").update(Buffer.from(module.content_base64, "base64")).digest("hex");
  assert(digest === UI_MODULE_SHA256, "UI module bytes differ from inspected version");
  const assetConfig = ui.assets?.config;
  assert(assetConfig && !ui.assets.jwt, "Unexpected UI asset configuration");
  assert(assetConfig.base_path === "/", "Asset base path changed");
  assert(assetConfig.html_handling === "auto-trailing-slash", "HTML handling changed");
  assert(assetConfig.not_found_handling === "none", "Asset 404 handling changed");
  assert(JSON.stringify(assetConfig.run_worker_first) === JSON.stringify(["/api/*"]), "API asset routing changed");
  const uiBindings = bindingMap(ui);
  assert(uiBindings.size === 2, "Unexpected UI binding set");
  assert(uiBindings.get("ASSETS")?.type === "assets", "ASSETS binding missing");
  const queue = uiBindings.get("LAUNCH_QUEUE");
  assert(queue?.type === "durable_object_namespace" && queue.class_name === "LaunchQueue" && queue.namespace_id === NAMESPACE_ID,
    "LAUNCH_QUEUE binding changed");
  const secretBindings = bindingMap(secret);
  assert(secret.migration_tag === "v1", "Secret version migration tag changed");
  assert(secretBindings.get("LAUNCH_QUEUE")?.namespace_id === NAMESPACE_ID, "Secret version namespace differs");
  assert(secretBindings.size === 6, "Unexpected historical binding set");
  for (const name of SECRET_NAMES) assert(secretBindings.get(name)?.type === "secret_text", `Historical ${name} secret binding missing`);
  assert(secretBindings.get("ASSETS")?.type === "assets", "Historical ASSETS binding missing");
  return { module, assetConfig, assetBinding: uiBindings.get("ASSETS"), queueBinding: queue };
}

function verifyCreated(checked, ui, source) {
  const names = bindingMap(checked);
  const assets = checked.assets?.config;
  const checks = {
    "exactly four inherited secret bindings": names.size === 6 &&
      SECRET_NAMES.every((name) => names.get(name)?.type === "secret_text"),
    "ASSETS binding and routing": names.get("ASSETS")?.type === "assets" &&
      assets?.base_path === source.assetConfig.base_path &&
      assets?.html_handling === source.assetConfig.html_handling &&
      assets?.not_found_handling === source.assetConfig.not_found_handling &&
      JSON.stringify(assets?.run_worker_first) === JSON.stringify(source.assetConfig.run_worker_first),
    "original LAUNCH_QUEUE namespace": names.get("LAUNCH_QUEUE")?.type === "durable_object_namespace" &&
      names.get("LAUNCH_QUEUE")?.class_name === "LaunchQueue" &&
      names.get("LAUNCH_QUEUE")?.namespace_id === NAMESPACE_ID,
    "same Worker module bytes": checked.main_module === ui.main_module &&
      checked.modules?.length === 1 &&
      checked.modules[0]?.name === source.module.name &&
      checked.modules[0]?.content_type === source.module.content_type &&
      checked.modules[0]?.content_base64 === source.module.content_base64,
    "same runtime settings": checked.compatibility_date === ui.compatibility_date &&
      checked.usage_model === ui.usage_model &&
      JSON.stringify(checked.compatibility_flags || []) === JSON.stringify(ui.compatibility_flags || []),
    // Cloudflare's beta API documents migration_tag as omitted on an undeployed version.
    // No migration was requested; the existing namespace ID and class name are preserved.
    "no Durable Object lifecycle change": checked.migrations == null &&
      checked.exports == null &&
      (checked.migration_tag == null || checked.migration_tag === "v1"),
  };
  const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([label]) => label);
  assert(failed.length === 0, `Structural verification failed: ${failed.join(", ")}`);
  return checks;
}

async function assetSnapshot() {
  const entries = [];
  async function visit(dir) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, item.name);
      if (item.isDirectory()) await visit(absolute);
      else {
        assert(item.isFile(), `Unsupported asset entry: ${absolute}`);
        const relative = path.relative(ASSETS_DIR, absolute).split(path.sep).join("/");
        assert(![".assetsignore", "_headers", "_redirects", "_worker.js"].includes(relative),
          `Unexpected special asset: ${relative}`);
        const info = await stat(absolute);
        assert(info.mtimeMs <= UI_UPLOADED_AT_MS, `Asset modified after source upload: ${relative}`);
        const bytes = await readFile(absolute);
        const ext = path.extname(absolute).slice(1);
        // Same hash algorithm as installed Wrangler 4.151.0 assets helper.
        entries.push([`/${relative}`, blake3Hash(bytes.toString("base64") + ext).toString("hex").slice(0, 32), bytes.length]);
      }
    }
  }
  await visit(ASSETS_DIR);
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  const digest = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  assert(entries.length === ASSET_COUNT && digest === ASSET_MANIFEST_SHA256,
    "Local assets do not match the pinned source-UI upload snapshot");
  return Object.fromEntries(entries.map(([pathname, hash, size]) => [pathname, { hash, size }]));
}

async function main() {
  const mode = process.argv[2];
  assert((["inspect", "create-inactive"].includes(mode) && process.argv.length === 3) ||
    (mode === "verify-existing" && process.argv.length === 4 && /^[0-9a-f-]{36}$/.test(process.argv[3])),
    "Usage: node maintenance/recover-horizon-worker.mjs inspect|create-inactive|verify-existing <version-id>");
  const token = await getAuthToken();
  const [ui, secret] = await Promise.all([
    getVersion(token, UI_VERSION), getVersion(token, SECRET_VERSION),
  ]);
  const source = verifyVersions(ui, secret);
  if (mode === "verify-existing") {
    const checked = await getVersion(token, process.argv[3]);
    const checks = verifyCreated(checked, ui, source);
    console.log(`PASS: existing version ${checked.id} has ${Object.keys(checks).length} matching structural checks. No new version was created.`);
    console.log("Asset contents and live behavior still require validation after activation; this check does not deploy.");
    return;
  }
  const manifest = await assetSnapshot();
  const latest = await getVersion(token, "latest");
  console.log(`Preflight passed: UI v${ui.number}, historical secrets v${secret.number}, ${Object.keys(manifest).length} pinned assets, namespace ${NAMESPACE_ID}. Latest uploaded version: ${latest.id}.`);
  if (mode === "inspect") {
    console.log("Read-only inspection complete. No asset session or Worker version was created.");
    return;
  }
  assert(latest.id === UI_VERSION, "A different Worker version was uploaded after the pinned UI version; stopped before creating another version");

  // A fresh completion JWT is essential: beta GET returns asset config, not the asset set or JWT.
  // Never upload missing files here. Empty buckets means Cloudflare already has every pinned blob.
  const session = await api(token, "POST", `/workers/scripts/${WORKER}/assets-upload-session`, { manifest });
  assert(Array.isArray(session.buckets) && session.buckets.length === 0,
    "Cloudflare requested asset uploads; stopped without creating a Worker version");
  assert(typeof session.jwt === "string" && session.jwt.length > 0,
    "Cloudflare did not issue an asset completion token");
  const beforeCreate = await getVersion(token, "latest");
  assert(beforeCreate.id === UI_VERSION, "Another version appeared during asset registration; stopped before creating a Worker version");
  const bindings = [source.assetBinding, source.queueBinding,
    ...SECRET_NAMES.map((name) => ({ name, type: "inherit", version_id: SECRET_VERSION }))];
  const created = await api(token, "POST", `/workers/workers/${WORKER}/versions?deploy=false`, {
    main_module: ui.main_module,
    modules: [source.module],
    assets: { jwt: session.jwt, config: source.assetConfig },
    compatibility_date: ui.compatibility_date,
    usage_model: ui.usage_model,
    bindings,
    annotations: { "workers/message": "Inactive recovery: v28 UI/assets plus v19 encrypted bindings" },
  });
  assert(typeof created.id === "string", "Cloudflare created a version but returned no ID; inspect latest manually");
  const checked = await getVersion(token, created.id);
  console.log(`Inactive Worker version created: ${created.id}`);
  verifyCreated(checked, ui, source);
  console.log("Verified: four encrypted secret bindings, asset binding/routing, module bytes, migration compatibility, and original LAUNCH_QUEUE namespace. Production traffic was not changed.");
}

main().catch((error) => {
  console.error(`Recovery stopped: ${error.message}`);
  process.exitCode = 1;
});
