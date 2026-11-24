import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(import.meta.dirname, "..");

function loadWatchCore() {
  const ctx = { console, Date, Math, JSON, Number, String, Array, Object, Boolean, RegExp, URL, URLSearchParams, encodeURIComponent, decodeURIComponent };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "universal-search/history-sections.js"), "utf8"), ctx);
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "universal-search/core.js"), "utf8"), ctx);
  return { core: ctx.HorizonSearchCore, sections: ctx.HorizonHistorySections };
}

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    dump() { return Object.fromEntries(map); },
  };
}

function createOverlayHarness({ search = "?type=movie&id=550&from=search&provider=vidbolt", progressItems = [], adapter = null } = {}) {
  const html = fs.readFileSync(path.join(ROOT, "video-lab/player-overlay.html"), "utf8");
  const css = fs.readFileSync(path.join(ROOT, "video-lab/player-overlay.css"), "utf8");
  const ids = [
    "player-shell", "player-frame", "horizon-caption-text", "player-loading", "remote-capture", "overlay",
    "show-title", "episode-caption", "metadata-credit", "metadata-provider-credit", "provider-indicator",
    "provider-telemetry", "playback-timeline", "timeline-current", "timeline-fill", "timeline-playhead",
    "timeline-duration", "seek-preview", "rewind", "rewind-label", "play-pause", "play-pause-label",
    "forward", "forward-label", "previous-episode", "episodes", "next-episode", "provider-choice",
    "vidzen-server", "vidzen-server-label", "recover-provider", "manual-end", "unload-provider",
    "subtitles", "subtitle-mode", "audio-language", "audio-language-mode", "diagnostics-open",
    "watch-fullscreen", "watch-exit", "experimental-controls", "experiment-play", "experiment-pause",
    "experiment-back", "experiment-forward", "experiment-volume", "experiment-unmute", "experiment-focus",
    "experiment-skip", "subtitle-menu", "menu-title", "menu-description", "menu-cancel", "menu-change",
    "independent-subtitle-menu", "independent-subtitle-status", "independent-subtitle-off",
    "independent-subtitle-english", "independent-subtitle-offset", "independent-subtitle-setup",
    "audio-language-menu", "audio-language-status", "audio-lang-auto", "audio-lang-en", "audio-lang-ja",
    "audio-lang-de", "provider-menu", "provider-options", "vidzen-server-menu", "vidzen-server-options",
    "command-status", "diagnostics-panel", "diagnostics-close", "diag-experimental", "compat-controls",
    "diag-variant", "compat-quality", "compat-autoplay", "compat-play", "compat-reset", "compat-status",
    "vidfast-compat-controls", "diag-vidfast-mode", "vidfast-autoplay", "vidfast-reset", "vidfast-compat-status",
    "vidlink-compat-controls", "diag-vidlink-mode", "vidlink-default-off", "vidlink-default-on",
    "vidlink-jw-on", "vidlink-focus-default", "vidlink-compat-status", "vidlink-focus-status",
    "vidbolt-compat-controls", "diag-vidbolt-mode", "vidbolt-autoplay-toggle", "vidbolt-auto-recover",
    "vidbolt-stop", "vidbolt-native-focus", "vidbolt-compat-status", "diag-user-agent", "diag-media-source",
    "diag-native-hls", "diag-html5", "diag-permissions", "diag-frame-events", "diag-events",
    "diag-message-checks", "diag-sources", "diag-elapsed", "diag-vidbolt-session", "diag-assessment",
    "up-next", "up-next-title", "up-next-identity", "up-next-separator", "up-next-name-viewport",
    "up-next-name", "up-next-play", "screen-reader-status"
  ];
  const hiddenByDefault = new Set([
    "subtitle-menu", "independent-subtitle-menu", "audio-language-menu", "provider-menu", "vidzen-server-menu",
    "vidzen-server", "horizon-caption-text", "up-next", "manual-end", "playback-timeline", "diagnostics-panel",
    "compat-controls", "vidfast-compat-controls", "vidlink-compat-controls", "vidbolt-compat-controls",
    "experimental-controls", "player-loading", "seek-preview", "unload-provider", "recover-provider",
    "watch-fullscreen", "watch-exit"
  ]);
  const elements = new Map();
  const posted = [];
  const docListeners = new Map();
  const winListeners = new Map();
  let nowMs = 100000;
  let nextTimerId = 1;
  const timers = new Map();

  function makeClassList() {
    const set = new Set();
    return {
      add(...xs) { xs.forEach(x => set.add(x)); },
      remove(...xs) { xs.forEach(x => set.delete(x)); },
      toggle(x, f) { if (f === undefined) set.has(x) ? set.delete(x) : set.add(x); else f ? set.add(x) : set.delete(x); },
      contains(x) { return set.has(x); },
    };
  }
  function makeEl(id, tag = "div") {
    const listeners = new Map();
    const attrs = new Map();
    const el = {
      id, tagName: tag.toUpperCase(),
      hidden: hiddenByDefault.has(id),
      disabled: false,
      tabIndex: id === "remote-capture" ? 0 : -1,
      textContent: "",
      title: "",
      src: "",
      style: (() => {
        const props = new Map();
        return {
          setProperty(k, v) { props.set(k, String(v)); },
          getPropertyValue(k) { return props.get(k) || ""; },
          removeProperty(k) { props.delete(k); },
        };
      })(),
      classList: makeClassList(),
      children: [],
      dataset: {},
      parentNode: null,
      contentWindow: id === "player-frame" ? { postMessage(data, origin) { posted.push({ data, origin }); } } : null,
      addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
      removeEventListener(type, fn) { if (listeners.has(type)) listeners.set(type, listeners.get(type).filter(f => f !== fn)); },
      fire(type, ev = {}) { (listeners.get(type) || []).slice().forEach(fn => fn({ target: el, preventDefault() {}, stopPropagation() {}, ...ev })); },
      click() { el.fire("click"); },
      focus() { doc.activeElement = el; el.fire("focus"); },
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      removeAttribute(k) { attrs.delete(k); if (k === "src") el.src = ""; },
      querySelector() { return null; },
      contains(node) { return node === el || el.children.includes(node); },
      replaceChildren(...nodes) { el.children = nodes; nodes.forEach(n => { n.parentNode = el; }); },
      cloneNode() {
        const clone = makeEl(id, tag);
        clone.parentNode = el.parentNode;
        clone.contentWindow = { postMessage(data, origin) { posted.push({ data, origin }); } };
        return clone;
      },
    };
    return el;
  }
  ids.forEach(id => elements.set(id, makeEl(id, id === "player-frame" ? "iframe" : "button")));
  const shell = elements.get("player-shell");
  const frameEl = elements.get("player-frame");
  frameEl.parentNode = {
    replaceChild(next, old) {
      elements.set("player-frame", next);
      next.parentNode = frameEl.parentNode;
    }
  };

  const doc = {
    activeElement: elements.get("remote-capture"),
    getElementById(id) { return elements.get(id) || null; },
    createElement(tag) { return makeEl("", tag); },
    addEventListener(type, fn) { if (!docListeners.has(type)) docListeners.set(type, []); docListeners.get(type).push(fn); },
    removeEventListener(type, fn) { if (docListeners.has(type)) docListeners.set(type, docListeners.get(type).filter(f => f !== fn)); },
  };
  const navigation = [];
  const nav = {
    origin: "https://horizon-video-lab-preview.ali-al-anbari.workers.dev",
    search,
    href: "https://horizon-video-lab-preview.ali-al-anbari.workers.dev/player-overlay.html" + search,
    replace(url) { navigation.push(url); },
  };
  const progressStore = makeStorage(progressItems.length
    ? { "horizon-video-lab-progress-v1": JSON.stringify({ version: 1, items: progressItems }) }
    : {});
  const clock = {
    performance: { now: () => nowMs },
    sessionStorage: makeStorage(),
    setTimeout(fn, delay) { const id = nextTimerId++; timers.set(id, { fn, at: nowMs + (Number(delay) || 0) }); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(type, fn) { if (!winListeners.has(type)) winListeners.set(type, []); winListeners.get(type).push(fn); },
    removeEventListener(type, fn) { if (winListeners.has(type)) winListeners.set(type, winListeners.get(type).filter(f => f !== fn)); },
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    document: { referrer: "" },
  };
  const sandbox = {
    console, Date, Math, JSON, Number, String, Array, Object, Boolean, RegExp, URL, URLSearchParams,
    encodeURIComponent, decodeURIComponent, Promise, navigator: { userAgent: "VIZIO SmartCast Chrome/128" },
    localStorage: progressStore,
    sessionStorage: clock.sessionStorage,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  for (const rel of [
    "video-lab/focus-lease.js",
    "video-lab/episode-catalog.js",
    "video-lab/playback-providers.js",
    "video-lab/player-diagnostics.js",
    "video-lab/independent-subtitles.js",
    "video-lab/player-overlay.js",
  ]) {
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, rel), "utf8"), sandbox);
  }
  const player = sandbox.HorizonPlayerOverlay.createPlayer(doc, nav, clock, {
    progressStorage: progressStore,
    commandAdapter: adapter,
    episodeResolver: {
      current: async () => null,
      resolve: async () => ({ kind: "none_known" }),
    },
  });

  function advance(ms) {
    const end = nowMs + ms;
    while (true) {
      let next = null;
      for (const [id, t] of timers.entries()) {
        if (t.at <= end && (!next || t.at < next.at)) next = { id, ...t };
      }
      if (!next) break;
      nowMs = next.at;
      timers.delete(next.id);
      next.fn();
    }
    nowMs = end;
  }
  function key(k, repeat = false) {
    let prevented = false;
    const ev = { key: k, repeat, preventDefault() { prevented = true; }, stopPropagation() {} };
    (docListeners.get("keydown") || []).slice().forEach(fn => fn(ev));
    return { prevented };
  }
  function message(data, origin, source = elements.get("player-frame").contentWindow) {
    (winListeners.get("message") || []).slice().forEach(fn => fn({ data, origin, source }));
  }
  function readProgress() {
    return JSON.parse(progressStore.getItem("horizon-video-lab-progress-v1") || '{"version":1,"items":[]}');
  }
  return {
    html, css, sandbox, doc, nav, navigation, posted, timers, player,
    get: (id) => elements.get(id),
    state: () => player.getState(),
    advance, key, message, readProgress,
    now: () => nowMs,
  };
}

