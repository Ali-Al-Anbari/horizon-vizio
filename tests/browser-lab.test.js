import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const root = new URL("../frontend/", import.meta.url);
const source = name => fs.readFileSync(new URL(name, root), "utf8");

function core() {
  const window = {};
  vm.runInNewContext(source("browser-lab-core.js"), { window, URL });
  return window.HorizonBrowserCore;
}

test("cursor handles every arrow, held repeat, and viewport boundaries", () => {
  const api = core();
  let cursor = { x: 100, y: 100, lastKey: "", lastAt: -1000, streak: 0 };
  cursor = api.moveCursor(cursor, "ArrowLeft", false, 1000, 200, 150);
  assert.equal(cursor.x, 84);
  cursor = api.moveCursor(cursor, "ArrowLeft", false, 1030, 200, 150);
  assert.equal(cursor.x, 68, "two deliberate presses must not accelerate");
  cursor = api.moveCursor(cursor, "ArrowLeft", true, 1060, 200, 150);
  assert.equal(cursor.x, 45);
  cursor = api.moveCursor(cursor, "ArrowLeft", true, 1090, 200, 150);
  assert.equal(cursor.x, 15);
  cursor = api.moveCursor(cursor, "ArrowLeft", true, 1120, 200, 150);
  assert.equal(cursor.x, 12);
  cursor = api.moveCursor(cursor, "ArrowDown", false, 1300, 200, 150);
  assert.equal(cursor.y, 116);
  cursor = api.moveCursor(cursor, "ArrowDown", true, 1330, 200, 150);
  assert.equal(cursor.y, 138);
  cursor = api.moveCursor(cursor, "ArrowDown", true, 1360, 200, 150);
  assert.ok(cursor.edgeY > 0);
  assert.equal(cursor.y, 138);
  assert.equal(api.CURSOR_MOTION.max, 58);
  assert.equal(api.keyName({ key: "Select" }), "OK");
  assert.equal(api.keyName({ key: "BrowserBack" }), "Back");
  assert.equal(api.keyName({ key: "Unidentified", keyCode: 27 }), "Back");
  assert.equal(api.keyName({ key: "Unidentified", keyCode: 38 }), "ArrowUp");
});

test("keyboard arrows, letters, numbers, punctuation, shift, deletion, and enter", () => {
  const api = core();
  assert.deepEqual(JSON.parse(JSON.stringify(api.moveKey({ row: 0, col: 0 }, "ArrowLeft"))), { row: 0, col: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(api.moveKey({ row: 3, col: 9 }, "ArrowDown"))), { row: 4, col: 4 });
  let edit = api.editValue("", "Shift", false);
  edit = api.editValue(edit.value, "a", edit.shifted);
  edit = api.editValue(edit.value, "1", edit.shifted);
  edit = api.editValue(edit.value, ".", edit.shifted);
  assert.equal(edit.value, "A1.");
  edit = api.editValue(edit.value, "Backspace", edit.shifted);
  edit = api.editValue(edit.value, "Space", edit.shifted);
  assert.equal(edit.value, "A1 ");
  assert.equal(api.editValue(edit.value, "Clear", edit.shifted).value, "");
  assert.equal(api.editValue(edit.value, "Enter", edit.shifted).done, true);
});

test("external address accepts HTTPS only and rejects credentials and unsafe schemes", () => {
  const api = core();
  assert.equal(api.httpsAddress("example.com"), "https://example.com/");
  assert.equal(api.httpsAddress("https://example.com/path"), "https://example.com/path");
  for (const value of ["", "http://example.com", "javascript:alert(1)",
                       "data:text/html,hi", "https://user:pass@example.com", "https://"])
    assert.equal(api.httpsAddress(value), null);
});

