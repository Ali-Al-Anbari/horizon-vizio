import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../universal-search/search.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../universal-search/index.html", import.meta.url), "utf8");

test("hero preferences are local, versioned, and default to immediate without a fade", () => {
  assert.match(source, /HERO_PREF_KEY = "horizon-watch-hero-preferences"/);
  assert.match(source, /HERO_DELAYS = \[0, 110, 150, 250, 300, 400, 500\]/);
  assert.match(source, /saved\.version === 1/);
  assert.match(source, /return \{ delay: 0, fade: false \}/);
  assert.match(html, /id="settings-hero-delay" data-focus/);
  assert.match(html, /id="settings-hero-fade" data-focus/);
});

test("Finished remains data but has no visible Discover filter", () => {
  assert.doesNotMatch(html, /id="filter-btn-finished"/);
  assert.match(source, /discoverHideFinished = true/);
  assert.match(source, /hideFinished: discoverHideFinished/);
});

test("visible recommendation rows initialize their poster window before input", () => {
  assert.match(source, /activeOrder\.forEach\(function \(group\) \{[\s\S]*?revealHomeWindow\(homeCards\[group\]\[0\]\)/);
  assert.match(source, /var initialEnd = Math\.min\(cards\.length - 1, visible \+ 2\)/);
});

test("held navigation has a release and missing-keyup stop", () => {
  assert.match(source, /doc\.addEventListener\("keyup"/);
  assert.match(source, /holdMotion\.inactivityTimer = clock\.setTimeout\(finishHoldMotion, 240\)/);
  assert.match(source, /clock\.addEventListener\("blur"/);
  assert.match(source, /doc\.addEventListener\("visibilitychange"/);
  assert.match(source, /event\.repeat && key === \(holdMotion\.direction/);
});
