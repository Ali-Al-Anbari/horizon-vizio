(function (root) {
  "use strict";

  var BUTTON_IDS = ["focus-parent", "focus-child", "arm", "restore", "window", "focus-target", "exit"];
  var WINDOWS_MS = [5000, 10000, 15000, 30000];

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

  function createFocusSwitch(doc, nav, clock) {
    var get = function (id) { return doc.getElementById(id); };
    var frame = get("player");
    if (!frame) return null;
    var controls = BUTTON_IDS.map(get);
    var target = get("focus-target");
    var selected = 2;
    var windowIndex = 1;
    var armed = false;
    var deadline = 0;
    var restoreTimer = null;
    var countdownTimer = null;
    var verifyTimer = null;
    var disposed = false;
    var okCount = 0;
    var events = [];
    var began = now();

    function now() {
      return clock.performance && typeof clock.performance.now === "function"
        ? clock.performance.now() : Date.now();
    }
    function note(message) {
      if (disposed) return;
      events.push("+" + Math.round(now() - began) + "ms " + message);
      if (events.length > 12) events.shift();
      get("events").textContent = "Parent events: " + events.join(" | ");
    }
    function focusName(element) {
      return element && (element.id || element.tagName) || "none";
    }
    function report() {
      if (disposed) return;
      var hasFocus = "unavailable";
      try { if (typeof doc.hasFocus === "function") hasFocus = String(doc.hasFocus()); }
      catch (_error) { hasFocus = "error"; }
      get("focus-report").textContent = "Browser report: activeElement=" + focusName(doc.activeElement)
        + "; document.hasFocus()=" + hasFocus + "; requested=" + (armed ? "YapGrid" : "Horizon")
        + ". Remote routing requires a physical test.";
    }
    function focusButton(index) {
      selected = Math.max(0, Math.min(controls.length - 1, index));
      try { controls[selected].focus({ preventScroll: true }); }
      catch (_error) { controls[selected].focus(); }
      report();
    }
    function clearTransferTimers() {
      if (restoreTimer !== null) { clock.clearTimeout(restoreTimer); restoreTimer = null; }
      if (countdownTimer !== null) { clock.clearInterval(countdownTimer); countdownTimer = null; }
      if (verifyTimer !== null) { clock.clearTimeout(verifyTimer); verifyTimer = null; }
    }
    function updateCountdown() {
      if (!armed || disposed) return;
      var remaining = Math.max(0, Math.ceil((deadline - now()) / 1000));
      get("countdown").textContent = "Automatic restoration in " + remaining + " s";
    }
    function restore(reason) {
      if (disposed) return;
      var overdue = armed ? Math.max(0, Math.round(now() - deadline)) : 0;
      clearTransferTimers();
      armed = false;
      frame.tabIndex = -1;
      get("countdown").textContent = "Automatic restoration: idle";
      get("state").textContent = "Horizon focus requested (" + reason + "). Press OK on the highlighted target to verify remote routing.";
      note("restore " + reason + (overdue ? "; timer late " + overdue + "ms" : ""));
      focusButton(BUTTON_IDS.indexOf("focus-target"));
      verifyTimer = clock.setTimeout(function () {
        verifyTimer = null;
        if (disposed || armed) return;
        if (doc.activeElement !== target) {
          note("target not active after restore; retry once");
          focusButton(BUTTON_IDS.indexOf("focus-target"));
        }
        note("restore check: activeElement=" + focusName(doc.activeElement) + "; remote unverified");
        report();
      }, 250);
    }
    function transfer(duration, label) {
      if (disposed) return;
      if (armed) { note("overlapping transfer ignored"); return; }
      clearTransferTimers();
      armed = true;
      deadline = now() + duration;
      frame.tabIndex = 0;
      restoreTimer = clock.setTimeout(function () { restore("automatic"); }, duration);
      countdownTimer = clock.setInterval(updateCountdown, 500);
      updateCountdown();
      get("state").textContent = label + ": iframe focus requested. The parent cannot observe child key events or playback.";
      note(label + " requested for " + duration / 1000 + "s");
      try { frame.focus({ preventScroll: true }); }
      catch (_error) {
        try { frame.focus(); }
        catch (_secondError) { note("iframe focus() failed"); restore("focus error"); return; }
      }
      note("iframe focus() returned; activeElement=" + focusName(doc.activeElement));
      report();
    }
    function activate(id) {
      if (id === "focus-parent") restore("Focus Horizon button");
      else if (id === "focus-child") transfer(3000, "Short YapGrid focus");
      else if (id === "arm") transfer(WINDOWS_MS[windowIndex], "Armed focus transfer");
      else if (id === "restore") restore("manual Restore button");
      else if (id === "window") {
        windowIndex = (windowIndex + 1) % WINDOWS_MS.length;
        get("window").textContent = "Window: " + WINDOWS_MS[windowIndex] / 1000 + " s";
        note("transfer window set to " + WINDOWS_MS[windowIndex] / 1000 + "s");
      } else if (id === "focus-target") {
        okCount += 1;
        get("ok-count").textContent = "Horizon target OK activations: " + okCount;
        note("Horizon target activated; parent received OK");
      } else if (id === "exit") {
        clearTransferTimers();
        disposed = true;
        nav.replace("embed-matrix.html");
      }
    }
    function onKey(event) {
      if (disposed) return;
      var key = keyName(event);
      if (key !== "OK" && key !== "Back" && key.indexOf("Arrow") !== 0) return;
      event.preventDefault();
      if (typeof event.stopPropagation === "function") event.stopPropagation();
      note("parent keydown " + key + (event.repeat ? " repeat" : ""));
      if (key === "Back") {
        if (event.repeat) return;
        if (armed) restore("parent Back");
        else activate("exit");
      } else if (key === "OK") {
        if (!event.repeat) controls[selected].click();
      } else if (key === "ArrowLeft" || key === "ArrowUp") focusButton(selected - 1);
      else focusButton(selected + 1);
    }

    controls.forEach(function (control, index) {
      control.addEventListener("focus", function () { selected = index; note("focus " + control.id); report(); });
      control.addEventListener("click", function () { activate(BUTTON_IDS[index]); });
    });
    frame.addEventListener("focus", function () { note("focus player iframe"); report(); });
    frame.addEventListener("load", function () {
      note("iframe load event; rendering/playback unverified");
      report();
    });
    frame.addEventListener("error", function () { note("iframe error event; child details unavailable"); });
    doc.addEventListener("focusin", function (event) { note("focusin " + focusName(event.target)); report(); });
    doc.addEventListener("focusout", function (event) { note("focusout " + focusName(event.target)); report(); });
    doc.addEventListener("keydown", onKey);
    clock.addEventListener("focus", function () { note("parent window focus"); report(); });
    clock.addEventListener("blur", function () { note("parent window blur"); report(); });
    clock.addEventListener("pagehide", function () { clearTransferTimers(); disposed = true; });
    focusButton(selected);
    get("state").textContent = "Horizon focus requested. Press OK to arm a 10-second transfer.";
    note("parent focus initialized; remote routing unverified");
    return { transfer: transfer, restore: restore, onKey: onKey };
  }

  root.HorizonFocusSwitch = { createFocusSwitch: createFocusSwitch, keyName: keyName };
  if (typeof document !== "undefined") createFocusSwitch(document, location, root);
})(typeof window !== "undefined" ? window : globalThis);
