import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { runInNewContext } from "node:vm";

const SINTEL_UPSTREAM = "https://media.w3.org/2010/05/sintel/trailer.mp4";
const FLOWER_UPSTREAM = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";

const source = readFileSync(new URL("../video-lab/video-lab.js", import.meta.url), "utf8");

function setup(search = "", canPlayType, fetchImpl) {
  const nodes = new Map();
  const documentListeners = {};
  const windowListeners = {};
  const navigation = [];
  const document = {
    activeElement: null,
    fullscreenElement: null,
    addEventListener(name, callback) { (documentListeners[name] ||= []).push(callback); },
    getElementById(id) { return nodes.get(id); },
  };
  function node(id) {
    const listeners = {};
    const attributes = {};
    const classes = new Set();
    return {
      id, textContent: "", value: 0, max: 1, listeners, attributes,
      classList: { add(name) { classes.add(name); }, remove(name) { classes.delete(name); },
        contains(name) { return classes.has(name); } },
      addEventListener(name, callback) { (listeners[name] ||= []).push(callback); },
      dispatch(name) { for (const callback of listeners[name] || []) callback({ type: name }); },
      focus() { document.activeElement = this; this.dispatch("focus"); },
      setAttribute(name, value) { attributes[name] = value; },
      removeAttribute(name) { delete attributes[name]; if (name === "src") this.src = ""; },
      click() { this.focus(); this.dispatch("click"); },
    };
  }
  document.body = node("body");
  for (const id of ["video", "player", "status", "progress", "time", "source-label", "capabilities",
    "diagnostics", "media-hints", "relay-http", "media-state", "media-events", "source-original", "source-mp4", "source-relay", "source-flowerRelay",
    "source-local", "source-faststart", "source-compat", "source-long", "source-hls",
    "seek-back", "play", "seek-forward", "checkpoint", "fullscreen", "exit", "embed-lab"]) nodes.set(id, node(id));
  const video = nodes.get("video");
  video.paused = true;
  video.currentTime = 0;
  video.duration = 52;
  video.readyState = 0;
  video.networkState = 0;
  video.currentSrc = "";
  video.loadCount = 0;
  video.pauseCount = 0;
  video.playCount = 0;
  video.canPlayType = canPlayType || (type => type.includes("mpegurl") ? "" : "probably");
  video.load = () => { video.loadCount++; };
  video.pause = () => { video.pauseCount++; video.paused = true; video.dispatch("pause"); };
  video.play = () => { video.playCount++; video.paused = false; video.dispatch("playing"); return Promise.resolve(); };
  const player = nodes.get("player");
  const nav = { search, replace(url) { navigation.push(url); } };
  const window = { fetch: fetchImpl, addEventListener(name, callback) { (windowListeners[name] ||= []).push(callback); } };
  runInNewContext(source, { window, document, location: nav });
  const key = (name, repeat = false, keyCode = 0) => {
    const event = { key: name, repeat, keyCode, prevented: false,
      preventDefault() { this.prevented = true; }, stopPropagation() {} };
    for (const listener of documentListeners.keydown || []) listener(event);
    return event;
  };
  const get = id => nodes.get(id);
  return { document, window, video, player, nav, navigation, get, key, documentListeners, windowListeners };
}

test("preview package contains only the isolated Video Lab assets", () => {
  const config = JSON.parse(readFileSync(new URL("../wrangler.video-lab-preview.jsonc", import.meta.url), "utf8"));
  const html = readFileSync(new URL("../video-lab/index.html", import.meta.url), "utf8");
  assert.equal(config.name, "horizon-video-lab-preview");
  assert.equal(config.assets.directory, "./video-lab");
  assert.equal(config.main, "./video-lab-media-worker.js");
  assert.equal(config.assets.binding, "ASSETS");
  assert.deepEqual(config.assets.run_worker_first, ["/media/*"]);
  assert.equal(config.browser, undefined);
  assert.match(html, /media-src 'self' https:\/\/interactive-examples\.mdn\.mozilla\.net https:\/\/media\.w3\.org https:\/\/devstreaming-cdn\.apple\.com/);
  assert.match(html, /connect-src 'self'/);
  assert.match(html, /id="source-relay"/);
  assert.match(html, /id="source-flowerRelay"/);
  assert.match(html, /id="embed-lab"/);
  assert.doesNotMatch(html, /<iframe|hls\.js|artplayer|browser-run/i);
});

