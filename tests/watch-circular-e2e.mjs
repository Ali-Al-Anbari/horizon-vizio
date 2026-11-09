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
  console.log("Instant circular Watch E2E passed at 1920x1080 and 1024x768.");
} finally { socket.close(); }
