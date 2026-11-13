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
  function circularIndex(index, length, direction) {
    return length ? (index + direction + length) % length : -1;
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
    var watchPerformance = root.HorizonWatchPerformance
      ? root.HorizonWatchPerformance.create(doc, clock) : null;
    var query = get("query"), results = get("results");
    var state = { view: "watch", previousView: "watch", detailSource: "watch", filter: "all", query: "", title: null, detail: null,
      season: null, episodes: [], subtitle: core.readSubtitlePref(local), continueMode: false,
      watchTab: "for-you", detailSourceTab: "for-you" };
    var finePointer = !!(clock.matchMedia && clock.matchMedia("(pointer: fine)").matches)
      && !/Vizio|SmartCast/i.test(clock.navigator && clock.navigator.userAgent || "");
    var keyboardOpen = !finePointer;
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
    var discoverFilters = { genre: null, length: null, rating: null, year: null, sort: "best" };
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
    var homeCards = Object.create(null), homeWindowSizes = Object.create(null);
    var homeScrollFrame = 0, homeHeroTimer = 0;
    var catalogRequests = Object.create(null);
    var homeRowOrder = ["continue", "top", "because", "recent"];
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
      return ["continue", "top", "because", "trending", "gems", "explore", "recent"];
    }
    function text(id, value) { get(id).textContent = value; }
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
        if (watchPerformance) watchPerformance.close();
        if (homeHeroTimer) clock.clearTimeout(homeHeroTimer);
        homeHeroTimer = 0; ++homeHeroToken;
        ++homeArtRequest; homeArtTargetSrc = "";
        if (homeScrollFrame) clock.cancelAnimationFrame(homeScrollFrame);
        homeScrollFrame = 0;
        homeOpenToken += 1; homeOpenPending = false;
        homeRowMemory = Object.create(null); homeLastContent = null; homeReturnFocus = null;
        get("watch-rows-scroll").scrollTop = 0;
        homeRowOrder.forEach(function (group) { get("watch-" + group + "-row").scrollLeft = 0; });
      }
      state.view = name;
      ["watch", "search", "details", "episodes", "history", "settings"].forEach(function (view) { get(view + "-view").hidden = view !== name; });
      get("keyboard").hidden = name !== "search" || !keyboardOpen;
      get("keyboard-toggle").textContent = keyboardOpen ? "Hide Keyboard" : "Show Keyboard";
      doc.body.classList.toggle("details-active", name === "details");
      doc.body.classList.toggle("episodes-active", name === "episodes");
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
    function scrollHomeRows(scroller, delta) {
      var destination = scroller.scrollTop + delta;
      if (homeScrollFrame) clock.cancelAnimationFrame(homeScrollFrame);
      homeScrollFrame = 0;
      if (!clock.requestAnimationFrame || !clock.cancelAnimationFrame || !clock.matchMedia
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
        heading.style.top = Math.max(original.getBoundingClientRect().top,
          get("watch-rows-scroll").getBoundingClientRect().top) - home.top + "px";
      }
    }
    function focus(element, skipHomeVertical, direction) { if (element) {
      var previous = doc.querySelector("[data-focus].is-focused");
      var previousHomeGroup = previous && previous.dataset.homeGroup || "";
      if (previous && previous !== element) previous.classList.remove("is-focused");
      if (element.dataset.homeGroup) revealHomeWindow(element, direction);
      else if (previousHomeGroup && element.closest(".watch-rail")) {
        var prevRowButtons = homeRowButtons(previousHomeGroup);
        if (prevRowButtons.length && rowCycleIndex[previousHomeGroup] <= 0) {
          revealHomeWindow(prevRowButtons[0]);
        }
      }
      element.focus({ preventScroll: true }); element.classList.add("is-focused");
      var seasonStrip = element.closest("#seasons");
      var episodeScroll = element.closest("#episode-list");
      var resultScroll = element.closest("#results, #history-list, #settings-view");
      var homeScroll = element.closest(".watch-home-row");
      if (seasonStrip) revealInScroller(element, seasonStrip, true, 14);
      else if (episodeScroll) revealInScroller(element, episodeScroll, false, 18);
      else if (homeScroll) {
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
      var el = doc.createElement("button"); el.type = "button"; el.textContent = label;
      el.dataset.focus = "1"; if (className) el.className = className;
      el.addEventListener("click", click); return el;
    }
    function detailAction(label, click, className, action) {
      var el = button(label, click, className);
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
      if (defer && artWindowExperiment) img.dataset.pendingSrc = url; else img.src = url;
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
        key: element.dataset.homeKey || "", index: row ? (homeCards[element.dataset.homeGroup] || []).indexOf(element) : -1 };
    }
    function homeRowButtons(group) {
      var host = get("watch-" + group + "-row");
      return host && !host.closest("[hidden]") ? homeCards[group] || [] : [];
    }
    function recordHomeCards(group) {
      homeCards[group] = Array.from(get("watch-" + group + "-row").querySelectorAll(".home-card"));
      delete homeWindowSizes[group];
    }
    function loadHomeWindowArt(cards) {
      if (!artWindowExperiment) return;
      cards.forEach(function (card) {
        card.querySelectorAll("img[data-pending-src]").forEach(function (image) {
          image.src = image.dataset.pendingSrc;
          delete image.dataset.pendingSrc;
        });
      });
    }
    function revealHomeWindow(element, direction) {
      var group = element.dataset.homeGroup, cards = homeCards[group];
      if (!cards || !cards.length) return;
      var row = get("watch-" + group + "-row"), track = row.querySelector(".watch-home-track");
      if (!row || !track) return;

      var first = track.firstElementChild || cards[0];
      var width = first.offsetWidth || 280;
      var nextEl = first.nextElementSibling;
      var cardStep = (nextEl && first && (nextEl.offsetLeft - first.offsetLeft))
        || (width + 16);
      if (cardStep <= 0) cardStep = width + 16;
      var rowWidth = row.clientWidth || (clock.innerWidth ? clock.innerWidth - 180 : 1735);
      var visibleSlots = Math.max(1, Math.ceil(rowWidth / cardStep));
      var overscan = 3;

      // Short rows: avoid duplicate titles, keep all cards in natural order
      if (cards.length <= visibleSlots) {
        if (track.childElementCount !== cards.length) {
          track.replaceChildren.apply(track, cards);
        }
        track.style.transform = "";
        row.scrollLeft = 0;
        loadHomeWindowArt(cards);
        return;
      }

      var windowSize = Math.min(cards.length, visibleSlots + overscan * 2);
      var attached = Array.from(track.children);
      var pos = attached.indexOf(element);

      // If element is not currently in track (e.g. restoring focus from memory or large jump)
      if (pos < 0) {
        var cardIndex = cards.indexOf(element);
        if (cardIndex < 0) return;
        var start = (cardIndex === 0 && row.scrollLeft <= 2) ? 0 : Math.max(0, cardIndex - overscan);
        var selected = [];
        for (var s = 0; s < windowSize; s++) {
          selected.push(cards[(start + s) % cards.length]);
        }
        track.replaceChildren.apply(track, selected);
        attached = Array.from(track.children);
        pos = attached.indexOf(element);
      }

      // On entering or returning to the first title: first poster at left gutter, nothing to the left
      if (element === cards[0] && direction !== 1) {
        if (attached[0] !== cards[0] || row.scrollLeft > 2) {
          var selected0 = [];
          for (var s0 = 0; s0 < windowSize; s0++) {
            selected0.push(cards[s0 % cards.length]);
          }
          track.replaceChildren.apply(track, selected0);
          attached = Array.from(track.children);
          pos = attached.indexOf(element);
          row.scrollLeft = 0;
          track.style.transform = "";
        }
        loadHomeWindowArt(attached);
        return;
      }

      var behindCount = pos;
      var aheadCount = attached.length - 1 - pos;

      // Approaching the end (moving right): recycle cards from front to back
      if (aheadCount < visibleSlots + overscan && behindCount > overscan) {
        var toMoveAhead = Math.min((visibleSlots + overscan) - aheadCount, behindCount - overscan);
        for (var ma = 0; ma < toMoveAhead; ma++) {
          var frontCard = track.firstElementChild;
          if (frontCard && frontCard !== element) {
            track.removeChild(frontCard);
            var lastAttached = track.lastElementChild;
            var lastIdx = cards.indexOf(lastAttached);
            var nextCardToAdd = cards[(lastIdx + 1) % cards.length];
            track.appendChild(nextCardToAdd);
            row.scrollLeft -= cardStep;
            behindCount--;
            aheadCount++;
          }
        }
        attached = Array.from(track.children);
        pos = attached.indexOf(element);
      }

      // Approaching the start (moving left): recycle cards from back to front
      // Never prepend before cards[0] in the current cycle
      if (behindCount < overscan && aheadCount > visibleSlots + overscan && attached[0] !== cards[0] && row.scrollLeft > 2) {
        var toMoveBehind = Math.min(overscan - behindCount, aheadCount - (visibleSlots + overscan));
        for (var mb = 0; mb < toMoveBehind; mb++) {
          var backCard = track.lastElementChild;
          if (backCard && backCard !== element) {
            track.removeChild(backCard);
            var firstAttached = track.firstElementChild;
            var firstIdx = cards.indexOf(firstAttached);
            var prevCardToAdd = cards[(firstIdx - 1 + cards.length) % cards.length];
            track.insertBefore(prevCardToAdd, track.firstElementChild);
            row.scrollLeft += cardStep;
            behindCount++;
            aheadCount--;
          }
        }
        attached = Array.from(track.children);
        pos = attached.indexOf(element);
      }

      loadHomeWindowArt(attached);
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
      var order = currentTabRowOrder();
      for (var i = 0; i < order.length; i++) {
        var first = homeRowButtons(order[i])[0]; if (first) return first;
      }
      return null;
    }
    function nearestHomeButton(group) {
      var order = currentTabRowOrder();
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
      return (row.type === "tv" ? "S" + row.season + " E" + row.episode
        + (row.episodeTitle ? " · " + row.episodeTitle : (row.isNextUnwatched ? " · Ready to start" : "")) : "Movie");
    }
    function homeDetail(row) {
      var key = row.type + ":" + row.id;
      if (!homeDetailCache.has(key)) homeDetailCache.set(key,
        api("/api/title/" + row.type + "/" + row.id).then(function (detail) { return detail; }, function () { return null; }));
      return homeDetailCache.get(key);
    }
    var homeArtRequest = 0, homeArtTargetSrc = "";
    function setHomeArtwork(backdropPath, posterPath) {
      var art = get("watch-hero-art");
      var paths = backdropPath ? [[backdropPath, "hero", false]] : [];
      if (posterPath) paths.push([posterPath, "poster", true]);
      if (!paths.length) { ++homeArtRequest; homeArtTargetSrc = ""; art.replaceChildren(); return; }
      var requestedSrc = core.imageUrl(paths[0][0], paths[0][1]);
      var visible = art.querySelector("img.is-visible");
      if (visible && visible.src === requestedSrc) {
        if (homeArtTargetSrc !== requestedSrc) ++homeArtRequest;
        homeArtTargetSrc = requestedSrc;
        return;
      }
      if (homeArtTargetSrc === requestedSrc) return;
      homeArtTargetSrc = requestedSrc;
      var request = ++homeArtRequest;
      function tryPath(index) {
        if (request !== homeArtRequest) return;
        if (index >= paths.length) { homeArtTargetSrc = ""; return; }
        var path = paths[index], src = core.imageUrl(path[0], path[1]);
        var current = art.querySelector("img.is-visible");
        if (current && current.src === src) { homeArtTargetSrc = src; return; }
        var image = doc.createElement("img");
        image.alt = ""; image.className = "home-art-layer";
        var artStarted = watchPerformance && watchPerformance.heroStart();
        image.addEventListener("error", function () {
          if (watchPerformance) watchPerformance.heroEnd(artStarted, true);
          tryPath(index + 1);
        });
        image.addEventListener("load", function () {
          if (watchPerformance) watchPerformance.heroEnd(artStarted, false);
          if (request !== homeArtRequest || state.view !== "watch") return;
          homeArtTargetSrc = src;
          Array.from(art.querySelectorAll("img:not(.is-visible)")).forEach(function (old) { old.remove(); });
          current = art.querySelector("img.is-visible");
          art.classList.toggle("is-poster", path[2]);
          art.appendChild(image);
          if (!current || clock.matchMedia && clock.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            if (current) current.remove();
            image.classList.add("is-visible"); return;
          }
          clock.requestAnimationFrame(function () { clock.requestAnimationFrame(function () {
            if (request !== homeArtRequest) return;
            image.classList.add("is-visible"); current.classList.remove("is-visible");
            clock.setTimeout(function () { if (current.parentNode === art) current.remove(); }, 480);
          }); });
        });
        image.src = src;
      }
      tryPath(0);
    }
    function paintHomeHero(entry, detail) {
      homeHeroEntry = entry;
      if (entry) {
        var row = entry.row, backdropPath = detail && detail.backdrop || row.backdrop,
          posterPath = detail && detail.poster || row.poster;
        setHomeArtwork(backdropPath, posterPath);
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
        ++homeArtRequest; get("watch-hero-art").replaceChildren();
        text("watch-hero-title", "Find your next watch");
        text("watch-hero-context", "Your viewing history will appear here.");
        text("watch-hero-description", "Use Search to find a movie or show.");
      }
    }
    function showHomeHero(entry) {
      if (homeHeroTimer) clock.clearTimeout(homeHeroTimer);
      homeHeroTimer = 0;
      if (entry && entry === homeHeroEntry) return;
      var token = ++homeHeroToken;
      function settle() {
        homeHeroTimer = 0;
        if (disposed || state.view !== "watch" || token !== homeHeroToken) return;
        paintHomeHero(entry, null);
        if (entry && entry.group !== "top" && entry.group !== "because") homeDetail(entry.row).then(function (detail) {
          if (!disposed && state.view === "watch" && token === homeHeroToken && detail) paintHomeHero(entry, detail);
        });
      }
      if (entry && homeHeroEntry) homeHeroTimer = clock.setTimeout(settle, 110);
      else settle();
    }
    function openHomeEntry(entry) {
      if (!entry || homeOpenPending || state.view !== "watch") return;
      var row = entry.row;
      if (row.type === "movie") { openDetails(row); return; }
      function openEpisode(target) {
        if (state.view !== "watch") return;
        homeOpenPending = false;
        openDetails(row, target || { season: row.season, episode: row.episode });
      }
      if (entry.group !== "recent") { openEpisode(null); return; }
      homeOpenPending = true;
      var token = ++homeOpenToken;
      homeDetail(row).then(function (detail) {
        var canonical = core.canonicalEpisodeTarget(core.readHistory(local), row.id, detail || local, local);
        return canonical ? { season: canonical.season, episode: canonical.episode } : (detail ? lookupNextEpisode(row, detail) : null);
      }).then(function (target) { if (token === homeOpenToken) openEpisode(target); },
        function () { if (token === homeOpenToken) openEpisode(null); });
    }
    function isFilterActive(tab) {
      var f = tab === "tv" ? tvFilters : (tab === "movies" ? movieFilters : discoverFilters);
      return !!(f.genre || f.length || f.rating || f.year || (f.sort && f.sort !== "best"));
    }
    function updateFilterStripUI() {
      var isTv = state.watchTab === "tv";
      var isDiscover = state.watchTab === "discover";
      var f = isTv ? tvFilters : (state.watchTab === "movies" ? movieFilters : discoverFilters);

      var seedBtn = get("filter-btn-seed");
      var modeBtn = get("filter-btn-mode");
      var mediaBtn = get("filter-btn-media");
      var finishedBtn = get("filter-btn-finished");

      if (seedBtn) {
        seedBtn.hidden = !isDiscover;
        if (isDiscover) {
          seedBtn.textContent = "Seed: " + (discoverActiveSeed ? discoverActiveSeed.title : "Choose Seed");
          seedBtn.classList.add("is-active");
        }
      }
      if (modeBtn) {
        modeBtn.hidden = !isDiscover;
        if (isDiscover) {
          var modeLabels = { all: "All Categories", closest: "Closest", vibe: "Same Vibe", genre: "Same Genre", gems: "Hidden Gems" };
          modeBtn.textContent = "Category: " + (modeLabels[discoverMode] || "All Categories");
          modeBtn.classList.toggle("is-active", discoverMode !== "all");
        }
      }
      if (mediaBtn) {
        mediaBtn.hidden = !isDiscover;
        if (isDiscover) {
          var mediaLabels = { same: "Same Type", tv: "TV Shows", movie: "Movies", both: "Both" };
          mediaBtn.textContent = "Type: " + (mediaLabels[discoverMedia] || "Same Type");
          mediaBtn.classList.toggle("is-active", discoverMedia !== "same");
        }
      }
      if (finishedBtn) {
        finishedBtn.hidden = !isDiscover;
        if (isDiscover) {
          finishedBtn.textContent = discoverHideFinished ? "Hide Finished" : "Show Finished";
          finishedBtn.classList.toggle("is-active", discoverHideFinished);
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
      if (lengthBtn) {
        var lengthLabels = isTv
          ? { short: "<30 min", medium: "30-60 min", long: ">60 min" }
          : { short: "<90 min", medium: "90-120 min", long: ">120 min" };
        lengthBtn.textContent = f.length ? "Length: " + (lengthLabels[f.length] || f.length) : "Length";
        lengthBtn.classList.toggle("is-active", !!f.length);
      }
      if (ratingBtn) {
        ratingBtn.textContent = f.rating ? "Rating: " + f.rating : "Age Rating";
        ratingBtn.classList.toggle("is-active", !!f.rating);
      }
      if (yearBtn) {
        var yearLabels = { "2020s": "2020s", "2010s": "2010s", "2000s": "2000s", "older": "Older" };
        yearBtn.textContent = f.year ? "Year: " + (yearLabels[f.year] || f.year) : "Year";
        yearBtn.classList.toggle("is-active", !!f.year);
      }
      if (sortBtn) {
        var sortLabels = { best: "Best Match", popularity: "Popularity", rating: "Highest Rated", newest: "Newest" };
        sortBtn.textContent = "Sort: " + (sortLabels[f.sort] || "Best Match");
        sortBtn.classList.toggle("is-active", f.sort && f.sort !== "best");
      }
      if (clearBtn) {
        var hasActive = isFilterActive(state.watchTab) || (isDiscover && (discoverMode !== "all" || discoverMedia !== "same" || !discoverHideFinished));
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
      } else if (filterType === "finished") {
        options.push({ label: "Hide Finished Titles", value: "true" });
        options.push({ label: "Show Finished Titles", value: "false" });
      } else if (filterType === "genre") {
        options.push({ label: "All Genres", value: "" });
        var genreList = isTv
          ? [[10759, "Action & Adventure"], [16, "Animation"], [35, "Comedy"], [80, "Crime"], [18, "Drama"], [9648, "Mystery"], [10765, "Sci-Fi & Fantasy"]]
          : [[28, "Action"], [12, "Adventure"], [16, "Animation"], [35, "Comedy"], [80, "Crime"], [18, "Drama"], [27, "Horror"], [878, "Sci-Fi"], [53, "Thriller"]];
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
        : filterType === "finished" ? (discoverHideFinished ? "true" : "false")
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
      if (filterType === "finished") {
        discoverHideFinished = (value === "true");
        closeFilterMenu();
        rowCycleIndex = Object.create(null);
        updateFilterStripUI();
        renderDiscoverRows(discoverData);
        var originatingFinished = get("filter-btn-finished");
        if (originatingFinished) focus(originatingFinished);
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
        discoverFilters = { genre: null, length: null, rating: null, year: null, sort: "best" };
        discoverMode = "all";
        discoverMedia = "same";
        discoverHideFinished = true;
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
        if (candidate.matchReason) {
          var reasonEl = doc.createElement("small");
          reasonEl.className = "card-match-reason";
          reasonEl.textContent = candidate.matchReason;
          card.appendChild(reasonEl);
        }
        card.setAttribute("aria-label", candidate.title + ", " + (candidate.type === "tv" ? "TV series" : "movie"));
        card.addEventListener("mouseenter", function () {
          if (state.view === "watch") showHomeHero(card.homeEntry);
        });
        track.appendChild(card);
      });
      var sec = get("watch-" + group + "-section");
      if (sec) sec.hidden = group === "filtered" ? (candidateList || []).length === 0 : (candidateList || []).length < 2;
      recordHomeCards(group);
      var cards = homeRowButtons(group);
      if (artWindowExperiment && cards.length) {
        var active = homeFocusIdentity(doc.activeElement);
        revealHomeWindow(resolveHomeSelection(active && active.group === group ? active : null) || cards[0]);
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
    function paintHomepage(continueRows, finishedRows) {
      var previous = homeFocusIdentity(doc.activeElement);
      if (state.watchTab === "for-you") {
        homeDefaultEntry = continueRows[0] ? { row: continueRows[0], group: "continue" }
          : finishedRows[0] ? { row: finishedRows[0], group: "recent" } : null;
      }
      function rowCard(entry, group, action) {
        var row = entry.row, card = button("", action, "home-card");
        card.dataset.homeGroup = group; card.dataset.homeKey = row.type + ":" + row.id;
        card.homeEntry = entry;
        var artwork = group === "continue" ? landscapeArt(row, true) : verticalPosterArt(row, true),
          title = doc.createElement("strong"), context = doc.createElement("small");
        title.textContent = row.title; context.textContent = homeContext(row);
        card.appendChild(artwork);
        if (group === "continue") {
          var caption = doc.createElement("span"); caption.className = "home-card-caption";
          caption.appendChild(title); caption.appendChild(context); artwork.appendChild(caption);
          var fraction = core.episodeProgressFraction(row);
          if (fraction > 0) { var line = doc.createElement("span"), fill = doc.createElement("span");
            line.className = "home-progress"; fill.className = "home-progress-fill";
            fill.style.width = (fraction * 100).toFixed(1) + "%";
            line.appendChild(fill); artwork.appendChild(line); }
        } else {
          card.classList.add("home-card-poster"); card.appendChild(title);
        }
        card.addEventListener("mouseenter", function () { if (state.view === "watch") showHomeHero(entry); });
        card.setAttribute("aria-label", (group === "continue" ? "Continue " : "Finished ")
          + row.title + ", " + context.textContent);
        return card;
      }
      var continueHost = get("watch-continue-row"), recentHost = get("watch-recent-row");
      continueHost.scrollLeft = 0; recentHost.scrollLeft = 0;
      rowCycleIndex["continue"] = 0; rowCycleIndex["recent"] = 0;
      var continueRow = continueHost.querySelector(".watch-home-track");
      var recentRow = recentHost.querySelector(".watch-home-track");
      continueRow.replaceChildren(); recentRow.replaceChildren();
      if (state.watchTab === "for-you") {
        continueRows.slice(0, 8).forEach(function (row) {
          var entry = { row: row, group: "continue" };
          continueRow.appendChild(rowCard(entry, "continue", function () { openHomeEntry(entry); }));
        });
        finishedRows.slice(0, 8).forEach(function (row) {
          var entry = { row: row, group: "recent" };
          recentRow.appendChild(rowCard(entry, "recent", function () { openHomeEntry(entry); }));
        });
        get("watch-continue-section").hidden = !continueRows.length;
        get("watch-recent-section").hidden = !finishedRows.length;
        recordHomeCards("continue"); recordHomeCards("recent");
      } else {
        get("watch-continue-section").hidden = true;
        get("watch-recent-section").hidden = true;
        homeCards["continue"] = [];
        homeCards["recent"] = [];
      }
      if (artWindowExperiment && state.watchTab === "for-you") ["continue", "recent"].forEach(function (group) {
        var cards = homeRowButtons(group);
        if (cards.length) revealHomeWindow(resolveHomeSelection(previous && previous.group === group ? previous : null) || cards[0]);
      });
      updateHomeSections();
      if (previous && previous.group) { homeReturnFocus = previous; focusHomeTarget(); }
      else showHomeHero(homeDefaultEntry);
    }
    function updateHomeSections() {
      var allKnownGroups = [
        "continue", "top", "because", "recent", "trending", "gems", "explore",
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
        } else if (group !== "continue" && group !== "recent" && group !== "filtered") {
          sec.hidden = (homeCards[group] || []).length < 2;
        }
      });
      var first = false;
      activeOrder.forEach(function (group) {
        var section = get("watch-" + group + "-section");
        if (!section) return;
        section.classList.toggle("is-first-visible", !section.hidden && !first);
        if (!section.hidden) first = true;
      });
      get("watch-view").classList.toggle("is-empty", !first);
    }
    function paintRecommendationRows(rows) {
      recommendationRows = rows;
      var active = homeFocusIdentity(doc.activeElement), activeGroup = active && active.group;
      var activeRow = activeGroup && activeGroup !== "continue" && activeGroup !== "recent";
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
      return recommendations.seedQuery(rows, feedback) + "|" + feedback.revision + "|"
        + rows.map(function (row) { return row.type + ":" + row.id + ":"
          + (row.progress && row.progress.updatedAt || 0) + ":" + (row.progress && row.progress.completed || false);
        }).join(",");
    }
    var knownRuntimes = Object.create(null);
    var candidateEnrichmentStarted = false;
    function enrichCandidateRuntimes(candidates) {
      if (!candidates || !candidates.length || candidateEnrichmentStarted) return;
      candidateEnrichmentStarted = true;
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
        if (updated && !disposed && state.view === "watch" && recommendationPayload) {
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

      if (useMock && mock.discoverSimilar) {
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
          if (useMock && mock.discoverSimilar) {
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
      var anyResults = (discoverMode === "closest" ? closestList.length >= 2
        : discoverMode === "vibe" ? vibeList.length >= 2
        : discoverMode === "genre" ? genreList.length >= 2
        : discoverMode === "gems" ? gemsList.length >= 2
        : (closestList.length >= 2 || vibeList.length >= 2 || genreList.length >= 2 || gemsList.length >= 2));
      if (emptySec) {
        if (!anyResults) {
          var isFiltered = isFilterActive("discover") || discoverMode !== "all" || discoverMedia !== "same";
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
    }
    function renderHomepage() {
      var rows = previewRows || core.readHistory(local);
      paintHomepage(core.homepageContinueCandidates(rows, local).filter(function (row) {
        return !core.isContinueHidden(local, row);
      }), core.homepageFinished(rows, local));
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
    function renderResults(rows) {
      results.replaceChildren();
      results.scrollTop = 0;
      rows.forEach(function (row) {
        var card = button("", function () { openDetails(row); }, "poster-card");
        card.dataset.mediaType = row.type;
        card.dataset.mediaId = String(row.id);
        var art = landscapeArt(row);
        var meta = doc.createElement("span"); meta.className = "poster-meta";
        var title = doc.createElement("strong"); title.textContent = row.title;
        var info = doc.createElement("small"); info.textContent = row.resume && row.type === "movie"
          ? row.resume.progress && !row.resume.progress.completed
            ? "Movie · " + Math.round(row.resume.progress.position / row.resume.progress.duration * 100) + "% watched"
            : "Movie" : row.resume && row.type === "tv"
          ? "S" + row.resume.season + " E" + row.resume.episode + (row.resume.episodeTitle ? " · " + row.resume.episodeTitle : "")
            + (row.resume.progress && !row.resume.progress.completed
              ? " · " + Math.round(row.resume.progress.position / row.resume.progress.duration * 100) + "% watched"
              : row.resume.progress && row.resume.progress.completed ? " · completed" : "")
          : (row.type === "tv" ? "TV" : "Movie") + (row.date ? " · " + row.date.slice(0, 4) : "");
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
    function searchNow(explicit) {
      if (disposed || state.continueMode) return;
      syncRail();
      if (searchTimer !== null) { clock.clearTimeout(searchTimer); searchTimer = null; }
      var q = state.query.trim(), token = ++searchToken;
      if (activeAbort) activeAbort.abort();
      if (q.length < (explicit ? 1 : 2)) { renderResults([]); text("search-status", "Enter at least two characters to search, or press OK to submit."); return; }
      text("search-status", "Searching…");
      var key = state.filter + ":" + q.toLowerCase();
      var cached = cache.get(key);
      if (cached && Date.now() - cached.at < 420000) {
          renderResults(cached.rows); text("search-status", cached.rows.length ? cached.rows.length + " results" : "No titles found.");
        return;
      }
      activeAbort = new AbortController();
      api("/api/search?q=" + encodeURIComponent(q) + "&type=" + state.filter, activeAbort.signal)
        .then(function (value) {
          if (disposed || token !== searchToken) return;
          var rows = core.rankResults(Array.isArray(value.results) ? value.results : [], q);
          if (cache.size >= 40) cache.delete(cache.keys().next().value);
          cache.set(key, { at: Date.now(), rows: rows });
          renderResults(rows); text("search-status", rows.length ? rows.length + " results" : "No titles found.");
        }, function (error) {
          if (disposed || token !== searchToken || error.name === "AbortError") return;
          renderResults([]); text("search-status", error.status === 429
            ? "Search is rate limited. Try again" + (error.retryAfter ? " in about " + error.retryAfter + " seconds." : " shortly.")
            : "Search unavailable. Press Retry or edit the query.");
          results.appendChild(button("Retry", function () { searchNow(true); }));
        });
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
    function renderSettings() {
      var rows = core.readHistory(local), visible = core.homepageContinueCandidates(rows, local);
      var continueHost = get("settings-continue"), historyHost = get("settings-history");
      continueHost.replaceChildren(); historyHost.replaceChildren();
      if (!visible.length) { var empty = doc.createElement("p"); empty.textContent = "No unfinished titles saved.";
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
      if (!rows.length) { var noHistory = doc.createElement("p"); noHistory.textContent = "No saved viewing history.";
        historyHost.appendChild(noHistory); }
      rows.forEach(function (row) {
        var line = doc.createElement("div"); line.className = "settings-entry";
        var name = doc.createElement("span");
        name.textContent = row.title + (row.type === "tv" ? " · S" + row.season + " E" + row.episode : " · Movie")
          + (row.progress ? " · " + Math.floor(row.progress.position / 60) + "m / "
            + Math.floor(row.progress.duration / 60) + "m" : " · Position unavailable");
        if (row.type === "tv") {
          var last = core.lastWatchedEpisode(rows, row.id);
          if (last && last.season === row.season && last.episode === row.episode) name.textContent += " · Last watched";
        }
        line.appendChild(name);
        line.appendChild(button(row.manualWatched === true ? "Mark unfinished" : "Mark finished", function () {
          core.setHistoryWatched(local, row.type, row.id, row.season, row.episode, row.manualWatched !== true);
          renderSettings(); focus(get("settings-toggle"));
        }));
        function deleteButton(label, allTitle) {
          var confirm = false;
          return button(label, function () {
            if (!confirm) { confirm = true; this.textContent = "Confirm " + label.toLowerCase(); focus(this); return; }
            core.deleteHistory(local, row.type, row.id, row.season, row.episode, allTitle);
            renderSettings(); focus(get("settings-toggle"));
          });
        }
        line.appendChild(deleteButton("Delete entry", false));
        if (row.type === "tv") line.appendChild(deleteButton("Delete all for show", true));
        historyHost.appendChild(line);
      });
    }
    function showSettings() { setView("settings"); renderSettings(); focus(get("settings-toggle")); saveView(); }
    function renderHistory() {
      var list = get("history-list"); list.replaceChildren();
      list.scrollTop = 0;
      var rows = core.groupedHistory(core.readHistory(local));
      rows.forEach(function (row) {
        var label = row.title + (row.type === "tv" ? " · S" + row.season + " E" + row.episode
          + (row.episodeTitle ? " · " + row.episodeTitle : "") : "")
          + (row.progress && !row.progress.completed
            ? " · " + Math.round(row.progress.position / row.progress.duration * 100) + "% watched" : "")
          + " · " + new Date(row.at).toLocaleDateString();
        var card = button(label, function () { launchHistory(row); }, "poster-card history-card");
        var art = verticalPosterArt(row);
        var meta = doc.createElement("span"); meta.className = "poster-meta";
        var name = doc.createElement("strong"); name.textContent = row.title;
        var detail = doc.createElement("small");
        detail.textContent = row.type === "tv" ? "S" + row.season + " E" + row.episode
          + (row.progress && !row.progress.completed ? " · "
            + Math.round(row.progress.position / row.progress.duration * 100) + "% watched" : "")
          : row.progress && !row.progress.completed ? "Movie · "
            + Math.round(row.progress.position / row.progress.duration * 100) + "% watched" : "Movie";
        meta.appendChild(name); meta.appendChild(detail); card.textContent = "";
        card.appendChild(art); card.appendChild(meta); card.setAttribute("aria-label", label);
        list.appendChild(card);
      });
      text("history-status", rows.length ? rows.length + " recently started titles" : "No viewing history yet.");
    }
    function showHistory() {
      state.previousView = state.view === "history" ? state.previousView : state.view;
      clearPending = false; get("history-clear").textContent = "Clear History";
      setView("history"); renderHistory(); focus(get("history-back"));
    }
    function leaveHistory() {
      clearPending = false; get("history-clear").textContent = "Clear History";
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
        var label = doc.createElement("span"); label.className = "detail-fact-label"; label.textContent = item.label;
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
          var text = doc.createElement("span"); text.textContent = label;
          el.replaceChildren(icon, text);
          el.setAttribute("aria-label", label);
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
        actions.appendChild(detailAction(movieProgress ? "Resume movie" : "Play movie",
          function () { launchMovie(false); }, "detail-primary", "primary"));
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
        var canonical = core.canonicalEpisodeTarget(core.readHistory(local), state.title.id, state.detail || local, local);
        var recent = canonical ? (canonical.baseEpisode || canonical) : core.lastWatchedEpisode(core.readHistory(local), state.title.id);
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
        if (!recent && state.episodes.length) primary.textContent = "Play S" + state.season + " E" + state.episodes[0].number;
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
      if (pickingDiscoverSeed) {
        pickingDiscoverSeed = false;
        launchDiscoverWithSeed(row, "search");
        return;
      }
      if (focusAction) pendingActionFocus = focusAction;
      detailToken += 1; seasonToken += 1;
      if (episodeTarget && row.type === "tv") pendingEpisodeFocus = { season: episodeTarget.season, episode: episodeTarget.episode };
      state.detailSource = state.view === "history" ? "history" : state.view === "watch" ? "watch" : "search";
      state.detailSourceTab = state.watchTab || "for-you";
      state.title = row; state.detail = null; state.season = null; nextContinue = null;
      state.episodes = [];
      state.subtitle = core.readSubtitlePref(local);
      setView("details");
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
          var changed = false;
          historyRows.forEach(function (h) {
            if (h.type !== row.type || h.id !== row.id) return;
            if (detail.poster && !h.poster) { h.poster = detail.poster; changed = true; }
            if (detail.tvdbId && !h.tvdbId) { h.tvdbId = detail.tvdbId; changed = true; }
          });
          if (changed) local.setItem(core.HISTORY_KEY, JSON.stringify({ version: 2, items: historyRows }));
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
          var latest = core.lastWatchedEpisode(core.readHistory(local), state.title.id);
          var seasons = Array.isArray(detail.seasons) ? detail.seasons : [];
          var browsed = core.readBrowsedSeason(local, state.title.id);
          state.season = episodeTarget && seasons.some(function (entry) { return entry.number === episodeTarget.season; })
            ? episodeTarget.season : browsed !== null && seasons.some(function (entry) { return entry.number === browsed; })
            ? browsed : latest && seasons.some(function (entry) { return entry.number === latest.season; })
              ? latest.season : seasons.length ? seasons[0].number : null;
          renderActions();
          if (episodeTarget || state.view === "episodes") browseEpisodes();
          else if (state.season !== null) loadSeason(state.season);
        }
        saveView();
      }, function () {
        if (disposed || token !== detailToken) return;
        text("detail-status", "More details unavailable; search result information remains visible.");
      });
    }
    function browseEpisodes() {
      if (!state.title || state.title.type !== "tv") return;
      setView("episodes");
      text("episodes-heading", state.title.title + " · Episodes");
      var seasons = state.detail && state.detail.seasons ? state.detail.seasons.slice().sort(function (a, b) {
        return a.number - b.number;
      }) : [];
      var rail = get("seasons"); rail.replaceChildren();
      seasons.forEach(function (entry) {
        var seasonButton = button(entry.name || "Season " + entry.number, function () { loadSeason(entry.number, true); },
          state.season === entry.number ? "is-current" : "");
        seasonButton.dataset.season = String(entry.number); rail.appendChild(seasonButton);
      });
      if (!seasons.length) text("episode-status", state.detail
        ? "No season metadata available. Return to Details and retry."
        : "Loading season metadata…");
      else {
        var latest = core.lastWatchedEpisode(core.readHistory(local), state.title.id);
        var browsed = core.readBrowsedSeason(local, state.title.id);
        var chosen = pendingEpisodeFocus && seasons.some(function (s) { return s.number === pendingEpisodeFocus.season; })
          ? pendingEpisodeFocus.season : browsed !== null && seasons.some(function (s) { return s.number === browsed; }) ? browsed
          : state.season !== null && seasons.some(function (s) { return s.number === state.season; }) ? state.season
            : latest && seasons.some(function (s) { return s.number === latest.season; }) ? latest.season : seasons[0].number;
        if (pendingEpisodeFocus && pendingEpisodeFocus.season !== chosen) pendingEpisodeFocus = null;
        loadSeason(chosen);
        var currentSeason = rail.querySelector(".is-current"), firstSeason = rail.querySelector("button");
        if (currentSeason && firstSeason) rail.scrollLeft = Math.max(0, currentSeason.offsetLeft - firstSeason.offsetLeft);
      }
      focus(get("episodes-back")); saveView();
    }
    function loadSeason(number, remember) {
      if (!state.title || !state.detail || !state.detail.seasons.some(function (s) { return s.number === number; })) return;
      if (state.season !== number) get("episode-list").scrollTop = 0;
      state.season = number; var token = ++seasonToken;
      if (remember) core.writeBrowsedSeason(local, state.title.id, number);
      get("seasons").querySelectorAll("button").forEach(function (button) {
        button.classList.toggle("is-current", Number(button.dataset.season) === number);
      });
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
        if (doc.activeElement === get("details-back") && primary && !primary.disabled) focus(primary);
        if (pendingEpisodeFocus && pendingEpisodeFocus.season === number) {
          var selected = Array.from(list.querySelectorAll(".episode-play")).find(function (card) {
            return card.dataset.episode === String(pendingEpisodeFocus.episode);
          });
          pendingEpisodeFocus = null;
          if (selected) focus(selected);
        }
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
      var heading = doc.createElement("strong");
      heading.textContent = "E" + ep.number + " · " + ep.title;
      var subtitle = doc.createElement("small");
      subtitle.textContent = ep.date || "Air date unknown";
      card.appendChild(artwork); card.appendChild(heading); card.appendChild(subtitle);
      card.setAttribute("aria-label", "Season " + seasonNumber + ", episode " + ep.number + ": " + ep.title);
      updateEpisodeProgress(card, core.readHistory(local));
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
    function buildKeyboard() {
      var host = get("keyboard-keys");
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890".split("").forEach(function (char) {
        host.appendChild(button(char, function () {
          query.value += char.toLowerCase(); state.query = query.value; scheduleSearch(300);
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
      var current = doc.activeElement, rect = current && current.getBoundingClientRect();
      if (!rect) { focus(query); return; }
      var railButtons = [get("search-toggle"), get("watch-toggle"), get("tv-toggle"), get("movies-toggle"), get("discover-toggle"), get("history-toggle"), get("settings-toggle")];
      var railPosition = railButtons.indexOf(current);
      if (railPosition >= 0 && (key === "ArrowDown" || key === "ArrowUp")) {
        focus(railButtons[Math.max(0, Math.min(railButtons.length - 1,
          railPosition + (key === "ArrowDown" ? 1 : -1)))]); return;
      }
      if (state.view === "settings") {
        var settingsButtons = Array.from(get("settings-view").querySelectorAll("[data-focus]"));
        var settingsIndex = settingsButtons.indexOf(current);
        if (railPosition >= 0 && key === "ArrowRight") focus(settingsButtons[0]);
        else if (settingsIndex >= 0) {
          if (key === "ArrowDown" || key === "ArrowRight") focus(settingsButtons[Math.min(settingsButtons.length - 1, settingsIndex + 1)]);
          else if (key === "ArrowUp") focus(settingsButtons[Math.max(0, settingsIndex - 1)]);
          else if (key === "ArrowLeft") focus(get("settings-toggle"));
        }
        return;
      }
      if (state.view === "watch") {
        var watchRows = currentTabRowOrder().map(homeRowButtons);
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
        var groupIndex = watchRows.findIndex(function (row) { return row.indexOf(current) >= 0; });
        var group = groupIndex >= 0 ? watchRows[groupIndex] : null;
        if (group) {
          var groupName = currentTabRowOrder()[groupIndex];
          var index = group.indexOf(current);
          var down = adjacentHomeRow(watchRows, groupIndex, 1);
          var up = adjacentHomeRow(watchRows, groupIndex, -1);
          if (rowCycleIndex[groupName] === undefined) {
            rowCycleIndex[groupName] = Math.max(0, index);
          }
          if (key === "ArrowLeft") {
            if (rowCycleIndex[groupName] <= 0) {
              focus(get("watch-toggle"));
            } else {
              rowCycleIndex[groupName] -= 1;
              focus(group[circularIndex(index, group.length, -1)], true, -1);
            }
          } else if (key === "ArrowRight") {
            if (index === group.length - 1) rowCycleIndex[groupName] = 0;
            else rowCycleIndex[groupName] += 1;
            focus(group[circularIndex(index, group.length, 1)], true, 1);
          } else if (key === "ArrowDown") {
            if (down) { var downGroup = currentTabRowOrder()[watchRows.indexOf(down)];
              focus(resolveHomeSelection(homeRowMemory[downGroup]) || down[0]); }
          } else if (key === "ArrowUp") {
            var upGroup = currentTabRowOrder()[watchRows.indexOf(up)];
            if (up) {
              focus(resolveHomeSelection(homeRowMemory[upGroup]) || up[0]);
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
      if (state.view === "details") {
        var actions = Array.from(get("detail-actions").querySelectorAll("button")).filter(function (item) {
          return !item.disabled;
        });
        var actionIndex = actions.indexOf(current), credits = get("details-view").querySelector(".detail-credits a");
        var railToggle = state.detailSource === "watch"
          ? (state.detailSourceTab === "tv" ? get("tv-toggle") : state.detailSourceTab === "movies" ? get("movies-toggle") : state.detailSourceTab === "discover" ? get("discover-toggle") : get("watch-toggle"))
          : state.detailSource === "history" ? get("history-toggle") : get("search-toggle");
        if (current === get("details-back")) {
          if (key === "ArrowDown") focus(actions[0] || credits);
          else if (key === "ArrowLeft") focus(railToggle);
          return;
        }
        if (actionIndex >= 0) {
          if (key === "ArrowUp") focus(get("details-back"));
          else if (key === "ArrowLeft") focus(actions[actionIndex - 1] || railToggle);
          else if (key === "ArrowRight") focus(actions[actionIndex + 1]);
          else if (key === "ArrowDown") focus(credits);
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
      if (state.view === "episodes") {
        var seasonButtons = Array.from(get("seasons").querySelectorAll("button"));
        var plays = Array.from(get("episode-list").querySelectorAll(".episode-play"));
        var seasonIndex = seasonButtons.indexOf(current), playIndex = plays.indexOf(current);
        var offset = key === "ArrowRight" ? 1 : -1;
        var columns = plays.filter(function (item) {
          return plays.length && Math.abs(item.getBoundingClientRect().top - plays[0].getBoundingClientRect().top) < 2;
        }).length || 3;
        var railToggle = state.detailSource === "watch"
          ? (state.detailSourceTab === "tv" ? get("tv-toggle") : state.detailSourceTab === "movies" ? get("movies-toggle") : state.detailSourceTab === "discover" ? get("discover-toggle") : get("watch-toggle"))
          : state.detailSource === "history" ? get("history-toggle") : get("search-toggle");
        if (current === get("episodes-back")) {
          if (key === "ArrowDown") focus(seasonButtons.find(function (item) {
            return item.classList.contains("is-current");
          }) || seasonButtons[0] || plays[0]);
          else if (key === "ArrowLeft") focus(railToggle);
          return;
        }
        if (seasonIndex >= 0) {
          if (key === "ArrowDown") focus(plays[0]);
          else if (key === "ArrowUp") focus(get("episodes-back"));
          else focus(seasonButtons[Math.max(0, Math.min(seasonButtons.length - 1, seasonIndex + offset))]);
          return;
        }
        if (playIndex >= 0) {
          if (key === "ArrowUp") focus(playIndex >= columns ? plays[playIndex - columns]
            : seasonButtons.find(function (item) { return item.classList.contains("is-current"); }) || seasonButtons[0]);
          else if (key === "ArrowDown") {
            var nextRow = Math.floor(playIndex / columns) + 1;
            if (nextRow * columns < plays.length) focus(plays[Math.min(nextRow * columns + playIndex % columns, plays.length - 1)]);
          } else {
            var rowStart = Math.floor(playIndex / columns) * columns;
            focus(plays[Math.max(rowStart, Math.min(plays.length - 1, rowStart + columns - 1, playIndex + offset))]);
          }
          return;
        }
        if (current.closest(".watch-rail") && key === "ArrowRight") {
          focus(get("episodes-back")); return;
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
    function onKey(event) {
      if (disposed || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      var key = keyName(event);
      if (watchPerformance && watchPerformance.handle(key, state.view, doc.activeElement)) {
        event.preventDefault(); return;
      }
      if (watchPerformance && key.indexOf("Arrow") === 0) watchPerformance.input();
      var editing = doc.activeElement === query || !!(doc.activeElement && doc.activeElement.isContentEditable);
      if (nativeEditingKey(event, editing, finePointer)) return;
      if (finePointer && event.key === "Backspace" && !editing) return;
      if (key === "Back") {
        event.preventDefault(); if (event.repeat) return;
        if (activeFilterMenuType) {
          closeFilterMenu();
          return;
        }
        if (state.view === "history") returnWithinWatch(leaveHistory);
        else if (state.view === "settings") returnWithinWatch(function () { showWatch(); });
        else if (state.view === "episodes") returnWithinWatch(backToDetails);
        else if (state.view === "details") returnWithinWatch(backToResults);
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
    get("history-back").addEventListener("click", function () { returnWithinWatch(leaveHistory); });
    get("history-clear").addEventListener("click", function () {
      if (!clearPending) { clearPending = true; this.textContent = "Confirm clear history"; return; }
      core.clearHistory(local); clearPending = false; this.textContent = "Clear History";
      renderHistory(); syncStartedMarks(); focus(this);
    });
    get("details-back").addEventListener("click", function () { returnWithinWatch(backToResults); });
    get("episodes-back").addEventListener("click", function () { returnWithinWatch(backToDetails); });
    ["seed", "mode", "media", "finished", "genre", "length", "rating", "year", "sort"].forEach(function (t) {
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
        var railActions = Array.from(doc.querySelectorAll(".watch-rail .rail-action"));
        railActions.forEach(function (action) {
          action.classList.remove("rail-neighbor-before", "rail-neighbor-after");
        });
        var railIndex = railActions.indexOf(event.target);
        if (railIndex > 0) railActions[railIndex - 1].classList.add("rail-neighbor-before");
        if (railIndex >= 0 && railIndex < railActions.length - 1)
          railActions[railIndex + 1].classList.add("rail-neighbor-after");
        if (state.view === "watch" && event.target.homeEntry) showHomeHero(event.target.homeEntry);
      }
    });
    get("watch-rows-scroll").addEventListener("scroll", function () {
      get("watch-view").classList.toggle("has-row-scroll", get("watch-rows-scroll").scrollTop > 1);
      if (state.view === "watch" && doc.activeElement.dataset.homeGroup)
        syncActiveHomeHeading(doc.activeElement, true);
    });
    clock.addEventListener("resize", function () {
      homeWindowSizes = Object.create(null);
      if (state.view === "watch" && doc.activeElement && doc.activeElement.dataset.homeGroup) {
        revealHomeWindow(doc.activeElement);
        revealHomeSection(doc.activeElement);
        syncActiveHomeHeading(doc.activeElement, true);
      }
    });
    doc.addEventListener("focusout", function (event) {
      if (event.target && event.target.classList) event.target.classList.remove("is-focused");
    });
    doc.addEventListener("keydown", onKey);
    if (finePointer && root.history && root.history.replaceState && clock.addEventListener) {
      clock.addEventListener("popstate", restoreBrowserView);
    }
    clock.addEventListener("pagehide", function () { disposed = true; if (searchTimer !== null) clock.clearTimeout(searchTimer);
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
    adjacentHomeRow: adjacentHomeRow, circularIndex: circularIndex };
  if (typeof document !== "undefined") createApp(document, location, root);
})(typeof window !== "undefined" ? window : globalThis);
