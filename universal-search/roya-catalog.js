(function (root) {
  "use strict";

  var BACKEND_BASE = "https://backend.roya.tv/api/v01";
  var CACHE_TTL_MS = 10 * 60 * 1000;

  // Preserve continuity with verified PoC IDs (e.g. السبع 1714 -> 901714)
  var SYNTHETIC_ID_OVERRIDES = {
    1714: 901714
  };
  var SYNTHETIC_TO_ROYA = {
    901714: 1714
  };

  // Curated bilingual aliases for major Roya titles (never fabricates titles absent from Roya)
  var BILINGUAL_ALIASES = {
    1714: { en: "Al-Sabea", aliases: ["al sabea", "el sabe3", "sabe3", "السبع 2025", "رمضان 2025"] },
    1698: { en: "Abna Al-Qahr", aliases: ["abna al qahr", "abnaa al qahr", "أبناء القهر", "بسام كوسا"] },
    1834: { en: "Hikaya Al-Maraya", aliases: ["maraya", "hikaya al maraya", "مرايا", "ياسر العظمة"] },
    1839: { en: "Welayat Bateekh 9", aliases: ["welayat bateekh", "wilayat btikh", "ولاية بطيخ"] },
    1290: { en: "Harit Al-Qubba", aliases: ["haret el qubba", "harit al qubba", "حارة القبة"] },
    796: { en: "Jaltah", aliases: ["jaltah", "jalta", "جلطة"] },
    1864: { en: "Al-Dawla Al-Amiqa", aliases: ["deep state", "dawla amiqa", "الدولة العميقة"] },
    1833: { en: "Walad Sultan", aliases: ["walad sultan", "awlad sultan", "ولاد سلطان"] },
    2111: { en: "Ishna Wa Shufna", aliases: ["eshna w shofna", "عشنا وشفنا"] },
    1846: { en: "Al-Qiddisa", aliases: ["the saint", "al qiddisa", "القديسة"] },
    1870: { en: "Sihr Al-Sharq", aliases: ["magic of the east", "سحر الشرق"] },
    1865: { en: "Al-Mantiqa Al-Hamra", aliases: ["red zone", "المنطقة الحمراء"] },
    1515: { en: "Aghmid Eynayk", aliases: ["aghmed ainaik", "أغمض عينيك"] },
    214: { en: "Asfourya", aliases: ["asfouryah", "عصفورية"] },
    216: { en: "Al-Jar Qabl Al-Dar", aliases: ["neighbor before house", "الجار قبل الدار"] },
    56: { en: "Donia Ya Donia", aliases: ["donia ya donia", "دنيا يا دنيا"] },
    2101: { en: "Eagles of Jordan (Documentary)", aliases: ["nesoor al urdun", "eagles of jordan", "نسور الأردن"] },
    421: { en: "Asl Al-Shuroor (Film)", aliases: ["origin of evil", "asl al shuroor", "أصل الشرور"] },
    1854: { en: "Tesbah Ala Khair", aliases: ["good night", "tamer hosny", "تصبح على خير"] },
    1852: { en: "Ahwak", aliases: ["i adore you", "tamer hosny", "أهواك"] },
    1853: { en: "Ocean 14", aliases: ["ocean 14", "أوشن 14"] },
    1855: { en: "Taht El-Tarabeeza", aliases: ["under the table", "تحت الترابيزة"] }
  };

  var GENRE_TRANSLATIONS = {
    "دراما": "Drama",
    "كوميدي": "Comedy",
    "كوميديا": "Comedy",
    "رومانسي": "Romance",
    "اجتماعي": "Social Drama",
    "مجتمعي": "Society",
    "أكشن": "Action",
    "تاريخي": "History",
    "إثارة وجريمة": "Thriller & Crime",
    "بيئة شامية": "Levantine Period Drama",
    "سفر": "Travel",
    "طبخ": "Cooking",
    "منوعات": "Variety",
    "موسيقى": "Music",
    "أطفال": "Kids",
    "وثائقي": "Documentary"
  };

  var state = {
    catalogLoadedAt: 0,
    catalogPromise: null,
    itemsByRoyaId: Object.create(null),
    itemsByWatchId: Object.create(null),
    catalogList: [],
    detailsCache: Object.create(null),
    detailsPending: Object.create(null),
    seasonCache: Object.create(null),
    seasonPending: Object.create(null)
  };

  function normalizeArabic(text) {
    return String(text || "")
      .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
      .replace(/[أإآ]/g, "ا")
      .replace(/ى/g, "ي")
      .replace(/ة/g, "ه")
      .replace(/ؤ/g, "و")
      .replace(/ئ/g, "ي")
      .toLowerCase()
      .replace(/[^\u0600-\u06FFa-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function stripHtml(text) {
    return String(text || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }

  function parseDurationSec(durationStr) {
    var parts = String(durationStr || "").trim().split(":").map(Number);
    if (parts.some(function (n) { return !Number.isFinite(n); })) return 0;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 1 && parts[0] > 0) return parts[0];
    return 0;
  }

  function toWatchId(royaId) {
    var rid = Number(royaId);
    if (SYNTHETIC_ID_OVERRIDES[rid]) return SYNTHETIC_ID_OVERRIDES[rid];
    return 9000000 + rid;
  }

  function toRoyaIdFromWatchId(watchId) {
    var wid = Number(watchId);
    if (SYNTHETIC_TO_ROYA[wid]) return SYNTHETIC_TO_ROYA[wid];
    if (wid > 9000000 && wid < 9999999) return wid - 9000000;
    return null;
  }

  function isAbortError(err) {
    return Boolean(err && (err.name === "AbortError" || /abort/i.test(String(err.message || ""))));
  }

  function fetchJson(url, signal, timeoutMs) {
    var fetchFn = typeof root.fetch === "function" ? root.fetch.bind(root) : null;
    if (!fetchFn) return Promise.reject(new Error("fetch unavailable"));
    var ms = timeoutMs || 10000;
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var onOuterAbort = null;
    if (controller && signal) {
      if (signal.aborted) {
        var abortErr = new Error("Aborted");
        abortErr.name = "AbortError";
        return Promise.reject(abortErr);
      }
      onOuterAbort = function () { controller.abort(); };
      signal.addEventListener("abort", onOuterAbort);
    }
    var timer = setTimeout(function () {
      if (controller) controller.abort();
    }, ms);
    return fetchFn(url, {
      method: "GET",
      signal: controller ? controller.signal : undefined
    }).then(function (resp) {
      if (!resp.ok) {
        var e = new Error("Roya HTTP " + resp.status);
        e.status = resp.status;
        throw e;
      }
      return resp.text();
    }).then(function (txt) {
      try { return JSON.parse(txt); } catch (_e) { return txt; }
    }).finally(function () {
      clearTimeout(timer);
      if (signal && onOuterAbort) signal.removeEventListener("abort", onOuterAbort);
    });
  }

  function fetchText(url, signal, timeoutMs) {
    var fetchFn = typeof root.fetch === "function" ? root.fetch.bind(root) : null;
    if (!fetchFn) return Promise.reject(new Error("fetch unavailable"));
    var ms = timeoutMs || 10000;
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var onOuterAbort = null;
    if (controller && signal) {
      if (signal.aborted) {
        var abortErr = new Error("Aborted");
        abortErr.name = "AbortError";
        return Promise.reject(abortErr);
      }
      onOuterAbort = function () { controller.abort(); };
      signal.addEventListener("abort", onOuterAbort);
    }
    var timer = setTimeout(function () {
      if (controller) controller.abort();
    }, ms);
    return fetchFn(url, {
      method: "GET",
      signal: controller ? controller.signal : undefined
    }).then(function (resp) {
      if (!resp.ok) {
        var e = new Error("Roya HTTP " + resp.status);
        e.status = resp.status;
        throw e;
      }
      return resp.text();
    }).finally(function () {
      clearTimeout(timer);
      if (signal && onOuterAbort) signal.removeEventListener("abort", onOuterAbort);
    });
  }

  function classifyType(raw, isMovieRow) {
    if (isMovieRow) return "movie";
    var eps = Number(raw.episodes_count || 0);
    var pt = String(raw.program_type || "");
    var name = String(raw.name || raw.title || "");
    if (pt === "2") return "tv";
    if (eps === 1 && (/فيلم|وثائقي/i.test(name))) return "movie";
    return "tv";
  }

  function mergeRoyaRecord(raw, opts) {
    opts = opts || {};
    var royaId = Number(raw.value || raw.id);
    if (!Number.isFinite(royaId) || royaId <= 0) return null;
    var watchId = toWatchId(royaId);
    var aliasInfo = BILINGUAL_ALIASES[royaId] || null;
    var existing = state.itemsByRoyaId[royaId];
    var nameAr = String(raw.name || raw.title || (existing && existing.titleAr) || ("Roya #" + royaId)).trim();
    var isPlus = Boolean(raw.plus || (existing && existing.plus));
    var isMovie = Boolean(opts.isMovie || (existing && existing.type === "movie") || classifyType(raw, opts.isMovie) === "movie");
    var type = isMovie ? "movie" : "tv";
    var epsCount = Math.max(Number(raw.episodes_count || 0), existing ? (existing.episodesCount || 0) : 0);
    var poster = raw.image_url || raw.CoverImage || (existing && existing.poster) || "";
    var backdrop = raw.thumbnail_web || raw.thumbnail_mob || (existing && existing.backdrop) || poster || "";
    var desc = stripHtml(raw.description || (existing && existing.overview) || "");
    var genres = existing && Array.isArray(existing.genres) ? existing.genres.slice() : [];
    if (opts.genreName) {
      var mappedGenre = GENRE_TRANSLATIONS[opts.genreName] || opts.genreName;
      if (genres.indexOf(mappedGenre) < 0) genres.push(mappedGenre);
    }
    if (!genres.length) genres.push(String(raw.program_type) === "2" ? "Drama" : "Variety");

    var rec = Object.assign(existing || {}, {
      id: watchId,
      externalCatalogId: true,
      isRoyaCatalog: true,
      royaSeriesId: royaId,
      royaProgramType: String(raw.program_type || (existing && existing.royaProgramType) || "1"),
      type: type,
      title: aliasInfo && aliasInfo.en ? (nameAr + " · " + aliasInfo.en) : nameAr,
      titleAr: nameAr,
      titleEn: aliasInfo && aliasInfo.en ? aliasInfo.en : nameAr,
      aliases: (aliasInfo ? aliasInfo.aliases : []).concat([String(royaId)]),
      date: (existing && existing.date) || "",
      country: "JO",
      countryLabel: String(raw.program_type) === "2" ? "الأردن / العالم العربي · Roya TV Series" : "الأردن · Roya TV",
      regionGroup: "levant",
      originalLanguage: "ar",
      rating: raw.age_rating || (existing && existing.rating) || "All",
      plus: isPlus,
      prime: Boolean(raw.prime || (existing && existing.prime)),
      episodesCount: epsCount,
      episodeRuntime: (existing && existing.episodeRuntime) || 42,
      runtime: (existing && existing.runtime) || (type === "movie" ? 90 : 42),
      genres: genres,
      cast: (existing && existing.cast) || [],
      network: "Roya TV",
      status: isPlus ? "Roya Plus" : "Streaming Free",
      availability: isPlus ? "unavailable" : "in-app",
      availabilityLabel: isPlus ? "Roya Plus · Subscription Required" : "Play In-App · Roya TV HLS",
      availabilityDetail: isPlus
        ? "Marked as Roya Plus on Roya TV (subscription required; unauthorized playback disabled)."
        : "Authorized live catalog title from Roya TV (KWIKmotion HLS playback).",
      poster: poster,
      backdrop: backdrop,
      overview: desc || "برنامج / مسلسل عربي متوفر عبر شبكة رؤيا التلفزيونية.",
      popularity: Number(raw.program_type) === "2" ? (90 - Math.min(40, Number(raw.order || 1))) : 55
    });

    state.itemsByRoyaId[royaId] = rec;
    state.itemsByWatchId[watchId] = rec;
    return rec;
  }

  function rebuildList() {
    var list = [];
    Object.keys(state.itemsByRoyaId).forEach(function (k) {
      list.push(state.itemsByRoyaId[k]);
    });
    // Prefer TV series (program_type 2) + free playable items first for default home rows
    list.sort(function (a, b) {
      var aScore = (a.plus ? -100 : 100) + (a.royaProgramType === "2" ? 50 : 0) + (a.type === "movie" ? 20 : 0);
      var bScore = (b.plus ? -100 : 100) + (b.royaProgramType === "2" ? 50 : 0) + (b.type === "movie" ? 20 : 0);
      if (bScore !== aScore) return bScore - aScore;
      return b.royaSeriesId - a.royaSeriesId;
    });
    state.catalogList = list;
  }

  function loadSeriesPages() {
    var firstPageHeadId = null;
    function fetchPage(p) {
      return fetchJson(BACKEND_BASE + "/genres/0/1?device_size=Size03Q40&device_type=1&page=" + p, null, 9000)
        .then(function (data) {
          return (data && Array.isArray(data.series)) ? data.series : [];
        });
    }
    return Promise.all([fetchPage(1), fetchPage(2), fetchPage(3), fetchPage(4)]).then(function (batches) {
      for (var b = 0; b < batches.length; b++) {
        var arr = batches[b];
        if (!arr.length) break;
        if (b === 0 && arr[0]) firstPageHeadId = arr[0].value;
        if (b > 0 && arr[0] && arr[0].value === firstPageHeadId) break;
        for (var i = 0; i < arr.length; i++) mergeRoyaRecord(arr[i], { genreName: "دراما" });
      }
      if (batches[3] && batches[3].length >= 24 && (!firstPageHeadId || batches[3][0].value !== firstPageHeadId)) {
        var page = 5;
        function next() {
          if (page > 20) return Promise.resolve();
          return fetchPage(page).then(function (arr) {
            if (!arr.length || (arr[0] && arr[0].value === firstPageHeadId)) return;
            for (var i = 0; i < arr.length; i++) mergeRoyaRecord(arr[i], { genreName: "دراما" });
            page += 1;
            return next();
          });
        }
        return next();
      }
    });
  }

  function loadProgramPages() {
    function fetchPage(p) {
      return fetchJson(BACKEND_BASE + "/programs/" + p, null, 9000)
        .then(function (sections) { return Array.isArray(sections) ? sections : []; });
    }
    function consume(sections) {
      var count = 0;
      for (var s = 0; s < sections.length; s++) {
        var sec = sections[s];
        var list = sec && Array.isArray(sec.programs) ? sec.programs : [];
        count += list.length;
        for (var i = 0; i < list.length; i++) {
          mergeRoyaRecord(list[i], { genreName: sec.name || "" });
        }
      }
      return count;
    }
    return Promise.all([fetchPage(1), fetchPage(2), fetchPage(3), fetchPage(4), fetchPage(5)]).then(function (b1) {
      var lastCount = 0;
      for (var i = 0; i < b1.length; i++) lastCount = consume(b1[i]);
      if (lastCount === 0) return;
      return Promise.all([fetchPage(6), fetchPage(7), fetchPage(8), fetchPage(9), fetchPage(10)]).then(function (b2) {
        var b2Last = 0;
        for (var j = 0; j < b2.length; j++) b2Last = consume(b2[j]);
        if (b2Last === 0) return;
        var page = 11;
        function next() {
          if (page > 16) return Promise.resolve();
          return fetchPage(page).then(function (secs) {
            if (consume(secs) === 0) return;
            page += 1;
            return next();
          });
        }
        return next();
      });
    });
  }

  function loadHomepageAndMovies() {
    return fetchJson(BACKEND_BASE + "/homepage/rows?device_size=Size03Q40&device_type=1&page=1", null, 9000)
      .then(function (payload) {
        var rows = (payload && payload.data && Array.isArray(payload.data.rows)) ? payload.data.rows : [];
        var extraLoads = [];
        for (var i = 0; i < rows.length; i++) {
          var row = rows[i];
          if (!row || row.type !== "programs") continue;
          var isMovieRow = Number(row.homepage_id) === 313 || /أفلام/.test(String(row.title || ""));
          var items = Array.isArray(row.items) ? row.items : [];
          for (var j = 0; j < items.length; j++) {
            mergeRoyaRecord(items[j], { isMovie: isMovieRow, genreName: row.title || "" });
          }
          if (isMovieRow) {
            (function (hpId, rowTitle, movFlag) {
              extraLoads.push(
                fetchJson(BACKEND_BASE + "/homepage/moredata/?device_size=Size03Q40&page=1&homepage_id=" + hpId, null, 8000)
                  .then(function (mdata) {
                    var mItems = (mdata && mdata.data && Array.isArray(mdata.data.items)) ? mdata.data.items : [];
                    for (var k = 0; k < mItems.length; k++) {
                      mergeRoyaRecord(mItems[k], { isMovie: movFlag, genreName: rowTitle });
                    }
                  }).catch(function () {})
              );
            })(row.homepage_id, row.title || "", isMovieRow);
          }
        }
        return Promise.all(extraLoads);
      });
  }

  var SESSION_CATALOG_KEY = "horizon-roya-catalog-v1";

  function tryHydrateSessionCache() {
    try {
      if (!root.sessionStorage) return false;
      var raw = root.sessionStorage.getItem(SESSION_CATALOG_KEY);
      if (!raw) return false;
      var parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.items) || !parsed.items.length) return false;
      if (Date.now() - (Number(parsed.at) || 0) >= CACHE_TTL_MS) return false;
      parsed.items.forEach(function (rec) {
        if (rec && rec.royaSeriesId && rec.id) {
          state.itemsByRoyaId[rec.royaSeriesId] = rec;
          state.itemsByWatchId[rec.id] = rec;
        }
      });
      rebuildList();
      state.catalogLoadedAt = Number(parsed.at) || Date.now();
      return state.catalogList.length > 0;
    } catch (_e) {
      return false;
    }
  }

  function writeSessionCache() {
    try {
      if (!root.sessionStorage || !state.catalogList.length) return;
      root.sessionStorage.setItem(SESSION_CATALOG_KEY, JSON.stringify({
        at: state.catalogLoadedAt,
        items: state.catalogList
      }));
    } catch (_e) {}
  }

  function abortPromise() {
    var err = new Error("Aborted");
    err.name = "AbortError";
    return Promise.reject(err);
  }

  function ensureCatalogLoaded(signal) {
    if (signal && signal.aborted) return abortPromise();
    var now = Date.now();
    if (state.catalogList.length > 0 && now - state.catalogLoadedAt < CACHE_TTL_MS) {
      return Promise.resolve(state.catalogList);
    }
    if (tryHydrateSessionCache()) {
      return Promise.resolve(state.catalogList);
    }
    if (!state.catalogPromise) {
      state.catalogPromise = Promise.all([
        loadSeriesPages(),
        loadProgramPages(),
        loadHomepageAndMovies()
      ]).then(function () {
        rebuildList();
        if (state.catalogList.length > 0) {
          state.catalogLoadedAt = Date.now();
          writeSessionCache();
        }
        state.catalogPromise = null;
        return state.catalogList;
      }, function (err) {
        state.catalogPromise = null;
        if (state.catalogList.length > 0) return state.catalogList;
        throw err;
      });
    }
    return state.catalogPromise.then(function (list) {
      if (signal && signal.aborted) return abortPromise();
      return list;
    });
  }

  function extractEpisodesIdList(rawText) {
    var cleaned = String(rawText || "").replace(/^[\s"',]+|[\s"',]+$/g, "");
    if (!cleaned) return [];
    var parts = cleaned.split(",");
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var id = Number(String(parts[i]).trim());
      if (Number.isFinite(id) && id > 0) out.push(id);
    }
    return out.reverse(); // Roya returns newest -> oldest; reverse to canonical E1..EN
  }

  function buildMetaMap(details) {
    var byEpId = Object.create(null);
    function addMeta(raw) {
      if (!raw) return;
      var id = Number(raw.value || raw.id);
      if (!Number.isFinite(id) || id <= 0) return;
      byEpId[id] = raw;
    }
    if (details && details.main && details.main.watchnow_episode) {
      addMeta(details.main.watchnow_episode);
    }
    var latest = details && Array.isArray(details.latest_episodes) ? details.latest_episodes : [];
    for (var i = 0; i < latest.length; i++) addMeta(latest[i]);
    return byEpId;
  }

  function buildEpisodeObjects(item, seasonNum, ascIds, details, seasonProgramId) {
    var metaMap = buildMetaMap(details);
    var fallbackStill = (details && details.main && (details.main.thumbnail_web || details.main.thumbnail_mob)) || item.backdrop || item.poster || "";
    var defaultRuntime = item.episodeRuntime || 42;
    var episodes = [];
    for (var i = 0; i < ascIds.length; i++) {
      var epId = ascIds[i];
      var m = metaMap[epId] || null;
      var epNum = i + 1;
      var epPlus = m ? Boolean(m.plus) : Boolean(item.plus);
      var vt = m && m.video_type ? String(m.video_type) : "erstream";
      var ytId = m && m.youtube_video_id ? String(m.youtube_video_id) : null;
      var durSec = m && m.duration ? parseDurationSec(m.duration) : 0;
      var rawTitle = m && (m.name || m.episode_title) ? String(m.name || m.episode_title).trim() : "";
      var title = rawTitle ? rawTitle : ("الحلقة " + epNum + " · Episode " + epNum);
      var dateStr = m && m.since ? String(m.since) : (m && m.episode_publish_date ? String(m.episode_publish_date).slice(0, 10) : (item.date || ""));
      episodes.push({
        number: epNum,
        season: seasonNum,
        royaSeriesId: seasonProgramId || item.royaSeriesId,
        royaEpisodeId: epId,
        title: title,
        date: dateStr,
        runtime: durSec > 0 ? Math.max(1, Math.round(durSec / 60)) : defaultRuntime,
        durationSec: durSec || defaultRuntime * 60,
        plus: epPlus,
        video_type: vt,
        youtubeId: vt === "youtube" ? ytId : null,
        still: (m && (m.image_url || m.thumbnail_web)) || fallbackStill,
        channel: "Roya TV",
        availability: epPlus ? "unavailable" : (vt === "youtube" && !ytId ? "unavailable" : "in-app"),
        overview: (m && (m.description || m.short_description))
          ? stripHtml(m.description || m.short_description)
          : ("الحلقة " + epNum + " من " + item.titleAr + (epPlus ? " (يتطلب اشتراك رؤيا بلس)." : " عبر رؤيا."))
      });
    }
    return episodes;
  }

  function extractCastList(castsObj) {
    if (!castsObj || typeof castsObj !== "object") return [];
    var out = [];
    for (var i = 1; i <= 10; i++) {
      var a = castsObj["actor" + i];
      if (a && a.name) out.push(a.name);
    }
    return out;
  }

  function fetchProgramRawDetails(royaId, signal) {
    return Promise.all([
      fetchJson(BACKEND_BASE + "/programs/" + royaId + "/details?device_size=Size01Q40", signal, 9000),
      fetchText(BACKEND_BASE + "/programs/" + royaId + "/episodes", signal, 9000).catch(function () { return ""; })
    ]).then(function (pair) {
      return { details: pair[0], epIds: extractEpisodesIdList(pair[1]) };
    });
  }

  function fetchDetailsAsync(royaIdOrWatchId, signal) {
    var royaId = toRoyaIdFromWatchId(royaIdOrWatchId) || Number(royaIdOrWatchId);
    if (!Number.isFinite(royaId) || royaId <= 0) return Promise.reject(new Error("Invalid Roya ID"));
    var cached = state.detailsCache[royaId];
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return Promise.resolve(cached.item);
    }
    if (state.detailsPending[royaId]) return state.detailsPending[royaId];

    var p = fetchProgramRawDetails(royaId, signal).then(function (res) {
      var det = res.details;
      if (!det || !det.main) throw new Error("Roya details payload empty");
      var main = det.main;
      var item = mergeRoyaRecord({
        value: royaId,
        name: main.title,
        description: main.description_str || (main.description && main.description.html) || "",
        plus: main.plus,
        prime: main.prime,
        episodes_count: main.episodesCount,
        age_rating: main.ageRatingValue,
        program_type: main.program_type,
        thumbnail_web: main.thumbnail_web,
        thumbnail_mob: main.thumbnail_mob
      }, {});

      var wn = main.watchnow_episode || null;
      var wnProg = wn && wn.program ? wn.program : null;
      var genres = Array.isArray(main.genres) ? main.genres.map(function (g) {
        return GENRE_TRANSLATIONS[g.name] || g.name;
      }).filter(Boolean) : [];
      if (genres.length) item.genres = genres;

      item.overview = stripHtml(main.description_str || item.overview);
      item.cast = extractCastList(det.casts);
      item.creators = det.casts && (det.casts.writer || det.casts.director)
        ? [det.casts.director, det.casts.writer].filter(Boolean)
        : [];
      item.directors = det.casts && det.casts.director ? [det.casts.director] : [];
      if (wnProg && wnProg.created_at) item.date = String(wnProg.created_at).slice(0, 10);
      else if (wn && wn.since) item.date = String(wn.since).slice(0, 10);

      if (wn && wn.duration) {
        var wnSec = parseDurationSec(wn.duration);
        if (wnSec > 0) {
          var wnMin = Math.max(1, Math.round(wnSec / 60));
          if (item.type === "movie") item.runtime = wnMin;
          else item.episodeRuntime = wnMin;
        }
      }
      if (item.type === "movie") {
        item.movieRoyaEpisodeId = wn && wn.value ? Number(wn.value) : (res.epIds[0] || null);
        item.movieDurationSec = wn && wn.duration ? parseDurationSec(wn.duration) : 0;
        item.moviePlus = Boolean(main.plus || (wn && wn.plus));
        if (item.moviePlus) {
          item.plus = true;
          item.availability = "unavailable";
          item.availabilityLabel = "Roya Plus · Subscription Required";
        }
      }

      // Multi-season handling via ChildsIds[0]
      var childIds = (det.ChildsIds && Array.isArray(det.ChildsIds[0]))
        ? det.ChildsIds[0].map(Number).filter(function (n) { return Number.isFinite(n) && n > 0; })
        : [];

      item.seasonEpisodes = item.seasonEpisodes || Object.create(null);
      item.seasonProgramMap = item.seasonProgramMap || Object.create(null);

      if (childIds.length > 1) {
        if (childIds.length <= 12) {
          return Promise.all(childIds.map(function (cid) {
            return fetchJson(BACKEND_BASE + "/programs/" + cid + "/details?device_size=Size01Q40", signal, 8000)
              .catch(function () { return null; });
          })).then(function (childDetails) {
            var seasonList = [];
            for (var c = 0; c < childDetails.length; c++) {
              var cd = childDetails[c];
              var cid = childIds[c];
              var cMain = cd && cd.main;
              var cWnProg = cMain && cMain.watchnow_episode && cMain.watchnow_episode.program;
              var sNo = Number((cWnProg && cWnProg.season_no) || (c + 1));
              while (item.seasonProgramMap[sNo]) sNo += 1;
              item.seasonProgramMap[sNo] = cid;
              seasonList.push({
                number: sNo,
                name: (cMain && cMain.title) || ("Season " + sNo + " · الموسم " + sNo),
                episodeCount: Number((cMain && cMain.episodesCount) || 0),
                royaProgramId: cid
              });
            }
            seasonList.sort(function (a, b) { return a.number - b.number; });
            item.seasons = seasonList;
            state.detailsCache[royaId] = { at: Date.now(), item: item };
            state.detailsPending[royaId] = null;
            return item;
          });
        }
        // Large archive program (e.g. 64 child seasons): map lazily to avoid 64 requests upfront
        var lazySeasons = [];
        for (var lc = 0; lc < childIds.length; lc++) {
          var sNumLazy = lc + 1;
          item.seasonProgramMap[sNumLazy] = childIds[lc];
          lazySeasons.push({
            number: sNumLazy,
            name: "Season " + sNumLazy + " · الموسم " + sNumLazy,
            episodeCount: 0,
            royaProgramId: childIds[lc]
          });
        }
        item.seasons = lazySeasons;
        state.detailsCache[royaId] = { at: Date.now(), item: item };
        state.detailsPending[royaId] = null;
        return item;
      }

      // Single-season series or program
      var singleSeasonId = childIds.length === 1 ? childIds[0] : royaId;
      var sNumber = Number((wnProg && wnProg.season_no) || 1);
      if (!Number.isFinite(sNumber) || sNumber <= 0) sNumber = 1;
      item.seasonProgramMap[sNumber] = singleSeasonId;

      if (singleSeasonId === royaId && res.epIds.length) {
        var built = buildEpisodeObjects(item, sNumber, res.epIds, det, royaId);
        item.seasonEpisodes[sNumber] = built;
        item.seasons = [{
          number: sNumber,
          name: "Season " + sNumber + " · الموسم " + sNumber,
          episodeCount: built.length,
          royaProgramId: singleSeasonId
        }];
        state.seasonCache[royaId + ":" + sNumber] = { at: Date.now(), episodes: built };
      } else {
        item.seasons = [{
          number: sNumber,
          name: "Season " + sNumber + " · الموسم " + sNumber,
          episodeCount: Number(main.episodesCount || 0),
          royaProgramId: singleSeasonId
        }];
      }
      state.detailsCache[royaId] = { at: Date.now(), item: item };
      state.detailsPending[royaId] = null;
      return item;
    }, function (err) {
      state.detailsPending[royaId] = null;
      throw err;
    });

    state.detailsPending[royaId] = p;
    return p;
  }

  function fetchSeasonAsync(royaIdOrWatchId, seasonNumber, signal) {
    var royaId = toRoyaIdFromWatchId(royaIdOrWatchId) || Number(royaIdOrWatchId);
    var sNum = Number(seasonNumber || 1);
    var cacheKey = royaId + ":" + sNum;
    var cached = state.seasonCache[cacheKey];
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return Promise.resolve(cached.episodes);
    }
    if (state.seasonPending[cacheKey]) return state.seasonPending[cacheKey];

    var p = fetchDetailsAsync(royaId, signal).then(function (item) {
      if (state.seasonCache[cacheKey] && Date.now() - state.seasonCache[cacheKey].at < CACHE_TTL_MS) {
        state.seasonPending[cacheKey] = null;
        return state.seasonCache[cacheKey].episodes;
      }
      var seasonProgId = (item.seasonProgramMap && item.seasonProgramMap[sNum]) || royaId;
      return fetchProgramRawDetails(seasonProgId, signal).then(function (raw) {
        var epIds = raw.epIds;
        if (!epIds.length && raw.details && raw.details.main && raw.details.main.watchnow_episode && raw.details.main.watchnow_episode.value) {
          epIds = [Number(raw.details.main.watchnow_episode.value)];
        }
        var built = buildEpisodeObjects(item, sNum, epIds, raw.details, seasonProgId);
        item.seasonEpisodes = item.seasonEpisodes || Object.create(null);
        item.seasonEpisodes[sNum] = built;
        if (Array.isArray(item.seasons)) {
          item.seasons.forEach(function (sObj) {
            if (sObj.number === sNum) {
              sObj.episodeCount = built.length;
              if (raw.details && raw.details.main && raw.details.main.title) {
                sObj.name = raw.details.main.title;
              }
            }
          });
        }
        state.seasonCache[cacheKey] = { at: Date.now(), episodes: built };
        state.seasonPending[cacheKey] = null;
        return built;
      });
    }, function (err) {
      state.seasonPending[cacheKey] = null;
      throw err;
    });

    state.seasonPending[cacheKey] = p;
    return p;
  }

  function findByWatchOrRoyaId(id) {
    var n = Number(id);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (state.itemsByWatchId[n]) return state.itemsByWatchId[n];
    if (state.itemsByRoyaId[n]) return state.itemsByRoyaId[n];
    var rid = toRoyaIdFromWatchId(n);
    if (rid && state.itemsByRoyaId[rid]) return state.itemsByRoyaId[rid];
    return null;
  }

  root.HorizonRoyaCatalog = {
    BACKEND_BASE: BACKEND_BASE,
    normalizeArabic: normalizeArabic,
    toWatchId: toWatchId,
    toRoyaIdFromWatchId: toRoyaIdFromWatchId,
    ensureCatalogLoaded: ensureCatalogLoaded,
    fetchDetailsAsync: fetchDetailsAsync,
    fetchSeasonAsync: fetchSeasonAsync,
    findById: findByWatchOrRoyaId,
    getCachedList: function () { return state.catalogList.slice(); },
    isLoaded: function () { return state.catalogList.length > 0; }
  };
})(typeof window !== "undefined" ? window : globalThis);
