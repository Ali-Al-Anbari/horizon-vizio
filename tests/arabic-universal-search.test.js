import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { api, arabicSearchCache, normalizeArabicText } from "../universal-search-worker.js";

const ENV = { TMDB_TOKEN: "test-secret" };
const req = p => new Request("https://search.example" + p);

function loadBrowserArabicStack() {
  const ctx = {
    globalThis: {},
    Date, Math, Object, Array, Number, String, Boolean, RegExp, JSON, Promise, Map, Set, Error, URL, encodeURIComponent, decodeURIComponent,
    setTimeout, clearTimeout,
    AbortController
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  for (const rel of [
    "universal-search/core.js",
    "universal-search/arabic-search-engine.js",
    "universal-search/arabic-catalog.js",
    "universal-search/arabic-providers.js"
  ]) {
    const code = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    vm.runInNewContext(code, ctx, { filename: rel });
  }
  return ctx;
}

test("ES5 / Chromium 79 syntax check across Arabic client modules", () => {
  for (const rel of [
    "universal-search/arabic-search-engine.js",
    "universal-search/arabic-catalog.js",
    "universal-search/arabic-providers.js",
    "universal-search/lg-webos-adapter.js",
    "universal-search/search.js"
  ]) {
    const src = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    // Strip strings/comments crudely when checking ?. / ?? or check syntax patterns safely:
    assert.equal(/\?\.[A-Za-z_$[]/.test(src), false, `${rel} must not use optional chaining (?.)`);
    assert.equal(/\?\?/.test(src), false, `${rel} must not use nullish coalescing (??)`);
    assert.equal(/:focus-visible/.test(src), false, `${rel} must not use :focus-visible`);
  }
});

test("Worker /api/arabic/search merges TMDB Arabic + Shoof Aflam platforms and rejects bad params", async () => {
  arabicSearchCache.clear();
  const bad = await api(req("/api/arabic/search?q=test&evil=1"), ENV);
  assert.equal(bad.status, 400);
  const badMethod = await api(new Request("https://search.example/api/arabic/search?q=test", { method: "POST" }), ENV);
  assert.equal(badMethod.status, 405);
  assert.equal((await api(req("/api/arabic/search?q=test"), {})).status, 503);

  const mockFetch = async (url) => {
    const u = String(url);
    if (u.startsWith("https://shoofaflam.tv/api/titles.json")) {
      return new Response(JSON.stringify([
        {
          slug: "efrag",
          title_ar: "إفراج",
          title_en: "Efrag",
          year: 2026,
          type: "series",
          platforms: ["shahid", "mbc"],
          poster_path: "/qpbB7nptAW47OcR7gZ2vduCR8uK.jpg"
        }
      ]), { status: 200 });
    }
    if (u.startsWith("https://shoofaflam.tv/api/platforms.json")) {
      return new Response(JSON.stringify([
        { slug: "shahid", name_ar: "شاهد VIP", name_en: "Shahid VIP", url: "https://shahid.mbc.net" },
        { slug: "mbc", name_ar: "MBC", name_en: "MBC", url: "https://mbc.net" }
      ]), { status: 200 });
    }
    if (u.includes("api.themoviedb.org")) {
      return new Response(JSON.stringify({
        total_pages: 1,
        results: [
          {
            media_type: "tv",
            id: 301322,
            name: "إفراج",
            original_name: "إفراج",
            original_language: "ar",
            first_air_date: "2026-02-18",
            poster_path: "/qpbB7nptAW47OcR7gZ2vduCR8uK.jpg",
            popularity: 42,
            vote_count: 15
          }
        ]
      }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };

  const res = await api(req("/api/arabic/search?q=" + encodeURIComponent("إفراج") + "&type=all"), ENV, { fetch: mockFetch });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].id, 301322);
  assert.equal(body.results[0].titleAr, "إفراج");
  assert.equal(body.results[0].sources.includes("shoofaflam"), true);
  assert.deepEqual(body.results[0].regionalPlatforms.map(p => p.slug), ["shahid", "mbc"]);
  assert.equal(body.results[0].regionalPlatforms[0].tier, "subscription");
  assert.equal(body.attribution.shoofAflam, "shoofaflam.tv");
});

test("Worker /api/arabic/title and /season return localized metadata, MENA providers, and aired episodes", async () => {
  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes("language=en-US")) {
      return new Response(JSON.stringify({ id: 301322, name: "Release", overview: "Egyptian drama." }), { status: 200 });
    }
    if (u.includes("/tv/301322?")) {
      return new Response(JSON.stringify({
        id: 301322,
        name: "إفراج",
        original_name: "إفراج",
        original_language: "ar",
        first_air_date: "2026-02-18",
        overview: "",
        seasons: [{ season_number: 1, episode_count: 30, name: "الموسم 1" }],
        external_ids: { imdb_id: "tt39635402" }
      }), { status: 200 });
    }
    if (u.includes("/watch/providers")) {
      return new Response(JSON.stringify({
        results: {
          EG: { flatrate: [{ provider_id: 1715, provider_name: "Watch It", logo_path: "/wit.png" }] },
          SA: { flatrate: [{ provider_id: 1750, provider_name: "Shahid VIP", logo_path: "/sh.png" }] }
        }
      }), { status: 200 });
    }
    if (u.includes("/season/1?")) {
      return new Response(JSON.stringify({
        season_number: 1,
        episodes: [
          { episode_number: 1, name: "الحلقة 1", air_date: "2026-02-18", overview: "الأولى" },
          { episode_number: 2, name: "Special", air_date: "2026-02-19", episode_type: "special" },
          { episode_number: 3, name: "Future", air_date: "2099-01-01" }
        ]
      }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };

  const dRes = await api(req("/api/arabic/title/tv/301322"), ENV, { fetch: mockFetch, shoofAflam: false });
  assert.equal(dRes.status, 200);
  const dBody = await dRes.json();
  assert.equal(dBody.titleAr, "إفراج");
  assert.equal(dBody.imdbId, "tt39635402");
  assert.equal(dBody.overview, "Egyptian drama.");
  assert.equal(dBody.watchProviders.some(p => p.name === "Watch It" && p.region === "EG"), true);

  const sRes = await api(req("/api/arabic/season/tv/301322/1"), ENV, { fetch: mockFetch });
  assert.equal(sRes.status, 200);
  const sBody = await sRes.json();
  assert.deepEqual(sBody.episodes.map(e => e.number), [1]);
});

test("normalizeArabicText handles Alef, Ta Marbuta, Alef Maksura, Harakaat, Tatweel, and numerals", () => {
  assert.equal(normalizeArabicText("إِفْـــرَاج"), "افراج");
  assert.equal(normalizeArabicText("باب الحارة ١٢"), "باب الحاره 12");
  assert.equal(normalizeArabicText("أبناء القهر"), "ابناء القهر");
  assert.equal(normalizeArabicText("على"), "علي");
});

test("Client multi-source search falls back gracefully on 400 legacy Worker, deduplicates, filters English noise, and preserves availability honesty", async () => {
  const ctx = loadBrowserArabicStack();
  const engine = ctx.HorizonArabicSearchEngine;
  const catalog = ctx.HorizonArabicCatalog;
  const providers = ctx.HorizonArabicProviders;
  engine._resetTestState();

  const mockFetch = async (url) => {
    const u = String(url);
    // Simulate legacy Worker that rejects /api/arabic/* with 400 invalid_route!
    if (u.startsWith("/api/arabic/")) {
      return new Response(JSON.stringify({ error: "invalid_route" }), { status: 400 });
    }
    if (u.startsWith("/api/search?")) {
      return new Response(JSON.stringify({
        results: [
          { id: 301322, type: "tv", title: "Release", originalTitle: "إفراج", originalLanguage: "ar", date: "2026-02-18", poster: "/efrag.jpg", popularity: 30 },
          { id: 999999, type: "movie", title: "Random English Noise", originalTitle: "Random English Noise", originalLanguage: "en", date: "2020-01-01", popularity: 99 }
        ]
      }), { status: 200 });
    }
    if (u.includes("arabcinemeta.osamayousry.com/catalog/series/")) {
      return new Response(JSON.stringify({
        metas: [
          { id: "tt39635402", type: "series", name: "إفراج", releaseInfo: "2026", poster: "https://btttr.cc/efrag.jpg" },
          { id: "tt0251656", type: "series", name: "David Cross: The Pride Is Back", releaseInfo: "1999" }
        ]
      }), { status: 200 });
    }
    if (u.includes("arabcinemeta.osamayousry.com/catalog/movie/")) {
      return new Response(JSON.stringify({ metas: [] }), { status: 200 });
    }
    throw new Error("unexpected url " + u);
  };

  const out = await catalog.searchAsync("إفراج", "all", { fetch: mockFetch });
  assert.equal(out.results.length, 1, "Should deduplicate TMDB + ArabCinemeta and exclude non-Arabic noise");
  assert.equal(out.results[0].id, 301322);
  assert.equal(out.results[0].imdbId, "tt39635402");
  assert.equal(out.results[0].availabilityState, "metadata_only");
  assert.equal(providers.preferredDefaultProvider({ type: "tv", tmdbId: 301322 }) !== "vidbolt", true);
  const resolved = providers.resolveAll({ type: "tv", tmdbId: 301322 });
  assert.equal(resolved.some(r => r.availability === "playable"), false, "Must NEVER mark non-Roya discovered series playable");
});

test("Client search survives single-source failure/timeout without crashing or losing healthy sources", async () => {
  const ctx = loadBrowserArabicStack();
  const engine = ctx.HorizonArabicSearchEngine;
  const catalog = ctx.HorizonArabicCatalog;
  engine._resetTestState();

  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes("arabcinemeta.osamayousry.com")) {
      throw new Error("simulated network timeout");
    }
    if (u.startsWith("/api/search?")) {
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "X-Horizon-Arabic-Api": "1" }
      });
    }
    if (u.startsWith("/api/arabic/search")) {
      return new Response(JSON.stringify({
        results: [
          {
            id: 304331, tmdbId: 304331, hasTmdbId: true, type: "tv",
            title: "توابع", titleAr: "توابع", titleEn: "Tawabea",
            originalLanguage: "ar", date: "2026-02-18",
            regionalPlatforms: [{ slug: "watchit", nameAr: "واتش ات", nameEn: "Watch iT", tier: "subscription" }],
            sources: ["tmdb", "shoofaflam"]
          }
        ],
        sources: { tmdb: true, shoofAflam: true }
      }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };

  const out = await catalog.searchAsync("توابع", "all", { fetch: mockFetch });
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].id, 304331);
  assert.equal(out.results[0].availabilityState, "subscription_required");
  assert.equal(out.metrics.sources.arabCinemeta, false);
  assert.equal(out.metrics.sources.tmdb, true);
  assert.equal(out.metrics.sources.shoofAflam, true);
});