// =========================================================================
// TASK 1: Continue Watching & Authoritative Playback State Unification
// =========================================================================

test("Continue Watching: newer authoritative Resume progress overrides outdated progress and backward seeks decrease progress", () => {
  const { core } = loadWatchCore();
  const storage = makeStorage();

  // Outdated progress at 600/1800
  core.writeHistory(storage, core.item("tv", 1396, "Breaking Bad", 1, 2, "off", 1000, {
    progress: { position: 600, duration: 1800, updatedAt: 1000, provider: "vidbolt", completed: false },
  }));
  // Forward seek to 900/1800
  core.writeHistory(storage, core.item("tv", 1396, "Breaking Bad", 1, 2, "off", 2000, {
    progress: { position: 900, duration: 1800, updatedAt: 2000, provider: "vidbolt", completed: false },
  }));
  let rows = core.readHistory(storage);
  let cw = core.homepageContinueCandidates(rows, storage);
  assert.equal(cw[0].progress.position, 900);
  assert.equal(core.episodeProgressFraction(cw[0]), 0.5);

  // Legitimate backward seek to 360/1800 (even at same or newer timestamp)
  core.writeHistory(storage, core.item("tv", 1396, "Breaking Bad", 1, 2, "off", 2000, {
    progress: { position: 360, duration: 1800, updatedAt: 2000, provider: "vidbolt", completed: false },
  }));
  rows = core.readHistory(storage);
  cw = core.homepageContinueCandidates(rows, storage);
  assert.equal(cw[0].progress.position, 360, "backward seek must decrease displayed progress");
  assert.equal(core.episodeProgressFraction(cw[0]), 0.2);

  // Older asynchronous update (updatedAt: 1500) must NOT overwrite newer authoritative state (updatedAt: 2000)
  core.writeHistory(storage, core.item("tv", 1396, "Breaking Bad", 1, 2, "off", 1500, {
    progress: { position: 1200, duration: 1800, updatedAt: 1500, provider: "vidbolt", completed: false },
  }));
  rows = core.readHistory(storage);
  cw = core.homepageContinueCandidates(rows, storage);
  assert.equal(cw[0].progress.position, 360, "older async update cannot overwrite newer authoritative state");
});

