import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(".");
const html = fs.readFileSync(path.join(root, "universal-search/index.html"), "utf8");
const js = fs.readFileSync(path.join(root, "universal-search/search.js"), "utf8");
const css = fs.readFileSync(path.join(root, "universal-search/search.css"), "utf8");

test("Phase 4C: History Screen Structure & Components", () => {
  // Overview container and elements
  assert.match(html, /id="history-overview"/, "History overview container exists");
  assert.match(html, /id="history-back"[^>]*>← Back<\/button>/, "History overview has Back button");
  assert.match(html, /id="history-view-all"[^>]*>View All Media<\/button>/, "View All Media button exists");
  assert.match(html, /id="history-clear"[^>]*>Clear History<\/button>/, "Clear History button exists");
  assert.match(html, /id="history-list"[^>]*class="[^"]*results history-grid[^"]*"/, "History list container exists");
  assert.match(html, /id="history-movies-section"/, "History movies secondary section exists");
  assert.match(html, /id="history-tv-section"/, "History TV secondary section exists");

  // Empty state
  assert.match(html, /id="history-empty"/, "History empty state container exists");
  assert.match(html, /id="history-empty-action"[^>]*>Explore Watch Home<\/button>/, "History empty state action exists");

  // Full library view (View All Media)
  assert.match(html, /id="history-all-view"/, "History all view container exists");
  assert.match(html, /id="history-all-back"[^>]*>← History Overview<\/button>/, "History all view has return button");
  assert.match(html, /id="history-filter-all"/, "History all filter chip exists");
  assert.match(html, /id="history-filter-movie"/, "History movie filter chip exists");
  assert.match(html, /id="history-filter-tv"/, "History tv filter chip exists");
  assert.match(html, /id="history-search-input"/, "History search filter input exists");
  assert.match(html, /id="history-all-list"/, "History all list container exists");
  assert.match(html, /id="history-all-empty"/, "History all empty container exists");
});

test("Phase 4C: Settings Screen Structure & Categories", () => {
  // Landing container and category cards
  assert.match(html, /id="settings-landing"/, "Settings landing view exists");
  assert.match(html, /id="settings-cat-appearance"/, "Appearance category card exists");
  assert.match(html, /id="settings-cat-browsing"/, "Browsing category card exists");
  assert.match(html, /id="settings-cat-library"/, "Library category card exists");
  assert.match(html, /id="settings-cat-about"/, "About category card exists");

  // Summaries
  assert.match(html, /id="settings-summary-appearance"/, "Appearance summary exists");
  assert.match(html, /id="settings-summary-browsing"/, "Browsing summary exists");
  assert.match(html, /id="settings-summary-library"/, "Library summary exists");
  assert.match(html, /id="settings-summary-about"/, "About summary exists");

  // Subpage container and panels
  assert.match(html, /id="settings-subpage"/, "Settings subpage view exists");
  assert.match(html, /id="settings-subpage-back"/, "Settings subpage Back button exists");
  assert.match(html, /id="settings-subpage-title"/, "Settings subpage title exists");
  assert.match(html, /id="settings-panel-appearance"/, "Appearance subpage panel exists");
  assert.match(html, /id="settings-panel-browsing"/, "Browsing subpage panel exists");
  assert.match(html, /id="settings-panel-library"/, "Library subpage panel exists");
  assert.match(html, /id="settings-panel-about"/, "About subpage panel exists");

  // Backward compatibility with all legacy settings IDs
  const legacyIds = [
    "settings-poster-glide",
    "settings-hold-scroll",
    "settings-scroll-animations",
    "settings-hero-delay",
    "settings-hero-fade",
    "settings-artwork-fade",
    "settings-appearance-reset",
    "settings-continue",
    "settings-history",
    "settings-taste"
  ];
  for (const id of legacyIds) {
    assert.match(html, new RegExp(`id="${id}"`), `Legacy element ${id} is preserved`);
  }
  assert.match(html, /tmdb-approved\.svg/, "TMDB logo is preserved");
  assert.match(html, /This product uses the TMDB API but is not endorsed or certified by TMDB/, "TMDB attribution text is preserved");
});

