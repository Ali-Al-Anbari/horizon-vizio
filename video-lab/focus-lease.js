(function (root) {
  "use strict";

  // Extracts only the bounded handoff pattern used by focus-switch.js. The
  // physically tested focus-switch lab remains unchanged.
  function createFocusLease(frame, target, doc, clock, onRestore) {
    var timeout = null;
    var verifyTimeout = null;
    var active = false;
    var deadline = 0;

    function now() {
      return clock.performance && typeof clock.performance.now === "function"
        ? clock.performance.now() : Date.now();
    }
    function focus(element) {
      try { element.focus({ preventScroll: true }); }
      catch (_error) { element.focus(); }
    }
    function clearTimers() {
      if (timeout !== null) { clock.clearTimeout(timeout); timeout = null; }
      if (verifyTimeout !== null) { clock.clearTimeout(verifyTimeout); verifyTimeout = null; }
    }
    function recoveryTarget() {
      return typeof target === "function" ? target() : target;
    }
    function restore(reason) {
      if (!active) return false;
      clearTimers();
      active = false;
      frame.tabIndex = -1;
      var visibleTarget = recoveryTarget();
      focus(visibleTarget);
      onRestore(reason, Math.max(0, Math.round(now() - deadline)), doc.activeElement === visibleTarget);
      verifyTimeout = clock.setTimeout(function () {
        verifyTimeout = null;
        // Match the tested focus-switch lab: retry the same visible target
        // once if focus did not stay there after the handoff.
        if (!active && doc.activeElement !== visibleTarget) focus(visibleTarget);
      }, 250);
      return true;
    }
    function begin(duration) {
      if (active) return false;
      clearTimers();
      active = true;
      deadline = now() + duration;
      frame.tabIndex = 0;
      timeout = clock.setTimeout(function () { restore("timeout"); }, duration);
      try { focus(frame); }
      catch (_error) { restore("focus_error"); return false; }
      return true;
    }
    function dispose() {
      clearTimers();
      active = false;
      frame.tabIndex = -1;
    }
    return {
      begin: begin, restore: restore, dispose: dispose,
      isActive: function () { return active; },
      remainingMs: function () { return active ? Math.max(0, deadline - now()) : 0; },
    };
  }

  root.HorizonFocusLease = { create: createFocusLease };
})(typeof window !== "undefined" ? window : globalThis);
