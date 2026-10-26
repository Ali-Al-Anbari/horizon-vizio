(function () {
  "use strict";
  var browser = window.HorizonBrowserCore;
  var pointer = window.HorizonPointerCore;
  var input = window.HorizonInputCore;
  var $ = function (id) { return document.getElementById(id); };
  var viewport = $("viewport");
  var localFrame = $("local-frame");
  var externalFrame = $("external-frame");
  var cursorNode = $("cursor");
  var controls = [$("return-lab"), $("show-local"), $("show-links"), $("show-form"),
    $("show-google"), $("enter-cursor"), $("focus-frame"), $("restore-toolbar")];
  var mode = "toolbar";
  var surface = "local";
  var controlIndex = 5;
  var cursor = { x: 80, y: 80, lastKey: "", lastAt: 0, streak: 0 };
  var clock = function () { return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now(); };
  var started = clock();
  var log = pointer.createLog(12);
  var renderTimer = null;

  function say(value) { $("status").textContent = value; }
  function record(event) {
    log.add(event, clock() - started);
    if (renderTimer === null) renderTimer = setTimeout(render, 120);
  }
  function render() {
    renderTimer = null;
    var state = log.snapshot();
    $("mode").textContent = "Mode: " + mode;
    $("surface").textContent = "Surface: " + (surface === "local" ? "same-origin fixture" : surface);
    $("focus").textContent = "Focus: " + (document.activeElement === externalFrame ? "external frame"
      : document.activeElement === localFrame ? "same-origin frame" : "parent");
    $("keys").textContent = "B Parent remote keys: " + state.parentKeys;
    $("visible").textContent = "A Cursor visible: " + (cursorNode.hidden ? "no" : "yes");
    var events = $("events");
    events.textContent = "";
    for (var i = 0; i < state.entries.length; i++) {
      var item = document.createElement("li");
      item.textContent = "+" + state.entries[i].at + "ms " + state.entries[i].event;
      events.appendChild(item);
    }
  }
  function focus(element) {
    try { element.focus({ preventScroll: true }); }
    catch (_error) { element.focus(); }
  }
  function focusToolbar(index) {
    mode = pointer.nextMode(mode, "toolbar");
    controlIndex = browser.clamp(index === undefined ? 5 : index, 0, controls.length - 1);
    focus(controls[controlIndex]);
    record("toolbar-restored");
    render();
  }
  function paintCursor() {
    cursorNode.style.transform = "translate3d(" + (cursor.x - 12) + "px," + (cursor.y - 12) + "px,0)";
  }
  function clampCursor() {
    cursor.x = browser.clamp(cursor.x, 12, Math.max(12, viewport.clientWidth - 12));
    cursor.y = browser.clamp(cursor.y, 12, Math.max(12, viewport.clientHeight - 12));
    paintCursor();
  }
  function enterCursor() {
    mode = pointer.nextMode(mode, "cursor");
    cursor.lastKey = "";
    cursor.streak = 0;
    clampCursor();
    focus(viewport);
    record("parent-focus");
    say("Overlay cursor active. Move across the page; Back restores toolbar. External OK reports the browser-input boundary.");
    render();
  }
  function nativeFrameFocus() {
    mode = pointer.nextMode(mode, "frame");
    focus(surface === "local" ? localFrame : externalFrame);
    $("activation").textContent = "C Native frame activation: unverified; inspect the page";
    record("frame-focus-requested");
    say("Native frame focus requested. Try arrows, OK, text field and Back. Parent key count may stop; use TV Home if Back does not return.");
    render();
  }
  function setSurface(kind) {
    surface = kind;
    var local = kind === "local";
    localFrame.hidden = !local;
    externalFrame.hidden = local;
    if (local) {
      externalFrame.removeAttribute("src");
      say("Same-origin fixture. Cursor OK can request a synthetic local activation; test the visible button or link.");
    } else {
      externalFrame.src = kind === "links" ? "https://httpbin.org/links/5/0"
        : kind === "form" ? "https://httpbin.org/forms/post"
        : "https://www.google.com/search?q=interstellar";
      say(kind === "google" ? "Google is expected to block embedding. A load event is not proof of rendering."
        : "Inspect whether the external page visibly renders. Overlay cursor remains Horizon-owned.");
    }
    $("activation").textContent = "C External activation: unverified";
    focusToolbar(controls.indexOf($("enter-cursor")));
  }
  function localHitTarget() {
    try {
      var viewportRect = viewport.getBoundingClientRect();
      var frameRect = localFrame.getBoundingClientRect();
      var x = viewportRect.left + cursor.x - frameRect.left;
      var y = viewportRect.top + cursor.y - frameRect.top;
      var target = localFrame.contentWindow.document.elementFromPoint(x, y);
      while (target && target.tagName !== "BODY") {
        if (/^(BUTTON|A|INPUT)$/.test(target.tagName || "")) return target;
        target = target.parentNode;
      }
    } catch (_error) { return null; }
    return null;
  }
  function cursorOK() {
    if (pointer.activation(surface) !== "local-synthetic") {
      record("external-click-unavailable");
      $("activation").textContent = "C External activation: unavailable to parent JS";
      say("No external click was sent. Parent JavaScript cannot dispatch a real coordinate click into this frame.");
      return;
    }
    var target = localHitTarget();
    if (!target) { say("No same-origin fixture control under the cursor."); return; }
    try {
      if (target.tagName === "INPUT") target.focus();
      else target.click();
      record("local-action");
      $("activation").textContent = "C Same-origin synthetic action requested; external still unverified";
      say("Same-origin action requested. Confirm the visible button, link, or input result. This is not a trusted external click.");
    } catch (_error) { say("Same-origin activation failed."); }
  }
  function activateControl(element) {
    if (element === $("show-local")) setSurface("local");
    else if (element === $("show-links")) setSurface("links");
    else if (element === $("show-form")) setSurface("form");
    else if (element === $("show-google")) setSurface("google");
    else if (element === $("enter-cursor")) enterCursor();
    else if (element === $("focus-frame")) nativeFrameFocus();
    else if (element === $("restore-toolbar")) focusToolbar(5);
  }

  controls.forEach(function (element, index) {
    element.addEventListener("focus", function () { controlIndex = index; record("parent-focus"); });
    if (index > 0) element.addEventListener("click", function () { activateControl(element); });
  });
  window.addEventListener("keydown", function (event) {
    var key = input.safeKey(event);
    if (!key) return;
    event.preventDefault();
    if (event.stopPropagation) event.stopPropagation();
    record("parent-key");
    if (key === "Back") {
      if (!event.repeat) { focusToolbar(5); say("Parent received Back; toolbar restored."); }
      return;
    }
    if (mode === "cursor") {
      if (key === "OK" && !event.repeat) cursorOK();
      else if (key.indexOf("Arrow") === 0) {
        cursor = browser.moveCursor(cursor, key, event.repeat === true, clock(), viewport.clientWidth, viewport.clientHeight);
        paintCursor();
      }
      return;
    }
    if (mode === "frame") return; // Only reached if the frame did not take keyboard ownership.
    if (key === "ArrowLeft") focusToolbar(controlIndex - 1);
    else if (key === "ArrowRight") focusToolbar(controlIndex + 1);
    else if (key === "ArrowDown") enterCursor();
    else if (key === "OK" && !event.repeat && controlIndex > 0) activateControl(controls[controlIndex]);
    else if (key === "OK" && !event.repeat && controlIndex === 0) window.location.assign("browser-lab.html");
  }, true);
  window.addEventListener("message", function (event) {
    var message = input.acceptChildMessage(event, localFrame.contentWindow, window.location.origin);
    if (!message) return;
    if (message.type === "escape") { focusToolbar(5); say("Cooperating same-origin child returned focus to toolbar."); }
    else if (message.type === "action") { record("local-action"); say("Same-origin child reported a local action. External activation remains unverified."); }
  });
  externalFrame.addEventListener("load", function () {
    if (surface !== "local") { record("frame-load-indeterminate"); say("External frame load event. Inspect visible content; loading alone proves neither rendering nor interaction."); }
  });
  window.addEventListener("focus", function () { record("parent-focus"); });
  window.addEventListener("blur", function () { record("external-focus-unknown"); });
  window.addEventListener("resize", clampCursor);
  clampCursor();
  focusToolbar(5);
})();
