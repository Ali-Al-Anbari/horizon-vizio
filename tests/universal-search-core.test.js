import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const script = readFileSync(new URL("../universal-search/core.js", import.meta.url), "utf8");
const adapterScript = readFileSync(new URL("../universal-search/player-adapter.js", import.meta.url), "utf8");
const window = {};
runInNewContext(script, { window, URL, URLSearchParams });
runInNewContext(adapterScript, { window });
const core = window.HorizonSearchCore;
const player = window.HorizonSearchPlayer;
function storage(initial = {}) { const values = new Map(Object.entries(initial));
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) }; }

test("Watch homepage uses confirmed activity, groups shows, and separates Continue from History", () => {
  const store = storage();
  core.writeEpisodeCatalog(store, 11, [{ number: 1, count: 2 }], 1000);
  const progress = (position, duration, updatedAt, completed = false) =>
    ({ position, duration, updatedAt, provider: "vidbolt", completed });
  const rows = [
    core.item("tv", 10, "Series", 3, 5, "off", 100, { progress: progress(300, 1200, 1000) }),
    core.item("tv", 10, "Series", 3, 10, "off", 300, { progress: progress(100, 1200, 800) }),
    core.item("movie", 20, "Done film", null, null, "off", 200, { progress: progress(1000, 1000, 900, true) }),
    core.item("movie", 21, "New film", null, null, "off", 400, { progress: progress(100, 1000, 1100) }),
    core.item("tv", 11, "Done show", 1, 2, "off", 500, { progress: progress(900, 900, 700, true) }),
    core.item("tv", 11, "Done show", 1, 1, "off", 50, { progress: progress(900, 900, 650, true) }),
    core.item("movie", 22, "Only opened", null, null, "off", 600)
  ];
  const history = core.homepageHistory(rows);
  assert.deepEqual(JSON.parse(JSON.stringify(history.map(row => [row.id, row.episode]))), [[21, null], [10, 5], [20, null], [11, 2]]);
  assert.deepEqual(Array.from(core.homepageContinueCandidates(rows, store), row => row.id), [21, 10]);
  assert.deepEqual(Array.from(core.homepageFinished(rows, store), row => row.id), [20, 11]);
  assert.equal(core.homepageContinueCandidates(rows, store).some(row => core.homepageFinished(rows, store).some(done => done.id === row.id)), false);
  assert.equal(core.homepageHistory([]).length, 0);
  const completedLatest = core.item("tv", 10, "Series", 3, 6, "off", 700,
    { progress: progress(1200, 1200, 2500, true) });
  assert.equal(core.homepageContinueCandidates([completedLatest, ...rows], store).some(row => row.id === 10), true);
  assert.equal(core.homepageFinished([completedLatest, ...rows], store).some(row => row.id === 10), false);
  const updated = core.item("tv", 10, "Series", 3, 5, "off", 700,
    { progress: progress(900, 1200, 2000) });
  assert.equal(core.homepageHistory([updated, ...rows]).find(row => row.id === 10).progress.position, 900);
});

test("Home snapshot import is idempotent, preserves newer progress, and backs up existing history", () => {
  const store = storage();
  const progress = { position: 900, duration: 1800, updatedAt: 2000, provider: "vidbolt", completed: false };
  core.writeHistory(store, core.item("movie", 5, "Existing", null, null, "off", 1000, { progress }));
  const old = store.getItem(core.HISTORY_KEY);
  const snapshot = { version: 2, items: [
    core.item("movie", 5, "Old name", null, null, "off", 100),
    core.item("tv", 10, "Legacy show", 1, 2, "off", 500)
  ] };
  assert.equal(core.importHomeSnapshot(store, snapshot), 1);
  assert.equal(core.importHomeSnapshot(store, snapshot), 0);
  assert.equal(store.getItem(core.HISTORY_BACKUP_KEY), old);
  assert.equal(core.readHistory(store).find(row => row.id === 5).progress.position, 900);
  assert.equal(core.readHistory(store).find(row => row.id === 10).progress, null);
});