test("universal address resolver distinguishes domains, HTTPS paths, and Google queries", () => {
  const api = core();
  assert.equal(api.resolveInput("" ).kind, "empty");
  assert.equal(api.resolveInput("google.com").url, "https://google.com/");
  assert.equal(api.resolveInput("https://example.com/path?x=1").url, "https://example.com/path?x=1");
  assert.equal(api.resolveInput("best sci fi movies").url,
               "https://www.google.com/search?q=best%20sci%20fi%20movies");
  assert.equal(api.resolveInput("Interstellar 2014").kind, "search");
  assert.equal(api.resolveInput("Interstellar: 2014").kind, "search");
  assert.equal(api.resolveInput("example.com/find?q=sci fi").url,
               "https://example.com/find?q=sci%20fi");
  assert.equal(api.resolveInput("what is C++?").url,
               "https://www.google.com/search?q=what%20is%20C%2B%2B%3F");
  assert.equal(api.resolveInput("science fiction", "https://search.example/?q=").url,
               "https://search.example/?q=science%20fiction");
  for (const unsafe of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd",
                        "http://example.com", "//example.com", "https://user:pass@example.com",
                        "https://example.com\\@evil.com"])
    assert.equal(api.resolveInput(unsafe).kind, "invalid", unsafe);
});

test("HTTPS parsing has an older-webview anchor fallback when URL is absent", () => {
  const window = {};
  const document = { createElement() {
    const link = {};
    Object.defineProperty(link, "href", { set(value) {
      const parsed = new URL(value);
      link.protocol = parsed.protocol;
      link.hostname = parsed.hostname;
      link.username = parsed.username;
      link.password = parsed.password;
      link._href = parsed.href;
    }, get() { return link._href; } });
    return link;
  } };
  vm.runInNewContext(source("browser-lab-core.js"), { window, document });
  assert.equal(window.HorizonBrowserCore.httpsAddress("example.com"), "https://example.com/");
});

function boot(options = {}) {
  const ids = new Map();
  const handlers = {};
  let now = 1000;
  const navigation = [];
  const scrolls = [];
  const timers = [];
  let hit = null;
  const document = { activeElement: null };

  class Element {
    constructor(id = "", tagName = "DIV") {
      this.id = id;
      this.tagName = tagName;
      this.children = [];
      this.parentNode = null;
      this.listeners = {};
      this.hidden = ["external-frame", "keyboard-panel", "remote-cursor", "cursor-toolbar", "test-options"].includes(id);
      this.value = "";
      this.textContent = "";
      this.style = {};
      this.clientWidth = 700;
      this.clientHeight = 500;
      this.scrollTop = 0;
      this.selectedIndex = 0;
      this.options = [{ text: "Movies" }, { text: "Series" }, { text: "Live TV" }];
      this.classes = new Set();
      this.classList = { add: name => this.classes.add(name),
        remove: name => this.classes.delete(name), contains: name => this.classes.has(name) };
    }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    dispatchEvent(event) { for (const fn of this.listeners[event.type] || []) fn(event); return true; }
    appendChild(child) { this.children.push(child); child.parentNode = this; }
    setAttribute() {}
    removeAttribute(name) { if (name === "src") this.src = ""; }
    getBoundingClientRect() {
      if (this.id === "cursor-toolbar") return { left: 480, top: 0, right: 700, bottom: 65, width: 220, height: 65 };
      return { left: 0, top: 0, right: 180, bottom: 140, width: 180, height: 140 };
    }
    querySelector(selector) {
      if (selector === ".is-selected") {
        const walk = item => item.classes.has("is-selected") ? item
          : item.children.map(walk).find(Boolean);
        return walk(this) || null;
      }
      return null;
    }
    querySelectorAll() { return [get("test-button")]; }
    focus() { document.activeElement = this; this.dispatchEvent({ type: "focus" }); }
    click() { this.dispatchEvent({ type: "click" }); }
    scrollBy(arg) { const top = typeof arg === "number" ? arg : arg.top; this.scrollTop += top; scrolls.push(top); }
  }

  const tags = { address: "INPUT", "test-input": "INPUT", "test-link": "A",
    "test-button": "BUTTON", "test-select": "BUTTON", "test-video": "VIDEO",
    "external-frame": "IFRAME" };
  function get(id) {
    if (!ids.has(id)) {
      const element = new Element(id, tags[id] || "BUTTON");
      if (id === "local-page" && options.noScrollBy) element.scrollBy = undefined;
      if (id === "test-select") element.textContent = "Movies ▾";
      ids.set(id, element);
    }
    return ids.get(id);
  }
  document.getElementById = get;
  document.createElement = tag => new Element("", tag.toUpperCase());
  document.elementFromPoint = options.noElementFromPoint ? undefined : () => hit;
  document.createEvent = () => ({ initEvent(name) { this.type = name; } });
  const window = {
    location: { hostname: "localhost", assign: path => navigation.push(path) },
    addEventListener(name, fn) { handlers[name] = fn; },
  };
  const sandbox = { window, document, URL, Date,
    performance: { now: () => now },
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
    Event: class { constructor(type) { this.type = type; } },
  };
  vm.runInNewContext(source("browser-lab-core.js"), sandbox);
  vm.runInNewContext(source("browser-lab-keyboard.js"), sandbox);
  vm.runInNewContext(source("browser-lab.js"), sandbox);
  return {
    get, window, navigation, scrolls, timers, active: () => document.activeElement,
    hit: id => { hit = get(id); },
    press(key, repeat = false, elapsed = 180) {
      now += elapsed;
      handlers.keydown({ key, repeat, preventDefault() {} });
    },
    noHitApi() { document.elementFromPoint = undefined; },
  };
}