test("experimental embed entry unloads video and stays within isolated preview", () => {
  const app = setup();
  app.get("embed-lab").click();
  assert.equal(app.navigation.at(-1), "embed-lab.html");
  assert.equal(app.video.pauseCount > 0, true);
  assert.equal(app.video.src, "");
});

test("the existing external samples remain available and loading never autoplays", () => {
  const app = setup();
  assert.equal(app.video.src, "https://media.w3.org/2010/05/sintel/trailer.mp4");
  assert.equal(app.video.playCount, 0);
  app.get("source-hls").click();
  assert.equal(app.video.src, "https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/bipbop_16x9_variant.m3u8");
  assert.equal(app.video.playCount, 0);
  assert.equal(app.get("source-hls").attributes["aria-pressed"], "true");
  assert.match(app.get("capabilities").textContent, /native HLS no/);
});

test("direct and relayed Sintel select the same fixed upstream without changing player", async () => {
  const calls = [];
  const app = setup("?diagnostics=1", undefined, (url, options) => {
    calls.push({ url, options });
    return Promise.resolve({ status: 200, headers: { get: () => "video/mp4" } });
  });
  assert.equal(app.video.src, SINTEL_UPSTREAM);
  const initialLoads = app.video.loadCount;
  app.get("source-relay").click();
  assert.equal(app.video.src, "media/relay/sintel.mp4");
  assert.equal(app.video.loadCount, initialLoads + 1);
  assert.equal(app.video.playCount, 0);
  assert.equal(app.get("source-relay").attributes["aria-pressed"], "true");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "media/relay/sintel.mp4");
  assert.equal(calls[0].options.method, "HEAD");
  assert.equal(calls[0].options.credentials, "omit");
  await Promise.resolve();
  assert.match(app.get("relay-http").textContent, /HEAD 200.*GET and Range playback must be checked separately/);
  app.get("source-mp4").click();
  assert.equal(app.video.src, SINTEL_UPSTREAM);
  assert.equal(app.get("relay-http").textContent, "");
});

test("Flower direct and relayed sources share the same player and preserve other options", async () => {
  const calls = [];
  const app = setup("?diagnostics=1", undefined, (url, options) => {
    calls.push({ url, options });
    return Promise.resolve({ status: 200, headers: { get: () => "video/mp4" } });
  });
  app.get("source-original").click();
  assert.equal(app.video.src, FLOWER_UPSTREAM);
  const video = app.video;
  app.get("source-flowerRelay").click();
  assert.equal(app.video, video);
  assert.equal(video.src, "media/relay/flower.mp4");
  assert.equal(app.get("source-flowerRelay").attributes["aria-pressed"], "true");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "media/relay/flower.mp4");
  assert.equal(calls[0].options.method, "HEAD");
  assert.equal(calls[0].options.credentials, "omit");
  await Promise.resolve();
  assert.match(app.get("relay-http").textContent, /HEAD 200/);
  app.get("source-long").click();
  assert.equal(video.src, "media/horizon-25min.mp4");
  assert.equal(app.get("relay-http").textContent, "");
});

test("same-origin Sintel variants use the same player and stay under the asset limit", () => {
  const app = setup();
  for (const [id, file] of [["source-local", "sintel-original.mp4"],
    ["source-faststart", "sintel-faststart.mp4"], ["source-compat", "sintel-compat.mp4"]]) {
    app.get(id).click();
    assert.equal(app.video.src, `media/${file}`);
    assert.equal(app.get(id).attributes["aria-pressed"], "true");
    assert.equal(app.video.playCount, 0);
    assert.ok(statSync(new URL(`../video-lab/media/${file}`, import.meta.url)).size < 25 * 1024 * 1024);
  }
  assert.equal(app.video.loadCount, 4);
});

