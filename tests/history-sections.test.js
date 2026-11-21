import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import vm from "node:vm";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load HorizonHistorySections and HorizonSearchCore in a clean browser-like global context
const sectionsSrc = fs.readFileSync(path.join(__dirname, "..", "universal-search", "history-sections.js"), "utf8");
const coreSrc = fs.readFileSync(path.join(__dirname, "..", "universal-search", "core.js"), "utf8");
const sandbox = { window: {}, globalThis: {} };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.runInNewContext(sectionsSrc, sandbox);
vm.runInNewContext(coreSrc, sandbox);
const sections = sandbox.HorizonHistorySections;
const core = sandbox.HorizonSearchCore;

function createMemoryStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    dump() { return Object.fromEntries(map.entries()); }
  };
}

function makeSectionStore(storage) {
  const HISTORY_KEY = core.HISTORY_KEY;
  const ACTIVE_KEY = core.ACTIVE_EPISODES_KEY;
  const HIDDEN_KEY = core.HIDDEN_CONTINUE_KEY;
  const LIB_KEY = core.CONTENT_LIBRARY_KEY;

  function readAll() {
    try {
      const parsed = JSON.parse(storage.getItem(HISTORY_KEY) || "null");
      if (!parsed || !Array.isArray(parsed.items)) return [];
      return sections.migrateHistoryRows(parsed.items, (row) =>
        core.item(row.type, row.id, row.title, row.season, row.episode, row.subtitle, row.at, row)
      );
    } catch {
      return [];
    }
  }

  function readSection(explicitSection) {
    const sec = explicitSection || sections.activeSection(storage, LIB_KEY);
    return sections.filterRowsBySection(readAll(), sec);
  }

  function writeSection(entry, explicitSection) {
    const sec = explicitSection || sections.activeSection(storage, LIB_KEY);
    const normalized = core.item(entry.type, entry.id, entry.title, entry.season, entry.episode, entry.subtitle, entry.at, entry);
    const next = sections.upsertSectionRow(readAll(), normalized, sec);
    storage.setItem(HISTORY_KEY, JSON.stringify({ version: 2, items: next }));
    return sections.filterRowsBySection(next, sec);
  }

  function setSection(mode) {
    core.writeLibraryPref(storage, mode === "arabic" ? "arabic" : "standard");
  }

  function readActive(showId, explicitSection) {
    const sec = explicitSection || sections.activeSection(storage, LIB_KEY);
    return sections.readSectionActiveEpisode(storage, ACTIVE_KEY, showId, sec);
  }

  function writeActive(showId, entry, explicitSection) {
    const sec = explicitSection || sections.activeSection(storage, LIB_KEY);
    return sections.writeSectionActiveEpisode(storage, ACTIVE_KEY, showId, entry, sec);
  }

  function nextTarget(showId, catalog, explicitSection) {
    const sec = explicitSection || sections.activeSection(storage, LIB_KEY);
    const scopedRows = readSection(sec);
    const active = readActive(showId, sec);
    const activeStorageShim = {
      getItem(k) {
        if (k === ACTIVE_KEY && active) {
          return JSON.stringify({ version: 1, shows: { [String(showId)]: active } });
        }
        return storage.getItem(k);
      }
    };
    return core.canonicalEpisodeTarget(scopedRows, showId, catalog, activeStorageShim);
  }

  function setHidden(row, hidden, explicitSection) {
    const sec = explicitSection || sections.activeSection(storage, LIB_KEY);
    const parsed = JSON.parse(storage.getItem(HIDDEN_KEY) || '{"version":1,"items":{}}');
    const key = sections.sectionTitleKey(row, sec);
    if (hidden) parsed.items[key] = row.progress ? row.progress.updatedAt : row.at;
    else delete parsed.items[key];
    storage.setItem(HIDDEN_KEY, JSON.stringify(parsed));
  }

  function isHidden(row, explicitSection) {
    const sec = explicitSection || sections.activeSection(storage, LIB_KEY);
    const parsed = JSON.parse(storage.getItem(HIDDEN_KEY) || '{"version":1,"items":{}}');
    return sections.isSectionContinueHidden(parsed.items, row, sec);
  }

  return { readAll, readSection, writeSection, setSection, readActive, writeActive, nextTarget, setHidden, isHidden };
}

