(function (root) {
  "use strict";

  // Concluded experiment (physical Vizio results recorded in
  // docs/VIDEO_LAB_EMBED_COMPATIBILITY.md). The modes below are kept exactly as
  // tested so the matrix stays reproducible. Do not add sandbox tokens to make
  // a provider play.
  var VIDLOVE = "https://player.vidlove.cc/embed/tv/2190/13/2";
  var YOUTUBE = "https://www.youtube.com/embed/M7lc1UVf-VE";
  var HORIZON = "https://horizon-vizio.ali-al-anbari.workers.dev/";
  var STRICT = "allow-scripts allow-presentation";
  var SAFETY_MS = 30000;
  var MODES = {
    strict: { label: "VidLove · strict", url: VIDLOVE, sandbox: STRICT },
    origin: { label: "VidLove · same-origin", url: VIDLOVE,
      sandbox: "allow-scripts allow-same-origin allow-presentation" },
    unsandboxed: { label: "VidLove · unsandboxed", url: VIDLOVE, sandbox: null },
    youtube: { label: "YouTube official sample · strict", url: YOUTUBE, sandbox: STRICT },
  };
  var IDS = ["strict", "origin", "unsandboxed", "youtube", "stop", "observed-player",
    "observed-blank", "observed-media-error", "back-lab", "horizon"];

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
    var startedAt = 0;
    var loadSeen = false;
    var observed = false;
    var parentBlocked = false;
    var navigationTimer = null;
    var observationTimer = null;
    var safetyTimer = null;
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
      if (safetyTimer !== null) { clock.clearTimeout(safetyTimer); safetyTimer = null; }
      if (blurTimer !== null) { clock.clearTimeout(blurTimer); blurTimer = null; }
    }
    // Replace the iframe with a never-navigated clone of the verified markup.
    // Removing the element destroys its browsing context (document, media
    // decoders, network, timers, nested ad frames) and drops the frame's
    // session-history entries, so a platform-level Back cannot traverse back
    // into the third-party page after unload. The clone's first navigation
    // replaces its initial about:blank entry instead of adding history.
    function discardFrame() {
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
    function stop(message) {
      clearTimers();
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
      // Runs from the request time regardless of render state or remote input;
      // this is why a frame that did render disappears about 30 s after OK.
      safetyTimer = clock.setTimeout(function () {
        safetyTimer = null;
        if (mode === name && !disposed) {
          note("30-second safety unload");
          stop("Frame auto-unloaded after 30 seconds. Back returns to the fixture lab.");
        }
      }, SAFETY_MS);
      focus(IDS.indexOf(name));
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
      if (index === 0) load("strict");
      else if (index === 1) load("origin");
      else if (index === 2) load("unsandboxed");
      else if (index === 3) load("youtube");
      else if (index === 4) stop();
      else if (index === 5) observe("player visible");
      else if (index === 6) observe("blank after flash or load");
      else if (index === 7) observe("media error shown inside frame");
      else if (index === 8) exit("embed-lab.html");
      else if (index === 9) exit(HORIZON);
    }
    function onKey(event) {
      if (disposed) return;
      var key = keyName(event);
      if (key !== "OK" && key !== "Back" && key.indexOf("Arrow") !== 0) return;
      event.preventDefault();
      if (typeof event.stopPropagation === "function") event.stopPropagation();
      if (key === "Back") {
        if (event.repeat) return;
        if (mode) stop();
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
      if (mode && !disposed) { note("unexpected frame focus"); focus(focused); }
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
