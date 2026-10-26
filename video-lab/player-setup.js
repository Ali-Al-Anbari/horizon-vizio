(function () {
  "use strict";
  var start = document.getElementById("start");
  var code = document.getElementById("code");
  var status = document.getElementById("status");
  var link = document.getElementById("continue");
  var timer = null;
  var active = false;
  function api(path, post) {
    return fetch(path, { method: post ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
      headers: post ? { "X-Horizon-Action": "pair" } : {} }).then(function (response) {
      return response.json().then(function (data) {
        if (!response.ok) throw new Error(data.code || "request_failed");
        return data;
      });
    });
  }
  function paired() {
    active = false;
    if (timer) clearTimeout(timer);
    start.hidden = true;
    code.textContent = "";
    status.textContent = "This Video Lab is paired. You can open the player.";
    link.hidden = false;
    link.focus();
  }
  function poll() {
    if (!active) return;
    api("/api/pair/status", true).then(function (result) {
      if (result.state === "paired") paired();
      else if (result.state === "pending" || result.state === "approved") {
        status.textContent = "Waiting for owner approval…";
        timer = setTimeout(poll, 2000);
      } else { active = false; status.textContent = "Pairing ended. Request a new code."; }
    }, function () { timer = setTimeout(poll, 3000); });
  }
  start.addEventListener("click", function () {
    if (active) return;
    api("/api/pair/start", true).then(function (result) {
      active = true;
      code.textContent = result.code;
      status.textContent = "Waiting for owner approval…";
      timer = setTimeout(poll, 1500);
    }, function (error) { status.textContent = "Pairing failed: " + error.message; });
  });
  api("/api/pair/session", false).then(paired, function () {
    status.textContent = "Press Show pairing code to begin.";
    start.focus();
  });
  window.addEventListener("pagehide", function () { active = false; if (timer) clearTimeout(timer); });
})();
