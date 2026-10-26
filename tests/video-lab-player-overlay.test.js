import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("../video-lab/player-overlay.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../video-lab/player-overlay.css", import.meta.url), "utf8");
const leaseScript = readFileSync(new URL("../video-lab/focus-lease.js", import.meta.url), "utf8");
const playerScript = readFileSync(new URL("../video-lab/player-overlay.js", import.meta.url), "utf8");
const ids = ["player-frame", "remote-capture", "overlay", "rewind", "play-pause", "forward", "subtitles",
  "episodes", "subtitle-menu", "subtitle-mode", "menu-title", "menu-description", "menu-cancel", "menu-change",
  "command-status", "screen-reader-status"];
const baseUrl = "https://yapgrid.com/embed/tv/2190/13/2";
const previewOrigin = "https://horizon-video-lab-preview.ali-al-anbari.workers.dev";

function setup({ search = "?sub=on", adapter = null, animationFrame = true } = {}) {
  const nodes = new Map();
  const documentEvents = {};
  const windowEvents = {};
  const timers = new Map();
  const navigation = [];
  let time = 0;
  let nextTimer = 1;
  const document = {
    activeElement: null,
    getElementById(id) { return nodes.get(id); },
    addEventListener(name, handler) { (documentEvents[name] ||= []).push(handler); },
  };
  function emit(handlers, name, event = {}) { for (const handler of handlers[name] || []) handler(event); }
  function node(id) {
    const handlers = {};
    const attributes = {};
    const classes = new Set();
    let source = "";
    const element = {
      id, hidden: id === "subtitle-menu", textContent: "", tabIndex: -1, sourceChanges: 0,
      attributes,
      classList: {
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); },
        contains(name) { return classes.has(name); },
      },
      get src() { return source; },
      set src(value) { source = String(value); element.sourceChanges += 1; },
      setAttribute(name, value) { attributes[name] = String(value); },
      addEventListener(name, handler) { (handlers[name] ||= []).push(handler); },
      focus() { document.activeElement = element; emit(handlers, "focus", { target: element }); },
      click() { emit(handlers, "click", { target: element }); },
    };
    return element;
  }
  for (const id of ids) nodes.set(id, node(id));
  const window = {
    performance: { now() { return time; } },
    addEventListener(name, handler) { (windowEvents[name] ||= []).push(handler); },
    setTimeout(handler, delay) {
      const id = nextTimer++;
      timers.set(id, { handler, due: time + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  if (animationFrame) {
    window.requestAnimationFrame = handler => window.setTimeout(handler, 16);
    window.cancelAnimationFrame = id => window.clearTimeout(id);
  }
  const location = { search, origin: previewOrigin, replace(path) { navigation.push(path); } };
  runInNewContext(leaseScript, { window });
  runInNewContext(playerScript, { window });
  const player = window.HorizonPlayerOverlay.createPlayer(document, location, window,
    adapter ? { commandAdapter: adapter } : undefined);
  // The script auto-initializes in a browser. In this harness, its exported
  // creator is called explicitly because the VM context has no global document.
  return {
    get: id => nodes.get(id), document, navigation, timers, player,
    state() { return player.getState(); },
    key(name, repeat = false) {
      if (document.activeElement === nodes.get("player-frame")) return { delivered: false };
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
        timers.delete(next[0]);
        next[1].handler();
      }
      time = end;
    },
    pagehide() { emit(windowEvents, "pagehide"); },
  };
}

test("preview has no persistent overlay, fake progress, or browser credentials", () => {
  assert.match(html, /id="overlay"[^>]*aria-hidden="true"/);
  assert.match(css, /\.overlay \{[^}]*opacity: 0; visibility: hidden; pointer-events: none/);
  assert.doesNotMatch(html, /<progress|currentTime|duration/);
  assert.doesNotMatch(playerScript, /contentDocument|contentWindow|AUTH_TOKEN|key_command|fetch\(/);
  assert.match(html, /frame-src https:\/\/yapgrid\.com/);
});

test("each first arrow or OK reveals controls without moving selection or sending a command", () => {
  for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"]) {
    const app = setup();
    const initial = app.get("player-frame").src;
    assert.equal(app.state(), "PLAYBACK_HIDDEN");
    assert.equal(app.document.activeElement.id, "remote-capture");
    app.key(key);
    assert.equal(app.state(), "CONTROLS_VISIBLE", key);
    assert.equal(app.document.activeElement.id, "play-pause", key);
    assert.equal(app.get("overlay").classList.contains("is-visible"), true);
    assert.match(app.get("command-status").textContent, /bridge is connected/);
    assert.equal(app.get("player-frame").src, initial);
    assert.equal(app.get("player-frame").sourceChanges, 1);
    assert.equal(app.timers.size, 1); // Only the five-second idle timer.
  }
});

test("visible controls navigate by row and the idle timer resets on every direction", () => {
  const app = setup();
  app.key("ArrowLeft"); // reveal only
  app.advance(4000);
  app.key("ArrowRight");
  assert.equal(app.document.activeElement.id, "forward");
  app.advance(4000);
  assert.equal(app.state(), "CONTROLS_VISIBLE");
  app.key("ArrowDown");
  assert.equal(app.document.activeElement.id, "episodes");
  app.key("ArrowLeft");
  assert.equal(app.document.activeElement.id, "subtitles");
  app.key("ArrowUp");
  assert.equal(app.document.activeElement.id, "play-pause");
  app.advance(4999);
  assert.equal(app.state(), "CONTROLS_VISIBLE");
  app.advance(1);
  assert.equal(app.state(), "PLAYBACK_HIDDEN");
  assert.equal(app.document.activeElement.id, "remote-capture");
  assert.equal(app.get("overlay").classList.contains("is-visible"), false);
  assert.equal(app.get("player-frame").sourceChanges, 1);
});

test("Back hides visible controls, then exits from hidden playback", () => {
  const app = setup();
  app.key("Enter");
  app.key("Backspace");
  assert.equal(app.state(), "PLAYBACK_HIDDEN");
  assert.deepEqual(app.navigation, []);
  app.key("Backspace");
  assert.deepEqual(app.navigation, ["embed-matrix.html"]);
});

test("without a secure bridge, playback controls never hand focus away or send a key", () => {
  const app = setup();
  app.key("Enter"); // reveal
  app.key("Enter"); // request Play/Pause
  assert.equal(app.state(), "CONTROLS_VISIBLE");
  assert.equal(app.document.activeElement.id, "play-pause");
  assert.match(app.get("command-status").textContent, /No key was sent or focus transferred/);
  assert.equal(app.timers.size, 1); // Five-second hide only.
  assert.equal(app.get("player-frame").sourceChanges, 1);
  app.advance(5000);
  assert.equal(app.state(), "PLAYBACK_HIDDEN");
});

test("handoff retries the selected visible control if focus slips back to the iframe", () => {
  const app = setup({ adapter: { send() { return new Promise(() => {}); } } });
  app.key("Enter");
  app.key("ArrowLeft");
  assert.equal(app.document.activeElement.id, "rewind");
  app.key("Enter");
  app.advance(3000);
  assert.equal(app.document.activeElement.id, "rewind");
  app.get("player-frame").focus();
  app.advance(250);
  assert.equal(app.document.activeElement.id, "rewind");
  assert.equal(app.state(), "CONTROLS_VISIBLE");
});

test("repeated seeks run sequentially when the adapter acknowledges delivery", async () => {
  const calls = [];
  const app = setup({ adapter: { send(command) {
    calls.push(command);
    return Promise.resolve({ accepted: true });
  } } });
  app.key("Enter");
  app.key("ArrowRight");
  assert.equal(app.document.activeElement.id, "forward");
  app.key("Enter");
  assert.equal(app.state(), "COMMAND_IN_PROGRESS");
  app.advance(16);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.state(), "CONTROLS_VISIBLE");
  app.key("Enter");
  assert.equal(app.state(), "COMMAND_IN_PROGRESS");
  app.advance(16);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.state(), "CONTROLS_VISIBLE");
  assert.deepEqual(calls, ["seek_forward", "seek_forward"]);
  assert.equal(app.get("player-frame").sourceChanges, 1);
});

