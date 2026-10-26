import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("../video-lab/focus-switch.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../video-lab/focus-switch.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../video-lab/focus-switch.css", import.meta.url), "utf8");
const source = "https://yapgrid.com/embed/tv/2190/13/2";
const ids = ["player", "focus-parent", "focus-child", "arm", "restore", "window", "focus-target", "exit",
  "state", "countdown", "focus-report", "ok-count", "events"];

function setup() {
  const nodes = new Map();
  const documentEvents = {};
  const windowEvents = {};
  const timers = new Map();
  const navigation = [];
  let time = 0;
  let nextTimer = 1;
  const document = {
    activeElement: null,
    hasFocus() { return true; },
    getElementById(id) { return nodes.get(id); },
    addEventListener(name, handler) { (documentEvents[name] ||= []).push(handler); },
  };
  function emit(handlers, name, event) {
    for (const handler of handlers[name] || []) handler(event);
  }
  function node(id) {
    const handlers = {};
    return {
      id, textContent: "", tabIndex: id === "player" ? -1 : 0,
      src: id === "player" ? source : undefined,
      addEventListener(name, handler) { (handlers[name] ||= []).push(handler); },
      focus() {
        const old = document.activeElement;
        if (old && old !== this) emit(documentEvents, "focusout", { target: old });
        document.activeElement = this;
        emit(handlers, "focus", { target: this });
        emit(documentEvents, "focusin", { target: this });
      },
      click() { emit(handlers, "click", { target: this }); },
      dispatch(name) { emit(handlers, name, { target: this }); },
    };
  }
  for (const id of ids) nodes.set(id, node(id));
  const window = {
    performance: { now() { return time; } },
    addEventListener(name, handler) { (windowEvents[name] ||= []).push(handler); },
    setTimeout(handler, delay) {
      const id = nextTimer++;
      timers.set(id, { handler, due: time + delay, period: 0 });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval(handler, period) {
      const id = nextTimer++;
      timers.set(id, { handler, due: time + period, period });
      return id;
    },
    clearInterval(id) { timers.delete(id); },
  };
  const location = { replace(path) { navigation.push(path); } };
  runInNewContext(script, { window, document, location });
  return {
    get: id => nodes.get(id), document, timers, navigation,
    key(name, repeat = false) {
      // A focused child document does not dispatch its key events to the parent.
      if (document.activeElement === nodes.get("player")) return { delivered: false };
      const event = { key: name, repeat, prevented: false,
        preventDefault() { this.prevented = true; }, stopPropagation() {} };
      emit(documentEvents, "keydown", event);
      return { delivered: true, prevented: event.prevented };
    },
    advance(milliseconds) {
      const end = time + milliseconds;
      while (true) {
        const next = [...timers.entries()].sort((a, b) => a[1].due - b[1].due)[0];
        if (!next || next[1].due > end) break;
        time = next[1].due;
        if (next[1].period) next[1].due += next[1].period;
        else timers.delete(next[0]);
        next[1].handler();
      }
      time = end;
    },
    fireWindow(name) { emit(windowEvents, name, {}); },
  };
}

test("focus-switch page is isolated and never reads or changes the child document", () => {
  assert.match(html, /frame-src https:\/\/yapgrid\.com/);
  assert.match(html, /src="https:\/\/yapgrid\.com\/embed\/tv\/2190\/13\/2"/);
  assert.match(html, /id="focus-target"/);
  assert.match(css, /#player \{ position: absolute/);
  assert.doesNotMatch(script, /contentDocument|contentWindow|postMessage|key_command|auth.token/i);
});

test("parent starts focused, arm transfers for ten seconds, then restores without reloading", () => {
  const app = setup();
  assert.equal(app.document.activeElement.id, "arm");
  const player = app.get("player");
  assert.equal(app.key("Enter").delivered, true);
  assert.equal(app.document.activeElement, player);
  assert.equal(player.tabIndex, 0);
  assert.match(app.get("focus-report").textContent, /activeElement=player;.*requested=YapGrid/);
  assert.equal(app.key("Backspace").delivered, false);
  app.advance(9500);
  assert.equal(app.document.activeElement, player);
  app.advance(500);
  assert.equal(app.document.activeElement.id, "focus-target");
  assert.equal(player.tabIndex, -1);
  assert.equal(player.src, source);
  assert.match(app.get("state").textContent, /Press OK on the highlighted target/);
  app.key("Enter");
  assert.match(app.get("ok-count").textContent, /: 1$/);
  app.advance(250);
  assert.equal(app.timers.size, 0);
});

test("short focus and manual restore remain bounded", () => {
  const app = setup();
  app.get("focus-child").click();
  assert.equal(app.document.activeElement.id, "player");
  app.get("restore").click();
  assert.equal(app.document.activeElement.id, "focus-target");
  app.advance(3250);
  assert.equal(app.timers.size, 0);
  assert.equal(app.get("player").src, source);
});

test("overlapping arm requests are ignored and repeated cycles do not accumulate timers", () => {
  const app = setup();
  for (let count = 1; count <= 4; count++) {
    app.get("arm").click();
    const scheduled = app.timers.size;
    app.get("arm").click();
    assert.equal(app.timers.size, scheduled);
    app.advance(10000);
    app.key("OK");
    assert.match(app.get("ok-count").textContent, new RegExp(": " + count + "$"));
    app.advance(250);
    assert.equal(app.timers.size, 0);
  }
  assert.equal(app.get("player").src, source);
});

test("remote navigation, configurable window, held OK, and Back work when parent receives keys", () => {
  const app = setup();
  app.key("ArrowRight");
  assert.equal(app.document.activeElement.id, "restore");
  app.key("ArrowRight");
  assert.equal(app.document.activeElement.id, "window");
  app.key("Enter");
  assert.equal(app.get("window").textContent, "Window: 15 s");
  app.key("Enter", true);
  assert.equal(app.get("window").textContent, "Window: 15 s");
  app.get("arm").click();
  app.advance(10000);
  assert.equal(app.document.activeElement.id, "player");
  app.advance(5000);
  assert.equal(app.document.activeElement.id, "focus-target");
  app.key("Backspace");
  assert.deepEqual(app.navigation, ["embed-matrix.html"]);
});

test("pagehide clears timers and parent event log stays bounded", () => {
  const app = setup();
  for (let n = 0; n < 30; n++) app.key("ArrowLeft");
  assert.ok(app.get("events").textContent.split(" | ").length <= 12);
  app.get("arm").click();
  app.fireWindow("pagehide");
  assert.equal(app.timers.size, 0);
  app.advance(15000);
  assert.equal(app.document.activeElement.id, "player");
});

test("manual sequential trial can arm a bounded 30-second iframe window", () => {
  const app = setup();
  app.get("window").click(); // 10 -> 15
  app.get("window").click(); // 15 -> 30
  assert.equal(app.get("window").textContent, "Window: 30 s");
  app.get("arm").click();
  app.advance(29999);
  assert.equal(app.document.activeElement.id, "player");
  app.advance(1);
  assert.equal(app.document.activeElement.id, "focus-target");
});
