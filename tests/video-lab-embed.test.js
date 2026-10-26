import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createEmbedHarness } from "./video-lab-embed-fake-dom.js";

const html = readFileSync(new URL("../video-lab/embed-lab.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../video-lab/embed-lab.js", import.meta.url), "utf8");
const fixture = readFileSync(new URL("../video-lab/embed-fixture.html", import.meta.url), "utf8");
const fixtureScript = readFileSync(new URL("../video-lab/embed-fixture.js", import.meta.url), "utf8");
const CANDIDATE_URL = "https://player.vidlove.cc/embed/tv/2190/13/2";
const ids = ["candidate", "placeholder", "status", "signals", "observation", "fixture-a",
  "fixture-b", "load", "stop", "observed-player", "observed-blocked", "observed-media-error",
  "matrix", "back-lab", "horizon"];

const setup = () => createEmbedHarness({ html, script, ids });

test("embed page permits only same-origin fixture and one fixed candidate in restrictive iframe", () => {
  assert.match(html, /frame-src 'self' https:\/\/player\.vidlove\.cc/);
  assert.match(html, /sandbox="allow-scripts allow-presentation"/);
  assert.match(html, /referrerpolicy="no-referrer"/);
  assert.doesNotMatch(html, /allow-popups|allow-top-navigation|allow-same-origin|allow-downloads|allow-modals|allow-forms/);
  assert.doesNotMatch(html, /id="interact"/);
  assert.doesNotMatch(html, /<iframe[^>]*\ssrc=/);
  assert.match(script, /https:\/\/player\.vidlove\.cc\/embed\/tv\/2190\/13\/2/);
  assert.doesNotMatch(script, /contentDocument|contentWindow|postMessage|fetch\(|frame\.focus\(/);
  assert.doesNotMatch(script, /allow-same-origin|allow-popups|allow-top-navigation/);
  assert.match(fixture, /AUTHORIZED SAME-ORIGIN IFRAME FIXTURE/);
  assert.match(fixtureScript, /Fixture B/);
  assert.doesNotMatch(fixture, /Content-Security-Policy/);
  assert.match(html, /Concluded: the VidLove candidate failed/);
});

test("fixture B visibly changes its label and color without external requests", () => {
  const view = { textContent: "Fixture A" };
  const detail = { textContent: "" };
  const document = { body: { className: "" }, getElementById(id) {
    return id === "view" ? view : detail;
  } };
  runInNewContext(fixtureScript, { document, location: { search: "?view=b" } });
  assert.equal(view.textContent, "Fixture B");
  assert.equal(document.body.className, "view-b");
  assert.match(detail.textContent, /Parent-directed iframe navigation/);
  assert.doesNotMatch(fixtureScript, /fetch\(|XMLHttpRequest|postMessage/);
});

test("remote loads candidate once and Back unloads before returning to Video Lab", () => {
  const app = setup();
  const frame = app.get("candidate");
  assert.equal(frame.src, undefined);
  assert.equal(app.document.activeElement.id, "fixture-a");
  app.get("load").focus();
  app.key("Enter", true);
  assert.equal(frame.src, undefined);
  assert.equal(app.key("Enter").prevented, true);
  assert.equal(frame.src, CANDIDATE_URL);
  assert.equal(frame.hidden, false);
  assert.equal(app.timers.size, 1);
  app.get("load").click();
  assert.equal(app.timers.size, 1);
  assert.deepEqual(frame.navigations, [CANDIDATE_URL]);
  assert.match(app.get("status").textContent, /already loaded/);
  app.key("Backspace");
  app.assertDiscarded(frame);
  assert.equal(app.timers.size, 0);
  assert.deepEqual(app.navigation, []);
  app.key("Backspace");
  assert.deepEqual(app.navigation, ["index.html"]);
});

test("same-origin fixture A and B navigate the identical sandboxed frame without focus transfer", () => {
  const app = setup();
  const frame = app.get("candidate");
  app.get("fixture-a").click();
  assert.equal(frame.src, "embed-fixture.html?view=a");
  frame.dispatch("load");
  assert.match(app.get("status").textContent, /Confirm the fixture label is visible/);
  app.get("fixture-b").click();
  assert.equal(app.get("candidate"), frame);
  assert.deepEqual(frame.navigations, ["embed-fixture.html?view=a", "embed-fixture.html?view=b"]);
  assert.equal(app.document.activeElement.id, "fixture-b");
  assert.equal(app.timers.size, 1);
  app.get("stop").click();
  app.assertDiscarded(frame);
});

test("switching to or from the third-party candidate always starts a fresh browsing context", () => {
  const app = setup();
  const fixtureFrame = app.get("candidate");
  app.get("fixture-a").click();
  app.get("load").click();
  const candidateFrame = app.get("candidate");
  assert.equal(fixtureFrame.parentNode, null);
  assert.deepEqual(candidateFrame.navigations, [CANDIDATE_URL]);
  assert.equal(candidateFrame.hidden, false);
  assert.equal(candidateFrame.attributes.sandbox, "allow-scripts allow-presentation");
  assert.deepEqual(app.delays(), [12000]);
  app.get("fixture-b").click();
  const nextFrame = app.get("candidate");
  assert.equal(candidateFrame.parentNode, null);
  assert.deepEqual(nextFrame.navigations, ["embed-fixture.html?view=b"]);
  assert.deepEqual(app.delays(), [12000]);
  // Late events from the discarded candidate frame cannot touch the fixture state.
  candidateFrame.dispatch("load");
  assert.doesNotMatch(app.get("status").textContent, /navigation event received/);
});

test("iframe load event is explicitly inconclusive; manual outcomes are labeled as observations", () => {
  const app = setup();
  app.get("load").click();
  app.get("candidate").dispatch("load");
  assert.match(app.get("status").textContent, /does not prove rendering, media support, or playback/);
  assert.equal(app.timers.size, 0);
  app.get("observed-blocked").click();
  assert.match(app.get("observation").textContent, /blocked or blank frame.*manual report/);
  app.get("observed-media-error").click();
  assert.match(app.get("observation").textContent, /media error shown by player.*manual report/);
  app.get("observed-player").click();
  assert.match(app.get("observation").textContent, /player visible.*manual report/);
});

test("timeout, iframe error, and parent CSP violation have distinct bounded diagnostics", () => {
  const app = setup();
  app.get("load").click();
  app.fireTimer(12000);
  assert.match(app.get("status").textContent, /No iframe navigation signal after 12 seconds/);
  app.get("candidate").dispatch("error");
  assert.match(app.get("status").textContent, /reported a navigation error/);
  app.fireDocument("securitypolicyviolation", { effectiveDirective: "frame-src" });
  assert.match(app.get("status").textContent, /Parent content policy blocked/);
  app.get("candidate").dispatch("load");
  assert.match(app.get("status").textContent, /Parent content policy blocked/);
  app.get("stop").click();
  assert.equal(app.get("candidate").hidden, true);
  assert.ok(app.get("signals").textContent.split("→").length <= 6);
});

test("unexpected iframe focus returns to parent and frame stays loaded without auto-unload", () => {
  const app = setup();
  app.get("load").click();
  const frame = app.get("candidate");
  frame.dispatch("load");
  frame.focus();
  assert.equal(app.document.activeElement.id, "load");
  // Only 12s navigation timer exists initially; once loaded, no auto-unload timers remain
  assert.equal(app.timers.size, 0);
  assert.equal(frame.hidden, false);
  app.get("horizon").click();
  assert.equal(app.navigation.at(-1), "https://horizon-vizio.ali-al-anbari.workers.dev/");
});

test("window blur with the iframe focused returns remote focus to the parent", () => {
  const app = setup();
  app.get("fixture-a").click();
  app.document.activeElement = app.get("candidate");
  app.fireWindow("blur");
  app.fireTimer(0);
  assert.equal(app.document.activeElement.id, "fixture-a");
  assert.match(app.get("signals").textContent, /frame took focus; restored/);
  app.get("stop").click();
  app.fireWindow("blur");
  assert.equal(app.timers.size, 0);
});

test("parent errors are categorized without exposing cross-origin contents", () => {
  const app = setup();
  app.fireWindow("error");
  assert.match(app.get("signals").textContent, /parent error event/);
  app.fireWindow("unhandledrejection");
  assert.match(app.get("status").textContent, /playback state remains unknown/);
});

test("pagehide discards frame and cancels timer without navigation", () => {
  const app = setup();
  app.get("load").click();
  const frame = app.get("candidate");
  app.fireWindow("pagehide");
  app.assertDiscarded(frame);
  assert.equal(app.timers.size, 0);
  assert.deepEqual(app.navigation, []);
});

test("matrix entry unloads fixture and stays in the isolated Video Lab", () => {
  const app = setup();
  app.get("fixture-a").click();
  const frame = app.get("candidate");
  app.get("matrix").click();
  app.assertDiscarded(frame);
  assert.equal(app.navigation.at(-1), "embed-matrix.html");
});
