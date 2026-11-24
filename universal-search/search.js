(function (root) {
  "use strict";
  function nativeEditingKey(event, editing, finePointer) {
    return editing && (event.key === "Delete" || finePointer && event.key === "Backspace"
      || finePointer && (event.key === "ArrowLeft" || event.key === "ArrowRight"
        || event.key === "ArrowUp" || event.key === "ArrowDown"));
  }
  function adjacentHomeRow(rows, index, direction) {
    for (var next = index + direction; next >= 0 && next < rows.length; next += direction)
      if (rows[next].length) return rows[next];
    return null;
  }
  function nextHomeRowIndex(rows, index, direction) {
    for (var next = index + direction; next >= 0 && next < rows.length; next += direction)
      if (rows[next] && rows[next].length) return next;
    return -1;
  }
  function circularIndex(index, length, direction) {
    return length ? (index + direction + length) % length : -1;
  }
  function isRowShort(group, cards) {
    var count = cards ? cards.length : 0;
    return group === "continue" || count < 8;
  }
  function createApp(doc, nav, clock, options) {
    options = options || {};
    var core = root.HorizonSearchCore;
    var recommendations = root.HorizonWatchRecommendations;
    var player = root.HorizonSearchPlayer;
    var mock = root.HorizonSearchMock;
    var useMock = options.mock === true || ((nav.hostname === "localhost" || nav.hostname === "127.0.0.1")
      && new URLSearchParams(nav.search).get("mock") === "1");
    var previewScenario = new URLSearchParams(nav.search).get("preview-history");
    var artWindowExperiment = new URLSearchParams(nav.search).get("art-window") === "1";
    var previewHistoryMode = useMock && (nav.hostname === "localhost" || nav.hostname === "127.0.0.1")
      && ["1", "none", "one-show", "two-show", "south-park", "multi-ratings"].indexOf(previewScenario) >= 0;
    var local = options.localStorage;
    var session = options.sessionStorage;
    try { if (!local) local = root.localStorage; } catch (_error) { local = null; }
    try { if (!session) session = root.sessionStorage; } catch (_error) { session = null; }
    function safeStorage(backing) { var values = {};
      return { getItem: function (key) { if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
          try { return backing ? backing.getItem(key) : null; } catch (_error) { return null; } },
        setItem: function (key, value) { values[key] = String(value);
          try { if (backing) backing.setItem(key, value); } catch (_error) { /* Keep session copy. */ } } }; }
    local = safeStorage(previewHistoryMode ? null : local);
    session = safeStorage(session);
    if (previewScenario === "multi-ratings" && previewHistoryMode && recommendations) {
      recommendations.setFeedback(local, "movie", 157336, "liked");
      recommendations.setFeedback(local, "tv", 70523, "liked");
      recommendations.setFeedback(local, "tv", 124364, "disliked");
    }
    if (useMock && new URLSearchParams(nav.search).get("from") === "home-local") {
      session.setItem("horizon-search-local-home", "1");
    }
    var get = function (id) { return doc.getElementById(id); };
    var watchPerformance = useMock && new URLSearchParams(nav.search).get("watch-motion") === "1"
      && root.HorizonWatchPerformance
      ? root.HorizonWatchPerformance.create(doc, clock) : null;
    if (watchPerformance && (typeof watchPerformance.onModeChange !== "function"
        || typeof watchPerformance.heroWork !== "function")) watchPerformance = null;
    var query = get("query"), results = get("results");
    var arabicCatalog = root.HorizonArabicCatalog || null;
    var contentLibrary = typeof core.readLibraryPref === "function" ? core.readLibraryPref(local) : "standard";
    var state = { view: "watch", previousView: "watch", detailSource: "watch", filter: "all", query: "", title: null, detail: null,
      season: null, episodes: [], subtitle: core.readSubtitlePref(local), contentLibrary: contentLibrary, continueMode: false,
      watchTab: "for-you", detailSourceTab: "for-you",
      historyMode: "overview", historyFilter: "all", historyQuery: "",
      settingsCategory: null, lastSettingsCategory: "appearance" };
    var i18n = root.HorizonWatchI18n;
    var localizeStatic = i18n && i18n.capture(doc.body);
    function localize(label) { return i18n && contentLibrary === "arabic" ? i18n.ar(label) : label; }
    function applyLibraryLanguage() {
      var arabic = contentLibrary === "arabic";
      doc.documentElement.lang = arabic ? "ar" : "en";
      doc.body.classList.toggle("watch-arabic", arabic);
      if (localizeStatic) localizeStatic(arabic);
    }
    applyLibraryLanguage();
    var isSmartTvRuntime = /Vizio|SmartCast|Web0S|webOS|SmartTV|NetCast/i.test((clock.navigator && clock.navigator.userAgent) || "")
      || /(?:^\?|&)lg=1(?:&|$)/.test((nav && nav.search) || "");
    var finePointer = !!(clock.matchMedia && clock.matchMedia("(pointer: fine)").matches) && !isSmartTvRuntime;
    var hoverPointer = finePointer && !!clock.matchMedia("(hover: hover)").matches;
    doc.body.classList.toggle("watch-desktop-pointer", finePointer);
    var keyboardLang = contentLibrary === "arabic" ? "ar" : "en";
    var keyboardOpen = !finePointer || contentLibrary === "arabic";
    var historyReady = false, restoringHistory = false, historyBackPending = false, historyDepth = 0;
    var searchTimer = null, searchToken = 0, detailToken = 0, seasonToken = 0, activeAbort = null;
    var cache = new Map(), disposed = false, returningHome = false, pendingEpisodeFocus = null,
      pendingActionFocus = null,
      nextContinue = null, homeHeroEntry = null, homeDefaultEntry = null, homeHeroToken = 0,
      homeOpenPending = false, homeOpenToken = 0, homeReturnFocus = null, homeDetailCache = new Map(),
      launchingEpisode = false, clearPending = false;
    var tabRowMemory = {
      "for-you": Object.create(null),
      "tv": Object.create(null),
      "movies": Object.create(null),
      "discover": Object.create(null)
    };
    var tabLastContent = {
      "for-you": null,
      "tv": null,
      "movies": null,
      "discover": null
    };
    var tabScrollTop = {
      "for-you": 0,
      "tv": 0,
      "movies": 0,
      "discover": 0
    };
    var tvFilters = { genre: null, length: null, rating: null, year: null, sort: "best" };
    var movieFilters = { genre: null, length: null, rating: null, year: null, sort: "best" };
    var discoverFilters = { genre: null, style: "all", sort: "best" };
    var discoverStyle = "all";
    var discoverMode = "all";
    var discoverMedia = "same";
    var discoverHideFinished = true;
    var discoverActiveSeed = null;
    var discoverData = null;
    var discoverFetchToken = 0;
    var discoverLoading = false;
    var discoverError = false;
    var pickingDiscoverSeed = false;
    var activeFilterMenuType = null;
    var homeRowMemory = tabRowMemory["for-you"], homeLastContent = null;
    var rowCycleIndex = Object.create(null);
    var homeCards = Object.create(null);
    var homeCarousels = Object.create(null);
    var visibleRowGroups = [];
    var homeScrollFrame = 0, homeHeroTimer = 0, wheelFadeTimer = 0;
    var HERO_PREF_KEY = "horizon-watch-hero-preferences";
    var HERO_DELAYS = [0, 110, 150, 250, 300, 400, 500];
    function defaultAppearance() {
      return { delay: 0, fade: false, glide: true, hold: true,
        scrollAnimations: true, artworkFade: false, carouselMovement: "instant" };
    }
    function readHeroPreferences() {
      try {
        var saved = JSON.parse(local.getItem(HERO_PREF_KEY));
        if (saved && (saved.version === 1 || saved.version === 2)) {
          var result = defaultAppearance();
          if (HERO_DELAYS.indexOf(saved.delay) >= 0) result.delay = saved.delay;
          if (typeof saved.fade === "boolean") result.fade = saved.fade;
          if (saved.version === 2) ["glide", "hold", "scrollAnimations", "artworkFade"].forEach(function (key) {
            if (typeof saved[key] === "boolean") result[key] = saved[key];
          });
          if (saved.carouselMovement === "instant" || saved.carouselMovement === "glide")
            result.carouselMovement = saved.carouselMovement;
          return result;
        }
      } catch (_error) { /* Unsupported or damaged data uses safe defaults. */ }
      return defaultAppearance();
    }
    var heroPreferences = readHeroPreferences();
    function saveHeroPreferences() {
      local.setItem(HERO_PREF_KEY, JSON.stringify({ version: 2,
        delay: heroPreferences.delay, fade: heroPreferences.fade,
        glide: heroPreferences.glide, hold: heroPreferences.hold,
        scrollAnimations: heroPreferences.scrollAnimations,
        artworkFade: heroPreferences.artworkFade,
        carouselMovement: heroPreferences.carouselMovement }));
      doc.body.classList.toggle("watch-artwork-fade", heroPreferences.artworkFade);
    }
    doc.body.classList.toggle("watch-artwork-fade", heroPreferences.artworkFade);
    var catalogRequests = Object.create(null);
    var homeRowOrder = ["continue", "top", "because"];
    var recommendationPayload = null, recommendationLoadedSignature = "", recommendationPending = null,
      recommendationWantedSignature = "", recommendationRows = { top: [], because: [], seed: null };
    var previewRows = previewHistoryMode ? mock.previewHistory(previewScenario) : null;
    function currentTabRowOrder() {
      if (state.watchTab === "tv") {
        if (isFilterActive("tv")) return ["filtered"];
        return ["tv-recommended", "tv-trending", "tv-genres", "tv-short", "tv-gems", "tv-acclaimed"];
      }
      if (state.watchTab === "movies") {
        if (isFilterActive("movies")) return ["filtered"];
        return ["movies-recommended", "movies-trending", "movies-genres", "movies-short", "movies-acclaimed", "movies-gems"];
      }
      if (state.watchTab === "discover") {
        if (discoverMode === "closest") return ["discover-closest"];
        if (discoverMode === "vibe") return ["discover-vibe"];
        if (discoverMode === "genre") return ["discover-genre"];
        if (discoverMode === "gems") return ["discover-gems"];
        return ["discover-closest", "discover-vibe", "discover-genre", "discover-gems"];
      }
      return ["continue", "top", "because", "trending", "gems", "explore"];
    }
    function text(id, value) {
      var node = get(id);
      node.textContent = /(?:-title|-summary|-cast)$/.test(id) ? value : localize(value);
      if (id === "detail-title" || id === "detail-summary") node.dir = "auto";
    }
    function createPlaybackHandoff(type, id, season, episode) {
      var token = "";
      try {
        if (clock.crypto && typeof clock.crypto.getRandomValues === "function") {
          var bytes = new Uint32Array(3); clock.crypto.getRandomValues(bytes);
          token = Array.prototype.map.call(bytes, function (value) { return value.toString(36); }).join("");
        }
      } catch (_error) {}
      if (!token) return "";
      token = token.slice(0, 48);
      session.setItem(core.HANDOFF_KEY, JSON.stringify({ token: token, type: type, id: id,
        season: type === "tv" ? season : null, episode: type === "tv" ? episode : null, at: Date.now() }));
      return token;
    }
    function consumePlaybackHandoff(returned, type) {
      if (!returned || !returned.handoff) return false;
      try {
        var saved = JSON.parse(session.getItem(core.HANDOFF_KEY) || "null");
        if (!core.validHandoff(saved, returned, type, Date.now())) return false;
        session.setItem(core.HANDOFF_KEY, "");
        return true;
      } catch (_error) { return false; }
    }
    function syncRail() {
      var isWatch = state.view === "watch" || ((state.view === "details" || state.view === "episodes") && state.detailSource === "watch");
      var curTab = state.view === "watch" ? state.watchTab : (state.detailSourceTab || "for-you");
      get("watch-toggle").classList.toggle("is-current", isWatch && curTab === "for-you");
      get("tv-toggle").classList.toggle("is-current", isWatch && curTab === "tv");
      get("movies-toggle").classList.toggle("is-current", isWatch && curTab === "movies");
      var discToggle = get("discover-toggle");
      if (discToggle) discToggle.classList.toggle("is-current", isWatch && curTab === "discover");
      get("search-toggle").classList.toggle("is-current", state.view === "search" && !state.continueMode
        || (state.view === "details" || state.view === "episodes") && state.detailSource === "search");
      get("history-toggle").classList.toggle("is-current", state.view === "history"
        || (state.view === "details" || state.view === "episodes") && state.detailSource === "history");
      get("settings-toggle").classList.toggle("is-current", state.view === "settings");
    }
    function setView(name) {
      var changed = state.view !== name;
      if (changed && state.view === "watch") {
        if (homeMotion) finishHorizontalMotion();
        clearHoldOutline();
        if (watchPerformance) watchPerformance.close();
        invalidatePendingHomeHero();
        if (homeScrollFrame) clock.cancelAnimationFrame(homeScrollFrame);
        homeScrollFrame = 0;
        homeOpenToken += 1; homeOpenPending = false;
        homeRowMemory = Object.create(null); homeLastContent = null; homeReturnFocus = null;
        get("watch-rows-scroll").scrollTop = 0;
        clearWheelHeadingFade();
        homeRowOrder.forEach(function (group) { get("watch-" + group + "-row").scrollLeft = 0; });
      }
      if (changed && name === "search" && contentLibrary === "arabic") {
        keyboardOpen = true;
      }
      state.view = name;
      ["watch", "search", "details", "episodes", "history", "settings"].forEach(function (view) { get(view + "-view").hidden = view !== name; });
      if (name === "details" || name === "episodes") {
        get("details-view").hidden = false;
        get("episodes-view").hidden = !(state.title && state.title.type === "tv");
      }
      if (query) query.setAttribute("dir", contentLibrary === "arabic" ? "auto" : "ltr");
      get("keyboard").hidden = name !== "search" || !keyboardOpen;
      get("keyboard-toggle").textContent = keyboardOpen ? "Hide Keyboard" : "Show Keyboard";
      doc.body.classList.toggle("details-active", name === "details" || name === "episodes");
      doc.body.classList.toggle("episodes-active", name === "episodes");
      doc.body.classList.toggle("settings-active", name === "settings");
      doc.body.classList.toggle("watch-active", name === "watch");
      if (name !== "watch") get("watch-active-heading").hidden = true;
      syncRail();
      if (changed && historyReady && !restoringHistory && root.history && root.history.pushState) {
        try { root.history.pushState({ horizonWatchView: name, depth: ++historyDepth }, "", nav.href); }
        catch (_error) { historyDepth -= 1; }
      }
    }
    function returnWithinWatch(fallback) {
      if (historyReady && historyDepth > 0 && root.history && root.history.back) {
        if (historyBackPending) return;
        historyBackPending = true;
        restoringHistory = true;
        fallback();
        restoringHistory = false;
        root.history.back(); return;
      }
      fallback();
    }
    function restoreBrowserView(event) {
      historyBackPending = false;
      var target = event.state && event.state.horizonWatchView;
      if (["watch", "search", "details", "episodes", "history", "settings"].indexOf(target) < 0) return;
      historyDepth = Number.isInteger(event.state.depth) ? event.state.depth : 0;
      restoringHistory = true;
      setView(target);
      restoringHistory = false;
      if (target === "watch") { renderHomepage(); focusHomeTarget(); }
      else if (target === "search") focusSelectedResult();
      else if (target === "history") { renderHistory(); focus(get("history-back")); }
      else if (target === "settings") { renderSettings(); focus(get("settings-toggle")); }
      else if (target === "episodes") focus(get("episodes-back"));
      else focus(get("details-back"));
    }
    function revealInScroller(element, scroller, horizontal, inset, leadingInset) {
      if (!scroller) return;
      var item = element.getBoundingClientRect(), bounds = scroller.getBoundingClientRect();
      if (horizontal) {
        if (item.left < bounds.left + (leadingInset || inset))
          scroller.scrollLeft -= bounds.left + (leadingInset || inset) - item.left;
        else if (item.right > bounds.right - inset) scroller.scrollLeft += item.right - bounds.right + inset;
      } else {
        if (item.top < bounds.top + inset) scroller.scrollTop -= bounds.top + inset - item.top;
        else if (item.bottom > bounds.bottom - inset) scroller.scrollTop += item.bottom - bounds.bottom + inset;
      }
    }
    function revealHomeSection(element) {
      var scroller = get("watch-rows-scroll"), section = element.closest(".watch-home-section");
      if (!scroller || !section) return;
      var heading = section.querySelector("h2"), bounds = scroller.getBoundingClientRect();
      var top = heading ? heading.getBoundingClientRect().top : element.getBoundingClientRect().top;
      var bottom = element.getBoundingClientRect().bottom;
      var topInset = Math.min(30, Math.max(28, Math.round(scroller.clientHeight * .065)));
      var bottomInset = 8, available = bounds.height - topInset - bottomInset;
      if (bottom - top > available) {
        // Keep the complete card visible if a TV reports a larger text scale.
        scrollHomeRows(scroller, bottom - bounds.bottom + bottomInset);
      } else if (top < bounds.top + topInset) {
        scrollHomeRows(scroller, -(bounds.top + topInset - top));
      } else if (bottom > bounds.bottom - bottomInset) {
        scrollHomeRows(scroller, bottom - bounds.bottom + bottomInset);
      }
    }
    function clearWheelHeadingFade() {
      if (wheelFadeTimer) clock.clearTimeout(wheelFadeTimer);
      wheelFadeTimer = 0;
      var heading = get("watch-active-heading");
      if (heading) heading.classList.remove("is-wheel-fading");
    }
    function triggerWheelHeadingFade() {
      if (state.view !== "watch") return;
      var heading = get("watch-active-heading");
      if (heading && !heading.hidden) heading.classList.add("is-wheel-fading");
      if (wheelFadeTimer) clock.clearTimeout(wheelFadeTimer);
      wheelFadeTimer = clock.setTimeout(function () {
        wheelFadeTimer = 0;
        var currentHeading = get("watch-active-heading");
        if (currentHeading) currentHeading.classList.remove("is-wheel-fading");
      }, 180);
    }
    function scrollHomeRows(scroller, delta) {
      var destination = scroller.scrollTop + delta;
      if (homeScrollFrame) clock.cancelAnimationFrame(homeScrollFrame);
      homeScrollFrame = 0;
      if (!heroPreferences.scrollAnimations || !clock.requestAnimationFrame || !clock.cancelAnimationFrame || !clock.matchMedia
          || clock.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        scroller.scrollTop = destination; return;
      }
      var start = scroller.scrollTop, began = 0;
      function frame(now) {
        if (!began) began = now;
        var progress = Math.min(1, (now - began) / 200), eased = 1 - Math.pow(1 - progress, 3);
        scroller.scrollTop = start + (destination - start) * eased;
        homeScrollFrame = progress < 1 ? clock.requestAnimationFrame(frame) : 0;
      }
      homeScrollFrame = clock.requestAnimationFrame(frame);
    }
    function syncActiveHomeHeading(element, force) {
      var heading = get("watch-active-heading"), section = element && element.closest(".watch-home-section");
      var original = section && section.querySelector("h2");
      var previousSection = doc.querySelector("#watch-rows-scroll .is-active-home-section");
      if (!force && section && section === previousSection && !heading.hidden
          && heading.textContent === original.textContent) return;
      if (previousSection && previousSection !== section)
        previousSection.classList.remove("is-active-home-section");
      heading.hidden = !section || state.view !== "watch";
      if (!heading.hidden) {
        section.classList.add("is-active-home-section");
        var home = get("watch-view").getBoundingClientRect();
        heading.textContent = original.textContent;
        var poster = element.querySelector(".poster-art");
        var posterTop = poster ? poster.getBoundingClientRect().top : original.getBoundingClientRect().bottom + 42;
        // The overlay lives outside the clipped row viewport. Position it from
        // the artwork, preserving the 42px visual gap even when a short viewport
        // places the heading in the hero's bottom fade.
        heading.style.top = (posterTop - 42 - heading.getBoundingClientRect().height - home.top) + "px";
      }
    }
    function focus(element, skipHomeVertical, direction) { if (element) {
      if (holdSettleRow && element.dataset.homeGroup !== holdSettleGroup) clearHoldOutline();
      var previous = doc.querySelector("[data-focus].is-focused");
      var previousHomeGroup = previous && previous.dataset.homeGroup || "";
      if (previous && previous !== element) previous.classList.remove("is-focused");
      if (element.dataset.homeGroup) element = revealHomeWindow(element, direction) || element;
      else if (previousHomeGroup && element.closest(".watch-rail")) {
        var prevController = homeCarousels[previousHomeGroup];
        if (prevController) {
          if (prevController.wrapTimer) clock.clearTimeout(prevController.wrapTimer);
          prevController.wrapTimer = 0;
          var pCycleStart = Math.floor(prevController.selected / prevController.cards.length) * prevController.cards.length;
          prunePreviousCycleSlots(prevController, pCycleStart);
        }
      }
      if (!element.isConnected && element.dataset.homeGroup) {
        var ctrl = homeCarousels[element.dataset.homeGroup];
        if (ctrl && ctrl.track) {
          var attached = ctrl.track.querySelector('[data-home-index="' + element.dataset.homeIndex + '"]');
          if (attached) element = attached;
          else if (ctrl.track.firstElementChild) element = ctrl.track.firstElementChild;
        }
      }
      element.focus({ preventScroll: true }); element.classList.add("is-focused");
      if (watchPerformance) watchPerformance.focusApplied();
      var seasonStrip = element.closest("#seasons");
      var episodeScroll = element.closest("#episode-list");
      var resultScroll = element.closest("#results, #history-list, #settings-view");
      var homeScroll = element.closest(".watch-home-row");
      if (seasonStrip) {
        revealInScroller(element, seasonStrip, true, 14);
        var dropdown = element.closest("#seasons-dropdown");
        if (dropdown) revealInScroller(element, dropdown, false, 8);
      }
      else if (episodeScroll) {
        revealInScroller(element, episodeScroll, false, 18);
        revealInScroller(element, episodeScroll, true, 24);
      }
      var detailScroller = element.closest("#detail-scroller");
      if (detailScroller && !seasonStrip) {
        revealInScroller(element, detailScroller, false, 48);
      }
      else if (homeScroll && !homeScroll.classList.contains("is-virtualized")) {
        var railEdge = get("watch-toggle").getBoundingClientRect().right;
        revealInScroller(element, homeScroll, true, 18,
          Math.max(18, railEdge - homeScroll.getBoundingClientRect().left + 22));
      }
      else if (resultScroll) revealInScroller(element, resultScroll, false, 18);
      if (!skipHomeVertical && element.closest("#watch-rows-scroll")
          && previousHomeGroup !== element.dataset.homeGroup)
        revealHomeSection(element);
      syncActiveHomeHeading(element);
      if (state.view === "watch" && element.dataset.homeGroup) {
        var identity = homeFocusIdentity(element);
        homeRowMemory[identity.group] = identity; homeLastContent = identity;
        if (tabRowMemory[state.watchTab]) tabRowMemory[state.watchTab][identity.group] = identity;
        tabLastContent[state.watchTab] = identity;
      }
    } }
    function button(label, click, className) {
      var el = doc.createElement("button"); el.type = "button"; el.textContent = localize(label);
      el.dataset.focus = "1"; if (className) el.className = className;
      el.addEventListener("click", click); return el;
    }
    function detailAction(label, click, className, action) {
      var el = button(label, function () { if (this.getAttribute("aria-disabled") !== "true") click(); }, className);
      el.dataset.action = action;
      return el;
    }
    function saveView() {
      try { if (session) session.setItem(core.STATE_KEY, JSON.stringify({ version: 1, view: state.view,
        filter: state.filter, query: state.query, type: state.title && state.title.type,
        id: state.title && state.title.id, season: state.season, subtitle: state.subtitle,
        source: state.detailSource })); }
      catch (_error) { /* Return falls back to search. */ }
    }
    function api(path, signal) {
      if (arabicCatalog) {
        var arUrl = new URL(path, "https://example.invalid");
        var arBits = arUrl.pathname.split("/");
        if (arBits[2] === "title") {
          var reqId = Number(arBits[4]);
          var arTitle = arabicCatalog.findByKey(arBits[3], reqId);
          var isRoyaSynth = contentLibrary === "arabic" && root.HorizonRoyaCatalog
            && typeof root.HorizonRoyaCatalog.toRoyaIdFromWatchId === "function"
            && root.HorizonRoyaCatalog.toRoyaIdFromWatchId(reqId);
          if (arTitle || isRoyaSynth || contentLibrary === "arabic") {
            if (typeof arabicCatalog.fetchDetailAsync === "function") {
              return arabicCatalog.fetchDetailAsync(arBits[3], reqId, signal);
            }
            if (arTitle) return Promise.resolve(arabicCatalog.toDetailPayload(arTitle));
          }
        }
        if (arBits[2] === "season" && arBits[3] === "tv") {
          var sReqId = Number(arBits[4]);
          var sTitle = arabicCatalog.findByKey("tv", sReqId);
          var sIsRoya = contentLibrary === "arabic" && root.HorizonRoyaCatalog
            && typeof root.HorizonRoyaCatalog.toRoyaIdFromWatchId === "function"
            && root.HorizonRoyaCatalog.toRoyaIdFromWatchId(sReqId);
          if (sTitle || sIsRoya || contentLibrary === "arabic") {
            if (typeof arabicCatalog.fetchSeasonAsync === "function") {
              return arabicCatalog.fetchSeasonAsync(sReqId, Number(arBits[5]), signal);
            }
            var arSeason = arabicCatalog.toSeasonPayload(sReqId, Number(arBits[5]));
            if (arSeason) return Promise.resolve(arSeason);
          }
        }
        if (contentLibrary === "arabic") {
          if (arBits[2] === "search") {
            var qParam = arUrl.searchParams.get("q") || "";
            var tParam = arUrl.searchParams.get("type") || "all";
            var pParam = Number(arUrl.searchParams.get("page")) || 1;
            if (typeof arabicCatalog.searchAsync === "function") {
              return arabicCatalog.searchAsync(qParam, tParam, { page: pParam, pageSize: 24, signal: signal });
            }
            return Promise.resolve({
              results: arabicCatalog.search(qParam, tParam)
            });
          }
          if (arBits[2] === "discover" && typeof arabicCatalog.filterDiscover === "function") {
            return Promise.resolve(arabicCatalog.filterDiscover(arUrl.searchParams));
          }
          if (arBits[2] === "discover-similar" && typeof arabicCatalog.similarTitles === "function") {
            return Promise.resolve(arabicCatalog.similarTitles(
              arUrl.searchParams.get("type"),
              arUrl.searchParams.get("id"),
              arUrl.searchParams.get("target"),
              arUrl.searchParams.get("avoid")
            ));
          }
        }
      }
      if (useMock) return Promise.resolve().then(function () {
        var parsed = new URL(path, "https://example.invalid");
        var bits = parsed.pathname.split("/");
        var value = bits[2] === "search" ? mock.search(parsed.searchParams.get("q") || "", parsed.searchParams.get("type") || "all")
          : bits[2] === "discover" ? (mock.discover ? mock.discover(parsed.searchParams) : { results: [] })
          : bits[2] === "discover-similar" ? (mock.discoverSimilar ? mock.discoverSimilar(parsed.searchParams.get("type"), parsed.searchParams.get("id"), parsed.searchParams.get("target"), parsed.searchParams.get("avoid")) : { seed: null, candidates: [] })
          : bits[2] === "title" ? mock.title(bits[3], Number(bits[4]))
          : mock.season(Number(bits[4]), Number(bits[5]));
        if (!value) throw Error("not_found");
        return value;
      });
      var request = options.request || root.fetch.bind(root);
      var controller = new AbortController();
      if (signal) signal.addEventListener("abort", function () { controller.abort(); });
      var timer = clock.setTimeout(function () { controller.abort(); }, 6000);
      return request(path, { credentials: "same-origin", signal: controller.signal })
        .then(function (response) { if (!response.ok) {
          var error = Error("metadata_unavailable"); error.status = response.status;
          var retry = Number(response.headers && response.headers.get("Retry-After"));
          error.retryAfter = Number.isFinite(retry) ? Math.max(0, Math.min(60, Math.ceil(retry))) : 0;
          throw error;
        } return response.json(); })
        .finally(function () { clock.clearTimeout(timer); });
    }
    function poster(path, kind, defer) {
      var url = core.imageUrl(path, defer && kind === "poster" && artWindowExperiment ? "poster-small" : kind);
      if (!url) return null;
      var img = doc.createElement("img");
      if (defer) img.dataset.pendingSrc = url; else img.src = url;
      img.loading = "lazy"; img.alt = "";
      return img;
    }
    function landscapeArt(row, defer) {
      var art = doc.createElement("span"); art.className = "poster-art";
      function fallback() { Array.from(art.querySelectorAll("img, .art-fallback")).forEach(function (node) { node.remove(); });
        var label = doc.createElement("span"); label.className = "art-fallback"; label.textContent = row.title;
        art.insertBefore(label, art.firstChild);
      }
      var image = poster(row.backdrop || row.poster, row.backdrop ? "backdrop" : "poster", defer);
      if (!image) { fallback(); return art; }
      if (!row.backdrop) art.classList.add("has-poster");
      var triedPoster = !row.backdrop;
      image.addEventListener("error", function () {
        if (!triedPoster && row.poster) {
          triedPoster = true; art.classList.add("has-poster"); image.src = core.imageUrl(row.poster, "poster");
        } else fallback();
      });
      art.appendChild(image); return art;
    }
    function verticalPosterArt(row, defer) {
      var art = doc.createElement("span"); art.className = "poster-art is-vertical-poster";
      function fallback() { art.replaceChildren(); art.classList.remove("is-loaded");
        var label = doc.createElement("span"); label.className = "art-fallback"; label.textContent = row.title;
        art.appendChild(label);
      }
      var posterPath = row.poster || row.backdrop;
      var image = poster(posterPath, row.poster ? "poster" : "backdrop", defer);
      if (!image) { fallback(); return art; }
      fallback();
      image.addEventListener("load", function () { if (image.naturalWidth) art.classList.add("is-loaded"); });
      var triedBackdrop = !row.poster;
      image.addEventListener("error", function () {
        if (!triedBackdrop && row.backdrop) {
          triedBackdrop = true; image.src = core.imageUrl(row.backdrop, "backdrop");
        } else fallback();
      });
      art.appendChild(image);
      if (image.complete && image.naturalWidth) art.classList.add("is-loaded");
      return art;
    }
    function homeFocusIdentity(element) {
      if (!element || !element.closest || !element.closest("#watch-view")) return null;
      var row = element.closest(".watch-home-row");
      return { id: element.id || "", group: element.dataset.homeGroup || "",
        key: element.dataset.homeKey || "", index: row ? Number(element.dataset.homeIndex) : -1 };
    }
    function homeRowButtons(group) {
      var host = get("watch-" + group + "-row");
      return host && !host.closest("[hidden]") ? homeCards[group] || [] : [];
    }
    function visibleHomeRowOrder() {
      return visibleRowGroups;
    }
    function recordHomeCards(group) {
      var row = get("watch-" + group + "-row"), track = row.querySelector(".watch-home-track");
      if (homeMotion && homeMotion.group === group) finishHorizontalMotion();
      homeCards[group] = Array.from(track.querySelectorAll(".home-card"));
      homeCards[group].forEach(function (card, index) { card.dataset.homeIndex = String(index); });
      if (homeCarousels[group] && homeCarousels[group].trimTimer)
        clock.clearTimeout(homeCarousels[group].trimTimer);
      if (homeCarousels[group] && homeCarousels[group].wrapTimer)
        clock.clearTimeout(homeCarousels[group].wrapTimer);
      delete homeCarousels[group];
      track.replaceChildren();
      track.style.transform = "";
      track.style.height = "";
      row.classList.add("is-virtualized"); track.classList.add("is-virtualized");
    }
    function prunePreviousCycleSlots(controller, cycleStart) {
      var track = controller.track;
      var first = track.firstElementChild;
      while (first && Number(first.dataset.homeOrdinal) < cycleStart) {
        var ord = first.dataset.homeOrdinal;
        delete controller.slots[ord];
        track.removeChild(first);
        first.classList.remove("is-focused");
        controller.pool.push(first);
        if (controller.pool.length > controller.capacity) controller.pool.shift();
        first = track.firstElementChild;
      }
      controller.start = first ? Number(first.dataset.homeOrdinal) : cycleStart;
    }
    function carouselSlot(controller, ordinal) {
      var source = controller.cards[ordinal % controller.cards.length];
      var pool = controller.pool || [];
      var reused = pool.findIndex(function (card) { return card.dataset.homeKey === source.dataset.homeKey; });
      var slot = reused >= 0 ? pool.splice(reused, 1)[0] : source.cloneNode(true);
      if (reused >= 0) slot.classList.remove("is-focused");
      slot.removeAttribute("id");
      slot.dataset.homeIndex = source.dataset.homeIndex;
      slot.dataset.homeOrdinal = String(ordinal);
      slot.style.left = ((controller.step || 0) * ordinal) + "px";
      slot.homeEntry = source.homeEntry;
      if (reused < 0) {
        slot.addEventListener("click", function () { source.click(); });
        slot.querySelectorAll("img").forEach(function (image) {
          var art = image.closest(".poster-art");
          image.addEventListener("load", function () { if (art) art.classList.add("is-loaded"); });
          image.addEventListener("error", function () {
            if (art) {
              image.remove(); art.classList.remove("is-loaded");
              if (!art.querySelector(".art-fallback")) {
                var fallback = doc.createElement("span");
                fallback.className = "art-fallback";
                fallback.textContent = source.homeEntry.row.title;
                art.appendChild(fallback);
              }
            }
          });
          if (image.dataset.pendingSrc) {
            image.src = image.dataset.pendingSrc;
            delete image.dataset.pendingSrc;
          }
          if (image.complete && image.naturalWidth && art) art.classList.add("is-loaded");
        });
      }
      return slot;
    }
    var homeMotion = null, holdRepeatCount = 0, holdSettleTimer = 0,
      holdSettleRow = null, holdSettleGroup = "";
    var edgeIntentTimer = 0, edgeMotionGroup = "", edgePointerX = 0, edgePointerY = 0,
      edgeLastMoveAt = 0, hoverHeroTimer = 0, hoverHeroCard = null, pointerHeroActive = false;
    function cancelHoverHero() {
      if (hoverHeroTimer) clock.clearTimeout(hoverHeroTimer);
      hoverHeroTimer = 0; hoverHeroCard = null;
    }
    function scheduleHoverHero(card) {
      cancelHoverHero();
      if (!hoverPointer || !pointerHeroActive || !card || !card.homeEntry || state.view !== "watch"
          || homeMotion && homeMotion.mode === "edge") return;
      hoverHeroCard = card;
      hoverHeroTimer = clock.setTimeout(function () {
        hoverHeroTimer = 0;
        if (hoverHeroCard === card && card.isConnected && pointerHeroActive
            && !(homeMotion && homeMotion.mode === "edge")) showHomeHero(card.homeEntry);
      }, 160);
    }
    function stopEdgeMotion() {
      if (edgeIntentTimer) clock.clearTimeout(edgeIntentTimer);
      edgeIntentTimer = 0; edgeMotionGroup = "";
      if (homeMotion && homeMotion.mode === "edge") {
        homeMotion.target = Math.max(homeMotion.minTarget,
          Math.min(homeMotion.maxTarget, Math.round(homeMotion.position)));
        homeMotion.mode = "target";
      }
    }
    function startEdgeMotion(group, direction) {
      if (state.view !== "watch" || homeMotion || !hoverPointer) return;
      var controller = homeCarousels[group];
      if (!controller || controller.fits || controller.cards.length < 2) return;
      var current = Math.max(0, -carouselX(controller.track) / controller.step);
      var short = isRowShort(group, controller.cards);
      var minimum = short ? 0 : Math.floor(controller.selected / controller.cards.length) * controller.cards.length;
      var maximum = short ? controller.cards.length - 1 : Infinity;
      if (direction < 0 && current <= minimum || direction > 0 && current >= maximum) return;
      cancelHoverHero(); invalidatePendingHomeHero();
      controller.row.classList.add("is-hold-scrolling");
      var now = clock.performance && clock.performance.now ? clock.performance.now() : Date.now();
      homeMotion = { controller: controller, group: group, mode: "edge", passive: true,
        direction: direction, position: current, target: current, committedOrdinal: controller.selected,
        minTarget: minimum, maxTarget: maximum, isShort: short, cycleStart: minimum,
        lastFrame: now, frame: 0, inactivityTimer: 0 };
      homeMotion.frame = clock.requestAnimationFrame(motionFrame);
    }
    function isRowShort(group, cards) {
      var count = cards ? cards.length : 0;
      return group === "continue" || count < 8;
    }
    function doesRowFit(controller) {
      if (!controller || !controller.row) return false;
      var available = controller.row.clientWidth - (controller.gutter || 0);
      var total = (controller.cards ? controller.cards.length : 0) * (controller.step || 0);
      return total <= available;
    }
    function clearHoldOutline() {
      if (holdSettleTimer) clock.clearTimeout(holdSettleTimer);
      holdSettleTimer = 0;
      if (holdSettleRow) holdSettleRow.classList.remove("is-hold-scrolling");
      holdSettleRow = null; holdSettleGroup = "";
    }
    function ensureHoldSlots(controller, first, last) {
      var minimum = Math.max(0, first), maximum = Math.max(minimum, last);
      while (controller.start > minimum) {
        if (controller.track.childElementCount >= controller.capacity) {
          var oldLast = controller.track.lastElementChild;
          if (oldLast && oldLast !== doc.activeElement && Number(oldLast.dataset.homeOrdinal) > maximum) {
            delete controller.slots[oldLast.dataset.homeOrdinal];
            oldLast.remove();
            controller.pool.push(oldLast);
            controller.end = controller.track.lastElementChild ? Number(controller.track.lastElementChild.dataset.homeOrdinal) : controller.end - 1;
          }
        }
        controller.start -= 1;
        var before = carouselSlot(controller, controller.start);
        controller.slots[controller.start] = before;
        controller.track.insertBefore(before, controller.track.firstElementChild);
      }
      while (controller.end < maximum) {
        if (controller.track.childElementCount >= controller.capacity) {
          var oldFirst = controller.track.firstElementChild;
          var visualMinimum = homeMotion && homeMotion.controller === controller
            ? Math.floor(homeMotion.position) - 2 : minimum;
          if (oldFirst && oldFirst !== doc.activeElement
              && Number(oldFirst.dataset.homeOrdinal) < Math.min(minimum, visualMinimum)) {
            delete controller.slots[oldFirst.dataset.homeOrdinal];
            oldFirst.remove();
            controller.pool.push(oldFirst);
            controller.start = controller.track.firstElementChild ? Number(controller.track.firstElementChild.dataset.homeOrdinal) : controller.start + 1;
          }
        }
        controller.end += 1;
        var after = carouselSlot(controller, controller.end);
        controller.slots[controller.end] = after;
        controller.track.appendChild(after);
      }
    }
    function trimHoldSlots(controller, position) {
      var minimum = Math.max(0, Math.floor(position) - 2);
      var maximum = Math.ceil(position) + controller.visible + 3;
      while (controller.start < minimum && controller.track.firstElementChild) {
        var first = controller.track.firstElementChild;
        if (first === doc.activeElement && homeMotion && homeMotion.passive) {
          var second = first.nextElementSibling;
          if (!second || Number(second.dataset.homeOrdinal) >= minimum) break;
          delete controller.slots[second.dataset.homeOrdinal]; second.remove();
          controller.pool.push(second);
          continue;
        }
        delete controller.slots[controller.start++]; first.remove();
        controller.pool.push(first);
      }
      while (controller.end > maximum && controller.track.lastElementChild) {
        var last = controller.track.lastElementChild;
        if (last === doc.activeElement && homeMotion && homeMotion.passive) {
          var beforeLast = last.previousElementSibling;
          if (!beforeLast || Number(beforeLast.dataset.homeOrdinal) <= maximum) break;
          delete controller.slots[beforeLast.dataset.homeOrdinal]; beforeLast.remove();
          controller.pool.push(beforeLast);
          continue;
        }
        delete controller.slots[controller.end--]; last.remove();
        controller.pool.push(last);
      }
      while (controller.pool.length > controller.capacity) controller.pool.shift();
    }
    function motionFrame(timestamp) {
      var motion = homeMotion;
      if (!motion) return;
      var elapsed = Math.min(40, Math.max(0, timestamp - motion.lastFrame));
      motion.lastFrame = timestamp;
      var controller = motion.controller, track = controller.track;

      if (motion.mode === "hold" || motion.mode === "edge") {
        var next = motion.position + motion.direction * elapsed * (motion.mode === "edge" ? 0.00165 : 0.0048);
        if (motion.direction < 0) next = Math.max(motion.minTarget, next);
        if (motion.direction > 0 && motion.isShort) next = Math.min(motion.maxTarget, next);
        motion.position = next;

        if (!motion.isShort) {
          ensureHoldSlots(controller, Math.max(motion.cycleStart, Math.floor(next) - 2),
            Math.ceil(next) + controller.visible + 3);
          trimHoldSlots(controller, next);
        }
        track.style.transform = "translate3d(" + (-next * controller.step) + "px,0,0)";

        if (motion.direction < 0 && next <= motion.minTarget) {
          if (motion.mode === "edge") stopEdgeMotion();
          else { finishHorizontalMotion(); return; }
        }
        if (motion.direction > 0 && motion.isShort && next >= motion.maxTarget) {
          if (motion.mode === "edge") stopEdgeMotion();
          else { finishHorizontalMotion(); return; }
        }
        if (motion.mode === "edge" && Date.now() - edgeLastMoveAt > 6000) stopEdgeMotion();
      } else {
        var diff = motion.target - motion.position;
        if (Math.abs(diff) < 0.005) {
          motion.position = motion.target;
          track.style.transform = "translate3d(" + (-motion.target * controller.step) + "px,0,0)";
          finishHorizontalMotion();
          return;
        }
        var distance = Math.abs(diff);
        // Glide Off keeps spatially continuous movement, but omits the slow
        // decorative ease. A one-frame position jump would violate wrapping.
        var speed = heroPreferences.glide ? Math.max(0.018, distance * 0.22) : 0.35;
        var delta = Math.min(distance, speed * (elapsed / 16.7), 0.35 * (elapsed / 16.7));
        var nextPos = motion.position + Math.sign(diff) * delta;
        motion.position = nextPos;

        if (!motion.isShort) {
          ensureHoldSlots(controller, Math.max(motion.cycleStart, Math.floor(nextPos) - 2),
            Math.ceil(nextPos) + controller.visible + 3);
          trimHoldSlots(controller, nextPos);
        }
        track.style.transform = "translate3d(" + (-nextPos * controller.step) + "px,0,0)";
      }

      motion.frame = clock.requestAnimationFrame(motionFrame);
    }
    function finishHorizontalMotion() {
      var motion = homeMotion;
      if (!motion) return;
      homeMotion = null; holdMotion = null; holdRepeatCount = 0;
      clock.cancelAnimationFrame(motion.frame);
      clock.clearTimeout(motion.inactivityTimer);

      var controller = motion.controller, track = controller.track;
      var isShort = motion.isShort;
      var target;
      if (motion.mode === "hold") {
        target = Math.round(motion.position);
        target = motion.direction > 0 ? Math.max(target, motion.committedOrdinal)
          : Math.min(target, motion.committedOrdinal);
        target = Math.max(motion.minTarget, Math.min(motion.maxTarget, target));
      } else {
        target = motion.target;
      }

      controller.selected = target;
      track.style.transform = "translate3d(" + (-target * controller.step) + "px,0,0)";

      if (!isShort) {
        var cycleStart = Math.floor(target / controller.cards.length) * controller.cards.length;
        if (!motion.passive) prunePreviousCycleSlots(controller, cycleStart);
        ensureHoldSlots(controller, Math.max(cycleStart, target - 2), target + controller.visible + 3);
        rowCycleIndex[motion.group] = target % controller.cards.length;
      } else {
        rowCycleIndex[motion.group] = target;
      }

      var slot = controller.slots[target];
      if (!slot && isShort) slot = controller.cards[target];
      if (slot && !motion.passive) {
        var previous = doc.querySelector("[data-focus].is-focused");
        if (previous && previous !== slot) previous.classList.remove("is-focused");
        slot.focus({ preventScroll: true });
        slot.classList.add("is-focused");
        if (watchPerformance) watchPerformance.focusApplied();
        var identity = homeFocusIdentity(slot);
        if (identity) {
          homeRowMemory[identity.group] = identity;
          homeLastContent = identity;
          if (tabRowMemory[state.watchTab]) tabRowMemory[state.watchTab][identity.group] = identity;
          tabLastContent[state.watchTab] = identity;
        }
        syncActiveHomeHeading(slot);
        showHomeHero(slot.homeEntry);
      }

      if (holdSettleTimer) clock.clearTimeout(holdSettleTimer);
      holdSettleRow = controller.row; holdSettleGroup = motion.group;
      holdSettleTimer = clock.setTimeout(clearHoldOutline, 170);
      if (motion.passive && pointerHeroActive) {
        var underneath = doc.elementFromPoint(edgePointerX, edgePointerY);
        scheduleHoverHero(underneath && underneath.closest(".home-card"));
      }
    }
    function renewMotionInactivity() {
      if (!homeMotion) return;
      clock.clearTimeout(homeMotion.inactivityTimer);
      holdMotion = homeMotion;
      holdMotion.inactivityTimer = clock.setTimeout(finishHoldMotion, 240);
    }
    function stepHorizontalMotion(groupName, direction, isHold) {
      if (!isHold && heroPreferences.carouselMovement !== "glide") return false;
      if (homeMotion && homeMotion.mode === "edge") stopEdgeMotion();
      var controller = homeCarousels[groupName];
      if (!controller || controller.cards.length < 1 || state.view !== "watch") return false;
      var row = controller.row, track = controller.track;
      var isShort = isRowShort(groupName, controller.cards);
      var minTarget = isShort ? 0 : Math.floor(controller.selected / controller.cards.length) * controller.cards.length;
      var maxTarget = isShort ? controller.cards.length - 1 : Infinity;

      if (controller.isShort && controller.fits) return false;
      if (direction < 0 && (controller.selected <= minTarget || (homeMotion && homeMotion.target <= minTarget))) {
        if (homeMotion) finishHorizontalMotion();
        return false;
      }
      if (direction > 0 && isShort && (controller.selected >= maxTarget || (homeMotion && homeMotion.target >= maxTarget))) return true;

      if (holdSettleTimer) clock.clearTimeout(holdSettleTimer);
      holdSettleTimer = 0;
      if (controller.trimTimer) clock.clearTimeout(controller.trimTimer);

      var currentX = carouselX(track);
      var currentPos = Math.max(0, -currentX / controller.step);

      row.style.setProperty("--hold-outline-width", controller.width + "px");
      var focused = doc.activeElement;
      var poster = focused && focused.querySelector ? focused.querySelector(".poster-art") : null;
      var posterHeight = poster ? poster.getBoundingClientRect().height : (controller.width * 1.5);
      row.style.setProperty("--hold-outline-height", posterHeight + "px");
      row.classList.add("is-hold-scrolling");

      track.style.transition = "none";
      invalidatePendingHomeHero();

      if (homeMotion && homeMotion.group === groupName) {
        if (isHold) {
          homeMotion.mode = "hold";
          homeMotion.direction = direction;
        } else {
          homeMotion.mode = "target";
          var nextTarget = homeMotion.target + direction;
          nextTarget = Math.max(minTarget, Math.min(maxTarget, nextTarget));
          homeMotion.target = nextTarget;
          homeMotion.direction = direction;
          homeMotion.committedOrdinal = nextTarget;
          controller.selected = nextTarget;
          if (!isShort) {
            ensureHoldSlots(controller, Math.max(minTarget, nextTarget - 2), nextTarget + controller.visible + 3);
          }
          var targetSlot = controller.slots[nextTarget] || (isShort ? controller.cards[nextTarget] : null);
          if (targetSlot) {
            var prev = doc.querySelector("[data-focus].is-focused");
            if (prev && prev !== targetSlot) prev.classList.remove("is-focused");
            targetSlot.focus({ preventScroll: true });
            targetSlot.classList.add("is-focused");
            if (watchPerformance) watchPerformance.focusApplied();
            var id = homeFocusIdentity(targetSlot);
            if (id) {
              homeRowMemory[id.group] = id; homeLastContent = id;
              if (tabRowMemory[state.watchTab]) tabRowMemory[state.watchTab][id.group] = id;
              tabLastContent[state.watchTab] = id;
            }
            syncActiveHomeHeading(targetSlot);
            showHomeHero(targetSlot.homeEntry);
          }
        }
        renewMotionInactivity();
        return true;
      }

      var initialTarget = controller.selected + direction;
      initialTarget = Math.max(minTarget, Math.min(maxTarget, initialTarget));
      if (!isHold && initialTarget === controller.selected && Math.abs(currentPos - initialTarget) < 0.005) {
        return false;
      }

      if (!isHold) {
        controller.selected = initialTarget;
        if (!isShort) {
          ensureHoldSlots(controller, Math.max(minTarget, initialTarget - 2), initialTarget + controller.visible + 3);
        }
        var initSlot = controller.slots[initialTarget] || (isShort ? controller.cards[initialTarget] : null);
        if (initSlot) {
          var prevInit = doc.querySelector("[data-focus].is-focused");
          if (prevInit && prevInit !== initSlot) prevInit.classList.remove("is-focused");
          initSlot.focus({ preventScroll: true });
          initSlot.classList.add("is-focused");
          if (watchPerformance) watchPerformance.focusApplied();
          var initId = homeFocusIdentity(initSlot);
          if (initId) {
            homeRowMemory[initId.group] = initId; homeLastContent = initId;
            if (tabRowMemory[state.watchTab]) tabRowMemory[state.watchTab][initId.group] = initId;
            tabLastContent[state.watchTab] = initId;
          }
          syncActiveHomeHeading(initSlot);
          showHomeHero(initSlot.homeEntry);
        }
      }

      var now = clock.performance && clock.performance.now ? clock.performance.now() : Date.now();
      homeMotion = {
        controller: controller,
        group: groupName,
        mode: isHold ? "hold" : "target",
        direction: direction,
        position: currentPos,
        target: initialTarget,
        committedOrdinal: initialTarget,
        minTarget: minTarget,
        maxTarget: maxTarget,
        isShort: isShort,
        cycleStart: minTarget,
        lastFrame: now,
        frame: 0,
        inactivityTimer: 0
      };
      renewMotionInactivity();
      homeMotion.frame = clock.requestAnimationFrame(motionFrame);
      return true;
    }
    // Backwards-compatible aliases
    var holdMotion = null;
    function holdFrame(timestamp) { return motionFrame(timestamp); }
    function finishHoldMotion() {
      var motion = homeMotion;
      if (!motion) return;
      clock.clearTimeout(motion.inactivityTimer);
      motion.inactivityTimer = 0;
      if (motion.mode === "hold") {
        motion.target = Math.max(motion.minTarget,
          Math.min(motion.maxTarget, Math.round(motion.position)));
        motion.mode = "target";
      }
      // Keyup releases control; the existing rAF movement completes the
      // selection without snapping by as much as half a poster.
      holdMotion = null;
      holdRepeatCount = 0;
    }
    function startHoldMotion(key) {
      var focused = doc.activeElement, group = focused && focused.dataset.homeGroup;
      return stepHorizontalMotion(group, key === "ArrowRight" ? 1 : -1, true);
    }
    function renewHoldInactivity() { return renewMotionInactivity(); }
    function carouselX(track) {
      var value = clock.getComputedStyle(track).transform;
      if (!value || value === "none") return 0;
      var parts = value.match(/^matrix(?:3d)?\((.*)\)$/);
      if (!parts) return 0;
      var numbers = parts[1].split(",").map(Number);
      return numbers.length === 16 ? numbers[12] : numbers[4];
    }
    function trimHomeCarousel(controller, inFlight) {
      var row = controller.row, track = controller.track;
      if (!track.isConnected || !track.firstElementChild) return true;
      if (row.closest("[hidden]")) return true;
      var expectedX = -controller.selected * controller.step;
      var x = carouselX(track);
      if (!inFlight && Math.abs(x - expectedX) > .75) return false;
      var cycleStart = Math.floor(controller.selected / controller.cards.length) * controller.cards.length;
      var first = track.firstElementChild;
      // Absolute slots do not reflow their neighbors when an offscreen node leaves.
      while (first && first !== doc.activeElement
          && (Number(first.dataset.homeOrdinal) < cycleStart
            || (track.childElementCount > controller.capacity
              && controller.gutter + Number(first.dataset.homeOrdinal) * controller.step
                + x + controller.width < -controller.step))) {
        delete controller.slots[first.dataset.homeOrdinal];
        track.removeChild(first);
        first.classList.remove("is-focused");
        controller.pool.push(first);
        if (controller.pool.length > controller.capacity) controller.pool.shift();
        first = track.firstElementChild;
      }
      controller.start = first ? Number(first.dataset.homeOrdinal) : cycleStart;
      var last = track.lastElementChild;
      while (track.childElementCount > controller.capacity
          && last && last !== doc.activeElement
          && Number(last.dataset.homeOrdinal) > controller.selected + controller.visible + 1
          && controller.gutter + Number(last.dataset.homeOrdinal) * controller.step
            + x > row.clientWidth + controller.step) {
        delete controller.slots[last.dataset.homeOrdinal];
        track.removeChild(last);
        last.classList.remove("is-focused");
        controller.pool.push(last);
        if (controller.pool.length > controller.capacity) controller.pool.shift();
        last = track.lastElementChild;
      }
      controller.end = last ? Number(last.dataset.homeOrdinal) : controller.start;
      return true;
    }
    function revealHomeWindow(element, direction) {
      var group = element.dataset.homeGroup, cards = homeCards[group];
      if (!cards || !cards.length) return element;
      var row = get("watch-" + group + "-row"), track = row.querySelector(".watch-home-track");
      // Async rows can be populated while their destination is hidden. Never
      // cache measurements from a zero-sized row: they collapse poster tracks.
      if (!row.getClientRects().length || !row.clientWidth) return element;
      var controller = homeCarousels[group];
      var isShort = isRowShort(group, cards);
      if (!controller) {
        var firstSlot = carouselSlot({ cards: cards }, 0);
        track.appendChild(firstSlot);
        var rowStyle = clock.getComputedStyle(row);
        var gap = parseFloat(rowStyle.columnGap);
        if (!Number.isFinite(gap)) gap = parseFloat(rowStyle.gap) || 0;
        var firstRect = firstSlot.getBoundingClientRect();
        if (!firstRect.width || !firstRect.height) {
          firstSlot.remove();
          return element;
        }
        var gutter = parseFloat(rowStyle.paddingLeft) || 0;
        var step = firstRect.width + gap;
        var available = row.clientWidth - gutter;
        var visible = Math.max(1, Math.ceil(available / step));
        track.style.height = firstRect.height + "px";
        if (isShort) {
          controller = homeCarousels[group] = { isShort: true, cards: cards, row: row, track: track,
            start: 0, end: cards.length - 1, selected: 0, step: step, width: firstRect.width,
            gutter: gutter, visible: visible, capacity: cards.length, pool: [], slots: Object.create(null) };
          controller.slots[0] = firstSlot;
          for (var i = 1; i < cards.length; i++) {
            var s = carouselSlot(controller, i);
            controller.slots[i] = s;
            track.appendChild(s);
          }
          var totalW = cards.length * step - gap;
          controller.fits = (totalW <= available);
        } else {
          controller = homeCarousels[group] = { isShort: false, cards: cards, row: row, track: track,
            start: 0, end: 0, selected: 0, step: step, width: firstRect.width,
            gutter: gutter, visible: visible, capacity: visible + 7,
            wrapTimer: 0, pool: [], slots: Object.create(null) };
          controller.slots[0] = firstSlot;
          var initialEnd = visible + 2;
          while (controller.end < initialEnd) {
            controller.end += 1;
            var initialSlot = carouselSlot(controller, controller.end);
            controller.slots[controller.end] = initialSlot;
            track.appendChild(initialSlot);
          }
        }
      }
      var index = Number(element.dataset.homeIndex);
      if (!Number.isInteger(index) || index < 0 || index >= cards.length) index = cards.indexOf(element);
      if (index < 0) return element;

      if (controller.isShort) {
        var target = Math.max(0, Math.min(cards.length - 1, index));
        var slot = controller.slots[target] || cards[target];
        controller.selected = target;
        track.style.transitionDuration = "0s";
        if (controller.fits) {
          track.style.transform = "translate3d(0px,0,0)";
        } else {
          track.style.transform = "translate3d(" + (-target * controller.step) + "px,0,0)";
        }
        return slot;
      }

      if (controller.track.childElementCount > controller.capacity + 2)
        trimHomeCarousel(controller, true);
      var target = direction === 1 ? controller.selected + 1
        : direction === -1 ? Math.max(0, controller.selected - 1)
          : controller.selected % cards.length === index ? controller.selected : index;
      if (cards.length === 1) target = 0;
      if (target % cards.length !== index) target = index;
      var neededEnd = target + (cards.length > 1 ? controller.visible + 2 : 0);
      while (controller.start > target) {
        if (track.childElementCount >= controller.capacity) {
          var oldLast = track.lastElementChild;
          if (oldLast && oldLast !== doc.activeElement && Number(oldLast.dataset.homeOrdinal) > target + controller.visible + 2) {
            delete controller.slots[oldLast.dataset.homeOrdinal];
            track.removeChild(oldLast);
            oldLast.classList.remove("is-focused");
            controller.pool.push(oldLast);
            controller.end = track.lastElementChild ? Number(track.lastElementChild.dataset.homeOrdinal) : controller.end - 1;
          }
        }
        controller.start -= 1;
        var restoredSlot = carouselSlot(controller, controller.start);
        controller.slots[controller.start] = restoredSlot;
        track.insertBefore(restoredSlot, track.firstElementChild);
      }
      while (cards.length > 1 && controller.end < neededEnd) {
        if (track.childElementCount >= controller.capacity) {
          var oldFirst = track.firstElementChild;
          if (oldFirst && oldFirst !== doc.activeElement && Number(oldFirst.dataset.homeOrdinal) < target - 2) {
            delete controller.slots[oldFirst.dataset.homeOrdinal];
            track.removeChild(oldFirst);
            oldFirst.classList.remove("is-focused");
            controller.pool.push(oldFirst);
            controller.start = track.firstElementChild ? Number(track.firstElementChild.dataset.homeOrdinal) : controller.start + 1;
          }
        }
        controller.end += 1;
        var addedSlot = carouselSlot(controller, controller.end);
        controller.slots[controller.end] = addedSlot;
        track.appendChild(addedSlot);
      }
      var slot = controller.slots[target];
      if (!slot) return element;
      var cycleStart = Math.floor(target / cards.length) * cards.length;
      if (direction === undefined && target % cards.length === 0) {
        prunePreviousCycleSlots(controller, cycleStart);
      }
      controller.selected = target;
      var now = clock.performance && clock.performance.now ? clock.performance.now() : Date.now();
      track.style.transitionDuration = "0s";
      controller.lastMoveAt = now;
      track.style.transform = "translate3d(" + (-target * controller.step) + "px,0,0)";
      if (controller.trimTimer) clock.clearTimeout(controller.trimTimer);
      if (track.childElementCount > controller.capacity || target % cards.length === 0) {
        var attemptTrim = function () {
          controller.trimTimer = 0;
          if (homeCarousels[group] !== controller) return;
          if (!trimHomeCarousel(controller))
            controller.trimTimer = clock.setTimeout(attemptTrim, 40);
        };
        controller.trimTimer = clock.setTimeout(attemptTrim, 160);
      }
      return slot;
    }
    function resolveHomeSelection(saved) {
      if (!saved) return null;
      var order = currentTabRowOrder();
      if (order.indexOf(saved.group) < 0 && homeRowOrder.indexOf(saved.group) < 0) return null;
      var cards = homeRowButtons(saved.group);
      return cards.find(function (card) { return card.dataset.homeKey === saved.key; })
        || cards[Math.max(0, Math.min(Number.isInteger(saved.index) ? saved.index : 0, cards.length - 1))] || null;
    }
    function firstHomeButton() {
      var order = visibleHomeRowOrder();
      for (var i = 0; i < order.length; i++) {
        var first = homeRowButtons(order[i])[0]; if (first) return first;
      }
      return null;
    }
    function nearestHomeButton(group) {
      var order = visibleHomeRowOrder();
      var index = order.indexOf(group);
      if (index < 0) return firstHomeButton();
      for (var distance = 1; distance < order.length; distance++) {
        var next = order[index + distance], previous = order[index - distance];
        if (next && homeRowButtons(next).length) return homeRowButtons(next)[0];
        if (previous && homeRowButtons(previous).length) return homeRowButtons(previous)[0];
      }
      return null;
    }
    function focusHomeTarget() {
      var target = resolveHomeSelection(homeReturnFocus || (tabLastContent && tabLastContent[state.watchTab]));
      if (target) {
        focus(target);
      } else if (state.watchTab === "for-you") {
        focus(get("watch-toggle"));
      } else {
        var first = firstHomeButton();
        if (first) focus(first);
        else focus(get(state.watchTab === "tv" ? "tv-toggle" : "movies-toggle"));
      }
    }
    function homeContext(row) {
      return row.type === "tv" ? localize("S" + row.season + " E" + row.episode)
        + (row.episodeTitle ? " · " + row.episodeTitle : (row.isNextUnwatched ? " · " + localize("Ready to start") : ""))
        : localize("Movie");
    }
    function homeDetail(row) {
      var key = row.type + ":" + row.id;
      if (!homeDetailCache.has(key)) homeDetailCache.set(key,
        api("/api/title/" + row.type + "/" + row.id).then(function (detail) { return detail; }, function () { return null; }));
      return homeDetailCache.get(key);
    }
    var homeArtRequest = 0, homeArtPendingImage = null, homeArtFadeTimer = 0;
    var homeHeroRequestedEntry = null;
    function cancelHomeArtwork() {
      ++homeArtRequest;
      if (homeArtFadeTimer) clock.clearTimeout(homeArtFadeTimer);
      homeArtFadeTimer = 0;
      get("watch-hero-art").classList.remove("is-fading-out");
      get("watch-hero-copy").classList.remove("is-fading-out");
      if (!homeArtPendingImage) return;
      var pending = homeArtPendingImage;
      homeArtPendingImage = null;
      if (pending.decodeTimer) clock.clearTimeout(pending.decodeTimer);
      pending.image.removeEventListener("load", pending.onLoad);
      pending.image.removeEventListener("error", pending.onError);
      pending.image.removeAttribute("src");
    }
    function invalidatePendingHomeHero() {
      if (homeHeroTimer) clock.clearTimeout(homeHeroTimer);
      homeHeroTimer = 0; ++homeHeroToken;
      homeHeroRequestedEntry = homeHeroEntry;
      cancelHomeArtwork();
    }
    function setHomeArtwork(backdropPath, posterPath, onReady) {
      var art = get("watch-hero-art");
      var paths = backdropPath ? [[backdropPath, "hero", false]] : [];
      if (posterPath) paths.push([posterPath, "poster", true]);
      if (!paths.length) { cancelHomeArtwork(); art.replaceChildren(); onReady(); return; }
      var requestedSrc = core.imageUrl(paths[0][0], paths[0][1]);
      var visible = art.querySelector("img.is-visible");
      if (visible && visible.src === requestedSrc) {
        cancelHomeArtwork();
        onReady(); return;
      }
      cancelHomeArtwork();
      var request = homeArtRequest;
      function tryPath(index) {
        if (request !== homeArtRequest) return;
        if (index >= paths.length) {
          art.replaceChildren(); onReady(); return;
        }
        var path = paths[index], src = core.imageUrl(path[0], path[1]);
        var current = art.querySelector("img.is-visible");
        if (current && current.src === src) { onReady(); return; }
        var image = doc.createElement("img");
        image.alt = ""; image.className = "home-art-layer";
        var artStarted = watchPerformance && watchPerformance.heroStart();
        function apply() {
          if (request !== homeArtRequest || state.view !== "watch") return;
          homeArtPendingImage = null;
          function commitImage() {
            if (request !== homeArtRequest || state.view !== "watch") return;
            homeArtFadeTimer = 0;
            image.classList.add("is-visible");
            art.classList.toggle("is-poster", path[2]);
            // Artwork and text are swapped together while hidden during a fade.
            art.replaceChildren(image);
            if (watchPerformance) watchPerformance.heroSwap();
            onReady();
            art.classList.remove("is-fading-out");
            get("watch-hero-copy").classList.remove("is-fading-out");
          }
          if (heroPreferences.fade && art.querySelector("img.is-visible")) {
            art.classList.add("is-fading-out");
            get("watch-hero-copy").classList.add("is-fading-out");
            homeArtFadeTimer = clock.setTimeout(commitImage, 65);
          } else commitImage();
        }
        function onError() {
          if (watchPerformance) watchPerformance.heroEnd(artStarted, true);
          homeArtPendingImage = null;
          tryPath(index + 1);
        }
        function onLoad() {
          if (watchPerformance) watchPerformance.heroEnd(artStarted, false);
          if (request !== homeArtRequest || state.view !== "watch") return;
          if (typeof image.decode === "function") {
            var decodeAt = watchPerformance && watchPerformance.decodeStart();
            var finished = false;
            function finishDecode(failed) {
              if (finished) return;
              finished = true;
              if (homeArtPendingImage && homeArtPendingImage.image === image) {
                clock.clearTimeout(homeArtPendingImage.decodeTimer);
                homeArtPendingImage.decodeTimer = 0;
              }
              if (request !== homeArtRequest) return;
              if (watchPerformance) watchPerformance.decodeEnd(decodeAt, failed);
              apply();
            }
            try {
              var decoding = image.decode();
              homeArtPendingImage.decodeTimer = clock.setTimeout(function () { finishDecode(true); }, 800);
              decoding.then(function () { finishDecode(false); }, function () { finishDecode(true); });
              return;
            } catch (_error) {
              finishDecode(true); return;
            }
          }
          apply();
        }
        homeArtPendingImage = { image: image, onLoad: onLoad, onError: onError };
        image.addEventListener("error", onError);
        image.addEventListener("load", onLoad);
        image.src = src;
      }
      tryPath(0);
    }
    function paintHomeHero(entry, detail, token, afterCommit) {
      function commit() {
        if (disposed || state.view !== "watch" || token !== homeHeroToken) return;
        homeHeroEntry = entry;
        if (entry) {
          var row = entry.row;
          text("watch-hero-title", detail && detail.title || row.title);
          var meta = [];
          if (detail && detail.date || row.date) meta.push((detail && detail.date || row.date).slice(0, 4));
          meta.push(row.type === "tv" ? "TV Series" : "Movie");
          if (detail && detail.rating || row.rating) meta.push(detail && detail.rating || row.rating);
          else if (Number.isFinite(row.voteAverage) && row.voteAverage > 0) meta.push(row.voteAverage.toFixed(1) + "/10");
          if (detail && detail.runtime) meta.push(detail.runtime + " min");
          else if (detail && detail.episodeRuntime && row.type === "tv") meta.push(detail.episodeRuntime + " min episodes");
          if (row.type === "tv" && row.season && row.episode) meta.push("S" + row.season + " E" + row.episode);
          if (row.matchReason) meta.push(row.matchReason);
          text("watch-hero-context", meta.join("  ·  "));
          text("watch-hero-description", detail && detail.overview || row.overview || "");
        } else {
          text("watch-hero-title", "Find your next watch");
          text("watch-hero-context", "Your viewing history will appear here.");
          text("watch-hero-description", "Use Search to find a movie or show.");
        }
        if (afterCommit) afterCommit();
      }
      if (!entry) { setHomeArtwork(null, null, commit); return; }
      var row = entry.row;
      setHomeArtwork(detail && detail.backdrop || row.backdrop,
        detail && detail.poster || row.poster, commit);
    }
    function showHomeHero(entry, force) {
      if (!force && entry === homeHeroRequestedEntry && (homeHeroTimer || homeArtPendingImage)) return;
      if (homeHeroTimer) clock.clearTimeout(homeHeroTimer);
      homeHeroTimer = 0;
      var previousRequest = homeHeroRequestedEntry;
      homeHeroRequestedEntry = entry;
      var token = ++homeHeroToken;
      cancelHomeArtwork();
      var mode = watchPerformance ? watchPerformance.mode() : heroPreferences;
      if (mode.fixed && homeHeroEntry) return;
      if (!force && entry && entry === homeHeroEntry) return;
      function settle() {
        homeHeroTimer = 0;
        if (disposed || state.view !== "watch" || token !== homeHeroToken) return;
        var heroStarted = watchPerformance && watchPerformance.heroAttempt();
        paintHomeHero(entry, null, token, function () {
          if (watchPerformance) watchPerformance.heroSettled(heroStarted);
          if (entry && entry.group !== "top" && entry.group !== "because") homeDetail(entry.row).then(function (detail) {
            if (!disposed && state.view === "watch" && token === homeHeroToken && detail)
              paintHomeHero(entry, detail, token);
          });
        });
        if (watchPerformance) watchPerformance.heroWork(heroStarted);
      }
      if (entry && previousRequest && !force && mode.delay > 0)
        homeHeroTimer = clock.setTimeout(settle, mode.delay);
      else settle();
    }
    if (watchPerformance) watchPerformance.onModeChange(function (mode) {
      if (state.view !== "watch") return;
      if (mode.fixed && homeHeroEntry) {
        if (homeHeroTimer) clock.clearTimeout(homeHeroTimer);
        homeHeroTimer = 0; ++homeHeroToken; cancelHomeArtwork(); return;
      }
      var remembered = resolveHomeSelection(tabLastContent[state.watchTab] || homeLastContent);
      showHomeHero(doc.activeElement.homeEntry || remembered && remembered.homeEntry
        || homeHeroRequestedEntry || homeDefaultEntry, true);
    });
    function openHomeEntry(entry) {
      if (!entry || homeOpenPending || state.view !== "watch") return;
      var row = entry.row;
      if (row.type === "movie") { openDetails(row); return; }
      homeOpenPending = false;
      openDetails(row, row.season ? { season: row.season, episode: row.episode } : null);
    }
    function isFilterActive(tab) {
      if (tab === "discover") {
        return !!(discoverFilters.genre || (discoverFilters.style && discoverFilters.style !== "all"));
      }
      var f = tab === "tv" ? tvFilters : movieFilters;
      return !!(f.genre || f.length || f.rating || f.year || (f.sort && f.sort !== "best"));
    }
    function updateFilterStripUI() {
      var isTv = state.watchTab === "tv";
      var isMovies = state.watchTab === "movies";
      var isDiscover = state.watchTab === "discover";
      var f = isTv ? tvFilters : (isMovies ? movieFilters : discoverFilters);

      var seedBtn = get("filter-btn-seed");
      var modeBtn = get("filter-btn-mode");
      var mediaBtn = get("filter-btn-media");
      var styleBtn = get("filter-btn-style");

      if (seedBtn) {
        seedBtn.hidden = !isDiscover;
        if (isDiscover) {
          seedBtn.textContent = "Seed: " + (discoverActiveSeed ? discoverActiveSeed.title : "Choose Seed");
          seedBtn.classList.add("is-active");
        }
      }
      // Category (mode) filter removed from Discover per Phase 3C.4 specification
      if (modeBtn) {
        modeBtn.hidden = true;
      }
      if (mediaBtn) {
        mediaBtn.hidden = !isDiscover;
        if (isDiscover) {
          var mediaLabels = { same: "Same Type", tv: "TV Shows", movie: "Movies", both: "Both" };
          mediaBtn.textContent = "Type: " + (mediaLabels[discoverMedia] || "Same Type");
          mediaBtn.classList.toggle("is-active", discoverMedia !== "same");
        }
      }
      if (styleBtn) {
        styleBtn.hidden = !isDiscover;
        if (isDiscover) {
          var styleLabels = { all: "Style: All", animated: "Style: Animated", live_action: "Style: Live Action" };
          styleBtn.textContent = styleLabels[discoverStyle] || "Style: All";
          styleBtn.classList.toggle("is-active", discoverStyle !== "all");
        }
      }

      var genreBtn = get("filter-btn-genre");
      var lengthBtn = get("filter-btn-length");
      var ratingBtn = get("filter-btn-rating");
      var yearBtn = get("filter-btn-year");
      var sortBtn = get("filter-btn-sort");
      var clearBtn = get("filter-btn-clear");

      if (genreBtn) {
        var genreName = f.genre && recommendations && recommendations.GENRE_NAMES && recommendations.GENRE_NAMES[f.genre];
        genreBtn.textContent = genreName ? "Genre: " + genreName : "Genre";
        genreBtn.classList.toggle("is-active", !!f.genre);
      }
      // Length, Rating, Year, Sort removed from Discover; preserved for TV and Movies
      if (lengthBtn) {
        lengthBtn.hidden = isDiscover;
        if (!isDiscover) {
          var lengthLabels = isTv
            ? { short: "<30 min", medium: "30-60 min", long: ">60 min" }
            : { short: "<90 min", medium: "90-120 min", long: ">120 min" };
          lengthBtn.textContent = f.length ? "Length: " + (lengthLabels[f.length] || f.length) : "Length";
          lengthBtn.classList.toggle("is-active", !!f.length);
        }
      }
      if (ratingBtn) {
        ratingBtn.hidden = isDiscover;
        if (!isDiscover) {
          ratingBtn.textContent = f.rating ? "Rating: " + f.rating : "Age Rating";
          ratingBtn.classList.toggle("is-active", !!f.rating);
        }
      }
      if (yearBtn) {
        yearBtn.hidden = isDiscover;
        if (!isDiscover) {
          var yearLabels = { "2020s": "2020s", "2010s": "2010s", "2000s": "2000s", "older": "Older" };
          yearBtn.textContent = f.year ? "Year: " + (yearLabels[f.year] || f.year) : "Year";
          yearBtn.classList.toggle("is-active", !!f.year);
        }
      }
      if (sortBtn) {
        sortBtn.hidden = isDiscover;
        if (!isDiscover) {
          var sortLabels = { best: "Best Match", popularity: "Popularity", rating: "Highest Rated", newest: "Newest" };
          sortBtn.textContent = "Sort: " + (sortLabels[f.sort] || "Best Match");
          sortBtn.classList.toggle("is-active", f.sort && f.sort !== "best");
        }
      }
      if (clearBtn) {
        var hasActive = isFilterActive(state.watchTab) || (isDiscover && (discoverMode !== "all" || discoverMedia !== "same" || !discoverHideFinished || (discoverFilters.style && discoverFilters.style !== "all")));
        clearBtn.hidden = !hasActive;
      }
    }
    function openFilterMenu(filterType) {
      activeFilterMenuType = filterType;
      var menu = get("watch-filter-menu");
      var host = get("watch-filter-menu-options");
      if (!menu || !host) return;
      host.replaceChildren();
      var isTv = state.watchTab === "tv";
      var f = isTv ? tvFilters : (state.watchTab === "movies" ? movieFilters : discoverFilters);
      var options = [];

      if (filterType === "seed") {
        var hist = core.readHistory(local) || [];
        var seenIds = new Set();
        options.push({ label: "Search for Any Title…", value: "__search__" });
        hist.forEach(function (h) {
          if (!h || !h.id || seenIds.has(h.type + ":" + h.id)) return;
          seenIds.add(h.type + ":" + h.id);
          options.push({ label: h.title + " (" + (h.type === "tv" ? "TV" : "Movie") + ")", value: h.type + ":" + h.id });
        });
        if (recommendationRows && recommendationRows.seed) {
          var s = recommendationRows.seed;
          if (!seenIds.has(s.type + ":" + s.id)) {
            options.push({ label: s.title + " (" + (s.type === "tv" ? "TV" : "Movie") + ")", value: s.type + ":" + s.id });
          }
        }
      } else if (filterType === "mode") {
        options.push({ label: "All Categories", value: "all" });
        options.push({ label: "Closest Matches", value: "closest" });
        options.push({ label: "Same Vibe", value: "vibe" });
        options.push({ label: "Same Genre, Different Story", value: "genre" });
        options.push({ label: "Hidden Gems", value: "gems" });
      } else if (filterType === "media") {
        options.push({ label: "Same Media Type", value: "same" });
        options.push({ label: "TV Shows Only", value: "tv" });
        options.push({ label: "Movies Only", value: "movie" });
        options.push({ label: "Both TV & Movies", value: "both" });
      } else if (filterType === "style") {
        options.push({ label: "All (Animated & Live Action)", value: "all" });
        options.push({ label: "Animated", value: "animated" });
        options.push({ label: "Live Action", value: "live_action" });
      } else if (filterType === "genre") {
        options.push({ label: "All Genres", value: "" });
        var genreList = state.watchTab === "discover"
          ? [[28, "Action"], [12, "Adventure"], [35, "Comedy"], [80, "Crime"], [18, "Drama"], [27, "Horror"], [9648, "Mystery"], [878, "Sci-Fi"], [53, "Thriller"]]
          : (isTv
            ? [[10759, "Action & Adventure"], [16, "Animation"], [35, "Comedy"], [80, "Crime"], [18, "Drama"], [9648, "Mystery"], [10765, "Sci-Fi & Fantasy"]]
            : [[28, "Action"], [12, "Adventure"], [16, "Animation"], [35, "Comedy"], [80, "Crime"], [18, "Drama"], [27, "Horror"], [878, "Sci-Fi"], [53, "Thriller"]]);
        genreList.forEach(function (g) { options.push({ label: g[1], value: String(g[0]) }); });
      } else if (filterType === "length") {
        options.push({ label: "Any Length", value: "" });
        if (isTv) {
          options.push({ label: "Short (<30 min)", value: "short" });
          options.push({ label: "Standard (30-60 min)", value: "medium" });
          options.push({ label: "Long (>60 min)", value: "long" });
        } else {
          options.push({ label: "Under 90 minutes", value: "short" });
          options.push({ label: "90 - 120 minutes", value: "medium" });
          options.push({ label: "Over 120 minutes", value: "long" });
        }
      } else if (filterType === "rating") {
        options.push({ label: "Any Rating", value: "" });
        var ratingsList = isTv ? ["TV-Y", "TV-G", "TV-PG", "TV-14", "TV-MA"] : ["G", "PG", "PG-13", "R", "NC-17"];
        ratingsList.forEach(function (r) { options.push({ label: r, value: r }); });
      } else if (filterType === "year") {
        options.push({ label: "Any Year", value: "" });
        options.push({ label: "2020s", value: "2020s" });
        options.push({ label: "2010s", value: "2010s" });
        options.push({ label: "2000s", value: "2000s" });
        options.push({ label: "1990s & Older", value: "older" });
      } else if (filterType === "sort") {
        options.push({ label: "Best Match", value: "best" });
        options.push({ label: "Popularity", value: "popularity" });
        options.push({ label: "Highest Rated", value: "rating" });
        options.push({ label: "Newest", value: "newest" });
      }

      var currentVal = filterType === "seed" ? (discoverActiveSeed ? (discoverActiveSeed.type + ":" + discoverActiveSeed.id) : "")
        : filterType === "mode" ? discoverMode
        : filterType === "media" ? discoverMedia
        : filterType === "style" ? discoverStyle
        : filterType === "genre" ? (f.genre ? String(f.genre) : "")
        : filterType === "length" ? (f.length || "")
        : filterType === "rating" ? (f.rating || "")
        : filterType === "year" ? (f.year || "")
        : (f.sort || "best");

      options.forEach(function (opt) {
        var optBtn = button(opt.label, function () {
          selectFilterOption(filterType, opt.value);
        }, "filter-menu-option");
        optBtn.dataset.filterType = filterType;
        optBtn.dataset.filterValue = opt.value;
        optBtn.classList.toggle("is-selected", opt.value === currentVal);
        host.appendChild(optBtn);
      });

      menu.hidden = false;
      var triggerBtn = get("filter-btn-" + filterType);
      if (triggerBtn) {
        var btnRect = triggerBtn.getBoundingClientRect();
        var menuWidth = Math.min(360, Math.max(250, btnRect.width + 40));
        var winWidth = clock.innerWidth || 1920;
        var left = Math.min(btnRect.left, winWidth - menuWidth - 24);
        menu.style.left = Math.max(16, left) + "px";
        menu.style.top = (btnRect.bottom + 8) + "px";
      }
      var selectedEl = host.querySelector(".is-selected") || host.querySelector(".filter-menu-option");
      if (selectedEl) focus(selectedEl);
    }
    function closeFilterMenu() {
      var prevType = activeFilterMenuType;
      activeFilterMenuType = null;
      var menu = get("watch-filter-menu");
      if (menu) menu.hidden = true;
      if (prevType) {
        var originatingBtn = get("filter-btn-" + prevType);
        if (originatingBtn) focus(originatingBtn);
      }
    }
    function selectFilterOption(filterType, value) {
      if (state.view === "watch") invalidatePendingHomeHero();
      if (filterType === "seed") {
        closeFilterMenu();
        if (value === "__search__") {
          pickingDiscoverSeed = true;
          state.continueMode = false;
          setView("search");
          scheduleSearch(0);
          focus(query);
          return;
        }
        var parts = value.split(":");
        var newType = parts[0], newId = Number(parts[1]);
        var hist = core.readHistory(local) || [];
        var found = hist.find(function (h) { return h.type === newType && h.id === newId; });
        if (found) {
          discoverActiveSeed = { type: found.type, id: found.id, title: found.title, poster: found.poster, backdrop: found.backdrop };
        } else {
          discoverActiveSeed = { type: newType, id: newId, title: "Title " + newId };
        }
        discoverData = null;
        rowCycleIndex = Object.create(null);
        tabRowMemory["discover"] = Object.create(null);
        tabLastContent["discover"] = null;
        homeRowMemory = Object.create(null);
        homeLastContent = null;
        updateFilterStripUI();
        loadDiscoverData(true);
        var originatingSeed = get("filter-btn-seed");
        if (originatingSeed) focus(originatingSeed);
        return;
      }
      if (filterType === "mode") {
        discoverMode = value || "all";
        closeFilterMenu();
        rowCycleIndex = Object.create(null);
        updateFilterStripUI();
        renderDiscoverRows(discoverData);
        var originatingMode = get("filter-btn-mode");
        if (originatingMode) focus(originatingMode);
        return;
      }
      if (filterType === "media") {
        discoverMedia = value || "same";
        closeFilterMenu();
        discoverData = null;
        rowCycleIndex = Object.create(null);
        updateFilterStripUI();
        loadDiscoverData(true);
        var originatingMedia = get("filter-btn-media");
        if (originatingMedia) focus(originatingMedia);
        return;
      }
      if (filterType === "style") {
        discoverStyle = value || "all";
        discoverFilters.style = discoverStyle;
        closeFilterMenu();
        rowCycleIndex = Object.create(null);
        updateFilterStripUI();
        renderDiscoverRows(discoverData);
        var originatingStyle = get("filter-btn-style");
        if (originatingStyle) focus(originatingStyle);
        return;
      }
      var isTv = state.watchTab === "tv";
      var f = isTv ? tvFilters : (state.watchTab === "movies" ? movieFilters : discoverFilters);
      if (filterType === "genre") f.genre = value ? Number(value) : null;
      else if (filterType === "length") f.length = value || null;
      else if (filterType === "rating") f.rating = value || null;
      else if (filterType === "year") f.year = value || null;
      else if (filterType === "sort") f.sort = value || "best";

      closeFilterMenu();
      rowCycleIndex = Object.create(null);
      updateFilterStripUI();
      if (state.watchTab === "discover") {
        renderDiscoverRows(discoverData);
      } else {
        renderFilterResultsIfActive();
        updateHomeSections();
      }
      var originating = get("filter-btn-" + filterType);
      if (originating) focus(originating);
    }
    function clearActiveFilters() {
      if (state.watchTab === "tv") {
        tvFilters = { genre: null, length: null, rating: null, year: null, sort: "best" };
      } else if (state.watchTab === "movies") {
        movieFilters = { genre: null, length: null, rating: null, year: null, sort: "best" };
      } else if (state.watchTab === "discover") {
        discoverFilters = { genre: null, style: "all", sort: "best" };
        discoverStyle = "all";
        discoverMode = "all";
        discoverMedia = "same";
        discoverHideFinished = true;
        tabRowMemory["discover"] = Object.create(null);
        tabLastContent["discover"] = null;
        homeRowMemory = Object.create(null);
        homeLastContent = null;
      }
      closeFilterMenu();
      rowCycleIndex = Object.create(null);
      updateFilterStripUI();
      if (state.watchTab === "discover") {
        renderDiscoverRows(discoverData);
      } else {
        renderFilterResultsIfActive();
        updateHomeSections();
      }
      var first = firstHomeButton();
      if (first) focus(first);
      else focus(state.watchTab === "discover" ? (get("filter-btn-seed") || get("filter-btn-genre")) : get("filter-btn-genre"));
    }
    function setWatchTab(tabName) {
      if (["for-you", "tv", "movies", "discover"].indexOf(tabName) < 0) return;
      if (homeMotion && homeMotion.mode === "edge") { stopEdgeMotion(); finishHorizontalMotion(); }
      cancelHoverHero();
      if (state.view === "watch") invalidatePendingHomeHero();
      if (activeFilterMenuType) closeFilterMenu();
      var scroller = get("watch-rows-scroll");
      if (scroller) tabScrollTop[state.watchTab] = scroller.scrollTop;
      if (doc.activeElement && doc.activeElement.dataset && doc.activeElement.dataset.homeGroup) {
        var curId = homeFocusIdentity(doc.activeElement);
        tabRowMemory[state.watchTab][curId.group] = curId;
        tabLastContent[state.watchTab] = curId;
      }
      state.watchTab = tabName;
      homeRowMemory = tabRowMemory[tabName];
      homeLastContent = tabLastContent[tabName];
      rowCycleIndex = Object.create(null);

      var filterStrip = get("watch-filter-strip");
      if (filterStrip) filterStrip.hidden = (tabName === "for-you");
      updateFilterStripUI();

      renderHomepage();
      syncRail();

      if (scroller) scroller.scrollTop = tabScrollTop[tabName] || 0;
      if (doc.activeElement && doc.activeElement.closest && doc.activeElement.closest(".watch-rail")) {
        var railMap = { "for-you": "watch-toggle", "tv": "tv-toggle", "movies": "movies-toggle", "discover": "discover-toggle" };
        focus(get(railMap[tabName]));
      } else {
        var target = resolveHomeSelection(tabLastContent[tabName]);
        if (target) focus(target);
        else focusHomeTarget();
      }
      saveView();
    }
    function populatePosterRow(group, candidateList) {
      var host = get("watch-" + group + "-row");
      if (!host) return;
      var track = host.querySelector(".watch-home-track");
      if (!track) return;
      var focused = homeFocusIdentity(doc.activeElement);
      if (!focused || focused.group !== group) focused = null;
      host.scrollLeft = 0;
      track.style.transform = "";
      rowCycleIndex[group] = 0;
      track.replaceChildren();
      (candidateList || []).forEach(function (candidate) {
        var card = button("", function () { openDetails(candidate); },
          "home-card home-card-poster");
        card.dataset.homeGroup = group; card.dataset.homeKey = candidate.type + ":" + candidate.id;
        card.homeEntry = { row: candidate, group: group };
        var title = doc.createElement("strong"); title.textContent = candidate.title;
        card.appendChild(verticalPosterArt(candidate, true)); card.appendChild(title);
        var reasonEl = doc.createElement("small");
        reasonEl.className = "card-match-reason";
        if (candidate.matchReason) {
          reasonEl.textContent = candidate.matchReason;
        } else {
          reasonEl.textContent = "\u00A0";
          reasonEl.style.visibility = "hidden";
        }
        card.appendChild(reasonEl);
        card.setAttribute("aria-label", candidate.title + ", " + (candidate.type === "tv" ? "TV series" : "movie"));
        track.appendChild(card);
      });
      var sec = get("watch-" + group + "-section");
      if (sec) sec.hidden = group === "filtered" ? (candidateList || []).length === 0 : (candidateList || []).length < 2;
      recordHomeCards(group);
      var cards = homeRowButtons(group);
      if (cards.length) {
        var selected = resolveHomeSelection(focused) || cards[0];
        revealHomeWindow(selected);
        if (focused) rowCycleIndex[group] = Number(selected.dataset.homeIndex) || 0;
      }
    }
    var filterFetchToken = 0;
    function renderFilterResultsIfActive() {
      var filteredSec = get("watch-filtered-section"), emptySec = get("watch-filter-empty");
      if (state.watchTab === "for-you") {
        if (filteredSec) filteredSec.hidden = true;
        if (emptySec) emptySec.hidden = true;
        return;
      }
      var isTv = state.watchTab === "tv";
      var f = isTv ? tvFilters : movieFilters;
      var active = isFilterActive(state.watchTab);
      if (!active) {
        if (filteredSec) filteredSec.hidden = true;
        if (emptySec) emptySec.hidden = true;
        return;
      }
      var token = ++filterFetchToken;
      var queryParams = new URLSearchParams();
      queryParams.set("type", isTv ? "tv" : "movie");
      if (f.genre) queryParams.set("with_genres", String(f.genre));
      if (f.year) queryParams.set("year", f.year);
      if (f.length) queryParams.set("length", f.length);
      if (f.rating) queryParams.set("rating", f.rating);
      if (f.sort && f.sort !== "best") {
        if (f.sort === "popularity") queryParams.set("sort_by", "popularity.desc");
        else if (f.sort === "rating") queryParams.set("sort_by", "vote_average.desc");
        else if (f.sort === "newest") queryParams.set("sort_by", isTv ? "first_air_date.desc" : "primary_release_date.desc");
      }
      text("watch-filtered-heading", isTv ? "Matching TV Shows" : "Matching Movies");
      api("/api/discover?" + queryParams.toString()).then(function (data) {
        if (disposed || token !== filterFetchToken || state.view !== "watch") return;
        var results = (data && Array.isArray(data.results)) ? data.results : [];
        var feedback = recommendations ? recommendations.readFeedback(local) : { ratings: {} };
        var ratings = feedback && feedback.ratings || {};
        var filtered = results.filter(function (c) {
          return ratings[c.type + ":" + c.id] !== "disliked" && c.poster;
        });
        populatePosterRow("filtered", filtered);
        if (filteredSec) filteredSec.hidden = filtered.length === 0;
        if (emptySec) {
          emptySec.hidden = filtered.length > 0;
          var p = emptySec.querySelector("p");
          if (p) p.textContent = "No matching titles found.";
        }
        updateHomeSections();
      }, function (_err) {
        if (disposed || token !== filterFetchToken || state.view !== "watch") return;
        populatePosterRow("filtered", []);
        if (filteredSec) filteredSec.hidden = true;
        if (emptySec) {
          emptySec.hidden = false;
          var p = emptySec.querySelector("p");
          if (p) p.textContent = "Unable to load matching titles. Please check your connection or clear filters.";
        }
        updateHomeSections();
      });
    }
    function paintHomepage(continueRows) {
      var previous = homeFocusIdentity(doc.activeElement);
      if (state.watchTab === "for-you") {
        homeDefaultEntry = continueRows[0] ? { row: continueRows[0], group: "continue" } : null;
      }
      function rowCard(entry, action) {
        var row = entry.row, card = button("", action, "home-card");
        card.dataset.homeGroup = "continue"; card.dataset.homeKey = row.type + ":" + row.id;
        card.homeEntry = entry;
        var artwork = landscapeArt(row, true),
          title = doc.createElement("strong"), context = doc.createElement("small");
        title.textContent = row.title; context.textContent = homeContext(row);
        card.appendChild(artwork);
        var caption = doc.createElement("span"); caption.className = "home-card-caption";
        caption.appendChild(title); caption.appendChild(context); artwork.appendChild(caption);
        var fraction = core.episodeProgressFraction(row);
        if (fraction > 0) { var line = doc.createElement("span"), fill = doc.createElement("span");
          line.className = "home-progress"; fill.className = "home-progress-fill";
          fill.style.width = (fraction * 100).toFixed(1) + "%";
          line.appendChild(fill); artwork.appendChild(line); }
        card.setAttribute("aria-label", "Continue " + row.title + ", " + context.textContent);
        return card;
      }
      var continueHost = get("watch-continue-row");
      continueHost.scrollLeft = 0;
      rowCycleIndex["continue"] = 0;
      var continueRow = continueHost.querySelector(".watch-home-track");
      continueRow.replaceChildren();
      if (state.watchTab === "for-you") {
        continueRows.slice(0, 8).forEach(function (row) {
          var entry = { row: row, group: "continue" };
          continueRow.appendChild(rowCard(entry, function () { openHomeEntry(entry); }));
        });
        get("watch-continue-section").hidden = !continueRows.length;
        recordHomeCards("continue");
      } else {
        get("watch-continue-section").hidden = true;
        homeCards["continue"] = [];
      }
      if (state.watchTab === "for-you") ["continue"].forEach(function (group) {
        var cards = homeRowButtons(group);
        if (cards.length) revealHomeWindow(resolveHomeSelection(previous && previous.group === group ? previous : null) || cards[0]);
      });
      updateHomeSections();
      if (previous && previous.group) { homeReturnFocus = previous; focusHomeTarget(); }
      else showHomeHero(homeDefaultEntry);
    }
    function updateHomeSections() {
      var allKnownGroups = [
        "continue", "top", "because", "trending", "gems", "explore",
        "tv-recommended", "tv-trending", "tv-genres", "tv-short", "tv-gems", "tv-acclaimed",
        "movies-recommended", "movies-trending", "movies-genres", "movies-short", "movies-acclaimed", "movies-gems",
        "discover-closest", "discover-vibe", "discover-genre", "discover-gems",
        "filtered"
      ];
      var activeOrder = currentTabRowOrder();
      allKnownGroups.forEach(function (group) {
        var sec = get("watch-" + group + "-section");
        if (!sec) return;
        if (activeOrder.indexOf(group) < 0) {
          sec.hidden = true;
        } else if (group !== "continue" && group !== "filtered") {
          sec.hidden = (homeCards[group] || []).length < (group.indexOf("discover-") === 0 ? 1 : 2);
        }
      });
      var first = false;
      activeOrder.forEach(function (group) {
        var section = get("watch-" + group + "-section");
        if (!section) return;
        section.classList.toggle("is-first-visible", !section.hidden && !first);
        if (!section.hidden) first = true;
      });
      // Use the actual visual order, cached when rows change. A separate
      // hand-maintained navigation order once made the third row unreachable.
      visibleRowGroups = Array.from(get("watch-rows-scroll").querySelectorAll(".watch-home-section"))
        .filter(function (section) {
          var group = section.id.slice(6, -8);
          return !section.hidden && activeOrder.indexOf(group) >= 0 && homeRowButtons(group).length;
        }).map(function (section) { return section.id.slice(6, -8); });
      get("watch-view").classList.toggle("is-empty", !first);
      // Recommendation rows are often built while their destination is hidden.
      // Measure and attach the complete visible window only after revealing it,
      // before the browser paints or the first D-pad input can reach the row.
      activeOrder.forEach(function (group) {
        var section = get("watch-" + group + "-section");
        if (get("watch-view").hidden || !section || section.hidden || homeCarousels[group] || !homeCards[group]
            || !homeCards[group].length) return;
        revealHomeWindow(homeCards[group][0]);
      });
    }
    function paintRecommendationRows(rows) {
      recommendationRows = rows;
      var active = homeFocusIdentity(doc.activeElement), activeGroup = active && active.group;
      var activeRow = activeGroup && activeGroup !== "continue";
      var anchor = state.view === "watch" && !activeRow && active && active.group
        ? doc.activeElement : null;
      var anchorY = anchor ? anchor.getBoundingClientRect().top : 0;

      var forYouData = rows.forYou || { top: rows.top || [], because: rows.because || [], seed: rows.seed };
      populatePosterRow("top", forYouData.top || rows.top || []);
      populatePosterRow("because", forYouData.because || rows.because || []);
      populatePosterRow("trending", forYouData.trending || []);
      populatePosterRow("gems", forYouData.gems || []);
      populatePosterRow("explore", forYouData.explore || []);

      text("watch-trending-heading", "Trending Now");
      text("watch-gems-heading", "Hidden Gems");
      text("watch-explore-heading", "Explore Something Different");

      var tvData = rows.tv || {};
      populatePosterRow("tv-recommended", tvData.recommended || []);
      populatePosterRow("tv-trending", tvData.trending || []);
      populatePosterRow("tv-genres", tvData.genres || []);
      populatePosterRow("tv-short", tvData.short || []);
      populatePosterRow("tv-gems", tvData.gems || []);
      populatePosterRow("tv-acclaimed", tvData.acclaimed || []);

      text("watch-tv-recommended-heading", "Recommended Series");
      text("watch-tv-trending-heading", "Trending TV");
      text("watch-tv-genres-heading", tvData.genresHeading || "Your Favorite TV Genres");
      text("watch-tv-short-heading", "Short Episodes");
      text("watch-tv-gems-heading", "Hidden Gem Series");
      text("watch-tv-acclaimed-heading", "Critically Acclaimed Series");

      var movieData = rows.movies || {};
      populatePosterRow("movies-recommended", movieData.recommended || []);
      populatePosterRow("movies-trending", movieData.trending || []);
      populatePosterRow("movies-genres", movieData.genres || []);
      populatePosterRow("movies-short", movieData.short || []);
      populatePosterRow("movies-acclaimed", movieData.acclaimed || []);
      populatePosterRow("movies-gems", movieData.gems || []);

      text("watch-movies-recommended-heading", "Recommended Movies");
      text("watch-movies-trending-heading", "Trending Movies");
      text("watch-movies-genres-heading", movieData.genresHeading || "Your Favorite Movie Genres");
      text("watch-movies-short-heading", "Under 100 Minutes");
      text("watch-movies-acclaimed-heading", "Critically Acclaimed Films");
      text("watch-movies-gems-heading", "Hidden Gem Films");

      var seed = rows.seed || forYouData.seed;
      if (seed) text("watch-because-heading", "Because You "
        + (seed.liked ? "Liked " : "Watched ") + seed.title);
      if (doc.activeElement && doc.activeElement.closest("#watch-because-section")) syncActiveHomeHeading(doc.activeElement);

      renderFilterResultsIfActive();

      updateHomeSections();
      if (anchor && anchor.isConnected) {
        var view = get("watch-rows-scroll"), movement = anchor.getBoundingClientRect().top - anchorY;
        if (Math.abs(movement) > 1) {
          var behavior = view.style.scrollBehavior;
          view.style.scrollBehavior = "auto"; view.scrollTop += movement;
          view.style.scrollBehavior = behavior;
        }
      }
      if (activeRow && state.view === "watch") {
        focus(resolveHomeSelection(active) || nearestHomeButton(activeGroup) || get("watch-toggle"));
      }
    }
    function recommendationSignature(rows, feedback) {
      return contentLibrary + "|" + recommendations.seedQuery(rows, feedback) + "|" + feedback.revision + "|"
        + rows.map(function (row) { return row.type + ":" + row.id + ":"
          + (row.progress && row.progress.updatedAt || 0) + ":" + (row.progress && row.progress.completed || false);
        }).join(",");
    }
    var knownRuntimes = Object.create(null);
    var candidateEnrichmentStarted = false;
    function enrichCandidateRuntimes(candidates) {
      if (!candidates || !candidates.length || candidateEnrichmentStarted) return;
      candidateEnrichmentStarted = true;
      var libraryAtStart = contentLibrary;
      var needed = [];
      candidates.forEach(function (c) {
        var k = c.type + ":" + c.id;
        if (c.runtime) knownRuntimes[k] = c.runtime;
        if (c.episodeRuntime) knownRuntimes[k] = c.episodeRuntime;
        if (!knownRuntimes[k] && needed.length < 16) needed.push(c);
      });
      if (!needed.length) return;
      var updated = false;
      var pending = needed.map(function (c) {
        return homeDetail(c).then(function (detail) {
          if (detail) {
            var k = c.type + ":" + c.id;
            var rt = detail.runtime || detail.episodeRuntime;
            if (rt) {
              knownRuntimes[k] = rt;
              if (c.type === "movie" && rt < 100) updated = true;
              if (c.type === "tv" && rt <= 30) updated = true;
            }
          }
        }, function () {});
      });
      Promise.all(pending).then(function () {
        if (updated && !disposed && state.view === "watch" && recommendationPayload
            && contentLibrary === libraryAtStart && contentLibrary !== "arabic") {
          var rows = previewRows || core.readHistory(local);
          var feedback = recommendations ? recommendations.readFeedback(local) : { ratings: {} };
          paintRecommendationRows(recommendations.selectRows(rows, feedback, recommendationPayload, { runtimes: knownRuntimes }));
        }
      });
    }
    function refreshRecommendations() {
      if (!recommendations || disposed) return;
      var rows = previewRows || core.readHistory(local), feedback = recommendations.readFeedback(local);
      var signature = recommendationSignature(rows, feedback);
      recommendationWantedSignature = signature;
      if (recommendationLoadedSignature === signature) return;
      if (contentLibrary === "arabic" && arabicCatalog && typeof arabicCatalog.selectHomeRows === "function") {
        recommendationLoadedSignature = signature;
        recommendationPayload = null;
        paintRecommendationRows(arabicCatalog.selectHomeRows(rows, feedback));
        if (typeof arabicCatalog.ensureLiveCatalogAsync === "function"
            && !(root.HorizonRoyaCatalog && root.HorizonRoyaCatalog.isLoaded())) {
          arabicCatalog.ensureLiveCatalogAsync().then(function () {
            if (!disposed && contentLibrary === "arabic") {
              paintRecommendationRows(arabicCatalog.selectHomeRows(
                previewRows || core.readHistory(local),
                recommendations.readFeedback(local)
              ));
            }
          }, function () {});
        }
        return;
      }
      if (recommendationPayload) paintRecommendationRows(recommendations.selectRows(rows, feedback, recommendationPayload, { runtimes: knownRuntimes }));
      if (recommendationPending) return;
      if (!recommendationPayload) paintRecommendationRows(recommendationRows);
      var params = new URLSearchParams(nav.search);
      var task = useMock ? new Promise(function (resolve) {
        clock.setTimeout(function () { var payload = params.get("rec-fail") === "1"
          ? { seeds: [], candidates: [] } : mock.recommendations();
          if (params.get("rec-one-row") === "1") payload.candidates = payload.candidates.filter(function (row) {
            return row.sources.some(function (source) { return source.kind === "trending"; });
          });
          resolve({ payload: payload });
        }, params.get("rec-delay") === "1" ? 900 : 0);
      }) : recommendations.loadBundle(local, function (path) {
        var request = options.request || root.fetch.bind(root), controller = new AbortController();
        var timer = clock.setTimeout(function () { controller.abort(); }, 6500);
        return request(path, { credentials: "same-origin", signal: controller.signal })
          .finally(function () { clock.clearTimeout(timer); });
      });
      recommendationPending = task;
      task.then(function (bundle) {
        if (disposed || recommendationPending !== task) return;
        recommendationPayload = bundle.payload;
        if (recommendationWantedSignature !== signature) return;
        recommendationLoadedSignature = signature;
        paintRecommendationRows(recommendations.selectRows(rows, feedback, bundle.payload, { runtimes: knownRuntimes }));
        enrichCandidateRuntimes(bundle.payload.candidates);
      }, function () {
        if (!disposed && recommendationWantedSignature === signature)
          paintRecommendationRows({ top: [], because: [], seed: null });
      }).finally(function () {
        if (recommendationPending === task) recommendationPending = null;
        if (!disposed && recommendationWantedSignature !== signature) refreshRecommendations();
      });
    }
    function getFallbackDiscoverSeed() {
      var hist = core.readHistory(local);
      if (contentLibrary === "arabic" && arabicCatalog) {
        if (Array.isArray(hist)) {
          for (var i = 0; i < hist.length; i++) {
            var matched = arabicCatalog.findByKey(hist[i].type, hist[i].id);
            if (matched) return arabicCatalog.toSearchSummary(matched);
          }
        }
        var firstAr = arabicCatalog.findByKey("tv", 90674) || arabicCatalog.ARABIC_TITLES[0];
        if (firstAr) return arabicCatalog.toSearchSummary(firstAr);
      }
      if (Array.isArray(hist) && hist.length > 0) {
        var first = hist[0];
        if (first && first.id) return { type: first.type, id: first.id, title: first.title, poster: first.poster, backdrop: first.backdrop };
      }
      if (recommendationRows && recommendationRows.seed) {
        return recommendationRows.seed;
      }
      return { type: "tv", id: 70523, title: "Dark", poster: "/wiiyc3m6HKaQhFBYeuM7ySCNQsG.jpg" };
    }
    function launchDiscoverWithSeed(seedTitle, source) {
      if (source === "details") {
        state.discoverReturnDetails = {
          title: state.title,
          season: state.season,
          episodes: state.episodes
        };
      } else {
        state.discoverReturnDetails = null;
      }
      discoverActiveSeed = {
        type: seedTitle.type,
        id: seedTitle.id,
        title: seedTitle.title,
        date: seedTitle.date,
        poster: seedTitle.poster,
        backdrop: seedTitle.backdrop
      };
      discoverData = null;
      tabRowMemory["discover"] = Object.create(null);
      tabLastContent["discover"] = null;
      homeRowMemory = Object.create(null);
      homeLastContent = null;
      rowCycleIndex = Object.create(null);
      if (state.view !== "watch") setView("watch");
      setWatchTab("discover");
    }
    function normalizeDiscoverCard(s) {
      if (!s) return null;
      var c = s.candidate || s;
      if (!c || !c.id) return null;
      var reason = s.matchReason || s.reason || (s.candidate && (s.candidate.matchReason || s.candidate.reason)) || "";
      var rawTitle = c.title || c.name || "Untitled";
      var posterPath = c.poster || c.poster_path || null;
      var backdropPath = c.backdrop || c.backdrop_path || null;
      return Object.assign({}, c, {
        type: c.type === "tv" ? "tv" : "movie",
        id: Number(c.id),
        title: String(rawTitle).slice(0, 160),
        poster: posterPath,
        backdrop: backdropPath,
        matchReason: reason
      });
    }
    function loadDiscoverData(force) {
      if (force) {
        discoverData = null;
        discoverError = false;
      }
      if (!discoverActiveSeed) {
        discoverActiveSeed = getFallbackDiscoverSeed();
        updateFilterStripUI();
      }
      var emptySec = get("watch-filter-empty");
      if (!discoverActiveSeed) {
        discoverLoading = false;
        discoverError = false;
        if (emptySec) {
          var p = emptySec.querySelector("p");
          if (p) p.textContent = "Choose a seed title to find similar movies and TV shows.";
          var btn = get("watch-filter-empty-clear");
          if (btn) btn.textContent = "Select Seed";
          emptySec.hidden = false;
        }
        populatePosterRow("discover-closest", []);
        populatePosterRow("discover-vibe", []);
        populatePosterRow("discover-genre", []);
        populatePosterRow("discover-gems", []);
        updateHomeSections();
        return;
      }
      var seed = discoverActiveSeed;
      var token = ++discoverFetchToken;
      discoverLoading = true;
      discoverError = false;

      var feedback = recommendations ? recommendations.readFeedback(local) : { ratings: {} };
      var avoids = [];
      if (feedback && feedback.ratings) {
        Object.keys(feedback.ratings).forEach(function (k) {
          if (feedback.ratings[k] === "disliked") avoids.push(k);
        });
      }

      function handleResponse(data) {
        if (disposed || token !== discoverFetchToken || state.view !== "watch") return;
        discoverLoading = false;
        discoverError = false;
        discoverData = data;
        renderDiscoverRows(data);
      }

      if (contentLibrary === "arabic" && arabicCatalog && typeof arabicCatalog.similarTitles === "function") {
        handleResponse(arabicCatalog.similarTitles(seed.type, seed.id, discoverMedia, avoids.join(",")));
      } else if (useMock && mock.discoverSimilar) {
        var mockRes = mock.discoverSimilar(seed.type, seed.id, discoverMedia, avoids);
        handleResponse(mockRes);
      } else {
        var queryParams = new URLSearchParams();
        queryParams.set("type", seed.type);
        queryParams.set("id", String(seed.id));
        queryParams.set("target", discoverMedia);
        if (avoids.length) queryParams.set("avoid", avoids.slice(0, 50).join(","));
        api("/api/discover-similar?" + queryParams.toString()).then(function (data) {
          handleResponse(data);
        }).catch(function () {
          if (contentLibrary === "arabic" && arabicCatalog && typeof arabicCatalog.similarTitles === "function") {
        handleResponse(arabicCatalog.similarTitles(seed.type, seed.id, discoverMedia, avoids.join(",")));
      } else if (useMock && mock.discoverSimilar) {
            handleResponse(mock.discoverSimilar(seed.type, seed.id, discoverMedia, avoids));
            return;
          }
          if (disposed || token !== discoverFetchToken || state.view !== "watch") return;
          discoverLoading = false;
          discoverError = true;
          var emp = get("watch-filter-empty");
          if (emp) {
            var p = emp.querySelector("p");
            if (p) p.textContent = "Could not load recommendations. Check your connection and retry.";
            var btn = get("watch-filter-empty-clear");
            if (btn) btn.textContent = "Retry";
            emp.hidden = false;
          }
          populatePosterRow("discover-closest", []);
          populatePosterRow("discover-vibe", []);
          populatePosterRow("discover-genre", []);
          populatePosterRow("discover-gems", []);
          updateHomeSections();
        });
      }
    }
    function renderDiscoverRows(data) {
      if (!data || !data.seed) return;
      var previousDiscoverFocus = homeFocusIdentity(doc.activeElement);
      var rawSeed = data.seed;
      var seed = {
        type: rawSeed.type === "tv" ? "tv" : "movie",
        id: Number(rawSeed.id),
        title: String(rawSeed.title || rawSeed.name || "Untitled").slice(0, 160),
        poster: rawSeed.poster || rawSeed.poster_path || null,
        backdrop: rawSeed.backdrop || rawSeed.backdrop_path || null,
        genreIds: rawSeed.genreIds || rawSeed.genre_ids || [],
        keywords: rawSeed.keywords || [],
        creators: rawSeed.creators || []
      };
      var candidates = data.candidates || [];
      discoverActiveSeed = seed;
      updateFilterStripUI();
      var feedback = recommendations ? recommendations.readFeedback(local) : { ratings: {} };
      var hist = core.readHistory(local);

      var discoverEngine = root.HorizonDiscoverEngine;
      var ranked = null;
      if (discoverEngine && discoverEngine.rankDiscoverCategories) {
        ranked = discoverEngine.rankDiscoverCategories(seed, candidates, {
          feedback: feedback,
          history: hist,
          hideFinished: discoverHideFinished,
          targetMedia: discoverMedia,
          filters: isFilterActive("discover") ? discoverFilters : null
        });
      }

      var closestList = ranked ? (ranked.closest || []).map(normalizeDiscoverCard).filter(Boolean) : [];
      var vibeList = ranked ? (ranked.vibe || []).map(normalizeDiscoverCard).filter(Boolean) : [];
      var genreList = ranked ? (ranked.genre || []).map(normalizeDiscoverCard).filter(Boolean) : [];
      var gemsList = ranked ? (ranked.gems || []).map(normalizeDiscoverCard).filter(Boolean) : [];

      populatePosterRow("discover-closest", closestList);
      populatePosterRow("discover-vibe", vibeList);
      populatePosterRow("discover-genre", genreList);
      populatePosterRow("discover-gems", gemsList);

      text("watch-discover-closest-heading", "Closest Matches to " + seed.title);
      text("watch-discover-vibe-heading", "Same Vibe as " + seed.title);
      text("watch-discover-genre-heading", "Same Genre, Different Story");
      text("watch-discover-gems-heading", "Hidden Gems for Fans of " + seed.title);

      var emptySec = get("watch-filter-empty");
      var anyResults = (closestList.length > 0 || vibeList.length > 0 || genreList.length > 0 || gemsList.length > 0);
      if (emptySec) {
        if (!anyResults) {
          var isFiltered = isFilterActive("discover") || discoverMedia !== "same";
          var msg = isFiltered
            ? "No similar titles match the selected filters."
            : "No similar titles found for " + seed.title + ".";
          var p = emptySec.querySelector("p");
          if (p) p.textContent = msg;
          var btn = get("watch-filter-empty-clear");
          if (btn) btn.textContent = isFiltered ? "Clear Filters" : "Choose Another Seed";
          emptySec.hidden = (state.watchTab !== "discover");
        } else {
          emptySec.hidden = true;
        }
      }

      updateHomeSections();
      if (previousDiscoverFocus && previousDiscoverFocus.group.indexOf("discover-") === 0) {
        var restored = resolveHomeSelection(previousDiscoverFocus);
        if (restored) focus(restored);
      }
    }
    function renderHomepage() {
      var rows = previewRows || core.readHistory(local);
      paintHomepage(core.homepageContinueCandidates(rows, local).filter(function (row) {
        return !core.isContinueHidden(local, row);
      }));
      if (state.watchTab === "discover") {
        loadDiscoverData();
      }
      if (!previewHistoryMode) core.groupedHistory(rows).filter(function (row) {
        return row.type === "tv" && row.progress && row.progress.completed;
      }).slice(0, 6).forEach(function (row) {
        var catalog = core.readEpisodeCatalog(local, row.id);
        if (catalog && Date.now() - catalog.at < 6 * 60 * 60 * 1000
            || catalogRequests[row.id] === true
            || Number.isFinite(catalogRequests[row.id]) && Date.now() - catalogRequests[row.id] < 10 * 60 * 1000) return;
        catalogRequests[row.id] = true;
        api("/api/title/tv/" + row.id).then(function (detail) {
          if (disposed) return;
          if (core.writeEpisodeCatalog(local, row.id, detail && detail.seasons)) {
            homeDetailCache.set("tv:" + row.id, Promise.resolve(detail));
            if (state.view === "watch") renderHomepage();
          }
        }, function () {}).finally(function () { catalogRequests[row.id] = Date.now(); });
      });
      refreshRecommendations();
    }
    function showWatch(resetFocus) {
      if (resetFocus === true) homeReturnFocus = null;
      setView("watch"); renderHomepage(); focusHomeTarget(); saveView();
    }
    function renderDetailArt(row) {
      var art = get("detail-art"), view = get("details-view");
      art.replaceChildren(); art.classList.remove("is-poster");
      view.classList.remove("has-art", "is-poster");
      var backdropUrl = core.imageUrl(row.backdrop, "hero");
      var posterUrl = core.imageUrl(row.poster, "poster");
      if (!backdropUrl && !posterUrl) return;
      var image = doc.createElement("img"); image.alt = "";
      var posterTried = !backdropUrl;
      view.classList.add("has-art");
      if (posterTried) { art.classList.add("is-poster"); view.classList.add("is-poster"); }
      image.addEventListener("error", function () {
        if (!art.contains(image)) return;
        if (!posterTried && posterUrl) {
          posterTried = true; art.classList.add("is-poster"); view.classList.add("is-poster"); image.src = posterUrl;
        } else { art.replaceChildren(); view.classList.remove("has-art", "is-poster"); art.classList.remove("is-poster"); }
      });
      image.src = backdropUrl || posterUrl;
      art.appendChild(image);
    }
    function renderResults(rows, appendMode) {
      if (!appendMode) {
        results.replaceChildren();
        results.scrollTop = 0;
      } else {
        var oldMore = results.querySelector(".lg-search-load-more");
        if (oldMore && oldMore.parentNode) oldMore.parentNode.removeChild(oldMore);
      }
      rows.forEach(function (row) {
        var card = button("", function () { openDetails(row); }, "poster-card search-card home-card-poster");
        card.dataset.mediaType = row.type;
        card.dataset.mediaId = String(row.id);
        var art = verticalPosterArt(row);
        var badge = doc.createElement("span");
        badge.className = "search-badge";
        badge.textContent = localize(row.type === "tv" ? "TV" : "Movie");
        art.appendChild(badge);
        if (row.resume && row.resume.progress && !row.resume.progress.completed && row.resume.progress.duration > 0) {
          var bar = doc.createElement("span"); bar.className = "home-progress-bar";
          var fill = doc.createElement("span"); fill.className = "home-progress-fill";
          fill.style.width = Math.min(100, Math.max(5, Math.round(row.resume.progress.position / row.resume.progress.duration * 100))) + "%";
          bar.appendChild(fill); art.appendChild(bar);
        }
        var meta = doc.createElement("span"); meta.className = "poster-meta";
        var title = doc.createElement("strong"); title.dir = "auto"; title.textContent = row.title;
        var availabilityTag = contentLibrary === "arabic" ? "" : row.plus ? " · Roya Plus"
          : (row.royaSeriesId ? " · Roya HLS"
          : (row.availabilityState === "playable" ? " · Play in Horizon"
          : (row.availabilityState === "subscription_required" ? (" · " + ((row.regionalPlatforms && row.regionalPlatforms[0] && (row.regionalPlatforms[0].nameEn || row.regionalPlatforms[0].slug)) || "Subscription"))
          : (row.availabilityState === "listed_on_provider" ? (" · " + ((row.regionalPlatforms && row.regionalPlatforms[0] && (row.regionalPlatforms[0].nameEn || row.regionalPlatforms[0].slug)) || "External"))
          : ""))));
        var info = doc.createElement("small"); info.textContent = row.resume && row.type === "movie"
          ? row.resume.progress && !row.resume.progress.completed
            ? "Movie · " + Math.round(row.resume.progress.position / row.resume.progress.duration * 100) + "% watched"
            : "Movie" : row.resume && row.type === "tv"
          ? "S" + row.resume.season + " E" + row.resume.episode + (row.resume.episodeTitle ? " · " + row.resume.episodeTitle : "")
            + (row.resume.progress && !row.resume.progress.completed
              ? " · " + Math.round(row.resume.progress.position / row.resume.progress.duration * 100) + "% watched"
              : row.resume.progress && row.resume.progress.completed ? " · completed" : "")
          : (row.type === "tv" ? "TV" : "Movie") + (row.date ? " · " + row.date.slice(0, 4) : "")
            + availabilityTag;
        if (contentLibrary === "arabic") {
          info.textContent = info.textContent.replace(/^Movie/, localize("Movie")).replace(/^TV/, localize("TV"))
            .replace(/^S(\d+) E(\d+)/, "الموسم $1 · الحلقة $2")
            .replace(/(\d+)% watched/g, "تمت مشاهدة $1٪").replace(/ · completed$/, " · اكتملت المشاهدة");
        }
        meta.appendChild(title); meta.appendChild(info); card.appendChild(art); card.appendChild(meta);
        card.setAttribute("aria-label", row.title + ", " + info.textContent);
        results.appendChild(card);
      });
    }
    function focusSelectedResult() {
      var selected = state.title && Array.from(results.querySelectorAll("button")).find(function (card) {
        return card.dataset.mediaType === state.title.type && card.dataset.mediaId === String(state.title.id);
      });
      focus(selected || results.querySelector("button") || query);
    }
    function backToResults() {
      if (state.detailSource === "watch") {
        setView("watch");
        setWatchTab(state.detailSourceTab || "for-you");
        return;
      }
      if (state.detailSource === "history") {
        state.detailSource = "search"; setView("history"); renderHistory(); focus(get("history-back")); return;
      }
      setView("search"); focusSelectedResult(); saveView();
    }
    function backToDetails() { setView("details"); focus(get("details-back")); saveView(); }
    function exitToHome() {
      if (state.view === "watch") {
        if (state.watchTab !== "for-you") setWatchTab("for-you");
        focus(get("watch-toggle"));
        return;
      }
      showWatch(true);
    }
    function searchNow(explicit, pageArg) {
      if (disposed || state.continueMode) return;
      syncRail();
      if (searchTimer !== null) { clock.clearTimeout(searchTimer); searchTimer = null; }
      var q = state.query.trim(), token = ++searchToken;
      var page = Math.max(1, Number(pageArg) || 1);
      if (activeAbort) activeAbort.abort();
      if (q.length < (explicit ? 1 : 2)) { renderResults([]); text("search-status", "Enter at least two characters to search, or press OK to submit."); return; }
      text("search-status", contentLibrary === "arabic" ? "Searching Arabic catalog (TMDB · ArabCinemeta · Roya)…" : "Searching…");
      var key = contentLibrary + ":" + state.filter + ":" + q.toLowerCase();
      var cached = cache.get(key);
      if (page === 1 && cached && Date.now() - cached.at < 420000) {
        renderResults(cached.rows);
        if (cached.hasMore) appendLoadMoreButton(cached.totalResults, 2);
        text("search-status", cached.rows.length
          ? (cached.totalResults > cached.rows.length ? ("Showing " + cached.rows.length + " of " + cached.totalResults + " results") : (cached.rows.length + " results"))
          : "No titles found.");
        return;
      }
      activeAbort = new AbortController();
      var searchUrl = "/api/search?q=" + encodeURIComponent(q) + "&type=" + state.filter
        + (contentLibrary === "arabic" && page > 1 ? "&page=" + page : "");
      api(searchUrl, activeAbort.signal)
        .then(function (value) {
          if (disposed || token !== searchToken) return;
          var rawRows = Array.isArray(value.results) ? value.results : [];
          var rows = value.preRanked ? rawRows : core.rankResults(rawRows, q);
          var totalResults = Number(value.totalResults) || rows.length;
          var hasMore = Boolean(value.hasMore);
          if (page === 1) {
            if (cache.size >= 40) cache.delete(cache.keys().next().value);
            cache.set(key, { at: Date.now(), rows: rows, totalResults: totalResults, hasMore: hasMore });
            renderResults(rows, false);
          } else {
            var prevCached = cache.get(key);
            var combined = prevCached ? prevCached.rows.concat(rows) : rows;
            cache.set(key, { at: Date.now(), rows: combined, totalResults: totalResults, hasMore: hasMore });
            renderResults(rows, true);
            rows = combined;
          }
          if (hasMore) appendLoadMoreButton(totalResults, page + 1);
          text("search-status", rows.length
            ? (totalResults > rows.length ? ("Showing " + rows.length + " of " + totalResults + " results") : (rows.length + " results"))
            : "No titles found.");
        }, function (error) {
          if (disposed || token !== searchToken || error.name === "AbortError") return;
          renderResults([]); text("search-status", error.status === 429
            ? "Search is rate limited. Try again" + (error.retryAfter ? " in about " + error.retryAfter + " seconds." : " shortly.")
            : "Search unavailable. Press Retry or edit the query.");
          results.appendChild(button("Retry", function () { searchNow(true, page); }));
        });
    }
    function appendLoadMoreButton(totalResults, nextPage) {
      var moreBtn = button("Load More Results (Total " + totalResults + ")", function () {
        searchNow(true, nextPage);
      }, "lg-search-load-more detail-secondary");
      results.appendChild(moreBtn);
    }
    function scheduleSearch(delay) {
      state.continueMode = false;
      syncRail();
      if (searchTimer !== null) clock.clearTimeout(searchTimer);
      searchToken += 1; if (activeAbort) activeAbort.abort();
      text("search-status", state.query.trim().length < 2 ? "Enter at least two characters to search, or press OK to submit." : "Waiting to search…");
      if (state.query.trim().length >= 2) searchTimer = clock.setTimeout(function () { searchTimer = null; searchNow(false); }, delay);
      else renderResults([]);
    }
    function showContinue() {
      if (searchTimer !== null) { clock.clearTimeout(searchTimer); searchTimer = null; }
      searchToken += 1; if (activeAbort) activeAbort.abort();
      state.continueMode = true; setView("search");
      var history = core.readHistory(local || { getItem: function () { return null; } });
      renderResults(core.continueRows(history).map(function (row) { return { type: row.type, id: row.id, title: row.title,
        date: "", poster: row.poster, backdrop: row.backdrop, resume: row }; }));
      text("search-status", history.length ? "Continue Watching · resume or choose the next confirmed episode"
        : "Nothing in Continue Watching yet.");
      focus(results.querySelector("button") || query);
    }
    function settingsHistoryKey(row) {
      return row.type + ":" + row.id;
    }
    function groupSettingsHistory(rows) {
      var groups = [], byKey = Object.create(null);
      rows.forEach(function (row) {
        var key = settingsHistoryKey(row);
        var existing = byKey[key];
        if (!existing) {
          existing = byKey[key] = {
            key: key,
            type: row.type,
            id: row.id,
            title: row.title,
            poster: row.poster || null,
            backdrop: row.backdrop || null,
            representative: row,
            episodeCount: row.type === "tv" ? 1 : 0,
            seasons: row.type === "tv" && Number.isInteger(row.season) ? [row.season] : []
          };
          groups.push(existing);
        } else {
          if (!existing.poster && row.poster) existing.poster = row.poster;
          if (!existing.backdrop && row.backdrop) existing.backdrop = row.backdrop;
          if (row.type === "tv") {
            existing.episodeCount += 1;
            if (Number.isInteger(row.season) && existing.seasons.indexOf(row.season) < 0)
              existing.seasons.push(row.season);
          }
        }
      });
      return groups;
    }
    function focusSettingsHistoryEntry(preferredKey, fallbackIndex) {
      var host = get("settings-history");
      var items = host ? Array.from(host.querySelectorAll(".settings-history-item")) : [];
      if (!items.length) {
        focus(get("settings-subpage-back") || get("settings-toggle"));
        return;
      }
      var match = preferredKey ? items.find(function (btn) { return btn.dataset.historyKey === preferredKey; }) : null;
      var idx = Math.max(0, Math.min(items.length - 1, Number.isInteger(fallbackIndex) ? fallbackIndex : 0));
      focus(match || items[idx]);
    }
    function closeSettingsHistoryActions() {
      var item = state.settingsHistoryItem;
      if (!item) return;
      state.settingsHistoryItem = null;
      renderSettings();
      focusSettingsHistoryEntry(item.key, item.index);
    }
    function renderSettings() {
      var movementButton = get("settings-carousel-movement");
      if (movementButton) {
        var isGlide = heroPreferences.carouselMovement === "glide";
        movementButton.textContent = localize(isGlide ? "Glide" : "Instant");
        movementButton.setAttribute("aria-pressed", String(isGlide));
      }
      var delayButton = get("settings-hero-delay"), fadeButton = get("settings-hero-fade");
      if (delayButton) delayButton.textContent = heroPreferences.delay ? heroPreferences.delay + (contentLibrary === "arabic" ? " مللي ثانية" : "ms") : localize("Immediate");
      if (fadeButton) {
        fadeButton.textContent = localize(heroPreferences.fade ? "Fade On" : "Fade Off");
        fadeButton.setAttribute("aria-pressed", String(heroPreferences.fade));
      }
      [
        ["settings-poster-glide", "glide"],
        ["settings-hold-scroll", "hold"],
        ["settings-scroll-animations", "scrollAnimations"],
        ["settings-artwork-fade", "artworkFade"]
      ].forEach(function (pair) {
        var control = get(pair[0]);
        if (control) {
          control.textContent = localize(heroPreferences[pair[1]] ? "On" : "Off");
          control.setAttribute("aria-pressed", String(heroPreferences[pair[1]]));
        }
      });
      var rows = core.readHistory(local), visible = core.homepageContinueCandidates(rows, local);
      var continueHost = get("settings-continue"), historyHost = get("settings-history"),
        actionsHost = get("settings-history-actions");
      if (continueHost) continueHost.replaceChildren();
      if (historyHost) historyHost.replaceChildren();
      if (actionsHost) { actionsHost.replaceChildren(); actionsHost.hidden = true; }
      var tasteHost = get("settings-taste");
      if (tasteHost) tasteHost.replaceChildren();
      var tasteRatings = recommendations && recommendations.readFeedback(local).ratings || {};
      if (tasteHost) {
        var tasteLine = doc.createElement("div"); tasteLine.className = "settings-entry";
        var tasteLabel = doc.createElement("span");
        tasteLabel.textContent = Object.keys(tasteRatings).length + " saved Love It / Not Interested choices";
        tasteLine.appendChild(tasteLabel);
        var confirmTasteReset = false;
        tasteLine.appendChild(button("Reset recommendation choices", function () {
          if (!confirmTasteReset) { confirmTasteReset = true;
            this.textContent = localize("Confirm reset choices"); focus(this); return; }
          if (recommendations && recommendations.resetFeedback(local)) {
            recommendationLoadedSignature = "";
            renderSettings(); refreshRecommendations();
            focus(get("settings-taste").querySelector("button"));
          }
        }));
        tasteHost.appendChild(tasteLine);
      }
      if (continueHost) {
        if (!visible.length) { var empty = doc.createElement("p"); empty.textContent = localize("No unfinished titles saved.");
          continueHost.appendChild(empty); }
        visible.forEach(function (row) {
          var line = doc.createElement("div"); line.className = "settings-entry";
          var name = doc.createElement("span"); name.textContent = row.title + " · " + homeContext(row);
          var hidden = core.isContinueHidden(local, row);
          line.appendChild(name);
          line.appendChild(button(hidden ? "Restore to Continue" : "Hide from Continue", function () {
            core.setContinueHidden(local, row, !hidden); renderSettings(); focus(get("settings-toggle"));
          })); continueHost.appendChild(line);
        });
      }
      if (historyHost) {
        var groupedHistory = groupSettingsHistory(rows);
        var activeItem = state.settingsHistoryItem;
        var matchedGroup = activeItem ? groupedHistory.find(function (g) { return g.key === activeItem.key; }) : null;
        if (activeItem && !matchedGroup) state.settingsHistoryItem = null;
        if (state.settingsHistoryItem && matchedGroup && actionsHost) {
          var matchedRow = matchedGroup.representative;
          historyHost.hidden = true;
          actionsHost.hidden = false;
          var head = doc.createElement("div"); head.className = "settings-history-actions-head";
          var thumb = doc.createElement("span"); thumb.className = "settings-history-thumb";
          var imgPath = matchedGroup.poster || matchedGroup.backdrop;
          var img = imgPath ? poster(imgPath, matchedGroup.poster ? "poster" : "backdrop", false) : null;
          if (img) thumb.appendChild(img);
          else {
            var fb = doc.createElement("span"); fb.className = "settings-history-thumb-fallback";
            fb.textContent = (matchedGroup.title || "?").slice(0, 1).toUpperCase();
            thumb.appendChild(fb);
          }
          var meta = doc.createElement("span"); meta.className = "settings-history-meta";
          var titleEl = doc.createElement("strong"); titleEl.textContent = matchedGroup.title;
          var detailEl = doc.createElement("small");
          detailEl.textContent = matchedGroup.type === "tv"
            ? ("Series · " + matchedGroup.episodeCount + (matchedGroup.episodeCount === 1 ? " episode" : " episodes"))
            : "Movie";
          meta.appendChild(titleEl); meta.appendChild(detailEl);
          head.appendChild(thumb); head.appendChild(meta);
          actionsHost.appendChild(head);

          var btnRow = doc.createElement("div"); btnRow.className = "settings-history-actions-buttons";
          var continueHidden = core.isContinueHidden(local, matchedRow);
          var continueBtn = button(continueHidden ? "Restore to Continue" : "Hide from Continue", function () {
            core.setContinueHidden(local, matchedRow, !continueHidden);
            renderSettings();
            var nextContinueBtn = actionsHost.querySelector('[data-history-action="continue"]');
            focus(nextContinueBtn || get("settings-subpage-back"));
          });
          continueBtn.dataset.historyAction = "continue";
          btnRow.appendChild(continueBtn);

          var confirmRemove = false;
          var removeBtn = button("Remove from History", function () {
            if (!confirmRemove) {
              confirmRemove = true;
              this.textContent = localize("Confirm remove from history");
              focus(this);
              return;
            }
            var savedIdx = activeItem.index;
            core.deleteHistory(local, matchedRow.type, matchedRow.id, matchedRow.season, matchedRow.episode, true);
            state.settingsHistoryItem = null;
            renderSettings();
            focusSettingsHistoryEntry(null, savedIdx);
          });
          removeBtn.dataset.historyAction = "remove";
          btnRow.appendChild(removeBtn);
          btnRow.appendChild(button("Back to list", closeSettingsHistoryActions));
          actionsHost.appendChild(btnRow);
        } else {
          historyHost.hidden = false;
          if (!groupedHistory.length) {
            var noHistory = doc.createElement("p"); noHistory.textContent = localize("No saved viewing history.");
            historyHost.appendChild(noHistory);
          }
          groupedHistory.forEach(function (group, idx) {
            var itemBtn = button("", function () {
              state.settingsHistoryItem = { key: group.key, index: idx };
              renderSettings();
              var firstAction = actionsHost && actionsHost.querySelector("[data-focus]");
              if (firstAction) focus(firstAction);
            }, "settings-history-item");
            itemBtn.dataset.historyKey = group.key;
            var thumb = doc.createElement("span"); thumb.className = "settings-history-thumb";
            var imgPath = group.poster || group.backdrop;
            var img = imgPath ? poster(imgPath, group.poster ? "poster" : "backdrop", false) : null;
            if (img) thumb.appendChild(img);
            else {
              var fb = doc.createElement("span"); fb.className = "settings-history-thumb-fallback";
              fb.textContent = (group.title || "?").slice(0, 1).toUpperCase();
              thumb.appendChild(fb);
            }
            var meta = doc.createElement("span"); meta.className = "settings-history-meta";
            var titleEl = doc.createElement("strong"); titleEl.textContent = group.title;
            var detailEl = doc.createElement("small");
            detailEl.textContent = group.type === "tv"
              ? ("Series · " + group.episodeCount + (group.episodeCount === 1 ? " episode" : " episodes"))
              : "Movie";
            meta.appendChild(titleEl); meta.appendChild(detailEl);
            itemBtn.appendChild(thumb); itemBtn.appendChild(meta);
            itemBtn.setAttribute("aria-label", group.title + " · " + detailEl.textContent);
            historyHost.appendChild(itemBtn);
          });
        }
      }
      var appSummary = get("settings-summary-appearance");
      if (appSummary) {
        appSummary.textContent = (heroPreferences.carouselMovement === "glide" ? "Glide" : "Instant")
          + " · Poster Glide " + (heroPreferences.glide ? "On" : "Off")
          + " · Hold " + (heroPreferences.hold ? "On" : "Off")
          + " · Animations " + (heroPreferences.scrollAnimations ? "On" : "Off")
          + " · Fade " + (heroPreferences.fade ? "On" : "Off");
      }
      var browseSummary = get("settings-summary-browsing");
      if (browseSummary) {
        browseSummary.textContent = "Hero delay: " + (heroPreferences.delay ? heroPreferences.delay + "ms" : "Immediate");
      }
      var libButton = get("settings-content-library");
      if (libButton) {
        var isArLib = contentLibrary === "arabic";
        libButton.textContent = localize(isArLib ? "Arabic Horizon — العربية" : "Standard Horizon");
        libButton.setAttribute("aria-pressed", String(isArLib));
      }
      var libSummary = get("settings-summary-library");
      if (libSummary) {
        libSummary.textContent = (contentLibrary === "arabic" ? "Arabic Horizon" : "Standard Horizon")
          + " · " + visible.length + " Continue · " + rows.length + " History · " + Object.keys(tasteRatings).length + " ratings";
      }
    }
    var SETTINGS_CATEGORIES = {
      appearance: {
        title: "Appearance & Motion",
        desc: "Customize scrolling physics, poster glide, animations, and artwork transitions",
        panelId: "settings-panel-appearance"
      },
      browsing: {
        title: "Browsing & Display",
        desc: "Fine-tune hero preview latency and display responsiveness",
        panelId: "settings-panel-browsing"
      },
      library: {
        title: "Library & Content",
        desc: "Manage Continue Watching, stored viewing history, and recommendation preferences",
        panelId: "settings-panel-library"
      },
      about: {
        title: "About Horizon",
        desc: "System version, local storage notice, and TMDB metadata attribution",
        panelId: "settings-panel-about"
      }
    };
    function openSettingsCategory(catId) {
      var cat = SETTINGS_CATEGORIES[catId];
      if (!cat) return;
      state.settingsCategory = catId;
      state.lastSettingsCategory = catId;
      get("settings-landing").hidden = true;
      var subpage = get("settings-subpage");
      subpage.hidden = false;
      text("settings-subpage-title", localize(cat.title));
      text("settings-subpage-desc", cat.desc);
      ["settings-panel-appearance", "settings-panel-browsing", "settings-panel-library", "settings-panel-about"].forEach(function (pid) {
        var p = get(pid);
        if (p) p.hidden = (pid !== cat.panelId);
      });
      var panel = get(cat.panelId);
      var firstBtn = panel && panel.querySelector("[data-focus]");
      focus(firstBtn || get("settings-subpage-back"));
    }
    function closeSettingsCategory() {
      state.settingsHistoryItem = null;
      state.settingsCategory = null;
      get("settings-subpage").hidden = true;
      get("settings-landing").hidden = false;
      ["settings-panel-appearance", "settings-panel-browsing", "settings-panel-library", "settings-panel-about"].forEach(function (pid) {
        var p = get(pid);
        if (p) p.hidden = true;
      });
      var returnBtn = get("settings-cat-" + (state.lastSettingsCategory || "appearance"));
      focus(returnBtn || get("settings-toggle"));
    }
    function showSettings() {
      state.previousView = state.view === "settings" ? state.previousView : state.view;
      state.settingsHistoryItem = null;
      state.settingsCategory = null;
      get("settings-subpage").hidden = true;
      get("settings-landing").hidden = false;
      ["settings-panel-appearance", "settings-panel-browsing", "settings-panel-library", "settings-panel-about"].forEach(function (pid) {
        var p = get(pid);
        if (p) p.hidden = true;
      });
      setView("settings");
      renderSettings();
      focus(get("settings-cat-" + (state.lastSettingsCategory || "appearance")) || get("settings-toggle"));
      saveView();
    }
    function createHistoryCard(row) {
      var isTv = row.type === "tv";
      var percent = row.progress && !row.progress.completed && row.progress.duration > 0
        ? Math.round(row.progress.position / row.progress.duration * 100) : 0;
      var label = row.title + (isTv ? " · S" + row.season + " E" + row.episode
        + (row.episodeTitle ? " · " + row.episodeTitle : "") : "")
        + (percent > 0 ? " · " + percent + "% watched" : "")
        + " · " + new Date(row.at).toLocaleDateString();
      var card = button(label, function () { launchHistory(row); }, "poster-card history-card home-card-poster");
      card.dataset.mediaType = row.type;
      card.dataset.mediaId = String(row.id);
      var art = verticalPosterArt(row);
      if (percent > 0) {
        var bar = doc.createElement("span"); bar.className = "home-progress-bar";
        var fill = doc.createElement("span"); fill.className = "home-progress-fill";
        fill.style.width = Math.min(100, Math.max(5, percent)) + "%";
        bar.appendChild(fill); art.appendChild(bar);
      }
      var meta = doc.createElement("span"); meta.className = "poster-meta";
      var name = doc.createElement("strong"); name.textContent = row.title;
      var detail = doc.createElement("small");
      detail.textContent = isTv
        ? (localize("S" + row.season + " E" + row.episode) + (percent > 0 ? " · " + percent + "%" : ""))
        : (localize("Movie") + (percent > 0 ? " · " + percent + "%" : ""));
      meta.appendChild(name); meta.appendChild(detail);
      card.textContent = "";
      card.appendChild(art); card.appendChild(meta); card.setAttribute("aria-label", label);
      return card;
    }
    function renderHistory() {
      var allRows = core.readHistory(local);
      var rows = core.groupedHistory(allRows);
      var overview = get("history-overview");
      var empty = get("history-empty");
      var allView = get("history-all-view");
      if (allView) allView.hidden = true;
      if (!rows.length) {
        if (overview) overview.hidden = true;
        if (empty) empty.hidden = false;
        text("history-status", "No viewing history yet.");
        return;
      }
      if (empty) empty.hidden = true;
      if (overview) overview.hidden = false;

      var list = get("history-list");
      list.replaceChildren();
      list.scrollTop = 0;
      var topRows = rows.slice(0, 12);
      topRows.forEach(function (row) {
        list.appendChild(createHistoryCard(row));
      });

      var movieSection = get("history-movies-section");
      var movieList = get("history-movies-list");
      var movieRows = rows.filter(function (r) { return r.type === "movie"; });
      if (movieSection && movieList) {
        if (movieRows.length > 0) {
          movieSection.hidden = false;
          movieList.replaceChildren();
          movieRows.slice(0, 6).forEach(function (row) {
            movieList.appendChild(createHistoryCard(row));
          });
        } else {
          movieSection.hidden = true;
        }
      }

      var tvSection = get("history-tv-section");
      var tvList = get("history-tv-list");
      var tvRows = rows.filter(function (r) { return r.type === "tv"; });
      if (tvSection && tvList) {
        if (tvRows.length > 0) {
          tvSection.hidden = false;
          tvList.replaceChildren();
          tvRows.slice(0, 6).forEach(function (row) {
            tvList.appendChild(createHistoryCard(row));
          });
        } else {
          tvSection.hidden = true;
        }
      }

      text("history-status", rows.length ? rows.length + " recently started titles" : "No viewing history yet.");
    }
    function renderHistoryAll() {
      var allRows = core.readHistory(local);
      var rows = core.groupedHistory(allRows);
      var filter = state.historyFilter || "all";
      var q = (state.historyQuery || "").trim().toLowerCase();
      var filtered = rows.filter(function (row) {
        if (filter !== "all" && row.type !== filter) return false;
        if (q) {
          var matchTitle = row.title && row.title.toLowerCase().indexOf(q) >= 0;
          var matchEp = row.episodeTitle && row.episodeTitle.toLowerCase().indexOf(q) >= 0;
          if (!matchTitle && !matchEp) return false;
        }
        return true;
      });
      var list = get("history-all-list");
      if (list) {
        list.replaceChildren();
        list.scrollTop = 0;
        filtered.forEach(function (row) {
          list.appendChild(createHistoryCard(row));
        });
      }
      var emptyEl = get("history-all-empty");
      if (emptyEl) emptyEl.hidden = (filtered.length > 0);
      text("history-all-count", filtered.length + (filtered.length === 1 ? " title" : " titles"));
    }
    function openHistoryAll() {
      state.historyMode = "all";
      state.historyFilter = "all";
      state.historyQuery = "";
      var searchInput = get("history-search-input");
      if (searchInput) searchInput.value = "";
      doc.querySelectorAll("[data-history-filter]").forEach(function (btn) {
        btn.classList.toggle("is-current", btn.dataset.historyFilter === "all");
      });
      var overview = get("history-overview"), empty = get("history-empty"), allView = get("history-all-view");
      if (overview) overview.hidden = true;
      if (empty) empty.hidden = true;
      if (allView) allView.hidden = false;
      renderHistoryAll();
      focus(get("history-all-back"));
    }
    function closeHistoryAll() {
      state.historyMode = "overview";
      var allView = get("history-all-view");
      if (allView) allView.hidden = true;
      renderHistory();
      focus(get("history-view-all"));
    }
    function showHistory() {
      state.previousView = state.view === "history" ? state.previousView : state.view;
      state.historyMode = "overview";
      clearPending = false; get("history-clear").textContent = localize("Clear History");
      setView("history"); renderHistory(); focus(get("history-back"));
    }
    function leaveHistory() {
      clearPending = false; get("history-clear").textContent = localize("Clear History");
      if (state.historyMode === "all") {
        closeHistoryAll();
        return;
      }
      setView(["details", "episodes", "watch", "settings"].indexOf(state.previousView) >= 0 ? state.previousView : "search");
      if (state.view === "watch") { renderHomepage(); focusHomeTarget(); }
      else if (state.view === "settings") { renderSettings(); focus(get("settings-toggle")); }
      else focus(state.view === "episodes" ? get("episodes-back") : state.view === "details" ? get("details-back") : query);
    }
    function launchHistory(row) {
      if (row.type === "movie") {
        state.detailSource = "history"; state.title = row; launchMovie();
        return;
      }
      row = core.lastWatchedEpisode(core.readHistory(local), row.id) || row;
      state.detailSource = "history";
      state.title = row; state.season = row.season; state.subtitle = core.readSubtitlePref(local);
      state.episodes = [{ number: row.episode, title: row.episodeTitle }];
      setView("episodes"); launchEpisode(row.season, row.episode);
    }
    function renderInformation(detail) {
      var host = get("detail-information"); host.replaceChildren();
      var items = [];
      function add(label, value) {
        if (Array.isArray(value)) value = value.filter(Boolean).slice(0, 4).join(" · ");
        if (value) items.push({ label: label, value: String(value) });
      }
      add("Featured cast", detail.cast);
      add(state.title.type === "tv" ? "Created by" : "Directed by",
        state.title.type === "tv" ? detail.creators : detail.directors);
      add("Genres", detail.genres);
      add(state.title.type === "tv" ? "Original network" : "Studios",
        state.title.type === "tv" ? detail.networks : detail.studios);
      add("Status", state.title.type === "tv" ? detail.status : "");
      var languages = { en: "English", es: "Spanish", fr: "French", de: "German", ja: "Japanese",
        ko: "Korean", zh: "Chinese", hi: "Hindi", it: "Italian", pt: "Portuguese" };
      add("Original language", languages[detail.originalLanguage] || detail.originalLanguage);
      host.hidden = !items.length;
      items.forEach(function (item) {
        var group = doc.createElement("div"); group.className = "detail-fact";
        var label = doc.createElement("span"); label.className = "detail-fact-label"; label.textContent = localize(item.label);
        var value = doc.createElement("span"); value.className = "detail-fact-value"; value.textContent = item.value;
        group.appendChild(label); group.appendChild(value); host.appendChild(group);
      });
    }
    function lookupNextEpisode(recent, detail) {
      if (!detail || !Array.isArray(detail.seasons)) return Promise.resolve(null);
      var seasons = detail.seasons.slice().sort(function (a, b) { return a.number - b.number; });
      if (!seasons.some(function (row) { return row.number === recent.season; })) return Promise.resolve(null);
      return api("/api/season/tv/" + recent.id + "/" + recent.season).then(function (value) {
        var rows = Array.isArray(value.episodes) ? value.episodes : [];
        if (!rows.some(function (row) { return row.number === recent.episode; })) return null;
        var next = core.nextConfirmedEpisode(recent, rows, null, null);
        if (next) return next;
        if (rows.some(function (row) { return row.number > recent.episode; })) return null;
        var following = seasons.find(function (row) { return row.number > recent.season; });
        if (!following) return null;
        return api("/api/season/tv/" + recent.id + "/" + following.number).then(function (season) {
          return core.nextConfirmedEpisode(recent, rows, following.number, season.episodes);
        });
      });
    }
    function resolveNextContinue(recent) {
      if (!state.detail || !Array.isArray(state.detail.seasons)) return;
      var key = recent.id + ":" + recent.season + ":" + recent.episode + ":"
        + (recent.progress && recent.progress.updatedAt || recent.at);
      if (nextContinue && nextContinue.key === key) return;
      var token = detailToken;
      nextContinue = { key: key, status: "pending", target: null };
      lookupNextEpisode(recent, state.detail).then(function (target) {
        if (disposed || token !== detailToken || !nextContinue || nextContinue.key !== key) return;
        nextContinue.status = target ? "ready" : "unavailable";
        nextContinue.target = target;
        renderActions();
      }, function () {
        if (disposed || token !== detailToken || !nextContinue || nextContinue.key !== key) return;
        nextContinue.status = "unavailable"; renderActions();
      });
    }
    function checkArabicPrimary(primary, season, episode) {
      if (contentLibrary !== "arabic" || primary.disabled || !root.HorizonArabicProviders) return;
      primary.dataset.playbackAsset = "1";
      if (season) primary.dataset.season = season;
      if (episode) primary.dataset.episode = episode;
      primary.dataset.playbackLabel = localize(primary.getAttribute("aria-label") || primary.textContent);
      primary.textContent = localize("Checking availability…");
      primary.setAttribute("aria-label", primary.textContent);
      primary.setAttribute("aria-disabled", "true");
    }

    function renderActions() {
      var actions = get("detail-actions");
      var focusedAction = actions.contains(doc.activeElement) ? doc.activeElement.dataset.action : (pendingActionFocus || null);
      actions.replaceChildren();
      function restoreActionFocus() {
        if (focusedAction) focus(actions.querySelector('[data-action="' + focusedAction + '"]:not(:disabled)')
          || actions.querySelector("button:not(:disabled)"));
      }
      function appendFeedbackActions() {
        var feedback = root.HorizonWatchRecommendations;
        if (!feedback || !state.title) return;
        var type = state.title.type, id = state.title.id;
        function syncFeedback() {
          var selected = feedback.readFeedback(local).ratings[type + ":" + id] || "neutral";
          actions.querySelectorAll(".detail-feedback").forEach(function (el) {
            var active = el.dataset.feedback === selected;
            el.classList.toggle("is-selected", active);
            el.setAttribute("aria-pressed", active ? "true" : "false");
          });
        }
        function add(stateValue, label, actionName) {
          var el = detailAction(label, function () {
            var current = feedback.readFeedback(local).ratings[type + ":" + id] || "neutral";
            if (feedback.setFeedback(local, type, id, current === stateValue ? "neutral" : stateValue)) {
              syncFeedback(); refreshRecommendations();
            }
          }, "detail-secondary detail-feedback", actionName || stateValue);
          el.dataset.feedback = stateValue;
          var icon = doc.createElement("span"); icon.className = "detail-feedback-icon";
          icon.setAttribute("aria-hidden", "true");
          if (stateValue === "liked") {
            icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>';
          } else {
            icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line></svg>';
          }
          var text = doc.createElement("span"); text.textContent = localize(label);
          el.replaceChildren(icon, text);
          el.setAttribute("aria-label", localize(label));
          actions.appendChild(el);
        }
        add("liked", "Love It", "love-it");
        add("disliked", "Not Interested", "not-interested");
        syncFeedback();
      }
      if (state.title.type === "movie") {
        var movieHistory = core.readHistory(local).find(function (row) {
          return row.type === "movie" && row.id === state.title.id;
        });
        var movieProgress = movieHistory && movieHistory.progress && !movieHistory.progress.completed
          ? movieHistory.progress : null;
        var moviePrimary = detailAction(movieProgress ? "Resume movie" : "Play movie",
          function () { launchMovie(false); }, "detail-primary", "primary");
        checkArabicPrimary(moviePrimary);
        actions.appendChild(moviePrimary);
        if (movieProgress) actions.appendChild(detailAction("Start Over", function () { launchMovie(true); },
          "detail-secondary", "start-over"));
        actions.appendChild(detailAction("More Like This", function () {
          launchDiscoverWithSeed(state.title, "details");
        }, "detail-secondary detail-more-like-this", "more-like-this"));
        appendFeedbackActions();
        restoreActionFocus();
        return;
      }
      if (state.title.type === "tv") {
        var historyRows = previewRows || core.readHistory(local);
        var canonical = core.canonicalEpisodeTarget(historyRows, state.title.id, state.detail || local, local);
        var recent = canonical ? (canonical.baseEpisode || canonical) : core.lastWatchedEpisode(historyRows, state.title.id);
        var resumable = canonical && !canonical.isNextUnwatched && canonical.progress && canonical.manualWatched !== true
          && (!canonical.progress.completed || canonical.manualWatched === false)
          ? canonical.progress : null;
        var completed = canonical ? canonical.completed : (recent && (recent.manualWatched === true || recent.progress
          && recent.progress.completed && recent.manualWatched !== false));
        if (completed && (!canonical || !canonical.isNextUnwatched)) resolveNextContinue(recent);
        var next = canonical && canonical.isNextUnwatched ? canonical
          : (completed && nextContinue && nextContinue.status === "ready" ? nextContinue.target : null);
        var noNext = canonical ? canonical.isFinished
          : (completed && nextContinue && nextContinue.status === "unavailable");
        var targetSeason = canonical ? canonical.season : (next ? next.season : (recent ? recent.season : state.season));
        var targetEpisode = canonical ? canonical.episode : (next ? next.episode : (recent ? recent.episode : (state.episodes.length ? state.episodes[0].number : 1)));
        var targetTitle = canonical ? (canonical.episodeTitle || canonical.title) : (next ? next.title : "");

        var primary = detailAction(resumable ? "Resume S" + targetSeason + " E" + targetEpisode
          : next ? "Continue S" + targetSeason + " E" + targetEpisode
            : noNext ? "Episodes" : completed ? "Checking next episode…"
              : recent ? "Continue S" + targetSeason + " E" + targetEpisode : "Start watching",
          function () {
            if (next) launchEpisode(next.season, next.episode, false, next.title);
            else if (noNext) browseEpisodes();
            else if (recent && !completed) launchEpisode(recent.season, recent.episode, false);
            else if (state.season && state.episodes.length) launchEpisode(state.season, state.episodes[0].number);
          }, "detail-primary", "primary");
        primary.disabled = completed && !next && !noNext || !recent && !state.episodes.length;
        primary.setAttribute("aria-label", resumable ? "Resume Season " + targetSeason + ", Episode " + targetEpisode
          : next ? "Continue with Season " + targetSeason + ", Episode " + targetEpisode
          : noNext ? "Choose an episode" : completed ? "Checking for the next episode"
          : recent ? "Continue Season " + targetSeason + ", Episode " + targetEpisode
          : state.episodes.length ? "Play Season " + state.season + ", Episode " + state.episodes[0].number
            : "Start watching when episode metadata loads");
        if (!recent && state.episodes.length) primary.textContent = localize("Play S" + state.season + " E" + state.episodes[0].number);
        primary.setAttribute("aria-label", localize(primary.getAttribute("aria-label")));
        if (!noNext) checkArabicPrimary(primary, next ? next.season : recent ? recent.season : state.season,
          next ? next.episode : recent ? recent.episode : state.episodes.length && state.episodes[0].number);
        actions.appendChild(primary);
        if (resumable) actions.appendChild(detailAction("Start Over", function () {
          launchEpisode(recent.season, recent.episode, true);
        }, "detail-secondary", "start-over"));
        if (!noNext) actions.appendChild(detailAction("Episodes", browseEpisodes, "detail-secondary", "episodes"));
        actions.appendChild(detailAction("More Like This", function () {
          launchDiscoverWithSeed(state.title, "details");
        }, "detail-secondary detail-more-like-this", "more-like-this"));
        appendFeedbackActions();
        restoreActionFocus();
      }
    }
    function openDetails(row, episodeTarget, focusAction) {
      if (homeMotion && homeMotion.mode === "edge") { stopEdgeMotion(); finishHorizontalMotion(); }
      cancelHoverHero();
      if (pickingDiscoverSeed) {
        pickingDiscoverSeed = false;
        launchDiscoverWithSeed(row, "search");
        return;
      }
      if (focusAction) pendingActionFocus = focusAction;
      detailToken += 1; seasonToken += 1;
      if (episodeTarget && row.type === "tv") pendingEpisodeFocus = { season: episodeTarget.season, episode: episodeTarget.episode };
      state.userExplicitlyBrowsedEpisodes = false;
      state.lastFocusedEpisodeCard = null;
      if (episodeTarget && row.type === "tv") state.activeEpisodeTarget = episodeTarget.episode;
      else if (row.type === "tv") {
        var hRows = previewRows || core.readHistory(local);
        var canonTarget = core.canonicalEpisodeTarget(hRows, row.id, state.detail || local, local);
        if (canonTarget) {
          pendingEpisodeFocus = { season: canonTarget.season, episode: canonTarget.episode };
          state.activeEpisodeTarget = canonTarget.episode;
        }
      }
      state.detailSource = state.view === "history" ? "history" : state.view === "watch" ? "watch" : "search";
      state.detailSourceTab = state.watchTab || "for-you";
      state.title = row; state.detail = null; state.season = null; nextContinue = null;
      state.episodes = [];
      state.subtitle = core.readSubtitlePref(local);
      setView("details");
      var detailScroller = get("detail-scroller");
      if (detailScroller) {
        detailScroller.style.scrollBehavior = "auto";
        detailScroller.scrollTop = 0;
        detailScroller.style.scrollBehavior = "";
      }
      get("detail-information").hidden = true;
      get("detail-information").replaceChildren();
      text("detail-kind", row.type === "tv" ? "TV Show" : "Movie");
      text("detail-title", row.title); text("detail-year", row.date ? row.date.slice(0, 4) : row.type === "tv" ? "TV series" : "Movie");
      text("detail-summary", row.overview || "No synopsis available.");
      renderDetailArt(row);
      text("detail-status", "Loading details…");
      renderActions();
      var targetAction = pendingActionFocus ? get("detail-actions").querySelector('[data-action="' + pendingActionFocus + '"]') : null;
      var initialPrimary = targetAction || get("detail-actions").querySelector(".detail-primary");
      focus(initialPrimary && !initialPrimary.disabled ? initialPrimary : get("details-back"));
      pendingActionFocus = null;
      saveView();
      var token = detailToken;
      api("/api/title/" + row.type + "/" + row.id).then(function (detail) {
        if (disposed || token !== detailToken) return;
        state.detail = detail;
        if (row.type === "tv") core.writeEpisodeCatalog(local, row.id, detail.seasons);
        state.title = Object.assign({}, row, detail, {
          backdrop: core.imageUrl(detail.backdrop, "hero") ? detail.backdrop : row.backdrop,
          poster: core.imageUrl(detail.poster, "poster") ? detail.poster : row.poster
        });
        renderDetailArt(state.title);
        try {
          var historyRows = core.readHistory(local);
          historyRows.forEach(function (h) {
            if (h.type !== row.type || h.id !== row.id) return;
            var changed = false;
            if (detail.poster && !h.poster) { h.poster = detail.poster; changed = true; }
            if (detail.tvdbId && !h.tvdbId) { h.tvdbId = detail.tvdbId; changed = true; }
            if (changed) core.writeHistory(local, h, h.section);
          });
        } catch (_e) {}
        text("detail-summary", detail.overview || "No synopsis available.");
        var meta = [];
        if (detail.date) meta.push(detail.date.slice(0, 4));
        meta.push(row.type === "tv" ? "TV series" : "Movie");
        if (detail.rating) meta.push(detail.rating);
        if (row.type === "tv") {
          if (Array.isArray(detail.seasons) && detail.seasons.length) meta.push(detail.seasons.length +
            (detail.seasons.length === 1 ? " season" : " seasons"));
          else if (detail.episodeRuntime) meta.push(detail.episodeRuntime + " min episodes");
        } else if (detail.runtime) meta.push(detail.runtime + " min");
        text("detail-year", meta.join("  ·  ") || (row.type === "tv" ? "TV Series" : "Movie"));
        renderInformation(detail);
        text("detail-status", "");
        if (row.type === "tv") {
          var historyRows = previewRows || core.readHistory(local);
          var canonical = core.canonicalEpisodeTarget(historyRows, state.title.id, state.detail || local, local);
          var latest = core.lastWatchedEpisode(historyRows, state.title.id);
          var seasons = Array.isArray(detail.seasons) ? detail.seasons : [];
          var browsed = core.readBrowsedSeason(local, state.title.id);
          var targetSeason = episodeTarget && seasons.some(function (entry) { return entry.number === episodeTarget.season; })
            ? episodeTarget.season : (!state.userExplicitlyBrowsedEpisodes && canonical && seasons.some(function (entry) { return entry.number === canonical.season; }))
            ? canonical.season : browsed !== null && seasons.some(function (entry) { return entry.number === browsed; })
            ? browsed : latest && seasons.some(function (entry) { return entry.number === latest.season; })
              ? latest.season : seasons.length ? seasons[0].number : null;
          state.season = targetSeason;
          if (!pendingEpisodeFocus && !state.userExplicitlyBrowsedEpisodes && canonical && canonical.season === targetSeason) {
            pendingEpisodeFocus = { season: canonical.season, episode: canonical.episode };
            state.activeEpisodeTarget = canonical.episode;
          }
          renderActions();
          loadDetailRecommendations(state.title);
          var rail = get("seasons"); rail.replaceChildren();
          seasons.forEach(function (entry) {
            var sBtn = button(entry.name || "Season " + entry.number, function () { selectSeason(entry.number); },
              state.season === entry.number ? "is-current" : "");
            sBtn.dataset.season = String(entry.number);
            sBtn.setAttribute("role", "option");
            rail.appendChild(sBtn);
          });
          if (state.view === "episodes") browseEpisodes();
          else if (state.season !== null) loadSeason(state.season);
        } else {
          renderActions();
          loadDetailRecommendations(state.title);
        }
        saveView();
      }, function () {
        if (disposed || token !== detailToken) return;
        text("detail-status", "More details unavailable; search result information remains visible.");
      });
    }
    function openSeasonDropdown() {
      var dropdown = get("seasons-dropdown");
      var btn = get("season-selector-btn");
      if (!dropdown || !btn) return;
      dropdown.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      var current = get("seasons").querySelector(".is-current") || get("seasons").querySelector("button");
      if (current) focus(current);
    }
    function closeSeasonDropdown(restoreFocus) {
      var dropdown = get("seasons-dropdown");
      var btn = get("season-selector-btn");
      if (!dropdown || dropdown.hidden) return;
      dropdown.hidden = true;
      if (btn) btn.setAttribute("aria-expanded", "false");
      if (restoreFocus && btn) focus(btn);
    }
    function selectSeason(number) {
      state.userExplicitlyBrowsedEpisodes = true;
      state.activeEpisodeTarget = null;
      state.lastFocusedEpisodeCard = null;
      closeSeasonDropdown(false);
      loadSeason(number, true);
      var btn = get("season-selector-btn");
      if (btn) focus(btn);
    }
    function updateFocusedEpisodeInfo(ep, seasonNumber) {
      if (!ep) return;
      var titleEl = get("focused-episode-title");
      var summaryEl = get("focused-episode-summary");
      var metaEl = get("focused-episode-meta");
      if (!titleEl || !summaryEl || !metaEl) return;
      titleEl.textContent = ep.number + ". " + (ep.title || ("Episode " + ep.number));
      summaryEl.textContent = ep.overview || (state.detail && state.detail.overview) || "No episode synopsis available.";
      metaEl.replaceChildren();
      var chips = [];
      if (state.detail && state.detail.rating) chips.push(state.detail.rating);
      if (ep.runtime || (state.detail && state.detail.episodeRuntime)) {
        chips.push((ep.runtime || state.detail.episodeRuntime) + " min");
      }
      if (ep.date) chips.push(ep.date.slice(0, 4));
      chips.push("S" + seasonNumber + " E" + ep.number);
      chips.forEach(function (text) {
        var pill = doc.createElement("span");
        pill.className = "episode-meta-pill";
        pill.textContent = text;
        metaEl.appendChild(pill);
      });
    }
    function loadDetailRecommendations(row) {
      var recContainer = get("detail-recommendations");
      var recList = get("detail-rec-list");
      if (!recContainer || !recList) return;
      recList.replaceChildren();
      recContainer.hidden = true;
      var engine = root.HorizonDiscoverEngine;
      if (!engine || !engine.related) return;
      engine.related(local, row, 10).then(function (results) {
        if (disposed || !results || !results.length || !state.title || state.title.id !== row.id) return;
        recList.replaceChildren();
        results.slice(0, 8).forEach(function (candidate) {
          var card = button("", function () { openDetails(candidate); }, "home-card home-card-landscape detail-rec-card");
          card.appendChild(landscapeArt(candidate, true));
          var label = doc.createElement("strong");
          label.textContent = candidate.title;
          card.appendChild(label);
          recList.appendChild(card);
        });
        recContainer.hidden = false;
      }).catch(function () {});
    }
    function browseEpisodes() {
      if (!state.title || state.title.type !== "tv") return;
      setView("episodes");
      text("episodes-heading", state.title.title + " · " + localize("Episodes"));
      var seasons = state.detail && state.detail.seasons ? state.detail.seasons.slice().sort(function (a, b) {
        return a.number - b.number;
      }) : [];
      var rail = get("seasons"); rail.replaceChildren();
      seasons.forEach(function (entry) {
        var seasonButton = button(entry.name || "Season " + entry.number, function () { selectSeason(entry.number); },
          state.season === entry.number ? "is-current" : "");
        seasonButton.dataset.season = String(entry.number);
        seasonButton.setAttribute("role", "option");
        rail.appendChild(seasonButton);
      });
      if (!seasons.length) text("episode-status", state.detail
        ? "No season metadata available. Return to Details and retry."
        : "Loading season metadata…");
      else {
        var historyRows = previewRows || core.readHistory(local);
        var latest = core.lastWatchedEpisode(historyRows, state.title.id);
        var canonical = core.canonicalEpisodeTarget(historyRows, state.title.id, state.detail || local, local);
        var browsed = core.readBrowsedSeason(local, state.title.id);
        var chosen = pendingEpisodeFocus && seasons.some(function (s) { return s.number === pendingEpisodeFocus.season; })
          ? pendingEpisodeFocus.season : (!state.userExplicitlyBrowsedEpisodes && canonical && seasons.some(function (s) { return s.number === canonical.season; }))
          ? canonical.season : browsed !== null && seasons.some(function (s) { return s.number === browsed; }) ? browsed
          : state.season !== null && seasons.some(function (s) { return s.number === state.season; }) ? state.season
            : latest && seasons.some(function (s) { return s.number === latest.season; }) ? latest.season : seasons[0].number;
        if (pendingEpisodeFocus && pendingEpisodeFocus.season !== chosen) pendingEpisodeFocus = null;
        if (!pendingEpisodeFocus && !state.userExplicitlyBrowsedEpisodes && canonical && canonical.season === chosen) {
          pendingEpisodeFocus = { season: canonical.season, episode: canonical.episode };
          state.activeEpisodeTarget = canonical.episode;
        }
        loadSeason(chosen);
        var currentSeason = rail.querySelector(".is-current"), firstSeason = rail.querySelector("button");
        if (currentSeason && firstSeason) rail.scrollLeft = Math.max(0, currentSeason.offsetLeft - firstSeason.offsetLeft);
      }
      var scroller = get("detail-scroller");
      if (scroller) {
        var epSection = get("episodes-view");
        if (epSection) scroller.scrollTop = epSection.offsetTop - 30;
      }
      var targetCard = (state.activeEpisodeTarget && Array.from(get("episode-list").querySelectorAll(".episode-play")).find(function (c) {
        return c.dataset.episode === String(state.activeEpisodeTarget);
      })) || get("episode-list").querySelector(".is-focused")
        || get("episode-list").querySelector(".episode-play");
      if (targetCard) revealInScroller(targetCard, get("episode-list"), true, 24);
      focus(targetCard || get("season-selector-btn") || get("episodes-back")); saveView();
    }
    function loadSeason(number, remember) {
      if (!state.title || !state.detail || !state.detail.seasons.some(function (s) { return s.number === number; })) return;
      if (state.season !== number) get("episode-list").scrollTop = 0;
      state.season = number; var token = ++seasonToken;
      if (remember) core.writeBrowsedSeason(local, state.title.id, number);
      get("seasons").querySelectorAll("button").forEach(function (button) {
        button.classList.toggle("is-current", Number(button.dataset.season) === number);
      });
      var currentSeasonObj = state.detail.seasons.find(function (s) { return s.number === number; });
      var seasonLabel = currentSeasonObj && currentSeasonObj.name ? currentSeasonObj.name : ("Season " + number);
      text("season-selector-label", seasonLabel);
      text("episode-status", "Loading Season " + number + "…");
      get("episode-list").replaceChildren();
      api("/api/season/tv/" + state.title.id + "/" + number).then(function (value) {
        if (disposed || token !== seasonToken) return;
        state.episodes = Array.isArray(value.episodes) ? value.episodes : [];
        var list = get("episode-list");
        list.replaceChildren();
        state.episodes.forEach(function (ep) {
          list.appendChild(makeEpisodeCard(ep, number));
        });
        syncStartedMarks();
        text("episode-status", state.episodes.length ? "" : "No aired episodes returned for this season.");
        renderActions();
        var primary = get("detail-actions").querySelector(".detail-primary");
        if ((!doc.activeElement || doc.activeElement === get("details-back") || doc.activeElement === doc.body) && primary && !primary.disabled) {
          focus(primary);
        }
        var initialEp = state.episodes.length ? state.episodes[0] : null;
        if (pendingEpisodeFocus && pendingEpisodeFocus.season === number) {
          var selected = Array.from(list.querySelectorAll(".episode-play")).find(function (card) {
            return card.dataset.episode === String(pendingEpisodeFocus.episode);
          });
          if (selected) {
            initialEp = selected.episodeData || initialEp;
            pendingEpisodeFocus = null;
            state.lastFocusedEpisodeCard = selected;
            state.activeEpisodeTarget = selected.dataset.episode;
            revealInScroller(selected, list, true, 24);
            if (state.view === "episodes") {
              focus(selected);
            }
          }
        }
        if (initialEp) updateFocusedEpisodeInfo(initialEp, number);
      }, function () {
        if (disposed || token !== seasonToken) return;
        text("episode-status", "Episodes unavailable. Select the season to retry.");
      });
      saveView();
    }
    function makeEpisodeCard(ep, seasonNumber) {
      var card = button("", function () { launchEpisode(seasonNumber, ep.number); }, "episode-play");
      card.dataset.season = String(seasonNumber);
      card.dataset.episode = String(ep.number);
      card.episodeData = ep;
      var artwork = doc.createElement("span");
      artwork.className = "episode-art";
      artwork.textContent = "Episode " + ep.number;
      if (ep.still) {
        var still = poster(ep.still, "backdrop");
        still.alt = "";
        still.addEventListener("error", function () {
          still.remove(); artwork.textContent = "Episode " + ep.number;
          syncStartedMarks();
        });
        artwork.replaceChildren(still);
      }
      var badge = doc.createElement("span");
      badge.className = "episode-badge-overlay";
      badge.textContent = localize("S" + seasonNumber + " E" + ep.number);
      artwork.appendChild(badge);

      var heading = doc.createElement("strong");
      heading.textContent = "E" + ep.number + " · " + ep.title;
      var subtitle = doc.createElement("small");
      subtitle.textContent = ep.date || "Air date unknown";
      card.appendChild(artwork); card.appendChild(heading); card.appendChild(subtitle);
      card.setAttribute("aria-label", (contentLibrary === "arabic" ? localize("Season " + seasonNumber + " · Episode " + ep.number)
        : "Season " + seasonNumber + ", episode " + ep.number) + ": " + ep.title);
      updateEpisodeProgress(card, core.readHistory(local));

      card.addEventListener("focus", function () {
        updateFocusedEpisodeInfo(ep, seasonNumber);
      });
      return card;
    }
    function updateEpisodeProgress(card, history) {
      var art = card.querySelector(".episode-art");
      if (!art || !state.title) return;
      var row = history.find(function (entry) { return entry.type === "tv" && entry.id === state.title.id
        && entry.season === Number(card.dataset.season) && entry.episode === Number(card.dataset.episode); });
      var fraction = core.episodeProgressFraction(row);
      var line = art.querySelector(".episode-progress");
      if (!fraction) { if (line) line.remove(); }
      else {
        if (!line) { line = doc.createElement("span"); line.className = "episode-progress";
          line.setAttribute("aria-hidden", "true");
          var fill = doc.createElement("span"); fill.className = "episode-progress-fill"; line.appendChild(fill);
          art.appendChild(line);
        }
        line.querySelector(".episode-progress-fill").style.width = (fraction * 100).toFixed(1) + "%";
      }
    }
    function syncStartedMarks() {
      var history = core.readHistory(local);
      doc.querySelectorAll("#episode-list .episode-play")
        .forEach(function (card) { updateEpisodeProgress(card, history); });
    }
    function launchEpisode(season, episode, startOver, confirmedTitle) {
      if (launchingEpisode || !state.title || state.title.type !== "tv") return;
      var matching = core.readHistory(local).find(function (row) { return row.type === "tv" && row.id === state.title.id
        && row.season === season && row.episode === episode; });
      var progress = matching && matching.progress && (!matching.progress.completed || matching.manualWatched === false)
        ? matching.progress : null;
      startOver = !!startOver || !!(matching && matching.progress && matching.progress.completed
        && matching.manualWatched !== false);
      var handoff = createPlaybackHandoff("tv", state.title.id, season, episode);
      var url = player.tvUrl(state.title.id, season, episode, state.subtitle, state.title.title, state.title.tvdbId,
        startOver ? null : progress, !!startOver, handoff);
      if (url && handoff) url += "&handoffAt=" + Date.now();
      if (!url) { text("detail-status", "Invalid episode selection."); return; }
      if (startOver) core.clearProgress(local, "tv", state.title.id, season, episode);
      core.writeActiveEpisode(local, state.title.id, { season: season, episode: episode, at: Date.now() });
      if (typeof root.__HORIZON_LG_LAUNCH__ === "function"
          && root.__HORIZON_LG_LAUNCH__("tv", state.title.id, season, episode, !!startOver, confirmedTitle || "")) {
        launchingEpisode = false;
        return;
      }
      if (contentLibrary === "arabic") {
        launchingEpisode = false;
        text("episode-status", "No authorized Horizon playback stream is available for this title.");
        return;
      }
      launchingEpisode = true;
      saveView();
      try { nav.assign(url);
        var episodeRow = state.season === season && state.episodes.find(function (row) { return row.number === episode; });
        core.writeHistory(local, core.item("tv", state.title.id, state.title.title, season, episode,
          state.subtitle, Date.now(), { poster: state.title.poster, backdrop: state.title.backdrop,
            episodeTitle: confirmedTitle || episodeRow && episodeRow.title
              || state.title.season === season && state.title.episode === episode && state.title.episodeTitle || "",
            tvdbId: state.title.tvdbId }));
        syncStartedMarks();
      }
      catch (_error) { launchingEpisode = false; text("episode-status", "Player could not open. Select the episode again."); }
    }
    function launchMovie(startOver) {
      if (launchingEpisode || !state.title || state.title.type !== "movie") return;
      var record = core.readHistory(local).find(function (row) { return row.type === "movie" && row.id === state.title.id; });
      var progress = record && record.progress && !record.progress.completed ? record.progress : null;
      startOver = !!startOver || !!(record && record.progress && record.progress.completed);
      var handoff = createPlaybackHandoff("movie", state.title.id);
      var url = player.movieUrl(state.title.id, state.title.title, startOver ? null : progress, !!startOver, handoff);
      if (!url) { text("detail-status", "Invalid movie selection."); return; }
      if (startOver) core.clearProgress(local, "movie", state.title.id);
      if (typeof root.__HORIZON_LG_LAUNCH__ === "function"
          && root.__HORIZON_LG_LAUNCH__("movie", state.title.id, null, null, !!startOver, state.title.title || "")) {
        launchingEpisode = false;
        return;
      }
      if (contentLibrary === "arabic") {
        launchingEpisode = false;
        text("detail-status", "No authorized Horizon playback stream is available for this movie.");
        return;
      }
      launchingEpisode = true;
      text("detail-status", "Opening movie in Horizon Video…");
      saveView();
      try {
        nav.assign(url);
        core.writeHistory(local, core.item("movie", state.title.id, state.title.title, null, null,
          "off", Date.now(), { poster: state.title.poster, backdrop: state.title.backdrop }));
      } catch (_error) {
        launchingEpisode = false;
        text("detail-status", "Movie player could not open. Select Play to retry.");
      }
    }
    function openKeyboard() {
      keyboardOpen = true;
      get("keyboard").hidden = false;
      get("keyboard-toggle").textContent = "Hide Keyboard";
      focus(get("keyboard-keys").querySelector("button"));
    }
    function toggleKeyboard() {
      if (!keyboardOpen) { openKeyboard(); return; }
      keyboardOpen = false;
      get("keyboard").hidden = true;
      get("keyboard-toggle").textContent = "Show Keyboard";
      focus(query);
    }
    var ARABIC_KEYBOARD_CHARS = [
      "ا", "أ", "إ", "ب", "ت", "ث", "ج", "ح", "خ", "د", "ذ", "ر", "ز",
      "س", "ش", "ص", "ض", "ط", "ظ", "ع", "غ", "ف", "ق", "ك", "ل", "م",
      "ن", "ه", "ة", "و", "ي", "ى", "ء", "ئ", "ؤ", "لا"
    ];
    function syncKeyboardLanguageToggle() {
      var kb = get("keyboard");
      var keysHost = get("keyboard-keys");
      if (!kb || !keysHost) return null;
      var langBtn = get("lg-kb-lang-toggle");
      if (!langBtn) {
        langBtn = doc.createElement("button");
        langBtn.type = "button";
        langBtn.id = "lg-kb-lang-toggle";
        langBtn.className = "lg-kb-lang-btn";
        langBtn.setAttribute("data-focus", "");
        langBtn.addEventListener("click", function () {
          keyboardLang = keyboardLang === "ar" ? "en" : "ar";
          buildKeyboard();
          focus(langBtn);
        });
        kb.insertBefore(langBtn, keysHost);
      }
      var arLibrary = contentLibrary === "arabic";
      langBtn.hidden = !arLibrary;
      langBtn.textContent = keyboardLang === "ar"
        ? "لوحة المفاتيح: العربية -> Switch to English"
        : "Keyboard: English -> Switch to العربية";
      return langBtn;
    }
    function buildKeyboard() {
      var host = get("keyboard-keys");
      if (!host) return;
      host.replaceChildren();
      var useArabic = contentLibrary === "arabic" && keyboardLang === "ar";
      syncKeyboardLanguageToggle();
      host.setAttribute("dir", useArabic ? "rtl" : "ltr");
      if (query) query.setAttribute("dir", contentLibrary === "arabic" ? "auto" : "ltr");
      var chars = useArabic ? ARABIC_KEYBOARD_CHARS : "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890".split("");
      chars.forEach(function (char) {
        host.appendChild(button(char, function () {
          query.value += (useArabic ? char : char.toLowerCase());
          state.query = query.value;
          scheduleSearch(300);
        }));
      });
      host.appendChild(button("Space", function () { query.value += " "; state.query = query.value; scheduleSearch(300); }, "wide"));
      host.appendChild(button("⌫", function () { query.value = query.value.slice(0, -1); state.query = query.value; scheduleSearch(300); }, "wide"));
      host.appendChild(button("Clear", function () { query.value = ""; state.query = ""; scheduleSearch(0); }, "wide"));
    }
    function activeButtons() {
      return Array.from(doc.querySelectorAll("[data-focus]")).filter(function (el) {
        return !el.disabled && !el.closest("[hidden]") && el.getBoundingClientRect().width > 0;
      });
    }
    function move(key) {
      var current = doc.activeElement;
      if (!current || current === doc.body || (!current.dataset.homeGroup && !current.hasAttribute("data-focus"))) {
        if (state.view === "watch") {
          var remembered = tabLastContent[state.watchTab] || homeLastContent;
          var rescue = resolveHomeSelection(remembered) || firstHomeButton() || get("watch-toggle");
          if (rescue) { focus(rescue); return; }
        }
      }
      var rect = current && current.getBoundingClientRect();
      if (!rect) { focus(query); return; }
      var railButtons = [get("search-toggle"), get("watch-toggle"), get("tv-toggle"), get("movies-toggle"), get("discover-toggle"), get("history-toggle"), get("settings-toggle")];
      var railPosition = railButtons.indexOf(current);
      if (railPosition >= 0 && (key === "ArrowDown" || key === "ArrowUp")) {
        focus(railButtons[Math.max(0, Math.min(railButtons.length - 1,
          railPosition + (key === "ArrowDown" ? 1 : -1)))]); return;
      }
      if (state.view === "settings") {
        if (!state.settingsCategory) {
          var catButtons = [
            get("settings-cat-appearance"),
            get("settings-cat-browsing"),
            get("settings-cat-library"),
            get("settings-cat-about")
          ].filter(Boolean);
          var catIndex = catButtons.indexOf(current);
          if (railPosition >= 0 && key === "ArrowRight") {
            var targetCat = get("settings-cat-" + (state.lastSettingsCategory || "appearance")) || catButtons[0];
            focus(targetCat);
          } else if (catIndex >= 0) {
            if (key === "ArrowDown") focus(catButtons[Math.min(catButtons.length - 1, catIndex + 1)]);
            else if (key === "ArrowUp") focus(catButtons[Math.max(0, catIndex - 1)]);
            else if (key === "ArrowLeft") focus(get("settings-toggle"));
            else if (key === "ArrowRight") openSettingsCategory(catButtons[catIndex].id.replace("settings-cat-", ""));
          }
          return;
        } else {
          var activeCatMeta = SETTINGS_CATEGORIES[state.settingsCategory];
          var activePanel = activeCatMeta && get(activeCatMeta.panelId);
          var subButtons = [get("settings-subpage-back")];
          if (activePanel) {
            subButtons = subButtons.concat(Array.from(activePanel.querySelectorAll("[data-focus]")).filter(function (el) {
              return !el.disabled && !el.closest("[hidden]");
            }));
          }
          var subIdx = subButtons.indexOf(current);
          if (railPosition >= 0 && key === "ArrowRight") {
            focus(subButtons[0]);
          } else if (subIdx >= 0) {
            var actionsWrap = state.settingsHistoryItem ? get("settings-history-actions") : null;
            var actionBtns = actionsWrap && !actionsWrap.hidden
              ? Array.from(actionsWrap.querySelectorAll("[data-focus]")) : [];
            var actIdx = actionBtns.indexOf(current);
            if (actIdx >= 0 && (key === "ArrowLeft" || key === "ArrowRight")) {
              if (key === "ArrowRight" && actIdx < actionBtns.length - 1) focus(actionBtns[actIdx + 1]);
              else if (key === "ArrowLeft") focus(actIdx > 0 ? actionBtns[actIdx - 1] : get("settings-subpage-back"));
            } else if (key === "ArrowDown") focus(subButtons[Math.min(subButtons.length - 1, subIdx + 1)]);
            else if (key === "ArrowUp") focus(subButtons[Math.max(0, subIdx - 1)]);
            else if (key === "ArrowLeft") {
              if (current === get("settings-subpage-back")) focus(get("settings-toggle"));
              else focus(get("settings-subpage-back"));
            }
          }
          return;
        }
      }
      if (state.view === "history") {
        if (state.historyMode === "all") {
          var allToolbar = [
            get("history-all-back"),
            get("history-filter-all"),
            get("history-filter-movie"),
            get("history-filter-tv"),
            get("history-search-input")
          ].filter(Boolean);
          var allCards = Array.from(get("history-all-list").querySelectorAll("button")).filter(function (b) {
            return !b.disabled && !b.closest("[hidden]");
          });
          var tIdx = allToolbar.indexOf(current);
          var cIdx = allCards.indexOf(current);
          if (railPosition >= 0 && key === "ArrowRight") {
            focus(allToolbar[0]);
            return;
          }
          if (tIdx >= 0) {
            if (key === "ArrowLeft") {
              if (tIdx === 0) focus(get("history-toggle"));
              else focus(allToolbar[tIdx - 1]);
            } else if (key === "ArrowRight") {
              if (tIdx < allToolbar.length - 1) focus(allToolbar[tIdx + 1]);
            } else if (key === "ArrowDown") {
              if (allCards.length) focus(allCards[0]);
            }
            return;
          }
          if (cIdx >= 0) {
            var cols = 5;
            if (key === "ArrowLeft") {
              if (cIdx % cols === 0) focus(get("history-toggle"));
              else focus(allCards[cIdx - 1]);
            } else if (key === "ArrowRight") {
              if (cIdx < allCards.length - 1) focus(allCards[cIdx + 1]);
            } else if (key === "ArrowUp") {
              if (cIdx < cols) focus(allToolbar[1] || allToolbar[0]);
              else focus(allCards[cIdx - cols]);
            } else if (key === "ArrowDown") {
              if (cIdx + cols < allCards.length) focus(allCards[cIdx + cols]);
            }
            return;
          }
        } else {
          var overviewHeaders = [
            get("history-back"),
            get("history-view-all"),
            get("history-clear")
          ].filter(Boolean);
          var hIdx = overviewHeaders.indexOf(current);
          var listCards = Array.from(get("history-list").querySelectorAll("button")).filter(function (b) {
            return !b.disabled && !b.closest("[hidden]");
          });
          var lIdx = listCards.indexOf(current);
          var emptyAction = get("history-empty-action");
          if (current === emptyAction) {
            if (key === "ArrowLeft") focus(get("history-toggle"));
            return;
          }
          if (railPosition >= 0 && key === "ArrowRight") {
            if (emptyAction && !emptyAction.closest("[hidden]")) focus(emptyAction);
            else focus(overviewHeaders[0]);
            return;
          }
          if (hIdx >= 0) {
            if (key === "ArrowLeft") {
              if (hIdx === 0) focus(get("history-toggle"));
              else focus(overviewHeaders[hIdx - 1]);
            } else if (key === "ArrowRight") {
              if (hIdx < overviewHeaders.length - 1) focus(overviewHeaders[hIdx + 1]);
            } else if (key === "ArrowDown") {
              if (listCards.length) focus(listCards[0]);
            }
            return;
          }
          if (lIdx >= 0) {
            var cols = 5;
            if (key === "ArrowLeft") {
              if (lIdx % cols === 0) focus(get("history-toggle"));
              else focus(listCards[lIdx - 1]);
            } else if (key === "ArrowRight") {
              if (lIdx < listCards.length - 1) focus(listCards[lIdx + 1]);
            } else if (key === "ArrowUp") {
              if (lIdx < cols) focus(overviewHeaders[0]);
              else focus(listCards[lIdx - cols]);
            } else if (key === "ArrowDown") {
              var movieCards = Array.from(get("history-movies-list").querySelectorAll("button")).filter(function (b) {
                return !b.disabled && !b.closest("[hidden]");
              });
              var tvCards = Array.from(get("history-tv-list").querySelectorAll("button")).filter(function (b) {
                return !b.disabled && !b.closest("[hidden]");
              });
              if (lIdx + cols < listCards.length) focus(listCards[lIdx + cols]);
              else if (movieCards.length) focus(movieCards[0]);
              else if (tvCards.length) focus(tvCards[0]);
            }
            return;
          }
          var movieCards = Array.from(get("history-movies-list").querySelectorAll("button")).filter(function (b) {
            return !b.disabled && !b.closest("[hidden]");
          });
          var mIdx = movieCards.indexOf(current);
          if (mIdx >= 0) {
            if (key === "ArrowLeft") {
              if (mIdx === 0) focus(get("history-toggle"));
              else focus(movieCards[mIdx - 1]);
            } else if (key === "ArrowRight" && mIdx < movieCards.length - 1) {
              focus(movieCards[mIdx + 1]);
            } else if (key === "ArrowUp") {
              focus(listCards[listCards.length - 1] || overviewHeaders[0]);
            } else if (key === "ArrowDown") {
              var tvCards = Array.from(get("history-tv-list").querySelectorAll("button")).filter(function (b) {
                return !b.disabled && !b.closest("[hidden]");
              });
              if (tvCards.length) focus(tvCards[0]);
            }
            return;
          }
          var tvCards = Array.from(get("history-tv-list").querySelectorAll("button")).filter(function (b) {
            return !b.disabled && !b.closest("[hidden]");
          });
          var tvIdx = tvCards.indexOf(current);
          if (tvIdx >= 0) {
            if (key === "ArrowLeft") {
              if (tvIdx === 0) focus(get("history-toggle"));
              else focus(tvCards[tvIdx - 1]);
            } else if (key === "ArrowRight" && tvIdx < tvCards.length - 1) {
              focus(tvCards[tvIdx + 1]);
            } else if (key === "ArrowUp") {
              if (movieCards.length) focus(movieCards[movieCards.length - 1]);
              else focus(listCards[listCards.length - 1] || overviewHeaders[0]);
            }
            return;
          }
        }
      }
      if (state.view === "watch") {
        var visibleOrder = visibleHomeRowOrder();
        var watchRows = visibleOrder.map(homeRowButtons);
        var first = firstHomeButton() || get("watch-toggle");
        if (current.closest(".watch-rail")) {
          var railIndex = railButtons.indexOf(current);
          if (key === "ArrowDown") focus(railButtons[Math.min(railButtons.length - 1, railIndex + 1)]);
          else if (key === "ArrowUp") focus(railButtons[Math.max(0, railIndex - 1)]);
          else if (key === "ArrowRight") {
            var remembered = tabLastContent[state.watchTab] || homeLastContent;
            focus(resolveHomeSelection(remembered)
              || (remembered && nearestHomeButton(remembered.group)) || first);
          }
          return;
        }
        if (current.classList.contains("filter-chip")) {
          var chips = Array.from(get("watch-filter-strip").querySelectorAll(".filter-chip")).filter(function (c) {
            return !c.hidden;
          });
          var chipIdx = chips.indexOf(current);
          if (key === "ArrowLeft") {
            if (chipIdx > 0) focus(chips[chipIdx - 1]);
            else focus(get("watch-toggle"));
          } else if (key === "ArrowRight" && chipIdx < chips.length - 1) {
            focus(chips[chipIdx + 1]);
          } else if (key === "ArrowUp") {
            focus(get("watch-toggle"));
          } else if (key === "ArrowDown") {
            var emptyBtn = get("watch-filter-empty-clear");
            if (emptyBtn && !emptyBtn.closest("[hidden]")) {
              focus(emptyBtn);
            } else {
              focus(resolveHomeSelection(homeLastContent) || firstHomeButton() || get("watch-toggle"));
            }
          }
          return;
        }
        if (current.classList.contains("filter-menu-option")) {
          var options = Array.from(get("watch-filter-menu-options").querySelectorAll(".filter-menu-option"));
          var optIdx = options.indexOf(current);
          if (key === "ArrowUp" && optIdx > 0) focus(options[optIdx - 1]);
          else if (key === "ArrowDown" && optIdx < options.length - 1) focus(options[optIdx + 1]);
          else if (key === "ArrowLeft") closeFilterMenu();
          return;
        }
        if (current.id === "watch-filter-empty-clear") {
          if (key === "ArrowUp") {
            var upTarget = (state.watchTab === "discover")
              ? (get("filter-btn-seed") || get("filter-btn-genre"))
              : get("filter-btn-genre");
            focus(upTarget);
          } else if (key === "ArrowLeft") {
            focus(get("watch-toggle"));
          }
          return;
        }
        var groupIndex = visibleOrder.indexOf(current.dataset.homeGroup);
        var group = groupIndex >= 0 ? watchRows[groupIndex] : null;
        if (group) {
          var groupName = visibleOrder[groupIndex];
          var index = Number(current.dataset.homeIndex);
          var down = adjacentHomeRow(watchRows, groupIndex, 1);
          var up = adjacentHomeRow(watchRows, groupIndex, -1);
          var downIdx = nextHomeRowIndex(watchRows, groupIndex, 1);
          var upIdx = nextHomeRowIndex(watchRows, groupIndex, -1);
          var isShort = isRowShort(groupName, group);
          if (rowCycleIndex[groupName] === undefined) {
            rowCycleIndex[groupName] = Math.max(0, index);
          }
          if (key === "ArrowLeft") {
            if (isShort) {
              if (index <= 0) {
                focus(get("watch-toggle"));
              } else {
                focus(group[index - 1], true, -1);
              }
            } else {
              if (rowCycleIndex[groupName] <= 0) {
                focus(get("watch-toggle"));
              } else {
                rowCycleIndex[groupName] -= 1;
                focus(group[circularIndex(index, group.length, -1)], true, -1);
              }
            }
          } else if (key === "ArrowRight") {
            if (isShort) {
              if (index < group.length - 1) {
                focus(group[index + 1], true, 1);
              }
            } else {
              if (index === group.length - 1) rowCycleIndex[groupName] = 0;
              else rowCycleIndex[groupName] += 1;
              focus(group[circularIndex(index, group.length, 1)], true, 1);
            }
          } else if (key === "ArrowDown") {
            if (down) { var downGroup = visibleOrder[downIdx >= 0 ? downIdx : watchRows.indexOf(down)];
              var downTarget = resolveHomeSelection(homeRowMemory[downGroup]) || down[0];
              if (downTarget) focus(downTarget); }
          } else if (key === "ArrowUp") {
            var upGroup = visibleOrder[upIdx >= 0 ? upIdx : watchRows.indexOf(up)];
            if (up) {
              var upTarget = resolveHomeSelection(homeRowMemory[upGroup]) || up[0];
              if (upTarget) focus(upTarget);
            } else if (state.watchTab === "tv" || state.watchTab === "movies" || state.watchTab === "discover") {
              var firstChip = get("filter-btn-seed");
              focus((state.watchTab === "discover" && firstChip && !firstChip.hidden) ? firstChip : get("filter-btn-genre"));
            } else {
              focus(get("watch-toggle"));
            }
          }
          return;
        }
      }
      if (state.view === "details" || state.view === "episodes") {
        var actions = Array.from(get("detail-actions").querySelectorAll("button")).filter(function (item) {
          return !item.disabled;
        });
        var actionIndex = actions.indexOf(current), credits = get("details-view").querySelector(".detail-credits a");
        var railToggle = state.detailSource === "watch"
          ? (state.detailSourceTab === "tv" ? get("tv-toggle") : state.detailSourceTab === "movies" ? get("movies-toggle") : state.detailSourceTab === "discover" ? get("discover-toggle") : get("watch-toggle"))
          : state.detailSource === "history" ? get("history-toggle") : get("search-toggle");
        var seasonButtons = Array.from(get("seasons").querySelectorAll("button"));
        var plays = Array.from(get("episode-list").querySelectorAll(".episode-play"));
        var recs = Array.from(get("detail-rec-list").querySelectorAll("button"));
        var seasonBtn = get("season-selector-btn");
        var seasonDropdown = get("seasons-dropdown");
        var seasonIndex = seasonButtons.indexOf(current), playIndex = plays.indexOf(current), recIndex = recs.indexOf(current);
        var offset = key === "ArrowRight" ? 1 : -1;
        var columns = plays.filter(function (item) {
          return plays.length && Math.abs(item.getBoundingClientRect().top - plays[0].getBoundingClientRect().top) < 2;
        }).length || 3;

        if (current === get("details-back")) {
          if (key === "ArrowDown") focus(actions[0] || credits);
          else if (key === "ArrowLeft") focus(railToggle);
          return;
        }
        if (actionIndex >= 0) {
          if (key === "ArrowUp") focus(get("details-back"));
          else if (key === "ArrowLeft") focus(actions[actionIndex - 1] || railToggle);
          else if (key === "ArrowRight") focus(actions[actionIndex + 1]);
          else if (key === "ArrowDown") {
            if (state.title && state.title.type === "tv" && !get("episodes-view").hidden) {
              var targetEpisodeCard = (state.lastFocusedEpisodeCard && plays.includes(state.lastFocusedEpisodeCard))
                ? state.lastFocusedEpisodeCard
                : (state.activeEpisodeTarget && plays.find(function (p) { return p.dataset.episode === String(state.activeEpisodeTarget); }))
                || plays.find(function (p) { return p.classList.contains("is-focused"); }) || plays[0];
              var targetDown = targetEpisodeCard || seasonBtn || credits;
              var sc = get("detail-scroller");
              if (sc && targetDown !== credits) {
                var epSec = get("episodes-view");
                if (epSec) sc.scrollTop = epSec.offsetTop - 20;
              }
              if (targetEpisodeCard && targetDown === targetEpisodeCard) {
                focus(targetEpisodeCard);
                revealInScroller(targetEpisodeCard, get("episode-list"), true, 24);
                if (targetEpisodeCard.episodeData) updateFocusedEpisodeInfo(targetEpisodeCard.episodeData, Number(targetEpisodeCard.dataset.season));
                state.lastFocusedEpisodeCard = targetEpisodeCard;
              } else {
                focus(targetDown);
              }
            } else {
              focus(credits);
            }
          }
          return;
        }
        if (current === seasonBtn) {
          if (key === "ArrowUp") {
            var scTop = get("detail-scroller");
            if (scTop) scTop.scrollTop = 0;
            focus(actions[actions.length - 1] || actions[0] || get("details-back"));
            if (scTop) scTop.scrollTop = 0;
          } else if (key === "ArrowDown") {
            var targetEpisodeCard = (state.lastFocusedEpisodeCard && plays.includes(state.lastFocusedEpisodeCard))
              ? state.lastFocusedEpisodeCard
              : (state.activeEpisodeTarget && plays.find(function (p) { return p.dataset.episode === String(state.activeEpisodeTarget); }))
              || plays.find(function (p) { return p.classList.contains("is-focused"); }) || plays[0];
            if (targetEpisodeCard) {
              focus(targetEpisodeCard);
              revealInScroller(targetEpisodeCard, get("episode-list"), true, 24);
            }
          } else if (key === "ArrowLeft") focus(railToggle);
          return;
        }
        if (seasonDropdown && !seasonDropdown.hidden && seasonIndex >= 0) {
          if (key === "ArrowDown") focus(seasonButtons[Math.min(seasonButtons.length - 1, seasonIndex + 1)]);
          else if (key === "ArrowUp") focus(seasonButtons[Math.max(0, seasonIndex - 1)]);
          else if (key === "Back" || key === "Escape") closeSeasonDropdown(true);
          return;
        }
        if (current === get("episodes-back")) {
          if (key === "ArrowDown") focus(seasonButtons.find(function (item) {
            return item.classList.contains("is-current");
          }) || seasonButtons[0] || plays[0]);
          else if (key === "ArrowLeft") focus(railToggle);
          else if (key === "ArrowUp") focus(actions[0] || get("details-back"));
          return;
        }
        if (seasonIndex >= 0) {
          if (key === "ArrowDown") focus(plays[0]);
          else if (key === "ArrowUp") focus(get("episodes-back"));
          else focus(seasonButtons[Math.max(0, Math.min(seasonButtons.length - 1, seasonIndex + offset))]);
          return;
        }
        if (playIndex >= 0) {
          if (key === "ArrowUp") {
            focus(seasonBtn || actions[0] || (seasonButtons.find(function (item) { return item.classList.contains("is-current"); }) || seasonButtons[0]) || get("details-back"));
          } else if (key === "ArrowDown") {
            if (recs.length) {
              focus(recs[0]);
              revealInScroller(recs[0], get("detail-rec-list"), true, 24);
            } else {
              var nextRow = Math.floor(playIndex / columns) + 1;
              if (nextRow * columns < plays.length) focus(plays[Math.min(nextRow * columns + playIndex % columns, plays.length - 1)]);
            }
          } else if (key === "ArrowRight") {
            if (playIndex < plays.length - 1) {
              var nextCard = plays[playIndex + 1];
              focus(nextCard);
              revealInScroller(nextCard, get("episode-list"), true, 24);
              if (nextCard.episodeData) updateFocusedEpisodeInfo(nextCard.episodeData, Number(nextCard.dataset.season));
              state.lastFocusedEpisodeCard = nextCard;
            }
          } else if (key === "ArrowLeft") {
            if (playIndex > 0) {
              var prevCard = plays[playIndex - 1];
              focus(prevCard);
              revealInScroller(prevCard, get("episode-list"), true, 24);
              if (prevCard.episodeData) updateFocusedEpisodeInfo(prevCard.episodeData, Number(prevCard.dataset.season));
              state.lastFocusedEpisodeCard = prevCard;
            } else {
              focus(railToggle);
            }
          }
          return;
        }
        if (recIndex >= 0) {
          if (key === "ArrowUp") {
            var activePlayCard = plays.find(function (p) { return p.classList.contains("is-focused"); }) || plays[0];
            if (activePlayCard) focus(activePlayCard);
          } else if (key === "ArrowLeft") {
            if (recIndex > 0) {
              focus(recs[recIndex - 1]);
              revealInScroller(recs[recIndex - 1], get("detail-rec-list"), true, 24);
            } else focus(railToggle);
          } else if (key === "ArrowRight") {
            if (recIndex < recs.length - 1) {
              focus(recs[recIndex + 1]);
              revealInScroller(recs[recIndex + 1], get("detail-rec-list"), true, 24);
            }
          }
          return;
        }
        if (current === credits) {
          if (key === "ArrowUp") focus(actions[actions.length - 1] || get("details-back"));
          return;
        }
        if (current.closest(".watch-rail") && key === "ArrowRight") {
          focus(get("details-back")); return;
        }
      }
      if (state.view === "search") {
        if (key === "ArrowRight" && current.closest(".watch-rail")) {
          focus(query); return;
        }
        if (key === "ArrowLeft" && current === query) {
          focus(get("search-toggle")); return;
        }
        var keys = get("keyboard-keys"), firstResult = results.querySelector("button");
        var nearest = function (items) { return items.sort(function (a, b) {
          var ay = a.getBoundingClientRect(), by = b.getBoundingClientRect();
          return Math.abs(ay.top + ay.height / 2 - (rect.top + rect.height / 2))
            - Math.abs(by.top + by.height / 2 - (rect.top + rect.height / 2));
        })[0]; };
        if (key === "ArrowRight" && firstResult && current.closest("#keyboard-keys")
            && rect.right >= keys.getBoundingClientRect().right - 24) {
          focus(nearest(Array.from(results.querySelectorAll("button")).filter(function (item) {
            return item.getBoundingClientRect().left <= firstResult.getBoundingClientRect().left + 4;
          }))); return;
        }
        if (key === "ArrowLeft" && current.closest("#results") && firstResult
            && rect.left <= firstResult.getBoundingClientRect().left + 4) {
          focus(nearest(Array.from(keys.querySelectorAll("button")).filter(function (item) {
            return item.getBoundingClientRect().right >= keys.getBoundingClientRect().right - 24;
          }))); return;
        }
      }
      var x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      var candidates = activeButtons().filter(function (el) { return el !== current; }).map(function (el) {
        var r = el.getBoundingClientRect(), dx = r.left + r.width / 2 - x, dy = r.top + r.height / 2 - y;
        var forward = key === "ArrowRight" ? dx : key === "ArrowLeft" ? -dx
          : key === "ArrowDown" ? dy : -dy;
        var lateral = key === "ArrowRight" || key === "ArrowLeft" ? Math.abs(dy) : Math.abs(dx);
        return { el: el, score: forward + lateral * 2.5, forward: forward };
      }).filter(function (candidate) { return candidate.forward > 4; }).sort(function (a, b) { return a.score - b.score; });
      if (candidates.length) focus(candidates[0].el);
    }
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
    function handleKey(event) {
      if (disposed || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      var key = keyName(event);
      if (homeMotion && homeMotion.mode === "edge") stopEdgeMotion();
      if (edgeIntentTimer) clock.clearTimeout(edgeIntentTimer);
      edgeIntentTimer = 0; edgeMotionGroup = "";
      pointerHeroActive = false; cancelHoverHero();
      if (watchPerformance && watchPerformance.handle(key, state.view, doc.activeElement, event.repeat)) {
        event.preventDefault(); return;
      }
      if (activeFilterMenuType && key === "Tab") {
        var menuOptions = Array.from(get("watch-filter-menu-options").querySelectorAll(".filter-menu-option"));
        if (menuOptions.length) {
          event.preventDefault();
          var menuIndex = menuOptions.indexOf(doc.activeElement);
          focus(menuIndex < 0 ? menuOptions[event.shiftKey ? menuOptions.length - 1 : 0]
            : menuOptions[(menuIndex + (event.shiftKey ? menuOptions.length - 1 : 1)) % menuOptions.length]);
          return;
        }
      }
      if (homeMotion) {
        if (key === "ArrowDown" || key === "ArrowUp" || key === "OK" || key === "Back") {
          finishHorizontalMotion();
        } else if (heroPreferences.hold && homeMotion.mode === "hold" && event.repeat
            && key === (homeMotion.direction > 0 ? "ArrowRight" : "ArrowLeft")) {
          event.preventDefault(); renewHoldInactivity(); return;
        }
      }
      if (key === "ArrowLeft" || key === "ArrowRight") {
        var active = doc.activeElement, group = active && active.dataset.homeGroup;
        if (state.view === "watch" && group) {
          var dir = key === "ArrowRight" ? 1 : -1;
          var isHold = heroPreferences.hold && !!event.repeat;
          if (stepHorizontalMotion(group, dir, isHold)) {
            event.preventDefault(); return;
          }
        }
      }
      var editing = doc.activeElement === query || !!(doc.activeElement && doc.activeElement.isContentEditable);
      if (nativeEditingKey(event, editing, finePointer)) return;
      if (finePointer && event.key === "Backspace" && !editing) return;
      if (key === "Back") {
        event.preventDefault(); if (event.repeat) return;
        if (activeFilterMenuType) {
          closeFilterMenu();
          return;
        }
        if (state.view === "history") {
          if (state.historyMode === "all") {
            closeHistoryAll();
            return;
          }
          returnWithinWatch(leaveHistory);
        }
        else if (state.view === "settings") {
          if (state.settingsHistoryItem) {
            closeSettingsHistoryActions();
            return;
          }
          if (state.settingsCategory) {
            closeSettingsCategory();
            return;
          }
          returnWithinWatch(function () { showWatch(); });
        }
        else if (state.view === "episodes" || state.view === "details") {
          var sdd = get("seasons-dropdown");
          if (sdd && !sdd.hidden) {
            closeSeasonDropdown(true);
            return;
          }
          returnWithinWatch(backToResults);
        }
        else if (state.view === "search" && state.query) {
          query.value = ""; state.query = ""; scheduleSearch(0); focus(query); saveView();
        } else if (state.view === "search") showWatch();
        else if (state.view === "watch") {
          if (state.watchTab === "discover" && state.discoverReturnDetails) {
            var ret = state.discoverReturnDetails;
            state.discoverReturnDetails = null;
            openDetails(ret.title, null, "more-like-this");
            return;
          } else if (state.watchTab !== "for-you") {
            setWatchTab("for-you");
          } else if (doc.activeElement && doc.activeElement.dataset && doc.activeElement.dataset.homeGroup) {
            focus(get("watch-toggle"));
          } else if (doc.activeElement && doc.activeElement.closest("#watch-filter-strip")) {
            focus(get("watch-toggle"));
          } else {
            focus(get("watch-toggle"));
          }
        }
        return;
      }
      if (key === "OK") {
        event.preventDefault(); if (event.repeat) return;
        var actEl = doc.activeElement;
        if (actEl && actEl.classList.contains("filter-chip")) {
          if (actEl.id === "filter-btn-clear") clearActiveFilters();
          else openFilterMenu(actEl.dataset.filterType);
          return;
        }
        if (actEl && actEl.classList.contains("filter-menu-option")) {
          selectFilterOption(actEl.dataset.filterType, actEl.dataset.filterValue);
          return;
        }
        if (actEl && actEl.id === "watch-filter-empty-clear") {
          clearActiveFilters();
          focus(get("filter-btn-genre"));
          return;
        }
        if (doc.activeElement === query) { if (state.query.trim()) { state.continueMode = false; searchNow(true); } else openKeyboard(); }
        else if (doc.activeElement && doc.activeElement.click) doc.activeElement.click();
        return;
      }
      if (key && key.indexOf("Arrow") === 0) { event.preventDefault(); move(key); return; }
    }
    function onKey(event) {
      var began = watchPerformance ? watchPerformance.keyStart(keyName(event)) : 0;
      try { handleKey(event); }
      finally { if (watchPerformance) watchPerformance.keyEnd(began); }
    }
    get("watch-toggle").addEventListener("click", function () {
      if (state.view !== "watch") setView("watch");
      setWatchTab("for-you");
    });
    get("tv-toggle").addEventListener("click", function () {
      if (state.view !== "watch") setView("watch");
      setWatchTab("tv");
    });
    get("movies-toggle").addEventListener("click", function () {
      if (state.view !== "watch") setView("watch");
      setWatchTab("movies");
    });
    get("discover-toggle").addEventListener("click", function () {
      if (state.view !== "watch") setView("watch");
      setWatchTab("discover");
    });
    get("search-toggle").addEventListener("click", function () {
      state.continueMode = false; setView("search"); scheduleSearch(0); focus(query); saveView();
    });
    get("keyboard-toggle").addEventListener("click", toggleKeyboard);
    get("history-toggle").addEventListener("click", showHistory);
    get("settings-toggle").addEventListener("click", showSettings);
    get("settings-hero-delay").addEventListener("click", function () {
      var current = HERO_DELAYS.indexOf(heroPreferences.delay);
      heroPreferences.delay = HERO_DELAYS[(current + 1) % HERO_DELAYS.length];
      saveHeroPreferences();
      this.textContent = heroPreferences.delay ? heroPreferences.delay + (contentLibrary === "arabic" ? " مللي ثانية" : "ms") : localize("Immediate");
      focus(this);
    });
    get("settings-hero-fade").addEventListener("click", function () {
      heroPreferences.fade = !heroPreferences.fade;
      saveHeroPreferences();
      this.textContent = localize(heroPreferences.fade ? "Fade On" : "Fade Off");
      this.setAttribute("aria-pressed", String(heroPreferences.fade));
      focus(this);
    });
    var movementBtn = get("settings-carousel-movement");
    if (movementBtn) movementBtn.addEventListener("click", function () {
      heroPreferences.carouselMovement = heroPreferences.carouselMovement === "glide" ? "instant" : "glide";
      saveHeroPreferences();
      if (heroPreferences.carouselMovement === "instant" && homeMotion && !homeMotion.passive) {
        finishHorizontalMotion();
      }
      var isGlide = heroPreferences.carouselMovement === "glide";
      this.textContent = localize(isGlide ? "Glide" : "Instant");
      this.setAttribute("aria-pressed", String(isGlide));
      focus(this);
    });
    [
      ["settings-poster-glide", "glide"],
      ["settings-hold-scroll", "hold"],
      ["settings-scroll-animations", "scrollAnimations"],
      ["settings-artwork-fade", "artworkFade"]
    ].forEach(function (pair) {
      get(pair[0]).addEventListener("click", function () {
        heroPreferences[pair[1]] = !heroPreferences[pair[1]];
        saveHeroPreferences();
        this.textContent = localize(heroPreferences[pair[1]] ? "On" : "Off");
        this.setAttribute("aria-pressed", String(heroPreferences[pair[1]]));
        focus(this);
      });
    });
    get("settings-appearance-reset").addEventListener("click", function () {
      heroPreferences = defaultAppearance();
      saveHeroPreferences();
      renderSettings();
      focus(this);
    });
    ["appearance", "browsing", "library", "about"].forEach(function (catId) {
      var btn = get("settings-cat-" + catId);
      if (btn) btn.addEventListener("click", function () { openSettingsCategory(catId); });
    });
    var contentLibraryBtn = get("settings-content-library");
    function setContentLibrary(nextMode) {
      var mode = nextMode === "arabic" ? "arabic" : "standard";
      contentLibrary = mode;
      state.contentLibrary = mode;
      applyLibraryLanguage();
      if (typeof core.writeLibraryPref === "function") core.writeLibraryPref(local, mode);
      cache.clear();
      recommendationPayload = null;
      recommendationLoadedSignature = "";
      recommendationWantedSignature = "";
      recommendationPending = null;
      recommendationRows = { top: [], because: [], seed: null };
      candidateEnrichmentStarted = false;
      discoverData = null;
      discoverActiveSeed = null;
      tvFilters = { genre: null, length: null, rating: null, year: null, sort: "best" };
      movieFilters = { genre: null, length: null, rating: null, year: null, sort: "best" };
      discoverFilters = { genre: null, style: "all", sort: "best" };
      discoverStyle = "all"; discoverMode = "all"; discoverMedia = "same";
      tabRowMemory = { "for-you": Object.create(null), "tv": Object.create(null), "movies": Object.create(null), "discover": Object.create(null) };
      tabLastContent = { "for-you": null, "tv": null, "movies": null, "discover": null };
      tabScrollTop = { "for-you": 0, "tv": 0, "movies": 0, "discover": 0 };
      homeRowMemory = tabRowMemory["for-you"];
      homeLastContent = null;
      homeDefaultEntry = null;
      rowCycleIndex = Object.create(null);
      state.watchTab = "for-you";
      state.query = "";
      if (query) query.value = "";
      keyboardLang = mode === "arabic" ? "ar" : "en";
      keyboardOpen = mode === "arabic" ? true : !finePointer;
      buildKeyboard();
      state.settingsCategory = null;
      state.settingsHistoryItem = null;
      if (get("settings-landing")) get("settings-landing").hidden = false;
      if (get("settings-subpage")) get("settings-subpage").hidden = true;
      updateFilterStripUI();
      renderSettings();
      try {
        doc.dispatchEvent(new CustomEvent("horizon:librarychange", { detail: { library: mode } }));
      } catch (_e) {}
      showWatch(true);
    }
    if (contentLibraryBtn) {
      contentLibraryBtn.addEventListener("click", function () {
        setContentLibrary(contentLibrary === "arabic" ? "standard" : "arabic");
      });
    }
    var subpageBack = get("settings-subpage-back");
    if (subpageBack) subpageBack.addEventListener("click", closeSettingsCategory);
    get("history-back").addEventListener("click", function () { returnWithinWatch(leaveHistory); });
    var viewAllBtn = get("history-view-all");
    if (viewAllBtn) viewAllBtn.addEventListener("click", openHistoryAll);
    var allBackBtn = get("history-all-back");
    if (allBackBtn) allBackBtn.addEventListener("click", closeHistoryAll);
    var emptyActionBtn = get("history-empty-action");
    if (emptyActionBtn) emptyActionBtn.addEventListener("click", function () { exitToHome(); });
    doc.querySelectorAll("[data-history-filter]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.historyFilter = this.dataset.historyFilter;
        doc.querySelectorAll("[data-history-filter]").forEach(function (b) {
          b.classList.toggle("is-current", b === btn);
        });
        renderHistoryAll();
      });
    });
    var historySearch = get("history-search-input");
    if (historySearch) {
      historySearch.addEventListener("input", function () {
        state.historyQuery = this.value;
        renderHistoryAll();
      });
    }
    get("history-clear").addEventListener("click", function () {
      if (!clearPending) { clearPending = true; this.textContent = localize("Confirm clear history"); return; }
      core.clearHistory(local); clearPending = false; this.textContent = localize("Clear History");
      renderHistory(); syncStartedMarks(); focus(this);
    });
    get("details-back").addEventListener("click", function () { returnWithinWatch(backToResults); });
    get("episodes-back").addEventListener("click", function () { returnWithinWatch(backToDetails); });
    var seasonSelBtn = get("season-selector-btn");
    if (seasonSelBtn) {
      seasonSelBtn.addEventListener("click", function () {
        var dd = get("seasons-dropdown");
        if (dd && !dd.hidden) closeSeasonDropdown(true);
        else openSeasonDropdown();
      });
    }
    ["seed", "mode", "media", "style", "genre", "length", "rating", "year", "sort"].forEach(function (t) {
      var b = get("filter-btn-" + t);
      if (b) b.addEventListener("click", function () { openFilterMenu(t); });
    });
    var clearBtn = get("filter-btn-clear");
    if (clearBtn) clearBtn.addEventListener("click", clearActiveFilters);
    var filterEmptyClear = get("watch-filter-empty-clear");
    if (filterEmptyClear) filterEmptyClear.addEventListener("click", function () {
      if (state.watchTab === "discover") {
        if (discoverError) {
          discoverError = false;
          loadDiscoverData(true);
        } else if (isFilterActive("discover") || discoverMode !== "all" || discoverMedia !== "same") {
          clearActiveFilters();
          focus(get("filter-btn-seed") || get("watch-toggle"));
        } else {
          openFilterMenu("seed");
        }
      } else {
        clearActiveFilters(); focus(get("filter-btn-genre"));
      }
    });
    query.addEventListener("input", function () { state.query = query.value; scheduleSearch(300); });
    doc.querySelectorAll("[data-filter]").forEach(function (filter) { filter.addEventListener("click", function () {
      state.filter = filter.dataset.filter;
      doc.querySelectorAll("[data-filter]").forEach(function (button) {
        button.classList.toggle("is-current", button === filter);
      }); scheduleSearch(0);
    }); });
    buildKeyboard();
    doc.addEventListener("click", function (event) {
      var target = event.target && event.target.closest && event.target.closest("[data-focus]");
      if (target && !target.disabled && !target.closest("[hidden]")) focus(target);
    }, true);
    doc.addEventListener("focusin", function (event) {
      if (event.target && event.target.matches && event.target.matches("[data-focus]")) {
        event.target.classList.add("is-focused");
        if (state.view === "watch" && event.target.homeEntry) showHomeHero(event.target.homeEntry);
      }
    });
    if (hoverPointer) {
      doc.addEventListener("pointermove", function (event) {
        if (event.pointerType && event.pointerType !== "mouse" && event.pointerType !== "pen") return;
        pointerHeroActive = true;
        edgePointerX = event.clientX; edgePointerY = event.clientY;
        edgeLastMoveAt = Date.now();
        var row = state.view === "watch" && event.target.closest && event.target.closest(".watch-home-row");
        var group = row && row.id && row.id.replace(/^watch-/, "").replace(/-row$/, "");
        var rect = row && row.getBoundingClientRect();
        var zone = rect ? Math.max(42, Math.min(110, rect.width * 0.07)) : 0;
        var direction = rect && event.clientX <= rect.left + zone ? -1
          : rect && event.clientX >= rect.right - zone ? 1 : 0;
        if (!direction || !group || row.closest("[hidden]")) {
          if (homeMotion && homeMotion.mode === "edge") stopEdgeMotion();
          if (edgeIntentTimer) clock.clearTimeout(edgeIntentTimer);
          edgeIntentTimer = 0; edgeMotionGroup = "";
          var hovered = event.target.closest && event.target.closest(".home-card");
          if (hovered && hovered !== hoverHeroCard) scheduleHoverHero(hovered);
          else if (!hovered) cancelHoverHero();
          return;
        }
        cancelHoverHero();
        if (homeMotion && homeMotion.mode === "edge") {
          if (homeMotion.group === group) homeMotion.direction = direction;
          else stopEdgeMotion();
          return;
        }
        var intent = group + ":" + direction;
        if (edgeMotionGroup === intent) return;
        if (edgeIntentTimer) clock.clearTimeout(edgeIntentTimer);
        edgeMotionGroup = intent;
        edgeIntentTimer = clock.setTimeout(function () {
          edgeIntentTimer = 0;
          if (edgeMotionGroup === intent) startEdgeMotion(group, direction);
        }, 220);
      }, { passive: true });
      doc.addEventListener("pointerleave", function () {
        pointerHeroActive = false; cancelHoverHero(); stopEdgeMotion();
      });
    }
    get("watch-rows-scroll").addEventListener("scroll", function () {
      if (homeMotion && homeMotion.mode === "edge") stopEdgeMotion();
      get("watch-view").classList.toggle("has-row-scroll", get("watch-rows-scroll").scrollTop > 1);
      if (state.view === "watch" && doc.activeElement.dataset.homeGroup)
        syncActiveHomeHeading(doc.activeElement, true);
    });
    get("watch-rows-scroll").addEventListener("wheel", function (event) {
      if (state.view !== "watch" || event.ctrlKey || event.metaKey
          || event.target.closest("#watch-filter-menu")) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      triggerWheelHeadingFade();
    }, { passive: true });
    // The persistent hero is a sibling of the row scroller, so native wheel
    // bubbling cannot reliably reach it. Route only its vertical gestures.
    get("watch-hero").addEventListener("wheel", function (event) {
      if (state.view !== "watch" || event.ctrlKey || event.metaKey
          || event.target.closest("#watch-filter-menu")) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      triggerWheelHeadingFade();
      var scroller = get("watch-rows-scroll");
      var unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1;
      scroller.scrollTop += event.deltaY * unit;
    }, { passive: false });
    clock.addEventListener("resize", function () {
      if (state.view !== "watch") return;
      if (homeMotion) finishHorizontalMotion();
      var active = homeFocusIdentity(doc.activeElement), restored = null;
      Object.keys(homeCarousels).forEach(function (group) {
        var old = homeCarousels[group], row = old.row, track = old.track;
        if (old.trimTimer) clock.clearTimeout(old.trimTimer);
        if (row.closest("[hidden]")) {
          track.replaceChildren(); track.style.transform = "";
          delete homeCarousels[group]; return;
        }
        var index = active && active.group === group ? active.index : old.selected % old.cards.length;
        track.style.transition = "none";
        track.style.transform = "";
        track.replaceChildren();
        delete homeCarousels[group];
        var slot = revealHomeWindow(old.cards[index] || old.cards[0]);
        track.offsetWidth;
        track.style.transition = "";
        if (active && active.group === group) restored = slot;
      });
      if (restored) {
        restored.focus({ preventScroll: true }); restored.classList.add("is-focused");
        revealHomeSection(restored);
        syncActiveHomeHeading(restored, true);
      }
    });
    doc.addEventListener("focusout", function (event) {
      if (event.target && event.target.classList) event.target.classList.remove("is-focused");
    });
    doc.addEventListener("keydown", onKey);
    doc.addEventListener("keyup", function (event) {
      var key = keyName(event);
      if (key === "ArrowLeft" || key === "ArrowRight") {
        holdRepeatCount = 0;
        if (holdMotion) finishHoldMotion();
      }
    });
    clock.addEventListener("blur", function () {
      pointerHeroActive = false; cancelHoverHero();
      if (homeMotion && homeMotion.mode === "edge") stopEdgeMotion();
      else if (homeMotion) finishHorizontalMotion();
    });
    doc.addEventListener("visibilitychange", function () {
      if (doc.hidden && homeMotion) finishHorizontalMotion();
    });
    if (finePointer && root.history && root.history.replaceState && clock.addEventListener) {
      clock.addEventListener("popstate", restoreBrowserView);
    }
    clock.addEventListener("pagehide", function () { if (homeMotion) finishHorizontalMotion();
      disposed = true; if (searchTimer !== null) clock.clearTimeout(searchTimer);
      if (activeAbort) activeAbort.abort(); });
    try {
      if ((nav.hash || "").indexOf("#watch-import=") === 0 && nav.hash.length < 7000) {
        var homeImport = JSON.parse(decodeURIComponent(nav.hash.slice(14)));
        core.importHomeSnapshot(local, homeImport);
        if (root.history && root.history.replaceState) root.history.replaceState(null, "", nav.pathname + nav.search);
      }
      var saved = session && JSON.parse(session.getItem(core.STATE_KEY));
      var returned = core.returnEpisode(nav.search);
      var returnedMovie = core.returnMovie(nav.search);
      if (returned) {
        var acceptedHandoff = consumePlaybackHandoff(returned, "tv");
        var acceptedEpisodeProgress = acceptedHandoff ? returned.progress : null;
        core.writeSubtitlePref(local, returned.subtitle);
        pendingEpisodeFocus = { season: returned.season, episode: returned.episode };
        var old = core.readHistory(local || { getItem: function () { return null; } })
          .find(function (row) { return row.type === "tv" && row.id === returned.id; });
        var episodeRow = core.readHistory(local).find(function (row) { return row.type === "tv" && row.id === returned.id
          && row.season === returned.season && row.episode === returned.episode; });
        if (acceptedHandoff && (old || returned.showTitle)) returned.episodeTrail.forEach(function (entry) {
          var prior = core.readHistory(local).find(function (row) { return row.type === "tv" && row.id === returned.id
            && row.season === entry.season && row.episode === entry.episode; });
          if (!prior) core.writeHistory(local, core.item("tv", returned.id, old && old.title || returned.showTitle,
            entry.season, entry.episode, returned.subtitle, Date.now(), old || {}));
        });
        if (acceptedHandoff && (old || returned.showTitle)) returned.progressBatch.forEach(function (entry) {
          var prior = core.readHistory(local).find(function (row) { return row.type === "tv" && row.id === returned.id
            && row.season === entry.season && row.episode === entry.episode; });
          core.writeHistory(local, core.item("tv", returned.id, old && old.title || returned.showTitle, entry.season, entry.episode,
            returned.subtitle, entry.progress.updatedAt, Object.assign({}, old || {}, prior || {}, { progress: entry.progress })));
        });
        if (old || acceptedEpisodeProgress || acceptedHandoff && returned.showTitle) {
          var returnedArtwork = Object.assign({}, old || {}, episodeRow || {});
          returnedArtwork.episodeTitle = episodeRow && episodeRow.episodeTitle || returned.episodeTitle || "";
          returnedArtwork.progress = acceptedEpisodeProgress || episodeRow && episodeRow.progress || null;
          core.writeHistory(local, core.item("tv", returned.id,
            old && old.title || returned.showTitle || "TV Show", returned.season, returned.episode,
            returned.subtitle, Date.now(), returnedArtwork));
          if (acceptedEpisodeProgress) {
            core.writeActiveEpisode(local, returned.id, {
              season: returned.season,
              episode: returned.episode,
              at: acceptedEpisodeProgress.updatedAt || Date.now()
            });
          }
        }
        if (!core.readEpisodeCatalog(local, returned.id)) {
          api("/api/title/tv/" + returned.id).then(function (detail) {
            if (detail && core.writeEpisodeCatalog(local, returned.id, detail.seasons)) {
              if (state.view === "watch") renderHomepage();
            }
          }, function () {});
        }
      }
      if (returnedMovie) {
        var acceptedMovieProgress = consumePlaybackHandoff(returnedMovie, "movie") ? returnedMovie.progress : null;
        var existingMovie = core.readHistory(local).find(function (row) { return row.type === "movie"
          && row.id === returnedMovie.id; });
        if (acceptedMovieProgress && existingMovie) core.writeHistory(local, core.item("movie", returnedMovie.id,
          existingMovie.title, null, null, "off", Date.now(), Object.assign({}, existingMovie,
            { progress: acceptedMovieProgress })));
      }
      if (saved && saved.version === 1 && ["all", "movie", "tv"].indexOf(saved.filter) >= 0) {
        state.detailSource = ["history", "watch"].indexOf(saved.source) >= 0 ? saved.source : "search";
        state.filter = saved.filter; state.query = String(saved.query || "").slice(0, 80); query.value = state.query;
        doc.querySelectorAll("[data-filter]").forEach(function (b) { b.classList.toggle("is-current", b.dataset.filter === state.filter); });
        if (state.query.length >= 2) scheduleSearch(0);
      }
      if (returned && (!saved || saved.view !== "watch")) {
        var restoreEpisodes = !saved || saved.id !== returned.id || saved.view === "episodes"
          || new URLSearchParams(nav.search).get("episodes") === "1";
        api("/api/title/tv/" + returned.id).then(function (value) {
          if (!old) core.writeHistory(local, core.item("tv", returned.id, value.title,
            returned.season, returned.episode, returned.subtitle, Date.now(), value));
          openDetails(value); state.detailSource = saved && saved.source === "history" ? "history" : "search";
          state.detail = value; state.season = returned.season;
          state.subtitle = core.readSubtitlePref(local); renderActions();
          if (restoreEpisodes) browseEpisodes();
        }, function () { text("search-status", "Could not restore show details. Search for the show to continue."); });
      }
      if (returnedMovie && (!saved || saved.view !== "watch")) {
        api("/api/title/movie/" + returnedMovie.id).then(function (value) {
          existingMovie = core.readHistory(local).find(function (row) { return row.type === "movie"
            && row.id === returnedMovie.id; });
          if (acceptedMovieProgress || existingMovie) core.writeHistory(local, core.item("movie", returnedMovie.id,
            value.title, null, null, "off", Date.now(), Object.assign({}, existingMovie || {}, {
              poster: existingMovie && existingMovie.poster || value.poster,
              backdrop: existingMovie && existingMovie.backdrop || value.backdrop,
              progress: acceptedMovieProgress || existingMovie && existingMovie.progress || null
            })));
          openDetails(value);
          state.detailSource = saved && saved.source === "history" ? "history" : "search";
        }, function () { text("search-status", "Could not restore movie details. Search for the movie to continue."); });
      }
      if ((returned || returnedMovie) && root.history && root.history.replaceState) root.history.replaceState(null, "",
        useMock ? (nav.pathname + "?mock=1") : "/");
    } catch (_error) { /* Storage and history are optional on the TV browser. */ }
    setView("watch"); renderHomepage(); focusHomeTarget();
    if (finePointer && root.history && root.history.replaceState) {
      try { root.history.replaceState({ horizonWatchView: state.view, depth: 0 }, "", nav.href);
        historyReady = true;
      } catch (_error) { /* Browser history remains optional on SmartCast. */ }
    }
    var incoming = new URLSearchParams(nav.search);
    if (incoming.get("play") === "tv") {
      var requested = core.item("tv", Number(incoming.get("id")), incoming.get("name"),
        Number(incoming.get("season")), Number(incoming.get("episode")), incoming.get("sub"), Date.now(),
        { poster: incoming.get("poster"), backdrop: incoming.get("backdrop"), episodeTitle: incoming.get("episodeTitle"),
          tvdbId: Number(incoming.get("tvdb")) });
      if (requested) {
        state.title = requested; state.season = requested.season;
        state.subtitle = core.readSubtitlePref(local);
        state.episodes = [{ number: requested.episode, title: requested.episodeTitle }];
        setView("episodes"); launchEpisode(requested.season, requested.episode);
      } else text("search-status", "Saved episode is invalid. Search for the show to continue.");
    } else if (incoming.get("open") === "movie" && /^[1-9][0-9]*$/.test(incoming.get("id") || "")) {
      api("/api/title/movie/" + incoming.get("id")).then(function (value) { openDetails(value); }, function () {
        text("search-status", "Movie details unavailable. Search for the movie to continue.");
      });
    }
    return { state: state, searchNow: searchNow, openDetails: openDetails, browseEpisodes: browseEpisodes,
      launchEpisode: launchEpisode, onKey: onKey, showContinue: showContinue };
  }
  root.HorizonUniversalSearch = { createApp: createApp, nativeEditingKey: nativeEditingKey,
    adjacentHomeRow: adjacentHomeRow, nextHomeRowIndex: nextHomeRowIndex, circularIndex: circularIndex,
    isRowShort: isRowShort };
  if (typeof document !== "undefined") root.HorizonUniversalSearch.app = createApp(document, location, root);
})(typeof window !== "undefined" ? window : globalThis);
