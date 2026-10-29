import fs from 'node:fs';

const base = 'http://127.0.0.1:4173';
const tabs = await (await fetch('http://127.0.0.1:9227/json')).json();
const tab = tabs.find(item => item.type === 'page');
if (!tab) throw Error('Chrome page unavailable');
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let id = 0;
const pending = new Map();
socket.onmessage = event => {
  const result = JSON.parse(event.data);
  if (!result.id || !pending.has(result.id)) return;
  const task = pending.get(result.id); pending.delete(result.id);
  result.error ? task.reject(Error(result.error.message)) : task.resolve(result.result);
};
function send(method, params = {}) { return new Promise((resolve, reject) => {
  const next = ++id; pending.set(next, { resolve, reject });
  socket.send(JSON.stringify({ id: next, method, params }));
}); }
async function evalJs(expression) {
  const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (reply.exceptionDetails) throw Error(reply.exceptionDetails.text);
  return reply.result.value;
}
async function until(expression, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await evalJs(expression)) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 35));
  }
  throw Error('Timed out waiting for ' + expression);
}
async function shot(path) {
  const capture = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path, Buffer.from(capture.data, 'base64'));
}

const mockHistory6 = [
  { type: "tv", id: 105248, title: "Cyberpunk: Edgerunners", season: 1, episode: 2, subtitle: "on", at: Date.now() - 1000, poster: "/7Fk1YIe125F4C75n75eZ1X5sYvW.jpg", backdrop: "/s1xGudgv2OKKLtbgRRA6WpkKygm.jpg", episodeTitle: "" },
  { type: "tv", id: 1396, title: "Breaking Bad", season: 1, episode: 1, subtitle: "on", at: Date.now() - 2000, poster: "/ztkUQFLlC19CCMYHW9o1zWhJRNq.jpg", backdrop: "/tsRy63Mu5cu8etL1X7ZLyf7UP1M.jpg", episodeTitle: "" },
  { type: "movie", id: 157336, title: "Interstellar", season: null, episode: null, subtitle: "on", at: Date.now() - 3000, poster: "/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg", backdrop: "/xJHokMbljvjADYdit5fK5VQsXEG.jpg" },
  { type: "movie", id: 438631, title: "Dune", season: null, episode: null, subtitle: "on", at: Date.now() - 4000, poster: "/d5NXSklXo0qyIYkgV94XAgMIckC.jpg", backdrop: "/lzWHmY2BERKlMS66cs0nsRvdjF7.jpg" },
  { type: "tv", id: 100088, title: "The Last of Us", season: 1, episode: 4, subtitle: "on", at: Date.now() - 5000, poster: "/uKvVjHNqB5VmOrdxqAt2V7JMrqi.jpg", backdrop: "/uDgy6hyPd82kOHh6I95FLtLnj6p.jpg", episodeTitle: "" },
  { type: "movie", id: 335984, title: "Blade Runner 2049", season: null, episode: null, subtitle: "on", at: Date.now() - 6000, poster: "/gajva2L0rPYkEWjzgFlBXCAVBE5.jpg", backdrop: "/ilRyASDvt7v6R445m13jH8iF67k.jpg" }
];

await send('Runtime.enable'); await send('Page.enable');

