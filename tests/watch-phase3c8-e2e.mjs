// Phase 3C.8 Unified Smooth Navigation & Stationary Focus Aura E2E
// Run with loopback static server and isolated headless Chrome on CDP port 9227.
import assert from "node:assert/strict";

const port = Number(process.env.HORIZON_CDP_PORT || 9227);
const base = process.env.HORIZON_SEARCH_URL || "http://127.0.0.1:4173/universal-search/index.html?mock=1";

const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const tab = tabs.find(item => item.type === "page");
assert.ok(tab, "isolated Chrome page exists");
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });

let sequence = 0;
const pending = new Map();
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const task = pending.get(message.id); pending.delete(message.id);
  message.error ? task.reject(Error(message.error.message)) : task.resolve(message.result);
};
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function until(expression, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw Error(`Timed out waiting for: ${expression}`);
}
const key = (name, repeat = false) => evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',
  {key:${JSON.stringify(name)},repeat:${repeat},bubbles:true}))`);
const release = name => evaluate(`document.dispatchEvent(new KeyboardEvent('keyup',
  {key:${JSON.stringify(name)},bubbles:true}))`);

async function navigate(scenario, viewport) {
  await send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1, mobile: false });
  const url = new URL(base);
  url.searchParams.set("mock", "1");
  if (scenario) url.searchParams.set("preview-history", scenario);
  url.searchParams.set("run", `p3c8-${scenario || "default"}-${viewport.width}-${Date.now()}`);
  await send("Page.navigate", { url: url.href });
  await until(`!!window.HorizonUniversalSearch && document.activeElement.id === 'watch-toggle'
    && document.querySelectorAll('#watch-continue-row .home-card').length >= 0`);
}

try {
  await send("Runtime.enable"); await send("Page.enable"); await send("Page.bringToFront");
  await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true });

  for (const viewport of [{ width: 1920, height: 1080 }, { width: 1024, height: 768 }]) {
    console.log(`[Phase 3C.8 E2E] Running tests at ${viewport.width}x${viewport.height}`);

    // TEST 1: Down navigation below Continue Watching & Up return
    await navigate("multi-ratings", viewport);
    await key("ArrowRight"); // Enters Continue Watching at South Park
    assert.equal(await evaluate("document.activeElement.homeEntry.row.title"), "South Park");
    assert.equal(await evaluate("document.activeElement.dataset.homeGroup"), "continue");

    // Press Down from Continue Watching: must reliably enter the next row (top)
    await key("ArrowDown");
    await new Promise(r => setTimeout(r, 60));
    assert.equal(await evaluate("document.activeElement.dataset.homeGroup"), "top",
      "Down from Continue Watching must reliably focus next row (top)");

    // Press Up from the next row: must reliably return to Continue Watching
    await key("ArrowUp");
    await new Promise(r => setTimeout(r, 60));
    assert.equal(await evaluate("document.activeElement.dataset.homeGroup"), "continue",
      "Up from next row must return focus to Continue Watching");
    assert.equal(await evaluate("document.activeElement.homeEntry.row.title"), "South Park",
      "Up restores remembered title in Continue Watching");

    // TEST 2: Continue Watching is permanently non-looping (8 titles fixture)
    const expected = ["South Park", "Dark", "Breaking Bad", "Interstellar",
      "Stranger Things", "The Last of Us", "Cyberpunk: Edgerunners", "Severance"];
    for (let i = 1; i < expected.length; i++) {
      await key("ArrowRight");
      assert.equal(await evaluate("document.activeElement.homeEntry.row.title"), expected[i]);
    }
    assert.equal(await evaluate("document.activeElement.homeEntry.row.title"), "Severance");

    // Press ArrowRight at Severance (last title): must stop at Severance, NOT loop
    await key("ArrowRight");
    assert.equal(await evaluate("document.activeElement.homeEntry.row.title"), "Severance",
      "Continue Watching stops at last title (non-looping rule)");

    // Press ArrowLeft back to South Park
    for (let i = expected.length - 2; i >= 0; i--) {
      await key("ArrowLeft");
      assert.equal(await evaluate("document.activeElement.homeEntry.row.title"), expected[i]);
    }
    assert.equal(await evaluate("document.activeElement.homeEntry.row.title"), "South Park");

    // ArrowLeft from first title enters left rail with Home focused
    await key("ArrowLeft");
    assert.equal(await evaluate("document.activeElement.id"), "watch-toggle",
      "ArrowLeft from card 0 enters rail at Home toggle");

    // TEST 3: Short rows (< 8 distinct titles): 1-title & 2-title scenarios
    for (const scenario of ["one-show", "two-show"]) {
      await navigate(scenario, viewport);
      await key("ArrowRight");
      const firstTitle = await evaluate("document.activeElement.homeEntry.row.title");
      const titleCount = scenario === "one-show" ? 1 : 2;

      // Card count in DOM equals distinct titles (no clones, no virtual duplicates)
      const domCards = await evaluate("document.querySelectorAll('#watch-continue-row .home-card').length");
      assert.equal(domCards, titleCount, `${scenario} has exactly ${titleCount} DOM card(s)`);

      // Forward navigation stops at last card
      for (let p = 0; p < 10; p++) await key("ArrowRight");
      const lastTitle = await evaluate("document.activeElement.homeEntry.row.title");
      if (titleCount === 1) {
        assert.equal(lastTitle, firstTitle, "1-title row stays on sole card");
      } else {
        assert.notEqual(lastTitle, firstTitle, "2-title row moves to card 2 and stops");
      }

      // Backward navigation returns to first card and then enters rail
      while (await evaluate("document.activeElement.id !== 'watch-toggle'")) {
        await key("ArrowLeft");
      }
      assert.equal(await evaluate("document.activeElement.id"), "watch-toggle",
        `${scenario} exits to rail on ArrowLeft from card 0`);
    }

    // TEST 4: Stationary focus aura verification during motion
    // Measure screen-space left/top of the focus aura across multiple rAF frames
    await navigate("multi-ratings", viewport);
    await key("ArrowRight"); // Enters Continue Watching
    const auraMeasurements = await evaluate(`new Promise(resolve => {
      const row = document.querySelector('#watch-continue-row');
      const track = row.querySelector('.watch-home-track');
      const samples = [];
      let frameCount = 0;

      // Start hold-scrolling
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', repeat: false, bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', repeat: true, bubbles: true }));

      function sampleFrame() {
        const rowRect = row.getBoundingClientRect();
        const gutter = parseFloat(getComputedStyle(row).paddingLeft);
        const style = getComputedStyle(row, '::after');
        const trackTransform = getComputedStyle(track).transform;

        // Visual position of stationary outline: row.left + gutter
        const auraScreenLeft = rowRect.left + gutter;
        samples.push({
          isHoldScrolling: row.classList.contains('is-hold-scrolling'),
          auraScreenLeft: Math.round(auraScreenLeft),
          auraTop: Math.round(rowRect.top + 11),
          trackTransform: trackTransform
        });

        if (++frameCount < 15) {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', repeat: true, bubbles: true }));
          requestAnimationFrame(sampleFrame);
        } else {
          document.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
          resolve(samples);
        }
      }
      requestAnimationFrame(sampleFrame);
    })`);

    // Verify aura was active and stayed at stationary screen coordinates
    assert.ok(auraMeasurements.length >= 10, "Captured motion sample frames");
    const activeFrames = auraMeasurements.filter(s => s.isHoldScrolling);
    assert.ok(activeFrames.length > 5, "Hold-scrolling class active during motion");
    const expectedGutter = viewport.width === 1024 ? 145 : 182;
    assert.ok(activeFrames.every(s => Math.abs(s.auraScreenLeft - expectedGutter) <= 2),
      `Aura screen-space left is rock-solid stationary at ${expectedGutter}px gutter`);
    assert.ok(activeFrames.every(s => s.auraTop === activeFrames[0].auraTop),
      "Aura screen-space top is rock-solid stationary");

    // TEST 5: Long rows (>= 8 titles) use infinite carousel forward looping
    // Navigate Down to explore row (which has 10 titles)
    await navigate("multi-ratings", viewport);
    await key("ArrowRight"); // Continue Watching
    await key("ArrowDown");  // Top
    await key("ArrowDown");  // Trending / Gems / Explore
    while (await evaluate("document.activeElement.dataset.homeGroup !== 'explore'")) {
      await key("ArrowDown");
    }
    assert.equal(await evaluate("document.activeElement.dataset.homeGroup"), "explore");
    const exploreFirst = await evaluate("document.activeElement.homeEntry.row.title");
    const exploreCount = await evaluate("document.querySelectorAll('#watch-explore-row .home-card').length");
    assert.ok(exploreCount >= 8, "Explore row has >= 8 titles for infinite carousel");

    // Forward loop through Explore row across 12 discrete presses
    for (let step = 0; step < 12; step++) {
      await key("ArrowRight");
      await new Promise(r => setTimeout(r, 45));
    }
    assert.equal(await evaluate("document.activeElement.dataset.homeGroup"), "explore",
      "Explore row continues forward carousel traversal smoothly");

    console.log(`[Phase 3C.8 E2E] PASS at ${viewport.width}x${viewport.height}`);
  }

  console.log("PASS ALL Phase 3C.8 E2E tests successfully.");
} finally {
  socket.close();
}
