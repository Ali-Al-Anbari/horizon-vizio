// Run with a localhost static server and headless Chrome on the CDP port.
// The localhost-only mock requires no TMDB secret or deployed Worker.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const port = Number(process.env.HORIZON_CDP_PORT || 9227);
const base = process.env.HORIZON_SEARCH_URL || "http://127.0.0.1:4173/?mock=1";
const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const tab = tabs.find(value => value.type === "page");
assert.ok(tab, "headless Chrome page exists");
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let sequence = 0;
const pending = new Map();
const errors = [];
const requests = [];
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails);
  if (message.method === "Network.requestWillBeSent") requests.push(message.params.request.url);
  if (message.id && pending.has(message.id)) {
    const action = pending.get(message.id); pending.delete(message.id);
    message.error ? action.reject(Error(message.error.message)) : action.resolve(message.result);
  }
};
function send(method, params = {}) { return new Promise((resolve, reject) => {
  const id = ++sequence; pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
}); }
async function evaluate(expression) {
  const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}
async function until(expression, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await evaluate(expression)) return; } catch (error) {
      if (!/context was destroyed|Cannot find context/.test(String(error))) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw Error(`Timed out waiting for ${label}; page=${await evaluate("location.href")} status=${await evaluate("document.querySelector('#search-status')?.textContent")}`);
}
async function navigate(url) {
  await send("Page.navigate", { url });
  await until(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete' && !!window.HorizonUniversalSearch && document.activeElement.id === 'query'`, "page ready");
}
async function capture(path) {
  const result = await send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
  await writeFile(path, Buffer.from(result.data, "base64"));
}
try {
  await send("Runtime.enable"); await send("Page.enable");
  await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true });
  await send("Network.setBlockedURLs", { urls: ["*horizon-video-lab-preview.ali-al-anbari.workers.dev*"] });
  await navigate(base);
  await evaluate("localStorage.clear(); sessionStorage.clear()");
  const cleanUrl = new URL(base); cleanUrl.searchParams.set("run", String(Date.now()));
  await navigate(cleanUrl.href);
  assert.equal(await evaluate("document.title"), "Horizon Watch");
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));");
  assert.equal(await evaluate("document.activeElement.textContent"), "A");
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',repeat:true,bubbles:true}));");
  assert.equal(await evaluate("document.querySelector('#query').value"), "");
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));");
  assert.equal(await evaluate("document.querySelector('#query').value"), "a");
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Backspace',bubbles:true}));");
  assert.equal(await evaluate("document.activeElement.id"), "query");
  await evaluate("document.querySelector('#query').value='South'; document.querySelector('#query').dispatchEvent(new Event('input',{bubbles:true}));");
  await until("document.querySelector('#search-status').textContent === '1 results' && document.querySelectorAll('#results button').length === 1", "TV search results");
  await evaluate("document.querySelector('#keyboard-toggle').click()");
  assert.equal(await evaluate("document.querySelector('#keyboard').hidden"), false, "keyboard cannot be hidden within Search");
  await evaluate("document.querySelector('#search-toggle').focus(); document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));");
  assert.equal(await evaluate("document.activeElement.id"), "continue-toggle");
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));");
  assert.equal(await evaluate("document.activeElement.id"), "history-toggle");
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));");
  assert.equal(await evaluate("document.activeElement.id"), "continue-toggle");
  await evaluate("document.querySelector('#search-toggle').focus(); document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));");
  assert.equal(await evaluate("document.activeElement.id"), "query");
  await evaluate("document.querySelector('#query').focus(); document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));");
  assert.equal(await evaluate("document.activeElement.closest('#keyboard') !== null"), true);
  await evaluate("document.querySelectorAll('#keyboard-keys button')[5].focus(); document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));");
  assert.equal(await evaluate("document.activeElement.closest('#results') !== null"), true);
  assert.equal(await evaluate("document.querySelector('#keyboard').hidden"), false, "result focus keeps keyboard visible");
  assert.equal(await evaluate("document.activeElement.classList.contains('is-focused') && getComputedStyle(document.activeElement.querySelector('.poster-art')).outlineStyle === 'solid'"), true);
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));");
  assert.equal(await evaluate("document.activeElement.closest('#keyboard') !== null"), true);
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  assert.equal(await evaluate("document.querySelector('#query').value"), "", "first Back clears Search query");
  assert.equal(await evaluate("document.querySelectorAll('#results button').length"), 0, "first Back clears results");
  assert.equal(await evaluate("document.querySelector('#search-view').hidden || document.querySelector('#keyboard').hidden"), false);
  await evaluate("document.querySelector('#query').value='South'; document.querySelector('#query').dispatchEvent(new Event('input',{bubbles:true}))");
  await until("document.querySelector('#results button')?.textContent.includes('South Park')", "search after Back clear");
  await evaluate(`window.HorizonSearchMock.title=(type,id)=>({type,id,title:'South Park',date:'1997-08-13',
    overview:'Four friends navigate life in the small town of South Park. This deliberately long synopsis checks that the details copy remains readable and never pushes the episode rail below the screen.',
    genres:['Animation','Comedy'],backdrop:'/south-park-backdrop.jpg',poster:'/south-park-poster.jpg',
    seasons:[{number:13,count:14,name:'Season 13'},{number:14,count:14,name:'Season 14'}]});
    window.HorizonSearchMock.providers=()=>({link:'https://www.themoviedb.org/tv/2190/watch?locale=US',
      stream:[{id:531,name:'Paramount+ Essential',logo:'/paramount.jpg'},{id:532,name:'Paramount+ Premium',logo:'/paramount.jpg'},
        {id:9,name:'Amazon Prime Video',logo:'/prime.jpg'}],rent:[{id:531,name:'Paramount+',logo:'/paramount.jpg'}],free:[],buy:[]});
    window.HorizonSearchMock.season=(id,n)=>({number:n,episodes:n===13?[
      {number:1,title:'The Ring',date:'2009-03-11',still:'/episode-one.jpg'},
      {number:2,title:'The Coon',date:'2009-03-18',still:'/episode-two.jpg'},
      {number:3,title:'Margaritaville',date:'2009-03-25',still:'/episode-three.jpg'}]:[
      {number:1,title:'Episode 1',date:'2010-03-17',still:null}]});`);
  await evaluate("document.querySelector('#results button').click()");
  await until("document.querySelector('#detail-title').textContent === 'South Park' && document.querySelectorAll('#providers button').length === 2 && document.querySelectorAll('#detail-episodes button').length === 3", "TV details, provider icons, and episode rail");
  assert.equal(await evaluate("document.querySelector('#detail-art img')?.src.includes('/w1280/south-park-backdrop.jpg')"), true);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#detail-art img')).objectFit"), "cover");
  assert.equal(await evaluate("document.querySelector('#detail-summary').textContent.includes('deliberately long synopsis')"), true);
  assert.equal(await evaluate("document.querySelectorAll('#providers button').length"), 2, "Paramount subscription plans and rent listing collapse to one service icon");
  assert.equal(await evaluate("document.querySelector('#providers').textContent.includes('Mark subscribed')"), false);
  assert.equal(await evaluate("document.querySelector('#providers button').dataset.availability"), "stream,rent");
  await until("Array.from(document.querySelectorAll('#providers img')).every(image => image.complete)", "provider logo fallbacks");
  assert.equal(await evaluate("Array.from(document.querySelectorAll('#providers .provider-icon')).every(icon => icon.classList.contains('has-name-fallback') && icon.textContent.trim().length > 1)"), true,
    "failed provider logos become readable names rather than empty or single-letter marks");
  assert.equal(await evaluate("document.querySelector('#detail-actions').textContent.includes('Search the web')"), false);
  assert.equal(await evaluate("document.querySelector('#detail-actions .detail-primary').textContent"), "Play S13 E1");
  assert.equal(await evaluate("document.querySelector('#detail-season-toggle').textContent"), "Season 13 ▾");
  assert.equal(await evaluate("document.querySelectorAll('#detail-episodes .detail-episode-art').length"), 3);
  assert.equal(await evaluate("document.querySelector('#detail-episodes button').getAttribute('aria-label')"), "Season 13, episode 1: The Ring");
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 1536, height: 960 }, { width: 1024, height: 768 }]) {
    await send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1, mobile: false });
    const geometry = await evaluate(`(() => { const h=innerHeight, view=document.querySelector('#details-view').getBoundingClientRect(),
      episodes=document.querySelector('#detail-episode-section').getBoundingClientRect(), title=document.querySelector('#detail-title').getBoundingClientRect(),
      primary=document.querySelector('#detail-actions .detail-primary').getBoundingClientRect();
      return {height:h, document:document.documentElement.scrollHeight, body:document.body.scrollHeight,
        viewBottom:view.bottom, episodeTop:episodes.top, episodeBottom:episodes.bottom, titleBottom:title.bottom, primaryBottom:primary.bottom}; })()`);
    assert.ok(geometry.document <= viewport.height && geometry.body <= viewport.height, `no vertical page scroll at ${viewport.width}x${viewport.height}: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.episodeTop < viewport.height && geometry.episodeBottom <= viewport.height, `episode row fits at ${viewport.width}x${viewport.height}`);
    assert.ok(geometry.titleBottom < geometry.episodeTop && geometry.primaryBottom < geometry.episodeTop, `show information and action remain above episodes at ${viewport.width}x${viewport.height}`);
    if (viewport.height <= 800) {
      await evaluate("document.querySelector('#detail-season-toggle').click()");
      const menu = await evaluate("(() => {const r=document.querySelector('#detail-season-menu').getBoundingClientRect();return {top:r.top,bottom:r.bottom,hidden:document.querySelector('#detail-season-menu').hidden}})()");
      assert.ok(!menu.hidden && menu.top >= 0 && menu.bottom <= viewport.height, `season menu remains fully visible at ${viewport.width}x${viewport.height}: ${JSON.stringify(menu)}`);
      await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    }
  }
  await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.querySelector('#detail-actions .detail-primary').focus(); let steps=0;
    while (!document.activeElement.closest('#detail-episodes') && steps++ < 5)
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));`);
  assert.equal(await evaluate("document.activeElement.closest('#detail-episodes') !== null"), true, "D-pad can move from actions through providers to the episode rail");
  await evaluate("document.querySelector('#detail-episodes button').focus(); document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))");
  assert.equal(await evaluate("document.activeElement.dataset.episode"), "2", "Right advances through the horizontal episode row");
  await evaluate("window.HorizonSearchCore.writeSubtitlePref(localStorage,'on')");
  await evaluate(`document.querySelector('#details-back').click();
    window.__originalImageUrl=window.HorizonSearchCore.imageUrl;
    window.HorizonSearchCore.imageUrl=function(path){return path?'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=':''};
    document.querySelector('#results button').click()`);
  await until("document.querySelector('#detail-title').textContent === 'South Park'", "deterministic artwork fallback fixture");
  await evaluate("document.querySelector('#detail-art img').dispatchEvent(new Event('error'))");
  assert.equal(await evaluate("document.querySelector('#details-view').classList.contains('is-poster')"), true, "backdrop failure falls back to poster artwork");
  assert.equal(await evaluate("document.querySelector('#detail-art img').src.startsWith('data:image/gif')"), true);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#detail-art img')).objectFit"), "contain");
  await evaluate("document.querySelector('#detail-art img').dispatchEvent(new Event('error'))");
  assert.equal(await evaluate("document.querySelector('#detail-art img') === null && !document.querySelector('#details-view').classList.contains('has-art')"), true, "failed poster falls back to the no-art background");
  await evaluate("window.HorizonSearchCore.imageUrl=window.__originalImageUrl");
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Backspace',bubbles:true}))");
  assert.equal(await evaluate("document.querySelector('#details-view').hidden"), true);
  await evaluate("document.querySelector('#results button').click()");
  await until("document.querySelector('#detail-title').textContent === 'South Park' && document.querySelectorAll('#detail-episodes button').length === 3", "restored TV details");
  assert.equal(await evaluate("window.HorizonSearchCore.readSubtitlePref(localStorage)"), "on", "details navigation retains the stored subtitle preference");
  await evaluate("document.querySelector('#detail-season-toggle').click()");
  assert.equal(await evaluate("document.querySelector('#detail-season-toggle').getAttribute('aria-expanded')"), "true");
  assert.equal(await evaluate("document.querySelectorAll('#detail-season-menu button').length"), 2);
  await evaluate("window.HorizonSearchCore.writeHistory(localStorage,window.HorizonSearchCore.item('tv',2190,'South Park',13,2,'off',100)); window.HorizonSearchCore.writeHistory(localStorage,window.HorizonSearchCore.item('tv',2190,'South Park',14,1,'off',200))");
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))");
  assert.equal(await evaluate("document.activeElement.dataset.season"), "14");
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  assert.equal(await evaluate("document.activeElement.id"), "detail-season-toggle");
  await evaluate("document.querySelector('#detail-season-toggle').click(); document.querySelector('#detail-season-menu [data-season=\\\"14\\\"]').click()");
  await until("document.querySelectorAll('#detail-episodes button').length === 1", "season change updates inline episode rail");
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('#detail-episodes button')).filter(b=>b.querySelector('.episode-started')).map(b=>b.dataset.episode)"), ["1"]);
  await evaluate("document.querySelector('#detail-season-toggle').click(); document.querySelector('#detail-season-menu [data-season=\\\"13\\\"]').click()");
  await until("document.querySelectorAll('#detail-episodes button').length === 3", "restore first season");
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('#detail-episodes button')).filter(b=>b.querySelector('.episode-started')).map(b=>b.dataset.episode)"), ["2"]);
  await evaluate("window.HorizonSearchCore.clearHistory(localStorage); document.querySelector('#detail-season-toggle').click(); document.querySelector('#detail-season-menu [data-season=\"14\"]').click()");
  await until("document.querySelectorAll('#detail-episodes button').length === 1", "season 14 after clear");
  assert.equal(await evaluate("document.querySelectorAll('#detail-episodes .episode-started').length"), 0);
  await evaluate("document.querySelector('#detail-season-toggle').click(); document.querySelector('#detail-season-menu [data-season=\"13\"]').click()");
  await until("document.querySelectorAll('#detail-episodes button').length === 3", "season 13 after clear");
  await evaluate("document.querySelector('#detail-actions .detail-secondary').click()");
  await until("document.querySelectorAll('#seasons button').length === 2 && document.querySelectorAll('#episode-list button').length === 3", "episodes");
  assert.equal(await evaluate("document.querySelectorAll('#episode-list .episode-art').length"), 3);
  await evaluate("document.querySelector('#episodes-back').click()");
  assert.equal(await evaluate("document.activeElement.id"), "details-back");
  await evaluate("document.querySelector('#details-back').click()");
  await evaluate("document.querySelector('[data-filter=movie]').click()");
  await evaluate("document.querySelector('#query').value='Fight'; document.querySelector('#query').dispatchEvent(new Event('input',{bubbles:true}));");
  await until("document.querySelector('#search-status').textContent === '1 results' && document.querySelector('#results button')?.textContent.includes('Fight Club')", "movie search result");
  await evaluate("document.querySelector('#results button').click()");
  await until("document.querySelector('#detail-title').textContent === 'Fight Club'", "movie details");
  assert.equal(await evaluate("[...document.querySelectorAll('#detail-actions button')].some(button => /Watch in Horizon|Play/.test(button.textContent))"), false);
  assert.equal(await evaluate("document.querySelector('.provider-link') === null"), true);
  assert.equal(await evaluate("document.querySelectorAll('#providers button').length"), 0, "invalid title link leaves provider icons informational");
  assert.equal(await evaluate("document.querySelectorAll('#providers .provider-informational').length"), 2);
  await evaluate("document.querySelector('#details-back').click(); window.HorizonSearchMock.title=()=>({type:'movie',id:550,title:'Fight Club',backdrop:'https://evil.example/image.jpg',poster:'/bad/path'}); document.querySelector('#results button').click()");
  await until("document.querySelector('#detail-title').textContent === 'Fight Club' && document.querySelector('#detail-status').textContent.includes('not supported')", "malformed artwork details");
  assert.equal(await evaluate("document.querySelector('#detail-art img') === null"), true);
  await evaluate("document.querySelector('#details-back').click(); window.HorizonSearchMock.search=()=>{throw Error('mock outage')}; document.querySelector('#query').value='outage'; document.querySelector('#query').dispatchEvent(new Event('input',{bubbles:true}));");
  await until("document.querySelector('#search-status').textContent.includes('Search unavailable')", "search error state");
  assert.equal(await evaluate("document.querySelector('#results button').textContent"), "Retry");
  await evaluate("window.HorizonSearchMock.search=(q)=>q==='slow' ? new Promise(resolve=>setTimeout(()=>resolve({results:[{type:'tv',id:2190,title:'Stale result'}]}),400)) : {results:[{type:'movie',id:550,title:'Fresh result'}]}; document.querySelector('#query').value='slow'; document.querySelector('#query').dispatchEvent(new Event('input',{bubbles:true}));");
  await until("document.querySelector('#search-status').textContent === 'Searching…'", "slow search started");
  await evaluate("document.querySelector('#query').value='fresh'; document.querySelector('#query').dispatchEvent(new Event('input',{bubbles:true}));");
  await until("document.querySelector('#results button')?.textContent.includes('Fresh result')", "fresh result replaces pending search");
  assert.equal(await evaluate("document.querySelector('#results').textContent.includes('Stale result')"), false);
  await evaluate("window.HorizonSearchMock.search=()=>({results:[{type:'tv',id:1,title:'Southbound',popularity:1},{type:'movie',id:2,title:'Southpaw',popularity:15},{type:'tv',id:3,title:'South Park',popularity:200},{type:'movie',id:4,title:'The South',popularity:500}]}); document.querySelector('[data-filter=all]').click(); document.querySelector('#query').value='sout'; document.querySelector('#query').dispatchEvent(new Event('input',{bubbles:true}))");
  await until("document.querySelectorAll('#results button').length === 4", "ranked search results");
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('#results button .poster-meta strong'),e=>e.textContent)"),
    ["South Park", "Southpaw", "Southbound", "The South"]);
  await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await evaluate("window.HorizonSearchMock.search=()=>({results:Array.from({length:9},(_,i)=>({type:'tv',id:1000+i,title:'Grid '+(i+1),date:'2025-01-01',poster:null,backdrop:null}))}); document.querySelector('#query').value='grid'; document.querySelector('#query').dispatchEvent(new Event('input',{bubbles:true}));");
  await until("document.querySelector('#search-status').textContent === '9 results' && document.querySelectorAll('#results button').length === 9", "landscape result grid");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#results')).gridTemplateColumns.split(' ').length"), 3);
  assert.equal(await evaluate("document.querySelector('#results .art-fallback').textContent"), "Grid 1");
  await evaluate("document.querySelector('#results button').focus(); document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));");
  assert.equal(await evaluate("document.activeElement.dataset.mediaId"), "1001");
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));");
  assert.equal(await evaluate("document.activeElement.dataset.mediaId"), "1004");
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));");
  assert.equal(await evaluate("document.activeElement.dataset.mediaId"), "1003");
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));");
  assert.equal(await evaluate("document.activeElement.closest('#keyboard') !== null"), true);
  await evaluate("localStorage.setItem(window.HorizonSearchCore.HISTORY_KEY,JSON.stringify({version:1,items:[{type:'tv',id:2190,title:'South Park',season:13,episode:2,subtitle:'on',at:100}]})); sessionStorage.setItem(window.HorizonSearchCore.STATE_KEY,JSON.stringify({version:1,view:'episodes',filter:'tv',query:'South',type:'tv',id:2190,season:13,subtitle:'on'}));");
  const returnUrl = new URL(base);
  returnUrl.searchParams.set("return", "1"); returnUrl.searchParams.set("showId", "2190");
  returnUrl.searchParams.set("season", "13"); returnUrl.searchParams.set("episode", "3");
  returnUrl.searchParams.set("sub", "off");
  await send("Page.navigate", { url: returnUrl.href });
  await until("!document.querySelector('#episodes-view')?.hidden && document.querySelectorAll('#episode-list button').length === 3", "return to episode selection");
  assert.equal(await evaluate("JSON.parse(localStorage.getItem(window.HorizonSearchCore.HISTORY_KEY)).items[0].episode"), 3);
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('#episode-list button')).filter(b=>b.querySelector('.episode-started')).map(b=>b.dataset.episode)"), ["2", "3"]);
  assert.equal(await evaluate("JSON.parse(localStorage.getItem(window.HorizonSearchCore.HISTORY_KEY)).items[0].subtitle"), "off");
  await evaluate("document.querySelector('#episodes-back').click()");
  assert.equal(await evaluate("window.HorizonSearchCore.readSubtitlePref(localStorage)"), "off");
  assert.equal(await evaluate("document.activeElement.id"), "details-back");
  await evaluate("document.querySelector('#details-back').click(); window.HorizonSearchMock.title=(type,id)=>new Promise(resolve=>setTimeout(()=>resolve({type,id,title:'South Park',date:'1997-08-13',seasons:[{number:13,name:'Season 13'}]}),150)); document.querySelector('#query').value='South'; document.querySelector('#query').dispatchEvent(new Event('input',{bubbles:true}));");
  await until("document.querySelector('#results button')?.textContent.includes('South Park')", "search after return");
  await evaluate("document.querySelector('#results button').click(); document.querySelector('#detail-actions .detail-secondary').click()");
  await until("document.querySelector('#episode-status').textContent === 'Loading season metadata…'", "early episode browsing waits for metadata");
  await until("document.querySelectorAll('#episode-list button').length === 3", "early episode browsing recovers");
  await evaluate("localStorage.setItem(window.HorizonSearchCore.HISTORY_KEY,JSON.stringify({version:2,items:[{type:'tv',id:2190,title:'South Park',season:13,episode:2,subtitle:'on',at:100},{type:'tv',id:2190,title:'South Park',season:13,episode:3,subtitle:'off',at:300},{type:'movie',id:550,title:'Fight Club',at:200}]})); sessionStorage.clear()");
  const historyUrl = new URL(base); historyUrl.searchParams.set("run", "history-" + Date.now());
  await navigate(historyUrl.href);
  await evaluate("document.querySelector('#history-toggle').click()");
  assert.equal(await evaluate("document.querySelectorAll('#history-list button').length"), 2);
  assert.match(await evaluate("document.querySelector('#history-list button').getAttribute('aria-label')"), /S13 E3/);
  assert.equal(await evaluate("window.HorizonSearchCore.readHistory(localStorage).length"), 3, "grouping leaves episode records intact");
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  assert.equal(await evaluate("document.querySelector('#search-view').hidden"), false);
  await evaluate("document.querySelector('#history-toggle').click(); document.querySelector('#history-list button').click()");
  await until("location.origin === 'https://horizon-video-lab-preview.ali-al-anbari.workers.dev' || location.href.startsWith('chrome-error:')", "History player navigation");
  const historyPlayer = requests.find(url => url.startsWith("https://horizon-video-lab-preview.ali-al-anbari.workers.dev/player-overlay.html?"));
  assert.ok(historyPlayer);
  assert.equal(new URL(historyPlayer).searchParams.get("episode"), "3");
  await send("Page.navigate", { url: historyUrl.href });
  await until("document.activeElement.id === 'query' && !!window.HorizonUniversalSearch", "Search after history launch");
  await evaluate("document.querySelector('#history-toggle').click(); document.querySelector('#history-clear').click(); document.querySelector('#history-clear').click()");
  assert.equal(await evaluate("document.querySelectorAll('#history-list button').length"), 0, "Clear History removes grouped cards");
  assert.equal(await evaluate("window.HorizonSearchCore.readHistory(localStorage).length"), 0, "Clear History removes underlying starts");
  await evaluate("sessionStorage.clear(); localStorage.clear()");
  const searchCheck = new URL(base); searchCheck.searchParams.set("run", "search-efficiency-" + Date.now());
  await navigate(searchCheck.href);
  await evaluate("window.__searchCalls=[]; const oldSearch=window.HorizonSearchMock.search; window.HorizonSearchMock.search=(q,t)=>{window.__searchCalls.push(q); return oldSearch(q,t)}; document.querySelector('#query').value='S'; document.querySelector('#query').dispatchEvent(new Event('input',{bubbles:true}))");
  assert.equal(await evaluate("window.__searchCalls.length"), 0);
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
  await until("document.querySelector('#search-status').textContent === '1 results'", "explicit one-character search");
  assert.equal(await evaluate("window.__searchCalls.join(',')"), "S");
  await evaluate("document.querySelector('#query').value='So'; document.querySelector('#query').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#query').value='Sou'; document.querySelector('#query').dispatchEvent(new Event('input',{bubbles:true}))");
  assert.equal(await evaluate("window.__searchCalls.length"), 1);
  await until("window.__searchCalls.length === 2 && document.querySelector('#search-status').textContent === '1 results'", "one debounced request");
  assert.equal(await evaluate("window.__searchCalls[1]"), "Sou");
  await evaluate("document.querySelector('#query').value='South'; document.querySelector('#query').dispatchEvent(new Event('input',{bubbles:true}))");
  await until("window.__searchCalls.length === 3 && document.querySelector('#search-status').textContent === '1 results'", "new query request");
  await evaluate("document.querySelector('#query').value='Sou'; document.querySelector('#query').dispatchEvent(new Event('input',{bubbles:true}))");
  await until("document.querySelector('#search-status').textContent === '1 results'", "cached query response");
  assert.equal(await evaluate("window.__searchCalls.length"), 3);
  const rateUrl = new URL(base); rateUrl.searchParams.set("mock", "0");
  await evaluate("sessionStorage.clear()");
  await navigate(rateUrl.href);
  await evaluate("window.__rateCalls=0; window.fetch=()=>{window.__rateCalls++; return Promise.resolve(new Response(JSON.stringify({error:'rate_limited'}),{status:429,headers:{'Retry-After':'7'}}))}; document.querySelector('#query').value='South'; document.querySelector('#query').dispatchEvent(new Event('input',{bubbles:true}))");
  await until("document.querySelector('#search-status').textContent.includes('rate limited')", "rate limit feedback");
  assert.match(await evaluate("document.querySelector('#search-status').textContent"), /7 seconds/);
  assert.equal(await evaluate("window.__rateCalls"), 1);
  await evaluate("sessionStorage.clear()");
  await navigate(rateUrl.href);
  await evaluate("window.__signals=[]; window.fetch=(path,options)=>{window.__signals.push(options.signal); const name=String(path).includes('slow')?'Slow result':'Fast result'; if(name==='Slow result') return new Promise(resolve=>{window.__releaseSlow=()=>resolve(new Response(JSON.stringify({results:[{type:'tv',id:2190,title:name}]}),{status:200}))}); return Promise.resolve(new Response(JSON.stringify({results:[{type:'tv',id:2190,title:name}]}),{status:200}))}; document.querySelector('#query').value='slow'; document.querySelector('#query').dispatchEvent(new Event('input',{bubbles:true}))");
  await until("window.__signals.length === 1", "slow request starts");
  await evaluate("document.querySelector('#query').value='fast'; document.querySelector('#query').dispatchEvent(new Event('input',{bubbles:true}))");
  assert.equal(await evaluate("window.__signals[0].aborted"), true);
  await until("document.querySelector('#results button')?.textContent.includes('Fast result')", "new request wins");
  await evaluate("window.__releaseSlow()");
  assert.equal(await evaluate("document.querySelector('#results').textContent.includes('Slow result')"), false);

  if (process.env.HORIZON_CAPTURE_DIR && process.env.HORIZON_DETAIL_BACKDROP && process.env.HORIZON_DETAIL_POSTER) {
    const captureDir = process.env.HORIZON_CAPTURE_DIR;
    await mkdir(captureDir, { recursive: true });
    const backdrop = "data:image/jpeg;base64," + (await readFile(process.env.HORIZON_DETAIL_BACKDROP)).toString("base64");
    const posterImage = "data:image/jpeg;base64," + (await readFile(process.env.HORIZON_DETAIL_POSTER)).toString("base64");
    async function openVisualTitle(queryText, fields) {
      await navigate(base + (base.includes("?") ? "&" : "?") + "visual=" + encodeURIComponent(queryText) + Date.now());
      await evaluate("localStorage.clear(); sessionStorage.clear();");
      await navigate(base + (base.includes("?") ? "&" : "?") + "visual=" + encodeURIComponent(queryText) + Date.now() + "b");
      await evaluate(`window.HorizonSearchMock.search=()=>({results:[Object.assign({type:'tv',id:76479,title:'The Boys',
        date:'2019-07-26',overview:'The world is on the brink as Butcher and the Boys confront a growing threat at the highest levels of power.',
        backdrop:null,poster:null},${JSON.stringify(fields)})]});
        window.HorizonSearchMock.title=()=>Object.assign({type:'tv',id:76479,title:'The Boys',date:'2019-07-26',
          overview:'The world is on the brink as Butcher and the Boys confront a growing threat at the highest levels of power.',
          genres:['Action','Drama'],seasons:[{number:1,count:8,name:'Season 1'},{number:2,count:8,name:'Season 2'},
            {number:3,count:8,name:'Season 3'},{number:4,count:8,name:'Season 4'}],backdrop:null,poster:null},${JSON.stringify(fields)});
        window.HorizonSearchMock.providers=()=>({link:'https://www.themoviedb.org/tv/76479/watch?locale=US',
          stream:[{id:9,name:'Prime Video',logo:null}],free:[],rent:[],buy:[]});
        window.HorizonSearchMock.season=()=>({number:4,episodes:[
          {number:1,title:'Department of Dirty Tricks',date:'2024-06-13',still:null},
          {number:2,title:'Life Among the Septics',date:'2024-06-13',still:null},
          {number:3,title:'We’ll Keep the Red Flag Flying',date:'2024-06-20',still:null},
          {number:4,title:'Wisdom of the Ages',date:'2024-06-27',still:null}]});
        window.HorizonSearchCore.writeHistory(localStorage,window.HorizonSearchCore.item('tv',76479,'The Boys',4,1,'off',Date.now()));
        document.querySelector('#query').value=${JSON.stringify(queryText)};
        document.querySelector('#query').dispatchEvent(new Event('input',{bubbles:true}));`);
      await until("document.querySelector('#results button')?.textContent.includes('The Boys')", "visual QA title result");
      await evaluate("document.querySelector('#results button').click()");
      await until("document.querySelector('#detail-title').textContent === 'The Boys' && document.querySelectorAll('#detail-episodes button').length === 4", "visual QA details and episodes");
      if (fields.backdrop) {
        await evaluate("document.querySelector('#detail-art img').src=" + JSON.stringify(backdrop));
        await evaluate("document.querySelector('#detail-art img').decode()");
      } else if (fields.poster) {
        await evaluate("document.querySelector('#detail-art img').src=" + JSON.stringify(posterImage));
        await evaluate("document.querySelector('#detail-art img').decode()");
      }
      await evaluate("document.querySelector('.detail-primary').focus()");
    }
    await openVisualTitle("BoysBackdrop", { backdrop: "/qa-boys-backdrop.jpg", poster: "/qa-boys-poster.jpg" });
    for (const viewport of [{ width: 1920, height: 1080 }, { width: 1536, height: 960 }, { width: 1024, height: 768 }]) {
      await send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1, mobile: false });
      await evaluate(`(() => { document.querySelector('.detail-primary').focus(); let steps=0;
        while (!document.activeElement.closest('#detail-episodes') && steps++ < 5)
          document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
        if (document.activeElement.dataset.episode === '1')
          document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})); })();`);
      const focusStyle = await evaluate("(() => {const e=document.activeElement,s=getComputedStyle(e);return {tag:e.tagName,classes:e.className,focused:e===document.querySelector('#detail-episodes button[data-episode=\"2\"]'),outline:s.outline,boxShadow:s.boxShadow}})()");
      assert.ok(focusStyle.focused && focusStyle.classes.includes("is-focused") && focusStyle.outline.includes("solid"),
        `episode focus has a visible outline before screenshot capture: ${JSON.stringify(focusStyle)}`);
      const state = await evaluate(`(() => ({height:innerHeight,scroll:document.documentElement.scrollHeight,
        episodeTop:document.querySelector('#detail-episode-section').getBoundingClientRect().top,
        episodeBottom:document.querySelector('#detail-episode-section').getBoundingClientRect().bottom,
        title:document.querySelector('#detail-title').getBoundingClientRect().bottom,
        action:document.querySelector('#detail-actions').getBoundingClientRect().bottom}))()`);
      assert.ok(state.scroll <= viewport.height && state.episodeTop < viewport.height && state.episodeBottom <= viewport.height
        && state.title < state.episodeTop && state.action < state.episodeTop, `visual QA fits at ${viewport.width}x${viewport.height}`);
      await capture(join(captureDir, `horizon-show-details-${viewport.width}x${viewport.height}.png`));
    }
    await openVisualTitle("BoysPoster", { poster: "/qa-boys-poster.jpg" });
    await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    await capture(join(captureDir, "horizon-show-details-poster-only.png"));
    await openVisualTitle("BoysNoArt", {});
    await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    await capture(join(captureDir, "horizon-show-details-no-art.png"));
    await evaluate(`document.querySelector('#detail-title').textContent='The Incredibly Long Fictional Title for a Drama Series';
      document.querySelector('#detail-summary').textContent='This synopsis is intentionally very long so the preview can confirm readable clipping, stable hierarchy and a one-screen layout even for unusually verbose source metadata. The artwork area remains clear, the actions stay reachable, and the episode strip remains visible.';
      document.querySelector('.detail-primary').focus();`);
    await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
    await capture(join(captureDir, "horizon-show-details-long-copy-1024x768.png"));
  }
  assert.deepEqual(errors.map(value => value.exception?.description || value.text), []);
  console.log("Browser E2E passed: keyboard/repeat guard, explicit short search, debounce/cache/abort/stale response, 429 feedback, details/providers, seasons, player return/history/subtitle, movie capability.");
} finally { socket.close(); }
