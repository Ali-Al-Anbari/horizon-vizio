(function (root) {
  "use strict";

  var keys = { ArrowLeft: true, ArrowRight: true, ArrowUp: true, ArrowDown: true, OK: true, Back: true };
  var childTypes = { ready: true, key: true, focus: true, action: true, escape: true };
  var childActions = { button: true, link: true, input: true, frame: true, toolbar: true };
  var safeLabels = { "toolbar-focus": true, "local-focus": true, "external-focus": true,
    "keyboard-open": true, "local-ready": true, "child-escape": true,
    "local-load": true, "external-load": true, "parent-blur": true,
    "parent-focus": true, button: true, link: true, input: true };
  var owns = function (object, key) { return Object.prototype.hasOwnProperty.call(object, key); };

  function safeKey(event) {
    var key = root.HorizonBrowserCore.keyName(event);
    return owns(keys, key) ? key : null;
  }

  function acceptChildMessage(event, childWindow, origin) {
    if (!event || event.origin !== origin || event.source !== childWindow) return null;
    var data = event.data;
    if (!data || data.kind !== "horizon-input-probe" || !owns(childTypes, data.type)) return null;
    if (data.type === "key" && !owns(keys, data.key)) return null;
    if ((data.type === "focus" || data.type === "action") && !owns(childActions, data.action)) return null;
    return { type: data.type, key: data.type === "key" ? data.key : null,
      action: data.type === "focus" || data.type === "action" ? data.action : null };
  }

  function createRecorder(maximum) {
    var limit = Math.max(1, Math.min(24, maximum || 24));
    var entries = [];
    var parentKeys = 0;
    var childKeys = 0;
    function add(source, label, at) {
      if (source !== "parent" && source !== "child" && source !== "frame") return;
      if (!owns(keys, label) && !owns(safeLabels, label)) return;
      if (source === "parent" && owns(keys, label)) parentKeys++;
      if (source === "child" && owns(keys, label)) childKeys++;
      entries.push({ source: source, label: label, at: Math.max(0, Math.round(at || 0)) });
      if (entries.length > limit) entries.shift();
    }
    return {
      add: add,
      snapshot: function () { return { entries: entries.slice(), parentKeys: parentKeys, childKeys: childKeys }; },
      clear: function () { entries = []; parentKeys = 0; childKeys = 0; },
    };
  }

  root.HorizonInputCore = { safeKey: safeKey, acceptChildMessage: acceptChildMessage, createRecorder: createRecorder };
})(typeof window !== "undefined" ? window : globalThis);
