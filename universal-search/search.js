(function (root) {
  "use strict";
  function nativeEditingKey(event, editing, finePointer) {
    return editing && (event.key === "Delete" || finePointer && event.key === "Backspace"
      || finePointer && (event.key === "ArrowLeft" || event.key === "ArrowRight"
        || event.key === "ArrowUp" || event.key === "ArrowDown"));
  }
  function createApp(doc, nav, clock, options) {
    options = options || {};
    var core = root.HorizonSearchCore;
    var player = root.HorizonSearchPlayer;
    var mock = root.HorizonSearchMock;
    var useMock = options.mock === true || ((nav.hostname === "localhost" || nav.hostname === "127.0.0.1")
      && new URLSearchParams(nav.search).get("mock") === "1");
    var local = options.localStorage;
    var session = options.sessionStorage;
    try { if (!local) local = root.localStorage; } catch (_error) { local = null; }
    try { if (!session) session = root.sessionStorage; } catch (_error) { session = null; }
    function safeStorage(backing) { var values = {};
      return { getItem: function (key) { if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
          try { return backing ? backing.getItem(key) : null; } catch (_error) { return null; } },
        setItem: function (key, value) { values[key] = String(value);
          try { if (backing) backing.setItem(key, value); } catch (_error) { /* Keep session copy. */ } } }; }
    local = safeStorage(local);
    session = safeStorage(session);
    if (useMock && new URLSearchParams(nav.search).get("from") === "home-local") {
      session.setItem("horizon-search-local-home", "1");
    }
    var get = function (id) { return doc.getElementById(id); };
    var query = get("query"), results = get("results");
    var state = { view: "search", previousView: "search", detailSource: "search", filter: "all", query: "", title: null, detail: null,
      season: null, episodes: [], subtitle: core.readSubtitlePref(local), continueMode: false };
    var finePointer = !!(clock.matchMedia && clock.matchMedia("(pointer: fine)").matches)
      && !/Vizio|SmartCast/i.test(clock.navigator && clock.navigator.userAgent || "");
    var keyboardOpen = !finePointer;
    var historyReady = false, restoringHistory = false, historyBackPending = false, historyDepth = 0;
    var searchTimer = null, searchToken = 0, detailToken = 0, seasonToken = 0, activeAbort = null;
    var cache = new Map(), disposed = false, returningHome = false, pendingEpisodeFocus = null,
      nextContinue = null,
      launchingEpisode = false, clearPending = false;
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
      get("search-toggle").classList.toggle("is-current", state.view !== "history" && !state.continueMode);
      get("continue-toggle").classList.toggle("is-current", state.view !== "history" && state.continueMode);
      get("history-toggle").classList.toggle("is-current", state.view === "history");
    }
    function setView(name) {
      var changed = state.view !== name;
      state.view = name;
      ["search", "details", "episodes", "history"].forEach(function (view) { get(view + "-view").hidden = view !== name; });
      get("keyboard").hidden = name !== "search" || !keyboardOpen;
      get("keyboard-toggle").textContent = keyboardOpen ? "Hide Keyboard" : "Show Keyboard";
      doc.body.classList.toggle("details-active", name === "details");
      doc.body.classList.toggle("episodes-active", name === "episodes");
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
      if (["search", "details", "episodes", "history"].indexOf(target) < 0) return;
      historyDepth = Number.isInteger(event.state.depth) ? event.state.depth : 0;
      restoringHistory = true;
      setView(target);
      restoringHistory = false;
      if (target === "search") focusSelectedResult();
      else if (target === "history") { renderHistory(); focus(get("history-back")); }
      else if (target === "episodes") focus(get("episodes-back"));
      else focus(get("details-back"));
    }
    function revealInScroller(element, scroller, horizontal, inset) {
      if (!scroller) return;
      var item = element.getBoundingClientRect(), bounds = scroller.getBoundingClientRect();
      if (horizontal) {
        if (item.left < bounds.left + inset) scroller.scrollLeft -= bounds.left + inset - item.left;
        else if (item.right > bounds.right - inset) scroller.scrollLeft += item.right - bounds.right + inset;
      } else {
        if (item.top < bounds.top + inset) scroller.scrollTop -= bounds.top + inset - item.top;
        else if (item.bottom > bounds.bottom - inset) scroller.scrollTop += item.bottom - bounds.bottom + inset;
      }
    }
    function focus(element) { if (element) {
      var previous = doc.querySelector("[data-focus].is-focused");
      if (previous && previous !== element) previous.classList.remove("is-focused");
      element.focus({ preventScroll: true }); element.classList.add("is-focused");
      var seasonStrip = element.closest("#seasons");
      var episodeScroll = element.closest("#episode-list");
      var resultScroll = element.closest("#results, #history-list");
      if (seasonStrip) revealInScroller(element, seasonStrip, true, 14);
      else if (episodeScroll) revealInScroller(element, episodeScroll, false, 18);
      else if (resultScroll) revealInScroller(element, resultScroll, false, 18);
    } }
    function button(label, click, className) {
      var el = doc.createElement("button"); el.type = "button"; el.textContent = label;
      el.dataset.focus = "1"; if (className) el.className = className;
      el.addEventListener("click", click); return el;
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
      function fallback() { art.replaceChildren();
        var label = doc.createElement("span"); label.className = "art-fallback"; label.textContent = row.title;
        art.appendChild(label);
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
      var snapshot = { version: 2, items: core.homeRows(core.readHistory(local)) };
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
      focus(get("continue-toggle"));
    }
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
      setView(state.previousView === "details" || state.previousView === "episodes" ? state.previousView : "search");
      focus(state.view === "episodes" ? get("episodes-back") : state.view === "details" ? get("details-back") : query);
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
    function resolveNextContinue(recent) {
      if (!state.detail || !Array.isArray(state.detail.seasons)) return;
      var key = recent.id + ":" + recent.season + ":" + recent.episode + ":"
        + (recent.progress && recent.progress.updatedAt || recent.at);
      if (nextContinue && nextContinue.key === key) return;
      var token = detailToken;
      nextContinue = { key: key, status: "pending", target: null };
      var seasons = state.detail.seasons.slice().sort(function (a, b) { return a.number - b.number; });
      if (!seasons.some(function (row) { return row.number === recent.season; })) {
        nextContinue.status = "unavailable"; return;
      }
      api("/api/season/tv/" + recent.id + "/" + recent.season).then(function (value) {
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
      }).then(function (target) {
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
      var focusedClass = actions.contains(doc.activeElement) && doc.activeElement.classList.contains("detail-secondary")
        ? "detail-secondary" : actions.contains(doc.activeElement) ? "detail-primary" : null;
      actions.replaceChildren();
      if (state.title.type === "movie") {
        var movieHistory = core.readHistory(local).find(function (row) {
          return row.type === "movie" && row.id === state.title.id;
        });
        var movieProgress = movieHistory && movieHistory.progress && !movieHistory.progress.completed
          ? movieHistory.progress : null;
        actions.appendChild(button(movieProgress ? "Resume movie" : "Play movie",
          function () { launchMovie(false); }, "detail-primary"));
        if (movieProgress) actions.appendChild(button("Start Over", function () { launchMovie(true); }, "detail-secondary"));
        if (focusedClass) focus(actions.querySelector("." + focusedClass) || actions.querySelector(".detail-primary"));
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
        var primary = button(resumable ? "Resume S" + recent.season + " E" + recent.episode
          : next ? "Continue S" + next.season + " E" + next.episode
            : noNext ? "Episodes" : completed ? "Checking next episode…"
              : recent ? "Continue S" + recent.season + " E" + recent.episode : "Start watching",
          function () {
            if (next) launchEpisode(next.season, next.episode, false, next.title);
            else if (noNext) browseEpisodes();
            else if (recent && !completed) launchEpisode(recent.season, recent.episode, false);
            else if (state.season && state.episodes.length) launchEpisode(state.season, state.episodes[0].number);
          }, "detail-primary");
        primary.disabled = completed && !next && !noNext || !recent && !state.episodes.length;
        primary.setAttribute("aria-label", resumable ? "Resume Season " + recent.season + ", Episode " + recent.episode
          : next ? "Continue with Season " + next.season + ", Episode " + next.episode
          : noNext ? "Choose an episode" : completed ? "Checking for the next episode"
          : recent ? "Continue Season " + recent.season + ", Episode " + recent.episode
          : state.episodes.length ? "Play Season " + state.season + ", Episode " + state.episodes[0].number
            : "Start watching when episode metadata loads");
        if (!recent && state.episodes.length) primary.textContent = "Play S" + state.season + " E" + state.episodes[0].number;
        actions.appendChild(primary);
        if (resumable) actions.appendChild(button("Start Over", function () {
          launchEpisode(recent.season, recent.episode, true);
        }, "detail-secondary"));
        if (!noNext) actions.appendChild(button("Episodes", browseEpisodes, "detail-secondary"));
        if (focusedClass) focus(actions.querySelector("." + focusedClass + ":not(:disabled)")
          || actions.querySelector("button:not(:disabled)"));
      }
    }
    function openDetails(row) {
      detailToken += 1; seasonToken += 1;
      state.detailSource = state.view === "history" ? "history" : "search";
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
          state.season = browsed !== null && seasons.some(function (entry) { return entry.number === browsed; })
            ? browsed : latest && seasons.some(function (entry) { return entry.number === latest.season; })
              ? latest.season : seasons.length ? seasons[0].number : null;
          renderActions();
          if (state.view === "episodes") browseEpisodes();
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
        var chosen = browsed !== null && seasons.some(function (s) { return s.number === browsed; }) ? browsed
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
        else if (state.view === "episodes") returnWithinWatch(backToDetails);
        else if (state.view === "details") returnWithinWatch(backToResults);
        else if (state.view === "search" && state.query) {
          query.value = ""; state.query = ""; scheduleSearch(0); focus(query); saveView();
        } else exitToHome();
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
    get("home-toggle").addEventListener("click", exitToHome);
    get("search-toggle").addEventListener("click", function () {
      state.continueMode = false; setView("search"); scheduleSearch(0); focus(query); saveView();
    });
    get("keyboard-toggle").addEventListener("click", toggleKeyboard);
    get("continue-toggle").addEventListener("click", showContinue);
    get("history-toggle").addEventListener("click", showHistory);
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
      if (event.target && event.target.matches && event.target.matches("[data-focus]")) event.target.classList.add("is-focused");
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
      var saved = session && JSON.parse(session.getItem(core.STATE_KEY));
      var returned = core.returnEpisode(nav.search);
      var returnedMovie = core.returnMovie(nav.search);
      if (returned) {
        var acceptedEpisodeProgress = consumePlaybackHandoff(returned, "tv") ? returned.progress : null;
        core.writeSubtitlePref(local, returned.subtitle);
        pendingEpisodeFocus = { season: returned.season, episode: returned.episode };
        var old = core.readHistory(local || { getItem: function () { return null; } })
          .find(function (row) { return row.type === "tv" && row.id === returned.id; });
        var episodeRow = core.readHistory(local).find(function (row) { return row.type === "tv" && row.id === returned.id
          && row.season === returned.season && row.episode === returned.episode; });
        if (old || acceptedEpisodeProgress) {
          var returnedArtwork = Object.assign({}, old || {}, episodeRow || {});
          returnedArtwork.episodeTitle = episodeRow && episodeRow.episodeTitle || returned.episodeTitle || "";
          returnedArtwork.progress = acceptedEpisodeProgress || episodeRow && episodeRow.progress || null;
          core.writeHistory(local, core.item("tv", returned.id,
            old && old.title || "TV Show", returned.season, returned.episode,
            returned.subtitle, Date.now(), returnedArtwork));
        }
      }
      if (saved && saved.version === 1 && ["all", "movie", "tv"].indexOf(saved.filter) >= 0) {
        state.detailSource = saved.source === "history" ? "history" : "search";
        state.filter = saved.filter; state.query = String(saved.query || "").slice(0, 80); query.value = state.query;
        doc.querySelectorAll("[data-filter]").forEach(function (b) { b.classList.toggle("is-current", b.dataset.filter === state.filter); });
        if (state.query.length >= 2) scheduleSearch(0);
      }
      if (returned) {
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
      if (returnedMovie) {
        var acceptedMovieProgress = consumePlaybackHandoff(returnedMovie, "movie") ? returnedMovie.progress : null;
        api("/api/title/movie/" + returnedMovie.id).then(function (value) {
          var existingMovie = core.readHistory(local).find(function (row) { return row.type === "movie"
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
    setView("search"); focus(query);
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
  root.HorizonUniversalSearch = { createApp: createApp, nativeEditingKey: nativeEditingKey };
  if (typeof document !== "undefined") createApp(document, location, root);
})(typeof window !== "undefined" ? window : globalThis);