test("Continue Watching & Details agree when stale activePointer lags behind a newer authoritative episode", () => {
  const { core } = loadWatchCore();
  const storage = makeStorage();
  core.writeEpisodeCatalog(storage, 1396, [{ number: 1, count: 7 }]);

  // Stale activePointer still points to S1E2 at t=1000
  core.writeActiveEpisode(storage, 1396, { season: 1, episode: 2, at: 1000 });
  core.writeHistory(storage, core.item("tv", 1396, "Breaking Bad", 1, 2, "off", 1000, {
    progress: { position: 900, duration: 1800, updatedAt: 1000, provider: "vidbolt", completed: false },
  }));
  // Authoritative playback moved on to S1E3 at t=5000
  core.writeHistory(storage, core.item("tv", 1396, "Breaking Bad", 1, 3, "off", 5000, {
    progress: { position: 450, duration: 1800, updatedAt: 5000, provider: "vidzen", completed: false },
  }));

  const rows = core.readHistory(storage);
  const cw = core.homepageContinueCandidates(rows, storage);
  const detailsTarget = core.canonicalEpisodeTarget(rows, 1396, storage);

  assert.equal(cw[0].season, 1);
  assert.equal(cw[0].episode, 3);
  assert.equal(cw[0].progress.position, 450);
  assert.equal(detailsTarget.season, cw[0].season);
  assert.equal(detailsTarget.episode, cw[0].episode);
  assert.equal(detailsTarget.progress.position, cw[0].progress.position);
});

