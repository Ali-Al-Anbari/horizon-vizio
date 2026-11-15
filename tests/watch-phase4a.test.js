import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../universal-search/search.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../universal-search/search.css", import.meta.url), "utf8");

test("desktop hero routes vertical wheel input without intercepting zoom or filter menus", () => {
  assert.match(source, /get\("watch-hero"\)\.addEventListener\("wheel"/);
  assert.match(source, /event\.ctrlKey \|\| event\.metaKey/);
  assert.match(source, /event\.target\.closest\("#watch-filter-menu"\)/);
  assert.match(source, /event\.deltaMode === 1 \? 16/);
  assert.match(source, /\{ passive: false \}/);
});

test("hover is presentation-only and desktop pointer scoped", () => {
  assert.doesNotMatch(source, /addEventListener\("mouseenter"/);
  assert.match(source, /classList\.toggle\("watch-desktop-pointer", finePointer\)/);
  assert.match(css, /@media \(hover: hover\) and \(pointer: fine\)/);
  assert.match(css, /\.home-card:hover \.poster-art/);
});

test("desktop hero reduction leaves TV heights intact", () => {
  assert.match(css, /body\.watch-active \.watch-home \{ --watch-hero-height: 59vh/);
  assert.match(css, /body\.watch-active\.watch-desktop-pointer \.watch-home \{ --watch-hero-height: 52vh/);
  assert.match(css, /body\.watch-active\.watch-desktop-pointer \.watch-home \{ --watch-hero-height: 48vh/);
});

test("open filter menu contains Tab navigation", () => {
  assert.match(source, /if \(activeFilterMenuType && key === "Tab"\)/);
  assert.match(source, /event\.shiftKey \? menuOptions\.length - 1 : 1/);
});

test("desktop Settings owns its vertical scroll surface", () => {
  assert.match(source, /classList\.toggle\("settings-active", name === "settings"\)/);
  assert.match(css, /body\.watch-desktop-pointer\.settings-active \.watch-content \{ height: 100vh/);
});