test("Continue suppression, explicit completion, and exact deletion preserve independent history", () => {
  const store = storage();
  const progress = { position: 300, duration: 1000, updatedAt: 1000, provider: "vidbolt", completed: false };
  const first = core.item("tv", 10, "Show", 1, 1, "off", 100, { progress });
  core.writeHistory(store, first);
  core.writeHistory(store, core.item("tv", 10, "Show", 1, 2, "off", 200));
  assert.equal(core.setContinueHidden(store, first, true), true);
  assert.equal(core.isContinueHidden(store, first), true);
  const newer = core.item("tv", 10, "Show", 1, 1, "off", 300, { progress: { ...progress, updatedAt: 2000 } });
  assert.equal(core.isContinueHidden(store, newer), false);
  assert.equal(core.setHistoryWatched(store, "tv", 10, 1, 2, true), true);
  assert.equal(core.homepageFinished(core.readHistory(store)).some(row => row.episode === 2), false,
    "last actively watched episode remains authoritative");
  assert.equal(core.deleteHistory(store, "tv", 10, 1, 1, false), true);
  assert.equal(core.readHistory(store).length, 1);
  assert.equal(core.homepageFinished(core.readHistory(store), store).length, 0);
  assert.equal(core.deleteHistory(store, "tv", 10, 1, 2, true), true);
  assert.equal(core.readHistory(store).length, 0);
  assert.equal(core.importHomeSnapshot(store, { version: 2, items: [first] }), 0,
    "an older Home snapshot cannot resurrect a deleted episode");
});

test("TV player URL uses validated show ID, selected episode, subtitle, and fixed return marker", () => {
  assert.equal(core.tvPlayerUrl(2190, 13, 2, "off", "South Park"),
    "https://horizon-video-lab-preview.ali-al-anbari.workers.dev/player-overlay.html?season=13&episode=2&sub=off&showId=2190&from=search&provider=vidbolt&name=South%20Park");
  assert.equal(core.tvPlayerUrl(1396, 1, 0, "on", "Breaking Bad"), null);
  assert.equal(core.tvPlayerUrl(-1, 1, 1, "on", "Bad"), null);
  assert.deepEqual(JSON.parse(JSON.stringify(core.returnEpisode("?return=1&showId=1396&season=1&episode=4&sub=off"))),
    { id: 1396, season: 1, episode: 4, subtitle: "off", episodeTitle: "", showTitle: "",
      progressBatch: [], episodeTrail: [], handoff: null, progress: null });
});

test("TVDB identity survives history and player URL without changing YapGrid show ID", () => {
  const row = core.item("tv", 105248, "Cyberpunk: Edgerunners", 2, 2, "off", 1000,
    { tvdbId: 384541 });
  assert.equal(row.tvdbId, 384541);
  assert.match(core.tvPlayerUrl(row.id, row.season, row.episode, row.subtitle, row.title, row.tvdbId),
    /showId=105248.*tvdb=384541$/);
});

test("movie adapter routes validated TMDB movie IDs to VidBolt with YapGrid selectable in the player", () => {
  assert.equal(player.movieUrl(550, "Fight Club"),
    "https://horizon-video-lab-preview.ali-al-anbari.workers.dev/player-overlay.html?type=movie&id=550&from=search&provider=vidbolt&name=Fight%20Club");
  assert.equal(player.movieUrl(-1, "Bad"), null);
  assert.equal(player.movieUrl(0, "Bad"), null);
  assert.deepEqual(JSON.parse(JSON.stringify(core.returnMovie("?return=1&type=movie&id=550"))),
    { id: 550, handoff: null, progress: null });
  assert.equal(core.returnMovie("?return=1&type=tv&id=550"), null);
  assert.equal(player.tvUrl(2190, 13, 2, "off", "South Park"),
    core.tvPlayerUrl(2190, 13, 2, "off", "South Park"));
});