test("Continue Watching: exiting immediately after backward seek on VidBolt and VidZen flushes latest position", () => {
  // 1. VidBolt backward seek + immediate exit
  const bolt = createOverlayHarness({
    search: "?showId=1396&season=1&episode=4&provider=vidbolt&from=search&handoff=tok_12345678&handoffAt=1000",
    progressItems: [{ identity: "tv:1396:1:4", position: 900, duration: 1800, updatedAt: 1000, provider: "vidbolt", completed: false }],
  });
  bolt.get("player-frame").fire("load");
  bolt.message({ type: "ready" }, "https://vidbolt.xyz");
  bolt.message({ type: "durationchange", duration: 1800 }, "https://vidbolt.xyz");
  bolt.message({ type: "timeupdate", time: 890, duration: 1800 }, "https://vidbolt.xyz");
  // User seeks backward to 300 and exits immediately
  bolt.key("ArrowDown");
  bolt.message({ type: "timeupdate", time: 300, duration: 1800 }, "https://vidbolt.xyz");
  bolt.get("watch-exit").click();
  const boltUrl = new URL(bolt.navigation.at(-1));
  assert.equal(Number(boltUrl.searchParams.get("position")), 300);
  assert.equal(bolt.readProgress().items[0].position, 300);

  // 2. VidZen backward seek + immediate exit
  const zen = createOverlayHarness({
    search: "?showId=1396&season=1&episode=4&provider=vidzen&from=search&handoff=tok_12345678&handoffAt=1000",
    progressItems: [{ identity: "tv:1396:1:4", position: 900, duration: 1800, updatedAt: 1000, provider: "vidzen", completed: false }],
  });
  zen.get("player-frame").fire("load");
  zen.message({ type: "vidzen:status", currentTime: 420, duration: 1800, paused: false }, "https://vidzen.fun");
  zen.key("ArrowDown");
  zen.get("watch-exit").click();
  const zenUrl = new URL(zen.navigation.at(-1));
  assert.equal(Number(zenUrl.searchParams.get("position")), 420);
  assert.equal(zen.readProgress().items[0].position, 420);
});

test("Continue Watching: missing or invalid duration produces neutral 0 progress (never NaN or Infinity)", () => {
  const { core } = loadWatchCore();
  assert.equal(core.episodeProgressFraction({ progress: { position: 100, duration: 0 } }), 0);
  assert.equal(core.episodeProgressFraction({ progress: { position: 100, duration: NaN } }), 0);
  assert.equal(core.episodeProgressFraction({ progress: { position: NaN, duration: 1800 } }), 0);
  assert.equal(core.episodeProgressFraction({ progress: { position: 100, duration: null } }), 0);
  assert.equal(core.episodeProgressFraction({ progress: { position: 2500, duration: 1800 } }), 1);
});

