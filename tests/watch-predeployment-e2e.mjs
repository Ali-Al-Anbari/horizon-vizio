import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const origin = "http://localhost:8798";
const assets = new URL("../universal-search/", import.meta.url);

async function withWatch(callback, availability = false, verifiedAsset = null, options = {}) {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, userAgent: options.userAgent });
    page.setDefaultTimeout(5000);
    const tickets = [];
    const mediaRequests = [];
    const isVerified = id => id === verifiedAsset || id === options.additionalAsset;
    const media = options.paired && await readFile(new URL("../video-lab/media/sintel-compat.mp4", import.meta.url));
    await page.route("**/*", async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (media && url.origin === "https://horizon.129-213-139-127.sslip.io" && url.pathname === "/relay") {
        assert.ok(isVerified(url.searchParams.get("id")));
        assert.equal(url.searchParams.get("ticket"), "fixture-ticket");
        const range = await request.headerValue("range");
        mediaRequests.push(range);
        const [, first, last] = /^bytes=(\d+)-(\d*)$/.exec(range);
        const start = Number(first), end = last ? Math.min(Number(last), media.length - 1) : media.length - 1;
        return route.fulfill({ status: 206, body: media.subarray(start, end + 1),
          headers: { "content-type": "video/mp4", "accept-ranges": "bytes",
            "content-range": `bytes ${start}-${end}/${media.length}` } });
      }
      if (url.origin !== origin) return route.abort();
      if (url.pathname === "/api/arabic/relay-availability") {
        assert.equal(await request.headerValue("cookie"), null);
        if (availability === "offline") return route.abort();
        return route.fulfill({ json: { enabled: availability } });
      }
      if (url.pathname === "/api/arabic/relay-ticket") {
        tickets.push(request.postDataJSON());
        if (options.paired) return route.fulfill({ json: { ticket: "fixture-ticket", ttlSeconds: 90, refreshesRemaining: 1 } });
        return route.fulfill({ status: 401, json: { code: "pairing_required" } });
      }
      if (url.pathname === "/api/arabic/relay-catalog") {
        if (options.catalogGate && url.searchParams.get("id") === verifiedAsset) await options.catalogGate;
        return route.fulfill({ json: { available: isVerified(url.searchParams.get("id")) } });
      }
      if (url.pathname.startsWith("/api/")) return route.fulfill({ status: 404 });
      const file = new URL("." + (url.pathname === "/" ? "/index.html" : url.pathname), assets);
      if (!file.href.startsWith(assets.href)) return route.abort();
      await route.fulfill({ path: fileURLToPath(file) });
    });
    const availabilitySettled = page.waitForEvent(availability === "offline" ? "requestfailed" : "requestfinished", {
      predicate: request => new URL(request.url()).pathname === "/api/arabic/relay-availability",
    });
    await page.goto(origin + (options.userAgent ? "/?mock=1" : "/?mock=1&lg=1"));
    await availabilitySettled;
    await callback(page, tickets, mediaRequests);
  } finally {
    await browser.close();
  }
}

async function selectArabicLibrary(page) {
  await page.locator("#settings-toggle").click();
  await page.locator("#settings-cat-library").click();
  await page.locator("#settings-content-library").click();
  await page.locator('html[lang="ar"]').waitFor();
}

async function openArabicMovie(page, id, title) {
  await page.evaluate(({ id, title }) => {
    const app = window.HorizonUniversalSearch.app;
    window.HorizonArabicSearchEngine.rememberDynamic({
      id, type: "movie", titleAr: title, date: "2024-01-04",
      regionalPlatforms: [{ slug: "watch-it", nameEn: "WATCH IT", subscriptionRequired: true }],
    });
    app.openDetails({ id, type: "movie", title, date: "2024-01-04" });
  }, { id, title });
}

