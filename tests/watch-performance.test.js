import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../universal-search/watch-performance.js", import.meta.url), "utf8");
function fixture() {
  const root = {};
  runInNewContext(source, { window: root, WeakMap, Number, Date, Math });
  let ticks = 0, intervals = 0, frames = 0, nodes = 15;
  const panel = { textContent: "", setAttribute() {}, remove() {} };
  const doc = { createElement() { return panel; }, getElementById() { return { appendChild() {} }; },
    querySelectorAll() { return Array(nodes).fill(null); }, addEventListener() {}, removeEventListener() {} };
  const clock = { performance: { now: () => ticks },
    requestAnimationFrame() { frames++; return frames; }, cancelAnimationFrame() {},
    setInterval() { intervals++; return intervals; }, clearInterval() {} };
  const diagnostic = root.HorizonWatchPerformance.create(doc, clock);
  return { diagnostic, panel, clock, advance: ms => { ticks += ms; },
    counts: () => ({ frames, intervals }), grow: () => { nodes += 10; } };
}

test("Watch hero test is inert until five Down presses on Settings rail", () => {
  const app = fixture();
  for (let i = 0; i < 4; i++) {
    assert.equal(app.diagnostic.handle("ArrowDown", "watch", { id: "settings-toggle" }), false);
    app.advance(100);
  }
  assert.deepEqual(app.counts(), { frames: 0, intervals: 0 });
  assert.equal(app.diagnostic.handle("ArrowDown", "watch", { id: "settings-toggle" }, true), false,
    "held-key repeats do not activate the selector");
  for (let i = 0; i < 4; i++) app.diagnostic.handle("ArrowDown", "watch", { id: "settings-toggle" });
  assert.equal(app.diagnostic.handle("ArrowDown", "watch", { id: "settings-toggle" }), true);
  assert.equal(app.diagnostic.active(), true);
  assert.match(app.panel.textContent, /WATCH HERO TEST/);
  assert.equal(app.diagnostic.handle("ArrowRight", "watch", { id: "settings-toggle" }), true);
  assert.equal(app.diagnostic.handle("OK", "watch", { id: "settings-toggle" }), true);
  assert.equal(app.diagnostic.mode().delay, 0);
  assert.match(app.panel.textContent, /Immediate/);
  assert.equal(app.diagnostic.handle("Back", "watch", { id: "watch-toggle" }), true);
  assert.equal(app.diagnostic.active(), false);
  assert.equal(app.diagnostic.mode().delay, 0, "selection survives closing the panel during this session");
});

test("Watch performance activation expires and other screens cannot activate it", () => {
  const app = fixture();
  for (let i = 0; i < 4; i++) app.diagnostic.handle("ArrowDown", "watch", { id: "settings-toggle" });
  app.advance(2300);
  assert.equal(app.diagnostic.handle("ArrowDown", "watch", { id: "settings-toggle" }), false);
  assert.equal(app.diagnostic.handle("ArrowDown", "details", { id: "settings-toggle" }), false);
  assert.equal(app.diagnostic.active(), false);
  assert.deepEqual(app.counts(), { frames: 0, intervals: 0 });
});

test("all hero timings and Fixed Hero are reachable and mode changes are session-only", () => {
  const app = fixture(), selected = [];
  app.diagnostic.onModeChange(mode => selected.push(mode.label));
  const choose = steps => {
    for (let i = 0; i < 5; i++) app.diagnostic.handle("ArrowDown", "watch", { id: "settings-toggle" });
    for (let i = 0; i < steps; i++) app.diagnostic.handle("ArrowRight", "watch", { id: "settings-toggle" });
    app.diagnostic.handle("OK", "watch", { id: "settings-toggle" });
  };
  for (const expected of [0, 150, 250, 300, 400, 500]) {
    choose(1);
    assert.equal(app.diagnostic.mode().delay, expected);
  }
  choose(1);
  assert.equal(app.diagnostic.mode().fixed, true);
  choose(1);
  assert.equal(app.diagnostic.mode().delay, 110, "baseline resets the experimental timing");
  assert.equal(selected.length, 8);
  assert.equal(app.diagnostic.handle("ArrowRight", "watch", { id: "watch-toggle" }), false,
    "arrows navigate Watch normally after a mode is applied");
});