test("Phase 4C: Search Screen Structure & 2:3 Vertical Posters", () => {
  assert.match(html, /id="search-view"/, "Search view exists");
  assert.match(html, /id="query"[^>]*data-focus/, "Search input query exists with data-focus");
  assert.match(html, /id="keyboard"/, "Keyboard exists");
  assert.match(html, /data-filter="all"/, "Filter all exists");
  assert.match(html, /data-filter="movie"/, "Filter movie exists");
  assert.match(html, /data-filter="tv"/, "Filter tv exists");
  assert.match(html, /id="results"/, "Results container exists");

  // Search card vertical 2:3 posters
  assert.match(js, /poster-card search-card home-card-poster/, "Search results use vertical poster card classes");
  assert.match(js, /verticalPosterArt\(row\)/, "Search results render vertical poster art");
  assert.match(js, /search-badge/, "Search results render media type badge");
  assert.match(css, /\.search-card \.poster-art \{[^}]*aspect-ratio: 2 \/ 3;/, "CSS enforces 2:3 aspect ratio on search cards");
  assert.match(css, /\.search-badge \{/, "CSS styles media badge on search posters");
});

test("Phase 4C: JavaScript Implementation & Logic", () => {
  // State extension
  assert.match(js, /historyMode:\s*"overview"/, "State includes historyMode");
  assert.match(js, /historyFilter:\s*"all"/, "State includes historyFilter");
  assert.match(js, /historyQuery:\s*""/, "State includes historyQuery");
  assert.match(js, /settingsCategory:\s*null/, "State includes settingsCategory");
  assert.match(js, /lastSettingsCategory:\s*"appearance"/, "State includes lastSettingsCategory");

  // History methods
  assert.match(js, /function createHistoryCard\(row\)/, "createHistoryCard helper exists");
  assert.match(js, /function renderHistory\(\)/, "renderHistory function exists");
  assert.match(js, /function renderHistoryAll\(\)/, "renderHistoryAll function exists");
  assert.match(js, /function openHistoryAll\(\)/, "openHistoryAll function exists");
  assert.match(js, /function closeHistoryAll\(\)/, "closeHistoryAll function exists");

  // Settings methods
  assert.match(js, /function openSettingsCategory\(catId\)/, "openSettingsCategory function exists");
  assert.match(js, /function closeSettingsCategory\(\)/, "closeSettingsCategory function exists");
  assert.match(js, /SETTINGS_CATEGORIES = \{/, "SETTINGS_CATEGORIES dictionary exists");

  // Back key handlers
  assert.match(js, /if \(state\.historyMode === "all"\) \{\s*closeHistoryAll\(\);\s*return;\s*\}/, "Back key closes History All view");
  assert.match(js, /if \(state\.settingsCategory\) \{\s*closeSettingsCategory\(\);\s*return;\s*\}/, "Back key closes Settings subpage");
});

test("Phase 4C: CSS Visual Polish & Aura Alignment", () => {
  assert.match(css, /\.poster-card:focus \.poster-art[^}]*box-shadow: 0 0 14px rgba\(138, 186, 255, 0\.45\)/, "Restrained white-blue focus aura is applied");
  assert.match(css, /\.settings-category-card:focus[^}]*box-shadow: 0 0 16px rgba\(138, 186, 255, 0\.45\)/, "Category card has focus aura");
  assert.match(css, /\.history-action-btn:focus[^}]*box-shadow: 0 0 14px rgba\(138, 186, 255, 0\.5\)/, "View All Media button has focus aura");
  assert.match(css, /\.history-empty-state \{/, "History empty state is styled");
  assert.match(css, /\.history-all-container \{/, "History All Media container is styled");
});
