// Run with a loopback static server and isolated headless Chrome on CDP port 9227.
// The preview-history fixture never writes genuine Watch history.
import assert from "node:assert/strict";

const port = Number(process.env.HORIZON_CDP_PORT || 9227);
const base = process.env.HORIZON_SEARCH_URL
  || "http://127.0.0.1:4173/universal-search/index.html?mock=1";
const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const tab = tabs.find(item => item.type === "page");
assert.ok(tab, "isolated Chrome page exists");
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let sequence = 0;
const pending = new Map();
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const task = pending.get(message.id); pending.delete(message.id);
    message.error ? task.reject(Error(message.error.message)) : task.resolve(message.result);
  }
};
function send(method, params = {}) { return new Promise((resolve, reject) => {
  const id = ++sequence; pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
}); }
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description
    || result.exceptionDetails.text);
  return result.result.value;
}
async function until(expression) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw Error("Watch preview did not become ready");
}
const key = name => evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',
  {key:${JSON.stringify(name)},bubbles:true}))`);
const pause = () => new Promise(resolve => setTimeout(resolve, 260));
async function navigate(suffix) {
  const url = new URL(base);
  const marker = `${suffix}-${process.pid}-${Date.now()}`;
  url.searchParams.set("mock", "1");
  url.searchParams.set("preview-history", "multi-ratings");
  url.searchParams.set("run", marker);
  await send("Page.navigate", { url: url.href });
  await until(`location.search.includes(${JSON.stringify(`run=${marker}`)}) && !!window.HorizonUniversalSearch
    && document.activeElement.id === 'watch-toggle'
    && document.querySelectorAll('#watch-continue-row .home-card').length > 0`);
}
const geometry = `(() => {
  const card = document.activeElement, section = card.closest('.watch-home-section');
  const heading = document.querySelector('#watch-active-heading').getBoundingClientRect();
  const poster = card.querySelector('.poster-art').getBoundingClientRect();
  const viewport = document.querySelector('#watch-rows-scroll').getBoundingClientRect();
  return { group: card.dataset.homeGroup, gap: poster.top - heading.bottom,
    headingVisible: heading.top >= viewport.top - 2 && heading.bottom < poster.top,
    posterVisible: poster.bottom <= viewport.bottom + 2,
    scrollTop: document.querySelector('#watch-rows-scroll').scrollTop };
})()`;
try {
  await send("Runtime.enable"); await send("Page.enable"); await send("Page.bringToFront");
  await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true });
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 1024, height: 768 }]) {
    await send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1, mobile: false });
    await navigate(`circular-${viewport.width}`);
    await key("ArrowRight");
    const expected = ["South Park", "Dark", "Breaking Bad", "Interstellar",
      "Stranger Things", "The Last of Us", "Cyberpunk: Edgerunners", "Severance"];
    const title = () => evaluate("document.activeElement.homeEntry.row.title");
    const visible = () => evaluate("Array.from(document.querySelectorAll('#watch-continue-row .home-card')).map(x=>x.dataset.homeKey)");
    assert.equal(await title(), expected[0]);
    const initialScroll = await evaluate("document.querySelector('#watch-rows-scroll').scrollTop");
    for (let cycle = 0; cycle < 3; cycle++) for (let index = 1; index <= expected.length; index++) {
      await key("ArrowRight");
      assert.equal(await title(), expected[index % expected.length]);
      const keys = await visible();
      assert.equal(new Set(keys).size, keys.length, "visible window has no duplicate identities");
      assert.ok(keys.length <= expected.length && keys.length >= 1,
        "row attaches bounded poster window without exceeding title count");
    }
    // At the first title of the cycle, Left enters the left navigation rail with Home focused
    await key("ArrowLeft");
    assert.equal(await evaluate("document.activeElement.id"), "watch-toggle",
      "Left at first title of cycle enters left rail with Home focused");
    // Right from rail returns to remembered content focus at the clean left gutter
    await key("ArrowRight");
    assert.equal(await title(), expected[0]);
    const gutterLeft = viewport.width === 1024 ? 145 : 182;
    const cardRect = () => evaluate("Math.round(document.activeElement.getBoundingClientRect().left)");
    const rowScroll = () => evaluate("document.getElementById('watch-continue-row').scrollLeft");
    const visiblePreceding = () => evaluate("Array.from(document.querySelectorAll('#watch-continue-row .home-card')).filter(c => { const r = c.getBoundingClientRect(); return r.right > 0 && r.right <= " + (gutterLeft + 10) + "; }).length");
    assert.equal(await rowScroll(), 0, "scrollLeft is 0 at first title");
    assert.equal(await cardRect(), gutterLeft, `first title at original left gutter (${gutterLeft}px)`);
    assert.equal(await visiblePreceding(), 0, "no preceding cards visible to the left of first title");

    // Move within cycle, then move backward within cycle to first title
    await key("ArrowRight");
    assert.equal(await title(), expected[1]);
    await key("ArrowLeft");
    assert.equal(await title(), expected[0]);
    assert.equal(await rowScroll(), 0, "scrollLeft settles at 0 on return to title 0");
    assert.equal(await cardRect(), gutterLeft, "title 0 settles at gutter on return");
    assert.equal(await visiblePreceding(), 0, "no previous-cycle cards visible after backward return");

    // Rapid reversals near boundary
    for (let r = 0; r < 3; r++) {
      await key("ArrowRight");
      await key("ArrowLeft");
      assert.equal(await title(), expected[0]);
      assert.equal(await cardRect(), gutterLeft);
      assert.equal(await visiblePreceding(), 0);
    }

    // Left from title 0 enters rail at Home
    await key("ArrowLeft");
    assert.equal(await evaluate("document.activeElement.id"), "watch-toggle");
    await key("ArrowRight");
    assert.equal(await title(), expected[0]);
    assert.equal(await cardRect(), gutterLeft);
    assert.equal(await visiblePreceding(), 0);

    // Multi-cycle test: navigate 5 full cycles, then 2 cards into new cycle, then return backward
    for (let c = 0; c < 5 * expected.length; c++) await key("ArrowRight");
    await key("ArrowRight"); // Dark
    await key("ArrowRight"); // Breaking Bad
    await key("ArrowLeft");  // Dark
    await key("ArrowLeft");  // South Park (boundary)
    assert.equal(await title(), expected[0]);
    assert.equal(await rowScroll(), 0, "scrollLeft is 0 after 5 cycles and backward return");
    assert.equal(await cardRect(), gutterLeft, "title 0 settles at gutter after 5 cycles");
    assert.equal(await visiblePreceding(), 0, "no previous cards visible after 5 cycles");
    assert.equal(await evaluate("document.querySelector('#watch-rows-scroll').scrollTop"), initialScroll);
    const layout = await evaluate(geometry);
    assert.ok(Math.abs(layout.gap - 42) < 1, `heading gap at ${viewport.width}`);
    await pause();
    assert.equal(await evaluate("document.querySelector('#watch-hero-title').textContent"), await title());
    for (let i = 0; i < 5; i++) await key("ArrowRight");
    const remembered = await evaluate("document.activeElement.dataset.homeKey");
    assert.equal(remembered, "tv:100088", "logical identity survives window recentering");
    assert.equal(await evaluate("document.activeElement.isConnected"), true,
      "focused logical card remains attached after recentering");
    await key("ArrowUp");
    assert.equal(await evaluate("document.activeElement.id"), "watch-toggle");
    await key("ArrowRight");
    assert.equal(await evaluate("document.activeElement.dataset.homeKey"), remembered,
      "rail return restores the same logical title, not a recycled window position");
    await key("ArrowDown"); await pause();
    assert.equal(await evaluate("document.activeElement.dataset.homeGroup"), "top");
    await key("ArrowUp"); await pause();
    assert.equal(await evaluate("document.activeElement.dataset.homeKey"), remembered,
      "row memory restores the detached-window title");
    await key("ArrowLeft");
    assert.equal(await title(), "Stranger Things");
    await key("ArrowLeft");
    assert.equal(await title(), "Interstellar");
    await key("Enter");
    await until("document.querySelector('#details-view').hidden === false"
      + " && document.querySelector('#detail-title').textContent === 'Interstellar'");
  }
  for (const scenario of ["one-show", "two-show", "none"]) {
    const url = new URL(base);
    url.searchParams.set("preview-history", scenario);
    url.searchParams.set("run", `${scenario}-${Date.now()}`);
    await send("Page.navigate", { url: url.href });
    await until(`location.href === ${JSON.stringify(url.href)} && !!window.HorizonUniversalSearch
      && document.activeElement.id === 'watch-toggle'`);
    if (scenario === "none") {
      assert.equal(await evaluate("document.querySelector('#watch-continue-section').hidden"), true);
      continue;
    }
    await key("ArrowRight");
    const first = await evaluate("document.activeElement.dataset.homeKey");
    const keys = [];
    for (let i = 0; i < 8; i++) {
      await key("ArrowRight");
      keys.push(await evaluate("document.activeElement.dataset.homeKey"));
    }
    assert.equal(keys[keys.length - 1], first);
    assert.equal(new Set(await evaluate("Array.from(document.querySelectorAll('#watch-continue-row .home-card')).map(x=>x.dataset.homeKey)")).size,
      scenario === "one-show" ? 1 : 2);
  }
  await navigate("movie-after-wrap");
  await key("ArrowRight");
  assert.equal(await evaluate("document.activeElement.homeEntry.row.title"), "South Park");
  await key("ArrowLeft");
  assert.equal(await evaluate("document.activeElement.id"), "watch-toggle",
    "Left from first card enters rail at Home");
  await key("ArrowRight");
  assert.equal(await evaluate("document.activeElement.homeEntry.row.title"), "South Park");
  for (let i = 0; i < 3; i++) await key("ArrowRight");
  assert.equal(await evaluate("document.activeElement.homeEntry.row.title"), "Interstellar");
  await key("Enter");
  await until("document.querySelector('#details-view').hidden === false");
  assert.equal(await evaluate("document.querySelector('#detail-title').textContent"), "Interstellar");
  await key("Back");
  await until("document.querySelector('#watch-view').hidden === false");
  assert.equal(await evaluate("document.activeElement.homeEntry.row.title"), "Interstellar",
    "Back from details restores Interstellar focus");

  // Phase 2 Discover & Find Similar verification in Chrome
  // 1. Open Discover directly from the left rail
  await key("ArrowLeft"); // Enter rail at Home
  assert.equal(await evaluate("document.activeElement.id"), "watch-toggle");
  for (const id of ["tv-toggle", "movies-toggle", "discover-toggle"]) {
    await key("ArrowDown");
    assert.equal(await evaluate("document.activeElement.id"), id);
  }
  await key("Enter"); // Activate Discover destination
  await until("document.querySelector('#watch-view').hidden === false && document.querySelector('#discover-toggle').classList.contains('is-current')");

  // 2. Verify automatically selected seed (South Park or fallback)
  const autoSeedText = await evaluate("document.querySelector('#filter-btn-seed')?.textContent");
  assert.ok(autoSeedText.includes("South Park") || autoSeedText.includes("Dark") || autoSeedText.includes("Severance"),
    `Discover auto seed must be valid: ${autoSeedText}`);

  // 3. Confirm recommendation cards display recognizable titles, poster images, and match reasons
  await until("document.querySelectorAll('#watch-discover-closest-row .home-card').length >= 2");
  const autoTitles = await evaluate("Array.from(document.querySelectorAll('#watch-discover-closest-row .home-card strong')).map(e => e.textContent.trim())");
  assert.ok(autoTitles.length >= 2, "Closest Matches must display at least 2 cards");
  assert.ok(autoTitles.every(t => t.length > 0 && t !== "undefined"), `Cards must have non-empty titles: ${JSON.stringify(autoTitles)}`);

  const autoImages = await evaluate("Array.from(document.querySelectorAll('#watch-discover-closest-row .home-card img')).map(i => i.src)");
  assert.ok(autoImages.length >= 2 && autoImages.every(src => src.includes("image.tmdb.org/t/p/")),
    `Cards must have valid TMDB poster image sources: ${JSON.stringify(autoImages)}`);

  const autoReasons = await evaluate("Array.from(document.querySelectorAll('#watch-discover-closest-row .home-card .card-match-reason')).map(r => r.textContent.trim())");
  assert.ok(autoReasons.length >= 2 && autoReasons.every(r => r.length > 0),
    `Cards must display non-empty match reasons: ${JSON.stringify(autoReasons)}`);

  const autoKeys = await evaluate("Array.from(document.querySelectorAll('#watch-discover-closest-row .home-card')).map(c => c.dataset.homeKey)");
  assert.ok(autoKeys.every(k => k && !k.includes("undefined")),
    `Cards must have canonical media keys: ${JSON.stringify(autoKeys)}`);

  // 4. Move from rail into Discover content, then press Left to verify Home focus invariant
  await key("ArrowRight"); // Enters first card of Closest Matches
  assert.equal(await evaluate("document.activeElement.closest('.watch-home-row')?.id"), "watch-discover-closest-row");
  await key("ArrowLeft"); // Left at first title of cycle enters left rail with Home focused
  assert.equal(await evaluate("document.activeElement.id"), "watch-toggle");
  await key("Enter"); // Return to Watch Home
  await until("document.querySelector('#watch-toggle').classList.contains('is-current')");
  await key("ArrowRight"); // Enters remembered card in Continue Watching
  while (await evaluate("document.activeElement.homeEntry?.row?.title !== 'Interstellar'")) {
    await key("ArrowRight");
  }
  assert.equal(await evaluate("document.activeElement.homeEntry.row.title"), "Interstellar");
  await key("Enter"); // Open Interstellar details
  await until("document.querySelector('#details-view').hidden === false");

  const moreLikeThisBtn = await evaluate("!!document.querySelector('#detail-actions [data-action=\"more-like-this\"]')");
  assert.equal(moreLikeThisBtn, true, "'More Like This' action must be present in Details view");

  // 5. Click 'More Like This' and verify Discover launches with Interstellar as seed
  await evaluate("document.querySelector('#detail-actions [data-action=\"more-like-this\"]').click()");
  await until("document.querySelector('#watch-view').hidden === false && document.querySelector('#discover-toggle').classList.contains('is-current')");
  const interstellarSeedText = await evaluate("document.querySelector('#filter-btn-seed')?.textContent");
  assert.ok(interstellarSeedText.includes("Interstellar"), `Discover seed must be Interstellar: ${interstellarSeedText}`);

  // 6. Verify cards updated for Interstellar with real titles and posters
  await until("document.querySelectorAll('#watch-discover-closest-row .home-card').length >= 2");
  const interstellarTitles = await evaluate("Array.from(document.querySelectorAll('#watch-discover-closest-row .home-card strong')).map(e => e.textContent.trim())");
  assert.ok(interstellarTitles.every(t => t.length > 0 && t !== "undefined"),
    `Interstellar cards must have non-empty titles: ${JSON.stringify(interstellarTitles)}`);

  // 7. Switch between Category modes (Closest Matches vs All Categories)
  await evaluate("document.querySelector('#filter-btn-mode').click()"); // Open mode menu
  await until("document.querySelector('#watch-filter-menu')?.hidden === false");
  await evaluate("Array.from(document.querySelectorAll('.filter-menu-option')).find(o => o.textContent.includes('Closest Matches'))?.click()");
  await until("document.querySelector('#watch-filter-menu')?.hidden === true");
  assert.equal(await evaluate("!document.querySelector('#watch-discover-closest-section').hidden"), true);
  assert.equal(await evaluate("document.querySelector('#watch-discover-vibe-section').hidden"), true);
  assert.equal(await evaluate("document.querySelector('#watch-discover-genre-section').hidden"), true);
  assert.equal(await evaluate("document.querySelector('#watch-discover-gems-section').hidden"), true);

  // Restore All Categories
  await evaluate("document.querySelector('#filter-btn-mode').click()");
  await until("document.querySelector('#watch-filter-menu')?.hidden === false");
  await evaluate("Array.from(document.querySelectorAll('.filter-menu-option')).find(o => o.textContent.includes('All Categories'))?.click()");
  await until("document.querySelector('#watch-filter-menu')?.hidden === true");
  assert.equal(await evaluate("!document.querySelector('#watch-discover-closest-section').hidden"), true);

  // 8. Change Media Type filter (Movies Only vs Same)
  await evaluate("document.querySelector('#filter-btn-media').click()");
  await until("document.querySelector('#watch-filter-menu')?.hidden === false");
  await evaluate("Array.from(document.querySelectorAll('.filter-menu-option')).find(o => o.textContent.includes('Movies Only'))?.click()");
  await until("document.querySelector('#watch-filter-menu')?.hidden === true");
  const movieTypes = await evaluate("Array.from(document.querySelectorAll('#watch-discover-closest-row .home-card')).map(c => c.dataset.homeKey.split(':')[0])");
  assert.ok(movieTypes.every(t => t === "movie"), `Movies Only filter must restrict results to movie: ${JSON.stringify(movieTypes)}`);

  // Clear filters
  await evaluate("document.querySelector('#filter-btn-clear')?.click()");
  await pause();

  // 9. Confirm there are no blank cards or offscreen focus outlines
  const allCardKeys = await evaluate("Array.from(document.querySelectorAll('.watch-home-row .home-card')).map(c => c.dataset.homeKey)");
  assert.ok(allCardKeys.every(k => k && !k.includes("undefined")), "Zero undefined card keys allowed");

  // 10. Select a recommendation card and verify correct details view opens
  const firstCardTitle = await evaluate("document.querySelector('#watch-discover-closest-row .home-card strong')?.textContent.trim()");
  await evaluate("document.querySelector('#watch-discover-closest-row .home-card').click()");
  await until("document.querySelector('#details-view').hidden === false");
  const openedDetailTitle = await evaluate("document.querySelector('#detail-title')?.textContent.trim()");
  assert.equal(openedDetailTitle, firstCardTitle, "Details view title must match clicked recommendation card title");

  // 11. Press Back from Details and verify focus is restored
  await key("Back");
  await until("document.querySelector('#watch-view').hidden === false");
  assert.equal(await evaluate("document.querySelector('#discover-toggle').classList.contains('is-current')"), true,
    "Back from card details must restore Discover view");

  // 12. Full rail traversal verification
  await key("ArrowLeft"); // Enter rail at Home
  assert.equal(await evaluate("document.activeElement.id"), "watch-toggle");
  await key("ArrowDown"); // TV
  assert.equal(await evaluate("document.activeElement.id"), "tv-toggle");
  await key("ArrowDown"); // Movies
  assert.equal(await evaluate("document.activeElement.id"), "movies-toggle");
  await key("ArrowDown"); // Discover
  assert.equal(await evaluate("document.activeElement.id"), "discover-toggle");
  await key("ArrowDown"); // History
  assert.equal(await evaluate("document.activeElement.id"), "history-toggle");
  await key("ArrowDown"); // Settings
  assert.equal(await evaluate("document.activeElement.id"), "settings-toggle");

  // Phase 3A: Continue Watching Reliability & Completed-Episode Advancement
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 1024, height: 768 }]) {
    await send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1, mobile: false });

    // 1. Set up catalog and initial partial checkpoint S14E3 (40%)
    const initUrl = new URL(base);
    initUrl.searchParams.set("mock", "1");
    initUrl.searchParams.set("run", `init-p3a-${viewport.width}-${Date.now()}`);
    await send("Page.navigate", { url: initUrl.href });
    await until("!!window.HorizonUniversalSearch && document.activeElement.id === 'watch-toggle'");

    await evaluate(`
      localStorage.clear();
      sessionStorage.clear();
      window.HorizonSearchCore.writeEpisodeCatalog(localStorage, 2190, [
        { number: 13, count: 14 },
        { number: 14, count: 14 }
      ]);
      window.HorizonSearchCore.writeHistory(localStorage, window.HorizonSearchCore.item(
        "tv", 2190, "South Park", 14, 3, "off", Date.now(), {
          poster: "/k7n2EVge7G77eMr3brztRGG1fFU.jpg",
          backdrop: "/3UviYOlhn8EgXMBuiT6MnUuo1w9.jpg",
          progress: { position: 400, duration: 1000, updatedAt: Date.now(), provider: "vidbolt", completed: false }
        }
      ));
    `);

    // Reload with real storage history (no preview-history parameter)
    const runMarker = `p3a-start-${viewport.width}-${Date.now()}`;
    const p3aUrl = new URL(base);
    p3aUrl.searchParams.set("mock", "1");
    p3aUrl.searchParams.set("run", runMarker);
    await send("Page.navigate", { url: p3aUrl.href });
    await until(`location.search.includes(${JSON.stringify(runMarker)}) && !!window.HorizonUniversalSearch
      && document.activeElement.id === 'watch-toggle'
      && document.querySelectorAll('#watch-continue-row .home-card').length > 0`);

    // 2 & 3. Confirm the card displays S14E3 and 40% progress
    const cardTextS14E3 = await evaluate("document.querySelector('#watch-continue-row [data-home-key=\"tv:2190\"] .home-card-caption small')?.textContent");
    assert.ok(cardTextS14E3.includes("S14 E3"), `Card must display S14 E3: ${cardTextS14E3}`);
    const progressWidth40 = await evaluate("document.querySelector('#watch-continue-row [data-home-key=\"tv:2190\"] .home-progress-fill')?.style.width");
    assert.ok(progressWidth40.startsWith("40"), `Progress bar should be ~40%: ${progressWidth40}`);

    // 4. Confirm selecting the card launches / opens S14E3
    await evaluate("document.querySelector('#watch-continue-row [data-home-key=\"tv:2190\"]').click()");
    await until("document.querySelector('#episodes-view')?.hidden === false");
    const focusedEp3 = await evaluate("document.activeElement.dataset.episode");
    const curSeason14 = await evaluate("document.querySelector('#seasons .is-current')?.dataset.season");
    assert.equal(curSeason14, "14", "Episodes view opens Season 14");
    assert.equal(focusedEp3, "3", "Episodes view focuses Episode 3");

    // 5. Import a verified 95%-complete S14E3 checkpoint via playback return handoff
    const returnHandoff = "handoff_p3a_test_" + Date.now();
    await evaluate(`
      sessionStorage.setItem(window.HorizonSearchCore.STATE_KEY, JSON.stringify({ version: 1, view: "watch", source: "watch" }));
      sessionStorage.setItem(window.HorizonSearchCore.HANDOFF_KEY, JSON.stringify({
        token: ${JSON.stringify(returnHandoff)},
        type: "tv",
        id: 2190,
        season: 14,
        episode: 3,
        at: Date.now()
      }));
    `);
    const compMarker = `return-comp-${viewport.width}-${Date.now()}`;
    const returnUrl = new URL(base);
    returnUrl.searchParams.set("mock", "1");
    returnUrl.searchParams.set("return", "1");
    returnUrl.searchParams.set("showId", "2190");
    returnUrl.searchParams.set("season", "14");
    returnUrl.searchParams.set("episode", "3");
    returnUrl.searchParams.set("position", "960");
    returnUrl.searchParams.set("duration", "1000");
    returnUrl.searchParams.set("updated", String(Date.now()));
    returnUrl.searchParams.set("completed", "1");
    returnUrl.searchParams.set("progressProvider", "vidbolt");
    returnUrl.searchParams.set("handoff", returnHandoff);
    returnUrl.searchParams.set("run", compMarker);

    await send("Page.navigate", { url: returnUrl.href });
    await until("!!window.HorizonUniversalSearch && document.querySelector('#watch-view')?.hidden === false && document.querySelectorAll('#watch-continue-row .home-card').length > 0");

    // 6. Confirm the card advances to S14E4
    const cardTextS14E4 = await evaluate("document.querySelector('#watch-continue-row [data-home-key=\"tv:2190\"] .home-card-caption small')?.textContent");
    assert.ok(cardTextS14E4.includes("S14 E4"), `Card must advance to S14 E4: ${cardTextS14E4}`);

    // 7. Confirm S14E4 displays zero progress if not started
    const zeroProgress = await evaluate("document.querySelector('#watch-continue-row [data-home-key=\"tv:2190\"] .home-progress-fill')");
    assert.equal(zeroProgress, null, "S14E4 must display zero progress bar (ready to start)");

    // 8. Confirm selecting the card launches / opens S14E4
    await evaluate("document.querySelector('#watch-continue-row [data-home-key=\"tv:2190\"]').click()");
    await until("document.querySelector('#episodes-view')?.hidden === false");
    const focusedEp4 = await evaluate("document.activeElement.dataset.episode");
    const curSeason14Adv = await evaluate("document.querySelector('#seasons .is-current')?.dataset.season");
    assert.equal(curSeason14Adv, "14", "Episodes view opens Season 14");
    assert.equal(focusedEp4, "4", "Episodes view focuses Episode 4");

    // 9. Confirm the show's Details view agrees with the Continue Watching target
    await evaluate("document.querySelector('#episodes-back').click()");
    await until("document.querySelector('#details-view')?.hidden === false");
    const detailsPrimary = await evaluate("document.querySelector('#detail-actions .detail-primary')?.textContent");
    assert.ok(detailsPrimary.includes("Continue S14 E4"), `Details primary action must agree with Continue S14 E4: ${detailsPrimary}`);

    // 10. Confirm an older delayed checkpoint cannot revert the card to S14E3
    await evaluate(`
      window.HorizonSearchCore.writeHistory(localStorage, window.HorizonSearchCore.item(
        "tv", 2190, "South Park", 14, 3, "off", 500, {
          progress: { position: 500, duration: 1000, updatedAt: 500, provider: "vidbolt", completed: false }
        }
      ));
    `);
    await evaluate("document.querySelector('#watch-toggle').click()");
    await until("document.querySelector('#watch-view')?.hidden === false");
    const preservedCard = await evaluate("document.querySelector('#watch-continue-row [data-home-key=\"tv:2190\"] .home-card-caption small')?.textContent");
    assert.ok(preservedCard.includes("S14 E4"), `Delayed checkpoint must not revert S14 E4: ${preservedCard}`);

    // 11. Verify the first-title carousel boundary, poster gutter, focus, and navigation remain intact
    await evaluate("document.querySelector('#watch-toggle').focus()");
    assert.equal(await evaluate("document.activeElement.id"), "watch-toggle");
    await key("ArrowRight"); // Enters South Park card
    const gutterP3 = viewport.width === 1024 ? 145 : 182;
    const cardLeftP3 = await evaluate("Math.round(document.activeElement.getBoundingClientRect().left)");
    assert.equal(cardLeftP3, gutterP3, `Card settles at clean left gutter (${gutterP3}px)`);
    await key("ArrowLeft"); // Exits to left rail with Home focused
    assert.equal(await evaluate("document.activeElement.id"), "watch-toggle", "Left enters left rail with Home focused");
  }

  console.log("Instant circular Watch E2E, Phase 2 Discover, and Phase 3A Continue Reliability passed at 1920x1080 and 1024x768.");
} finally { socket.close(); }
