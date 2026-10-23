(function () {
  "use strict";
  var status = document.getElementById("status");
  var signIn = document.getElementById("sign-in");
  var check = document.getElementById("check");
  var focused = 0;

  function focusControl(index) {
    focused = index;
    (index === 0 ? signIn : check).focus();
  }

  window.addEventListener("keydown", function (event) {
    var key = event.key;
    if (key === "ArrowRight" || key === "ArrowDown") {
      event.preventDefault();
      focusControl(1);
    } else if (key === "ArrowLeft" || key === "ArrowUp") {
      event.preventDefault();
      focusControl(0);
    } else if (key === "Enter" || key === "Select" || key === "OK" || key === "NumpadEnter") {
      event.preventDefault();
      if (focused === 0) window.location.href = signIn.href;
      else if (!check.disabled) check.click();
    }
  }, false);

  function show(message) { status.textContent = message; }
  function checkSession() {
    if (typeof window.fetch !== "function") {
      show("This webview has no fetch API. Navigation may work, but Horizon's cloud API transport needs a compatibility change.");
      return;
    }
    check.disabled = true;
    show("Checking same-origin session...");
    fetch("/api/auth/probe", { credentials: "same-origin", cache: "no-store", redirect: "follow" })
      .then(function (response) {
        var type = response.headers.get("content-type") || "";
        if (type.indexOf("application/json") === -1) {
          show("Access returned a login page or redirect to the API request. The session was not usable for same-origin fetch.");
          return null;
        }
        return response.json().then(function (body) {
          if (response.status === 200 && body.authenticated === true && body.code === "owner_verified") {
            show("Owner verified. Same-origin API request carried a usable Access session.");
          } else if (body.code === "access_assertion_missing") {
            show("The Worker received no Access assertion. Check the Access path rule and session cookie.");
          } else if (body.code === "authorization_rejected") {
            show("Access assertion reached the Worker, but signature, audience, issuer, or owner check failed.");
          } else if (body.code === "authorization_unconfigured") {
            show("Staging Worker authentication settings are missing.");
          } else {
            show("Session check failed. HTTP " + response.status + "; code " + String(body.code || "unknown") + ".");
          }
          return null;
        });
      })
      .catch(function () {
        show("The same-origin request failed before a readable response. Check network, redirects, and webview restrictions.");
      })
      .then(function () { check.disabled = false; if (focused === 1) focusControl(1); });
  }

  signIn.addEventListener("focus", function () { focused = 0; });
  check.addEventListener("focus", function () { focused = 1; });
  check.addEventListener("click", checkSession);
  focusControl(0);
  if (window.location.search.indexOf("access=returned") !== -1) checkSession();
}());