test("Delayed free availability for الحريفة suppresses WATCH IT and one Play starts native MP4", async () => {
  let releaseCatalog;
  const catalogGate = new Promise(resolve => { releaseCatalog = resolve; });
  try {
    await withWatch(async (page, tickets, mediaRequests) => {
      await selectArabicLibrary(page);
      await openArabicMovie(page, 1197989, "الحريفة");
      const primary = page.locator("#detail-actions .detail-primary");
      const details = page.locator("#detail-copy");
      await primary.filter({ hasText: "جارٍ التحقق من التوفر…" }).waitFor();
      assert.equal(await primary.getAttribute("aria-disabled"), "true");
      await primary.evaluate(el => el.click());
      assert.deepEqual(tickets, []);
      assert.doesNotMatch(await details.innerText(), /WATCH IT|subscription|Provider/i);
      assert.equal(await page.locator("#lg-provider-select-btn, #lg-provider-menu, #lg-detail-availability").count(), 0);
      releaseCatalog();
      await primary.filter({ hasText: /^Play$/ }).waitFor();
      await primary.click();
      const video = page.locator("#lg-player-stage video");
      await page.waitForFunction(() => {
        const video = document.querySelector("#lg-player-stage video");
        return video && !video.paused && video.currentTime > 0 && video.videoWidth > 0;
      });
      assert.equal(await page.locator(".lg-player-status-card").count(), 0);
      assert.deepEqual(tickets, [{ episodeId: "movie-1197989" }]);
      assert.ok(mediaRequests.some(range => range.startsWith("bytes=")));
      await page.locator("#lg-player-playpause").click();
      assert.equal(await video.evaluate(video => video.paused), true);
      await video.evaluate(video => { video.currentTime = 15; });
      await page.waitForFunction(() => {
        const video = document.querySelector("#lg-player-stage video");
        return !video.seeking && Math.abs(video.currentTime - 15) < 1;
      });
      await page.locator("#lg-player-native").click();
      await page.waitForFunction(() => {
        const video = document.querySelector("#lg-player-stage video");
        return video && video.readyState >= 2 && Math.abs(video.currentTime - 15) < 1;
      });
      assert.equal(tickets.length, 1);
      await page.keyboard.press("Escape");
      await page.locator("#lg-player-overlay").waitFor({ state: "hidden" });
      assert.equal(await video.count(), 0);
    }, true, "movie-1197989", { catalogGate, paired: true });
  } finally {
    releaseCatalog();
  }
});

test("A late movie lookup cannot enable playback on a different title", async () => {
  let releaseCatalog;
  const catalogGate = new Promise(resolve => { releaseCatalog = resolve; });
  try {
    await withWatch(async (page, tickets) => {
      await selectArabicLibrary(page);
      await openArabicMovie(page, 1197989, "الحريفة");
      const original = page.waitForResponse(response => response.url().includes("relay-catalog?id=movie-1197989"));
      await openArabicMovie(page, 1316422, "عنوان غير متاح");
      const primary = page.locator("#detail-actions .detail-primary");
      await primary.filter({ hasText: /^غير متاح$/ }).waitFor();
      releaseCatalog();
      await original;
      await primary.filter({ hasText: /^غير متاح$/ }).waitFor();
      assert.equal(await primary.getAttribute("aria-disabled"), "true");
      assert.deepEqual(tickets, []);
    }, true, "movie-1197989", { catalogGate });
  } finally {
    releaseCatalog();
  }
});

for (const availability of [true, false, "offline"]) {
  test("Watch relay availability in the browser with response " + availability, async () => {
    await withWatch(async (page, tickets) => {
      await selectArabicLibrary(page);
      await page.evaluate(() => {
        const app = window.HorizonUniversalSearch.app;
        window.HorizonArabicSearchEngine.rememberDynamic({
          id: 297621, type: "tv", titleAr: "فخر الدلتا", date: "2026-02-19",
          seasons: [{ number: 1 }], seasonEpisodes: { 1: [{ number: 1, title: "Episode One" }] },
        });
        app.openDetails({ id: 297621, type: "tv", title: "فخر الدلتا" }, { season: 1, episode: 1 });
      });
      const primary = page.locator("#detail-actions .detail-primary");
      if (availability === true) {
        await primary.filter({ hasText: /^Play$/ }).waitFor();
        await primary.click();
        await page.getByRole("button", { name: "عرض رمز الإقران" }).waitFor();
        assert.deepEqual(tickets, [{ episodeId: "fakhr-el-delta-s01e01" }]);
      } else {
        await primary.filter({ hasText: /^غير متاح$/ }).waitFor();
        assert.equal(await primary.getAttribute("aria-label"), "غير متاح");
        await primary.evaluate(el => el.click());
        assert.equal(await page.getByRole("button", { name: "عرض رمز الإقران" }).count(), 0);
        assert.deepEqual(tickets, []);
      }
    }, availability);
  });
}

