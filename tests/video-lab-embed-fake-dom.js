// Shared fake DOM for the isolated Video Lab embed tests. Not a test file
// itself (no .test.js suffix). The candidate iframe starts with the exact
// attributes from the page markup and sits inside a stage whose replaceChild
// detaches the old frame, so tests can prove that unload destroys the
// browsing context instead of merely re-navigating it.
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

export function markupFrameAttributes(html) {
  const tag = /<iframe\b([^>]*)>/.exec(html);
  assert.ok(tag, "expected iframe markup");
  const attributes = {};
  for (const match of tag[1].matchAll(/([a-z-]+)(?:="([^"]*)")?/g)) {
    attributes[match[1]] = match[2] ?? "";
  }
  return attributes;
}

export function createEmbedHarness({ html, script, ids }) {
  const nodes = new Map();
  const docEvents = {};
  const winEvents = {};
  const timers = new Map();
  const navigation = [];
  const discarded = [];
  let nextTimer = 1;
  let time = 1000;
  const document = {
    activeElement: null,
    getElementById(id) { return nodes.get(id); },
    addEventListener(name, fn) { (docEvents[name] ||= []).push(fn); },
  };
  function node(id) {
    const events = {};
    const attributes = {};
    const self = {
      id, hidden: false, textContent: "", attributes, events, parentNode: null,
      // Real iframes reflect src to the attribute, so cloneNode copies it.
      get src() { return attributes.src; },
      set src(value) { attributes.src = String(value); self.navigations.push(String(value)); },
      navigations: [],
      setAttribute(name, value) { attributes[name] = String(value); },
      removeAttribute(name) { delete attributes[name]; },
      addEventListener(name, fn) { (events[name] ||= []).push(fn); },
      dispatch(name, value = {}) { for (const fn of events[name] || []) fn(value); },
      focus() { document.activeElement = self; self.dispatch("focus"); },
      click() { self.focus(); self.dispatch("click"); },
      cloneNode(deep) {
        assert.equal(deep, false, "iframe clone must be shallow");
        const copy = node(id);
        Object.assign(copy.attributes, attributes);
        copy.hidden = self.hidden;
        return copy;
      },
    };
    return self;
  }
  for (const id of ids) nodes.set(id, node(id));
  const markup = markupFrameAttributes(html);
  const initial = nodes.get("candidate");
  for (const [name, value] of Object.entries(markup)) {
    if (name !== "id" && name !== "hidden") initial.attributes[name] = value;
  }
  initial.hidden = "hidden" in markup;
  const stage = {
    replaceChild(fresh, old) {
      assert.equal(old.parentNode, stage, "replaced frame must be attached");
      old.parentNode = null;
      fresh.parentNode = stage;
      nodes.set("candidate", fresh);
      discarded.push(old);
      return old;
    },
  };
  initial.parentNode = stage;
  const location = { replace(path) { navigation.push(path); } };
  const window = {
    performance: { now() { return time; } },
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
  return {
    get: id => nodes.get(id), document, timers, navigation, discarded, markup, key,
    advance(ms) { time += ms; },
    delays() { return [...timers.values()].map(value => value.delay).sort((a, b) => a - b); },
    fireTimer(delay) {
      const entry = [...timers.entries()].find(([, value]) => value.delay === delay);
      assert.ok(entry, `expected a ${delay}ms timer`);
      timers.delete(entry[0]); entry[1].fn();
    },
    fireDocument(name, value) { for (const fn of docEvents[name] || []) fn(value); },
    fireWindow(name) { for (const fn of winEvents[name] || []) fn(); },
    // A discarded frame is detached and the replacement is a never-navigated
    // clone that keeps every verified markup attribute except src.
    assertDiscarded(old) {
      assert.equal(old.parentNode, null, "old frame must be detached");
      assert.ok(discarded.includes(old));
      const fresh = nodes.get("candidate");
      assert.notEqual(fresh, old);
      assert.equal(fresh.parentNode, stage);
      assert.equal(fresh.src, undefined);
      assert.deepEqual(fresh.navigations, []);
      assert.equal(fresh.hidden, true);
      const expected = { ...markup };
      delete expected.id; delete expected.hidden;
      assert.deepEqual({ ...fresh.attributes }, expected);
      return fresh;
    },
  };
}