test("toolbar, cursor, local OK activation, dropdown, scroll, and Back", () => {
  const app = boot();
  assert.equal(app.active(), app.get("back-home"));
  app.press("ArrowDown");
  assert.equal(app.get("remote-cursor").hidden, false);
  app.hit("test-button");
  app.press("Enter");
  assert.equal(app.get("button-count").textContent, "1");
  app.press("Enter", true);
  assert.equal(app.get("button-count").textContent, "1");
  app.hit("test-select");
  app.press("Enter");
  assert.equal(app.get("test-options").hidden, false);
  app.press("ArrowDown");
  app.press("Enter");
  assert.equal(app.get("test-select").textContent, "Series ▾");
  for (let i = 0; i < 18; i++) app.press("ArrowDown", true, 40);
  assert.ok(app.scrolls.length > 0);
  app.press("BrowserBack");
  assert.equal(app.get("remote-cursor").hidden, true);
  assert.equal(app.active(), app.get("edit-address"));
  app.press("BrowserBack");
  assert.deepEqual(app.navigation, []);
});

test("remote can leave and reenter cursor mode without losing toolbar access", () => {
  const app = boot();
  app.press("ArrowDown");
  app.press("ArrowRight");
  const beforeExit = app.get("remote-cursor").style.transform;
  app.press("BrowserBack");
  app.press("ArrowDown");
  assert.equal(app.get("remote-cursor").style.transform, beforeExit,
               "mode switching preserves the cursor position");
  app.press("BrowserBack");
  for (let i = 0; i < 3; i++) {
    app.press("ArrowDown");
    assert.equal(app.get("remote-cursor").hidden, false);
    assert.equal(app.get("cursor-toolbar").hidden, false);
    app.press("BrowserBack");
    assert.equal(app.get("remote-cursor").hidden, true);
    assert.equal(app.active(), app.get("edit-address"));
    assert.deepEqual(app.navigation, []);
  }
  app.press("ArrowDown");
  app.hit("cursor-toolbar");
  app.press("Enter");
  assert.equal(app.active(), app.get("edit-address"), "the on-screen escape works without a Back event");
  app.press("BrowserBack");
  assert.deepEqual(app.navigation, [], "remote Back never exits to Horizon");
});

test("custom dropdown opens, navigates, cancels, and restores cursor focus", () => {
  const app = boot();
  app.press("ArrowDown");
  app.hit("test-select");
  app.press("Enter");
  assert.equal(app.get("test-options").hidden, false);
  assert.equal(app.active(), app.get("test-option-movies"));
  app.press("ArrowDown");
  assert.equal(app.active(), app.get("test-option-series"));
  app.press("BrowserBack");
  assert.equal(app.get("test-options").hidden, true);
  assert.equal(app.get("test-select").textContent, "Movies ▾");
  assert.equal(app.active(), app.get("viewer"));
  assert.equal(app.get("remote-cursor").hidden, false);
  app.press("Enter");
  app.press("ArrowDown");
  app.press("ArrowDown");
  app.press("Enter");
  assert.equal(app.get("test-select").textContent, "Live TV ▾");
  assert.equal(app.active(), app.get("viewer"));
  assert.deepEqual(app.navigation, []);
});