test("Next from فخر الدلتا S01E01 launches the exact next episode and keeps section progress", async () => {
  await withWatch(async (page, tickets) => {
    await selectArabicLibrary(page);
    await page.evaluate(() => {
      const app = window.HorizonUniversalSearch.app;
      const core = window.HorizonSearchCore;
      const id = 297621;
      core.writeEpisodeCatalog(localStorage, id, [{ number: 1, count: 2 }], Date.now());
      core.writeHistory(localStorage, core.item("tv", id, "English record", 1, 1, "none", Date.now(),
        { progress: { position: 25, duration: 130, provider: "vidbolt", updatedAt: Date.now() } }), "english");
      window.HorizonArabicSearchEngine.rememberDynamic({
        id, type: "tv", titleAr: "فخر الدلتا", date: "2026-02-19",
        seasons: [{ number: 1 }], seasonEpisodes: {
          1: [{ number: 1, title: "الحلقة الأولى" }, { number: 2, title: "الحلقة الثانية" }],
        },
      });
      app.openDetails({ id, type: "tv", title: "فخر الدلتا" }, { season: 1, episode: 1 });
    });
    await page.locator("#detail-actions .detail-primary").filter({ hasText: /^Play$/ }).click();
    const video = page.locator("#lg-player-stage video");
    await page.waitForFunction(() => document.querySelector("#lg-player-stage video")?.currentTime > 0);
    await video.evaluate(el => { el.currentTime = 42; });
    await page.waitForFunction(() => {
      const el = document.querySelector("#lg-player-stage video");
      return !el.seeking && el.readyState >= 2 && el.currentTime >= 42;
    });
    await page.locator("#lg-player-next").click();
    await page.waitForFunction(() => document.querySelector("#lg-player-episode").textContent.includes("الحلقة 2"));
    await page.waitForFunction(() => document.querySelector("#lg-player-stage video")?.currentTime > 0);
    assert.deepEqual(tickets, [{ episodeId: "fakhr-el-delta-s01e01" }, { episodeId: "tv-297621-s1-e2" }]);
    await page.keyboard.press("Escape");
    const positions = await page.evaluate(() => {
      const core = window.HorizonSearchCore;
      return Object.fromEntries(["arabic", "english"].map(section => [section,
        core.readHistory(localStorage, section).find(row => row.id === 297621 && row.episode === 1)?.progress?.position
      ]));
    });
    assert.ok(positions.arabic >= 42);
    assert.equal(positions.english, 25);
  }, true, "fakhr-el-delta-s01e01", { paired: true, additionalAsset: "tv-297621-s1-e2" });
});

for (const { name, arabic, userAgent } of [
  { name: "LG webOS Arabic", arabic: true },
  { name: "Vizio SmartCast English", arabic: false, userAgent: "Mozilla/5.0 Vizio SmartCast Chrome/79.0" },
]) {
  test(name + " Search fits and wraps results and keeps D-pad focus visible when scrolling", async () => {
    await withWatch(async page => {
      if (arabic) await selectArabicLibrary(page);
      await page.locator("#search-toggle").click();
      await page.evaluate(({ arabic }) => {
        const labels = arabic ? [
          "مسلسل طويل جدًا عن رحلة العائلة عبر المدن والقرى في المواسم الجديدة",
          "الحلقة الأخيرة من مسلسل تاريخي طويل ومشوّق من إنتاج عربي جديد",
        ] : [
          "An exceptionally long English title that should wrap across multiple readable lines",
          "A second long title describing an unexpected journey across distant lands",
        ];
        const rows = Array.from({ length: 20 }, (_, index) => ({ id: 6000 + index, type: "movie", title: labels[index % 2] }));
        window.HorizonArabicCatalog.searchAsync = () => Promise.resolve({ results: rows, preRanked: true });
        window.HorizonSearchMock.search = () => ({ results: rows, preRanked: true });
        const app = window.HorizonUniversalSearch.app;
        app.state.query = "fixture";
        app.searchNow(true);
      }, { arabic });
      const cards = page.locator("#results .search-card");
      await cards.nth(19).waitFor();
      const layout = await cards.evaluateAll(cards => {
        const grid = cards[0].parentElement, bounds = grid.getBoundingClientRect();
        const text = cards[0].querySelector("strong"), poster = cards[0].querySelector(".poster-art").getBoundingClientRect();
        return {
          lang: document.documentElement.lang,
          direction: getComputedStyle(text).direction,
          visible: cards.filter(card => card.getBoundingClientRect().bottom <= bounds.bottom).length,
          ratio: poster.height / poster.width,
          wrapped: getComputedStyle(text).whiteSpace === "normal" && text.clientHeight >= 2 * parseFloat(getComputedStyle(text).lineHeight),
          clipped: text.scrollWidth > text.clientWidth || text.scrollHeight > text.clientHeight || grid.scrollWidth > grid.clientWidth,
        };
      });
      assert.equal(layout.lang, arabic ? "ar" : "en");
      assert.equal(layout.direction, arabic ? "rtl" : "ltr");
      assert.ok(layout.visible >= 5);
      assert.ok(Math.abs(layout.ratio - 1.5) < 0.02);
      assert.equal(layout.wrapped, true);
      assert.equal(layout.clipped, false);
      assert.equal(await page.locator("#search-toggle .rail-label").textContent(), arabic ? "بحث" : "Search");
      assert.equal(await page.locator("#history-toggle .rail-label").textContent(), arabic ? "السجل" : "History");
      await cards.first().focus();
      await page.keyboard.press("ArrowRight");
      assert.equal(await cards.nth(1).evaluate(card => card === document.activeElement), true);
      for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
      await page.waitForFunction(() => {
        const grid = document.querySelector("#results"), card = document.activeElement;
        return card.classList.contains("is-focused") && grid.contains(card) && grid.scrollTop > 0
          && card.getBoundingClientRect().bottom <= grid.getBoundingClientRect().bottom;
      });
    }, false, null, { userAgent });
  });
}