test("versioned history keeps distinct episodes, deduplicates starts, and tolerates old/bad storage", () => {
  const store = storage();
  const first = core.item("tv", 2190, "South Park", 13, 2, "off", 100);
  core.writeHistory(store, first);
  core.writeHistory(store, core.item("tv", 2190, "South Park", 13, 3, "off", 200));
  assert.equal(core.readHistory(store).length, 2);
  assert.equal(core.readHistory(store)[0].episode, 3);
  core.writeHistory(store, core.item("tv", 2190, "Renamed South Park", 13, 2, "on", 300,
    { poster: "/poster.jpg", episodeTitle: "The Coon" }));
  assert.equal(core.readHistory(store).length, 2);
  assert.equal(core.readHistory(store)[0].episode, 2);
  assert.equal(core.readHistory(store)[0].poster, "/poster.jpg");
  assert.equal(core.readHistory(store)[0].episodeTitle, "The Coon");
  assert.equal(core.homeRows(core.readHistory(store)).length, 1);
  const legacy = storage({ [core.HISTORY_KEY]: JSON.stringify({ version: 1, items: [first] }) });
  assert.equal(core.readHistory(legacy)[0].episode, 2);
  assert.equal(core.readHistory(storage({ [core.HISTORY_KEY]: JSON.stringify({ version: 0, items: [first] }) })).length, 0);
  assert.equal(core.readHistory({ getItem() { throw Error("denied"); } }).length, 0);
  assert.equal(core.item("movie", 550, "Fight Club", null, null, "on", 100).episode, null);
  core.clearHistory(store);
  assert.equal(core.readHistory(store).length, 0);
});

test("movie starts replace the same TMDB movie and transfer as one Home row", () => {
  const store = storage();
  core.writeHistory(store, core.item("movie", 550, "Fight Club", null, null, "off", 100,
    { poster: "/first.jpg" }));
  core.writeHistory(store, core.item("tv", 2190, "South Park", 13, 2, "off", 150));
  core.writeHistory(store, core.item("movie", 550, "Fight Club", null, null, "off", 200,
    { poster: "/poster.jpg", backdrop: "/backdrop.jpg" }));
  const rows = core.readHistory(store);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].type, "movie");
  assert.equal(rows[0].id, 550);
  assert.equal(rows[0].at, 200);
  assert.equal(rows[0].poster, "/poster.jpg");
  assert.deepEqual(Array.from(core.homeRows(rows), row => row.type + ":" + row.id), ["movie:550", "tv:2190"]);
  core.clearHistory(store);
  assert.equal(core.readHistory(store).length, 0);
});

test("Watch history preserves validated VidBolt progress and keeps completed rows out of Continue Watching", () => {
  const store = storage();
  const partial = { position: 125.5, duration: 600, updatedAt: 1700000000000, provider: "vidbolt", completed: false };
  const row = core.item("movie", 550, "Fight Club", null, null, "off", 200,
    { poster: "/poster.jpg", progress: partial });
  core.writeHistory(store, row);
  core.writeHistory(store, core.item("movie", 550, "Fight Club", null, null, "off", 300,
    { poster: "/poster.jpg" }));
  assert.deepEqual(JSON.parse(JSON.stringify(core.readHistory(store)[0].progress)), partial);
  assert.equal(core.continueRows(core.readHistory(store)).length, 1);
  core.writeHistory(store, core.item("movie", 550, "Fight Club", null, null, "off", 400,
    { progress: Object.assign({}, partial, { updatedAt: 1700000001000, completed: true }) }));
  assert.equal(core.continueRows(core.readHistory(store)).length, 0);
  assert.equal(core.readHistory(store).length, 1, "completed title remains in History");
  assert.equal(core.clearProgress(store, "movie", 550), true, "Start Over clears only resume metadata");
  assert.equal(core.readHistory(store)[0].progress, null);
  assert.equal(core.readHistory(store).length, 1, "clearing progress does not erase History");
});

