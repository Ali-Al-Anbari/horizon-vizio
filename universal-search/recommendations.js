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
  // Feedback is independent of history and the active episode pointer.
  function resetFeedback(storage) {
    try {
      var raw = storage && storage.getItem(FEEDBACK_KEY);
      if (!storage) return false;
      if (raw) {
        var stored;
        try { stored = JSON.parse(raw); } catch (_error) { stored = null; }
        if (stored && stored.version !== 1) return false;
      }
      var current = readFeedback(storage);
      storage.setItem(FEEDBACK_KEY, JSON.stringify({ version: 1,
        revision: current.revision + 1, ratings: {} }));
      return true;
    } catch (_error) { return false; }
  }
  var TASTE_WEIGHTS = { movieSeconds: 600, episodeSeconds: 300,
    minimumFraction: 0.1, repeatCap: 3, completionBonus: 4, love: 34 };
  function meaningful(progress, type) {
    return progress.duration >= 60 && progress.position >= 60
      && (progress.position >= (type === "movie" ? TASTE_WEIGHTS.movieSeconds : TASTE_WEIGHTS.episodeSeconds)
        || progress.position / progress.duration >= TASTE_WEIGHTS.minimumFraction);
  }
  function signals(history, feedback, now) {
    var byKey = {};
    (Array.isArray(history) ? history : []).forEach(function (row) {
      var identity = row && key(row.type, row.id);
      // Only validated VidBolt progress is evidence. A launch, import, or missing progress is not.
      var progress = row && core.progressRecord(row.progress);
      if (!identity || !progress || !meaningful(progress, row.type)
          || progress.updatedAt > now + 86400000) return;
      var signal = byKey[identity] || (byKey[identity] = { type: row.type, id: row.id,
        title: row.title || "", count: 0, completed: false, lastAt: 0 });
      signal.count = Math.min(TASTE_WEIGHTS.repeatCap, signal.count + 1);
      signal.lastAt = Math.max(signal.lastAt, progress.updatedAt);
      signal.completed = signal.completed || progress.completed === true || row.manualWatched === true;
    });
    var ratings = feedback && feedback.ratings || {};
    var positives = Object.keys(byKey).filter(function (identity) {
      return ratings[identity] !== "disliked";
    }).map(function (identity) {
      var item = byKey[identity], ageDays = Math.max(0, (now - item.lastAt) / 86400000);
      item.strength = (12 + Math.max(0, item.count - 1) * 2
        + (item.completed ? TASTE_WEIGHTS.completionBonus : 0))
        * (0.5 + 0.5 * Math.exp(-ageDays / 90));
      return item;
    });
    Object.keys(ratings).forEach(function (identity) {
      if (ratings[identity] !== "liked") return;
      var parts = identity.split(":"), item = byKey[identity];
      if (!item) { item = { type: parts[0], id: Number(parts[1]), title: "", count: 0,
        completed: false, lastAt: 0 }; positives.push(item); }
      item.strength = TASTE_WEIGHTS.love + Math.min(6, item.strength || 0);
      item.liked = true;
    });
    positives.sort(function (a, b) { return b.strength - a.strength || b.lastAt - a.lastAt
      || (a.type + ":" + a.id).localeCompare(b.type + ":" + b.id); });
    return positives;
  }
  function tasteProfile(history, feedback, payload, now) {
    var positive = signals(history, feedback, Number.isFinite(now) ? now : Date.now());
    var details = Array.isArray(payload && payload.seeds) ? payload.seeds : [];
    var genres = {}, keywords = {};
    positive.forEach(function (item) {
      var detail = details.find(function (row) { return row.type === item.type && row.id === item.id; });
      if (!detail) return;
      (detail.genreIds || []).forEach(function (id) { var k = item.type + ":" + id;
        genres[k] = Math.min(3, (genres[k] || 0) + item.strength / 34); });
      (detail.keywordIds || []).forEach(function (id) { var k = item.type + ":" + id;
        keywords[k] = Math.min(3, (keywords[k] || 0) + item.strength / 34); });
    });
    return { positive: positive, negative: Object.keys(feedback && feedback.ratings || {}).filter(function (k) {
      return feedback.ratings[k] === "disliked";
    }).sort(), genres: genres, keywords: keywords,
      confidence: Math.min(1, positive.reduce(function (sum, item) { return sum + item.strength; }, 0) / 80) };
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
    var profile = tasteProfile(rows, feedback, payload, now);
    var positive = profile.positive, seeds = {};
    positive.forEach(function (item) { seeds[item.type + ":" + item.id] = item; });
    var genreWeight = profile.genres, keywordWeight = profile.keywords,
      negativeGenres = {}, negativeKeywords = {};
    (payload && Array.isArray(payload.seeds) ? payload.seeds : []).forEach(function (seed) {
      var signal = seeds[key(seed.type, seed.id)];
      if (!signal) return;
      signal.title = signal.title || seed.title || "";
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
      var relevance = similarity + genre + keyword;
      // A single verified watch is useful evidence; Love It reaches full confidence sooner.
      // Keep the full quality score at cold start and for strongly related candidates.
      var confidence = Math.min(1, profile.confidence * 5);
      var qualityShare = 1 - 0.65 * confidence * (1 - Math.min(1, relevance / 24));
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
      return { candidate: candidate, score: relevance + quality * qualityShare - aversion,
        relevance: relevance, reason: reason, leadingSeed: strongest && strongest.source.seed || null };
    }).filter(Boolean);
    var output = [], used = {}, seedCounts = {}, genreCounts = {}, typeCounts = {};
    while (output.length < limit && output.length < scored.length) {
      var best = null, bestScore = -Infinity;
      scored.forEach(function (entry) {
        var identity = key(entry.candidate.type, entry.candidate.id);
        if (used[identity]) return;
        var seedWeight = Number.isFinite(options.seedDiversityWeight)
          ? Math.max(0, options.seedDiversityWeight) : 5;
        var penalty = (entry.leadingSeed ? Math.min(1, seedCounts[entry.leadingSeed] || 0)
          * seedWeight : 0)
          + Math.min(2, typeCounts[entry.candidate.type] || 0)
          + Math.min(6, (entry.candidate.genreIds || []).reduce(function (sum, id) {
            return sum + Math.min(2, genreCounts[id] || 0) * 1.5; }, 0));
        // Variety is a tie-breaker, not a reason to bury a clear seed/metadata match.
        penalty *= 1 - Math.min(0.3, entry.relevance / 80);
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
  var GENRE_NAMES = {
    12: "Adventure", 14: "Fantasy", 16: "Animation", 18: "Drama", 27: "Horror",
    28: "Action", 35: "Comedy", 36: "History", 37: "Western", 53: "Thriller",
    80: "Crime", 99: "Documentary", 878: "Sci-Fi", 9648: "Mystery", 10402: "Music",
    10749: "Romance", 10751: "Family", 10752: "War", 10759: "Action & Adventure",
    10762: "Kids", 10763: "News", 10764: "Reality", 10765: "Sci-Fi & Fantasy",
    10766: "Soap", 10767: "Talk", 10768: "War & Politics", 10770: "TV Movie"
  };
  function selectRows(history, feedback, payload, options) {
    options = options || {};
    var now = Number.isFinite(options.now) ? options.now : Date.now();
    var top = rank(history, feedback, payload, { now: now,
      limit: Number.isInteger(options.topLimit) ? options.topLimit : 8 });
    var reserved = top.map(function (row) { return row.type + ":" + row.id; });
    var seedDetails = Array.isArray(payload && payload.seeds) ? payload.seeds : [];
    var candidates = Array.isArray(payload && payload.candidates) ? payload.candidates : [];
    var ratings = feedback && feedback.ratings || {};
    var positive = signals(history, feedback, now);
    var because = [], seed = null;
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
      var found = rank(history, feedback, { seeds: seedDetails, avoids: payload.avoids,
        candidates: related }, { now: now, reserved: reserved,
        seedDiversityWeight: 0,
        limit: Number.isInteger(options.becauseLimit) ? options.becauseLimit : 12 })
        .filter(function (candidate) { return candidate.score > 0; });
      if (found.length >= 2) {
        because = found;
        seed = { type: signal.type, id: signal.id, title: title, liked: !!signal.liked };
        break;
      }
    }
    // Generic rows share the same eligibility rules as ranked rows. Keep the
    // original candidate pool above so duplicate source relationships can merge.
    var inHistory = {}, seenCandidates = {};
    (Array.isArray(history) ? history : []).forEach(function (row) {
      var identity = row && key(row.type, row.id);
      if (identity && (row.manualWatched === true || core.progressRecord(row.progress))) inHistory[identity] = true;
    });
    candidates = candidates.filter(function (candidate) {
      var identity = candidate && key(candidate.type, candidate.id);
      if (!identity || seenCandidates[identity] || inHistory[identity]
          || ratings[identity] === "disliked" || ratings[identity] === "liked") return false;
      seenCandidates[identity] = true;
      return true;
    });

    // For You additional rows
    var forYouReserved = {};
    top.forEach(function (r) { forYouReserved[r.type + ":" + r.id] = true; });
    because.forEach(function (r) { forYouReserved[r.type + ":" + r.id] = true; });

    var trending = candidates.filter(function (c) {
      return !forYouReserved[c.type + ":" + c.id] && ratings[c.type + ":" + c.id] !== "disliked"
        && c.poster && (c.voteCount >= 20 || c.popularity >= 10);
    }).sort(function (a, b) {
      return (b.popularity || 0) - (a.popularity || 0) || (b.voteCount || 0) - (a.voteCount || 0);
    }).slice(0, 12);
    trending.forEach(function (r) { forYouReserved[r.type + ":" + r.id] = true; });

    var gems = candidates.filter(function (c) {
      return !forYouReserved[c.type + ":" + c.id] && ratings[c.type + ":" + c.id] !== "disliked"
        && c.poster && c.voteAverage >= 7.0 && c.voteCount >= 20 && c.voteCount <= 6000;
    }).sort(function (a, b) {
      return (b.voteAverage || 0) - (a.voteAverage || 0) || (b.voteCount || 0) - (a.voteCount || 0);
    }).slice(0, 12);
    gems.forEach(function (r) { forYouReserved[r.type + ":" + r.id] = true; });

    var seedGenreSet = new Set();
    seedDetails.forEach(function (s) { (s.genreIds || []).forEach(function (g) { seedGenreSet.add(g); }); });
    var explore = candidates.filter(function (c) {
      if (forYouReserved[c.type + ":" + c.id] || ratings[c.type + ":" + c.id] === "disliked" || !c.poster) return false;
      var cGenres = c.genreIds || [];
      return cGenres.length > 0 && !cGenres.some(function (g) { return seedGenreSet.has(g); });
    }).sort(function (a, b) {
      return (b.popularity || 0) - (a.popularity || 0);
    }).slice(0, 12);
    if (!explore.length) {
      explore = candidates.filter(function (c) {
        return !forYouReserved[c.type + ":" + c.id] && ratings[c.type + ":" + c.id] !== "disliked" && c.poster;
      }).slice(0, 12);
    }

    // TV Shows rows
    var tvCandidates = candidates.filter(function (c) {
      return c.type === "tv" && c.poster && ratings[c.type + ":" + c.id] !== "disliked";
    });
    var tvReserved = {};
    var tvRanked = rank(history, feedback, { seeds: seedDetails, avoids: payload.avoids, candidates: tvCandidates },
      { now: now, limit: Number.isInteger(options.tabRankedLimit) ? options.tabRankedLimit : 12 });
    tvRanked.forEach(function (r) { tvReserved[r.type + ":" + r.id] = true; });

    var tvTrending = tvCandidates.filter(function (c) {
      return !tvReserved[c.type + ":" + c.id] && (c.voteCount >= 20 || c.popularity >= 10);
    }).sort(function (a, b) { return (b.popularity || 0) - (a.popularity || 0); }).slice(0, 12);
    tvTrending.forEach(function (r) { tvReserved[r.type + ":" + r.id] = true; });

    var topTvGenre = null, topTvGenreCount = 0;
    var tvGenreCounts = {};
    positive.filter(function (p) { return p.type === "tv"; }).forEach(function (p) {
      var sd = seedDetails.find(function (s) { return s.type === "tv" && s.id === p.id; });
      if (sd) (sd.genreIds || []).forEach(function (g) { tvGenreCounts[g] = (tvGenreCounts[g] || 0) + 1; });
    });
    Object.keys(tvGenreCounts).forEach(function (g) {
      if (tvGenreCounts[g] > topTvGenreCount) { topTvGenre = Number(g); topTvGenreCount = tvGenreCounts[g]; }
    });
    var tvGenresName = topTvGenre && GENRE_NAMES[topTvGenre] ? GENRE_NAMES[topTvGenre] + " Series" : "Featured Series";
    var tvGenres = tvCandidates.filter(function (c) {
      return !tvReserved[c.type + ":" + c.id] && (!topTvGenre || (c.genreIds || []).includes(topTvGenre));
    }).slice(0, 12);
    tvGenres.forEach(function (r) { tvReserved[r.type + ":" + r.id] = true; });

    var tvShort = tvCandidates.filter(function (c) {
      var rt = Number.isFinite(c.episodeRuntime) && c.episodeRuntime > 0 ? c.episodeRuntime
        : (c.detail && Number.isFinite(c.detail.episodeRuntime) && c.detail.episodeRuntime > 0 ? c.detail.episodeRuntime
        : (options && options.runtimes && Number.isFinite(options.runtimes["tv:" + c.id]) && options.runtimes["tv:" + c.id] > 0
          ? options.runtimes["tv:" + c.id] : null));
      return rt !== null && rt <= 30;
    }).slice(0, 12);
    tvShort.forEach(function (r) { tvReserved[r.type + ":" + r.id] = true; });

    var tvGems = tvCandidates.filter(function (c) {
      return !tvReserved[c.type + ":" + c.id] && c.voteAverage >= 7.0 && c.voteCount >= 20 && c.voteCount <= 3000;
    }).sort(function (a, b) { return (b.voteAverage || 0) - (a.voteAverage || 0); }).slice(0, 12);
    tvGems.forEach(function (r) { tvReserved[r.type + ":" + r.id] = true; });

    var tvAcclaimed = tvCandidates.filter(function (c) {
      return !tvReserved[c.type + ":" + c.id] && c.voteAverage >= 7.5;
    }).sort(function (a, b) { return (b.voteAverage || 0) - (a.voteAverage || 0); }).slice(0, 12);

    // Movie rows
    var movieCandidates = candidates.filter(function (c) {
      return c.type === "movie" && c.poster && ratings[c.type + ":" + c.id] !== "disliked";
    });
    var movieReserved = {};
    var moviesRanked = rank(history, feedback, { seeds: seedDetails, avoids: payload.avoids, candidates: movieCandidates },
      { now: now, limit: Number.isInteger(options.tabRankedLimit) ? options.tabRankedLimit : 12 });
    moviesRanked.forEach(function (r) { movieReserved[r.type + ":" + r.id] = true; });

    var moviesTrending = movieCandidates.filter(function (c) {
      return !movieReserved[c.type + ":" + c.id] && (c.voteCount >= 20 || c.popularity >= 10);
    }).sort(function (a, b) { return (b.popularity || 0) - (a.popularity || 0); }).slice(0, 12);
    moviesTrending.forEach(function (r) { movieReserved[r.type + ":" + r.id] = true; });

    var topMovieGenre = null, topMovieGenreCount = 0;
    var movieGenreCounts = {};
    positive.filter(function (p) { return p.type === "movie"; }).forEach(function (p) {
      var sd = seedDetails.find(function (s) { return s.type === "movie" && s.id === p.id; });
      if (sd) (sd.genreIds || []).forEach(function (g) { movieGenreCounts[g] = (movieGenreCounts[g] || 0) + 1; });
    });
    Object.keys(movieGenreCounts).forEach(function (g) {
      if (movieGenreCounts[g] > topMovieGenreCount) { topMovieGenre = Number(g); topMovieGenreCount = movieGenreCounts[g]; }
    });
    var movieGenresName = topMovieGenre && GENRE_NAMES[topMovieGenre] ? GENRE_NAMES[topMovieGenre] + " Films" : "Featured Films";
    var moviesGenres = movieCandidates.filter(function (c) {
      return !movieReserved[c.type + ":" + c.id] && (!topMovieGenre || (c.genreIds || []).includes(topMovieGenre));
    }).slice(0, 12);
    moviesGenres.forEach(function (r) { movieReserved[r.type + ":" + r.id] = true; });

    var moviesShort = movieCandidates.filter(function (c) {
      var rt = Number.isFinite(c.runtime) && c.runtime > 0 ? c.runtime
        : (c.detail && Number.isFinite(c.detail.runtime) && c.detail.runtime > 0 ? c.detail.runtime
        : (options && options.runtimes && Number.isFinite(options.runtimes["movie:" + c.id]) && options.runtimes["movie:" + c.id] > 0
          ? options.runtimes["movie:" + c.id] : null));
      return rt !== null && rt < 100;
    }).slice(0, 12);
    moviesShort.forEach(function (r) { movieReserved[r.type + ":" + r.id] = true; });

    var moviesAcclaimed = movieCandidates.filter(function (c) {
      return !movieReserved[c.type + ":" + c.id] && c.voteAverage >= 7.5;
    }).sort(function (a, b) { return (b.voteAverage || 0) - (a.voteAverage || 0); }).slice(0, 12);
    moviesAcclaimed.forEach(function (r) { movieReserved[r.type + ":" + r.id] = true; });

    var moviesGems = movieCandidates.filter(function (c) {
      return !movieReserved[c.type + ":" + c.id] && c.voteAverage >= 7.0 && c.voteCount >= 20 && c.voteCount <= 4000;
    }).sort(function (a, b) { return (b.voteAverage || 0) - (a.voteAverage || 0); }).slice(0, 12);

    return {
      top: top, because: because, seed: seed,
      forYou: {
        top: top, because: because, trending: trending, gems: gems, explore: explore, seed: seed
      },
      tv: {
        recommended: tvRanked, trending: tvTrending, genres: tvGenres, genresHeading: tvGenresName,
        short: tvShort, gems: tvGems, acclaimed: tvAcclaimed
      },
      movies: {
        recommended: moviesRanked, trending: moviesTrending, genres: moviesGenres, genresHeading: movieGenresName,
        short: moviesShort, acclaimed: moviesAcclaimed, gems: moviesGems
      }
    };
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
    setFeedback: setFeedback, resetFeedback: resetFeedback, signals: signals,
    tasteProfile: tasteProfile, TASTE_WEIGHTS: TASTE_WEIGHTS,
    seedQuery: seedQuery, avoidQuery: avoidQuery,
    rank: rank, selectRows: selectRows, load: load, loadBundle: loadBundle, GENRE_NAMES: GENRE_NAMES };
})(typeof window !== "undefined" ? window : globalThis);
