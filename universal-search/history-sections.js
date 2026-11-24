(function (root) {
  "use strict";

  var SECTION_ENGLISH = "english";
  var SECTION_ARABIC = "arabic";
  var ARABIC_ONLY_PROVIDERS = ["roya_tv", "akwam_relay"];

  function normalizeSection(value) {
    if (value === SECTION_ARABIC) return SECTION_ARABIC;
    return SECTION_ENGLISH;
  }

  function activeSection(storage, contentLibraryKey) {
    var key = contentLibraryKey || "horizon-watch-content-library-v1";
    if (!storage || typeof storage.getItem !== "function") return SECTION_ENGLISH;
    try {
      var parsed = JSON.parse(storage.getItem(key) || "null");
      return parsed && parsed.version === 1 && parsed.mode === SECTION_ARABIC
        ? SECTION_ARABIC
        : SECTION_ENGLISH;
    } catch (_error) {
      return SECTION_ENGLISH;
    }
  }

  /**
   * Backward-compatible classification for legacy history records lacking an explicit `section`.
   * - Explicit `row.section` ("arabic" | "english") is always respected.
   * - Legacy records are classified as "arabic" ONLY when reliable explicit provider metadata
   *   identifies an Arabic-only provider. Uncertain records safely default to "english".
   */
  function classifyRecordSection(row) {
    if (row && (row.section === SECTION_ARABIC || row.section === SECTION_ENGLISH)) {
      return row.section;
    }
    var provider = row && row.progress && typeof row.progress.provider === "string"
      ? row.progress.provider
      : "";
    if (provider && ARABIC_ONLY_PROVIDERS.indexOf(provider) >= 0) {
      return SECTION_ARABIC;
    }
    return SECTION_ENGLISH;
  }

  function withSection(row, explicitSection) {
    if (!row || typeof row !== "object") return null;
    var sec = (explicitSection === SECTION_ARABIC || explicitSection === SECTION_ENGLISH)
      ? explicitSection
      : classifyRecordSection(row);
    return Object.assign({}, row, { section: sec });
  }

  function sectionHistoryKey(row, explicitSection) {
    if (!row) return "";
    var sec = (explicitSection === SECTION_ARABIC || explicitSection === SECTION_ENGLISH)
      ? explicitSection
      : classifyRecordSection(row);
    return sec + ":" + row.type + ":" + row.id + (row.type === "tv" ? ":" + row.season + ":" + row.episode : "");
  }

  function sectionTitleKey(row, explicitSection) {
    if (!row) return "";
    var sec = (explicitSection === SECTION_ARABIC || explicitSection === SECTION_ENGLISH)
      ? explicitSection
      : classifyRecordSection(row);
    return sec + ":" + row.type + ":" + row.id;
  }

  function sectionActiveEpisodeKey(showId, section) {
    return normalizeSection(section) + ":" + String(showId);
  }

  /**
   * Migrates a list of raw/legacy history rows into deduplicated, section-tagged records
   * without erasing existing records or duplicating migrated entries.
   */
  function migrateHistoryRows(rows, normalizeItemFn) {
    if (!Array.isArray(rows)) return [];
    var seen = Object.create(null);
    var out = [];
    var normalized = rows.slice(0, 200).map(function (raw) {
      if (!raw || typeof raw !== "object") return null;
      var sec = classifyRecordSection(raw);
      var built = typeof normalizeItemFn === "function" ? normalizeItemFn(raw) : Object.assign({}, raw);
      if (!built) return null;
      built.section = sec;
      return built;
    }).filter(Boolean).sort(function (a, b) {
      return (b.at || 0) - (a.at || 0);
    });

    for (var i = 0; i < normalized.length; i++) {
      var row = normalized[i];
      var key = sectionHistoryKey(row);
      if (seen[key]) continue;
      seen[key] = true;
      out.push(row);
    }
    return out;
  }

  function filterRowsBySection(rows, section) {
    var target = normalizeSection(section);
    if (!Array.isArray(rows)) return [];
    return rows.filter(function (row) {
      return row && classifyRecordSection(row) === target;
    });
  }

  function upsertSectionRow(allRows, entry, targetSection) {
    var sec = normalizeSection(targetSection || (entry && entry.section));
    var incoming = withSection(entry, sec);
    if (!incoming) return Array.isArray(allRows) ? allRows.slice() : [];

    var migrated = migrateHistoryRows(allRows || []);
    var incomingKey = sectionHistoryKey(incoming, sec);
    var previous = migrated.find(function (row) { return sectionHistoryKey(row) === incomingKey; }) || null;

    if (!incoming.progress && previous && previous.progress) incoming.progress = previous.progress;
    if (incoming.manualWatched === null && previous) incoming.manualWatched = previous.manualWatched;
    if (previous && previous.manualOnly) incoming.manualOnly = true;
    if (incoming.progress && previous && previous.progress
        && previous.progress.updatedAt > incoming.progress.updatedAt) {
      incoming.progress = previous.progress;
      incoming.at = Math.min(incoming.at, previous.at);
    }

    var next = migrated.filter(function (row) { return sectionHistoryKey(row) !== incomingKey; });
    next.unshift(incoming);
    next.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });

    // Preserve up to 100 rows per section independently so one section never evicts the other
    var counts = { english: 0, arabic: 0 };
    return next.filter(function (row) {
      var rSec = classifyRecordSection(row);
      counts[rSec] = (counts[rSec] || 0) + 1;
      return counts[rSec] <= 100;
    });
  }

  function deleteSectionRows(allRows, section, type, id, season, episode, allTitle) {
    var target = normalizeSection(section);
    var migrated = migrateHistoryRows(allRows || []);
    var removed = [];
    var kept = migrated.filter(function (row) {
      if (classifyRecordSection(row) !== target) return true;
      var matches = row.type === type && row.id === id
        && (allTitle || row.type !== "tv" || (row.season === season && row.episode === episode));
      if (matches) {
        removed.push(row);
        return false;
      }
      return true;
    });
    return { kept: kept, removed: removed };
  }

  function clearSectionRows(allRows, section) {
    var target = normalizeSection(section);
    var migrated = migrateHistoryRows(allRows || []);
    var removed = [];
    var kept = migrated.filter(function (row) {
      if (classifyRecordSection(row) === target) {
        removed.push(row);
        return false;
      }
      return true;
    });
    return { kept: kept, removed: removed };
  }

  function readSectionActiveEpisode(storage, activeKey, showId, section) {
    if (!storage || typeof storage.getItem !== "function") return null;
    var sec = normalizeSection(section);
    try {
      var data = JSON.parse(storage.getItem(activeKey) || "null");
      if (!data || data.version !== 1 || !data.shows || typeof data.shows !== "object") return null;
      var scoped = data.shows[sectionActiveEpisodeKey(showId, sec)];
      // Legacy bare showId key applies only to English section so Arabic never inherits English state
      var value = scoped || (sec === SECTION_ENGLISH ? data.shows[String(showId)] : null);
      return value && Number(value.season) > 0 && Number(value.episode) > 0 && Number.isFinite(value.at)
        ? { season: value.season, episode: value.episode, at: value.at, section: sec }
        : null;
    } catch (_error) {
      return null;
    }
  }

  function writeSectionActiveEpisode(storage, activeKey, showId, entry, section) {
    if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function"
        || !entry || !(Number(entry.season) > 0) || !(Number(entry.episode) > 0)) return false;
    var sec = normalizeSection(section);
    try {
      var data = JSON.parse(storage.getItem(activeKey) || "null");
      var shows = data && data.version === 1 && data.shows && typeof data.shows === "object" ? data.shows : {};
      shows[sectionActiveEpisodeKey(showId, sec)] = {
        season: entry.season,
        episode: entry.episode,
        at: Number.isFinite(entry.at) ? entry.at : Date.now(),
        section: sec
      };
      storage.setItem(activeKey, JSON.stringify({ version: 1, shows: shows }));
      return true;
    } catch (_error) {
      return false;
    }
  }

  function deleteSectionActiveEpisode(storage, activeKey, showId, section) {
    if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") return false;
    var sec = normalizeSection(section);
    try {
      var data = JSON.parse(storage.getItem(activeKey) || "null");
      if (!data || data.version !== 1 || !data.shows || typeof data.shows !== "object") return false;
      var changed = false;
      var scopedKey = sectionActiveEpisodeKey(showId, sec);
      if (Object.prototype.hasOwnProperty.call(data.shows, scopedKey)) {
        delete data.shows[scopedKey];
        changed = true;
      }
      if (sec === SECTION_ENGLISH && Object.prototype.hasOwnProperty.call(data.shows, String(showId))) {
        delete data.shows[String(showId)];
        changed = true;
      }
      if (changed) storage.setItem(activeKey, JSON.stringify(data));
      return changed;
    } catch (_error) {
      return false;
    }
  }

  function isSectionContinueHidden(hiddenItems, row, section) {
    if (!hiddenItems || !row) return false;
    var sec = normalizeSection(section || classifyRecordSection(row));
    var scopedStamp = hiddenItems[sectionTitleKey(row, sec)];
    var legacyStamp = sec === SECTION_ENGLISH ? hiddenItems[row.type + ":" + row.id] : undefined;
    var stamp = Number.isFinite(scopedStamp) ? scopedStamp : legacyStamp;
    return Number.isFinite(stamp) && stamp >= (row.progress ? row.progress.updatedAt : row.at);
  }

  /**
   * Returns clean visible button copy for the Arabic section primary playback button.
   * For any playable Arabic provider/format (MP4, HLS, Akwam Relay, Archive.org, Roya TV, YouTube),
   * visible copy is strictly "Play" while preserving internal provider metadata untouched.
   */
  function formatArabicPrimaryButtonLabel(resolved) {
    if (resolved && resolved.availability === "playable") {
      return "Play";
    }
    return null;
  }

  var api = {
    SECTION_ENGLISH: SECTION_ENGLISH,
    SECTION_ARABIC: SECTION_ARABIC,
    ARABIC_ONLY_PROVIDERS: ARABIC_ONLY_PROVIDERS.slice(),
    normalizeSection: normalizeSection,
    activeSection: activeSection,
    classifyRecordSection: classifyRecordSection,
    withSection: withSection,
    sectionHistoryKey: sectionHistoryKey,
    sectionTitleKey: sectionTitleKey,
    sectionActiveEpisodeKey: sectionActiveEpisodeKey,
    migrateHistoryRows: migrateHistoryRows,
    filterRowsBySection: filterRowsBySection,
    upsertSectionRow: upsertSectionRow,
    deleteSectionRows: deleteSectionRows,
    clearSectionRows: clearSectionRows,
    readSectionActiveEpisode: readSectionActiveEpisode,
    writeSectionActiveEpisode: writeSectionActiveEpisode,
    deleteSectionActiveEpisode: deleteSectionActiveEpisode,
    isSectionContinueHidden: isSectionContinueHidden,
    formatArabicPrimaryButtonLabel: formatArabicPrimaryButtonLabel
  };

  root.HorizonHistorySections = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
