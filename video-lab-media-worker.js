
// Isolated Video Lab media delivery. Static assets currently ignore Range in
// local Wrangler; this Worker adds bounded-memory single-range responses for
// four fixed lab clips and relays two fixed public test sources.
const MEDIA = new Map([
  ["/media/sintel-original.mp4", 4372373],
  ["/media/sintel-faststart.mp4", 4369172],
  ["/media/sintel-compat.mp4", 5764843],
  ["/media/horizon-25min.mp4", 14663351],
]);
export function mediaSize(path) { return MEDIA.get(path); }
const RELAY_SOURCES = new Map([
  ["/media/relay/sintel.mp4", "https://media.w3.org/2010/05/sintel/trailer.mp4"],
  ["/media/relay/flower.mp4", "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4"],
]);

function requestedRange(value) {
  if (!value || value.length > 80) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : null;
  const end = match[2] ? Number(match[2]) : null;
  if ((start !== null && !Number.isSafeInteger(start))
    || (end !== null && !Number.isSafeInteger(end))
    || (start === null && end === 0)
    || (start !== null && end !== null && end < start)) return null;
  return { start, end };
}

function matchingRange(requested, start, end, total) {
  if (requested.start === null) {
    return start === Math.max(0, total - requested.end) && end === total - 1;
  }
  return start === requested.start
    && end === (requested.end === null ? total - 1 : Math.min(requested.end, total - 1));
}

async function discard(response) {
  if (response.body) await response.body.cancel().catch(function () {});
}

function relayError(status, message) {
  return new Response(message, { status, headers: { "Cache-Control": "no-store" } });
}

export async function relayMedia(request, fetchUpstream = fetch) {
  const url = new URL(request.url);
  const source = RELAY_SOURCES.get(url.pathname);
  if (!source || url.search) return relayError(404, "Not found");
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405,
      headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" } });
  }
  const rangeHeader = request.method === "GET" ? request.headers.get("Range") : null;
  const range = rangeHeader ? requestedRange(rangeHeader) : null;
  if (rangeHeader && !range) return relayError(400, "Invalid single-byte range");

  const headers = new Headers({ Accept: "video/mp4", "Accept-Encoding": "identity" });
  if (rangeHeader) {
    headers.set("Range", rangeHeader);
    const ifRange = request.headers.get("If-Range");
    if (ifRange && ifRange.length <= 200) headers.set("If-Range", ifRange);
  }
  let upstream;
  try {
    upstream = await fetchUpstream(source,
      { method: request.method, headers, redirect: "manual" });
  } catch (_error) {
    return relayError(502, "Upstream unavailable");
  }
  if (upstream.status === 416 && rangeHeader) {
    const contentRange = upstream.headers.get("Content-Range");
    await discard(upstream);
    if (!/^bytes \*\/\d+$/.test(contentRange || "")) {
      return relayError(502, "Invalid upstream range response");
    }
    return new Response(null, { status: 416, headers: {
      "Content-Range": contentRange, "Accept-Ranges": "bytes", "Cache-Control": "no-store",
    } });
  }
  if (upstream.status !== 200 && upstream.status !== 206) {
    console.warn("Media upstream rejected:", {
      status: upstream.status,
      contentType: upstream.headers.get("Content-Type"),
    });
    await discard(upstream);
    return relayError(502, "Upstream media request failed");
  }
  if (!/^video\/mp4(?:\s*;|$)/i.test(upstream.headers.get("Content-Type") || "")
    || (upstream.headers.get("Content-Encoding")
      && upstream.headers.get("Content-Encoding") !== "identity")) {
    await discard(upstream);
    return relayError(502, "Unexpected upstream media type or encoding");
  }

  const lengthHeader = upstream.headers.get("Content-Length");
  let length = lengthHeader === null ? null : Number(lengthHeader);
  if (length !== null && (!Number.isSafeInteger(length) || length < 0)) {
    await discard(upstream);
    return relayError(502, "Invalid upstream media length");
  }
  const responseHeaders = new Headers({ "Content-Type": "video/mp4" });
  for (const name of ["ETag", "Last-Modified", "Cache-Control", "Expires", "Accept-Ranges"]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  if (!responseHeaders.has("Cache-Control")) responseHeaders.set("Cache-Control", "public, max-age=300");

  if (upstream.status === 206) {
    const value = upstream.headers.get("Content-Range");
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value || "");
    const start = match && Number(match[1]);
    const end = match && Number(match[2]);
    const total = match && Number(match[3]);
    if (!range || !match || ![start, end, total].every(Number.isSafeInteger)
      || total <= 0 || start > end || end >= total
      || !matchingRange(range, start, end, total)
      || (length !== null && length !== end - start + 1)) {
      await discard(upstream);
      return relayError(502, "Invalid upstream range response");
    }
    length = end - start + 1;
    responseHeaders.set("Content-Range", value);
    responseHeaders.set("Accept-Ranges", "bytes");
  } else if (upstream.headers.has("Content-Range")) {
    await discard(upstream);
    return relayError(502, "Unexpected upstream range header");
  }

  if (length !== null) responseHeaders.set("Content-Length", String(length));
  if (request.method === "HEAD") {
    await discard(upstream);
    return new Response(null, { status: 200, headers: responseHeaders });
  }
  if (!upstream.body) return relayError(502, "Upstream media body missing");
  return new Response(length === null ? upstream.body : fixedBody(upstream.body, length),
    { status: upstream.status, headers: responseHeaders });
}

function parseRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix === 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start >= size || end < start) return null;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function sliceStream(body, start, end) {
  const reader = body.getReader();
  let offset = 0;
  return new ReadableStream({
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          controller.error(new Error("Media asset ended before requested range"));
          return;
        }
        const next = offset + value.byteLength;
        if (next <= start) { offset = next; continue; }
        const from = Math.max(0, start - offset);
        const to = Math.min(value.byteLength, end + 1 - offset);
        offset = next;
        if (to > from) controller.enqueue(value.subarray(from, to));
        if (offset > end) {
          controller.close();
          await reader.cancel();
          return;
        }
        if (to > from) return;
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

function fixedBody(body, length) {
  // Workers ignores a manually supplied Content-Length on an ordinary
  // ReadableStream response. FixedLengthStream keeps both memory and the wire
  // length bounded. The fallback exists only for host-side unit tests.
  if (typeof FixedLengthStream !== "function") return body;
  const { readable, writable } = new FixedLengthStream(length);
  body.pipeTo(writable).catch(function () { /* Stream failure reaches the reader. */ });
  return readable;
}

export async function serveMedia(request, assets, size) {
    const path = new URL(request.url).pathname;
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    const rangeHeader = request.method === "GET" ? request.headers.get("Range") : null;
    const ifRange = request.headers.get("If-Range");
    const range = rangeHeader ? parseRange(rangeHeader, size) : null;
    if (rangeHeader && !range && !ifRange) {
      return new Response(null, { status: 416, headers: {
        "Accept-Ranges": "bytes", "Content-Range": `bytes */${size}`,
      } });
    }

    // Strip the client's Range header: the asset binding is the full-source
    // stream, and the Worker slices exactly one validated byte range.
    const asset = await assets.fetch(new Request(new URL(path, request.url)));
    if (!asset.ok || !asset.body) return new Response("Media unavailable", { status: 502 });
    const statedSize = asset.headers.get("Content-Length");
    if ((statedSize !== null && Number(statedSize) !== size) || asset.headers.get("Content-Encoding")) {
      await asset.body.cancel();
      return new Response("Media asset mismatch", { status: 502 });
    }
    const headers = new Headers(asset.headers);
    headers.set("Content-Type", "video/mp4");
    headers.set("Content-Length", String(size));
    headers.set("Accept-Ranges", "bytes");
    const matchingValidator = !ifRange || ifRange === asset.headers.get("ETag")
      || ifRange === asset.headers.get("Last-Modified");
    if (request.method === "HEAD" || !rangeHeader || !matchingValidator) {
      if (request.method === "HEAD") {
        await asset.body.cancel();
        return new Response(null, { status: 200, headers });
      }
      return new Response(fixedBody(asset.body, size), { status: 200, headers });
    }

    if (!range) {
      await asset.body.cancel();
      return new Response(null, { status: 416, headers: {
        "Accept-Ranges": "bytes", "Content-Range": `bytes */${size}`,
      } });
    }

    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    headers.set("Content-Length", String(range.end - range.start + 1));
    const length = range.end - range.start + 1;
    return new Response(fixedBody(sliceStream(asset.body, range.start, range.end), length),
      { status: 206, headers });
}

export default {
  fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/empty.vtt") {
      return new Response("WEBVTT\n\n99:00:00.000 --> 99:00:01.000\n.\n", {
        status: 200,
        headers: {
          "Content-Type": "text/vtt; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }
    if (RELAY_SOURCES.has(path)) return relayMedia(request);
    const size = MEDIA.get(path);
    if (!size) return new Response("Not found", { status: 404 });
    return serveMedia(request, env.ASSETS, size);
  },
};
