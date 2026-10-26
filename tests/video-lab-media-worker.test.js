import test from "node:test";
import assert from "node:assert/strict";
import worker, { mediaSize, serveMedia } from "../video-lab-media-worker.js";
import { statSync } from "node:fs";

const ORIGIN = "https://horizon-video-lab-preview.example";
const PATH = "/media/sintel-original.mp4";
const BYTES = new TextEncoder().encode("0123456789");

const call = (app, request) => serveMedia(request, app.env.ASSETS, BYTES.length);

test("media length manifest matches the packaged files", () => {
  for (const path of ["/media/sintel-original.mp4", "/media/sintel-faststart.mp4",
    "/media/sintel-compat.mp4", "/media/horizon-25min.mp4"]) {
    assert.equal(statSync(new URL(`../video-lab${path}`, import.meta.url)).size, mediaSize(path));
  }
});

function fixture({ truncate = false, encoding = false } = {}) {
  let fetches = 0;
  let forwardedRange = null;
  let canceled = false;
  const env = {
    ASSETS: {
      async fetch(request) {
        fetches++;
        forwardedRange = request.headers.get("Range");
        const chunks = truncate ? [BYTES.slice(0, 3)] : [BYTES.slice(0, 3), BYTES.slice(3, 7), BYTES.slice(7)];
        const body = new ReadableStream({
          pull(controller) {
            if (chunks.length) controller.enqueue(chunks.shift());
            else controller.close();
          },
          cancel() { canceled = true; },
        });
        const headers = { "Content-Length": "10", "Content-Type": "video/mp4", ETag: '"test-etag"' };
        if (encoding) headers["Content-Encoding"] = "gzip";
        return new Response(body, { headers });
      },
    },
  };
  const request = (range, extras = {}) => new Request(ORIGIN + PATH, {
    headers: { ...(range ? { Range: range } : {}), ...extras },
  });
  return { env, request, get fetches() { return fetches; }, get forwardedRange() { return forwardedRange; },
    get canceled() { return canceled; } };
}

test("fixed media route streams exact inclusive ranges without forwarding Range to assets", async () => {
  for (const [header, body, contentRange] of [
    ["bytes=0-1", "01", "bytes 0-1/10"],
    ["bytes=5-", "56789", "bytes 5-9/10"],
    ["bytes=-3", "789", "bytes 7-9/10"],
  ]) {
    const app = fixture();
    const response = await call(app, app.request(header));
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("Content-Range"), contentRange);
    assert.equal(response.headers.get("Content-Length"), String(body.length));
    assert.equal(response.headers.get("Content-Type"), "video/mp4");
    assert.equal(response.headers.get("Accept-Ranges"), "bytes");
    assert.equal(await response.text(), body);
    assert.equal(app.forwardedRange, null);
    if (header === "bytes=0-1") assert.equal(app.canceled, true);
  }
});

test("full GET, HEAD and mismatched If-Range preserve full response semantics", async () => {
  const full = fixture();
  assert.equal(await (await call(full, full.request())).text(), "0123456789");
  const head = fixture();
  const headResponse = await call(head, new Request(ORIGIN + PATH, { method: "HEAD" }));
  assert.equal(headResponse.status, 200);
  assert.equal(headResponse.headers.get("Content-Length"), "10");
  assert.equal(await headResponse.text(), "");
  assert.equal(head.canceled, true);
  const stale = fixture();
  const response = await call(stale, stale.request("bytes=0-1", { "If-Range": '"old"' }));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "0123456789");
  const current = fixture();
  const partial = await call(current, current.request("bytes=0-1", { "If-Range": '"test-etag"' }));
  assert.equal(partial.status, 206);
  assert.equal(await partial.text(), "01");
});

test("invalid ranges, unlisted paths, methods and compressed assets fail safely", async () => {
  for (const range of ["bytes=10-", "bytes=5-4", "bytes=0-1,5-6", "bytes=-0"]) {
    const app = fixture();
    const response = await call(app, app.request(range));
    assert.equal(response.status, 416);
    assert.equal(response.headers.get("Content-Range"), "bytes */10");
    assert.equal(app.fetches, 0);
  }
  const app = fixture();
  assert.equal((await worker.fetch(new Request(ORIGIN + "/media/private.mp4"), app.env)).status, 404);
  assert.equal((await worker.fetch(new Request(ORIGIN + PATH, { method: "POST" }), app.env)).status, 405);
  assert.equal(app.fetches, 0);
  const compressed = fixture({ encoding: true });
  assert.equal((await call(compressed, compressed.request("bytes=0-1"))).status, 502);
  assert.equal(compressed.canceled, true);
});

test("truncated source fails instead of silently completing a partial response", async () => {
  const app = fixture({ truncate: true });
  const response = await call(app, app.request("bytes=5-9"));
  assert.equal(response.status, 206);
  await assert.rejects(response.arrayBuffer());
});
