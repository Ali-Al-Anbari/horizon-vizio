(function (root) {
  "use strict";

  // Chromium 79 (LG webOS 6.x) lacks Element/Document/DocumentFragment.prototype.replaceChildren (added in Chromium 86).
  function polyfillReplaceChildren(proto) {
    if (!proto || typeof proto.replaceChildren === "function") return;
    proto.replaceChildren = function () {
      while (this.firstChild) {
        this.removeChild(this.firstChild);
      }
      for (var i = 0; i < arguments.length; i++) {
        var node = arguments[i];
        if (typeof node === "string") {
          this.appendChild(document.createTextNode(node));
        } else if (node !== null && node !== undefined) {
          this.appendChild(node);
        }
      }
    };
  }

  if (typeof Element !== "undefined") polyfillReplaceChildren(Element.prototype);
  if (typeof Document !== "undefined") polyfillReplaceChildren(Document.prototype);
  if (typeof DocumentFragment !== "undefined") polyfillReplaceChildren(DocumentFragment.prototype);

  if (typeof NodeList !== "undefined" && NodeList.prototype && typeof NodeList.prototype.forEach !== "function") {
    NodeList.prototype.forEach = Array.prototype.forEach;
  }

  function detectFlexGap(doc) {
    try {
      var flex = doc.createElement("div");
      flex.style.display = "flex";
      flex.style.flexDirection = "column";
      flex.style.rowGap = "1px";
      flex.style.position = "absolute";
      flex.style.visibility = "hidden";
      flex.appendChild(doc.createElement("div"));
      flex.appendChild(doc.createElement("div"));
      var host = doc.body || doc.documentElement;
      if (!host) return true;
      host.appendChild(flex);
      var supported = flex.scrollHeight === 1;
      host.removeChild(flex);
      return supported;
    } catch (_e) {
      return false;
    }
  }

  function detectLGMode() {
    var search = (root.location && root.location.search) ? root.location.search : "";
    if (/[?&]lg=0\b/i.test(search)) {
      try { root.sessionStorage.removeItem("horizon-lg-mode"); } catch (_e) {}
      return false;
    }
    if (/[?&]lg=1\b/i.test(search)) {
      try { root.sessionStorage.setItem("horizon-lg-mode", "1"); } catch (_e) {}
      return true;
    }
    var ua = (root.navigator && root.navigator.userAgent) ? root.navigator.userAgent : "";
    if (root.PalmSystem || root.webOS || root.PalmServiceBridge || /Web0S|webOS|NetCast/i.test(ua)) {
      return true;
    }
    try {
      if (root.sessionStorage.getItem("horizon-lg-mode") === "1") return true;
    } catch (_e) {}
    return false;
  }

  root.__HORIZON_LG_MODE__ = detectLGMode();

  var doc = root.document;
  if (doc && doc.documentElement) {
    if (root.__HORIZON_LG_MODE__) {
      doc.documentElement.classList.add("lg-mode");
    }
    if (!detectFlexGap(doc)) {
      doc.documentElement.classList.add("lg-no-flex-gap");
    }
  }
})(typeof window !== "undefined" ? window : globalThis);
