#!/usr/bin/env node
import http from "http";
import https from "https";
import fs from "fs";
import path from "path";
import assert from "assert/strict";
import { fileURLToPath } from "url";
import pw from "../../node_modules/playwright-core/index.js";

const { chromium } = pw;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const searchRoot = path.join(repoRoot, "universal-search");
const previewOrigin = "https://horizon-universal-search-preview.ali-al-anbari.workers.dev";
const shotDir = process.env.LG_SHOT_DIR || "/Users/alialanbari/.gemini/antigravity-cli/brain/6c7b660d-c664-4a6e-a300-ac1db356c7dc/scratch";
fs.mkdirSync(shotDir, { recursive: true });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg"
};

function proxyApiRequest(req, res) {
  const targetUrl = new URL(req.url, previewOrigin);
  const proxyReq = https.request(
    targetUrl,
    { method: req.method, headers: { "User-Agent": "HorizonLG-Verify/2.0", Accept: "application/json" } },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 200, {
        "Content-Type": proxyRes.headers["content-type"] || "application/json; charset=utf-8"
      });
      proxyRes.pipe(res);
    }
  );
  proxyReq.on("error", (err) => {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "proxy_error", detail: err.message }));
  });
  proxyReq.end();
}

function startWatchServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url, "http://127.0.0.1");
      if (reqUrl.pathname.startsWith("/api/")) {
        proxyApiRequest(req, res);
        return;
      }
      const rel = decodeURIComponent(reqUrl.pathname).replace(/^\/+/, "");
      const filePath = path.resolve(searchRoot, rel || "index.html");
      if (!filePath.startsWith(searchRoot) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      fs.createReadStream(filePath).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function dispatchKeyCode(page, key, keyCode) {
  await page.evaluate(({ k, kc }) => {
    const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    Object.defineProperty(ev, "keyCode", { get: () => kc });
    Object.defineProperty(ev, "which", { get: () => kc });
    (document.activeElement || document).dispatchEvent(ev);
  }, { k: key, kc: keyCode });
}

async function getHomeCardTitles(page) {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll("#watch-view .home-card"))
      .filter((el) => !el.closest("[hidden]"))
      .slice(0, 12)
      .map((el) => el.getAttribute("aria-label") || el.textContent || "");
  });
}

