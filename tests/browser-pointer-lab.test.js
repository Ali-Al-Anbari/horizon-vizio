import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const frontend = path.resolve("frontend");
const read = name => fs.readFileSync(path.join(frontend, name), "utf8");
function loadCore() {
  const context = {};
  vm.runInNewContext(read("browser-lab-core.js"), context);
  vm.runInNewContext(read("browser-pointer-core.js"), context);
  return { browser: context.HorizonBrowserCore, pointer: context.HorizonPointerCore };
}

test("cursor mode remains separate from frame focus and Back restores toolbar", () => {
  const { pointer } = loadCore();
  assert.equal(pointer.nextMode("toolbar", "cursor"), "cursor");
  assert.equal(pointer.nextMode("cursor", "frame"), "frame");
  assert.equal(pointer.nextMode("frame", "back"), "toolbar");
  assert.equal(pointer.nextMode("cursor", "back"), "toolbar");
  assert.equal(pointer.nextMode("toolbar", "unrecognized"), "toolbar");
});

test("only the cooperating fixture permits a synthetic activation", () => {
  const { pointer } = loadCore();
  assert.equal(pointer.activation("local"), "local-synthetic");
  for (const surface of ["links", "form", "google", "unknown", "__proto__"])
    assert.equal(pointer.activation(surface), "external-unavailable");
});

test("single remote presses move precisely and stay inside viewport", () => {
  const { browser } = loadCore();
  const start = { x: 50, y: 50, lastKey: "", lastAt: 0, streak: 0 };
  const first = browser.moveCursor(start, "ArrowRight", false, 1, 100, 100);
  const second = browser.moveCursor(first, "ArrowRight", false, 2, 100, 100);
  assert.equal(first.x, 66);
  assert.equal(second.x, 82);
  assert.equal(second.streak, 0);
  const held = browser.moveCursor(second, "ArrowRight", true, 3, 100, 100);
  assert.equal(held.x, 88);
  assert.equal(held.streak, 1);
  const edge = browser.moveCursor(held, "ArrowDown", false, 4, 100, 100);
  assert.ok(edge.y <= 88);
});

test("diagnostics are bounded and discard arbitrary data", () => {
  const { pointer } = loadCore();
  const log = pointer.createLog(2);
  log.add("parent-key", 1);
  log.add("private text", 2);
  log.add("external-click-unavailable", 3);
  log.add("toolbar-restored", 4);
  const snapshot = log.snapshot();
  assert.equal(snapshot.parentKeys, 1);
  assert.deepEqual(Array.from(snapshot.entries, entry => entry.event), ["external-click-unavailable", "toolbar-restored"]);
});

test("experiment keeps parent overlay above a sandboxed external frame", () => {
  const html = read("browser-pointer-lab.html");
  const css = read("browser-pointer-lab.css");
  const script = read("browser-pointer-lab.js");
  assert.match(html, /id="viewport"[^>]*tabindex="0"/);
  assert.match(html, /id="external-frame"[^>]*sandbox="allow-scripts allow-forms"/);
  assert.match(html, /id="cursor"/);
  assert.match(html, /id="return-lab" href="browser-lab\.html"/);
  assert.match(css, /\.viewport iframe[^}]*z-index:\s*1/);
  assert.match(css, /\.cursor[^}]*z-index:\s*10/);
  assert.match(css, /\.cursor[^}]*pointer-events:\s*none/);
  assert.match(script, /focus\(viewport\)/);
  assert.match(script, /focus\(surface === "local" \? localFrame : externalFrame\)/);
  assert.match(script, /input\.acceptChildMessage\(event, localFrame\.contentWindow, window\.location\.origin\)/);
  assert.doesNotMatch(script, /externalFrame\.contentWindow\.document|externalFrame\.contentDocument/);
  assert.doesNotMatch(script, /new MouseEvent|dispatchEvent\(|localStorage|sessionStorage|fetch\(/);
});

test("external load and external OK remain explicitly indeterminate or unavailable", () => {
  const script = read("browser-pointer-lab.js");
  assert.match(script, /frame-load-indeterminate/);
  assert.match(script, /loading alone proves neither rendering nor interaction/i);
  assert.match(script, /external-click-unavailable/);
  assert.match(script, /No external click was sent/);
  assert.match(script, /C External activation: unverified/);
  assert.match(script, /if \(key === "Back"\)[\s\S]*?focusToolbar\(5\)/);
});