test("1-4. Watching Arabic episode appears only in Arabic; switching to English isolates both sections", () => {
  const storage = createMemoryStorage();
  const store = makeSectionStore(storage);

  // Watch Arabic episode
  store.setSection("arabic");
  store.writeSection({
    type: "tv", id: 297621, title: "فخر الدلتا", season: 1, episode: 1, subtitle: "off", at: 1700001000000,
    progress: { position: 420, duration: 3118, updatedAt: 1700001000000, provider: "akwam_relay", completed: false }
  });

  const arHistory = store.readSection("arabic");
  assert.equal(arHistory.length, 1);
  assert.equal(arHistory[0].section, "arabic");
  assert.equal(core.homepageHistory(arHistory).length, 1);

  // Switch to English -> Arabic history is absent
  store.setSection("english");
  assert.equal(store.readSection().length, 0);
  assert.equal(core.homepageHistory(store.readSection()).length, 0);

  // Watch English episode -> appears only in English
  store.writeSection({
    type: "tv", id: 1396, title: "Breaking Bad", season: 1, episode: 2, subtitle: "on", at: 1700002000000,
    progress: { position: 900, duration: 2880, updatedAt: 1700002000000, provider: "vidbolt", completed: false }
  });
  const enHistory = store.readSection();
  assert.equal(enHistory.length, 1);
  assert.equal(enHistory[0].id, 1396);
  assert.equal(enHistory[0].section, "english");

  // Switch back to Arabic -> Arabic history & progress intact, English absent
  store.setSection("arabic");
  const arAfter = store.readSection();
  assert.equal(arAfter.length, 1);
  assert.equal(arAfter[0].id, 297621);
  assert.equal(arAfter[0].progress.position, 420);
});

test("5 & 6. Same TMDB ID watched in both sections maintains independent records, timestamps, and persists across reload", () => {
  const storage = createMemoryStorage();
  const store1 = makeSectionStore(storage);

  store1.setSection("arabic");
  store1.writeSection({
    type: "tv", id: 555001, title: "مسلسل مشترك", season: 1, episode: 1, subtitle: "off", at: 1700003000000,
    progress: { position: 600, duration: 2400, updatedAt: 1700003000000, provider: "akwam_relay", completed: false }
  });

  store1.setSection("english");
  store1.writeSection({
    type: "tv", id: 555001, title: "Shared Show", season: 1, episode: 1, subtitle: "on", at: 1700009000000,
    progress: { position: 1500, duration: 2400, updatedAt: 1700009000000, provider: "vidbolt", completed: false }
  });

  // Simulate full page reload by creating a brand-new store reading from the same persisted localStorage snapshot
  const reloadedStorage = createMemoryStorage(storage.dump());
  const store2 = makeSectionStore(reloadedStorage);

  const arRows = store2.readSection("arabic");
  const enRows = store2.readSection("english");
  assert.equal(arRows.length, 1);
  assert.equal(enRows.length, 1);
  assert.equal(arRows[0].progress.position, 600);
  assert.equal(arRows[0].at, 1700003000000);
  assert.equal(enRows[0].progress.position, 1500);
  assert.equal(enRows[0].at, 1700009000000);

  // Hiding in English does not hide in Arabic
  store2.setHidden(enRows[0], true, "english");
  assert.equal(store2.isHidden(enRows[0], "english"), true);
  assert.equal(store2.isHidden(arRows[0], "arabic"), false);
});

test("7. Next Episode and Resume use the correct section independently for the same TMDB ID", () => {
  const storage = createMemoryStorage();
  const store = makeSectionStore(storage);
  const catalog = { seasons: [{ number: 1, count: 10 }] };

  // Arabic: completed S1E1 -> Next Episode should be S1E2
  store.setSection("arabic");
  store.writeActive(777001, { season: 1, episode: 1, at: 1700001000000 }, "arabic");
  store.writeSection({
    type: "tv", id: 777001, title: "عمل عربي", season: 1, episode: 1, subtitle: "off", at: 1700001500000,
    progress: { position: 2350, duration: 2400, updatedAt: 1700001500000, provider: "roya_tv", completed: true }
  }, "arabic");

  // English: mid-way through S1E4 -> Resume should stay on S1E4 at 800s
  store.setSection("english");
  store.writeActive(777001, { season: 1, episode: 4, at: 1700002000000 }, "english");
  store.writeSection({
    type: "tv", id: 777001, title: "English Show", season: 1, episode: 4, subtitle: "on", at: 1700002500000,
    progress: { position: 800, duration: 2400, updatedAt: 1700002500000, provider: "vidbolt", completed: false }
  }, "english");

  const arTarget = store.nextTarget(777001, catalog, "arabic");
  const enTarget = store.nextTarget(777001, catalog, "english");

  assert.equal(arTarget.season, 1);
  assert.equal(arTarget.episode, 2);
  assert.equal(arTarget.isNextUnwatched, true);

  assert.equal(enTarget.season, 1);
  assert.equal(enTarget.episode, 4);
  assert.equal(enTarget.isNextUnwatched, false);
  assert.equal(enTarget.progress.position, 800);
});

