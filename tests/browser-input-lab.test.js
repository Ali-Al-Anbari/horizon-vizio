import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const frontend = new URL("../frontend/", import.meta.url);
const read = name => fs.readFileSync(new URL(name, frontend), "utf8");

function inputCore() {
  const window = {};
  const context = { window, URL };
  vm.runInNewContext(read("browser-lab-core.js"), context);
  vm.runInNewContext(read("browser-input-core.js"), context);
  return window.HorizonInputCore;
}

test("probe accepts navigation keys and never records typed characters", () => {
  const core = inputCore();
  assert.equal(core.safeKey({ key: "ArrowLeft" }), "ArrowLeft");
  assert.equal(core.safeKey({ key: "Enter" }), "OK");
  assert.equal(core.safeKey({ key: "Unidentified", keyCode: 27 }), "Back");
  assert.equal(core.safeKey({ key: "p" }), null);
  assert.equal(core.safeKey({ key: "__proto__" }), null);
  const recorder = core.createRecorder(2);
  recorder.add("parent", "ArrowLeft", 12);
  recorder.add("child", "OK", 20);
  recorder.add("child", "typed password", 21);
  recorder.add("frame", "local-load", 30);
  const report = recorder.snapshot();
  assert.equal(report.parentKeys, 1);
  assert.equal(report.childKeys, 1);
  assert.equal(report.entries.length, 2);
  assert.deepEqual(Array.from(report.entries, item => item.label), ["OK", "local-load"]);
  recorder.clear();
  assert.equal(recorder.snapshot().entries.length, 0);
});

test("only the exact same-origin child frame can send safe observations", () => {
  const core = inputCore();
  const child = {};
  const origin = "https://preview.example";
  const valid = { origin, source: child,
    data: { kind: "horizon-input-probe", type: "key", key: "ArrowDown" } };
  assert.equal(core.acceptChildMessage(valid, child, origin).key, "ArrowDown");
  assert.equal(core.acceptChildMessage({ ...valid, origin: "https://evil.example" }, child, origin), null);
  assert.equal(core.acceptChildMessage({ ...valid, source: {} }, child, origin), null);
  assert.equal(core.acceptChildMessage({ ...valid, data: { ...valid.data, key: "secret" } }, child, origin), null);
  assert.equal(core.acceptChildMessage({ ...valid, data: { ...valid.data, type: "__proto__" } }, child, origin), null);
  assert.equal(core.acceptChildMessage({ ...valid,
    data: { kind: "horizon-input-probe", type: "action", action: "input", value: "private" } }, child, origin).action, "input");
});

test("input lab keeps controls in the parent document and external frame sandboxed", () => {
  const html = read("browser-input-lab.html");
  const child = read("browser-input-child.html");
  const script = read("browser-input-lab.js");
  assert.match(html, /id="input-controls"/);
  assert.match(html, /id="keyboard-panel"/);
  assert.match(html, /id="local-frame"/);
  assert.match(html, /id="external-frame"[^>]*sandbox="allow-scripts allow-forms"/);
  assert.match(html, /id="show-links"/);
  assert.match(html, /href="browser-lab.html"/);
  assert.match(child, /id="child-button"/);
  assert.match(child, /id="child-link"/);
  assert.match(child, /id="child-input"/);
  assert.match(script, /acceptChildMessage\(event, localFrame\.contentWindow, window\.location\.origin\)/);
  assert.match(script, /https:\/\/httpbin\.org\/links\/5\/0/);
  assert.doesNotMatch(script, /externalFrame\.contentWindow\.document/);
  assert.doesNotMatch(script, /localStorage|sessionStorage|fetch\(/);
});