test("Continue Watching routes Resume and Next to Details, Episodes, and Back with history intact", async () => {
  await withWatch(async page => {
    const watchCard = page.locator('#watch-continue-row [data-home-key="tv:2190"]');
    const primary = page.locator('#detail-actions [data-action="primary"]');
    const episodes = page.locator('#detail-actions [data-action="episodes"]');
    const view = () => page.evaluate(() => window.HorizonUniversalSearch.app.state.view);

    for (const completed of [false, true]) {
      const target = completed ? 4 : 3;
      await page.evaluate(completed => {
        const core = window.HorizonSearchCore;
        const now = Date.now();
        core.writeEpisodeCatalog(localStorage, 2190, [{ number: 14, count: 14 }], now);
        core.writeHistory(localStorage, core.item("tv", 2190, "South Park", 14, 3, "off", now, {
          progress: { position: completed ? 1200 : 400, duration: 1200, updatedAt: now, provider: "vidbolt", completed },
        }));
      }, completed);
      await page.reload();
      await watchCard.waitFor();
      assert.match(await watchCard.innerText(), new RegExp("S14 E" + target));
      await watchCard.click();
      await page.waitForFunction(() => window.HorizonUniversalSearch.app.state.detail?.id === 2190);
      assert.equal(await view(), "details");
      assert.equal(await page.locator("#episode-list .episode-play:focus").count(), 0);
      assert.equal(await primary.getAttribute("aria-label"), completed
        ? "Continue with Season 14, Episode 4" : "Resume Season 14, Episode 3");

      // Record the actual player handoff without launching an external provider.
      await page.evaluate(() => {
        window.__HORIZON_LG_LAUNCH__ = (...args) => { window.navigationTestLaunch = args; return true; };
      });
      await primary.click();
      assert.deepEqual(await page.evaluate(() => window.navigationTestLaunch.slice(0, 5)), ["tv", 2190, 14, target, false]);
      assert.equal(await view(), "details");

      await episodes.click();
      assert.equal(await view(), "episodes");
      await page.waitForFunction(number => document.activeElement.dataset.episode === String(number), target);
      await page.keyboard.press("Escape");
      assert.equal(await view(), "watch");
      assert.equal(await watchCard.evaluate(card => card === document.activeElement), true);
      await page.locator("#history-toggle").click();
      assert.equal(await view(), "history");
      assert.match(await page.locator("#history-list").innerText(), /South Park/);
      assert.deepEqual(await page.evaluate(() => window.HorizonSearchCore.readHistory(localStorage).map(
        row => [row.season, row.episode, row.progress.completed])), [[14, 3, completed]]);
    }
  });
});

