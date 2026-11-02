import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("../video-lab/player-overlay.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../video-lab/player-overlay.css", import.meta.url), "utf8");
const leaseScript = readFileSync(new URL("../video-lab/focus-lease.js", import.meta.url), "utf8");
const catalogScript = readFileSync(new URL("../video-lab/episode-catalog.js", import.meta.url), "utf8");
const providerScript = readFileSync(new URL("../video-lab/playback-providers.js", import.meta.url), "utf8");
const diagnosticsScript = readFileSync(new URL("../video-lab/player-diagnostics.js", import.meta.url), "utf8");
const listHtml = readFileSync(new URL("../video-lab/episode-list-placeholder.html", import.meta.url), "utf8");
const listScript = readFileSync(new URL("../video-lab/episode-list-placeholder.js", import.meta.url), "utf8");
const playerScript = readFileSync(new URL("../video-lab/player-overlay.js", import.meta.url), "utf8");
const ids = ["player-frame", "player-loading", "remote-capture", "overlay", "rewind", "rewind-label", "play-pause", "play-pause-label", "forward", "forward-label", "subtitles",
  "episodes", "previous-episode", "next-episode", "manual-end", "show-title", "metadata-credit", "metadata-provider-credit", "episode-caption", "up-next", "up-next-title", "up-next-countdown", "up-next-play", "up-next-cancel",
  "subtitle-menu", "subtitle-mode", "menu-title", "menu-description", "menu-cancel", "menu-change",
  "command-status", "screen-reader-status", "provider-choice", "unload-provider", "recover-provider", "provider-telemetry", "diagnostics-open", "diagnostics-close", "diagnostics-panel", "diag-user-agent", "diag-media-source", "diag-native-hls", "diag-html5", "diag-permissions", "diag-frame-events", "diag-events", "diag-message-checks", "diag-sources", "diag-elapsed", "diag-assessment", "diag-vidbolt-session", "compat-controls", "compat-quality", "compat-play", "compat-autoplay", "compat-reset", "compat-status", "diag-variant", "vidfast-compat-controls", "vidfast-autoplay", "vidfast-reset", "vidfast-compat-status", "diag-vidfast-mode", "vidlink-compat-controls", "vidlink-default-off", "vidlink-default-on", "vidlink-jw-on", "vidlink-focus-default", "vidlink-focus-status", "vidlink-compat-status", "diag-vidlink-mode", "vidbolt-compat-controls", "vidbolt-autoplay-toggle", "vidbolt-auto-recover", "vidbolt-stop", "vidbolt-native-focus", "diag-vidbolt-mode", "vidbolt-compat-status", "experimental-controls", "experiment-play", "experiment-pause", "experiment-back", "experiment-forward", "experiment-volume", "experiment-unmute", "experiment-focus", "experiment-skip", "player-shell"];
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
  const posted = [];
  let time = 0;
  let nextTimer = 1;
  const document = {
    activeElement: null,
    getElementById(id) { return nodes.get(id); },
    addEventListener(name, handler) { (documentEvents[name] ||= []).push(handler); },
    createElement() { return { canPlayType() { return "maybe"; } }; },
  };
  function emit(handlers, name, event = {}) { for (const handler of handlers[name] || []) handler(event); }
  function node(id) {
    const handlers = {};
    const attributes = {};
    const classes = new Set();
    let source = "";
    const element = {
      id, hidden: id === "subtitle-menu" || id === "up-next" || id === "manual-end" || id === "diagnostics-panel" || id === "compat-controls" || id === "vidfast-compat-controls" || id === "vidlink-compat-controls" || id === "vidbolt-compat-controls" || id === "experimental-controls", textContent: "", tabIndex: -1, sourceChanges: 0,
      attributes,
      classList: {
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); },
        contains(name) { return classes.has(name); },
      },
      get src() { return source; },
      set src(value) { source = String(value); element.sourceChanges += 1; },
      cloneNode() { return node(id); },
      parentNode: { replaceChild(next) { nodes.set(id, next); } },
      setAttribute(name, value) { attributes[name] = String(value); },
      removeAttribute(name) { delete attributes[name]; if (name === "src") source = ""; },
      getAttribute(name) { return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null; },
      addEventListener(name, handler) { (handlers[name] ||= []).push(handler); },
      fire(name) { emit(handlers, name, { target: element }); },
      focus() { document.activeElement = element; emit(handlers, "focus", { target: element }); },
      click() { emit(handlers, "click", { target: element }); },
    };
    if (id === "player-frame") element.contentWindow = {
      postMessage(data, origin) { posted.push({ data, origin }); },
    };
    if (id === "player-frame") {
      element.setAttribute("allow", "autoplay; fullscreen; picture-in-picture");
      element.setAttribute("allowfullscreen", "");
      element.setAttribute("referrerpolicy", "no-referrer");
    }
    return element;
  }
  for (const id of ids) nodes.set(id, node(id));
  const window = {
    navigator: { userAgent: "Mock Vizio Test" },
    MediaSource: { isTypeSupported() { return true; } },
    getComputedStyle() { return { pointerEvents: "none" }; },
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
  runInNewContext(providerScript, { window });
  runInNewContext(diagnosticsScript, { window });
  runInNewContext(playerScript, { window });
  const player = window.HorizonPlayerOverlay.createPlayer(document, location, window,
    { commandAdapter: adapter, episodeResolver });
  // The script auto-initializes in a browser. In this harness, its exported
  // creator is called explicitly because the VM context has no global document.
  return {
    get: id => nodes.get(id), document, navigation, timers, player, posted,
    state() { return player.getState(); },
    key(name, repeat = false) {
      if (document.activeElement === nodes.get("player-frame")) return { delivered: false };
      const event = { key: name, repeat, prevented: false,
        preventDefault() { this.prevented = true; }, stopPropagation() {} };
      emit(documentEvents, "keydown", event);
      return { delivered: true, prevented: event.prevented };
    },
    parentKey(name) {
      const event = { key: name, repeat: false, prevented: false,
        preventDefault() { this.prevented = true; }, stopPropagation() {} };
      emit(documentEvents, "keydown", event);
      return { prevented: event.prevented };
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
    blur() { emit(windowEvents, "blur"); },
    message(data, origin = "https://yapgrid.com", source = nodes.get("player-frame").contentWindow) {
      emit(windowEvents, "message", { data, origin, source });
    },
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

test("KEYLIST completion reports one SmartCast request acknowledgment, not observed playback", async () => {
  const app = setup({ adapter: {
    open: () => Promise.resolve(), ready: () => Promise.resolve(), close() {}, send() {},
    sendBatch() { return Promise.resolve({ id: "keylist-6" }); },
    batchStatus() { return Promise.resolve({ id: "keylist-6", state: "complete",
      code: "keylist_acknowledged", acknowledged: 6, metrics: { picoMs: 531 } }); },
  } });
  await startBatch(app, "forward", 2);
  assert.match(app.get("command-status").textContent,
    /SmartCast KEYLIST request acknowledged for 6 inputs/);
  assert.match(app.get("command-status").textContent, /YapGrid position unverified/);
  assert.equal(app.document.activeElement.id, "forward");
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
  assert.equal(episodes.pageUrl({ showId: 2191, season: 13, episode: 2 }, "on", false),
    "player-overlay.html?season=13&episode=2&sub=on&showId=2191");
  assert.equal(episodes.embedUrl({ showId: 2190, season: 13, episode: 0 }), null);
  assert.equal(episodes.parse("?season=-1&episode=0&sub=off").current.episode, 2);
  assert.equal(episodes.parse("?season=13&episode=2").subtitle, "off");
  assert.equal(episodes.parse("?season=13&episode=2&sub=on").subtitle, "on");
  assert.equal(episodes.parse("?season=%ZZ&episode=3").invalid, true);
  const generic = episodes.parse("?showId=1396&season=1&episode=2&sub=off&from=search&name=Breaking%20Bad");
  assert.equal(generic.current.showId, 1396);
  assert.equal(generic.fromSearch, true);
  assert.equal(episodes.embedUrl(generic.current), "https://yapgrid.com/embed/tv/1396/1/2");
  assert.equal(episodes.pageUrl(generic.current, "off", false, null, true, generic.showTitle),
    "player-overlay.html?season=1&episode=2&sub=off&showId=1396&from=search&name=Breaking%20Bad");
});

test("search-launched TV keeps validated show ID and returns safely to fixed search origin", () => {
  const app = setup({ search: "?showId=1396&season=1&episode=2&sub=off&from=search&name=Breaking%20Bad" });
  assert.match(app.get("player-frame").src, /\/embed\/tv\/1396\/1\/2\?sub_url=/);
  assert.equal(app.get("show-title").textContent, "Breaking Bad");
  assert.match(app.get("metadata-credit").textContent, /TMDB selection/);
  app.key("Backspace");
  assert.deepEqual(app.navigation, [
    "https://horizon-universal-search-preview.ali-al-anbari.workers.dev/?return=1&showId=1396&season=1&episode=2&sub=off"
  ]);
});

test("movie uses the same player shell with a TMDB movie URL and returns to Watch", () => {
  const app = setup({ search: "?type=movie&id=550&from=search&name=Fight%20Club" });
  assert.equal(app.get("player-frame").src, "https://yapgrid.com/embed/movie/550");
  assert.equal(app.get("player-frame").sourceChanges, 1);
  assert.equal(app.get("show-title").textContent, "Fight Club");
  assert.equal(app.get("player-loading").textContent, "Opening movie…");
  for (const id of ["previous-episode", "episodes", "next-episode", "subtitles"])
    assert.equal(app.get(id).hidden, true);
  app.key("ArrowDown");
  assert.equal(app.document.activeElement.id, "play-pause");
  app.key("ArrowDown");
  assert.equal(app.document.activeElement.id, "provider-choice", "movie focus can reach provider selection");
  app.get("player-frame").fire("load");
  assert.equal(app.get("player-loading").hidden, true);
  app.key("Backspace");
  app.key("Backspace");
  assert.deepEqual(app.navigation, [previewOrigin.replace("video-lab-preview", "universal-search-preview")
    + "/?return=1&type=movie&id=550"]);
});

test("movie provider failure and invalid ID do not claim playback", () => {
  const app = setup({ search: "?type=movie&id=550&from=search" });
  app.advance(12000);
  assert.match(app.get("player-loading").textContent, /taking longer/);
  app.get("player-frame").fire("error");
  assert.match(app.get("player-loading").textContent, /could not load/);
  assert.equal(app.get("player-loading").hidden, false);
  const invalid = setup({ search: "?type=movie&id=0&from=search" });
  assert.equal(invalid.get("player-frame").sourceChanges, 0);
  assert.match(invalid.get("player-loading").textContent, /Invalid movie ID/);
});

test("movie provider cycles YapGrid, VidBolt, YapGrid by D-pad", () => {
  const app = setup({ search: "?type=movie&id=550&from=search&name=Fight%20Club" });
  assert.equal(app.get("player-frame").src, "https://yapgrid.com/embed/movie/550");
  app.key("ArrowDown");
  app.key("ArrowDown");
  assert.equal(app.document.activeElement.id, "provider-choice");
  app.key("Enter");
  assert.equal(app.get("player-frame").src, "https://vidbolt.xyz/movie/550?autoPlay=true");
  assert.equal(app.get("provider-choice").textContent, "Provider: VidBolt");
  assert.equal(app.get("unload-provider").hidden, true);
  assert.equal(app.get("recover-provider").hidden, false);
  app.key("ArrowDown"); app.key("ArrowDown");
  assert.equal(app.document.activeElement.id, "provider-choice");
  app.key("Enter");
  assert.equal(app.get("player-frame").src, "https://yapgrid.com/embed/movie/550");
  assert.equal(app.get("provider-choice").textContent, "Provider: YapGrid");
  assert.equal(app.get("unload-provider").hidden, true);
  assert.equal(app.get("recover-provider").hidden, false);
  assert.equal(app.get("recover-provider").textContent, "Reload Player");
});

test("YapGrid Reload Player replaces only its iframe and retains movie or exact TV URL", () => {
  for (const [search, expected] of [
    ["?type=movie&id=550", "https://yapgrid.com/embed/movie/550"],
    ["?sub=on", baseUrl + "?lang=en"],
    ["?sub=off", baseUrl + "?sub_url=" + encodeURIComponent(previewOrigin + "/empty.vtt")
      + "&sub_lang=en&sub_label=Off"],
  ]) {
    const app = setup({ search });
    const oldFrame = app.get("player-frame");
    assert.equal(oldFrame.src, expected);
    app.key("ArrowDown");
    if (search.startsWith("?type=movie")) {
      app.key("ArrowDown"); app.key("ArrowDown"); app.key("ArrowDown");
    } else {
      app.key("ArrowDown"); app.key("ArrowDown"); app.key("ArrowDown"); app.key("ArrowDown");
    }
    assert.equal(app.document.activeElement.id, "recover-provider");
    app.key("Enter");
    assert.equal(oldFrame.src, "about:blank");
    assert.notEqual(app.get("player-frame"), oldFrame);
    assert.equal(app.get("player-frame").src, expected);
    assert.equal(app.document.activeElement.id, "recover-provider");
    assert.match(app.get("command-status").textContent, /Previous position is unavailable/);
    assert.deepEqual(app.navigation, []);
    app.key("Backspace");
    assert.equal(app.state(), "PLAYBACK_HIDDEN");
  }
});

test("YapGrid and VidBolt render the same control rows and D-pad targets", () => {
  const paths = [
    ["play-pause", []], ["rewind", ["ArrowLeft"]], ["forward", ["ArrowRight"]],
    ["previous-episode", ["ArrowLeft", "ArrowDown"]],
    ["subtitles", ["ArrowDown"]], ["episodes", ["ArrowDown", "ArrowRight"]],
    ["next-episode", ["ArrowRight", "ArrowDown"]],
    ["provider-choice", ["ArrowDown", "ArrowDown"]],
    ["diagnostics-open", ["ArrowDown", "ArrowDown", "ArrowDown"]],
    ["recover-provider", ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowRight"]],
  ];
  const ids = paths.map(item => item[0]);
  for (const [provider, search] of [["YapGrid", "?sub=on"], ["VidBolt", "?sub=on&provider=vidbolt"]]) {
    const sample = setup({ search });
    assert.equal(sample.get("experimental-controls").hidden, true, provider);
    assert.equal(sample.get("unload-provider").hidden, true, provider);
    assert.deepEqual(ids.filter(id => !sample.get(id).hidden), ids, provider);
    if (provider === "VidBolt") {
      sample.message({ type: "timeupdate", time: 6.31 }, "https://vidbolt.xyz");
      assert.equal(sample.get("provider-telemetry").classList.contains("is-visible"), false);
      assert.equal(sample.get("play-pause-label").textContent, "Play / Pause");
    }
    for (const [target, keys] of paths) {
      const app = setup({ search });
      app.key("ArrowDown");
      for (const key of keys) app.key(key);
      assert.equal(app.document.activeElement.id, target, provider + " → " + target);
      assert.equal(app.get(target).tabIndex, 0, provider + " → " + target);
      assert.equal(app.state(), "CONTROLS_VISIBLE");
      app.key("Backspace");
      assert.equal(app.state(), "PLAYBACK_HIDDEN", provider + " Back from " + target);
    }
  }
  assert.match(html, /class="control-row primary"[^>]*>[\s\S]*id="rewind"[\s\S]*id="play-pause"[\s\S]*id="forward"/);
  assert.match(css, /\.primary button \{[^}]*width: clamp\(100px, 8vw, 150px\)/);
});

test("provider switching keeps the same primary buttons and focus entry", () => {
  const app = setup({ search: "?type=movie&id=550" });
  const primary = ["rewind", "play-pause", "forward"].map(id => app.get(id));
  for (const name of ["VidBolt", "YapGrid"]) {
    app.key("ArrowDown"); app.key("ArrowDown"); app.key("Enter");
    assert.equal(app.get("provider-choice").textContent, "Provider: " + name);
    assert.deepEqual(["rewind", "play-pause", "forward"].map(id => app.get(id)), primary);
    assert.equal(app.get("experimental-controls").hidden, true);
    app.key("ArrowDown");
    assert.equal(app.document.activeElement.id, "play-pause");
    app.key("Backspace");
  }
});

test("VidFast errors stay on the selected provider until the user switches", () => {
  const app = setup({ search: "?type=movie&id=550&provider=vidfast" });
  assert.equal(app.get("player-frame").src, "https://vidfast.vc/movie/550");
  app.get("player-frame").fire("error");
  assert.match(app.get("player-loading").textContent, /could not load/);
  assert.equal(app.get("player-loading").hidden, false);
  app.key("ArrowDown");
  app.key("ArrowDown");
  assert.equal(app.document.activeElement.id, "provider-choice");
  app.key("Enter");
  assert.equal(app.get("player-frame").src, "https://yapgrid.com/embed/movie/550");
});

test("VidFast warning banner is unobtrusive, and MEDIA_DATA / status messages do not falsely claim playback", () => {
  const app = setup({ search: "?type=movie&id=550&provider=vidfast" });
  assert.equal(app.get("player-loading").textContent, "Opening VidFast…");
  assert.equal(app.get("player-loading").classList.contains("is-warning"), false);

  // 12s timeout triggers Horizon warning banner
  app.advance(12000);
  assert.match(app.get("player-loading").textContent, /^Horizon warning: VidFast is taking longer/);
  assert.equal(app.get("player-loading").classList.contains("is-warning"), true);

  // MEDIA_DATA sync does not clear timeout banner or claim video playback
  app.message({ type: "MEDIA_DATA", data: { t550: { id: 550 } } }, "https://vidfast.vc");
  assert.match(app.get("command-status").textContent, /sync heartbeat received/);
  assert.equal(app.get("player-loading").hidden, false);

  // Status 404 reports stream error
  app.message({ event: "status", data: 404 }, "https://vidfast.vc");
  assert.match(app.get("player-loading").textContent, /status 404/);
  assert.equal(app.get("player-loading").classList.contains("is-warning"), true);

  // A provider play report after a stream error does not prove recovery.
  app.message({ type: "PLAYER_EVENT", data: { event: "play", currentTime: 0, duration: 100 } }, "https://vidfast.vc");
  assert.equal(app.get("player-loading").hidden, false);
  assert.match(app.get("screen-reader-status").textContent, /after a stream error/);
});

test("user-controlled Stop / Unload action frees VidFast iframe and focuses provider-choice", () => {
  const app = setup({ search: "?type=movie&id=550&provider=vidfast" });
  assert.equal(app.get("player-frame").src, "https://vidfast.vc/movie/550");
  app.key("ArrowDown");
  app.key("ArrowDown");
  assert.equal(app.document.activeElement.id, "provider-choice");
  app.key("ArrowDown");
  assert.equal(app.document.activeElement.id, "unload-provider");
  app.key("Enter");
  assert.equal(app.get("player-frame").src, "about:blank");
  assert.match(app.get("command-status").textContent, /unloaded/);
  assert.equal(app.document.activeElement.id, "provider-choice");
});

test("VidFast diagnostic selector reloads only with documented autoPlay and resets", () => {
  const app = setup({ search: "?type=movie&id=550&provider=vidfast" });
  app.key("ArrowDown"); app.key("ArrowDown"); app.key("ArrowDown"); app.key("ArrowDown"); app.key("Enter");
  assert.equal(app.state(), "DIAGNOSTICS_OPEN");
  assert.equal(app.get("vidfast-compat-controls").hidden, false);
  assert.equal(app.get("compat-controls").hidden, true);
  assert.match(app.get("diag-vidfast-mode").textContent, /Baseline/);
  app.key("ArrowDown");
  assert.equal(app.document.activeElement.id, "vidfast-autoplay");
  app.key("Enter");
  assert.equal(app.get("player-frame").src, "https://vidfast.vc/movie/550?autoPlay=true");
  assert.match(app.get("diag-vidfast-mode").textContent, /Explicit autoPlay=true/);
  app.get("player-frame").fire("load");
  assert.match(app.get("diag-frame-events").textContent, /iframe load/);
  app.message({ type: "MEDIA_DATA", data: { t550: { id: 550 } } }, "https://vidfast.vc");
  app.message({ event: "status", data: 500 }, "https://vidfast.vc");
  assert.match(app.get("diag-assessment").textContent, /stream status 500; autoplay cause is unestablished/);
  assert.equal(app.get("player-loading").hidden, false);
  app.key("ArrowRight"); app.key("Enter");
  assert.equal(app.get("player-frame").src, "https://vidfast.vc/movie/550");
  assert.equal(app.get("diag-frame-events").textContent, "none observed");
  assert.match(app.get("diag-vidfast-mode").textContent, /Baseline/);
  assert.equal(app.posted.length, 0, "selector never sends postMessage Play");
});

test("temporary diagnostic panel is D-pad accessible and keeps Back and playback intact", () => {
  const app = setup({ search: "?type=movie&id=550&provider=vidfast" });
  app.key("ArrowDown"); app.key("ArrowDown"); app.key("ArrowDown"); app.key("ArrowDown");
  assert.equal(app.document.activeElement.id, "diagnostics-open");
  app.key("Enter");
  assert.equal(app.state(), "DIAGNOSTICS_OPEN");
  assert.equal(app.document.activeElement.id, "diagnostics-close");
  assert.equal(app.get("diagnostics-panel").hidden, false);
  assert.match(app.get("diag-user-agent").textContent, /Mock Vizio Test/);
  assert.match(app.get("diag-media-source").textContent, /MSE fMP4 AVC\/AAC yes/);
  assert.match(app.get("diag-permissions").textContent, /autoplay; fullscreen; picture-in-picture/);
  app.message({ type: "PLAYER_EVENT", data: { event: "play", currentTime: 0, duration: 100 } }, "https://wrong.test");
  assert.equal(app.get("diag-events").textContent, "none received");
  app.message({ type: "PLAYER_EVENT", data: { event: "play", currentTime: 0, duration: 100 } }, "https://vidfast.vc");
  assert.match(app.get("diag-events").textContent, /play/);
  app.advance(3000);
  assert.match(app.get("diag-elapsed").textContent, /3s since iframe launch/);
  app.key("Backspace");
  assert.equal(app.state(), "CONTROLS_VISIBLE");
  assert.equal(app.get("diagnostics-panel").hidden, true);
  assert.equal(app.document.activeElement.id, "diagnostics-open");
  app.key("Backspace");
  assert.equal(app.state(), "PLAYBACK_HIDDEN");
});

test("TV diagnostics are reachable without changing episode or sending Pico commands", () => {
  const sent = [];
  const app = setup({ adapter: { send(command) { sent.push(command); return Promise.resolve({ accepted: true }); } } });
  const original = app.get("player-frame").src;
  app.key("ArrowDown"); app.key("ArrowDown"); app.key("ArrowDown"); app.key("ArrowDown");
  assert.equal(app.document.activeElement.id, "diagnostics-open");
  app.key("Enter");
  assert.equal(app.state(), "DIAGNOSTICS_OPEN");
  assert.equal(app.get("player-frame").src, original);
  assert.deepEqual(sent, []);
  app.key("Backspace");
  assert.equal(app.document.activeElement.id, "diagnostics-open");
});

test("CineSrc is excluded from the experiment and never initializes", () => {
  const movieApp = setup({ search: "?type=movie&id=550&provider=cinesrc" });
  assert.equal(movieApp.get("player-frame").src, "https://yapgrid.com/embed/movie/550");
  assert.equal(movieApp.get("provider-choice").textContent, "Provider: YapGrid");

  const tvApp = setup({ search: "?showId=1396&season=1&episode=2&provider=cinesrc" });
  assert.match(tvApp.get("player-frame").src, /yapgrid\.com/);
  assert.equal(tvApp.get("provider-choice").textContent, "Provider: YapGrid");
});

test("iframe events and rejected direct-frame messages are distinct from VidFast events", () => {
  const app = setup({ search: "?type=movie&id=550&provider=vidfast" });
  app.key("ArrowDown"); app.key("ArrowDown"); app.key("ArrowDown"); app.key("ArrowDown"); app.key("Enter");
  app.get("player-frame").fire("load");
  assert.match(app.get("diag-frame-events").textContent, /iframe load/);
  assert.equal(app.get("diag-events").textContent, "none received");
  app.message({ type: "PLAYER_EVENT", data: { event: "play" } }, "https://wrong.test");
  app.message({ type: "unknown" }, "https://vidfast.vc");
  assert.equal(app.get("diag-events").textContent, "none received");
  assert.equal(app.get("diag-message-checks").textContent,
    "Direct-frame ignored: origin 1; envelope 1 (last: unknown)");
  app.message({ type: "PLAYER_EVENT", data: { event: "play", currentTime: 10, duration: 100 } }, "https://vidfast.vc");
  assert.match(app.get("diag-events").textContent, /play/);
  app.get("player-frame").fire("error");
  assert.match(app.get("diag-frame-events").textContent, /iframe load.*iframe error/);
  assert.doesNotMatch(app.get("diag-events").textContent, /iframe error/);
});

test("YapGrid diagnostics expose no CineSrc compatibility controls or URL changes", () => {
  const app = setup({ search: "?type=movie&id=550" });
  const original = app.get("player-frame").src;
  app.key("ArrowDown"); app.key("ArrowDown"); app.key("ArrowDown"); app.key("Enter");
  assert.equal(app.get("compat-controls").hidden, true);
  app.key("ArrowDown");
  assert.equal(app.document.activeElement.id, "diagnostics-close");
  assert.equal(app.get("player-frame").src, original);
  assert.equal(app.get("player-frame").sourceChanges, 1);
});

test("legacy VidFast route returns to YapGrid then enters VidBolt", () => {
  const app = setup({ search: "?type=movie&id=550&provider=vidfast" });
  assert.equal(app.get("player-frame").src, "https://vidfast.vc/movie/550");
  app.key("ArrowDown"); app.key("ArrowDown");
  assert.equal(app.document.activeElement.id, "provider-choice");
  app.key("Enter");
  assert.equal(app.get("player-frame").src, "https://yapgrid.com/embed/movie/550");
  assert.equal(app.get("provider-choice").textContent, "Provider: YapGrid");
  app.key("ArrowDown"); app.key("ArrowDown");
  assert.equal(app.document.activeElement.id, "provider-choice");
  app.key("Enter");
  assert.equal(app.get("player-frame").src, "https://vidbolt.xyz/movie/550?autoPlay=true");
  assert.equal(app.get("provider-choice").textContent, "Provider: VidBolt");
});

test("VidLink D-pad variants unload old frames and reset session diagnostics", () => {
  const app = setup({ search: "?type=movie&id=550&provider=vidlink" });
  assert.equal(app.get("player-frame").src, "https://vidlink.pro/movie/550?player=default&autoplay=false");
  app.key("ArrowDown"); app.key("ArrowDown"); app.key("ArrowDown"); app.key("ArrowDown");
  assert.equal(app.document.activeElement.id, "diagnostics-open");
  app.key("Enter");
  assert.equal(app.get("vidlink-compat-controls").hidden, false);
  app.key("ArrowDown");
  assert.equal(app.document.activeElement.id, "vidlink-default-off");
  app.key("ArrowRight");
  assert.equal(app.document.activeElement.id, "vidlink-default-on");
  app.message({ type: "MEDIA_DATA", data: { 550: {} } }, "https://vidlink.pro");
  assert.match(app.get("diag-events").textContent, /media_data/);
  const frameBefore = app.get("player-frame");
  app.key("Enter");
  assert.equal(app.get("player-frame").src, "https://vidlink.pro/movie/550?player=default&autoplay=true");
  assert.notEqual(app.get("player-frame"), frameBefore, "new iframe prevents stale source acceptance");
  assert.equal(app.get("diag-events").textContent, "none received");
  app.key("ArrowRight"); app.key("Enter");
  assert.equal(app.get("player-frame").src, "https://vidlink.pro/movie/550?player=jw&autoplay=true");
  app.key("ArrowLeft"); app.key("ArrowLeft"); app.key("Enter");
  assert.equal(app.get("player-frame").src, "https://vidlink.pro/movie/550?player=default&autoplay=false");
  app.key("Backspace");
  assert.equal(app.document.activeElement.id, "diagnostics-open");
  app.key("ArrowUp");
  assert.equal(app.document.activeElement.id, "unload-provider");
  app.key("Enter");
  assert.equal(app.get("player-frame").src, "about:blank");
});

test("VidLink rejects other provider messages and keeps errors visible after a play report", () => {
  const app = setup({ search: "?type=movie&id=550&provider=vidlink" });
  app.message({ type: "PLAYER_EVENT", data: { event: "play" } }, "https://vidfast.vc");
  assert.equal(app.get("player-loading").hidden, false);
  app.message({ type: "PLAYER_EVENT", data: { event: "error", error: "network_failure" } }, "https://vidlink.pro");
  assert.match(app.get("player-loading").textContent, /reports an error/);
  app.message({ type: "PLAYER_EVENT", data: { event: "play" } }, "https://vidlink.pro");
  assert.equal(app.get("player-loading").hidden, false);
  assert.match(app.get("screen-reader-status").textContent, /after an error/);
  app.key("ArrowDown"); app.key("ArrowDown"); app.key("ArrowDown");
  assert.equal(app.document.activeElement.id, "unload-provider");
  app.key("Enter");
  app.message({ type: "PLAYER_EVENT", data: { event: "play" } }, "https://vidlink.pro");
  assert.equal(app.get("player-frame").src, "about:blank");
  assert.equal(app.get("player-loading").hidden, false);
});

test("default VidLink input trial focuses iframe, preserves URL, and automatically restores Stop / Unload", () => {
  const app = setup({ search: "?type=movie&id=550&provider=vidlink" });
  const url = app.get("player-frame").src;
  app.get("player-frame").fire("load");
  app.key("ArrowDown"); app.key("ArrowDown"); app.key("ArrowDown"); app.key("ArrowDown"); app.key("Enter");
  app.key("ArrowDown"); app.key("ArrowRight"); app.key("ArrowRight"); app.key("ArrowRight");
  assert.equal(app.document.activeElement.id, "vidlink-focus-default");
  app.key("Enter");
  assert.equal(app.state(), "NATIVE_FOCUS");
  assert.equal(app.document.activeElement.id, "player-frame");
  assert.equal(app.get("player-frame").tabIndex, 0);
  assert.equal(app.get("player-shell").classList.contains("native-focus-trial"), true);
  assert.equal(app.key("Enter").delivered, false, "child-frame keys do not reach parent fixture");
  assert.equal(app.get("player-frame").src, url, "trial never reloads working provider");
  app.advance(12000);
  assert.equal(app.state(), "CONTROLS_VISIBLE");
  assert.equal(app.document.activeElement.id, "unload-provider");
  assert.equal(app.get("player-frame").tabIndex, -1);
  assert.equal(app.get("player-shell").classList.contains("native-focus-trial"), false);
  assert.equal(app.get("player-frame").src, url);
  app.key("ArrowDown"); app.key("Enter");
  assert.match(app.get("vidlink-focus-status").textContent, /iframe element focused; parent keys 0; return timeout/);
});

test("default VidLink input trial needs iframe load and parent Back can end it early", () => {
  const app = setup({ search: "?type=movie&id=550&provider=vidlink" });
  app.key("ArrowDown"); app.key("ArrowDown"); app.key("ArrowDown"); app.key("ArrowDown"); app.key("Enter");
  app.key("ArrowDown"); app.key("ArrowRight"); app.key("ArrowRight"); app.key("ArrowRight");
  app.key("Enter");
  assert.equal(app.state(), "DIAGNOSTICS_OPEN");
  assert.match(app.get("vidlink-compat-status").textContent, /Wait for iframe load/);
  app.get("player-frame").fire("load");
  app.key("Enter");
  assert.equal(app.state(), "NATIVE_FOCUS");
  assert.equal(app.parentKey("ArrowRight").prevented, false, "parent does not swallow keys during trial");
  const result = app.parentKey("Backspace");
  assert.equal(result.prevented, true);
  assert.equal(app.document.activeElement.id, "unload-provider");
  assert.equal(app.state(), "CONTROLS_VISIBLE");
  app.advance(12000);
  assert.equal(app.state(), "PLAYBACK_HIDDEN", "normal idle behavior resumes; trial timeout stays cleared");
  assert.equal(app.document.activeElement.id, "remote-capture");
});

test("JWPlayer comparison keeps its working autoplay URL and hides default-player input trial", () => {
  const app = setup({ search: "?type=movie&id=550&provider=vidlink" });
  app.key("ArrowDown"); app.key("ArrowDown"); app.key("ArrowDown"); app.key("ArrowDown"); app.key("Enter");
  app.key("ArrowDown"); app.key("ArrowRight"); app.key("ArrowRight"); app.key("Enter");
  assert.equal(app.get("player-frame").src, "https://vidlink.pro/movie/550?player=jw&autoplay=true");
  assert.equal(app.get("vidlink-focus-default").hidden, true);
  assert.equal(app.get("vidlink-focus-default").tabIndex, -1);
  app.key("ArrowRight");
  assert.equal(app.document.activeElement.id, "vidlink-default-off");
});

test("VidRift requests state and sends documented controls without involving the Pico bridge", () => {
  const app = setup({ search: "?type=movie&id=550&provider=vidrift" });
  assert.equal(app.get("player-frame").src, "https://embed.vidrift.net/embed/movie/550");
  assert.equal(app.get("player-frame").getAttribute("referrerpolicy"), "strict-origin-when-cross-origin");
  app.key("ArrowDown");
  app.get("diagnostics-open").click();
  assert.match(app.get("diag-permissions").textContent, /referrer: strict-origin-when-cross-origin/);
  app.get("diagnostics-close").click();
  assert.equal(app.get("player-frame").getAttribute("sandbox"), null);
  assert.equal(app.get("experimental-controls").hidden, false);
  assert.equal(app.get("play-pause").hidden, true);
  app.get("player-frame").fire("load");
  assert.equal(app.posted.length, 1);
  assert.equal(app.posted[0].origin, "https://embed.vidrift.net");
  assert.equal(app.posted[0].data.type, "vidrift:get-state");
  app.key("ArrowDown");
  assert.equal(app.document.activeElement.id, "experiment-play");
  app.key("Enter");
  assert.deepEqual(app.posted.map(item => item.data.type), ["vidrift:get-state", "vidrift:play"],
    "Play sends no automatic Pause");
  app.get("experiment-skip").click();
  assert.equal(app.posted.at(-1).data.type, "vidrift:skip", "relative Skip remains diagnostic only");
  const beforeSeek = app.posted.length;
  app.get("experiment-pause").click();
  app.get("experiment-back").click();
  app.get("experiment-forward").click();
  app.get("experiment-volume").click();
  app.get("experiment-unmute").click();
  assert.deepEqual(app.posted.map(item => JSON.stringify(item.data)), [
    '{"type":"vidrift:get-state"}', '{"type":"vidrift:play"}', '{"type":"vidrift:skip","seconds":10}', '{"type":"vidrift:pause"}',
    '{"type":"vidrift:get-state"}',
    '{"type":"vidrift:set","volume":0.5}', '{"type":"vidrift:set","muted":false}'
  ]);
  assert.equal(beforeSeek, 3);
  app.message({ type: "vidrift:state", tmdbId: 550, mediaType: "movie", paused: false,
    currentTime: 12, duration: 120, volume: 0.14999999999999997, muted: true,
    server: "vela", source: "0", audios: [{}], subtitles: [{}],
    servers: [{ value: "vela", state: "ready" }, { value: "nova", state: "failed" }] },
    "https://embed.vidrift.net");
  assert.match(app.get("provider-telemetry").textContent, /volume 15% muted; server vela, source 0; audio 1/);
  app.get("experiment-forward").click();
  assert.equal(JSON.stringify(app.posted.at(-1)),
    '{"data":{"type":"vidrift:resume","currentTime":22},"origin":"https://embed.vidrift.net"}');
  const pendingCount = app.posted.length;
  app.get("experiment-back").click();
  assert.equal(app.posted.length, pendingCount + 1, "a second seek requests state instead of stacking");
  assert.equal(app.posted.at(-1).data.type, "vidrift:get-state");
  app.message({ type: "vidrift:state", tmdbId: 550, mediaType: "movie", paused: true,
    currentTime: 22, duration: 120, volume: 0.15, muted: false, server: "vela", source: "0",
    servers: [{ value: "vela", state: "ready" }, { value: "nova", state: "failed" }] }, "https://embed.vidrift.net");
  app.get("experiment-back").click();
  assert.equal(app.posted.at(-1).data.currentTime, 12);
  app.message({ type: "vidrift:command-error",
    command: "vidrift:set", field: "muted", reason: "click-required" }, "https://embed.vidrift.net");
  assert.match(app.get("command-status").textContent, /click-required/);
  assert.match(app.get("command-status").textContent, /Try Focus player and press OK/);
  app.message({ type: "vidrift:ui-hidden", tmdbId: 550 }, "https://embed.vidrift.net");
  assert.match(app.get("command-status").textContent, /click-required/,
    "unrelated UI telemetry cannot mask a command error");
  app.get("diagnostics-open").click();
  assert.match(app.get("diag-message-checks").textContent, /accepted 3; rejected 1; last identity:missing-mediaType vidrift.ui-hidden/);
  assert.match(app.get("diag-events").textContent, /command-error vidrift:set muted click-required/);
  assert.match(app.get("diag-sources").textContent, /server vela; source 0; options vela ready, nova failed/);
  app.message({ type: "vidrift:command-error", command: "play", reason: "click-required" },
    "https://embed.vidrift.net");
  assert.match(app.get("command-status").textContent, /refused play: click-required/);
  app.message({ type: "vidrift:state", tmdbId: 550, mediaType: "movie", paused: true,
    currentTime: 12, duration: 120, volume: 0.5, muted: false }, "https://embed.vidrift.net");
  assert.match(app.get("provider-telemetry").textContent, /volume 50% unmuted/,
    "volume success is based on a subsequent reported state");
});

test("VidRift native focus trial is bounded and restores Stop / Unload without reloading", () => {
  const app = setup({ search: "?type=movie&id=550&provider=vidrift" });
  const url = app.get("player-frame").src;
  app.get("player-frame").fire("load");
  app.key("ArrowDown");
  app.get("experiment-focus").click();
  assert.equal(app.state(), "NATIVE_FOCUS");
  assert.equal(app.document.activeElement.id, "player-frame");
  assert.equal(app.get("player-shell").classList.contains("native-focus-trial"), true);
  app.advance(12000);
  assert.equal(app.state(), "CONTROLS_VISIBLE");
  assert.equal(app.document.activeElement.id, "unload-provider");
  assert.equal(app.get("player-frame").src, url);
  app.key("Enter");
  assert.equal(app.get("player-frame").src, "about:blank");
});

test("VidRift seeks only from fresh reported positions and keeps paused state separate", () => {
  const app = setup({ search: "?type=movie&id=550&provider=vidrift" });
  app.get("player-frame").fire("load");
  app.key("ArrowDown");
  app.get("experiment-forward").click();
  assert.deepEqual(app.posted.map(item => item.data.type), ["vidrift:get-state", "vidrift:get-state"]);
  app.message({ type: "vidrift:state", tmdbId: 550, mediaType: "movie", paused: true,
    currentTime: 95, duration: 100, volume: 0.15, muted: false }, "https://embed.vidrift.net");
  app.advance(9000);
  app.key("ArrowDown");
  app.get("experiment-forward").click();
  assert.equal(app.posted.at(-1).data.type, "vidrift:get-state", "paused stale position requests a snapshot");
  app.message({ type: "vidrift:state", tmdbId: 550, mediaType: "movie", paused: true,
    currentTime: 96, duration: 100, volume: 0.15, muted: false }, "https://embed.vidrift.net");
  app.get("experiment-forward").click();
  assert.equal(app.posted.at(-1).data.currentTime, 100, "seek clamps to duration");
  assert.equal(app.posted.at(-1).data.type, "vidrift:resume");
  assert.match(app.get("provider-telemetry").textContent, /time 96s/);
  const pendingCount = app.posted.length;
  app.get("experiment-back").click();
  assert.equal(app.posted.length, pendingCount + 1, "pending seek requests state, not another seek");
  assert.equal(app.posted.at(-1).data.type, "vidrift:get-state");
  app.message({ type: "vidrift:state", tmdbId: 550, mediaType: "movie", paused: true,
    currentTime: 100, duration: 100, volume: 0.15, muted: false }, "https://embed.vidrift.net");
  app.get("experiment-back").click();
  assert.equal(app.posted.at(-1).data.currentTime, 90);
});

test("VidRift seek timeout retries only after a fresh provider state", () => {
  const app = setup({ search: "?type=movie&id=550&provider=vidrift" });
  app.get("player-frame").fire("load");
  app.key("ArrowDown");
  app.message({ type: "vidrift:state", tmdbId: 550, mediaType: "movie", paused: true,
    currentTime: 40, duration: 100, volume: 0.15, muted: false }, "https://embed.vidrift.net");
  app.get("experiment-forward").click();
  assert.equal(app.posted.at(-1).data.currentTime, 50);
  app.advance(16000);
  app.key("ArrowDown");
  app.get("experiment-forward").click();
  assert.equal(app.posted.at(-1).data.type, "vidrift:get-state");
  app.message({ type: "vidrift:state", tmdbId: 550, mediaType: "movie", paused: true,
    currentTime: 43, duration: 100, volume: 0.15, muted: false }, "https://embed.vidrift.net");
  app.get("experiment-forward").click();
  assert.equal(app.posted.at(-1).data.currentTime, 53, "retry uses reported, not assumed, position");
});

test("VidBolt seeks only from recent validated timeupdate and autoplay toggle reloads", () => {
  const app = setup({ search: "?type=movie&id=550&provider=vidbolt" });
  assert.equal(app.get("player-frame").src, "https://vidbolt.xyz/movie/550?autoPlay=true");
  assert.match(app.get("player-frame").getAttribute("allow"), /encrypted-media/);
  assert.equal(app.get("player-frame").getAttribute("referrerpolicy"), "no-referrer");
  assert.equal(app.get("experiment-unmute").hidden, true);
  app.get("player-frame").fire("load");
  app.key("ArrowDown");
  app.get("forward").click();
  assert.equal(app.posted.length, 0);
  assert.match(app.get("command-status").textContent, /Wait for VidBolt ready/);
  app.message({ type: "ready" }, "https://vidbolt.xyz");
  app.get("forward").click();
  assert.equal(app.posted.length, 1);
  assert.equal(JSON.stringify(app.posted[0].data), '{"type":"volume","volume":1}');
  assert.match(app.get("command-status").textContent, /position is unavailable/);
  app.message({ type: "timeupdate", time: 8 }, "https://vidbolt.xyz");
  app.message({ type: "durationchange", duration: 100 }, "https://vidbolt.xyz");
  app.get("rewind").click();
  app.get("forward").click();
  assert.equal(app.posted.length, 2, "uncertain seek is not stacked on stale position");
  app.message({ type: "timeupdate", time: 0 }, "https://vidbolt.xyz");
  app.get("forward").click();
  assert.deepEqual(app.posted.map(item => JSON.stringify(item.data)), [
    '{"type":"volume","volume":1}', '{"type":"seek","time":0}', '{"type":"seek","time":10}'
  ]);
  app.advance(16000);
  app.key("ArrowDown");
  app.get("forward").click();
  assert.equal(app.posted.length, 3, "stale position is not used for seeking");
  app.get("diagnostics-open").click();
  app.key("ArrowDown");
  assert.equal(app.document.activeElement.id, "vidbolt-autoplay-toggle");
  app.key("Enter");
  assert.equal(app.get("player-frame").src, "https://vidbolt.xyz/movie/550");
  assert.equal(app.get("diag-events").textContent, "none received");
  app.key("Enter");
  assert.equal(app.get("player-frame").src, "https://vidbolt.xyz/movie/550?autoPlay=true");
});

function boltApp(search = "?type=movie&id=550&provider=vidbolt") {
  return setup({ search });
}
function boltProgress(app, first, second) {
  app.message({ type: "play" }, "https://vidbolt.xyz");
  app.message({ type: "timeupdate", time: first }, "https://vidbolt.xyz");
  app.advance(1000);
  app.message({ type: "timeupdate", time: second }, "https://vidbolt.xyz");
}
function boltDiagnostics(app) {
  if (app.state() !== "DIAGNOSTICS_OPEN") {
    if (app.state() === "PLAYBACK_HIDDEN") app.key("ArrowDown");
    app.get("diagnostics-open").click();
  }
  assert.equal(app.state(), "DIAGNOSTICS_OPEN");
  return app.get("diag-vidbolt-session").textContent;
}

test("VidBolt initializes internal volume once after ready, or after play if ready was missed", () => {
  for (const order of [["ready", "play"], ["play", "ready"]]) {
    const app = boltApp();
    const oldFrame = app.get("player-frame");
    for (const type of order) app.message({ type }, "https://vidbolt.xyz");
    app.message({ type: "timeupdate", time: 1 }, "https://vidbolt.xyz");
    app.message({ type: "timeupdate", time: 2 }, "https://vidbolt.xyz");
    assert.equal(app.posted.length, 1);
    assert.equal(JSON.stringify(app.posted[0].data), '{"type":"volume","volume":1}');
    assert.equal(app.posted[0].origin, "https://vidbolt.xyz");
    app.get("recover-provider").click(); // Hidden controls do not activate.
    assert.equal(app.get("player-frame"), oldFrame);
    const report = boltDiagnostics(app);
    assert.match(report, /volume 100% command sent .*no provider acknowledgement/);
    assert.match(report, /last advance 0s ago/);
  }
});

test("VidBolt hides manual Volume and does not repeat automatic initialization", () => {
  const app = boltApp();
  app.message({ type: "ready" }, "https://vidbolt.xyz");
  app.get("player-frame").fire("load");
  app.key("ArrowDown");
  assert.equal(app.get("experimental-controls").hidden, true);
  assert.equal(app.get("play-pause").hidden, false);
  app.get("experiment-volume").click();
  app.message({ type: "play" }, "https://vidbolt.xyz");
  app.message({ type: "timeupdate", time: 1 }, "https://vidbolt.xyz");
  app.message({ type: "timeupdate", time: 2 }, "https://vidbolt.xyz");
  assert.deepEqual(app.posted.map(item => JSON.stringify(item.data)), [
    '{"type":"volume","volume":1}'
  ]);
});

test("VidBolt retries volume only when the first postMessage throws", () => {
  const app = boltApp();
  const frame = app.get("player-frame");
  const send = frame.contentWindow.postMessage;
  let attempts = 0;
  frame.contentWindow.postMessage = function (data, origin) {
    attempts += 1;
    if (attempts === 1) throw new Error("transport unavailable");
    send(data, origin);
  };
  app.message({ type: "ready" }, "https://vidbolt.xyz");
  assert.equal(app.posted.length, 0);
  app.message({ type: "play" }, "https://vidbolt.xyz");
  app.message({ type: "timeupdate", time: 1 }, "https://vidbolt.xyz");
  assert.equal(attempts, 2);
  assert.equal(app.posted.length, 1);
  assert.equal(JSON.stringify(app.posted[0].data), '{"type":"volume","volume":1}');
});

test("VidBolt first actual progress initializes volume if ready and play were both missed", () => {
  const app = boltApp();
  app.message({ type: "timeupdate", time: 1 }, "https://vidbolt.xyz");
  assert.equal(app.posted.length, 0);
  app.message({ type: "timeupdate", time: 2 }, "https://vidbolt.xyz");
  assert.equal(JSON.stringify(app.posted[0].data), '{"type":"volume","volume":1}');
  app.message({ type: "timeupdate", time: 3 }, "https://vidbolt.xyz");
  assert.equal(app.posted.length, 1);
});

test("VidBolt accumulates small forward steps without mistaking duplicate positions for progress", () => {
  const app = boltApp();
  app.message({ type: "timeupdate", time: 10 }, "https://vidbolt.xyz");
  app.message({ type: "timeupdate", time: 10.1 }, "https://vidbolt.xyz");
  app.message({ type: "timeupdate", time: 10.2 }, "https://vidbolt.xyz");
  assert.match(boltDiagnostics(app), /last advance none/);
  app.message({ type: "timeupdate", time: 10.3 }, "https://vidbolt.xyz");
  assert.match(app.get("diag-vidbolt-session").textContent, /last confirmed 10.3s; last advance 0s ago/);
  app.message({ type: "timeupdate", time: 10.3 }, "https://vidbolt.xyz");
  const oldFrame = app.get("player-frame");
  app.advance(45000);
  assert.equal(app.get("player-frame"), oldFrame);
  assert.match(boltDiagnostics(app), /suspected-playback-stall: position stopped advancing/);
  assert.match(app.get("diag-vidbolt-session").textContent, /recovery 0 total/);
});

test("VidBolt startup requires advancing time, and repeated positions flag a suspected stall", () => {
  const app = boltApp();
  app.get("player-frame").fire("load");
  app.message({ type: "ready" }, "https://vidbolt.xyz");
  app.message({ type: "play" }, "https://vidbolt.xyz");
  app.message({ type: "timeupdate", time: 0 }, "https://vidbolt.xyz");
  app.advance(50000);
  app.message({ type: "timeupdate", time: 0 }, "https://vidbolt.xyz");
  assert.doesNotMatch(boltDiagnostics(app), /watchdog suspected stalled/);
  const firstFrame = app.get("player-frame");
  app.advance(10000);
  assert.equal(app.get("player-frame"), firstFrame);
  assert.match(boltDiagnostics(app), /suspected-startup-stall: ready\/play reported; position not advancing/);
  assert.equal(app.get("player-loading").hidden, true);
  app.message({ type: "timeupdate", time: 1 }, "https://vidbolt.xyz");
  app.message({ type: "timeupdate", time: 2 }, "https://vidbolt.xyz");
  assert.match(boltDiagnostics(app), /watchdog progressing/);
  assert.match(app.get("diag-vidbolt-session").textContent, /progress resumed; suspicion cleared/);
});

test("VidBolt sustained or resumed position advancement prevents automatic recovery", () => {
  const app = boltApp();
  boltProgress(app, 0, 1);
  const active = app.get("player-frame");
  for (let position = 2; position <= 5; position++) {
    app.advance(30000);
    app.message({ type: "timeupdate", time: position }, "https://vidbolt.xyz");
  }
  assert.equal(app.get("player-frame"), active);
  assert.match(boltDiagnostics(app), /recovery 0 total, 0\/1 automatic/);
  app.advance(40000);
  app.message({ type: "timeupdate", time: 6 }, "https://vidbolt.xyz");
  assert.equal(app.get("player-frame"), active);
  assert.match(app.get("diag-vidbolt-session").textContent, /watchdog progressing/);
});

test("VidBolt watchdog excludes pause, ended, and seek transition, then resumes monitoring", () => {
  const app = boltApp();
  boltProgress(app, 20, 21);
  app.message({ type: "pause" }, "https://vidbolt.xyz");
  app.advance(90000);
  assert.doesNotMatch(app.get("player-loading").textContent, /suspected-/);
  app.message({ type: "play" }, "https://vidbolt.xyz");
  app.advance(40000);
  assert.doesNotMatch(app.get("player-loading").textContent, /suspected-/);
  app.get("player-frame").fire("load");
  app.message({ type: "timeupdate", time: 21.5 }, "https://vidbolt.xyz");
  app.key("ArrowDown");
  app.get("experiment-forward").click();
  app.advance(25000);
  assert.doesNotMatch(app.get("player-loading").textContent, /suspected-/);
  app.message({ type: "ended" }, "https://vidbolt.xyz");
  app.advance(90000);
  assert.doesNotMatch(app.get("player-loading").textContent, /suspected-/);
});

test("VidBolt Auto Recover defaults on, but only an active iframe error triggers it", () => {
  const app = boltApp();
  const initialFrame = app.get("player-frame");
  boltDiagnostics(app);
  assert.match(app.get("vidbolt-auto-recover").textContent, /ON/);
  app.get("vidbolt-auto-recover").click();
  assert.match(app.get("vidbolt-auto-recover").textContent, /OFF/);
  app.advance(60000);
  assert.equal(app.get("player-frame"), initialFrame);
  assert.match(boltDiagnostics(app), /suspected-startup-stall/);
  assert.equal(app.get("player-loading").hidden, true);
  initialFrame.fire("error");
  assert.equal(app.get("player-frame"), initialFrame);
  assert.match(boltDiagnostics(app), /skipped: Auto Recover OFF/);
  app.get("vidbolt-auto-recover").click();
  assert.match(app.get("vidbolt-auto-recover").textContent, /ON/);
  initialFrame.fire("error");
  const recoveryFrame = app.get("player-frame");
  assert.notEqual(recoveryFrame, initialFrame);
  assert.equal(recoveryFrame.src, "https://vidbolt.xyz/movie/550?autoPlay=true");
  assert.match(boltDiagnostics(app), /1\/1 automatic; last iframe-error; iframe load not observed/);
  app.advance(65000);
  assert.equal(app.get("player-frame"), recoveryFrame);
  assert.match(boltDiagnostics(app), /result no advancing position after recovery/);
  assert.equal(app.get("player-loading").hidden, true);
});

test("VidBolt playback stall stays diagnostic, then iframe error recovers once with position", () => {
  const app = boltApp();
  boltProgress(app, 4, 5);
  boltDiagnostics(app);
  assert.match(app.get("vidbolt-auto-recover").textContent, /ON/);
  const oldFrame = app.get("player-frame");
  app.advance(50000);
  assert.equal(app.get("player-frame"), oldFrame);
  assert.match(boltDiagnostics(app), /suspected-playback-stall/);
  oldFrame.fire("error");
  assert.notEqual(app.get("player-frame"), oldFrame);
  assert.equal(app.get("player-frame").src,
    "https://vidbolt.xyz/movie/550?autoPlay=true&startAt=5");
  assert.match(app.get("diag-vidbolt-session").textContent,
    /1\/1 automatic; last iframe-error; position stopped advancing; resume 5s/);
  app.advance(60000);
  assert.match(boltDiagnostics(app), /result no advancing position after recovery/);
  assert.match(app.get("diag-vidbolt-session").textContent, /1\/1 automatic/);
  const replacement = app.get("player-frame");
  replacement.fire("error");
  assert.equal(app.get("player-frame"), replacement);
  assert.match(boltDiagnostics(app), /skipped: automatic recovery limit reached/);
});

test("VidBolt shows the exact remaining stall time and never reloads on missing progress alone", () => {
  const app = boltApp();
  boltProgress(app, 4, 5);
  const frame = app.get("player-frame");
  app.advance(35000);
  assert.match(boltDiagnostics(app), /watchdog progressing; progress threshold in 10s/);
  app.advance(14000);
  assert.equal(app.get("player-frame"), frame);
  assert.match(app.get("diag-vidbolt-session").textContent,
    /watchdog suspected stalled \(suspected-playback-stall: position stopped advancing\)/);
  assert.match(app.get("diag-vidbolt-session").textContent, /recovery 0 total/);
  assert.equal(app.get("player-loading").hidden, true);
});

test("VidBolt short initial advance to 6.31s remains ambiguous until fresh progress resumes", () => {
  const app = boltApp();
  app.message({ type: "ready" }, "https://vidbolt.xyz");
  app.message({ type: "play" }, "https://vidbolt.xyz");
  app.message({ type: "timeupdate", time: 5.9 }, "https://vidbolt.xyz");
  app.advance(1000);
  app.message({ type: "timeupdate", time: 6.31 }, "https://vidbolt.xyz");
  const frame = app.get("player-frame");
  app.advance(50000);
  app.message({ type: "timeupdate", time: 6.31 }, "https://vidbolt.xyz");
  assert.match(boltDiagnostics(app), /suspected-playback-stall/);
  assert.equal(app.get("player-frame"), frame);
  assert.match(app.get("diag-vidbolt-session").textContent, /recovery 0 total/);
  app.message({ type: "timeupdate", time: 6.7 }, "https://vidbolt.xyz");
  assert.match(app.get("diag-vidbolt-session").textContent, /watchdog progressing/);
  assert.equal(app.get("player-frame"), frame);
});

test("VidBolt iframe errors skip automatic recovery when paused, seeking or ended", () => {
  for (const mode of ["pause", "seek", "ended"]) {
    const app = boltApp();
    const frame = app.get("player-frame");
    frame.fire("load");
    app.message({ type: "ready" }, "https://vidbolt.xyz");
    app.message({ type: "timeupdate", time: 20 }, "https://vidbolt.xyz");
    if (mode === "pause") app.message({ type: "pause" }, "https://vidbolt.xyz");
    if (mode === "ended") app.message({ type: "ended" }, "https://vidbolt.xyz");
    if (mode === "seek") {
      app.key("ArrowDown");
      app.get("forward").click();
    }
    frame.fire("error");
    assert.equal(app.get("player-frame"), frame, mode);
    if (app.state() === "PLAYBACK_HIDDEN") app.key("ArrowDown");
    app.get("diagnostics-open").click();
    assert.match(app.get("diag-vidbolt-session").textContent, /active iframe error; skipped:/);
    assert.equal(app.get("player-loading").hidden, true);
    app.key("Backspace");
    app.get("recover-provider").click();
    assert.notEqual(app.get("player-frame"), frame, mode);
  }
});

test("obsolete iframe load and messages cannot affect automatic recovery generation", () => {
  const app = boltApp();
  const oldFrame = app.get("player-frame");
  oldFrame.fire("error");
  const active = app.get("player-frame");
  assert.notEqual(active, oldFrame);
  assert.equal(oldFrame.src, "about:blank");
  oldFrame.fire("load");
  app.message({ type: "ready" }, "https://vidbolt.xyz", oldFrame.contentWindow);
  app.message({ type: "timeupdate", time: 999 }, "https://vidbolt.xyz", oldFrame.contentWindow);
  assert.equal(app.posted.length, 0);
  assert.match(boltDiagnostics(app), /Session 2 .*iframe loads 0, last none; parent URL assignments 1/);
  assert.match(app.get("diag-vidbolt-session").textContent, /result awaiting position advance/);
  app.message({ type: "ready" }, "https://vidbolt.xyz");
  assert.equal(app.posted.length, 1);
  assert.equal(JSON.stringify(app.posted[0].data), '{"type":"volume","volume":1}');
});

test("VidBolt startup diagnostics distinguish loaded-but-never-ready from media progression", () => {
  const app = boltApp();
  app.get("player-frame").fire("load");
  app.advance(55000);
  assert.match(boltDiagnostics(app), /suspected-startup-stall: iframe loaded; no ready or play/);
  assert.match(app.get("diag-vidbolt-session").textContent, /recovery 0 total/);
  assert.match(app.get("diag-vidbolt-session").textContent, /volume 100% not sent/);
});

test("VidBolt manual recovery restores only confirmed same-title position and rejects old iframe", () => {
  const app = boltApp();
  const oldFrame = app.get("player-frame");
  boltProgress(app, 10, 11.5);
  const sentBeforeRecovery = app.posted.length;
  app.key("ArrowDown"); app.key("ArrowDown"); app.key("ArrowRight"); app.key("ArrowRight");
  assert.equal(app.document.activeElement.id, "recover-provider");
  app.key("Enter");
  assert.equal(app.get("player-frame").src, "https://vidbolt.xyz/movie/550?autoPlay=true&startAt=11.5");
  assert.equal(oldFrame.src, "about:blank");
  app.message({ type: "ready" }, "https://vidbolt.xyz", oldFrame.contentWindow);
  assert.equal(app.posted.length, sentBeforeRecovery);
  app.message({ type: "ready" }, "https://vidbolt.xyz");
  assert.equal(JSON.stringify(app.posted.at(-1).data), '{"type":"volume","volume":1}');
  app.get("diagnostics-open").click();
  app.get("vidbolt-stop").click();
  assert.equal(app.get("player-frame").src, "about:blank");
  app.advance(120000);
  assert.doesNotMatch(app.get("player-loading").textContent, /suspected-/);
});

test("VidBolt episode identity and provider switches never reuse another position", () => {
  const episode = boltApp("?showId=1396&season=1&episode=2&provider=vidbolt");
  boltProgress(episode, 34, 35);
  episode.key("ArrowDown"); episode.key("ArrowDown"); episode.key("ArrowDown");
  episode.key("ArrowRight"); episode.key("ArrowRight"); episode.key("Enter");
  assert.match(episode.get("player-frame").src, /\/tv\/1396\/1\/2\?autoPlay=true&startAt=35$/);
  const next = boltApp("?showId=1396&season=1&episode=3&provider=vidbolt");
  assert.equal(next.get("player-frame").src, "https://vidbolt.xyz/tv/1396/1/3?autoPlay=true");
  const old = next.get("player-frame");
  next.key("ArrowDown"); next.get("provider-choice").click();
  assert.equal(next.get("provider-choice").textContent, "Provider: YapGrid");
  assert.notEqual(next.get("player-frame"), old);
});

test("VidBolt play/pause uses validated state, preserves focus, and bounds pending presses", () => {
  const app = boltApp();
  app.get("player-frame").fire("load");
  app.message({ type: "ready" }, "https://vidbolt.xyz");
  app.key("ArrowDown");
  const button = app.get("play-pause");
  const label = app.get("play-pause-label");
  assert.equal(app.document.activeElement, button);
  assert.equal(label.textContent, "Play / Pause");
  assert.match(button.getAttribute("aria-label"), /state unknown/);
  app.key("Enter");
  assert.equal(app.posted.at(-1).data.type, "play");
  app.key("Enter");
  assert.equal(app.posted.filter(item => item.data.type === "play").length, 1);
  app.message({ type: "pause" }, "https://vidbolt.xyz"); // Late opposite event is ignored while Play is pending.
  assert.match(label.textContent, /Play…/);
  app.message({ type: "play" }, "https://vidbolt.xyz");
  assert.equal(label.textContent, "Pause");
  assert.equal(app.document.activeElement, button);
  app.advance(800);
  app.key("Enter");
  assert.equal(app.posted.at(-1).data.type, "pause");
  app.key("Enter");
  assert.equal(app.posted.filter(item => item.data.type === "pause").length, 1);
  app.message({ type: "pause" }, "https://vidbolt.xyz");
  assert.equal(label.textContent, "Play");
  assert.equal(app.document.activeElement, button);
});

test("VidBolt missing play/pause response returns to unknown without contradictory command", () => {
  const app = boltApp();
  app.get("player-frame").fire("load");
  app.message({ type: "ready" }, "https://vidbolt.xyz");
  app.message({ type: "play" }, "https://vidbolt.xyz");
  app.key("ArrowDown");
  app.key("Enter");
  assert.equal(app.posted.at(-1).data.type, "pause");
  app.advance(3000);
  assert.equal(app.get("play-pause-label").textContent, "Play / Pause");
  assert.match(app.get("play-pause").getAttribute("aria-label"), /state unknown/);
  app.key("Enter");
  assert.equal(app.posted.at(-1).data.type, "play");
});

test("VidBolt unconfirmed user Pause does not trigger automatic recovery", () => {
  const app = boltApp();
  app.get("player-frame").fire("load");
  boltProgress(app, 20, 21);
  app.key("ArrowDown");
  app.key("Enter");
  const active = app.get("player-frame");
  app.advance(70000);
  assert.equal(app.get("player-frame"), active);
  assert.match(boltDiagnostics(app), /state pause requested, unconfirmed/);
});

test("VidBolt shared seek buttons send one clamped absolute 10s or 10m seek", () => {
  for (const [direction, repeats, expected] of [
    ["ArrowLeft", 0, 110], ["ArrowRight", 0, 130],
    ["ArrowLeft", 5, 0], ["ArrowRight", 5, 700],
  ]) {
    const app = boltApp();
    app.get("player-frame").fire("load");
    app.message({ type: "ready" }, "https://vidbolt.xyz");
    app.message({ type: "durationchange", duration: 700 }, "https://vidbolt.xyz");
    app.message({ type: "timeupdate", time: 120 }, "https://vidbolt.xyz");
    app.key("ArrowDown"); app.key(direction);
    for (let i = 0; i < repeats; i++) app.key(direction, true);
    assert.equal(app.posted.filter(item => item.data.type === "seek").length, 0);
    app.key("Enter");
    assert.equal(JSON.stringify(app.posted.at(-1).data), '{"type":"seek","time":' + expected + '}');
    assert.equal(app.posted.filter(item => item.data.type === "seek").length, 1);
  }
});

test("VidBolt shared seek lock expires only after a fresh reported position", () => {
  const app = boltApp();
  app.get("player-frame").fire("load");
  app.message({ type: "ready" }, "https://vidbolt.xyz");
  app.message({ type: "timeupdate", time: 120 }, "https://vidbolt.xyz");
  app.key("ArrowDown"); app.key("ArrowRight"); app.key("Enter");
  assert.equal(JSON.stringify(app.posted.at(-1).data), '{"type":"seek","time":130}');
  app.advance(20000);
  app.key("ArrowDown"); app.key("ArrowRight"); app.key("Enter");
  assert.equal(app.posted.filter(item => item.data.type === "seek").length, 1);
  app.message({ type: "timeupdate", time: 120 }, "https://vidbolt.xyz");
  app.key("Enter");
  assert.equal(JSON.stringify(app.posted.at(-1).data), '{"type":"seek","time":130}');
  assert.equal(app.posted.filter(item => item.data.type === "seek").length, 2);
});

test("VidBolt Left/Right use YapGrid levels and OK commits one absolute seek", () => {
  const app = boltApp();
  app.get("player-frame").fire("load");
  app.message({ type: "ready" }, "https://vidbolt.xyz");
  app.message({ type: "timeupdate", time: 900 }, "https://vidbolt.xyz");
  app.key("ArrowDown");
  app.key("ArrowLeft");
  assert.equal(app.document.activeElement.id, "rewind");
  app.key("ArrowLeft");
  assert.match(app.get("command-status").textContent, /Rewind −30s · target 14:30/);
  for (const label of ["1m", "2m", "5m", "10m"]) {
    app.key("ArrowLeft", true);
    assert.equal(app.get("rewind-label").textContent, "−" + label);
  }
  assert.match(app.get("command-status").textContent, /target 5:00/);
  assert.equal(app.posted.filter(item => item.data.type === "seek").length, 0);
  app.keyup("ArrowLeft");
  assert.equal(app.posted.filter(item => item.data.type === "seek").length, 0);
  app.key("Enter");
  assert.equal(JSON.stringify(app.posted.at(-1).data), '{"type":"seek","time":300}');
  app.key("Enter", true);
  assert.equal(app.posted.filter(item => item.data.type === "seek").length, 1);
});

test("VidBolt inward Left/Right reduces the jump then returns to Play/Pause at 10 seconds", () => {
  const app = boltApp();
  app.key("ArrowDown"); app.key("ArrowLeft");
  assert.equal(app.document.activeElement.id, "rewind");
  app.key("ArrowLeft"); app.key("ArrowLeft");
  assert.equal(app.get("rewind-label").textContent, "−1m");
  app.key("ArrowRight");
  assert.equal(app.get("rewind-label").textContent, "−30s");
  app.key("ArrowRight");
  assert.equal(app.get("rewind-label").textContent, "−10s");
  app.key("ArrowRight");
  assert.equal(app.document.activeElement.id, "play-pause");
  app.key("ArrowRight");
  assert.equal(app.document.activeElement.id, "forward");
  app.key("ArrowLeft");
  assert.equal(app.document.activeElement.id, "play-pause");
  assert.equal(app.posted.filter(item => item.data.type === "seek").length, 0);
});

test("VidBolt repeat selection needs OK and resets on Back, stale position and iframe replacement", () => {
  const app = boltApp();
  app.get("player-frame").fire("load");
  app.message({ type: "ready" }, "https://vidbolt.xyz");
  app.message({ type: "timeupdate", time: 100 }, "https://vidbolt.xyz");
  app.key("ArrowDown"); app.key("ArrowRight");
  assert.equal(app.document.activeElement.id, "forward");
  app.key("ArrowRight", true); app.key("ArrowRight", true);
  assert.equal(app.get("forward-label").textContent, "+1m");
  app.blur(); app.advance(1000); app.keyup("ArrowRight");
  assert.equal(app.posted.filter(item => item.data.type === "seek").length, 0);
  app.key("ArrowUp");
  assert.equal(app.document.activeElement.id, "play-pause");
  app.key("ArrowDown"); app.key("ArrowRight"); app.key("ArrowRight");
  app.key("Backspace");
  assert.equal(app.get("forward-label").textContent, "+10s");
  app.advance(16000);
  app.key("ArrowDown"); app.key("ArrowRight");
  app.key("Enter");
  assert.equal(app.posted.filter(item => item.data.type === "seek").length, 0);
  assert.match(app.get("command-status").textContent, /position is unavailable or stale/);
  app.get("recover-provider").click();
  app.advance(1000);
  assert.equal(app.posted.filter(item => item.data.type === "seek").length, 0);
});

test("VidBolt diagnostics separate repeated iframe load events from parent URL assignments", () => {
  const app = boltApp();
  const active = app.get("player-frame");
  app.advance(1000); active.fire("load");
  app.advance(10000); active.fire("load");
  assert.equal(app.get("player-frame"), active);
  const report = boltDiagnostics(app);
  assert.match(report, /iframe loads 2, last \+11\.0s; parent URL assignments 1/);
  assert.match(app.get("diag-frame-events").textContent, /\+1s iframe load.*\+11s iframe load/);
  assert.match(report, /watchdog initializing; progress threshold in 44s/);
});

test("VidBolt has no second playback row or native-focus button in the main bar", () => {
  const app = boltApp();
  const frame = app.get("player-frame");
  frame.fire("load");
  app.key("ArrowDown");
  assert.equal(app.get("experimental-controls").hidden, true);
  assert.equal(app.get("experiment-focus").hidden, true);
  assert.equal(app.get("play-pause").hidden, false);
  assert.equal(app.get("rewind").hidden, false);
  assert.equal(app.get("forward").hidden, false);
  app.get("experiment-focus").click();
  assert.equal(app.state(), "CONTROLS_VISIBLE");
  assert.equal(app.document.activeElement.id, "play-pause");
  assert.equal(app.get("player-frame"), frame);
  assert.doesNotMatch(html, /id="experiment-(?:back|forward)-fast"/);
});

test("VidBolt native CC trial lives in Diagnostics and returns to a visible focus target", () => {
  const app = boltApp();
  const frame = app.get("player-frame");
  frame.fire("load");
  app.key("ArrowDown"); app.get("diagnostics-open").click();
  app.key("ArrowDown");
  for (let i = 0; i < 3; i++) app.key("ArrowRight");
  assert.equal(app.document.activeElement.id, "vidbolt-native-focus");
  app.key("Enter");
  assert.equal(app.state(), "NATIVE_FOCUS");
  assert.equal(app.document.activeElement, frame);
  app.advance(30000);
  assert.equal(app.state(), "CONTROLS_VISIBLE");
  assert.equal(app.document.activeElement.id, "diagnostics-open");
  assert.equal(app.get("player-frame"), frame);
});

test("VidBolt passively counts validated mobile subtitle rows without applying a track", () => {
  const app = boltApp();
  const frame = app.get("player-frame");
  const panel = { type: "mobile-panel", options: [
    { option: "subtitles", group: "Subtitles", value: "0", label: "English" },
    { option: "subtitles", group: "Subtitles", value: "-1", label: "Off" },
  ] };
  app.message(panel, "https://other.test");
  app.message(panel, "https://vidbolt.xyz", {});
  assert.match(boltDiagnostics(app), /mobile-panel messages 0, subtitle rows 0/);
  app.message(panel, "https://vidbolt.xyz", frame.contentWindow);
  assert.match(app.get("diag-vidbolt-session").textContent, /mobile-panel messages 1, subtitle rows 2/);
  assert.equal(app.posted.length, 0);
});

test("VidBolt Auto Recover opt-out survives manual reload and provider switching", () => {
  const app = boltApp();
  boltDiagnostics(app);
  app.get("vidbolt-auto-recover").click();
  assert.match(app.get("vidbolt-auto-recover").textContent, /OFF/);
  app.key("Backspace");
  app.get("recover-provider").click();
  app.advance(60000);
  assert.match(boltDiagnostics(app), /watchdog recovery failed.*progress threshold reached/);
  app.key("Backspace");
  app.key("ArrowDown"); app.key("ArrowUp"); app.key("ArrowLeft"); app.key("ArrowLeft"); app.key("Enter");
  assert.equal(app.get("provider-choice").textContent, "Provider: YapGrid");
  app.key("ArrowDown"); app.key("ArrowDown"); app.key("Enter");
  assert.equal(app.get("provider-choice").textContent, "Provider: VidBolt");
  boltDiagnostics(app);
  assert.match(app.get("vidbolt-auto-recover").textContent, /OFF/);
});

test("provider switch rejects stale messages and VidBolt Stop / Unload stays reachable in diagnostics", () => {
  const app = setup({ search: "?type=movie&id=550" });
  const oldFrame = app.get("player-frame");
  app.key("ArrowDown"); app.key("ArrowDown");
  assert.equal(app.document.activeElement.id, "provider-choice");
  app.key("Enter");
  assert.equal(app.get("player-frame").src, "https://vidbolt.xyz/movie/550?autoPlay=true");
  app.message({ type: "ready" }, "https://vidbolt.xyz", oldFrame.contentWindow);
  assert.equal(app.posted.length, 0);
  app.get("player-frame").fire("load");
  app.message({ type: "ready" }, "https://vidbolt.xyz");
  assert.equal(app.posted.length, 1);
  app.key("ArrowDown"); app.get("diagnostics-open").click();
  app.key("ArrowDown"); app.key("ArrowRight"); app.key("ArrowRight");
  assert.equal(app.document.activeElement.id, "vidbolt-stop");
  app.key("Enter");
  assert.equal(app.get("player-frame").src, "about:blank");
});

test("TV VidFast selection retains TMDB episode and provider through episode navigation", async () => {
  const app = setup({ search: "?showId=1396&season=1&episode=2&provider=vidfast&name=Breaking%20Bad" });
  assert.equal(app.get("player-frame").src, "https://vidfast.vc/tv/1396/1/2");
  app.key("ArrowDown");
  app.key("ArrowDown");
  app.key("ArrowDown");
  assert.equal(app.document.activeElement.id, "provider-choice");
  app.key("ArrowUp");
  app.key("ArrowUp");
  app.key("ArrowRight");
  assert.equal(app.document.activeElement.id, "forward");
  app.message({ type: "PLAYER_EVENT", data: { event: "timeupdate", currentTime: 30, duration: 1800 } }, "https://vidfast.vc");
  assert.match(app.get("provider-telemetry").textContent, /VidFast reports 30s/);
  assert.equal(app.get("player-frame").src, "https://vidfast.vc/tv/1396/1/2");
  const target = { showId: 1396, season: 1, episode: 3 };
  const episodes = catalog();
  assert.equal(episodes.pageUrl(target, "off", false, null, true, "Breaking Bad", null, "vidfast"),
    "player-overlay.html?season=1&episode=3&sub=off&showId=1396&from=search&name=Breaking%20Bad&provider=vidfast");
  await flush();
});

test("search-launched real-show player uses the same full-size seek batch path", async () => {
  for (const direction of ["forward", "rewind"]) {
    const sent = [];
    const app = setup({ search: "?showId=1396&season=1&episode=2&sub=off&from=search&name=Breaking%20Bad",
      adapter: {
        open: () => Promise.resolve(), ready: () => Promise.resolve(), close() {}, send() {},
        sendBatch(command, count) { sent.push([command, count]); return Promise.resolve({ id: "search-seek" }); },
        batchStatus() { return Promise.resolve({ id: "search-seek", state: "complete",
          code: "keylist_acknowledged", acknowledged: 60 }); },
      } });
    await startBatch(app, direction, 5);
    assert.match(app.get("player-frame").src, /\/embed\/tv\/1396\/1\/2\?sub_url=/);
    assert.deepEqual(sent, [[direction === "forward" ? "seek_forward" : "seek_backward", 60]]);
    assert.equal(app.document.activeElement.id, direction);
    assert.match(app.get("command-status").textContent, /KEYLIST request acknowledged for 60 inputs/);
  }
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

test("Cyberpunk original TVDB identity retains Season 2 numbering and rejects the separate sequel", async () => {
  const episodes = catalog();
  const rows = Array.from({ length: 10 }, (_, i) => ({ season: 1, number: i + 1,
    name: "Original " + (i + 1), type: "regular", airdate: "2022-09-13" })).concat(
    Array.from({ length: 10 }, (_, i) => ({ season: 2, number: i + 1,
      name: ["Last Chance for a Slow Dance", "Give Me Another Day", "0 + 2 = 1"][i]
        || "Sequel " + (i + 1), type: "regular", airdate: "2026-10-20" })));
  const urls = [];
  const resolver = episodes.createResolver({ showId: 105248, tvdbId: 384541,
    today: "2026-10-29", storage: {}, clock: { setTimeout, clearTimeout },
    fetch: async url => { urls.push(url);
      return { ok: true, json: async () => url.includes("lookup")
        ? { id: 48945, externals: { thetvdb: 384541 } } : rows }; } });
  const current = { showId: 105248, season: 2, episode: 2 };
  assert.deepEqual(JSON.parse(JSON.stringify((await resolver.resolve(current, 1)).target)),
    { showId: 105248, season: 2, episode: 3, title: "0 + 2 = 1" });
  assert.equal((await resolver.resolve({ ...current, episode: 3 }, -1)).target.episode, 2);
  assert.equal((await resolver.resolve({ ...current, episode: 10 }, 1)).kind, "none_known");
  assert.equal((await resolver.resolve({ ...current, season: 1, episode: 10 }, 1)).target.season, 2);
  assert.deepEqual(urls, ["https://api.tvmaze.com/lookup/shows?thetvdb=384541",
    "https://api.tvmaze.com/shows/48945/episodes"]);
  assert.match(episodes.pageUrl(current, "off", false, null, true, "Cyberpunk", 384541), /tvdb=384541$/);
  const wrong = episodes.createResolver({ showId: 105248, tvdbId: 384541,
    storage: {}, clock: { setTimeout, clearTimeout }, fetch: async () => ({ ok: true,
      json: async () => ({ id: 88337, externals: { thetvdb: null } }) }) });
  assert.equal((await wrong.resolve(current, 1)).kind, "unknown");
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

test("VidFast episode transition keeps the selected provider and TMDB show ID", async () => {
  const app = setup({ search: "?season=13&episode=2&sub=off&provider=vidfast" });
  app.key("ArrowUp"); app.key("ArrowRight"); app.key("ArrowDown"); app.key("Enter");
  await flush();
  assert.match(app.get("command-status").textContent, /VidFast playback unknown/);
  app.key("Enter");
  assert.deepEqual(app.navigation, ["player-overlay.html?season=13&episode=3&sub=off&provider=vidfast"]);
  const loaded = setup({ search: "?season=13&episode=3&sub=off&provider=vidfast" });
  assert.equal(loaded.get("player-frame").src,
    "https://vidfast.vc/tv/2190/13/3");
});

test("VidFast subtitle button does not claim an unverified provider setting", () => {
  const app = setup({ search: "?season=13&episode=2&provider=vidfast" });
  app.key("ArrowUp"); app.key("ArrowDown");
  assert.equal(app.document.activeElement.id, "subtitles");
  app.key("Enter");
  assert.equal(app.state(), "CONTROLS_VISIBLE");
  assert.equal(app.get("player-frame").sourceChanges, 1);
  assert.match(app.get("command-status").textContent, /no tested VidFast subtitle selection/);
});

test("switching provider retains the TVmaze metadata link and updates its provider credit", () => {
  assert.match(html, /id="metadata-credit"[^>]*>Episode metadata: <a href="https:\/\/www\.tvmaze\.com/);
  const app = setup();
  assert.equal(app.get("metadata-provider-credit").textContent, "YapGrid playback availability is unverified");
  app.key("ArrowDown"); app.key("ArrowDown"); app.key("ArrowDown"); app.key("Enter");
  assert.equal(app.get("metadata-provider-credit").textContent, "VidBolt playback availability is unverified");
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

test("Episode List preserves a manually chosen VidFast provider", () => {
  const nodes = {
    "return-player": { href: "", focus() {} },
    "return-episode": { textContent: "" },
  };
  const window = {
    location: { search: "?season=13&episode=3&sub=off&provider=vidfast", origin: previewOrigin },
    document: { getElementById(id) { return nodes[id]; }, addEventListener() {} },
  };
  runInNewContext(catalogScript, { window });
  runInNewContext(listScript, { window });
  assert.equal(nodes["return-player"].href,
    "player-overlay.html?season=13&episode=3&sub=off&provider=vidfast");
});

test("subtitle reload keeps the selected episode while switching mode", () => {
  const app = setup({ search: "?season=13&episode=3&sub=off" });
  app.key("ArrowUp"); app.key("ArrowDown"); app.key("Enter");
  app.key("ArrowRight"); app.key("Enter");
  app.key("ArrowRight"); app.key("Enter");
  assert.deepEqual(app.navigation, ["player-overlay.html?season=13&episode=3&sub=on"]);
});
