import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../universal-search/search.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../universal-search/search.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../universal-search/index.html", import.meta.url), "utf8");

test("Phase 3C.8: isRowShort enforces the short-row and Continue Watching rule", async () => {
  await import("../universal-search/search.js");
  const isRowShort = globalThis.HorizonUniversalSearch?.isRowShort;
  assert.equal(typeof isRowShort, "function");

  // Continue Watching is ALWAYS short regardless of distinct title count
  assert.equal(isRowShort("continue", []), true);
  assert.equal(isRowShort("continue", new Array(1)), true);
  assert.equal(isRowShort("continue", new Array(5)), true);
  assert.equal(isRowShort("continue", new Array(7)), true);
  assert.equal(isRowShort("continue", new Array(8)), true);
  assert.equal(isRowShort("continue", new Array(20)), true);

  // Other rows: < 8 distinct titles is short; >= 8 is not short
  assert.equal(isRowShort("top", []), true);
  assert.equal(isRowShort("top", new Array(1)), true);
  assert.equal(isRowShort("top", new Array(4)), true);
  assert.equal(isRowShort("top", new Array(7)), true);
  assert.equal(isRowShort("top", new Array(8)), false);
  assert.equal(isRowShort("top", new Array(15)), false);

  assert.equal(isRowShort("trending", new Array(3)), true);
  assert.equal(isRowShort("trending", new Array(8)), false);
});

test("Phase 3C.8: nextHomeRowIndex reliably skips empty rows and respects boundaries", async () => {
  await import("../universal-search/search.js");
  const nextHomeRowIndex = globalThis.HorizonUniversalSearch?.nextHomeRowIndex;
  assert.equal(typeof nextHomeRowIndex, "function");

  const rows = [
    [{}, {}],   // 0: Continue Watching (2 items)
    [],         // 1: Top Picks (empty/hidden)
    [],         // 2: Because (empty/hidden)
    [{}, {}, {}], // 3: Trending (3 items)
    [],         // 4: Gems (empty)
    [{}]        // 5: Recent (1 item)
  ];

  // Down (+1) from Continue (0) must reliably skip empty rows 1 & 2 and land on Trending (3)
  assert.equal(nextHomeRowIndex(rows, 0, 1), 3);

  // Up (-1) from Trending (3) must reliably return to Continue Watching (0)
  assert.equal(nextHomeRowIndex(rows, 3, -1), 0);

  // Down (+1) from Trending (3) must skip 4 and land on Recent (5)
  assert.equal(nextHomeRowIndex(rows, 3, 1), 5);

  // Down (+1) from Recent (5) has no next row
  assert.equal(nextHomeRowIndex(rows, 5, 1), -1);

  // Up (-1) from Continue (0) has no previous row
  assert.equal(nextHomeRowIndex(rows, 0, -1), -1);
});

test("Phase 3C.8: Stationary focus aura and track transition suppression rules in CSS", () => {
  // Stationary focus aura pseudo-element
  assert.match(css, /\.watch-home-row\.is-hold-scrolling::after\s*\{[^}]*position:\s*absolute/);
  assert.match(css, /\.watch-home-row\.is-hold-scrolling::after\s*\{[^}]*top:\s*11px/);
  assert.match(css, /\.watch-home-row\.is-hold-scrolling::after\s*\{[^}]*left:\s*var\(--watch-gutter\)/);
  assert.match(css, /\.watch-home-row\.is-hold-scrolling::after\s*\{[^}]*width:\s*var\(--hold-outline-width\)/);
  assert.match(css, /\.watch-home-row\.is-hold-scrolling::after\s*\{[^}]*height:\s*var\(--hold-outline-height\)/);
  assert.match(css, /\.watch-home-row\.is-hold-scrolling::after\s*\{[^}]*outline:\s*2px solid #fff/);

  // Suppress poster art individual focus outline while hold-scrolling
  assert.match(css, /\.watch-home-row\.is-hold-scrolling \.home-card \.poster-art\s*\{[^}]*outline:\s*none/);
  assert.match(css, /\.watch-home-row\.is-hold-scrolling \.home-card \.poster-art\s*\{[^}]*box-shadow:\s*none/);

  // Track transition suppression during motion to avoid CSS competing with rAF
  assert.match(css, /\.watch-home-row\.is-hold-scrolling \.watch-home-track\s*\{[^}]*transition:\s*none !important/);
});

test("Phase 3C.8: Search.js implements unified motion, focus recovery, and non-looping short rows", () => {
  // Focus recovery on body or detached focus
  assert.match(source, /var current = doc\.activeElement;/);
  assert.match(source, /!current\.dataset\.homeGroup && !current\.hasAttribute\("data-focus"\)/);

  // Unified horizontal motion state machine
  assert.match(source, /function stepHorizontalMotion\(groupName, direction, isHold\)/);
  assert.match(source, /function motionFrame\(timestamp\)/);
  assert.match(source, /function finishHorizontalMotion\(\)/);

  // Short row non-looping boundary checks
  assert.match(source, /var isShort = isRowShort\(groupName, group\);/);
  assert.match(source, /if \(isShort\) \{\s*if \(index <= 0\) \{\s*focus\(get\("watch-toggle"\)\);/);
  assert.match(source, /if \(isShort\) \{\s*if \(index < group\.length - 1\) \{\s*focus\(group\[index \+ 1\], true, 1\);/);

  // Vertical keys settle horizontal motion before moving
  assert.match(source, /if \(key === "ArrowDown" \|\| key === "ArrowUp" \|\| key === "OK" \|\| key === "Back"\) \{\s*finishHoldMotion\(\);/);
});

test("Phase 3C.8: Settings preferences and defaults preserved", () => {
  assert.match(source, /HERO_PREF_KEY = "horizon-watch-hero-preferences"/);
  assert.match(source, /HERO_DELAYS = \[0, 110, 150, 250, 300, 400, 500\]/);
  assert.match(source, /return \{ delay: 0, fade: false \}/);
  assert.match(html, /id="settings-hero-delay"/);
  assert.match(html, /id="settings-hero-fade"/);
});
