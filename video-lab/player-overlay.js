(function (root) {
  "use strict";

  var STATES = {
    PLAYBACK_HIDDEN: "PLAYBACK_HIDDEN",
    CONTROLS_VISIBLE: "CONTROLS_VISIBLE",
    SUBMENU_OPEN: "SUBMENU_OPEN",
    COMMAND_IN_PROGRESS: "COMMAND_IN_PROGRESS",
    DIAGNOSTICS_OPEN: "DIAGNOSTICS_OPEN",
    NATIVE_FOCUS: "NATIVE_FOCUS",
  };
  var PREVIEW_ORIGIN = "https://horizon-video-lab-preview.ali-al-anbari.workers.dev";
  var CONTROL_IDS = ["rewind", "play-pause", "forward", "previous-episode", "subtitles", "episodes", "next-episode", "manual-end", "provider-choice", "unload-provider", "diagnostics-open", "recover-provider", "experiment-play", "experiment-pause", "experiment-back", "experiment-forward", "experiment-volume", "experiment-unmute", "experiment-focus", "experiment-skip", "watch-exit", "watch-fullscreen"];
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
      get("vidlink-focus-default"), get("vidbolt-autoplay-toggle"), get("vidbolt-auto-recover"),
      get("vidbolt-stop"), get("vidbolt-native-focus")];
    var menuButtons = [get("menu-cancel"), get("menu-change")];
    var upNextButtons = [get("up-next-play")];
    var catalog = root.HorizonEpisodes;
    var providers = root.HorizonPlaybackProviders;
    var diagnostics = root.HorizonPlayerDiagnostics.create(root, doc, frame, clock);
    var route = catalog.parse(nav.search);
    if (route.fromSearch) get("player-shell").classList.add("watch-player");
    var desktopWatch = route.fromSearch && !!(clock.matchMedia
      && (clock.matchMedia("(pointer: fine)").matches || clock.matchMedia("(any-pointer: fine)").matches))
      && !/Vizio|SmartCast/i.test(root.navigator && root.navigator.userAgent || "");
    var playerShell = get("player-shell");
    var desktopFullscreenButton = get("watch-fullscreen");
    var fullscreenWasActive = false;
    var fullscreenExitAt = -Infinity;
    if (desktopWatch) {
      playerShell.classList.add("watch-desktop");
      capture.tabIndex = -1;
    }
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
    var boltRestoreRequest = null;
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
    var boltRecoveryFromLoads = null;
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
    var PLAYER_PROGRESS_KEY = "horizon-video-lab-progress-v1";
    var playerProgressStorage = options && options.progressStorage;
    try { if (!playerProgressStorage) playerProgressStorage = root.localStorage; } catch (_error) { playerProgressStorage = null; }
    var initialSavedProgress = route.startOver ? null : route.resumePosition !== null && route.resumeDuration !== null
      && route.resumePosition > 0 && route.resumePosition <= route.resumeDuration + 2
      ? { position: Math.min(route.resumePosition, route.resumeDuration), duration: route.resumeDuration,
        updatedAt: route.resumeUpdatedAt || 1, provider: "vidbolt", completed: false } : null;
    var initialRestoreTarget = null;
    var initialRestoreConsumed = false;
    var progressLastWriteAt = 0;
    function readPlayerProgress(identity) {
      try {
        var parsed = JSON.parse(playerProgressStorage && playerProgressStorage.getItem(PLAYER_PROGRESS_KEY) || "null");
        var record = parsed && parsed.version === 1 && Array.isArray(parsed.items)
          ? parsed.items.find(function (entry) { return entry && entry.identity === identity; }) : null;
        if (!record || !Number.isFinite(record.position) || record.position <= 0
            || !Number.isFinite(record.duration) || record.duration <= 0 || record.duration > 10000000
            || record.position > record.duration + 2
            || !Number.isFinite(record.updatedAt) || record.provider !== "vidbolt") return null;
        return { position: Math.min(record.position, record.duration), duration: record.duration,
          updatedAt: record.updatedAt, provider: "vidbolt", completed: record.completed === true };
      } catch (_error) { return null; }
    }
    function clearPlayerProgress(identity) {
      if (!playerProgressStorage) return;
      try {
        var parsed = JSON.parse(playerProgressStorage.getItem(PLAYER_PROGRESS_KEY) || "null");
        var items = parsed && parsed.version === 1 && Array.isArray(parsed.items) ? parsed.items : [];
        playerProgressStorage.setItem(PLAYER_PROGRESS_KEY, JSON.stringify({ version: 1,
          items: items.filter(function (entry) { return entry && entry.identity !== identity; }) }));
      } catch (_error) {}
    }
    function storePlayerProgress(position, duration, completed, force, allowRegression) {
      if (provider !== providers.VIDBOLT || !playerProgressStorage || !Number.isFinite(position)
          || !Number.isFinite(duration) || duration <= 0 || duration > 10000000
          || position <= 0 || position > duration + 2) return null;
      var stamp = Date.now();
      if (!force && stamp - progressLastWriteAt < 5000) return null;
      var record = { identity: boltIdentity(), position: Math.min(position, duration), duration: duration,
        updatedAt: stamp, provider: "vidbolt", completed: completed === true };
      try {
        var parsed = JSON.parse(playerProgressStorage.getItem(PLAYER_PROGRESS_KEY) || "null");
        var items = parsed && parsed.version === 1 && Array.isArray(parsed.items) ? parsed.items : [];
        var existing = items.find(function (entry) { return entry && entry.identity === record.identity; });
        if (existing && existing.completed === true) record.completed = true;
        if (existing && Number.isFinite(existing.position) && Number.isFinite(existing.duration)
            && record.position + 1 < existing.position && !allowRegression) {
          if (!completed) return null;
          record.position = Math.min(existing.position, existing.duration);
          record.duration = existing.duration;
        }
        items = items.filter(function (entry) { return entry && entry.identity !== record.identity; });
        items.unshift(record); items = items.slice(0, 100);
        playerProgressStorage.setItem(PLAYER_PROGRESS_KEY, JSON.stringify({ version: 1, items: items }));
        progressLastWriteAt = stamp;
        return record;
      } catch (_error) { return null; }
    }
    function confirmedProgressRecord() {
      if (provider !== providers.VIDBOLT || !boltSession || boltSession.identity !== boltIdentity()) return null;
      var position = boltLastConfirmed && boltLastConfirmed.identity === boltIdentity()
        ? boltLastConfirmed.position : boltPosition;
      if (boltSession.restoreKind === "resume" && boltSession.restoreResult === "position confirmed"
          && boltSession.advancedAt === null && boltSession.restoreBaseline) return boltSession.restoreBaseline;
      if (!Number.isFinite(position) || !Number.isFinite(boltDuration) || boltDuration <= 0 || boltDuration > 10000000
          || position <= 0 || position > boltDuration + 2) return null;
      return { position: Math.min(position, boltDuration), duration: boltDuration,
        updatedAt: Date.now(), provider: "vidbolt", completed: boltSession.endedAt !== null };
    }
    function markStoredProgressComplete() {
      var identity = boltIdentity();
      var saved = readPlayerProgress(identity);
      if (!saved || !playerProgressStorage) return;
      saved.completed = true; saved.updatedAt = Date.now();
      try {
        var parsed = JSON.parse(playerProgressStorage.getItem(PLAYER_PROGRESS_KEY) || "null");
        var items = parsed && Array.isArray(parsed.items) ? parsed.items.filter(function (entry) {
          return entry && entry.identity !== identity;
        }) : [];
        items.unshift(Object.assign({ identity: identity }, saved));
        playerProgressStorage.setItem(PLAYER_PROGRESS_KEY, JSON.stringify({ version: 1, items: items.slice(0, 100) }));
      } catch (_error) {}
    }
    if (route.startOver) clearPlayerProgress(isMovie ? "movie:" + currentEpisode.movieId
      : "tv:" + currentEpisode.showId + ":" + currentEpisode.season + ":" + currentEpisode.episode);
    if (!route.startOver) {
      var cachedProgress = readPlayerProgress(isMovie ? "movie:" + currentEpisode.movieId
        : "tv:" + currentEpisode.showId + ":" + currentEpisode.season + ":" + currentEpisode.episode);
      var selectedProgress = initialSavedProgress && (!cachedProgress || initialSavedProgress.updatedAt >= cachedProgress.updatedAt)
        ? initialSavedProgress : cachedProgress;
      if (selectedProgress && !selectedProgress.completed) initialRestoreTarget = Math.max(0, selectedProgress.position - 10);
    }
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
    var upNextTarget = null;
    var upNextDismissed = false;
    var upNextLookup = 0;
    var upNextLookupPending = false;
    var leavingUpNextFocus = false;
    var transitionStarted = false;
    var episodeLookup = 0;
    var episodeLookupPending = false;
    var pendingEpisode = null;
    var pauseTrace = null;
    var lastPauseTiming = null;

    function providerLabel() { return providers.label(provider); }
    function isCommandProvider() { return provider === providers.VIDRIFT || provider === providers.VIDBOLT; }
    function usesExperimentalRow() { return provider === providers.VIDRIFT; }
    function renderProviderChoice() {
      var next = providers.next(provider);
      var choice = get("provider-choice");
      var text = "Provider: " + providerLabel();
      choice.setAttribute("aria-label", "Playback provider: " + providerLabel()
        + ". Press OK to switch to " + providers.label(next));
      choice.title = "Switch provider · current " + providerLabel();
      var label = choice.querySelector ? choice.querySelector(".action-label") : null;
      if (label) label.textContent = text;
      else choice.textContent = text;
      get("provider-indicator").textContent = providerLabel();
      get("playback-timeline").hidden = true;
      var unloadBtn = get("unload-provider");
      if (unloadBtn) {
        unloadBtn.hidden = provider === providers.PRIMARY || provider === providers.VIDBOLT;
      }
      var recoverBtn = get("recover-provider");
      recoverBtn.hidden = provider !== providers.VIDBOLT && provider !== providers.YAPGRID;
      var recoverText = provider === providers.YAPGRID ? "Reload Player" : "Recover Player";
      var recoverLabel = recoverBtn.querySelector ? recoverBtn.querySelector(".action-label") : null;
      if (recoverLabel) recoverLabel.textContent = recoverText;
      else recoverBtn.textContent = recoverText;
      recoverBtn.title = recoverText;
      recoverBtn.setAttribute("aria-label", recoverText);
      desktopFullscreenButton.hidden = !desktopWatch;
      get("watch-exit").hidden = !route.fromSearch;
      get("experimental-controls").hidden = !usesExperimentalRow();
      get("experiment-pause").hidden = false;
      get("experiment-volume").hidden = false;
      get("experiment-unmute").hidden = provider !== providers.VIDRIFT;
      get("experiment-focus").hidden = provider !== providers.VIDRIFT;
      get("experiment-skip").hidden = provider !== providers.VIDRIFT;
      ["rewind", "play-pause", "forward"].forEach(function (id) {
        get(id).hidden = usesExperimentalRow();
      });
      get("subtitle-mode").textContent = provider === providers.VIDBOLT ? "NATIVE" : subtitleMode.toUpperCase();
      get("subtitles").hidden = isMovie || provider === providers.VIDBOLT;
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
      var button = get("play-pause");
      if (provider !== providers.VIDBOLT) {
        get("play-pause-label").textContent = "Play / Pause";
        button.setAttribute("aria-label", "Play / Pause");
        button.setAttribute("data-playback", "unknown");
        return;
      }
      var s = boltSession;
      var label = s && s.controlPending ? (s.controlPending.type === "pause" ? "Pause…" : "Play…")
        : s && s.paused === false ? "Pause" : s && s.paused === true ? "Play" : "Play / Pause";
      get("play-pause-label").textContent = label;
      button.setAttribute("aria-label", "VidBolt " + label
        + (!s || s.paused === null && !s.controlPending ? "; state unknown" : ""));
      button.setAttribute("data-playback", s && s.paused === false ? "playing" : "paused");
      button.title = label;
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
        + "; position restore " + (s.restoreResult || "none")
        + "; state " + (s.endedAt !== null ? "ended" : s.paused === true ? "paused"
          : s.pauseIntent ? "pause requested, unconfirmed" : s.paused === false ? "playing" : "unknown")
        + "; ended " + boltAge(s.endedAt) + "; iframe error " + boltAge(s.frameErrorAt)
        + "; progress gap " + (s.advancedAt === null ? "unavailable" : boltAge(s.advancedAt))
        + "; iframe loads " + s.loadCount + ", last " + boltSinceStart(s.latestLoadAt, s)
        + "; parent URL assignments " + s.parentUrlAssignments
        + "; provider error events no documented VidBolt message type"
        + "; mobile-panel messages " + s.mobilePanelCount + ", subtitle rows " + s.subtitleOptionCount
        + ", English rows " + s.englishOptionCount + ", Off rows " + s.offOptionCount
        + ", last " + boltAge(s.mobilePanelAt)
        + "; watchdog " + (boltRecoveryGeneration === s.generation && boltRecoveryResult === "awaiting position advance"
          ? "recovering" : boltRecoveryGeneration === s.generation && boltRecoveryResultAt !== null
            ? boltRecoveryResult.indexOf("position advancing") === 0 ? "recovered" : "recovery failed"
          : s.suspected ? "suspected stalled (" + s.suspected + ": " + s.suspectedDetail + ")"
          : s.healthy ? "progressing" : "initializing")
        + "; progress threshold in " + (s.suspected ? "0s" : Math.max(0, Math.ceil((s.healthy
          ? BOLT_STALL_GRACE_MS - (now() - Math.max(s.advancedAt, s.monitorSince, s.seekUntil))
          : boltStartupGraceMs - (now() - Math.max(s.createdAt, s.monitorSince))) / 1000)) + "s")
        + "; last watchdog check " + boltAge(s.watchdogCheckedAt) + " (5s interval)"
        + "; auto recovery decision " + boltRecoveryDecision
        + "; suspicion began " + boltPageTime(s.suspectedAt) + " (" + boltAge(s.suspectedAt) + ")"
        + "; autoplay " + (s.autoplayRequested ? "requested" : "off diagnostic")
        + "; volume 100% " + (s.volumeSentAt === null ? "not sent" : "command sent " + boltAge(s.volumeSentAt) + ", no provider acknowledgement")
        + "; recovery " + boltRecoveryAttempts + " total, " + boltAutoAttempts + "/1 automatic; last " + boltLastRecoveryReason
        + "; generations " + (boltRecoveryFromGeneration === null ? "none" : boltRecoveryFromGeneration + "→" + boltRecoveryGeneration)
        + "; previous iframe loads " + (boltRecoveryFromLoads === null ? "none" : boltRecoveryFromLoads)
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
        s.watchdogCheckedAt = now();
        if (boltSeekPending && now() >= s.seekUntil) {
          boltSeekPending = false; s.seekTarget = null; s.seekUnconfirmed = true;
          if (s.restoreSent && s.restoreResult === "awaiting position confirmation") {
            s.restoreResult = "not confirmed; playback remains available";
            get("command-status").textContent = "VidBolt did not confirm the saved position; playback remains available from its current position.";
          }
        }
        var reason = null;
        if (!transitionStarted && !episodeLookupPending
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
    function issueBoltRestore(s) {
      if (!s || s.restoreTarget === null || s.restoreAttempted || provider !== providers.VIDBOLT
          || s.identity !== boltIdentity()) return;
      s.restoreAttempted = true;
      var target = s.duration > 0 ? Math.min(s.restoreTarget, s.duration) : s.restoreTarget;
      if (!providers.sendCommand(frame, "seek", [target], provider)) {
        s.restoreResult = "seek command could not be sent";
        get("command-status").textContent = "Saved position is unavailable to VidBolt; playback continues from its current position.";
        return;
      }
      s.restoreSent = true;
      s.restoreSentAt = now();
      s.seekTarget = target;
      s.seekUntil = now() + BOLT_SEEK_GRACE_MS;
      s.seekUnconfirmed = true;
      s.restoreResult = "awaiting position confirmation";
      boltSeekPending = true;
      diagnostics.recordCommand("seek");
      get("command-status").textContent = (s.restoreKind === "recovery" ? "Recovery position" : "Resume position")
        + " requested at " + boltClock(target) + "; awaiting VidBolt confirmation.";
    }
    function recordBoltEvent(message) {
      var s = boltSession;
      if (!s) return;
      var time = now();
      if (message.type === "vidbolt:ready") {
        if (s.readyAt === null) s.readyAt = time;
        initializeBoltVolume();
        issueBoltRestore(s);
      } else if (message.type === "vidbolt:play") {
        if (s.playAt === null) s.playAt = time;
        if (s.controlPending && s.controlPending.type === "pause"
            && time - s.controlPending.at < BOLT_CONTROL_PENDING_MS) return;
        s.controlPending = null;
        clearBoltControlTimer();
        var replayAfterEnd = s.endedAt !== null;
        if (s.paused !== false) s.monitorSince = time;
        s.paused = false;
        s.pauseIntent = false;
        s.endedAt = null;
        if (replayAfterEnd) {
          clearUpNext();
        }
        initializeBoltVolume(); // ready may have been missed.
        issueBoltRestore(s);
      } else if (message.type === "vidbolt:pause") {
        if (s.controlPending && s.controlPending.type === "play"
            && time - s.controlPending.at < BOLT_CONTROL_PENDING_MS) return;
        s.controlPending = null;
        clearBoltControlTimer();
        s.pauseAt = time; s.paused = true; s.suspected = null;
        if (movieLoadTimer !== null) { clock.clearTimeout(movieLoadTimer); movieLoadTimer = null; }
        get("player-loading").classList.remove("is-warning");
        get("player-loading").hidden = true;
        var pausedProgress = confirmedProgressRecord();
        if (pausedProgress) storePlayerProgress(pausedProgress.position, pausedProgress.duration,
          pausedProgress.completed, true);
      } else if (message.type === "vidbolt:ended") {
        s.controlPending = null;
        clearBoltControlTimer();
        s.endedAt = time; s.paused = true; s.suspected = null;
        if (!isMovie) startUpNext();
        if (movieLoadTimer !== null) { clock.clearTimeout(movieLoadTimer); movieLoadTimer = null; }
        get("player-loading").classList.remove("is-warning");
        get("player-loading").hidden = true;
        var endedProgress = confirmedProgressRecord();
        if (endedProgress) storePlayerProgress(endedProgress.position, endedProgress.duration, true, true);
        else markStoredProgressComplete();
      } else if (message.type === "vidbolt:durationchange") {
        s.duration = message.duration;
      } else if (message.type === "vidbolt:mobile-panel") {
        s.mobilePanelCount = Math.min(999, s.mobilePanelCount + 1);
        s.mobilePanelAt = time;
        s.subtitleOptionCount = message.subtitleOptionCount;
        s.englishOptionCount = message.englishOptionCount;
        s.offOptionCount = message.offOptionCount;
      } else if (message.type === "vidbolt:timeupdate") {
        if (s.firstTimeupdateAt === null) s.firstTimeupdateAt = time;
        if (typeof message.duration === "number" && isFinite(message.duration) && message.duration > 0)
          s.duration = message.duration;
        var seekArrival = s.seekTarget !== null && Math.abs(message.currentTime - s.seekTarget) <= 2;
        if (s.progressReference === null || seekArrival || s.seekTarget !== null
            || s.seekUnconfirmed || message.currentTime < s.progressReference)
          s.progressReference = message.currentTime;
        if (s.seekUnconfirmed) s.seekUnconfirmed = false;
        if (seekArrival) {
          s.seekTarget = null; s.seekUntil = time + 5000;
          if (s.restoreSent) {
            s.restoreResult = "position confirmed";
            if (s.restoreKind === "recovery") {
              boltLastConfirmed = { identity: s.identity, position: message.currentTime };
              storePlayerProgress(message.currentTime, s.duration, false, true, true);
            }
            get("command-status").textContent = (s.restoreKind === "recovery" ? "Recovery" : "Resume")
              + " position confirmed by VidBolt timeupdate.";
            s.restoreTarget = null;
            s.restoreSent = false;
          } else {
            boltLastConfirmed = { identity: s.identity, position: message.currentTime };
            storePlayerProgress(message.currentTime, s.duration, false, true, true);
          }
        }
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
          storePlayerProgress(message.currentTime, s.duration, false, false);
          if (s.duration > 0 && message.currentTime / s.duration >= 0.95)
            storePlayerProgress(message.currentTime, s.duration, true, true);
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
        boltPosition = message.currentTime;
        boltPositionAt = time;
        boltDuration = s.duration;
        // A provider timeupdate is the confirmed position. Seek preview targets
        // never reach this check, so a validated seek to the completion range
        // is eligible just like any other reported position.
        if (!isMovie && s.duration > 0 && message.currentTime / s.duration >= 0.95) startUpNext();
      }
      renderBoltPlayPause();
    }
    function recoverBolt(reason) {
      if (disposed || provider !== providers.VIDBOLT || route.invalid || !boltSession || activeBatch) return;
      if (reason !== "manual" && boltAutoAttempts >= 1) return;
      var last = confirmedProgressRecord();
      var restore = boltLastConfirmed && boltLastConfirmed.identity === boltIdentity()
        ? boltLastConfirmed.position : last && last.position;
      if (restore === null && boltSession.restoreBaseline
          && boltSession.restoreBaseline.provider === "vidbolt") restore = boltSession.restoreBaseline.position;
      if (restore === null && boltSession.restoreTarget !== null
          && boltSession.identity === boltIdentity()) restore = boltSession.restoreTarget;
      if (reason !== "manual") boltAutoAttempts += 1;
      boltRecoveryAttempts += 1;
      boltLastRecoveryAt = now();
      boltRecoveryStartedAt = boltLastRecoveryAt;
      boltRecoveryResult = "awaiting position advance";
      boltRecoveryResultAt = null;
      boltLastRecoveryReason = reason + (reason === "manual" || !boltSession.suspectedDetail
        ? "" : "; " + boltSession.suspectedDetail)
        + (restore === null ? "; position unavailable" : "; resume " + restore + "s");
      clearUpNext();
      boltRecoveryFromGeneration = boltSession.generation;
      boltRecoveryFromLoads = boltSession.loadCount + " from " + boltSession.parentUrlAssignments
        + " parent URL assignment(s)";
      boltRestoreRequest = restore !== null && Number.isFinite(restore) && restore >= 0
        ? { identity: boltIdentity(), target: restore, kind: "recovery" } : null;
      unloadFrame();
      vidBoltAutoplay = true;
      loadProviderFrame(null, true);
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
      if (state === STATES.CONTROLS_VISIBLE && (selected === 0 || selected === 2))
        renderSeekPreview(CONTROL_IDS[selected]);
    }
    function renderSeekPreview(id) {
      var preview = get("seek-preview");
      if (id !== "rewind" && id !== "forward") { preview.hidden = true; return; }
      var delta = SEEK_COUNTS[seekLevels[id]] * 10 * (id === "forward" ? 1 : -1);
      var detail = "";
      if (provider === providers.VIDBOLT) {
        if (boltPosition !== null && now() - boltPositionAt <= 15000) {
          var target = Math.max(0, Math.min(boltDuration !== null && boltDuration > 0
            ? boltDuration : Infinity, boltPosition + delta));
          detail = " · target " + boltClock(target);
        } else detail = " · waiting for current position";
      }
      preview.textContent = (delta < 0 ? "Rewind " : "Forward ")
        + SEEK_LABELS[seekLevels[id]] + detail + " · OK to confirm";
      preview.hidden = false;
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
          + " · " + arrows + " · OK seeks · Up Play/Pause · Down "
          + (id === "forward" ? "Next Episode" : "Previous Episode");
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
      get("command-status").classList.add("is-seek-help");
      get("screen-reader-status").textContent = get("command-status").textContent;
      return true;
    }

    function focus(element) {
      try { element.focus({ preventScroll: true }); }
      catch (_error) { element.focus(); }
    }
    function playerFullscreen() {
      return doc.fullscreenElement === playerShell || doc.webkitFullscreenElement === playerShell;
    }
    function syncDesktopFullscreen() {
      if (!desktopWatch || disposed) return;
      var active = playerFullscreen();
      if (fullscreenWasActive && !active) {
        fullscreenExitAt = now();
        get("command-status").textContent = "Fullscreen exited.";
      }
      fullscreenWasActive = active;
      var fullscreenText = active ? "Exit Fullscreen" : "Fullscreen";
      var fullscreenLabel = desktopFullscreenButton.querySelector
        ? desktopFullscreenButton.querySelector(".action-label") : null;
      if (fullscreenLabel) fullscreenLabel.textContent = fullscreenText;
      else desktopFullscreenButton.textContent = fullscreenText;
      desktopFullscreenButton.title = fullscreenText;
      desktopFullscreenButton.setAttribute("aria-pressed", active ? "true" : "false");
    }
    function toggleDesktopFullscreen() {
      if (!desktopWatch || disposed) return;
      var action = playerFullscreen()
        ? doc.exitFullscreen || doc.webkitExitFullscreen
        : playerShell.requestFullscreen || playerShell.webkitRequestFullscreen;
      if (!action) {
        get("command-status").textContent = "Fullscreen is unavailable in this browser.";
        return;
      }
      try {
        var target = playerFullscreen() ? doc : playerShell;
        var result = action.call(target);
        Promise.resolve(result).then(function () {
          if (!disposed) { syncDesktopFullscreen();
            get("command-status").textContent = playerFullscreen() ? "Fullscreen active." : "Fullscreen exited.";
          }
        }, function () {
          if (!disposed) get("command-status").textContent = "Fullscreen request was blocked by the browser.";
        });
      } catch (_error) {
        get("command-status").textContent = "Fullscreen request was blocked by the browser.";
      }
    }
    function clearIdle() {
      if (idleTimer !== null) { clock.clearTimeout(idleTimer); idleTimer = null; }
    }
    function resetIdle() {
      clearIdle();
      if (state === STATES.CONTROLS_VISIBLE && !disposed && !activeBatch
          && !(provider === providers.VIDBOLT && boltSession
            && (boltSession.paused === true || boltSession.pauseIntent || boltSession.endedAt !== null))) {
        idleTimer = clock.setTimeout(function () {
          idleTimer = null;
          if (state === STATES.CONTROLS_VISIBLE) hideControls();
        }, IDLE_MS);
      }
    }
    function setOverlayVisible(visible) {
      if (visible) overlay.classList.add("is-visible");
      else overlay.classList.remove("is-visible");
      if (visible) playerShell.classList.add("controls-open");
      else playerShell.classList.remove("controls-open");
      overlay.setAttribute("aria-hidden", visible ? "false" : "true");
      controls.forEach(function (button, index) {
        if (button) button.tabIndex = visible && !button.hidden
          && (index < 12 || usesExperimentalRow() || index === 20 && route.fromSearch
            || index === 21 && desktopWatch) ? 0 : -1;
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
          && (id === "rewind" || id === "forward")) {
        get("command-status").textContent = seekHint(id);
        get("command-status").classList.add("is-seek-help");
      } else get("command-status").classList.remove("is-seek-help");
      if (state === STATES.CONTROLS_VISIBLE) renderSeekPreview(id);
    }
    function showControls() {
      if (disposed || state !== STATES.PLAYBACK_HIDDEN) return;
      state = STATES.CONTROLS_VISIBLE;
      renderTimeline();
      selected = usesExperimentalRow() ? 12 : 1;
      setOverlayVisible(true);
      focusControl(selected);
      markPause("overlayAt");
      get("command-status").classList.remove("is-seek-help");
      get("command-status").textContent = provider === providers.VIDBOLT ? "" : isCommandProvider()
        ? "Experimental commands use the provider iframe; TV effect remains unverified."
        : adapter && typeof adapter.send === "function"
        ? "Preparing secure player connection…"
        : "Playback commands unavailable until the secure Pico bridge is connected.";
      if (!isCommandProvider() && adapter && typeof adapter.open === "function") {
        var connectionTimer = clock.setTimeout(function () {
          if (!disposed && state === STATES.CONTROLS_VISIBLE
              && get("command-status").textContent === "Preparing secure player connection…") {
            get("command-status").textContent = "Player Bridge is unavailable. YapGrid controls cannot be confirmed; use VidBolt or retry later.";
            resetIdle();
          }
        }, 5000);
        adapter.open().then(function () {
          clock.clearTimeout(connectionTimer);
          if (!disposed && state === STATES.CONTROLS_VISIBLE
              && get("command-status").textContent === "Preparing secure player connection…") {
            get("command-status").textContent = "Player connection ready; playback effect remains unverified.";
          }
        }, function (error) {
          clock.clearTimeout(connectionTimer);
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
    function hideControls(force) {
      if (disposed || state !== STATES.CONTROLS_VISIBLE) return;
      if (!force && provider === providers.VIDBOLT && boltSession
          && (boltSession.paused === true || boltSession.pauseIntent || boltSession.endedAt !== null)) return;
      clearIdle();
      if (upNextTarget && provider === providers.VIDBOLT && boltSeekPending) {
        resetIdle();
        return;
      }
      var restoreUpNextFocus = !!upNextTarget;
      episodeLookup += 1;
      episodeLookupPending = false;
      pendingEpisode = null;
      resetSeekSelection();
      state = STATES.PLAYBACK_HIDDEN;
      setOverlayVisible(false);
      overlay.classList.remove("is-quick-pause");
      get("command-status").textContent = "";
      get("command-status").classList.remove("is-seek-help");
      get("seek-preview").hidden = true;
      if (adapter && typeof adapter.close === "function") adapter.close();
      if (restoreUpNextFocus) {
        if (doc.activeElement !== upNextButtons[0]) focus(upNextButtons[0]);
      } else focus(capture);
      get("screen-reader-status").textContent = "Controls hidden. Press an arrow or OK to show controls. Back exits to "
        + (route.fromSearch ? "Watch." : "Video Lab.");
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
      focusControl(provider === providers.VIDBOLT ? 10 : 9);
      get("command-status").textContent = provider === providers.VIDBOLT
        ? "Native input trial ended. Diagnostics is focused; Stop / Unload remains there. CC access is unverified."
        : "Native input trial ended. Stop / Unload is focused; playback remains unverified.";
    }
    function startNativeFocus() {
      var fromVidLinkDiagnostics = provider === providers.VIDLINK
        && vidLinkMode !== "jwOn" && state === STATES.DIAGNOSTICS_OPEN;
      var fromVidRiftControls = provider === providers.VIDRIFT && state === STATES.CONTROLS_VISIBLE;
      var fromVidBoltDiagnostics = provider === providers.VIDBOLT && state === STATES.DIAGNOSTICS_OPEN;
      if ((!fromVidLinkDiagnostics && !fromVidRiftControls && !fromVidBoltDiagnostics)
          || route.invalid || desktopWatch && fromVidBoltDiagnostics) return;
      if (!frameLoaded || frame.src === "about:blank") {
        get(fromVidLinkDiagnostics ? "vidlink-compat-status"
          : fromVidBoltDiagnostics ? "vidbolt-compat-status" : "command-status").textContent =
          "Wait for iframe load before trying native input.";
        return;
      }
      if (fromVidLinkDiagnostics || fromVidBoltDiagnostics) closeDiagnostics();
      hideControls(true);
      state = STATES.NATIVE_FOCUS;
      focusAttempts = Math.min(999, focusAttempts + 1);
      parentKeysDuringFocus = 0;
      frame.tabIndex = 0;
      get("player-shell").classList.add("native-focus-trial");
      var trialSeconds = fromVidBoltDiagnostics ? 30 : 12;
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
        + " seconds. Horizon will restore its controls automatically.";
    }
    function navigate(key) {
      if ((provider === providers.YAPGRID || provider === providers.VIDBOLT)
          && navigateSharedControls(key)) return;
      if (desktopWatch && selected === 21) {
        if (key === "ArrowLeft" || key === "ArrowUp") focusControl(11);
        else if (key === "ArrowRight" || key === "ArrowDown") focusControl(20);
        return;
      }
      if (desktopWatch && selected === 20) {
        if (key === "ArrowLeft") focusControl(desktopFullscreenButton.disabled ? 11 : 21);
        else if (key === "ArrowUp") focusControl(11);
        return;
      }
      if (desktopWatch && selected === 11 && (key === "ArrowRight" || key === "ArrowDown")) {
        focusControl(desktopFullscreenButton.disabled ? 20 : 21); return;
      }
      if (route.fromSearch && selected === 20) {
        if (key === "ArrowLeft" || key === "ArrowUp") focusControl(11);
        return;
      }
      if (route.fromSearch && selected === 11 && (key === "ArrowRight" || key === "ArrowDown")) {
        focusControl(20); return;
      }
      if (usesExperimentalRow()) {
        if (selected >= 12) {
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
            else if (selected === 8) focusControl(!get("unload-provider").hidden ? 9 : 10);
            else if (selected === 9) focusControl(10);
            else if (selected === 10 && !get("recover-provider").hidden) focusControl(11);
          } else {
            if (selected === 11) focusControl(10);
            else if (selected === 10) focusControl(!get("unload-provider").hidden ? 9 : 8);
            else if (selected === 9) focusControl(8);
            else if (selected === 8) focusControl(1);
            else if (selected !== 1) focusControl(1);
          }
          return;
        }
        if (key === "ArrowLeft") {
          if (selected === 1 || selected === 2) focusControl(selected - 1);
          else if (selected === 11) focusControl(10);
          else if (selected === 10) focusControl(!get("unload-provider").hidden ? 9 : 8);
          else if (selected === 9) focusControl(8);
          return;
        }
        if (key === "ArrowRight") {
          if (selected === 0 || selected === 1) focusControl(selected + 1);
          else if (selected === 8) focusControl(!get("unload-provider").hidden ? 9 : 10);
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
        else if (selected === 10) next = !get("unload-provider").hidden ? 9 : 8;
      } else if (key === "ArrowRight") {
        if (selected === 0 || selected === 1 || (selected >= 3 && selected <= 5)) next += 1;
        else if (selected === 8) next = !get("unload-provider").hidden ? 9 : 10;
        else if (selected === 9) next = 10;
        else if (selected === 10 && !get("recover-provider").hidden) next = 11;
      } else if (key === "ArrowDown") {
        if (selected <= 2) next = [3, 4, 6][selected];
        else if (selected >= 3 && selected <= 6) next = manualEndEnabled ? 7 : 8;
        else if (selected === 7) next = 8;
        else if (selected === 8) next = !get("unload-provider").hidden ? 9 : 10;
        else if (selected === 9) next = 10;
        else if (selected === 10 && !get("recover-provider").hidden) next = 11;
      } else if (key === "ArrowUp") {
        if (selected === 0 || selected === 2) next = 1;
        else if (selected >= 3 && selected <= 6) next = selected === 3 ? 0 : selected === 6 ? 2 : 1;
        else if (selected === 7) next = 5;
        else if (selected === 8) next = manualEndEnabled ? 7 : 1;
        else if (selected === 9) next = 8;
        else if (selected === 11) next = 10;
        else if (selected === 10) next = !get("unload-provider").hidden ? 9 : 8;
      }
      if (next !== selected) focusControl(next);
    }
    function navigateSharedControls(key) {
      if (upNextTarget && !leavingUpNextFocus && key === "ArrowDown" && selected >= 3) {
        focus(upNextButtons[0]);
        return true;
      }
      var rows = [[0, 1, 2], [3, 5, 6, 8, 11, 7, 9, 4, 10, 21, 20]]
        .map(function (row) { return row.filter(function (index) {
          return controls[index] && !controls[index].hidden && !controls[index].disabled;
        }); }).filter(function (row) { return row.length; });
      var rowIndex = rows.findIndex(function (row) { return row.indexOf(selected) !== -1; });
      if (rowIndex < 0) { focusControl(1); return true; }
      var row = rows[rowIndex];
      var column = row.indexOf(selected);
      if (upNextTarget && !leavingUpNextFocus && rowIndex === 1
          && (key === "ArrowDown" || key === "ArrowRight" && column === row.length - 1)) {
        focus(upNextButtons[0]);
        return true;
      }
      if (key === "ArrowLeft" || key === "ArrowRight") {
        var nextColumn = column + (key === "ArrowRight" ? 1 : -1);
        if (nextColumn >= 0 && nextColumn < row.length) focusControl(row[nextColumn]);
      } else if (key === "ArrowUp" || key === "ArrowDown") {
        var nextRow = rows[rowIndex + (key === "ArrowDown" ? 1 : -1)];
        if (nextRow) {
          var target = Math.round(column * (nextRow.length - 1) / Math.max(1, row.length - 1));
          if (rowIndex === 0 && key === "ArrowDown" && !isMovie) {
            var preferred = [3, 5, 6][column];
            if (nextRow.indexOf(preferred) !== -1) target = nextRow.indexOf(preferred);
          }
          if (rowIndex === 0 && key === "ArrowDown" && isMovie) {
            var moviePreferred = [8, 11, 21][column];
            if (nextRow.indexOf(moviePreferred) !== -1) target = nextRow.indexOf(moviePreferred);
          }
          focusControl(nextRow[target]);
        }
      }
      return true;
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
      var reloadUrl = appendHandoff(catalog.pageUrl(currentEpisode, subtitleMode === "on" ? "off" : "on",
        manualEndEnabled, null, route.fromSearch, route.showTitle, route.tvdbId, provider));
      transitionTo(reloadUrl && route.episodeTrail
        ? reloadUrl + "&episodeTrail=" + encodeURIComponent(route.episodeTrail) : reloadUrl);
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
      var hadFocus = doc.activeElement === upNextButtons[0];
      upNextLookup += 1;
      upNextLookupPending = false;
      upNextTarget = null;
      get("up-next").hidden = true;
      upNextButtons.forEach(function (button) { button.tabIndex = -1; });
      if (hadFocus) {
        if (state === STATES.CONTROLS_VISIBLE) focusControl(1);
        else if (state === STATES.PLAYBACK_HIDDEN) focus(capture);
      }
    }
    function transitionTo(url) {
      if (disposed || transitionStarted || !url) return;
      transitionStarted = true;
      dispose();
      nav.replace(url);
    }
    function episodeListUrl() {
      if (route.fromSearch && !isMovie && !route.invalid) {
        return watchReturnUrl(true);
      }
      return catalog.pageUrl(currentEpisode, subtitleMode, manualEndEnabled, "list", route.fromSearch, route.showTitle, route.tvdbId, provider);
    }
    function watchReturnUrl(episodes) {
      var query = isMovie ? "?return=1&type=movie&id=" + currentEpisode.movieId
        : "?return=1" + (episodes ? "&episodes=1" : "") + "&showId=" + currentEpisode.showId
          + "&season=" + currentEpisode.season + "&episode=" + currentEpisode.episode + "&sub=" + subtitleMode;
      if (!isMovie && currentEpisode.title) query += "&episodeTitle=" + encodeURIComponent(String(currentEpisode.title).slice(0, 160));
      if (!isMovie && route.showTitle) query += "&showTitle=" + encodeURIComponent(String(route.showTitle).slice(0, 120));
      if (!isMovie && route.episodeTrail) query += "&episodeTrail=" + encodeURIComponent(route.episodeTrail);
      if (route.handoff) query += "&handoff=" + encodeURIComponent(route.handoff);
      var confirmed = confirmedProgressRecord();
      var prior = readPlayerProgress(boltIdentity());
      var flushed = confirmed && boltSession && boltSession.advancedAt !== null
        ? storePlayerProgress(confirmed.position, confirmed.duration,
          confirmed.completed || !!(prior && prior.completed), true) : null;
      var saved = flushed || readPlayerProgress(boltIdentity()) || confirmed;
      if (saved && saved.provider === "vidbolt") query += "&position=" + encodeURIComponent(saved.position)
        + "&duration=" + encodeURIComponent(saved.duration) + "&updated=" + encodeURIComponent(saved.updatedAt)
        + "&progressProvider=vidbolt" + (saved.completed ? "&completed=1" : "");
      if (!isMovie && route.handoff && playerProgressStorage) {
        try { var store = JSON.parse(playerProgressStorage.getItem(PLAYER_PROGRESS_KEY) || "null");
          var prefix = "tv:" + currentEpisode.showId + ":";
          var batch = store && store.version === 1 && Array.isArray(store.items) ? store.items
            .filter(function (entry) { return entry && typeof entry.identity === "string"
              && entry.identity.indexOf(prefix) === 0 && entry.provider === "vidbolt"
              && route.handoffAt > 0 && entry.updatedAt >= route.handoffAt; })
            .slice(0, 16).map(function (entry) { var parts = entry.identity.slice(prefix.length).split(":");
              return { season: Number(parts[0]), episode: Number(parts[1]), progress: {
                position: entry.position, duration: entry.duration, updatedAt: entry.updatedAt,
                provider: entry.provider, completed: entry.completed === true } }; }) : [];
          if (batch && batch.length) query += "&progressBatch=" + encodeURIComponent(JSON.stringify(batch));
        } catch (_error) {}
      }
      return "https://horizon-universal-search-preview.ali-al-anbari.workers.dev/" + query;
    }
    function launchEpisode(target) {
      var trail = (route.episodeTrail ? route.episodeTrail + "," : "")
        + currentEpisode.season + ":" + currentEpisode.episode;
      var trailItems = trail.split(",");
      if (trailItems.length > 16) trail = [trailItems[0]].concat(trailItems.slice(-15)).join(",");
      var url = appendHandoff(catalog.pageUrl(target, subtitleMode, manualEndEnabled, null,
        route.fromSearch, route.showTitle, route.tvdbId, provider));
      transitionTo(url ? url + "&episodeTrail=" + encodeURIComponent(trail) : null);
    }
    function appendHandoff(url) {
      return url && route.handoff ? url + (url.indexOf("?") >= 0 ? "&" : "?")
        + "handoff=" + encodeURIComponent(route.handoff)
        + (route.handoffAt ? "&handoffAt=" + encodeURIComponent(route.handoffAt) : "") : url;
    }
    function exitPlayer() {
      if (!route.fromSearch) { dispose(); nav.replace("embed-matrix.html"); return; }
      var url = isMovie && route.invalid ? "https://horizon-universal-search-preview.ali-al-anbari.workers.dev/"
        : watchReturnUrl(false);
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
    function startUpNext() {
      if (isMovie || disposed || transitionStarted || upNextLookupPending || upNextDismissed || upNextTarget) return;
      upNextLookupPending = true;
      var lookup = ++upNextLookup;
      var generation = boltSession && boltSession.generation;
      var identity = boltSession && boltSession.identity;
      Promise.resolve().then(function () { return resolver.resolve(currentEpisode, 1); }).then(function (result) {
        if (lookup !== upNextLookup) return;
        upNextLookupPending = false;
        if (disposed || provider !== providers.VIDBOLT || isMovie || !boltSession
            || boltSession.generation !== generation || boltSession.identity !== identity) return;
        if (!result || result.kind !== "catalogued") return;
        beginUpNext(result.target);
      }, function () { if (lookup === upNextLookup) upNextLookupPending = false; });
    }
    function beginUpNext(next) {
      if (upNextTarget || upNextDismissed || !next
          || typeof next.season !== "number" || !isFinite(next.season) || next.season < 0
          || Math.floor(next.season) !== next.season
          || typeof next.episode !== "number" || !isFinite(next.episode) || next.episode < 1
          || Math.floor(next.episode) !== next.episode) return;
      var activeSeekInteraction = state === STATES.CONTROLS_VISIBLE
        && (selected === 0 || selected === 2 || boltSeekPending || !get("seek-preview").hidden);
      upNextTarget = next;
      get("up-next-identity").textContent = "S" + next.season + " E" + next.episode;
      get("up-next-name").textContent = next.title || "";
      get("up-next-separator").hidden = !next.title;
      var actionName = "Play next episode, Season " + next.season + ", Episode " + next.episode
        + (next.title ? ": " + next.title : "");
      upNextButtons[0].setAttribute("aria-label", actionName);
      upNextButtons[0].title = actionName;
      get("up-next").hidden = false;
      upNextButtons[0].tabIndex = 0;
      get("screen-reader-status").textContent = "Next episode available. Press OK to Play Next, or Back to return to the current player.";
      var safeToFocus = state !== STATES.SUBMENU_OPEN && state !== STATES.DIAGNOSTICS_OPEN
        && state !== STATES.COMMAND_IN_PROGRESS && state !== STATES.NATIVE_FOCUS && !activeSeekInteraction;
      if (safeToFocus) focus(upNextButtons[0]);
      renderUpNextTitleOverflow();
    }
    function chooseUpNext() {
      if (!upNextTarget || transitionStarted) return;
      launchEpisode(upNextTarget);
    }
    function dismissUpNext() {
      if (!upNextTarget) return;
      var hadFocus = doc.activeElement === upNextButtons[0];
      upNextDismissed = true;
      upNextTarget = null;
      get("up-next").hidden = true;
      upNextButtons[0].tabIndex = -1;
      if (hadFocus) {
        if (state === STATES.CONTROLS_VISIBLE) focusControl(1);
        else if (state === STATES.PLAYBACK_HIDDEN) focus(capture);
      }
      if (state === STATES.CONTROLS_VISIBLE) resetIdle();
    }
    function renderUpNextTitleOverflow() {
      if (!upNextTarget) return;
      var viewport = get("up-next-name-viewport");
      var title = get("up-next-name");
      var overflow = Number(title.scrollWidth) - Number(viewport.clientWidth);
      if (isFinite(overflow) && overflow > 8) {
        viewport.classList.add("is-overflowing");
        if (viewport.style && typeof viewport.style.setProperty === "function")
          viewport.style.setProperty("--up-next-overflow", "-" + Math.ceil(overflow) + "px");
      } else {
        viewport.classList.remove("is-overflowing");
        if (viewport.style && typeof viewport.style.removeProperty === "function")
          viewport.style.removeProperty("--up-next-overflow");
      }
    }
    function boltClock(seconds) {
      var whole = Math.max(0, Math.floor(seconds));
      return Math.floor(whole / 60) + ":" + (whole % 60 < 10 ? "0" : "") + whole % 60;
    }
    function renderTimeline() {
      var timeline = get("playback-timeline");
      var usable = provider === providers.VIDBOLT && boltSession
        && boltSession.identity === boltIdentity() && frame.src !== "about:blank"
        && boltPosition !== null && isFinite(boltPosition) && boltPosition >= 0
        && boltDuration !== null && isFinite(boltDuration) && boltDuration > 0
        && boltPosition <= boltDuration + 2
        && (boltSession.paused === true || now() - boltPositionAt <= 15000);
      timeline.hidden = !usable;
      var fillEl = get("timeline-fill");
      var playheadEl = get("timeline-playhead");
      if (!usable) {
        if (fillEl) {
          if (fillEl.style) fillEl.style.width = "0%";
          fillEl.setAttribute("style", "width:0%");
        }
        if (playheadEl) {
          if (playheadEl.style) playheadEl.style.left = "0%";
          playheadEl.setAttribute("style", "left:0%");
        }
        return;
      }
      get("timeline-current").textContent = boltClock(boltPosition);
      get("timeline-duration").textContent = boltClock(boltDuration);
      var progress = Math.max(0, Math.min(100, boltPosition / boltDuration * 100));
      var widthPct = progress.toFixed(2) + "%";
      var width = "width:" + widthPct;
      var left = "left:" + widthPct;
      if (fillEl) {
        if (fillEl.style) fillEl.style.width = widthPct;
        if (fillEl.getAttribute("style") !== width)
          fillEl.setAttribute("style", width);
      }
      if (playheadEl) {
        if (playheadEl.style) playheadEl.style.left = widthPct;
        if (playheadEl.getAttribute("style") !== left)
          playheadEl.setAttribute("style", left);
      }
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
      if (!usesExperimentalRow() || !frameLoaded || frame.src === "about:blank") {
        get("command-status").textContent = "Wait for the experimental iframe to load; no command sent.";
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
      get("command-status").classList.remove("is-seek-help");
      if (id.indexOf("experiment-") === 0) { activateExperimental(id); return; }
      if (usesExperimentalRow() && selected <= 2) return;
      if (provider === providers.VIDBOLT && selected <= 2) {
        if (selected === 1) {
          if (frameLoaded && (route.fromSearch || providerReady || providerPlaying
              || boltSession && boltSession.paused === true))
            toggleBoltPlayPause();
          else get("command-status").textContent = "Wait for VidBolt ready; no command sent.";
        } else sendBoltSeek((selected === 2 ? 1 : -1) * 10
          * SEEK_COUNTS[seekLevels[selected === 2 ? "forward" : "rewind"]]);
        return;
      }
      if (id === "diagnostics-open") { openDiagnostics(); return; }
      if (id === "provider-choice") { switchProvider(); return; }
      if (id === "unload-provider") { stopAndUnloadProvider(); return; }
      if (id === "recover-provider") {
        if (provider === providers.YAPGRID) reloadYapGrid();
        else if (provider === providers.VIDBOLT) recoverBolt("manual");
        return;
      }
      if (id === "watch-exit" && route.fromSearch) { exitPlayer(); return; }
      if (id === "watch-fullscreen" && desktopWatch) { toggleDesktopFullscreen(); return; }
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
      if (disposed || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (desktopWatch && event.key === "Escape"
          && (playerFullscreen() || now() - fullscreenExitAt < 500)) {
        event.preventDefault();
        if (playerFullscreen()) toggleDesktopFullscreen();
        return;
      }
      var key = keyName(event);
      if (route.fromSearch && provider === providers.VIDBOLT && event.key === " "
          && state === STATES.PLAYBACK_HIDDEN) {
        event.preventDefault(); showControls(); activateControl(); return;
      }
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
      if (upNextTarget && doc.activeElement === upNextButtons[0]) {
        if (key === "OK") {
          if (!event.repeat) chooseUpNext();
          return;
        }
        if (key === "Back") { if (!event.repeat) dismissUpNext(); return; }
        if (key.indexOf("Arrow") === 0) {
          if (state === STATES.PLAYBACK_HIDDEN) showControls();
          if (state === STATES.CONTROLS_VISIBLE) {
            focusControl(selected);
            leavingUpNextFocus = true;
            navigate(key);
            leavingUpNextFocus = false;
            resetIdle();
          }
          return;
        }
      }
      if (upNextTarget && key === "Back" && state !== STATES.SUBMENU_OPEN
          && state !== STATES.DIAGNOSTICS_OPEN && !event.repeat) {
        dismissUpNext();
        return;
      }
      if (state === STATES.PLAYBACK_HIDDEN) {
        if (key === "Back") { if (!event.repeat) exitPlayer(); }
        else if (key === "OK" && !event.repeat && (!isCommandProvider() || provider === providers.VIDBOLT)) {
          if (provider !== providers.VIDBOLT) pauseTrace = { inputAt: now(), hidden: true };
          overlay.classList.add("is-quick-pause");
          showControls();
          if (provider === providers.VIDBOLT) activateControl();
          else requestCommand("play-pause");
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
        else if (provider === providers.VIDBOLT && key === "ArrowRight" && diagnosticSelected >= 11)
          focusDiagnostic(diagnosticSelected === (desktopWatch ? 13 : 14) ? 11 : diagnosticSelected + 1);
        else if (provider === providers.VIDBOLT && key === "ArrowLeft" && diagnosticSelected >= 11)
          focusDiagnostic(diagnosticSelected === 11 ? (desktopWatch ? 13 : 14) : diagnosticSelected - 1);
        else if (provider === providers.VIDBOLT && key === "ArrowDown" && diagnosticSelected === 0)
          focusDiagnostic(11);
        return;
      }
      resetIdle();
      if (key === "Back") { if (!event.repeat) {
        if (activeBatch) cancelActiveBatch();
        else if (desktopWatch) exitPlayer();
        else hideControls(true);
      } }
      else if (key === "OK") { if (!event.repeat) activateControl(); }
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
      if (typeof clock.removeEventListener === "function") clock.removeEventListener("resize", renderUpNextTitleOverflow);
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
      if (provider === providers.VIDBOLT && diagnosticSelected === 14 && !desktopWatch) {
        startNativeFocus();
        return;
      }
      if (provider === providers.VIDBOLT && diagnosticSelected === 13) {
        closeDiagnostics();
        stopAndUnloadProvider();
        return;
      }
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
      get("vidbolt-native-focus").hidden = desktopWatch || provider !== providers.VIDBOLT;
      get("vidlink-focus-default").hidden = provider !== providers.VIDLINK || vidLinkMode === "jwOn";
      overlay.classList.add("is-diagnostics");
      controls.forEach(function (button) { button.tabIndex = -1; });
      diagnosticButtons.forEach(function (button, index) {
        button.tabIndex = index === 0 || (provider === providers.CINESRC && index < 5)
          || (provider === providers.VIDFAST && index >= 5 && index <= 6)
          || (provider === providers.VIDLINK && index >= 7
            && index <= 10 && (index < 10 || vidLinkMode !== "jwOn"))
          || (provider === providers.VIDBOLT && index >= 11 && index <= (desktopWatch ? 13 : 14)) ? 0 : -1;
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
      if (provider === providers.VIDBOLT) {
        var unloadedProgress = confirmedProgressRecord();
        if (unloadedProgress) storePlayerProgress(unloadedProgress.position, unloadedProgress.duration,
          unloadedProgress.completed, true);
      }
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
      get("playback-timeline").hidden = true;
      renderTimeline();
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
          : compatibilityMode, null);
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
        var restoreForSession = null;
        if (boltRestoreRequest && boltRestoreRequest.identity === boltIdentity()) {
          restoreForSession = boltRestoreRequest;
          boltRestoreRequest = null;
        } else if (!recovering && !initialRestoreConsumed && initialRestoreTarget !== null) {
          restoreForSession = { identity: boltIdentity(), target: initialRestoreTarget, kind: "resume" };
          initialRestoreConsumed = true;
          initialRestoreTarget = null;
        }
        boltSession = { generation: ++boltGeneration, identity: boltIdentity(), createdAt: now(),
          loadedAt: null, latestLoadAt: null, loadCount: 0, parentUrlAssignments: 1,
          frameErrorAt: null, readyAt: null, playAt: null, pauseAt: null,
          mobilePanelCount: 0, mobilePanelAt: null, subtitleOptionCount: 0,
          englishOptionCount: 0, offOptionCount: 0,
          firstTimeupdateAt: null,
          position: null, positionAt: null, progressReference: null, advancedAt: null,
          duration: null, endedAt: null,
          paused: null, pauseIntent: false, controlPending: null, controlLastSentAt: null,
          healthy: false, suspected: null, suspectedDetail: null, watchdogCheckedAt: null,
          suspectedAt: null, seekUntil: 0, seekTarget: null,
          seekUnconfirmed: false,
          monitorSince: now(),
          autoplayRequested: vidBoltAutoplay, volumeSentAt: null, volumeAttempts: 0,
          restoreTarget: restoreForSession ? restoreForSession.target : null,
          restoreKind: restoreForSession ? restoreForSession.kind : null,
          restoreBaseline: restoreForSession && restoreForSession.kind === "resume" ? selectedProgress : null,
          restoreAttempted: false, restoreSent: false, restoreSentAt: null,
          restoreResult: restoreForSession ? "waiting for ready" : "none" };
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
          var wasPlaying = boltSession && boltSession.paused === false;
          var firstPlay = boltSession && boltSession.playAt === null;
          recordBoltEvent(message);
          if (message.type === "vidbolt:play" && (firstPlay || !wasPlaying)) {
            if (state === STATES.PLAYBACK_HIDDEN) showControls();
            else if (state === STATES.CONTROLS_VISIBLE) resetIdle();
          } else if (message.type === "vidbolt:pause" || message.type === "vidbolt:ended") {
            if (state === STATES.PLAYBACK_HIDDEN) showControls();
            else if (state === STATES.CONTROLS_VISIBLE) resetIdle();
          }
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
            if (message.duration !== null && message.duration !== undefined
                && isFinite(message.duration) && message.duration > 0) {
              boltDuration = message.duration;
            }
            renderTimeline();
            if (state === STATES.CONTROLS_VISIBLE && (selected === 0 || selected === 2))
              renderSeekPreview(CONTROL_IDS[selected]);
            if (boltSeekPending && boltSession && boltSession.seekTarget === null) {
              boltSeekPending = false;
            }
          }
          telemetry.textContent = providerLabel() + " reports " + Math.floor(message.currentTime)
            + "s" + (message.duration !== null && message.duration !== undefined
              ? " / " + Math.floor(message.duration) + "s" : "") + "; check picture and sound on TV.";
          if (provider === providers.VIDBOLT) telemetry.classList.remove("is-visible");
          else telemetry.classList.add("is-visible");
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
          renderTimeline();
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
      hideControls(true);
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
      boltRecoveryFromLoads = null;
      boltRecoveryDecision = "no explicit failure signal";
      boltLastConfirmed = null;
      clearUpNext();
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
      if (desktopWatch) showControls();
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
          : transitionStarted || episodeLookupPending || pendingEpisode
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
    get("subtitle-mode").textContent = provider === providers.VIDBOLT ? "NATIVE" : subtitleMode.toUpperCase();
    controls.forEach(function (button, index) {
      if (!button) return;
      button.addEventListener("focus", function () {
        if (state !== STATES.CONTROLS_VISIBLE || button.hidden) return;
        selected = index;
        renderSeekPreview(CONTROL_IDS[index]);
        resetIdle();
      });
      button.addEventListener("click", function () {
        if (disposed || state !== STATES.CONTROLS_VISIBLE) return;
        if (button.hidden || (index >= 12 && !usesExperimentalRow() && index !== 20
            && !(index === 21 && desktopWatch))) return;
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
            || (index >= 11 && provider !== providers.VIDBOLT)
            || (index === 14 && desktopWatch)) return;
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
        if (index === 0) chooseUpNext();
      });
    });
    doc.addEventListener("keydown", onKey);
    if (desktopWatch) {
      doc.addEventListener("fullscreenchange", syncDesktopFullscreen);
      doc.addEventListener("webkitfullscreenchange", syncDesktopFullscreen);
      desktopFullscreenButton.disabled = doc.fullscreenEnabled === false
        || !playerShell.requestFullscreen && !playerShell.webkitRequestFullscreen;
      if (desktopFullscreenButton.disabled)
        desktopFullscreenButton.title = "Fullscreen is unavailable in this browser";
      syncDesktopFullscreen();
    }
    playerShell.addEventListener("click", function (event) {
      if (route.fromSearch && state === STATES.PLAYBACK_HIDDEN
          && event.target === playerShell) showControls();
    });
    playerShell.addEventListener("pointermove", function () {
      if (route.fromSearch && state === STATES.PLAYBACK_HIDDEN) showControls();
    });
    overlay.addEventListener("pointermove", function () {
      if (route.fromSearch && state === STATES.CONTROLS_VISIBLE) resetIdle();
    });
    clock.addEventListener("resize", renderUpNextTitleOverflow);
    clock.addEventListener("pagehide", dispose);
    setOverlayVisible(false);
    renderSeekLabels();
    if (desktopWatch) showControls();
    else focus(capture);
    if (route.fromSearch) get("screen-reader-status").textContent = desktopWatch
      ? "Horizon controls visible. Back exits to Watch; Fullscreen stays in the control row."
      : "Video playing. Press an arrow, OK, or click to show controls. Back exits to Watch.";
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
