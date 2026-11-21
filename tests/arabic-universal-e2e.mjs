import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import pw from "../node_modules/playwright-core/index.js";
import { api as workerApi } from "../universal-search-worker.js";

const { chromium } = pw;

const PREVIEW_WORKER = "https://horizon-universal-search-preview.ali-al-anbari.workers.dev";
const WATCH_DIR = path.join(process.cwd(), "universal-search");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png"
};

const REQUIRED_14_TITLES = [
  { query: "إفراج", expected: /إفراج/, type: "tv", royaplayable: false },
  { query: "توابع", expected: /توابع/, type: "tv", royaplayable: false },
  { query: "المداح", expected: /المداح/, type: "tv", royaplayable: false },
  { query: "فخر الدلتا", expected: /فخر الدلتا/, type: "tv", royaplayable: false },
  { query: "الحشاشين", expected: /الحشاشين/, type: "tv", royaplayable: false },
  { query: "رأس الأفعى", expected: /رأس الأفعى/, type: "tv", royaplayable: false },
  { query: "رأفت الهجان", expected: /رأفت الهجان/, type: "tv", royaplayable: false },
  { query: "لن أعيش في جلباب أبي", expected: /لن أعيش في جلباب أبي/, type: "tv", royaplayable: false },
  { query: "باب الحارة", expected: /باب الحارة/, type: "tv", royaplayable: false },
  { query: "الهيبة", expected: /الهيبة/, type: "tv", royaplayable: false },
  { query: "رشاش", expected: /رشاش/, type: "tv", royaplayable: false },
  { query: "السبع", expected: /السبع/, type: "tv", royaplayable: true },
  { query: "أبناء القهر", expected: /أبناء القهر/, type: "tv", royaplayable: true },
  { query: "جلطة", expected: /جلطة/, type: "tv", royaplayable: true }
];

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const u = new URL(req.url, "http://127.0.0.1");
        if (u.pathname.startsWith("/api/")) {
          // Proxy /api/* to preview Worker so we exercise REAL network behavior + legacy fallback!
          const target = PREVIEW_WORKER + u.pathname + u.search;
          const up = await fetch(target);
          const buf = Buffer.from(await up.arrayBuffer());
          res.writeHead(up.status, { "Content-Type": up.headers.get("content-type") || "application/json" });
          res.end(buf);
          return;
        }
        let rel = decodeURIComponent(u.pathname);
        if (rel === "/") rel = "/index.html";
        const filePath = path.join(WATCH_DIR, rel);
        if (!filePath.startsWith(WATCH_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        const ext = path.extname(filePath);
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
        fs.createReadStream(filePath).pipe(res);
      } catch (err) {
        res.writeHead(500);
        res.end(err.message);
      }
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function startWorkerHybridServer() {
  // Uses local universal-search-worker.js for /api/arabic/* proxying TMDB calls to mock or preview
  // AND live ShoofAflam /api/titles.json so we test full /api/arabic/* ShoofAflam UI integration!
  const mockEnv = { TMDB_TOKEN: "hybrid-demo-token" };
  const hybridFetch = async (url) => {
    const u = String(url);
    if (u.startsWith("https://shoofaflam.tv/")) {
      return fetch(u);
    }
    if (u.includes("api.themoviedb.org/3/search/multi")) {
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
            popularity: 45,
            vote_count: 14
          }
        ]
      }), { status: 200 });
    }
    if (u.includes("/tv/301322/watch/providers")) {
      return new Response(JSON.stringify({ results: {} }), { status: 200 });
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
    if (u.includes("/tv/301322/season/1")) {
      return new Response(JSON.stringify({ season_number: 1, episodes: [{ episode_number: 1, name: "الحلقة 1", air_date: "2026-02-18" }] }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const u = new URL(req.url, "http://127.0.0.1");
        if (u.pathname.startsWith("/api/arabic/")) {
          const wRes = await workerApi(new Request("https://local.example" + u.pathname + u.search), mockEnv, { fetch: hybridFetch });
          const buf = Buffer.from(await wRes.arrayBuffer());
          res.writeHead(wRes.status, { "Content-Type": wRes.headers.get("content-type") || "application/json" });
          res.end(buf);
          return;
        }
        if (u.pathname.startsWith("/api/")) {
          const up = await fetch(PREVIEW_WORKER + u.pathname + u.search);
          const buf = Buffer.from(await up.arrayBuffer());
          res.writeHead(up.status, {
            "Content-Type": up.headers.get("content-type") || "application/json",
            "X-Horizon-Arabic-Api": "1"
          });
          res.end(buf);
          return;
        }
        let rel = decodeURIComponent(u.pathname);
        if (rel === "/") rel = "/index.html";
        const filePath = path.join(WATCH_DIR, rel);
        if (!filePath.startsWith(WATCH_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
          res.writeHead(404); res.end("Not found"); return;
        }
        res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
        fs.createReadStream(filePath).pipe(res);
      } catch (err) {
        res.writeHead(500); res.end(err.message);
      }
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function run() {
  const { server, port } = await startServer();
  const baseUrl = `http://127.0.0.1:${port}/?lg=1&device=ar-e2e`;
  const browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"]
  });

  const consoleErrors = [];
  const pageErrors = [];
  const resultsReport = [];

  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    page.on("console", msg => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", err => pageErrors.push(err.message));

    // Switch to Arabic Content Library via UI
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#settings-toggle", { timeout: 10000 });
    await page.click("#settings-toggle");
    await page.waitForSelector("#settings-cat-library", { timeout: 6000 });
    await page.click("#settings-cat-library");
    await page.waitForSelector("#settings-content-library", { timeout: 6000 });
    await page.click("#settings-content-library");
    await page.waitForSelector("#watch-top-row .home-card", { timeout: 10000 });
    await page.waitForTimeout(400);

    // Go to Search screen
    await page.click("#search-toggle");
    await page.waitForSelector("#query", { timeout: 6000 });
    await page.waitForTimeout(300);

    // Ensure Roya live catalog is warmed up cleanly
    await page.evaluate(() => window.HorizonRoyaCatalog && window.HorizonRoyaCatalog.ensureCatalogLoaded());

    // 1. Test ALL 14 required Arabic titles
    for (const item of REQUIRED_14_TITLES) {
      const t0 = Date.now();
      await page.fill("#query", "");
      await page.fill("#query", item.query);
      await page.press("#query", "Enter");
      await page.waitForFunction(
        () => {
          const st = document.getElementById("search-status");
          return st && !st.textContent.includes("Searching");
        },
        null,
        { timeout: 12000 }
      );
      const elapsed = Date.now() - t0;
      const cards = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("#results .poster-card")).map(el => ({
          id: Number(el.dataset.mediaId),
          type: el.dataset.mediaType,
          text: el.textContent.trim(),
          title: (el.querySelector("strong") || {}).textContent || ""
        }));
      });
      const hit = cards.find(c => item.expected.test(c.text));
      assert.ok(hit, `Query "${item.query}" must return a matching result; got ${JSON.stringify(cards.slice(0, 5))}`);
      // Deduplication check: should not have duplicate cards with identical titleAr + type
      const dupes = cards.filter(c => c.type === hit.type && c.title === hit.title);
      assert.equal(dupes.length, 1, `Duplicate cards found for "${item.query}": ${JSON.stringify(dupes)}`);

      resultsReport.push({
        query: item.query,
        matchedId: hit.id,
        matchedType: hit.type,
        title: hit.title,
        cardCount: cards.length,
        latencyMs: elapsed,
        info: hit.text
      });
    }

    // 2. Open إفراج Details & Episodes (Non-Roya discovery safety check)
    await page.fill("#query", "إفراج");
    await page.press("#query", "Enter");
    await page.waitForSelector('#results .poster-card[data-media-id="301322"]', { timeout: 10000 });
    await page.click('#results .poster-card[data-media-id="301322"]');
    await page.waitForSelector("#lg-detail-availability", { timeout: 10000 });
    await page.waitForTimeout(800);

    const efragDetails = await page.evaluate(() => ({
      title: document.getElementById("detail-title")?.textContent || "",
      summary: document.getElementById("detail-summary")?.textContent || "",
      pill: document.getElementById("lg-detail-availability")?.textContent || "",
      primaryBtn: document.querySelector("#detail-actions .detail-primary")?.textContent || "",
      episodes: document.querySelectorAll("#episode-list .episode-play").length
    }));
    assert.ok(efragDetails.title.includes("إفراج"), "Details must show إفراج title");
    assert.ok(/[\u0600-\u06FF]/.test(efragDetails.summary), "Details must enrich Arabic overview from ArabCinemeta");
    assert.ok(efragDetails.episodes >= 15, `إفراج must load aired episode cards (>=15), got ${efragDetails.episodes}`);
    assert.ok(!efragDetails.primaryBtn.includes("Play S1"), `Must NOT falsely claim direct Play S1 on non-Roya title: ${efragDetails.primaryBtn}`);

    // Clicking primary button on non-Roya show MUST show Horizon unavailable/listing card, NEVER navigate to VidBolt!
    const beforeHref = page.url();
    await page.click("#detail-actions .detail-primary");
    await page.waitForSelector(".lg-player-status-card", { timeout: 5000 });
    assert.equal(page.url(), beforeHref, "Must NOT leave Horizon Watch or open VidBolt player-overlay.html");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("lg-player-overlay")?.hidden === true, null, { timeout: 4000 });

    // Back from Details -> Search
    await page.keyboard.press("Escape");
    await page.waitForSelector("#results .poster-card", { timeout: 4000 });

    // 3. Test المداح multi-season browsing
    await page.fill("#query", "المداح");
    await page.press("#query", "Enter");
    await page.waitForSelector('#results .poster-card[data-media-id="122543"]', { timeout: 10000 });
    await page.click('#results .poster-card[data-media-id="122543"]');
    await page.waitForSelector("#season-selector-btn", { timeout: 10000 });
    await page.waitForTimeout(600);
    const maddahSeasons = await page.evaluate(() => document.querySelectorAll("#seasons button").length);
    assert.ok(maddahSeasons >= 5, `المداح must show multi-season list (>=5), got ${maddahSeasons}`);
    await page.keyboard.press("Escape");
    await page.waitForSelector("#results .poster-card", { timeout: 4000 });

    // 4. Test السبع Roya HLS regression (must remain 100% playable!)
    await page.fill("#query", "السبع");
    await page.press("#query", "Enter");
    await page.waitForSelector('#results .poster-card[data-media-id="901714"]', { timeout: 10000 });
    await page.click('#results .poster-card[data-media-id="901714"]');
    await page.waitForSelector("#detail-actions .detail-primary", { timeout: 8000 });
    await page.waitForTimeout(500);
    const sabaaBtn = await page.textContent("#detail-actions .detail-primary");
    assert.equal(sabaaBtn.trim(), "Play", `السبع primary action must display strictly "Play", got "${sabaaBtn}"`);
    await page.click("#detail-actions .detail-primary");
    await page.waitForFunction(() => {
      const ov = document.getElementById("lg-player-overlay");
      const v = document.querySelector("#lg-player-stage video");
      return ov && !ov.hidden && v && v.readyState >= 1;
    }, null, { timeout: 15000 });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    await page.keyboard.press("Escape");
    await page.waitForSelector("#results .poster-card", { timeout: 4000 });

    // 5. Resilience: Abort ArabCinemeta requests -> Search for فخر الدلتا STILL returns TMDB match cleanly
    await context.route("https://arabcinemeta.osamayousry.com/**", route => route.abort());
    await page.fill("#query", "فخر الدلتا");
    await page.press("#query", "Enter");
    await page.waitForSelector('#results .poster-card[data-media-id="297621"]', { timeout: 10000 });
    await context.unroute("https://arabcinemeta.osamayousry.com/**");

    // 6. Standard Horizon regression check
    await page.click("#settings-toggle");
    await page.waitForSelector("#settings-cat-library", { timeout: 6000 });
    await page.click("#settings-cat-library");
    await page.waitForSelector("#settings-content-library", { timeout: 6000 });
    await page.click("#settings-content-library");
    await page.waitForSelector("#watch-top-row .home-card", { timeout: 10000 });
    await page.waitForTimeout(300);
    await page.click("#search-toggle");
    await page.fill("#query", "South Park");
    await page.press("#query", "Enter");
    await page.waitForSelector('#results .poster-card[data-media-id="2190"]', { timeout: 10000 });

    await context.close();

    // 7. Hybrid /api/arabic/* Worker + real Shoof Aflam JSON check for إفراج (Shahid VIP · MBC badge!)
    const hyb = await startWorkerHybridServer();
    try {
      const ctx2 = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
      const p2 = await ctx2.newPage();
      p2.on("pageerror", err => pageErrors.push(err.message));
      await p2.goto(`http://127.0.0.1:${hyb.port}/?lg=1&device=ar-hyb`, { waitUntil: "domcontentloaded" });
      await p2.waitForSelector("#settings-toggle", { timeout: 8000 });
      await p2.click("#settings-toggle");
      await p2.waitForSelector("#settings-cat-library", { timeout: 6000 });
      await p2.click("#settings-cat-library");
      await p2.waitForSelector("#settings-content-library", { timeout: 6000 });
      await p2.click("#settings-content-library");
      await p2.waitForSelector("#watch-top-row .home-card", { timeout: 10000 });
      await p2.waitForTimeout(300);
      await p2.click("#search-toggle");
      await p2.fill("#query", "إفراج");
      await p2.press("#query", "Enter");
      await p2.waitForSelector('#results .poster-card[data-media-id="301322"]', { timeout: 10000 });
      const hybCardText = await p2.textContent('#results .poster-card[data-media-id="301322"]');
      assert.ok(/Shahid|شاهد/i.test(hybCardText), `Updated Worker + ShoofAflam must show Shahid listing on إفراج card, got: ${hybCardText}`);
      await p2.click('#results .poster-card[data-media-id="301322"]');
      await p2.waitForSelector("#lg-detail-availability", { timeout: 8000 });
      await p2.waitForTimeout(500);
      const hybPill = await p2.textContent("#lg-detail-availability");
      assert.ok(/Subscription Required.*Shahid/i.test(hybPill), `Availability pill must show Subscription Required · Shahid, got: ${hybPill}`);
      await ctx2.close();
    } finally {
      hyb.server.close();
    }

    assert.equal(pageErrors.length, 0, `Uncaught page errors: ${JSON.stringify(pageErrors)}`);
    // Filter known benign third-party media/CORS noise only if explicitly empty -> expect zero!
    console.log("ALL 14 ARABIC TITLES VERIFIED:");
    console.table(resultsReport);
    console.log("Efrag details verified:", efragDetails);
    console.log("Console errors:", consoleErrors);
    assert.equal(consoleErrors.length, 0, `Console errors detected: ${JSON.stringify(consoleErrors)}`);
    console.log("UNIVERSAL_ARABIC_E2E_PASS");
  } finally {
    await browser.close();
    server.close();
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