test("25-minute source is a single non-looping asset with a 1500-second movie timeline", () => {
  const app = setup();
  assert.equal(app.video.loop, true);
  app.get("source-long").click();
  assert.equal(app.video.src, "media/horizon-25min.mp4");
  assert.equal(app.video.loop, false);
  assert.equal(app.get("source-long").attributes["aria-pressed"], "true");
  const file = new URL("../video-lab/media/horizon-25min.mp4", import.meta.url);
  assert.ok(statSync(file).size < 25 * 1024 * 1024);
  const data = readFileSync(file);
  const movie = data.indexOf(Buffer.from("mvhd"));
  assert.ok(movie > 0);
  assert.equal(data[movie + 4], 0);
  const timescale = data.readUInt32BE(movie + 16);
  const duration = data.readUInt32BE(movie + 20);
  assert.equal(duration / timescale, 1500);
});

test("remux and compatibility files move MP4 metadata before media data", () => {
  function topLevelAtoms(file) {
    const data = readFileSync(new URL(`../video-lab/media/${file}`, import.meta.url));
    const atoms = [];
    for (let offset = 0; offset + 8 <= data.length;) {
      const length = data.readUInt32BE(offset);
      assert.ok(length >= 8 && offset + length <= data.length, `${file}: valid MP4 atom`);
      atoms.push(data.toString("ascii", offset + 4, offset + 8));
      offset += length;
    }
    return atoms;
  }
  const original = topLevelAtoms("sintel-original.mp4");
  assert.ok(original.indexOf("moov") > original.indexOf("mdat"));
  for (const file of ["sintel-faststart.mp4", "sintel-compat.mp4", "horizon-25min.mp4"]) {
    const atoms = topLevelAtoms(file);
    assert.ok(atoms.indexOf("moov") < atoms.indexOf("mdat"), file);
  }
});

test("original working flower and Sintel can be loaded in the same video element", () => {
  const app = setup();
  app.get("source-original").click();
  assert.equal(app.video.src, "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4");
  assert.equal(app.get("source-original").attributes["aria-pressed"], "true");
  app.get("source-mp4").click();
  assert.equal(app.video.src, "https://media.w3.org/2010/05/sintel/trailer.mp4");
  assert.equal(app.video.playCount, 0);
});

test("empty canPlayType hints do not prevent a source load or remote play request", () => {
  const app = setup("", () => "");
  assert.equal(app.video.loadCount, 1);
  assert.match(app.get("capabilities").textContent, /MP4 no/);
  app.get("source-original").click();
  assert.equal(app.video.loadCount, 2);
  app.get("play").click();
  assert.equal(app.video.playCount, 1);
});

test("switching sources stops the previous playback before loading HLS", () => {
  const app = setup();
  app.get("play").click();
  const previousLoads = app.video.loadCount;
  app.get("source-hls").click();
  assert.equal(app.video.paused, true);
  assert.equal(app.video.loadCount, previousLoads + 1);
  assert.match(app.video.src, /bipbop_16x9_variant\.m3u8$/);
});

