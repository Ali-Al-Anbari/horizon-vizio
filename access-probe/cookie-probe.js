(function () {
  "use strict";
  var status = document.getElementById("status");
  var controls = [
    document.getElementById("create"),
    document.getElementById("check"),
    document.getElementById("reload"),
    document.getElementById("clear")
  ];
  var focused = 0;
  var busy = false;

  function show(message) { status.textContent = message; }
  function focusControl(index) {
    focused = Math.max(0, Math.min(controls.length - 1, index));
    controls[focused].focus();
  }
  function request(path, method) {
    return fetch(path, {
      method: method,
      credentials: "same-origin",
      cache: "no-store",
      headers: method === "POST" ? { "X-Horizon-Probe": "cookie" } : {}
    });
  }
  function checkCookie() {
    if (typeof window.fetch !== "function") {
      show("This webview has no fetch API. The cloud frontend transport needs a compatibility change.");
      return;
    }
    if (busy) return;
    busy = true;
    show("Checking same-origin cookie...");
    request("/api/cookie/check", "GET")
      .then(function (response) {
        if (response.status !== 200) throw new Error("http_" + response.status);
        return response.json();
      })
      .then(function (body) {
        show(body.cookieSeen === true ? "Test cookie present in same-origin HTTPS request." :
          "Test cookie absent from same-origin HTTPS request.");
      })
      .catch(function () { show("Cookie check failed before a usable API response."); })
      .then(function () { busy = false; });
  }
  function changeCookie(path) {
    if (typeof window.fetch !== "function" || busy) return;
    busy = true;
    show(path.indexOf("clear") !== -1 ? "Clearing test cookie..." : "Creating test cookie...");
    request(path, "POST")
      .then(function (response) {
        if (response.status !== 204) throw new Error("http_" + response.status);
        busy = false;
        checkCookie();
      })
      .catch(function () {
        busy = false;
        show("Cookie update failed before a usable API response.");
      });
  }

  controls[0].addEventListener("click", function () { changeCookie("/api/cookie/start"); });
  controls[1].addEventListener("click", checkCookie);
  controls[2].addEventListener("click", function () { window.location.reload(); });
  controls[3].addEventListener("click", function () { changeCookie("/api/cookie/clear"); });
  controls.forEach(function (control, index) {
    control.addEventListener("focus", function () { focused = index; });
  });
  window.addEventListener("keydown", function (event) {
    var key = event.key;
    if (key === "ArrowRight" || key === "ArrowDown") {
      event.preventDefault();
      focusControl(focused + 1);
    } else if (key === "ArrowLeft" || key === "ArrowUp") {
      event.preventDefault();
      focusControl(focused - 1);
    } else if (key === "Enter" || key === "Select" || key === "OK" || key === "NumpadEnter") {
      event.preventDefault();
      if (!busy) controls[focused].click();
    }
  }, false);

  focusControl(0);
  checkCookie();
}());