async function run() {
  const { server, port } = await startWatchServer();
  const baseUrl = `http://127.0.0.1:${port}/index.html`;
  const browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--autoplay-policy=no-user-gesture-required"]
  });

  try {
    // 1. Default/Vizio & Desktop entry (NO ?lg=1): 7 rail buttons, zero #arabic-toggle, defaults to Standard Horizon
    const vizioCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const vizioPage = await vizioCtx.newPage();
    await vizioPage.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await vizioPage.waitForSelector("#watch-top-row .home-card", { timeout: 15000 });
    const vizioState = await vizioPage.evaluate(() => ({
      lgMode: !!window.__HORIZON_LG_MODE__,
      arabicBtn: !!document.getElementById("arabic-toggle"),
      railCount: document.querySelectorAll(".watch-rail .rail-action").length,
      library: window.HorizonUniversalSearch.app.state.contentLibrary,
      subtitlePref: window.HorizonSearchCore.readSubtitlePref(window.localStorage)
    }));
    assert.deepEqual(vizioState, {
      lgMode: false,
      arabicBtn: false,
      railCount: 7,
      library: "standard",
      subtitlePref: "off"
    });
    // Also verify switching library works identically on Vizio/Desktop (universal setting!)
    await vizioPage.click("#settings-toggle");
    await vizioPage.waitForTimeout(200);
    await vizioPage.click("#settings-cat-library");
    await vizioPage.waitForTimeout(200);
    assert.equal(await vizioPage.textContent("#settings-content-library"), "Standard Horizon");
    await vizioPage.click("#settings-content-library");
    await vizioPage.waitForSelector("#watch-top-row .home-card", { timeout: 10000 });
    assert.equal(
      await vizioPage.evaluate(() => window.HorizonUniversalSearch.app.state.contentLibrary),
      "arabic",
      "Content Library switch must work universally on non-LG desktop/Vizio entry"
    );
    await vizioCtx.close();

    // 2. Fresh Chromium 79 Emulated Context (?lg=1) at 1920x1080: Device defaults cleanly to Standard Horizon
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    await context.addInitScript(() => {
      try {
        delete Element.prototype.replaceChildren;
        delete Document.prototype.replaceChildren;
        delete DocumentFragment.prototype.replaceChildren;
      } catch (_e) {}
    });

    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    const assetHttpErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(err.message));
    page.on("response", (res) => {
      if (res.url().startsWith(`http://127.0.0.1:${port}`) && res.status() >= 400) {
        assetHttpErrors.push(`${res.status()} ${res.url()}`);
      }
    });

    await page.goto(`${baseUrl}?lg=1`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#watch-top-row .home-card", { timeout: 15000 });
    await page.waitForTimeout(900);

    // Check Standard Home default
    assert.equal(await page.evaluate(() => document.querySelectorAll("#arabic-toggle").length), 0, "No #arabic-toggle allowed on rail");
    assert.equal(await page.evaluate(() => document.querySelectorAll(".watch-rail .rail-action").length), 7);
    assert.equal(await page.evaluate(() => window.HorizonUniversalSearch.app.state.contentLibrary), "standard");
    const standardTitles = await getHomeCardTitles(page);
    assert.ok(standardTitles.length > 0, "Standard Home must show cards");
    await page.screenshot({ path: path.join(shotDir, "lg-v3-01-standard-home.png") });

    // Confirm #lg-kb-lang-toggle is hidden in Standard Search even when keyboard is open
    await page.click("#search-toggle");
    await page.waitForTimeout(250);
    if (await page.isHidden("#keyboard")) await page.click("#keyboard-toggle");
    await page.waitForTimeout(150);
    assert.equal(await page.isHidden("#lg-kb-lang-toggle"), true, "Arabic keyboard toggle must be hidden in Standard library");

    // 3. Open Settings -> Library & Content -> Switch to Arabic Horizon — العربية
    await page.click("#settings-toggle");
    await page.waitForTimeout(250);
    await page.click("#settings-cat-library");
    await page.waitForTimeout(250);
    assert.equal(await page.textContent("#settings-content-library"), "Standard Horizon");
    await page.screenshot({ path: path.join(shotDir, "lg-v3-02-settings-library.png") });

    // Set subtitles preference to "on" temporarily or keep "off" & verify library switch doesn't mutate it
    const subPrefBefore = await page.evaluate(() => window.HorizonSearchCore.readSubtitlePref(window.localStorage));
    await page.click("#settings-content-library");
    await page.waitForSelector("#watch-top-row .home-card", { timeout: 10000 });
    await page.waitForTimeout(700);

    assert.equal(await page.evaluate(() => window.HorizonUniversalSearch.app.state.contentLibrary), "arabic");
    assert.equal(await page.isHidden("#watch-view"), false);
    const arHomeTitles = await getHomeCardTitles(page);
    assert.ok(arHomeTitles.some((t) => /[\u0600-\u06FF]/.test(t)), "Arabic Home must show Arabic titles immediately");
    assert.equal(
      await page.evaluate(() => window.HorizonSearchCore.readSubtitlePref(window.localStorage)),
      subPrefBefore,
      "Subtitles preference must remain independent of Content Library switch"
    );
    await page.screenshot({ path: path.join(shotDir, "lg-v3-03-arabic-home.png") });

    // 4. Verify TV, Movies, Discover, and Search all reflect Arabic Horizon
    await page.click("#tv-toggle");
    await page.waitForTimeout(500);
    const arTvTitles = await getHomeCardTitles(page);
    assert.ok(arTvTitles.some((t) => /[\u0600-\u06FF]/.test(t)), "TV tab in Arabic mode must show Arabic series");

    await page.click("#movies-toggle");
    await page.waitForTimeout(500);
    const arMovieTitles = await getHomeCardTitles(page);
    assert.ok(arMovieTitles.some((t) => /[\u0600-\u06FF]/.test(t)), "Movies tab in Arabic mode must show Arabic movies");

    await page.click("#discover-toggle");
    await page.waitForTimeout(500);
    const arDiscoverTitles = await getHomeCardTitles(page);
    assert.ok(arDiscoverTitles.some((t) => /[\u0600-\u06FF]/.test(t)), "Discover tab in Arabic mode must show Arabic titles");

    await page.click("#search-toggle");
    await page.waitForTimeout(250);
    if (await page.isHidden("#keyboard")) await page.click("#keyboard-toggle");
    await page.waitForTimeout(150);
    assert.equal(await page.isHidden("#lg-kb-lang-toggle"), false, "EN/Arabic keyboard toggle must be visible in Arabic library");
    await page.click("#lg-kb-lang-toggle");
    await page.waitForTimeout(150);
    assert.ok((await page.textContent("#lg-kb-lang-toggle")).includes("العربية"), "Keyboard toggle should switch to Arabic keys");
    await page.fill("#query", "رافت");
    await page.waitForSelector("#results .poster-card", { timeout: 10000 });
    const searchText = await page.textContent("#results");
    assert.ok(searchText.includes("رأفت الهجان") || searchText.includes("Raafat"), "Arabic search must return Raafat El-Haggan");
    await page.screenshot({ path: path.join(shotDir, "lg-v3-04-arabic-search.png") });

    // 5. Verify persistence across page reload (and per-device isolation already tested above)
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#watch-top-row .home-card", { timeout: 15000 });
    await page.waitForTimeout(600);
    assert.equal(await page.evaluate(() => window.HorizonUniversalSearch.app.state.contentLibrary), "arabic");
    const arReloadTitles = await getHomeCardTitles(page);
    assert.ok(arReloadTitles.some((t) => /[\u0600-\u06FF]/.test(t)), "Reloaded Arabic mode must stay in Arabic Home");

    // 6. Al-Mummia (TMDB 46707) should play through the verified free source.
    await page.click("#search-toggle");
    await page.waitForTimeout(200);
    await page.fill("#query", "المومياء");
    await page.waitForSelector('#results .poster-card[data-media-id="46707"]', { timeout: 8000 });
    await page.click('#results .poster-card[data-media-id="46707"]');
    await page.locator("#detail-actions .detail-primary").filter({ hasText: /^Play$/ }).waitFor({ timeout: 6000 });
    assert.equal(await page.locator("#lg-provider-menu, #lg-provider-select-btn, #lg-detail-availability").count(), 0);

    // Real HTML5 <video> Archive.org MP4 playback
    await page.click("#detail-actions .detail-primary");
    await page.waitForSelector("#lg-html5-video", { timeout: 10000 });
    assert.equal(await page.locator(".lg-player-status-card").count(), 0);
    await page.waitForFunction(() => {
      const v = document.getElementById("lg-html5-video");
      return v && v.readyState >= 2 && v.duration > 60 && v.currentTime > 0.3 && !v.paused;
    }, { timeout: 20000 });
    await page.screenshot({ path: path.join(shotDir, "lg-v3-05-mp4-playback.png") });

    await page.click("#lg-player-playpause");
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => document.getElementById("lg-html5-video").paused), true);
    await page.click("#lg-player-playpause");
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => document.getElementById("lg-html5-video").paused), false);
    await page.click("#lg-player-ff");
    await page.waitForTimeout(800);
    const seekedPos = await page.evaluate(() => document.getElementById("lg-html5-video").currentTime);
    assert.ok(seekedPos >= 9, `Seek +10s expected >= 9s, got ${seekedPos}`);

    await dispatchKeyCode(page, "GoBack", 461);
    await page.waitForTimeout(300);
    assert.equal(await page.isHidden("#lg-player-overlay"), true);
    const savedHistoryAfterPlay = await page.evaluate(() => localStorage.getItem("horizon-universal-search-history-v1") || "");
    assert.ok(savedHistoryAfterPlay.includes("46707"), "Archive.org playback progress must persist in shared history");

    // 7. Switch back to Standard Horizon via Settings -> Verify full restore + preserved history
    await page.click("#settings-toggle");
    await page.waitForTimeout(250);
    await page.click("#settings-cat-library");
    await page.waitForTimeout(250);
    assert.equal(await page.textContent("#settings-content-library"), "مكتبة هورايزن العربية");
    await page.click("#settings-content-library");
    await page.waitForSelector("#watch-top-row .home-card", { timeout: 15000 });
    await page.waitForTimeout(900);

    assert.equal(await page.evaluate(() => window.HorizonUniversalSearch.app.state.contentLibrary), "standard");
    assert.equal(await page.isHidden("#watch-view"), false);
    const restoredTitles = await getHomeCardTitles(page);
    assert.ok(restoredTitles.some((t) => /[A-Za-z]/.test(t)), "Restored Standard Home must show regular Horizon titles");
    assert.equal(await page.evaluate(() => document.querySelectorAll("#arabic-toggle").length), 0);

    // Search keyboard returns to English and hides toggle again
    await page.click("#search-toggle");
    await page.waitForTimeout(200);
    if (await page.isHidden("#keyboard")) await page.click("#keyboard-toggle");
    await page.waitForTimeout(150);
    assert.equal(await page.isHidden("#lg-kb-lang-toggle"), true, "Keyboard toggle must hide again when back in Standard Horizon");

    // Viewing history preserved across switch back to Standard
    const savedHistoryAfterRestore = await page.evaluate(() => localStorage.getItem("horizon-universal-search-history-v1") || "");
    assert.ok(savedHistoryAfterRestore.includes("46707"), "History must remain intact across library switches");

    await page.click("#watch-toggle");
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(shotDir, "lg-v3-06-restored-standard.png") });

    console.log(JSON.stringify({
      ok: true,
      vizioUniversalCheckPassed: true,
      arabicHomeSample: arHomeTitles.slice(0, 3),
      arabicTvSample: arTvTitles.slice(0, 3),
      arabicMovieSample: arMovieTitles.slice(0, 3),
      mp4SeekedSeconds: Number(seekedPos.toFixed(2)),
      restoredStandardSample: restoredTitles.slice(0, 3),
      screenshotsDir: shotDir,
      consoleErrors,
      pageErrors,
      assetHttpErrors
    }, null, 2));

    assert.equal(consoleErrors.length, 0, `Unexpected consoleErrors: ${consoleErrors.join("; ")}`);
    assert.equal(pageErrors.length, 0, `Unexpected pageErrors: ${pageErrors.join("; ")}`);
    assert.equal(assetHttpErrors.length, 0, `Unexpected assetHttpErrors: ${assetHttpErrors.join("; ")}`);
  } finally {
    await browser.close();
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    server.close();
  }
}

run().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
