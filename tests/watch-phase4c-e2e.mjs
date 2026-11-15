import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const port = Number(process.env.HORIZON_CDP_PORT || 9227);
const base = process.env.HORIZON_SEARCH_URL || "http://127.0.0.1:8788/universal-search/index.html?mock=1";
const screenshotDir = "/Users/alialanbari/.gemini/antigravity-cli/brain/e0d0ce39-3a93-490f-ba17-d97b0acec382/screenshots";
fs.mkdirSync(screenshotDir, { recursive: true });

const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const tab = tabs.find(item => item.type === "page");
assert.ok(tab, "Chrome page tab found");
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });

let sequence = 0;
const pending = new Map();
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const task = pending.get(message.id);
  pending.delete(message.id);
  message.error ? task.reject(Error(message.error.message)) : task.resolve(message.result);
};

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

async function until(expression, msg = "") {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw Error(`Timed out waiting for: ${expression} (${msg})`);
}

async function capture(filename) {
  const res = await send("Page.captureScreenshot", { format: "png" });
  const buffer = Buffer.from(res.data, "base64");
  const filePath = path.join(screenshotDir, filename);
  fs.writeFileSync(filePath, buffer);
  console.log(`Saved screenshot: ${filePath}`);
}

const key = (name, repeat = false) => evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', {key:${JSON.stringify(name)},repeat:${repeat},bubbles:true}))`);
const release = name => evaluate(`document.dispatchEvent(new KeyboardEvent('keyup', {key:${JSON.stringify(name)},bubbles:true}))`);

async function seedHistory() {
  await evaluate(`(() => {
    localStorage.clear();
    const now = Date.now();
    const C = window.HorizonSearchCore;
    // Movies
    C.writeHistory(localStorage, C.item("movie", 550, "Fight Club", null, null, "off", now - 10000, {
      poster: "/fight-club.jpg",
      progress: { position: 3600, duration: 7200, completed: false, provider: "vidbolt", updatedAt: now - 10000 }
    }));
    C.writeHistory(localStorage, C.item("movie", 680, "Pulp Fiction", null, null, "off", now - 20000, {
      poster: "/pulp-fiction.jpg",
      progress: { position: 8400, duration: 9000, completed: false, provider: "vidbolt", updatedAt: now - 20000 }
    }));
    C.writeHistory(localStorage, C.item("movie", 155, "The Dark Knight", null, null, "off", now - 30000, {
      poster: "/dark-knight.jpg",
      progress: { position: 9120, duration: 9120, completed: true, provider: "vidbolt", updatedAt: now - 30000 }
    }));
    C.writeHistory(localStorage, C.item("movie", 13, "Forrest Gump", null, null, "off", now - 40000, { poster: "/forrest-gump.jpg" }));
    C.writeHistory(localStorage, C.item("movie", 27205, "Inception", null, null, "off", now - 50000, { poster: "/inception.jpg" }));

    // TV shows
    C.writeHistory(localStorage, C.item("tv", 2190, "South Park", 16, 4, "off", now - 5000, {
      episodeTitle: "Jewpacabra",
      poster: "/south-park.jpg",
      progress: { position: 540, duration: 1320, completed: false, provider: "vidbolt", updatedAt: now - 5000 }
    }));
    C.writeHistory(localStorage, C.item("tv", 1399, "Game of Thrones", 4, 2, "off", now - 15000, {
      episodeTitle: "The Lion and the Rose",
      poster: "/got.jpg",
      progress: { position: 1200, duration: 3200, completed: false, provider: "vidbolt", updatedAt: now - 15000 }
    }));
    C.writeHistory(localStorage, C.item("tv", 1396, "Breaking Bad", 5, 14, "off", now - 25000, {
      episodeTitle: "Ozymandias",
      poster: "/breaking-bad.jpg",
      progress: { position: 2820, duration: 2820, completed: true, provider: "vidbolt", updatedAt: now - 25000 }
    }));
    C.writeHistory(localStorage, C.item("tv", 60625, "Rick and Morty", 3, 7, "off", now - 35000, {
      episodeTitle: "The Ricklantis Mixup",
      poster: "/rick-and-morty.jpg"
    }));
    C.writeHistory(localStorage, C.item("tv", 66732, "Stranger Things", 2, 4, "off", now - 45000, {
      episodeTitle: "Will the Wise",
      poster: "/stranger-things.jpg"
    }));
  })()`);
}

async function navigate(viewport) {
  await send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1, mobile: false });
  const url = new URL(base);
  url.searchParams.set("mock", "1");
  url.searchParams.set("run", `p4c-${viewport.width}-${Date.now()}`);
  await send("Page.navigate", { url: url.href });
  await until("!!window.HorizonUniversalSearch && document.activeElement.id === 'watch-toggle'", "initial load");
}

