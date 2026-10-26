(function (root) {
  "use strict";

  // Concluded experiment: the VidLove candidate failed on the physical Vizio
  // (see docs/VIDEO_LAB_EMBED_COMPATIBILITY.md). It stays reachable only inside
  // this isolated preview for reproduction, under the unchanged strict sandbox.
  var CANDIDATE = "https://player.vidlove.cc/embed/tv/2190/13/2";
  var HORIZON = "https://horizon-vizio.ali-al-anbari.workers.dev/";
  var STRICT = "allow-scripts allow-presentation";
  var SOURCES = {
    fixtureA: "embed-fixture.html?view=a",
    fixtureB: "embed-fixture.html?view=b",
    candidate: CANDIDATE,
  };
  var IDS = ["fixture-a", "fixture-b", "load", "stop", "observed-player", "observed-blocked",
    "observed-media-error", "matrix", "back-lab", "horizon"];

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

  function createEmbedLab(doc, nav, clock) {
    var get = function (id) { return doc.getElementById(id); };
    var frame = get("candidate");
    if (!frame) return null;
    var controls = IDS.map(get);
    var focused = 0;
    var activeSource = null;
    var loadedSignal = false;
    var parentBlocked = false;
    var navigationTimer = null;
    var blurTimer = null;
    var disposed = false;
    var signals = [];

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
      if (blurTimer !== null) { clock.clearTimeout(blurTimer); blurTimer = null; }
    }
    // Replace the iframe with a never-navigated clone of the verified markup.
    // Removing the element destroys its browsing context (document, media,
    // network, timers, nested ad frames) and its session-history entries, so a
    // platform-level Back cannot return into the third-party page after unload.
    function discardFrame() {
      var parent = frame.parentNode;
      if (!parent || typeof frame.cloneNode !== "function") {
        frame.hidden = true;
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
      activeSource = null;
      loadedSignal = false;
      discardFrame();
      get("placeholder").hidden = false;
      note("unloaded");
      say(message || "Frame unloaded. Back returns to Video Lab.");
      focus(3);
    }
    function load(sourceName) {
      if (disposed) return;
      if (!SOURCES[sourceName]) return;
      if (activeSource === sourceName) { say("That frame is already loaded. Stop and unload before starting it again."); return; }
      clearTimers();
      // Fixture A -> B deliberately re-navigates the same frame (the verified
      // fixture B check). Any switch to or from the third-party candidate starts
      // from a fresh browsing context so nothing from one source outlives it.
      if (activeSource && (activeSource === "candidate" || sourceName === "candidate")) discardFrame();
      activeSource = sourceName;
      loadedSignal = false;
      parentBlocked = false;
      get("observation").textContent = "Visible TV observation: not recorded.";
      frame.hidden = false;
      get("placeholder").hidden = true;
      frame.src = SOURCES[sourceName];
      note("requested " + sourceName);
      say(sourceName === "candidate"
        ? "Requested candidate embed. Check the TV picture; playback cannot be confirmed by this page."
        : "Requested same-origin fixture. Confirm its large label and color visibly change on the TV.");
      navigationTimer = clock.setTimeout(function () {
        navigationTimer = null;
        if (activeSource === sourceName && !loadedSignal && !parentBlocked) {
          note("no load signal");
          say("No iframe navigation signal after 12 seconds. It may be blocked, unavailable, or slow. Stop unloads it.");
        }
      }, 12000);
      focus(sourceName === "fixtureA" ? 0 : sourceName === "fixtureB" ? 1 : 2);
    }
    function observe(value) {
      get("observation").textContent = "Visible TV observation: " + value + " (manual report; not detected by script).";
      note("manual observation");
    }
    function exit(url) {
      if (disposed) return;
      stop();
      disposed = true;
      nav.replace(url);
    }
    function activate(index) {
      if (index === 0) load("fixtureA");
      else if (index === 1) load("fixtureB");
      else if (index === 2) load("candidate");
      else if (index === 3) stop();
      else if (index === 4) observe("player visible");
      else if (index === 5) observe("blocked or blank frame");
      else if (index === 6) observe("media error shown by player");
      else if (index === 7) exit("embed-matrix.html");
      else if (index === 8) exit("index.html");
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
        if (activeSource) stop();
        else exit("index.html");
      } else if (key === "OK") {
        if (!event.repeat) activate(focused);
      } else if (key === "ArrowLeft" || key === "ArrowUp") focus(focused - 1);
      else focus(focused + 1);
    }

    function onFrameLoad() {
      if (!activeSource || disposed) return;
      loadedSignal = true;
      if (navigationTimer !== null) { clock.clearTimeout(navigationTimer); navigationTimer = null; }
      note("iframe load event");
      if (!parentBlocked) say(activeSource === "candidate"
        ? "Iframe navigation event received. It does not prove rendering, media support, or playback; check the TV."
        : "Fixture navigation event received. Confirm the fixture label is visible; the event alone does not prove rendering.");
    }
    function onFrameError() {
      if (!activeSource || disposed) return;
      if (navigationTimer !== null) { clock.clearTimeout(navigationTimer); navigationTimer = null; }
      note("iframe error event");
      say("Iframe reported a navigation error. The parent cannot inspect the cross-origin response.");
    }
    function onFrameFocus() {
      if (activeSource && !disposed) {
        note("unexpected frame focus");
        focus(focused);
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
      if (!activeSource || disposed || !event
        || (event.effectiveDirective !== "frame-src" && event.effectiveDirective !== "child-src")) return;
      parentBlocked = true;
      if (navigationTimer !== null) { clock.clearTimeout(navigationTimer); navigationTimer = null; }
      note("parent CSP blocked frame");
      say("Parent content policy blocked the frame. This page cannot load that source.");
    });
    root.addEventListener("error", function () {
      if (disposed) return;
      note("parent error event");
      say("Parent page reported an error. It does not reveal errors inside a cross-origin iframe.");
    });
    root.addEventListener("unhandledrejection", function () {
      if (disposed) return;
      note("parent promise rejection");
      say("Parent page reported a rejected operation. The iframe's playback state remains unknown.");
    });
    // Second focus guard: the parent window blurs when focus moves into a
    // child frame. If the iframe became the active element, pull focus back.
    root.addEventListener("blur", function () {
      if (!activeSource || disposed || blurTimer !== null) return;
      blurTimer = clock.setTimeout(function () {
        blurTimer = null;
        if (activeSource && !disposed && doc.activeElement === frame) {
          note("frame took focus; restored");
          focus(focused);
        }
      }, 0);
    });
    doc.addEventListener("keydown", onKey);
    root.addEventListener("pagehide", function () {
      if (disposed) return;
      clearTimers();
      activeSource = null;
      discardFrame();
      disposed = true;
    });
    focus(0);
    return { load: load, stop: stop, activate: activate, onKey: onKey };
  }

  root.HorizonEmbedLab = { createEmbedLab: createEmbedLab, keyName: keyName };
  if (typeof document !== "undefined") createEmbedLab(document, location, root);
})(typeof window !== "undefined" ? window : globalThis);
