import test from "node:test";
import assert from "node:assert/strict";
import "../universal-search/core.js";

const root = typeof window !== "undefined" ? window : globalThis;
const core = root.HorizonSearchCore;

function storage(data = {}) {
  const store = { ...data };
  return {
    getItem: key => Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null,
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: key => { delete store[key]; },
    clear: () => { Object.keys(store).forEach(k => delete store[k]); }
  };
}

const progress = (position, duration, updatedAt, completed = false, provider = "vidbolt") =>
  ({ position, duration, updatedAt, provider, completed });

test("Partial progress: S2E3 at 40% and 80% targets S2E3 at verified positions", () => {
  const store = storage();
  core.writeEpisodeCatalog(store, 2190, [{ number: 2, count: 10 }], 1000);

  // 1. S2E3 at 40%
  const row40 = core.item("tv", 2190, "South Park", 2, 3, "off", 1000,
    { progress: progress(400, 1000, 1000, false) });
  core.writeHistory(store, row40);

  let target = core.canonicalEpisodeTarget(core.readHistory(store), 2190, store);
  assert.equal(target.season, 2);
  assert.equal(target.episode, 3);
  assert.equal(target.isNextUnwatched, false);
  assert.equal(target.isFinished, false);
  assert.equal(core.episodeProgressFraction(target), 0.4);

  let candidates = core.homepageContinueCandidates(core.readHistory(store), store);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].season, 2);
  assert.equal(candidates[0].episode, 3);
  assert.equal(core.episodeProgressFraction(candidates[0]), 0.4);

  // 2. S2E3 at 80%
  const row80 = core.item("tv", 2190, "South Park", 2, 3, "off", 2000,
    { progress: progress(800, 1000, 2000, false) });
  core.writeHistory(store, row80);

  target = core.canonicalEpisodeTarget(core.readHistory(store), 2190, store);
  assert.equal(target.season, 2);
  assert.equal(target.episode, 3);
  assert.equal(target.isNextUnwatched, false);
  assert.equal(core.episodeProgressFraction(target), 0.8);

  candidates = core.homepageContinueCandidates(core.readHistory(store), store);
  assert.equal(candidates[0].season, 2);
  assert.equal(candidates[0].episode, 3);
  assert.equal(core.episodeProgressFraction(candidates[0]), 0.8);

  // 3. Returning from Video Lab with updated progress
  const returned = core.returnEpisode("?return=1&showId=2190&season=2&episode=3&position=850&duration=1000&updated=3000&progressProvider=vidbolt");
  assert.ok(returned && returned.progress);
  assert.equal(returned.progress.position, 850);
  core.writeHistory(store, core.item("tv", returned.id, "South Park", returned.season, returned.episode, "off", Date.now(), { progress: returned.progress }));

  target = core.canonicalEpisodeTarget(core.readHistory(store), 2190, store);
  assert.equal(target.season, 2);
  assert.equal(target.episode, 3);
  assert.equal(target.progress.position, 850);
});

test("Completion: S2E3 at 95% advances Continue Watching to S2E4 at 0% without autoplay", () => {
  const store = storage();
  core.writeEpisodeCatalog(store, 2190, [{ number: 2, count: 10 }], 1000);

  // S2E3 reaching 95%
  const row95 = core.item("tv", 2190, "South Park", 2, 3, "off", 1000,
    { progress: progress(950, 1000, 1000, true) });
  core.writeHistory(store, row95);

  const history = core.readHistory(store);
  assert.equal(history.length, 1);
  assert.equal(history[0].season, 2);
  assert.equal(history[0].episode, 3);
  assert.equal(core.isEpisodeCompleted(history[0]), true, "S2E3 is recorded completed in history");

  const target = core.canonicalEpisodeTarget(history, 2190, store);
  assert.equal(target.season, 2);
  assert.equal(target.episode, 4, "Continue Watching target advances to S2E4");
  assert.equal(target.isNextUnwatched, true);
  assert.equal(target.progress, null, "S2E4 has null progress (starts at 0%)");
  assert.equal(core.episodeProgressFraction(target), 0, "S2E4 progress bar is 0%");

  const candidates = core.homepageContinueCandidates(history, store);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].season, 2);
  assert.equal(candidates[0].episode, 4);
  assert.equal(candidates[0].isNextUnwatched, true);
  assert.equal(core.episodeProgressFraction(candidates[0]), 0);

  // Natural-ended completion checkpoint (?completed=1)
  const returnedEnded = core.returnEpisode("?return=1&showId=2190&season=2&episode=3&position=1000&duration=1000&updated=2000&completed=1&progressProvider=vidbolt");
  assert.equal(returnedEnded.progress.completed, true);
});

