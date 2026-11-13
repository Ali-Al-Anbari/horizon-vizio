(function (root) {
  "use strict";

  var STOP_WORDS = new Set([
    "a", "about", "above", "after", "again", "against", "all", "am", "an", "and", "any", "are", "aren't",
    "as", "at", "be", "because", "been", "before", "being", "below", "between", "both", "but", "by",
    "can't", "cannot", "could", "couldn't", "did", "didn't", "do", "does", "doesn't", "doing", "don't",
    "down", "during", "each", "few", "for", "from", "further", "had", "hadn't", "has", "hasn't", "have",
    "haven't", "having", "he", "he'd", "he'll", "he's", "her", "here", "here's", "hers", "herself", "him",
    "himself", "his", "how", "how's", "i", "i'd", "i'll", "i'm", "i've", "if", "in", "into", "is", "isn't",
    "it", "it's", "its", "itself", "let's", "me", "more", "most", "mustn't", "my", "myself", "no", "nor",
    "not", "of", "off", "on", "once", "only", "or", "other", "ought", "our", "ours", "ourselves", "out",
    "over", "own", "same", "shan't", "she", "she'd", "she'll", "she's", "should", "shouldn't", "so", "some",
    "such", "than", "that", "that's", "the", "their", "theirs", "them", "themselves", "then", "there",
    "there's", "these", "they", "they'd", "they'll", "they're", "they've", "this", "those", "through", "to",
    "too", "under", "until", "up", "very", "was", "wasn't", "we", "we'd", "we'll", "we're", "we've", "were",
    "weren't", "what", "what's", "when", "when's", "where", "where's", "which", "while", "who", "who's",
    "whom", "why", "why's", "with", "won't", "would", "wouldn't", "you", "you'd", "you'll", "you're", "you've",
    "your", "yours", "yourself", "yourselves"
  ]);

  var MOVIE_TO_TV_GENRES = {
    28: [10759], 12: [10759], 16: [16], 35: [35], 80: [80], 99: [99], 18: [18],
    10751: [10751, 10762], 14: [10765], 36: [18, 10768], 27: [9648, 18],
    10402: [10402], 9648: [9648], 10749: [18, 10766], 878: [10765], 53: [9648, 80],
    10752: [10768], 37: [37]
  };

  var TV_TO_MOVIE_GENRES = {
    10759: [28, 12], 16: [16], 35: [35], 80: [80], 99: [99], 18: [18],
    10751: [10751], 10762: [16, 10751], 9648: [9648, 53], 10765: [878, 14],
    10766: [10749, 18], 10768: [10752, 36], 37: [37]
  };

  var GENRE_NAMES = {
    12: "Adventure", 14: "Fantasy", 16: "Animation", 18: "Drama", 27: "Horror",
    28: "Action", 35: "Comedy", 36: "History", 37: "Western", 53: "Thriller",
    80: "Crime", 99: "Documentary", 878: "Sci-Fi", 9648: "Mystery", 10402: "Music",
    10749: "Romance", 10751: "Family", 10752: "War", 10759: "Action & Adventure",
    10762: "Kids", 10763: "News", 10764: "Reality", 10765: "Sci-Fi & Fantasy",
    10766: "Soap", 10767: "Talk", 10768: "War & Politics", 10770: "TV Movie"
  };

  // Distinctive genres receive higher weight in genre matching than generic drama/comedy.
  // Animation (16) is a presentation style, not a similarity genre.
  var GENRE_WEIGHTS = {
    878: 1.5, 10765: 1.5, 27: 1.4, 9648: 1.3, 14: 1.2, 37: 1.2,
    80: 1.1, 10759: 1.1, 28: 1.1, 12: 1.1, 10752: 1.1, 10768: 1.1,
    99: 1.0, 10402: 1.0, 10751: 1.0, 10762: 1.0, 10749: 0.9, 36: 0.9,
    18: 0.7, 35: 0.7
  };

  function tokenize(text) {
    if (!text || typeof text !== "string") return [];
    return text.toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(function (word) { return word.length >= 3 && !STOP_WORDS.has(word); });
  }

  function termFrequency(tokens) {
    var counts = Object.create(null);
    for (var i = 0; i < tokens.length; i++) {
      var w = tokens[i];
      counts[w] = (counts[w] || 0) + 1;
    }
    return counts;
  }

  function textCosineSimilarity(textA, textB) {
    var tokensA = tokenize(textA), tokensB = tokenize(textB);
    if (!tokensA.length || !tokensB.length) return 0;
    var freqA = termFrequency(tokensA), freqB = termFrequency(tokensB);
    var dot = 0, normA = 0, normB = 0;
    var wordsA = Object.keys(freqA);
    for (var i = 0; i < wordsA.length; i++) {
      var w = wordsA[i], countA = freqA[w];
      normA += countA * countA;
      if (freqB[w]) dot += countA * freqB[w];
    }
    var wordsB = Object.keys(freqB);
    for (var j = 0; j < wordsB.length; j++) {
      normB += freqB[wordsB[j]] * freqB[wordsB[j]];
    }
    if (normA <= 0 || normB <= 0) return 0;
    return Math.min(1, Math.max(0, dot / (Math.sqrt(normA) * Math.sqrt(normB))));
  }

  function mapGenres(sourceType, targetType, genreIds) {
    if (!Array.isArray(genreIds) || !genreIds.length) return [];
    if (sourceType === targetType) return genreIds.slice();
    var mapping = sourceType === "movie" ? MOVIE_TO_TV_GENRES : TV_TO_MOVIE_GENRES;
    var mapped = new Set();
    genreIds.forEach(function (g) {
      var targets = mapping[g] || [g];
      targets.forEach(function (t) { mapped.add(t); });
    });
    return Array.from(mapped);
  }

  function jaccardKeywordSimilarity(seedKeywords, candidateKeywords) {
    var sKeys = Array.isArray(seedKeywords) ? seedKeywords : [];
    var cKeys = Array.isArray(candidateKeywords) ? candidateKeywords : [];
    if (!sKeys.length || !cKeys.length) return 0;
    var sSet = new Set(sKeys.map(function (k) { return typeof k === "object" ? k.id : k; }));
    var cSet = new Set(cKeys.map(function (k) { return typeof k === "object" ? k.id : k; }));
    var intersection = 0;
    sSet.forEach(function (id) { if (cSet.has(id)) intersection++; });
    var union = sSet.size + cSet.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  function genreOverlapSimilarity(seedGenres, candidateGenres) {
    // Animation (genre 16) describes presentation style, not thematic similarity.
    // Exclude genre 16 from similarity calculations so unrelated animated titles are not matched.
    var sG = (Array.isArray(seedGenres) ? seedGenres : []).filter(function (g) { return Number(g) !== 16; });
    var cG = (Array.isArray(candidateGenres) ? candidateGenres : []).filter(function (g) { return Number(g) !== 16; });
    if (!sG.length || !cG.length) return 0;
    var sSet = new Set(sG), cSet = new Set(cG);
    var intersectionWeight = 0, unionWeight = 0;
    var unionSet = new Set();
    sG.forEach(function (g) { unionSet.add(g); });
    cG.forEach(function (g) { unionSet.add(g); });
    unionSet.forEach(function (g) {
      var w = GENRE_WEIGHTS[g] || 1.0;
      unionWeight += w;
      if (sSet.has(g) && cSet.has(g)) intersectionWeight += w;
    });
    return unionWeight > 0 ? intersectionWeight / unionWeight : 0;
  }

  function bayesianQuality(voteCount, voteAverage) {
    var v = Number.isFinite(voteCount) ? Math.max(0, voteCount) : 0;
    var r = Number.isFinite(voteAverage) ? Math.max(0, Math.min(10, voteAverage)) : 0;
    var m = 50, c = 6.5; // prior confidence threshold and mean rating
    var weightedScore = (v / (v + m)) * (r / 10) + (m / (v + m)) * (c / 10);
    return Math.min(1, Math.max(0, weightedScore));
  }

  function sourceRelevance(sources) {
    if (!Array.isArray(sources) || !sources.length) return 0.2;
    var best = 0;
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i], kind = s.kind, rank = Number.isInteger(s.rank) ? s.rank : 10;
      var posScore = Math.max(0, 1 - rank / 25);
      if (kind === "recommendation") best = Math.max(best, 0.6 + 0.4 * posScore);
      else if (kind === "similar") best = Math.max(best, 0.4 + 0.4 * posScore);
      else if (kind === "discovery") best = Math.max(best, 0.5);
      else if (kind === "cross_media") best = Math.max(best, 0.55);
      else if (kind === "trending") best = Math.max(best, 0.3);
    }
    return Math.min(1, best);
  }

  function creatorOverlap(seed, candidate) {
    var sDirectors = Array.isArray(seed.directors) ? seed.directors : [];
    var sCreators = Array.isArray(seed.creators) ? seed.creators : [];
    var cDirectors = Array.isArray(candidate.directors) ? candidate.directors : [];
    var cCreators = Array.isArray(candidate.creators) ? candidate.creators : [];
    var sAuthors = new Set(sDirectors.concat(sCreators).map(function (n) { return n.toLowerCase().trim(); }));
    for (var i = 0; i < cDirectors.length; i++) {
      if (sAuthors.has(cDirectors[i].toLowerCase().trim())) return { score: 1.0, name: cDirectors[i], role: "director" };
    }
    for (var j = 0; j < cCreators.length; j++) {
      if (sAuthors.has(cCreators[j].toLowerCase().trim())) return { score: 1.0, name: cCreators[j], role: "creator" };
    }
    var sCast = Array.isArray(seed.cast) ? seed.cast : [];
    var cCast = Array.isArray(candidate.cast) ? candidate.cast : [];
    if (sCast.length && cCast.length) {
      var sCastSet = new Set(sCast.slice(0, 4).map(function (n) { return n.toLowerCase().trim(); }));
      var sharedCast = cCast.slice(0, 4).filter(function (n) { return sCastSet.has(n.toLowerCase().trim()); });
      if (sharedCast.length) return { score: Math.min(0.7, 0.35 * sharedCast.length), name: sharedCast[0], role: "cast" };
    }
    return { score: 0, name: null, role: null };
  }

  function generateMatchReason(seed, candidate, breakdown) {
    if (!breakdown) {
      var hasSem = typeof candidate.semanticSim === "number" && Number.isFinite(candidate.semanticSim) && candidate.semanticSim >= 0;
      breakdown = {
        creator: creatorOverlap(seed, candidate),
        synopsis: textCosineSimilarity(seed.overview, candidate.overview),
        semantic: hasSem ? candidate.semanticSim : null
      };
    }
    if (breakdown.creator && breakdown.creator.name) {
      if (breakdown.creator.role === "director") return "From director " + breakdown.creator.name;
      if (breakdown.creator.role === "creator") return "From creator " + breakdown.creator.name;
      if (breakdown.creator.role === "cast") return "Starring " + breakdown.creator.name;
    }
    var seedKeywords = Array.isArray(seed.keywords) ? seed.keywords : [];
    var candKeywords = Array.isArray(candidate.keywords) && candidate.keywords.length
      ? candidate.keywords : candidate.keywordIds || [];
    var sharedKwNames = [];
    seedKeywords.forEach(function (sk) {
      var skName = typeof sk === "object" ? sk.name : String(sk);
      var skId = typeof sk === "object" ? sk.id : null;
      if (candKeywords.some(function (ck) {
        var ckName = typeof ck === "object" ? ck.name : String(ck);
        var ckId = typeof ck === "object" ? ck.id : Number.isInteger(ck) ? ck : null;
        return (skId && ckId && skId === ckId) || (skName && ckName && skName.toLowerCase() === ckName.toLowerCase());
      })) {
        sharedKwNames.push(skName);
      }
    });
    if (sharedKwNames.length >= 2) {
      return "Shares themes: " + sharedKwNames.slice(0, 2).join(", ");
    }
    if (sharedKwNames.length === 1 && (breakdown.keyword >= 0.25
        || (breakdown.keyword >= 0.12 && breakdown.genre >= 0.35 && breakdown.synopsis >= 0.08))) {
      return "Shares theme: " + sharedKwNames[0];
    }
    if (breakdown.semantic >= 0.65) return "Shares thematic atmosphere";
    if (breakdown.synopsis >= 0.3) return "Similar plot descriptions";
    if (breakdown.semantic >= 0.52) return "Similar plot concepts";
    var mappedGenres = mapGenres(seed.type, candidate.type, (seed.genreIds || []).filter(function (id) { return Number(id) !== 16; }));
    var sharedG = (candidate.genreIds || []).filter(function (id) { return Number(id) !== 16 && mappedGenres.includes(id); })
      .map(function (id) { return GENRE_NAMES[id] || ""; }).filter(Boolean);
    if (sharedG.length >= 2) {
      return "Shares " + sharedG.slice(0, 2).join(" and ") + " genres";
    }
    if (sharedG.length === 1) {
      return "Shares " + sharedG[0] + " genre";
    }
    return breakdown.genre > 0 ? "Related genre discovery" : "Related title discovery";
  }

  function scoreCandidate(seed, candidate, options) {
    options = options || {};
    var seedMappedGenres = mapGenres(seed.type, candidate.type, seed.genreIds || []);
    var kwSim = jaccardKeywordSimilarity(seed.keywordIds || seed.keywords, candidate.keywordIds || candidate.keywords);
    var genreSim = genreOverlapSimilarity(seedMappedGenres, candidate.genreIds || []);
    var synopsisSim = textCosineSimilarity(seed.overview || "", candidate.overview || "");
    var sourceRel = sourceRelevance(candidate.sources || []);
    var quality = bayesianQuality(candidate.voteCount, candidate.voteAverage);
    var creator = creatorOverlap(seed, candidate);
    var crossMedia = candidate.type !== seed.type;

    var hasSemantic = typeof candidate.semanticSim === "number" && Number.isFinite(candidate.semanticSim) && candidate.semanticSim >= 0;
    var semanticSim = hasSemantic ? Math.min(1, Math.max(0, candidate.semanticSim)) : 0;

    var keywordEvidence = kwSim >= 0.25 || (kwSim >= 0.12 && genreSim >= 0.35 && synopsisSim >= 0.08);
    var semanticEvidence = hasSemantic && semanticSim >= 0.50;
    var contentEvidence = creator.score >= 0.7 || keywordEvidence || semanticEvidence
      || (synopsisSim >= 0.18 && genreSim >= 0.2)
      || (crossMedia && kwSim >= 0.05 && genreSim >= 0.65 && synopsisSim >= 0.03);
    var strongSource = sourceRel >= 0.94 || (candidate.sources || []).some(function (source) {
      return source.kind === "similar" && Number.isInteger(source.rank) && source.rank <= 2;
    });
    var strongSameMediaSource = !crossMedia && strongSource && genreSim >= 0.55
      && (candidate.genreIds || []).filter(function (id) { return Number(id) !== 16 && seedMappedGenres.includes(id); }).length >= 2;
    // Cross-media retrieval alone is not a title-level similarity signal.
    if (crossMedia) sourceRel *= 0.2 + 0.8 * Math.min(1,
      2 * kwSim + 2 * synopsisSim + 0.5 * creator.score + 0.25 * genreSim + (hasSemantic ? 0.5 * semanticSim : 0));

    var ratings = options.feedback && options.feedback.ratings || {};
    var candKey = candidate.type + ":" + candidate.id;
    var pref = ratings[candKey] === "liked" ? 0.1 : 0;
    if (ratings[candKey] === "disliked") pref = -1.0;

    // Closest match baseline weights: 25% kw, 25% source, 20% genre, 15% synopsis, 5% creator, 5% quality, 5% pref
    // When semantic embeddings are present, blend at 35% weight per benchmark findings
    var closest;
    if (hasSemantic) {
      closest = (0.35 * semanticSim) + (0.20 * sourceRel) + (0.15 * kwSim) + (0.15 * genreSim)
        + (0.05 * synopsisSim) + (0.05 * creator.score) + (0.05 * quality) + pref;
    } else {
      closest = (0.25 * kwSim) + (0.25 * sourceRel) + (0.20 * genreSim)
        + (0.15 * synopsisSim) + (0.05 * creator.score) + (0.05 * quality) + pref;
    }
    if (!contentEvidence && !strongSameMediaSource) closest = 0;

    // Same vibe: heavy plot themes, keywords, narrative atmosphere
    var vibe;
    if (hasSemantic) {
      vibe = (0.40 * semanticSim) + (0.20 * kwSim) + (0.15 * synopsisSim) + (0.15 * sourceRel) + (0.05 * genreSim) + (0.05 * quality) + pref;
    } else {
      vibe = (0.35 * kwSim) + (0.35 * synopsisSim) + (0.15 * sourceRel) + (0.10 * genreSim) + (0.05 * quality) + pref;
    }
    // Vibe requires thematic connection (keywords, synopsis, or semantic similarity)
    var vibeThematic = creator.score >= 0.7 || keywordEvidence || (hasSemantic && semanticSim >= 0.48)
      || synopsisSim >= 0.15 || (kwSim >= 0.05 && genreSim >= 0.65 && synopsisSim >= 0.04);
    if (!vibeThematic) vibe = 0;

    // Same genre, different story: high genre, low synopsis/keyword/semantic overlap
    var genreDiffStory;
    if (hasSemantic) {
      genreDiffStory = (0.50 * genreSim) + (0.25 * quality) + (0.25 * sourceRel) - (0.15 * semanticSim) - (0.10 * synopsisSim) - (0.10 * kwSim) + pref;
    } else {
      genreDiffStory = (0.50 * genreSim) + (0.25 * quality) + (0.25 * sourceRel) - (0.20 * synopsisSim) - (0.15 * kwSim) + pref;
    }
    if (genreSim < 0.3) genreDiffStory = -1; // Must belong to same genre family

    // Hidden gems: high quality, moderate relevance, lower popularity/vote count
    var vCount = Number(candidate.voteCount) || 0;
    var vAvg = Number(candidate.voteAverage) || 0;
    var gems = 0;
    var gemEligible = (vAvg >= 7.0 && vCount >= 20 && vCount <= 6000
      && (contentEvidence || (genreSim >= 0.45 && (kwSim >= 0.05 || synopsisSim >= 0.05 || (hasSemantic && semanticSim >= 0.45)))));
    if (gemEligible) {
      var obscurityBonus = Math.max(0, 1 - (vCount / 6000)) * 0.3;
      gems = (0.35 * quality) + (0.25 * genreSim) + (0.20 * sourceRel) + (0.10 * kwSim) + obscurityBonus + pref;
    } else {
      gems = -1;
    }

    var breakdown = {
      keyword: kwSim,
      genre: genreSim,
      synopsis: synopsisSim,
      semantic: hasSemantic ? semanticSim : null,
      source: sourceRel,
      quality: quality,
      creator: creator,
      preference: pref
    };

    var matchReason = generateMatchReason(seed, candidate, breakdown);

    return {
      candidate: candidate,
      breakdown: breakdown,
      matchReason: matchReason,
      scores: {
        closest: Math.max(0, Math.round(closest * 1000) / 1000),
        vibe: Math.max(0, Math.round(vibe * 1000) / 1000),
        genreDiffStory: Math.max(0, Math.round(genreDiffStory * 1000) / 1000),
        gems: Math.max(0, Math.round(gems * 1000) / 1000)
      }
    };
  }

  function getFranchisePrefix(title) {
    if (!title) return "";
    var colon = title.indexOf(":");
    if (colon > 2) return title.slice(0, colon).toLowerCase().trim();
    var dash = title.indexOf(" - ");
    if (dash > 2) return title.slice(0, dash).toLowerCase().trim();
    return "";
  }

  function applyDiversityRerank(scoredList, scoreKey, limit) {
    limit = limit || 12;
    var selected = [], used = new Set(), franchiseCounts = Object.create(null);
    var pool = scoredList.slice().sort(function (a, b) {
      return (b.scores[scoreKey] || 0) - (a.scores[scoreKey] || 0)
        || (b.candidate.voteCount || 0) - (a.candidate.voteCount || 0);
    });

    while (selected.length < limit && selected.length < pool.length) {
      var best = null, bestAdjusted = -Infinity;
      for (var i = 0; i < pool.length; i++) {
        var item = pool[i], id = item.candidate.type + ":" + item.candidate.id;
        if (used.has(id)) continue;
        var rawScore = item.scores[scoreKey] || 0;
        var franchise = getFranchisePrefix(item.candidate.title);
        var fCount = franchise ? (franchiseCounts[franchise] || 0) : 0;
        var penalty = fCount * 0.25;
        var adjusted = rawScore - penalty;
        if (adjusted > bestAdjusted) {
          bestAdjusted = adjusted;
          best = item;
        }
      }
      if (!best || bestAdjusted <= 0) break;
      var bestId = best.candidate.type + ":" + best.candidate.id;
      used.add(bestId);
      var f = getFranchisePrefix(best.candidate.title);
      if (f) franchiseCounts[f] = (franchiseCounts[f] || 0) + 1;
      var resultCandidate = Object.assign({}, best.candidate, {
        matchReason: best.matchReason,
        discoverScore: best.scores[scoreKey]
      });
      selected.push(resultCandidate);
    }
    return selected;
  }

  function allocateDiscoverRows(scored, limit) {
    var categories = ["closest", "vibe", "genreDiffStory", "gems"];
    var lists = {}, maxScore = {}, choices = Object.create(null), assigned = Object.create(null);
    var rows = { closest: [], vibe: [], genreDiffStory: [], gems: [] };
    var byId = Object.create(null);
    scored.forEach(function (item) { byId[item.candidate.type + ":" + item.candidate.id] = item; });
    categories.forEach(function (category) {
      var eligible = scored.filter(function (item) { return item.scores[category] > 0; });
      // Four bounded candidate lists preserve the existing franchise rerank.
      lists[category] = applyDiversityRerank(eligible, category, Math.min(eligible.length, limit * 4));
      maxScore[category] = eligible.reduce(function (best, item) {
        return Math.max(best, item.scores[category]); }, 0);
      lists[category].forEach(function (item, index) {
        var identity = item.type + ":" + item.id;
        if (!choices[identity]) choices[identity] = [];
        choices[identity].push({ category: category,
          fit: item.discoverScore / maxScore[category] + 0.12 * (1 - index / lists[category].length) });
      });
    });
    // Protect the strongest close matches, then place specialist candidates in
    // their best relative category. Absolute category scores are not comparable.
    lists.closest.slice(0, 2).forEach(function (item) {
      var identity = item.type + ":" + item.id;
      if (!assigned[identity] && rows.closest.length < limit) {
        assigned[identity] = true; rows.closest.push(byId[identity]);
      }
    });
    Object.keys(choices).map(function (identity) {
      var fits = choices[identity].sort(function (a, b) { return b.fit - a.fit
        || categories.indexOf(a.category) - categories.indexOf(b.category); });
      return { identity: identity, fits: fits, margin: fits[0].fit - (fits[1] ? fits[1].fit : 0) };
    }).sort(function (a, b) { return b.margin - a.margin || b.fits[0].fit - a.fits[0].fit
      || a.identity.localeCompare(b.identity); }).forEach(function (entry) {
      if (assigned[entry.identity]) return;
      var fit = entry.fits.find(function (choice) { return rows[choice.category].length < limit; });
      if (!fit) return;
      assigned[entry.identity] = true;
      rows[fit.category].push(byId[entry.identity]);
    });
    return { closest: applyDiversityRerank(rows.closest, "closest", limit),
      vibe: applyDiversityRerank(rows.vibe, "vibe", limit),
      genre: applyDiversityRerank(rows.genreDiffStory, "genreDiffStory", limit),
      gems: applyDiversityRerank(rows.gems, "gems", limit) };
  }

  function matchesDiscoverFilters(candidate, filters) {
    if (!filters) return true;
    if (filters.style && filters.style !== "all") {
      var hasGenreArray = Array.isArray(candidate.genreIds) && candidate.genreIds.length > 0;
      var isAnimated = false;
      if (hasGenreArray) {
        isAnimated = candidate.genreIds.some(function (g) { return Number(g) === 16; });
      } else if (Array.isArray(candidate.genres) && candidate.genres.length > 0) {
        isAnimated = candidate.genres.some(function (g) {
          return Number(g) === 16 || g === "Animation" || (typeof g === "object" && (Number(g.id) === 16 || g.name === "Animation"));
        });
        hasGenreArray = true;
      }
      if (!hasGenreArray) {
        // Deliberate policy: unknown media is excluded when a specific style (animated or live_action) is selected.
        return false;
      }
      if (filters.style === "animated" && !isAnimated) return false;
      if (filters.style === "live_action" && isAnimated) return false;
    }
    if (filters.genre && Array.isArray(candidate.genreIds)) {
      var requiredGenre = Number(filters.genre);
      if (!candidate.genreIds.includes(requiredGenre)) return false;
    }
    if (filters.rating) {
      if (!candidate.rating || candidate.rating.toUpperCase() !== filters.rating.toUpperCase()) return false;
    }
    if (filters.length) {
      var rt = candidate.type === "movie" ? candidate.runtime : candidate.episodeRuntime;
      if (!Number.isFinite(rt) || rt <= 0) return false;
      if (candidate.type === "movie") {
        if (filters.length === "short" && rt >= 90) return false;
        if (filters.length === "medium" && (rt < 90 || rt > 120)) return false;
        if (filters.length === "long" && rt <= 120) return false;
      } else {
        if (filters.length === "short" && rt > 30) return false;
        if (filters.length === "medium" && (rt <= 30 || rt > 60)) return false;
        if (filters.length === "long" && rt <= 60) return false;
      }
    }
    if (filters.year) {
      var date = candidate.date || "";
      var y = parseInt(date.slice(0, 4), 10);
      if (!y) return false;
      if (filters.year === "2020s" && y < 2020) return false;
      if (filters.year === "2010s" && (y < 2010 || y > 2019)) return false;
      if (filters.year === "2000s" && (y < 2000 || y > 2009)) return false;
      if (filters.year === "older" && y >= 2000) return false;
      if (/^\d{4}$/.test(filters.year) && y !== parseInt(filters.year, 10)) return false;
    }
    return true;
  }

  function rankDiscoverCategories(seed, candidates, options) {
    options = options || {};
    var ratings = options.feedback && options.feedback.ratings || {};
    var history = Array.isArray(options.history) ? options.history : [];
    var hideFinished = options.hideFinished !== false; // default true
    var targetMedia = options.targetMedia || "same"; // "same", "movie", "tv", "both"
    var filters = options.filters || null;

    var finishedSet = new Set();
    if (hideFinished) {
      history.forEach(function (row) {
        if (!row || !row.id) return;
        var p = row.progress;
        if (row.manualWatched === true || (p && p.completed === true)) {
          finishedSet.add(row.type + ":" + row.id);
        }
      });
    }

    var seedKey = seed.type + ":" + seed.id;

    var validPool = (Array.isArray(candidates) ? candidates : []).filter(function (c) {
      if (!c || !c.id || !c.title) return false;
      var cKey = c.type + ":" + c.id;
      if (cKey === seedKey) return false; // Exclude seed
      if (ratings[cKey] === "disliked") return false; // Suppress Not Interested
      if (finishedSet.has(cKey)) return false; // Hide Finished if enabled

      // Media type filter
      if (targetMedia === "same" && c.type !== seed.type) return false;
      if (targetMedia === "movie" && c.type !== "movie") return false;
      if (targetMedia === "tv" && c.type !== "tv") return false;

      // Refinement filters (genre, length, age rating, year)
      if (filters && !matchesDiscoverFilters(c, filters)) return false;

      return true;
    });

    var scored = validPool.map(function (candidate) {
      return scoreCandidate(seed, candidate, options);
    });

    var limit = Math.max(1, Math.min(24, options.limit || 12));
    var allocated = allocateDiscoverRows(scored, limit);

    return {
      seed: seed,
      closest: allocated.closest,
      vibe: allocated.vibe,
      genre: allocated.genre,
      gems: allocated.gems,
      totalCandidates: validPool.length
    };
  }

  var api = {
    STOP_WORDS: STOP_WORDS,
    MOVIE_TO_TV_GENRES: MOVIE_TO_TV_GENRES,
    TV_TO_MOVIE_GENRES: TV_TO_MOVIE_GENRES,
    GENRE_NAMES: GENRE_NAMES,
    tokenize: tokenize,
    textCosineSimilarity: textCosineSimilarity,
    mapGenres: mapGenres,
    jaccardKeywordSimilarity: jaccardKeywordSimilarity,
    genreOverlapSimilarity: genreOverlapSimilarity,
    bayesianQuality: bayesianQuality,
    sourceRelevance: sourceRelevance,
    creatorOverlap: creatorOverlap,
    generateMatchReason: generateMatchReason,
    scoreCandidate: scoreCandidate,
    applyDiversityRerank: applyDiversityRerank,
    matchesDiscoverFilters: matchesDiscoverFilters,
    rankDiscoverCategories: rankDiscoverCategories
  };

  root.HorizonDiscoverEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
