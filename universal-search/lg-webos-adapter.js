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
    var sec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    var mm = m < 10 ? "0" + m : String(m);
    var ss = s < 10 ? "0" + s : String(s);
    return h > 0 ? (h + ":" + mm + ":" + ss) : (mm + ":" + ss);
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

  var isLG = !!root.__HORIZON_LG_MODE__;
  var core = root.HorizonSearchCore;
  var arabic = root.HorizonArabicCatalog;
  if (!core || !arabic) {
    root.HorizonLGWebOS = { enabled: false };
    return;
  }

  var state = {
    keyboardLang: "en",
    playerOpen: false,
    playerSession: null
  };

  var ARABIC_CHARS = [
    "ا", "أ", "إ", "ب", "ت", "ث", "ج", "ح", "خ", "د", "ذ", "ر", "ز",
    "س", "ش", "ص", "ض", "ط", "ظ", "ع", "غ", "ف", "ق", "ك", "ل", "م",
    "ن", "ه", "ة", "و", "ي", "ى", "ء", "ئ", "ؤ", "لا"
  ];
  var ENGLISH_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890".split("");

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

    function isArabicLibraryActive() {
      return !!(app.state && app.state.contentLibrary === "arabic");
    }

    // Build Horizon-owned full-screen MP4 / YouTube / Official App overlay + Provider Menu
    var overlay = doc.getElementById("lg-player-overlay");
    if (!overlay) {
      overlay = doc.createElement("div");
      overlay.id = "lg-player-overlay";
      overlay.className = "lg-player-overlay";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.hidden = true;
      overlay.innerHTML =
        '<div id="lg-player-stage" class="lg-player-stage"></div>' +
        '<div id="lg-player-chrome" class="lg-player-chrome">' +
          '<div class="lg-player-topbar">' +
            '<div><h2 id="lg-player-title">Horizon Player</h2><p id="lg-player-subtitle"></p></div>' +
            '<span id="lg-player-badge" class="lg-player-badge">LG webOS</span>' +
          '</div>' +
          '<div class="lg-player-bottombar">' +
            '<div class="lg-player-progress-row">' +
              '<span id="lg-player-time" class="lg-player-time">00:00 / --:--</span>' +
              '<div class="lg-player-track"><div id="lg-player-track-fill" class="lg-player-track-fill"></div></div>' +
            '</div>' +
            '<div class="lg-player-controls">' +
              '<button id="lg-player-playpause" class="lg-player-ctrl-btn is-primary" type="button">Pause</button>' +
              '<button id="lg-player-rew" class="lg-player-ctrl-btn" type="button">-10s</button>' +
              '<button id="lg-player-ff" class="lg-player-ctrl-btn" type="button">+10s</button>' +
              '<button id="lg-player-subtitles" class="lg-player-ctrl-btn" type="button">Subtitles: Off</button>' +
              '<button id="lg-player-next" class="lg-player-ctrl-btn" type="button" hidden>Next Episode</button>' +
              '<button id="lg-player-provider-switch" class="lg-player-ctrl-btn" type="button">Switch Provider</button>' +
              '<button id="lg-player-native" class="lg-player-ctrl-btn" type="button" hidden>Open in LG YouTube App</button>' +
              '<button id="lg-player-back" class="lg-player-ctrl-btn" type="button">← Back</button>' +
            '</div>' +
          '</div>' +
        '</div>';
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

    // Search EN / Arabic on-screen keyboard toggle (shown only when Arabic Horizon library is active)
    var kb = doc.getElementById("keyboard");
    var keysHost = doc.getElementById("keyboard-keys");
    var queryInput = doc.getElementById("query");
    var langBtn = doc.getElementById("lg-kb-lang-toggle");
    function renderKeys() {
      if (!langBtn || !keysHost || !queryInput) return;
      langBtn.textContent = state.keyboardLang === "ar"
        ? "لوحة المفاتيح: العربية -> Switch to English"
        : "Keyboard: English -> Switch to العربية";
      keysHost.replaceChildren();
      keysHost.setAttribute("dir", state.keyboardLang === "ar" ? "rtl" : "ltr");
      var list = state.keyboardLang === "ar" ? ARABIC_CHARS : ENGLISH_CHARS;
      list.forEach(function (ch) {
        var b = doc.createElement("button");
        b.type = "button";
        b.setAttribute("data-focus", "");
        b.textContent = ch;
        b.addEventListener("click", function () {
          queryInput.value += (state.keyboardLang === "en" ? ch.toLowerCase() : ch);
          queryInput.dispatchEvent(new Event("input", { bubbles: true }));
        });
        keysHost.appendChild(b);
      });
      [
        ["Space", "wide", function () { queryInput.value += " "; queryInput.dispatchEvent(new Event("input", { bubbles: true })); }],
        ["⌫", "wide", function () { queryInput.value = queryInput.value.slice(0, -1); queryInput.dispatchEvent(new Event("input", { bubbles: true })); }],
        ["Clear", "wide", function () { queryInput.value = ""; queryInput.dispatchEvent(new Event("input", { bubbles: true })); }]
      ].forEach(function (cfg) {
        var b = doc.createElement("button");
        b.type = "button";
        b.className = cfg[1];
        b.setAttribute("data-focus", "");
        b.textContent = cfg[0];
        b.addEventListener("click", cfg[2]);
        keysHost.appendChild(b);
      });
    }
    function syncKeyboardLibraryMode() {
      if (!langBtn) return;
      var arActive = isArabicLibraryActive();
      langBtn.hidden = !arActive;
      if (!arActive && state.keyboardLang !== "en") {
        state.keyboardLang = "en";
        renderKeys();
      }
    }
    if (kb && keysHost && queryInput && !langBtn) {
      langBtn = doc.createElement("button");
      langBtn.type = "button";
      langBtn.id = "lg-kb-lang-toggle";
      langBtn.className = "lg-kb-lang-btn";
      langBtn.setAttribute("data-focus", "");
      langBtn.textContent = "Keyboard: English -> Switch to العربية";
      langBtn.hidden = !isArabicLibraryActive();
      kb.insertBefore(langBtn, keysHost);
      langBtn.addEventListener("click", function () {
        state.keyboardLang = state.keyboardLang === "en" ? "ar" : "en";
        renderKeys();
      });
    }
    doc.addEventListener("horizon:librarychange", syncKeyboardLibraryMode);
    root.addEventListener("horizon:librarychange", syncKeyboardLibraryMode);

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

    // F. Full-screen Horizon MP4 / YouTube / Official LG App player
    var stage = doc.getElementById("lg-player-stage");
    var chrome = doc.getElementById("lg-player-chrome");
    var pTitle = doc.getElementById("lg-player-title");
    var pSub = doc.getElementById("lg-player-subtitle");
    var pBadge = doc.getElementById("lg-player-badge");
    var pTime = doc.getElementById("lg-player-time");
    var pFill = doc.getElementById("lg-player-track-fill");
    var btnPlay = doc.getElementById("lg-player-playpause");
    var btnRew = doc.getElementById("lg-player-rew");
    var btnFf = doc.getElementById("lg-player-ff");
    var btnSubtitles = doc.getElementById("lg-player-subtitles");
    var btnNext = doc.getElementById("lg-player-next");
    var btnSwitchProvider = doc.getElementById("lg-player-provider-switch");
    var btnNative = doc.getElementById("lg-player-native");
    var btnBack = doc.getElementById("lg-player-back");

    var ytPlayer = null;
    var videoEl = null;
    var progressTimer = 0;
    var returnFocusNode = null;

    function clearOverlayMedia() {
      if (progressTimer) { clearInterval(progressTimer); progressTimer = 0; }
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
      if (sess.mode !== "youtube" && sess.mode !== "mp4") return;
      var pos = Math.floor(sess.positionSec || 0);
      var dur = Math.floor(sess.durationSec || 0);
      if (pos <= 0 || dur <= 0) return;
      var completed = dur > 30 && pos / dur >= 0.92;
      var subChoice = core.readSubtitlePref(root.localStorage);
      var rec = core.progressRecord({ position: pos, duration: dur, updatedAt: Date.now(), provider: "vidbolt", completed: completed });
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
      var pct = state.playerSession.durationSec > 0 ? Math.min(100, (state.playerSession.positionSec / state.playerSession.durationSec) * 100) : 0;
      pTime.textContent = formatTime(state.playerSession.positionSec) + " / " + (state.playerSession.durationSec > 0 ? formatTime(state.playerSession.durationSec) : "--:--");
      pFill.style.width = pct.toFixed(1) + "%";
    }

    function closePlayerOverlay() {
      if (!state.playerOpen) return;
      saveObservedProgress();
      clearOverlayMedia();
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
      var pref = core.readSubtitlePref(root.localStorage);
      var sess = state.playerSession;
      if (btnSubtitles) {
        if (sess && sess.mode === "mp4") {
          var tracks = sess.subtitleTracks || [];
          btnSubtitles.textContent = pref === "on" && tracks.length
            ? "Subtitles: External Track (Blocked CORS)"
            : "Subtitles: Off";
        } else {
          btnSubtitles.textContent = pref === "on" ? "Subtitles: On" : "Subtitles: Off";
        }
      }
    }

    function showStatusCard(heading, body, meta, buttons) {
      clearOverlayMedia();
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

    function openHtml5VideoPlayback(option, arItem, startSec) {
      chrome.hidden = false;
      btnNative.hidden = true;
      btnNext.hidden = true;
      btnPlay.textContent = "Pause";
      pTitle.textContent = arItem.titleAr + " · " + arItem.titleEn;
      pSub.textContent = option.authorizationNote + " · MP4 Direct Stream";
      pBadge.textContent = option.providerLabel;
      syncSubtitleButton();
      updateTimeBar(startSec || 0, (arItem.archiveSource && arItem.archiveSource.durationSec) || (arItem.runtime || 90) * 60);

      videoEl = doc.createElement("video");
      videoEl.id = "lg-html5-video";
      videoEl.src = option.streamUrl;
      videoEl.autoplay = true;
      videoEl.playsInline = true;
      videoEl.controls = false;
      stage.appendChild(videoEl);

      var sess = state.playerSession;
      videoEl.addEventListener("loadedmetadata", function () {
        if (!state.playerOpen || state.playerSession !== sess) return;
        if (startSec > 0 && videoEl.duration > startSec + 2) {
          try { videoEl.currentTime = startSec; } catch (_e) {}
        }
        updateTimeBar(videoEl.currentTime || 0, videoEl.duration || sess.durationSec);
      });
      videoEl.addEventListener("play", function () {
        if (!state.playerOpen || state.playerSession !== sess) return;
        sess.observedPlayback = true;
        btnPlay.textContent = "Pause";
      });
      videoEl.addEventListener("pause", function () {
        if (!state.playerOpen || state.playerSession !== sess) return;
        btnPlay.textContent = "Play";
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
        btnPlay.textContent = "Play";
        saveObservedProgress();
      });
      videoEl.addEventListener("error", function () {
        if (!state.playerOpen || state.playerSession !== sess) return;
        var code = videoEl && videoEl.error ? videoEl.error.code : "unknown";
        showStatusCard(
          "MP4 Playback Error (" + option.providerShortLabel + ")",
          "The HTML5 <video> element could not decode or load the stream (MediaError code " + code + ").",
          "Stream: " + option.streamUrl,
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
      });

      var p = videoEl.play();
      if (p && typeof p.catch === "function") p.catch(function () { btnPlay.textContent = "Play"; });
      focusEl(btnPlay);
    }

    function openYouTubePlayback(target, startSec) {
      chrome.hidden = false;
      btnNative.hidden = false;
      var nextEp = target.item.type === "tv" ? arabic.findNextVerifiedEpisode(target.item.id, target.season, target.episode) : null;
      btnNext.hidden = !nextEp;
      btnPlay.textContent = "Pause";
      syncSubtitleButton();
      pTitle.textContent = target.title;
      pSub.textContent = target.subtitle;
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
              btnPlay.textContent = (ev.data === 1 || ev.data === 3) ? "Pause" : "Play";
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
      focusEl(btnPlay);
    }

    btnPlay.addEventListener("click", function () {
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
    });
    btnRew.addEventListener("click", function () {
      if (!state.playerSession) return;
      var t = Math.max(0, (state.playerSession.positionSec || 0) - 10);
      if (videoEl) {
        try { videoEl.currentTime = t; } catch (_e) {}
        updateTimeBar(t, videoEl.duration || state.playerSession.durationSec);
        return;
      }
      if (ytPlayer && typeof ytPlayer.seekTo === "function") {
        ytPlayer.seekTo(t, true);
        updateTimeBar(t, state.playerSession.durationSec);
      }
    });
    btnFf.addEventListener("click", function () {
      if (!state.playerSession) return;
      var t = (state.playerSession.positionSec || 0) + 10;
      if (state.playerSession.durationSec > 0) t = Math.min(state.playerSession.durationSec - 1, t);
      if (videoEl) {
        try { videoEl.currentTime = t; } catch (_e) {}
        updateTimeBar(t, videoEl.duration || state.playerSession.durationSec);
        return;
      }
      if (ytPlayer && typeof ytPlayer.seekTo === "function") {
        ytPlayer.seekTo(t, true);
        updateTimeBar(t, state.playerSession.durationSec);
      }
    });
    if (btnSubtitles) {
      btnSubtitles.addEventListener("click", function () {
        var next = core.readSubtitlePref(root.localStorage) === "on" ? "off" : "on";
        core.writeSubtitlePref(root.localStorage, next);
        syncSubtitleButton();
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
        pSub.textContent = res.simulated
          ? ("Desktop dry-run Luna launch -> " + JSON.stringify(res.parameters))
          : (res.ok ? "Launched LG YouTube app." : ("Luna error: " + res.error));
      });
    });
    btnBack.addEventListener("click", closePlayerOverlay);

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
          item: arItem,
          season: null,
          episode: null,
          episodeTitle: "",
          subtitleTracks: option.subtitleTracks || [],
          positionSec: resumeSec,
          durationSec: (arItem.archiveSource && arItem.archiveSource.durationSec) || 0,
          observedPlayback: false
        };
        openHtml5VideoPlayback(option, arItem, resumeSec);
        return true;
      }

      var target = arabic.getPlayableTarget(type, Number(id), season, episode);
      var nextEp = type === "tv" ? arabic.findNextVerifiedEpisode(id, target.season, target.episode) : null;
      state.playerSession = {
        mode: "youtube",
        item: arItem,
        season: target.season || null,
        episode: target.episode || null,
        episodeTitle: target.episodeObj ? target.episodeObj.title : "",
        youtubeId: option.youtubeId,
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
        if (key === "Back" || key === "MediaStop") {
          closePlayerOverlay();
          return;
        }
        if (key === "MediaPlayPause" || key === "MediaPlay" || key === "MediaPause") {
          btnPlay.click();
          return;
        }
        if (key === "MediaRewind") { btnRew.click(); return; }
        if (key === "MediaFastForward") { btnFf.click(); return; }
        var pBtns = Array.prototype.slice.call(overlay.querySelectorAll("button")).filter(function (b) {
          return !b.hidden && !b.disabled && !b.closest("[hidden]");
        });
        if (!pBtns.length) return;
        var pIdx = pBtns.indexOf(active);
        if (pIdx < 0) pIdx = 0;
        if (key === "ArrowRight" || key === "ArrowDown") focusEl(pBtns[(pIdx + 1) % pBtns.length]);
        else if (key === "ArrowLeft" || key === "ArrowUp") focusEl(pBtns[(pIdx - 1 + pBtns.length) % pBtns.length]);
        else if (key === "OK") pBtns[pIdx].click();
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