try {
  // 1. HOME SCENARIOS across resolutions
  for (const [width, height] of [[1920, 1080], [1536, 960], [1024, 768]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    
    // A. Empty history
    await send('Page.navigate', { url: base + '/frontend/index.html?res=' + width });
    await until("document.readyState === 'complete' && !!document.querySelector('#app-grid button')");
    await evalJs("localStorage.setItem('horizon.preferences.v1', JSON.stringify({wallpaper:'img-9612',slideshow:false,accent:'cyan'})); localStorage.removeItem('horizon.watch.home.v1');");
    await send('Page.reload');
    await until("document.querySelector('.wallpaper-layer[style*=\"img-9612\"]') !== null");
    await until("Number(getComputedStyle(document.querySelector('.wallpaper-layer[style*=\"img-9612\"]')).opacity) > .99");
    await shot(`/private/tmp/horizon-qa-home-empty-${width}x${height}.png`);

    // B. Six recent titles with posters (matching mockup)
    await evalJs(`localStorage.setItem('horizon.watch.home.v1', JSON.stringify({ version: 2, items: ${JSON.stringify(mockHistory6)} }));`);
    await send('Page.reload');
    await until("document.querySelectorAll('#watch-cards .watch-card').length === 6");
    await until("document.querySelector('.wallpaper-layer[style*=\"img-9612\"]') !== null && Number(getComputedStyle(document.querySelector('.wallpaper-layer[style*=\"img-9612\"]')).opacity) > .99");
    await shot(`/private/tmp/horizon-qa-home-6posters-${width}x${height}.png`);

    // Focus on Continue Watching first card
    await evalJs("(() => { const el = document.querySelector('#watch-cards .watch-card'); document.querySelector('.app-tile.is-focused')?.classList.remove('is-focused'); el?.focus(); el?.classList.add('is-focused'); })()");
    const watchFocusInset = await evalJs("(() => {const host=document.querySelector('#watch-cards').getBoundingClientRect(),art=document.querySelector('#watch-cards .watch-card-art').getBoundingClientRect();return art.left-host.left})()");
    if (watchFocusInset < 14) throw Error('Home history focus aura may clip at ' + width + 'px');
    const lastWatchInset = await evalJs("(() => {const host=document.querySelector('#watch-cards'), card=host.lastElementChild; card.focus(); card.scrollIntoView({block:'nearest',inline:'nearest'}); return host.getBoundingClientRect().right-card.querySelector('.watch-card-art').getBoundingClientRect().right})()");
    if (lastWatchInset < 14) throw Error('Last Home history card focus aura may clip at ' + width + 'px');
    await evalJs("document.querySelector('#watch-cards .watch-card').focus()");
    await shot(`/private/tmp/horizon-qa-home-focus-continue-${width}x${height}.png`);

    // Focus on lower app shortcut (Spotify / Twitch)
    await evalJs("(() => { const el = document.querySelector('#secondary-app-grid button'); document.querySelector('.watch-card.is-focused')?.classList.remove('is-focused'); el?.focus(); el?.classList.add('is-focused'); })()");
    await shot(`/private/tmp/horizon-qa-home-focus-lower-${width}x${height}.png`);

    // C. Three recent titles
    await evalJs(`localStorage.setItem('horizon.watch.home.v1', JSON.stringify({ version: 2, items: ${JSON.stringify(mockHistory6.slice(0, 3))} }));`);
    await send('Page.reload');
    await until("document.querySelectorAll('#watch-cards .watch-card').length === 3");
    await shot(`/private/tmp/horizon-qa-home-3posters-${width}x${height}.png`);

    // D. Missing poster artwork fallback
    const missingPoster = [
      { type: "tv", id: 9999, title: "Mystery Series", season: 2, episode: 5, subtitle: "on", at: Date.now(), poster: null, backdrop: null }
    ];
    await evalJs(`localStorage.setItem('horizon.watch.home.v1', JSON.stringify({ version: 2, items: ${JSON.stringify(missingPoster)} }));`);
    await send('Page.reload');
    await until("document.querySelectorAll('#watch-cards .watch-card').length === 1");
    await shot(`/private/tmp/horizon-qa-home-fallback-${width}x${height}.png`);

    // 2. WATCH SCENARIOS across resolutions
    await evalJs("sessionStorage.clear(); localStorage.clear();");
    await send('Page.navigate', { url: base + '/universal-search/index.html?mock=1&res=' + width });
    await until("document.readyState === 'complete' && !!window.HorizonUniversalSearch && !!document.querySelector('#keyboard-keys button')");
    await evalJs("sessionStorage.clear(); localStorage.clear();");
    const searchAlignment = await evalJs("(() => {const field=document.querySelector('.search-field').getBoundingClientRect(),keys=document.querySelector('#keyboard-keys').getBoundingClientRect();return {left:Math.abs(field.left-keys.left),width:Math.abs(field.width-keys.width)}})()");
    if (searchAlignment.left > 1 || searchAlignment.width > 1) throw Error('Search field and keyboard misalign at ' + width + 'px');

    // A. Empty query
    await shot(`/private/tmp/horizon-qa-search-empty-${width}x${height}.png`);

    // B. Keyboard focus
    await evalJs("(() => { const el = document.querySelectorAll('#keyboard-keys button')[2]; el?.focus(); el?.classList.add('is-focused'); })()"); // 'c'
    await shot(`/private/tmp/horizon-qa-search-keyfocus-${width}x${height}.png`);

    // C. Cyberpunk query + results
    const cyberpunkFixture = JSON.parse(fs.readFileSync('/private/tmp/horizon-cyberpunk-live.json', 'utf8'));
    await evalJs("window.HorizonSearchMock.search=()=> (" + JSON.stringify(cyberpunkFixture) + ");");
    await evalJs("const q=document.querySelector('#query'); q.value='Cyberpunk'; q.dispatchEvent(new Event('input',{bubbles:true}));");
    await until("document.querySelector('#search-status').textContent === '18 results' && document.querySelectorAll('#results button').length === 18");
    await shot(`/private/tmp/horizon-qa-search-results-${width}x${height}.png`);

    // D. Focused search result (first card with white-blue aura)
    await evalJs("(() => { const el = document.querySelector('#results button'); el?.focus(); el?.classList.add('is-focused'); })()");
    const resultFocusInset = await evalJs("(() => {const host=document.querySelector('#results').getBoundingClientRect(),art=document.querySelector('#results .poster-art').getBoundingClientRect();return art.left-host.left})()");
    if (resultFocusInset < 14) throw Error('Search result focus aura may clip at ' + width + 'px');
    await shot(`/private/tmp/horizon-qa-search-result-focus-${width}x${height}.png`);

    // E. History view with multiple vertical posters
    await evalJs(`localStorage.setItem(window.HorizonSearchCore.HISTORY_KEY, JSON.stringify({ version: 2, items: ${JSON.stringify(mockHistory6)} }));`);
    await evalJs("document.querySelector('#history-toggle').click()");
    await until("document.querySelectorAll('#history-list button').length === 6");
    await shot(`/private/tmp/horizon-qa-search-history-posters-${width}x${height}.png`);

    // F. Show details and episode navigation
    await evalJs("window.HorizonSearchMock.title=(type,id)=>({type,id,title:'Cyberpunk: Edgerunners',date:'2022-09-13',overview:'A street kid trying to survive in a technology and body modification-obsessed city of the future.',seasons:[{number:1,count:10,name:'Season 1'}]});");
    await evalJs("window.HorizonSearchMock.season=(id,num)=>({number:num,episodes:[{number:1,title:'Let You Down',date:'2022-09-13',overview:'A rough day at the academy.'},{number:2,title:'Like a Boy',date:'2022-09-13',overview:'David receives an offer.'}]});");
    await evalJs("document.querySelector('#history-back').click()");
    await evalJs("document.querySelector('#results button[data-media-type=tv]').click()");
    await until("document.querySelector('#detail-title').textContent !== '' && !!document.querySelector('#detail-actions .detail-secondary')");
    await shot(`/private/tmp/horizon-qa-search-details-${width}x${height}.png`);

    await evalJs("document.querySelector('#detail-actions .detail-secondary')?.click()");
    await until("document.querySelectorAll('#episode-list button').length > 0");
    await shot(`/private/tmp/horizon-qa-search-episodes-${width}x${height}.png`);
  }
  console.log("All scenarios successfully rendered and captured.");
} finally { socket.close(); }