test("Episode transitions: same season, season boundary, finished series, new season, and Season 0 exclusion", () => {
  const store = storage();
  // Season 1: 3 episodes, Season 2: 2 episodes. Season 0 exists with 5 specials.
  const catalog = [
    { number: 0, count: 5 }, // Specials (must be excluded from regular progression)
    { number: 1, count: 3 },
    { number: 2, count: 2 }
  ];
  core.writeEpisodeCatalog(store, 100, catalog, 1000);

  // 1. Same-season next: S1E1 completed -> S1E2
  const s1e1 = core.item("tv", 100, "Show", 1, 1, "off", 100, { progress: progress(100, 100, 100, true) });
  core.writeHistory(store, s1e1);
  let target = core.canonicalEpisodeTarget(core.readHistory(store), 100, store);
  assert.equal(target.season, 1);
  assert.equal(target.episode, 2);

  // 2. Season boundary: S1E3 completed -> S2E1
  const s1e3 = core.item("tv", 100, "Show", 1, 3, "off", 300, { progress: progress(100, 100, 300, true) });
  core.writeHistory(store, s1e3);
  target = core.canonicalEpisodeTarget(core.readHistory(store), 100, store);
  assert.equal(target.season, 2);
  assert.equal(target.episode, 1);

  // 3. Final episode of series: S2E2 completed -> Finished
  const s2e2 = core.item("tv", 100, "Show", 2, 2, "off", 500, { progress: progress(100, 100, 500, true) });
  core.writeHistory(store, s2e2);
  target = core.canonicalEpisodeTarget(core.readHistory(store), 100, store);
  assert.equal(target.isFinished, true);
  assert.equal(core.homepageContinueCandidates(core.readHistory(store), store).length, 0);
  assert.equal(core.homepageFinished(core.readHistory(store), store).length, 1);

  // 4. New season available later: Season 3 released (count 4) -> Re-enters Continue Watching targeting S3E1
  core.writeEpisodeCatalog(store, 100, [...catalog, { number: 3, count: 4 }], 2000);
  target = core.canonicalEpisodeTarget(core.readHistory(store), 100, store);
  assert.equal(target.isFinished, false);
  assert.equal(target.season, 3);
  assert.equal(target.episode, 1);
  assert.equal(core.homepageContinueCandidates(core.readHistory(store), store).length, 1);
  assert.equal(core.homepageFinished(core.readHistory(store), store).length, 0);

  // 5. Incomplete catalog data: If catalog is unavailable, safe recoverable state preserved
  const noCatStore = storage();
  const rowNoCat = core.item("tv", 200, "Uncached Show", 1, 1, "off", 100, { progress: progress(100, 100, 100, true) });
  core.writeHistory(noCatStore, rowNoCat);
  const targetNoCat = core.canonicalEpisodeTarget(core.readHistory(noCatStore), 200, noCatStore);
  assert.equal(targetNoCat.hasCatalog, false);
  assert.equal(targetNoCat.isFinished, false, "Must not classify as Finished when catalog is missing");
});

