import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("../video-lab/player-overlay.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../video-lab/player-overlay.css", import.meta.url), "utf8");
const leaseScript = readFileSync(new URL("../video-lab/focus-lease.js", import.meta.url), "utf8");
const catalogScript = readFileSync(new URL("../video-lab/episode-catalog.js", import.meta.url), "utf8");
const listHtml = readFileSync(new URL("../video-lab/episode-list-placeholder.html", import.meta.url), "utf8");
const listScript = readFileSync(new URL("../video-lab/episode-list-placeholder.js", import.meta.url), "utf8");
const playerScript = readFileSync(new URL("../video-lab/player-overlay.js", import.meta.url), "utf8");
const ids = ["player-frame", "remote-capture", "overlay", "rewind", "rewind-label", "play-pause", "forward", "forward-label", "subtitles",
  "episodes", "previous-episode", "next-episode", "manual-end", "episode-caption", "up-next", "up-next-title", "up-next-countdown", "up-next-play", "up-next-cancel",
  "subtitle-menu", "subtitle-mode", "menu-title", "menu-description", "menu-cancel", "menu-change",
  "command-status", "screen-reader-status"];
const baseUrl = "https://yapgrid.com/embed/tv/2190/13/2";
const previewOrigin = "https://horizon-video-lab-preview.ali-al-anbari.workers.dev";

function fixtureResolver() {
  const episodes = catalog();
  const titles = ["The Ring", "The Coon", "Margaritaville"];
  const rows = Array.from({ length: 14 }, (_, index) => ({ season: 13, number: index + 1,
    title: titles[index] || (index === 13 ? "Pee" : "Episode " + (index + 1)) }));
  return { current(item) { const found = rows.find(row => row.season === item.season && row.number === item.episode);
      return Promise.resolve(found ? episodes.episode(found.season, found.number, found.title) : null); },
    resolve(item, direction) { return Promise.resolve(episodes.resolveFromRows(rows, item, direction)); } };
}

function setup({ search = "?sub=on", adapter = null, animationFrame = true, episodeResolver = fixtureResolver() } = {}) {
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
      id, hidden: id === "subtitle-menu" || id === "up-next" || id === "manual-end", textContent: "", tabIndex: -1, sourceChanges: 0,
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
  runInNewContext(catalogScript, { window });
  runInNewContext(playerScript, { window });
  const player = window.HorizonPlayerOverlay.createPlayer(document, location, window,
    { commandAdapter: adapter, episodeResolver });
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
    keyup(name) {
      const event = { key: name, prevented: false,
        preventDefault() { this.prevented = true; }, stopPropagation() {} };
      emit(documentEvents, "keyup", event);
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
    message(data, origin = "https://yapgrid.com") { emit(windowEvents, "message", { data, origin }); },
  };
}

function catalog() {
  const window = {};
  runInNewContext(catalogScript, { window });
  return window.HorizonEpisodes;
}