test("8. Existing legacy history survives migration without data loss, duplicates, or misclassifying uncertain records as Arabic", () => {
  const legacyPayload = {
    version: 2,
    items: [
      // Legacy English record (vidbolt, no section field)
      { type: "movie", id: 27205, title: "Inception", season: null, episode: null, subtitle: "off", at: 1700005000000,
        progress: { position: 1200, duration: 8880, updatedAt: 1700005000000, provider: "vidbolt", completed: false } },
      // Duplicate older copy of same legacy English movie -> must deduplicate cleanly
      { type: "movie", id: 27205, title: "Inception", season: null, episode: null, subtitle: "off", at: 1700001000000, progress: null },
      // Legacy Arabic record (reliable Arabic-only provider: roya_tv, no section field)
      { type: "tv", id: 90011, title: "مسلسل رؤيا", season: 1, episode: 3, subtitle: "off", at: 1700004000000,
        progress: { position: 300, duration: 2400, updatedAt: 1700004000000, provider: "roya_tv", completed: false } },
      // Legacy youtube_official & archive_pd records WITHOUT explicit section -> MUST NOT be classified as Arabic
      { type: "movie", id: 7001, title: "Public Domain Film", season: null, episode: null, subtitle: "off", at: 1700003600000,
        progress: { position: 200, duration: 3600, updatedAt: 1700003600000, provider: "archive_pd", completed: false } },
      { type: "movie", id: 7002, title: "YouTube Broadcast", season: null, episode: null, subtitle: "off", at: 1700003500000,
        progress: { position: 150, duration: 3600, updatedAt: 1700003500000, provider: "youtube_official", completed: false } },
      // Uncertain legacy record (no progress, no provider, no section) -> MUST NOT be silently classified as Arabic
      { type: "movie", id: 603, title: "The Matrix", season: null, episode: null, subtitle: "off", at: 1700003000000, progress: null }
    ]
  };

  const storage = createMemoryStorage({
    [core.HISTORY_KEY]: JSON.stringify(legacyPayload),
    [core.ACTIVE_EPISODES_KEY]: JSON.stringify({ version: 1, shows: { "1396": { season: 2, episode: 5, at: 1700001000000 } } })
  });

  // Exercise core.js directly with HorizonHistorySections wired in
  core.writeLibraryPref(storage, "standard");
  const enRows = core.readHistory(storage);
  core.writeLibraryPref(storage, "arabic");
  const arRows = core.readHistory(storage);

  assert.equal(enRows.length, 4);
  assert.deepEqual(Array.from(enRows, (r) => r.id), [27205, 7001, 7002, 603]);
  assert.equal(arRows.length, 1);
  assert.equal(arRows[0].id, 90011);

  // Legacy bare active episode applies to English, not Arabic
  assert.equal(core.readActiveEpisode(storage, 1396, "english").episode, 5);
  assert.equal(core.readActiveEpisode(storage, 1396, "arabic"), null);

  // Clearing Arabic history via core.clearHistory preserves all English legacy records
  core.clearHistory(storage, "arabic");
  assert.equal(core.readHistory(storage, "arabic").length, 0);
  assert.deepEqual(Array.from(core.readHistory(storage, "english"), (r) => r.id), [27205, 7001, 7002, 603]);
});

test("9. Arabic primary playback button displays strictly 'Play' across all playable providers while preserving internal metadata", () => {
  const playableOptions = [
    { providerId: "akwam_relay", providerShortLabel: "Akwam Relay", format: "mp4", availability: "playable" },
    { providerId: "archive_pd", providerShortLabel: "Archive.org (MP4)", format: "mp4", availability: "playable" },
    { providerId: "roya_tv", providerShortLabel: "Roya TV", format: "hls", availability: "playable" },
    { providerId: "youtube_official", providerShortLabel: "YouTube Official", format: "youtube-iframe", availability: "playable" }
  ];

  for (const opt of playableOptions) {
    assert.equal(sections.formatArabicPrimaryButtonLabel(opt), "Play");
    // Internal provider identity remains completely intact
    assert.ok(opt.providerId.length > 0);
    assert.ok(opt.providerShortLabel.length > 0);
  }

  // Non-playable options return null so existing fallback copy (e.g. Open in Official App) is preserved
  assert.equal(sections.formatArabicPrimaryButtonLabel({ availability: "external-app" }), null);
  assert.equal(sections.formatArabicPrimaryButtonLabel({ availability: "unavailable" }), null);
});