test("browsed season is remembered per show independently of watched history", () => {
  const store = storage();
  assert.equal(core.writeBrowsedSeason(store, 2190, 14), true);
  assert.equal(core.readBrowsedSeason(store, 2190), 14);
  assert.equal(core.readBrowsedSeason(store, 1396), null);
  core.writeBrowsedSeason(store, 1396, 3);
  assert.equal(core.readBrowsedSeason(store, 2190), 14);
  assert.equal(core.readBrowsedSeason(store, 1396), 3);
  assert.equal(core.writeBrowsedSeason(store, 2190, -1), false);
  assert.equal(core.readBrowsedSeason(storage({ [core.BROWSED_SEASONS_KEY]: "invalid" }), 2190), null);
});

test("manual watched state overrides the thumbnail line without changing confirmed position", () => {
  const store = storage();
  const saved = { position: 50, duration: 100, updatedAt: 1700000000000, provider: "vidbolt", completed: false };
  core.writeHistory(store, core.item("tv", 2190, "South Park", 14, 2, "off", 1,
    { progress: saved, manualWatched: true }));
  assert.equal(core.continueRows(core.readHistory(store)).length, 1,
    "completed shows remain selectable so Continue can resolve a confirmed next episode");
  core.writeHistory(store, core.item("tv", 2190, "South Park", 14, 2, "off", 2,
    { manualWatched: false }));
  const row = core.readHistory(store)[0];
  assert.equal(row.progress.position, 50);
  assert.equal(row.manualWatched, false);
  assert.equal(core.continueRows(core.readHistory(store)).length, 1);
  core.writeHistory(store, core.item("tv", 2190, "South Park", 14, 2, "off", 3,
    { progress: Object.assign({}, saved, { updatedAt: 1700000001000, completed: true }) }));
  assert.equal(core.readHistory(store)[0].manualWatched, false, "explicit unmark survives a progress update");
  assert.equal(core.continueRows(core.readHistory(store)).length, 1);
});

test("confirmed playback selects the last watched episode over a newer catalog or browse launch", () => {
  const store = storage();
  const progress = (position, updatedAt, completed = false) =>
    ({ position, duration: 1800, updatedAt, provider: "vidbolt", completed });
  core.writeHistory(store, core.item("tv", 2190, "South Park", 3, 5, "off", 100,
    { progress: progress(300, 1000) }));
  core.writeHistory(store, core.item("tv", 2190, "South Park", 3, 10, "off", 2000));
  core.writeBrowsedSeason(store, 2190, 14);
  assert.equal(core.lastWatchedEpisode(core.readHistory(store), 2190).episode, 5);
  assert.equal(core.homeRows(core.readHistory(store))[0].episode, 5);
  assert.equal(core.continueRows(core.readHistory(store))[0].episode, 5);
  assert.equal(core.readBrowsedSeason(store, 2190), 14);
  core.writeHistory(store, core.item("tv", 2190, "South Park", 3, 5, "off", 3000,
    { progress: progress(900, 3000) }));
  assert.equal(core.lastWatchedEpisode(core.readHistory(store), 2190).progress.position, 900);
  core.writeHistory(store, core.item("tv", 2190, "South Park", 3, 5, "off", 4000,
    { progress: progress(300, 1000) }));
  const latest = core.lastWatchedEpisode(core.readHistory(store), 2190);
  assert.equal(latest.progress.position, 900, "stale handoff cannot overwrite newer absolute position");
  assert.equal(latest.at, 3000, "stale handoff cannot also change activity order");
});

test("Continue resolves only exact confirmed next episodes and season boundaries", () => {
  const current = { id: 2190, season: 3, episode: 5 };
  const rows = Array.from({ length: 10 }, (_, index) => ({ number: index + 1, title: "Episode " + (index + 1) }));
  assert.deepEqual(JSON.parse(JSON.stringify(core.nextConfirmedEpisode(current, rows, null, null))),
    { season: 3, episode: 6, title: "Episode 6" });
  assert.equal(core.nextConfirmedEpisode(current, rows.filter(row => row.number !== 6), null, null), null,
    "a later catalog episode cannot be substituted for a missing next episode");
  assert.deepEqual(JSON.parse(JSON.stringify(core.nextConfirmedEpisode({ id: 2190, season: 3, episode: 10 }, rows, 4,
    [{ number: 1, title: "Season opener" }]))), { season: 4, episode: 1, title: "Season opener" });
  assert.equal(core.nextConfirmedEpisode({ id: 2190, season: 3, episode: 10 }, rows, 4, []), null);
  assert.equal(core.nextConfirmedEpisode({ id: 2190, season: 3, episode: 10 }, rows, null, null), null);
  assert.equal(core.nextConfirmedEpisode({ id: 2190, season: 3, episode: 11 }, rows, 4,
    [{ number: 1, title: "Wrong" }]), null);
});