try {
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.bringToFront");
  await send("Network.enable");
  await send("Network.setCacheDisabled", { cacheDisabled: true });

  const viewports = [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
    { width: 1024, height: 768 }
  ];

  for (const vp of viewports) {
    console.log(`\n=== Testing Viewport ${vp.width}x${vp.height} ===`);
    await navigate(vp);
    await seedHistory();

    // ---------------------------------------------------------
    // 1. HISTORY OVERVIEW
    // ---------------------------------------------------------
    await evaluate("document.querySelector('#history-toggle').click()");
    await until("document.querySelector('#history-view').hidden === false", "History view visible");
    await until("document.querySelector('#history-list button') !== null", "History items populated");

    // Verify overview structure
    assert.equal(await evaluate("document.querySelector('#history-overview').hidden"), false);
    assert.equal(await evaluate("document.querySelector('#history-all-view').hidden"), true);
    assert.equal(await evaluate("document.querySelector('#history-empty').hidden"), true);

    const historyItemsCount = await evaluate("document.querySelectorAll('#history-list button').length");
    assert.equal(historyItemsCount, 10, "History overview has 10 curated items");
    assert.equal(await evaluate("document.querySelectorAll('#history-movies-list button').length"), 5, "Movies section has 5 items");
    assert.equal(await evaluate("document.querySelectorAll('#history-tv-list button').length"), 5, "TV section has 5 items");

    // Verify 2:3 vertical poster cards with progress bar
    const firstArtRatio = await evaluate(`(() => {
      const art = document.querySelector('#history-list .history-card .poster-art');
      const r = art.getBoundingClientRect();
      return r.height / r.width;
    })()`);
    assert.ok(Math.abs(firstArtRatio - 1.5) < 0.1, `History card poster is 2:3 aspect ratio (got ratio ${firstArtRatio})`);

    // Focus on first history card to show white-blue aura
    await evaluate("document.querySelector('#history-list button').focus()");
    await capture(`verified_phase4c_history_overview_${vp.width}x${vp.height}.png`);

    // ---------------------------------------------------------
    // 2. HISTORY VIEW ALL (FULL LIBRARY)
    // ---------------------------------------------------------
    await evaluate("document.querySelector('#history-view-all').click()");
    await until("document.querySelector('#history-all-view').hidden === false", "History all view visible");
    assert.equal(await evaluate("document.querySelector('#history-overview').hidden"), true);

    const allItemsCount = await evaluate("document.querySelectorAll('#history-all-list button').length");
    assert.equal(allItemsCount, 10, "History All Media displays complete 10 items");

    // Test filter chips
    await evaluate("document.querySelector('#history-filter-movie').click()");
    const movieOnly = await evaluate(`[...document.querySelectorAll('#history-all-list button')].every(b => b.dataset.mediaType === 'movie')`);
    assert.ok(movieOnly, "Filter movies shows only movie items");
    assert.equal(await evaluate("document.querySelectorAll('#history-all-list button').length"), 5);

    await evaluate("document.querySelector('#history-filter-tv').click()");
    const tvOnly = await evaluate(`[...document.querySelectorAll('#history-all-list button')].every(b => b.dataset.mediaType === 'tv')`);
    assert.ok(tvOnly, "Filter TV shows only TV items");
    assert.equal(await evaluate("document.querySelectorAll('#history-all-list button').length"), 5);

    await evaluate("document.querySelector('#history-filter-all').click()");

    // Test client-side search input
    await evaluate("document.querySelector('#history-search-input').value = 'South'; document.querySelector('#history-search-input').dispatchEvent(new Event('input', {bubbles:true}))");
    assert.equal(await evaluate("document.querySelectorAll('#history-all-list button').length"), 1, "Filter input matches South Park");
    assert.equal(await evaluate("document.querySelector('#history-all-list strong').textContent"), "South Park");

    // Clear search filter
    await evaluate("document.querySelector('#history-search-input').value = ''; document.querySelector('#history-search-input').dispatchEvent(new Event('input', {bubbles:true}))");
    assert.equal(await evaluate("document.querySelectorAll('#history-all-list button').length"), 10);

    // Focus on filter chip for screenshot
    await evaluate("document.querySelector('#history-filter-all').focus()");
    await capture(`verified_phase4c_history_all_${vp.width}x${vp.height}.png`);

    // Test Back key from View All returns to History Overview with focus on #history-view-all
    await key("Escape");
    await until("document.querySelector('#history-overview').hidden === false", "History overview restored");
    assert.equal(await evaluate("document.activeElement.id"), "history-view-all", "Focus restored to View All button");

    // ---------------------------------------------------------
    // 3. SETTINGS LANDING SCREEN
    // ---------------------------------------------------------
    await evaluate("document.querySelector('#settings-toggle').click()");
    await until("document.querySelector('#settings-view').hidden === false", "Settings view visible");
    await until("document.querySelector('#settings-landing').hidden === false", "Settings landing visible");
    assert.equal(await evaluate("document.querySelector('#settings-subpage').hidden"), true);

    // Verify 4 category cards
    for (const cat of ["appearance", "browsing", "library", "about"]) {
      assert.ok(await evaluate(`document.querySelector('#settings-cat-${cat}') !== null`), `Category ${cat} card exists`);
      const summaryText = await evaluate(`document.querySelector('#settings-summary-${cat}').textContent`);
      assert.ok(summaryText.length > 0, `Category ${cat} summary is populated: ${summaryText}`);
    }

    // Focus on Appearance category card
    await evaluate("document.querySelector('#settings-cat-appearance').focus()");
    await capture(`verified_phase4c_settings_landing_${vp.width}x${vp.height}.png`);

    // ---------------------------------------------------------
    // 4. SETTINGS SUBPAGE: APPEARANCE & MOTION
    // ---------------------------------------------------------
    await evaluate("document.querySelector('#settings-cat-appearance').click()");
    await until("document.querySelector('#settings-subpage').hidden === false", "Settings subpage visible");
    assert.equal(await evaluate("document.querySelector('#settings-landing').hidden"), true);
    assert.equal(await evaluate("document.querySelector('#settings-panel-appearance').hidden"), false);

    // Verify controls exist in appearance panel
    for (const id of ["settings-poster-glide", "settings-hold-scroll", "settings-scroll-animations", "settings-hero-fade", "settings-artwork-fade", "settings-appearance-reset"]) {
      assert.ok(await evaluate(`document.getElementById('${id}') !== null`), `Control ${id} exists in appearance panel`);
    }

    // Focus poster glide toggle
    await evaluate("document.querySelector('#settings-poster-glide').focus()");
    await capture(`verified_phase4c_settings_appearance_${vp.width}x${vp.height}.png`);

    // Press Back key to return to landing with focus memory
    await key("Escape");
    await until("document.querySelector('#settings-landing').hidden === false", "Settings landing restored");
    assert.equal(await evaluate("document.activeElement.id"), "settings-cat-appearance", "Focus memory restored to appearance card");

    // ---------------------------------------------------------
    // 5. SETTINGS SUBPAGE: BROWSING & DISPLAY
    // ---------------------------------------------------------
    await evaluate("document.querySelector('#settings-cat-browsing').click()");
    await until("document.querySelector('#settings-panel-browsing').hidden === false", "Browsing panel visible");
    assert.ok(await evaluate("document.querySelector('#settings-hero-delay') !== null"), "Hero delay control exists");

    await evaluate("document.querySelector('#settings-hero-delay').focus()");
    await capture(`verified_phase4c_settings_browsing_${vp.width}x${vp.height}.png`);

    // Return to landing
    await key("Escape");
    await until("document.querySelector('#settings-landing').hidden === false", "Settings landing restored");
    assert.equal(await evaluate("document.activeElement.id"), "settings-cat-browsing", "Focus memory restored to browsing card");

    // ---------------------------------------------------------
    // 6. SEARCH SCREEN: EMPTY STATE
    // ---------------------------------------------------------
    await evaluate("document.querySelector('#search-toggle').click()");
    await until("document.querySelector('#search-view').hidden === false", "Search view visible");
    await evaluate("document.querySelector('#query').value = ''; document.querySelector('#query').dispatchEvent(new Event('input', {bubbles:true}))");
    await evaluate("document.querySelector('#query').focus()");
    await capture(`verified_phase4c_search_empty_${vp.width}x${vp.height}.png`);

    // ---------------------------------------------------------
    // 7. SEARCH SCREEN: POPULATED RESULTS WITH 2:3 POSTERS
    // ---------------------------------------------------------
    await evaluate("document.querySelector('#query').value = 'South'; document.querySelector('#query').dispatchEvent(new Event('input', {bubbles:true}))");
    await until("document.querySelector('#results button') !== null", "Search results populated");

    // Verify vertical 2:3 ratio of search posters
    const searchPosterRatio = await evaluate(`(() => {
      const art = document.querySelector('#results .search-card .poster-art');
      const r = art.getBoundingClientRect();
      return r.height / r.width;
    })()`);
    assert.ok(Math.abs(searchPosterRatio - 1.5) < 0.1, `Search poster is 2:3 vertical aspect ratio (got ratio ${searchPosterRatio})`);

    // Verify media type badge
    assert.ok(await evaluate("document.querySelector('#results .search-badge') !== null"), "Search badge exists on poster");

    // Focus on first search result card
    await evaluate("document.querySelector('#results button').focus()");
    await capture(`verified_phase4c_search_results_${vp.width}x${vp.height}.png`);
  }

  console.log("\n==========================================");
  console.log("PHASE 4C VISUAL & FUNCTIONAL E2E: ALL PASS");
  console.log("==========================================");
} finally {
  socket.close();
}
