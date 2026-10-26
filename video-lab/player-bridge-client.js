(function (root) {
  "use strict";
  // Preview-only same-origin adapter. TV and controller secrets stay off-page.
  function request(path, body) {
    var hasBody = body !== undefined;
    return fetch("/api/player/" + path, {
      method: hasBody ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
      keepalive: path === "close",
      headers: hasBody ? { "Content-Type": "application/json", "X-Horizon-Action": "player" } : {},
      body: hasBody ? JSON.stringify(body) : undefined,
    }).then(function (response) {
      return response.json().then(function (data) {
        if (!response.ok) throw new Error(data.error || data.code || "bridge_error");
        return data;
      });
    });
  }

  function newId() {
    var bytes = new Uint8Array(16);
    root.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    var value = Array.prototype.map.call(bytes, function (byte) {
      var hex = byte.toString(16);
      return hex.length === 1 ? "0" + hex : hex;
    }).join("");
    return value.slice(0, 8) + "-" + value.slice(8, 12) + "-" + value.slice(12, 16)
      + "-" + value.slice(16, 20) + "-" + value.slice(20);
  }

  function create(clock) {
    var visible = false;
    var generation = 0;
    var renewal = null;
    var openPromise = null;
    var startPromise = null;
    var closePromise = Promise.resolve();
    var sequence = 0;
    var serverOffset = 0;

    function updateClock(result) {
      if (result && typeof result.serverNow === "number" && isFinite(result.serverNow)) {
        serverOffset = result.serverNow - Date.now();
      }
    }

    function clearRenewal() {
      if (renewal !== null) { clock.clearTimeout(renewal); renewal = null; }
    }
    function scheduleRenewal(epoch) {
      clearRenewal();
      if (!visible || epoch !== generation) return;
      renewal = clock.setTimeout(function () {
        renewal = null;
        if (!visible || epoch !== generation) return;
        request("renew", {}).then(function (result) { updateClock(result); scheduleRenewal(epoch); }, function () {
          visible = false; // fail closed; next reveal may open a new session
        });
      }, 2000);
    }
    function waitReady(epoch, count) {
      if (!visible || epoch !== generation) return Promise.reject(new Error("session_closed"));
      if (count >= 50) return Promise.reject(new Error("preparation_timeout"));
      return request("status").then(function (result) {
        if (!visible || epoch !== generation) throw new Error("session_closed");
        updateClock(result);
        if (result.state === "ready") return true;
        if (result.state !== "preparing") throw new Error("player_session_closed");
        return new Promise(function (resolve) {
          clock.setTimeout(resolve, 100);
        }).then(function () { return waitReady(epoch, count + 1); });
      });
    }
    function open() {
      if (visible && openPromise) return openPromise;
      visible = true;
      var epoch = ++generation;
      sequence = 0;
      startPromise = closePromise.then(function () {
        return request("open", {});
      });
      openPromise = startPromise.then(function () {
        scheduleRenewal(epoch);
        return waitReady(epoch, 0);
      }).catch(function (error) {
        if (epoch === generation) {
          visible = false;
          clearRenewal();
        }
        throw error;
      });
      return openPromise;
    }
    function close() {
      var wasOpened = openPromise !== null;
      var previous = startPromise;
      visible = false;
      generation += 1;
      clearRenewal();
      openPromise = null;
      startPromise = null;
      if (wasOpened) closePromise = Promise.resolve(previous).catch(function () {})
        .then(function () { return request("close", {}); }).catch(function () {});
      return closePromise;
    }
    function send(command) {
      if (!visible || !openPromise) return Promise.reject(new Error("session_closed"));
      return openPromise.then(function () {
        if (!visible) throw new Error("session_closed");
        var next = ++sequence;
        return request("command", { id: newId(), sequence: next, command: command,
          issuedAt: Math.round(Date.now() + serverOffset) });
      }).then(function (result) {
        if (result.accepted !== true) close();
        return { accepted: result.accepted === true };
      }, function (error) {
        // An HTTP failure may follow delivery. Never replay or reuse sequence.
        close();
        throw error;
      });
    }
    return { open: open, ready: function () {
      return visible ? openPromise : Promise.reject(new Error("session_closed"));
    },
      send: send, close: close, dispose: close };
  }
  root.HorizonPlayerBridge = { create: create };
})(typeof window !== "undefined" ? window : globalThis);
