import test from "node:test";
import assert from "node:assert/strict";
import worker, { relayMedia } from "../video-lab-media-worker.js";

const RELAY = "https://horizon-video-lab-preview.example/media/relay/sintel.mp4";
const FLOWER_RELAY = "https://horizon-video-lab-preview.example/media/relay/flower.mp4";
const SINTEL_UPSTREAM = "https://media.w3.org/2010/05/sintel/trailer.mp4";
const FLOWER_UPSTREAM = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";
const MEDIA_HEADERS = { "Content-Type": "video/mp4", "Content-Length": "10",
  "Accept-Ranges": "bytes", ETag: '"public-test"', "Cache-Control": "public, max-age=120" };

function upstream(bytes = "0123456789", status = 200, headers = MEDIA_HEADERS) {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(bytes.slice(0, 3)));
      controller.enqueue(new TextEncoder().encode(bytes.slice(3)));
      controller.close();
    },
  });
  return new Response(body, { status, headers });
}

test("relay streams fixed W3C bytes and sends no client credentials upstream", async () => {
  let target;
  let options;
  const request = new Request(RELAY, { headers: {
    Cookie: "private", Authorization: "Bearer private", Referer: "https://private.example/",
  } });
  const response = await relayMedia(request, async (url, init) => {
    target = url; options = init;
    return upstream();
  });
  assert.equal(target, SINTEL_UPSTREAM);
  assert.equal(options.method, "GET");
  assert.equal(options.redirect, "manual");
  assert.equal(options.headers.get("Cookie"), null);
  assert.equal(options.headers.get("Authorization"), null);
  assert.equal(options.headers.get("Referer"), null);
  assert.equal(options.headers.get("Accept-Encoding"), "identity");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "video/mp4");
  assert.equal(response.headers.get("Content-Length"), "10");
  assert.equal(response.headers.get("ETag"), '"public-test"');
  assert.equal(await response.text(), "0123456789");
});

test("relay forwards a valid Range and returns only the upstream-confirmed bytes", async () => {
  let options;
  const response = await relayMedia(new Request(RELAY, { headers: {
    Range: "bytes=0-1", "If-Range": '"public-test"',
  } }), async (_url, init) => {
    options = init;
    return upstream("01", 206, { ...MEDIA_HEADERS, "Content-Length": "2",
      "Content-Range": "bytes 0-1/10" });
  });
  assert.equal(options.headers.get("Range"), "bytes=0-1");
  assert.equal(options.headers.get("If-Range"), '"public-test"');
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("Content-Range"), "bytes 0-1/10");
  assert.equal(response.headers.get("Content-Length"), "2");
  assert.equal(await response.text(), "01");
});

test("ignored upstream Range remains 200 and never becomes fabricated 206", async () => {
  const response = await relayMedia(new Request(RELAY, { headers: { Range: "bytes=0-1" } }),
    async () => upstream());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Range"), null);
  assert.equal(await response.text(), "0123456789");
});

test("HEAD and upstream 416 retain accurate metadata without a media body", async () => {
  let method;
  const head = await relayMedia(new Request(RELAY, { method: "HEAD" }), async (_url, init) => {
    method = init.method;
    return new Response(null, { status: 200, headers: MEDIA_HEADERS });
  });
  assert.equal(method, "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("Content-Length"), "10");
  assert.equal(await head.text(), "");
  const invalid = await relayMedia(new Request(RELAY, { headers: { Range: "bytes=99-" } }),
    async () => new Response(null, { status: 416, headers: { "Content-Range": "bytes */10" } }));
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get("Content-Range"), "bytes */10");
});

test("relay rejects arbitrary paths, methods, queries, and multipart ranges before fetching", async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return upstream(); };
  for (const request of [new Request(RELAY + "?url=https://private.example"),
    new Request(RELAY.replace("sintel.mp4", "other.mp4")),
    new Request(RELAY, { method: "POST" }),
    new Request(RELAY, { headers: { Range: "bytes=0-1,3-4" } })]) {
    const result = await relayMedia(request, fetcher);
    assert.ok([400, 404, 405].includes(result.status));
  }
  assert.equal(calls, 0);
  assert.equal((await worker.fetch(new Request(RELAY.replace("sintel.mp4", "other.mp4")), {})).status, 404);
});