test("remote arrows reach sources and controls; OK plays and pauses once", () => {
  const app = setup();
  assert.equal(app.document.activeElement.id, "play");
  app.key("ArrowUp");
  assert.equal(app.document.activeElement.id, "source-original");
  app.key("ArrowRight");
  assert.equal(app.document.activeElement.id, "source-mp4");
  app.key("ArrowRight");
  assert.equal(app.document.activeElement.id, "source-relay");
  app.key("ArrowRight");
  assert.equal(app.document.activeElement.id, "source-flowerRelay");
  app.key("ArrowRight");
  assert.equal(app.document.activeElement.id, "source-local");
  app.key("ArrowRight");
  assert.equal(app.document.activeElement.id, "source-faststart");
  app.key("ArrowRight");
  assert.equal(app.document.activeElement.id, "source-compat");
  app.key("ArrowRight");
  assert.equal(app.document.activeElement.id, "source-long");
  app.key("ArrowRight");
  assert.equal(app.document.activeElement.id, "source-hls");
  app.key("ArrowDown");
  assert.equal(app.document.activeElement.id, "play");
  const pressed = app.key("Enter");
  assert.equal(pressed.prevented, true);
  assert.equal(app.video.playCount, 1);
  app.key("Enter", true);
  assert.equal(app.video.playCount, 1);
  app.key("Enter");
  assert.equal(app.video.paused, true);
});

test("remote checkpoint seeks cover 5, 10, 15, 20, and 24 minutes and end is visible", () => {
  const app = setup("?diagnostics=1");
  app.get("checkpoint").click();
  assert.match(app.get("status").textContent, /25-minute video/);
  app.get("source-long").click();
  app.get("checkpoint").click();
  assert.match(app.get("status").textContent, /after the 25-minute video loads/);
  app.video.duration = 1500;
  app.video.dispatch("loadedmetadata");
  for (const seconds of [300, 600, 900, 1200, 1440]) {
    app.get("checkpoint").click();
    assert.equal(app.video.currentTime, seconds);
    assert.match(app.get("status").textContent, /Seek requested/);
    app.video.dispatch("seeking");
    app.video.dispatch("seeked");
    assert.equal(app.get("time").textContent, `${Math.floor(seconds / 60)}:00 / 25:00`);
    assert.match(app.get("status").textContent, /Seek completed/);
  }
  app.get("play").click();
  assert.equal(app.video.paused, false);
  app.get("play").click();
  assert.equal(app.video.paused, true);
  app.video.currentTime = 1500;
  app.video.dispatch("ended");
  assert.match(app.get("status").textContent, /reached the end/);
  assert.match(app.get("media-events").textContent, /ended/);
  app.key("Backspace");
  assert.equal(app.navigation.length, 1);
});

test("10-second seeking clamps to the beginning and end", () => {
  const app = setup();
  app.video.currentTime = 4;
  app.get("seek-back").click();
  assert.equal(app.video.currentTime, 0);
  app.video.currentTime = 48;
  app.get("seek-forward").click();
  assert.equal(app.video.currentTime, 52);
  assert.equal(app.get("time").textContent, "0:52 / 0:52");
  app.video.duration = NaN;
  app.get("seek-forward").click();
  assert.match(app.get("status").textContent, /Seeking unavailable/);
});

test("media error and rejected play requests produce visible, bounded descriptions", async () => {
  const app = setup();
  app.video.error = { code: 3, message: "Decoder failed" };
  app.video.dispatch("error");
  assert.equal(app.get("status").textContent, "Media error 3 (Media decoding failed): Decoder failed.");
  app.video.play = () => Promise.reject(Object.assign(new Error("Unsupported format"), { name: "NotSupportedError" }));
  app.get("play").click();
  await Promise.resolve();
  assert.equal(app.get("status").textContent, "Play rejected (NotSupportedError): Unsupported format.");
});

test("opt-in diagnostics report source state and only the latest six media events", () => {
  const app = setup("?diagnostics=1");
  assert.equal(app.get("diagnostics").hidden, false);
  assert.match(app.get("media-hints").textContent, /flower H\.264 High@3\.1\/AAC/);
  app.video.currentSrc = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";
  app.video.readyState = 1;
  app.video.networkState = 2;
  app.video.dispatch("loadstart");
  app.video.dispatch("loadedmetadata");
  app.video.dispatch("canplay");
  app.video.dispatch("playing");
  app.video.dispatch("waiting");
  app.video.dispatch("stalled");
  app.video.error = { code: 4, message: "Not supported" };
  app.video.dispatch("error");
  assert.match(app.get("media-state").textContent, /readyState 1 \(HAVE_METADATA\).*networkState 2 \(LOADING\).*flower\.mp4/);
  assert.match(app.get("media-events").textContent, /loadedmetadata → canplay → playing → waiting → stalled → error/);
  assert.doesNotMatch(app.get("media-events").textContent, /loadstart/);
  assert.equal(app.get("status").textContent, "Media error 4 (Media source or format is unsupported): Not supported.");
});

