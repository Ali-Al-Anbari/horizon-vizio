(function (root) {
  "use strict";

  // TVmaze describes aired episodes, not YapGrid streams. South Park is
  // TVmaze show 112 and YapGrid/TMDB show 2190; S13E2 is The Coon in both.
  var SHOW_ID = 2190;
  var EPISODES_URL = "https://api.tvmaze.com/shows/112/episodes";
  var CACHE_KEY = "horizon-video-lab-tvmaze-112-v1";
  var CACHE_MS = 3600000;
  var REQUEST_MS = 4000;

  function positive(value) {
    return typeof value === "number" && isFinite(value) && value > 0
      && value % 1 === 0 && value <= 9007199254740991;
  }
  function episode(season, number, title) {
    if (!positive(season) || !positive(number)) return null;
    return { showId: SHOW_ID, season: season, episode: number, title: title || null };
  }
  function episodeFor(showId, season, number) {
    if (!positive(showId) || !positive(season) || !positive(number)) return null;
    return { showId: showId, season: season, episode: number, title: null };
  }
  function parameter(search, name) {
    var match = new RegExp("(?:^|[?&])" + name + "=([^&]*)").exec(search || "");
    if (!match) return null;
    try { return decodeURIComponent(match[1]); }
    catch (_error) { return ""; }
  }
  function parse(search) {
    var seasonText = parameter(search, "season");
    var episodeText = parameter(search, "episode");
    var season = seasonText === null ? 13 : /^[1-9][0-9]*$/.test(seasonText) ? Number(seasonText) : NaN;
    var number = episodeText === null ? 2 : /^[1-9][0-9]*$/.test(episodeText) ? Number(episodeText) : NaN;
    var showText = parameter(search, "showId");
    var showId = showText === null ? SHOW_ID : /^[1-9][0-9]*$/.test(showText) ? Number(showText) : NaN;
    var current = episodeFor(showId, season, number);
    return { current: current || episode(13, 2), invalid: !current,
      subtitle: parameter(search, "sub") === "on" ? "on" : "off",
      testEnd: parameter(search, "testEnd") === "1",
      fromSearch: parameter(search, "from") === "search",
      showTitle: (parameter(search, "name") || "").slice(0, 120),
      tvdbId: /^[1-9][0-9]*$/.test(parameter(search, "tvdb") || "")
        ? Number(parameter(search, "tvdb")) : null };
  }
  function pageUrl(target, subtitle, testEnd, page, fromSearch, showTitle, tvdbId) {
    if (!target || !episodeFor(target.showId, target.season, target.episode)) return null;
    var destination = page === "list" ? "episode-list-placeholder.html" : "player-overlay.html";
    return destination + "?season=" + target.season + "&episode=" + target.episode
      + "&sub=" + (subtitle === "on" ? "on" : "off") + (testEnd ? "&testEnd=1" : "")
      + (target.showId === SHOW_ID ? "" : "&showId=" + target.showId)
      + (fromSearch ? "&from=search" : "")
      + (showTitle ? "&name=" + encodeURIComponent(showTitle.slice(0, 120)) : "")
      + (positive(tvdbId) ? "&tvdb=" + tvdbId : "");
  }
  function embedUrl(target) {
    if (!target || !episodeFor(target.showId, target.season, target.episode)) return null;
    return "https://yapgrid.com/embed/tv/" + target.showId + "/" + target.season + "/" + target.episode;
  }
  function normalize(raw, today, expectedShowId) {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 3000) throw new Error("invalid_episode_metadata");
    var rows = [];
    var seen = {};
    raw.forEach(function (entry) {
      if (!entry || entry.type !== "regular" || !positive(entry.season)
          || !positive(entry.number) || typeof entry.name !== "string"
          || !entry.name || entry.name.length > 160 || entry.name === "TBA"
          || typeof entry.airdate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.airdate)
          || entry.airdate > today) return;
      var key = entry.season + ":" + entry.number;
      if (seen[key]) throw new Error("ambiguous_episode_metadata");
      seen[key] = true;
      rows.push({ season: entry.season, number: entry.number, title: entry.name });
    });
    if (expectedShowId === undefined && !rows.some(function (row) { return row.season === 13 && row.number === 2 && row.title === "The Coon"; })) {
      throw new Error("episode_index_mismatch");
    }
    return rows;
  }
  function find(rows, season, number) {
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].season === season && rows[i].number === number) return rows[i];
    }
    return null;
  }
  function resolveFromRows(rows, current, direction) {
    if (!current || !episodeFor(current.showId, current.season, current.episode)
        || (direction !== -1 && direction !== 1) || !find(rows, current.season, current.episode)) {
      return { kind: "unknown", reason: "current_episode_not_in_metadata" };
    }
    var candidate = null;
    if (direction === 1) {
      candidate = find(rows, current.season, current.episode + 1)
        || find(rows, current.season + 1, 1);
    } else {
      if (current.episode > 1) candidate = find(rows, current.season, current.episode - 1);
      if (!candidate) {
        rows.forEach(function (row) {
          if (row.season < current.season && (!candidate || row.season > candidate.season
              || (row.season === candidate.season && row.number > candidate.number))) candidate = row;
        });
      }
    }
    return candidate ? { kind: "catalogued", target: { showId: current.showId,
      season: candidate.season, episode: candidate.number, title: candidate.title },
      providerAvailability: "unknown" } : { kind: "none_known" };
  }
  function createResolver(options) {
    options = options || {};
    var clock = options.clock || root;
    var tvdbId = positive(options.tvdbId) ? options.tvdbId : null;
    var showId = positive(options.showId) ? options.showId : SHOW_ID;
    var cacheKey = tvdbId ? "horizon-video-lab-tvmaze-tvdb-" + tvdbId + "-v1" : CACHE_KEY;
    var fetchEpisodeList = options.fetch || (root.fetch && root.fetch.bind(root));
    var storage = options.storage || null;
    if (!storage) {
      try { storage = root.sessionStorage; }
      catch (_error) { storage = null; } // Some TV browsers block storage entirely.
    }
    var today = options.today || new Date().toISOString().slice(0, 10);
    var rows = null;
    var pending = null;
    function load() {
      if (rows) return Promise.resolve(rows);
      if (pending) return pending;
      try {
        var saved = storage && JSON.parse(storage.getItem(cacheKey));
        if (saved && typeof saved.at === "number" && Date.now() - saved.at < CACHE_MS
            && Date.now() >= saved.at && Array.isArray(saved.rows)) {
          rows = normalize(saved.rows.map(function (row) {
            return { season: row.season, number: row.number, name: row.title,
              type: "regular", airdate: today };
          }), today, tvdbId || undefined);
          return Promise.resolve(rows);
        }
      } catch (_error) { /* Storage is optional on Vizio. */ }
      if (!fetchEpisodeList) return Promise.reject(new Error("metadata_unavailable"));
      var timer = null;
      var controller = root.AbortController ? new root.AbortController() : null;
      var timeout = new Promise(function (_resolve, reject) {
        timer = clock.setTimeout(function () {
          if (controller) controller.abort();
          reject(new Error("metadata_timeout"));
        }, tvdbId ? REQUEST_MS * 2 : REQUEST_MS);
      });
      var request = Promise.resolve().then(function () {
        if (!tvdbId && showId !== SHOW_ID) throw new Error("identity_unavailable");
        return tvdbId ? fetchEpisodeList("https://api.tvmaze.com/lookup/shows?thetvdb=" + tvdbId,
          controller ? { signal: controller.signal } : {}) : null;
      }).then(function (lookup) {
        if (!tvdbId) return EPISODES_URL;
        if (!lookup || !lookup.ok) throw new Error("identity_unavailable");
        return lookup.json().then(function (show) {
          if (!show || !positive(show.id) || !show.externals || show.externals.thetvdb !== tvdbId)
            throw new Error("identity_mismatch");
          return "https://api.tvmaze.com/shows/" + show.id + "/episodes";
        });
      }).then(function (url) {
        return fetchEpisodeList(url, controller ? { signal: controller.signal } : {});
      }).then(function (response) {
        if (!response || !response.ok) throw new Error("metadata_http_error");
        return response.json();
      }).then(function (data) { return normalize(data, today, tvdbId || undefined); });
      pending = Promise.race([request, timeout]).then(function (result) {
        clock.clearTimeout(timer);
        rows = result;
        pending = null;
        try { if (storage) storage.setItem(cacheKey, JSON.stringify({ at: Date.now(), rows: rows })); }
        catch (_error) { /* Storage is optional on Vizio. */ }
        return rows;
      }, function (error) {
        clock.clearTimeout(timer);
        pending = null;
        throw error;
      });
      return pending;
    }
    function resolve(current, direction) {
      return load().then(function (data) { return resolveFromRows(data, current, direction); }, function (error) {
        return { kind: "unknown", reason: error && error.message === "metadata_timeout"
          ? "timeout" : "metadata_unavailable" };
      });
    }
    function current(currentEpisode) {
      return load().then(function (data) {
        var found = find(data, currentEpisode.season, currentEpisode.episode);
        return found ? { showId: currentEpisode.showId, season: found.season,
          episode: found.number, title: found.title } : null;
      }, function () { return null; });
    }
    return { resolve: resolve, current: current, load: load };
  }
  root.HorizonEpisodes = { episode: episode, episodeFor: episodeFor, parse: parse, pageUrl: pageUrl, embedUrl: embedUrl,
    normalize: normalize, resolveFromRows: resolveFromRows, createResolver: createResolver };
})(typeof window !== "undefined" ? window : globalThis);
