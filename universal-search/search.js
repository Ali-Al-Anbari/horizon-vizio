(function (root) {
  "use strict";
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
      providers: null, season: null, episodes: [], subtitle: core.readSubtitlePref(local), continueMode: false };
    var searchTimer = null, searchToken = 0, detailToken = 0, seasonToken = 0, activeAbort = null;
    var cache = new Map(), disposed = false, returningHome = false, pendingEpisodeFocus = null,
      launchingEpisode = false, clearPending = false;
    function text(id, value) { get(id).textContent = value; }
    function syncRail() {
      get("search-toggle").classList.toggle("is-current", state.view !== "history" && !state.continueMode);
      get("continue-toggle").classList.toggle("is-current", state.view !== "history" && state.continueMode);
      get("history-toggle").classList.toggle("is-current", state.view === "history");
    }
    function setView(name) {
      state.view = name;
      ["search", "details", "episodes", "history"].forEach(function (view) { get(view + "-view").hidden = view !== name; });
      get("keyboard").hidden = name !== "search";
      doc.body.classList.toggle("details-active", name === "details");
      if (name !== "details") closeSeasonMenu(false);
      syncRail();
    }
    function focus(element) { if (element) {
      var previous = doc.querySelector("[data-focus].is-focused");
      if (previous && previous !== element) previous.classList.remove("is-focused");
      element.focus({ preventScroll: true }); element.classList.add("is-focused");
      if (element.scrollIntoView) element.scrollIntoView({ block: "nearest", inline: "nearest" });
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
          : bits[2] === "providers" ? mock.providers()
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
      rows.forEach(function (row) {
        var card = button("", function () { openDetails(row); }, "poster-card");
        card.dataset.mediaType = row.type;
        card.dataset.mediaId = String(row.id);
        var art = landscapeArt(row);
        var meta = doc.createElement("span"); meta.className = "poster-meta";
        var title = doc.createElement("strong"); title.textContent = row.title;
        var info = doc.createElement("small"); info.textContent = row.resume && row.type === "tv"
          ? "S" + row.resume.season + " E" + row.resume.episode + (row.resume.episodeTitle ? " · " + row.resume.episodeTitle : "")
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
      renderResults(core.homeRows(history).map(function (row) { return { type: row.type, id: row.id, title: row.title,
        date: "", poster: row.poster, backdrop: row.backdrop, resume: row }; }));
      text("search-status", history.length ? "Continue Watching · last selected episode, not playback position"
        : "Nothing in Continue Watching yet.");
      focus(get("continue-toggle"));
    }
    function renderHistory() {
      var list = get("history-list"); list.replaceChildren();
      var rows = core.groupedHistory(core.readHistory(local));
      rows.forEach(function (row) {
        var label = row.title + (row.type === "tv" ? " · S" + row.season + " E" + row.episode
          + (row.episodeTitle ? " · " + row.episodeTitle : "") : "")
          + " · " + new Date(row.at).toLocaleDateString();
        var card = button(label, function () { launchHistory(row); }, "poster-card history-card");
        var art = verticalPosterArt(row);
        var meta = doc.createElement("span"); meta.className = "poster-meta";
        var name = doc.createElement("strong"); name.textContent = row.title;
        var detail = doc.createElement("small");
        detail.textContent = row.type === "tv" ? "S" + row.season + " E" + row.episode : "Movie";
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
        openDetails(row);
        text("detail-status", "Movie playback is not verified in Video Lab. No movie player was opened.");
        return;
      }
      state.detailSource = "history";
      state.title = row; state.season = row.season; state.subtitle = core.readSubtitlePref(local);
      state.episodes = [{ number: row.episode, title: row.episodeTitle }];
      setView("episodes"); launchEpisode(row.season, row.episode);
    }
    function updateProviders(value) {
      state.providers = value;
      var container = get("providers"); container.replaceChildren();
      var link = state.title && core.providerWatchUrl(value && value.link, state.title.type, state.title.id);
      var categoryNames = { stream: "included with subscription", free: "free or ad-supported",
        rent: "available to rent", buy: "available to buy" };
      core.groupProviders(value).forEach(function (provider) {
        var label = provider.name + " · " + provider.availability.map(function (category) {
          return categoryNames[category];
        }).join(", ");
        var icon;
        if (link) {
          icon = button("", function () { saveView(); nav.assign(link); }, "provider-icon");
          icon.setAttribute("aria-label", label + ". Open title availability on TMDB / JustWatch.");
          icon.title = label + " · View title availability";
          icon.dataset.availability = provider.availability.join(",");
        } else {
          icon = doc.createElement("span"); icon.className = "provider-icon provider-informational";
          icon.setAttribute("role", "img"); icon.setAttribute("aria-label", label + ". Informational listing only.");
          icon.title = label;
        }
        if (provider.logo) {
          var logo = doc.createElement("img"); logo.src = core.imageUrl(provider.logo, "provider"); logo.alt = provider.name;
          logo.addEventListener("error", function () {
            icon.classList.add("has-name-fallback");
            icon.replaceChildren(); var name = doc.createElement("span"); name.className = "provider-name-fallback";
            name.textContent = provider.name; icon.appendChild(name);
          }); icon.appendChild(logo);
        } else {
          icon.classList.add("has-name-fallback");
          var fallback = doc.createElement("span"); fallback.className = "provider-name-fallback";
          fallback.textContent = provider.name; icon.appendChild(fallback);
        }
        container.appendChild(icon);
      });
      container.setAttribute("aria-label", container.children.length
        ? "Where to watch. Provider data from TMDB and JustWatch."
        : "No US provider listings returned.");
    }
    function renderActions() {
      var actions = get("detail-actions"); actions.replaceChildren();
      if (state.title.type === "tv") {
        var recent = core.readHistory(local || { getItem: function () { return null; } })
          .find(function (row) { return row.type === "tv" && row.id === state.title.id; });
        var primary = button(recent ? "Continue S" + recent.season + " E" + recent.episode : "Start watching",
          function () {
            if (recent) launchEpisode(recent.season, recent.episode);
            else if (state.season && state.episodes.length) launchEpisode(state.season, state.episodes[0].number);
          }, "detail-primary");
        primary.disabled = !recent && !state.episodes.length;
        primary.setAttribute("aria-label", recent ? "Continue Season " + recent.season + ", Episode " + recent.episode
          : state.episodes.length ? "Play Season " + state.season + ", Episode " + state.episodes[0].number
            : "Start watching when episode metadata loads");
        if (!recent && state.episodes.length) primary.textContent = "Play S" + state.season + " E" + state.episodes[0].number;
        actions.appendChild(primary);
        actions.appendChild(button("Episode List", browseEpisodes, "detail-secondary"));
      }
    }
    function renderDetailSeasons() {
      var menu = get("detail-season-menu"), toggle = get("detail-season-toggle");
      menu.replaceChildren();
      var seasons = state.detail && Array.isArray(state.detail.seasons) ? state.detail.seasons : [];
      toggle.disabled = !seasons.length;
      if (!seasons.length) { toggle.textContent = "Season unavailable"; return; }
      var selected = seasons.find(function (season) { return season.number === state.season; }) || seasons[0];
      toggle.textContent = (selected.name || "Season " + selected.number) + " ▾";
      seasons.forEach(function (season) {
        var option = button(season.name || "Season " + season.number, function () {
          closeSeasonMenu(false); loadSeason(season.number); focus(toggle);
        }, "season-option" + (season.number === selected.number ? " is-current" : ""));
        option.dataset.season = String(season.number); option.setAttribute("role", "option");
        option.setAttribute("aria-selected", season.number === selected.number ? "true" : "false");
        menu.appendChild(option);
      });
    }
    function closeSeasonMenu(restoreFocus) {
      var menu = get("detail-season-menu"), toggle = get("detail-season-toggle");
      if (!menu || menu.hidden) return;
      menu.hidden = true; toggle.setAttribute("aria-expanded", "false");
      if (restoreFocus) focus(toggle);
    }
    function toggleSeasonMenu() {
      var menu = get("detail-season-menu"), toggle = get("detail-season-toggle");
      if (menu.hidden) {
        menu.hidden = false; toggle.setAttribute("aria-expanded", "true");
        var current = menu.querySelector(".is-current"); focus(current || menu.querySelector("button"));
      } else closeSeasonMenu(true);
    }
    function openDetails(row) {
      detailToken += 1; seasonToken += 1;
      state.detailSource = state.view === "history" ? "history" : "search";
      state.title = row; state.detail = null; state.providers = null; state.season = null;
      state.episodes = [];
      state.subtitle = core.readSubtitlePref(local);
      setView("details");
      get("details-view").classList.toggle("is-movie", row.type === "movie");
      get("detail-episode-section").hidden = row.type !== "tv";
      text("detail-kind", row.type === "tv" ? "TV Show" : "Movie");
      text("detail-title", row.title); text("detail-year", row.date ? row.date.slice(0, 4) : "Release date unknown");
      text("detail-summary", row.overview || "No synopsis available.");
      renderDetailArt(row);
      text("detail-status", "Loading details and provider listings…");
      text("detail-episode-status", row.type === "tv" ? "Loading episodes…" : "");
      get("detail-episodes").replaceChildren();
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
        if (Array.isArray(detail.genres) && detail.genres.length) meta.push(detail.genres.slice(0, 3).join(" · "));
        if (row.type === "tv") meta.push(Array.isArray(detail.seasons) && detail.seasons.length
          ? detail.seasons.length + (detail.seasons.length === 1 ? " season" : " seasons") : "TV series");
        else meta.push("Movie");
        text("detail-year", meta.join("  ·  ") || (row.type === "tv" ? "TV Series" : "Movie"));
        text("detail-status", row.type === "movie" ? "Movie playback is not supported by the current Video Lab player." : "");
        if (row.type === "tv") {
          var latest = core.readHistory(local || { getItem: function () { return null; } })
            .find(function (entry) { return entry.type === "tv" && entry.id === state.title.id; });
          var seasons = Array.isArray(detail.seasons) ? detail.seasons : [];
          state.season = latest && seasons.some(function (entry) { return entry.number === latest.season; })
            ? latest.season : seasons.length ? seasons[0].number : null;
          renderDetailSeasons(); renderActions();
          if (state.season) loadSeason(state.season);
          else text("detail-episode-status", "Episode metadata is unavailable.");
        }
        saveView();
      }, function () {
        if (disposed || token !== detailToken) return;
        text("detail-status", "More details unavailable; search result information remains visible.");
      });
      api("/api/providers/" + row.type + "/" + row.id).then(function (value) {
        if (!disposed && token === detailToken) updateProviders(value);
      }, function () {
        if (!disposed && token === detailToken) get("providers").textContent = "Provider listings unavailable. Try again later.";
      });
    }
    function browseEpisodes() {
      if (!state.title || state.title.type !== "tv") return;
      setView("episodes");
      text("episodes-heading", state.title.title + " · Episodes");
      var seasons = state.detail && state.detail.seasons || [];
      var rail = get("seasons"); rail.replaceChildren();
      seasons.forEach(function (entry) {
        rail.appendChild(button(entry.name || "Season " + entry.number, function () { loadSeason(entry.number); },
          state.season === entry.number ? "is-current" : ""));
      });
      if (!seasons.length) text("episode-status", state.detail
        ? "No season metadata available. Return to Details and retry."
        : "Loading season metadata…");
      else {
        var latest = core.readHistory(local || { getItem: function () { return null; } })
          .find(function (row) { return row.type === "tv" && row.id === state.title.id; });
        var chosen = state.season || (latest && seasons.some(function (s) { return s.number === latest.season; })
          ? latest.season : seasons[0].number);
        loadSeason(chosen);
      }
      focus(get("episodes-back")); saveView();
    }
    function loadSeason(number) {
      if (!state.title || !state.detail || !state.detail.seasons.some(function (s) { return s.number === number; })) return;
      state.season = number; var token = ++seasonToken;
      if (!get("details-view").hidden) renderDetailSeasons();
      get("seasons").querySelectorAll("button").forEach(function (button, index) {
        button.classList.toggle("is-current", state.detail.seasons[index].number === number);
      });
      text("episode-status", "Loading Season " + number + "…");
      text("detail-episode-status", "Loading episodes…");
      get("episode-list").replaceChildren();
      get("detail-episodes").replaceChildren();
      api("/api/season/tv/" + state.title.id + "/" + number).then(function (value) {
        if (disposed || token !== seasonToken) return;
        state.episodes = Array.isArray(value.episodes) ? value.episodes : [];
        var list = get("episode-list"), detailList = get("detail-episodes");
        list.replaceChildren(); detailList.replaceChildren();
        state.episodes.forEach(function (ep) {
          list.appendChild(makeEpisodeCard(ep, number, false));
          detailList.appendChild(makeEpisodeCard(ep, number, true));
        });
        text("episode-status", state.episodes.length ? "Select an episode to watch in Horizon."
          : "No aired episodes returned for this season.");
        text("detail-episode-status", state.episodes.length ? "" : "No aired episodes for this season.");
        renderActions();
        var primary = get("detail-actions").querySelector(".detail-primary");
        if (doc.activeElement === get("details-back") && primary && !primary.disabled) focus(primary);
        if (pendingEpisodeFocus && pendingEpisodeFocus.season === number) {
          var selected = Array.from(list.querySelectorAll("button")).find(function (card) {
            return card.dataset.episode === String(pendingEpisodeFocus.episode);
          });
          pendingEpisodeFocus = null;
          if (selected) focus(selected);
        }
      }, function () {
        if (disposed || token !== seasonToken) return;
        text("episode-status", "Episodes unavailable. Select the season to retry.");
        text("detail-episode-status", "Episodes unavailable. Choose the season to retry.");
      });
      saveView();
    }
    function makeEpisodeCard(ep, seasonNumber, compact) {
      var card = button("", function () { launchEpisode(seasonNumber, ep.number); }, compact ? "detail-episode-card" : "");
      card.dataset.season = String(seasonNumber);
      card.dataset.episode = String(ep.number);
      var artwork = doc.createElement("span");
      artwork.className = compact ? "detail-episode-art" : "episode-art";
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
      var heading = doc.createElement(compact ? "span" : "strong");
      heading.className = compact ? "detail-episode-label" : "";
      heading.textContent = "E" + ep.number + " · " + ep.title;
      var subtitle = doc.createElement(compact ? "span" : "small");
      subtitle.className = compact ? "detail-episode-meta" : "";
      subtitle.textContent = compact ? (ep.date || "") : (ep.date || "Air date unknown");
      card.appendChild(artwork); card.appendChild(heading); card.appendChild(subtitle);
      card.setAttribute("aria-label", "Season " + seasonNumber + ", episode " + ep.number + ": " + ep.title);
      if (core.readHistory(local).some(function (row) { return row.type === "tv" && row.id === state.title.id
          && row.season === seasonNumber && row.episode === ep.number; })) addStartedMark(artwork);
      return card;
    }
    function addStartedMark(artwork) {
      if (artwork.querySelector(".episode-started")) return;
      var mark = doc.createElement("span"); mark.className = "episode-started";
      mark.setAttribute("aria-hidden", "true"); artwork.appendChild(mark);
    }
    function syncStartedMarks() {
      var history = core.readHistory(local);
      doc.querySelectorAll("#detail-episodes button, #episode-list button").forEach(function (card) {
        var art = card.querySelector(".detail-episode-art, .episode-art");
        if (!art) return;
        var started = state.title && history.some(function (row) { return row.type === "tv" && row.id === state.title.id
          && row.season === Number(card.dataset.season) && row.episode === Number(card.dataset.episode); });
        if (started) addStartedMark(art);
        else { var mark = art.querySelector(".episode-started"); if (mark) mark.remove(); }
      });
    }
    function launchEpisode(season, episode) {
      if (launchingEpisode || !state.title || state.title.type !== "tv") return;
      var url = player.tvUrl(state.title.id, season, episode, state.subtitle, state.title.title, state.title.tvdbId);
      if (!url) { text("detail-status", "Invalid episode selection."); return; }
      launchingEpisode = true;
      saveView();
      try { nav.assign(url);
        var episodeRow = state.season === season && state.episodes.find(function (row) { return row.number === episode; });
        core.writeHistory(local, core.item("tv", state.title.id, state.title.title, season, episode,
          state.subtitle, Date.now(), { poster: state.title.poster, backdrop: state.title.backdrop,
            episodeTitle: episodeRow && episodeRow.title || state.title.episodeTitle,
            tvdbId: state.title.tvdbId }));
        syncStartedMarks();
      }
      catch (_error) { launchingEpisode = false; text("episode-status", "Player could not open. Select the episode again."); }
    }
    function openKeyboard() { focus(get("keyboard-keys").querySelector("button")); }
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
      var seasonMenu = get("detail-season-menu");
      if (state.view === "details" && seasonMenu && !seasonMenu.hidden) {
        var options = Array.from(seasonMenu.querySelectorAll("button"));
        var optionIndex = options.indexOf(current);
        if (key === "ArrowUp" || key === "ArrowDown") {
          if (optionIndex < 0) optionIndex = 0;
          else optionIndex = Math.max(0, Math.min(options.length - 1, optionIndex + (key === "ArrowDown" ? 1 : -1)));
          if (options.length) focus(options[optionIndex]);
        } else if (key === "ArrowLeft") closeSeasonMenu(true);
        return;
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
      if (disposed) return;
      var key = keyName(event);
      if (event.key === "Backspace" && event.code === "Backspace" && doc.activeElement === query) return;
      if (key === "Back") {
        event.preventDefault(); if (event.repeat) return;
        if (state.view === "details" && !get("detail-season-menu").hidden) closeSeasonMenu(true);
        else if (state.view === "history") leaveHistory();
        else if (state.view === "episodes") backToDetails();
        else if (state.view === "details") backToResults();
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
      if (state.view === "search" && doc.activeElement !== query && key && key.length === 1
          && !event.ctrlKey && !event.metaKey && !event.repeat) {
        event.preventDefault(); query.value += key; state.query = query.value; scheduleSearch(300); focus(query);
      }
    }
    get("home-toggle").addEventListener("click", exitToHome);
    get("search-toggle").addEventListener("click", function () {
      state.continueMode = false; setView("search"); scheduleSearch(0); focus(query); saveView();
    });
    get("keyboard-toggle").addEventListener("click", openKeyboard);
    get("continue-toggle").addEventListener("click", showContinue);
    get("history-toggle").addEventListener("click", showHistory);
    get("history-back").addEventListener("click", leaveHistory);
    get("history-clear").addEventListener("click", function () {
      if (!clearPending) { clearPending = true; this.textContent = "Confirm clear history"; return; }
      core.clearHistory(local); clearPending = false; this.textContent = "Clear History";
      renderHistory(); syncStartedMarks(); focus(this);
    });
    get("details-back").addEventListener("click", backToResults);
    get("episodes-back").addEventListener("click", backToDetails);
    get("detail-season-toggle").addEventListener("click", toggleSeasonMenu);
    query.addEventListener("input", function () { state.query = query.value; scheduleSearch(300); });
    doc.querySelectorAll("[data-filter]").forEach(function (filter) { filter.addEventListener("click", function () {
      state.filter = filter.dataset.filter;
      doc.querySelectorAll("[data-filter]").forEach(function (button) {
        button.classList.toggle("is-current", button === filter);
      }); scheduleSearch(0);
    }); });
    buildKeyboard();
    doc.addEventListener("focusin", function (event) {
      if (event.target && event.target.matches && event.target.matches("[data-focus]")) event.target.classList.add("is-focused");
    });
    doc.addEventListener("focusout", function (event) {
      if (event.target && event.target.classList) event.target.classList.remove("is-focused");
    });
    doc.addEventListener("keydown", onKey);
    clock.addEventListener("pagehide", function () { disposed = true; if (searchTimer !== null) clock.clearTimeout(searchTimer);
      if (activeAbort) activeAbort.abort(); });
    try {
      var saved = session && JSON.parse(session.getItem(core.STATE_KEY));
      var returned = core.returnEpisode(nav.search);
      if (returned) {
        core.writeSubtitlePref(local, returned.subtitle);
        pendingEpisodeFocus = { season: returned.season, episode: returned.episode };
        var old = core.readHistory(local || { getItem: function () { return null; } })
          .find(function (row) { return row.type === "tv" && row.id === returned.id; });
        if (old && (old.season !== returned.season || old.episode !== returned.episode))
          core.writeHistory(local, core.item("tv", old.id, old.title, returned.season,
            returned.episode, returned.subtitle, Date.now(), old));
      }
      if (saved && saved.version === 1 && ["all", "movie", "tv"].indexOf(saved.filter) >= 0) {
        state.detailSource = saved.source === "history" ? "history" : "search";
        state.filter = saved.filter; state.query = String(saved.query || "").slice(0, 80); query.value = state.query;
        doc.querySelectorAll("[data-filter]").forEach(function (b) { b.classList.toggle("is-current", b.dataset.filter === state.filter); });
        if (state.query.length >= 2) scheduleSearch(0);
      }
      if (returned) {
        var restoreEpisodes = !saved || saved.id !== returned.id || saved.view === "episodes";
        api("/api/title/tv/" + returned.id).then(function (value) {
          if (!old) core.writeHistory(local, core.item("tv", returned.id, value.title,
            returned.season, returned.episode, returned.subtitle, Date.now(), value));
          openDetails(value); state.detailSource = saved && saved.source === "history" ? "history" : "search";
          state.detail = value; state.season = returned.season;
          state.subtitle = core.readSubtitlePref(local); renderActions();
          if (restoreEpisodes) browseEpisodes();
        }, function () { text("search-status", "Could not restore show details. Search for the show to continue."); });
      }
      if (returned && root.history && root.history.replaceState) root.history.replaceState(null, "",
        useMock ? (nav.pathname + "?mock=1") : "/");
    } catch (_error) { /* Storage and history are optional on the TV browser. */ }
    setView("search"); focus(query);
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
  root.HorizonUniversalSearch = { createApp: createApp };
  if (typeof document !== "undefined") createApp(document, location, root);
})(typeof window !== "undefined" ? window : globalThis);
