(function (root) {
  "use strict";

  var STATES = {
    PLAYBACK_HIDDEN: "PLAYBACK_HIDDEN",
    CONTROLS_VISIBLE: "CONTROLS_VISIBLE",
    SUBMENU_OPEN: "SUBMENU_OPEN",
    COMMAND_IN_PROGRESS: "COMMAND_IN_PROGRESS",
    UP_NEXT: "UP_NEXT",
  };
  var PREVIEW_ORIGIN = "https://horizon-video-lab-preview.ali-al-anbari.workers.dev";
  var CONTROL_IDS = ["rewind", "play-pause", "forward", "previous-episode", "subtitles", "episodes", "next-episode", "manual-end"];
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
    var upNextButtons = [get("up-next-play"), get("up-next-cancel")];
    var catalog = root.HorizonEpisodes;
    var route = catalog.parse(nav.search);
    var currentEpisode = route.current;
    var manualEndEnabled = route.testEnd && currentEpisode.showId === 2190 && nav.origin === PREVIEW_ORIGIN;
    var resolver = options && options.episodeResolver || (currentEpisode.showId === 2190 || route.tvdbId
      ? catalog.createResolver({ clock: clock, showId: currentEpisode.showId, tvdbId: route.tvdbId }) : {
        current: function () { return Promise.resolve(null); },
        resolve: function () { return Promise.resolve({ kind: "unknown", reason: "provider_metadata_unavailable" }); }
      });
    var adapter = options && options.commandAdapter;
    if (!adapter && root.HorizonPlayerBridge) adapter = root.HorizonPlayerBridge.create(clock);
    var subtitleMode = route.subtitle;
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
    var upNextTimer = null;
    var upNextDeadline = null;
    var upNextSelected = 0;
    var upNextTarget = null;
    var transitionStarted = false;
    var episodeLookup = 0;
    var episodeLookupPending = false;
    var pendingEpisode = null;
    var pauseTrace = null;
    var lastPauseTiming = null;

    function now() { return clock.performance && clock.performance.now ? clock.performance.now() : Date.now(); }
    function markPause(stage) { if (pauseTrace) pauseTrace[stage] = now(); }
    function finishPauseTiming() {
      if (!pauseTrace) return;
      pauseTrace.restoredAt = now();
      lastPauseTiming = pauseTrace;
      if (pauseTrace.hidden) {
        var summary = " Quick Pause: bar " + Math.round(pauseTrace.overlayAt - pauseTrace.inputAt)
          + " ms; ready " + (pauseTrace.readyAt === undefined ? "?" : Math.round(pauseTrace.readyAt - pauseTrace.inputAt))
          + " ms; reply " + (pauseTrace.replyAt === undefined ? "?" : Math.round(pauseTrace.replyAt - pauseTrace.inputAt))
          + " ms; focus " + Math.round(pauseTrace.restoredAt - pauseTrace.inputAt) + " ms.";
        get("command-status").textContent += summary;
      }
      pauseTrace = null;
    }
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
      return label + " · " + arrows + " · OK seeks · Up Play/Pause · Down "
        + (id === "forward" ? "Next Episode" : "Previous Episode");
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
      controls.forEach(function (button) { button.tabIndex = visible && !button.hidden ? 0 : -1; });
    }
    function focusControl(index) {
      if (selected !== index) {
        pendingEpisode = null;
        episodeLookup += 1;
        episodeLookupPending = false;
      }
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
      markPause("overlayAt");
      get("command-status").textContent = adapter && typeof adapter.send === "function"
        ? "Preparing secure player connection…"
        : "Playback commands unavailable until the secure Pico bridge is connected.";
      if (adapter && typeof adapter.open === "function") {
        adapter.open().then(function () {
          if (!disposed && state === STATES.CONTROLS_VISIBLE
              && get("command-status").textContent === "Preparing secure player connection…") {
            get("command-status").textContent = "Player connection ready; playback effect remains unverified.";
          }
        }, function (error) {
          if (!disposed && state === STATES.CONTROLS_VISIBLE
              && get("command-status").textContent === "Preparing secure player connection…") {
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
      episodeLookup += 1;
      episodeLookupPending = false;
      pendingEpisode = null;
      resetSeekSelection();
      state = STATES.PLAYBACK_HIDDEN;
      setOverlayVisible(false);
      overlay.classList.remove("is-quick-pause");
      get("command-status").textContent = "";
      if (adapter && typeof adapter.close === "function") adapter.close();
      focus(capture);
      get("screen-reader-status").textContent = "Controls hidden. Press an arrow or OK to show controls. Back exits to Video Lab.";
    }
    function navigate(key) {
      var next = selected;
      if (key === "ArrowLeft") {
        if (selected === 1 || selected === 2 || (selected >= 4 && selected <= 6)) next -= 1;
      } else if (key === "ArrowRight") {
        if (selected === 0 || selected === 1 || (selected >= 3 && selected <= 5)) next += 1;
      } else if (key === "ArrowDown") {
        if (selected <= 2) next = [3, 4, 6][selected];
        else if (selected <= 6 && manualEndEnabled) next = 7;
      } else if (key === "ArrowUp") {
        if (selected === 0 || selected === 2) next = 1;
        else if (selected >= 3 && selected <= 6) next = selected === 3 ? 0 : selected === 6 ? 2 : 1;
        else if (selected === 7) next = 5;
      }
      if (next !== selected) focusControl(next);
    }
    function closeMenu() {
      if (state !== STATES.SUBMENU_OPEN) return;
      get("subtitle-menu").hidden = true;
      menuButtons.forEach(function (button) { button.tabIndex = -1; });
      menuConfirm = false;
      state = STATES.CONTROLS_VISIBLE;
      focusControl(4);
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
      transitionTo(catalog.pageUrl(currentEpisode, subtitleMode === "on" ? "off" : "on",
        manualEndEnabled, null, route.fromSearch, route.showTitle, route.tvdbId));
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
      finishPauseTiming();
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
        + (result.code === "keylist_acknowledged"
          ? "SmartCast KEYLIST request acknowledged for " + batch.count + " inputs"
          : "SmartCast " + result.state + ": " + result.acknowledged + "/" + batch.count + " inputs")
        + "; accept " + (batch.browserAcceptanceMs === undefined ? "?" : batch.browserAcceptanceMs)
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
        markPause("dispatchedAt");
        Promise.resolve(adapter.send(command)).then(function (result) {
          if (disposed || sequence !== commandNumber || state !== STATES.COMMAND_IN_PROGRESS) return;
          markPause("replyAt");
          var elapsed = clock.performance && clock.performance.now
            ? Math.round(clock.performance.now() - commandStartedAt) : null;
          commandMessage = result && result.accepted === true
            ? "SmartCast acknowledged in " + (elapsed === null ? "unknown" : elapsed) + " ms; playback effect is unverified."
            : "Controller did not accept the command; playback effect is unverified.";
          lease.restore("adapter_result");
        }, function () {
          if (disposed || sequence !== commandNumber || state !== STATES.COMMAND_IN_PROGRESS) return;
          markPause("replyAt");
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
      if (id === "play-pause" && !pauseTrace) pauseTrace = { inputAt: now(), hidden: false };
      if (id !== "play-pause") pauseTrace = null;
      if (!adapter || typeof adapter.send !== "function") {
        get("command-status").textContent = "No secure Pico bridge is connected. No key was sent or focus transferred.";
        finishPauseTiming();
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
        markPause("focusedAt");
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
        Promise.resolve(adapter.ready()).then(function () {
          markPause("readyAt");
          beginHandoff();
        }, function () {
          if (disposed || sequence !== commandNumber || state !== STATES.COMMAND_IN_PROGRESS) return;
          if (activeBatch) activeBatch = null;
          commandMessage = "Player connection failed; no key was sent.";
          state = STATES.CONTROLS_VISIBLE;
          get("command-status").textContent = commandMessage;
          activeCommand = null;
          finishPauseTiming();
          resetIdle();
        });
        return;
      }
      // A frame callback gives the browser one focus-processing turn. It is
      // not a fixed millisecond delay or a claim of physical TV readiness.
      beginHandoff();
    }
    function clearUpNext() {
      if (upNextTimer !== null) { clock.clearTimeout(upNextTimer); upNextTimer = null; }
      upNextDeadline = null;
      upNextTarget = null;
      get("up-next").hidden = true;
      overlay.classList.remove("is-up-next");
      upNextButtons.forEach(function (button) { button.tabIndex = -1; });
    }
    function transitionTo(url) {
      if (disposed || transitionStarted || !url) return;
      transitionStarted = true;
      dispose();
      nav.replace(url);
    }
    function episodeListUrl() {
      return catalog.pageUrl(currentEpisode, subtitleMode, manualEndEnabled, "list", route.fromSearch, route.showTitle, route.tvdbId);
    }
    function launchEpisode(target) {
      transitionTo(catalog.pageUrl(target, subtitleMode, manualEndEnabled, null, route.fromSearch, route.showTitle, route.tvdbId));
    }
    function exitPlayer() {
      if (!route.fromSearch) { dispose(); nav.replace("embed-matrix.html"); return; }
      var url = "https://horizon-universal-search-preview.ali-al-anbari.workers.dev/?return=1"
        + "&showId=" + currentEpisode.showId + "&season=" + currentEpisode.season
        + "&episode=" + currentEpisode.episode + "&sub=" + subtitleMode;
      dispose(); nav.replace(url);
    }
    function transitionEpisode(direction) {
      if (pendingEpisode && pendingEpisode.direction === direction) {
        launchEpisode(pendingEpisode.target);
        return;
      }
      if (episodeLookupPending) return;
      episodeLookupPending = true;
      var lookup = ++episodeLookup;
      get("command-status").textContent = "Checking episode metadata…";
      Promise.resolve().then(function () { return resolver.resolve(currentEpisode, direction); }).then(function (result) {
        if (disposed || lookup !== episodeLookup || state !== STATES.CONTROLS_VISIBLE) return;
        episodeLookupPending = false;
        if (result && result.kind === "catalogued") {
          pendingEpisode = { direction: direction, target: result.target };
          get("command-status").textContent = "S" + result.target.season + " E" + result.target.episode
            + " · " + result.target.title + " is listed by TVmaze. YapGrid playback unknown; press OK again to try.";
        } else if (result && result.kind === "none_known") {
          get(direction < 0 ? "previous-episode" : "next-episode").setAttribute("aria-disabled", "true");
          get("command-status").textContent = direction < 0
            ? "No earlier aired episode in metadata; YapGrid availability unknown."
            : "No later aired episode in metadata; series status and YapGrid availability unknown.";
        } else {
          get("command-status").textContent = result && result.reason === "timeout"
            ? "Episode metadata timed out; availability unknown. Press OK to retry."
            : "Episode metadata unavailable; availability unknown. Press OK to retry.";
        }
        get("screen-reader-status").textContent = get("command-status").textContent;
      }, function () {
        if (disposed || lookup !== episodeLookup || state !== STATES.CONTROLS_VISIBLE) return;
        episodeLookupPending = false;
        get("command-status").textContent = "Episode metadata unavailable; availability unknown. Press OK to retry.";
      });
    }
    function renderUpNext() {
      var remaining = Math.max(0, Math.ceil((upNextDeadline - now()) / 1000));
      get("up-next-countdown").textContent = "Playing next episode in " + remaining
        + (remaining === 1 ? " second" : " seconds");
      get("screen-reader-status").textContent = "Up Next: " + get("up-next-title").textContent
        + ". " + remaining + " seconds. Choose Play now or Cancel.";
    }
    function tickUpNext() {
      upNextTimer = null;
      if (disposed || state !== STATES.UP_NEXT || upNextDeadline === null) return;
      if (now() >= upNextDeadline) {
        launchEpisode(upNextTarget);
        return;
      }
      renderUpNext();
      upNextTimer = clock.setTimeout(tickUpNext, Math.min(1000, upNextDeadline - now()));
    }
    function startUpNext() {
      if (!manualEndEnabled || disposed || state !== STATES.CONTROLS_VISIBLE
          || transitionStarted || episodeLookupPending) return;
      episodeLookupPending = true;
      var lookup = ++episodeLookup;
      get("command-status").textContent = "Checking next episode metadata…";
      Promise.resolve().then(function () { return resolver.resolve(currentEpisode, 1); }).then(function (result) {
        if (disposed || lookup !== episodeLookup || state !== STATES.CONTROLS_VISIBLE) return;
        episodeLookupPending = false;
        if (!result || result.kind !== "catalogued") {
          get("command-status").textContent = result && result.kind === "none_known"
            ? "No later aired episode in metadata; series status and YapGrid availability unknown."
            : "Next episode metadata unavailable; autoplay cannot start safely.";
          return;
        }
        beginUpNext(result.target);
      }, function () {
        if (disposed || lookup !== episodeLookup || state !== STATES.CONTROLS_VISIBLE) return;
        episodeLookupPending = false;
        get("command-status").textContent = "Next episode metadata unavailable; autoplay cannot start safely.";
      });
    }
    function beginUpNext(next) {
      clearIdle();
      state = STATES.UP_NEXT;
      upNextTarget = next;
      upNextDeadline = now() + 10000;
      upNextSelected = 0;
      get("up-next-title").textContent = "S" + next.season + " E" + next.episode + " · " + next.title;
      get("up-next").hidden = false;
      overlay.classList.add("is-up-next");
      upNextButtons.forEach(function (button) { button.tabIndex = 0; });
      controls.forEach(function (button) { button.tabIndex = -1; });
      renderUpNext();
      focus(upNextButtons[0]);
      upNextTimer = clock.setTimeout(tickUpNext, 1000);
    }
    function chooseUpNext() {
      if (state !== STATES.UP_NEXT) return;
      if (upNextSelected === 0) launchEpisode(upNextTarget);
      else transitionTo(episodeListUrl());
    }
    function activateControl() {
      var id = CONTROL_IDS[selected];
      if (activeBatch) {
        get("command-status").textContent = "Seek in progress; wait for completion or timeout.";
        return;
      }
      if (COMMANDS[id]) requestCommand(id);
      else if (id === "previous-episode") transitionEpisode(-1);
      else if (id === "next-episode") transitionEpisode(1);
      else if (id === "subtitles") openMenu();
      else if (id === "episodes") transitionTo(episodeListUrl());
      else if (id === "manual-end") startUpNext();
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
        if (key === "Back") { if (!event.repeat) exitPlayer(); }
        else if (key === "OK" && !event.repeat) {
          pauseTrace = { inputAt: now(), hidden: true };
          overlay.classList.add("is-quick-pause");
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
      if (state === STATES.UP_NEXT) {
        if (key === "Back") { if (!event.repeat) transitionTo(episodeListUrl()); }
        else if (key.indexOf("Arrow") === 0) {
          upNextSelected = key === "ArrowLeft" || key === "ArrowUp" ? 0 : 1;
          focus(upNextButtons[upNextSelected]);
        } else if (!event.repeat) chooseUpNext();
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
      if (disposed) return;
      disposed = true;
      overlay.classList.remove("is-quick-pause");
      episodeLookup += 1;
      clearIdle();
      clearUpNext();
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

    var playerUrl = catalog.embedUrl(currentEpisode);
    var subtitleUrl = playerUrl + "?lang=en";
    if (subtitleMode === "off") {
      var origin = nav.origin && nav.origin !== "null" ? nav.origin : PREVIEW_ORIGIN;
      subtitleUrl = playerUrl + "?sub_url=" + encodeURIComponent(origin + "/empty.vtt")
        + "&sub_lang=en&sub_label=Off";
    }
    frame.src = subtitleUrl; // One initial navigation; focus and overlay never reset it.
    if (currentEpisode.showId !== 2190) {
      get("show-title").textContent = route.showTitle || "TV Episode";
      get("metadata-credit").textContent = "Episode metadata: TMDB selection · YapGrid playback availability is unverified";
    } else if (route.showTitle) get("show-title").textContent = route.showTitle;
    get("episode-caption").textContent = "Season " + currentEpisode.season + " · Episode "
      + currentEpisode.episode;
    get("previous-episode").setAttribute("aria-disabled", "false");
    get("next-episode").setAttribute("aria-disabled", "false");
    get("manual-end").hidden = !manualEndEnabled;
    resolver.current(currentEpisode).then(function (found) {
      if (!disposed && found && found.title) {
        currentEpisode.title = found.title;
        get("episode-caption").textContent += " · " + found.title;
      }
    });
    [-1, 1].forEach(function (direction) {
      resolver.resolve(currentEpisode, direction).then(function (result) {
        if (disposed) return;
        get(direction < 0 ? "previous-episode" : "next-episode")
          .setAttribute("aria-disabled", result.kind === "none_known" ? "true" : "false");
        if (direction === 1 && result.kind === "none_known" && manualEndEnabled) {
          get("manual-end").hidden = true;
          get("manual-end").tabIndex = -1;
        }
      });
    });
    get("subtitle-mode").textContent = subtitleMode.toUpperCase();
    controls.forEach(function (button, index) {
      button.addEventListener("click", function () {
        if (disposed || state !== STATES.CONTROLS_VISIBLE) return;
        if (selected !== index) {
          pendingEpisode = null;
          episodeLookup += 1;
          episodeLookupPending = false;
        }
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
    upNextButtons.forEach(function (button, index) {
      button.addEventListener("click", function () {
        if (state !== STATES.UP_NEXT) return;
        upNextSelected = index;
        chooseUpNext();
      });
    });
    doc.addEventListener("keydown", onKey);
    clock.addEventListener("pagehide", dispose);
    setOverlayVisible(false);
    renderSeekLabels();
    focus(capture);
    return { onKey: onKey, getState: function () { return state; },
      getLastPauseTiming: function () {
        if (!lastPauseTiming) return null;
        var snapshot = {};
        Object.keys(lastPauseTiming).forEach(function (key) { snapshot[key] = lastPauseTiming[key]; });
        return snapshot;
      }, dispose: dispose };
  }

  root.HorizonPlayerOverlay = { createPlayer: createPlayer, keyName: keyName, STATES: STATES };
  if (typeof document !== "undefined") createPlayer(document, location, root);
})(typeof window !== "undefined" ? window : globalThis);