test("two validated returns preserve independent episode positions and the newest absolute point", () => {
  const store = storage();
  const returned = (episode, position, updatedAt) => core.returnEpisode("?return=1&showId=1396&season=1&episode="
    + episode + "&position=" + position + "&duration=1800&updated=" + updatedAt + "&progressProvider=vidbolt");
  const first = returned(4, 300, 1000);
  core.writeHistory(store, core.item("tv", first.id, "Breaking Bad", first.season, first.episode,
    "off", 1000, { progress: first.progress }));
  assert.equal(core.episodeProgressFraction(core.readHistory(store)[0]), 300 / 1800);
  const second = returned(4, 900, 2000);
  core.writeHistory(store, core.item("tv", second.id, "Breaking Bad", second.season, second.episode,
    "off", 2000, { progress: second.progress }));
  assert.equal(core.episodeProgressFraction(core.readHistory(store)[0]), 900 / 1800,
    "thumbnail uses the latest absolute position immediately after the second return");
  const other = returned(5, 120, 2100);
  core.writeHistory(store, core.item("tv", other.id, "Breaking Bad", other.season, other.episode,
    "off", 2100, { progress: other.progress }));
  assert.equal(core.readHistory(store).find(row => row.episode === 4).progress.position, 900);
  assert.equal(core.readHistory(store).find(row => row.episode === 5).progress.position, 120);
  assert.equal(core.lastWatchedEpisode(core.readHistory(store), 1396).episode, 5);
  assert.match(core.tvPlayerUrl(1396, 1, 4, "off", "Breaking Bad", null,
    core.readHistory(store).find(row => row.episode === 4).progress), /resume=900/);
});

test("return handoff binds confirmed progress to the show across episode transitions", () => {
  const saved = { token: "session_abc123", type: "tv", id: 2190, season: 3, episode: 5, at: 1000 };
  const returned = { handoff: "session_abc123", id: 2190, season: 3, episode: 5 };
  assert.equal(core.validHandoff(saved, returned, "tv", 2000), true);
  assert.equal(core.validHandoff(saved, { ...returned, episode: 10 }, "tv", 2000), false);
  assert.equal(core.validHandoff(saved, { ...returned, season: 4,
    episodeTrail: [{ season: 3, episode: 5 }] }, "tv", 2000), true);
  assert.equal(core.validHandoff(saved, returned, "tv", 86402000), false);
});

test("show completion requires every catalog episode and changes when a new episode appears", () => {
  const store = storage();
  const complete = { position: 96, duration: 100, updatedAt: 1000, provider: "vidbolt", completed: true };
  const rows = [1, 2].map(number => core.item("tv", 99, "Series", 1, number, "off", number,
    { progress: { ...complete, updatedAt: 1000 + number } }));
  core.writeEpisodeCatalog(store, 99, [{ number: 1, count: 2 }], 1000);
  assert.equal(core.homepageFinished(rows, store).length, 1);
  core.writeEpisodeCatalog(store, 99, [{ number: 1, count: 3 }], 2000);
  assert.equal(core.homepageFinished(rows, store).length, 0);
  assert.equal(core.homepageContinueCandidates(rows, store).length, 1);
  const partial = core.item("tv", 99, "Series", 1, 3, "off", 3,
    { progress: { ...complete, position: 50, completed: false, updatedAt: 1003 } });
  assert.equal(core.homepageContinueCandidates([...rows, partial], store)[0].episode, 3);
  assert.equal(core.readEpisodeCatalog(storage({ [core.EPISODE_CATALOG_KEY]: '{"version":2,"shows":{}}' }), 99), null);
});

