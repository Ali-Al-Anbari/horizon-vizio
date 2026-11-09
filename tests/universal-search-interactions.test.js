import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../universal-search/search.js", import.meta.url), "utf8");
const coreSource = readFileSync(new URL("../universal-search/core.js", import.meta.url), "utf8");
const root = {};
runInNewContext(source, { window: root });
const native = root.HorizonUniversalSearch.nativeEditingKey;
const adjacentHomeRow = root.HorizonUniversalSearch.adjacentHomeRow;
const circularIndex = root.HorizonUniversalSearch.circularIndex;
const html = readFileSync(new URL("../universal-search/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../universal-search/search.css", import.meta.url), "utf8");

test("Watch rail and Settings expose the requested controls and retain TMDB attribution", () => {
  const rail = html.match(/<nav class="watch-rail"[\s\S]*?<\/nav>/)[0];
  assert.deepEqual(Array.from(rail.matchAll(/id="([^"]+-toggle)"/g), match => match[1]),
    ["search-toggle", "watch-toggle", "tv-toggle", "movies-toggle", "history-toggle", "settings-toggle"]);
  assert.match(source, /railButtons = \[get\("search-toggle"\), get\("watch-toggle"\), get\("tv-toggle"\), get\("movies-toggle"\), get\("history-toggle"\), get\("settings-toggle"\)\]/);
  assert.match(source, /railPosition \+ \(key === "ArrowDown" \? 1 : -1\)/);
  assert.match(html, /id="settings-view"/);
  assert.match(html, /id="settings-continue"/);
  assert.match(html, /id="settings-history"/);
  assert.match(html, /This product uses the TMDB API but is not endorsed or certified by TMDB/);
  assert.match(html, /icons\/tmdb-approved\.svg/);
  assert.doesNotMatch(html, /<footer>Metadata:/);
  assert.match(css, /body\.watch-active \.watch-rail::before \{ content: none; \}/);
  assert.match(css, /body\.watch-active \.rail-action \{[^}]*border-radius: 50%/s);
  assert.match(css, /body\.watch-active \.home-card \.poster-art \{[^}]*aspect-ratio: 16 \/ 9/s);
});

test("Watch home follows the reference layout and routes cards through the existing Watch views", () => {
  for (const id of ["watch-view", "watch-hero-title", "watch-hero-description", "watch-continue-row", "watch-recent-row"])
    assert.match(html, new RegExp(`id="${id}"`));
  assert.doesNotMatch(html, /id="home-toggle"|id="watch-hero-play"|id="watch-hero-details"/);
  assert.match(html, /<h2>Recently Finished<\/h2>/);
  assert.match(source, /core\.homepageContinueCandidates\(rows, local\)/);
  assert.match(source, /core\.homepageFinished\(rows, local\)/);
  assert.match(source, /group === "continue" \? landscapeArt\(row, true\) : verticalPosterArt\(row, true\)/);
  assert.match(source, /loadHomeWindowArt\(/);
  assert.match(source, /if \(row\.type === "movie"\) \{ openDetails\(row\); return; \}/);
  assert.match(source, /openDetails\(row, target \|\| \{ season: row\.season, episode: row\.episode \}\)/);
  assert.match(source, /lookupNextEpisode\(row, detail\)/);
  assert.match(source, /pendingEpisodeFocus = \{ season: episodeTarget\.season, episode: episodeTarget\.episode \}/);
  assert.match(source, /if \(episodeTarget \|\| state\.view === "episodes"\) browseEpisodes\(\)/);
  assert.match(source, /event\.target\.homeEntry\) showHomeHero\(event\.target\.homeEntry\)/);
  assert.match(source, /railButtons = \[get\("search-toggle"\), get\("watch-toggle"\), get\("tv-toggle"\), get\("movies-toggle"\), get\("history-toggle"\), get\("settings-toggle"\)\]/);
  assert.match(source, /revealInScroller\(element, homeScroll, true, 18,[\s\S]*?railEdge/);
  assert.match(css, /body\.watch-active \.watch-rows-scroll \{[^}]*overflow-y: auto/s);
  assert.match(css, /body\.watch-active \.watch-hero \{[^}]*min-height:/s);
  assert.match(css, /body\.watch-active \.home-card-poster \.poster-art \{[^}]*aspect-ratio: 2 \/ 3/s);
  assert.match(css, /body\.watch-active \.home-card:focus \.poster-art/);
  assert.match(css, /\.home-progress-fill\s*\{[^}]*background: #fff/s);
  assert.doesNotMatch(html, /Trending Now|Recommended For You/);
});

test("Watch hero remains outside the only vertical row scroller and recommendation focus paints it", () => {
  assert.match(html, /id="watch-hero"[\s\S]*?id="watch-rows-scroll"/);
  assert.match(css, /body\.watch-active \.watch-home \{[^}]*height: 100vh;[^}]*overflow: hidden/s);
  assert.match(css, /body\.watch-active \.watch-hero \{[^}]*height: var\(--watch-hero-height\);[^}]*flex: none/s);
  assert.match(source, /card\.homeEntry = \{ row: candidate, group: group \}/);
  assert.match(source, /entry\.group !== "top" && entry\.group !== "because"/);
  assert.match(source, /function revealHomeSection\(element\)/);
});

