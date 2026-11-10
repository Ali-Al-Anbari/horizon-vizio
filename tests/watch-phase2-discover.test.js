import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("../universal-search/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../universal-search/search.css", import.meta.url), "utf8");
const searchSource = readFileSync(new URL("../universal-search/search.js", import.meta.url), "utf8");
const engineSource = readFileSync(new URL("../universal-search/discover-engine.js", import.meta.url), "utf8");
const mockSource = readFileSync(new URL("../universal-search/mock-data.js", import.meta.url), "utf8");
const coreSource = readFileSync(new URL("../universal-search/core.js", import.meta.url), "utf8");

const root = {};
runInNewContext(coreSource, { window: root });
runInNewContext(engineSource, { window: root });
runInNewContext(mockSource, { window: root });
runInNewContext(searchSource, { window: root });

test("Phase 2A: Dedicated Discover destination in left navigation rail", () => {
  const rail = html.match(/<nav class="watch-rail"[\s\S]*?<\/nav>/)[0];
  assert.ok(rail, "Left rail exists in HTML");
  const buttons = Array.from(rail.matchAll(/id="([^"]+-toggle)"/g), match => match[1]);
  assert.deepEqual(buttons, [
    "search-toggle",
    "watch-toggle",
    "tv-toggle",
    "movies-toggle",
    "discover-toggle",
    "history-toggle",
    "settings-toggle"
  ]);

  assert.match(html, /id="discover-toggle"[^>]*aria-label="Discover"/);
  assert.match(html, /icons\/compass\.svg/);
  assert.match(searchSource, /get\("discover-toggle"\)\.addEventListener\("click"/);
  assert.match(searchSource, /discToggle\.classList\.toggle\("is-current",\s*isWatch && curTab === "discover"\)/);
});

test("Phase 2A: Focus invariant - entering rail from any content always focuses Home", () => {
  // Home entry rule: Left from first card of current cycle enters left rail with Home focused
  assert.match(searchSource, /if \(rowCycleIndex\[groupName\] <= 0\) \{\s*focus\(get\("watch-toggle"\)\);/);

  // Left from first filter chip reaches Home on rail
  assert.match(searchSource, /if \(chipIdx > 0\) focus\(chips\[chipIdx - 1\]\);\s*else focus\(get\("watch-toggle"\)\);/);

  // Up from filter chip reaches Home on rail
  assert.match(searchSource, /else if \(key === "ArrowUp"\) \{\s*focus\(get\("watch-toggle"\)\);/);
});

test("Phase 2B: Four Discover sections exist with poster carousels and match reason badges", () => {
  const discoverSectionIds = [
    "watch-discover-closest-section",
    "watch-discover-vibe-section",
    "watch-discover-genre-section",
    "watch-discover-gems-section"
  ];

  discoverSectionIds.forEach(id => {
    assert.match(html, new RegExp(`id="${id}"`), `Section ${id} must exist in HTML`);
  });

  assert.match(html, /id="watch-discover-closest-row"[\s\S]*?class="watch-home-track"/);
  assert.match(html, /id="watch-discover-vibe-row"[\s\S]*?class="watch-home-track"/);
  assert.match(html, /id="watch-discover-genre-row"[\s\S]*?class="watch-home-track"/);
  assert.match(html, /id="watch-discover-gems-row"[\s\S]*?class="watch-home-track"/);

  assert.match(searchSource, /candidate\.matchReason/);
  assert.match(searchSource, /card-match-reason/);
  assert.match(css, /\.card-match-reason/);
});

test("Phase 2C: Refinement controls on filter strip in Discover mode", () => {
  assert.match(html, /id="filter-btn-seed"/);
  assert.match(html, /id="filter-btn-mode"/);
  assert.match(html, /id="filter-btn-media"/);
  assert.match(html, /id="filter-btn-finished"/);

  assert.match(searchSource, /filterType === "seed"/);
  assert.match(searchSource, /filterType === "mode"/);
  assert.match(searchSource, /filterType === "media"/);
  assert.match(searchSource, /filterType === "finished"/);

  // Filter strip reuses genre, length, rating, year, sort
  assert.match(searchSource, /var isDiscover = state\.watchTab === "discover"/);
  assert.match(searchSource, /discoverMode !== "all" \|\| discoverMedia !== "same" \|\| !discoverHideFinished/);
});

test("Phase 2C: 'More Like This' action in Details view with round-trip Back focus", () => {
  assert.match(searchSource, /actions\.appendChild\(detailAction\("More Like This"/);
  assert.match(searchSource, /"more-like-this"/);
  assert.match(searchSource, /launchDiscoverWithSeed\(state\.title,\s*"details"\)/);

  // Back returns to details with focus on More Like This button
  assert.match(searchSource, /state\.watchTab === "discover" && state\.discoverReturnDetails/);
  assert.match(searchSource, /openDetails\(ret\.title,\s*null,\s*"more-like-this"\)/);
});