test("preview has no persistent overlay, fake progress, or browser credentials", () => {
  assert.match(html, /id="overlay"[^>]*aria-hidden="true"/);
  assert.match(css, /\.overlay \{[^}]*opacity: 0; visibility: hidden; pointer-events: none/);
  assert.doesNotMatch(html, /<progress|currentTime|duration/);
  assert.doesNotMatch(playerScript, /contentDocument|contentWindow|AUTH_TOKEN|key_command|fetch\(/);
  assert.match(html, /frame-src https:\/\/yapgrid\.com/);
});

test("each first arrow reveals controls without moving selection or sending a command", () => {
  for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
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

test("one hidden OK reveals controls and dispatches one pause toggle, then restores Play/Pause focus", async () => {
  const calls = [];
  const app = setup({ adapter: { send(command) {
    calls.push(command);
    return Promise.resolve({ accepted: true });
  } } });
  app.key("Enter");
  assert.equal(app.state(), "COMMAND_IN_PROGRESS");
  assert.equal(app.get("overlay").classList.contains("is-visible"), true);
  assert.equal(app.document.activeElement.id, "player-frame");
  assert.deepEqual(calls, []);
  app.keyup("Enter");
  app.key("Enter", true);
  app.advance(16);
  await flush();
  assert.deepEqual(calls, ["pause_toggle"]);
  assert.equal(app.state(), "CONTROLS_VISIBLE");
  assert.equal(app.document.activeElement.id, "play-pause");
  assert.match(app.get("command-status").textContent, /playback effect is unverified/);

  app.player.onKey({ key: "Enter", repeat: true, preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(calls, ["pause_toggle"]);
  app.key("Enter");
  app.advance(16);
  await flush();
  assert.deepEqual(calls, ["pause_toggle", "pause_toggle"]);
  assert.equal(app.document.activeElement.id, "play-pause");
});

test("Quick Pause displays controls immediately and records readiness, reply and focus stages", async () => {
  let ready;
  let reply;
  const sent = [];
  const app = setup({ adapter: {
    open: () => Promise.resolve(),
    ready: () => new Promise(resolve => { ready = resolve; }),
    send(command) { sent.push(command); return new Promise(resolve => { reply = resolve; }); },
    close() {},
  } });
  app.key("Enter");
  assert.equal(app.get("overlay").classList.contains("is-visible"), true);
  assert.equal(app.get("overlay").classList.contains("is-quick-pause"), true);
  assert.match(css, /\.overlay\.is-visible\.is-quick-pause \{ transition: none; \}/);
  assert.equal(app.document.activeElement.id, "play-pause");
  assert.deepEqual(sent, []);
  app.advance(400);
  ready();
  await flush();
  assert.equal(app.document.activeElement.id, "player-frame");
  app.advance(16);
  await flush();
  assert.deepEqual(sent, ["pause_toggle"]);
  app.advance(120);
  reply({ accepted: true });
  await flush();
  const timing = app.player.getLastPauseTiming();
  assert.equal(timing.hidden, true);
  assert.equal(timing.overlayAt - timing.inputAt, 0);
  assert.equal(timing.readyAt - timing.inputAt, 400);
  assert.equal(timing.dispatchedAt - timing.inputAt, 416);
  assert.equal(timing.replyAt - timing.inputAt, 536);
  assert.equal(timing.restoredAt - timing.inputAt, 536);
  assert.match(app.get("command-status").textContent, /playback effect is unverified.*Quick Pause: bar 0 ms; ready 400 ms; reply 536 ms; focus 536 ms/);
  assert.equal(app.document.activeElement.id, "play-pause");
  app.advance(5000);
  assert.equal(app.state(), "PLAYBACK_HIDDEN");
  assert.equal(app.get("overlay").classList.contains("is-quick-pause"), false);
});

test("visible controls keep normal navigation and hide only on the existing idle timeout", () => {
  const app = setup();
  app.key("ArrowLeft"); // reveal only
  app.advance(4000);
  app.key("ArrowRight");
  assert.equal(app.document.activeElement.id, "forward");
  app.advance(4000);
  assert.equal(app.state(), "CONTROLS_VISIBLE");
  app.key("ArrowDown");
  assert.equal(app.document.activeElement.id, "next-episode");
  app.key("ArrowLeft");
  app.key("ArrowRight");
  assert.equal(app.document.activeElement.id, "next-episode");
  app.key("ArrowLeft");
  assert.equal(app.document.activeElement.id, "episodes");
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
  app.key("ArrowUp");
  app.key("Backspace");
  assert.equal(app.state(), "PLAYBACK_HIDDEN");
  assert.deepEqual(app.navigation, []);
  app.key("Backspace");
  assert.deepEqual(app.navigation, ["embed-matrix.html"]);
});

test("without a secure bridge, playback controls never hand focus away or send a key", () => {
  const app = setup();
  app.key("ArrowUp"); // reveal
  app.key("Enter"); // request Play/Pause
  assert.equal(app.state(), "CONTROLS_VISIBLE");
  assert.equal(app.document.activeElement.id, "play-pause");
  assert.match(app.get("command-status").textContent, /No key was sent or focus transferred/);
  assert.equal(app.timers.size, 1); // Five-second hide only.
  assert.equal(app.get("player-frame").sourceChanges, 1);
  app.advance(5000);
  assert.equal(app.state(), "PLAYBACK_HIDDEN");
});

test("hidden OK with a disconnected bridge reveals controls without claiming a pause", () => {
  const app = setup();
  app.key("Enter");
  assert.equal(app.state(), "CONTROLS_VISIBLE");
  assert.equal(app.get("overlay").classList.contains("is-visible"), true);
  assert.equal(app.document.activeElement.id, "play-pause");
  assert.match(app.get("command-status").textContent, /No secure Pico bridge.*No key was sent/);
});

test("uncertain hidden-OK delivery restores Play/Pause focus without replay", async () => {
  const calls = [];
  const app = setup({ adapter: { send(command) {
    calls.push(command);
    return Promise.reject(Error("connection lost after send"));
  } } });
  app.key("Enter");
  app.advance(16);
  await flush();
  assert.deepEqual(calls, ["pause_toggle"]);
  assert.equal(app.state(), "CONTROLS_VISIBLE");
  assert.equal(app.document.activeElement.id, "play-pause");
  assert.match(app.get("command-status").textContent, /playback effect is unknown/);
  app.player.onKey({ key: "Enter", repeat: true, preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(calls, ["pause_toggle"]);
});

test("handoff retries the selected visible control if focus slips back to the iframe", () => {
  const app = setup({ adapter: { send() { return new Promise(() => {}); } } });
  app.key("ArrowUp");
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
  app.key("ArrowUp");
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
  on.key("ArrowUp");
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
  off.key("ArrowUp");
  off.key("ArrowDown");
  off.key("Enter");
  off.key("ArrowRight");
  off.key("Enter");
  off.key("ArrowRight");
  off.key("Enter");
  assert.deepEqual(off.navigation, ["player-overlay.html?season=13&episode=2&sub=on"]);
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
  assert.equal(app.document.activeElement.id, "play-pause");
  assert.deepEqual(calls, ["pause_toggle"]);
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

const flush = () => new Promise(resolve => setImmediate(resolve));

async function startBatch(app, direction = "forward", steps = 0) {
  app.key("ArrowUp"); // reveal controls without activating Play/Pause
  app.key(direction === "forward" ? "ArrowRight" : "ArrowLeft");
  for (let i = 0; i < steps; i++) app.key(direction === "forward" ? "ArrowRight" : "ArrowLeft");
  app.key("Enter");
  await flush();
  app.advance(16);
  await flush();
}

test("arrows immediately adjust seek labels without Up or issuing playback", () => {
  const sent = [];
  const app = setup({ adapter: { open: () => Promise.resolve(), send: command => sent.push(command),
    sendBatch: (command, count) => sent.push([command, count]) } });
  app.key("ArrowUp");
  app.key("ArrowRight");
  assert.equal(app.document.activeElement.id, "forward");
  assert.equal(app.get("forward-label").textContent, "+10s");
  app.key("ArrowRight"); app.key("ArrowRight");
  assert.equal(app.get("forward-label").textContent, "+1m");
  app.key("ArrowLeft");
  assert.equal(app.get("forward-label").textContent, "+30s");
  assert.deepEqual(sent, []);
  app.key("ArrowDown");
  assert.equal(app.document.activeElement.id, "next-episode");
  app.key("ArrowLeft");
  app.key("ArrowLeft");
  assert.equal(app.document.activeElement.id, "subtitles");
  app.key("ArrowRight");
  assert.equal(app.document.activeElement.id, "episodes");
  app.key("ArrowUp");
  assert.equal(app.document.activeElement.id, "play-pause");
  app.key("ArrowLeft");
  assert.equal(app.document.activeElement.id, "rewind");
  assert.equal(app.get("forward-label").textContent, "+30s");
  app.key("ArrowLeft"); app.key("ArrowLeft"); app.key("ArrowRight");
  assert.equal(app.get("rewind-label").textContent, "−30s");
  assert.deepEqual(sent, []);
});

test("inward arrows decrease larger amounts and move from the minimum to Play/Pause", () => {
  const sent = [];
  const app = setup({ adapter: {
    send(command) { sent.push(command); return Promise.resolve({ accepted: true }); },
    sendBatch(command, count) { sent.push([command, count]); return Promise.resolve({ id: "unused" }); },
  } });
  app.key("ArrowUp");
  app.key("ArrowRight"); // Focus Forward
  app.key("ArrowLeft");
  assert.equal(app.get("forward-label").textContent, "+10s");
  assert.equal(app.document.activeElement.id, "play-pause");
  app.key("ArrowLeft"); // Focus Rewind
  app.key("ArrowRight");
  assert.equal(app.get("rewind-label").textContent, "−10s");
  assert.equal(app.document.activeElement.id, "play-pause");
  assert.deepEqual(sent, []);
});

test("the displayed amount is the exact single batch sent by OK", async () => {
  const sent = [];
  const app = setup({ adapter: {
    open: () => Promise.resolve(), ready: () => Promise.resolve(), send() {}, close() {},
    sendBatch(command, count) { sent.push([command, count]); return Promise.resolve({ id: "batch-12" }); },
    batchStatus() { return Promise.resolve({ id: "batch-12", state: "complete", acknowledged: 12 }); },
  } });
  app.key("ArrowUp"); app.key("ArrowRight");
  app.key("ArrowRight"); app.key("ArrowRight"); app.key("ArrowRight");
  assert.equal(app.get("forward-label").textContent, "+2m");
  assert.deepEqual(sent, []);
  app.key("Enter");
  await flush(); app.advance(16); await flush();
  assert.deepEqual(sent, [["seek_forward", 12]]);
  assert.equal(app.get("forward-label").textContent, "+2m");
});

test("seek amount does not reset after four seconds while the control bar remains visible", () => {
  const app = setup();
  app.key("ArrowUp"); app.key("ArrowRight"); app.key("ArrowRight");
  app.advance(4000);
  assert.equal(app.state(), "CONTROLS_VISIBLE");
  assert.equal(app.get("forward-label").textContent, "+30s");
  app.advance(1000);
  assert.equal(app.state(), "PLAYBACK_HIDDEN");
  assert.equal(app.get("forward-label").textContent, "+10s");
  assert.equal(app.get("rewind-label").textContent, "−10s");
});

test("both seek amounts reset only when controls hide or the player exits", () => {
  const app = setup();
  app.key("ArrowUp"); app.key("ArrowRight"); app.key("ArrowRight"); // Forward +30s
  app.key("ArrowUp"); app.key("ArrowLeft"); app.key("ArrowLeft"); // Rewind −30s
  assert.equal(app.get("forward-label").textContent, "+30s");
  assert.equal(app.get("rewind-label").textContent, "−30s");
  app.key("Backspace");
  assert.equal(app.state(), "PLAYBACK_HIDDEN");
  assert.equal(app.get("forward-label").textContent, "+10s");
  assert.equal(app.get("rewind-label").textContent, "−10s");
  app.key("ArrowUp");
  assert.equal(app.get("forward-label").textContent, "+10s");
  app.key("ArrowRight"); app.key("ArrowRight");
  app.player.dispose();
  assert.equal(app.get("forward-label").textContent, "+10s");
  assert.equal(app.get("rewind-label").textContent, "−10s");
});

test("OK dispatches exactly one batch at every selected count in either direction", async () => {
  for (const direction of ["forward", "rewind"]) {
    for (const [steps, count, label] of [[0, 1, "10s"], [1, 3, "30s"], [2, 6, "1m"],
      [3, 12, "2m"], [4, 30, "5m"], [5, 60, "10m"]]) {
      const sent = [];
      const app = setup({ adapter: {
        open: () => Promise.resolve(), ready: () => Promise.resolve(), close() {},
        send() { throw Error("seek used the single command path"); },
        sendBatch(command, requested) { sent.push([command, requested]); return Promise.resolve({ id: "batch-1" }); },
        batchStatus() { return Promise.resolve({ id: "batch-1", state: "complete", acknowledged: count }); },
      } });
      await startBatch(app, direction, steps);
      assert.deepEqual(sent, [[direction === "forward" ? "seek_forward" : "seek_backward", count]]);
      assert.equal(app.document.activeElement.id, direction);
      assert.equal(app.get(direction + "-label").textContent, (direction === "forward" ? "+" : "−") + label);
      assert.match(app.get("command-status").textContent, new RegExp(count + "/" + count + " inputs"));
      assert.match(app.get("command-status").textContent, /YapGrid position unverified/);
      assert.equal(app.get("player-frame").sourceChanges, 1);
    }
  }
});

test("a 60-input batch holds iframe focus beyond three seconds until matching terminal completion", async () => {
  let terminal = false;
  const sent = [];
  const app = setup({ adapter: {
    open: () => Promise.resolve(), ready: () => Promise.resolve(), close() {}, send() {},
    sendBatch(command, count) { sent.push([command, count]); return Promise.resolve({ id: "batch-60" }); },
    batchStatus(id) { assert.equal(id, "batch-60"); return Promise.resolve({ id, state: terminal ? "complete" : "running",
      acknowledged: terminal ? 60 : 8 }); },
  } });
  await startBatch(app, "forward", 5);
  assert.deepEqual(sent, [["seek_forward", 60]]);
  assert.equal(app.document.activeElement.id, "player-frame");
  assert.match(app.get("command-status").textContent, /8\/60 SmartCast inputs acknowledged/);
  assert.equal(app.key("Backspace").delivered, false);
  app.advance(3001);
  assert.equal(app.document.activeElement.id, "player-frame");
  await flush();
  app.advance(13000);
  assert.equal(app.document.activeElement.id, "player-frame");
  terminal = true;
  await flush();
  app.advance(250);
  await flush();
  assert.equal(app.document.activeElement.id, "forward");
  assert.equal(app.state(), "CONTROLS_VISIBLE");
  assert.equal(app.get("forward-label").textContent, "+10m");
});

test("one-input seek keeps the original short focus lease", async () => {
  const cancelled = [];
  const app = setup({ adapter: {
    open: () => Promise.resolve(), ready: () => Promise.resolve(), send() {}, close() {},
    sendBatch() { return Promise.resolve({ id: "single" }); },
    batchStatus() { return new Promise(() => {}); },
    cancelBatch(id) { cancelled.push(id); return Promise.resolve({ state: "cancelling" }); },
  } });
  await startBatch(app);
  app.advance(2983);
  assert.equal(app.document.activeElement.id, "player-frame");
  app.advance(1);
  assert.equal(app.document.activeElement.id, "forward");
  assert.deepEqual(cancelled, ["single"]);
});

test("rapid OK during an active batch cannot dispatch or queue another batch", async () => {
  const sent = [];
  const app = setup({ adapter: {
    open: () => Promise.resolve(), ready: () => Promise.resolve(), close() {}, send() {},
    sendBatch(command, count) { sent.push([command, count]); return Promise.resolve({ id: "active" }); },
    batchStatus() { return new Promise(() => {}); },
  } });
  await startBatch(app, "forward", 2);
  assert.equal(app.key("Enter").delivered, false);
  app.player.onKey({ key: "Enter", repeat: false, preventDefault() {}, stopPropagation() {} });
  app.player.onKey({ key: "Enter", repeat: true, preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(sent, [["seek_forward", 6]]);
  assert.equal(app.document.activeElement.id, "player-frame");
});

test("failure, cancellation, and status disconnect restore Horizon focus without replay", async () => {
  for (const outcome of ["failed", "cancelled", "disconnect"]) {
    const sent = [];
    const app = setup({ adapter: {
      open: () => Promise.resolve(), ready: () => Promise.resolve(), close() {}, send() {},
      sendBatch(command, count) { sent.push([command, count]); return Promise.resolve({ id: outcome }); },
      batchStatus() { return outcome === "disconnect" ? Promise.reject(Error("offline"))
        : Promise.resolve({ id: outcome, state: outcome, acknowledged: 2 }); },
    } });
    await startBatch(app, "forward", 1);
    assert.deepEqual(sent, [["seek_forward", 3]]);
    assert.equal(app.document.activeElement.id, "forward");
    assert.equal(app.state(), "CONTROLS_VISIBLE");
    assert.equal(app.get("forward-label").textContent, "+30s");
    assert.match(app.get("command-status").textContent, new RegExp(outcome === "disconnect" ? "unknown" : outcome));
  }
});

test("a partial terminal acknowledgment is unknown, never reported as a completed seek", async () => {
  const sent = [];
  const app = setup({ adapter: {
    open: () => Promise.resolve(), ready: () => Promise.resolve(), send() {}, close() {},
    sendBatch(command, count) { sent.push([command, count]); return Promise.resolve({ id: "partial" }); },
    batchStatus() { return Promise.resolve({ id: "partial", state: "complete", acknowledged: 2 }); },
  } });
  await startBatch(app, "forward", 1);
  assert.deepEqual(sent, [["seek_forward", 3]]);
  assert.equal(app.document.activeElement.id, "forward");
  assert.equal(app.get("forward-label").textContent, "+30s");
  assert.match(app.get("command-status").textContent, /SmartCast unknown: 2\/3 inputs/);
});

test("30-second watchdog restores focus, requests cancellation, and bounds uncertain completion", async () => {
  const calls = [];
  const app = setup({ adapter: {
    open: () => Promise.resolve(), ready: () => Promise.resolve(), send() {},
    close() { calls.push("close"); },
    sendBatch() { return Promise.resolve({ id: "long-batch" }); },
    batchStatus() { return new Promise(() => {}); },
    cancelBatch(id) { calls.push(["cancel", id]); return Promise.resolve({ state: "cancelling" }); },
  } });
  await startBatch(app, "forward", 5);
  app.advance(29983);
  assert.equal(app.document.activeElement.id, "player-frame");
  app.advance(1);
  assert.equal(app.document.activeElement.id, "forward");
  assert.deepEqual(calls, [["cancel", "long-batch"]]);
  assert.match(app.get("command-status").textContent, /Focus timeout; stopping/);
  app.advance(5000);
  assert.ok(calls.includes("close"));
  assert.match(app.get("command-status").textContent, /unknown/);
  assert.equal(app.get("forward-label").textContent, "+10m");
});

test("stale status from timed-out batch cannot finish a later batch", async () => {
  let resolveOld;
  let sends = 0;
  let wrongResponse = true;
  const app = setup({ adapter: {
    open: () => Promise.resolve(), ready: () => Promise.resolve(), send() {}, close() {},
    sendBatch() { sends += 1; return Promise.resolve({ id: "batch-" + sends }); },
    batchStatus(id) { return id === "batch-1" ? new Promise(resolve => { resolveOld = resolve; })
      : Promise.resolve(wrongResponse ? { id: "batch-1", state: "complete", acknowledged: 6 }
        : { id, state: "running", acknowledged: 1 }); },
    cancelBatch() { return Promise.resolve({ state: "cancelling" }); },
  } });
  await startBatch(app, "forward", 2);
  app.advance(35000);
  assert.equal(app.document.activeElement.id, "forward");
  app.key("Enter");
  await flush(); app.advance(16); await flush();
  assert.equal(sends, 2);
  assert.equal(app.document.activeElement.id, "player-frame");
  wrongResponse = false;
  resolveOld({ state: "complete", acknowledged: 6 });
  await flush();
  assert.equal(app.document.activeElement.id, "player-frame");
  assert.equal(app.state(), "COMMAND_IN_PROGRESS");
});

test("Back during batch preparation cancels before dispatch and rapid OK cannot overlap", async () => {
  let resolveReady;
  const batches = [];
  const app = setup({ adapter: {
    open: () => Promise.resolve(), ready: () => new Promise(resolve => { resolveReady = resolve; }),
    send() {}, sendBatch(command, count) { batches.push([command, count]); }, close() {},
  } });
  app.key("ArrowUp"); app.key("ArrowRight"); app.key("ArrowRight"); app.key("Enter");
  app.key("Enter"); app.key("Enter");
  assert.equal(batches.length, 0);
  app.key("Backspace");
  resolveReady();
  await flush(); app.advance(20);
  assert.deepEqual(batches, []);
  assert.equal(app.state(), "CONTROLS_VISIBLE");
  assert.equal(app.get("forward-label").textContent, "+30s");
});

test("catalog validates positive provider route inputs without hardcoded season boundaries", () => {
  const episodes = catalog();
  assert.equal(episodes.embedUrl(episodes.episode(13, 2)), baseUrl);
  assert.equal(episodes.pageUrl(episodes.episode(13, 3), "off", false),
    "player-overlay.html?season=13&episode=3&sub=off");
  assert.equal(episodes.episode(14, 1).season, 14);
  assert.equal(episodes.episode(13, 15).episode, 15);
  for (const [season, number] of [[13, 0], [13, -1], [0, 1], [13, 1.5]]) {
    assert.equal(episodes.episode(season, number), null);
  }
  assert.equal(episodes.pageUrl({ showId: 2191, season: 13, episode: 2 }, "on", false), null);
  assert.equal(episodes.embedUrl({ showId: 2190, season: 13, episode: 0 }), null);
  assert.equal(episodes.parse("?season=-1&episode=0&sub=off").current.episode, 2);
  assert.equal(episodes.parse("?season=%ZZ&episode=3").invalid, true);
});

test("dynamic metadata resolves same-season and cross-season episodes without episode counts", () => {
  const episodes = catalog();
  const rows = [
    { season: 11, number: 6, title: "Earlier season finale" },
    { season: 13, number: 1, title: "The Ring" },
    { season: 13, number: 2, title: "The Coon" },
    { season: 13, number: 3, title: "Margaritaville" },
    { season: 14, number: 1, title: "New season" },
  ];
  const target = (season, number, direction) =>
    episodes.resolveFromRows(rows, episodes.episode(season, number), direction);
  assert.equal(target(13, 2, 1).target.episode, 3);
  assert.equal(target(13, 3, 1).target.season, 14);
  assert.equal(target(14, 1, -1).target.episode, 3);
  assert.equal(target(13, 1, -1).target.season, 11); // Skip absent Season 12.
  assert.equal(target(13, 2, -1).target.episode, 1);
  assert.equal(target(14, 1, 1).kind, "none_known");
  assert.equal(target(13, 4, 1).kind, "unknown");
  assert.equal(target(13, 1, -1).providerAvailability, "unknown");
});

test("metadata filters future and nonregular entries and rejects a mismatched show index", () => {
  const episodes = catalog();
  const sentinel = { season: 13, number: 2, name: "The Coon", type: "regular", airdate: "2009-03-18" };
  const normalized = episodes.normalize([sentinel,
    { season: 13, number: 3, name: "Future", type: "regular", airdate: "2999-01-01" },
    { season: 13, number: 4, name: "Special", type: "significant_special", airdate: "2010-01-01" },
  ], "2026-10-26");
  assert.equal(normalized.length, 1);
  assert.throws(() => episodes.normalize([{ ...sentinel, name: "Wrong show" }], "2026-10-26"),
    /episode_index_mismatch/);
  assert.throws(() => episodes.normalize([sentinel, sentinel], "2026-10-26"),
    /ambiguous_episode_metadata/);
});

test("metadata resolver caches verified listings and keeps HTTP failure and timeout unknown", async () => {
  const episodes = catalog();
  const rows = [
    { season: 13, number: 2, name: "The Coon", type: "regular", airdate: "2009-03-18" },
    { season: 13, number: 3, name: "Margaritaville", type: "regular", airdate: "2009-03-25" },
  ];
  let fetches = 0;
  const saved = new Map();
  const storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  const realClock = { setTimeout, clearTimeout };
  const resolver = episodes.createResolver({ storage, clock: realClock, today: "2026-10-26", fetch: async () => {
    fetches += 1;
    return { ok: true, json: async () => rows };
  } });
  const current = episodes.episode(13, 2);
  assert.equal((await resolver.resolve(current, 1)).target.episode, 3);
  assert.equal((await resolver.resolve(current, -1)).kind, "none_known");
  assert.equal(fetches, 1);
  const cached = episodes.createResolver({ storage, clock: realClock, today: "2026-10-26", fetch: async () => {
    throw Error("cache was not used");
  } });
  assert.equal((await cached.resolve(current, 1)).kind, "catalogued");
  const unavailable = episodes.createResolver({ storage: {}, clock: realClock, fetch: async () => ({ ok: false }) });
  assert.equal((await unavailable.resolve(current, 1)).kind, "unknown");
  let expire;
  const clock = { setTimeout(callback) { expire = callback; return 1; }, clearTimeout() {} };
  const slow = episodes.createResolver({ storage: {}, clock, fetch: () => new Promise(() => {}) });
  const outcome = slow.resolve(current, 1);
  await flush();
  expire();
  assert.equal((await outcome).reason, "timeout");
});

test("remote reaches Previous, Next, Subtitles, Episode List and keeps playback controls reachable", () => {
  const app = setup();
  app.key("ArrowUp");
  const reached = new Set([app.document.activeElement.id]);
  app.key("ArrowLeft"); reached.add(app.document.activeElement.id); // Rewind
  app.key("ArrowDown"); reached.add(app.document.activeElement.id); // Previous
  app.key("ArrowRight"); reached.add(app.document.activeElement.id); // Subtitles
  app.key("ArrowRight"); reached.add(app.document.activeElement.id); // List
  app.key("ArrowRight"); reached.add(app.document.activeElement.id); // Next
  app.key("ArrowUp"); reached.add(app.document.activeElement.id); // Forward
  assert.deepEqual([...reached].sort(), ["episodes", "forward", "next-episode", "play-pause",
    "previous-episode", "rewind", "subtitles"].sort());
  assert.deepEqual(app.navigation, []);
});

test("Previous and Next each require confirmation and transition once with subtitle mode", async () => {
  const previous = setup({ search: "?season=13&episode=2&sub=off" });
  previous.key("ArrowUp"); previous.key("ArrowLeft"); previous.key("ArrowDown");
  assert.equal(previous.document.activeElement.id, "previous-episode");
  previous.key("Enter");
  await flush();
  assert.deepEqual(previous.navigation, []);
  assert.match(previous.get("command-status").textContent, /YapGrid playback unknown/);
  previous.key("Enter"); previous.key("Enter", true);
  assert.deepEqual(previous.navigation, ["player-overlay.html?season=13&episode=1&sub=off"]);

  const next = setup({ search: "?season=13&episode=2&sub=off" });
  next.key("ArrowUp"); next.key("ArrowRight"); next.key("ArrowDown");
  assert.equal(next.document.activeElement.id, "next-episode");
  next.key("Enter");
  await flush();
  assert.deepEqual(next.navigation, []);
  next.key("Enter");
  assert.deepEqual(next.navigation, ["player-overlay.html?season=13&episode=3&sub=off"]);
  const loaded = setup({ search: "?season=13&episode=3&sub=off" });
  await flush();
  assert.match(loaded.get("player-frame").src, /\/2190\/13\/3\?sub_url=/);
  assert.match(loaded.get("episode-caption").textContent, /Margaritaville/);
  assert.equal(loaded.get("subtitle-mode").textContent, "OFF");
});

test("episode controls cross season boundaries and unknown metadata never navigates", async () => {
  const episodes = catalog();
  const rows = [
    { season: 13, number: 14, title: "Season finale" },
    { season: 14, number: 1, title: "New season" },
  ];
  const resolver = { current: item => Promise.resolve(item),
    resolve: (item, direction) => Promise.resolve(episodes.resolveFromRows(rows, item, direction)) };
  const next = setup({ search: "?season=13&episode=14&sub=off", episodeResolver: resolver });
  next.key("ArrowUp"); next.key("ArrowRight"); next.key("ArrowDown"); next.key("Enter");
  await flush();
  assert.match(next.get("command-status").textContent, /S14 E1.*press OK again/);
  next.key("Enter");
  assert.deepEqual(next.navigation, ["player-overlay.html?season=14&episode=1&sub=off"]);

  const previous = setup({ search: "?season=14&episode=1&sub=on", episodeResolver: resolver });
  previous.key("ArrowUp"); previous.key("ArrowLeft"); previous.key("ArrowDown"); previous.key("Enter");
  await flush();
  previous.key("Enter");
  assert.deepEqual(previous.navigation, ["player-overlay.html?season=13&episode=14&sub=on"]);

  const unknown = setup({ episodeResolver: { current: () => Promise.resolve(null),
    resolve: () => Promise.resolve({ kind: "unknown", reason: "timeout" }) } });
  unknown.key("ArrowUp"); unknown.key("ArrowRight"); unknown.key("ArrowDown"); unknown.key("Enter");
  await flush();
  assert.match(unknown.get("command-status").textContent, /timed out; availability unknown/);
  unknown.key("Enter");
  await flush();
  assert.deepEqual(unknown.navigation, []);
});

test("metadata boundaries cannot launch unlisted episodes or autoplay", async () => {
  const first = setup({ search: "?season=13&episode=1&sub=on" });
  await flush();
  first.key("ArrowUp"); first.key("ArrowLeft"); first.key("ArrowDown"); first.key("Enter");
  await flush();
  assert.equal(first.get("previous-episode").attributes["aria-disabled"], "true");
  assert.deepEqual(first.navigation, []);
  assert.match(first.get("command-status").textContent, /No earlier aired episode/);
  const final = setup({ search: "?season=13&episode=14&sub=off&testEnd=1" });
  await flush();
  final.key("ArrowUp"); final.key("ArrowRight"); final.key("ArrowDown"); final.key("Enter");
  await flush();
  assert.equal(final.get("next-episode").attributes["aria-disabled"], "true");
  assert.equal(final.get("manual-end").hidden, true);
  assert.equal(final.get("up-next").hidden, true);
  assert.deepEqual(final.navigation, []);
});

test("preview manual end trigger counts down ten seconds and launches once", async () => {
  const app = setup({ search: "?season=13&episode=2&sub=off&testEnd=1" });
  app.key("ArrowUp"); app.key("ArrowDown"); app.key("ArrowDown");
  assert.equal(app.document.activeElement.id, "manual-end");
  app.key("Enter");
  app.get("manual-end").click(); // Duplicate end while prompt is active.
  await flush();
  assert.equal(app.state(), "UP_NEXT");
  assert.equal(app.get("up-next").hidden, false);
  assert.equal(app.document.activeElement.id, "up-next-play");
  assert.match(app.get("up-next-title").textContent, /Margaritaville/);
  assert.match(app.get("up-next-countdown").textContent, /10 seconds/);
  app.advance(9000);
  assert.match(app.get("up-next-countdown").textContent, /1 second$/);
  assert.deepEqual(app.navigation, []);
  app.advance(1000);
  assert.deepEqual(app.navigation, ["player-overlay.html?season=13&episode=3&sub=off&testEnd=1"]);
  app.advance(30000);
  assert.equal(app.navigation.length, 1);
  assert.equal(app.timers.size, 0);
});

test("Play now, Cancel and Back terminate countdown with no delayed second launch", async () => {
  for (const action of ["play", "cancel", "back"]) {
    const app = setup({ search: "?season=13&episode=2&sub=off&testEnd=1" });
    app.key("ArrowUp"); app.get("manual-end").click();
    await flush();
    app.advance(2000);
    if (action === "play") app.key("Enter");
    else if (action === "cancel") { app.key("ArrowRight"); app.key("Enter"); }
    else app.key("Backspace");
    assert.deepEqual(app.navigation, [action === "play"
      ? "player-overlay.html?season=13&episode=3&sub=off&testEnd=1"
      : "episode-list-placeholder.html?season=13&episode=2&sub=off&testEnd=1"]);
    app.advance(20000);
    assert.equal(app.navigation.length, 1);
    assert.equal(app.timers.size, 0);
  }
});

test("countdown ignores other controls, clears on teardown, and does not trust arbitrary messages", () => {
  const app = setup({ search: "?testEnd=1" });
  app.message({ type: "ended" });
  assert.equal(app.state(), "PLAYBACK_HIDDEN");
  app.key("ArrowUp");
  app.message({ type: "ended" });
  assert.equal(app.get("up-next").hidden, true);
  app.get("manual-end").click();
  app.get("next-episode").click();
  assert.deepEqual(app.navigation, []);
  app.pagehide();
  app.advance(20000);
  assert.deepEqual(app.navigation, []);
  assert.equal(app.timers.size, 0);

  const regular = setup();
  assert.equal(regular.get("manual-end").hidden, true);
  regular.key("ArrowUp"); regular.key("ArrowDown"); regular.key("ArrowDown");
  assert.notEqual(regular.document.activeElement.id, "manual-end");
});

test("Episode List placeholder returns to the same episode and subtitle mode", () => {
  const nodes = {
    "return-player": { href: "", focused: false, focus() { this.focused = true; } },
    "return-episode": { textContent: "" },
  };
  let keydown;
  const navigation = [];
  const window = {
    location: { search: "?season=13&episode=3&sub=off&testEnd=1", origin: previewOrigin,
      replace(path) { navigation.push(path); } },
    document: { getElementById(id) { return nodes[id]; },
      addEventListener(name, handler) { if (name === "keydown") keydown = handler; } },
  };
  runInNewContext(catalogScript, { window });
  runInNewContext(listScript, { window });
  assert.match(listHtml, /Episode List/);
  assert.equal(nodes["return-player"].href,
    "player-overlay.html?season=13&episode=3&sub=off&testEnd=1");
  assert.equal(nodes["return-player"].focused, true);
  assert.match(nodes["return-episode"].textContent, /Season 13 · Episode 3/);
  keydown({ key: "Backspace", preventDefault() {} });
  assert.deepEqual(navigation, [nodes["return-player"].href]);
});

test("subtitle reload keeps the selected episode while switching mode", () => {
  const app = setup({ search: "?season=13&episode=3&sub=off" });
  app.key("ArrowUp"); app.key("ArrowDown"); app.key("Enter");
  app.key("ArrowRight"); app.key("Enter");
  app.key("ArrowRight"); app.key("Enter");
  assert.deepEqual(app.navigation, ["player-overlay.html?season=13&episode=3&sub=on"]);
});
