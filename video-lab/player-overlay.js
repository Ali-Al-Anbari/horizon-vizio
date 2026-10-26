(function (root) {
  "use strict";

  var STATES = {
    PLAYBACK_HIDDEN: "PLAYBACK_HIDDEN",
    CONTROLS_VISIBLE: "CONTROLS_VISIBLE",
    SUBMENU_OPEN: "SUBMENU_OPEN",
    COMMAND_IN_PROGRESS: "COMMAND_IN_PROGRESS",
  };
  var PLAYER_URL = "https://yapgrid.com/embed/tv/2190/13/2";
  var PREVIEW_ORIGIN = "https://horizon-video-lab-preview.ali-al-anbari.workers.dev";
  var CONTROL_IDS = ["rewind", "play-pause", "forward", "subtitles", "episodes"];
  var COMMANDS = { rewind: "seek_backward", "play-pause": "pause_toggle", forward: "seek_forward" };
  var IDLE_MS = 5000;
  // A watchdog for a future acknowledged adapter, not a delay before sending.
  // The 500 ms end-to-end target must be measured with the real transport.
  var COMMAND_RECOVERY_MS = 3000;
  var BATCH_RECOVERY_MS = 30000;
  var BATCH_CANCEL_GRACE_MS = 5000;
  var SEEK_COUNTS = [1, 3, 6, 12, 30, 60];
  var SEEK_LABELS = ["10s", "30s", "1m", "2m", "5m", "10m"];

  function keyName(event) {
    var key = event && event.key;
    if (key === "Enter" || key === "Select" || key === "OK" || key === "NumpadEnter") return "OK";
    if (key === "Escape" || key === "Backspace" || key === "BrowserBack" || key === "GoBack") return "Back";
    if (key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown") return key;
    var code = event && (event.keyCode || event.which);
    if (code === 13) return "OK";
    if (code === 8 || code === 27 || code === 4) return "Back";
    if (code >= 37 && code <= 40) return ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"][code - 37];
    return key || "Unknown";
  }

  function createPlayer(doc, nav, clock, options) {
    var get = function (id) { return doc.getElementById(id); };
    var frame = get("player-frame");
    if (!frame) return null;
    var capture = get("remote-capture");
    var overlay = get("overlay");
    var controls = CONTROL_IDS.map(get);
    var menuButtons = [get("menu-cancel"), get("menu-change")];
    var adapter = options && options.commandAdapter;
    if (!adapter && root.HorizonPlayerBridge) adapter = root.HorizonPlayerBridge.create(clock);
    var subtitleMode = /(?:^|[?&])sub=off(?:&|$)/.test(nav.search || "") ? "off" : "on";
    var selected = 1;
    var menuSelected = 0;
    var menuConfirm = false;
    var state = STATES.PLAYBACK_HIDDEN;
    var idleTimer = null;
    var dispatchTimer = null;
    var dispatchFrame = null;
    var commandNumber = 0;
    var activeCommand = null;
    var commandMessage = "";
    var commandStartedAt = null;
    var disposed = false;
    var hideAfterCommand = false;
    var activeBatch = null;
    var batchPollTimer = null;
    var batchStopTimer = null;
    var seekLevels = { rewind: 0, forward: 0 };

    function now() { return clock.performance && clock.performance.now ? clock.performance.now() : Date.now(); }
    function renderSeekLabels() {
      get("rewind-label").textContent = "−" + SEEK_LABELS[seekLevels.rewind];
      get("forward-label").textContent = "+" + SEEK_LABELS[seekLevels.forward];
      get("rewind").setAttribute("aria-label", "Rewind " + SEEK_LABELS[seekLevels.rewind]);
      get("forward").setAttribute("aria-label", "Forward " + SEEK_LABELS[seekLevels.forward]);
    }
    function resetSeekSelection() {
      seekLevels.rewind = 0; seekLevels.forward = 0;
      renderSeekLabels();
    }
    function seekHint(id) {
      var label = id === "forward" ? "Forward " + get("forward-label").textContent
        : "Rewind " + get("rewind-label").textContent;
      var arrows = id === "forward" ? "Right more · Left less" : "Left more · Right less";
      return label + " · " + arrows + " · OK seeks · Up Play/Pause · Down Subtitles";
    }
    function adjustSeek(id, key) {
      var increase = id === "forward" ? key === "ArrowRight" : key === "ArrowLeft";
      var decrease = !increase;
      if (decrease && seekLevels[id] === 0) return false;
      seekLevels[id] = Math.max(0, Math.min(SEEK_COUNTS.length - 1,
        seekLevels[id] + (increase ? 1 : -1)));
      renderSeekLabels();
      get("command-status").textContent = seekHint(id);
      get("screen-reader-status").textContent = get("command-status").textContent;
      return true;
    }

    function focus(element) {
      try { element.focus({ preventScroll: true }); }
      catch (_error) { element.focus(); }
    }
    function clearIdle() {
      if (idleTimer !== null) { clock.clearTimeout(idleTimer); idleTimer = null; }
    }
    function resetIdle() {
      clearIdle();
      if (state === STATES.CONTROLS_VISIBLE && !disposed && !activeBatch) {
        idleTimer = clock.setTimeout(function () {
          idleTimer = null;
          if (state === STATES.CONTROLS_VISIBLE) hideControls();
        }, IDLE_MS);
      }
    }
    function setOverlayVisible(visible) {
      if (visible) overlay.classList.add("is-visible");
      else overlay.classList.remove("is-visible");
      overlay.setAttribute("aria-hidden", visible ? "false" : "true");
      controls.forEach(function (button) { button.tabIndex = visible ? 0 : -1; });
    }
    function focusControl(index) {
      selected = Math.max(0, Math.min(controls.length - 1, index));
      var id = CONTROL_IDS[selected];
      focus(controls[selected]);
      if (state === STATES.CONTROLS_VISIBLE && !activeBatch
          && (id === "rewind" || id === "forward")) {
        get("command-status").textContent = seekHint(id);
      }
    }
    function showControls() {
      if (disposed || state !== STATES.PLAYBACK_HIDDEN) return;
      state = STATES.CONTROLS_VISIBLE;
      selected = 1;
      setOverlayVisible(true);
      focusControl(selected);
      get("command-status").textContent = adapter && typeof adapter.send === "function"
        ? "Preparing secure player connection…"
        : "Playback commands unavailable until the secure Pico bridge is connected.";
      if (adapter && typeof adapter.open === "function") {
        adapter.open().then(function () {
          if (!disposed && state === STATES.CONTROLS_VISIBLE) {
            get("command-status").textContent = "Player connection ready; playback effect remains unverified.";
          }
        }, function (error) {
          if (!disposed && state === STATES.CONTROLS_VISIBLE) {
            get("command-status").textContent =
              "Bridge error: " + (error && error.message ? error.message : "unknown");
          }
        });
      }
      resetIdle();
      get("screen-reader-status").textContent = "Playback controls visible. Use arrows to navigate; OK selects; Back hides controls.";
    }
    function hideControls() {
      if (disposed || state !== STATES.CONTROLS_VISIBLE) return;
      clearIdle();
      resetSeekSelection();
      state = STATES.PLAYBACK_HIDDEN;
      setOverlayVisible(false);
      get("command-status").textContent = "";
      if (adapter && typeof adapter.close === "function") adapter.close();
      focus(capture);
      get("screen-reader-status").textContent = "Controls hidden. Press an arrow or OK to show controls. Back exits to Video Lab.";
    }
    function navigate(key) {
      var next = selected;
      if (key === "ArrowLeft") {
        if (selected === 1 || selected === 2 || selected === 4) next -= 1;
      } else if (key === "ArrowRight") {
        if (selected === 0 || selected === 1 || selected === 3) next += 1;
      } else if (key === "ArrowDown") {
        if (selected <= 2) next = 3;
      } else if (key === "ArrowUp") {
        if (selected === 0 || selected === 2 || selected >= 3) next = 1;
      }
      if (next !== selected) focusControl(next);
    }
    function closeMenu() {
      if (state !== STATES.SUBMENU_OPEN) return;
      get("subtitle-menu").hidden = true;
      menuButtons.forEach(function (button) { button.tabIndex = -1; });
      menuConfirm = false;
      state = STATES.CONTROLS_VISIBLE;
      focusControl(3);
      resetIdle();
    }
    function openMenu() {
      if (state !== STATES.CONTROLS_VISIBLE) return;
      clearIdle();
      state = STATES.SUBMENU_OPEN;
      menuConfirm = false;
      menuSelected = 0;
      get("subtitle-menu").hidden = false;
      get("menu-title").textContent = "Subtitles: " + subtitleMode.toUpperCase();
      get("menu-description").textContent = "Changing subtitles reloads YapGrid and may lose your position.";
      get("menu-cancel").textContent = "Keep playing";
      get("menu-change").textContent = "Switch to " + (subtitleMode === "on" ? "OFF" : "ON") + " · reload required";
      menuButtons.forEach(function (button) { button.tabIndex = 0; });
      focus(menuButtons[0]);
    }
    function chooseMenu() {
      if (menuSelected === 0) { closeMenu(); return; }
      if (!menuConfirm) {
        menuConfirm = true;
        menuSelected = 0;
        get("menu-title").textContent = "Reload video from the beginning?";
        get("menu-description").textContent = "The embedded player cannot provide its current position. Reloading may lose your place.";
        get("menu-cancel").textContent = "Cancel";
        get("menu-change").textContent = "Reload with subtitles " + (subtitleMode === "on" ? "OFF" : "ON");
        focus(menuButtons[0]);
        return;
      }
      dispose();
      nav.replace("player-overlay.html?sub=" + (subtitleMode === "on" ? "off" : "on"));
    }
    function restoreFromCommand(reason, late, parentFocused) {
      if (disposed || state !== STATES.COMMAND_IN_PROGRESS) return;
      if (reason === "focus_error" && activeBatch) {
        activeBatch = null;
      }
      if (dispatchTimer !== null) { clock.clearTimeout(dispatchTimer); dispatchTimer = null; }
      if (dispatchFrame !== null && typeof clock.cancelAnimationFrame === "function") {
        clock.cancelAnimationFrame(dispatchFrame);
        dispatchFrame = null;
      }
      commandNumber += 1; // Ignore any late adapter result.
      state = STATES.CONTROLS_VISIBLE;
      setOverlayVisible(true);
      get("command-status").textContent = commandMessage ||
        "Controller delivery timed out; command outcome is unknown. Check the TV picture.";
      if (reason === "focus_error") get("command-status").textContent = "Could not focus YapGrid; no command was sent.";
      if (late > 0) get("screen-reader-status").textContent = "Focus restoration timer was late by " + late + " ms.";
      else get("screen-reader-status").textContent = parentFocused
        ? "Horizon focus requested after playback command. Press OK to verify remote response."
        : "Horizon focus was requested; remote response must be checked on the TV.";
      activeCommand = null;
      commandStartedAt = null;
      if (activeBatch) {
        activeBatch.focusRestoreMs = Math.round(now() - activeBatch.startedAt);
        if (reason === "timeout") {
          activeBatch.watchdogExpired = true;
          cancelActiveBatch();
          if (activeBatch) {
            batchStopTimer = clock.setTimeout(function () {
              batchStopTimer = null;
              if (!activeBatch || disposed) return;
              if (adapter && typeof adapter.close === "function") adapter.close();
              finishBatch({ state: "unknown", acknowledged: activeBatch.acknowledged });
            }, BATCH_CANCEL_GRACE_MS);
          }
        }
        if (activeBatch) get("command-status").textContent = batchMessage(activeBatch);
        return;
      }
      resetIdle();
      if (hideAfterCommand) { hideAfterCommand = false; hideControls(); }
    }
    var lease = root.HorizonFocusLease.create(frame, function () { return controls[selected]; }, doc, clock, restoreFromCommand);

    function batchMessage(batch) {
      var direction = (batch.command === "seek_forward" ? "+" : "−") + batch.label;
      if (batch.cancelling) return (batch.watchdogExpired ? "Focus timeout; stopping " : "Stopping ")
        + direction + " after current input · " + batch.acknowledged + "/" + batch.count
        + " SmartCast inputs acknowledged · video position unverified";
      return "Seeking " + direction + " · " + batch.acknowledged + "/" + batch.count
        + " SmartCast inputs acknowledged · video position unverified"
        + (batch.focusRestoreMs === undefined ? "" : " · focus restored " + batch.focusRestoreMs + " ms");
    }
    function finishBatch(result) {
      var batch = activeBatch;
      if (!batch) return;
      activeBatch = null;
      if (batchPollTimer !== null) { clock.clearTimeout(batchPollTimer); batchPollTimer = null; }
      if (batchStopTimer !== null) { clock.clearTimeout(batchStopTimer); batchStopTimer = null; }
      if (result.state !== "complete") {
        if (result.state === "unknown" && adapter && typeof adapter.close === "function") adapter.close();
      }
      renderSeekLabels();
      commandMessage = (batch.watchdogExpired ? "Focus watchdog expired; " : "")
        + "SmartCast " + result.state + ": " + result.acknowledged + "/" + batch.count
        + " inputs; accept " + (batch.browserAcceptanceMs === undefined ? "?" : batch.browserAcceptanceMs)
        + " ms (bridge " + (batch.serverAcceptanceMs === null || batch.serverAcceptanceMs === undefined
          ? "?" : batch.serverAcceptanceMs) + " ms); Pico "
        + (result.metrics && typeof result.metrics.picoMs === "number" ? result.metrics.picoMs + " ms" : "time unknown")
        + "; total " + Math.round(now() - batch.startedAt)
        + " ms. YapGrid position unverified.";
      get("command-status").textContent = commandMessage;
      if (lease.isActive()) lease.restore("batch_done");
      else {
        if (state === STATES.COMMAND_IN_PROGRESS) {
          state = STATES.CONTROLS_VISIBLE;
          focusControl(selected);
        }
        resetIdle();
      }
    }
    function pollBatch() {
      if (!activeBatch || !activeBatch.id || disposed) return;
      var id = activeBatch.id;
      Promise.resolve(adapter.batchStatus(id)).then(function (result) {
        if (!activeBatch || activeBatch.id !== id || disposed) return;
        if (!result || result.id !== id) {
          // A stale or malformed status cannot terminate the current focus lease.
          batchPollTimer = clock.setTimeout(pollBatch, 250);
          return;
        }
        activeBatch.acknowledged = result.acknowledged || 0;
        if (result.state === "complete" && result.acknowledged !== activeBatch.count) {
          // Never call a partial or malformed terminal report a completed jump.
          finishBatch({ state: "unknown", acknowledged: activeBatch.acknowledged });
          return;
        }
        if (["complete", "cancelled", "failed", "unknown"].indexOf(result.state) >= 0) {
          finishBatch(result);
          return;
        }
        get("command-status").textContent = batchMessage(activeBatch);
        batchPollTimer = clock.setTimeout(pollBatch, 250);
      }, function () {
        if (!activeBatch || activeBatch.id !== id || disposed) return;
        // A missing status reply leaves key delivery uncertain. Closing the
        // session stops further keys on the Pico when the socket is live.
        if (adapter && typeof adapter.close === "function") adapter.close();
        finishBatch({ state: "unknown", acknowledged: activeBatch.acknowledged });
      });
    }
    function cancelActiveBatch() {
      if (!activeBatch) return;
      if (!activeBatch.dispatched) {
        activeBatch = null;
        commandMessage = "Seek cancelled before sending a key.";
        if (lease.isActive()) lease.restore("cancel_requested");
        else {
          commandNumber += 1;
          state = STATES.CONTROLS_VISIBLE;
          get("command-status").textContent = commandMessage;
          resetIdle();
        }
        return;
      }
      if (!activeBatch.cancelling) {
        activeBatch.cancelling = true;
        get("command-status").textContent = "Stopping after the current SmartCast input…";
        if (activeBatch.id) sendCancel(activeBatch.id);
      }
      if (lease.isActive()) lease.restore("cancel_requested");
    }
    function sendCancel(id) {
      Promise.resolve(adapter.cancelBatch(id)).catch(function () {
        if (adapter && typeof adapter.close === "function") adapter.close();
      });
    }

    function dispatchToAdapter(sequence, command) {
      if (disposed || state !== STATES.COMMAND_IN_PROGRESS || sequence !== commandNumber || !lease.isActive()) return;
      if (doc.activeElement !== frame) {
        commandMessage = "YapGrid did not become the active element; no command was sent.";
        lease.restore("focus_error");
        return;
      }
      // Focus observation gates dispatch; physical remote routing and player
      // response still require verification on the Vizio.
      try {
        if (activeBatch && typeof adapter.sendBatch === "function") {
          var batch = activeBatch;
          batch.dispatched = true;
          Promise.resolve(adapter.sendBatch(command, batch.count)).then(function (result) {
            if (disposed || activeBatch !== batch) return;
            batch.id = result.id;
            batch.browserAcceptanceMs = Math.round(now() - batch.startedAt);
            batch.serverAcceptanceMs = typeof result.serverAcceptedAt === "number"
              && typeof result.serverQueuedAt === "number"
              ? result.serverAcceptedAt - result.serverQueuedAt : null;
            if (batch.cancelling) sendCancel(batch.id);
            get("command-status").textContent = batchMessage(batch);
            pollBatch();
          }, function () {
            if (disposed || activeBatch !== batch) return;
            finishBatch({ state: "unknown", acknowledged: batch.acknowledged });
          });
          return;
        }
        Promise.resolve(adapter.send(command)).then(function (result) {
          if (disposed || sequence !== commandNumber || state !== STATES.COMMAND_IN_PROGRESS) return;
          var elapsed = clock.performance && clock.performance.now
            ? Math.round(clock.performance.now() - commandStartedAt) : null;
          commandMessage = result && result.accepted === true
            ? "SmartCast acknowledged in " + (elapsed === null ? "unknown" : elapsed) + " ms; playback effect is unverified."
            : "Controller did not accept the command; playback effect is unverified.";
          lease.restore("adapter_result");
        }, function () {
          if (disposed || sequence !== commandNumber || state !== STATES.COMMAND_IN_PROGRESS) return;
          commandMessage = "Controller command failed or timed out; playback effect is unknown.";
          lease.restore("adapter_error");
        });
      } catch (_error) {
        if (activeBatch) {
          finishBatch({ state: "unknown", acknowledged: activeBatch.acknowledged });
          return;
        }
        commandMessage = "Controller command failed; playback effect is unknown.";
        lease.restore("adapter_error");
      }
    }
    function requestCommand(id) {
      if (disposed || state !== STATES.CONTROLS_VISIBLE || !COMMANDS[id]) return;
      if (!adapter || typeof adapter.send !== "function") {
        get("command-status").textContent = "No secure Pico bridge is connected. No key was sent or focus transferred.";
        resetIdle();
        return;
      }
      if (activeBatch) return;
      if (id === "rewind" || id === "forward") {
        var direction = COMMANDS[id];
        var level = seekLevels[id];
        if (level > 0 && typeof adapter.sendBatch !== "function") {
          get("command-status").textContent = "Progressive seeking requires the preview batch bridge.";
          return;
        }
        if (typeof adapter.sendBatch === "function") {
          activeBatch = { command: direction, count: SEEK_COUNTS[level], label: SEEK_LABELS[level], acknowledged: 0,
            id: null, cancelling: false, dispatched: false, startedAt: now() };
        }
      }
      clearIdle();
      state = STATES.COMMAND_IN_PROGRESS;
      commandNumber += 1;
      var sequence = commandNumber;
      activeCommand = COMMANDS[id];
      commandMessage = "";
      commandStartedAt = clock.performance && clock.performance.now ? clock.performance.now() : null;
      get("command-status").textContent = "Handing focus to YapGrid; waiting for controller delivery…";
      get("screen-reader-status").textContent = get("command-status").textContent;
      function beginHandoff() {
        if (disposed || state !== STATES.COMMAND_IN_PROGRESS || sequence !== commandNumber) return;
        commandStartedAt = clock.performance && clock.performance.now ? clock.performance.now() : null;
        if (!lease.begin(activeBatch && activeBatch.count > 1
          ? BATCH_RECOVERY_MS : COMMAND_RECOVERY_MS)) {
          if (activeBatch) finishBatch({ state: "failed", acknowledged: 0 });
          return;
        }
        if (typeof clock.requestAnimationFrame === "function") {
          dispatchFrame = clock.requestAnimationFrame(function () {
            dispatchFrame = null;
            dispatchToAdapter(sequence, activeCommand);
          });
        } else {
          dispatchTimer = clock.setTimeout(function () {
            dispatchTimer = null;
            dispatchToAdapter(sequence, activeCommand);
          }, 0);
        }
      }
      if (typeof adapter.ready === "function") {
        get("command-status").textContent = "Waiting for secure TV connection…";
        Promise.resolve(adapter.ready()).then(beginHandoff, function () {
          if (disposed || sequence !== commandNumber || state !== STATES.COMMAND_IN_PROGRESS) return;
          if (activeBatch) activeBatch = null;
          commandMessage = "Player connection failed; no key was sent.";
          state = STATES.CONTROLS_VISIBLE;
          get("command-status").textContent = commandMessage;
          activeCommand = null;
          resetIdle();
        });
        return;
      }
      // A frame callback gives the browser one focus-processing turn. It is
      // not a fixed millisecond delay or a claim of physical TV readiness.
      beginHandoff();
    }
    function activateControl() {
      var id = CONTROL_IDS[selected];
      if (activeBatch) {
        get("command-status").textContent = "Seek in progress; wait for completion or timeout.";
        return;
      }
      if (COMMANDS[id]) requestCommand(id);
      else if (id === "subtitles") openMenu();
      else if (id === "episodes") { dispose(); nav.replace("embed-matrix.html"); }
    }
    function onKey(event) {
      if (disposed) return;
      var key = keyName(event);
      if (key !== "OK" && key !== "Back" && key.indexOf("Arrow") !== 0) return;
      event.preventDefault();
      if (typeof event.stopPropagation === "function") event.stopPropagation();
      if (state === STATES.COMMAND_IN_PROGRESS) {
        if (key === "Back" && !event.repeat) {
          if (activeBatch) cancelActiveBatch();
          else if (lease.isActive()) hideAfterCommand = true;
          else {
            commandNumber += 1;
            state = STATES.CONTROLS_VISIBLE;
            hideControls();
          }
        }
        return;
      }
      if (state === STATES.PLAYBACK_HIDDEN) {
        if (key === "Back") { if (!event.repeat) { dispose(); nav.replace("embed-matrix.html"); } }
        else if (key === "OK" && !event.repeat) {
          showControls();
          requestCommand("play-pause");
        } else if (!event.repeat || key.indexOf("Arrow") === 0) showControls();
        return;
      }
      if (state === STATES.SUBMENU_OPEN) {
        if (key === "Back") { if (!event.repeat) closeMenu(); }
        else if (key.indexOf("Arrow") === 0) {
          menuSelected = key === "ArrowLeft" || key === "ArrowUp" ? 0 : 1;
          focus(menuButtons[menuSelected]);
        } else if (!event.repeat) chooseMenu();
        return;
      }
      resetIdle();
      if (key === "Back") { if (!event.repeat) { if (activeBatch) cancelActiveBatch(); else hideControls(); } }
      else if (key === "OK") { if (!event.repeat) activateControl(); }
      else if ((selected === 0 || selected === 2)
          && (key === "ArrowLeft" || key === "ArrowRight")) {
        if (!adjustSeek(CONTROL_IDS[selected], key)) navigate(key);
      } else navigate(key);
    }
    function dispose() {
      disposed = true;
      clearIdle();
      if (batchPollTimer !== null) { clock.clearTimeout(batchPollTimer); batchPollTimer = null; }
      if (batchStopTimer !== null) { clock.clearTimeout(batchStopTimer); batchStopTimer = null; }
      if (dispatchTimer !== null) { clock.clearTimeout(dispatchTimer); dispatchTimer = null; }
      if (dispatchFrame !== null && typeof clock.cancelAnimationFrame === "function") {
        clock.cancelAnimationFrame(dispatchFrame);
        dispatchFrame = null;
      }
      commandNumber += 1;
      resetSeekSelection();
      lease.dispose();
      if (adapter && typeof adapter.dispose === "function") adapter.dispose();
    }

    var subtitleUrl = PLAYER_URL + "?lang=en";
    if (subtitleMode === "off") {
      var origin = nav.origin && nav.origin !== "null" ? nav.origin : PREVIEW_ORIGIN;
      subtitleUrl = PLAYER_URL + "?sub_url=" + encodeURIComponent(origin + "/empty.vtt")
        + "&sub_lang=en&sub_label=Off";
    }
    frame.src = subtitleUrl; // One initial navigation; focus and overlay never reset it.
    get("subtitle-mode").textContent = subtitleMode.toUpperCase();
    controls.forEach(function (button, index) {
      button.addEventListener("click", function () {
        if (disposed || state !== STATES.CONTROLS_VISIBLE) return;
        selected = index;
        resetIdle();
        activateControl();
      });
    });
    menuButtons.forEach(function (button, index) {
      button.addEventListener("click", function () {
        if (state !== STATES.SUBMENU_OPEN) return;
        menuSelected = index;
        chooseMenu();
      });
    });
    doc.addEventListener("keydown", onKey);
    clock.addEventListener("pagehide", dispose);
    setOverlayVisible(false);
    renderSeekLabels();
    focus(capture);
    return { onKey: onKey, getState: function () { return state; }, dispose: dispose };
  }

  root.HorizonPlayerOverlay = { createPlayer: createPlayer, keyName: keyName, STATES: STATES };
  if (typeof document !== "undefined") createPlayer(document, location, root);
})(typeof window !== "undefined" ? window : globalThis);
