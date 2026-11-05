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

test("Watch homepage has real history rows, an empty discovery state, and explicit focus groups", () => {
  for (const id of ["watch-view", "watch-hero-play", "watch-hero-details", "watch-continue-row", "watch-recent-row"])
    assert.match(html, new RegExp(`id="${id}"`));
  assert.match(source, /core\.homepageHistory\(core\.readHistory\(local\)\)/);
  assert.match(source, /core\.homepageContinueCandidates\(core\.readHistory\(local\)\)/);
  assert.match(source, /lookupNextEpisode\(row, detail\)/);
  assert.match(source, /if \(homeHeroEntry\) startHomeEntry\(homeHeroEntry\)/);
  assert.match(source, /else get\("search-toggle"\)\.click\(\)/);
  assert.match(source, /if \(state\.view === "watch"\) \{[\s\S]*?var hero = /);
  assert.match(source, /else if \(key === "ArrowDown"\) focus\(down\[/);
  assert.match(source, /revealInScroller\(element, homeScroll, true, 18\)/);
  assert.match(css, /\.watch-home-row\s*\{[^}]*overflow-x: auto/s);
  assert.match(css, /\.home-card:focus \.poster-art/);
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