test("Continue Watching: English and Arabic viewing histories remain strictly isolated", () => {
  const { core } = loadWatchCore();
  const storage = makeStorage();
  core.writeHistory(storage, core.item("movie", 1316416, "Siko Siko", null, null, "off", 1000, {
    progress: { position: 300, duration: 7200, updatedAt: 1000, provider: "vidbolt", completed: false },
  }), "english");
  core.writeHistory(storage, core.item("movie", 1316416, "سيكو سيكو", null, null, "off", 2000, {
    progress: { position: 1200, duration: 7200, updatedAt: 2000, provider: "akwam_relay", completed: false },
  }), "arabic");

  const enRows = core.readHistory(storage, "english");
  const arRows = core.readHistory(storage, "arabic");
  assert.equal(enRows.length, 1);
  assert.equal(arRows.length, 1);
  assert.equal(enRows[0].progress.position, 300);
  assert.equal(arRows[0].progress.position, 1200);
});

// =========================================================================
// TASK 3: Control Bar Auto-Hide Across EVERY English Provider
// =========================================================================

const PROVIDERS_UNDER_TEST = [
  {
    id: "vidbolt",
    origin: "https://vidbolt.xyz",
    play: (app) => app.message({ type: "play" }, "https://vidbolt.xyz"),
    pause: (app) => app.message({ type: "pause" }, "https://vidbolt.xyz"),
    tick: (app, t) => app.message({ type: "timeupdate", time: t, duration: 7200 }, "https://vidbolt.xyz"),
  },
  {
    id: "vidy",
    origin: "https://www.vidy.st",
    play: (app) => app.message(JSON.stringify({ type: "PLAYER_EVENT", data: { event: "play", currentTime: 10, duration: 7200, id: "550", mediaType: "movie" } }), "https://www.vidy.st"),
    pause: (app) => app.message(JSON.stringify({ type: "PLAYER_EVENT", data: { event: "pause", currentTime: 20, duration: 7200, id: "550", mediaType: "movie" } }), "https://www.vidy.st"),
    tick: (app, t) => app.message(JSON.stringify({ type: "PLAYER_EVENT", data: { event: "timeupdate", currentTime: t, duration: 7200, id: "550", mediaType: "movie" } }), "https://www.vidy.st"),
  },
  {
    id: "vidzen",
    origin: "https://vidzen.fun",
    play: (app) => app.message({ type: "vidzen:status", currentTime: 10, duration: 7200, paused: false }, "https://vidzen.fun"),
    pause: (app) => app.message({ type: "vidzen:status", currentTime: 20, duration: 7200, paused: true }, "https://vidzen.fun"),
    tick: (app, t) => app.message({ type: "vidzen", event: "timeupdate", currentTime: t, duration: 7200 }, "https://vidzen.fun"),
  },
  {
    id: "stellar",
    origin: "https://stellar.rip",
    play: (app) => app.message({ type: "PLAYER_EVENT", data: { event: "play", currentTime: 10, duration: 7200, tmdbId: 550, mediaType: "movie" } }, "https://stellar.rip"),
    pause: (app) => app.message({ type: "PLAYER_EVENT", data: { event: "pause", currentTime: 20, duration: 7200, tmdbId: 550, mediaType: "movie" } }),
    tick: (app, t) => app.message({ type: "PLAYER_EVENT", data: { event: "timeupdate", currentTime: t, duration: 7200, tmdbId: 550, mediaType: "movie" } }, "https://stellar.rip"),
  },
  {
    id: "yapgrid",
    origin: "https://yapgrid.com",
    play: () => {},
    pause: null,
    tick: () => {},
  },
];