test("bounded return batch accepts only verified progress and observed episode trail", () => {
  const record = { position: 96, duration: 100, updatedAt: 1700000000000,
    provider: "vidbolt", completed: true };
  const query = new URLSearchParams({ return: "1", showId: "99", season: "1", episode: "3",
    handoff: "session_abc123", showTitle: "Series", episodeTrail: "1:1,1:2",
    progressBatch: JSON.stringify([{ season: 1, episode: 1, progress: record },
      { season: 1, episode: 2, progress: { ...record, completed: false, position: 50 } },
      { season: 1, episode: 3, progress: { ...record, provider: "yapgrid" } }]) });
  const returned = core.returnEpisode("?" + query);
  assert.deepEqual(JSON.parse(JSON.stringify(returned.episodeTrail)), [{ season: 1, episode: 1 }, { season: 1, episode: 2 }]);
  assert.equal(returned.progressBatch.length, 2);
  assert.equal(returned.progressBatch[1].progress.completed, false);
});

test("progress records and Watch return handoffs reject invalid or mismatched fields", () => {
  const saved = { position: 20, duration: 100, updatedAt: 1700000000000, provider: "vidbolt", completed: false };
  assert.equal(core.progressRecord(Object.assign({}, saved, { position: 105 })), null);
  assert.equal(core.progressRecord(Object.assign({}, saved, { provider: "yapgrid" })), null);
  const record = core.item("tv", 1396, "Breaking Bad", 1, 4, "off", 1,
    { progress: saved });
  const url = core.tvPlayerUrl(record.id, record.season, record.episode, record.subtitle, record.title,
    null, record.progress, false, "session_abc123");
  assert.match(url, /resume=20&duration=100&resumeUpdated=1700000000000&handoff=session_abc123$/);
  const returned = core.returnEpisode("?return=1&showId=1396&season=1&episode=4&handoff=session_abc123"
    + "&position=20&duration=100&updated=1700000000000&progressProvider=vidbolt");
  assert.equal(returned.progress.position, 20);
  assert.equal(returned.handoff, "session_abc123");
  assert.equal(core.returnEpisode("?return=1&showId=1396&season=1&episode=4&position=20&duration=100&updated=1"
    + "&progressProvider=yapgrid").progress, null);
});

test("Home history groups shows, keeps movies, orders newest first, and limits to six", () => {
  const store = storage();
  for (let id = 1; id <= 8; id++) core.writeHistory(store,
    core.item(id % 2 ? "tv" : "movie", id, "Title " + id, 1, 1, "on", id * 100));
  core.writeHistory(store, core.item("tv", 7, "Title 7", 1, 2, "off", 900));
  assert.equal(core.readHistory(store).length, 9);
  assert.deepEqual(Array.from(core.homeRows(core.readHistory(store)), row => row.id), [7, 8, 6, 5, 4, 3]);
  assert.equal(core.homeRows(core.readHistory(store))[0].episode, 2);
});

test("Watch History groups by stable show ID without deleting distinct episode records", () => {
  const store = storage();
  core.writeHistory(store, core.item("tv", 2190, "South Park", 13, 2, "off", 100));
  core.writeHistory(store, core.item("tv", 2190, "Renamed South Park", 13, 3, "off", 300));
  core.writeHistory(store, core.item("movie", 550, "Fight Club", null, null, "off", 200));
  core.writeHistory(store, core.item("tv", 105248, "Cyberpunk", 2, 7, "off", 400));
  const all = core.readHistory(store), grouped = core.groupedHistory(all);
  assert.equal(all.length, 4);
  assert.deepEqual(Array.from(grouped, row => [row.type, row.id, row.episode]),
    [["tv", 105248, 7], ["tv", 2190, 3], ["movie", 550, null]]);
  core.clearHistory(store);
  assert.equal(core.groupedHistory(core.readHistory(store)).length, 0);
});

