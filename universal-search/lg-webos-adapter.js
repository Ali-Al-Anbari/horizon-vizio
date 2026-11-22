(function (root) {
  "use strict";

  var MEDIA_KEY_MAP = {
    415: "MediaPlay",
    19: "MediaPause",
    413: "MediaStop",
    412: "MediaRewind",
    417: "MediaFastForward",
    10252: "MediaPlayPause"
  };

  function normalizeLGKey(event) {
    if (!event) return "Unknown";
    var key = event.key;
    var code = event.keyCode || event.which || 0;
    if (code === 461 || key === "GoBack" || key === "BrowserBack" || key === "Escape" || key === "Back") return "Back";
    if (key === "Backspace" || code === 8 || code === 27 || code === 4) return "Back";
    if (key === "Enter" || key === "Select" || key === "OK" || key === "NumpadEnter" || code === 13) return "OK";
    if (key === "ArrowLeft" || key === "ArrowUp" || key === "ArrowRight" || key === "ArrowDown") return key;
    if (code >= 37 && code <= 40) return ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"][code - 37];
    if (MEDIA_KEY_MAP[code]) return MEDIA_KEY_MAP[code];
    return key || "Unknown";
  }

  function detectWebOSRuntime() {
    var ua = (root.navigator && root.navigator.userAgent) ? root.navigator.userAgent : "";
    return !!(root.webOS || root.PalmSystem || root.PalmServiceBridge || /Web0S|webOS|NetCast/i.test(ua));
  }

  function callLuna(service, method, parameters) {
    var uri = "luna://" + service + "/" + method;
    var payload = parameters || {};
    return new Promise(function (resolve) {
      try {
        if (root.webOS && root.webOS.service && typeof root.webOS.service.request === "function") {
          root.webOS.service.request("luna://" + service, {
            method: method,
            parameters: payload,
            onSuccess: function (res) { resolve({ ok: true, simulated: false, uri: uri, parameters: payload, response: res || {} }); },
            onFailure: function (err) { resolve({ ok: false, simulated: false, uri: uri, parameters: payload, error: (err && (err.errorText || err.message)) || "Luna error" }); }
          });
          return;
        }
        if (typeof root.PalmServiceBridge === "function") {
          var bridge = new root.PalmServiceBridge();
          bridge.onservicecallback = function (raw) {
            var parsed = {};
            try { parsed = JSON.parse(raw || "{}"); } catch (_e) {}
            var ok = parsed.returnValue !== false;
            resolve({ ok: ok, simulated: false, uri: uri, parameters: payload, response: parsed, error: ok ? "" : (parsed.errorText || "PalmServiceBridge failed") });
          };
          bridge.call(uri, JSON.stringify(payload));
          return;
        }
      } catch (err) {
        resolve({ ok: false, simulated: false, uri: uri, parameters: payload, error: err && err.message ? err.message : String(err) });
        return;
      }
      resolve({ ok: true, simulated: true, uri: uri, parameters: payload });
    });
  }

  function launchLGApp(appId, params) {
    var p = { id: String(appId || "") };
    if (params && typeof params === "object") p.params = params;
    return callLuna("com.webos.applicationManager", "launch", p);
  }

  function formatTime(totalSeconds) {
    var whole = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    return Math.floor(whole / 60) + ":" + (whole % 60 < 10 ? "0" : "") + (whole % 60);
  }

  var ytApiPromise = null;
  function loadYouTubeApi(doc) {
    if (root.YT && root.YT.Player) return Promise.resolve(root.YT);
    if (ytApiPromise) return ytApiPromise;
    ytApiPromise = new Promise(function (resolve, reject) {
      var prev = root.onYouTubeIframeAPIReady;
      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) { settled = true; reject(new Error("YouTube IFrame API timed out")); }
      }, 8000);
      root.onYouTubeIframeAPIReady = function () {
        if (typeof prev === "function") { try { prev(); } catch (_e) {} }
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          if (root.YT && root.YT.Player) resolve(root.YT);
          else reject(new Error("YT.Player missing"));
        }
      };
      var script = doc.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.onerror = function () {
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error("Failed to load YouTube IFrame API")); }
      };
      (doc.head || doc.body || doc.documentElement).appendChild(script);
    });
    return ytApiPromise;
  }

  var hlsLibPromise = null;
  function loadHlsLibrary(doc) {
    if (root.Hls) return Promise.resolve(root.Hls);
    if (hlsLibPromise) return hlsLibPromise;
    hlsLibPromise = new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error("HLS library load timed out")); }, 8000);
      var script = doc.createElement("script");
      script.src = "vendor/hls.light.1.5.20.min.js";
      script.async = true;
      script.onload = function () {
        clearTimeout(timer);
        if (root.Hls) resolve(root.Hls);
        else reject(new Error("window.Hls unavailable after script load"));
      };
      script.onerror = function () {
        clearTimeout(timer);
        reject(new Error("Failed to load vendor/hls.light.1.5.20.min.js"));
      };
      (doc.head || doc.body || doc.documentElement).appendChild(script);
    }).catch(function (err) {
      hlsLibPromise = null;
      throw err;
    });
    return hlsLibPromise;
  }

  function detectHlsCapability(video) {
    var nativeHls = video && video.canPlayType && (
      video.canPlayType("application/vnd.apple.mpegurl")
      || video.canPlayType("application/x-mpegURL")
    );
    var mse = root.MediaSource || root.WebKitMediaSource;
    if (mse && typeof mse.isTypeSupported === "function") {
      var codecs = [
        'video/mp4; codecs="avc1.42001e, mp4a.40.2"',
        'video/mp4; codecs="avc1.4d401e, mp4a.40.2"',
        'video/mp4; codecs="avc1.64001e, mp4a.40.2"'
      ];
      if (codecs.some(function (t) { return mse.isTypeSupported(t); })) return "mse";
    }
    return nativeHls ? "native" : "unsupported";
  }

  var isLG = !!root.__HORIZON_LG_MODE__;
  var core = root.HorizonSearchCore;
  var arabic = root.HorizonArabicCatalog;
  if (!core || !arabic) {
    root.HorizonLGWebOS = { enabled: false };
    return;
  }

  var state = {
    playerOpen: false,
    playerSession: null
  };

  var mounted = false;
  function mountLGInterface() {
    if (mounted) return;
    var doc = root.document;
    var app = root.HorizonUniversalSearch && root.HorizonUniversalSearch.app;
    if (!app || !doc.body) return;
    mounted = true;

    // Clean up any stale #arabic-toggle / #arabic-view if present from cached DOM
    var staleToggle = doc.getElementById("arabic-toggle");
    if (staleToggle && staleToggle.parentNode) staleToggle.parentNode.removeChild(staleToggle);
    var staleView = doc.getElementById("arabic-view");
    if (staleView && staleView.parentNode) staleView.parentNode.removeChild(staleView);

    // Build the Horizon-owned full-screen Video Lab overlay.
    var overlay = doc.getElementById("lg-player-overlay");
    if (!overlay) {
      overlay = doc.createElement("div");
      overlay.id = "lg-player-overlay";
      overlay.className = "lg-player-overlay player-shell";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.hidden = true;
      overlay.innerHTML =
        '<div id="lg-player-stage" class="lg-player-stage"></div>' +
        '<button id="lg-remote-capture" class="remote-capture" type="button" tabindex="0" aria-label="Horizon video remote control"></button>' +
        '<section id="lg-player-chrome" class="overlay" aria-label="Horizon playback controls" aria-hidden="true">' +
          '<div class="overlay-content">' +
            '<div class="player-heading">' +
              '<p class="brand">HORIZON VIDEO</p>' +
              '<h1 id="lg-player-title">Horizon Video</h1>' +
              '<p id="lg-player-episode" class="episode"></p>' +
              '<p id="lg-player-badge" class="provider-indicator">Roya TV</p>' +
            '</div>' +
            '<div class="player-dock">' +
              '<div id="lg-playback-timeline" class="playback-timeline" aria-label="Reported playback progress" hidden>' +
                '<span id="lg-timeline-current">0:00</span>' +
                '<div id="lg-timeline-track" class="timeline-track" tabindex="-1" role="slider" aria-label="Seek timeline" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">' +
                  '<span id="lg-player-track-fill" class="timeline-fill"></span>' +
                  '<span id="lg-timeline-playhead" class="timeline-playhead"></span>' +
                '</div>' +
                '<span id="lg-timeline-duration">0:00</span>' +
              '</div>' +
              '<p id="lg-seek-preview" class="seek-preview" aria-live="polite" hidden></p>' +
              '<div class="control-row primary" aria-label="Playback actions">' +
                '<button id="lg-player-rew" type="button" tabindex="-1" title="Rewind · Left increases jump">' +
                  '<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><path d="M11 5v14L1 12l10-7zm11 0v14L12 12l10-7z"/></svg>' +
                  '<small id="lg-rewind-label">\u221210s</small>' +
                '</button>' +
                '<button id="lg-player-playpause" class="lg-play-pause-btn" type="button" tabindex="-1" title="Play or pause" data-playback="paused">' +
                  '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
                    '<path class="play-symbol" d="M5 4v16l14-8z" fill="currentColor" stroke="none"/>' +
                    '<path class="pause-symbol" d="M7 5v14M17 5v14" stroke-width="4"/>' +
                  '</svg>' +
                  '<small id="lg-play-pause-label">Play / Pause</small>' +
                '</button>' +
                '<button id="lg-player-ff" type="button" tabindex="-1" title="Forward · Right increases jump">' +
                  '<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><path d="M2 5v14l10-7L2 5zm11 0v14l10-7-10-7z"/></svg>' +
                  '<small id="lg-forward-label">+10s</small>' +
                '</button>' +
              '</div>' +
              '<div class="action-row" aria-label="More player actions">' +
                '<div class="control-row secondary" aria-label="Episode and player actions">' +
                  '<button id="lg-player-prev" type="button" tabindex="-1" aria-label="Previous episode" title="Previous episode" disabled aria-disabled="true">' +
                    '<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>' +
                    '<span class="action-label">Previous</span>' +
                  '</button>' +
                  '<button id="lg-player-episodes" type="button" tabindex="-1" aria-label="Episode list" title="Episode list">' +
                    '<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><path d="M4 6h2v2H4V6zm5 0h11v2H9V6zm-5 5h2v2H4v-2zm5 0h11v2H9v-2zm-5 5h2v2H4v-2zm5 0h11v2H9v-2z"/></svg>' +
                    '<span class="action-label">Episode List</span>' +
                  '</button>' +
                  '<button id="lg-player-next" type="button" tabindex="-1" aria-label="Next episode" title="Next episode">' +
                    '<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zm10-12v12h2V6h-2z"/></svg>' +
                    '<span class="action-label">Next</span>' +
                  '</button>' +
                '</div>' +
                '<div class="control-row test-row utility-row" aria-label="Additional player actions">' +
                  '<button id="lg-player-subtitles" class="is-subtitles-disabled" type="button" tabindex="-1" aria-label="Subtitles" title="Subtitles unavailable" disabled aria-disabled="true">' +
                    '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 10a2 2 0 0 0-2 2v0a2 2 0 0 0 2 2m7-4a2 2 0 0 0-2 2v0a2 2 0 0 0 2 2"/></svg>' +
                    '<span class="action-label">Subtitles: OFF</span>' +
                  '</button>' +
                  '<button id="lg-player-native" type="button" tabindex="-1" aria-label="Open in LG YouTube App" title="Open in LG YouTube App" hidden>' +
                    '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>' +
                    '<span class="action-label">Open in LG YouTube App</span>' +
                  '</button>' +
                  '<button id="lg-player-back" type="button" tabindex="-1" aria-label="Exit to Watch" title="Exit to Watch">' +
                    '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 5 5v5"/></svg>' +
                    '<span class="action-label">Exit to Watch</span>' +
                  '</button>' +
                '</div>' +
              '</div>' +
              '<p id="lg-command-status" class="command-status" role="status" aria-live="polite"></p>' +
            '</div>' +
          '</div>' +
        '</section>';
      doc.body.appendChild(overlay);
    }

    var localizePlayer = root.HorizonWatchI18n && root.HorizonWatchI18n.capture(overlay);

    function focusEl(el) {
      if (!el || el.disabled || el.hidden || el.closest("[hidden]")) return false;
      Array.prototype.forEach.call(doc.querySelectorAll(".is-focused"), function (n) {
        if (n !== el) n.classList.remove("is-focused");
      });
      el.classList.add("is-focused");
      try { el.focus({ preventScroll: true }); } catch (_e) { el.focus(); }
      return true;
    }

    // E. Free playback availability for the current Details selection.
    var providersMod = root.HorizonArabicProviders;
    var relayEnabled = false;
    var relayAvailability = null;
    var relayChecks = new Map();

    function tr(label) {
      var session = state.playerSession;
      var isArabic = session ? session.section === "arabic" : app.state.contentLibrary === "arabic";
      return isArabic && root.HorizonWatchI18n ? root.HorizonWatchI18n.ar(label) : label;
    }

    function readAvailability(path) {
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, 9000);
      return root.fetch(path, { cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal })
        .then(function (response) { return response.ok ? response.json() : null; })
        .catch(function () { return null; })
        .then(function (reply) { clearTimeout(timer); return reply; });
    }

    function prepareRelayQuery(query) {
      var id = relayEnabled && providersMod && providersMod.relayAssetId(query);
      if (!id || id === "fakhr-el-delta-s01e01") return Promise.resolve(!!id);
      var current = relayChecks.get(id);
      if (current && (current.pending || current.until > Date.now())) {
        if (current.available) query.relayVerified = id;
        return current.pending || Promise.resolve(current.available);
      }
      if (relayChecks.size >= 96) relayChecks.delete(relayChecks.keys().next().value);
      var entry = { until: 0, available: false };
      relayChecks.set(id, entry);
      entry.pending = readAvailability("/api/arabic/relay-catalog?id=" + encodeURIComponent(id))
        .then(function (reply) {
          var available = !!reply && reply.available === true;
          entry.available = available;
          entry.until = Date.now() + (available ? 60000 : 20000);
          entry.pending = null;
          decorateDetails();
          return available;
        });
      return entry.pending;
    }

    function freeOption(query) {
      if (!providersMod) return null;
      var preferred = providersMod.preferredDefaultProvider(query, relayEnabled);
      var option = providersMod.resolveForProvider(preferred, query, relayEnabled);
      if (option.availability === "playable" && option.providerId !== "official_app_handoff") return option;
      return providersMod.resolveAll(query, relayEnabled).find(function (candidate) {
        return candidate.availability === "playable" && candidate.providerId !== "official_app_handoff";
      }) || null;
    }

    function relayCheckPending(query) {
      var id = providersMod && providersMod.relayAssetId(query);
      var entry = id && relayChecks.get(id);
      return !!(id && (relayAvailability || (entry && entry.pending)));
    }

    function decorateDetails() {
      var t = app.state.title;
      if (!t || app.state.contentLibrary !== "arabic") return;
      var actions = doc.getElementById("detail-actions");
      var primary = actions && actions.querySelector(".detail-primary[data-playback-asset]");
      if (!primary) return;
      var query = {
        type: t.type, tmdbId: t.id, titleAr: t.titleAr, titleEn: t.titleEn,
        year: t.date ? t.date.slice(0, 4) : null,
        season: Number(primary.dataset.season) || null, episode: Number(primary.dataset.episode) || null
      };
      prepareRelayQuery(query);
      var playable = !!freeOption(query);
      var label = playable ? "Play" : tr(relayCheckPending(query) ? "Checking availability…" : "Unavailable");
      primary.setAttribute("aria-disabled", playable ? "false" : "true");
      if (!playable) primary.setAttribute("aria-label", label);
      else if (primary.dataset.playbackLabel) primary.setAttribute("aria-label", primary.dataset.playbackLabel);
      if (primary.textContent !== label) primary.textContent = label;
      var restart = actions.querySelector('[data-action="start-over"]');
      if (restart) restart.hidden = !playable;
    }

    var obs = new MutationObserver(decorateDetails);
    if (doc.getElementById("detail-actions")) obs.observe(doc.getElementById("detail-actions"), { childList: true });
    if (providersMod && typeof root.fetch === "function") {
      relayAvailability = readAvailability("/api/arabic/relay-availability")
        .then(function (status) {
          relayEnabled = !!status && status.enabled === true;
          relayAvailability = null;
          decorateDetails();
        });
    }

    // F. Full-screen Horizon Video Lab overlay for Arabic HLS / MP4 / YouTube / LG App
    var stage = doc.getElementById("lg-player-stage");
    var remoteCapture = doc.getElementById("lg-remote-capture");
    var chrome = doc.getElementById("lg-player-chrome");
    var pTitle = doc.getElementById("lg-player-title");
    var pEp = doc.getElementById("lg-player-episode");
    var pBadge = doc.getElementById("lg-player-badge");
    var pTimeline = doc.getElementById("lg-playback-timeline");
    var pTimelineCur = doc.getElementById("lg-timeline-current");
    var pTimelineDur = doc.getElementById("lg-timeline-duration");
    var pTimelineTrack = doc.getElementById("lg-timeline-track");
    var pFill = doc.getElementById("lg-player-track-fill");
    var pPlayhead = doc.getElementById("lg-timeline-playhead");
    var pSeekPreview = doc.getElementById("lg-seek-preview");
    var pCommandStatus = doc.getElementById("lg-command-status");
    var btnRew = doc.getElementById("lg-player-rew");
    var rewLabel = doc.getElementById("lg-rewind-label");
    var btnPlay = doc.getElementById("lg-player-playpause");
    var playPauseLabel = doc.getElementById("lg-play-pause-label");
    var btnFf = doc.getElementById("lg-player-ff");
    var ffLabel = doc.getElementById("lg-forward-label");
    var btnPrev = doc.getElementById("lg-player-prev");
    var btnEpisodes = doc.getElementById("lg-player-episodes");
    var btnNext = doc.getElementById("lg-player-next");
    var btnSubtitles = doc.getElementById("lg-player-subtitles");
    var btnNative = doc.getElementById("lg-player-native");
    var btnBack = doc.getElementById("lg-player-back");

    var CONTROLS_ORDER = [
      btnRew, btnPlay, btnFf,
      btnPrev, btnEpisodes, btnNext, null, btnSubtitles, btnNative, btnBack, pTimelineTrack
    ];
    var CONTROL_IDS = [
      "rewind", "play-pause", "forward",
      "previous-episode", "episodes", "next-episode", "provider-choice", "subtitles", "native", "watch-exit", "timeline"
    ];
    var IDLE_MS = 5000;
    var SEEK_COUNTS = [1, 3, 6, 12, 30, 60];
    var SEEK_LABELS = ["10s", "30s", "1m", "2m", "5m", "10m"];
    var seekLevels = { rewind: 0, forward: 0 };
    var controlsVisible = false;
    var selectedControlIdx = 1;
    var desktopWatch = !!(root.matchMedia
      && (root.matchMedia("(pointer: fine)").matches || root.matchMedia("(any-pointer: fine)").matches))
      && !detectWebOSRuntime();

    var ytPlayer = null;
    var hlsPlayer = null;
    var videoEl = null;
    var relayRequest = null;
    var relayPairTimer = 0;
    var relayStartupTimer = 0;
    var relayRetryTimer = 0;
    var RELAY_ORIGIN = "https://horizon.129-213-139-127.sslip.io";
    var progressTimer = 0;
    var controlsHideTimer = 0;
    var returnFocusNode = null;

    function isPlaybackPaused() {
      if (videoEl) return !!videoEl.paused;
      if (ytPlayer && typeof ytPlayer.getPlayerState === "function") {
        var st = ytPlayer.getPlayerState();
        return st !== 1 && st !== 3;
      }
      return false;
    }

    function updatePlayPauseVisual(playing) {
      if (!btnPlay) return;
      var label = tr(playing ? "Pause" : "Play");
      btnPlay.setAttribute("data-playback", playing ? "playing" : "paused");
      btnPlay.setAttribute("aria-label", label);
      btnPlay.title = label;
      if (playPauseLabel) playPauseLabel.textContent = label;
    }

    function renderSeekLabels() {
      if (rewLabel) rewLabel.textContent = "\u2212" + SEEK_LABELS[seekLevels.rewind];
      if (ffLabel) ffLabel.textContent = "+" + SEEK_LABELS[seekLevels.forward];
    }

    function resetSeekSelection() {
      seekLevels.rewind = 0;
      seekLevels.forward = 0;
      renderSeekLabels();
      if (pSeekPreview) pSeekPreview.hidden = true;
    }

    function renderSeekPreview(id) {
      if (!pSeekPreview) return;
      if (id !== "rewind" && id !== "forward") {
        pSeekPreview.hidden = true;
        return;
      }
      var sess = state.playerSession;
      var delta = SEEK_COUNTS[seekLevels[id]] * 10 * (id === "forward" ? 1 : -1);
      var detail = "";
      if (sess && sess.durationSec > 0) {
        var target = Math.max(0, Math.min(sess.durationSec, (sess.positionSec || 0) + delta));
        detail = " · " + tr("target") + " " + formatTime(target);
      }
      pSeekPreview.textContent = tr(delta < 0 ? "Rewind" : "Forward") + " " + SEEK_LABELS[seekLevels[id]] + detail + " · " + tr("OK to confirm");
      pSeekPreview.hidden = false;
    }

    function adjustSeek(id, key) {
      var increase = id === "forward" ? key === "ArrowRight" : key === "ArrowLeft";
      var decrease = !increase;
      if (decrease && seekLevels[id] === 0) return false;
      seekLevels[id] = Math.max(0, Math.min(SEEK_COUNTS.length - 1, seekLevels[id] + (increase ? 1 : -1)));
      renderSeekLabels();
      renderSeekPreview(id);
      if (pCommandStatus) {
        pCommandStatus.textContent = (id === "forward" ? tr("Forward") + " " + ffLabel.textContent : tr("Rewind") + " " + rewLabel.textContent) + " · " + tr("OK seeks");
        pCommandStatus.classList.add("is-seek-help");
      }
      return true;
    }

    function clearControlsHideTimer() {
      if (controlsHideTimer) { clearTimeout(controlsHideTimer); controlsHideTimer = 0; }
    }

    function setOverlayVisible(visible) {
      controlsVisible = !!visible;
      overlay.classList.toggle("controls-open", controlsVisible);
      chrome.classList.toggle("is-visible", controlsVisible);
      chrome.setAttribute("aria-hidden", controlsVisible ? "false" : "true");
      CONTROLS_ORDER.forEach(function (btn) {
        if (!btn) return;
        btn.tabIndex = (controlsVisible && !btn.hidden && !btn.disabled) ? 0 : -1;
      });
    }

    function resetIdle() {
      clearControlsHideTimer();
      var sess = state.playerSession;
      if (!controlsVisible || !state.playerOpen || !sess) return;
      if (sess.mode !== "hls" && sess.mode !== "mp4" && sess.mode !== "youtube") return;
      if ((sess.mode === "hls" || sess.mode === "mp4") && !sess.observedPlayback) return;
      if (stage && stage.querySelector(".lg-player-status-card")) return;
      if (isPlaybackPaused()) return;
      controlsHideTimer = setTimeout(function () {
        controlsHideTimer = 0;
        if (controlsVisible && state.playerOpen && !isPlaybackPaused()) hideControls(false);
      }, IDLE_MS);
    }

    function focusControl(index) {
      var idx = Math.max(0, Math.min(CONTROLS_ORDER.length - 1, index));
      if (CONTROLS_ORDER[idx] && (CONTROLS_ORDER[idx].disabled || CONTROLS_ORDER[idx].hidden)) {
        idx = 1;
      }
      if (selectedControlIdx !== idx) resetSeekSelection();
      selectedControlIdx = idx;
      var id = CONTROL_IDS[idx];
      if (CONTROLS_ORDER[idx]) focusEl(CONTROLS_ORDER[idx]);
      if (controlsVisible) {
        if (id === "rewind" || id === "forward") renderSeekPreview(id);
        else if (pSeekPreview) pSeekPreview.hidden = true;
      }
      if (pCommandStatus && id !== "rewind" && id !== "forward") {
        pCommandStatus.classList.remove("is-seek-help");
      }
    }

    function showControls(targetIdx) {
      if (!state.playerOpen) return;
      if (stage && stage.querySelector(".lg-player-status-card")) return;
      chrome.hidden = false;
      setOverlayVisible(true);
      focusControl(typeof targetIdx === "number" ? targetIdx : 1);
      resetIdle();
    }

    function hideControls(force) {
      if (!controlsVisible && !force) return;
      if (!force && isPlaybackPaused()) return;
      clearControlsHideTimer();
      resetSeekSelection();
      chrome.classList.remove("is-quick-pause");
      setOverlayVisible(false);
      Array.prototype.forEach.call(overlay.querySelectorAll(".is-focused"), function (n) {
        n.classList.remove("is-focused");
      });
      if (pCommandStatus) { pCommandStatus.textContent = ""; pCommandStatus.classList.remove("is-seek-help"); }
      if (remoteCapture && state.playerOpen && !(stage && stage.querySelector(".lg-player-status-card"))) {
        try { remoteCapture.focus({ preventScroll: true }); } catch (_e) { remoteCapture.focus(); }
      }
    }

    function navigateSharedControls(key) {
      var rows = [[10], [0, 1, 2], [3, 4, 5, 6, 7, 8, 9]].map(function (row) {
        return row.filter(function (idx) {
          var b = CONTROLS_ORDER[idx];
          if (!b || b.hidden || b.disabled) return false;
          if (idx === 10 && (!pTimeline || pTimeline.hidden)) return false;
          return true;
        });
      }).filter(function (row) { return row.length > 0; });
      if (!rows.length) return;
      var rowIndex = rows.findIndex(function (row) { return row.indexOf(selectedControlIdx) !== -1; });
      if (rowIndex < 0) { focusControl(rows[0][0]); return; }
      var row = rows[rowIndex];
      var col = row.indexOf(selectedControlIdx);
      if (key === "ArrowLeft" || key === "ArrowRight") {
        var nextCol = col + (key === "ArrowRight" ? 1 : -1);
        if (nextCol >= 0 && nextCol < row.length) focusControl(row[nextCol]);
        return;
      }
      if (key === "ArrowUp" || key === "ArrowDown") {
        var nextRow = rows[rowIndex + (key === "ArrowDown" ? 1 : -1)];
        if (!nextRow) return;
        var curRowId = row[0] === 10 ? "timeline" : (row.indexOf(1) !== -1 ? "primary" : "action");
        var target = Math.round(col * (nextRow.length - 1) / Math.max(1, row.length - 1));
        if (curRowId === "timeline" && key === "ArrowDown") {
          var playIdx = nextRow.indexOf(1);
          if (playIdx !== -1) target = playIdx;
        } else if (curRowId === "primary" && key === "ArrowDown") {
          var isTv = state.playerSession && state.playerSession.item && state.playerSession.item.type === "tv";
          var preferred = isTv ? [3, 6, 5][col] : [6, 6, 9][col];
          if (nextRow.indexOf(preferred) !== -1) target = nextRow.indexOf(preferred);
        } else if (curRowId === "action" && key === "ArrowUp") {
          var primaryPlayIdx = nextRow.indexOf(1);
          if (primaryPlayIdx !== -1 && col >= 1 && col <= Math.max(1, row.length - 2)) target = primaryPlayIdx;
        }
        focusControl(nextRow[target]);
      }
    }

    function stopRelayStartupTimer() {
      if (relayStartupTimer) clearTimeout(relayStartupTimer);
      relayStartupTimer = 0;
    }

    function clearOverlayMedia() {
      stopRelayStartupTimer();
      if (relayRetryTimer) { clearTimeout(relayRetryTimer); relayRetryTimer = 0; }
      if (relayRequest) { relayRequest.abort(); relayRequest = null; }
      if (relayPairTimer) { clearTimeout(relayPairTimer); relayPairTimer = 0; }
      clearControlsHideTimer();
      resetSeekSelection();
      if (progressTimer) { clearInterval(progressTimer); progressTimer = 0; }
      if (hlsPlayer) {
        try { if (typeof hlsPlayer.destroy === "function") hlsPlayer.destroy(); } catch (_e) {}
        hlsPlayer = null;
      }
      if (ytPlayer) {
        try { if (typeof ytPlayer.destroy === "function") ytPlayer.destroy(); } catch (_e) {}
        ytPlayer = null;
      }
      if (videoEl) {
        var element = videoEl;
        videoEl = null;
        try { element.pause(); element.removeAttribute("src"); element.load(); } catch (_e) {}
      }
      if (stage) stage.replaceChildren();
    }

    function saveObservedProgress() {
      var sess = state.playerSession;
      if (!sess || !sess.item || !sess.observedPlayback) return;
      if (sess.mode !== "youtube" && sess.mode !== "mp4" && sess.mode !== "hls") return;
      var rawPos = Number(sess.positionSec || 0);
      var rawDur = Number(sess.durationSec || 0);
      if (sess.relay) rawPos = sess.relay.confirmedSec;
      if (videoEl) {
        if (!sess.relay && Number.isFinite(videoEl.currentTime)) rawPos = Math.max(rawPos, videoEl.currentTime);
        if (Number.isFinite(videoEl.duration) && videoEl.duration > 0) rawDur = videoEl.duration;
      }
      var pos = rawPos > 0 ? Math.max(1, Math.round(rawPos)) : 0;
      var dur = Math.floor(rawDur);
      if (pos <= 0 || dur <= 0) return;
      var completed = dur > 30 && pos / dur >= 0.92;
      var subChoice = core.readSubtitlePref(root.localStorage);
      var providerId = sess.providerId || (sess.mode === "mp4" ? "archive_pd" : (sess.mode === "youtube" ? "youtube_official" : "vidbolt"));
      var now = Date.now();
      var sessionSection = (sess.section === "arabic" || sess.section === "english")
        ? sess.section
        : ((app.state && app.state.contentLibrary === "arabic") ? "arabic" : "english");
      var rec = core.progressRecord({ position: pos, duration: dur, updatedAt: now, provider: providerId, completed: completed });
      var cleanTitle = (sess.item.titleEn && sess.item.titleEn !== sess.item.titleAr)
        ? (sess.item.titleAr + " · " + sess.item.titleEn)
        : (sess.item.titleAr || sess.item.title || "");
      var entry = core.item(
        sess.item.type,
        sess.item.id,
        cleanTitle,
        sess.item.type === "tv" ? sess.season : null,
        sess.item.type === "tv" ? sess.episode : null,
        subChoice || "off",
        now,
        { poster: sess.item.poster, backdrop: sess.item.backdrop, episodeTitle: sess.episodeTitle || "", progress: rec, section: sessionSection }
      );
      if (entry) {
        core.writeHistory(root.localStorage, entry, sessionSection);
        if (sess.item.type === "tv" && sess.season && sess.episode && typeof core.writeActiveEpisode === "function") {
          core.writeActiveEpisode(root.localStorage, sess.item.id, { season: sess.season, episode: sess.episode, at: now }, sessionSection);
        }
      }
    }

    function updateTimeBar(pos, dur) {
      if (!state.playerSession) return;
      state.playerSession.positionSec = Math.max(0, Number(pos) || 0);
      state.playerSession.durationSec = Math.max(0, Number(dur) || 0);
      var hasDur = state.playerSession.durationSec > 0;
      if (pTimeline) pTimeline.hidden = !hasDur;
      if (pTimelineCur) pTimelineCur.textContent = formatTime(state.playerSession.positionSec);
      if (pTimelineDur) pTimelineDur.textContent = hasDur ? formatTime(state.playerSession.durationSec) : "0:00";
      var pct = hasDur ? Math.min(100, (state.playerSession.positionSec / state.playerSession.durationSec) * 100) : 0;
      var widthPct = pct.toFixed(2) + "%";
      if (pFill) pFill.style.width = widthPct;
      if (pPlayhead) pPlayhead.style.left = widthPct;
      if (pTimelineTrack) pTimelineTrack.setAttribute("aria-valuenow", String(Math.round(pct)));
      if (controlsVisible && (selectedControlIdx === 0 || selectedControlIdx === 2)) {
        renderSeekPreview(CONTROL_IDS[selectedControlIdx]);
      }
    }

    function closePlayerOverlay() {
      if (!state.playerOpen) return;
      saveObservedProgress();
      clearOverlayMedia();
      chrome.classList.remove("is-quick-pause");
      Array.prototype.forEach.call(overlay.querySelectorAll(".is-focused"), function (n) {
        n.classList.remove("is-focused");
      });
      setOverlayVisible(false);
      state.playerOpen = false;
      state.playerSession = null;
      overlay.hidden = true;
      if (returnFocusNode && doc.body.contains(returnFocusNode)) focusEl(returnFocusNode);
      else {
        var fallback = doc.querySelector("#detail-actions .detail-primary");
        if (fallback) focusEl(fallback);
      }
      returnFocusNode = null;
    }

    function syncSubtitleButton() {
      // Required exception: Subtitles remain visibly dimmed/blurred, disabled, and OFF.
      if (!btnSubtitles) return;
      btnSubtitles.disabled = true;
      btnSubtitles.setAttribute("aria-disabled", "true");
      btnSubtitles.classList.add("is-subtitles-disabled");
      btnSubtitles.tabIndex = -1;
      var lbl = btnSubtitles.querySelector(".action-label");
      if (lbl) lbl.textContent = tr("Subtitles: OFF");
    }

    function syncEpisodeControls(arItem) {
      var sess = state.playerSession;
      var isTv = !!(arItem && arItem.type === "tv");
      var prevEp = isTv && sess ? sess.prevEpisode : null;
      var nextEp = isTv && sess ? sess.nextEpisode : null;
      if (btnPrev) {
        btnPrev.hidden = !isTv;
        btnPrev.disabled = !prevEp;
        btnPrev.setAttribute("aria-disabled", prevEp ? "false" : "true");
      }
      if (btnEpisodes) {
        btnEpisodes.hidden = !isTv;
        btnEpisodes.disabled = !isTv;
      }
      if (btnNext) {
        btnNext.hidden = !isTv;
        btnNext.disabled = !nextEp;
        btnNext.setAttribute("aria-disabled", nextEp ? "false" : "true");
      }
      setOverlayVisible(controlsVisible);
    }

    function verifyRelayNeighbors(sess) {
      if (!sess.season) return;
      var info = core.readEpisodeCatalog(root.localStorage, Number(sess.item.id));
      var seasons = info ? info.seasons.slice().sort(function (a, b) { return a.number - b.number; }) : [];
      var index = seasons.findIndex(function (season) { return season.number === sess.season; });
      if (index < 0) return;
      var current = seasons[index], previous = seasons[index - 1], next = seasons[index + 1];
      var neighbors = {
        prevEpisode: sess.episode > 1 ? { season: current.number, episode: sess.episode - 1 }
          : previous && { season: previous.number, episode: previous.count },
        nextEpisode: sess.episode < current.count ? { season: current.number, episode: sess.episode + 1 }
          : next && { season: next.number, episode: 1 }
      };
      Object.keys(neighbors).forEach(function (direction) {
        var target = neighbors[direction];
        if (!target) return;
        prepareRelayQuery({ type: "tv", tmdbId: sess.item.id, season: target.season, episode: target.episode })
          .then(function (available) {
            if (!available || !state.playerOpen || state.playerSession !== sess) return;
            sess[direction] = target;
            syncEpisodeControls(sess.item);
          });
      });
    }

    function showStatusCard(heading, body, meta, buttons) {
      clearOverlayMedia();
      setOverlayVisible(false);
      chrome.hidden = true;
      if (state.playerSession && state.playerSession.section === "arabic" && meta) {
        heading = "Playback unavailable";
        body = "";
        meta = "";
      }
      var card = doc.createElement("div");
      card.className = "lg-player-status-card";
      var h = doc.createElement("h3"); h.textContent = tr(heading); card.appendChild(h);
      var p = doc.createElement("p"); p.textContent = tr(body); card.appendChild(p);
      if (meta) {
        var m = doc.createElement("div"); m.className = "lg-player-status-meta"; m.textContent = meta; card.appendChild(m);
      }
      var row = doc.createElement("div");
      row.className = "lg-player-controls";
      buttons.forEach(function (cfg, i) {
        var b = doc.createElement("button");
        b.type = "button";
        b.className = "lg-player-ctrl-btn" + (i === 0 ? " is-primary" : "");
        b.textContent = tr(cfg.label);
        b.addEventListener("click", cfg.onClick);
        row.appendChild(b);
      });
      card.appendChild(row);
      stage.appendChild(card);
      var first = row.querySelector("button");
      if (first) focusEl(first);
    }

    function disableNativeTextTracks(v) {
      if (!v || !v.textTracks) return;
      for (var i = 0; i < v.textTracks.length; i++) {
        try { v.textTracks[i].mode = "disabled"; } catch (_e) {}
      }
    }

    function attachHtml5VideoListeners(option, arItem, sess, startSec, errHeading, retryFn) {
      var element = videoEl;
      var relayStarted = false;
      var relayPlaying = false;
      var startPosition = 0;
      function active() {
        return state.playerOpen && state.playerSession === sess && videoEl === element;
      }
      function watchRelayStartup() {
        if (!sess.relay || relayStarted || relayStartupTimer) return;
        relayStartupTimer = setTimeout(function () {
          relayStartupTimer = 0;
          if (active() && !relayStarted && sess.relay.wasPlaying) {
            recoverRelayPlayback(option, arItem, sess, true, true);
          }
        }, 25000);
      }

      function confirmPosition(seekFinished) {
        if (sess.relay && (relayStarted || seekFinished) && !element.seeking && element.readyState >= 2 && Number.isFinite(element.currentTime)) {
          sess.relay.confirmedSec = element.currentTime;
        }
      }
      if (sess.relay && sess.relay.wasPlaying) watchRelayStartup();
      element.addEventListener("loadedmetadata", function () {
        if (!active()) return;
        disableNativeTextTracks(element);
        if (startSec > 0 && element.duration > startSec + 2) {
          try { element.currentTime = startSec; startPosition = startSec; } catch (_e) {}
        }
        updateTimeBar(element.currentTime || 0, element.duration || sess.durationSec);
      });
      element.addEventListener("play", function () {
        if (!active()) return;
        if (sess.relay) sess.relay.wasPlaying = true;
        watchRelayStartup();
        updatePlayPauseVisual(true);
        chrome.classList.remove("is-quick-pause");
        resetIdle();
      });
      element.addEventListener("playing", function () {
        if (!active()) return;
        var firstStart = !sess.observedPlayback;
        relayPlaying = true;
        if (!sess.relay) sess.observedPlayback = true;
        updatePlayPauseVisual(true);
        chrome.classList.remove("is-quick-pause");
        if (firstStart) resetIdle();
      });
      element.addEventListener("pause", function () {
        if (!active()) return;
        if (sess.relay && !element.error) {
          sess.relay.wasPlaying = false;
          if (element.readyState >= 2) stopRelayStartupTimer();
        }
        updatePlayPauseVisual(false);
        showControls(selectedControlIdx);
        clearControlsHideTimer();
        saveObservedProgress();
      });
      element.addEventListener("timeupdate", function () {
        if (!active()) return;
        if (sess.relay && !relayStarted && relayPlaying && !element.paused && !element.seeking
          && element.readyState >= 2 && element.currentTime >= startPosition + 0.35) {
          relayStarted = true;
          sess.observedPlayback = true;
          stopRelayStartupTimer();
          resetIdle();
        }
        confirmPosition();
        if (!sess.relay && element.currentTime > 0) sess.observedPlayback = true;
        updateTimeBar(element.currentTime || 0, element.duration || sess.durationSec);
      });
      element.addEventListener("seeked", function () {
        if (!active()) return;
        if (!relayStarted) startPosition = element.currentTime;
        confirmPosition(true);
        if (!sess.relay) sess.observedPlayback = true;
        updateTimeBar(element.currentTime || 0, element.duration || sess.durationSec);
        saveObservedProgress();
      });
      element.addEventListener("ended", function () {
        if (!active()) return;
        confirmPosition();
        updatePlayPauseVisual(false);
        showControls(sess.nextEpisode && btnNext && !btnNext.disabled ? 5 : 1);
        clearControlsHideTimer();
        saveObservedProgress();
      });
      element.addEventListener("error", function () {
        if (!active()) return;
        if (sess.relay) {
          recoverRelayPlayback(option, arItem, sess, sess.relay.wasPlaying, !relayStarted);
          return;
        }
        var code = element.error ? element.error.code : "unknown";
        var btns = [];
        if (typeof retryFn === "function") btns.push({ label: "Retry", onClick: retryFn });
        btns.push({ label: "Back to Horizon", onClick: closePlayerOverlay });
        showStatusCard(
          errHeading + " (" + option.providerShortLabel + ")",
          "The HTML5 <video> element could not decode or load the stream (MediaError code " + code + "). Current selection kept; no silent provider switch performed.",
          "Stream: " + (option.streamUrl || option.ticketUrl || ""),
          btns
        );
      });
    }

    function setNativeAction(label, reload) {
      label = tr(label);
      btnNative.setAttribute("aria-label", label);
      btnNative.title = label;
      btnNative.querySelector(".action-label").textContent = label;
      btnNative.querySelector("svg").style.display = reload ? "none" : "";
    }

    function openHtml5VideoPlayback(option, arItem, startSec, sourceUrl, startPaused) {
      var sess = state.playerSession;
      btnNative.hidden = !sess.relay;
      btnNative.disabled = false;
      if (sess.relay) {
        sess.relay.wasPlaying = !startPaused;
        setNativeAction("Reload", true);
      }
      pTitle.textContent = (arItem.titleAr || arItem.title || "") + (arItem.titleEn ? " · " + arItem.titleEn : "");
      if (pEp) pEp.textContent = sess.season
        ? tr("Season " + sess.season + " · Episode " + sess.episode) + (sess.episodeTitle ? " · " + sess.episodeTitle : "")
        : sess.section === "arabic" ? "" : option.authorizationNote + " · MP4 Direct Stream";
      pBadge.textContent = option.providerShortLabel;
      if (pCommandStatus) pCommandStatus.textContent = "";
      syncSubtitleButton();
      syncEpisodeControls(arItem);
      updatePlayPauseVisual(!startPaused);
      updateTimeBar(startSec || 0, sess.durationSec || (arItem.runtime || 90) * 60);

      var element = doc.createElement("video");
      videoEl = element;
      element.id = "lg-html5-video";
      element.autoplay = !startPaused;
      if (sess.relay) element.preload = "metadata";
      element.playsInline = true;
      element.controls = false;
      stage.appendChild(element);
      attachHtml5VideoListeners(option, arItem, sess, startSec, "MP4 Playback Error", null);
      element.src = sourceUrl || option.streamUrl;
      if (!startPaused) {
        var p = element.play();
        if (p && typeof p.catch === "function") p.catch(function () {
          if (state.playerOpen && state.playerSession === sess && videoEl === element) updatePlayPauseVisual(false);
        });
      }
      showControls(1);
    }

    function relayApi(path, action, data, signal) {
      var headers = { "X-Horizon-Action": action };
      var body;
      if (data) { headers["Content-Type"] = "application/json"; body = JSON.stringify(data); }
      return root.fetch(path, { method: "POST", credentials: "same-origin", cache: "no-store",
        headers: headers, body: body, signal: signal }).then(function (response) {
        return response.json().then(function (value) {
          if (!response.ok) throw new Error(value.code || "request_failed");
          return value;
        });
      });
    }

    function relaySessionActive(sess, request) {
      return state.playerOpen && state.playerSession === sess && relayRequest === request;
    }

    function showLoading(label) {
      setOverlayVisible(false);
      chrome.hidden = true;
      var status = doc.createElement("p");
      status.className = "lg-player-loading";
      status.setAttribute("role", "status");
      status.textContent = tr(label);
      stage.appendChild(status);
      focusEl(remoteCapture);
    }

    function relayStatus(heading, message, primaryAction) {
      showStatusCard(heading, message, "", [
        primaryAction,
        { label: "Back to Horizon", onClick: closePlayerOverlay }
      ].filter(Boolean));
    }

    function pairRelayDevice(option, arItem, sess, startPaused) {
      if (relayRequest) return;
      var request = new AbortController();
      relayRequest = request;
      var card = stage.querySelector(".lg-player-status-card");
      var message = card && card.querySelector("p");
      var expiresAt;
      if (message) message.textContent = tr("Requesting a pairing code…");

      function failed() {
        if (!relaySessionActive(sess, request)) return;
        relayRequest = null;
        if (message) message.textContent = tr("Pairing ended. Select Show pairing code to try again.");
      }

      function poll() {
        if (!relaySessionActive(sess, request)) return;
        if (Date.now() >= expiresAt) { failed(); return; }
        relayApi("/api/pair/status", "pair", null, request.signal).then(function (value) {
          if (!relaySessionActive(sess, request)) return;
          if (value.state === "paired") {
            startRelayPlayback(option, arItem, sess, startPaused, false);
          } else if (value.state === "pending" || value.state === "approved") {
            relayPairTimer = setTimeout(poll, 2000);
          } else failed();
        }, failed);
      }

      relayApi("/api/pair/start", "pair", null, request.signal).then(function (value) {
        if (!relaySessionActive(sess, request)) return;
        if (!/^[A-HJ-NP-Z2-9]{10}$/.test(value.code)) { failed(); return; }
        expiresAt = Date.now() + 5 * 60 * 1000;
        if (message) message.textContent = tr("Code:") + " " + value.code + " · " + tr("Approve it on this Watch site’s /owner page.");
        relayPairTimer = setTimeout(poll, 1500);
      }, failed);
    }

    function startRelayPlayback(option, arItem, sess, startPaused, refreshUpstream) {
      if (!state.playerOpen || state.playerSession !== sess) return;
      clearOverlayMedia();
      var relay = sess.relay;
      var request = new AbortController();
      var refreshTicket = relay.ticket && relay.expiresAt <= Date.now() + 5000;
      var data = { episodeId: option.relayEpisodeId };
      if (refreshTicket) data.previousTicket = relay.ticket;

      function failed(error) {
        if (!relaySessionActive(sess, request)) return;
        var pairing = error.message === "pairing_required";
        var ended = error.message === "ticket_renewal_rejected";
        var unavailable = error.message === "relay_asset_unavailable";
        if (unavailable) {
          relayChecks.set(option.relayEpisodeId, { available: false, until: Date.now() + 20000 });
          decorateDetails();
        }
        relayStatus(pairing ? "Pair Horizon Watch" : "Playback unavailable",
          pairing ? "Pair this device to play the selected episode."
            : ended ? "This playback ticket has reached its renewal limit. Exit and select the episode again."
            : unavailable ? "No verified source is currently available for this selection."
            : "Could not start playback. Try Reload.",
          pairing ? { label: "Show pairing code", onClick: function () {
            pairRelayDevice(option, arItem, sess, startPaused);
          } } : ended || unavailable ? null : { label: "Reload", onClick: function () {
            startRelayPlayback(option, arItem, sess, startPaused, true);
          } });
      }

      function play() {
        if (!relaySessionActive(sess, request)) return;
        relayRequest = null;
        stage.replaceChildren();
        relay.attemptAt = Date.now();
        var source = RELAY_ORIGIN + "/relay?id=" + encodeURIComponent(option.relayEpisodeId)
          + "&ticket=" + encodeURIComponent(relay.ticket) + (refreshUpstream ? "&refresh=1" : "")
          + (relay.variant ? "&variant=1" : "");
        openHtml5VideoPlayback(option, arItem, relay.confirmedSec, source, startPaused);
      }

      var needsTicket = !relay.ticket || refreshTicket;
      if (needsTicket) showLoading("Loading…");
      relayRequest = request;
      if (!needsTicket) { play(); return; }
      if (refreshTicket && relay.refreshesRemaining === 0) {
        failed(new Error("ticket_renewal_rejected"));
        return;
      }
      var requestedAt = Date.now();
      relayApi(option.ticketUrl, "ticket", data, request.signal).then(function (value) {
        if (!relaySessionActive(sess, request)) return;
        if (!value || typeof value.ticket !== "string" || !value.ticket || !(value.ttlSeconds > 0)
          || !Number.isInteger(value.refreshesRemaining) || value.refreshesRemaining < 0) {
          throw new Error("invalid_ticket_response");
        }
        relay.ticket = value.ticket;
        relay.expiresAt = requestedAt + value.ttlSeconds * 1000;
        relay.refreshesRemaining = value.refreshesRemaining;
        relay.sourceCount = value.sourceCount === 2 ? 2 : 1;
        play();
      }).catch(failed);
    }

    function recoverRelayPlayback(option, arItem, sess, wasPlaying, startup) {
      var relay = sess.relay;
      if (startup && relay.startupRetries < 1) {
        relay.startupRetries++;
        clearOverlayMedia();
        showLoading("Loading…");
        // Let the existing Oracle force-refresh cooldown elapse even on an
        // immediate decode error. Back and episode changes cancel this timer.
        var delay = Math.max(0, 5000 - (Date.now() - relay.attemptAt));
        relayRetryTimer = setTimeout(function () {
          relayRetryTimer = 0;
          startRelayPlayback(option, arItem, sess, !wasPlaying, true);
        }, delay);
      } else if (startup && !relay.variant && relay.sourceCount === 2) {
        relay.variant = 1;
        startRelayPlayback(option, arItem, sess, !wasPlaying, false);
      } else if (!startup && !relay.recovered) {
        relay.recovered = true;
        startRelayPlayback(option, arItem, sess, !wasPlaying, true);
      } else if (startup) {
        relayStatus("Unavailable", "", null);
      } else {
        relayStatus("Playback interrupted", "Playback stopped. Reload resumes from the last confirmed position.",
          { label: "Reload", onClick: function () {
            startRelayPlayback(option, arItem, sess, !wasPlaying, true);
          } });
      }
    }

    function openHlsPlayback(option, arItem, startSec) {
      var sess = state.playerSession;
      btnNative.hidden = true;
      pTitle.textContent = (arItem.titleEn && arItem.titleEn !== arItem.titleAr)
        ? (arItem.titleAr + " · " + arItem.titleEn)
        : (arItem.titleAr || arItem.title || "Roya TV");
      if (pEp) {
        pEp.textContent = (sess && sess.season
          ? (tr("Season " + sess.season + " · Episode " + sess.episode) + (sess.episodeTitle ? " · " + sess.episodeTitle : ""))
          : sess.section === "arabic" ? "" : (arItem.date ? arItem.date.slice(0, 4) + " · Roya TV Film" : "Roya TV · HLS"));
      }
      pBadge.textContent = option.providerShortLabel;
      if (pCommandStatus) pCommandStatus.textContent = tr("Authorizing Roya TV HLS stream…");
      syncSubtitleButton();
      syncEpisodeControls(arItem);
      updatePlayPauseVisual(true);
      updateTimeBar(startSec || 0, option.durationSec || ((arItem.type === "movie" ? arItem.runtime : arItem.episodeRuntime) || 43) * 60);

      videoEl = doc.createElement("video");
      videoEl.id = "lg-html5-video";
      videoEl.autoplay = true;
      videoEl.playsInline = true;
      videoEl.controls = false;
      stage.appendChild(videoEl);

      function retryHls() {
        clearOverlayMedia();
        state.playerSession = sess;
        openHlsPlayback(option, arItem, sess.positionSec || startSec || 0);
      }

      function showHlsError(title, detail, meta) {
        if (!state.playerOpen || state.playerSession !== sess) return;
        showStatusCard(
          title,
          detail + " Preserved S" + (sess.season || "?") + " E" + (sess.episode || "?") + "; no automatic provider switch.",
          meta,
          [
            { label: "Retry", onClick: retryHls },
            { label: "Back to Horizon", onClick: closePlayerOverlay }
          ]
        );
      }

      attachHtml5VideoListeners(option, arItem, sess, startSec, "HLS Playback Error", retryHls);

      var cap = detectHlsCapability(videoEl);
      if (cap === "unsupported") {
        showHlsError(
          "HLS Playback Unsupported",
          "This browser engine lacks native HLS and H.264/AAC MediaSource support.",
          "Provider: " + option.providerId + " · Video " + option.royaEpisodeId
        );
        return;
      }

      fetch(option.ticketUrl, { method: "GET" })
        .then(function (resp) {
          if (!resp.ok) throw new Error("Playback ticket HTTP " + resp.status);
          return resp.json();
        })
        .then(function (payload) {
          if (!state.playerOpen || state.playerSession !== sess) return null;
          var m3u8Url = payload && payload.data && payload.data.secured_url;
          if (!m3u8Url) throw new Error("Ticket response missing data.secured_url");
          sess.hlsUrl = m3u8Url;
          if (pCommandStatus) pCommandStatus.textContent = "";
          if (cap === "native") {
            videoEl.src = m3u8Url;
            videoEl.load();
            var np = videoEl.play();
            if (np && typeof np.catch === "function") np.catch(function () { updatePlayPauseVisual(false); });
            return null;
          }
          return loadHlsLibrary(doc).then(function (Hls) {
            if (!state.playerOpen || state.playerSession !== sess) return;
            if (!Hls || typeof Hls.isSupported !== "function" || !Hls.isSupported()) {
              var nat = videoEl.canPlayType && (videoEl.canPlayType("application/vnd.apple.mpegurl") || videoEl.canPlayType("application/x-mpegURL"));
              if (nat) {
                videoEl.src = m3u8Url;
                videoEl.load();
                var fp = videoEl.play();
                if (fp && typeof fp.catch === "function") fp.catch(function () { updatePlayPauseVisual(false); });
                return;
              }
              showHlsError("HLS Unsupported", "hls.light reports MediaSource is unsupported on this runtime.", option.ticketUrl);
              return;
            }
            hlsPlayer = new Hls({
              enableWorker: false,
              maxBufferLength: 20,
              backBufferLength: 10,
              renderTextTracksNatively: false
            });
            hlsPlayer.on(Hls.Events.MEDIA_ATTACHED, function () {
              if (!state.playerOpen || state.playerSession !== sess || !hlsPlayer) return;
              hlsPlayer.loadSource(m3u8Url);
            });
            hlsPlayer.on(Hls.Events.MANIFEST_PARSED, function () {
              if (!state.playerOpen || state.playerSession !== sess) return;
              disableNativeTextTracks(videoEl);
              var ap = videoEl.play();
              if (ap && typeof ap.catch === "function") ap.catch(function () { updatePlayPauseVisual(false); });
            });
            hlsPlayer.on(Hls.Events.ERROR, function (_ev, data) {
              if (!state.playerOpen || state.playerSession !== sess) return;
              if (!data || !data.fatal) return;
              var code = data.response && Number(data.response.code);
              var reason = (data.type || "hlsError") + " / " + (data.details || "unknown") + (code > 0 ? (" (HTTP " + code + ")") : "");
              showHlsError("Roya TV HLS Fatal Error", "Stream interrupted: " + reason + ".", m3u8Url);
            });
            hlsPlayer.attachMedia(videoEl);
          });
        })
        .catch(function (err) {
          showHlsError(
            "Roya TV Stream Unavailable",
            err && err.message ? err.message : "Failed to load Roya playback ticket.",
            option.ticketUrl
          );
        });

      showControls(1);
    }

    function openYouTubePlayback(target, startSec) {
      setNativeAction("Open in LG YouTube App", false);
      btnNative.hidden = false;
      btnNative.disabled = false;
      syncSubtitleButton();
      syncEpisodeControls(target.item);
      updatePlayPauseVisual(true);
      pTitle.textContent = target.item.titleAr + " · " + target.item.titleEn;
      if (pEp) {
        pEp.textContent = target.item.type === "tv"
          ? (tr("Season " + target.season + " · Episode " + target.episode) + (target.episodeObj && target.episodeObj.title ? " · " + target.episodeObj.title : ""))
          : state.playerSession.section === "arabic" ? "" : target.subtitle;
      }
      pBadge.textContent = "YouTube Official · " + (target.channel || "Horizon");
      updateTimeBar(startSec || 0, (target.episodeObj && target.episodeObj.runtime ? target.episodeObj.runtime * 60 : (target.item.runtime || 40) * 60));

      var mount = doc.createElement("div");
      mount.id = "lg-yt-player-mount";
      stage.appendChild(mount);

      var sess = state.playerSession;
      loadYouTubeApi(doc).then(function (YT) {
        if (!state.playerOpen || state.playerSession !== sess) return;
        ytPlayer = new YT.Player("lg-yt-player-mount", {
          width: "1920",
          height: "1080",
          videoId: target.youtubeId,
          playerVars: {
            autoplay: 1,
            controls: 0,
            rel: 0,
            modestbranding: 1,
            playsinline: 1,
            enablejsapi: 1,
            start: Math.floor(startSec || 0)
          },
          events: {
            onReady: function (ev) {
              if (!state.playerOpen || state.playerSession !== sess) return;
              try {
                var ifr = ev.target && typeof ev.target.getIframe === "function" ? ev.target.getIframe() : null;
                if (ifr) ifr.setAttribute("tabindex", "-1");
                if (typeof ev.target.getDuration === "function") {
                  var d = ev.target.getDuration();
                  if (d > 0) updateTimeBar(startSec || 0, d);
                }
                ev.target.playVideo();
              } catch (_e) {}
            },
            onStateChange: function (ev) {
              if (!state.playerOpen || state.playerSession !== sess) return;
              if (ev.data === 1) sess.observedPlayback = true;
              var playing = (ev.data === 1 || ev.data === 3);
              updatePlayPauseVisual(playing);
              if (!playing) { showControls(selectedControlIdx); clearControlsHideTimer(); }
              else resetIdle();
              if (typeof ev.target.getCurrentTime === "function") {
                updateTimeBar(ev.target.getCurrentTime(), ev.target.getDuration() || sess.durationSec);
                saveObservedProgress();
              }
            },
            onError: function (ev) {
              if (!state.playerOpen || state.playerSession !== sess) return;
              showStatusCard(
                "In-App YouTube Embed Blocked",
                "YouTube returned Error " + (ev && ev.data) + ". Choose another provider or launch the official LG YouTube app.",
                "Video ID: " + target.youtubeId,
                [
                  {
                    label: "Open in LG YouTube App",
                    onClick: function () {
                      launchLGApp("youtube.leanback.v4", { contentTarget: "https://www.youtube.com/watch?v=" + target.youtubeId });
                    }
                  },
                  { label: "Back to Horizon", onClick: closePlayerOverlay }
                ]
              );
            }
          }
        });
        progressTimer = setInterval(function () {
          if (!state.playerOpen || state.playerSession !== sess || !ytPlayer) return;
          try {
            if (typeof ytPlayer.getCurrentTime === "function") {
              var cur = ytPlayer.getCurrentTime();
              var dur = ytPlayer.getDuration();
              if (cur > 0) sess.observedPlayback = true;
              if (Number.isFinite(cur)) updateTimeBar(cur, dur || sess.durationSec);
            }
          } catch (_e) {}
        }, 1000);
      }).catch(function (err) {
        if (!state.playerOpen || state.playerSession !== sess) return;
        showStatusCard(
          "YouTube Player Unavailable",
          err && err.message ? err.message : "Could not load YouTube Player API.",
          "Video ID: " + target.youtubeId,
          [
            {
              label: "Open in LG YouTube App",
              onClick: function () { launchLGApp("youtube.leanback.v4", { contentTarget: "https://www.youtube.com/watch?v=" + target.youtubeId }); }
            },
            { label: "Back to Horizon", onClick: closePlayerOverlay }
          ]
        );
      });
      showControls(1);
    }

    function togglePlayPause() {
      if (videoEl) {
        if (videoEl.paused) {
          var pr = videoEl.play();
          if (pr && typeof pr.catch === "function") pr.catch(function () {});
        } else {
          videoEl.pause();
        }
        return;
      }
      if (!ytPlayer || typeof ytPlayer.getPlayerState !== "function") return;
      if (ytPlayer.getPlayerState() === 1) ytPlayer.pauseVideo();
      else ytPlayer.playVideo();
    }

    function performSeek(deltaSeconds) {
      if (!state.playerSession) return;
      var dur = (videoEl && Number.isFinite(videoEl.duration) && videoEl.duration > 0)
        ? videoEl.duration : (state.playerSession.durationSec || 0);
      var rawTarget = (state.playerSession.positionSec || 0) + deltaSeconds;
      var t = dur > 0 ? Math.max(0, Math.min(dur - 0.5, rawTarget)) : Math.max(0, rawTarget);
      if (videoEl) {
        try { videoEl.currentTime = t; } catch (_e) {}
        updateTimeBar(t, dur);
        resetSeekSelection();
        resetIdle();
        return;
      }
      if (ytPlayer && typeof ytPlayer.seekTo === "function") {
        ytPlayer.seekTo(t, true);
        updateTimeBar(t, dur);
        resetSeekSelection();
        resetIdle();
      }
    }

    btnPlay.addEventListener("click", function () {
      selectedControlIdx = 1;
      togglePlayPause();
    });
    btnRew.addEventListener("click", function () {
      selectedControlIdx = 0;
      performSeek(-10 * SEEK_COUNTS[seekLevels.rewind]);
    });
    btnFf.addEventListener("click", function () {
      selectedControlIdx = 2;
      performSeek(10 * SEEK_COUNTS[seekLevels.forward]);
    });
    if (pTimelineTrack) {
      pTimelineTrack.addEventListener("click", function (ev) {
        var sess = state.playerSession;
        if (!sess || !sess.durationSec) return;
        var rect = pTimelineTrack.getBoundingClientRect();
        if (!rect || rect.width <= 0) return;
        var frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
        var targetSec = frac * sess.durationSec;
        if (videoEl) {
          try { videoEl.currentTime = targetSec; } catch (_e) {}
          updateTimeBar(targetSec, videoEl.duration || sess.durationSec);
        } else if (ytPlayer && typeof ytPlayer.seekTo === "function") {
          ytPlayer.seekTo(targetSec, true);
          updateTimeBar(targetSec, sess.durationSec);
        }
        resetIdle();
      });
    }
    var pendingTransitionSection = null;
    if (btnPrev) {
      btnPrev.addEventListener("click", function () {
        var s = state.playerSession;
        if (!s || !s.prevEpisode) return;
        var p = s.prevEpisode;
        pendingTransitionSection = (s.section === "arabic" || s.section === "english") ? s.section : null;
        saveObservedProgress();
        clearOverlayMedia();
        app.launchEpisode(p.season, p.episode);
      });
    }
    if (btnEpisodes) {
      btnEpisodes.addEventListener("click", function () {
        var cur = state.playerSession && state.playerSession.item;
        closePlayerOverlay();
        if (cur && cur.type === "tv") {
          var epBtn = doc.querySelector('#detail-actions button[data-action="episodes"]');
          if (epBtn && !epBtn.hidden && !epBtn.disabled) epBtn.click();
        }
      });
    }
    btnNext.addEventListener("click", function () {
      var s = state.playerSession;
      if (!s || !s.nextEpisode) return;
      var n = s.nextEpisode;
      pendingTransitionSection = (s.section === "arabic" || s.section === "english") ? s.section : null;
      saveObservedProgress();
      clearOverlayMedia();
      app.launchEpisode(n.season, n.episode);
    });
    btnNative.addEventListener("click", function () {
      var s = state.playerSession;
      if (s && s.relay) {
        s.relay.startupRetries = 0;
        s.relay.variant = 0;
        startRelayPlayback(s.relay.option, s.item, s, isPlaybackPaused(), true);
        return;
      }
      if (!s || !s.youtubeId) return;
      launchLGApp("youtube.leanback.v4", { contentTarget: "https://www.youtube.com/watch?v=" + s.youtubeId }).then(function (res) {
        if (pCommandStatus) {
          pCommandStatus.textContent = res.simulated
            ? ("Desktop dry-run Luna launch -> " + JSON.stringify(res.parameters))
            : (res.ok ? "Launched LG YouTube app." : ("Luna error: " + res.error));
        }
      });
    });
    btnBack.addEventListener("click", closePlayerOverlay);

    overlay.addEventListener("pointermove", function () {
      if (!state.playerOpen) return;
      if (stage && stage.querySelector(".lg-player-status-card")) return;
      if (!controlsVisible) showControls(selectedControlIdx);
      else resetIdle();
    }, { passive: true });

    // G. Playback hook registered with universal-search/search.js for Arabic titles ONLY
    root.__HORIZON_LG_LAUNCH__ = function (type, id, season, episode, startOver, confirmedTitle, forcedSection) {
      if (!providersMod) return false;
      var launchSection = (forcedSection === "arabic" || forcedSection === "english")
        ? forcedSection
        : (pendingTransitionSection || ((app.state && app.state.contentLibrary === "arabic") ? "arabic" : "english"));
      pendingTransitionSection = null;
      var libraryPref = launchSection === "arabic" ? "arabic" : "standard";
      var found = arabic.findByKey(type, Number(id));
      var arItem = (found && (libraryPref === "arabic" || found.royaSeriesId)) ? found : null;
      var q = { type: type, tmdbId: Number(id), season: season || null, episode: episode || null };
      var match = core.readHistory(root.localStorage, launchSection).find(function (row) {
        return row.type === type && row.id === Number(id)
          && (type === "movie" || (row.season === Number(season) && row.episode === Number(episode)));
      });
      var savedRelay = match && match.progress && match.progress.provider === "akwam_relay";
      if (libraryPref === "arabic" || savedRelay) prepareRelayQuery(q);
      var savedRelayOption = savedRelay
        && providersMod && providersMod.resolveForProvider("akwam_relay", q, relayEnabled);
      if (!arItem && savedRelayOption && savedRelayOption.relayEpisodeId) {
        arItem = found || { type: type, id: Number(id), titleAr: match.title,
          poster: match.poster, backdrop: match.backdrop };
      }
      if (!arItem && libraryPref === "arabic" && app.state.title
        && app.state.title.type === type && Number(app.state.title.id) === Number(id)) arItem = app.state.title;
      if (!arItem && savedRelay) arItem = found || { type: type, id: Number(id), titleAr: match.title };
      if (!arItem) return false;
      q.titleAr = arItem.titleAr;
      q.titleEn = arItem.titleEn;
      q.year = arItem.date ? arItem.date.slice(0, 4) : null;
      var option = libraryPref === "standard" && savedRelay
        ? providersMod.resolveForProvider("akwam_relay", q, relayEnabled)
        : libraryPref === "arabic" ? freeOption(q)
        : providersMod.resolveForProvider("roya_tv", q, relayEnabled);

      returnFocusNode = doc.activeElement;
      clearOverlayMedia();
      state.playerOpen = true;
      overlay.hidden = false;
      if (localizePlayer) localizePlayer(launchSection === "arabic");
      pBadge.hidden = launchSection === "arabic";
      var lookup = relayEnabled && relayChecks.get(providersMod.relayAssetId(q));
      var waitingForFlag = (libraryPref === "arabic" || savedRelay) && providersMod.relayAssetId(q) && relayAvailability;
      var pending = waitingForFlag || (lookup && lookup.pending);
      if (pending && (!option || option.availability !== "playable")) {
        var pendingSession = { item: arItem, mode: "unavailable", section: launchSection, observedPlayback: false };
        state.playerSession = pendingSession;
        showLoading("Checking availability…");
        pending.then(function (available) {
          if (!state.playerOpen || state.playerSession !== pendingSession) return;
          if (available || waitingForFlag) {
            var focusTarget = returnFocusNode;
            root.__HORIZON_LG_LAUNCH__(type, id, season, episode, startOver, confirmedTitle, launchSection);
            returnFocusNode = focusTarget;
          } else relayStatus("Unavailable", "", null);
        });
        return true;
      }

      if (!option || option.availability !== "playable") {
        state.playerSession = { mode: "unavailable", section: launchSection, item: arItem, observedPlayback: false };
        relayStatus("Unavailable", "", null);
        return true;
      }

      var resumeSec = (!startOver && match && match.progress && !match.progress.completed) ? Number(match.progress.position) : 0;
      if (!Number.isFinite(resumeSec) || resumeSec < 0) resumeSec = 0;

      if (option.format === "mp4" && (option.streamUrl || option.relayEpisodeId)) {
        var mp4Ep = providersMod.strictEpisodeLookup(arItem, season, episode);
        state.playerSession = {
          mode: "mp4",
          section: launchSection,
          providerId: option.providerId,
          item: arItem,
          season: type === "tv" ? Number(season) : null,
          episode: type === "tv" ? Number(episode) : null,
          episodeTitle: confirmedTitle || (mp4Ep && mp4Ep.title) || (match && match.episodeTitle) || "",
          prevEpisode: mp4Ep && arabic.findPrevVerifiedEpisode ? arabic.findPrevVerifiedEpisode(id, season, episode) : null,
          nextEpisode: mp4Ep ? arabic.findNextVerifiedEpisode(id, season, episode) : null,
          subtitleTracks: option.subtitleTracks || [],
          positionSec: resumeSec,
          durationSec: (mp4Ep && mp4Ep.durationSec) || (arItem.archiveSource && arItem.archiveSource.durationSec) || 0,
          observedPlayback: false
        };
        if (option.relayEpisodeId) {
          state.playerSession.relay = { option: option, confirmedSec: resumeSec, recovered: false, startupRetries: 0, variant: 0 };
          startRelayPlayback(option, arItem, state.playerSession, false, false);
          verifyRelayNeighbors(state.playerSession);
        } else openHtml5VideoPlayback(option, arItem, resumeSec);
        return true;
      }

      if (option.format === "hls" && option.ticketUrl) {
        var hlsTarget = arabic.getPlayableTarget(type, Number(id), season, episode);
        var hlsSeason = type === "tv" ? Number(season || (hlsTarget && hlsTarget.season) || 1) : null;
        var hlsEpisode = type === "tv" ? Number(episode || (hlsTarget && hlsTarget.episode) || 1) : null;
        var hlsEpObj = (type === "tv" && arItem.seasonEpisodes && arItem.seasonEpisodes[hlsSeason])
          ? arItem.seasonEpisodes[hlsSeason].find(function (row) { return row.number === hlsEpisode; })
          : null;
        var hlsPrevEp = type === "tv" && arabic.findPrevVerifiedEpisode ? arabic.findPrevVerifiedEpisode(id, hlsSeason, hlsEpisode) : null;
        var hlsNextEp = type === "tv" ? arabic.findNextVerifiedEpisode(id, hlsSeason, hlsEpisode) : null;
        var activeHlsSess = {
          mode: "hls",
          section: launchSection,
          providerId: option.providerId,
          item: arItem,
          season: hlsSeason,
          episode: hlsEpisode,
          episodeTitle: hlsEpObj ? hlsEpObj.title : "",
          prevEpisode: hlsPrevEp,
          nextEpisode: hlsNextEp,
          positionSec: resumeSec,
          durationSec: option.durationSec || (hlsEpObj && hlsEpObj.durationSec) || 0,
          observedPlayback: false
        };
        state.playerSession = activeHlsSess;
        openHlsPlayback(option, arItem, resumeSec);
        if (type === "tv" && Array.isArray(arItem.seasons) && arItem.seasons.length > 1 && typeof arabic.fetchSeasonAsync === "function") {
          if (!hlsNextEp) {
            var nextSeasonEntry = arItem.seasons.find(function (sEntry) { return sEntry.number > hlsSeason; });
            if (nextSeasonEntry) {
              arabic.fetchSeasonAsync(id, nextSeasonEntry.number).then(function () {
                if (state.playerOpen && state.playerSession === activeHlsSess) {
                  activeHlsSess.nextEpisode = arabic.findNextVerifiedEpisode(id, hlsSeason, hlsEpisode);
                  syncEpisodeControls(arItem);
                }
              }, function () {});
            }
          }
          if (!hlsPrevEp && arabic.findPrevVerifiedEpisode) {
            var prevCandidates = arItem.seasons.filter(function (sEntry) { return sEntry.number < hlsSeason; });
            var prevSeasonEntry = prevCandidates.length ? prevCandidates[prevCandidates.length - 1] : null;
            if (prevSeasonEntry) {
              arabic.fetchSeasonAsync(id, prevSeasonEntry.number).then(function () {
                if (state.playerOpen && state.playerSession === activeHlsSess) {
                  activeHlsSess.prevEpisode = arabic.findPrevVerifiedEpisode(id, hlsSeason, hlsEpisode);
                  syncEpisodeControls(arItem);
                }
              }, function () {});
            }
          }
        }
        return true;
      }

      var target = arabic.getPlayableTarget(type, Number(id), season, episode);
      var prevEp = type === "tv" && arabic.findPrevVerifiedEpisode ? arabic.findPrevVerifiedEpisode(id, target.season, target.episode) : null;
      var nextEp = type === "tv" ? arabic.findNextVerifiedEpisode(id, target.season, target.episode) : null;
      state.playerSession = {
        mode: "youtube",
        section: launchSection,
        providerId: option.providerId,
        item: arItem,
        season: target.season || null,
        episode: target.episode || null,
        episodeTitle: target.episodeObj ? target.episodeObj.title : "",
        youtubeId: option.youtubeId,
        prevEpisode: prevEp,
        nextEpisode: nextEp,
        positionSec: resumeSec,
        durationSec: 0,
        observedPlayback: false
      };
      openYouTubePlayback(target, resumeSec);
      return true;
    };

    // Modal & Player capture handler + LG webOS Back (461) translation when in LG mode
    root.addEventListener("keydown", function (event) {
      var key = normalizeLGKey(event);
      var active = doc.activeElement;
      var rawCode = event.keyCode || event.which;

      if (state.playerOpen) {
        event.preventDefault();
        event.stopImmediatePropagation();

        if (stage.querySelector(".lg-player-loading")) {
          if ((key === "Back" && !event.repeat) || key === "MediaStop") closePlayerOverlay();
          return;
        }
        var statusCard = stage && stage.querySelector(".lg-player-status-card");
        if (statusCard) {
          if (key === "Back" || key === "MediaStop") { closePlayerOverlay(); return; }
          var sBtns = Array.prototype.slice.call(statusCard.querySelectorAll("button"));
          if (!sBtns.length) return;
          var sIdx = sBtns.indexOf(active);
          if (sIdx < 0) sIdx = 0;
          if (key === "ArrowRight" || key === "ArrowDown") focusEl(sBtns[(sIdx + 1) % sBtns.length]);
          else if (key === "ArrowLeft" || key === "ArrowUp") focusEl(sBtns[(sIdx - 1 + sBtns.length) % sBtns.length]);
          else if (key === "OK" && !event.repeat) sBtns[sIdx].click();
          return;
        }

        if (key === "MediaStop") { closePlayerOverlay(); return; }
        if (key === "MediaPlayPause" || key === "MediaPlay" || key === "MediaPause") {
          showControls(1);
          togglePlayPause();
          return;
        }
        if (key === "MediaRewind") { showControls(0); performSeek(-10); return; }
        if (key === "MediaFastForward") { showControls(2); performSeek(10); return; }

        if (!controlsVisible) {
          if (key === "Back") { if (!event.repeat) closePlayerOverlay(); return; }
          if (key === "OK" && !event.repeat) {
            chrome.classList.add("is-quick-pause");
            showControls(1);
            togglePlayPause();
            return;
          }
          if (!event.repeat || key.indexOf("Arrow") === 0) {
            showControls(1);
          }
          return;
        }

        resetIdle();
        if (key === "Back") {
          if (!event.repeat) {
            if (desktopWatch) closePlayerOverlay();
            else hideControls(true);
          }
          return;
        }
        if (key === "OK") {
          if (!event.repeat) {
            if (selectedControlIdx === 10) {
              togglePlayPause();
            } else if (CONTROLS_ORDER[selectedControlIdx] && !CONTROLS_ORDER[selectedControlIdx].disabled) {
              CONTROLS_ORDER[selectedControlIdx].click();
            }
          }
          return;
        }
        if (selectedControlIdx === 10 && (key === "ArrowLeft" || key === "ArrowRight")) {
          performSeek(key === "ArrowRight" ? 10 : -10);
          return;
        }
        if ((selectedControlIdx === 0 || selectedControlIdx === 2) && (key === "ArrowLeft" || key === "ArrowRight")) {
          if (!adjustSeek(CONTROL_IDS[selectedControlIdx], key)) navigateSharedControls(key);
          return;
        }
        if (key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown") {
          navigateSharedControls(key);
        }
        return;
      }

      if (isLG && rawCode === 461) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (typeof app.onKey === "function") {
          app.onKey({
            key: "Escape",
            keyCode: 27,
            which: 27,
            repeat: !!event.repeat,
            altKey: false,
            ctrlKey: false,
            metaKey: false,
            shiftKey: false,
            preventDefault: function () {}
          });
        }
      }
    }, true);

    root.addEventListener("pagehide", function () {
      if (state.playerSession && state.playerSession.relay) closePlayerOverlay();
    });

    if (isLG) {
      try {
        if (root.PalmSystem && typeof root.PalmSystem.stageReady === "function") {
          root.PalmSystem.stageReady();
        }
      } catch (_e) {}
    }

    root.HorizonLGWebOS = {
      enabled: true,
      isLGMode: isLG,
      isWebOS: detectWebOSRuntime(),
      normalizeKey: normalizeLGKey,
      launchApp: launchLGApp,
      getState: function () { return state; }
    };
    root.HorizonWatchArabicUI = root.HorizonLGWebOS;
  }

  if (root.HorizonUniversalSearch && root.HorizonUniversalSearch.app) {
    mountLGInterface();
  } else {
    root.document.addEventListener("DOMContentLoaded", mountLGInterface);
    root.addEventListener("load", mountLGInterface);
    setTimeout(mountLGInterface, 0);
  }
})(typeof window !== "undefined" ? window : globalThis);
