import test from "node:test";
import assert from "node:assert/strict";
import { localPreflight, smoke } from "../maintenance/check-media-release.mjs";

test("Watch and Video Lab local release preflight checks expected configuration", async () => {
  assert.equal((await localPreflight("watch")).target, "horizon-universal-search-preview");
  assert.equal((await localPreflight("video-lab")).target, "horizon-video-lab-preview");
});

test("release smoke checks assets and safe API errors without a session", async () => {
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push([url.pathname, options.credentials]);
    if (url.pathname.endsWith(".html")) return new Response(
      url.pathname === "/index.html" ? "Horizon Watch" : "player-frame");
    if (url.pathname === "/api/recommendations") return Response.json({ error: "invalid_query" }, { status: 400 });
    return Response.json({ code: "not_authorized" }, { status: 403 });
  };
  await smoke("watch", "https://horizon-universal-search-preview.example", fetcher);
  await smoke("video-lab", "https://horizon-video-lab-preview.example", fetcher);
  assert.deepEqual(requests, [["/index.html", "omit"], ["/api/recommendations", "omit"],
    ["/player-overlay.html", "omit"], ["/api/subtitles", "omit"]]);
});

test("release smoke fails closed on a missing secret or lost pairing guard", async () => {
  const page = async url => url.pathname.endsWith(".html")
    ? new Response(url.pathname === "/index.html" ? "Horizon Watch" : "player-frame")
    : Response.json({ error: "metadata_unconfigured" }, { status: 503 });
  await assert.rejects(smoke("watch", "https://horizon-universal-search-preview.example", page), /HTTP 503/);
  const publicSubtitle = async url => url.pathname.endsWith(".html")
    ? new Response("player-frame") : Response.json({ language: "en" });
  await assert.rejects(smoke("video-lab", "https://horizon-video-lab-preview.example", publicSubtitle), /HTTP 200/);
});
