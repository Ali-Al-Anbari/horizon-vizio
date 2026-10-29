// Local Home -> Search -> episode -> existing player URL -> Search -> Home.
// The remote player request is blocked: this test never contacts the bridge.
import assert from "node:assert/strict";

const port = Number(process.env.HORIZON_CDP_PORT || 9227);
const origin = process.env.HORIZON_LOCAL_ORIGIN || "http://127.0.0.1:4173";
const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const tab = tabs.find(value => value.type === "page");
assert.ok(tab, "headless Chrome page exists");
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let sequence = 0;
const pending = new Map();
const requests = [];
const errors = [];
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.method === "Network.requestWillBeSent") requests.push(message.params.request.url);
  if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text);
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
async function until(check, label) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch (error) {
      if (!/context was destroyed|Cannot find context/.test(String(error))) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw Error(`Timed out waiting for ${label}; requests=${JSON.stringify(requests.slice(-3))}`);
}
async function key(value) {
  await evaluate(`(location.pathname.startsWith('/frontend/') ? window : document).dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(value)},bubbles:true}))`);
}
try {
  await send("Runtime.enable"); await send("Page.enable"); await send("Network.enable");
  await send("Network.setBlockedURLs", { urls: ["*horizon-video-lab-preview.ali-al-anbari.workers.dev*"] });
  await send("Page.navigate", { url: origin + "/frontend/index.html" });
  await until(async () => await evaluate("document.readyState === 'complete' && !!document.querySelector('#search-open') && !!document.querySelector('#app-grid button')"), "Home ready");
  assert.equal(await evaluate("document.title"), "Horizon for Vizio");
  await evaluate("localStorage.clear(); sessionStorage.clear()");
  await key("ArrowUp"); await key("ArrowLeft");
  assert.equal(await evaluate("document.activeElement.id"), "search-open");
  await key("Enter");
  await until(async () => await evaluate("location.pathname === '/universal-search/index.html' && !!window.HorizonUniversalSearch && document.activeElement.id === 'query'"), "Search ready");
  assert.equal(await evaluate("document.title"), "Horizon Watch");
  await evaluate("document.querySelector('#query').value='South'; document.querySelector('#query').dispatchEvent(new Event('input',{bubbles:true}))");
  await until(async () => await evaluate("document.querySelector('#search-status')?.textContent === '1 results'"), "search results");
  await evaluate("document.querySelector('#results button').click()");
  await until(async () => await evaluate("document.querySelector('#detail-title')?.textContent === 'South Park' && !!document.querySelector('#detail-actions button')"), "show details");
  await evaluate("document.querySelector('#detail-actions .detail-secondary').click()");
  await until(async () => await evaluate("document.querySelectorAll('#episode-list button').length === 3"), "episode selection");
  await evaluate("document.querySelectorAll('#episode-list button')[1].click()");
  await until(async () => requests.some(url => url.startsWith("https://horizon-video-lab-preview.ali-al-anbari.workers.dev/player-overlay.html?")), "player launch request");
  const playerUrl = new URL(requests.find(url => url.startsWith("https://horizon-video-lab-preview.ali-al-anbari.workers.dev/player-overlay.html?")));
  assert.equal(playerUrl.searchParams.get("showId"), "2190");
  assert.equal(playerUrl.searchParams.get("season"), "13");
  assert.equal(playerUrl.searchParams.get("episode"), "2");
  assert.equal(playerUrl.searchParams.get("sub"), "off");
  assert.equal(playerUrl.searchParams.get("from"), "search");
  const returned = origin + "/universal-search/index.html?mock=1&return=1&showId=2190&season=13&episode=2&sub=off";
  await send("Page.navigate", { url: returned });
  await until(async () => await evaluate("!document.querySelector('#episodes-view')?.hidden && document.querySelectorAll('#episode-list button').length === 3 && document.activeElement.dataset.episode === '2'"), "selected episode restored");
  await key("Escape");
  assert.equal(await evaluate("document.activeElement.id"), "details-back");
  await key("Escape");
  assert.equal(await evaluate("document.activeElement.dataset.mediaId"), "2190");
  await key("Escape"); await key("Escape");
  await until(async () => await evaluate("location.pathname === '/frontend/index.html' && document.activeElement.id === 'search-open'"), "Home restored");
  assert.equal(await evaluate("document.querySelectorAll('#watch-cards button').length"), 1);
  assert.match(await evaluate("document.querySelector('#watch-cards button').textContent"), /S13 E2/);
  await key("ArrowDown"); await key("ArrowDown");
  assert.equal(await evaluate("document.activeElement.dataset.watchIndex"), "0");
  const launchesBeforeHistory = requests.filter(url => url.startsWith("https://horizon-video-lab-preview.ali-al-anbari.workers.dev/player-overlay.html?")).length;
  await key("Enter");
  await until(async () => requests.filter(url => url.startsWith("https://horizon-video-lab-preview.ali-al-anbari.workers.dev/player-overlay.html?")).length > launchesBeforeHistory, "history episode launch");
  const historyLaunch = new URL(requests.filter(url => url.startsWith("https://horizon-video-lab-preview.ali-al-anbari.workers.dev/player-overlay.html?")).at(-1));
  assert.equal(historyLaunch.searchParams.get("episode"), "2");
  await send("Page.navigate", { url: returned });
  await until(async () => await evaluate("!document.querySelector('#episodes-view')?.hidden && document.activeElement.dataset.episode === '2'"), "history playback returns to episode list");
  await evaluate("document.querySelector('#history-toggle').click()");
  assert.equal(await evaluate("document.querySelectorAll('#history-list button').length"), 1);
  await evaluate("document.querySelector('#history-clear').click()");
  assert.equal(await evaluate("document.querySelectorAll('#history-list button').length"), 1);
  await evaluate("document.querySelector('#history-clear').click()");
  assert.equal(await evaluate("document.querySelectorAll('#history-list button').length"), 0);
  await key("Escape"); await key("Escape"); await key("Escape"); await key("Escape"); await key("Escape");
  await until(async () => await evaluate("location.pathname === '/frontend/index.html' && document.querySelectorAll('#watch-cards button').length === 0"), "clear history reaches Home");
  assert.deepEqual(errors, []);
  console.log("Integration browser E2E passed: Home -> Watch -> episode -> player URL -> return; Home history -> player -> episode return; clear History -> empty Home row.");
} finally { socket.close(); }
