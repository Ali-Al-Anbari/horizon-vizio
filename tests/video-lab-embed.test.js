import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("../video-lab/embed-lab.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../video-lab/embed-lab.js", import.meta.url), "utf8");
const fixture = readFileSync(new URL("../video-lab/embed-fixture.html", import.meta.url), "utf8");
const fixtureScript = readFileSync(new URL("../video-lab/embed-fixture.js", import.meta.url), "utf8");
const CANDIDATE_URL = "https://player.vidlove.cc/embed/tv/2190/13/2";
const ids = ["candidate", "placeholder", "status", "signals", "observation", "fixture-a",
  "fixture-b", "load", "stop", "observed-player", "observed-blocked", "observed-media-error",
  "back-lab", "horizon"];

function setup() {
  const nodes = new Map();
  const docEvents = {};
  const winEvents = {};
  const timers = new Map();
  const navigation = [];
  let nextTimer = 1;
  const document = {
    activeElement: null,
    getElementById(id) { return nodes.get(id); },
    addEventListener(name, fn) { (docEvents[name] ||= []).push(fn); },
  };
  function node(id) {
    const events = {};
    return {
      id, textContent: "", hidden: id === "candidate", events,
      addEventListener(name, fn) { (events[name] ||= []).push(fn); },
      dispatch(name, detail = {}) { for (const fn of events[name] || []) fn(detail); },
      focus() { document.activeElement = this; this.dispatch("focus"); },
      click() { this.focus(); this.dispatch("click"); },
    };
  }
  for (const id of ids) nodes.set(id, node(id));
  const location = { replace(path) { navigation.push(path); } };
  const window = {
    addEventListener(name, fn) { (winEvents[name] ||= []).push(fn); },
    setTimeout(fn, delay) { const id = nextTimer++; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  runInNewContext(script, { window, document, location });
  const key = (name, repeat = false) => {
    const event = { key: name, repeat, prevented: false,
      preventDefault() { this.prevented = true; }, stopPropagation() {} };
    for (const fn of docEvents.keydown || []) fn(event);
    return event;
  };
  return { get: id => nodes.get(id), document, navigation, key, timers,
    fireDocument(name, detail) { for (const fn of docEvents[name] || []) fn(detail); },
    fireWindow(name) { for (const fn of winEvents[name] || []) fn(); },
    fireTimer(delay) {
      const entry = [...timers.entries()].find(([, value]) => value.delay === delay);
      assert.ok(entry, `expected a ${delay}ms timer`);
      timers.delete(entry[0]); entry[1].fn();
    } };
}

test("embed page permits only same-origin fixture and one fixed candidate in restrictive iframe", () => {
  assert.match(html, /frame-src 'self' https:\/\/player\.vidlove\.cc/);
  assert.match(html, /sandbox="allow-scripts allow-presentation"/);
  assert.match(html, /referrerpolicy="no-referrer"/);
  assert.doesNotMatch(html, /allow-popups|allow-top-navigation|allow-same-origin|allow-downloads/);
  assert.doesNotMatch(html, /id="interact"/);
  assert.doesNotMatch(html, /<iframe[^>]*\ssrc=/);
  assert.match(script, /https:\/\/player\.vidlove\.cc\/embed\/tv\/2190\/13\/2/);
  assert.doesNotMatch(script, /contentDocument|contentWindow|postMessage|fetch\(|frame\.focus\(/);
  assert.match(fixture, /AUTHORIZED SAME-ORIGIN IFRAME FIXTURE/);
  assert.match(fixtureScript, /Fixture B/);
  assert.doesNotMatch(fixture, /Content-Security-Policy/);
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
  assert.equal(app.get("candidate").src, undefined);
  assert.equal(app.document.activeElement.id, "fixture-a");
  app.get("load").focus();
  app.key("Enter", true);
  assert.equal(app.get("candidate").src, undefined);
  assert.equal(app.key("Enter").prevented, true);
  assert.equal(app.get("candidate").src, CANDIDATE_URL);
  assert.equal(app.get("candidate").hidden, false);
  assert.equal(app.timers.size, 2);
  app.get("load").click();
  assert.equal(app.timers.size, 2);
  assert.match(app.get("status").textContent, /already loaded/);
  app.key("Backspace");
  assert.equal(app.get("candidate").src, "about:blank");
  assert.equal(app.get("candidate").hidden, true);
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
  assert.equal(frame.src, "embed-fixture.html?view=b");
  assert.equal(app.document.activeElement.id, "fixture-b");
  assert.equal(app.timers.size, 2);
  app.get("stop").click();
  assert.equal(frame.src, "about:blank");
});

test("iframe load event is explicitly inconclusive; manual outcomes are labeled as observations", () => {
  const app = setup();
  app.get("load").click();
  app.get("candidate").dispatch("load");
  assert.match(app.get("status").textContent, /does not prove rendering, media support, or playback/);
  assert.equal(app.timers.size, 1);
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

test("unexpected iframe focus returns to parent; a 30-second timer unloads independently of keys", () => {
  const app = setup();
  app.get("load").click();
  app.get("candidate").dispatch("load");
  app.get("candidate").focus();
  assert.equal(app.document.activeElement.id, "load");
  app.fireTimer(30000);
  assert.equal(app.get("candidate").hidden, true);
  assert.equal(app.timers.size, 0);
  assert.match(app.get("status").textContent, /auto-unloaded after 30 seconds/);
  app.get("horizon").click();
  assert.equal(app.navigation.at(-1), "https://horizon-vizio.ali-al-anbari.workers.dev/");
});

test("parent errors are categorized without exposing cross-origin contents", () => {
  const app = setup();
  app.fireWindow("error");
  assert.match(app.get("signals").textContent, /parent error event/);
  app.fireWindow("unhandledrejection");
  assert.match(app.get("status").textContent, /playback state remains unknown/);
});

test("pagehide unloads frame and cancels timer without navigation", () => {
  const app = setup();
  app.get("load").click();
  app.fireWindow("pagehide");
  assert.equal(app.get("candidate").src, "about:blank");
  assert.equal(app.timers.size, 0);
  assert.deepEqual(app.navigation, []);
});
