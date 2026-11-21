import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const origin = "http://localhost:8798";
const assets = new URL("../universal-search/", import.meta.url);

async function withWatch(callback, availability = false) {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.setDefaultTimeout(5000);
    const tickets = [];
    await page.route("**/*", async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === "/api/arabic/relay-availability") {
        assert.equal(await request.headerValue("cookie"), null);
        if (availability === "offline") return route.abort();
        return route.fulfill({ json: { enabled: availability } });
      }
      if (url.pathname === "/api/arabic/relay-ticket") {
        tickets.push(request.postDataJSON());
        return route.fulfill({ status: 401, json: { code: "pairing_required" } });
      }
      if (url.pathname.startsWith("/api/")) return route.fulfill({ status: 404 });
      const file = new URL("." + (url.pathname === "/" ? "/index.html" : url.pathname), assets);
      if (!file.href.startsWith(assets.href)) return route.abort();
      await route.fulfill({ path: fileURLToPath(file) });
    });
    const availabilitySettled = page.waitForEvent(availability === "offline" ? "requestfailed" : "requestfinished", {
      predicate: request => new URL(request.url()).pathname === "/api/arabic/relay-availability",
    });
    await page.goto(origin + "/?mock=1&lg=1");
    await availabilitySettled;
    await callback(page, tickets);
  } finally {
    await browser.close();
  }
}

for (const availability of [true, false, "offline"]) {
  test("Watch relay availability in the browser with response " + availability, async () => {
    await withWatch(async (page, tickets) => {
      await page.evaluate(() => {
        const app = window.HorizonUniversalSearch.app;
        window.HorizonArabicSearchEngine.rememberDynamic({
          id: 297621, type: "tv", titleAr: "فخر الدلتا", date: "2026-02-19",
          seasons: [{ number: 1 }], seasonEpisodes: { 1: [{ number: 1, title: "Episode One" }] },
        });
        app.state.contentLibrary = "arabic";
        app.openDetails({ id: 297621, type: "tv", title: "فخر الدلتا" }, { season: 1, episode: 1 });
      });
      const primary = page.locator("#detail-actions .detail-primary");
      const relayOption = page.locator('[data-provider-id="akwam_relay"]');
      if (availability === true) {
        await page.getByText(/^(Play|Resume) \(Akwam Relay\)$/).waitFor();
        await page.locator("#lg-provider-select-btn").click();
        assert.match(await relayOption.innerText(), /Ready/i);
        await page.locator("#lg-provider-menu-close").click();
        await primary.click();
        await page.getByRole("button", { name: "Show pairing code" }).waitFor();
        assert.deepEqual(tickets, [{ episodeId: "fakhr-el-delta-s01e01" }]);
      } else {
        assert.match(await primary.innerText(), /Unavailable/i);
        assert.match(await primary.getAttribute("aria-label"), /Unavailable/i);
        await page.locator("#lg-provider-select-btn").click();
        assert.equal(await relayOption.count(), 0);
        await page.locator("#lg-provider-menu-close").click();
        assert.equal(await page.getByRole("button", { name: "Show pairing code" }).count(), 0);
        assert.deepEqual(tickets, []);
      }
    }, availability);
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
