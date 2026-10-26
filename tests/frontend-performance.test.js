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
      this.scrollTop = 0;
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
    replaceChildren() { this.children = []; }
    setAttribute() {}
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
  const rows = Array.from({ length: 4 }, (_, index) => {
    const row = new Element();
    row.dataset.setting = ["wallpaper", "slideshow", "accent", "arrangement"][index];
    return row;
  });
  document.querySelectorAll = selector => selector === ".setting-row" ? rows
    : selector === ".wallpaper-layer" ? [new Element(), new Element()] : [];
  document.querySelector = selector => get(selector);

  const location = { protocol: "http:", port: "8765", hostname: "localhost", search };
  const window = {
    innerWidth: 1920, innerHeight: 1080,
    addEventListener(name, callback) { listeners[name] = callback; },
  };
  const sandbox = {
    window, document, location, console, Intl, Date,
    performance: { now: () => elapsed },
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
    setInterval: callback => { intervals.push(callback); return intervals.length; },
    setTimeout: () => 1, clearTimeout() {},
    localStorage: { getItem: () => null, setItem() {} },
    fetch: () => { requests++; return new Promise(() => {}); },
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
  };
}

test("optimized is the default and explicit profile variants remain selectable", () => {
  const page = boot();
  assert.equal(page.document.body.dataset.perfProfile, "optimized");
  assert.equal(page.get("diagnostics").hidden, true);
  const baseline = boot("?perf=baseline");
  assert.equal(baseline.document.body.dataset.perfProfile, "baseline");
  assert.equal(baseline.press("ArrowRight"), "plex");
  assert.equal(baseline.press("ArrowLeft"), "youtube");
  const explicitOptimized = boot("?perf=optimized");
  assert.equal(explicitOptimized.document.body.dataset.perfProfile, "optimized");
  const minimal = boot("?perf=minimal");
  assert.equal(minimal.document.body.dataset.perfProfile, "minimal");
  assert.equal(page.press("ArrowRight"), "plex");
  assert.equal(page.press("ArrowRight"), "prime-video");
  assert.equal(page.press("ArrowLeft"), "plex");
  assert.equal(page.press("ArrowLeft"), "youtube");
  assert.equal(page.get("app-grid").children[0].classList.contains("is-focused"), true);
});

test("optimized and minimal profiles keep rapid input, including held repeats", () => {
  for (const profile of ["optimized", "minimal"]) {
    const page = boot(`?perf=${profile}&diagnostics=1`);
    assert.equal(page.document.body.dataset.perfProfile, profile);
    assert.equal(page.press("ArrowRight"), "plex");
    assert.equal(page.press("ArrowRight", true), "prime-video");
    assert.equal(page.press("ArrowLeft"), "plex");
    page.frame();
    assert.match(page.summary(), /multiple keys before frame 1/);
    assert.match(page.summary(), /unexpected focus count 0/);
    const firstIcon = page.get("app-grid").children[0].children[0];
    assert.equal(firstIcon.children.length, profile === "minimal" ? 0 : 1);
  }
});

test("row scrolling, settings, pairing focus, and OK guard remain intact", () => {
  const page = boot("?perf=optimized");
  assert.equal(page.press("ArrowDown"), "netflix");
  assert.equal(page.get("home-screen").scrollTop, Math.round(1080 * .43));
  assert.equal(page.press("ArrowUp"), "youtube");
  assert.equal(page.get("home-screen").scrollTop, 0);
  page.press("ArrowUp");
  assert.equal(page.document.activeElement, page.get("settings-open"));
  page.press("OK");
  assert.equal(page.get("settings-screen").hidden, false);
  page.press("ArrowDown");
  page.press("Backspace");
  assert.equal(page.get("settings-screen").hidden, true);
  assert.equal(page.document.activeElement.dataset.id, "youtube");
  page.get("pairing-screen").hidden = false;
  page.get("pairing-retry").focus();
  page.press("ArrowRight");
  assert.equal(page.document.activeElement, page.get("pairing-close"));
  page.press("Backspace");
  assert.equal(page.get("pairing-screen").hidden, true);
  page.press("OK");
  page.press("OK");
  assert.equal(page.requests(), 1);
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
  normal.press("OK");
  assert.equal(normal.get("diagnostics").hidden, true);
  const diagnostic = boot("?diagnostics=1");
  diagnostic.press("OK");
  assert.match(diagnostic.get("diagnostics").children[1].textContent, /YouTube: OK→send/);
});
