(function (root) {
  "use strict";

  var PROVIDERS = [
    {
      id: "archive_pd",
      label: "Archive.org Open MP4",
      shortLabel: "Archive.org (MP4)",
      requiresAuth: false,
      authNote: "None (Public Domain / Internet Archive)",
      supportedFormats: ["mp4"]
    },
    {
      id: "youtube_official",
      label: "YouTube Official Broadcast",
      shortLabel: "YouTube Official",
      requiresAuth: false,
      authNote: "Official broadcast channel embed or LG YouTube Leanback app",
      supportedFormats: ["youtube-iframe"]
    },
    {
      id: "official_app_handoff",
      label: "Official Partner App (LG webOS)",
      shortLabel: "Official LG App",
      requiresAuth: true,
      authNote: "Requires active subscription inside official LG TV app",
      supportedFormats: ["luna-app"]
    },
    {
      id: "cinemana_iraq",
      label: "Shabakaty Cinemana (Iraq Geo-Locked)",
      shortLabel: "Cinemana (Geo-Locked)",
      requiresAuth: true,
      authNote: "Iraq ISP network required (unavailable from US)",
      supportedFormats: []
    }
  ];

  function normalizeText(value) {
    var cat = root.HorizonArabicCatalog;
    if (cat && typeof cat.normalizeArabic === "function") return cat.normalizeArabic(value);
    return String(value || "").toLowerCase().trim();
  }

  function matchYear(itemDate, queryYear) {
    if (!queryYear) return true;
    var y = Number(String(itemDate || "").slice(0, 4));
    var qy = Number(queryYear);
    if (!Number.isFinite(y) || !Number.isFinite(qy) || !y || !qy) return true;
    return Math.abs(y - qy) <= 1;
  }

  function deterministicMatch(query) {
    var cat = root.HorizonArabicCatalog;
    if (!cat || !query) return null;

    // 1. Exact type + numeric ID match (TMDB / catalog ID)
    if (query.tmdbId) {
      var byId = cat.findByKey(query.type || null, Number(query.tmdbId));
      if (byId && matchYear(byId.date, query.year)) return byId;
    }

    // 2. Normalized Arabic / English title match + year check
    var qAr = normalizeText(query.titleAr);
    var qEn = normalizeText(query.titleEn);
    var titles = cat.ARABIC_TITLES || [];
    for (var i = 0; i < titles.length; i++) {
      var candidate = titles[i];
      if (query.type && candidate.type !== query.type) continue;
      if (!matchYear(candidate.date, query.year)) continue;
      var cAr = normalizeText(candidate.titleAr);
      var cEn = normalizeText(candidate.titleEn);
      if ((qAr && cAr === qAr) || (qEn && cEn === qEn)) return candidate;
    }
    return null;
  }

  function strictEpisodeLookup(item, season, episode) {
    if (!item || item.type !== "tv") return null;
    var sNum = Number(season);
    var eNum = Number(episode);
    if (!Number.isFinite(sNum) || !Number.isFinite(eNum) || sNum <= 0 || eNum <= 0) return null;
    var list = (item.seasonEpisodes && item.seasonEpisodes[sNum]) ? item.seasonEpisodes[sNum] : [];
    for (var i = 0; i < list.length; i++) {
      if (Number(list[i].number) === eNum) return list[i];
    }
    return null;
  }

  function buildOption(providerMeta, baseFields) {
    return Object.assign({
      providerId: providerMeta.id,
      providerLabel: providerMeta.label,
      providerShortLabel: providerMeta.shortLabel,
      matchedTitle: "",
      mediaId: null,
      season: null,
      episode: null,
      format: "none",
      audioLanguage: "ar",
      quality: null,
      authRequired: providerMeta.requiresAuth,
      authNote: providerMeta.authNote,
      availability: "unavailable",
      streamUrl: null,
      youtubeId: null,
      officialApp: null,
      subtitleTracks: [],
      authorizationNote: "",
      failureReason: ""
    }, baseFields || {});
  }

  function resolveForProvider(providerId, query) {
    var providerMeta = null;
    for (var i = 0; i < PROVIDERS.length; i++) {
      if (PROVIDERS[i].id === providerId) { providerMeta = PROVIDERS[i]; break; }
    }
    if (!providerMeta) {
      return buildOption({ id: providerId, label: String(providerId), shortLabel: String(providerId), requiresAuth: false, authNote: "" }, {
        failureReason: "Unknown provider selected."
      });
    }

    var item = deterministicMatch(query);
    if (!item) {
      return buildOption(providerMeta, {
        failureReason: "Could not deterministically match an Arabic catalog title for this selection."
      });
    }

    var ep = item.type === "tv" ? strictEpisodeLookup(item, query.season, query.episode) : null;
    if (item.type === "tv" && !ep) {
      return buildOption(providerMeta, {
        matchedTitle: item.titleAr + " · " + item.titleEn,
        mediaId: item.id,
        season: query.season || null,
        episode: query.episode || null,
        failureReason: "Requested S" + (query.season || "?") + " E" + (query.episode || "?") + " does not exist in verified episode metadata."
      });
    }

    if (providerId === "archive_pd") {
      if (item.archiveSource && item.archiveSource.streamUrl) {
        return buildOption(providerMeta, {
          matchedTitle: item.titleAr + " · " + item.titleEn,
          mediaId: item.id,
          format: item.archiveSource.format || "mp4",
          audioLanguage: "ar",
          quality: item.archiveSource.quality || "MP4",
          authRequired: false,
          availability: "playable",
          streamUrl: item.archiveSource.streamUrl,
          subtitleTracks: Array.isArray(item.archiveSource.subtitleTracks) ? item.archiveSource.subtitleTracks : [],
          authorizationNote: "Public Domain license (" + item.archiveSource.license + ") via Internet Archive"
        });
      }
      return buildOption(providerMeta, {
        matchedTitle: item.titleAr + " · " + item.titleEn,
        mediaId: item.id,
        season: query.season || null,
        episode: query.episode || null,
        failureReason: "No authorized public-domain MP4 stream exists on Archive.org for " + item.titleEn + (ep ? " S" + query.season + "E" + ep.number : "") + "."
      });
    }

    if (providerId === "youtube_official") {
      var ytId = item.type === "movie" ? item.youtubeId : (ep && ep.youtubeId ? ep.youtubeId : null);
      var channel = item.type === "movie" ? item.channel : (ep && ep.channel ? ep.channel : item.network);
      if (ytId) {
        return buildOption(providerMeta, {
          matchedTitle: item.titleAr + " · " + item.titleEn,
          mediaId: item.id,
          season: query.season || null,
          episode: query.episode || null,
          format: "youtube-iframe",
          audioLanguage: "ar",
          quality: "Official Channel Stream",
          authRequired: false,
          availability: "playable",
          youtubeId: ytId,
          streamUrl: "https://www.youtube.com/watch?v=" + ytId,
          authorizationNote: "Official broadcast channel: " + (channel || "YouTube")
        });
      }
      return buildOption(providerMeta, {
        matchedTitle: item.titleAr + " · " + item.titleEn,
        mediaId: item.id,
        season: query.season || null,
        episode: query.episode || null,
        failureReason: "No verified official YouTube broadcast is available for " + item.titleEn + (ep ? " S" + query.season + "E" + ep.number : "") + "."
      });
    }

    if (providerId === "official_app_handoff") {
      if (item.officialApp && item.officialApp.appId) {
        return buildOption(providerMeta, {
          matchedTitle: item.titleAr + " · " + item.titleEn,
          mediaId: item.id,
          season: query.season || null,
          episode: query.episode || null,
          format: "luna-app",
          audioLanguage: "ar",
          quality: "Native App",
          authRequired: true,
          availability: "external-app",
          officialApp: item.officialApp,
          authorizationNote: "Launches official LG TV app: " + item.officialApp.appName
        });
      }
      return buildOption(providerMeta, {
        matchedTitle: item.titleAr + " · " + item.titleEn,
        mediaId: item.id,
        season: query.season || null,
        episode: query.episode || null,
        failureReason: "No official LG TV partner app integration is configured for " + item.titleEn + "."
      });
    }

    if (providerId === "cinemana_iraq") {
      return buildOption(providerMeta, {
        matchedTitle: item.titleAr + " · " + item.titleEn,
        mediaId: item.id,
        season: query.season || null,
        episode: query.episode || null,
        failureReason: "Shabakaty Cinemana (cinemana.shabakaty.cc) only responds inside Iraqi ISP networks and timed out from the US."
      });
    }

    return buildOption(providerMeta, { failureReason: "Provider unavailable." });
  }

  function resolveAll(query) {
    return PROVIDERS.map(function (p) { return resolveForProvider(p.id, query); });
  }

  function preferredDefaultProvider(query) {
    var options = resolveAll(query);
    for (var i = 0; i < options.length; i++) {
      if (options[i].availability === "playable") return options[i].providerId;
    }
    for (var j = 0; j < options.length; j++) {
      if (options[j].availability === "external-app") return options[j].providerId;
    }
    return PROVIDERS[0].id;
  }

  root.HorizonArabicProviders = {
    PROVIDERS: PROVIDERS,
    deterministicMatch: deterministicMatch,
    strictEpisodeLookup: strictEpisodeLookup,
    resolveForProvider: resolveForProvider,
    resolveAll: resolveAll,
    preferredDefaultProvider: preferredDefaultProvider
  };
})(typeof window !== "undefined" ? window : globalThis);