test("remote path reaches Edit, submits Google search, and returns to toolbar", () => {
  const app = boot();
  app.press("ArrowDown");
  app.press("BrowserBack");
  assert.equal(app.active(), app.get("edit-address"));
  app.press("Enter");
  assert.equal(app.get("keyboard-panel").hidden, false);
  app.press("Enter"); // q
  app.press("ArrowRight");
  app.press("Enter"); // w
  for (let i = 0; i < 4; i++) app.press("ArrowDown");
  for (let i = 0; i < 3; i++) app.press("ArrowRight");
  app.press("Enter"); // keyboard Enter
  assert.equal(app.get("external-frame").src, "https://www.google.com/search?q=qw");
  assert.equal(app.get("keyboard-panel").hidden, true);
  app.timers.at(-1)();
  assert.equal(app.active(), app.get("address"));
  app.press("ArrowDown");
  app.press("BrowserBack");
  assert.equal(app.active(), app.get("edit-address"));
  assert.deepEqual(app.navigation, []);
});

test("keyboard opens for controlled input, edits preview, then returns to cursor", () => {
  const app = boot();
  app.press("ArrowDown");
  app.hit("test-input");
  app.press("Enter");
  assert.equal(app.get("keyboard-panel").hidden, false);
  assert.equal(app.active(), app.get("keyboard-grid").children[0].children[0]);
  app.press("Enter"); // q
  app.press("ArrowRight");
  app.press("Enter"); // w
  assert.equal(app.get("test-input").value, "qw");
  assert.equal(app.get("keyboard-preview").textContent, "qw");
  app.press("BrowserBack");
  assert.equal(app.get("keyboard-panel").hidden, true);
  assert.equal(app.get("remote-cursor").hidden, false);
  app.press("Enter");
  for (let i = 0; i < 4; i++) app.press("ArrowDown");
  app.press("Enter"); // Shift
  assert.equal(app.get("keyboard-grid").children[4].children[0].classList.contains("is-shifted"), true);
  for (let i = 0; i < 4; i++) app.press("ArrowRight");
  app.press("Enter"); // Keyboard Enter
  assert.equal(app.get("keyboard-panel").hidden, true);
});

test("unsupported hit-test API uses local fallback; invalid iframe URL fails closed", () => {
  const app = boot({ noElementFromPoint: true });
  app.press("ArrowDown");
  app.press("Enter");
  assert.equal(app.get("button-count").textContent, "1");
  app.press("BrowserBack");
  app.get("address").value = "javascript:alert(1)";
  app.get("go-address").click();
  assert.equal(app.get("external-frame").hidden, true);
  assert.match(app.get("lab-status").textContent, /valid HTTPS/);
  app.get("address").value = "https://example.com";
  app.get("go-address").click();
  assert.equal(app.get("external-frame").hidden, false);
  assert.equal(app.get("external-frame").src, "https://example.com/");
  app.timers.at(-1)();
  assert.match(app.get("lab-status").textContent, /No iframe load signal/);
  app.get("external-frame").dispatchEvent({ type: "error" });
  assert.match(app.get("lab-status").textContent, /load error/);
  app.get("external-frame").dispatchEvent({ type: "load" });
  assert.match(app.get("lab-status").textContent, /does not prove/);
  app.get("focus-frame").click();
  assert.equal(app.active(), app.get("external-frame"));
  app.press("BrowserBack");
  assert.equal(app.active(), app.get("focus-frame"));
  app.get("enter-cursor").click();
  app.hit("test-button");
  app.press("Enter");
  assert.match(app.get("lab-status").textContent, /cannot be clicked/);
  assert.equal(app.get("button-count").textContent, "1");
  app.press("BrowserBack");
  app.get("show-local").click();
  assert.equal(app.get("external-frame").hidden, true);
});

test("scroll controls fall back when object-form scrollBy is unsupported", () => {
  const app = boot({ noScrollBy: true });
  app.get("scroll-down").click();
  assert.ok(app.get("local-page").scrollTop > 0);
});

test("local video receives one direct play request from OK", () => {
  const app = boot();
  let plays = 0;
  const video = app.get("test-video");
  video.paused = true;
  video.play = () => { plays++; return Promise.resolve(); };
  app.press("ArrowDown");
  app.hit("test-video");
  app.press("Enter");
  app.press("Enter", true);
  assert.equal(plays, 1);
  assert.match(app.get("lab-status").textContent, /Confirm visible playback/);
});

