import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const root = new URL("../frontend/", import.meta.url);
const source = name => fs.readFileSync(new URL(name, root), "utf8");

function boot(search = "", options = {}) {
  let elapsed = 1000;
  let requests = 0;
  const frames = [];
  const intervals = [];
  const listeners = {};
  const ids = new Map();
  const document = { activeElement: null, body: null };

  class Element {
    constructor(id = "") {
      this.id = id;
      this.children = [];
      this.dataset = {};
      this.events = {};
      this.hidden = ["settings-screen", "browser-screen", "pairing-screen", "notice", "diagnostics"].includes(id);
      this.textContent = "";
      if (id === "pairing-code") { this.textContent = "—"; this.hidden = true; }
      this.scrollTop = 0;
      this.scrollCalls = 0;
      this.classes = new Set();
      this.classList = {
        add: name => this.classes.add(name),
        remove: name => this.classes.delete(name),
        contains: name => this.classes.has(name),
      };
      this.style = { setProperty() {} };
    }
    addEventListener(name, callback) { (this.events[name] ||= []).push(callback); }
    emit(name) { for (const callback of this.events[name] || []) callback(); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute() {}
    scrollIntoView() { this.scrollCalls++; }
    remove() {}
    focus() {
      if (document.activeElement === this) return;
      document.activeElement?.emit("blur");
      document.activeElement = this;
      this.emit("focus");
    }
  }
  const get = id => {
    if (!ids.has(id)) ids.set(id, new Element(id));
    return ids.get(id);
  };
  document.body = new Element("body");
  document.getElementById = get;
  document.createElement = () => new Element();
  const rows = Array.from({ length: 3 }, (_, index) => {
    const row = new Element();
    row.dataset.setting = ["wallpaper", "slideshow", "accent"][index];
    return row;
  });
  document.querySelectorAll = selector => selector === ".setting-row" ? rows
    : selector === ".wallpaper-layer" ? [new Element(), new Element()] : [];
  document.querySelector = selector => get(selector);

  const navigations = [];
  const stored = new Map(Object.entries(options.storage || {}));
  const session = new Map(Object.entries(options.session || {}));
  const location = { protocol: options.protocol || "http:", port: options.port || "8765", hostname: "localhost", search,
    hash: options.hash || "",
    pathname: "/frontend/index.html", assign: url => navigations.push(url) };
  const window = {
    innerWidth: 1920, innerHeight: 1080,
    history: { replaceState(_state, _title, url) { navigations.push("replace:" + url); } },
    addEventListener(name, callback) { listeners[name] = callback; },
  };
  const sandbox = {
    window, document, location, console, Intl, Date,
    performance: { now: () => elapsed },
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
    setInterval: callback => { intervals.push(callback); return intervals.length; },
    setTimeout: () => 1, clearTimeout() {},
    localStorage: { getItem: key => stored.get(key) || null, setItem: (key, value) => stored.set(key, value) },
    sessionStorage: { getItem: key => session.get(key) || null, setItem: (key, value) => session.set(key, value), removeItem: key => session.delete(key) },
    fetch: (...args) => { requests++; return options.fetch ? options.fetch(...args) : new Promise(() => {}); },
  };
  vm.runInNewContext(source("horizon-config.js"), sandbox);
  window.HORIZON_WALLPAPERS = [];
  vm.runInNewContext(source("horizon-diagnostics.js"), sandbox);
  vm.runInNewContext(source("horizon.js"), sandbox);
  return {
    document, get, window,
    press(key, repeat = false) {
      elapsed += 35;
      listeners.keydown({ key, repeat, timeStamp: elapsed - 1, preventDefault() {} });
      return document.activeElement?.dataset.id;
    },
    frame() {
      elapsed += 16;
      const ready = frames.splice(0);
      for (const callback of ready) callback(elapsed);
    },
    summary() { for (const callback of intervals) callback(); return get("diagnostics").children[0]?.textContent || ""; },
    scheduledFrames: () => frames.length,
    requests: () => requests,
    navigations: () => navigations,
    stored: key => stored.get(key),
    session: key => session.get(key),
  };
}

test("Home Search is remote-focusable, opens once, and restores focus on return", () => {
  const page = boot("", { port: "4173" });
  page.press("ArrowUp");
  page.press("ArrowLeft");
  assert.equal(page.document.activeElement, page.get("search-open"));
  assert.equal(page.get("search-open").classList.contains("is-focused"), true);
  page.press("OK");
  page.press("OK", true);
  assert.deepEqual(page.navigations(), ["/universal-search/index.html?mock=1&from=home-local"]);
  const returned = boot("?return=search", { port: "4173" });
  assert.equal(returned.document.activeElement, returned.get("search-open"));
  assert.deepEqual(returned.navigations(), ["replace:/frontend/index.html"]);
  returned.press("ArrowRight");
  assert.equal(returned.document.activeElement, returned.get("settings-open"));
  const watchLaunch = boot("", { port: "4173" });
  watchLaunch.press("OK");
  watchLaunch.press("OK", true);
  assert.deepEqual(watchLaunch.navigations(), ["/universal-search/index.html?mock=1&from=home-local"]);
  assert.equal(watchLaunch.session("horizon.home.searchFocus"), "horizon-watch");
  const watchReturn = boot("?return=search", { port: "4173", session: { "horizon.home.searchFocus": "horizon-watch" } });
  assert.equal(watchReturn.document.activeElement.dataset.id, "horizon-watch");
});

test("Refined Glass keeps the specified native rows and verified launch mappings", () => {
  const page = boot();
  const top = page.get("app-grid").children.map(tile => tile.dataset.id);
  const bottom = page.get("secondary-app-grid").children.map(tile => tile.dataset.id);
  assert.deepEqual(top, ["horizon-watch", "prime-video", "youtube", "hulu", "netflix"]);
  assert.deepEqual(bottom, ["spotify", "paramount-plus", "twitch", "crunchyroll", "live-tv", "internet", "settings"]);
  assert.equal(new Set([...top, ...bottom]).size, 12);
  const oldPreference = boot("", { storage: { "horizon.preferences.v1": JSON.stringify({ arrangement: "reverse" }) } });
  assert.deepEqual(oldPreference.get("app-grid").children.map(tile => tile.dataset.id), top);
  const byId = Object.fromEntries(page.window.HORIZON_CONFIG.tiles.map(tile => [tile.id, tile]));
  assert.equal(byId["prime-video"].controllerAppId, "prime-video");
  assert.equal(byId.youtube.controllerAppId, "youtube");
  assert.equal(byId["live-tv"].controllerAppId, "live-tv");
  for (const id of ["hulu", "netflix", "spotify", "paramount-plus", "twitch", "crunchyroll"]) {
    assert.equal(byId[id].launchState, "unverified");
    assert.equal(byId[id].controllerAppId, undefined);
  }
});

test("all seven bottom actions remain reachable in one horizontal row", () => {
  const page = boot();
  assert.equal(page.press("ArrowDown"), "spotify");
  for (const id of ["paramount-plus", "twitch", "crunchyroll", "live-tv", "internet", "settings"]) {
    assert.equal(page.press("ArrowRight"), id);
  }
  assert.equal(page.get("secondary-app-grid").children[6].scrollCalls, 1);
  assert.equal(page.press("ArrowRight"), "settings");
  assert.equal(page.press("ArrowUp"), "netflix");
  assert.equal(page.press("ArrowDown"), "live-tv");
  page.press("ArrowLeft");
  assert.equal(page.document.activeElement.dataset.id, "crunchyroll");
});

test("Continue Watching reads a bounded return snapshot and remains reachable from native apps", () => {
  for (const file of ["index.html", "horizon.html"]) {
    const html = source(file);
    assert.ok(html.indexOf('class="apps-section"') < html.indexOf('id="watch-section"'));
    assert.ok(html.indexOf('id="watch-section"') < html.indexOf('class="secondary-apps-section"'));
  }
  const rows = Array.from({ length: 7 }, (_, index) => ({ type: "tv", id: index + 1, title: "Show " + index,
    season: 1, episode: index + 1, subtitle: "off", at: 100 + index,
    tvdbId: index === 1 ? 384541 : null }));
  const snapshot = { version: 2, items: rows.slice(0, 6) };
  const page = boot("?return=search", { port: "4173", hash: "#watch=" + encodeURIComponent(JSON.stringify(snapshot)) });
  assert.equal(page.get("watch-section").hidden, false);
  assert.equal(page.get("watch-cards").children.length, 6);
  assert.equal(page.get("app-grid").children.length, 5);
  assert.equal(page.get("secondary-app-grid").children.length, 7);
  assert.equal(page.get("watch-cards").children[0].children[0].children[0].src, "assets/horizon-watch.svg");
  page.press("ArrowDown");
  page.press("ArrowDown");
  assert.equal(page.document.activeElement.dataset.watchIndex, "0");
  page.press("ArrowRight");
  assert.equal(page.document.activeElement.dataset.watchIndex, "1");
  page.press("ArrowUp");
  assert.equal(page.document.activeElement, page.get("app-grid").children[1]);
  page.press("ArrowDown");
  page.press("ArrowDown");
  assert.equal(page.document.activeElement, page.get("secondary-app-grid").children[1]);
  page.press("ArrowUp");
  assert.equal(page.document.activeElement.dataset.watchIndex, "1");
  page.press("OK");
  assert.match(page.navigations().at(-1), /play=tv&id=2&season=1&episode=2&sub=off/);
  assert.match(page.navigations().at(-1), /tvdb=384541/);
  assert.equal(page.session("horizon.watch.returnFocus"), "tv:2");
  assert.equal(JSON.parse(page.stored("horizon.watch.home.v1")).items[0].id, 2);
  const reloaded = boot("", { storage: { "horizon.watch.home.v1": page.stored("horizon.watch.home.v1") } });
  assert.equal(reloaded.get("watch-cards").children.length, 6);
  const returned = boot("?return=search", { storage: { "horizon.watch.home.v1": page.stored("horizon.watch.home.v1") }, session: { "horizon.watch.returnFocus": "tv:2" } });
  assert.equal(returned.document.activeElement.dataset.watchIndex, "0");
  assert.equal(returned.session("horizon.watch.returnFocus"), undefined);
  for (const count of [1, 3]) {
    const sized = boot("", { storage: { "horizon.watch.home.v1": JSON.stringify({ version: 2, items: rows.slice(0, count) }) } });
    assert.equal(sized.get("watch-cards").children.length, count);
    sized.press("ArrowDown");
    assert.equal(sized.document.activeElement.dataset.watchIndex, "0");
    sized.press("ArrowDown");
  assert.equal(sized.document.activeElement.dataset.id, "spotify");
  }
  const corrupt = boot("", { storage: { "horizon.watch.home.v1": "{broken" } });
  assert.equal(corrupt.get("watch-section").hidden, true);
  const legacy = boot("", { storage: { "horizon.watch.home.v1": JSON.stringify({ version: 2,
    items: [{ type: "tv", id: 2190, title: "South Park", season: 13, episode: 2, at: 100 }] }) } });
  legacy.get("watch-cards").children[0].focus(); legacy.press("OK");
  assert.match(legacy.navigations().at(-1), /sub=off/);
});

test("Continue Watching prefers vertical poster artwork and preserves native app actions", () => {
  const row = { type: "tv", id: 2190, title: "South Park", season: 13, episode: 2, subtitle: "on",
    at: 100, poster: "/poster.jpg", backdrop: "/backdrop.jpg" };
  const page = boot("", { storage: { "horizon.watch.home.v1": JSON.stringify({ version: 2, items: [row] }) } });
  const image = page.get("watch-cards").children[0].children[0].children[0];
  assert.equal(image.src, "https://image.tmdb.org/t/p/w500/poster.jpg");
  image.onerror();
  assert.equal(image.src, "https://image.tmdb.org/t/p/w780/backdrop.jpg");
  image.onerror();
  assert.equal(page.get("watch-cards").children[0].children[0].children[0].src, "assets/horizon-watch.svg");
  page.press("ArrowDown");
  page.press("ArrowDown");
  assert.equal(page.press("ArrowRight"), "paramount-plus");
  page.press("Backspace");
  assert.equal(page.document.activeElement.dataset.id, "horizon-watch");
});

test("Home accepts a movie in the Watch history transfer and opens its details", () => {
  const snapshot = { version: 2, items: [{ type: "movie", id: 550, title: "Fight Club", at: 200,
    poster: "/fight.jpg", backdrop: "/fight-backdrop.jpg" }] };
  const page = boot("?return=search", { port: "4173", hash: "#watch=" + encodeURIComponent(JSON.stringify(snapshot)) });
  assert.equal(page.get("watch-cards").children.length, 1);
  assert.equal(JSON.parse(page.stored("horizon.watch.home.v1")).items[0].type, "movie");
  page.press("ArrowDown"); page.press("ArrowDown"); page.press("OK");
  assert.equal(page.navigations().at(-1), "/universal-search/index.html?mock=1&from=home-local&open=movie&id=550");
});

test("optimized is the default and explicit profile variants remain selectable", () => {
  const page = boot();
  assert.equal(page.document.body.dataset.perfProfile, "optimized");
  assert.equal(page.get("diagnostics").hidden, true);
  const baseline = boot("?perf=baseline");
  assert.equal(baseline.document.body.dataset.perfProfile, "baseline");
  assert.equal(baseline.press("ArrowRight"), "prime-video");
  assert.equal(baseline.press("ArrowLeft"), "horizon-watch");
  const explicitOptimized = boot("?perf=optimized");
  assert.equal(explicitOptimized.document.body.dataset.perfProfile, "optimized");
  const minimal = boot("?perf=minimal");
  assert.equal(minimal.document.body.dataset.perfProfile, "minimal");
  assert.equal(page.press("ArrowRight"), "prime-video");
  assert.equal(page.press("ArrowRight"), "youtube");
  assert.equal(page.press("ArrowLeft"), "prime-video");
  assert.equal(page.press("ArrowLeft"), "horizon-watch");
  assert.equal(page.get("app-grid").children[0].classList.contains("is-focused"), true);
});

test("optimized and minimal profiles keep rapid input, including held repeats", () => {
  for (const profile of ["optimized", "minimal"]) {
    const page = boot(`?perf=${profile}&diagnostics=1`);
    assert.equal(page.document.body.dataset.perfProfile, profile);
    assert.equal(page.press("ArrowRight"), "prime-video");
    assert.equal(page.press("ArrowRight", true), "youtube");
    assert.equal(page.press("ArrowLeft"), "prime-video");
    page.frame();
    assert.match(page.summary(), /multiple keys before frame 1/);
    assert.match(page.summary(), /unexpected focus count 0/);
    const firstIcon = page.get("app-grid").children[0].children[0];
    assert.equal(firstIcon.children.length, profile === "minimal" ? 0 : 1);
  }
});

test("row scrolling, settings, pairing focus, and OK guard remain intact", () => {
  const page = boot("?perf=optimized");
  assert.equal(page.press("ArrowDown"), "spotify");
  assert.equal(page.get("secondary-app-grid").children[0].scrollCalls, 1);
  assert.equal(page.press("ArrowUp"), "horizon-watch");
  assert.equal(page.get("app-grid").children[0].scrollCalls, 1);
  page.press("ArrowUp");
  assert.equal(page.document.activeElement, page.get("settings-open"));
  page.press("OK");
  assert.equal(page.get("settings-screen").hidden, false);
  page.press("ArrowDown");
  page.press("Backspace");
  assert.equal(page.get("settings-screen").hidden, true);
  assert.equal(page.document.activeElement.dataset.id, "horizon-watch");
  page.get("pairing-screen").hidden = false;
  page.get("pairing-retry").focus();
  page.press("ArrowRight");
  assert.equal(page.document.activeElement, page.get("pairing-close"));
  page.press("Backspace");
  assert.equal(page.get("pairing-screen").hidden, true);
  page.press("ArrowRight");
  page.press("ArrowRight");
  page.press("OK");
  page.press("OK");
  assert.equal(page.requests(), 1);
});

test("unavailable optional pairing service does not interrupt Home or authorize native launches", async () => {
  const page = boot("", { protocol: "https:", fetch: async () => new Response("not found", {
    status: 404, headers: { "content-type": "text/plain" }
  }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.get("pairing-screen").hidden, true);
  assert.equal(page.document.activeElement?.id === "pairing-retry", false);
  page.get("app-grid").children[1].focus();
  page.press("OK");
  assert.equal(page.get("pairing-screen").hidden, true);
  assert.match(page.get("notice").textContent, /unavailable/);
});

test("confirmed unpaired session offers a code, but unavailable code service never shows a blank code", async () => {
  const page = boot("", { protocol: "https:", fetch: async path => path === "/api/pair/session"
    ? new Response(JSON.stringify({ state: "unpaired", code: "not_authorized" }), {
      status: 401, headers: { "content-type": "application/json" }
    }) : new Response("offline", { status: 503, headers: { "content-type": "text/plain" } }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.get("pairing-screen").hidden, false);
  assert.equal(page.get("pairing-code").hidden, true);
  assert.match(page.get("pairing-status").textContent, /unavailable/);
});

test("paired session remains usable when optional cookie rotation fails", async () => {
  const page = boot("", { protocol: "https:", fetch: async path => path === "/api/pair/session"
    ? new Response(JSON.stringify({ state: "paired", rotationDue: true }), {
      status: 200, headers: { "content-type": "application/json" }
    }) : new Response(JSON.stringify({ code: "queue_unavailable" }), {
      status: 503, headers: { "content-type": "application/json" }
    }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.get("pairing-screen").hidden, true);
  assert.equal(page.get("app-grid").children[1].dataset.id, "prime-video");
  page.get("app-grid").children[1].focus();
  assert.match(page.get("selection-status").textContent, /Press OK to open/);
});

test("an explicit rotation authorization rejection does not leave the TV marked paired", async () => {
  const page = boot("", { protocol: "https:", fetch: async path => path === "/api/pair/session"
    ? new Response(JSON.stringify({ state: "paired", rotationDue: true }), {
      status: 200, headers: { "content-type": "application/json" }
    }) : new Response(JSON.stringify({ code: "not_authorized" }), {
      status: 401, headers: { "content-type": "application/json" }
    }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.get("pairing-screen").hidden, false);
});

test("upward traversal from bottom apps returns the scroll container fully to the hero", () => {
  const page = boot();
  page.get("home-screen").scrollTop = 640;
  page.press("ArrowDown");
  assert.equal(page.document.activeElement.dataset.id, "spotify");
  page.press("ArrowUp");
  assert.equal(page.document.activeElement.dataset.id, "horizon-watch");
  page.press("ArrowUp");
  assert.equal(page.document.activeElement.id, "settings-open");
  assert.equal(page.get("home-screen").scrollTop, 0);
  page.press("ArrowDown");
  page.get("home-screen").scrollTop = 420;
  page.press("ArrowUp");
  assert.equal(page.get("home-screen").scrollTop, 0);
  const history = { version: 2, items: [{ type: "tv", id: 2190, title: "South Park",
    season: 13, episode: 2, subtitle: "off", at: 100 }] };
  const withWatch = boot("", { storage: { "horizon.watch.home.v1": JSON.stringify(history) } });
  withWatch.press("ArrowDown");
  assert.equal(withWatch.document.activeElement.dataset.watchIndex, "0");
  withWatch.press("ArrowDown");
  assert.equal(withWatch.document.activeElement.dataset.id, "spotify");
  withWatch.get("home-screen").scrollTop = 720;
  withWatch.press("ArrowUp"); withWatch.press("ArrowUp"); withWatch.press("ArrowUp");
  assert.equal(withWatch.document.activeElement.id, "settings-open");
  assert.equal(withWatch.get("home-screen").scrollTop, 0);
});

test("diagnostics are opt-in and tolerate missing timing APIs", () => {
  const page = boot("?perf=unknown");
  assert.equal(page.document.body.dataset.perfProfile, "optimized");
  assert.equal(page.get("diagnostics").hidden, true);
  assert.equal(page.scheduledFrames(), 0);
  const nodes = new Map();
  const panel = { hidden: true, append(node) { this.summary = node; } };
  const window = {};
  const timers = [];
  const sandbox = {
    window, location: { search: "?diagnostics=1" }, Date,
    document: { getElementById: id => id === "diagnostics" ? panel
      : (nodes.has(id) ? nodes.get(id) : nodes.set(id, { textContent: "", className: "" }).get(id)),
      createElement: () => ({ textContent: "", className: "" }) },
    setTimeout: callback => { timers.push(callback); return timers.length; },
    setInterval: () => 1,
  };
  vm.runInNewContext(source("horizon-diagnostics.js"), sandbox);
  const diagnostics = window.HorizonDiagnostics.start("baseline");
  diagnostics.received("ArrowLeft", { repeat: false, timeStamp: 0 }, Date.now());
  diagnostics.handled(Date.now(), true);
  timers.shift()();
  assert.equal(nodes.get("diag-arrival").textContent, "n/a");
  assert.notEqual(nodes.get("diag-frame").textContent, "");
  assert.equal(panel.hidden, false);
  diagnostics.launchStage("ok", "YouTube");
  diagnostics.launchStage("send");
  diagnostics.launchStage("queued", { queuedAt: 1000 });
  diagnostics.launchStage("processing", { claimedAt: 1300 });
  diagnostics.launchStage("terminal", { state: "verified", claimedAt: 1300, finishedAt: 1800 });
  assert.match(panel.summary.textContent, /queue→claim 300 ms \(server\)/);
  assert.match(panel.summary.textContent, /claim→result 500 ms \(server\)/);
  diagnostics.launchStage("ok", "Prime Video");
  diagnostics.launchStage("send");
  diagnostics.launchStage("queued", { queuedAt: 2000 });
  diagnostics.launchStage("terminal", { state: "failed", claimedAt: 1900, finishedAt: 1800 });
  assert.doesNotMatch(panel.summary.textContent, /queue→claim -/);
  assert.doesNotMatch(panel.summary.textContent, /claim→result -/);
});

test("launch timing is visible only in the opt-in diagnostics panel", () => {
  const normal = boot();
  normal.press("ArrowRight"); normal.press("ArrowRight");
  normal.press("OK");
  assert.equal(normal.get("diagnostics").hidden, true);
  const diagnostic = boot("?diagnostics=1");
  diagnostic.press("ArrowRight"); diagnostic.press("ArrowRight");
  diagnostic.press("OK");
  assert.match(diagnostic.get("diagnostics").children[1].textContent, /YouTube: OK→send/);
});