test("active Watch heading is outside the clipped scroller and above the decorative fade", () => {
  assert.match(html, /id="watch-hero"[\s\S]*?id="watch-active-heading"[^>]*>[\s\S]*?id="watch-rows-scroll"/);
  assert.match(css, /body\.watch-active \.watch-active-heading \{[^}]*z-index: 4/s);
  assert.match(css, /body\.watch-active \.watch-home::after \{[^}]*z-index: 2/s);
  assert.match(css, /body\.watch-active \.watch-home-section\.is-active-home-section > h2 \{ opacity: 0; \}/);
  assert.match(source, /function syncActiveHomeHeading\(element, force\)/);
  assert.match(source, /syncActiveHomeHeading\(element\)/);
});

test("Continue Watching precedes recommendations in DOM and remote row order", () => {
  assert.ok(html.indexOf('id="watch-continue-section"') < html.indexOf('id="watch-top-section"'));
  assert.ok(html.indexOf('id="watch-top-section"') < html.indexOf('id="watch-because-section"'));
  assert.match(source, /homeRowOrder = \["continue", "top", "because", "recent"\]/);
});

test("focused rail circle expands with adjacent controls spaced apart", () => {
  assert.match(css, /body\.watch-active \.rail-action:focus,[\s\S]*?transform: scale\(1\.1\)/);
  assert.match(css, /\.rail-action\.rail-neighbor-before \{ transform: translateY\(-5px\)/);
  assert.match(css, /\.rail-action\.rail-neighbor-after \{ transform: translateY\(5px\)/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test("horizontal poster traversal cannot trigger vertical row reveal", () => {
  assert.match(source, /if \(!skipHomeVertical && element\.closest\("#watch-rows-scroll"\)[\s\S]*?previousHomeGroup !== element\.dataset\.homeGroup\)\s*revealHomeSection\(element\)/);
  assert.match(source, /key === "ArrowLeft"\)[\s\S]*?focus\(group\[circularIndex\(index, group\.length, -1\)\], true/);
  assert.match(source, /key === "ArrowRight"\)[\s\S]*?focus\(group\[circularIndex\(index, group\.length, 1\)\], true/);
  assert.match(css, /body\.watch-active \.watch-rows-scroll \{[^}]*scroll-behavior: auto/s);
  assert.match(source, /element\.getBoundingClientRect\(\)\.bottom/);
});

test("circular home index handles empty, single, and two-title rows", () => {
  assert.equal(circularIndex(0, 0, 1), -1);
  assert.equal(circularIndex(0, 1, 1), 0);
  assert.equal(circularIndex(0, 1, -1), 0);
  assert.equal(circularIndex(0, 2, -1), 1);
  assert.equal(circularIndex(1, 2, 1), 0);
});

test("last visible homepage row has no Down target, including dynamically hidden rows", () => {
  const top = [{}], continueRow = [{}], because = [{}], recent = [{}];
  assert.equal(adjacentHomeRow([top, continueRow, because, recent], 3, 1), null);
  assert.equal(adjacentHomeRow([top, continueRow, because, []], 2, 1), null);
  assert.equal(adjacentHomeRow([top, [], because, []], 0, 1), because);
  assert.equal(adjacentHomeRow([top, [], because, []], 2, -1), top);
  assert.match(source, /if \(down\) \{ var downGroup/);
  assert.doesNotMatch(source, /down\.length \?[^;]*get\("history-toggle"\)/);
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
  assert.match(source, /detailAction\("Episodes", browseEpisodes/);
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

test("Details has no per-title subtitle control and Watch rows preserve normal full-width track layout", () => {
  assert.doesNotMatch(source, /function appendSubtitleAction/);
  assert.doesNotMatch(source, /appendSubtitleAction\(\)/);
  assert.doesNotMatch(html, /detail-subtitles/);
  assert.doesNotMatch(css, /\.detail-actions \.detail-subtitles/);
  assert.match(css, /body\.watch-active \.watch-home-track \{[^}]*display: contents/);
  assert.match(css, /body\.watch-active \.watch-home-row \{[^}]*overflow-x: auto/);
});