test("Conflicts and stale state: delayed checkpoints, rewatching older episodes, duplicate completions", () => {
  const store = storage();
  core.writeEpisodeCatalog(store, 500, [{ number: 2, count: 10 }, { number: 4, count: 10 }], 1000);

  // Forward frontier established at S4E6 (completed at T=2000)
  const s4e6 = core.item("tv", 500, "Epic Show", 4, 6, "off", 2000, { progress: progress(100, 100, 2000, true) });
  core.writeHistory(store, s4e6);

  let target = core.canonicalEpisodeTarget(core.readHistory(store), 500, store);
  assert.equal(target.season, 4);
  assert.equal(target.episode, 7, "Next episode target is S4E7");

  // 1. User goes back and rewatches S2E1 (partially watched at T=3000)
  const s2e1 = core.item("tv", 500, "Epic Show", 2, 1, "off", 3000, { progress: progress(40, 100, 3000, false) });
  core.writeHistory(store, s2e1);

  target = core.canonicalEpisodeTarget(core.readHistory(store), 500, store);
  assert.equal(target.season, 2);
  assert.equal(target.episode, 1, "Continue Watching follows the active rewatch session (S2E1)");
  assert.equal(core.episodeProgressFraction(target), 0.4);

  // 2. User completes rewatch of S2E1 (completed at T=4000)
  const s2e1Done = core.item("tv", 500, "Epic Show", 2, 1, "off", 4000, { progress: progress(100, 100, 4000, true) });
  core.writeHistory(store, s2e1Done);

  target = core.canonicalEpisodeTarget(core.readHistory(store), 500, store);
  assert.equal(target.season, 2);
  assert.equal(target.episode, 2, "Completing rewatch advances to next episode in rewatched season (S2E2)");
  assert.equal(target.isNextUnwatched, true);
  assert.equal(core.episodeProgressFraction(target), 0);

  // 3. Stale delayed checkpoint for S2E3 arrives with old timestamp T=500
  const stale = core.item("tv", 500, "Epic Show", 2, 3, "off", 500, { progress: progress(50, 100, 500, false) });
  core.writeHistory(store, stale);

  target = core.canonicalEpisodeTarget(core.readHistory(store), 500, store);
  assert.equal(target.season, 2);
  assert.equal(target.episode, 2, "Stale checkpoint cannot revert or disrupt newer rewatch session");

  // 4. Duplicate completion of S2E1 is idempotent
  core.writeHistory(store, s2e1Done);
  target = core.canonicalEpisodeTarget(core.readHistory(store), 500, store);
  assert.equal(target.season, 2);
  assert.equal(target.episode, 2, "Duplicate completion is strictly idempotent");

  // 5. User intentionally returns to season 4 frontier
  const s4e7 = core.item("tv", 500, "Epic Show", 4, 7, "off", 5000, { progress: progress(100, 100, 5000, true) });
  core.writeHistory(store, s4e7);
  target = core.canonicalEpisodeTarget(core.readHistory(store), 500, store);
  assert.equal(target.season, 4);
  assert.equal(target.episode, 8, "New interaction on Season 4 advances forward frontier to S4E8");
});