test("Back exits CSS viewport fullscreen first, preserving playback and focus", () => {
  const app = setup();
  app.get("play").click();
  app.video.currentTime = 12;
  const loads = app.video.loadCount;
  const src = app.video.src;
  app.get("fullscreen").click();
  assert.equal(app.player.classList.contains("viewport-fullscreen"), true);
  assert.equal(app.document.body.classList.contains("video-fullscreen"), true);
  assert.equal(app.get("fullscreen").textContent, "Exit fullscreen");
  assert.equal(app.video.src, src);
  assert.equal(app.video.loadCount, loads);
  assert.equal(app.video.paused, false);
  assert.equal(app.video.currentTime, 12);
  app.key("Backspace");
  assert.equal(app.player.classList.contains("viewport-fullscreen"), false);
  assert.equal(app.document.body.classList.contains("video-fullscreen"), false);
  assert.equal(app.document.activeElement.id, "fullscreen");
  assert.equal(app.video.paused, false);
  assert.equal(app.video.loadCount, loads);
  assert.equal(app.navigation.length, 0);
  app.key("Backspace");
  assert.deepEqual(app.navigation, ["https://horizon-vizio.ali-al-anbari.workers.dev/"]);
  assert.equal(app.video.src, "");
  assert.ok(app.video.pauseCount > 0);
  app.key("Backspace");
  assert.equal(app.navigation.length, 1);
});

test("fullscreen keeps focus on visible controls and leaves Home to Vizio", () => {
  const app = setup();
  app.get("fullscreen").click();
  app.key("ArrowUp");
  assert.equal(app.document.activeElement.id, "play");
  app.key("ArrowLeft");
  assert.equal(app.document.activeElement.id, "seek-back");
  app.key("ArrowLeft");
  assert.equal(app.document.activeElement.id, "seek-back");
  const home = app.key("Home");
  assert.equal(home.prevented, false);
  app.key("GoBack");
  assert.equal(app.document.activeElement.id, "fullscreen");
  assert.equal(app.navigation.length, 0);
});

test("remote OK toggles viewport fullscreen without using native Fullscreen API", () => {
  const app = setup();
  app.player.requestFullscreen = () => { throw new Error("native API must not run"); };
  app.key("ArrowRight");
  app.key("ArrowRight");
  app.key("ArrowRight");
  assert.equal(app.document.activeElement.id, "fullscreen");
  app.key("OK");
  assert.equal(app.player.classList.contains("viewport-fullscreen"), true);
  app.key("OK");
  assert.equal(app.player.classList.contains("viewport-fullscreen"), false);
  assert.equal(app.document.activeElement.id, "fullscreen");
  assert.equal(app.navigation.length, 0);
});

test("pagehide cleanup is idempotent and does not navigate", () => {
  const app = setup();
  for (const callback of app.windowListeners.pagehide || []) callback();
  for (const callback of app.windowListeners.pagehide || []) callback();
  assert.equal(app.navigation.length, 0);
  assert.equal(app.video.src, "");
  assert.equal(app.video.pauseCount, 1);
});

test("TV keyCode fallbacks and ordinary unrelated keys", () => {
  const app = setup();
  assert.equal(app.window.HorizonVideoLab.keyName({ key: "Unidentified", keyCode: 4 }), "Back");
  assert.equal(app.window.HorizonVideoLab.keyName({ key: "Unidentified", keyCode: 39 }), "ArrowRight");
  const event = app.key("VolumeUp");
  assert.equal(event.prevented, false);
});
