import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../universal-search/search.js", import.meta.url), "utf8");
const root = {};
runInNewContext(source, { window: root });
const native = root.HorizonUniversalSearch.nativeEditingKey;

test("desktop search keeps editing keys native while TV arrows remain available for D-pad navigation", () => {
  for (const key of ["Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"])
    assert.equal(native({ key }, true, true), true, key);
  assert.equal(native({ key: "Delete" }, true, false), true, "Delete remains an editing key");
  for (const key of ["Backspace", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"])
    assert.equal(native({ key }, true, false), false, key);
  assert.equal(native({ key: "Enter" }, true, true), false, "Enter still submits search");
  assert.equal(native({ key: "ArrowLeft" }, false, true), false, "arrows on cards still navigate");
});
