#!/usr/bin/env node
// Inactive-version recovery using the beta Workers Versions API. Does not activate traffic.
// First upload current code/assets with `wrangler versions upload`, then inspect/create here.
import { readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { hash: blake3Hash } = require("blake3-wasm");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ACCOUNT = "d5a1f0de26db9b9ab0166715a99df692";
const NAMESPACE = "3e81b6c93f6f45fb8595e8280201fd7a";
const TARGETS = {
  home: { name: "horizon-vizio", dir: "frontend", module: "bridge-worker.js",
    active: "e6da0eff-01d6-4488-9b3c-7bee7777b308", date: "2026-10-19",
    secrets: ["ACCESS_AUD", "CONTROLLER_TOKEN", "OWNER_EMAIL", "TEAM_DOMAIN"] },
  watch: { name: "horizon-universal-search-preview", dir: "universal-search",
    module: "universal-search-worker.js", active: "51e49098-d3c4-4648-b2f6-8c1b2d9a4780",
    date: "2026-10-25", secrets: ["TMDB_TOKEN"] },
};
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
function check(ok, message) { if (!ok) throw Error(message); }
const bindings = v => new Map((v.bindings || []).map(b => [b.name, b]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function token() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const file = path.join(homedir(), "Library/Preferences/.wrangler/config/default.toml");
  const match = (await readFile(file, "utf8")).match(/^oauth_token\s*=\s*"([^"]+)"/m);
  check(match, "Existing Wrangler authentication unavailable");
  return match[1];
}
async function call(auth, method, route, body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${route}`, {
    method, headers: { Authorization: `Bearer ${auth}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let value;
  try { value = await response.json(); } catch { throw Error(`${method} returned non-JSON HTTP ${response.status}`); }
  if (!response.ok || value.success !== true) {
    const codes = (value.errors || []).map(e => e.code).join(",");
    throw Error(`${method} failed: HTTP ${response.status}, Cloudflare codes ${codes || "unknown"}`);
  }
  return value.result;
}
const get = (auth, target, id) => call(auth, "GET", `/workers/workers/${target.name}/versions/${id}?include=modules`);
function moduleBytes(v) {
  check(v.modules?.length === 1 && v.modules[0].name === v.main_module
    && v.modules[0].content_type === "application/javascript+module"
    && typeof v.modules[0].content_base64 === "string", "Module content unavailable or unexpected");
  return Buffer.from(v.modules[0].content_base64, "base64");
}
function verifySource(ui, active, target, id) {
  check(ui.id === id && active.id === target.active && ui.id !== active.id, "Version identity changed");
  check(ui.main_module === target.module && active.main_module === target.module, "Main module changed");
  check(ui.compatibility_date === target.date && active.compatibility_date === target.date
    && same(ui.compatibility_flags || [], active.compatibility_flags || [])
    && ui.usage_model === active.usage_model, "Runtime settings changed");
  moduleBytes(ui);
  check(ui.assets?.config && !ui.assets.jwt && same(ui.assets.config, active.assets?.config)
    && same(ui.assets.config.run_worker_first, ["/api/*"]), "Asset config or API routing changed");
  const a = bindings(active), u = bindings(ui);
  const wanted = ["ASSETS", ...(target === TARGETS.home ? ["LAUNCH_QUEUE"] : []), ...target.secrets];
  check(same([...a.keys()].sort(), wanted.sort()) && a.get("ASSETS")?.type === "assets"
    && u.get("ASSETS")?.type === "assets"
    && [...u.keys()].every(name => wanted.includes(name)), "Unexpected source binding set");
  for (const name of target.secrets) check(a.get(name)?.type === "secret_text", `Missing active ${name}`);
  if (target === TARGETS.home) {
    check(a.get("LAUNCH_QUEUE")?.type === "durable_object_namespace"
      && a.get("LAUNCH_QUEUE")?.namespace_id === NAMESPACE
      && a.get("LAUNCH_QUEUE")?.class_name === "LaunchQueue"
      && u.get("LAUNCH_QUEUE")?.namespace_id === NAMESPACE
      && active.migration_tag === "v1"
      && (ui.migration_tag == null || ui.migration_tag === "v1"), "Durable Object identity changed");
  }
  return a;
}
function verifyCreated(created, ui, active, target) {
  const b = bindings(created), a = bindings(active);
  check(same([...b.keys()].sort(), [...a.keys()].sort()), "Created binding names changed");
  for (const name of target.secrets) check(b.get(name)?.type === "secret_text", `Missing created ${name}`);
  check(b.get("ASSETS")?.type === "assets", "Created ASSETS binding missing");
  if (target === TARGETS.home) check(b.get("LAUNCH_QUEUE")?.namespace_id === NAMESPACE
    && b.get("LAUNCH_QUEUE")?.class_name === "LaunchQueue", "Created Durable Object changed");
  check(created.main_module === ui.main_module && sha(moduleBytes(created)) === sha(moduleBytes(ui)),
    "Created module differs from UI upload");
  check(created.compatibility_date === ui.compatibility_date && created.usage_model === ui.usage_model
    && same(created.compatibility_flags || [], ui.compatibility_flags || [])
    && same(created.assets?.config, ui.assets.config), "Created runtime or asset routing changed");
  check(created.migrations == null && created.exports == null
    && (created.migration_tag == null || created.migration_tag === active.migration_tag),
    "Unexpected Durable Object lifecycle change");
}
async function manifest(target, uploadTime) {
  const dir = path.join(ROOT, target.dir), rows = [];
  async function walk(folder) {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      const absolute = path.join(folder, item.name);
      if (item.isDirectory()) await walk(absolute);
      else {
        check(item.isFile(), `Unsupported asset: ${absolute}`);
        const relative = path.relative(dir, absolute).split(path.sep).join("/");
        check(![".assetsignore", "_headers", "_redirects", "_worker.js"].includes(relative),
          `Special asset requires review: ${relative}`);
        check((await stat(absolute)).mtimeMs <= uploadTime + 2000,
          `Asset changed after UI upload: ${relative}`);
        const bytes = await readFile(absolute), ext = path.extname(absolute).slice(1);
        rows.push([`/${relative}`, blake3Hash(bytes.toString("base64") + ext).toString("hex").slice(0, 32), bytes.length]);
      }
    }
  }
  await walk(dir); rows.sort((a, b) => a[0].localeCompare(b[0]));
  check(rows.length > 0, "Empty asset directory");
  return { value: Object.fromEntries(rows.map(([name, hash, size]) => [name, { hash, size }])),
    count: rows.length, digest: sha(Buffer.from(JSON.stringify(rows))) };
}
async function main() {
  const [mode, role, uiId, newId] = process.argv.slice(2), target = TARGETS[role];
  check(target && /^[0-9a-f-]{36}$/.test(uiId || "")
    && (["inspect", "create-inactive"].includes(mode) && !newId
      || mode === "verify-existing" && /^[0-9a-f-]{36}$/.test(newId || "")),
    "Usage: prepare-coordinated-release.mjs inspect|create-inactive home|watch <ui-version> [new-version]");
  const auth = await token();
  const [ui, active, latest] = await Promise.all([get(auth, target, uiId),
    get(auth, target, target.active), get(auth, target, "latest")]);
  const a = verifySource(ui, active, target, uiId);
  const uploadTime = Date.parse(ui.created_on || ui.created_at || "");
  check(Number.isFinite(uploadTime), "UI upload time unavailable");
  const assets = await manifest(target, uploadTime);
  console.log(`Preflight ${target.name}: active ${target.active}, UI ${uiId}, ${assets.count} current assets, manifest SHA256 ${assets.digest}, module SHA256 ${sha(moduleBytes(ui))}`);
  if (mode === "verify-existing") {
    const created = await get(auth, target, newId);
    verifyCreated(created, ui, active, target);
    console.log(`PASS: ${newId} preserves required encrypted bindings, module, assets routing, runtime, and namespace where applicable.`);
    return;
  }
  check(latest.id === uiId, "A newer version exists; stopped before asset registration");
  if (mode === "inspect") { console.log("Read-only inspection complete."); return; }
  // Wrangler's immediately preceding inactive upload must have registered every current blob.
  const session = await call(auth, "POST", `/workers/scripts/${target.name}/assets-upload-session`,
    { manifest: assets.value });
  check(Array.isArray(session.buckets) && session.buckets.length === 0,
    "Current assets are not all registered; stopped before version creation");
  check(typeof session.jwt === "string" && session.jwt, "Asset completion token unavailable");
  check((await get(auth, target, "latest")).id === uiId, "Concurrent version upload detected");
  const nextBindings = [a.get("ASSETS"), ...(target === TARGETS.home ? [a.get("LAUNCH_QUEUE")] : []),
    ...target.secrets.map(name => ({ name, type: "inherit", version_id: target.active }))];
  const created = await call(auth, "POST", `/workers/workers/${target.name}/versions?deploy=false`, {
    main_module: ui.main_module, modules: ui.modules,
    assets: { jwt: session.jwt, config: ui.assets.config },
    compatibility_date: ui.compatibility_date, compatibility_flags: ui.compatibility_flags || [],
    usage_model: ui.usage_model, bindings: nextBindings,
    annotations: { "workers/message": `Inactive coordinated release: ${target.dir} assets and inherited encrypted bindings` },
  });
  check(created.id, "Version created without ID; inspect latest manually");
  console.log(`Inactive version created: ${created.id}`);
  verifyCreated(await get(auth, target, created.id), ui, active, target);
  console.log("PASS: structural verification complete. Production traffic unchanged.");
}
main().catch(error => { console.error(`Recovery stopped: ${error.message}`); process.exitCode = 1; });
