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
async function navigate(mode, suffix) {
  const url = new URL(base);
  const marker = `${suffix}-${process.pid}-${Date.now()}`;
  url.searchParams.set("mock", "1");
  url.searchParams.set("preview-history", "multi-ratings");
  if (mode) url.searchParams.set("watch-motion", mode);
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
  await send("Runtime.enable"); await send("Page.enable");
  await send("Page.bringToFront");
  await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true });
  await send("Performance.enable");
  const performanceMetrics = async () => Object.fromEntries((await send("Performance.getMetrics")).metrics
    .map(item => [item.name, item.value]));
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 1024, height: 768 }]) {
    await send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1, mobile: false });
    await navigate(null, String(viewport.width));
    await key("ArrowRight");
    for (const group of ["continue", "top", "because", "recent"]) {
      await pause();
      const actual = await evaluate(geometry);
      assert.equal(actual.group, group);
      assert.ok(actual.gap >= 38 && actual.gap <= 46,
        `${group} gap at ${viewport.width}x${viewport.height}: ${actual.gap}px`);
      assert.ok(actual.headingVisible && actual.posterVisible,
        `${group} heading and poster fit at ${viewport.width}x${viewport.height}`);
      const before = actual.scrollTop;
      const moves = Math.min(5, (await evaluate("document.activeElement.closest('.watch-home-section').querySelectorAll('.home-card').length")) - 1);
      for (let i = 0; i < moves; i++) await key("ArrowRight");
      for (let i = 0; i < moves; i++) await key("ArrowLeft");
      assert.equal((await evaluate(geometry)).scrollTop, before,
        `${group} horizontal movement keeps vertical position`);
      await key("ArrowDown");
    }
  }
  await navigate(null, "remote-menu");
  assert.equal(await evaluate("!!document.querySelector('.watch-motion-overlay')"), false);
  assert.equal(await evaluate("!!window.HorizonWatchMotionDiagnostics"), false);
  for (let i = 0; i < 4; i++) await key("ArrowUp");
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',repeat:true,bubbles:true}))");
  assert.equal(await evaluate("!!document.querySelector('.watch-motion-overlay')"), false,
    "held key and four presses cannot open the overlay");
  await key("ArrowUp");
  assert.equal(await evaluate("document.activeElement.id"), "watch-toggle");
  assert.equal(await evaluate("document.querySelector('.motion-active').textContent"), "Active: PROFILE");
  for (const [index, mode] of ["profile", "glide-off", "art-off", "scroll-off", "all-off"].entries()) {
    if (index) await key("ArrowDown");
    await key("Enter");
    assert.equal(await evaluate("window.HorizonWatchMotionDiagnostics.snapshot().mode"), mode);
    assert.equal(await evaluate("document.activeElement.id"), "watch-toggle");
  }
  assert.equal(await evaluate("document.body.classList.contains('watch-motion-all-off')"), true);
  for (let i = 0; i < 4; i++) await key("ArrowUp");
  await key("Enter");
  assert.equal(await evaluate("window.HorizonWatchMotionDiagnostics.snapshot().mode"), "profile");
  assert.equal(await evaluate("document.body.classList.contains('watch-motion-all-off')"), false);
  await key("Escape");
  assert.equal(await evaluate("document.querySelector('.watch-motion-overlay').hidden"), true);
  await key("ArrowRight");
  assert.equal(await evaluate("document.activeElement.dataset.homeGroup"), "continue",
    "closing overlay restores ordinary rail-to-poster navigation");
  const artBefore = await evaluate("window.HorizonWatchMotionDiagnostics.snapshot().artRequests");
  await key("ArrowRight");
  await pause();
  assert.ok((await evaluate("window.HorizonWatchMotionDiagnostics.snapshot().artRequests")) > artBefore,
    "returning from art-off resumes focused hero artwork updates");
  for (const mode of ["profile", "glide-off", "art-off", "scroll-off", "all-off"]) {
    await navigate(mode, mode);
    await key("ArrowRight"); await pause();
    const before = await evaluate("window.HorizonWatchMotionDiagnostics.snapshot().artRequests");
    await key("ArrowRight");
    const state = await evaluate(`(() => ({ mode: window.HorizonWatchMotionDiagnostics.snapshot().mode,
      artRequests: window.HorizonWatchMotionDiagnostics.snapshot().artRequests,
      glide: document.querySelector('#watch-view').classList.contains('has-focus-glide'),
      allOff: document.body.classList.contains('watch-motion-all-off'),
      focus: document.activeElement.dataset.homeGroup }))()`);
    assert.equal(state.mode, mode);
    assert.equal(state.focus, "continue");
    if (mode === "glide-off" || mode === "all-off") assert.equal(state.glide, false);
    if (mode === "art-off" || mode === "all-off") assert.equal(state.artRequests, before);
    if (mode === "all-off") assert.equal(state.allOff, true);
    await key("ArrowDown");
    assert.equal(await evaluate("document.activeElement.dataset.homeGroup"), "top");
    if (mode === "scroll-off" || mode === "all-off")
      assert.equal(await evaluate("window.HorizonWatchMotionDiagnostics.snapshot().rowAnimating"), false);
    const countersBefore = await performanceMetrics();
    await evaluate(`(async () => {
      const press = key => document.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true}));
      for (let i = 0; i < 20; i++) {
        press(i % 4 < 2 ? 'ArrowRight' : 'ArrowLeft');
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      for (const direction of ['ArrowUp','ArrowDown','ArrowUp','ArrowDown']) {
        press(direction);
        await new Promise(resolve => setTimeout(resolve, 240));
      }
      await new Promise(resolve => setTimeout(resolve, 700));
      return true;
    })()`);
    const countersAfter = await performanceMetrics();
    const metrics = await evaluate("window.HorizonWatchMotionDiagnostics.snapshot()");
    const percentile = (values, fraction) => {
      if (!values.length) return null;
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
    };
    console.log(JSON.stringify({ mode, frameMedianMs: percentile(metrics.frames, .5),
      frameP95Ms: percentile(metrics.frames, .95), framesOver25Ms: metrics.frames.filter(ms => ms > 25).length,
      frames: metrics.frames.length, inputToFrameMedianMs: percentile(metrics.input.map(item => item.ms), .5),
      inputToFrameP95Ms: percentile(metrics.input.map(item => item.ms), .95),
      longTasks: metrics.longTasks.length, imageLoads: metrics.images.length,
      overlapFrames: metrics.overlaps.filter(count => count >= 2).length,
      artRequests: metrics.artRequests,
      layouts: countersAfter.LayoutCount - countersBefore.LayoutCount,
      styleRecalculations: countersAfter.RecalcStyleCount - countersBefore.RecalcStyleCount,
      layoutMs: Math.round((countersAfter.LayoutDuration - countersBefore.LayoutDuration) * 1000),
      styleMs: Math.round((countersAfter.RecalcStyleDuration - countersBefore.RecalcStyleDuration) * 1000) }));
  }
  console.log("Watch row-gap and motion diagnostics E2E passed at 1920x1080 and 1024x768.");
} finally { socket.close(); }
