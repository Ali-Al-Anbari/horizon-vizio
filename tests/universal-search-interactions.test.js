import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../universal-search/search.js", import.meta.url), "utf8");
const coreSource = readFileSync(new URL("../universal-search/core.js", import.meta.url), "utf8");
const root = {};
runInNewContext(source, { window: root });
const native = root.HorizonUniversalSearch.nativeEditingKey;
const html = readFileSync(new URL("../universal-search/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../universal-search/search.css", import.meta.url), "utf8");

test("Watch rail and Settings expose the requested controls and retain TMDB attribution", () => {
  const rail = html.match(/<nav class="watch-rail"[\s\S]*?<\/nav>/)[0];
  assert.deepEqual(Array.from(rail.matchAll(/id="([^"]+-toggle)"/g), match => match[1]),
    ["watch-toggle", "search-toggle", "history-toggle", "settings-toggle"]);
  assert.match(source, /railOrder = \[get\("watch-toggle"\), get\("search-toggle"\), get\("history-toggle"\), get\("settings-toggle"\)\]/);
  assert.match(source, /railPosition \+ \(key === "ArrowDown" \? 1 : -1\)/);
  assert.match(html, /id="settings-view"/);
  assert.match(html, /id="settings-continue"/);
  assert.match(html, /id="settings-history"/);
  assert.match(html, /This product uses the TMDB API but is not endorsed or certified by TMDB/);
  assert.match(html, /icons\/tmdb-approved\.svg/);
  assert.doesNotMatch(html, /<footer>Metadata:/);
  assert.match(css, /body\.watch-active \.watch-rail::before/);
  assert.match(css, /body\.watch-active \.home-card \.poster-art \{[^}]*aspect-ratio: 16 \/ 9/s);
});

test("Watch home follows the reference layout and routes cards through the existing Watch views", () => {
  for (const id of ["watch-view", "watch-hero-title", "watch-hero-description", "watch-continue-row", "watch-recent-row"])
    assert.match(html, new RegExp(`id="${id}"`));
  assert.doesNotMatch(html, /id="home-toggle"|id="watch-hero-play"|id="watch-hero-details"/);
  assert.match(html, /<h2>Recently Finished<\/h2>/);
  assert.match(source, /core\.homepageContinueCandidates\(rows\)/);
  assert.match(source, /core\.homepageFinished\(rows\)/);
  assert.match(source, /group === "continue" \? landscapeArt\(row\) : verticalPosterArt\(row\)/);
  assert.match(source, /if \(row\.type === "movie"\) \{ openDetails\(row\); return; \}/);
  assert.match(source, /openDetails\(row, target \|\| \{ season: row\.season, episode: row\.episode \}\)/);
  assert.match(source, /lookupNextEpisode\(row, detail\)/);
  assert.match(source, /pendingEpisodeFocus = \{ season: episodeTarget\.season, episode: episodeTarget\.episode \}/);
  assert.match(source, /if \(episodeTarget \|\| state\.view === "episodes"\) browseEpisodes\(\)/);
  assert.match(source, /event\.target\.homeEntry\) showHomeHero\(event\.target\.homeEntry\)/);
  assert.match(source, /railOrder = \[get\("watch-toggle"\), get\("search-toggle"\), get\("history-toggle"\), get\("settings-toggle"\)\]/);
  assert.match(source, /revealInScroller\(element, homeScroll, true, 18\)/);
  assert.match(css, /body\.watch-active \.watch-home \{[^}]*overflow-y: auto/s);
  assert.match(css, /body\.watch-active \.watch-hero \{[^}]*min-height:/s);
  assert.match(css, /body\.watch-active \.home-card-poster \.poster-art \{[^}]*aspect-ratio: 2 \/ 3/s);
  assert.match(css, /body\.watch-active \.home-card:focus \.poster-art/);
  assert.match(css, /\.home-progress-fill\s*\{[^}]*background: #fff/s);
  assert.doesNotMatch(html, /Trending Now|Recommended For You/);
});

test("desktop search keeps editing keys native while TV arrows remain available for D-pad navigation", () => {
  for (const key of ["Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"])
    assert.equal(native({ key }, true, true), true, key);
  assert.equal(native({ key: "Delete" }, true, false), true, "Delete remains an editing key");
  for (const key of ["Backspace", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"])
    assert.equal(native({ key }, true, false), false, key);
  assert.equal(native({ key: "Enter" }, true, true), false, "Enter still submits search");
  assert.equal(native({ key: "ArrowLeft" }, false, true), false, "arrows on cards still navigate");
});

test("details retain separate Episodes routing and verified metadata without inline browsing or manual watched controls", () => {
  assert.match(html, /id="detail-information"/);
  assert.match(html, /id="episodes-view"/);
  assert.doesNotMatch(html, /id="detail-episodes"|id="detail-season-toggle"|id="providers"/);
  assert.match(source, /button\("Episodes", browseEpisodes/);
  assert.doesNotMatch(source, /Mark as watched|Mark as unwatched|setEpisodeWatched/);
  assert.match(coreSource, /row\.manualWatched === true/);
});

test("details and episode focus targets have safe space inside their clipping containers", () => {
  assert.match(css, /\.detail-view\s*\{[^}]*overflow: hidden/s);
  assert.match(css, /\.detail-copy\s*\{[^}]*overflow: visible/s);
  assert.match(css, /\.episode-list\s*\{[^}]*padding: 20px 22px 26px/s);
  assert.match(css, /\.episodes-header\s*\{[^}]*padding: 16px 20px 0/s);
  assert.match(css, /\.episodes-view \.seasons\s*\{[^}]*padding: 16px 20px 18px/s);
  assert.match(css, /\.detail-information\s*\{[^}]*grid-template-columns: repeat\(2/s);
  assert.match(source, /revealInScroller\(element, seasonStrip, true, 14\)/);
  assert.match(source, /revealInScroller\(element, episodeScroll, false, 18\)/);
  assert.doesNotMatch(source, /scrollIntoView\(/);
});

test("Details uses explicit vertical focus links and episode grid respects visual rows", () => {
  assert.match(source, /current === get\("details-back"\)[\s\S]*?key === "ArrowDown"\) focus\(actions\[0\]/);
  assert.match(source, /actionIndex >= 0[\s\S]*?key === "ArrowUp"\) focus\(get\("details-back"\)\)/);
  assert.match(source, /nextRow \* columns < plays\.length/);
  assert.match(source, /item\.classList\.contains\("is-current"\)/);
});

test("completed Continue waits for verified episode metadata before enabling the exact target", () => {
  assert.match(source, /api\("\/api\/season\/tv\/" \+ recent\.id/);
  assert.match(source, /core\.nextConfirmedEpisode\(recent, rows/);
  assert.match(source, /if \(next\) launchEpisode\(next\.season, next\.episode, false, next\.title\)/);
  assert.match(source, /primary\.disabled = completed && !next && !noNext/);
});
