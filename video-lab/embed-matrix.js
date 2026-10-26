(function (root) {
  "use strict";

  // Concluded experiment (physical Vizio results recorded in
  // docs/VIDEO_LAB_EMBED_COMPATIBILITY.md). The modes below are kept exactly as
  // tested so the matrix stays reproducible. Do not add sandbox tokens to make
  // a provider play.
  var VIDLOVE = "https://player.vidlove.cc/embed/tv/2190/13/2";
  var VIDLINK = "https://vidlink.pro/tv/2190/13/2";
  var EMBEDWAVE = "https://embedwave.cc/embed/tv/2190/13/2";
  var PREVIEW_ORIGIN = (typeof location !== "undefined" && location.origin && location.origin !== "null")
    ? location.origin
    : "https://horizon-video-lab-preview.ali-al-anbari.workers.dev";
  var EMPTY_VTT_URL = PREVIEW_ORIGIN + "/empty.vtt";
  var YAPGRID = "https://yapgrid.com/embed/tv/2190/13/2";
  var YAPGRID_SUB = "https://yapgrid.com/embed/tv/2190/13/2?lang=en";
  var YAPGRID_OFF = "https://yapgrid.com/embed/tv/2190/13/2?sub_url="
    + encodeURIComponent(EMPTY_VTT_URL)
    + "&sub_lang=en&sub_label=Off";
  var YOUTUBE = "https://www.youtube.com/embed/M7lc1UVf-VE";
  var HORIZON = "https://horizon-vizio.ali-al-anbari.workers.dev/";
  var STRICT = "allow-scripts allow-presentation";
  var MODES = {
    strict: { label: "VidLove · strict", url: VIDLOVE, sandbox: STRICT, allow: "autoplay; fullscreen" },
    origin: { label: "VidLove · same-origin", url: VIDLOVE,
      sandbox: "allow-scripts allow-same-origin allow-presentation", allow: "autoplay; fullscreen" },
    unsandboxed: { label: "VidLove · unsandboxed (autoplay)", url: VIDLOVE, sandbox: null, allow: "autoplay; fullscreen" },
    "user-play": { label: "VidLove · unsandboxed (user-init)", url: VIDLOVE, sandbox: null, allow: "fullscreen" },
    vidlink: { label: "VidLink", url: VIDLINK, sandbox: null, allow: "autoplay; fullscreen" },
    embedwave: { label: "EmbedWave", url: EMBEDWAVE, sandbox: null, allow: "autoplay; fullscreen; picture-in-picture; encrypted-media" },
    yapgrid: { label: "YapGrid", url: YAPGRID, sandbox: null, allow: "autoplay; fullscreen" },
    "yapgrid-sub": { label: "YapGrid (en sub)", url: YAPGRID_SUB, sandbox: null, allow: "autoplay; fullscreen" },
    "yapgrid-off": { label: "YapGrid (sub off)", url: YAPGRID_OFF, sandbox: null, allow: "autoplay; fullscreen" },
    youtube: { label: "YouTube official sample · strict", url: YOUTUBE, sandbox: STRICT, allow: "autoplay; fullscreen" },
  };
  var IDS = ["strict", "origin", "unsandboxed", "user-play", "vidlink", "embedwave", "yapgrid", "yapgrid-sub", "yapgrid-off", "youtube",
    "ctl-play", "ctl-seek-back", "ctl-seek-fwd", "ctl-sub", "control-player",
    "fullscreen-api", "fullscreen-css", "stop",
    "observed-player", "observed-blank", "observed-media-error", "back-lab", "horizon"];

  function keyName(event) {
    var key = event && event.key;
    if (key === "Enter" || key === "Select" || key === "OK" || key === "NumpadEnter") return "OK";
    if (key === "Escape" || key === "Backspace" || key === "BrowserBack" || key === "GoBack") return "Back";
    if (key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown") return key;
    var code = event && (event.keyCode || event.which);
    if (code === 13) return "OK";
    if (code === 8 || code === 27 || code === 4) return "Back";
    if (code >= 37 && code <= 40) return ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"][code - 37];
    return key || "Unknown";
  }

  function createMatrix(doc, nav, clock) {
    var get = function (id) { return doc.getElementById(id); };
    var frame = get("candidate");
    if (!frame) return null;
    var controls = IDS.map(get);
    var focused = 0;
    var mode = null;
    var isControllingPlayer = false;
    var startedAt = 0;
    var loadSeen = false;
    var observed = false;
    var parentBlocked = false;
    var navigationTimer = null;
    var observationTimer = null;
    var blurTimer = null;
    var disposed = false;
    var signals = [];

    function now() { return clock.performance && typeof clock.performance.now === "function"
      ? clock.performance.now() : Date.now(); }
    function say(value) { if (!disposed) get("status").textContent = value; }
    function note(value) {
      signals.push(value);
      if (signals.length > 6) signals.shift();
      get("signals").textContent = "Parent signals: " + signals.join(" → ") + ".";
    }
    function focus(index) {
      focused = Math.max(0, Math.min(controls.length - 1, index));
      try { controls[focused].focus({ preventScroll: true }); }
      catch (_error) { controls[focused].focus(); }
    }
    function clearTimers() {
      if (navigationTimer !== null) { clock.clearTimeout(navigationTimer); navigationTimer = null; }
      if (observationTimer !== null) { clock.clearTimeout(observationTimer); observationTimer = null; }
      if (blurTimer !== null) { clock.clearTimeout(blurTimer); blurTimer = null; }
    }
    // Replace the iframe with a never-navigated clone of the verified markup.
    // Removing the element destroys its browsing context (document, media
    // decoders, network, timers, nested ad frames) and drops the frame's
    // session-history entries, so a platform-level Back cannot traverse back
    // into the third-party page after unload. The clone's first navigation
    // replaces its initial about:blank entry instead of adding history.
    function discardFrame() {
      isControllingPlayer = false;
      var parent = frame.parentNode;
      if (!parent || typeof frame.cloneNode !== "function") {
        frame.hidden = true;
        frame.setAttribute("sandbox", STRICT);
        frame.src = "about:blank";
        return;
      }
      var fresh = frame.cloneNode(false);
      fresh.removeAttribute("src");
      fresh.setAttribute("sandbox", STRICT);
      fresh.hidden = true;
      parent.replaceChild(fresh, frame);
      frame = fresh;
      bindFrame(fresh);
    }
    var stage = frame.parentNode;
    var isCssFullscreen = false;

    function leaveCssFullscreen() {
      if (!isCssFullscreen) return;
      isCssFullscreen = false;
      if (stage) stage.classList.remove("viewport-fullscreen");
      doc.body.classList.remove("stage-fullscreen");
      get("fullscreen-css").textContent = "Test CSS Fullscreen";
      say("Exited CSS fullscreen.");
      focus(IDS.indexOf("fullscreen-css"));
    }

    function toggleCssFullscreen() {
      if (!mode) { say("Load an embed before testing fullscreen."); return; }
      if (isCssFullscreen) {
        leaveCssFullscreen();
        return;
      }
      isCssFullscreen = true;
      if (stage) stage.classList.add("viewport-fullscreen");
      doc.body.classList.add("stage-fullscreen");
      get("fullscreen-css").textContent = "Exit CSS Fullscreen";
      say("Entered CSS fullscreen. Note: this enlarges the iframe container, not the inner video element directly. Press Back to exit.");
    }

    function requestApiFullscreen() {
      if (!mode) { say("Load an embed before testing fullscreen."); return; }
      say("Requesting API fullscreen on the iframe container...");
      var req = frame.requestFullscreen || frame.webkitRequestFullscreen || frame.mozRequestFullScreen || frame.msRequestFullscreen;
      if (typeof req !== "function") {
        say("Fullscreen API is not supported on this iframe element.");
        note("fullscreen API unsupported");
        return;
      }
      try {
        var p = req.call(frame);
        if (p && typeof p.then === "function") {
          p.then(function () {
            say("Iframe requestFullscreen succeeded. Inspect TV to see if inner video or container filled screen.");
            note("fullscreen API resolved");
          }).catch(function (err) {
            say("Iframe requestFullscreen rejected: " + ((err && err.message) || "permission or engine error") + ".");
            note("fullscreen API rejected");
          });
        } else {
          say("Iframe requestFullscreen invoked (legacy synchronous). Inspect TV.");
          note("fullscreen API invoked");
        }
      } catch (err) {
        say("Iframe requestFullscreen threw: " + ((err && err.message) || err) + ".");
        note("fullscreen API threw");
      }
    }

    function stop(message) {
      clearTimers();
      isControllingPlayer = false;
      leaveCssFullscreen();
      mode = null;
      discardFrame();
      get("placeholder").hidden = false;
      get("mode").textContent = "Active mode: none.";
      note("unloaded");
      say(message || "Frame unloaded. Back returns to the fixture lab.");
      focus(IDS.indexOf("stop"));
    }
    function load(name) {
      if (disposed || !MODES[name]) return;
      if (mode) { say("Stop and unload before switching modes."); return; }
      isControllingPlayer = false;
      var selected = MODES[name];
      mode = name;
      loadSeen = false;
      observed = false;
      parentBlocked = false;
      get("mode").textContent = "Active mode: " + selected.label + ".";
      get("timing").textContent = "Iframe navigation timing: waiting for parent load event.";
      get("observation").textContent = "Visible TV observation: not recorded.";
      // Sandbox flags are applied at navigation time, so set them before src.
      if (selected.sandbox === null) {
        frame.removeAttribute("sandbox");
      } else {
        frame.setAttribute("sandbox", selected.sandbox);
      }
      if (selected.allow) {
        frame.setAttribute("allow", selected.allow);
      }
      frame.hidden = false;
      get("placeholder").hidden = true;
      startedAt = now();
      frame.src = selected.url;
      note("requested " + name);
      say("Requested " + selected.label + ". A load event will not prove it rendered; check the TV.");
      navigationTimer = clock.setTimeout(function () {
        navigationTimer = null;
        if (mode === name && !loadSeen && !parentBlocked) {
          note("no load event after 12s");
          say("No parent iframe load event after 12 seconds. Network, embedding policy, and browser behavior remain indistinguishable.");
        }
      }, 12000);
      focus(IDS.indexOf(name));
    }
    function controlAction(action) {
      if (!mode) {
        say("Load a provider before using playback controls.");
        return;
      }
      // Report verified facts: cross-origin players cannot be controlled without a verified external messaging API
      if (action === "play") {
        say("Play/Pause requested. Note: YapGrid and cross-origin providers have no public messaging API; use their on-screen player controls.");
        note("ctl-play requested");
      } else if (action === "seek-back") {
        say("Seek -10s requested. Note: YapGrid does not expose a parent seek API; use on-screen scrub controls.");
        note("ctl-seek-back requested");
      } else if (action === "seek-fwd") {
        say("Seek +10s requested. Note: YapGrid does not expose a parent seek API; use on-screen scrub controls.");
        note("ctl-seek-fwd requested");
      } else if (action === "sub") {
        say("Subtitles requested. Use 'YapGrid (en sub)' for ?lang=en, or 'YapGrid (sub off)' for empty VTT suppression, or use YapGrid's in-player CC menu.");
        note("ctl-sub requested");
      }
    }
    function enterPlayerControl() {
      if (!mode) {
        say("Load a provider before transferring remote control.");
        return;
      }
      isControllingPlayer = true;
      frame.tabIndex = 0;
      try {
        frame.focus({ preventScroll: true });
      } catch (_e) {
        try { frame.focus(); } catch (_e2) {}
      }
      note("transferred focus to player");
      say("Remote focus transferred to player. Use Vizio remote (OK, arrows) to operate in-player controls. If Back is trapped, use TV Home to exit and relaunch.");
    }
    function observe(value) {
      if (!mode) { say("Load a mode before recording a TV observation."); return; }
      observed = true;
      if (observationTimer !== null) { clock.clearTimeout(observationTimer); observationTimer = null; }
      get("observation").textContent = "Visible TV observation: " + value + " (manual; not detected by script).";
      note("manual observation");
    }
    function exit(url) {
      if (disposed) return;
      stop();
      disposed = true;
      nav.replace(url);
    }
    function activate(index) {
      var id = IDS[index];
      if (!id) return;
      if (MODES[id]) load(id);
      else if (id === "ctl-play") controlAction("play");
      else if (id === "ctl-seek-back") controlAction("seek-back");
      else if (id === "ctl-seek-fwd") controlAction("seek-fwd");
      else if (id === "ctl-sub") controlAction("sub");
      else if (id === "control-player") enterPlayerControl();
      else if (id === "fullscreen-api") requestApiFullscreen();
      else if (id === "fullscreen-css") toggleCssFullscreen();
      else if (id === "stop") stop();
      else if (id === "observed-player") observe("player visible");
      else if (id === "observed-blank") observe("blank after flash or load");
      else if (id === "observed-media-error") observe("media error shown inside frame");
      else if (id === "back-lab") exit("embed-lab.html");
      else if (id === "horizon") exit(HORIZON);
    }
    function onKey(event) {
      if (disposed) return;
      var key = keyName(event);
      if (key !== "OK" && key !== "Back" && key.indexOf("Arrow") !== 0) return;
      if (isControllingPlayer) {
        if (key === "Back") {
          event.preventDefault();
          if (typeof event.stopPropagation === "function") event.stopPropagation();
          isControllingPlayer = false;
          if (isCssFullscreen) {
            leaveCssFullscreen();
          } else {
            say("Returned focus to Horizon controls.");
            focus(IDS.indexOf("control-player"));
          }
        }
        return;
      }
      event.preventDefault();
      if (typeof event.stopPropagation === "function") event.stopPropagation();
      if (key === "Back") {
        if (event.repeat) return;
        if (isCssFullscreen) leaveCssFullscreen();
        else if (mode) stop();
        else exit("embed-lab.html");
      } else if (key === "OK") {
        if (!event.repeat) activate(focused);
      } else if (key === "ArrowLeft" || key === "ArrowUp") focus(focused - 1);
      else focus(focused + 1);
    }

    function onFrameLoad() {
      if (!mode || disposed) return;
      if (loadSeen) { note("additional iframe load event"); return; }
      loadSeen = true;
      if (navigationTimer !== null) { clock.clearTimeout(navigationTimer); navigationTimer = null; }
      var elapsed = Math.max(0, Math.round(now() - startedAt));
      get("timing").textContent = "Iframe load event: +" + elapsed + " ms from request (rendering and playback unverified).";
      note("iframe load event");
      if (parentBlocked) return;
      say("Parent received an iframe load event. Inspect the TV picture; cross-origin playback cannot be read here.");
      observationTimer = clock.setTimeout(function () {
        observationTimer = null;
        if (mode && !observed && !disposed) {
          note("no visual result reported");
          say("No visible result was recorded after the load event. Mark what the TV shows; this page cannot decide whether it is blank.");
        }
      }, 7000);
    }
    function onFrameError() {
      if (!mode || disposed) return;
      if (navigationTimer !== null) { clock.clearTimeout(navigationTimer); navigationTimer = null; }
      note("iframe error event");
      if (!parentBlocked) say("Parent received an iframe error signal. Cross-origin response details remain unavailable.");
    }
    function onFrameFocus() {
      if (mode && !disposed) {
        if (isControllingPlayer) {
          note("player iframe focused");
        } else {
          note("unexpected frame focus");
          focus(focused);
        }
      }
    }
    function bindFrame(target) {
      // Listeners on a discarded frame are ignored even if it fires late.
      target.addEventListener("load", function () { if (target === frame) onFrameLoad(); });
      target.addEventListener("error", function () { if (target === frame) onFrameError(); });
      target.addEventListener("focus", function () { if (target === frame) onFrameFocus(); });
    }

    controls.forEach(function (control, index) {
      control.addEventListener("focus", function () { focused = index; });
      control.addEventListener("click", function () { activate(index); });
    });
    bindFrame(frame);
    doc.addEventListener("securitypolicyviolation", function (event) {
      if (!mode || disposed || !event
        || (event.effectiveDirective !== "frame-src" && event.effectiveDirective !== "child-src")) return;
      parentBlocked = true;
      if (navigationTimer !== null) { clock.clearTimeout(navigationTimer); navigationTimer = null; }
      note("parent CSP blocked frame");
      say("Parent CSP blocked this frame. This does not report the provider's own embedding policy.");
    });
    root.addEventListener("error", function () {
      if (!disposed) { note("parent error event"); say("Parent page reported an error; child media state remains unavailable."); }
    });
    root.addEventListener("unhandledrejection", function () {
      if (!disposed) { note("parent promise rejection"); say("Parent operation rejected; child media state remains unavailable."); }
    });
    // Second focus guard: the parent window blurs when focus moves into a
    // child frame. If the iframe became the active element, pull focus back
    // so remote keys keep reaching this page's handlers.
    root.addEventListener("blur", function () {
      if (!mode || disposed || blurTimer !== null) return;
      blurTimer = clock.setTimeout(function () {
        blurTimer = null;
        if (mode && !disposed && doc.activeElement === frame) {
          if (isControllingPlayer) return;
          note("frame took focus; restored");
          focus(focused);
        }
      }, 0);
    });
    doc.addEventListener("keydown", onKey);
    root.addEventListener("pagehide", function () {
      if (disposed) return;
      clearTimers();
      mode = null;
      discardFrame();
      disposed = true;
    });
    focus(0);
    return { load: load, stop: stop, onKey: onKey };
  }

  root.HorizonEmbedMatrix = { createMatrix: createMatrix, keyName: keyName };
  if (typeof document !== "undefined") createMatrix(document, location, root);
})(typeof window !== "undefined" ? window : globalThis);
