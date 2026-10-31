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

test("TV player URL uses validated show ID, selected episode, subtitle, and fixed return marker", () => {
  assert.equal(core.tvPlayerUrl(2190, 13, 2, "off", "South Park"),
    "https://horizon-video-lab-preview.ali-al-anbari.workers.dev/player-overlay.html?season=13&episode=2&sub=off&showId=2190&from=search&name=South%20Park");
  assert.equal(core.tvPlayerUrl(1396, 1, 0, "on", "Breaking Bad"), null);
  assert.equal(core.tvPlayerUrl(-1, 1, 1, "on", "Bad"), null);
  assert.deepEqual(JSON.parse(JSON.stringify(core.returnEpisode("?return=1&showId=1396&season=1&episode=4&sub=off"))),
    { id: 1396, season: 1, episode: 4, subtitle: "off" });
});

test("TVDB identity survives history and player URL without changing YapGrid show ID", () => {
  const row = core.item("tv", 105248, "Cyberpunk: Edgerunners", 2, 2, "off", 1000,
    { tvdbId: 384541 });
  assert.equal(row.tvdbId, 384541);
  assert.match(core.tvPlayerUrl(row.id, row.season, row.episode, row.subtitle, row.title, row.tvdbId),
    /showId=105248.*tvdb=384541$/);
});

test("movie adapter routes validated TMDB movie IDs through Video Lab while TV stays unchanged", () => {
  assert.equal(player.movieUrl(550, "Fight Club"),
    "https://horizon-video-lab-preview.ali-al-anbari.workers.dev/player-overlay.html?type=movie&id=550&from=search&name=Fight%20Club");
  assert.equal(player.movieUrl(-1, "Bad"), null);
  assert.equal(player.movieUrl(0, "Bad"), null);
  assert.deepEqual(JSON.parse(JSON.stringify(core.returnMovie("?return=1&type=movie&id=550"))), { id: 550 });
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
