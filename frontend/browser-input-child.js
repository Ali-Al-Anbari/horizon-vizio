(function () {
  "use strict";
  var core = window.HorizonInputCore;
  var count = 0;
  var status = document.getElementById("child-status");
  var button = document.getElementById("child-button");
  var link = document.getElementById("child-link");
  var input = document.getElementById("child-input");
  var targets = [button, link, input];
  var lastButtonAt = -1000;
  function report(type, details) {
    var message = { kind: "horizon-input-probe", type: type };
    if (details) {
      if (details.key) message.key = details.key;
      if (details.action) message.action = details.action;
    }
    window.parent.postMessage(message, window.location.origin);
  }
  window.addEventListener("keydown", function (event) {
    var key = core.safeKey(event);
    if (!key) return;
    report("key", { key: key });
    status.textContent = "Same-origin child received " + key + ".";
    if (key === "Back") {
      event.preventDefault();
      report("escape");
    } else if (key.indexOf("Arrow") === 0 && document.activeElement !== input) {
      event.preventDefault();
      var index = targets.indexOf(document.activeElement);
      var step = key === "ArrowRight" || key === "ArrowDown" ? 1 : -1;
      targets[Math.max(0, Math.min(targets.length - 1, index + step))].focus();
    } else if (key === "OK" && !event.repeat) {
      var active = document.activeElement;
      if (active === button || active === link) {
        event.preventDefault();
        active.click();
      }
    }
  }, true);
  button.addEventListener("click", function () {
    var now = Date.now();
    if (now - lastButtonAt < 120) return;
    lastButtonAt = now;
    document.getElementById("child-count").textContent = String(++count);
    report("action", { action: "button" });
  });
  link.addEventListener("click", function () {
    report("action", { action: "link" });
  });
  input.addEventListener("focus", function () {
    report("focus", { action: "input" });
  });
  report("ready");
})();
