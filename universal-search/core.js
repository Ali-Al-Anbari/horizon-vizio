(function (root) {
  "use strict";
  var PLAYER_ORIGIN = "https://horizon-video-lab-preview.ali-al-anbari.workers.dev";
  var LAUNCHER_ORIGIN = "https://horizon-vizio.ali-al-anbari.workers.dev";
  var HISTORY_KEY = "horizon-universal-search-history-v1";
  var PREFS_KEY = "horizon-universal-search-providers-v1";
  var SUBTITLE_KEY = "horizon-watch-subtitles-v1";
  var STATE_KEY = "horizon-universal-search-view-v1";
  var APP_NAMES = { "Amazon Prime Video": "Prime Video", "Disney Plus": "Disney+",
    "Plex": "Plex", "YouTube": "YouTube" };
  function positive(value) { return typeof value === "number" && isFinite(value) && value % 1 === 0
    && value > 0 && value <= 999999999; }
  function safeText(value, max) { return typeof value === "string" ? value.slice(0, max) : ""; }
  function imagePath(path) { return typeof path === "string" && /^\/[a-zA-Z0-9._-]{1,90}$/.test(path) ? path : null; }
  function item(type, id, title, season, episode, subtitle, at, artwork) {
    if ((type !== "tv" && type !== "movie") || !positive(id) || !safeText(title, 160)
        || !Number.isFinite(at) || at < 0 || at > 8640000000000000) return null;
    if (type === "tv" && (!positive(season) || !positive(episode))) return null;
    artwork = artwork || {};
    return { type: type, id: id, title: safeText(title, 160),
      season: type === "tv" ? season : null, episode: type === "tv" ? episode : null,
      subtitle: subtitle === "on" ? "on" : "off", at: at,
      poster: imagePath(artwork.poster), backdrop: imagePath(artwork.backdrop),
      episodeTitle: type === "tv" ? safeText(artwork.episodeTitle, 160) : "",
      tvdbId: type === "tv" && positive(artwork.tvdbId) ? artwork.tvdbId : null };
  }
  function historyKey(row) { return row.type + ":" + row.id + (row.type === "tv" ? ":" + row.season + ":" + row.episode : ""); }
  function readHistory(storage) {
    try {
      var parsed = JSON.parse(storage.getItem(HISTORY_KEY));
      if (!parsed || (parsed.version !== 1 && parsed.version !== 2) || !Array.isArray(parsed.items)) return [];
      var seen = {};
      return parsed.items.slice(0, 120).map(function (row) {
        return item(row.type, row.id, row.title, row.season, row.episode, row.subtitle, row.at, row);
      }).filter(Boolean).sort(function (a, b) { return b.at - a.at; }).filter(function (row) {
        var key = historyKey(row);
        if (seen[key]) return false;
        seen[key] = true; return true;
      }).slice(0, 100);
    } catch (_error) { return []; }
  }
  function writeHistory(storage, entry) {
    if (!entry) return readHistory(storage);
    entry = item(entry.type, entry.id, entry.title, entry.season, entry.episode, entry.subtitle, entry.at, entry);
    if (!entry) return readHistory(storage);
    var rows = readHistory(storage).filter(function (row) { return historyKey(row) !== historyKey(entry); });
    rows.unshift(entry); rows.sort(function (a, b) { return b.at - a.at; }); rows = rows.slice(0, 100);
    try { storage.setItem(HISTORY_KEY, JSON.stringify({ version: 2, items: rows })); }
    catch (_error) { /* Vizio storage may be unavailable; current session still works. */ }
    return rows;
  }
  function clearHistory(storage) { try { storage.setItem(HISTORY_KEY, JSON.stringify({ version: 2, items: [] })); } catch (_error) {} }
  function groupedHistory(rows) {
    var seen = {};
    return rows.filter(function (row) { var key = row.type + ":" + row.id;
      if (seen[key]) return false;
      seen[key] = true; return true;
    });
  }
  function homeRows(rows) { return groupedHistory(rows).slice(0, 6); }
  function rankResults(rows, query) {
    var q = String(query || "").toLocaleLowerCase().trim();
    if (!q) return rows.slice();
    function quality(value) {
      var title = String(value || "").toLocaleLowerCase().trim();
      if (title === q) return q.length <= 5 ? 95 : 125;
      if (title.indexOf(q) === 0) return 80;
      var words = title.split(/[^a-z0-9]+/);
      for (var i = 0; i < words.length; i++) if (words[i].indexOf(q) === 0) return 35;
      return title.indexOf(q) >= 0 ? 22 : 0;
    }
    function score(row) {
      return Math.max(quality(row.title), quality(row.originalTitle) - 8)
        + Math.log(1 + Math.max(0, Number(row.popularity) || 0)) * 8
        + Math.log(1 + Math.max(0, Number(row.voteCount) || 0)) * 7;
    }
    return rows.map(function (row, index) { return { row: row, index: index, score: score(row) }; })
      .sort(function (a, b) { return b.score - a.score
        || (Number(b.row.voteCount) || 0) - (Number(a.row.voteCount) || 0)
        || a.index - b.index; })
      .map(function (entry) { return entry.row; });
  }
  function readPrefs(storage) {
    try {
      var parsed = JSON.parse(storage.getItem(PREFS_KEY));
      return parsed && parsed.version === 1 && Array.isArray(parsed.ids)
        ? parsed.ids.filter(positive).slice(0, 50) : [];
    } catch (_error) { return []; }
  }
  function writePrefs(storage, ids) {
    try { storage.setItem(PREFS_KEY, JSON.stringify({ version: 1, ids: ids.filter(positive).slice(0, 50) })); }
    catch (_error) { /* Local preference is optional. */ }
  }
  function readSubtitlePref(storage) {
    try { var value = JSON.parse(storage.getItem(SUBTITLE_KEY));
      return value && value.version === 1 && value.mode === "on" ? "on" : "off";
    } catch (_error) { return "off"; }
  }
  function writeSubtitlePref(storage, mode) {
    if (mode !== "on" && mode !== "off") return;
    try { storage.setItem(SUBTITLE_KEY, JSON.stringify({ version: 1, mode: mode })); } catch (_error) {}
  }
  function tvPlayerUrl(id, season, episode, subtitle, title, tvdbId) {
    if (!positive(id) || !positive(season) || !positive(episode)) return null;
    var url = PLAYER_ORIGIN + "/player-overlay.html?season=" + season + "&episode=" + episode
      + "&sub=" + (subtitle === "on" ? "on" : "off") + "&showId=" + id + "&from=search";
    return url + (safeText(title, 120) ? "&name=" + encodeURIComponent(safeText(title, 120)) : "")
      + (positive(tvdbId) ? "&tvdb=" + tvdbId : "");
  }
  function imageUrl(path, size) {
    return imagePath(path)
      ? "https://image.tmdb.org/t/p/" + (size === "hero" ? "w1280" : size === "backdrop" ? "w780"
        : size === "provider" ? "w92" : "w500") + path : "";
  }
  function providerIdentity(name) {
    var value = safeText(name, 90).toLowerCase().replace(/&/g, "and").replace(/\s+/g, " ").trim();
    if (/paramount/.test(value)) return "paramount-plus";
    if (/amazon|prime video/.test(value)) return "prime-video";
    if (/hbo max|^max$/.test(value)) return "max";
    if (/disney/.test(value)) return "disney-plus";
    if (/peacock/.test(value)) return "peacock";
    if (/apple tv/.test(value)) return "apple-tv";
    return value.replace(/\s+(essential|premium|standard|basic|with ads|ad-supported|no ads)$/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }
  function groupProviders(value) {
    var categories = ["stream", "free", "rent", "buy"], names = {
      "paramount-plus": "Paramount+", "prime-video": "Prime Video", "max": "Max",
      "disney-plus": "Disney+", "peacock": "Peacock", "apple-tv": "Apple TV"
    }, groups = [], byIdentity = {};
    categories.forEach(function (category) {
      (value && Array.isArray(value[category]) ? value[category] : []).forEach(function (provider) {
        var identity = providerIdentity(provider && provider.name);
        if (!identity) return;
        var group = byIdentity[identity];
        if (!group) {
          group = byIdentity[identity] = { identity: identity, id: provider.id, name: names[identity]
            || safeText(provider.name, 90).replace(/\s+(Essential|Premium|Standard|Basic|with ads|ad-supported|no ads)$/i, ""),
            logo: imagePath(provider.logo), availability: [], offerIds: [] };
          groups.push(group);
        }
        if (!group.logo && imagePath(provider.logo)) group.logo = imagePath(provider.logo);
        if (group.offerIds.indexOf(provider.id) < 0) group.offerIds.push(provider.id);
        if (group.availability.indexOf(category) < 0) group.availability.push(category);
      });
    });
    return groups;
  }
  function providerWatchUrl(link, type, id) {
    if (!positive(id) || (type !== "tv" && type !== "movie") || typeof link !== "string") return null;
    try { var url = new URL(link);
      return url.protocol === "https:" && url.hostname === "www.themoviedb.org"
        && url.pathname === "/" + type + "/" + id + "/watch" && url.searchParams.get("locale") === "US"
        ? url.href : null;
    } catch (_error) { return null; }
  }
  function providerApp(name) { return APP_NAMES[name] || null; }
  function websiteSearch(title) { return "https://www.google.com/search?q="
    + encodeURIComponent(safeText(title, 160) + " streaming availability"); }
  function returnEpisode(search) {
    var params = new URLSearchParams(search || "");
    if (params.get("return") !== "1") return null;
    var id = Number(params.get("showId")), season = Number(params.get("season"));
    var episode = Number(params.get("episode"));
    return positive(id) && positive(season) && positive(episode)
      ? { id: id, season: season, episode: episode, subtitle: params.get("sub") === "on" ? "on" : "off" } : null;
  }
  root.HorizonSearchCore = { PLAYER_ORIGIN: PLAYER_ORIGIN, LAUNCHER_ORIGIN: LAUNCHER_ORIGIN,
    HISTORY_KEY: HISTORY_KEY, PREFS_KEY: PREFS_KEY, SUBTITLE_KEY: SUBTITLE_KEY, STATE_KEY: STATE_KEY, item: item,
    readHistory: readHistory, writeHistory: writeHistory, clearHistory: clearHistory, groupedHistory: groupedHistory,
    homeRows: homeRows, rankResults: rankResults,
    readPrefs: readPrefs, writePrefs: writePrefs, readSubtitlePref: readSubtitlePref, writeSubtitlePref: writeSubtitlePref,
    tvPlayerUrl: tvPlayerUrl, imageUrl: imageUrl, providerApp: providerApp, providerWatchUrl: providerWatchUrl,
    websiteSearch: websiteSearch, returnEpisode: returnEpisode, providerIdentity: providerIdentity,
    groupProviders: groupProviders };
})(typeof window !== "undefined" ? window : globalThis);
