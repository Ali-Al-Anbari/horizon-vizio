(function (root) {
  "use strict";
  var core = root.HorizonSearchCore;
  var FEEDBACK_KEY = "horizon-watch-feedback-v1";
  var CACHE_MS = 10 * 60 * 1000;
  var candidateCache = new Map();
  function key(type, id) { return (type === "movie" || type === "tv") && Number.isInteger(id)
    && id > 0 && id <= 999999999 ? type + ":" + id : null; }
  function readFeedback(storage) {
    try {
      var raw = storage && storage.getItem(FEEDBACK_KEY);
      if (!raw) return { version: 1, revision: 0, ratings: {} };
      var value = JSON.parse(raw), ratings = {};
      if (!value || value.version !== 1 || !value.ratings || typeof value.ratings !== "object"
          || Array.isArray(value.ratings)) return { version: 1, revision: 0, ratings: {} };
      Object.keys(value.ratings).slice(0, 500).forEach(function (identity) {
        var parts = /^(movie|tv):([1-9][0-9]*)$/.exec(identity);
        if (parts && key(parts[1], Number(parts[2])) === identity
            && (value.ratings[identity] === "liked" || value.ratings[identity] === "disliked"))
          ratings[identity] = value.ratings[identity];
      });
      return { version: 1, revision: Number.isSafeInteger(value.revision) && value.revision >= 0
        ? value.revision : 0, ratings: ratings };
    } catch (_error) { return { version: 1, revision: 0, ratings: {} }; }
  }
  function setFeedback(storage, type, id, state) {
    var identity = key(type, id);
    if (!storage || !identity || ["liked", "disliked", "neutral"].indexOf(state) < 0) return false;
    try {
      var raw = storage.getItem(FEEDBACK_KEY);
      if (raw) {
        var stored;
        try { stored = JSON.parse(raw); } catch (_error) { stored = null; }
        if (stored && stored.version !== 1) return false; // Preserve data from a newer schema.
      }
      var value = readFeedback(storage);
      if (!Object.prototype.hasOwnProperty.call(value.ratings, identity)
          && state !== "neutral" && Object.keys(value.ratings).length >= 500) return false;
      if (state === "neutral") delete value.ratings[identity];
      else value.ratings[identity] = state;
      value.revision += 1;
      storage.setItem(FEEDBACK_KEY, JSON.stringify(value));
      return true;
    } catch (_error) { return false; }
  }
  function signals(history, feedback, now) {
    var byKey = {};
    (Array.isArray(history) ? history : []).forEach(function (row) {
      var identity = row && key(row.type, row.id);
      // Only validated VidBolt progress is evidence. A launch, import, or missing progress is not.
      var progress = row && core.progressRecord(row.progress);
      if (!identity || !progress || progress.updatedAt > now + 86400000) return;
      var signal = byKey[identity] || (byKey[identity] = { type: row.type, id: row.id,
        title: row.title || "", count: 0, completed: false, lastAt: 0 });
      signal.count += 1; // Distinct verified TV episodes; history collapses repeat movie plays.
      signal.lastAt = Math.max(signal.lastAt, progress.updatedAt);
      signal.completed = signal.completed || progress.completed === true || row.manualWatched === true;
    });
    var ratings = feedback && feedback.ratings || {};
    var positives = Object.keys(byKey).filter(function (identity) {
      return ratings[identity] !== "disliked";
    }).map(function (identity) {
      var item = byKey[identity], ageDays = Math.max(0, (now - item.lastAt) / 86400000);
      item.strength = (12 + Math.min(6, Math.max(0, item.count - 1) * 2)
        + (item.completed ? 4 : 0)) * (0.5 + 0.5 * Math.exp(-ageDays / 90));
      return item;
    });
    Object.keys(ratings).forEach(function (identity) {
      if (ratings[identity] !== "liked") return;
      var parts = identity.split(":"), item = byKey[identity];
      if (!item) { item = { type: parts[0], id: Number(parts[1]), title: "", count: 0,
        completed: false, lastAt: 0 }; positives.push(item); }
      item.strength = 34 + Math.min(6, item.strength || 0);
      item.liked = true;
    });
    positives.sort(function (a, b) { return b.strength - a.strength || b.lastAt - a.lastAt
      || (a.type + ":" + a.id).localeCompare(b.type + ":" + b.id); });
    return positives;
  }
  function seedQuery(history, feedback, now) {
    return signals(history, feedback, now).slice(0, 3).map(function (item) {
      return item.type + ":" + item.id;
    }).join(",");
  }
  function avoidQuery(feedback) {
    return Object.keys(feedback && feedback.ratings || {}).filter(function (identity) {
      return feedback.ratings[identity] === "disliked";
    }).sort().slice(0, 2).join(",");
  }
  function rank(history, feedback, payload, options) {
    options = options || {};
    var now = Number.isFinite(options.now) ? options.now : Date.now();
    var limit = Math.max(0, Math.min(24, Number.isInteger(options.limit) ? options.limit : 12));
    var rows = Array.isArray(history) ? history : [], ratings = feedback && feedback.ratings || {};
    var positive = signals(rows, feedback, now), seeds = {};
    positive.forEach(function (item) { seeds[item.type + ":" + item.id] = item; });
    var genreWeight = {}, keywordWeight = {}, negativeGenres = {}, negativeKeywords = {};
    (payload && Array.isArray(payload.seeds) ? payload.seeds : []).forEach(function (seed) {
      var signal = seeds[key(seed.type, seed.id)];
      if (!signal) return;
      signal.title = signal.title || seed.title || "";
      (seed.genreIds || []).forEach(function (id) { var feature = seed.type + ":" + id;
        genreWeight[feature] = (genreWeight[feature] || 0) + signal.strength / 34; });
      (seed.keywordIds || []).forEach(function (id) { var feature = seed.type + ":" + id;
        keywordWeight[feature] = (keywordWeight[feature] || 0) + signal.strength / 34; });
    });
    var knownAvoids = {};
    (payload && Array.isArray(payload.avoids) ? payload.avoids : []).forEach(function (avoid) {
      if (ratings[key(avoid.type, avoid.id)] !== "disliked") return;
      knownAvoids[key(avoid.type, avoid.id)] = true;
      (avoid.genreIds || []).forEach(function (id) { var feature = avoid.type + ":" + id;
        negativeGenres[feature] = (negativeGenres[feature] || 0) + 1; });
      (avoid.keywordIds || []).forEach(function (id) { var feature = avoid.type + ":" + id;
        negativeKeywords[feature] = (negativeKeywords[feature] || 0) + 1; });
    });
    (payload && Array.isArray(payload.candidates) ? payload.candidates : []).forEach(function (candidate) {
      var identity = candidate && key(candidate.type, candidate.id);
      if (!identity || knownAvoids[identity] || ratings[identity] !== "disliked") return;
      knownAvoids[identity] = true;
      (candidate.genreIds || []).forEach(function (id) { var feature = candidate.type + ":" + id;
        negativeGenres[feature] = (negativeGenres[feature] || 0) + 1; });
      (candidate.keywordIds || []).forEach(function (id) { var feature = candidate.type + ":" + id;
        negativeKeywords[feature] = (negativeKeywords[feature] || 0) + 1; });
    });
    var excluded = {};
    rows.forEach(function (row) {
      var identity = row && key(row.type, row.id);
      if (!identity) return;
      if (row.progress && core.progressRecord(row.progress) || row.manualWatched === true)
        excluded[identity] = true; // Both completed and unfinished viewing are excluded.
    });
    Object.keys(ratings).forEach(function (identity) {
      if (ratings[identity] === "disliked" || ratings[identity] === "liked") excluded[identity] = true;
    });
    (options.reserved || []).forEach(function (identity) { excluded[identity] = true; });
    var unique = {}, candidates = Array.isArray(payload && payload.candidates) ? payload.candidates : [];
    candidates.slice(0, 240).forEach(function (candidate) {
      var identity = candidate && key(candidate.type, candidate.id);
      if (!identity || excluded[identity] || !candidate.title) return;
      var old = unique[identity];
      if (!old) unique[identity] = Object.assign({}, candidate, { sources: (candidate.sources || []).slice() });
      else {
        (candidate.sources || []).forEach(function (source) {
          if (!old.sources.some(function (item) { return item.kind === source.kind && item.seed === source.seed; }))
            old.sources.push(source);
        });
        if ((candidate.genreIds || []).length > (old.genreIds || []).length) old.genreIds = candidate.genreIds;
        if ((candidate.keywordIds || []).length > (old.keywordIds || []).length) old.keywordIds = candidate.keywordIds;
      }
    });
    var scored = Object.keys(unique).map(function (identity) {
      var candidate = unique[identity], genres = candidate.genreIds || [], keywords = candidate.keywordIds || [];
      var sourceScores = (candidate.sources || []).filter(function (source) { return seeds[source.seed]; })
        .map(function (source) { return { source: source, seed: seeds[source.seed],
          points: seeds[source.seed].strength * (source.kind === "recommendation" ? 0.8 : 0.58) }; })
        .sort(function (a, b) { return b.points - a.points; });
      var strongest = sourceScores[0], second = strongest && sourceScores.find(function (entry) {
        return entry.source.seed !== strongest.source.seed;
      });
      var similarity = strongest ? strongest.points
        + (second ? Math.min(5, second.points * 0.2) : 0) : 0;
      var matchedGenres = genres.filter(function (id) { return genreWeight[candidate.type + ":" + id] > 0; });
      var genre = Math.min(18, matchedGenres.reduce(function (sum, id) {
        return sum + Math.min(7, 5 * genreWeight[candidate.type + ":" + id]); }, 0));
      var matchedKeywords = keywords.filter(function (id) { return keywordWeight[candidate.type + ":" + id] > 0; });
      var keyword = Math.min(10, matchedKeywords.reduce(function (sum, id) {
        return sum + Math.min(5, 4 * keywordWeight[candidate.type + ":" + id]); }, 0));
      var aversion = Math.min(12, genres.reduce(function (sum, id) {
        return sum + Math.min(5, (negativeGenres[candidate.type + ":" + id] || 0) * 4); }, 0)
        + keywords.reduce(function (sum, id) { return sum + Math.min(5,
          (negativeKeywords[candidate.type + ":" + id] || 0) * 4); }, 0));
      var quality = Math.min(10, Math.log1p(Math.max(0, candidate.voteCount || 0)) * 1.4)
        + Math.min(6, Math.log1p(Math.max(0, candidate.popularity || 0)) * 1.1)
        + Math.min(4, Math.max(0, Number(candidate.voteAverage) || 0) * 0.4);
      var source = (candidate.sources || []).find(function (s) { return s.kind === "discovery"; });
      var broadSource = (candidate.sources || []).some(function (s) {
        return s.kind === "trending" || s.kind === "discovery";
      });
      if (!strongest && !matchedGenres.length && !matchedKeywords.length && !broadSource) return null;
      var reason = strongest
        ? { code: strongest.seed.liked ? "liked" : "watched", title: strongest.seed.title || null }
        : matchedGenres.length ? { code: "genres", genreIds: matchedGenres.slice(0, 2) }
        : matchedKeywords.length ? { code: "keywords", keywordIds: matchedKeywords.slice(0, 2) }
        : source && source.genreId && genreWeight[candidate.type + ":" + source.genreId]
          ? { code: "category", genreId: source.genreId }
          : { code: "popular" };
      return { candidate: candidate, score: similarity + genre + keyword + quality - aversion,
        reason: reason, leadingSeed: strongest && strongest.source.seed || null };
    }).filter(Boolean);
    var output = [], used = {}, seedCounts = {}, genreCounts = {}, typeCounts = {};
    while (output.length < limit && output.length < scored.length) {
      var best = null, bestScore = -Infinity;
      scored.forEach(function (entry) {
        var identity = key(entry.candidate.type, entry.candidate.id);
        if (used[identity]) return;
        var penalty = (entry.leadingSeed ? (seedCounts[entry.leadingSeed] || 0)
          * (Number.isFinite(options.seedDiversityWeight) ? Math.max(0, options.seedDiversityWeight) : 9) : 0)
          + (typeCounts[entry.candidate.type] || 0) * 1.5
          + (entry.candidate.genreIds || []).reduce(function (sum, id) {
            return sum + Math.min(3, genreCounts[id] || 0) * 2; }, 0);
        var score = entry.score - penalty;
        if (score > bestScore || score === bestScore && identity < key(best.candidate.type, best.candidate.id)) {
          best = entry; bestScore = score;
        }
      });
      if (!best) break;
      var identity = key(best.candidate.type, best.candidate.id); used[identity] = true;
      if (best.leadingSeed) seedCounts[best.leadingSeed] = (seedCounts[best.leadingSeed] || 0) + 1;
      typeCounts[best.candidate.type] = (typeCounts[best.candidate.type] || 0) + 1;
      (best.candidate.genreIds || []).forEach(function (id) { genreCounts[id] = (genreCounts[id] || 0) + 1; });
      output.push(Object.assign({}, best.candidate, { score: Math.round(bestScore * 100) / 100,
        reason: best.reason }));
    }
    return output;
  }
  function selectRows(history, feedback, payload, options) {
    options = options || {};
    var now = Number.isFinite(options.now) ? options.now : Date.now();
    var top = rank(history, feedback, payload, { now: now,
      limit: Number.isInteger(options.topLimit) ? options.topLimit : 8 });
    var reserved = top.map(function (row) { return row.type + ":" + row.id; });
    var seedDetails = Array.isArray(payload && payload.seeds) ? payload.seeds : [];
    var candidates = Array.isArray(payload && payload.candidates) ? payload.candidates : [];
    var positive = signals(history, feedback, now);
    for (var i = 0; i < positive.length; i++) {
      var signal = positive[i], identity = signal.type + ":" + signal.id;
      var detail = seedDetails.find(function (item) { return item.type === signal.type && item.id === signal.id; });
      var title = signal.title || detail && detail.title;
      if (!title) continue;
      var related = candidates.filter(function (candidate) {
        return candidate.poster && (candidate.voteCount >= 25 || candidate.popularity >= 20)
          && Array.isArray(candidate.sources) && candidate.sources.some(function (source) {
          return source.seed === identity && (source.kind === "recommendation" || source.kind === "similar");
        });
      }).map(function (candidate) { return Object.assign({}, candidate, { sources: candidate.sources.filter(function (source) {
        return source.seed === identity && (source.kind === "recommendation" || source.kind === "similar");
      }) }); });
      var because = rank(history, feedback, { seeds: seedDetails, avoids: payload.avoids,
        candidates: related }, { now: now, reserved: reserved,
        seedDiversityWeight: 0,
        limit: Number.isInteger(options.becauseLimit) ? options.becauseLimit : 12 })
        .filter(function (candidate) { return candidate.score > 0; });
      if (because.length >= 2) return { top: top, because: because,
        seed: { type: signal.type, id: signal.id, title: title, liked: !!signal.liked } };
    }
    return { top: top, because: [], seed: null };
  }
  async function loadBundle(storage, fetcher, options) {
    options = options || {};
    var now = Number.isFinite(options.now) ? options.now : Date.now();
    var history = core.readHistory(storage), feedback = readFeedback(storage);
    var seeds = seedQuery(history, feedback, now), avoids = avoidQuery(feedback);
    // Candidate lists depend on positive seeds. A changed Dislike reranks locally without refetching them.
    var cacheKey = seeds, cached = candidateCache.get(cacheKey), payload;
    if (cached && now - cached.at < CACHE_MS) payload = cached.payload;
    else {
      try {
        var response = await fetcher("/api/recommendations?seeds=" + encodeURIComponent(seeds)
          + "&avoid=" + encodeURIComponent(avoids));
        if (!response.ok) throw new Error("recommendations_unavailable");
        payload = await response.json();
        if (!payload || !Array.isArray(payload.candidates)) throw new Error("invalid_recommendations");
        if (candidateCache.size >= 12) candidateCache.delete(candidateCache.keys().next().value);
        candidateCache.set(cacheKey, { at: now, payload: payload });
      } catch (_error) {
        var last = Array.from(candidateCache.values()).pop();
        payload = cached ? cached.payload : last ? last.payload : { seeds: [], candidates: [] };
      }
    }
    // Read again after the request: feedback/history may have changed while it was in flight.
    var currentHistory = core.readHistory(storage), currentFeedback = readFeedback(storage);
    if (seedQuery(currentHistory, currentFeedback, now) !== seeds) {
      return loadBundle(storage, fetcher, options);
    }
    return { payload: payload, results: rank(currentHistory, currentFeedback, payload, options) };
  }
  async function load(storage, fetcher, options) {
    return (await loadBundle(storage, fetcher, options)).results;
  }
  root.HorizonWatchRecommendations = { FEEDBACK_KEY: FEEDBACK_KEY, readFeedback: readFeedback,
    setFeedback: setFeedback, signals: signals, seedQuery: seedQuery, avoidQuery: avoidQuery,
    rank: rank, selectRows: selectRows, load: load, loadBundle: loadBundle };
})(typeof window !== "undefined" ? window : globalThis);
