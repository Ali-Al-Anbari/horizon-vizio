import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const server = http.createServer((req, res) => {
  const filePath = path.join(process.cwd(), req.url.split('?')[0]);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    const mime = ext === '.html' ? 'text/html' : ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : ext === '.svg' ? 'image/svg+xml' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.png' ? 'image/png' : 'text/plain';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404);
    res.end();
  }
});

const PORT = 4173;
server.listen(PORT, async () => {
  console.log(`Server listening on http://127.0.0.1:${PORT}`);
  
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  });
  
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1
  });

  try {
    fs.mkdirSync('./artifacts', { recursive: true });

    // Load Horizon Watch with mock=1
    await page.goto(`http://127.0.0.1:${PORT}/universal-search/index.html?mock=1&preview-history=1`, { waitUntil: 'networkidle' });
    
    // Wait for Watch Home to initialize
    await page.waitForSelector('#watch-toggle.is-current', { timeout: 8000 });
    console.log("Watch Home initialized successfully.");

    // Search or open Dragon Ball Super directly
    // Let's verify opening Dragon Ball Super
    await page.evaluate(() => {
      const dbs = window.HorizonSearchMock.title("tv", 62715);
      window.HorizonUniversalSearch.app.openDetails(dbs);
    });

    // Wait for details view to settle and metadata to load
    await page.waitForFunction(() => {
      const title = document.querySelector('#detail-title');
      const info = document.querySelector('#detail-information');
      const primary = document.querySelector('#detail-actions .detail-primary');
      return title && title.textContent === 'Dragon Ball Super' &&
             info && !info.hidden && info.children.length > 0 &&
             primary && !primary.disabled;
    }, { timeout: 8000 });

    // Wait a brief tick for any smooth-scrolling or layout transitions
    await page.waitForTimeout(300);

    // 1. Initial details view checks:
    const initialMetrics = await page.evaluate(() => {
      const scroller = document.querySelector('#detail-scroller');
      const title = document.querySelector('#detail-title');
      const meta = document.querySelector('#detail-year');
      const summary = document.querySelector('#detail-summary');
      const actions = document.querySelector('#detail-actions');
      const info = document.querySelector('#detail-information');
      const episodesView = document.querySelector('#episodes-view');
      const focusedEl = document.activeElement;

      const tRect = title.getBoundingClientRect();
      const mRect = meta.getBoundingClientRect();
      const sRect = summary.getBoundingClientRect();
      const aRect = actions.getBoundingClientRect();
      const iRect = info.getBoundingClientRect();
      const eRect = episodesView.getBoundingClientRect();

      return {
        scrollTop: scroller.scrollTop,
        focusedId: focusedEl ? (focusedEl.id || focusedEl.className) : null,
        focusedText: focusedEl ? focusedEl.textContent : null,
        title: { top: tRect.top, bottom: tRect.bottom },
        meta: { top: mRect.top, bottom: mRect.bottom, text: meta.textContent },
        summary: { top: sRect.top, bottom: sRect.bottom },
        actions: { top: aRect.top, bottom: aRect.bottom },
        info: { top: iRect.top, bottom: iRect.bottom, childrenCount: info.children.length },
        episodesView: { top: eRect.top, bottom: eRect.bottom }
      };
    });

    console.log("Initial Metrics:", JSON.stringify(initialMetrics, null, 2));

    // Verify 1: Initial details view is at the top of the page
    assert.equal(initialMetrics.scrollTop, 0, "Initial details view scroller must have scrollTop = 0");

    // Verify 2: Title, year, description, buttons, show metadata in exact vertical order with compact spacing
    assert.ok(initialMetrics.meta.top >= initialMetrics.title.bottom, "Year must be below title");
    assert.ok(initialMetrics.meta.top - initialMetrics.title.bottom <= 30, "Spacing between title and year must be compact (<=30px)");

    assert.ok(initialMetrics.summary.top >= initialMetrics.meta.bottom, "Description must be below year");
    assert.ok(initialMetrics.summary.top - initialMetrics.meta.bottom <= 30, "Spacing between year and description must be compact (<=30px)");

    assert.ok(initialMetrics.actions.top >= initialMetrics.summary.bottom, "Actions must be below description");
    assert.ok(initialMetrics.actions.top - initialMetrics.summary.bottom <= 30, "Spacing between description and actions must be compact (<=30px)");

    assert.ok(initialMetrics.info.top >= initialMetrics.actions.bottom, "Metadata must be below action buttons");
    assert.ok(initialMetrics.info.top - initialMetrics.actions.bottom <= 30, "Spacing between actions and metadata must be compact (<=30px)");

    // Verify 3: All five sections fit within 1920x1080 without scrolling or clipping
    assert.ok(initialMetrics.info.bottom <= 1080, `Show metadata bottom (${initialMetrics.info.bottom}) must be <= 1080 (no bottom clipping)`);
    assert.ok(initialMetrics.info.top > 0 && initialMetrics.title.top > 0, "Elements must be within top bounds");

    // Verify 4: Episode information is NOT visible on initial entry
    assert.ok(initialMetrics.episodesView.top >= 1080, `Episode view top (${initialMetrics.episodesView.top}) must be >= 1080 (not visible in initial viewport)`);

    // Verify Focus: Primary action button has focus
    assert.ok(initialMetrics.focusedId.includes("detail-primary") || initialMetrics.focusedText.includes("Play") || initialMetrics.focusedText.includes("Resume"),
      `Primary action button should be focused, but got: ${initialMetrics.focusedId} (${initialMetrics.focusedText})`);

    // Screenshot 1: Initial details view
    const shot1Path = './artifacts/dragon-ball-super-1-initial-hero.png';
    await page.screenshot({ path: shot1Path });
    console.log(`Saved screenshot 1: ${shot1Path}`);

    // Step 5: Pressing Down reveals the correct active episode in the correct season
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(400); // Wait for smooth scroll

    const downMetrics = await page.evaluate(() => {
      const scroller = document.querySelector('#detail-scroller');
      const focusedEl = document.activeElement;
      const seasonBtn = document.querySelector('#season-selector-btn');
      const epRow = document.querySelector('#episode-list');
      const fPanel = document.querySelector('#focused-episode-panel');

      const sRect = seasonBtn.getBoundingClientRect();
      const eRect = epRow.getBoundingClientRect();
      const fRect = fPanel.getBoundingClientRect();

      return {
        scrollTop: scroller.scrollTop,
        focusedId: focusedEl ? (focusedEl.id || focusedEl.className) : null,
        focusedSeason: focusedEl ? focusedEl.dataset.season : null,
        focusedEpisode: focusedEl ? focusedEl.dataset.episode : null,
        seasonLabel: seasonBtn.textContent.trim(),
        seasonBtn: { top: sRect.top, bottom: sRect.bottom },
        focusedPanel: { top: fRect.top, bottom: fRect.bottom },
        epRow: { top: eRect.top, bottom: eRect.bottom }
      };
    });

    console.log("Down Metrics:", JSON.stringify(downMetrics, null, 2));

    // Verify 5: Active episode in correct season is focused
    assert.ok(downMetrics.scrollTop > 0, "Scroller should have scrolled to episodes section");
    assert.equal(downMetrics.focusedSeason, "1", "Should focus season 1");
    assert.equal(downMetrics.focusedEpisode, "1", "Should focus episode 1");

    // Verify season selector and episode row visible together
    assert.ok(downMetrics.seasonBtn.top >= 0 && downMetrics.seasonBtn.bottom <= 1080, "Season selector must be visible in viewport");
    assert.ok(downMetrics.epRow.top >= 0 && downMetrics.epRow.bottom <= 1080, "Episode list row must be visible in viewport");

    // Screenshot 2: Episodes focused and visible
    const shot2Path = './artifacts/dragon-ball-super-2-episodes-focused.png';
    await page.screenshot({ path: shot2Path });
    console.log(`Saved screenshot 2: ${shot2Path}`);

    // Step 6: Up to season selector, then Up to hero
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(200);

    const upToSeason = await page.evaluate(() => {
      return document.activeElement === document.querySelector('#season-selector-btn');
    });
    assert.ok(upToSeason, "ArrowUp from episode should focus season selector");

    await page.keyboard.press('ArrowUp');
    await page.waitForFunction(() => {
      const scroller = document.querySelector('#detail-scroller');
      return scroller && scroller.scrollTop === 0 && !!document.activeElement.closest('#detail-actions');
    }, { timeout: 4000 });

    const backToHero = await page.evaluate(() => {
      const scroller = document.querySelector('#detail-scroller');
      return {
        scrollTop: scroller.scrollTop,
        activeInActions: !!document.activeElement.closest('#detail-actions')
      };
    });
    assert.equal(backToHero.scrollTop, 0, "ArrowUp from season selector should reset scrollTop to 0");
    assert.ok(backToHero.activeInActions, "ArrowUp from season selector should focus action button");

    // Step 7: Navigating back to Watch Home and reopening a title starts at the hero again
    await page.keyboard.press('Escape'); // Remote Back key
    await page.waitForFunction(() => {
      return !document.querySelector('#watch-view').hidden;
    }, { timeout: 5000 });
    console.log("Returned to Watch Home.");

    // Reopen Dragon Ball Super by clicking its card on Watch Home like a remote control OK button
    const homeCard = await page.waitForSelector('#watch-continue-row .home-card');
    assert.ok(homeCard, "Dragon Ball Super card should be on Watch Home");
    await homeCard.click();

    await page.waitForFunction(() => {
      const title = document.querySelector('#detail-title');
      const primary = document.querySelector('#detail-actions .detail-primary');
      return title && title.textContent === 'Dragon Ball Super' && primary && !primary.disabled;
    }, { timeout: 8000 });
    await page.waitForTimeout(300);

    const reopenedMetrics = await page.evaluate(() => {
      const scroller = document.querySelector('#detail-scroller');
      const epView = document.querySelector('#episodes-view');
      const focusedEl = document.activeElement;
      return {
        scrollTop: scroller.scrollTop,
        focusedId: focusedEl ? (focusedEl.id || focusedEl.className) : null,
        focusedText: focusedEl ? focusedEl.textContent : null,
        episodesTop: epView.getBoundingClientRect().top
      };
    });

    console.log("Reopened from Watch Home Card Metrics:", JSON.stringify(reopenedMetrics, null, 2));
    assert.equal(reopenedMetrics.scrollTop, 0, "Reopened details scroller must be at scrollTop = 0");
    assert.ok(reopenedMetrics.episodesTop >= 1080, "Episodes view must not be visible on initial reopened entry");
    assert.ok(reopenedMetrics.focusedId.includes("detail-primary"), "Primary action button should be focused on reopen");

    // Screenshot 3: Reopened hero
    const shot3Path = './artifacts/dragon-ball-super-3-reopened-hero.png';
    await page.screenshot({ path: shot3Path });
    console.log(`Saved screenshot 3: ${shot3Path}`);

    console.log("ALL PLAYWRIGHT CHECKS PASSED PERFECTLY!");
  } finally {
    await browser.close();
    server.close();
  }
});