for (const spec of PROVIDERS_UNDER_TEST) {
  test(`Control auto-hide (${spec.id}): hides after 5s despite continuous background timeupdate, stays open on pause/menu, cleans up on exit`, () => {
    const app = createOverlayHarness({ search: `?type=movie&id=550&from=search&provider=${spec.id}` });
    app.get("player-frame").fire("load");
    spec.play(app);

    // Reveal controls via remote interaction
    if (app.state() === "PLAYBACK_HIDDEN") app.key("ArrowDown");
    assert.equal(app.state(), "CONTROLS_VISIBLE", `${spec.id}: controls visible after interaction`);

    // Simulate continuous background progress events every 500ms for 5.5s
    for (let step = 1; step <= 11; step++) {
      app.advance(500);
      spec.tick(app, 10 + step);
    }
    assert.equal(app.state(), "PLAYBACK_HIDDEN", `${spec.id}: continuous background timeupdate must NOT block 5s auto-hide`);

    // Remote interaction restores controls without triggering playback command
    const postedBefore = app.posted.length;
    app.key("ArrowUp");
    assert.equal(app.state(), "CONTROLS_VISIBLE", `${spec.id}: remote interaction restores controls`);
    assert.equal(app.posted.length, postedBefore, `${spec.id}: showing controls does not send unintended command`);

    // Opening provider menu holds controls open indefinitely; closing restarts auto-hide
    app.get("provider-choice").click();
    assert.equal(app.state(), "SUBMENU_OPEN", `${spec.id}: submenu open`);
    app.advance(12000);
    assert.equal(app.state(), "SUBMENU_OPEN", `${spec.id}: menu stays open while browsing`);
    app.key("Escape");
    assert.equal(app.state(), "CONTROLS_VISIBLE", `${spec.id}: closing menu returns to controls`);
    app.advance(5000);
    assert.equal(app.state(), "PLAYBACK_HIDDEN", `${spec.id}: auto-hide resumes after menu closes`);

    // Pausing keeps controls visible; resuming restarts auto-hide (for providers with pause events)
    if (spec.pause && spec.id !== "stellar") {
      app.key("ArrowDown");
      spec.pause(app);
      app.advance(12000);
      assert.equal(app.state(), "CONTROLS_VISIBLE", `${spec.id}: paused keeps controls visible`);
      spec.play(app);
      app.advance(5000);
      assert.equal(app.state(), "PLAYBACK_HIDDEN", `${spec.id}: resuming restarts auto-hide`);
    }

    // Back from hidden exits playback and cleans up timers
    app.key("Backspace");
    assert.equal(app.navigation.length, 1, `${spec.id}: Back exits playback`);
    assert.equal(app.timers.size, 0, `${spec.id}: all timers cleaned up on exit`);
  });
}

// =========================================================================
// TASK 2 & TASK 4: Clean UI, No Technical Messages, No "Experimental" Labels
// =========================================================================

test("UI cleanup & Experimental removal: zero Experimental labels in English provider UI and no routine technical status messages", () => {
  const app = createOverlayHarness({ search: "?type=movie&id=550&from=search&provider=vidbolt" });
  const providersMod = app.sandbox.HorizonPlaybackProviders;

  for (const id of ["vidbolt", "vidy", "vidzen", "yapgrid", "stellar", "embedwave", "apiplayer"]) {
    assert.doesNotMatch(providersMod.label(id), /experimental/i, `label(${id}) must not contain Experimental`);
  }

  // Open provider menu and verify every rendered option is clean
  app.key("ArrowDown");
  app.get("provider-choice").click();
  const options = app.get("provider-options").children.map(b => b.textContent);
  assert.ok(options.length >= 4);
  for (const text of options) {
    assert.doesNotMatch(text, /experimental/i, `provider option "${text}" must not contain Experimental`);
  }

  // Close menu, verify no routine technical messages or telemetry banners
  app.key("Escape");
  assert.equal(app.get("command-status").textContent, "");
  assert.equal(app.get("provider-telemetry").classList.contains("is-visible"), false);

  // Verify no temporary diagnostic overlays or Experimental text in HTML templates
  const watchHtml = fs.readFileSync(path.join(ROOT, "universal-search/index.html"), "utf8");
  assert.doesNotMatch(watchHtml, /WATCH TEST|watch-static-version|horizon-preplay-diag/i);
  assert.doesNotMatch(app.html, /Experimental provider|experimental provider/i);
});

// =========================================================================
// CINEMATIC CONTROL MASKING: DOM, CSS Stacking, Lifecycle & Provider Sync
// =========================================================================

