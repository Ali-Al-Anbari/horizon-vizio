(function (root) {
  "use strict";

  var rows = [
    ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
    ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
    ["z", "x", "c", "v", "b", "n", "m", ".", ",", "?"],
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
    ["Shift", "Space", "Backspace", "Clear", "Enter"],
  ];

  function keyName(event) {
    var key = event && event.key;
    if (key === "Enter" || key === "Select" || key === "OK" || key === "NumpadEnter") return "OK";
    if (key === "Escape" || key === "Backspace" || key === "BrowserBack" || key === "GoBack") return "Back";
    if (key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown") return key;
    // Some embedded browsers report an unidentified key but retain its standard code.
    var code = event && (event.keyCode || event.which);
    if (code === 13) return "OK";
    if (code === 8 || code === 27 || code === 4) return "Back";
    if (code >= 37 && code <= 40) return ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"][code - 37];
    return key || "Unknown";
  }

  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }

  var CURSOR_MOTION = { single: 16, repeatGain: 7, max: 58 };

  function moveCursor(cursor, key, repeated, at, width, height) {
    // Two deliberate presses remain two precise moves. Only a reported held-key
    // repeat accelerates; timing alone cannot distinguish a hold from two taps.
    var streak = repeated && key === cursor.lastKey ? Math.min(6, cursor.streak + 1) : 0;
    var step = Math.min(CURSOR_MOTION.max, CURSOR_MOTION.single + streak * CURSOR_MOTION.repeatGain);
    var dx = key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0;
    var dy = key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0;
    return {
      x: clamp(cursor.x + dx, 12, Math.max(12, width - 12)),
      y: clamp(cursor.y + dy, 12, Math.max(12, height - 12)),
      lastKey: key,
      lastAt: at,
      streak: streak,
      edgeY: dy !== 0 && (cursor.y + dy < 12 || cursor.y + dy > height - 12) ? dy : 0,
    };
  }

  function moveKey(position, direction) {
    var row = position.row;
    var col = position.col;
    if (direction === "ArrowUp") row = Math.max(0, row - 1);
    if (direction === "ArrowDown") row = Math.min(rows.length - 1, row + 1);
    if (direction === "ArrowLeft") col = Math.max(0, col - 1);
    if (direction === "ArrowRight") col = Math.min(rows[row].length - 1, col + 1);
    return { row: row, col: Math.min(col, rows[row].length - 1) };
  }

  function editValue(value, key, shifted) {
    if (key === "Shift") return { value: value, shifted: !shifted, done: false };
    if (key === "Backspace") return { value: value.slice(0, -1), shifted: shifted, done: false };
    if (key === "Clear") return { value: "", shifted: shifted, done: false };
    if (key === "Enter") return { value: value, shifted: shifted, done: true };
    if (key === "Space") return { value: value + " ", shifted: shifted, done: false };
    if (typeof key === "string" && key.length === 1) {
      return { value: value + (shifted ? key.toUpperCase() : key), shifted: shifted, done: false };
    }
    return { value: value, shifted: shifted, done: false };
  }

  var GOOGLE_SEARCH_PREFIX = "https://www.google.com/search?q=";

  function parseHttps(value) {
    try {
      if (value.slice(0, 8).toLowerCase() !== "https://"
          || value.slice(8).split(/[/?#]/, 1)[0].indexOf("@") >= 0) return null;
      var url;
      if (typeof URL === "function") url = new URL(value);
      else if (typeof document !== "undefined") {
        url = document.createElement("a");
        url.href = value;
      } else return null;
      if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
      return url.href;
    } catch (_error) {
      return null;
    }
  }

  function domainPrefix(value) {
    var host = value.split(/[/?#]/, 1)[0];
    var port = host.match(/:(\d+)$/);
    if (port) {
      if (+port[1] < 1 || +port[1] > 65535) return false;
      host = host.slice(0, -port[0].length);
    }
    if (host.length > 253 || host.indexOf(".") < 0) return false;
    var labels = host.split(".");
    for (var index = 0; index < labels.length; index++) {
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(labels[index])) return false;
    }
    return /^[a-z]{2,63}$/i.test(labels[labels.length - 1]) || /^\d+$/.test(labels[labels.length - 1]);
  }

  function resolveInput(text, searchPrefix) {
    var value = String(text || "").trim();
    if (!value) return { kind: "empty" };
    if (/[\u0000-\u001f\u007f\\]/.test(value) || value.slice(0, 2) === "//") return { kind: "invalid" };
    var explicitHttps = /^https:\/\//i.test(value);
    if (explicitHttps || domainPrefix(value)) {
      var url = parseHttps(explicitHttps ? value : "https://" + value);
      return url ? { kind: "url", url: url } : { kind: "invalid" };
    }
    // Reject unsupported schemes rather than searching for their text.
    if (/^[a-z][a-z0-9+.-]*:[^\s]/i.test(value)) return { kind: "invalid" };
    var prefix = searchPrefix || GOOGLE_SEARCH_PREFIX;
    if (!parseHttps(prefix) || prefix.indexOf("?q=") < 0) return { kind: "invalid" };
    return { kind: "search", url: prefix + encodeURIComponent(value) };
  }

  function httpsAddress(text) {
    var result = resolveInput(text);
    return result.kind === "url" ? result.url : null;
  }

  root.HorizonBrowserCore = {
    rows: rows, keyName: keyName, clamp: clamp, moveCursor: moveCursor,
    moveKey: moveKey, editValue: editValue, httpsAddress: httpsAddress,
    CURSOR_MOTION: CURSOR_MOTION,
    resolveInput: resolveInput, GOOGLE_SEARCH_PREFIX: GOOGLE_SEARCH_PREFIX,
  };
})(typeof window !== "undefined" ? window : globalThis);