test("Rewatch regression: South Park S16 rewatch, completion progression, and intentional season switching", () => {
  const store = storage();
  // Catalog with Seasons 16, 20, 27
  const catalog = [
    { number: 16, count: 14 },
    { number: 20, count: 10 },
    { number: 27, count: 10 }
  ];
  core.writeEpisodeCatalog(store, 2190, catalog, 1000);

  // Initial state: Previously watched S27E10 (series finale / furthest watched at T=1000)
  const s27e10 = core.item("tv", 2190, "South Park", 27, 10, "off", 1000, {
    progress: progress(1000, 1000, 1000, true)
  });
  core.writeHistory(store, s27e10);

  // Before rewatching, show is finished
  let target = core.canonicalEpisodeTarget(core.readHistory(store), 2190, store);
  assert.equal(target.isFinished, true, "South Park is finished initially");
  assert.equal(core.homepageFinished(core.readHistory(store), store).length, 1);
  assert.equal(core.homepageContinueCandidates(core.readHistory(store), store).length, 0);

  // Case 1: Intentionally start rewatching S16E4 (active pointer recorded at T=2000, playing at 45%)
  core.writeActiveEpisode(store, 2190, { season: 16, episode: 4, at: 2000 });
  const s16e4 = core.item("tv", 2190, "South Park", 16, 4, "off", 2050, {
    progress: progress(450, 1000, 2050, false)
  });
  core.writeHistory(store, s16e4);

  target = core.canonicalEpisodeTarget(core.readHistory(store), 2190, store);
  assert.equal(target.season, 16);
  assert.equal(target.episode, 4, "Continue Watching shows S16E4 despite S27 having been watched");
  assert.equal(target.isFinished, false);
  assert.equal(core.episodeProgressFraction(target), 0.45);

  let candidates = core.homepageContinueCandidates(core.readHistory(store), store);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].season, 16);
  assert.equal(candidates[0].episode, 4);
  assert.equal(core.homepageFinished(core.readHistory(store), store).length, 0, "Leaves Finished and appears in Continue Watching");

  // Case 2: Rewatch S16E4 reaches 95% -> advances to S16E5 at 0%, ready to start
  const s16e4Done = core.item("tv", 2190, "South Park", 16, 4, "off", 2100, {
    progress: progress(950, 1000, 2100, true)
  });
  core.writeHistory(store, s16e4Done);

  target = core.canonicalEpisodeTarget(core.readHistory(store), 2190, store);
  assert.equal(target.season, 16);
  assert.equal(target.episode, 5, "Advances to S16E5 after S16E4 completes");
  assert.equal(target.isNextUnwatched, true);
  assert.equal(target.progress, null);
  assert.equal(core.episodeProgressFraction(target), 0, "S16E5 starts at 0% (ready to start)");

  candidates = core.homepageContinueCandidates(core.readHistory(store), store);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].season, 16);
  assert.equal(candidates[0].episode, 5);

  // Case 3: Previously completed S16E5 from history years ago (T=500) must NOT skip S16E5
  const s16e5Old = core.item("tv", 2190, "South Park", 16, 5, "off", 500, {
    progress: progress(1000, 1000, 500, true)
  });
  core.writeHistory(store, s16e5Old);

  target = core.canonicalEpisodeTarget(core.readHistory(store), 2190, store);
  assert.equal(target.season, 16);
  assert.equal(target.episode, 5, "Old historical completion does not immediately skip S16E5");
  assert.equal(target.isNextUnwatched, true);
  assert.equal(target.progress, null);

  // Case 4: Finish S16E5 in this session (T=2200) -> advance to S16E6
  core.writeActiveEpisode(store, 2190, { season: 16, episode: 5, at: 2150 });
  const s16e5Done = core.item("tv", 2190, "South Park", 16, 5, "off", 2200, {
    progress: progress(1000, 1000, 2200, true)
  });
  core.writeHistory(store, s16e5Done);

  target = core.canonicalEpisodeTarget(core.readHistory(store), 2190, store);
  assert.equal(target.season, 16);
  assert.equal(target.episode, 6, "Finish S16E5 advances to S16E6");
  assert.equal(target.isNextUnwatched, true);

  // Case 5: Intentionally launch S20E2 -> switch Continue Watching to S20E2
  core.writeActiveEpisode(store, 2190, { season: 20, episode: 2, at: 3000 });
  target = core.canonicalEpisodeTarget(core.readHistory(store), 2190, store);
  assert.equal(target.season, 20);
  assert.equal(target.episode, 2, "Intentionally launching S20E2 switches target to S20E2");

  // Case 6: Delayed checkpoint for S27 arrives with older timestamp (T=1500)
  const delayedS27 = core.item("tv", 2190, "South Park", 27, 8, "off", 1500, {
    progress: progress(500, 1000, 1500, false)
  });
  core.writeHistory(store, delayedS27);

  target = core.canonicalEpisodeTarget(core.readHistory(store), 2190, store);
  assert.equal(target.season, 20);
  assert.equal(target.episode, 2, "Older delayed S27 checkpoint does not hijack active S20 session");

  // Case 7: Reloading Watch retains active rewatch target
  const reloadedTarget = core.canonicalEpisodeTarget(core.readHistory(store), 2190, store);
  assert.equal(reloadedTarget.season, 20);
  assert.equal(reloadedTarget.episode, 2, "Active episode pointer persists across reloads");
});

test("Playback integrity: short ads, provider uncertainty, and progress persistence", () => {
  // 1. Short ad duration (e.g. 22 seconds) with non-vidbolt or bad progress cannot establish completion
  const badProgress = core.progressRecord({ position: 22, duration: 22, updatedAt: 1000, provider: "yapgrid", completed: true });
  assert.equal(badProgress, null, "yapgrid provider cannot write verified progress");

  // VidBolt with duration 0 or negative
  assert.equal(core.progressRecord({ position: 10, duration: 0, updatedAt: 1000, provider: "vidbolt" }), null);

  // 2. Partial progress survives in history
  const store = storage();
  const validProgress = core.item("tv", 999, "Show", 1, 1, "off", 1000, { progress: progress(450, 1000, 1000, false) });
  core.writeHistory(store, validProgress);
  assert.equal(core.readHistory(store)[0].progress.position, 450);
});