test("Cinematic control masking: HTML structure, CSS stacking order, pointer-events, transitions, and cache version", () => {
  const html = fs.readFileSync(path.join(ROOT, "video-lab/player-overlay.html"), "utf8");
  const css = fs.readFileSync(path.join(ROOT, "video-lab/player-overlay.css"), "utf8");

  // Two independent aria-hidden non-interactive gradient masks inside #player-shell
  assert.match(html, /id="control-mask-top"[^>]*class="control-mask control-mask-top"[^>]*aria-hidden="true"/);
  assert.match(html, /id="control-mask-bottom"[^>]*class="control-mask control-mask-bottom"[^>]*aria-hidden="true"/);
  assert.doesNotMatch(html, /control-mask[^>]*tabindex/i, "masks must not be focusable");

  // Cache-busting version bumped on modified frontend assets; temporary #mask-size removed
  assert.match(html, /player-overlay\.css\?v=vl-5/);
  assert.match(html, /episode-catalog\.js\?v=vl-2/);
  assert.match(html, /player-overlay\.js\?v=vl-5/);
  assert.doesNotMatch(html, /id="mask-size"/);
  assert.doesNotMatch(css, /mask-size-button/);

  // Legacy single .overlay::before scrim removed; no blur or decorative boxes
  assert.doesNotMatch(css, /\.overlay::before/);
  assert.doesNotMatch(css, /backdrop-filter/i);

  // Strict stacking hierarchy: iframe (0) < masks (2) < captions (3) < overlay (4) < loading/provider-menu (5) < up-next (6)
  assert.match(css, /#player-frame\s*\{[^}]*z-index:\s*0/);
  assert.match(css, /\.control-mask\s*\{[^}]*z-index:\s*2/);
  assert.match(css, /\.control-mask\s*\{[^}]*pointer-events:\s*none/);
  assert.match(css, /\.horizon-caption\s*\{[^}]*z-index:\s*3/);
  assert.match(css, /\.overlay\s*\{[^}]*z-index:\s*4/);
  assert.match(css, /\.player-loading\s*\{[^}]*z-index:\s*5/);
  assert.match(css, /\.provider-menu\s*\{[^}]*z-index:\s*5/);
  assert.match(css, /\.up-next\s*\{[^}]*z-index:\s*6/);

  // Variable-driven mask heights defaulting to Standard 15% / 20% & GPU-friendly opacity transitions (~250ms in / ~350ms out)
  assert.match(css, /\.control-mask-top\s*\{[^}]*height:\s*var\(--mask-top-height,\s*15vh\)/);
  assert.match(css, /\.control-mask-bottom\s*\{[^}]*height:\s*var\(--mask-bottom-height,\s*20vh\)/);
  assert.match(css, /\.control-mask\s*\{[^}]*transition:\s*opacity\s+350ms/);
  assert.match(css, /\.player-shell\.controls-open\s+\.control-mask\s*\{[^}]*opacity:\s*1[^}]*transition:\s*opacity\s+250ms/s);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.overlay,\s*\.control-mask\s*\{\s*transition:\s*none;/);
});

test("Watch Settings Control Shading: persistence, validation, cross-origin URL handoff, legacy key retirement, and episode transition propagation", () => {
  const { core } = loadWatchCore();
  const watchStorage = makeStorage();

  // Default is Standard (15% / 20%)
  assert.equal(core.readControlShadingPref(watchStorage), "standard");

  // All 8 presets validate and round-trip cleanly
  const expectedMap = {
    off: ["0vh", "0vh"],
    minimal: ["5vh", "5vh"],
    light: ["8vh", "8vh"],
    subtle: ["10vh", "10vh"],
    medium: ["12vh", "15vh"],
    standard: ["15vh", "20vh"],
    strong: ["20vh", "25vh"],
    maximum: ["25vh", "35vh"],
  };
  for (const preset of Object.keys(expectedMap)) {
    core.writeControlShadingPref(watchStorage, preset);
    assert.equal(core.readControlShadingPref(watchStorage), preset);
    const tvUrl = core.tvPlayerUrl(1396, 1, 2, "off", "Breaking Bad", null, null, false, "tok_12345678", preset);
    const movieUrl = core.moviePlayerUrl(550, "Fight Club", null, false, "tok_12345678", preset);
    assert.equal(new URL(tvUrl).searchParams.get("shading"), preset);
    assert.equal(new URL(movieUrl).searchParams.get("shading"), preset);

    // Video Lab parses and applies exact preset heights
    const app = createOverlayHarness({ search: `?type=movie&id=550&from=search&provider=vidbolt&shading=${preset}` });
    assert.equal(app.get("player-shell").style.getPropertyValue("--mask-top-height"), expectedMap[preset][0]);
    assert.equal(app.get("player-shell").style.getPropertyValue("--mask-bottom-height"), expectedMap[preset][1]);
  }

  // Invalid or corrupted Watch preference falls back cleanly to standard
  watchStorage.setItem(core.CONTROL_SHADING_KEY, JSON.stringify({ version: 1, preset: "invalid_value" }));
  assert.equal(core.readControlShadingPref(watchStorage), "standard");

  // Video Lab ignores missing/invalid ?shading= and retires stale legacy horizon-video-lab-mask-size-v1
  const fallbackApp = createOverlayHarness({ search: "?type=movie&id=550&from=search&provider=vidbolt&shading=bogus" });
  fallbackApp.sandbox.localStorage.setItem("horizon-video-lab-mask-size-v1", "5-5");
  fallbackApp.sandbox.HorizonPlayerOverlay.createPlayer(fallbackApp.doc, fallbackApp.nav, {
    performance: { now: () => 1000 },
    sessionStorage: makeStorage(),
    setTimeout: () => 1,
    clearTimeout: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    document: { referrer: "" },
  }, { progressStorage: fallbackApp.sandbox.localStorage });
  assert.equal(fallbackApp.get("player-shell").style.getPropertyValue("--mask-top-height"), "15vh");
  assert.equal(fallbackApp.get("player-shell").style.getPropertyValue("--mask-bottom-height"), "20vh");
  assert.equal(fallbackApp.sandbox.localStorage.getItem("horizon-video-lab-mask-size-v1"), null, "legacy temporary key retired");

  // Episode transition inside Video Lab preserves ?shading= on next episode URL
  const episodesMod = fallbackApp.sandbox.HorizonEpisodes;
  const nextUrl = episodesMod.pageUrl({ showId: 1396, season: 1, episode: 3 }, "off", false, null, true, "Breaking Bad", null, "vidbolt", "strong");
  assert.match(nextUrl, /[?&]shading=strong(?:&|$)/);
  assert.equal(episodesMod.parse(nextUrl.slice(nextUrl.indexOf("?"))).shading, "strong");

  // Watch HTML contains all 8 Control Shading options + Restore Default + bumped cache versions
  const watchHtml = fs.readFileSync(path.join(ROOT, "universal-search/index.html"), "utf8");
  assert.match(watchHtml, /search\.css\?v=phase4a-6/);
  assert.match(watchHtml, /core\.js\?v=lg-relay-4/);
  assert.match(watchHtml, /player-adapter\.js\?v=shading-1/);
  assert.match(watchHtml, /search\.js\?v=phase4a-11/);
  for (const preset of Object.keys(expectedMap)) {
    assert.match(watchHtml, new RegExp(`data-shading="${preset}"`));
  }
  assert.match(watchHtml, /id="settings-control-shading-reset"/);
});