test("Roya launched from English saves 42s progress to English only (immutable across mid-playback section switch, reverse direction, identical TMDB ID, reload & resume)", async () => {
  await withWatch(async page => {
    // Stub Roya ticket so playback overlay mounts deterministically offline without external network flakiness
    await page.route("https://ticket.roya-tv.com/**", route =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: true, data: { secured_url: "https://vod.kwikmotion.com/test/master.m3u8" } }),
      })
    );

    const runSessionSave = async ({ launchLib, switchLibDuringPlayback, positionSec }) => {
      return page.evaluate(({ launchLib, switchLibDuringPlayback, positionSec }) => {
        const app = window.HorizonUniversalSearch.app;
        const core = window.HorizonSearchCore;
        const arabic = window.HorizonArabicCatalog;

        // Register a verified Roya series (TMDB/Roya ID 901714) if not already in catalog
        if (!arabic.findByKey("tv", 901714)) {
          window.HorizonArabicSearchEngine.rememberDynamic({
            id: 901714, type: "tv", titleAr: "السبع", titleEn: "Al Sabaa", date: "2025-03-01",
            royaSeriesId: 1714,
            seasons: [{ number: 1 }],
            seasonEpisodes: { 1: [{ number: 1, title: "الحلقة 1", royaSeriesId: 1714, royaEpisodeId: 77701, durationSec: 2400 }] },
          });
        }

        app.state.contentLibrary = launchLib;
        core.writeLibraryPref(localStorage, launchLib);

        // Launch Roya HLS session from the originating section
        const launched = window.__HORIZON_LG_LAUNCH__("tv", 901714, 1, 1, false, "الحلقة 1");
        const v = document.getElementById("lg-html5-video");
        // Simulate observed playback at `positionSec` on the live <video> element
        Object.defineProperty(v, "currentTime", { configurable: true, get: () => positionSec });
        Object.defineProperty(v, "duration", { configurable: true, get: () => 2400 });
        v.dispatchEvent(new Event("playing"));
        v.dispatchEvent(new Event("timeupdate"));

        // Switch library mid-playback to prove session section stays immutable
        if (switchLibDuringPlayback) {
          app.state.contentLibrary = switchLibDuringPlayback;
          core.writeLibraryPref(localStorage, switchLibDuringPlayback);
        }

        return { launched };
      }, { launchLib, switchLibDuringPlayback, positionSec });
    };

    // 1. Launch Roya from English, switch to Arabic mid-playback, press Escape to save 42s -> MUST land in English only!
    const r1 = await runSessionSave({ launchLib: "standard", switchLibDuringPlayback: "arabic", positionSec: 42 });
    assert.equal(r1.launched, true);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("lg-player-overlay")?.hidden === true);

    const afterEnglishWatch = await page.evaluate(() => ({
      en: window.HorizonSearchCore.readHistory(localStorage, "english").map(r => ({ id: r.id, pos: r.progress?.position, sec: r.section })),
      ar: window.HorizonSearchCore.readHistory(localStorage, "arabic").map(r => ({ id: r.id, pos: r.progress?.position, sec: r.section })),
    }));
    assert.deepEqual(afterEnglishWatch.en, [{ id: 901714, pos: 42, sec: "english" }]);
    assert.deepEqual(afterEnglishWatch.ar, []);

    // 2. Reverse direction: launch SAME TMDB ID (901714) from Arabic, switch to English mid-playback, save 128s -> MUST land in Arabic only!
    const r2 = await runSessionSave({ launchLib: "arabic", switchLibDuringPlayback: "standard", positionSec: 128 });
    assert.equal(r2.launched, true);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("lg-player-overlay")?.hidden === true);

    // 3. Reload page and verify both sections keep independent positions & Resume reads the right section
    await page.reload();
    const afterReload = await page.evaluate(() => {
      const core = window.HorizonSearchCore;
      const en = core.readHistory(localStorage, "english");
      const ar = core.readHistory(localStorage, "arabic");
      return {
        en: en.map(r => ({ id: r.id, pos: r.progress?.position, sec: r.section })),
        ar: ar.map(r => ({ id: r.id, pos: r.progress?.position, sec: r.section })),
        enActive: core.readActiveEpisode(localStorage, 901714, "english"),
        arActive: core.readActiveEpisode(localStorage, 901714, "arabic"),
      };
    });
    assert.deepEqual(afterReload.en, [{ id: 901714, pos: 42, sec: "english" }]);
    assert.deepEqual(afterReload.ar, [{ id: 901714, pos: 128, sec: "arabic" }]);
    assert.equal(afterReload.enActive.episode, 1);
    assert.equal(afterReload.arActive.episode, 1);
  });
});
