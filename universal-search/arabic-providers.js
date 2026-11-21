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
      id: "roya_tv",
      label: "Roya TV (Authorized HLS)",
      shortLabel: "Roya TV",
      requiresAuth: false,
      authNote: "Authorized Roya TV playback ticket -> KWIKmotion HLS",
      supportedFormats: ["hls"]
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
    },
    {
      id: "akwam_relay",
      label: "Akwam Relay (MP4)",
      shortLabel: "Akwam Relay",
      requiresAuth: true,
      authNote: "Requires a paired Horizon device",
      supportedFormats: ["mp4"]
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
    var titles = (typeof cat.getCombinedTitles === "function" ? cat.getCombinedTitles() : cat.ARABIC_TITLES) || [];
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

  function resolveForProvider(providerId, query, relayEnabled) {
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
    if (providerId === "akwam_relay") {
      if (relayEnabled !== true) return buildOption(providerMeta, { failureReason: "Relay unavailable." });
      var supported = query && query.type === "tv" && Number(query.tmdbId) === 297621
        && Number(query.season) === 1 && Number(query.episode) === 1;
      return buildOption(providerMeta, {
        matchedTitle: item ? item.titleAr + " · " + item.titleEn : "",
        mediaId: supported ? 297621 : (item && item.id),
        season: (query && query.season) || null,
        episode: (query && query.episode) || null,
        format: "mp4",
        availability: supported ? "playable" : "unavailable",
        relayEpisodeId: supported ? "fakhr-el-delta-s01e01" : null,
        ticketUrl: supported ? "/api/arabic/relay-ticket" : null,
        authorizationNote: supported ? "Paired-device playback ticket" : "",
        failureReason: supported ? "" : "No relay mapping for this title and episode."
      });
    }

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

    if (providerId === "roya_tv") {
      var displayMatch = (item.titleEn && item.titleEn !== item.titleAr)
        ? (item.titleAr + " · " + item.titleEn)
        : (item.titleAr || item.title || "");
      var royaSeriesId = (ep && ep.royaSeriesId ? Number(ep.royaSeriesId) : null)
        || (item.royaSeriesId ? Number(item.royaSeriesId) : null);
      var royaEpId = item.type === "movie"
        ? (item.movieRoyaEpisodeId ? Number(item.movieRoyaEpisodeId) : (item.royaEpisodeId ? Number(item.royaEpisodeId) : null))
        : (ep && ep.royaEpisodeId ? Number(ep.royaEpisodeId) : null);
      if (royaSeriesId && royaEpId) {
        if ((ep && ep.plus) || item.plus || (item.type === "movie" && item.moviePlus)) {
          return buildOption(providerMeta, {
            matchedTitle: displayMatch,
            mediaId: item.id,
            season: query.season || null,
            episode: query.episode || null,
            authRequired: true,
            failureReason: "Roya TV Plus subscription required for Roya video ID " + royaEpId + " (unauthorized playback disabled)."
          });
        }
        if (ep && ep.video_type === "youtube") {
          return buildOption(providerMeta, {
            matchedTitle: displayMatch,
            mediaId: item.id,
            season: query.season || null,
            episode: query.episode || null,
            failureReason: "This Roya episode uses YouTube broadcast hosting rather than KWIKmotion HLS."
          });
        }
        return buildOption(providerMeta, {
          matchedTitle: displayMatch,
          mediaId: item.id,
          season: query.season || null,
          episode: query.episode || null,
          format: "hls",
          audioLanguage: "ar",
          quality: "HLS Adaptive (up to 1080p)",
          authRequired: false,
          availability: "playable",
          royaSeriesId: royaSeriesId,
          royaEpisodeId: royaEpId,
          durationSec: (item.type === "movie" ? item.movieDurationSec : (ep && ep.durationSec)) || null,
          ticketUrl: "https://ticket.roya-tv.com/api/v5/video/" + royaEpId + "/ticket?device_type=1&_rtv_lang=ar",
          streamUrl: "https://roya.tv/videos/" + royaEpId,
          authorizationNote: "Roya TV Live Catalog · ID " + royaSeriesId + " · Video " + royaEpId
        });
      }
      return buildOption(providerMeta, {
        matchedTitle: displayMatch,
        mediaId: item.id,
        season: query.season || null,
        episode: query.episode || null,
        failureReason: "No authorized Roya TV " + (item.type === "movie" ? "film" : "series/episode") + " identifier is available for " + (item.titleEn || item.titleAr) + (ep ? " S" + query.season + "E" + ep.number : "") + "."
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

  function buildRegionalListingOptions(item, query) {
    if (!item) return [];
    var out = [];
    var seen = Object.create(null);
    var platforms = Array.isArray(item.regionalPlatforms) ? item.regionalPlatforms : [];
    var watchProviders = Array.isArray(item.watchProviders) ? item.watchProviders : [];

    function pushPlatform(slug, label, isSub, region) {
      var key = String(slug || label || "").toLowerCase();
      if (!key || seen[key]) return;
      seen[key] = true;
      var statusLabel = isSub ? "Subscription Required" : "Listed on Provider";
      out.push({
        providerId: "regional_" + key.replace(/[^a-z0-9]+/g, "_"),
        providerLabel: label + " (" + statusLabel + ")",
        providerShortLabel: label,
        matchedTitle: (item.titleAr || item.title || "") + (item.titleEn ? (" · " + item.titleEn) : ""),
        mediaId: item.id,
        season: (query && query.season) || null,
        episode: (query && query.episode) || null,
        format: "external-listing",
        audioLanguage: "ar",
        quality: statusLabel,
        authRequired: Boolean(isSub),
        authNote: isSub ? "Subscription service without public in-app Horizon stream API" : "External regional platform listing",
        availability: isSub ? "subscription-required" : "listed-on-provider",
        streamUrl: null,
        youtubeId: null,
        officialApp: null,
        subtitleTracks: [],
        authorizationNote: "Discovered via " + (item.provenance || "Shoof Aflam / TMDB") + (region ? (" · " + region) : ""),
        failureReason: label + " requires its own official app/website (" + statusLabel + "); unauthorized third-party extraction is disabled in Horizon."
      });
    }

    for (var i = 0; i < platforms.length; i++) {
      var p = platforms[i];
      if (!p) continue;
      var label = p.nameEn || p.nameAr || p.slug;
      pushPlatform(p.slug, label, p.tier === "subscription", "MENA");
    }
    for (var j = 0; j < watchProviders.length; j++) {
      var wp = watchProviders[j];
      if (!wp || !wp.name) continue;
      pushPlatform(wp.name, wp.name, wp.tier === "subscription", wp.region || "TMDB");
    }
    return out;
  }

  function resolveAll(query, relayEnabled) {
    var base = PROVIDERS.filter(function (p) { return p.id !== "akwam_relay" || relayEnabled === true; })
      .map(function (p) { return resolveForProvider(p.id, query, relayEnabled); });
    var item = deterministicMatch(query);
    var regional = buildRegionalListingOptions(item, query);
    return base.concat(regional);
  }

  function preferredDefaultProvider(query, relayEnabled) {
    var item = deterministicMatch(query);
    if (item && item.royaSeriesId) return "roya_tv";
    var options = resolveAll(query, relayEnabled);
    for (var i = 0; i < options.length; i++) {
      if (options[i].availability === "playable") return options[i].providerId;
    }
    for (var j = 0; j < options.length; j++) {
      if (options[j].availability === "external-app") return options[j].providerId;
    }
    for (var k = 0; k < options.length; k++) {
      if (options[k].availability === "subscription-required" || options[k].availability === "listed-on-provider") {
        return options[k].providerId;
      }
    }
    return PROVIDERS[0].id;
  }

  function summarizeAvailability(item) {
    var engine = root.HorizonArabicSearchEngine;
    if (engine && typeof engine.classifyAvailability === "function") {
      return engine.classifyAvailability(item);
    }
    if (item && item.availability === "in-app") {
      return { state: "playable", label: item.availabilityLabel || "Playable in Horizon", detail: item.availabilityDetail || "" };
    }
    return { state: "metadata_only", label: (item && item.availabilityLabel) || "Discoverable Only", detail: (item && item.availabilityDetail) || "" };
  }

  root.HorizonArabicProviders = {
    PROVIDERS: PROVIDERS,
    deterministicMatch: deterministicMatch,
    strictEpisodeLookup: strictEpisodeLookup,
    resolveForProvider: resolveForProvider,
    resolveAll: resolveAll,
    preferredDefaultProvider: preferredDefaultProvider,
    summarizeAvailability: summarizeAvailability
  };
})(typeof window !== "undefined" ? window : globalThis);
