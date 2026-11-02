(function (root) {
  "use strict";

  var STATES = {
    PLAYBACK_HIDDEN: "PLAYBACK_HIDDEN",
    CONTROLS_VISIBLE: "CONTROLS_VISIBLE",
    SUBMENU_OPEN: "SUBMENU_OPEN",
    COMMAND_IN_PROGRESS: "COMMAND_IN_PROGRESS",
    UP_NEXT: "UP_NEXT",
    DIAGNOSTICS_OPEN: "DIAGNOSTICS_OPEN",
    NATIVE_FOCUS: "NATIVE_FOCUS",
  };
  var PREVIEW_ORIGIN = "https://horizon-video-lab-preview.ali-al-anbari.workers.dev";
  var CONTROL_IDS = ["rewind", "play-pause", "forward", "previous-episode", "subtitles", "episodes", "next-episode", "manual-end", "provider-choice", "unload-provider", "diagnostics-open", "recover-provider", "experiment-play", "experiment-pause", "experiment-back", "experiment-forward", "experiment-volume", "experiment-unmute", "experiment-focus", "experiment-skip", "experiment-back-fast", "experiment-forward-fast"];
  var COMMANDS = { rewind: "seek_backward", "play-pause": "pause_toggle", forward: "seek_forward" };
  var IDLE_MS = 5000;
  // A watchdog for a future acknowledged adapter, not a delay before sending.
  // The 500 ms end-to-end target must be measured with the real transport.
  var COMMAND_RECOVERY_MS = 3000;
  var BATCH_RECOVERY_MS = 30000;
  var BATCH_CANCEL_GRACE_MS = 5000;
  var SEEK_COUNTS = [1, 3, 6, 12, 30, 60];
  var SEEK_LABELS = ["10s", "30s", "1m", "2m", "5m", "10m"];
  var BOLT_STARTUP_GRACE_MS = 55000;
  var BOLT_STALL_GRACE_MS = 45000;
  var BOLT_SEEK_GRACE_MS = 20000;
  var BOLT_WATCHDOG_TICK_MS = 5000;
  var BOLT_CONTROL_PENDING_MS = 3000;

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
    var diagnosticButtons = [get("diagnostics-close"), get("compat-quality"),
      get("compat-autoplay"), get("compat-play"), get("compat-reset"),
      get("vidfast-autoplay"), get("vidfast-reset"),
      get("vidlink-default-off"), get("vidlink-default-on"), get("vidlink-jw-on"),
      get("vidlink-focus-default"), get("vidbolt-autoplay-toggle"), get("vidbolt-auto-recover")];
    var menuButtons = [get("menu-cancel"), get("menu-change")];
    var upNextButtons = [get("up-next-play"), get("up-next-cancel")];
    var catalog = root.HorizonEpisodes;
    var providers = root.HorizonPlaybackProviders;
    var diagnostics = root.HorizonPlayerDiagnostics.create(root, doc, frame, clock);
    var route = catalog.parse(nav.search);
    var provider = providers.select(route.provider);
    var compatibilityMode = providers.BASELINE;
    var vidFastMode = providers.BASELINE;
    var vidLinkMode = "defaultOff";
    var vidBoltAutoplay = true;
    var boltAutoRecover = true;
    var boltStartupGraceMs = options && typeof options.boltStartupGraceMs === "number"
      && isFinite(options.boltStartupGraceMs) && options.boltStartupGraceMs >= 30000
      && options.boltStartupGraceMs <= 120000 ? options.boltStartupGraceMs : BOLT_STARTUP_GRACE_MS;
    var boltAutoAttempts = 0;
    var boltRecoveryAttempts = 0;
    var boltLastRecoveryAt = null;
    var boltLastRecoveryReason = "none";
    var boltGeneration = 0;
    var boltSession = null;
    var boltWatchdogTimer = null;
    var boltLastConfirmed = null;
    var boltPosition = null;
    var boltPositionAt = 0;
    var boltDuration = null;
    var boltSeekPending = false;
    var boltControlTimer = null;
    var boltRecoveryStartedAt = null;
    var boltRecoveryResult = "none";
    var boltRecoveryResultAt = null;
    var boltRecoveryGeneration = null;
    var boltRecoveryFromGeneration = null;
    var boltRecoveryDecision = "no explicit failure signal";
    var riftState = null;
    var riftPosition = null;
    var riftPositionAt = 0;
    var riftDuration = null;
    var riftSeekTarget = null;
    var riftSeekSentAt = 0;
    var riftStateRequestedAt = null;
    var riftPaused = null;
    var nativeFocusTimer = null;
    var focusAttempts = 0;
    var parentKeysDuringFocus = 0;
    var lastFocusResult = "none";
    var frameLoaded = false;
    var diagnosticSelected = 0;
    var isMovie = route.mediaType === "movie";
    var currentEpisode = route.current || {};
    var manualEndEnabled = !isMovie && route.testEnd && currentEpisode.showId === 2190 && nav.origin === PREVIEW_ORIGIN;
    var resolver = options && options.episodeResolver || (!isMovie && (currentEpisode.showId === 2190 || route.tvdbId)
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
    var movieLoadTimer = null;
    var diagnosticsTimer = null;
    var providerReady = false;
    var providerPlaying = false;
    var providerFailed = false;
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

    function providerLabel() { return providers.label(provider); }
    function isCommandProvider() { return provider === providers.VIDRIFT || provider === providers.VIDBOLT; }
    function renderProviderChoice() {
      var next = providers.next(provider);
      var choice = get("provider-choice");
      choice.textContent = "Provider: " + providerLabel();
      choice.setAttribute("aria-label", "Playback provider: " + providerLabel()
        + ". Press OK to switch to " + providers.label(next));
      var unloadBtn = get("unload-provider");
      if (unloadBtn) {
        unloadBtn.hidden = provider === providers.PRIMARY;
      }
      get("recover-provider").hidden = provider !== providers.VIDBOLT && provider !== providers.YAPGRID;
      get("recover-provider").textContent = provider === providers.YAPGRID ? "Reload Player" : "Recover Player";
      get("experimental-controls").hidden = !isCommandProvider();
      get("experiment-pause").hidden = provider === providers.VIDBOLT;
      get("experiment-volume").hidden = provider === providers.VIDBOLT;
      get("experiment-back-fast").hidden = provider !== providers.VIDBOLT;
      get("experiment-forward-fast").hidden = provider !== providers.VIDBOLT;
      get("experiment-unmute").hidden = provider !== providers.VIDRIFT;
      get("experiment-focus").hidden = provider !== providers.VIDRIFT && provider !== providers.VIDBOLT;
      get("experiment-focus").textContent = provider === providers.VIDBOLT
        ? "Focus VidBolt player · 30s" : "Focus player · 12s";
      get("experiment-skip").hidden = provider !== providers.VIDRIFT;
      ["rewind", "play-pause", "forward"].forEach(function (id) {
        get(id).hidden = isCommandProvider();
      });
      renderBoltPlayPause();
      renderSeekLabels();
    }

    function now() { return clock.performance && clock.performance.now ? clock.performance.now() : Date.now(); }
    function boltIdentity() {
      return isMovie ? "movie:" + currentEpisode.movieId
        : "tv:" + currentEpisode.showId + ":" + currentEpisode.season + ":" + currentEpisode.episode;
    }
    function boltAge(value) { return value === null ? "none" : Math.max(0, Math.floor((now() - value) / 1000)) + "s ago"; }
    function boltPageTime(value) {
      return value === null ? "none" : "+" + (value / 1000).toFixed(1) + "s page time";
    }
    function boltSinceStart(value, session) {
      return value === null ? "none" : "+" + ((value - session.createdAt) / 1000).toFixed(1) + "s";
    }
    function boltStallDetail(s, reason) {
      if (reason === "suspected-playback-stall") return "position stopped advancing";
      if (s.loadedAt === null) return "iframe load not observed";
      if (s.readyAt === null && s.playAt === null) return "iframe loaded; no ready or play";
      if (s.firstTimeupdateAt === null) return "ready/play reported; no timeupdate";
      return "ready/play reported; position not advancing";
    }
    function clearBoltControlTimer() {
      if (boltControlTimer !== null) { clock.clearTimeout(boltControlTimer); boltControlTimer = null; }
    }
    function renderBoltPlayPause() {
      if (provider !== providers.VIDBOLT) return;
      var button = get("experiment-play");
      var s = boltSession;
      var label = s && s.controlPending ? (s.controlPending.type === "pause" ? "Pause…" : "Play…")
        : s && s.paused === false ? "Pause" : s && s.paused === true ? "Play" : "Play · state unknown";
      button.textContent = label;
      button.setAttribute("aria-label", "VidBolt " + label);
    }
    function boltDiagnostic() {
      if (provider !== providers.VIDBOLT) return "VidBolt not selected.";
      if (!boltSession) return "No active VidBolt iframe.";
      var s = boltSession;
      return "Session " + s.generation + " · " + s.identity + "; created " + boltPageTime(s.createdAt)
        + " (" + boltAge(s.createdAt) + ")"
        + "; iframe load " + boltAge(s.loadedAt) + "; ready " + boltAge(s.readyAt)
        + "; play " + boltAge(s.playAt) + "; pause " + boltAge(s.pauseAt)
        + "; first timeupdate " + boltAge(s.firstTimeupdateAt)
        + "; position " + (s.position === null ? "unavailable" : s.position + "s, " + boltAge(s.positionAt))
        + "; last confirmed " + (boltLastConfirmed && boltLastConfirmed.identity === s.identity
          ? boltLastConfirmed.position + "s" : "unavailable")
        + "; last advance " + boltAge(s.advancedAt) + " (" + boltPageTime(s.advancedAt) + ")"
        + "; duration " + (s.duration === null ? "unavailable" : s.duration + "s")
        + "; state " + (s.endedAt !== null ? "ended" : s.paused === true ? "paused"
          : s.pauseIntent ? "pause requested, unconfirmed" : s.paused === false ? "playing" : "unknown")
        + "; ended " + boltAge(s.endedAt) + "; iframe error " + boltAge(s.frameErrorAt)
        + "; progress gap " + (s.advancedAt === null ? "unavailable" : boltAge(s.advancedAt))
        + "; iframe loads " + s.loadCount + ", last " + boltSinceStart(s.latestLoadAt, s)
        + "; parent URL assignments " + s.parentUrlAssignments
        + "; mobile-panel messages " + s.mobilePanelCount + ", subtitle rows " + s.subtitleOptionCount
        + ", last " + boltAge(s.mobilePanelAt)
        + "; watchdog " + (boltRecoveryGeneration === s.generation && boltRecoveryResult === "awaiting position advance"
          ? "recovering" : boltRecoveryGeneration === s.generation && boltRecoveryResultAt !== null
            ? boltRecoveryResult.indexOf("position advancing") === 0 ? "recovered" : "recovery failed"
          : s.suspected ? "suspected stalled (" + s.suspected + ": " + s.suspectedDetail + ")"
          : s.healthy ? "progressing" : "initializing")
        + "; progress threshold in " + (s.suspected ? "0s" : Math.max(0, Math.ceil((s.healthy
          ? BOLT_STALL_GRACE_MS - (now() - Math.max(s.advancedAt, s.monitorSince, s.seekUntil))
          : boltStartupGraceMs - (now() - Math.max(s.createdAt, s.monitorSince))) / 1000)) + "s")
        + "; auto recovery decision " + boltRecoveryDecision
        + "; suspicion began " + boltPageTime(s.suspectedAt) + " (" + boltAge(s.suspectedAt) + ")"
        + "; autoplay " + (s.autoplayRequested ? "requested" : "off diagnostic")
        + "; volume 100% " + (s.volumeSentAt === null ? "not sent" : "command sent " + boltAge(s.volumeSentAt) + ", no provider acknowledgement")
        + "; recovery " + boltRecoveryAttempts + " total, " + boltAutoAttempts + "/1 automatic; last " + boltLastRecoveryReason
        + "; generations " + (boltRecoveryFromGeneration === null ? "none" : boltRecoveryFromGeneration + "→" + boltRecoveryGeneration)
        + "; started " + boltPageTime(boltRecoveryStartedAt)
        + "; result " + boltRecoveryResult + " at " + boltPageTime(boltRecoveryResultAt)
        + ". Picture, audio and volume effect require TV verification.";
    }
    function clearBoltWatchdog() {
      if (boltWatchdogTimer !== null) { clock.clearTimeout(boltWatchdogTimer); boltWatchdogTimer = null; }
    }
    function scheduleBoltWatchdog() {
      clearBoltWatchdog();
      if (provider !== providers.VIDBOLT || !boltSession || disposed) return;
      var generation = boltSession.generation;
      boltWatchdogTimer = clock.setTimeout(function () {
        boltWatchdogTimer = null;
        if (disposed || provider !== providers.VIDBOLT || !boltSession
            || boltSession.generation !== generation || frame.src === "about:blank") return;
        var s = boltSession;
        if (boltSeekPending && now() >= s.seekUntil) {
          boltSeekPending = false; s.seekTarget = null; s.seekUnconfirmed = true;
        }
        var reason = null;
        if (!transitionStarted && state !== STATES.UP_NEXT && !episodeLookupPending
            && !pendingEpisode && s.endedAt === null && s.paused !== true && !s.pauseIntent
            && now() >= s.seekUntil) {
          if (!s.healthy && now() - Math.max(s.createdAt, s.monitorSince) >= boltStartupGraceMs)
            reason = "suspected-startup-stall";
          else if (s.healthy && s.paused !== true && s.advancedAt !== null
              && now() - Math.max(s.advancedAt, s.monitorSince, s.seekUntil) >= BOLT_STALL_GRACE_MS)
            reason = "suspected-playback-stall";
        }
        if (reason) {
          if (s.suspected !== reason) {
            s.suspected = reason;
            s.suspectedDetail = boltStallDetail(s, reason);
            s.suspectedAt = now();
            boltRecoveryDecision = "progress threshold reached; no explicit failure signal; manual recovery available";
          }
          if (boltRecoveryGeneration === s.generation
              && boltRecoveryResult === "awaiting position advance") {
            boltRecoveryResult = "no advancing position after recovery; picture unverified; use Manual Recover";
            boltRecoveryResultAt = now();
          }
        }
        if (state === STATES.DIAGNOSTICS_OPEN) renderDiagnostics();
        scheduleBoltWatchdog();
      }, BOLT_WATCHDOG_TICK_MS);
    }
    function initializeBoltVolume() {
      var s = boltSession;
      if (!s || s.volumeSentAt !== null || s.volumeAttempts >= 2) return;
      s.volumeAttempts += 1;
      if (providers.sendCommand(frame, "volume100", [], provider)) {
        s.volumeSentAt = now();
        diagnostics.recordCommand("volume100");
      }
    }
    function recordBoltEvent(message) {
      var s = boltSession;
      if (!s) return;
      var time = now();
      if (message.type === "vidbolt:ready") {
        if (s.readyAt === null) s.readyAt = time;
        initializeBoltVolume();
      } else if (message.type === "vidbolt:play") {
        if (s.playAt === null) s.playAt = time;
        if (s.controlPending && s.controlPending.type === "pause"
            && time - s.controlPending.at < BOLT_CONTROL_PENDING_MS) return;
        s.controlPending = null;
        clearBoltControlTimer();
        if (s.paused !== false) s.monitorSince = time;
        s.paused = false;
        s.pauseIntent = false;
        s.endedAt = null;
        initializeBoltVolume(); // ready may have been missed.
      } else if (message.type === "vidbolt:pause") {
        if (s.controlPending && s.controlPending.type === "play"
            && time - s.controlPending.at < BOLT_CONTROL_PENDING_MS) return;
        s.controlPending = null;
        clearBoltControlTimer();
        s.pauseAt = time; s.paused = true; s.suspected = null;
        if (movieLoadTimer !== null) { clock.clearTimeout(movieLoadTimer); movieLoadTimer = null; }
        get("player-loading").classList.remove("is-warning");
        get("player-loading").hidden = true;
      } else if (message.type === "vidbolt:ended") {
        s.controlPending = null;
        clearBoltControlTimer();
        s.endedAt = time; s.paused = true; s.suspected = null;
        if (movieLoadTimer !== null) { clock.clearTimeout(movieLoadTimer); movieLoadTimer = null; }
        get("player-loading").classList.remove("is-warning");
        get("player-loading").hidden = true;
      } else if (message.type === "vidbolt:durationchange") {
        s.duration = message.duration;
      } else if (message.type === "vidbolt:mobile-panel") {
        s.mobilePanelCount = Math.min(999, s.mobilePanelCount + 1);
        s.mobilePanelAt = time;
        s.subtitleOptionCount = message.subtitleOptionCount;
      } else if (message.type === "vidbolt:timeupdate") {
        if (s.firstTimeupdateAt === null) s.firstTimeupdateAt = time;
        var seekArrival = s.seekTarget !== null && Math.abs(message.currentTime - s.seekTarget) <= 2;
        if (s.progressReference === null || seekArrival || s.seekTarget !== null
            || s.seekUnconfirmed || message.currentTime < s.progressReference)
          s.progressReference = message.currentTime;
        if (s.seekUnconfirmed) s.seekUnconfirmed = false;
        if (seekArrival) { s.seekTarget = null; s.seekUntil = time + 5000; }
        if (!seekArrival && s.seekTarget === null && time >= s.seekUntil
            && message.currentTime > s.progressReference + 0.25) {
          s.advancedAt = time;
          s.healthy = true;
          if (s.suspected) boltRecoveryDecision = "progress resumed; suspicion cleared";
          s.suspected = null;
          s.suspectedDetail = null;
          s.suspectedAt = null;
          providerFailed = false;
          s.progressReference = message.currentTime;
          boltLastConfirmed = { identity: s.identity, position: message.currentTime };
          if (s.volumeSentAt === null) initializeBoltVolume(); // Both ready and play may be missed.
          if (boltRecoveryGeneration === s.generation && boltRecoveryResult === "awaiting position advance") {
            boltRecoveryResult = "position advancing (picture/audio unverified)";
            boltRecoveryResultAt = time;
          }
          if (movieLoadTimer !== null) { clock.clearTimeout(movieLoadTimer); movieLoadTimer = null; }
          get("player-loading").classList.remove("is-warning");
          get("player-loading").hidden = true;
        }
        s.position = message.currentTime;
        s.positionAt = time;
      }
      renderBoltPlayPause();
    }
    function recoverBolt(reason) {
      if (disposed || provider !== providers.VIDBOLT || route.invalid || !boltSession || activeBatch) return;
      if (reason !== "manual" && boltAutoAttempts >= 1) return;
      var restore = boltLastConfirmed && boltLastConfirmed.identity === boltIdentity()
        ? boltLastConfirmed.position : null;
      if (reason !== "manual") boltAutoAttempts += 1;
      boltRecoveryAttempts += 1;
      boltLastRecoveryAt = now();
      boltRecoveryStartedAt = boltLastRecoveryAt;
      boltRecoveryResult = "awaiting position advance";
      boltRecoveryResultAt = null;
      boltLastRecoveryReason = reason + (reason === "manual" || !boltSession.suspectedDetail
        ? "" : "; " + boltSession.suspectedDetail)
        + (restore === null ? "; position unavailable" : "; resume " + restore + "s");
      boltRecoveryFromGeneration = boltSession.generation;
      unloadFrame();
      vidBoltAutoplay = true;
      loadProviderFrame(restore, true);
      boltRecoveryGeneration = boltSession ? boltSession.generation : null;
      boltRecoveryDecision = reason === "manual" ? "manual recovery requested" : "active iframe error; automatic recovery used";
      get("command-status").textContent = "VidBolt recovery " + boltRecoveryAttempts + ": " + boltLastRecoveryReason
        + ". New iframe loading; TV result unverified.";
      if (state === STATES.DIAGNOSTICS_OPEN) renderDiagnostics();
    }
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
      if (provider === providers.VIDBOLT) {
        get("experiment-back").textContent = "−" + SEEK_LABELS[seekLevels.rewind];
        get("experiment-forward").textContent = "+" + SEEK_LABELS[seekLevels.forward];
        get("experiment-back").setAttribute("aria-label", "VidBolt rewind " + SEEK_LABELS[seekLevels.rewind]);
        get("experiment-forward").setAttribute("aria-label", "VidBolt forward " + SEEK_LABELS[seekLevels.forward]);
      }
    }
    function resetSeekSelection() {
      seekLevels.rewind = 0; seekLevels.forward = 0;
      renderSeekLabels();
    }
    function seekHint(id) {
      var label = id === "forward" ? "Forward " + get("forward-label").textContent
        : "Rewind " + get("rewind-label").textContent;
      var arrows = id === "forward" ? "Right more · Left less" : "Left more · Right less";
      if (provider === providers.VIDBOLT) {
        var delta = SEEK_COUNTS[seekLevels[id]] * 10 * (id === "forward" ? 1 : -1);
        var target = boltPosition !== null && now() - boltPositionAt <= 15000
          ? Math.max(0, Math.min(boltDuration !== null && boltDuration > 0 ? boltDuration : Infinity,
            boltPosition + delta)) : null;
        return label + " · target " + (target === null ? "unavailable until fresh position" : boltClock(target))
          + " · " + arrows + " · OK seeks once · Up/Down Diagnostics";
      }
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
      controls.forEach(function (button, index) {
        if (button) button.tabIndex = visible && !button.hidden
          && (index < 12 || isCommandProvider()) ? 0 : -1;
      });
    }
    function focusControl(index) {
      if (selected !== index) {
        pendingEpisode = null;
        episodeLookup += 1;
        episodeLookupPending = false;
      }
      selected = Math.max(0, Math.min(controls.length - 1, index));
      var id = CONTROL_IDS[selected];
      if (controls[selected]) focus(controls[selected]);
      if (state === STATES.CONTROLS_VISIBLE && !activeBatch
          && (id === "rewind" || id === "forward"
            || (provider === providers.VIDBOLT && (id === "experiment-back" || id === "experiment-forward")))) {
        get("command-status").textContent = seekHint(id === "experiment-back" ? "rewind"
          : id === "experiment-forward" ? "forward" : id);
      }
    }
    function showControls() {
      if (disposed || state !== STATES.PLAYBACK_HIDDEN) return;
      state = STATES.CONTROLS_VISIBLE;
      selected = isCommandProvider() ? 12 : 1;
      setOverlayVisible(true);
      focusControl(selected);
      markPause("overlayAt");
      get("command-status").textContent = isCommandProvider()
        ? "Experimental commands use the provider iframe; TV effect remains unverified."
        : adapter && typeof adapter.send === "function"
        ? "Preparing secure player connection…"
        : "Playback commands unavailable until the secure Pico bridge is connected.";
      if (!isCommandProvider() && adapter && typeof adapter.open === "function") {
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
    function endNativeFocus(reason) {
      if (state !== STATES.NATIVE_FOCUS) return;
      if (nativeFocusTimer !== null) { clock.clearTimeout(nativeFocusTimer); nativeFocusTimer = null; }
      get("player-shell").classList.remove("native-focus-trial");
      frame.tabIndex = -1;
      lastFocusResult += "; parent keys " + parentKeysDuringFocus + "; return " + reason;
      state = STATES.PLAYBACK_HIDDEN;
      focus(capture);
      showControls();
      focusControl(9); // Stop / Unload remains reachable even if the child swallowed Back.
      get("command-status").textContent = "Native input trial ended. Stop / Unload is focused; playback remains unverified.";
    }
    function startNativeFocus() {
      var fromVidLinkDiagnostics = provider === providers.VIDLINK
        && vidLinkMode !== "jwOn" && state === STATES.DIAGNOSTICS_OPEN;
      var fromVidRiftControls = provider === providers.VIDRIFT && state === STATES.CONTROLS_VISIBLE;
      var fromVidBoltControls = provider === providers.VIDBOLT && state === STATES.CONTROLS_VISIBLE;
      if ((!fromVidLinkDiagnostics && !fromVidRiftControls && !fromVidBoltControls) || route.invalid) return;
      if (!frameLoaded || frame.src === "about:blank") {
        get(fromVidLinkDiagnostics ? "vidlink-compat-status" : "command-status").textContent =
          "Wait for iframe load before trying native input.";
        return;
      }
      if (fromVidLinkDiagnostics) closeDiagnostics();
      hideControls();
      state = STATES.NATIVE_FOCUS;
      focusAttempts = Math.min(999, focusAttempts + 1);
      parentKeysDuringFocus = 0;
      frame.tabIndex = 0;
      get("player-shell").classList.add("native-focus-trial");
      var trialSeconds = fromVidBoltControls ? 30 : 12;
      nativeFocusTimer = clock.setTimeout(function () { endNativeFocus("timeout"); }, trialSeconds * 1000);
      try {
        focus(frame);
        lastFocusResult = doc.activeElement === frame ? "iframe element focused" : "iframe element focus unconfirmed";
      } catch (_error) {
        lastFocusResult = "iframe focus failed";
        endNativeFocus("focus failure");
      }
      if (state === STATES.NATIVE_FOCUS) get("screen-reader-status").textContent =
        "Trying native " + providerLabel() + " input for " + trialSeconds
        + " seconds. Horizon will restore Stop / Unload automatically.";
    }
    function navigate(key) {
      if (isCommandProvider()) {
        if (selected >= 12) {
          if (provider === providers.VIDBOLT) {
            var boltControls = [12, 14, 15, 20, 21, 18];
            var index = boltControls.indexOf(selected);
            if (key === "ArrowLeft") focusControl(boltControls[(index + boltControls.length - 1) % boltControls.length]);
            else if (key === "ArrowRight") focusControl(boltControls[(index + 1) % boltControls.length]);
            else if (key === "ArrowUp" || key === "ArrowDown") focusControl(10);
            return;
          }
          var last = provider === providers.VIDRIFT ? 19 : 16;
          if (key === "ArrowLeft") focusControl(selected === 12 ? last : selected - 1);
          else if (key === "ArrowRight") focusControl(selected === last ? 12 : selected + 1);
          else if (key === "ArrowUp" || key === "ArrowDown") focusControl(10);
          return;
        }
        if (selected === 10 && key === "ArrowDown") { focusControl(12); return; }
        if (selected === 11 && key === "ArrowDown") { focusControl(12); return; }
      }
      if (isMovie) {
        if (key === "ArrowDown" || key === "ArrowUp") {
          if (key === "ArrowDown") {
            if (selected <= 2) focusControl(8);
            else if (selected === 8) focusControl(provider !== providers.PRIMARY ? 9 : 10);
            else if (selected === 9) focusControl(10);
            else if (selected === 10 && !get("recover-provider").hidden) focusControl(11);
          } else {
            if (selected === 11) focusControl(10);
            else if (selected === 10) focusControl(provider !== providers.PRIMARY ? 9 : 8);
            else if (selected === 9) focusControl(8);
            else if (selected === 8) focusControl(1);
            else if (selected !== 1) focusControl(1);
          }
          return;
        }
        if (key === "ArrowLeft") {
          if (selected === 1 || selected === 2) focusControl(selected - 1);
          else if (selected === 11) focusControl(10);
          else if (selected === 10) focusControl(provider !== providers.PRIMARY ? 9 : 8);
          else if (selected === 9) focusControl(8);
          return;
        }
        if (key === "ArrowRight") {
          if (selected === 0 || selected === 1) focusControl(selected + 1);
          else if (selected === 8) focusControl(provider !== providers.PRIMARY ? 9 : 10);
          else if (selected === 9) focusControl(10);
          else if (selected === 10 && !get("recover-provider").hidden) focusControl(11);
          return;
        }
      }
      var next = selected;
      if (key === "ArrowLeft") {
        if (selected === 1 || selected === 2 || (selected >= 4 && selected <= 6)) next -= 1;
        else if (selected === 9) next = 8;
        else if (selected === 11) next = 10;
        else if (selected === 10) next = provider !== providers.PRIMARY ? 9 : 8;
      } else if (key === "ArrowRight") {
        if (selected === 0 || selected === 1 || (selected >= 3 && selected <= 5)) next += 1;
        else if (selected === 8) next = provider !== providers.PRIMARY ? 9 : 10;
        else if (selected === 9) next = 10;
        else if (selected === 10 && !get("recover-provider").hidden) next = 11;
      } else if (key === "ArrowDown") {
        if (selected <= 2) next = [3, 4, 6][selected];
        else if (selected >= 3 && selected <= 6) next = manualEndEnabled ? 7 : 8;
        else if (selected === 7) next = 8;
        else if (selected === 8) next = provider !== providers.PRIMARY ? 9 : 10;
        else if (selected === 9) next = 10;
        else if (selected === 10 && !get("recover-provider").hidden) next = 11;
      } else if (key === "ArrowUp") {
        if (selected === 0 || selected === 2) next = 1;
        else if (selected >= 3 && selected <= 6) next = selected === 3 ? 0 : selected === 6 ? 2 : 1;
        else if (selected === 7) next = 5;
        else if (selected === 8) next = manualEndEnabled ? 7 : 1;
        else if (selected === 9) next = 8;
        else if (selected === 11) next = 10;
        else if (selected === 10) next = provider !== providers.PRIMARY ? 9 : 8;
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
      if (provider !== providers.PRIMARY) {
        get("command-status").textContent = "Horizon has no tested " + providerLabel()
          + " subtitle selection. Check whether the provider's native controls are accessible on this TV.";
        return;
      }
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
        manualEndEnabled, null, route.fromSearch, route.showTitle, route.tvdbId, provider));
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
      if (reason === "focus_error") get("command-status").textContent = "Could not focus " + providerLabel() + "; no command was sent.";
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
        + " ms. " + providerLabel() + " position unverified.";
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
        commandMessage = providerLabel() + " did not become the active element; no command was sent.";
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
      get("command-status").textContent = "Handing focus to " + providerLabel() + "; waiting for controller delivery…";
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
      return catalog.pageUrl(currentEpisode, subtitleMode, manualEndEnabled, "list", route.fromSearch, route.showTitle, route.tvdbId, provider);
    }
    function launchEpisode(target) {
      transitionTo(catalog.pageUrl(target, subtitleMode, manualEndEnabled, null, route.fromSearch, route.showTitle, route.tvdbId, provider));
    }
    function exitPlayer() {
      if (!route.fromSearch) { dispose(); nav.replace("embed-matrix.html"); return; }
      if (isMovie) {
        var movieReturn = "https://horizon-universal-search-preview.ali-al-anbari.workers.dev/"
          + (route.invalid ? "" : "?return=1&type=movie&id=" + currentEpisode.movieId);
        dispose(); nav.replace(movieReturn); return;
      }
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
            + " · " + result.target.title + " is listed by TVmaze. " + providerLabel() + " playback unknown; press OK again to try.";
        } else if (result && result.kind === "none_known") {
          get(direction < 0 ? "previous-episode" : "next-episode").setAttribute("aria-disabled", "true");
          get("command-status").textContent = direction < 0
            ? "No earlier aired episode in metadata; " + providerLabel() + " availability unknown."
            : "No later aired episode in metadata; series status and " + providerLabel() + " availability unknown.";
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
            ? "No later aired episode in metadata; series status and " + providerLabel() + " availability unknown."
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
    function boltClock(seconds) {
      var whole = Math.max(0, Math.floor(seconds));
      return Math.floor(whole / 60) + ":" + (whole % 60 < 10 ? "0" : "") + whole % 60;
    }
    function sendBoltSeek(delta) {
      if (provider !== providers.VIDBOLT || !boltSession || !frameLoaded || frame.src === "about:blank") return false;
      if (!providerReady && !providerPlaying && boltSession.paused !== true) {
        get("command-status").textContent = "Wait for VidBolt ready; no seek sent.";
        return false;
      }
      if (boltSeekPending) {
        get("command-status").textContent = "Await a confirmed VidBolt seek position; no second seek sent.";
        return false;
      }
      var position = boltPosition;
      var positionAt = boltPositionAt;
      if (position === null || !isFinite(position) || position < 0 || now() - positionAt > 15000) {
        get("command-status").textContent = "VidBolt position is unavailable or stale; no seek sent.";
        return false;
      }
      var target = Math.max(0, Math.min(boltDuration !== null && boltDuration > 0 ? boltDuration : Infinity,
        position + delta));
      if (target === position) {
        get("command-status").textContent = "At the seek boundary; no seek sent.";
        return false;
      }
      if (!providers.sendCommand(frame, "seek", [target], provider)) {
        get("command-status").textContent = "VidBolt seek could not be sent.";
        return false;
      }
      boltSeekPending = true;
      boltSession.seekUntil = now() + BOLT_SEEK_GRACE_MS;
      boltSession.seekTarget = target;
      boltSession.seekUnconfirmed = false;
      diagnostics.recordCommand("seek");
      get("command-status").textContent = "Seek requested to " + boltClock(target)
        + "; awaiting VidBolt position confirmation.";
      get("screen-reader-status").textContent = get("command-status").textContent;
      return true;
    }
    function toggleBoltPlayPause() {
      var s = boltSession;
      if (!s) return;
      if (s.controlPending) {
        get("command-status").textContent = "Await VidBolt's play/pause response; no opposite command sent.";
        return;
      }
      if (s.controlLastSentAt !== null && now() - s.controlLastSentAt < 750) {
        get("command-status").textContent = "Wait briefly before another VidBolt play/pause request.";
        return;
      }
      var command = s.paused === false ? "pause" : "play";
      if (!providers.sendCommand(frame, command, [], provider)) {
        get("command-status").textContent = "VidBolt " + command + " could not be sent.";
        return;
      }
      s.controlLastSentAt = now();
      s.controlPending = { type: command, at: now() };
      s.pauseIntent = command === "pause";
      diagnostics.recordCommand(command);
      renderBoltPlayPause();
      get("command-status").textContent = "VidBolt " + command + " requested; awaiting provider event.";
      clearBoltControlTimer();
      var generation = s.generation;
      boltControlTimer = clock.setTimeout(function () {
        boltControlTimer = null;
        if (!boltSession || boltSession.generation !== generation || !boltSession.controlPending) return;
        var wasPause = boltSession.controlPending.type === "pause";
        boltSession.controlPending = null;
        boltSession.paused = null;
        renderBoltPlayPause();
        get("command-status").textContent = wasPause
          ? "VidBolt pause response missing; state unknown, watchdog held for your pause request."
          : "VidBolt play response missing; state unknown.";
      }, BOLT_CONTROL_PENDING_MS);
    }
    function activateExperimental(id) {
      if (id === "experiment-focus") { startNativeFocus(); return; }
      if (!isCommandProvider() || !frameLoaded || frame.src === "about:blank") {
        get("command-status").textContent = "Wait for the experimental iframe to load; no command sent.";
        return;
      }
      if (provider === providers.VIDBOLT && !providerReady && !providerPlaying
          && (!boltSession || boltSession.paused !== true)) {
        get("command-status").textContent = "Wait for VidBolt ready; no command sent.";
        return;
      }
      if (provider === providers.VIDBOLT) {
        if (id === "experiment-play") toggleBoltPlayPause();
        else if (id === "experiment-back") sendBoltSeek(-10 * SEEK_COUNTS[seekLevels.rewind]);
        else if (id === "experiment-forward") sendBoltSeek(10 * SEEK_COUNTS[seekLevels.forward]);
        else if (id === "experiment-back-fast") sendBoltSeek(-600);
        else if (id === "experiment-forward-fast") sendBoltSeek(600);
        return;
      }
      var command = id.slice(11);
      var args = [];
      function requestRiftState(reason) {
        var requested = false;
        if (riftStateRequestedAt === null || now() - riftStateRequestedAt >= 2000) {
          if (providers.sendCommand(frame, "get-state", [], provider)) {
            riftStateRequestedAt = now();
            diagnostics.recordCommand("get-state");
            requested = true;
          }
        }
        get("command-status").textContent = reason + (requested ? " Requested VidRift state;"
          : " Awaiting VidRift state;") + " retry after its position arrives.";
      }
      if (command === "back" || command === "forward") {
        if (provider === providers.VIDRIFT) {
          if (riftSeekTarget !== null) {
            requestRiftState("Previous seek has no confirmed position.");
            return;
          }
          if (riftPosition === null || riftDuration === null || now() - riftPositionAt > 8000) {
            requestRiftState("VidRift position is missing or stale" + (riftPaused ? " while paused." : "."));
            return;
          }
          var destination = Math.max(0, Math.min(riftDuration,
            riftPosition + (command === "forward" ? 10 : -10)));
          if (destination === riftPosition) {
            get("command-status").textContent = "VidRift is at the seek boundary; no seek sent.";
            return;
          }
          args = [destination];
          command = "resume";
        }
        else {
          if (boltSeekPending) {
            get("command-status").textContent = "Await a fresh VidBolt position before another seek; no command sent.";
            return;
          }
          if (boltPosition === null || now() - boltPositionAt > 15000) {
            get("command-status").textContent = "VidBolt position is unavailable or stale; no seek sent.";
            return;
          }
          args = [Math.max(0, Math.min(boltDuration === null ? Infinity : boltDuration,
            boltPosition + (command === "forward" ? 10 : -10)))];
          command = "seek";
        }
      } else if (command === "volume") command = "volume50";
      else if (command === "skip" && provider === providers.VIDRIFT) command = "seek-forward";
      if (command === "unmute" && provider !== providers.VIDRIFT) return;
      var sent = providers.sendCommand(frame, command, args, provider);
      if (sent && provider === providers.VIDBOLT && command === "seek") {
        boltSeekPending = true;
        if (boltSession) {
          boltSession.seekUntil = now() + BOLT_SEEK_GRACE_MS;
          boltSession.seekTarget = args[0];
          boltSession.seekUnconfirmed = false;
        }
      }
      if (sent && provider === providers.VIDRIFT && command === "resume") {
        riftSeekTarget = args[0];
        riftSeekSentAt = now();
      }
      if (sent) diagnostics.recordCommand(command);
      get("command-status").textContent = sent
        ? providerLabel() + " " + command + " sent; provider response and TV effect remain unverified."
        : providerLabel() + " " + command + " could not be sent.";
      if (state === STATES.DIAGNOSTICS_OPEN) renderDiagnostics();
    }
    function activateControl() {
      var id = CONTROL_IDS[selected];
      if (id.indexOf("experiment-") === 0) { activateExperimental(id); return; }
      if (isCommandProvider() && selected <= 2) return;
      if (id === "diagnostics-open") { openDiagnostics(); return; }
      if (id === "provider-choice") { switchProvider(); return; }
      if (id === "unload-provider") { stopAndUnloadProvider(); return; }
      if (id === "recover-provider") {
        if (provider === providers.YAPGRID) reloadYapGrid();
        else if (provider === providers.VIDBOLT) recoverBolt("manual");
        return;
      }
      if (isMovie && !COMMANDS[id]) return;
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
      if (state === STATES.NATIVE_FOCUS) {
        if (key === "OK" || key === "Back" || key.indexOf("Arrow") === 0) {
          parentKeysDuringFocus = Math.min(999, parentKeysDuringFocus + 1);
          if (key === "Back" && !event.repeat) {
            event.preventDefault();
            if (typeof event.stopPropagation === "function") event.stopPropagation();
            endNativeFocus("parent Back");
          }
        }
        return; // Other keys are not rewritten as trusted child-frame input.
      }
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
        else if (key === "OK" && !event.repeat && !isCommandProvider()) {
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
      if (state === STATES.DIAGNOSTICS_OPEN) {
        if (key === "Back" && !event.repeat) closeDiagnostics();
        else if (key === "OK" && !event.repeat) activateDiagnostic();
        else if (provider === providers.CINESRC && key === "ArrowDown" && diagnosticSelected === 0)
          focusDiagnostic(1);
        else if (key === "ArrowUp" && diagnosticSelected > 0) focusDiagnostic(0);
        else if (provider === providers.CINESRC && key === "ArrowRight" && diagnosticSelected > 0)
          focusDiagnostic(diagnosticSelected === 4 ? 1 : diagnosticSelected + 1);
        else if (provider === providers.CINESRC && key === "ArrowLeft" && diagnosticSelected > 0)
          focusDiagnostic(diagnosticSelected === 1 ? 4 : diagnosticSelected - 1);
        else if (provider === providers.VIDFAST && key === "ArrowDown" && diagnosticSelected === 0)
          focusDiagnostic(5);
        else if (provider === providers.VIDFAST && key === "ArrowRight" && diagnosticSelected === 5)
          focusDiagnostic(6);
        else if (provider === providers.VIDFAST && key === "ArrowLeft" && diagnosticSelected === 6)
          focusDiagnostic(5);
        else if (provider === providers.VIDLINK && key === "ArrowDown" && diagnosticSelected === 0)
          focusDiagnostic(7);
        else if (provider === providers.VIDLINK && key === "ArrowRight" && diagnosticSelected >= 7)
          focusDiagnostic(diagnosticSelected === (vidLinkMode === "jwOn" ? 9 : 10) ? 7 : diagnosticSelected + 1);
        else if (provider === providers.VIDLINK && key === "ArrowLeft" && diagnosticSelected >= 7)
          focusDiagnostic(diagnosticSelected === 7 ? (vidLinkMode === "jwOn" ? 9 : 10) : diagnosticSelected - 1);
        else if (provider === providers.VIDBOLT && key === "ArrowRight" && diagnosticSelected === 11)
          focusDiagnostic(12);
        else if (provider === providers.VIDBOLT && key === "ArrowLeft" && diagnosticSelected === 12)
          focusDiagnostic(11);
        else if (provider === providers.VIDBOLT && key === "ArrowDown" && diagnosticSelected === 0)
          focusDiagnostic(11);
        return;
      }
      resetIdle();
      if (key === "Back") { if (!event.repeat) { if (activeBatch) cancelActiveBatch(); else hideControls(); } }
      else if (key === "OK") { if (!event.repeat) activateControl(); }
      else if (provider === providers.VIDBOLT && (selected === 14 || selected === 15)
          && (key === "ArrowLeft" || key === "ArrowRight")) {
        if (!adjustSeek(selected === 14 ? "rewind" : "forward", key)) navigate(key);
      }
      else if ((selected === 0 || selected === 2)
          && (key === "ArrowLeft" || key === "ArrowRight")) {
        if (!adjustSeek(CONTROL_IDS[selected], key)) navigate(key);
      } else navigate(key);
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      if (nativeFocusTimer !== null) { clock.clearTimeout(nativeFocusTimer); nativeFocusTimer = null; }
      get("player-shell").classList.remove("native-focus-trial");
      frame.tabIndex = -1;
      if (provider !== providers.PRIMARY) unloadFrame();
      if (movieLoadTimer !== null) { clock.clearTimeout(movieLoadTimer); movieLoadTimer = null; }
      if (diagnosticsTimer !== null) { clock.clearTimeout(diagnosticsTimer); diagnosticsTimer = null; }
      clearBoltWatchdog();
      clearBoltControlTimer();
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
      if (typeof clock.removeEventListener === "function") clock.removeEventListener("message", onProviderMessage);
    }

    function loading(message) {
      var display = get("player-loading");
      display.hidden = false;
      display.textContent = message;
    }
    function renderDiagnostics() {
      var data = diagnostics.snapshot();
      get("diag-user-agent").textContent = data.userAgent;
      get("diag-media-source").textContent = data.mediaSource;
      get("diag-native-hls").textContent = data.nativeHls;
      get("diag-html5").textContent = data.html5;
      get("diag-permissions").textContent = data.permissions;
      get("diag-frame-events").textContent = data.frameEvents;
      get("diag-events").textContent = data.events;
      get("diag-message-checks").textContent = data.messageChecks;
      get("diag-sources").textContent = data.sources;
      get("diag-elapsed").textContent = data.elapsed;
      get("diag-assessment").textContent = data.assessment;
      get("diag-vidbolt-session").textContent = boltDiagnostic();
      get("diag-variant").textContent = "CineSrc test: " + (compatibilityMode === "quality480"
        ? "Quality 480 only" : compatibilityMode === "autoplayOff"
          ? "Autoplay off only" : "Baseline (documented defaults)");
      get("diag-vidfast-mode").textContent = "VidFast test: "
        + (vidFastMode === "autoPlayTrue" ? "Explicit autoPlay=true" : "Baseline (no optional parameters)");
      get("diag-vidlink-mode").textContent = "VidLink test: " + (vidLinkMode === "jwOn"
        ? "JWPlayer · autoplay=true" : "Default · autoplay=" + (vidLinkMode === "defaultOn" ? "true" : "false"));
      get("diag-vidbolt-mode").textContent = "VidBolt test: "
        + (vidBoltAutoplay ? "autoPlay=true (default)" : "autoplay off diagnostic");
      get("vidbolt-autoplay-toggle").textContent = vidBoltAutoplay
        ? "Test autoplay off" : "Restore autoPlay=true";
      get("vidbolt-auto-recover").textContent = "Auto Recover: " + (boltAutoRecover ? "ON" : "OFF");
      get("vidlink-focus-default").hidden = provider !== providers.VIDLINK || vidLinkMode === "jwOn";
      get("vidlink-focus-default").tabIndex = get("vidlink-focus-default").hidden ? -1
        : state === STATES.DIAGNOSTICS_OPEN ? 0 : -1;
      get("vidlink-focus-status").textContent = "Input trial: attempts " + focusAttempts + "; "
        + lastFocusResult + ". Iframe focus does not prove the player received a key.";
    }
    function focusDiagnostic(index) {
      diagnosticSelected = index;
      focus(diagnosticButtons[index]);
    }
    function changeCompatibilityMode(nextMode) {
      if (provider !== providers.CINESRC || state !== STATES.DIAGNOSTICS_OPEN
          || activeBatch || route.invalid) return;
      compatibilityMode = providers.compatibilityMode(nextMode);
      get("compat-status").textContent = "Reloading CineSrc with "
        + (compatibilityMode === providers.BASELINE ? "baseline settings" : compatibilityMode === "quality480"
          ? "quality=480 only" : "autoplay=false only")
        + ". Playback position may be lost; video is unverified.";
      loadProviderFrame();
      renderDiagnostics();
    }
    function activateDiagnostic() {
      if (diagnosticSelected === 0) { closeDiagnostics(); return; }
      if (provider === providers.VIDBOLT && diagnosticSelected === 12) {
        boltAutoRecover = !boltAutoRecover;
        get("vidbolt-compat-status").textContent = "Auto Recover " + (boltAutoRecover ? "ON" : "OFF")
          + ". Only an active iframe error can trigger one automatic reload. Playback stalls stay diagnostic.";
        renderDiagnostics();
        return;
      }
      if (provider === providers.VIDBOLT && diagnosticSelected === 11) {
        vidBoltAutoplay = !vidBoltAutoplay;
        unloadFrame();
        get("vidbolt-compat-status").textContent = "Previous iframe unloaded. Loading "
          + (vidBoltAutoplay ? "autoPlay=true" : "autoplay off diagnostic") + ". Playback remains unverified.";
        loadProviderFrame();
        renderDiagnostics();
        return;
      }
      if (provider === providers.VIDLINK && diagnosticSelected === 10) { startNativeFocus(); return; }
      if (provider === providers.VIDFAST && (diagnosticSelected === 5 || diagnosticSelected === 6)) {
        vidFastMode = diagnosticSelected === 5 ? "autoPlayTrue" : providers.BASELINE;
        get("vidfast-compat-status").textContent = "Reloading VidFast with "
          + (vidFastMode === "autoPlayTrue" ? "autoPlay=true" : "baseline settings")
          + ". Iframe load and command delivery do not confirm playback; stream status remains independent.";
        loadProviderFrame();
        renderDiagnostics();
        return;
      }
      if (provider === providers.VIDLINK && diagnosticSelected >= 7 && diagnosticSelected <= 9) {
        vidLinkMode = ["defaultOff", "defaultOn", "jwOn"][diagnosticSelected - 7];
        unloadFrame();
        get("vidlink-compat-status").textContent = "Previous iframe unloaded. Loading "
          + (vidLinkMode === "jwOn" ? "JWPlayer · autoplay=true" : "default · autoplay="
            + (vidLinkMode === "defaultOn" ? "true" : "false"))
          + ". Check actual video and audio on the TV.";
        loadProviderFrame();
        renderDiagnostics();
        return;
      }
      if (provider !== providers.CINESRC) return;
      if (diagnosticSelected === 1) changeCompatibilityMode("quality480");
      else if (diagnosticSelected === 2) changeCompatibilityMode("autoplayOff");
      else if (diagnosticSelected === 4) changeCompatibilityMode(providers.BASELINE);
      else if (diagnosticSelected === 3) {
        get("compat-status").textContent = compatibilityMode === "quality480"
          ? "Keep the quality test isolated. Reset default or choose Autoplay off before manual play; no command was sent."
          : !frameLoaded
          ? "Wait for the CineSrc iframe load event; no play command was sent."
          : providers.sendCommand(frame, "play", [])
            ? "One CineSrc play command sent; outcome is unverified. No command will be replayed."
            : "CineSrc play command could not be sent; playback is unverified.";
      }
    }
    function tickDiagnostics() {
      diagnosticsTimer = null;
      if (disposed || state !== STATES.DIAGNOSTICS_OPEN) return;
      renderDiagnostics();
      diagnosticsTimer = clock.setTimeout(tickDiagnostics, 1000);
    }
    function openDiagnostics() {
      if (disposed || state !== STATES.CONTROLS_VISIBLE || activeBatch) return;
      clearIdle();
      state = STATES.DIAGNOSTICS_OPEN;
      get("diagnostics-panel").hidden = false;
      get("compat-controls").hidden = provider !== providers.CINESRC;
      get("vidfast-compat-controls").hidden = provider !== providers.VIDFAST;
      get("vidlink-compat-controls").hidden = provider !== providers.VIDLINK;
      get("vidbolt-compat-controls").hidden = provider !== providers.VIDBOLT;
      get("vidlink-focus-default").hidden = provider !== providers.VIDLINK || vidLinkMode === "jwOn";
      overlay.classList.add("is-diagnostics");
      controls.forEach(function (button) { button.tabIndex = -1; });
      diagnosticButtons.forEach(function (button, index) {
        button.tabIndex = index === 0 || (provider === providers.CINESRC && index < 5)
          || (provider === providers.VIDFAST && index >= 5 && index <= 6)
          || (provider === providers.VIDLINK && index >= 7
            && index <= 10 && (index < 10 || vidLinkMode !== "jwOn"))
          || (provider === providers.VIDBOLT && (index === 11 || index === 12)) ? 0 : -1;
      });
      focusDiagnostic(0);
      tickDiagnostics();
    }
    function closeDiagnostics() {
      if (state !== STATES.DIAGNOSTICS_OPEN) return;
      if (diagnosticsTimer !== null) { clock.clearTimeout(diagnosticsTimer); diagnosticsTimer = null; }
      get("diagnostics-panel").hidden = true;
      diagnosticButtons.forEach(function (button) { button.tabIndex = -1; });
      overlay.classList.remove("is-diagnostics");
      state = STATES.CONTROLS_VISIBLE;
      setOverlayVisible(true);
      focusControl(10);
      resetIdle();
    }
    function unloadFrame() {
      clearBoltControlTimer();
      clearBoltWatchdog();
      boltSession = null;
      if (nativeFocusTimer !== null) { clock.clearTimeout(nativeFocusTimer); nativeFocusTimer = null; }
      get("player-shell").classList.remove("native-focus-trial");
      frame.tabIndex = -1;
      if (movieLoadTimer !== null) { clock.clearTimeout(movieLoadTimer); movieLoadTimer = null; }
      frameLoaded = false;
      providerReady = false;
      providerPlaying = false;
      providerFailed = false;
      boltPosition = null;
      boltDuration = null;
      boltSeekPending = false;
      riftState = null;
      riftPosition = null;
      riftDuration = null;
      riftSeekTarget = null;
      riftStateRequestedAt = null;
      riftPaused = null;
      try { if (frame.src !== "about:blank") frame.src = "about:blank"; } catch (_e) {}
    }
    function stopAndUnloadProvider() {
      if (disposed || activeBatch) return;
      unloadFrame();
      get("player-loading").classList.remove("is-warning");
      loading(providerLabel() + " player unloaded. Use Provider to return to YapGrid.");
      get("command-status").textContent = providerLabel() + " player unloaded.";
      get("provider-telemetry").classList.remove("is-visible");
      focusControl(8);
    }
    function reloadYapGrid() {
      if (disposed || provider !== providers.YAPGRID || route.invalid || activeBatch) return;
      unloadFrame();
      loadProviderFrame();
      focusControl(11);
      get("command-status").textContent = "YapGrid player reloaded for the same title. Previous position is unavailable; playback starts again.";
    }
    function loadProviderFrame(resumeAt, recovering) {
      if (movieLoadTimer !== null) { clock.clearTimeout(movieLoadTimer); movieLoadTimer = null; }
      clearBoltWatchdog();
      if (frame.src === "about:blank" && frame.parentNode && typeof frame.cloneNode === "function") {
        var nextFrame = frame.cloneNode(false);
        if (typeof nextFrame.removeAttribute === "function") nextFrame.removeAttribute("src");
        frame.parentNode.replaceChild(nextFrame, frame);
        frame = nextFrame;
        bindFrameEvents(frame);
        diagnostics = root.HorizonPlayerDiagnostics.create(root, doc, frame, clock);
      }
      diagnostics.reset(provider);
      boltPosition = null;
      boltDuration = null;
      boltPositionAt = 0;
      boltSeekPending = false;
      riftState = null;
      riftPosition = null;
      riftDuration = null;
      riftSeekTarget = null;
      riftStateRequestedAt = null;
      riftPaused = null;
      focusAttempts = 0;
      parentKeysDuringFocus = 0;
      lastFocusResult = "none";
      frameLoaded = false;
      providerReady = false;
      providerPlaying = false;
      providerFailed = false;
      var url = route.invalid ? null : providers.embedUrl(currentEpisode, provider, subtitleMode,
        nav.origin, catalog, provider === providers.VIDFAST ? vidFastMode
          : provider === providers.VIDLINK ? vidLinkMode
          : provider === providers.VIDBOLT ? (vidBoltAutoplay ? "autoPlayTrue" : "autoPlayOff")
          : compatibilityMode, provider === providers.VIDBOLT && recovering ? resumeAt : null);
      if (!url) {
        loading(isMovie ? "Invalid movie ID. Press Back to return to Horizon Watch."
          : "Invalid episode ID. Press Back to return to Horizon Watch.");
        return;
      }
      frame.title = providerLabel() + " video player";
      frame.setAttribute("referrerpolicy", provider === providers.VIDRIFT
        ? "strict-origin-when-cross-origin" : "no-referrer");
      frame.setAttribute("allow", provider === providers.VIDBOLT
        ? "autoplay; encrypted-media; picture-in-picture; fullscreen"
        : "autoplay; fullscreen; picture-in-picture");
      if (isMovie || provider !== providers.PRIMARY) {
        get("player-loading").classList.remove("is-warning");
        loading(provider === providers.YAPGRID ? "Opening movie…" : "Opening " + providerLabel() + "…");
      } else {
        get("player-loading").classList.remove("is-warning");
        get("player-loading").hidden = true;
      }
      frame.src = url;
      if (provider === providers.VIDBOLT) {
        boltSession = { generation: ++boltGeneration, identity: boltIdentity(), createdAt: now(),
          loadedAt: null, latestLoadAt: null, loadCount: 0, parentUrlAssignments: 1,
          frameErrorAt: null, readyAt: null, playAt: null, pauseAt: null,
          mobilePanelCount: 0, mobilePanelAt: null, subtitleOptionCount: 0,
          firstTimeupdateAt: null,
          position: null, positionAt: null, progressReference: null, advancedAt: null,
          duration: null, endedAt: null,
          paused: null, pauseIntent: false, controlPending: null, controlLastSentAt: null,
          healthy: false, suspected: null, suspectedDetail: null,
          suspectedAt: null, seekUntil: 0, seekTarget: null,
          seekUnconfirmed: false,
          monitorSince: now(),
          autoplayRequested: vidBoltAutoplay, volumeSentAt: null, volumeAttempts: 0 };
        renderBoltPlayPause();
        scheduleBoltWatchdog();
      } else boltSession = null;
      if (provider === providers.VIDBOLT) {
        // Retire the neutral opening indicator without treating its disappearance
        // as evidence that video or audio started.
        movieLoadTimer = clock.setTimeout(function () {
          movieLoadTimer = null;
          if (!disposed && provider === providers.VIDBOLT) get("player-loading").hidden = true;
        }, 12000);
      } else if (isMovie || provider !== providers.PRIMARY) {
        movieLoadTimer = clock.setTimeout(function () {
          movieLoadTimer = null;
          if (!disposed) {
            get("player-loading").classList.add("is-warning");
            loading("Horizon warning: " + providerLabel() + " is taking longer than expected. Playback is unverified; press Back or choose another provider.");
          }
        }, 12000);
      }
    }
    function onProviderMessage(event) {
      if (disposed || frame.src === "about:blank") return;
      var message = providers.acceptEvent(event, frame, provider, currentEpisode);
      if (!message) {
        var rejected = providers.diagnosticRejection(event, frame, provider, currentEpisode);
        if (rejected) {
          diagnostics.recordRejected(rejected, event);
          if (state === STATES.DIAGNOSTICS_OPEN) renderDiagnostics();
        }
        return;
      }
      diagnostics.record(message);
      if (state === STATES.DIAGNOSTICS_OPEN) renderDiagnostics();
      var telemetry = get("provider-telemetry");

      if (provider === providers.VIDRIFT || provider === providers.VIDBOLT) {
        if (provider === providers.VIDBOLT) {
          recordBoltEvent(message);
          if (state === STATES.DIAGNOSTICS_OPEN) renderDiagnostics();
        }
        if (provider === providers.VIDRIFT && typeof message.currentTime === "number"
            && isFinite(message.currentTime)) {
          riftPosition = message.currentTime;
          riftPositionAt = now();
          if (typeof message.duration === "number" && isFinite(message.duration) && message.duration > 0)
            riftDuration = message.duration;
          if (riftSeekTarget !== null && riftPositionAt >= riftSeekSentAt
              && (Math.abs(riftPosition - riftSeekTarget) <= 2 || riftPositionAt - riftSeekSentAt > 15000))
            riftSeekTarget = null;
        }
        if (message.type === "vidrift:state") {
          riftStateRequestedAt = null;
          riftPaused = message.paused;
          riftState = message;
          providerReady = true;
          providerPlaying = !message.paused;
          telemetry.textContent = "VidRift state: " + (message.paused ? "paused" : "playing")
            + "; time " + Math.floor(message.currentTime) + "s"
            + "; volume " + Math.round(message.volume * 100) + "%" + (message.muted ? " muted" : " unmuted")
            + "; server " + (message.server || "unknown") + ", source " + (message.source || "unknown")
            + "; audio " + message.audioCount + ", subtitles " + message.subtitleCount
            + ", qualities " + message.qualityCount + ", servers " + message.serverCount + ".";
          telemetry.classList.add("is-visible");
        } else if (message.type === "vidrift:progress" || message.type === "vidbolt:timeupdate") {
          if (provider === providers.VIDRIFT && riftState) riftState.currentTime = message.currentTime;
          if (provider === providers.VIDBOLT) {
            boltPosition = message.currentTime;
            boltPositionAt = now();
            if (boltSeekPending && boltSession && boltSession.seekTarget === null) {
              boltSeekPending = false;
            }
          }
          telemetry.textContent = providerLabel() + " reports " + Math.floor(message.currentTime)
            + "s" + (message.duration !== null && message.duration !== undefined
              ? " / " + Math.floor(message.duration) + "s" : "") + "; check picture and sound on TV.";
          telemetry.classList.add("is-visible");
        } else if (message.type === "vidrift:command-error") {
          get("command-status").textContent = "VidRift refused " + message.command
            + (message.field ? " (" + message.field + ")" : "") + ": " + message.reason + "."
            + (message.reason === "click-required"
              ? " Try Focus player and press OK inside VidRift, then retry; TV input support is unverified."
              : message.reason === "not-ready" ? " Wait for the stream before retrying." : "");
          if (message.reason === "click-required" || message.reason === "not-ready")
            get("screen-reader-status").textContent = get("command-status").textContent;
        } else if (message.type === "vidbolt:durationchange") {
          boltDuration = message.duration;
        } else if (message.type === "vidbolt:ready") {
          providerReady = true;
        } else if (message.type === "vidrift:unpaused" || message.type === "vidbolt:play") {
          if (provider === providers.VIDRIFT) riftPaused = false;
          providerPlaying = true;
        } else if (message.type === "vidrift:paused" || message.type === "vidbolt:pause"
            || message.type === "vidrift:ended" || message.type === "vidbolt:ended") {
          if (provider === providers.VIDRIFT) riftPaused = true;
          providerPlaying = false;
        }
        if (providerReady || providerPlaying) {
          if (movieLoadTimer !== null) { clock.clearTimeout(movieLoadTimer); movieLoadTimer = null; }
          if (!providerFailed) get("player-loading").hidden = true;
        }
        return;
      }

      if (provider === providers.VIDLINK) {
        if (message.type === "vidlink:play") {
          providerPlaying = true;
          if (movieLoadTimer !== null) { clock.clearTimeout(movieLoadTimer); movieLoadTimer = null; }
          if (!providerFailed) get("player-loading").hidden = true;
          get("screen-reader-status").textContent = providerFailed
            ? "VidLink reports play after an error; picture and audio remain unverified."
            : "VidLink reports play; confirm picture and audio on the TV.";
        } else if (message.type === "vidlink:pause" || message.type === "vidlink:seeked"
            || message.type === "vidlink:ended") {
          if (message.type !== "vidlink:seeked") providerPlaying = false;
          get("command-status").textContent = "VidLink reports " + message.event + "; verify on the TV.";
        } else if (message.type === "vidlink:timeupdate") {
          if (message.currentTime !== null && message.duration !== null) {
            telemetry.textContent = "VidLink reports " + Math.floor(message.currentTime)
              + "s / " + Math.floor(message.duration) + "s; verify against the picture.";
            telemetry.classList.add("is-visible");
          }
        } else if (message.type === "vidlink:media_data") {
          get("command-status").textContent = "VidLink progress data received; video and audio remain unverified.";
        } else if (message.type === "vidlink:error") {
          providerFailed = true;
          if (movieLoadTimer !== null) { clock.clearTimeout(movieLoadTimer); movieLoadTimer = null; }
          get("player-loading").classList.add("is-warning");
          loading("VidLink reports an error. Playback is unverified; use Provider to return to YapGrid.");
          get("command-status").textContent = "VidLink error: " + message.error;
        }
        return;
      }

      if (message.type === "vidfast:play" || message.event === "play") {
        providerPlaying = true;
        if (!providerFailed) {
          if (movieLoadTimer !== null) { clock.clearTimeout(movieLoadTimer); movieLoadTimer = null; }
          get("player-loading").classList.remove("is-warning");
          get("player-loading").hidden = true;
        }
        get("screen-reader-status").textContent = providerFailed
          ? "VidFast reports play after a stream error; video and audio remain unverified."
          : "VidFast reports play. Verify visible video and audio on the TV.";
      } else if (message.type === "vidfast:pause" || message.event === "pause") {
        providerPlaying = false;
        get("command-status").textContent = "VidFast reported pause; verify on the TV.";
      } else if (message.type === "vidfast:timeupdate" || message.event === "timeupdate") {
        telemetry.textContent = "VidFast reports " + Math.floor(message.currentTime)
          + "s / " + Math.floor(message.duration) + "s; verify against the picture.";
        telemetry.classList.add("is-visible");
      } else if (message.type === "vidfast:playerstatus" || message.event === "playerstatus") {
        telemetry.textContent = "VidFast status: " + Math.floor(message.currentTime)
          + "s / " + Math.floor(message.duration) + "s; playback accuracy is unverified.";
        telemetry.classList.add("is-visible");
      } else if (message.type === "vidfast:ended" || message.event === "ended") {
        get("command-status").textContent = "VidFast reported ended; verify on the TV.";
      } else if (message.type === "vidfast:status" || message.event === "status") {
        if (typeof message.statusCode === "number" && message.statusCode >= 400) {
          providerFailed = true;
          if (movieLoadTimer !== null) { clock.clearTimeout(movieLoadTimer); movieLoadTimer = null; }
          get("player-loading").classList.add("is-warning");
          loading("Horizon warning: VidFast reported stream status " + message.statusCode + ". Playback is unverified; use Provider to return to YapGrid.");
        }
        get("command-status").textContent = "VidFast reported status " + message.statusCode + "; verify on the TV.";
      } else if (message.type === "vidfast:media_data" || message.event === "media_data") {
        get("command-status").textContent = "VidFast sync heartbeat received (" + message.itemCount + " items); video playback unverified.";
      } else if (message.type === "cinesrc:ready") {
        if (providerReady || providerFailed) return;
        providerReady = true;
        if (movieLoadTimer !== null) { clock.clearTimeout(movieLoadTimer); movieLoadTimer = null; }
        if (!providerPlaying) loading("CineSrc reports player ready; video playback is unverified.");
        providers.sendCommand(frame, "getCurrentTime", [], provider);
        providers.sendCommand(frame, "getDuration", [], provider);
      } else if (message.type === "cinesrc:play") {
        providerPlaying = true;
        providerFailed = false;
        if (movieLoadTimer !== null) { clock.clearTimeout(movieLoadTimer); movieLoadTimer = null; }
        get("player-loading").hidden = true;
        get("screen-reader-status").textContent = "CineSrc reports play. Verify visible video and audio on the TV.";
      } else if (message.type === "cinesrc:error") {
        providerFailed = true;
        if (movieLoadTimer !== null) { clock.clearTimeout(movieLoadTimer); movieLoadTimer = null; }
        loading("CineSrc reported an error. Playback is unverified; use Provider to return to YapGrid.");
        get("command-status").textContent = "CineSrc error reported: " + message.error;
      } else if (message.type === "cinesrc:timeupdate") {
        telemetry.textContent = "CineSrc reports " + Math.floor(message.currentTime)
          + "s / " + Math.floor(message.duration) + "s; verify against the picture.";
        telemetry.classList.add("is-visible");
      } else if (message.type === "cinesrc:response") {
        telemetry.textContent = "CineSrc " + message.command + " response: " + Math.floor(message.result)
          + "s; playback accuracy is unverified.";
        telemetry.classList.add("is-visible");
      } else if (message.type === "cinesrc:nextepisode") {
        get("command-status").textContent = "CineSrc reports internal S" + message.season + " E" + message.episode
          + "; Horizon's selected episode and History were not changed.";
      } else if (message.type === "cinesrc:sourceused") {
        get("command-status").textContent = "CineSrc reports source " + message.sourceId + "; playback is unverified.";
      } else if (message.type === "cinesrc:ended" || message.type === "cinesrc:pause"
          || message.type === "cinesrc:seeking" || message.type === "cinesrc:seeked"
          || message.type === "cinesrc:loadedmetadata") {
        get("command-status").textContent = "CineSrc reported " + message.type.slice(8) + "; verify on the TV.";
      } else if (message.type === "cinesrc:close") {
        exitPlayer();
      }
    }
    function switchProvider() {
      if (disposed || state !== STATES.CONTROLS_VISIBLE || activeBatch || route.invalid) return;
      hideControls();
      unloadFrame();
      provider = providers.next(provider);
      compatibilityMode = providers.BASELINE;
      vidFastMode = providers.BASELINE;
      vidLinkMode = "defaultOff";
      vidBoltAutoplay = true;
      boltAutoAttempts = 0;
      boltRecoveryAttempts = 0;
      boltLastRecoveryAt = null;
      boltLastRecoveryReason = "none";
      boltRecoveryStartedAt = null;
      boltRecoveryResult = "none";
      boltRecoveryResultAt = null;
      boltRecoveryGeneration = null;
      boltRecoveryFromGeneration = null;
      boltRecoveryDecision = "no explicit failure signal";
      boltLastConfirmed = null;
      get("compat-status").textContent = "Each choice reloads CineSrc with one changed setting. Play is a separate manual command.";
      get("vidfast-compat-status").textContent = "Iframe loading, provider status, and visible playback are separate results.";
      get("vidlink-compat-status").textContent = "Choose one setting, then check picture and audio on the TV. Each choice unloads the previous player.";
      get("vidbolt-compat-status").textContent = "Changing autoplay unloads and reloads the iframe.";
      renderProviderChoice();
      get("provider-telemetry").classList.remove("is-visible");
      get("provider-telemetry").textContent = "Playback position is unverified.";
      if (!isMovie && currentEpisode.showId === 2190) {
        get("metadata-provider-credit").textContent = providerLabel() + " playback availability is unverified";
      } else {
        get("metadata-credit").textContent = (isMovie ? "Movie selected by TMDB ID" : "Episode selected by TMDB ID")
          + " · " + providerLabel() + " playback availability is unverified";
      }
      get("screen-reader-status").textContent = "Switching to " + providerLabel()
        + ". Playback is unverified. Press an arrow to show Horizon controls.";
      loadProviderFrame();
    }
    function bindFrameEvents(activeFrame) {
    activeFrame.addEventListener("load", function () {
      if (disposed || activeFrame !== frame || frame.src === "about:blank") return;
      frameLoaded = true;
      diagnostics.recordFrame("load");
      if (provider === providers.VIDBOLT && boltSession) {
        boltSession.loadCount = Math.min(999, boltSession.loadCount + 1);
        boltSession.latestLoadAt = now();
        if (boltSession.loadedAt === null) boltSession.loadedAt = now();
      }
      if (provider === providers.VIDRIFT && providers.sendCommand(frame, "get-state", [], provider)) {
        diagnostics.recordCommand("get-state");
      }
      if (state === STATES.DIAGNOSTICS_OPEN) renderDiagnostics();
      if (provider === providers.VIDRIFT || provider === providers.VIDBOLT) {
        if (provider === providers.VIDBOLT) get("player-loading").hidden = true;
        if (provider !== providers.VIDBOLT && !providerReady && !providerPlaying && !providerFailed
            && !(provider === providers.VIDBOLT && boltSession && boltSession.healthy))
          loading(providerLabel() + " iframe loaded; awaiting player signal. Picture and sound unverified.");
      } else if (provider === providers.VIDFAST) {
        if (!providerReady && !providerPlaying && !providerFailed)
          loading("VidFast frame loaded; awaiting player signals. Video playback is unverified.");
      } else if (provider === providers.VIDLINK) {
        if (!providerPlaying && !providerFailed)
          loading("VidLink frame loaded; video and audio remain unverified.");
      } else if (provider === providers.CINESRC) {
        if (!providerReady && !providerPlaying && !providerFailed)
          loading("CineSrc frame loaded; awaiting player signals. Video playback is unverified.");
      } else if (isMovie) {
        if (movieLoadTimer !== null) { clock.clearTimeout(movieLoadTimer); movieLoadTimer = null; }
        get("player-loading").hidden = true;
        get("screen-reader-status").textContent = "Movie frame loaded. Playback remains unverified. Press Back to return to Horizon Watch.";
      }
    });
    activeFrame.addEventListener("error", function () {
      if (disposed || activeFrame !== frame || frame.src === "about:blank") return;
      frameLoaded = false;
      diagnostics.recordFrame("error");
      if (provider === providers.VIDBOLT && boltSession) boltSession.frameErrorAt = now();
      if (state === STATES.DIAGNOSTICS_OPEN) renderDiagnostics();
      providerFailed = true;
      if (movieLoadTimer !== null) { clock.clearTimeout(movieLoadTimer); movieLoadTimer = null; }
      if (provider === providers.VIDBOLT && boltSession) {
        var s = boltSession;
        var blocked = !boltAutoRecover ? "Auto Recover OFF"
          : boltAutoAttempts >= 1 ? "automatic recovery limit reached"
          : s.endedAt !== null ? "ended"
          : s.paused === true || s.pauseIntent ? "intentionally paused"
          : boltSeekPending || now() < s.seekUntil ? "seek in progress"
          : transitionStarted || state === STATES.UP_NEXT || episodeLookupPending || pendingEpisode
            ? "navigation in progress" : null;
        if (blocked) {
          boltRecoveryDecision = "active iframe error; skipped: " + blocked;
          if (boltRecoveryGeneration === s.generation && boltRecoveryResult === "awaiting position advance") {
            boltRecoveryResult = "iframe error after recovery; manual recovery available";
            boltRecoveryResultAt = now();
          }
        } else {
          if (!s.suspectedDetail) s.suspectedDetail = "active iframe error event";
          recoverBolt("iframe-error");
          return;
        }
        if (state === STATES.DIAGNOSTICS_OPEN) renderDiagnostics();
        get("player-loading").hidden = true;
        return;
      }
      get("player-loading").classList.add("is-warning");
      loading(providerLabel() + " frame could not load. Playback is unverified; press Back or choose another provider.");
    });
    }
    bindFrameEvents(frame);
    clock.addEventListener("message", onProviderMessage);
    if (isMovie) {
      ["previous-episode", "episodes", "next-episode", "subtitles"].forEach(function (id) { get(id).hidden = true; });
      get("show-title").textContent = route.showTitle || "Movie";
      get("episode-caption").textContent = "Movie · playback position unavailable";
      get("metadata-credit").textContent = "Movie selected by TMDB ID · " + providerLabel() + " playback availability is unverified";
    } else {
      if (currentEpisode.showId !== 2190) {
        get("show-title").textContent = route.showTitle || "TV Episode";
        get("metadata-credit").textContent = "Episode metadata: TMDB selection · " + providerLabel() + " playback availability is unverified";
      } else {
        if (route.showTitle) get("show-title").textContent = route.showTitle;
        get("metadata-provider-credit").textContent = providerLabel() + " playback availability is unverified";
      }
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
    }
    renderProviderChoice();
    loadProviderFrame();
    get("subtitle-mode").textContent = subtitleMode.toUpperCase();
    controls.forEach(function (button, index) {
      if (!button) return;
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
    diagnosticButtons.forEach(function (button, index) {
      button.addEventListener("click", function () {
        if (state !== STATES.DIAGNOSTICS_OPEN || (index > 0 && index < 5 && provider !== providers.CINESRC)
            || (index >= 5 && index <= 6 && provider !== providers.VIDFAST)
            || (index >= 7 && index <= 10 && provider !== providers.VIDLINK)
            || ((index === 11 || index === 12) && provider !== providers.VIDBOLT)) return;
        diagnosticSelected = index;
        activateDiagnostic();
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