test("subtitle ON/OFF URLs match existing launch modes and switching requires confirmation", () => {
  const on = setup();
  assert.equal(on.get("player-frame").src, baseUrl + "?lang=en");
  on.key("Enter");
  on.key("ArrowDown");
  on.key("Enter");
  assert.equal(on.state(), "SUBMENU_OPEN");
  on.advance(20000); // Menu suspends auto-hide.
  assert.equal(on.state(), "SUBMENU_OPEN");
  on.key("ArrowRight");
  on.key("Enter");
  assert.match(on.get("menu-title").textContent, /Reload video from the beginning/);
  assert.equal(on.get("player-frame").sourceChanges, 1);
  assert.deepEqual(on.navigation, []);
  on.key("Backspace");
  assert.equal(on.state(), "CONTROLS_VISIBLE");
  assert.deepEqual(on.navigation, []);

  const off = setup({ search: "?sub=off" });
  assert.equal(off.get("player-frame").src, baseUrl + "?sub_url="
    + encodeURIComponent(previewOrigin + "/empty.vtt") + "&sub_lang=en&sub_label=Off");
  assert.equal(off.get("subtitle-mode").textContent, "OFF");
  off.key("Enter");
  off.key("ArrowDown");
  off.key("Enter");
  off.key("ArrowRight");
  off.key("Enter");
  off.key("ArrowRight");
  off.key("Enter");
  assert.deepEqual(off.navigation, ["player-overlay.html?sub=on"]);
});

test("mock adapter waits for a focus turn, reports acceptance without claiming playback, and restores", async () => {
  const calls = [];
  const app = setup({ adapter: { send(command) { calls.push(command); return Promise.resolve({ accepted: true }); } } });
  app.key("Enter");
  app.key("Enter");
  assert.equal(calls.length, 0);
  app.advance(16);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["pause_toggle"]);
  assert.equal(app.state(), "CONTROLS_VISIBLE");
  assert.equal(app.document.activeElement.id, "play-pause");
  assert.match(app.get("command-status").textContent, /acknowledged.*unverified/);
  assert.equal(app.get("player-frame").sourceChanges, 1);
});

