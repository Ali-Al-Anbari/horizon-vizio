(function () {
  "use strict";
  var inputCore = window.HorizonInputCore;
  var $ = function (id) { return document.getElementById(id); };
  var localFrame = $("local-frame");
  var externalFrame = $("external-frame");
  var controls = [$("back-lab"), $("focus-toolbar"), $("show-local"), $("show-example"),
    $("show-links"), $("show-form"), $("show-google"), $("focus-page"), $("open-keyboard"), $("clear-events")];
  var surface = "local";
  var localReady = false;
  var controlIndex = 1;
  var mode = "toolbar";
  var started = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  var recorder = inputCore.createRecorder(24);
  var renderTimer = null;
  var keyboard = new window.HorizonTVKeyboard($("keyboard-panel"), $("keyboard-preview"), $("keyboard-grid"), function () {
    mode = "toolbar";
    $("local-input").value = "";
    focusToolbar(controls.indexOf($("open-keyboard")));
    say("Parent-owned keyboard closed. No text was recorded.");
  });

  function elapsed() {
    return (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()) - started;
  }
  function say(message) { $("input-status").textContent = message; }
  function record(source, label) {
    recorder.add(source, label, elapsed());
    if (renderTimer !== null) return;
    renderTimer = setTimeout(render, 120);
  }
  function render() {
    renderTimer = null;
    var report = recorder.snapshot();
    $("parent-count").textContent = "Parent keys: " + report.parentKeys;
    $("child-count").textContent = "Child keys: " + report.childKeys;
    var active = document.activeElement;
    $("focus-label").textContent = active === localFrame ? "Same-origin frame focused"
      : active === externalFrame ? "External frame focused"
      : mode === "keyboard" ? "Parent keyboard focused" : "Parent toolbar focused";
    var list = $("event-list");
    list.textContent = "";
    for (var i = 0; i < report.entries.length; i++) {
      var entry = report.entries[i];
      var item = document.createElement("li");
      item.textContent = "+" + entry.at + "ms " + entry.source + " " + entry.label;
      list.appendChild(item);
    }
  }
  function focusToolbar(index) {
    mode = "toolbar";
    controlIndex = Math.max(0, Math.min(controls.length - 1, index === undefined ? 1 : index));
    try { controls[controlIndex].focus({ preventScroll: true }); }
    catch (_error) { controls[controlIndex].focus(); }
    record("frame", "toolbar-focus");
  }
  function setSurface(kind) {
    surface = kind;
    var local = kind === "local";
    localFrame.hidden = !local;
    externalFrame.hidden = local;
    if (local) {
      externalFrame.removeAttribute("src");
      $("surface-label").textContent = "Same-origin page";
      say("Cooperating same-origin page. Focus page, then test arrows, OK, and Back.");
    } else {
      var destination = kind === "example" ? "https://example.com/"
        : kind === "links" ? "https://httpbin.org/links/5/0"
        : kind === "form" ? "https://httpbin.org/forms/post"
        : "https://www.google.com/search?q=interstellar";
      $("surface-label").textContent = kind === "example" ? "example.com"
        : kind === "links" ? "External links"
        : kind === "form" ? "External form" : "Google Search";
      externalFrame.src = destination;
      say(kind === "google"
        ? "Google Search advertises SAMEORIGIN framing. Inspect the viewport; load events do not prove rendering."
        : "External frame requested. Inspect visible rendering; then Focus page to test native remote input.");
    }
    focusToolbar(controls.indexOf($("focus-page")));
  }
  function focusPage() {
    if (surface === "local") {
      if (!localReady) { say("Same-origin page has not signaled readiness yet."); return; }
      try {
        localFrame.contentWindow.document.getElementById("child-button").focus();
        mode = "frame";
        record("frame", "local-focus");
        say("Same-origin button focused. Child reports its own keys; Back should return to toolbar.");
      } catch (_error) { say("Same-origin child focus was unavailable. Try again after it loads."); }
    } else {
      mode = "frame";
      try { externalFrame.focus({ preventScroll: true }); }
      catch (_error) { externalFrame.focus(); }
      record("frame", "external-focus");
      say("External frame focus requested. Try arrows, OK, and Back; parent cannot see its internal key events.");
    }
  }
  function openKeyboard() {
    mode = "keyboard";
    $("local-input").value = "";
    keyboard.open($("local-input"));
    record("frame", "keyboard-open");
    say("Parent-owned keyboard is visible over the current frame. It cannot type into an external website.");
  }
  function clearEvents() {
    recorder.clear();
    if (renderTimer !== null) clearTimeout(renderTimer);
    renderTimer = null;
    render();
    say("Local event counts cleared.");
  }
  function act(element) {
    if (element === $("focus-toolbar")) focusToolbar(1);
    else if (element === $("show-local")) setSurface("local");
    else if (element === $("show-example")) setSurface("example");
    else if (element === $("show-links")) setSurface("links");
    else if (element === $("show-form")) setSurface("form");
    else if (element === $("show-google")) setSurface("google");
    else if (element === $("focus-page")) focusPage();
    else if (element === $("open-keyboard")) openKeyboard();
    else if (element === $("clear-events")) clearEvents();
  }

  controls.forEach(function (element, index) {
    element.addEventListener("focus", function () { controlIndex = index; record("frame", "toolbar-focus"); });
    if (element !== $("back-lab")) element.addEventListener("click", function () { act(element); });
  });
  window.addEventListener("keydown", function (event) {
    var key = inputCore.safeKey(event);
    if (!key) return;
    record("parent", key);
    if (mode === "keyboard") {
      event.preventDefault();
      if (key === "Back") keyboard.close();
      else if (key === "OK" && !event.repeat) keyboard.press();
      else if (key.indexOf("Arrow") === 0) keyboard.move(key);
      return;
    }
    if (key === "Back") {
      event.preventDefault();
      focusToolbar(1);
      say("Parent received Back and restored toolbar focus.");
      return;
    }
    if (document.activeElement === externalFrame || document.activeElement === localFrame) return;
    if (key === "ArrowDown") { event.preventDefault(); focusPage(); }
    else if (key === "ArrowLeft") { event.preventDefault(); focusToolbar(controlIndex - 1); }
    else if (key === "ArrowRight") { event.preventDefault(); focusToolbar(controlIndex + 1); }
    else if (key === "OK" && !event.repeat) { event.preventDefault(); controls[controlIndex].click(); }
  }, true);
  window.addEventListener("message", function (event) {
    var message = inputCore.acceptChildMessage(event, localFrame.contentWindow, window.location.origin);
    if (!message) return;
    if (message.type === "ready") { localReady = true; record("frame", "local-ready"); }
    else if (message.type === "key") record("child", message.key);
    else if (message.type === "focus" || message.type === "action") record("child", message.action);
    else if (message.type === "escape") {
      record("frame", "child-escape");
      focusToolbar(1);
      say("Cooperating child requested toolbar focus after Back.");
    }
  });
  localFrame.addEventListener("load", function () { record("frame", "local-load"); });
  externalFrame.addEventListener("load", function () {
    if (surface !== "local") {
      record("frame", "external-load");
      say("External iframe load event. Inspect visible content; this does not prove that the site rendered.");
    }
  });
  window.addEventListener("blur", function () { record("frame", "parent-blur"); });
  window.addEventListener("focus", function () { record("frame", "parent-focus"); });
  focusToolbar(1);
  render();
})();
