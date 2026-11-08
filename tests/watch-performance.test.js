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

test("Watch performance probe is inert until five Up presses on Home rail", () => {
  const app = fixture();
  for (let i = 0; i < 4; i++) {
    assert.equal(app.diagnostic.handle("ArrowUp", "watch", { id: "watch-toggle" }), false);
    app.advance(100);
  }
  assert.deepEqual(app.counts(), { frames: 0, intervals: 0 });
  assert.equal(app.diagnostic.handle("ArrowUp", "watch", { id: "watch-toggle" }), true);
  assert.equal(app.diagnostic.active(), true);
  assert.match(app.panel.textContent, /Input→next frame/);
  assert.equal(app.diagnostic.handle("Back", "watch", { id: "watch-toggle" }), true);
  assert.equal(app.diagnostic.active(), false);
});

test("Watch performance activation expires and other screens cannot activate it", () => {
  const app = fixture();
  for (let i = 0; i < 4; i++) app.diagnostic.handle("ArrowUp", "watch", { id: "watch-toggle" });
  app.advance(2300);
  assert.equal(app.diagnostic.handle("ArrowUp", "watch", { id: "watch-toggle" }), false);
  assert.equal(app.diagnostic.handle("ArrowUp", "details", { id: "watch-toggle" }), false);
  assert.equal(app.diagnostic.active(), false);
  assert.deepEqual(app.counts(), { frames: 0, intervals: 0 });
});