test("redirects, wrong types, compression, and upstream failures fail closed", async () => {
  const request = new Request(RELAY);
  const cases = [
    () => new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/private" } }),
    () => upstream("<html></html>", 200, { ...MEDIA_HEADERS, "Content-Type": "text/html" }),
    () => upstream("compressed", 200, { ...MEDIA_HEADERS, "Content-Encoding": "gzip" }),
    () => new Response(null, { status: 503 }),
  ];
  for (const make of cases) {
    const response = await relayMedia(request, async () => make());
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
  assert.equal((await relayMedia(request, async () => { throw new Error("network failed"); })).status, 502);
});

test("mismatched or malformed upstream 206 is rejected rather than mislabeled", async () => {
  const request = new Request(RELAY, { headers: { Range: "bytes=0-1" } });
  for (const headers of [
    { ...MEDIA_HEADERS, "Content-Length": "2", "Content-Range": "bytes 3-4/10" },
    { ...MEDIA_HEADERS, "Content-Length": "3", "Content-Range": "bytes 0-1/10" },
    { ...MEDIA_HEADERS, "Content-Length": "2", "Content-Range": "invalid" },
  ]) {
    const response = await relayMedia(request, async () => upstream("01", 206, headers));
    assert.equal(response.status, 502);
  }
});

test("Flower relays exact bytes, valid ranges, HEAD, and upstream 416", async () => {
  const bytes = "0123456789";
  let target;
  const fetcher = async (url, init) => {
    target = url;
    assert.equal(init.redirect, "manual");
    assert.equal(init.headers.get("Authorization"), null);
    assert.equal(init.headers.get("Cookie"), null);
    if (init.method === "HEAD") return new Response(null, { status: 200, headers: MEDIA_HEADERS });
    const range = init.headers.get("Range");
    if (range === "bytes=2-5") return upstream(bytes.slice(2, 6), 206, {
      ...MEDIA_HEADERS, "Content-Length": "4", "Content-Range": "bytes 2-5/10",
    });
    if (range === "bytes=99-") return new Response(null, { status: 416,
      headers: { "Content-Range": "bytes */10" } });
    return upstream(bytes);
  };
  const full = await relayMedia(new Request(FLOWER_RELAY, { headers: {
    Authorization: "Bearer private", Cookie: "private",
  } }), fetcher);
  assert.equal(target, FLOWER_UPSTREAM);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("Content-Length"), "10");
  assert.equal(await full.text(), bytes);
  const partial = await relayMedia(new Request(FLOWER_RELAY, { headers: {
    Range: "bytes=2-5",
  } }), fetcher);
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("Content-Range"), "bytes 2-5/10");
  assert.equal(partial.headers.get("Content-Length"), "4");
  assert.equal(await partial.text(), bytes.slice(2, 6));
  const head = await relayMedia(new Request(FLOWER_RELAY, { method: "HEAD" }), fetcher);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("Content-Length"), "10");
  assert.equal(await head.text(), "");
  const unsatisfiable = await relayMedia(new Request(FLOWER_RELAY, {
    headers: { Range: "bytes=99-" },
  }), fetcher);
  assert.equal(unsatisfiable.status, 416);
  assert.equal(unsatisfiable.headers.get("Content-Range"), "bytes */10");
});

test("Flower path rejects query, methods, and multipart ranges before upstream fetch", async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return upstream(); };
  const cases = [
    [FLOWER_RELAY + "?url=https://private.example", {}, 404],
    [FLOWER_RELAY, { method: "POST" }, 405],
    [FLOWER_RELAY, { headers: { Range: "bytes=0-1,3-4" } }, 400],
  ];
  for (const [url, init, status] of cases) {
    assert.equal((await relayMedia(new Request(url, init), fetcher)).status, status);
  }
  assert.equal(calls, 0);
});

test("Flower upstream access rejection remains a 502 without returning HTML", async () => {
  const response = await relayMedia(new Request(FLOWER_RELAY), async () =>
    new Response("<html>denied</html>", { status: 403,
      headers: { "Content-Type": "text/html" } }));
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.doesNotMatch(await response.text(), /denied|html/i);
});
