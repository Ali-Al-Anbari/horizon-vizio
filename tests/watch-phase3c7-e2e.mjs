// Isolated loopback Chrome check. Run with HORIZON_CDP_PORT and HORIZON_SEARCH_URL.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";

const port = Number(process.env.HORIZON_CDP_PORT || 9227);
const base = process.env.HORIZON_SEARCH_URL || "http://127.0.0.1:8788/universal-search/index.html?mock=1";
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
function send(method, params = {}) { return new Promise((resolve, reject) => {
  const id = ++sequence; pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
}); }
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function until(expression) {
  const untilAt = Date.now() + 5000;
  while (Date.now() < untilAt) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw Error(`Timed out: ${expression}`);
}
const key = (name, repeat = false) => evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',
  {key:${JSON.stringify(name)},repeat:${repeat},bubbles:true}))`);
const release = name => evaluate(`document.dispatchEvent(new KeyboardEvent('keyup',
  {key:${JSON.stringify(name)},bubbles:true}))`);
async function navigate(viewport) {
  await send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1, mobile: false });
  const url = new URL(base);
  url.searchParams.set("mock", "1");
  url.searchParams.set("preview-history", "multi-ratings");
  url.searchParams.set("run", String(Date.now()));
  await send("Page.navigate", { url: url.href });
  await until("document.querySelector('#watch-explore-section')?.hidden === false && document.querySelectorAll('#watch-explore-row .home-card').length > 2");
}

try {
  await send("Runtime.enable"); await send("Page.enable"); await send("Page.bringToFront");
  await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true });
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 1024, height: 768 }]) {
    await navigate(viewport);
    assert.equal(await evaluate("!!document.querySelector('#filter-btn-finished')"), false);
    const initial = await evaluate(`(() => {
      const row=document.querySelector('#watch-explore-row');
      const cards=[...row.querySelectorAll('.home-card')];
      return {count:cards.length, visible:cards.filter(c=>{const r=c.getBoundingClientRect();return r.left<innerWidth&&r.right>0}).length,
        unique:new Set(cards.map(c=>c.dataset.homeOrdinal)).size};
    })()`);
    assert.ok(initial.visible > 2, "Explore fills its initial viewport");
    assert.equal(initial.unique, initial.count, "initial poster slots have distinct ordinals");
    await key("ArrowRight");
    const first = await evaluate("document.activeElement.homeEntry.row.title");
    for (let i = 0; i < 5; i++) { await key("ArrowRight"); await release("ArrowRight"); }
    assert.notEqual(await evaluate("document.activeElement.homeEntry.row.title"), first,
      "five discrete taps advance five logical titles");
    await navigate(viewport);
    await key("ArrowRight");
    await key("ArrowRight");
    await key("ArrowRight", true); await key("ArrowRight", true);
    assert.equal(await evaluate("document.querySelector('#watch-continue-row').classList.contains('is-hold-scrolling')"), true);
    const samples = await evaluate(`new Promise(resolve => {
      const track=document.querySelector('#watch-continue-row .watch-home-track'), values=[];
      const pulse=setInterval(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',repeat:true,bubbles:true})),45);
      let n=0; function sample(){const m=getComputedStyle(track).transform.match(/matrix\\(([^)]+)\\)/);
        values.push(m?Number(m[1].split(',')[4]):0);
        if(++n<120) requestAnimationFrame(sample); else {clearInterval(pulse);
          document.dispatchEvent(new KeyboardEvent('keyup',{key:'ArrowRight',bubbles:true})); resolve(values);}}
      requestAnimationFrame(sample);
    })`);
    const jumps = samples.slice(1).map((x, i) => x - samples[i]);
    assert.ok(jumps.every(delta => delta <= 1), "held forward motion never reverses or rebases");
    assert.ok(Math.min(...samples) < samples[0] - 500, "held direction moves through multiple titles");
    await until("!!document.activeElement.homeEntry && !document.querySelector('#watch-continue-row').classList.contains('is-hold-scrolling')");
    await key("ArrowRight", true); await key("ArrowRight", true);
    await until("!document.querySelector('#watch-continue-row').classList.contains('is-hold-scrolling')");
    assert.ok(await evaluate("!!document.activeElement.homeEntry"), "missing keyup stops and restores focus");
    await navigate(viewport);
    await key("ArrowRight");
    const cycleStartTitle = await evaluate("document.activeElement.homeEntry.row.title");
    const cycles = await evaluate(`new Promise(resolve => {
      const track=document.querySelector('#watch-continue-row .watch-home-track');
      const length=8, samples=[]; let presses=0, watching=true;
      function frame(){const m=getComputedStyle(track).transform.match(/matrix\\(([^)]+)\\)/);
        samples.push(m?Number(m[1].split(',')[4]):0);
        if(watching)requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
      const timer=setInterval(()=>{
        document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
        document.dispatchEvent(new KeyboardEvent('keyup',{key:'ArrowRight',bubbles:true}));
        if(++presses===length*10){clearInterval(timer);setTimeout(()=>{watching=false;
          resolve({samples,focus:document.activeElement.homeEntry?.row?.title,
            cards:document.querySelectorAll('#watch-continue-row .home-card').length});},220);}
      },45);
    })`);
    assert.equal(cycles.focus, "Severance", "Continue Watching is non-looping under Phase 3C.8 and stops at Severance");
    assert.ok(cycles.cards <= 16, "attached card window bounded");
    if (process.env.HORIZON_RECORD_FRAMES === "1") {
      mkdirSync(".playwright-mcp", { recursive: true });
      writeFileSync(`.playwright-mcp/phase3c7-wrap-frames-${viewport.width}.json`,
        JSON.stringify({ viewport, samples: cycles.samples }, null, 2));
    }
    for (let i = 0; i < 7; i++) await key("ArrowLeft");
    assert.equal(await evaluate("document.activeElement.homeEntry.row.title"), cycleStartTitle,
      "backward traversal restores the first title");
    await key("ArrowLeft");
    assert.equal(await evaluate("document.activeElement.id"), "watch-toggle",
      "Left from first title enters Home rail");
    console.log(`${viewport.width}x${viewport.height}: Explore ${initial.visible} visible / ${initial.count} attached, hold ${samples.length} frames, forward displacement ${Math.round(samples[0] - Math.min(...samples))}px`);
  }
  const settingsUrl = new URL(base);
  settingsUrl.searchParams.set("mock", "1");
  settingsUrl.searchParams.delete("preview-history");
  settingsUrl.searchParams.set("run", `settings-${Date.now()}`);
  await send("Page.navigate", { url: settingsUrl.href });
  await until("!!document.querySelector('#settings-hero-delay') && !!window.HorizonUniversalSearch");
  await evaluate("localStorage.removeItem('horizon-watch-hero-preferences')");
  await send("Page.reload");
  await until("!!window.HorizonUniversalSearch && document.activeElement.id === 'watch-toggle'");
  const historyBefore = await evaluate("localStorage.getItem(HorizonSearchCore.HISTORY_KEY)");
  await evaluate("document.querySelector('#settings-toggle').click()");
  assert.equal(await evaluate("document.querySelector('#settings-hero-delay').textContent"), "Immediate");
  assert.equal(await evaluate("document.querySelector('#settings-hero-fade').textContent"), "Fade Off");
  await key("ArrowRight");
  assert.equal(await evaluate("document.activeElement.id"), "settings-hero-delay");
  const timingLabels = [];
  for (let i = 0; i < 7; i++) {
    timingLabels.push(await evaluate("document.activeElement.textContent"));
    await key("Enter");
  }
  assert.deepEqual(timingLabels, ["Immediate", "110ms", "150ms", "250ms", "300ms", "400ms", "500ms"]);
  await key("ArrowDown"); await key("Enter");
  assert.equal(await evaluate("document.activeElement.textContent"), "Fade On");
  assert.equal(await evaluate("localStorage.getItem(HorizonSearchCore.HISTORY_KEY)"), historyBefore,
    "hero preferences do not change playback history");
  await send("Page.reload");
  await until("!!window.HorizonUniversalSearch");
  await evaluate("document.querySelector('#settings-toggle').click()");
  assert.equal(await evaluate("document.querySelector('#settings-hero-delay').textContent"), "Immediate");
  assert.equal(await evaluate("document.querySelector('#settings-hero-fade').textContent"), "Fade On");
  await send("Network.setBlockedURLs", { urls: ["*image.tmdb.org*"] });
  await navigate({ width: 1024, height: 768 });
  const delayedArt = await evaluate(`(() => {
    const cards=[...document.querySelectorAll('#watch-explore-row .home-card')];
    return {count:cards.length, sized:cards.every(c=>c.querySelector('.poster-art').getBoundingClientRect().height>100),
      labeled:cards.every(c=>!!c.querySelector('strong')?.textContent.trim())};
  })()`);
  await send("Network.setBlockedURLs", { urls: [] });
  assert.ok(delayedArt.count > 2 && delayedArt.sized && delayedArt.labeled,
    "blocked artwork leaves a complete, sized initial Explore window with title labels");
  console.log("PASS Phase 3C.7 browser navigation");
} finally { socket.close(); }