test("Cinematic control masking: player-shell.controls-open stays synchronized with overlay visibility across all providers and exit/dispose", () => {
  for (const spec of PROVIDERS_UNDER_TEST) {
    const app = createOverlayHarness({ search: `?type=movie&id=550&from=search&provider=${spec.id}` });
    const shell = app.get("player-shell");
    const overlay = app.get("overlay");
    app.get("player-frame").fire("load");
    spec.play(app);

    // Reveal controls -> both shell.controls-open and overlay.is-visible true
    if (app.state() === "PLAYBACK_HIDDEN") app.key("ArrowDown");
    assert.equal(shell.classList.contains("controls-open"), true, `${spec.id}: masks open when controls visible`);
    assert.equal(overlay.classList.contains("is-visible"), true, `${spec.id}: overlay open`);

    // 5s auto-hide -> both false together
    app.advance(5000);
    assert.equal(shell.classList.contains("controls-open"), false, `${spec.id}: masks hidden after 5s auto-hide`);
    assert.equal(overlay.classList.contains("is-visible"), false, `${spec.id}: overlay hidden after 5s auto-hide`);

    // D-pad restore -> both true
    app.key("ArrowRight");
    assert.equal(shell.classList.contains("controls-open"), true, `${spec.id}: masks restored on D-pad`);

    // Submenu open keeps masks open; closing & waiting 5s hides them
    app.get("provider-choice").click();
    app.advance(10000);
    assert.equal(shell.classList.contains("controls-open"), true, `${spec.id}: masks remain open while menu open`);
    app.key("Escape");
    app.advance(5000);
    assert.equal(shell.classList.contains("controls-open"), false, `${spec.id}: masks hide after menu closes`);

    // Quick-pause / dispose cleanup removes controls-open and is-quick-pause cleanly
    app.key("ArrowDown");
    assert.equal(shell.classList.contains("controls-open"), true);
    app.player.dispose();
    assert.equal(shell.classList.contains("controls-open"), false, `${spec.id}: dispose clears controls-open`);
    assert.equal(shell.classList.contains("is-quick-pause"), false, `${spec.id}: dispose clears is-quick-pause`);
  }
});
