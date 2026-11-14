// Loopback-only browser test. Run with HORIZON_SEARCH_URL and HORIZON_CDP_PORT.
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
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const key = name => evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',
  {key:${JSON.stringify(name)},bubbles:true}))`);
async function until(expression, deadlineMs = 6000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await wait(25);
  }
  throw Error(`Condition did not settle: ${expression}`);
}
async function navigate(label) {
  const url = new URL(base);
  url.searchParams.set("mock", "1");
  url.searchParams.set("watch-motion", "1");
  url.searchParams.set("preview-history", "multi-ratings");
  url.searchParams.set("run", `${label}-${process.pid}-${Date.now()}`);
  await send("Page.navigate", { url: url.href });
  await until("!!window.HorizonUniversalSearch && document.activeElement.id === 'watch-toggle'"
    + " && document.querySelectorAll('#watch-continue-row .home-card').length > 0");
  await until("document.querySelector('#watch-hero-title').textContent === 'South Park'");
}
async function selectMode(index, label) {
  for (let i = 0; i < 5; i++) await key("ArrowDown");
  assert.equal(await evaluate("document.activeElement.id"), "settings-toggle");
  for (let i = 0; i < 5; i++) await key("ArrowDown");
  assert.match(await evaluate("document.querySelector('.watch-performance-panel').textContent"), /Select a mode/);
  for (let i = 0; i < index; i++) await key("ArrowRight");
  await key("Enter");
  assert.match(await evaluate("document.querySelector('.watch-performance-panel').textContent"),
    new RegExp(`WATCH HERO TEST · ${label}`));
  await key("ArrowRight");
  assert.equal(await evaluate("document.activeElement.homeEntry.row.title"), "South Park");
}
const hero = `(() => ({ focus: document.activeElement.homeEntry?.row?.title || '',
  title: document.querySelector('#watch-hero-title').textContent,
  art: document.querySelector('#watch-hero-art img')?.getAttribute('src') || '' }))()`;
try {
  await send("Runtime.enable"); await send("Page.enable"); await send("Page.bringToFront");
  await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true });
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 1024, height: 768 }]) {
    await send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1, mobile: false });
    for (const item of [
      { index: 0, label: "Baseline", delay: 110 },
      { index: 1, label: "Immediate", delay: 0 },
      { index: 2, label: "150ms", delay: 150 },
      { index: 3, label: "250ms", delay: 250 },
      { index: 4, label: "300ms", delay: 300 },
      { index: 5, label: "400ms", delay: 400 },
      { index: 6, label: "500ms", delay: 500 }
    ]) {
      await navigate(`${viewport.width}-${item.label}`);
      await selectMode(item.index, item.label);
      await key("ArrowRight");
      assert.equal((await evaluate(hero)).focus, "Dark");
      if (item.delay >= 150) {
        await wait(Math.min(80, item.delay - 30));
        assert.equal((await evaluate(hero)).title, "South Park",
          `${item.label}: hero remains coherent before debounce expires`);
      }
      await until("document.querySelector('#watch-hero-title').textContent === 'Dark'", 5000);
      const settled = await evaluate(hero);
      assert.ok(settled.art.includes("3jDXL4Xvj3AzDOF6UH1xeyHW8MH"),
        `${item.label}: Dark title and artwork settle together`);
    }
    await navigate(`${viewport.width}-fixed`);
    await selectMode(7, "Fixed Hero");
    await key("ArrowRight"); await wait(800);
    const fixed = await evaluate(hero);
    assert.equal(fixed.focus, "Dark");
    assert.equal(fixed.title, "South Park");
    assert.ok(fixed.art.includes("3UviYOlhn8EgXMBuiT6MnUuo1w9"));
  }

  await navigate("rapid-cancellation");
  await selectMode(4, "300ms");
  const rapid = await evaluate(`new Promise(async resolve => {
    const art = document.querySelector('#watch-hero-art'); let swaps = 0;
    const observer = new MutationObserver(changes => {
      changes.forEach(change => { if (change.target === art) swaps += change.addedNodes.length; });
    });
    observer.observe(art, { childList: true });
    for (let i = 0; i < 20; i++) {
      document.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight',bubbles:true}));
      await new Promise(done => setTimeout(done, 50));
    }
    const deadline = Date.now() + 4000;
    while (swaps === 0 && Date.now() < deadline) {
      await new Promise(done => setTimeout(done, 50));
    }
    await new Promise(done => setTimeout(done, 400));
    observer.disconnect();
    resolve({ swaps, focus: document.activeElement.homeEntry.row.title,
      hero: document.querySelector('#watch-hero-title').textContent });
  })`);
  assert.equal(rapid.swaps, 1, "20 rapid inputs load only the final hero image");
  assert.equal(rapid.hero, rapid.focus, "hero settles on the final logical title");

  // Delay one decoded image after its load event. Its late result must not replace
  // the next focused title, even when Immediate starts both requests.
  const delayed = await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    const original = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function () {
      if (this.classList.contains('home-art-layer')
          && this.src.includes('3jDXL4Xvj3AzDOF6UH1xeyHW8MH'))
        return new Promise(resolve => setTimeout(resolve, 1100));
      return original ? original.call(this) : Promise.resolve();
    };
  })();` });
  await navigate("stale-decode");
  await selectMode(1, "Immediate");
  await key("ArrowRight"); // Dark: delayed decode.
  await wait(100);
  await key("ArrowRight"); // Breaking Bad: its decoded image wins.
  await until("document.querySelector('#watch-hero-title').textContent === 'Breaking Bad'");
  await wait(1200);
  assert.equal((await evaluate(hero)).title, "Breaking Bad", "late Dark decode is discarded");
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: delayed.identifier });

  const hungDecode = await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    const original = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function () {
      return this.classList.contains('home-art-layer')
        && this.src.includes('3jDXL4Xvj3AzDOF6UH1xeyHW8MH')
        ? new Promise(() => {}) : original ? original.call(this) : Promise.resolve();
    };
  })();` });
  await navigate("unsupported-decode");
  await selectMode(1, "Immediate");
  await key("ArrowRight");
  await until("document.querySelector('#watch-hero-title').textContent === 'Dark'", 4000);
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: hungDecode.identifier });

  await navigate("leave-during-pending");
  await selectMode(6, "500ms");
  for (let i = 0; i < 3; i++) await key("ArrowRight"); // Interstellar is a movie.
  await key("Enter");
  await until("document.querySelector('#details-view').hidden === false");
  await wait(650);
  assert.equal(await evaluate("document.querySelector('#watch-hero-title').textContent"), "South Park",
    "pending Interstellar hero work was canceled when Details opened");
  await key("Escape");
  await until("document.querySelector('#watch-view').hidden === false");
  assert.equal(await evaluate("document.activeElement.homeEntry?.row?.title"), "Interstellar");
  await until("document.querySelector('#watch-hero-title').textContent === 'Interstellar'");

  await navigate("discover-cancels-pending");
  await selectMode(6, "500ms");
  await key("ArrowRight"); // Dark is pending.
  await key("ArrowUp"); // Return to the Home rail without changing the hero.
  for (let i = 0; i < 3; i++) await key("ArrowDown");
  assert.equal(await evaluate("document.activeElement.id"), "discover-toggle");
  await key("Enter");
  await wait(700);
  assert.equal(await evaluate("document.querySelector('#watch-hero-title').textContent"), "South Park",
    "switching to Discover cancels a hero update from the previous destination");

  console.log("Hero modes, rapid cancellation, stale decode, Details return, and Discover switch passed at 1920x1080 and 1024x768.");
} finally { socket.close(); }
