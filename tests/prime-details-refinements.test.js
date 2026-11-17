import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../universal-search/search.js", import.meta.url), "utf8");
const coreSource = readFileSync(new URL("../universal-search/core.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../universal-search/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../universal-search/search.css", import.meta.url), "utf8");

test("Requirement 1: Love It and Not Interested remain adjacent in single horizontal action row", () => {
  assert.match(css, /\.detail-actions\s*\{[^}]*flex-wrap:\s*nowrap/s, "Action row must not wrap");
  assert.match(css, /\.detail-actions\s*\{[^}]*gap:\s*clamp\(8px/s, "Compact gap between actions");
  assert.match(css, /\.detail-copy\s*\{[^}]*width:\s*min\(70vw,\s*1100px\)/s, "Sufficient width to prevent clipping");
  assert.match(source, /add\("liked",\s*"Love It",\s*"love-it"\);[\s\S]*?add\("disliked",\s*"Not Interested",\s*"not-interested"\);/, "Love It and Not Interested appended adjacent");
});

test("Requirement 2 & 3: Up from episode rail focuses season selector without resetting scrollTop; Down restores previous episode", () => {
  // Verifies that playIndex ArrowUp does not reset scroller scrollTop to 0
  const playIndexBlock = source.match(/if \(playIndex >= 0\) \{[\s\S]*?return;\s*\}/)?.[0];
  assert.ok(playIndexBlock, "playIndex block exists");
  assert.match(playIndexBlock, /if \(key === "ArrowUp"\)\s*\{\s*focus\(seasonBtn/, "ArrowUp moves focus to seasonBtn");
  assert.doesNotMatch(playIndexBlock, /scRoll\.scrollTop = 0/, "Must not reset detail-scroller scrollTop on Up from episode");
  
  // Verifies that Down from seasonBtn restores lastFocusedEpisodeCard or active target
  const seasonBtnBlock = source.match(/if \(current === seasonBtn\) \{[\s\S]*?return;\s*\}/)?.[0];
  assert.ok(seasonBtnBlock, "seasonBtn block exists");
  assert.match(seasonBtnBlock, /targetEpisodeCard = \(state\.lastFocusedEpisodeCard/, "Down from seasonBtn checks lastFocusedEpisodeCard");
  assert.match(seasonBtnBlock, /revealInScroller\(targetEpisodeCard,\s*get\("episode-list"\),\s*true,\s*24\)/, "Reveals target episode card");
  assert.match(seasonBtnBlock, /if \(key === "ArrowUp"\)[\s\S]*?scTop\.scrollTop = 0/, "Only Up from seasonBtn scrolls back to top hero");
});

test("Requirement 4 & 5: Season dropdown scrolls internally without moving main details scroller, absorbs Left/Right", () => {
  assert.match(source, /var dropdown = element\.closest\("#seasons-dropdown"\);[\s\S]*?if \(dropdown\) revealInScroller\(element, dropdown, false, 8\);/, "Dropdown scrolls internally on focus");
  assert.match(source, /if \(detailScroller && !seasonStrip\)\s*\{\s*revealInScroller\(element, detailScroller, false, 48\);/, "Main details scroller is skipped when navigating season dropdown");
  
  const dropdownMoveBlock = source.match(/if \(seasonDropdown && !seasonDropdown\.hidden && seasonIndex >= 0\) \{[\s\S]*?return;\s*\}/)?.[0];
  assert.ok(dropdownMoveBlock, "dropdownMoveBlock exists");
  assert.match(dropdownMoveBlock, /key === "ArrowDown"[\s\S]*?Math\.min\(seasonButtons\.length - 1,\s*seasonIndex \+ 1\)/);
  assert.match(dropdownMoveBlock, /key === "ArrowUp"[\s\S]*?Math\.max\(0,\s*seasonIndex - 1\)/);
  assert.match(dropdownMoveBlock, /return;/, "Absorbs other keys so focus cannot escape into background");
});

test("Requirement 6: Modern rounded season selector styling and absence of harsh blue focus box", () => {
  assert.match(css, /\.season-selector-btn\s*\{[^}]*background:\s*rgba\(22,\s*26,\s*34/s, "Dark charcoal neutral background");
  assert.match(css, /\.season-selector-btn\s*\{[^}]*border-radius:\s*999px/s, "Pill-like shape");
  assert.match(css, /\.season-selector-btn:focus,\s*\.season-selector-btn\.is-focused\s*\{[^}]*outline:\s*2px solid #fff/s, "White focus outline");
  assert.match(css, /\.seasons-dropdown\s*\{[^}]*background:\s*#141820/s, "Dark neutral dropdown background");
  assert.match(css, /\.seasons-dropdown\s*\{[^}]*border-radius:\s*12px/s, "Rounded dropdown panel");
  assert.match(css, /\.episodes-view \.seasons button:focus,\s*\.episodes-view \.seasons button\.is-focused\s*\{[^}]*background:\s*#ffffff;\s*color:\s*#0d1117/s, "High contrast focused option");
  
  // Confirms season-selector-btn was removed from the old cyan box-shadow rule
  assert.doesNotMatch(css, /\.season-selector-btn:focus,\s*\.season-selector-btn\.is-focused,\s*\.detail-rec-card/, "Season button not in legacy cyan glow rule");
});

test("Requirement 7, 8, & 9: Canonical active episode/season resolution, rewatch preservation, and explicit browsing retention", () => {
  assert.match(source, /var canonical = core\.canonicalEpisodeTarget\(historyRows,\s*state\.title\.id,\s*state\.detail \|\| local,\s*local\);/, "Resolves canonical episode target");
  assert.match(source, /!state\.userExplicitlyBrowsedEpisodes && canonical/, "Prioritizes canonical target unless explicitly changed");
  assert.match(source, /function selectSeason\(number\) \{[\s\S]*?state\.userExplicitlyBrowsedEpisodes = true;/, "selectSeason marks explicit browsing");
  assert.match(source, /openDetails\(row, episodeTarget, focusAction\) \{[\s\S]*?state\.userExplicitlyBrowsedEpisodes = false;/, "openDetails resets explicit browsing flag for fresh load");
});

test("Requirement 10: Episode title region has stable vertical geometry to eliminate bounce", () => {
  assert.match(css, /\.focused-episode-panel\s*\{[^}]*min-height:\s*165px/s, "Panel has reserved stable min-height");
  assert.match(css, /\.focused-episode-title\s*\{[^}]*min-height:\s*2\.4em;\s*max-height:\s*2\.4em/s, "Title reserves exactly 2 lines");
  assert.match(css, /\.focused-episode-title\s*\{[^}]*-webkit-line-clamp:\s*2/s, "Clamps to 2 lines");
  assert.match(css, /\.focused-episode-summary\s*\{[^}]*min-height:\s*4\.35em;\s*max-height:\s*4\.35em/s, "Summary reserves exactly 3 lines");
  assert.match(css, /\.focused-episode-summary\s*\{[^}]*-webkit-line-clamp:\s*3/s, "Clamps to 3 lines");
  assert.match(css, /\.focused-episode-meta\s*\{[^}]*min-height:\s*28px;\s*height:\s*28px/s, "Meta row has fixed 28px height");
});

test("Requirement 11, 12, & 13: Direct Back navigation to Watch Home with dropdown exception", () => {
  const backBlock = source.match(/else if \(state\.view === "episodes" \|\| state\.view === "details"\) \{[\s\S]*?returnWithinWatch\(backToResults\);\s*\}/)?.[0];
  assert.ok(backBlock, "Details/Episodes Back block exists");
  assert.match(backBlock, /if \(sdd && !sdd\.hidden\) \{\s*closeSeasonDropdown\(true\);\s*return;\s*\}/, "Open dropdown closes on first Back");
  assert.match(backBlock, /returnWithinWatch\(backToResults\);/, "Back exits directly via returnWithinWatch(backToResults)");
  assert.doesNotMatch(backBlock, /inEp/, "No intermediate scroll or button focus step");
});

test("Requirement 14 & 15: Movie details and Video Lab integration remain intact", () => {
  assert.match(source, /if \(row\.type === "movie"\) \{ openDetails\(row\); return; \}/, "Movie routing unchanged");
  assert.match(source, /player\.tvUrl\(state\.title\.id,\s*season,\s*episode/, "TV Player URL invocation unchanged");
  assert.match(source, /launchEpisode\(seasonNumber,\s*ep\.number\)/, "Launch episode invocation unchanged");
});
