(function (root) {
  "use strict";

  var ARABCINEMETA_BASE = "https://arabcinemeta.osamayousry.com";
  var SUBSCRIPTION_SLUGS = {
    shahid: true, netflix: true, watchit: true, osn: true,
    starzplay: true, tod: true, disney: true, prime: true, yango: true
  };

  var WORKER_CAP_KEY = "horizon-arabic-worker-cap-v1";
  var workerArabicSupported = null; // null = unknown, true/false after probe
  try {
    if (root.sessionStorage) {
      var storedCap = root.sessionStorage.getItem(WORKER_CAP_KEY);
      if (storedCap === "1") workerArabicSupported = true;
      else if (storedCap === "0") workerArabicSupported = false;
    }
  } catch (_e) {}

  function setWorkerArabicSupported(flag) {
    workerArabicSupported = !!flag;
    try {
      if (root.sessionStorage) root.sessionStorage.setItem(WORKER_CAP_KEY, flag ? "1" : "0");
    } catch (_e) {}
  }
  var dynamicByKey = Object.create(null);
  var dynamicOrder = [];
  var detailCache = Object.create(null);
  var seasonCache = Object.create(null);
  var metaCache = Object.create(null);
  var MAX_DYNAMIC_ENTRIES = 400;

  function hasArabicChars(text) {
    return /[\u0600-\u06FF]/.test(String(text || ""));
  }

  function normalizeArabic(text) {
    var s = String(text || "")
      .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, "")
      .replace(/[أإآٱ]/g, "ا")
      .replace(/ى/g, "ي")
      .replace(/ة/g, "ه")
      .replace(/ؤ/g, "و")
      .replace(/ئ/g, "ي");
    s = s.replace(/[٠-٩]/g, function (ch) {
      return String("٠١٢٣٤٥٦٧٨٩".indexOf(ch));
    });
    return s.toLowerCase()
      .replace(/[^\u0600-\u06FF\u0750-\u077F\u08A0-\u08FFa-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function stripLeadingAl(normText) {
    var words = String(normText || "").split(" ");
    var out = [];
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (!w) continue;
      if (w.length > 3 && w.indexOf("ال") === 0) out.push(w.slice(2));
      else out.push(w);
    }
    return out.join(" ");
  }

  function tokenizeBilingual(query) {
    var norm = normalizeArabic(query);
    return norm ? norm.split(" ").filter(Boolean) : [];
  }

  function stableSynthId(base, keyStr) {
    var h = 0;
    for (var i = 0; i < keyStr.length; i++) {
      h = ((h * 33) ^ keyStr.charCodeAt(i)) >>> 0;
    }
    return base + (h % 900000);
  }

  function yearOf(dateStr) {
    var m = /^(\d{4})/.exec(String(dateStr || ""));
    return m ? Number(m[1]) : 0;
  }

  function yearsCompatible(dateA, dateB) {
    var yA = yearOf(dateA);
    var yB = yearOf(dateB);
    if (!yA || !yB) return true;
    return Math.abs(yA - yB) <= 1;
  }

  function fetchWithTimeout(fetcher, url, opts, timeoutMs, externalSignal) {
    var fn = fetcher || root.fetch;
    if (typeof fn !== "function") {
      return Promise.reject(new Error("fetch_unavailable"));
    }
    var hasAbort = typeof AbortController === "function";
    var ctrl = hasAbort ? new AbortController() : null;
    var timer = null;
    var onExternalAbort = null;
    if (ctrl && externalSignal) {
      if (externalSignal.aborted) {
        ctrl.abort();
      } else if (typeof externalSignal.addEventListener === "function") {
        onExternalAbort = function () { ctrl.abort(); };
        externalSignal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }
    if (ctrl && timeoutMs > 0) {
      timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
    }
    var reqOpts = opts ? Object.assign({}, opts) : {};
    if (ctrl) reqOpts.signal = ctrl.signal;
    return fn(url, reqOpts).then(function (res) {
      if (timer) clearTimeout(timer);
      if (ctrl && externalSignal && onExternalAbort && typeof externalSignal.removeEventListener === "function") {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
      return res;
    }, function (err) {
      if (timer) clearTimeout(timer);
      if (ctrl && externalSignal && onExternalAbort && typeof externalSignal.removeEventListener === "function") {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
      throw err;
    });
  }

  function rememberDynamic(item) {
    if (!item || !item.type || !item.id) return item;
    var k = item.type + ":" + item.id;
    if (!dynamicByKey[k]) {
      dynamicOrder.push(k);
      if (dynamicOrder.length > MAX_DYNAMIC_ENTRIES) {
        var dropKey = dynamicOrder.shift();
        delete dynamicByKey[dropKey];
      }
    }
    dynamicByKey[k] = item;
    return item;
  }

  function getDynamicByKey(type, id) {
    var k = String(type || "tv") + ":" + Number(id);
    return dynamicByKey[k] || null;
  }

  function classifyAvailability(item) {
    if (!item) {
      return {
        state: "unavailable",
        label: "Unavailable",
        detail: "No verified playback source."
      };
    }
    if (item.plus) {
      return {
        state: "subscription_required",
        label: "Subscription Required · Roya Plus",
        detail: "Roya Plus subscription is required. Unauthorized playback is disabled."
      };
    }
    if (item.royaSeriesId || item.archiveSource || item.youtubeId || item.availability === "in-app") {
      if (item.royaSeriesId) {
        return {
          state: "playable",
          label: "Playable in Horizon · Roya TV HLS",
          detail: "Authorized Roya TV HLS stream (" + item.royaSeriesId + ")."
        };
      }
      if (item.archiveSource) {
        return {
          state: "playable",
          label: "Playable in Horizon · Archive.org MP4",
          detail: "Verified public-domain Archive.org MP4 stream."
        };
      }
      if (item.youtubeId) {
        return {
          state: "playable",
          label: "Playable in Horizon · YouTube Official",
          detail: "Verified official broadcast YouTube upload."
        };
      }
    }
    if (item.officialApp && item.officialApp.appId) {
      return {
        state: "listed_on_provider",
        label: "Open on Official App · " + item.officialApp.appName,
        detail: "Official LG TV app launch available (" + item.officialApp.appName + ")."
      };
    }
    var platforms = Array.isArray(item.regionalPlatforms) ? item.regionalPlatforms : [];
    var tmdbProvs = Array.isArray(item.watchProviders) ? item.watchProviders : [];
    var names = [];
    var hasSub = false;
    var i;
    for (i = 0; i < platforms.length; i++) {
      var p = platforms[i];
      if (!p) continue;
      var pname = p.nameEn || p.nameAr || p.slug;
      if (pname && names.indexOf(pname) < 0) names.push(pname);
      if (p.tier === "subscription" || SUBSCRIPTION_SLUGS[String(p.slug || "").toLowerCase()]) hasSub = true;
    }
    for (i = 0; i < tmdbProvs.length; i++) {
      var wp = tmdbProvs[i];
      if (!wp || !wp.name) continue;
      if (names.indexOf(wp.name) < 0) names.push(wp.name);
      if (wp.tier === "subscription" || /shahid|netflix|watch\s*it|osn|starzplay|tod|yango|prime/i.test(wp.name)) hasSub = true;
    }
    if (names.length) {
      var platSummary = names.slice(0, 3).join(" · ");
      if (hasSub) {
        return {
          state: "subscription_required",
          label: "Subscription Required · " + platSummary,
          detail: "Listed on " + platSummary + ". No public unauthenticated stream exists for in-app Horizon playback."
        };
      }
      return {
        state: "listed_on_provider",
        label: "Listed on Provider · " + platSummary,
        detail: "Reported on " + platSummary + ". External broadcaster platform — no verified direct Horizon stream."
      };
    }
    return {
      state: "metadata_only",
      label: "Discoverable Only · No Stream in Horizon",
      detail: "Metadata verified across Arabic databases; no playable Horizon stream is currently linked."
    };
  }

  function queryWorkerArabic(fetcher, query, typeFilter, signal) {
    var encodedQ = encodeURIComponent(query);
    var encodedType = encodeURIComponent(typeFilter || "all");
    function formatLegacyPayload(data) {
      return {
        sourceMode: "worker_legacy",
        results: (data && Array.isArray(data.results) ? data.results : []).map(function (r) {
          return Object.assign({}, r, {
            tmdbId: r.id,
            hasTmdbId: true,
            titleAr: hasArabicChars(r.originalTitle) ? r.originalTitle : (hasArabicChars(r.title) ? r.title : ""),
            titleEn: !hasArabicChars(r.title) ? r.title : "",
            sources: ["tmdb"]
          });
        }),
        sources: { tmdb: true, shoofAflam: false }
      };
    }
    function runArabicEndpoint() {
      return fetchWithTimeout(fetcher, "/api/arabic/search?q=" + encodedQ + "&type=" + encodedType, null, 5000, signal)
        .then(function (res) {
          if (res.status === 400 || res.status === 404) {
            setWorkerArabicSupported(false);
            return runLegacySearch(false);
          }
          if (!res.ok) {
            var err = new Error("worker_arabic_" + res.status);
            err.status = res.status;
            throw err;
          }
          setWorkerArabicSupported(true);
          return res.json().then(function (data) {
            return {
              sourceMode: "worker_arabic",
              results: (data && Array.isArray(data.results)) ? data.results : [],
              sources: (data && data.sources) || { tmdb: true, shoofAflam: false },
              attribution: (data && data.attribution) || { tmdb: "TMDB" }
            };
          });
        });
    }
    function runLegacySearch(allowUpgrade) {
      return fetchWithTimeout(fetcher, "/api/search?q=" + encodedQ + "&type=" + encodedType, null, 4500, signal)
        .then(function (res) {
          if (!res.ok) {
            var err = new Error("worker_search_" + res.status);
            err.status = res.status;
            throw err;
          }
          var hasArabicApi = Boolean(res.headers && typeof res.headers.get === "function"
            && res.headers.get("x-horizon-arabic-api") === "1");
          if (allowUpgrade && hasArabicApi) {
            setWorkerArabicSupported(true);
            return runArabicEndpoint();
          }
          if (workerArabicSupported === null) {
            setWorkerArabicSupported(hasArabicApi);
          }
          return res.json().then(formatLegacyPayload);
        });
    }
    if (workerArabicSupported === true) {
      return runArabicEndpoint();
    }
    if (workerArabicSupported === false) {
      return runLegacySearch(false);
    }
    // Probe capability safely on 200 /api/search so legacy preview Workers never emit HTTP 400 console errors.
    return runLegacySearch(true);
  }

  function isCredibleArabCinemetaMatch(metaName, normQ, stripQ, tokens, queryIsArabic) {
    var name = String(metaName || "");
    var n = normalizeArabic(name);
    if (!n) return false;
    var s = stripLeadingAl(n);
    if (n.indexOf(normQ) >= 0 || s.indexOf(stripQ) >= 0 || normQ.indexOf(n) >= 0) return true;
    var matchedCount = 0;
    for (var i = 0; i < tokens.length; i++) {
      var tok = tokens[i];
      if (tok.length >= 2 && (n.indexOf(tok) >= 0 || s.indexOf(stripLeadingAl(tok)) >= 0)) {
        matchedCount++;
      }
    }
    if (matchedCount >= tokens.length && matchedCount > 0) return true;
    if (queryIsArabic && !hasArabicChars(name)) return false;
    return matchedCount > 0;
  }

  function parseArabCinemetaItem(meta, mediaType) {
    var rawId = String(meta.id || "");
    var tmdbMatch = /^tmdb:(\d+)$/.exec(rawId);
    var imdbMatch = /^(tt\d{5,12})$/.exec(rawId);
    var tmdbId = tmdbMatch ? Number(tmdbMatch[1]) : null;
    var imdbId = imdbMatch ? imdbMatch[1] : null;
    var yearText = String(meta.releaseInfo || "").slice(0, 4);
    var synthId = tmdbId || stableSynthId(7000000, mediaType + ":" + rawId);
    return {
      id: synthId,
      tmdbId: tmdbId,
      hasTmdbId: Boolean(tmdbId),
      imdbId: imdbId,
      type: mediaType,
      title: String(meta.name || "").slice(0, 160),
      titleAr: hasArabicChars(meta.name) ? String(meta.name).slice(0, 160) : "",
      titleEn: !hasArabicChars(meta.name) ? String(meta.name).slice(0, 160) : "",
      date: /^\d{4}$/.test(yearText) ? (yearText + "-01-01") : "",
      poster: typeof meta.poster === "string" ? meta.poster : "",
      backdrop: typeof meta.background === "string" ? meta.background : "",
      overview: typeof meta.description === "string" ? meta.description.slice(0, 1200) : "",
      genres: Array.isArray(meta.genres) ? meta.genres.slice(0, 6) : [],
      originalLanguage: "ar",
      popularity: 35,
      voteCount: 0,
      sources: ["arabcinemeta"],
      attribution: { arabCinemeta: "elCinema / ArabCinemeta" }
    };
  }

  function queryArabCinemeta(fetcher, query, typeFilter, signal) {
    var normQ = normalizeArabic(query);
    var stripQ = stripLeadingAl(normQ);
    var tokens = tokenizeBilingual(query);
    var queryIsArabic = hasArabicChars(query);
    if (!normQ) return Promise.resolve({ results: [], ok: true });
    var endpoints = [];
    if (typeFilter === "all" || typeFilter === "tv") {
      endpoints.push({
        type: "tv",
        url: ARABCINEMETA_BASE + "/catalog/series/elcinema-search-series/search=" + encodeURIComponent(query) + ".json"
      });
    }
    if (typeFilter === "all" || typeFilter === "movie") {
      endpoints.push({
        type: "movie",
        url: ARABCINEMETA_BASE + "/catalog/movie/elcinema-search-movies/search=" + encodeURIComponent(query) + ".json"
      });
    }
    return Promise.all(endpoints.map(function (ep) {
      return fetchWithTimeout(fetcher, ep.url, null, 3500, signal)
        .then(function (res) {
          if (!res.ok) throw new Error("ac_http_" + res.status);
          return res.json();
        })
        .then(function (payload) {
          var metas = (payload && Array.isArray(payload.metas)) ? payload.metas : [];
          var kept = [];
          for (var i = 0; i < metas.length; i++) {
            var m = metas[i];
            if (!m || !m.id || !m.name) continue;
            if (!isCredibleArabCinemetaMatch(m.name, normQ, stripQ, tokens, queryIsArabic)) continue;
            kept.push(parseArabCinemetaItem(m, ep.type));
          }
          return { ok: true, rows: kept };
        }, function () {
          return { ok: false, rows: [] };
        });
    })).then(function (parts) {
      var merged = [];
      var anyOk = false;
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].ok) anyOk = true;
        for (var j = 0; j < parts[i].rows.length; j++) merged.push(parts[i].rows[j]);
      }
      return { ok: anyOk, results: merged };
    });
  }

  function matchLocalCatalog(pool, query, typeFilter) {
    var normQ = normalizeArabic(query);
    var stripQ = stripLeadingAl(normQ);
    var tokens = tokenizeBilingual(query);
    if (!normQ) return [];
    var out = [];
    for (var i = 0; i < pool.length; i++) {
      var item = pool[i];
      if (!item || (typeFilter !== "all" && item.type !== typeFilter)) continue;
      if (item.originalLanguage && item.originalLanguage !== "ar") continue;
      var hay = normalizeArabic([
        item.titleAr,
        item.titleEn,
        item.countryLabel,
        (item.genres || []).join(" "),
        (item.cast || []).join(" "),
        (item.aliases || []).join(" ")
      ].join(" "));
      var hayStrip = stripLeadingAl(hay);
      var allToks = tokens.length > 0 && tokens.every(function (tok) {
        return hay.indexOf(tok) >= 0 || hayStrip.indexOf(stripLeadingAl(tok)) >= 0;
      });
      if (!allToks && hay.indexOf(normQ) < 0 && hayStrip.indexOf(stripQ) < 0) continue;
      out.push(Object.assign({}, item, {
        sources: item.isRoyaCatalog ? ["roya"] : ["curated"]
      }));
    }
    return out;
  }

  function mergeSourceRecords(target, incoming) {
    if (!target.titleAr && incoming.titleAr) target.titleAr = incoming.titleAr;
    if (!target.titleEn && incoming.titleEn) target.titleEn = incoming.titleEn;
    if (!target.imdbId && incoming.imdbId) target.imdbId = incoming.imdbId;
    if (!target.tmdbId && incoming.tmdbId) {
      target.tmdbId = incoming.tmdbId;
      target.hasTmdbId = true;
    }
    if (!target.poster && incoming.poster) target.poster = incoming.poster;
    if (!target.backdrop && incoming.backdrop) target.backdrop = incoming.backdrop;
    if (!target.overview && incoming.overview) target.overview = incoming.overview;
    if (!target.date && incoming.date) target.date = incoming.date;
    if ((!target.genres || !target.genres.length) && incoming.genres && incoming.genres.length) {
      target.genres = incoming.genres.slice();
    }
    if ((!target.regionalPlatforms || !target.regionalPlatforms.length) && incoming.regionalPlatforms && incoming.regionalPlatforms.length) {
      target.regionalPlatforms = incoming.regionalPlatforms.slice();
    }
    if (incoming.watchProviders && incoming.watchProviders.length) {
      target.watchProviders = (target.watchProviders || []).concat(incoming.watchProviders);
    }
    if (incoming.shoofSlug && !target.shoofSlug) target.shoofSlug = incoming.shoofSlug;
    if (incoming.popularity && (!target.popularity || incoming.popularity > target.popularity)) {
      target.popularity = incoming.popularity;
    }
    var srcList = target.sources ? target.sources.slice() : [];
    var incSrc = incoming.sources || [];
    for (var i = 0; i < incSrc.length; i++) {
      if (srcList.indexOf(incSrc[i]) < 0) srcList.push(incSrc[i]);
    }
    target.sources = srcList;
    if (incoming.royaSeriesId && !target.royaSeriesId) {
      target.royaSeriesId = incoming.royaSeriesId;
      target.isRoyaCatalog = Boolean(incoming.isRoyaCatalog);
      target.plus = Boolean(incoming.plus);
      target.availability = target.plus ? "catalog-only" : "in-app";
    }
  }

  function buildUnifiedRecords(localHits, workerHits, acHits, localPool) {
    var records = [];
    var byKey = Object.create(null);
    var byImdb = Object.create(null);

    // Build lookup map of all local+Roya titles by exact normalized title for safe playability merging
    var royaByNorm = Object.create(null);
    for (var l = 0; l < localPool.length; l++) {
      var li = localPool[l];
      if (!li) continue;
      var ln = normalizeArabic(li.titleAr || li.title);
      if (ln) {
        if (!royaByNorm[ln]) royaByNorm[ln] = [];
        royaByNorm[ln].push(li);
      }
    }

    function addOrMerge(entry) {
      var nAr = normalizeArabic(entry.titleAr || entry.title || "");
      var nEn = normalizeArabic(entry.titleEn || "");
      var sAr = stripLeadingAl(nAr);
      var i;

      // 1. Exact ID key match
      var key = entry.type + ":" + entry.id;
      if (byKey[key]) {
        mergeSourceRecords(byKey[key], entry);
        return;
      }
      // 2. Match existing IMDb ID
      if (entry.imdbId && byImdb[entry.type + ":" + entry.imdbId]) {
        mergeSourceRecords(byImdb[entry.type + ":" + entry.imdbId], entry);
        return;
      }
      // 3. Match verified local/Roya title by normalized title + type + year
      if (nAr && royaByNorm[nAr]) {
        var cands = royaByNorm[nAr];
        for (i = 0; i < cands.length; i++) {
          var cand = cands[i];
          if (cand.type === entry.type && yearsCompatible(cand.date, entry.date)
              && (cand.isRoyaCatalog || cand.availability === "in-app" || cand.officialApp || cand.id === entry.id)) {
            var existingRec = byKey[cand.type + ":" + cand.id];
            if (!existingRec) {
              existingRec = Object.assign({}, cand, {
                sources: cand.isRoyaCatalog ? ["roya"] : ["curated"]
              });
              byKey[cand.type + ":" + cand.id] = existingRec;
              records.push(existingRec);
            }
            mergeSourceRecords(existingRec, entry);
            return;
          }
        }
      }
      // 4. Match already accumulated records by normalized Arabic or English title + type + year
      for (i = 0; i < records.length; i++) {
        var r = records[i];
        if (r.type !== entry.type || !yearsCompatible(r.date, entry.date)) continue;
        var rAr = normalizeArabic(r.titleAr || r.title || "");
        var rEn = normalizeArabic(r.titleEn || "");
        var sameTitle = (nAr && rAr && (rAr === nAr || stripLeadingAl(rAr) === sAr))
          || (nEn && rEn && rEn === nEn);
        if (!sameTitle) continue;
        // Prefer real TMDB ID over synthetic non-TMDB IDs
        if (entry.hasTmdbId && !r.hasTmdbId && !r.isRoyaCatalog && r.availability !== "in-app") {
          delete byKey[r.type + ":" + r.id];
          r.id = entry.id;
          r.tmdbId = entry.tmdbId;
          r.hasTmdbId = true;
          byKey[r.type + ":" + r.id] = r;
        }
        mergeSourceRecords(r, entry);
        if (r.imdbId) byImdb[r.type + ":" + r.imdbId] = r;
        return;
      }

      var copy = Object.assign({}, entry);
      byKey[key] = copy;
      if (copy.imdbId) byImdb[copy.type + ":" + copy.imdbId] = copy;
      records.push(copy);
    }

    var idx;
    for (idx = 0; idx < localHits.length; idx++) addOrMerge(localHits[idx]);
    for (idx = 0; idx < workerHits.length; idx++) addOrMerge(workerHits[idx]);
    for (idx = 0; idx < acHits.length; idx++) addOrMerge(acHits[idx]);
    return records;
  }

  function scoreRecord(item, query, normQ, stripQ, tokens, queryIsArabic) {
    var ar = normalizeArabic(item.titleAr || item.title || "");
    var orig = normalizeArabic(item.originalTitle || "");
    var en = normalizeArabic(item.titleEn || "");
    var arStrip = stripLeadingAl(ar);
    var s = 0;

    if (ar === normQ || orig === normQ || en === normQ) s += 1200;
    else if (arStrip && arStrip === stripQ) s += 1100;
    else if (ar.indexOf(normQ) === 0 || orig.indexOf(normQ) === 0 || en.indexOf(normQ) === 0) s += 750;
    else if (arStrip.indexOf(stripQ) === 0) s += 680;
    else if (tokens.length > 0 && tokens.every(function (t) { return ar.indexOf(t) >= 0 || en.indexOf(t) >= 0; })) s += 520;
    else if (ar.indexOf(normQ) >= 0 || en.indexOf(normQ) >= 0) s += 300;
    else s += 120;

    if (item.originalLanguage === "ar" || hasArabicChars(item.titleAr || item.title)) s += 240;
    else if (queryIsArabic) s -= 260;

    var avail = classifyAvailability(item);
    if (avail.state === "playable") s += 95;
    else if (avail.state === "subscription_required" || avail.state === "listed_on_provider") s += 45;

    if (item.sources && item.sources.length > 1) s += item.sources.length * 18;
    s += Math.min(80, Math.log(1 + (item.popularity || 0)) * 9);
    if (item.date && yearOf(item.date) >= 2020) s += 15;
    return s;
  }

  function finalizeUnifiedItem(item) {
    var avail = classifyAvailability(item);
    var ar = item.titleAr || (hasArabicChars(item.title) ? item.title : (item.originalTitle || item.title || ""));
    var en = item.titleEn || (!hasArabicChars(item.title) ? item.title : "");
    var titleText = (en && ar && en !== ar) ? (ar + " · " + en) : (ar || en || item.title || "Untitled");
    var country = item.countryLabel || (item.originalLanguage === "ar" ? "عربي · Arabic" : "");
    var provenance = (item.sources || []).join(" + ") || "catalog";

    var normalized = Object.assign({}, item, {
      title: ar || en || item.title,
      titleAr: ar,
      titleEn: en,
      originalLanguage: item.originalLanguage || "ar",
      countryLabel: country,
      availabilityState: avail.state,
      availability: avail.state === "playable" ? "in-app" : (item.officialApp ? "official-app" : "catalog-only"),
      availabilityLabel: avail.label,
      availabilityDetail: item.availabilityDetail || avail.detail,
      provenance: provenance,
      summaryTitle: titleText
    });
    rememberDynamic(normalized);
    return normalized;
  }

  function searchMultiSource(query, typeFilter, options) {
    options = options || {};
    var startedAt = Date.now();
    var q = String(query || "").trim();
    var filter = (typeFilter === "movie" || typeFilter === "tv") ? typeFilter : "all";
    var normQ = normalizeArabic(q);
    var stripQ = stripLeadingAl(normQ);
    var tokens = tokenizeBilingual(q);
    var queryIsArabic = hasArabicChars(q);
    var page = Math.max(1, Number(options.page) || 1);
    var pageSize = Math.max(1, Math.min(60, Number(options.pageSize) || 24));
    var fetcher = options.fetch || root.fetch;
    var signal = options.signal;
    var localPool = Array.isArray(options.localPool) ? options.localPool : [];
    var royaLoader = options.royaLoader || Promise.resolve([]);

    if (!normQ) {
      return Promise.resolve({
        results: [], page: page, pageSize: pageSize, totalResults: 0,
        totalPages: 1, hasMore: false, preRanked: true,
        metrics: { elapsedMs: 0, sources: {}, deduplicatedCount: 0 }
      });
    }

    var workerPromise = queryWorkerArabic(fetcher, q, filter, signal)
      .then(function (data) { return { ok: true, data: data }; }, function (err) {
        if (err && err.name === "AbortError") throw err;
        return { ok: false, error: err && err.message ? err.message : "worker_failed", data: { results: [] } };
      });

    var acPromise = queryArabCinemeta(fetcher, q, filter, signal)
      .catch(function (err) {
        if (err && err.name === "AbortError") throw err;
        return { ok: false, results: [] };
      });

    var royaPromise = Promise.resolve(royaLoader)
      .then(function () { return { ok: true, pool: typeof options.getLocalPool === "function" ? options.getLocalPool() : localPool }; })
      .catch(function () { return { ok: false, pool: localPool }; });

    return Promise.all([workerPromise, acPromise, royaPromise]).then(function (settled) {
      var wRes = settled[0];
      var acRes = settled[1];
      var rRes = settled[2];
      var pool = rRes.pool || [];
      var localHits = matchLocalCatalog(pool, q, filter);
      var workerHits = (wRes.data && wRes.data.results) || [];
      var acHits = acRes.results || [];

      var unified = buildUnifiedRecords(localHits, workerHits, acHits, pool);
      var filtered = unified.filter(function (row) {
        if (filter !== "all" && row.type !== filter) return false;
        // Exclude pure non-Arabic noise if query is Arabic and item is not Arabic
        if (queryIsArabic && row.originalLanguage && row.originalLanguage !== "ar" && !hasArabicChars(row.titleAr || row.title)) {
          return false;
        }
        return true;
      }).map(finalizeUnifiedItem);

      filtered.sort(function (a, b) {
        var sa = scoreRecord(a, q, normQ, stripQ, tokens, queryIsArabic);
        var sb = scoreRecord(b, q, normQ, stripQ, tokens, queryIsArabic);
        if (sb !== sa) return sb - sa;
        return (b.popularity || 0) - (a.popularity || 0);
      });

      var totalResults = filtered.length;
      var totalPages = Math.max(1, Math.ceil(totalResults / pageSize));
      var start = (page - 1) * pageSize;
      var paged = filtered.slice(start, start + pageSize);

      return {
        results: paged,
        page: page,
        pageSize: pageSize,
        totalResults: totalResults,
        totalPages: totalPages,
        hasMore: start + pageSize < totalResults,
        preRanked: true,
        metrics: {
          elapsedMs: Date.now() - startedAt,
          sources: {
            tmdb: wRes.ok && Boolean(wRes.data && wRes.data.sources && wRes.data.sources.tmdb !== false),
            shoofAflam: Boolean(wRes.ok && wRes.data && wRes.data.sources && wRes.data.sources.shoofAflam),
            arabCinemeta: Boolean(acRes.ok),
            roya: Boolean(rRes.ok)
          },
          sourceCounts: {
            localRoya: localHits.length,
            workerTmdbShoof: workerHits.length,
            arabCinemeta: acHits.length
          },
          deduplicatedCount: totalResults
        }
      };
    });
  }

  function fetchArabCinemetaMeta(fetcher, mediaType, lookupId, signal) {
    if (!lookupId) return Promise.resolve(null);
    var acType = mediaType === "movie" ? "movie" : "series";
    var cacheKey = acType + ":" + lookupId;
    if (metaCache[cacheKey]) return Promise.resolve(metaCache[cacheKey]);
    var url = ARABCINEMETA_BASE + "/meta/" + acType + "/" + encodeURIComponent(lookupId) + ".json";
    return fetchWithTimeout(fetcher, url, null, 4000, signal)
      .then(function (res) {
        if (!res.ok) return null;
        return res.json();
      })
      .then(function (payload) {
        var meta = payload && payload.meta ? payload.meta : null;
        if (meta) metaCache[cacheKey] = meta;
        return meta;
      }, function () {
        return null;
      });
  }

  function extractSeasonsFromVideos(videos) {
    if (!Array.isArray(videos) || !videos.length) return [];
    var counts = Object.create(null);
    var nums = [];
    for (var i = 0; i < videos.length; i++) {
      var v = videos[i];
      var s = Number(v && v.season);
      if (!s || s <= 0 || s > 100) continue;
      if (!counts[s]) {
        counts[s] = 0;
        nums.push(s);
      }
      counts[s] += 1;
    }
    nums.sort(function (a, b) { return a - b; });
    return nums.map(function (n) {
      return { number: n, count: counts[n], episodeCount: counts[n], name: "الموسم " + n + " · Season " + n };
    });
  }

  function fetchUniversalDetail(type, id, existingItem, options) {
    options = options || {};
    var fetcher = options.fetch || root.fetch;
    var signal = options.signal;
    var numId = Number(id);
    var key = String(type || "tv") + ":" + numId;
    if (detailCache[key]) return Promise.resolve(detailCache[key]);

    var baseItem = existingItem || getDynamicByKey(type, numId);
    var hasTmdb = (baseItem && baseItem.hasTmdbId && baseItem.tmdbId) || (numId > 0 && numId < 7000000);
    var tmdbId = (baseItem && baseItem.tmdbId) || (hasTmdb ? numId : null);

    var workerDetailPromise = Promise.resolve(null);
    if (tmdbId) {
      var runLegacyDetail = function () {
        return Promise.all([
          fetchWithTimeout(fetcher, "/api/title/" + type + "/" + tmdbId, null, 4500, signal)
            .then(function (r) { return r.ok ? r.json() : null; }, function () { return null; }),
          fetchWithTimeout(fetcher, "/api/providers/" + type + "/" + tmdbId, null, 3500, signal)
            .then(function (r) { return r.ok ? r.json() : null; }, function () { return null; })
        ]).then(function (pair) {
          var det = pair[0];
          if (!det) return null;
          var prov = pair[1];
          if (prov) {
            var wp = [];
            (prov.stream || []).forEach(function (p) { wp.push({ id: p.id, name: p.name, tier: "subscription", region: "US" }); });
            (prov.free || []).forEach(function (p) { wp.push({ id: p.id, name: p.name, tier: "free", region: "US" }); });
            det.watchProviders = wp;
          }
          return det;
        });
      };

      if (workerArabicSupported !== true) {
        workerDetailPromise = runLegacyDetail();
      } else {
        workerDetailPromise = fetchWithTimeout(fetcher, "/api/arabic/title/" + type + "/" + tmdbId, null, 4500, signal)
          .then(function (r) {
            if (r.status === 400 || r.status === 404) {
              setWorkerArabicSupported(false);
              return runLegacyDetail();
            }
            if (!r.ok) return null;
            setWorkerArabicSupported(true);
            return r.json();
          }, function () {
            return null;
          });
      }
    }

    var acLookup = (baseItem && baseItem.imdbId) ? baseItem.imdbId : (tmdbId ? ("tmdb:" + tmdbId) : null);
    var acMetaPromise = fetchArabCinemetaMeta(fetcher, type, acLookup, signal);

    return Promise.all([workerDetailPromise, acMetaPromise]).then(function (pair) {
      var wDet = pair[0];
      var acMeta = pair[1];
      var merged = Object.assign({}, baseItem || { type: type, id: numId });

      if (wDet) {
        merged.date = wDet.date || merged.date || "";
        merged.rating = wDet.rating || merged.rating || "";
        merged.runtime = wDet.runtime || merged.runtime || null;
        merged.episodeRuntime = wDet.episodeRuntime || merged.episodeRuntime || null;
        merged.genres = (wDet.genres && wDet.genres.length) ? wDet.genres : (merged.genres || []);
        merged.cast = (wDet.cast && wDet.cast.length) ? wDet.cast : (merged.cast || []);
        merged.creators = wDet.creators || merged.creators || [];
        merged.directors = wDet.directors || merged.directors || [];
        merged.network = (wDet.networks && wDet.networks.length ? wDet.networks.join(", ") : "") || merged.network || "";
        merged.status = wDet.status || merged.status || "";
        merged.tvdbId = wDet.tvdbId || merged.tvdbId || null;
        merged.imdbId = wDet.imdbId || merged.imdbId || null;
        merged.poster = wDet.poster || merged.poster || "";
        merged.backdrop = wDet.backdrop || merged.backdrop || "";
        merged.titleAr = wDet.titleAr || (hasArabicChars(wDet.originalTitle) ? wDet.originalTitle : merged.titleAr) || "";
        merged.titleEn = wDet.titleEn || (!hasArabicChars(wDet.title) ? wDet.title : merged.titleEn) || "";
        merged.overview = wDet.overview || merged.overview || "";
        if (Array.isArray(wDet.seasons) && wDet.seasons.length) merged.seasons = wDet.seasons;
        if (Array.isArray(wDet.regionalPlatforms) && wDet.regionalPlatforms.length) {
          merged.regionalPlatforms = wDet.regionalPlatforms;
        }
        if (Array.isArray(wDet.watchProviders) && wDet.watchProviders.length) {
          merged.watchProviders = wDet.watchProviders;
        }
      }

      if (acMeta) {
        if (hasArabicChars(acMeta.name)) merged.titleAr = acMeta.name;
        if (hasArabicChars(acMeta.description) || !merged.overview) {
          merged.overview = acMeta.description || merged.overview || "";
        }
        if (!merged.poster && acMeta.poster) merged.poster = acMeta.poster;
        if (!merged.backdrop && acMeta.background) merged.backdrop = acMeta.background;
        if ((!merged.cast || !merged.cast.length) && Array.isArray(acMeta.cast)) merged.cast = acMeta.cast.slice(0, 6);
        if ((!merged.genres || !merged.genres.length) && Array.isArray(acMeta.genres)) merged.genres = acMeta.genres.slice(0, 6);
        if (Array.isArray(acMeta.videos) && acMeta.videos.length) {
          merged.acVideos = acMeta.videos;
          if (!merged.seasons || !merged.seasons.length) {
            merged.seasons = extractSeasonsFromVideos(acMeta.videos);
          }
        }
        merged.sources = (merged.sources || []);
        if (merged.sources.indexOf("arabcinemeta") < 0) merged.sources.push("arabcinemeta");
      }

      var finalized = finalizeUnifiedItem(merged);
      if (!finalized.hasTmdbId && (finalized.titleAr || finalized.titleEn)) {
        var lookupQuery = finalized.titleAr || finalized.titleEn;
        return queryWorkerArabic(fetcher, lookupQuery, type, signal).then(function (wData) {
          var candidates = (wData && Array.isArray(wData.results)) ? wData.results : [];
          var nAr = normalizeArabic(finalized.titleAr || finalized.title || "");
          var sAr = stripLeadingAl(nAr);
          var nEn = normalizeArabic(finalized.titleEn || "");
          for (var c = 0; c < candidates.length; c++) {
            var cand = candidates[c];
            if (!cand || cand.type !== type || !yearsCompatible(cand.date, finalized.date)) continue;
            var candTmdb = Number(cand.tmdbId || cand.id);
            if (!Number.isFinite(candTmdb) || candTmdb <= 0 || candTmdb >= 7000000) continue;
            var cAr = normalizeArabic(cand.titleAr || cand.originalTitle || cand.title || "");
            var cEn = normalizeArabic(cand.titleEn || cand.title || "");
            var same = (nAr && cAr && (cAr === nAr || stripLeadingAl(cAr) === sAr))
              || (nEn && cEn && cEn === nEn);
            if (!same) continue;
            merged.tmdbId = candTmdb;
            merged.hasTmdbId = true;
            if (cand.date && (!merged.date || /-01-01$/.test(merged.date))) merged.date = cand.date;
            if (!merged.poster && cand.poster) merged.poster = cand.poster;
            if (!merged.backdrop && cand.backdrop) merged.backdrop = cand.backdrop;
            merged.sources = (merged.sources || []);
            if (merged.sources.indexOf("tmdb") < 0) merged.sources.unshift("tmdb");
            finalized = finalizeUnifiedItem(merged);
            break;
          }
          detailCache[key] = finalized;
          return finalized;
        }, function () {
          detailCache[key] = finalized;
          return finalized;
        });
      }
      detailCache[key] = finalized;
      return finalized;
    });
  }

  function fetchUniversalSeason(id, seasonNumber, existingItem, options) {
    options = options || {};
    var fetcher = options.fetch || root.fetch;
    var signal = options.signal;
    var numId = Number(id);
    var sNum = Number(seasonNumber);
    var cacheKey = numId + ":" + sNum;
    if (seasonCache[cacheKey]) return Promise.resolve(seasonCache[cacheKey]);

    var baseItem = existingItem || getDynamicByKey("tv", numId);
    var hasTmdb = (baseItem && baseItem.hasTmdbId && baseItem.tmdbId) || (numId > 0 && numId < 7000000);
    var tmdbId = (baseItem && baseItem.tmdbId) || (hasTmdb ? numId : null);

    var workerSeasonPromise = Promise.resolve([]);
    if (tmdbId) {
      var runLegacySeason = function () {
        return fetchWithTimeout(fetcher, "/api/season/tv/" + tmdbId + "/" + sNum, null, 4500, signal)
          .then(function (r) { return r.ok ? r.json() : null; }, function () { return null; })
          .then(function (data) { return (data && Array.isArray(data.episodes)) ? data.episodes : []; });
      };
      if (workerArabicSupported !== true) {
        workerSeasonPromise = runLegacySeason();
      } else {
        workerSeasonPromise = fetchWithTimeout(fetcher, "/api/arabic/season/tv/" + tmdbId + "/" + sNum, null, 4500, signal)
          .then(function (r) {
            if (r.status === 400 || r.status === 404) {
              setWorkerArabicSupported(false);
              return runLegacySeason();
            }
            return r.ok ? r.json().then(function (d) { return (d && Array.isArray(d.episodes)) ? d.episodes : []; }) : [];
          }, function () { return []; });
      }
    }

    var acVideos = baseItem && Array.isArray(baseItem.acVideos) ? baseItem.acVideos : null;
    var acPromise = acVideos
      ? Promise.resolve(acVideos)
      : (baseItem && (baseItem.imdbId || tmdbId)
        ? fetchArabCinemetaMeta(fetcher, "series", baseItem.imdbId || ("tmdb:" + tmdbId), signal)
          .then(function (m) { return (m && Array.isArray(m.videos)) ? m.videos : []; })
        : Promise.resolve([]));

    return Promise.all([workerSeasonPromise, acPromise]).then(function (pair) {
      var tmdbEps = pair[0] || [];
      var videos = (pair[1] || []).filter(function (v) { return Number(v && v.season) === sNum; });
      var byEpNum = Object.create(null);
      var i;
      for (i = 0; i < tmdbEps.length; i++) {
        var te = tmdbEps[i];
        byEpNum[te.number] = {
          number: te.number,
          title: te.title || ("الحلقة " + te.number),
          date: te.date || "",
          overview: te.overview || "",
          still: te.still || null,
          availability: "catalog-only"
        };
      }
      for (i = 0; i < videos.length; i++) {
        var v = videos[i];
        var epNum = Number(v.episode);
        if (!epNum || epNum <= 0) continue;
        var existing = byEpNum[epNum];
        if (!existing) {
          byEpNum[epNum] = {
            number: epNum,
            title: v.title || ("الحلقة " + epNum),
            date: v.released ? String(v.released).slice(0, 10) : "",
            overview: v.overview || "",
            still: v.thumbnail || null,
            availability: "catalog-only"
          };
        } else {
          if (hasArabicChars(v.title)) existing.title = v.title;
          if (!existing.overview && v.overview) existing.overview = v.overview;
          if (!existing.still && v.thumbnail) existing.still = v.thumbnail;
        }
      }
      var keys = Object.keys(byEpNum).map(Number).sort(function (a, b) { return a - b; });
      var result = {
        season: sNum,
        episodes: keys.map(function (k) { return byEpNum[k]; })
      };
      if (result.episodes.length) seasonCache[cacheKey] = result;
      return result;
    });
  }

  root.HorizonArabicSearchEngine = {
    normalizeArabic: normalizeArabic,
    stripLeadingAl: stripLeadingAl,
    tokenizeBilingual: tokenizeBilingual,
    hasArabicChars: hasArabicChars,
    classifyAvailability: classifyAvailability,
    searchMultiSource: searchMultiSource,
    fetchUniversalDetail: fetchUniversalDetail,
    fetchUniversalSeason: fetchUniversalSeason,
    getDynamicByKey: getDynamicByKey,
    rememberDynamic: rememberDynamic,
    _resetTestState: function () {
      workerArabicSupported = null;
      dynamicByKey = Object.create(null);
      dynamicOrder = [];
      detailCache = Object.create(null);
      seasonCache = Object.create(null);
      metaCache = Object.create(null);
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
