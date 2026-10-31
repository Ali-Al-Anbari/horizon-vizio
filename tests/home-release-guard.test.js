import test from "node:test";
import assert from "node:assert/strict";
import { checkHomeRelease } from "../maintenance/check-home-release.mjs";

const candidate = "71f619e9-4f44-4e3a-a473-93de187ecbac";
const baseline = "e6da0eff-01d6-4488-9b3c-7bee7777b308";
const namespace = "3e81b6c93f6f45fb8595e8280201fd7a";
function version(id) { return {
  id, main_module: "bridge-worker.js", migration_tag: "v1",
  compatibility_date: "2026-10-19", compatibility_flags: [], usage_model: "standard",
  modules: [{ name: "bridge-worker.js", content_type: "application/javascript+module",
    content_base64: Buffer.from("export default { fetch() {} }").toString("base64") }],
  assets: { config: { base_path: "/", run_worker_first: ["/api/*"] } },
  bindings: [
    { name: "ASSETS", type: "assets" },
    { name: "LAUNCH_QUEUE", type: "durable_object_namespace", class_name: "LaunchQueue", namespace_id: namespace },
    ...["ACCESS_AUD", "CONTROLLER_TOKEN", "OWNER_EMAIL", "TEAM_DOMAIN"]
      .map(name => ({ name, type: "secret_text" })),
  ],
}; }
function fixture({ enabled = true, candidateVersion = version(candidate), home = 200, claim = 403 } = {}) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/subdomain")) return new Response(JSON.stringify({ success: true, result: { enabled } }));
    if (url.includes("/versions/")) return new Response(JSON.stringify({ success: true,
      result: url.includes(candidate) ? candidateVersion : version(baseline) }));
    return new Response("", { status: url.endsWith("/api/controller/claim") ? claim : home });
  };
  return { fetcher, calls };
}

test("preflight verifies the enabled route and exact combined Worker structure without writes", async () => {
  const { fetcher, calls } = fixture();
  assert.equal((await checkHomeRelease("pre", candidate, { fetcher, token: "fixture" })).structure, "verified");
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => !call.options.method || call.options.method === "GET"));
  assert.ok(calls.every(call => !call.url.includes("/api/controller/claim")));
});

test("disabled workers.dev route fails before version inspection", async () => {
  const { fetcher, calls } = fixture({ enabled: false });
  await assert.rejects(checkHomeRelease("pre", candidate, { fetcher, token: "fixture" }), /workers.dev is disabled/);
  assert.equal(calls.length, 1);
});

test("missing secret, changed queue, or static asset routing fails closed", async () => {
  for (const change of [
    v => { v.bindings.pop(); },
    v => { v.bindings[1].namespace_id = "different"; },
    v => { v.assets.config.run_worker_first = []; },
    v => { v.modules[0].content_base64 = Buffer.from("other handler").toString("base64"); },
  ]) {
    const altered = version(candidate); change(altered);
    await assert.rejects(checkHomeRelease("pre", candidate,
      { ...fixture({ candidateVersion: altered }), token: "fixture" }));
  }
});

test("postflight checks Home 200, unauthenticated claim 403, and subdomain again", async () => {
  const good = fixture();
  assert.equal((await checkHomeRelease("post", candidate, { fetcher: good.fetcher, token: "fixture" })).smoke,
    "verified");
  assert.equal(good.calls.filter(call => call.url.endsWith("/subdomain")).length, 2);
  assert.ok(good.calls.some(call => call.url.endsWith("/api/controller/claim") && !call.options.headers.Authorization));
  for (const options of [{ home: 404 }, { claim: 404 }]) {
    const bad = fixture(options);
    await assert.rejects(checkHomeRelease("post", candidate, { fetcher: bad.fetcher, token: "fixture" }),
      /smoke check failed|controller claim failed/);
  }
});
