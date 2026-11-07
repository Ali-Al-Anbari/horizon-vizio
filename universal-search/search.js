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
    var query = get("query"), results = get("results");
    var state = { view: "watch", previousView: "watch", detailSource: "watch", filter: "all", query: "", title: null, detail: null,
      season: null, episodes: [], subtitle: core.readSubtitlePref(local), continueMode: false };
    var finePointer = !!(clock.matchMedia && clock.matchMedia("(pointer: fine)").matches)
      && !/Vizio|SmartCast/i.test(clock.navigator && clock.navigator.userAgent || "");
    var keyboardOpen = !finePointer;
    var historyReady = false, restoringHistory = false, historyBackPending = false, historyDepth = 0;
    var searchTimer = null, searchToken = 0, detailToken = 0, seasonToken = 0, activeAbort = null;
    var cache = new Map(), disposed = false, returningHome = false, pendingEpisodeFocus = null,
      nextContinue = null, homeHeroEntry = null, homeDefaultEntry = null, homeHeroToken = 0,
      homeOpenPending = false, homeOpenToken = 0, homeReturnFocus = null, homeDetailCache = new Map(),
      launchingEpisode = false, clearPending = false;
    var homeRowMemory = Object.create(null), homeLastContent = null;
    var homeCards = Object.create(null), homeWindowSizes = Object.create(null);
    var homeScrollFrame = 0, homeHeroTimer = 0;
    var catalogRequests = Object.create(null);
    var homeRowOrder = ["continue", "top", "because", "recent"];
    var recommendationPayload = null, recommendationLoadedSignature = "", recommendationPending = null,
      recommendationWantedSignature = "", recommendationRows = { top: [], because: [], seed: null };
    var previewRows = previewHistoryMode ? mock.previewHistory(previewScenario) : null;
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
      get("watch-toggle").classList.toggle("is-current", state.view === "watch"
        || (state.view === "details" || state.view === "episodes") && state.detailSource === "watch");
      get("search-toggle").classList.toggle("is-current", state.view === "search" && !state.continueMode
        || (state.view === "details" || state.view === "episodes") && state.detailSource === "search");
      get("history-toggle").classList.toggle("is-current", state.view === "history"
        || (state.view === "details" || state.view === "episodes") && state.detailSource === "history");
      get("settings-toggle").classList.toggle("is-current", state.view === "settings");
    }
    function setView(name) {
      var changed = state.view !== name;
      if (changed && state.view === "watch") {
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
    function focus(element, skipHomeVertical) { if (element) {
      var previous = doc.querySelector("[data-focus].is-focused");
      var previousHomeGroup = previous && previous.dataset.homeGroup || "";
      if (previous && previous !== element) previous.classList.remove("is-focused");
      if (element.dataset.homeGroup) revealHomeWindow(element);
      element.focus({ preventScroll: true }); element.classList.add("is-focused");
      var seasonStrip = element.closest("#seasons");
      var episodeScroll = element.closest("#episode-list");
      var resultScroll = element.closest("#results, #history-list, #settings-view");
      var homeScroll = element.closest("#watch-continue-row, #watch-recent-row, #watch-top-row, #watch-because-row");
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
    function poster(path, kind) {
      var url = core.imageUrl(path, kind);
      if (!url) return null;
      var img = doc.createElement("img"); img.src = url; img.loading = "lazy"; img.alt = "";
      return img;
    }
    function landscapeArt(row) {
      var art = doc.createElement("span"); art.className = "poster-art";
      function fallback() { Array.from(art.querySelectorAll("img, .art-fallback")).forEach(function (node) { node.remove(); });
        var label = doc.createElement("span"); label.className = "art-fallback"; label.textContent = row.title;
        art.insertBefore(label, art.firstChild);
      }
      var image = poster(row.backdrop || row.poster, row.backdrop ? "backdrop" : "poster");
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
    function verticalPosterArt(row) {
      var art = doc.createElement("span"); art.className = "poster-art is-vertical-poster";
      function fallback() { art.replaceChildren(); art.classList.remove("is-loaded");
        var label = doc.createElement("span"); label.className = "art-fallback"; label.textContent = row.title;
        art.appendChild(label);
      }
      var posterPath = row.poster || row.backdrop;
      var image = poster(posterPath, row.poster ? "poster" : "backdrop");
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
    function revealHomeWindow(element) {
      var group = element.dataset.homeGroup, cards = homeCards[group];
      if (!cards || !cards.length) return;
      var row = get("watch-" + group + "-row"), track = row.querySelector(".watch-home-track");
      var count = homeWindowSizes[group];
      if (!count) {
        var first = track.querySelector(".home-card") || cards[0];
        var width = first.offsetWidth || 280;
        count = homeWindowSizes[group] = Math.min(cards.length,
          Math.max(3, Math.ceil(row.clientWidth / width) + 2));
      }
      if (cards.length <= count) {
        if (track.childElementCount !== cards.length) track.replaceChildren.apply(track, cards);
        return;
      }
      var attached = Array.from(track.children), position = attached.indexOf(element);
      if (position > 0 && position < attached.length - 1 && attached.length === count) return;
      var index = cards.indexOf(element), selected = [];
      var start = index === 0 ? 0 : index - 1;
      for (var i = 0; i < count; i++) selected.push(cards[(start + i) % cards.length]);
      track.replaceChildren.apply(track, selected);
      row.scrollLeft = 0;
    }
    function resolveHomeSelection(saved) {
      if (!saved || homeRowOrder.indexOf(saved.group) < 0) return null;
      var cards = homeRowButtons(saved.group);
      return cards.find(function (card) { return card.dataset.homeKey === saved.key; })
        || cards[Math.max(0, Math.min(Number.isInteger(saved.index) ? saved.index : 0, cards.length - 1))] || null;
    }
    function firstHomeButton() {
      for (var i = 0; i < homeRowOrder.length; i++) {
        var first = homeRowButtons(homeRowOrder[i])[0]; if (first) return first;
      }
      return null;
    }
    function nearestHomeButton(group) {
      var index = homeRowOrder.indexOf(group);
      if (index < 0) return firstHomeButton();
      for (var distance = 1; distance < homeRowOrder.length; distance++) {
        var next = homeRowOrder[index + distance], previous = homeRowOrder[index - distance];
        if (next && homeRowButtons(next).length) return homeRowButtons(next)[0];
        if (previous && homeRowButtons(previous).length) return homeRowButtons(previous)[0];
      }
      return null;
    }
    function focusHomeTarget() {
      var target = resolveHomeSelection(homeReturnFocus);
      focus(target || get("watch-toggle"));
    }
    function homeContext(row) {
      return (row.type === "tv" ? "S" + row.season + " E" + row.episode
        + (row.episodeTitle ? " · " + row.episodeTitle : "") : "Movie");
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
        image.addEventListener("error", function () { tryPath(index + 1); });
        image.addEventListener("load", function () {
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
        return detail ? lookupNextEpisode(row, detail) : null;
      }).then(function (target) { if (token === homeOpenToken) openEpisode(target); },
        function () { if (token === homeOpenToken) openEpisode(null); });
    }
    function paintHomepage(continueRows, finishedRows) {
      var previous = homeFocusIdentity(doc.activeElement);
      homeDefaultEntry = continueRows[0] ? { row: continueRows[0], group: "continue" }
        : finishedRows[0] ? { row: finishedRows[0], group: "recent" } : null;
      function rowCard(entry, group, action) {
        var row = entry.row, card = button("", action, "home-card");
        card.dataset.homeGroup = group; card.dataset.homeKey = row.type + ":" + row.id;
        card.homeEntry = entry;
        var artwork = group === "continue" ? landscapeArt(row) : verticalPosterArt(row),
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
      var continueRow = get("watch-continue-row").querySelector(".watch-home-track");
      var recentRow = get("watch-recent-row").querySelector(".watch-home-track");
      continueRow.replaceChildren(); recentRow.replaceChildren();
      continueRows.slice(0, 8).forEach(function (row) {
        var entry = { row: row, group: "continue" };
        continueRow.appendChild(rowCard(entry, "continue", function () { openHomeEntry(entry); }));
      });
      finishedRows.slice(0, 8).forEach(function (row) {
        var entry = { row: row, group: "recent" };
        recentRow.appendChild(rowCard(entry, "recent", function () { openHomeEntry(entry); }));
      });
      recordHomeCards("continue"); recordHomeCards("recent");
      get("watch-continue-section").hidden = !continueRows.length;
      get("watch-recent-section").hidden = !finishedRows.length;
      updateHomeSections();
      if (previous && previous.group) { homeReturnFocus = previous; focusHomeTarget(); }
      else showHomeHero(homeDefaultEntry);
    }
    function updateHomeSections() {
      var ids = homeRowOrder.map(function (group) { return "watch-" + group + "-section"; });
      var first = false;
      ids.forEach(function (id) { var section = get(id);
        section.classList.toggle("is-first-visible", !section.hidden && !first);
        if (!section.hidden) first = true;
      });
      get("watch-view").classList.toggle("is-empty", !first);
    }
    function paintRecommendationRows(rows) {
      recommendationRows = rows;
      var active = homeFocusIdentity(doc.activeElement), activeGroup = active && active.group;
      var activeRow = activeGroup === "top" || activeGroup === "because";
      var anchor = state.view === "watch" && !activeRow && active && active.group
        ? doc.activeElement : null;
      var anchorY = anchor ? anchor.getBoundingClientRect().top : 0;
      [["top", rows.top], ["because", rows.because]].forEach(function (pair) {
        var group = pair[0], host = get("watch-" + group + "-row").querySelector(".watch-home-track");
        host.replaceChildren();
        pair[1].forEach(function (candidate) {
          var card = button("", function () { openDetails(candidate); },
            "home-card home-card-poster");
          card.dataset.homeGroup = group; card.dataset.homeKey = candidate.type + ":" + candidate.id;
          card.homeEntry = { row: candidate, group: group };
          var title = doc.createElement("strong"); title.textContent = candidate.title;
          card.appendChild(verticalPosterArt(candidate)); card.appendChild(title);
          card.setAttribute("aria-label", candidate.title + ", " + (candidate.type === "tv" ? "TV series" : "movie"));
          card.addEventListener("mouseenter", function () {
            if (state.view === "watch") showHomeHero(card.homeEntry);
          });
          host.appendChild(card);
        });
        recordHomeCards(group);
      });
      get("watch-top-section").hidden = !rows.top.length;
      get("watch-because-section").hidden = !rows.because.length;
      if (rows.seed) text("watch-because-heading", "Because You "
        + (rows.seed.liked ? "Liked " : "Watched ") + rows.seed.title);
      if (doc.activeElement.closest("#watch-because-section")) syncActiveHomeHeading(doc.activeElement);
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
    function refreshRecommendations() {
      if (!recommendations || disposed) return;
      var rows = previewRows || core.readHistory(local), feedback = recommendations.readFeedback(local);
      var signature = recommendationSignature(rows, feedback);
      recommendationWantedSignature = signature;
      if (recommendationLoadedSignature === signature) return;
      if (recommendationPayload) paintRecommendationRows(recommendations.selectRows(rows, feedback, recommendationPayload));
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
        paintRecommendationRows(recommendations.selectRows(rows, feedback, bundle.payload));
      }, function () {
        if (!disposed && recommendationWantedSignature === signature)
          paintRecommendationRows({ top: [], because: [], seed: null });
      }).finally(function () {
        if (recommendationPending === task) recommendationPending = null;
        if (!disposed && recommendationWantedSignature !== signature) refreshRecommendations();
      });
    }
    function renderHomepage() {
      var rows = previewRows || core.readHistory(local);
      paintHomepage(core.homepageContinueCandidates(rows, local).filter(function (row) {
        return !core.isContinueHidden(local, row);
      }), core.homepageFinished(rows, local));
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
      if (state.detailSource === "watch") { showWatch(); return; }
      if (state.detailSource === "history") {
        state.detailSource = "search"; setView("history"); renderHistory(); focus(get("history-back")); return;
      }
      setView("search"); focusSelectedResult(); saveView();
    }
    function backToDetails() { setView("details"); focus(get("details-back")); saveView(); }
    function exitToHome() {
      if (returningHome) return;
      returningHome = true;
      saveView();
      var localHome = useMock && session.getItem("horizon-search-local-home") === "1";
      var currentRows = core.readHistory(local);
      var snapshot = { version: 3, updatedAt: Date.now(), items: core.homepageContinueCandidates(currentRows)
        .filter(function (row) { return !core.isContinueHidden(local, row); }).slice(0, 6) };
      var homeUrl = localHome ? "/frontend/index.html?return=search" : core.LAUNCHER_ORIGIN + "/?return=search";
      nav.replace(homeUrl + "#watch=" + encodeURIComponent(JSON.stringify(snapshot)));
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
      var rows = core.readHistory(local), visible = core.homepageContinueCandidates(rows);
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
      var focusedAction = actions.contains(doc.activeElement) ? doc.activeElement.dataset.action : null;
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
        function add(stateValue, label) {
          var el = detailAction(label, function () {
            var current = feedback.readFeedback(local).ratings[type + ":" + id] || "neutral";
            if (feedback.setFeedback(local, type, id, current === stateValue ? "neutral" : stateValue)) {
              syncFeedback(); refreshRecommendations();
            }
          }, "detail-secondary detail-feedback", stateValue);
          el.dataset.feedback = stateValue;
          var icon = doc.createElement("span"); icon.className = "detail-feedback-icon";
          icon.setAttribute("aria-hidden", "true");
          icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v10H4a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2h3Zm0 0 5-7a2 2 0 0 1 2-1c1.1 0 1.8.9 1.6 2L15 8h5a2 2 0 0 1 2 2l-1.2 8a2 2 0 0 1-2 2H7"/></svg>';
          var text = doc.createElement("span"); text.textContent = label;
          el.replaceChildren(icon, text);
          actions.appendChild(el);
        }
        add("liked", "Like"); add("disliked", "Dislike");
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
        appendFeedbackActions();
        restoreActionFocus();
        return;
      }
      if (state.title.type === "tv") {
        var recent = core.lastWatchedEpisode(core.readHistory(local), state.title.id);
        var resumable = recent && recent.progress && recent.manualWatched !== true
          && (!recent.progress.completed || recent.manualWatched === false)
          ? recent.progress : null;
        var completed = recent && (recent.manualWatched === true || recent.progress
          && recent.progress.completed && recent.manualWatched !== false);
        if (completed) resolveNextContinue(recent);
        var next = completed && nextContinue && nextContinue.status === "ready" ? nextContinue.target : null;
        var noNext = completed && nextContinue && nextContinue.status === "unavailable";
        var primary = detailAction(resumable ? "Resume S" + recent.season + " E" + recent.episode
          : next ? "Continue S" + next.season + " E" + next.episode
            : noNext ? "Episodes" : completed ? "Checking next episode…"
              : recent ? "Continue S" + recent.season + " E" + recent.episode : "Start watching",
          function () {
            if (next) launchEpisode(next.season, next.episode, false, next.title);
            else if (noNext) browseEpisodes();
            else if (recent && !completed) launchEpisode(recent.season, recent.episode, false);
            else if (state.season && state.episodes.length) launchEpisode(state.season, state.episodes[0].number);
          }, "detail-primary", "primary");
        primary.disabled = completed && !next && !noNext || !recent && !state.episodes.length;
        primary.setAttribute("aria-label", resumable ? "Resume Season " + recent.season + ", Episode " + recent.episode
          : next ? "Continue with Season " + next.season + ", Episode " + next.episode
          : noNext ? "Choose an episode" : completed ? "Checking for the next episode"
          : recent ? "Continue Season " + recent.season + ", Episode " + recent.episode
          : state.episodes.length ? "Play Season " + state.season + ", Episode " + state.episodes[0].number
            : "Start watching when episode metadata loads");
        if (!recent && state.episodes.length) primary.textContent = "Play S" + state.season + " E" + state.episodes[0].number;
        actions.appendChild(primary);
        if (resumable) actions.appendChild(detailAction("Start Over", function () {
          launchEpisode(recent.season, recent.episode, true);
        }, "detail-secondary", "start-over"));
        if (!noNext) actions.appendChild(detailAction("Episodes", browseEpisodes, "detail-secondary", "episodes"));
        appendFeedbackActions();
        restoreActionFocus();
      }
    }
    function openDetails(row, episodeTarget) {
      detailToken += 1; seasonToken += 1;
      if (episodeTarget && row.type === "tv") pendingEpisodeFocus = { season: episodeTarget.season, episode: episodeTarget.episode };
      state.detailSource = state.view === "history" ? "history" : state.view === "watch" ? "watch" : "search";
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
      var initialPrimary = get("detail-actions").querySelector(".detail-primary");
      focus(initialPrimary && !initialPrimary.disabled ? initialPrimary : get("details-back"));
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
      var railOrder = [get("watch-toggle"), get("search-toggle"), get("history-toggle"), get("settings-toggle")];
      var railPosition = railOrder.indexOf(current);
      if (railPosition >= 0 && (key === "ArrowDown" || key === "ArrowUp")) {
        focus(railOrder[Math.max(0, Math.min(railOrder.length - 1,
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
        var watchRows = homeRowOrder.map(homeRowButtons);
        var first = firstHomeButton() || get("search-toggle");
        var rail = [get("watch-toggle"), get("search-toggle"), get("history-toggle"), get("settings-toggle")];
        if (current.closest(".watch-rail")) {
          var railIndex = rail.indexOf(current);
          if (key === "ArrowDown") focus(rail[Math.min(rail.length - 1, railIndex + 1)]);
          else if (key === "ArrowUp") focus(rail[Math.max(0, railIndex - 1)]);
          else if (key === "ArrowRight") focus(resolveHomeSelection(homeLastContent)
            || homeLastContent && nearestHomeButton(homeLastContent.group) || first);
          return;
        }
        var groupIndex = watchRows.findIndex(function (row) { return row.indexOf(current) >= 0; });
        var group = groupIndex >= 0 ? watchRows[groupIndex] : null;
        if (group) {
          var index = group.indexOf(current);
          var down = adjacentHomeRow(watchRows, groupIndex, 1);
          var up = adjacentHomeRow(watchRows, groupIndex, -1);
          if (key === "ArrowLeft") focus(group[circularIndex(index, group.length, -1)], true);
          else if (key === "ArrowRight") focus(group[circularIndex(index, group.length, 1)], true);
          else if (key === "ArrowDown") {
            if (down) { var downGroup = homeRowOrder[watchRows.indexOf(down)];
              focus(resolveHomeSelection(homeRowMemory[downGroup]) || down[0]); }
          } else if (key === "ArrowUp") {
            var upGroup = homeRowOrder[watchRows.indexOf(up)];
            focus(up ? resolveHomeSelection(homeRowMemory[upGroup]) || up[0] : get("watch-toggle"));
          }
          return;
        }
      }
      if (state.view === "details") {
        var actions = Array.from(get("detail-actions").querySelectorAll("button")).filter(function (item) {
          return !item.disabled;
        });
        var actionIndex = actions.indexOf(current), credits = get("details-view").querySelector(".detail-credits a");
        if (current === get("details-back")) {
          if (key === "ArrowDown") focus(actions[0] || credits);
          else if (key === "ArrowLeft") focus(get("search-toggle"));
          return;
        }
        if (actionIndex >= 0) {
          if (key === "ArrowUp") focus(get("details-back"));
          else if (key === "ArrowLeft") focus(actions[actionIndex - 1] || get("search-toggle"));
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
        if (current === get("episodes-back")) {
          if (key === "ArrowDown") focus(seasonButtons.find(function (item) {
            return item.classList.contains("is-current");
          }) || seasonButtons[0] || plays[0]);
          else if (key === "ArrowLeft") focus(get("search-toggle"));
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
        if (key === "ArrowRight" && current.id === "search-toggle") {
          focus(query); return;
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
      var editing = doc.activeElement === query || !!(doc.activeElement && doc.activeElement.isContentEditable);
      if (nativeEditingKey(event, editing, finePointer)) return;
      if (finePointer && event.key === "Backspace" && !editing) return;
      if (key === "Back") {
        event.preventDefault(); if (event.repeat) return;
        if (state.view === "history") returnWithinWatch(leaveHistory);
        else if (state.view === "settings") returnWithinWatch(function () { showWatch(); });
        else if (state.view === "episodes") returnWithinWatch(backToDetails);
        else if (state.view === "details") returnWithinWatch(backToResults);
        else if (state.view === "search" && state.query) {
          query.value = ""; state.query = ""; scheduleSearch(0); focus(query); saveView();
        } else if (state.view === "search") showWatch();
        else exitToHome();
        return;
      }
      if (key === "OK") {
        event.preventDefault(); if (event.repeat) return;
        if (doc.activeElement === query) { if (state.query.trim()) { state.continueMode = false; searchNow(true); } else openKeyboard(); }
        else if (doc.activeElement && doc.activeElement.click) doc.activeElement.click();
        return;
      }
      if (key && key.indexOf("Arrow") === 0) { event.preventDefault(); move(key); return; }
    }
    get("watch-toggle").addEventListener("click", function () { showWatch(true); });
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
        state.title = requested; state.season = requested.season; state.subtitle = core.readSubtitlePref(local);
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