test("missing frame focus fails closed before a mock adapter dispatch; pagehide clears timers", () => {
  const calls = [];
  const app = setup({ adapter: { send(command) { calls.push(command); return Promise.resolve({ accepted: true }); } } });
  app.key("Enter");
  app.key("Enter");
  app.get("remote-capture").focus(); // Simulate the iframe refusing to retain focus.
  app.advance(16);
  assert.deepEqual(calls, []);
  assert.equal(app.state(), "CONTROLS_VISIBLE");
  assert.match(app.get("command-status").textContent, /no command was sent/i);
  app.pagehide();
  assert.equal(app.timers.size, 0);
});

test("slow mock controller is not sent duplicate commands and late acceptance is ignored", async () => {
  const calls = [];
  let resolveCommand;
  const app = setup({ adapter: { send(command) {
    calls.push(command);
    return new Promise(resolve => { resolveCommand = resolve; });
  } } });
  app.key("Enter");
  app.key("Enter");
  app.advance(16);
  assert.deepEqual(calls, ["pause_toggle"]);
  app.player.onKey({ key: "Enter", repeat: false, preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(calls, ["pause_toggle"]);
  app.advance(2984);
  assert.equal(app.state(), "CONTROLS_VISIBLE");
  assert.match(app.get("command-status").textContent, /outcome is unknown/);
  resolveCommand({ accepted: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(app.get("command-status").textContent, /Controller accepted/);
  assert.equal(app.get("player-frame").sourceChanges, 1);
});

test("Home is left to Vizio and the adapter fallback works without requestAnimationFrame", async () => {
  const calls = [];
  const app = setup({ animationFrame: false, adapter: { send(command) {
    calls.push(command);
    return Promise.resolve({ accepted: true });
  } } });
  assert.equal(app.key("Home").prevented, false);
  app.key("Enter");
  app.key("Enter");
  app.advance(0);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["pause_toggle"]);
  assert.equal(app.state(), "CONTROLS_VISIBLE");
});

test("visible controls open and renew via adapter; hide and unload close without reloading iframe", async () => {
  let opens = 0;
  let closes = 0;
  const app = setup({ adapter: {
    open() { opens++; return Promise.resolve(); },
    close() { closes++; },
    dispose() { closes++; },
    send() { throw Error("no command expected"); },
  } });
  app.key("ArrowUp");
  assert.equal(opens, 1);
  app.advance(5000);
  assert.equal(closes, 1);
  app.key("ArrowDown");
  assert.equal(opens, 2);
  app.pagehide();
  assert.equal(closes, 2);
  assert.equal(app.get("player-frame").sourceChanges, 1);
});

test("cold command waits for readiness before focus or delivery", async () => {
  let ready;
  const calls = [];
  const app = setup({ adapter: {
    open() { return new Promise(resolve => { ready = resolve; }); },
    ready() { return new Promise(resolve => { ready = resolve; }); },
    send(command) { calls.push(command); return Promise.resolve({ accepted: true }); },
    close() {},
  } });
  app.key("Enter");
  app.key("Enter");
  assert.equal(app.state(), "COMMAND_IN_PROGRESS");
  assert.equal(app.document.activeElement.id, "play-pause");
  assert.deepEqual(calls, []);
  ready();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.document.activeElement.id, "player-frame");
  app.advance(16);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["pause_toggle"]);
  assert.equal(app.document.activeElement.id, "play-pause");
});

test("failed cold preparation leaves Horizon focus and never sends a key", async () => {
  let rejectReady;
  let sent = 0;
  const app = setup({ adapter: {
    open() { return Promise.resolve(); },
    ready() { return new Promise((_resolve, reject) => { rejectReady = reject; }); },
    send() { sent++; }, close() {},
  } });
  app.key("Enter");
  app.key("Enter");
  rejectReady(Error("offline"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.state(), "CONTROLS_VISIBLE");
  assert.equal(app.document.activeElement.id, "play-pause");
  assert.equal(sent, 0);
});

test("deliberate repeated seek presses during preparation queue in order", async () => {
  let resolveReady;
  let prepared = false;
  const calls = [];
  const app = setup({ adapter: {
    open() { return Promise.resolve(); },
    ready() { return prepared ? Promise.resolve() : new Promise(resolve => { resolveReady = resolve; }); },
    send(command) { calls.push(command); return Promise.resolve({ accepted: true }); },
    close() {},
  } });
  app.key("Enter");
  app.key("ArrowRight");
  app.key("Enter");
  app.key("Enter");
  app.key("Enter");
  assert.equal(app.document.activeElement.id, "forward");
  assert.equal(calls.length, 0);
  prepared = true;
  resolveReady();
  for (let i = 0; i < 3; i++) {
    await new Promise(resolve => setImmediate(resolve));
    app.advance(16);
    await new Promise(resolve => setImmediate(resolve));
    app.advance(0);
  }
  assert.deepEqual(calls, ["seek_forward", "seek_forward", "seek_forward"]);
  assert.equal(app.get("player-frame").sourceChanges, 1);
});
