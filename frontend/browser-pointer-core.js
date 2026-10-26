(function (root) {
  "use strict";

  var allowedEvents = {
    "parent-key": true, "parent-focus": true, "frame-focus-requested": true,
    "frame-load-indeterminate": true, "local-action": true,
    "external-click-unavailable": true, "external-focus-unknown": true,
    "toolbar-restored": true,
  };

  function nextMode(mode, action) {
    if (action === "toolbar" || action === "back") return "toolbar";
    if (action === "cursor") return "cursor";
    if (action === "frame") return "frame";
    return mode;
  }

  function activation(surface) {
    return surface === "local" ? "local-synthetic" : "external-unavailable";
  }

  function createLog(limit) {
    var maximum = Math.max(1, Math.min(16, limit || 12));
    var entries = [];
    var parentKeys = 0;
    return {
      add: function (event, at) {
        if (!Object.prototype.hasOwnProperty.call(allowedEvents, event)) return;
        if (event === "parent-key") parentKeys++;
        entries.push({ event: event, at: Math.max(0, Math.round(at || 0)) });
        if (entries.length > maximum) entries.shift();
      },
      snapshot: function () { return { parentKeys: parentKeys, entries: entries.slice() }; },
    };
  }

  root.HorizonPointerCore = { nextMode: nextMode, activation: activation, createLog: createLog };
})(typeof window !== "undefined" ? window : globalThis);
