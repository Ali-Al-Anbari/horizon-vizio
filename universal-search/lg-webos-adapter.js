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

  function hasArabicChars(text) {
    return /[\u0600-\u06FF]/.test(String(text || ""));
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

    // Build Horizon-owned full-screen Video Lab overlay + Provider Menu
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
                '<div id="lg-timeline-track" class="timeline-track" aria-hidden="true">' +
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
                  '<button id="lg-player-provider-switch" type="button" tabindex="-1" aria-label="Switch provider" title="Switch provider">' +
                    '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10h14l-4-4m0 8H3l4 4"/></svg>' +
                    '<span class="action-label">Switch Provider</span>' +
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

    var providerMenu = doc.getElementById("lg-provider-menu");
    if (!providerMenu) {
      providerMenu = doc.createElement("div");
      providerMenu.id = "lg-provider-menu";
      providerMenu.className = "lg-provider-menu";
      providerMenu.setAttribute("role", "dialog");
      providerMenu.setAttribute("aria-modal", "true");
      providerMenu.setAttribute("aria-label", "Select Arabic Playback Provider");
      providerMenu.hidden = true;
      providerMenu.innerHTML =
        '<h3>Select Playback Provider</h3>' +
        '<p id="lg-provider-menu-sub" class="lg-provider-menu-sub">Providers are manually selected and do not auto-switch on failure.</p>' +
        '<div id="lg-provider-menu-list"></div>' +
        '<button id="lg-provider-menu-close" class="lg-player-ctrl-btn" type="button">Close</button>';
      doc.body.appendChild(providerMenu);
    }

    // Add availability pill container inside #detail-copy
    var detailCopy = doc.getElementById("detail-copy");
    var detailKind = doc.getElementById("detail-kind");
    if (detailCopy && !doc.getElementById("lg-detail-availability")) {
      var pill = doc.createElement("span");
      pill.id = "lg-detail-availability";
      pill.className = "lg-detail-availability";
      pill.hidden = true;
      if (detailKind && detailKind.nextSibling) detailCopy.insertBefore(pill, detailKind.nextSibling);
      else detailCopy.insertBefore(pill, detailCopy.firstChild);
    }

    function focusEl(el) {
      if (!el || el.disabled || el.hidden || el.closest("[hidden]")) return false;
      Array.prototype.forEach.call(doc.querySelectorAll(".is-focused"), function (n) {
        if (n !== el) n.classList.remove("is-focused");
      });
      el.classList.add("is-focused");
      try { el.focus({ preventScroll: true }); } catch (_e) { el.focus(); }
      return true;
    }

    // E. Provider selection & Details view decoration for Arabic titles
    var providersMod = root.HorizonArabicProviders;
    state.selectedProviderByKey = Object.create(null);
    state.providerMenuOpen = false;
    state.providerMenuReturnEl = null;

    function getSelectionQuery(arItem) {
      var season = arItem.type === "tv" ? (app.state.season || (arItem.seasons && arItem.seasons[0] && arItem.seasons[0].number) || 1) : null;
      var epNum = null;
      if (arItem.type === "tv") {
        var activeEp = app.state.activeEpisodeTarget;
        var epList = arItem.seasonEpisodes && arItem.seasonEpisodes[season] ? arItem.seasonEpisodes[season] : [];
        epNum = activeEp || (epList[0] && epList[0].number) || 1;
      }
      return {
        type: arItem.type,
        tmdbId: arItem.id,
        titleAr: arItem.titleAr,
        titleEn: arItem.titleEn,
        year: arItem.date ? arItem.date.slice(0, 4) : null,
        season: season,
        episode: epNum
      };
    }

    function getSelectedProviderId(arItem) {
      var key = arItem.type + ":" + arItem.id;
      if (state.selectedProviderByKey[key]) return state.selectedProviderByKey[key];
      if (!providersMod) return "youtube_official";
      var q = getSelectionQuery(arItem);
      var defId = providersMod.preferredDefaultProvider(q);
      state.selectedProviderByKey[key] = defId;
      return defId;
    }

    function openProviderMenu(arItem, returnEl) {
      if (!providersMod || !arItem) return;
      state.providerMenuOpen = true;
      state.providerMenuReturnEl = returnEl || doc.activeElement;
      var q = getSelectionQuery(arItem);
      var currentId = getSelectedProviderId(arItem);
      var allOptions = providersMod.resolveAll(q);
      var listHost = doc.getElementById("lg-provider-menu-list");
      var sub = doc.getElementById("lg-provider-menu-sub");
      if (sub) {
        sub.textContent = arItem.titleAr + " (" + arItem.titleEn + ")"
          + (arItem.type === "tv" ? (" · S" + q.season + " E" + q.episode) : "")
          + " — Manual selection (no silent switching).";
      }
      listHost.replaceChildren();
      var selectedEl = null;
      allOptions.forEach(function (opt) {
        var btn = doc.createElement("button");
        btn.type = "button";
        btn.className = "lg-provider-option" + (opt.providerId === currentId ? " is-selected" : "");
        btn.dataset.providerId = opt.providerId;
        var left = doc.createElement("span");
        var strong = doc.createElement("strong");
        strong.textContent = opt.providerLabel;
        var meta = doc.createElement("span");
        meta.className = "lg-provider-option-meta";
        meta.textContent = opt.availability === "playable"
          ? (opt.format.toUpperCase() + " · " + opt.authorizationNote)
          : (opt.availability === "external-app" ? opt.authorizationNote : opt.failureReason);
        left.appendChild(strong);
        left.appendChild(meta);

        var pill = doc.createElement("span");
        pill.className = "lg-provider-option-status is-" + opt.availability;
        pill.textContent = opt.availability === "playable" ? "Ready"
          : (opt.availability === "external-app" ? "LG App" : "Unavailable");

        btn.appendChild(left);
        btn.appendChild(pill);
        btn.addEventListener("click", function () {
          state.selectedProviderByKey[arItem.type + ":" + arItem.id] = opt.providerId;
          closeProviderMenu();
          decorateDetails();
        });
        listHost.appendChild(btn);
        if (opt.providerId === currentId) selectedEl = btn;
      });
      providerMenu.hidden = false;
      focusEl(selectedEl || listHost.querySelector("button") || doc.getElementById("lg-provider-menu-close"));
    }

    function closeProviderMenu() {
      if (!state.providerMenuOpen) return;
      state.providerMenuOpen = false;
      providerMenu.hidden = true;
      if (state.providerMenuReturnEl && doc.body.contains(state.providerMenuReturnEl)) {
        focusEl(state.providerMenuReturnEl);
      }
      state.providerMenuReturnEl = null;
    }

    var pMenuClose = doc.getElementById("lg-provider-menu-close");
    if (pMenuClose) pMenuClose.addEventListener("click", closeProviderMenu);

    function decorateDetails() {
      var t = app.state && app.state.title;
      var pillEl = doc.getElementById("lg-detail-availability");
      var dTitle = doc.getElementById("detail-title");
      var dSum = doc.getElementById("detail-summary");
      var arItem = t ? arabic.findByKey(t.type, t.id) : null;
      var existingProvBtn = doc.getElementById("lg-provider-select-btn");
      if (!arItem) {
        if (pillEl) pillEl.hidden = true;
        if (dTitle) dTitle.removeAttribute("dir");
        if (dSum) dSum.removeAttribute("dir");
        if (existingProvBtn) existingProvBtn.remove();
        return;
      }
      if (dTitle && hasArabicChars(dTitle.textContent)) dTitle.setAttribute("dir", "rtl");
      if (dSum && hasArabicChars(dSum.textContent)) dSum.setAttribute("dir", "rtl");

      var selectedId = getSelectedProviderId(arItem);
      var resolved = providersMod ? providersMod.resolveForProvider(selectedId, getSelectionQuery(arItem)) : null;

      if (pillEl) {
        pillEl.hidden = false;
        var pillClass = resolved && resolved.availability === "playable" ? "in-app"
          : (resolved && resolved.availability === "external-app" ? "official-app" : "catalog-only");
        pillEl.className = "lg-detail-availability is-" + pillClass;
        pillEl.textContent = (resolved ? (resolved.providerShortLabel + " · " + (resolved.availability === "playable" ? resolved.format.toUpperCase() : resolved.availability.toUpperCase())) : arItem.availabilityLabel)
          + (arItem.countryLabel ? " · " + arItem.countryLabel : "");
      }

      var actions = doc.getElementById("detail-actions");
      if (!actions) return;
      var primaryBtn = actions.querySelector(".detail-primary");
      if (primaryBtn) {
        if (resolved && resolved.availability === "playable") {
          if (resolved.format === "mp4") primaryBtn.textContent = "Play MP4 (Archive.org)";
          else if (resolved.format === "hls") primaryBtn.textContent = "Watch (" + resolved.providerShortLabel + ")";
          else primaryBtn.textContent = "Watch (YouTube Official)";
        } else if (resolved && resolved.availability === "external-app") {
          primaryBtn.textContent = "Open in " + (resolved.officialApp ? resolved.officialApp.appName : "Official App");
        } else {
          primaryBtn.textContent = "Unavailable (" + (resolved ? resolved.providerShortLabel : "No Stream") + ")";
        }
      }

      if (!existingProvBtn) {
        existingProvBtn = doc.createElement("button");
        existingProvBtn.type = "button";
        existingProvBtn.id = "lg-provider-select-btn";
        existingProvBtn.className = "detail-secondary";
        existingProvBtn.setAttribute("data-focus", "");
        existingProvBtn.addEventListener("click", function () {
          var current = app.state && app.state.title ? arabic.findByKey(app.state.title.type, app.state.title.id) : null;
          if (current) openProviderMenu(current, existingProvBtn);
        });
        var moreLike = actions.querySelector('[data-action="more-like-this"]');
        if (moreLike) actions.insertBefore(existingProvBtn, moreLike);
        else actions.appendChild(existingProvBtn);
      }
      var nextProvLabel = "Provider: " + (resolved ? resolved.providerShortLabel : selectedId);
      if (existingProvBtn.textContent !== nextProvLabel) {
        existingProvBtn.textContent = nextProvLabel;
      }
    }

    var obs = new MutationObserver(decorateDetails);
    if (doc.getElementById("detail-title")) obs.observe(doc.getElementById("detail-title"), { childList: true, characterData: true, subtree: true });
    if (doc.getElementById("detail-actions")) obs.observe(doc.getElementById("detail-actions"), { childList: true });

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
    var btnSwitchProvider = doc.getElementById("lg-player-provider-switch");
    var btnSubtitles = doc.getElementById("lg-player-subtitles");
    var btnNative = doc.getElementById("lg-player-native");
    var btnBack = doc.getElementById("lg-player-back");

    var CONTROLS_ORDER = [
      btnRew, btnPlay, btnFf,
      btnPrev, btnEpisodes, btnNext, btnSwitchProvider, btnSubtitles, btnNative, btnBack
    ];
    var CONTROL_IDS = [
      "rewind", "play-pause", "forward",
      "previous-episode", "episodes", "next-episode", "provider-choice", "subtitles", "native", "watch-exit"
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
      var label = playing ? "Pause" : "Play";
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
        detail = " · target " + formatTime(target);
      }
      pSeekPreview.textContent = (delta < 0 ? "Rewind " : "Forward ") + SEEK_LABELS[seekLevels[id]] + detail + " · OK to confirm";
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
        pCommandStatus.textContent = (id === "forward" ? "Forward " + ffLabel.textContent : "Rewind " + rewLabel.textContent) + " · OK seeks";
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
      if (pCommandStatus) { pCommandStatus.textContent = ""; pCommandStatus.classList.remove("is-seek-help"); }
      if (remoteCapture && state.playerOpen && !(stage && stage.querySelector(".lg-player-status-card"))) {
        try { remoteCapture.focus({ preventScroll: true }); } catch (_e) { remoteCapture.focus(); }
      }
    }

    function navigateSharedControls(key) {
      var rows = [[0, 1, 2], [3, 4, 5, 6, 7, 8, 9]].map(function (row) {
        return row.filter(function (idx) {
          var b = CONTROLS_ORDER[idx];
          return b && !b.hidden && !b.disabled;
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
        var target = Math.round(col * (nextRow.length - 1) / Math.max(1, row.length - 1));
        if (rowIndex === 0 && key === "ArrowDown") {
          var isTv = state.playerSession && state.playerSession.item && state.playerSession.item.type === "tv";
          var preferred = isTv ? [3, 6, 5][col] : [6, 6, 9][col];
          if (nextRow.indexOf(preferred) !== -1) target = nextRow.indexOf(preferred);
        }
        focusControl(nextRow[target]);
      }
    }

    function clearOverlayMedia() {
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
        try { videoEl.pause(); videoEl.removeAttribute("src"); videoEl.load(); } catch (_e) {}
        videoEl = null;
      }
      if (stage) stage.replaceChildren();
    }

    function saveObservedProgress() {
      var sess = state.playerSession;
      if (!sess || !sess.item || !sess.observedPlayback) return;
      if (sess.mode !== "youtube" && sess.mode !== "mp4" && sess.mode !== "hls") return;
      var pos = Math.floor(sess.positionSec || 0);
      var dur = Math.floor(sess.durationSec || 0);
      if (pos <= 0 || dur <= 0) return;
      var completed = dur > 30 && pos / dur >= 0.92;
      var subChoice = core.readSubtitlePref(root.localStorage);
      var providerId = sess.providerId || (sess.mode === "mp4" ? "archive_pd" : (sess.mode === "youtube" ? "youtube_official" : "vidbolt"));
      var rec = core.progressRecord({ position: pos, duration: dur, updatedAt: Date.now(), provider: providerId, completed: completed });
      var entry = core.item(
        sess.item.type,
        sess.item.id,
        sess.item.titleAr + " · " + sess.item.titleEn,
        sess.item.type === "tv" ? sess.season : null,
        sess.item.type === "tv" ? sess.episode : null,
        subChoice || "off",
        Date.now(),
        { poster: sess.item.poster, backdrop: sess.item.backdrop, episodeTitle: sess.episodeTitle || "", progress: rec }
      );
      if (entry) core.writeHistory(root.localStorage, entry);
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
      if (controlsVisible && (selectedControlIdx === 0 || selectedControlIdx === 2)) {
        renderSeekPreview(CONTROL_IDS[selectedControlIdx]);
      }
    }

    function closePlayerOverlay() {
      if (!state.playerOpen) return;
      saveObservedProgress();
      clearOverlayMedia();
      chrome.classList.remove("is-quick-pause");
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
      if (lbl) lbl.textContent = "Subtitles: OFF";
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

    function showStatusCard(heading, body, meta, buttons) {
      clearOverlayMedia();
      setOverlayVisible(false);
      chrome.hidden = true;
      var card = doc.createElement("div");
      card.className = "lg-player-status-card";
      var h = doc.createElement("h3"); h.textContent = heading; card.appendChild(h);
      var p = doc.createElement("p"); p.textContent = body; card.appendChild(p);
      if (meta) {
        var m = doc.createElement("div"); m.className = "lg-player-status-meta"; m.textContent = meta; card.appendChild(m);
      }
      var row = doc.createElement("div");
      row.className = "lg-player-controls";
      buttons.forEach(function (cfg, i) {
        var b = doc.createElement("button");
        b.type = "button";
        b.className = "lg-player-ctrl-btn" + (i === 0 ? " is-primary" : "");
        b.textContent = cfg.label;
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
      videoEl.addEventListener("loadedmetadata", function () {
        if (!state.playerOpen || state.playerSession !== sess) return;
        disableNativeTextTracks(videoEl);
        if (startSec > 0 && videoEl.duration > startSec + 2) {
          try { videoEl.currentTime = startSec; } catch (_e) {}
        }
        updateTimeBar(videoEl.currentTime || 0, videoEl.duration || sess.durationSec);
      });
      videoEl.addEventListener("play", function () {
        if (!state.playerOpen || state.playerSession !== sess) return;
        sess.observedPlayback = true;
        updatePlayPauseVisual(true);
        chrome.classList.remove("is-quick-pause");
        resetIdle();
      });
      videoEl.addEventListener("pause", function () {
        if (!state.playerOpen || state.playerSession !== sess) return;
        updatePlayPauseVisual(false);
        showControls(selectedControlIdx);
        clearControlsHideTimer();
        saveObservedProgress();
      });
      videoEl.addEventListener("timeupdate", function () {
        if (!state.playerOpen || state.playerSession !== sess) return;
        if (videoEl.currentTime > 0) sess.observedPlayback = true;
        updateTimeBar(videoEl.currentTime || 0, videoEl.duration || sess.durationSec);
      });
      videoEl.addEventListener("seeked", function () {
        if (!state.playerOpen || state.playerSession !== sess) return;
        sess.observedPlayback = true;
        updateTimeBar(videoEl.currentTime || 0, videoEl.duration || sess.durationSec);
        saveObservedProgress();
      });
      videoEl.addEventListener("ended", function () {
        if (!state.playerOpen || state.playerSession !== sess) return;
        updatePlayPauseVisual(false);
        showControls(sess.nextEpisode && btnNext && !btnNext.disabled ? 5 : 1);
        clearControlsHideTimer();
        saveObservedProgress();
      });
      videoEl.addEventListener("error", function () {
        if (!state.playerOpen || state.playerSession !== sess) return;
        var code = videoEl && videoEl.error ? videoEl.error.code : "unknown";
        var btns = [];
        if (typeof retryFn === "function") btns.push({ label: "Retry", onClick: retryFn });
        btns.push({
          label: "Choose Another Provider",
          onClick: function () {
            closePlayerOverlay();
            openProviderMenu(arItem, doc.getElementById("lg-provider-select-btn"));
          }
        });
        btns.push({ label: "Back to Horizon", onClick: closePlayerOverlay });
        showStatusCard(
          errHeading + " (" + option.providerShortLabel + ")",
          "The HTML5 <video> element could not decode or load the stream (MediaError code " + code + "). Current selection kept; no silent provider switch performed.",
          "Stream: " + (option.streamUrl || option.ticketUrl || ""),
          btns
        );
      });
    }

    function openHtml5VideoPlayback(option, arItem, startSec) {
      btnNative.hidden = true;
      pTitle.textContent = arItem.titleAr + " · " + arItem.titleEn;
      if (pEp) pEp.textContent = option.authorizationNote + " · MP4 Direct Stream";
      pBadge.textContent = option.providerShortLabel;
      syncSubtitleButton();
      syncEpisodeControls(arItem);
      updatePlayPauseVisual(true);
      updateTimeBar(startSec || 0, (arItem.archiveSource && arItem.archiveSource.durationSec) || (arItem.runtime || 90) * 60);

      videoEl = doc.createElement("video");
      videoEl.id = "lg-html5-video";
      videoEl.src = option.streamUrl;
      videoEl.autoplay = true;
      videoEl.playsInline = true;
      videoEl.controls = false;
      stage.appendChild(videoEl);

      var sess = state.playerSession;
      attachHtml5VideoListeners(option, arItem, sess, startSec, "MP4 Playback Error", null);

      var p = videoEl.play();
      if (p && typeof p.catch === "function") p.catch(function () { updatePlayPauseVisual(false); });
      showControls(1);
    }

    function openHlsPlayback(option, arItem, startSec) {
      var sess = state.playerSession;
      btnNative.hidden = true;
      pTitle.textContent = arItem.titleAr + " · " + arItem.titleEn;
      if (pEp) {
        pEp.textContent = (sess && sess.season ? ("Season " + sess.season + " · Episode " + sess.episode + (sess.episodeTitle ? " · " + sess.episodeTitle : "")) : "")
          || "Authorizing Roya TV HLS stream…";
      }
      pBadge.textContent = option.providerShortLabel;
      if (pCommandStatus) pCommandStatus.textContent = "Authorizing Roya TV HLS stream…";
      syncSubtitleButton();
      syncEpisodeControls(arItem);
      updatePlayPauseVisual(true);
      updateTimeBar(startSec || 0, option.durationSec || (arItem.episodeRuntime || 43) * 60);

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
            {
              label: "Choose Another Provider",
              onClick: function () {
                closePlayerOverlay();
                openProviderMenu(arItem, doc.getElementById("lg-provider-select-btn"));
              }
            },
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
      btnNative.hidden = false;
      btnNative.disabled = false;
      syncSubtitleButton();
      syncEpisodeControls(target.item);
      updatePlayPauseVisual(true);
      pTitle.textContent = target.item.titleAr + " · " + target.item.titleEn;
      if (pEp) {
        pEp.textContent = target.item.type === "tv"
          ? ("Season " + target.season + " · Episode " + target.episode + (target.episodeObj && target.episodeObj.title ? " · " + target.episodeObj.title : ""))
          : target.subtitle;
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
                  {
                    label: "Choose Another Provider",
                    onClick: function () {
                      closePlayerOverlay();
                      openProviderMenu(target.item, doc.getElementById("lg-provider-select-btn"));
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
    if (btnPrev) {
      btnPrev.addEventListener("click", function () {
        var s = state.playerSession;
        if (!s || !s.prevEpisode) return;
        var p = s.prevEpisode;
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
    if (btnSwitchProvider) {
      btnSwitchProvider.addEventListener("click", function () {
        var cur = state.playerSession && state.playerSession.item;
        closePlayerOverlay();
        if (cur) openProviderMenu(cur, doc.getElementById("lg-provider-select-btn"));
      });
    }
    btnNext.addEventListener("click", function () {
      var s = state.playerSession;
      if (!s || !s.nextEpisode) return;
      var n = s.nextEpisode;
      saveObservedProgress();
      clearOverlayMedia();
      app.launchEpisode(n.season, n.episode);
    });
    btnNative.addEventListener("click", function () {
      var s = state.playerSession;
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
    root.__HORIZON_LG_LAUNCH__ = function (type, id, season, episode, startOver) {
      var arItem = arabic.findByKey(type, Number(id));
      if (!arItem) return false; // Leave Vizio / non-Arabic VidBolt/Vidy/VidZen/YapGrid untouched!

      var chosenProviderId = getSelectedProviderId(arItem);
      var q = {
        type: type,
        tmdbId: Number(id),
        titleAr: arItem.titleAr,
        titleEn: arItem.titleEn,
        year: arItem.date ? arItem.date.slice(0, 4) : null,
        season: season || null,
        episode: episode || null
      };
      var option = providersMod ? providersMod.resolveForProvider(chosenProviderId, q) : null;

      returnFocusNode = doc.activeElement;
      clearOverlayMedia();
      state.playerOpen = true;
      overlay.hidden = false;

      if (!option || option.availability === "unavailable") {
        // Explicit graceful failure: NEVER silently switch to YouTube!
        state.playerSession = { mode: "unavailable", item: arItem, observedPlayback: false };
        showStatusCard(
          "Provider Unavailable · " + (option ? option.providerLabel : chosenProviderId),
          (option && option.failureReason) || "This provider cannot play the selected title or episode.",
          "Current selection kept: " + arItem.titleAr + (type === "tv" ? (" S" + season + " E" + episode) : "") + " · No automatic provider switch performed.",
          [
            {
              label: "Choose Another Provider",
              onClick: function () {
                closePlayerOverlay();
                openProviderMenu(arItem, doc.getElementById("lg-provider-select-btn"));
              }
            },
            { label: "Back to Horizon", onClick: closePlayerOverlay }
          ]
        );
        return true;
      }

      if (option.availability === "external-app" && option.officialApp) {
        // Do NOT write fake progress for third-party app launches!
        state.playerSession = { mode: "official-app", item: arItem, observedPlayback: false };
        showStatusCard(
          "Open in " + option.officialApp.appName + " on LG webOS",
          arItem.titleAr + " (" + arItem.titleEn + ") is available via the official " + option.officialApp.appName + " LG TV application. Horizon will not invent playback progress for external apps.",
          "Luna payload: luna://com.webos.applicationManager/launch -> {\"id\":\"" + option.officialApp.appId + "\"}",
          [
            {
              label: "Launch " + option.officialApp.appName,
              onClick: function () {
                launchLGApp(option.officialApp.appId).then(function (res) {
                  var m = stage.querySelector(".lg-player-status-meta");
                  if (m) m.textContent = res.simulated ? ("Desktop dry-run -> " + JSON.stringify(res.parameters)) : (res.ok ? "Launched " + option.officialApp.appName : res.error);
                });
              }
            },
            { label: "Back to Horizon", onClick: closePlayerOverlay }
          ]
        );
        return true;
      }

      var savedRows = core.readHistory(root.localStorage);
      var match = savedRows.find(function (r) {
        return r.type === type && r.id === Number(id) && (type === "movie" || (r.season === season && r.episode === episode));
      });
      var resumeSec = (!startOver && match && match.progress && !match.progress.completed) ? Number(match.progress.position) : 0;

      if (option.format === "mp4" && option.streamUrl) {
        state.playerSession = {
          mode: "mp4",
          providerId: option.providerId,
          item: arItem,
          season: null,
          episode: null,
          episodeTitle: "",
          prevEpisode: null,
          nextEpisode: null,
          subtitleTracks: option.subtitleTracks || [],
          positionSec: resumeSec,
          durationSec: (arItem.archiveSource && arItem.archiveSource.durationSec) || 0,
          observedPlayback: false
        };
        openHtml5VideoPlayback(option, arItem, resumeSec);
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
        state.playerSession = {
          mode: "hls",
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
        openHlsPlayback(option, arItem, resumeSec);
        return true;
      }

      var target = arabic.getPlayableTarget(type, Number(id), season, episode);
      var prevEp = type === "tv" && arabic.findPrevVerifiedEpisode ? arabic.findPrevVerifiedEpisode(id, target.season, target.episode) : null;
      var nextEp = type === "tv" ? arabic.findNextVerifiedEpisode(id, target.season, target.episode) : null;
      state.playerSession = {
        mode: "youtube",
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

      if (state.providerMenuOpen) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (key === "Back") {
          closeProviderMenu();
          return;
        }
        var mBtns = Array.prototype.slice.call(providerMenu.querySelectorAll("button"));
        if (!mBtns.length) return;
        var mIdx = mBtns.indexOf(active);
        if (mIdx < 0) mIdx = 0;
        if (key === "ArrowDown" || key === "ArrowRight") focusEl(mBtns[(mIdx + 1) % mBtns.length]);
        else if (key === "ArrowUp" || key === "ArrowLeft") focusEl(mBtns[(mIdx - 1 + mBtns.length) % mBtns.length]);
        else if (key === "OK") mBtns[mIdx].click();
        return;
      }

      if (state.playerOpen) {
        event.preventDefault();
        event.stopImmediatePropagation();

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
          if (!event.repeat && CONTROLS_ORDER[selectedControlIdx] && !CONTROLS_ORDER[selectedControlIdx].disabled) {
            CONTROLS_ORDER[selectedControlIdx].click();
          }
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
