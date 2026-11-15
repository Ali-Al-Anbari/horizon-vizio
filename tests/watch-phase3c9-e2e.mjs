// Isolated loopback Chrome visual geometry and navigation regression.
import assert from "node:assert/strict";

const port = Number(process.env.HORIZON_CDP_PORT || 9227);
const base = process.env.HORIZON_SEARCH_URL || "http://127.0.0.1:8788/universal-search/index.html?mock=1";
const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const tab = tabs.find(item => item.type === "page");
assert.ok(tab);
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
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw Error(`Timed out: ${expression}`);
}
const key = (name, repeat = false) => evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',
  {key:${JSON.stringify(name)},repeat:${repeat},bubbles:true}))`);
const release = name => evaluate(`document.dispatchEvent(new KeyboardEvent('keyup',
  {key:${JSON.stringify(name)},bubbles:true}))`);
async function navigate(viewport, preview = true) {
  await send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1, mobile: false });
  const url = new URL(base);
  url.searchParams.set("mock", "1");
  if (preview) url.searchParams.set("preview-history", "multi-ratings");
  else url.searchParams.delete("preview-history");
  url.searchParams.set("run", `p3c9-${viewport.width}-${Date.now()}`);
  await send("Page.navigate", { url: url.href });
  await until("!!window.HorizonUniversalSearch && document.activeElement.id === 'watch-toggle'");
  if (preview) await until("document.querySelector('#watch-explore-section').hidden === false");
}

try {
  await send("Runtime.enable"); await send("Page.enable"); await send("Page.bringToFront");
  await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true });
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 1024, height: 768 }]) {
    await navigate(viewport);
    const geometry = await evaluate(`(() => [...document.querySelectorAll('#watch-rows-scroll .watch-home-section:not([hidden])')]
      .filter(s => s.querySelector('.home-card')).map(s => {
        const row=s.querySelector('.watch-home-row'), track=s.querySelector('.watch-home-track');
        const cards=[...track.querySelectorAll('.home-card')], first=cards[0];
        const art=first.querySelector('.poster-art').getBoundingClientRect();
        const heading=s.querySelector('h2').getBoundingClientRect();
        return {group:s.id.slice(6,-8), count:cards.length, firstOrdinal:Number(first.dataset.homeOrdinal),
          x:art.x,width:art.width,height:art.height,trackHeight:track.getBoundingClientRect().height,
          gap:art.top-heading.bottom, rowWidth:row.getBoundingClientRect().width};
      }))()`);
    assert.ok(geometry.length >= 5);
    assert.equal(await evaluate("document.querySelector('#watch-recent-section')"), null);
    for (const row of geometry) {
      assert.equal(row.firstOrdinal, 0, `${row.group}: first ordinal attached on entry`);
      assert.ok(Math.abs(row.x - (viewport.width === 1920 ? 182.4 : 145)) < 3,
        `${row.group}: first poster at the established gutter; got ${row.x}`);
      assert.ok(row.width > 150 && row.height > 150 && row.trackHeight > 150,
        `${row.group}: no compressed poster strip`);
      if (row.group !== "continue") assert.ok(Math.abs(row.height / row.width - 1.5) < 0.02,
        `${row.group}: portrait 2:3 artwork`);
      assert.ok(row.gap >= 39 && row.gap <= 45, `${row.group}: heading gap ${row.gap}px`);
    }
    assert.ok(geometry.find(row => row.group === "explore").count > 2,
      "Explore populates more than two initial cards");

    await key("ArrowRight");
    const expected = geometry.map(row => row.group);
    for (const group of expected) {
      assert.equal(await evaluate("document.activeElement.dataset.homeGroup"), group,
        `Down follows visible DOM row order to ${group}`);
      if (group !== expected.at(-1)) { await key("ArrowDown"); await new Promise(r => setTimeout(r, 220)); }
    }
    const last = await evaluate("document.activeElement.dataset.homeKey");
    const lastScroll = await evaluate("document.querySelector('#watch-rows-scroll').scrollTop");
    await key("ArrowDown");
    assert.equal(await evaluate("document.activeElement.dataset.homeKey"), last, "last-row Down retains focus");
    assert.equal(await evaluate("document.querySelector('#watch-rows-scroll').scrollTop"), lastScroll);
    const cycleMotion = await evaluate(`new Promise(resolve => {
      const row=document.querySelector('#watch-explore-row'), track=row.querySelector('.watch-home-track');
      const first=document.activeElement.dataset.homeKey, values=[];
      let length=0, presses=0, total=0, done=false;
      function transformX(){const m=getComputedStyle(track).transform.match(/matrix(?:3d)?\\(([^)]+)\\)/);
        if(!m)return 0;const values=m[1].split(',').map(Number);return values.length===16?values[12]:values[4];}
      function frame(){values.push(transformX());if(!done)requestAnimationFrame(frame);}
      requestAnimationFrame(frame);
      const timer=setInterval(()=>{
        document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
        document.dispatchEvent(new KeyboardEvent('keyup',{key:'ArrowRight',bubbles:true}));
        presses++;
        if(!length && document.activeElement.dataset.homeKey===first) {
          length=presses;total=length*11;
        }
        if((length && presses>=total) || presses>=330) {
          clearInterval(timer);setTimeout(()=>{done=true;resolve({length,presses,values,
            focus:document.activeElement.dataset.homeKey,slots:track.childElementCount,
            vertical:document.querySelector('#watch-rows-scroll').scrollTop});},450);
        }
      },45);
    })`);
    assert.ok(cycleMotion.length >= 8 && cycleMotion.presses >= cycleMotion.length * 10,
      "long row traverses ten forward cycles");
    assert.equal(cycleMotion.focus, last, "ten loops restore the original logical title");
    assert.equal(cycleMotion.vertical, lastScroll, "horizontal loops do not scroll vertically");
    assert.ok(cycleMotion.slots <= (viewport.width === 1920 ? 18 : 15), "attached poster window stays bounded");
    const forwardJumps = cycleMotion.values.slice(1).map((value, i) => value - cycleMotion.values[i]);
    assert.ok(forwardJumps.every(delta => delta <= 2), "forward track never rebases rightward at wrap");
    for (let i = expected.length - 2; i >= 0; i--) {
      await key("ArrowUp"); await new Promise(r => setTimeout(r, 220));
      assert.equal(await evaluate("document.activeElement.dataset.homeGroup"), expected[i]);
    }
    await evaluate("document.querySelector('#settings-toggle').click()");
    for (const id of ["settings-poster-glide", "settings-hold-scroll", "settings-scroll-animations", "settings-artwork-fade"])
      await evaluate(`document.getElementById('${id}').click()`);
    await evaluate("document.querySelector('#watch-toggle').click()");
    await until("document.querySelector('#watch-top-section').hidden === false");
    const toggledGeometry = await evaluate(`(() => {
      const section=document.querySelector('#watch-top-section');
      const art=section.querySelector('.home-card .poster-art').getBoundingClientRect();
      const heading=section.querySelector('h2').getBoundingClientRect();
      return {x:art.x,width:art.width,height:art.height,gap:art.top-heading.bottom};
    })()`);
    assert.ok(Math.abs(toggledGeometry.x - (viewport.width === 1920 ? 182.4 : 145)) < 3,
      "all presentation toggles Off preserve the first-card gutter");
    assert.ok(Math.abs(toggledGeometry.height / toggledGeometry.width - 1.5) < 0.02);
    assert.ok(Math.abs(toggledGeometry.gap - 42) < 3);
    await key("ArrowRight"); await key("ArrowDown");
    assert.equal(await evaluate("document.activeElement.dataset.homeGroup"), "top");
    const beforeRepeat = await evaluate("Number(document.activeElement.dataset.homeIndex)");
    await key("ArrowRight", true); await release("ArrowRight");
    assert.equal(await evaluate("Number(document.activeElement.dataset.homeIndex)"), beforeRepeat + 1,
      "Hold Off treats a repeat as one discrete step");
    console.log(`${viewport.width}x${viewport.height}: ${geometry.map(r => `${r.group} ${Math.round(r.width)}x${Math.round(r.height)} x${Math.round(r.x)} gap${Math.round(r.gap)}`).join(", ")}`);
  }

  // Recommendation responses may land while Details hides Watch. A hidden
  // carousel must defer measurement until Watch becomes visible again.
  const delayedUrl = new URL(base);
  delayedUrl.searchParams.set("mock", "1");
  delayedUrl.searchParams.set("preview-history", "multi-ratings");
  delayedUrl.searchParams.set("rec-delay", "1");
  delayedUrl.searchParams.set("run", `hidden-${Date.now()}`);
  await send("Page.navigate", { url: delayedUrl.href });
  await until("document.activeElement.id === 'watch-toggle' && !!document.querySelector('#watch-continue-row .home-card')");
  await key("ArrowRight"); await key("Enter");
  await until("document.querySelector('#watch-view').hidden === true");
  await new Promise(resolve => setTimeout(resolve, 1050));
  assert.equal(await evaluate("document.querySelector('#watch-top-row .watch-home-track').style.height"), "",
    "hidden asynchronous row has no cached zero-height geometry");
  await evaluate("document.querySelector('#watch-toggle').click()");
  await until("document.querySelector('#watch-top-section').hidden === false");
  assert.ok(await evaluate("document.querySelector('#watch-top-row .home-card .poster-art').getBoundingClientRect().height > 200"),
    "returning from Details initializes full-height posters");

  await navigate({ width: 1920, height: 1080 }, false);
  await evaluate("localStorage.setItem('horizon-watch-hero-preferences', JSON.stringify({version:1,delay:300,fade:true}))");
  await send("Page.reload");
  await until("document.activeElement.id === 'watch-toggle'");
  await evaluate("document.querySelector('#settings-toggle').click()");
  assert.equal(await evaluate("document.querySelector('#settings-hero-delay').textContent"), "300ms");
  assert.equal(await evaluate("document.querySelector('#settings-hero-fade').textContent"), "Fade On");
  for (const id of ["settings-poster-glide", "settings-hold-scroll", "settings-scroll-animations", "settings-artwork-fade"]) {
    assert.equal(await evaluate(`document.getElementById('${id}').textContent`), id === "settings-artwork-fade" ? "Off" : "On");
    await evaluate(`document.getElementById('${id}').click()`);
  }
  const saved = await evaluate("JSON.parse(localStorage.getItem('horizon-watch-hero-preferences'))");
  assert.equal(saved.version, 2);
  assert.deepEqual([saved.glide, saved.hold, saved.scrollAnimations, saved.artworkFade], [false, false, false, true]);
  await send("Page.reload");
  await until("document.activeElement.id === 'watch-toggle'");
  await evaluate("document.querySelector('#settings-toggle').click()");
  assert.equal(await evaluate("document.querySelector('#settings-poster-glide').textContent"), "Off");
  assert.equal(await evaluate("document.querySelector('#settings-artwork-fade').textContent"), "On");
  await evaluate("HorizonSearchCore.writeHistory(localStorage, HorizonSearchCore.item('movie', 550, 'Settings Test Movie', null, null, 'off', Date.now()))");
  const historyBefore = await evaluate("localStorage.getItem(HorizonSearchCore.HISTORY_KEY)");
  await evaluate("document.querySelector('#settings-appearance-reset').click()");
  assert.equal(await evaluate("document.querySelector('#settings-hero-delay').textContent"), "Immediate");
  assert.equal(await evaluate("document.querySelector('#settings-hero-fade').textContent"), "Fade Off");
  assert.equal(await evaluate("document.querySelector('#settings-poster-glide').textContent"), "On");
  assert.equal(await evaluate("document.querySelector('#settings-artwork-fade').textContent"), "Off");
  assert.equal(await evaluate("localStorage.getItem(HorizonSearchCore.HISTORY_KEY)"), historyBefore,
    "appearance reset does not touch playback history");
  await evaluate("localStorage.setItem('horizon-watch-hero-preferences', JSON.stringify({version:99,delay:500,fade:true}))");
  await send("Page.reload");
  await until("document.activeElement.id === 'watch-toggle'");
  await evaluate("document.querySelector('#settings-toggle').click()");
  assert.equal(await evaluate("document.querySelector('#settings-hero-delay').textContent"), "Immediate",
    "unknown future preferences use safe defaults");
  console.log("Phase 3C.9 Settings migration, persistence, and reset: PASS");
  console.log("PASS Phase 3C.9 E2E");
} finally { socket.close(); }