test("Search balances title match with popularity and votes for short partial queries", () => {
  const rows = [
    { title: "Obscure Southbound", popularity: 1 },
    { title: "Southpaw", popularity: 10 },
    { title: "South Park", popularity: 200 },
    { title: "The South End", popularity: 500 },
    { title: "Outsouth", popularity: 800 },
    { title: "South", popularity: 1 },
    { title: "South Coast", popularity: 100 }
  ];
  assert.deepEqual(Array.from(core.rankResults(rows, "south"), row => row.title).slice(0, 3),
    ["South Park", "South Coast", "South"]);
  assert.deepEqual(Array.from(core.rankResults(rows, "sout"), row => row.title).slice(0, 2),
    ["South Park", "South Coast"]);
  const partial = [
    { title: "Sou", popularity: 0.7, voteCount: 0 },
    { title: "South Park", popularity: 210, voteCount: 4000 },
    { title: "Southpaw", popularity: 75, voteCount: 5200 }
  ];
  assert.deepEqual(core.rankResults(partial, "sou").map(row => row.title),
    ["South Park", "Southpaw", "Sou"]);
});

test("provider preference and launch names are allowlisted; external search is encoded", () => {
  const store = storage(); core.writePrefs(store, [9, 337]);
  assert.equal(core.readPrefs(store).join(","), "9,337");
  assert.equal(core.providerApp("Amazon Prime Video"), "Prime Video");
  assert.equal(core.providerApp("Netflix"), null);
  assert.match(core.websiteSearch("A & B"), /A%20%26%20B/);
  assert.equal(core.imageUrl("https://evil.example/a", "poster"), "");
  assert.match(core.imageUrl("/test.jpg", "poster"), /\/w500\/test\.jpg$/);
  assert.match(core.imageUrl("/test.jpg", "poster-small"), /\/w342\/test\.jpg$/);
});

test("subtitle preference defaults off, remembers either explicit choice, and rejects corrupt storage", () => {
  const store = storage();
  assert.equal(core.readSubtitlePref(store), "off");
  core.writeSubtitlePref(store, "on"); assert.equal(core.readSubtitlePref(store), "on");
  core.writeSubtitlePref(store, "off"); assert.equal(core.readSubtitlePref(store), "off");
  core.writeSubtitlePref(store, "invalid"); assert.equal(core.readSubtitlePref(store), "off");
  assert.equal(core.readSubtitlePref(storage({ [core.SUBTITLE_KEY]: "{" })), "off");
  assert.match(core.tvPlayerUrl(2190, 13, 2, undefined, "South Park"), /sub=off/);
});

test("provider listing URL is title-specific, US-specific, and cannot redirect to an arbitrary site", () => {
  const valid = "https://www.themoviedb.org/tv/2190/watch?locale=US";
  assert.equal(core.providerWatchUrl(valid, "tv", 2190), valid);
  for (const link of ["https://evil.example/tv/2190/watch?locale=US",
    "https://www.themoviedb.org/tv/2191/watch?locale=US",
    "https://www.themoviedb.org/tv/2190/watch?locale=GB", "javascript:alert(1)"])
    assert.equal(core.providerWatchUrl(link, "tv", 2190), null);
});

test("provider groups collapse subscription-plan IDs to one underlying service while retaining offer categories", () => {
  const grouped = core.groupProviders({
    stream: [{ id: 531, name: "Paramount+ Essential", logo: "/paramount.png" },
      { id: 532, name: "Paramount+ Premium", logo: "/paramount.png" },
      { id: 9, name: "Amazon Prime Video", logo: "/prime.png" }],
    rent: [{ id: 531, name: "Paramount+", logo: "/paramount.png" }], buy: [], free: []
  });
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].name, "Paramount+");
  assert.deepEqual(Array.from(grouped[0].availability), ["stream", "rent"]);
  assert.deepEqual(Array.from(grouped[0].offerIds), [531, 532]);
  assert.equal(grouped[1].name, "Prime Video");
});