test("keyboard Enter submits a Google query once and cannot activate Horizon Home", () => {
  const app = boot();
  app.get("address").value = "best sci fi movies";
  app.get("edit-address").click();
  for (let i = 0; i < 4; i++) app.press("ArrowDown");
  for (let i = 0; i < 4; i++) app.press("ArrowRight");
  app.press("Enter");
  assert.equal(app.get("keyboard-panel").hidden, true);
  assert.equal(app.get("external-frame").src,
               "https://www.google.com/search?q=best%20sci%20fi%20movies");
  assert.equal(app.get("embedding-note").hidden, false);
  assert.equal(app.get("loading-indicator").hidden, false);
  app.press("Enter"); // Stray duplicate while focus is being restored.
  assert.deepEqual(app.navigation, []);
  app.timers.at(-1)(); // Finish guarded focus restoration.
  assert.equal(app.active(), app.get("address"));
  assert.equal(app.get("history-label").textContent, "History 2/2 · Horizon-controlled pages only");
  assert.deepEqual(app.navigation, []);
});

test("physical Enter and OK on a filled address submit; empty address does not navigate", () => {
  const app = boot();
  app.get("address").focus();
  app.press("Enter");
  assert.equal(app.get("keyboard-panel").hidden, false);
  assert.deepEqual(app.navigation, []);
  app.press("BrowserBack");
  app.get("address").value = "Interstellar 2014";
  app.press("OK");
  assert.equal(app.get("external-frame").src,
               "https://www.google.com/search?q=Interstellar%202014");
  assert.deepEqual(app.navigation, []);
  app.get("address").value = "https://example.com/path";
  app.press("Enter");
  assert.equal(app.get("external-frame").src, "https://example.com/path");
  assert.deepEqual(app.navigation, []);
});

test("controlled Back, Forward, Refresh, Browser Home, and explicit Horizon exit", () => {
  const app = boot();
  app.get("address").value = "google.com";
  app.get("go-address").click();
  app.get("address").value = "example.com";
  app.get("go-address").click();
  assert.equal(app.get("history-label").textContent, "History 3/3 · Horizon-controlled pages only");
  app.get("nav-back").click();
  assert.equal(app.get("address").value, "https://google.com/");
  app.get("nav-forward").click();
  assert.equal(app.get("address").value, "https://example.com/");
  app.get("nav-refresh").click();
  assert.equal(app.get("history-label").textContent, "History 3/3 · Horizon-controlled pages only");
  app.get("show-local").click();
  assert.equal(app.get("local-page").hidden, false);
  assert.equal(app.get("address").value, "");
  app.press("BrowserBack");
  assert.equal(app.get("address").value, "https://example.com/");
  app.get("nav-back").click();
  assert.equal(app.get("address").value, "https://google.com/");
  app.get("nav-forward").click();
  assert.equal(app.get("address").value, "https://example.com/");
  assert.deepEqual(app.navigation, []);
  app.get("back-home").click();
  assert.deepEqual(app.navigation, ["./"]);
});

test("unsafe address is rejected and direct navigation needs deliberate confirmation", () => {
  const app = boot();
  app.get("address").value = "javascript:alert(1)";
  app.get("go-address").click();
  assert.equal(app.get("external-frame").hidden, true);
  assert.equal(app.get("history-label").textContent, "History 1/1 · Horizon-controlled pages only");
  app.get("address").value = "https://example.com";
  app.get("go-address").click();
  app.get("direct-open").click();
  assert.equal(app.get("direct-confirm").hidden, false);
  app.press("BrowserBack"); // Back closes transient confirmation first.
  assert.equal(app.get("direct-confirm").hidden, true);
  app.get("direct-open").click();
  app.press("Enter"); // Cancel is the initial choice.
  assert.deepEqual(app.navigation, []);
  app.get("direct-open").click();
  app.press("ArrowRight");
  app.press("Enter");
  assert.deepEqual(app.navigation, ["https://example.com/"]);
});

test("browser lab remains a separate static page and production home keeps its Browser panel", () => {
  const lab = source("browser-lab.html");
  const home = source("index.html");
  assert.match(lab, /id="external-frame"/);
  assert.match(lab, /id="keyboard-panel"/);
  assert.match(lab, /frame-src 'self' https:/);
  assert.match(lab, /sandbox="allow-scripts allow-forms"/);
  assert.match(home, /Browser coming soon/);
  assert.match(home, /frame-src 'none'/);
});
