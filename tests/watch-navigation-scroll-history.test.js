import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../universal-search/search.js", import.meta.url), "utf8");
const coreSource = readFileSync(new URL("../universal-search/core.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../universal-search/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../universal-search/search.css", import.meta.url), "utf8");

const root = {};
runInNewContext(source, { window: root });
const api = root.HorizonUniversalSearch;

const coreRoot = {};
runInNewContext(coreSource, { window: coreRoot });
const core = coreRoot.HorizonSearchCore;

test("Watch Row Heading: original spacing restored with mouse-only 175ms opacity fade", () => {
  assert.match(source, /heading\.style\.top = \(posterTop - 42 - heading\.getBoundingClientRect\(\)\.height - home\.top\) \+ "px";/);
  assert.doesNotMatch(source, /scrollFadeBaseline|programmaticScrollActive|headingFadeOpacity/);
  assert.match(css, /\.watch-active-heading \{[^}]*transition: opacity 175ms ease-out;/);
  assert.match(css, /\.watch-active-heading\.is-wheel-fading \{ opacity: 0; \}/);
  assert.match(source, /function triggerWheelHeadingFade\(\)/);
  assert.match(source, /wheelFadeTimer = clock\.setTimeout\(/);
  assert.match(source, /get\("watch-rows-scroll"\)\.addEventListener\("wheel"/);
  assert.match(source, /get\("watch-hero"\)\.addEventListener\("wheel"[\s\S]*?triggerWheelHeadingFade\(\)/);
  assert.doesNotMatch(html, /class="[^"]*spacer/);
});

test("Watch Carousel: Instant default and Glide option share stationary focus, looping, and 1.5x edge speed", () => {
  assert.match(html, /id="settings-carousel-movement"/);
  assert.doesNotMatch(html, /id="settings-nav-mode"/);
  assert.doesNotMatch(source, /navMode|viewportStart/);
  assert.match(source, /carouselMovement:\s*"instant"/);
  assert.match(source, /if \(saved\.carouselMovement === "instant" \|\| saved\.carouselMovement === "glide"\)/);

  // Instant skips rAF sliding and applies 0s stationary transform; Glide uses rAF motionFrame
  assert.match(source, /function stepHorizontalMotion\(groupName, direction, isHold\) \{\s*if \(!isHold && heroPreferences\.carouselMovement !== "glide"\) return false;/);
  assert.match(source, /track\.style\.transitionDuration = "0s";/);

  // Mouse-edge auto-scroll speed increased by 50% (0.0011 -> 0.00165)
  assert.match(source, /motion\.mode === "edge" \? 0\.00165 : 0\.0048/);

  // Shared left rail geometry across all Watch tabs
  assert.match(css, /\.watch-rail \{\s*position: fixed;\s*left: clamp\(14px, 1\.5vw, 28px\);\s*top: 50%;\s*transform: translateY\(-50%\);/);
  assert.match(css, /\.watch-content \{\s*grid-column: 2;/);

  // Seamless looping, backward boundary, and short-row rules remain intact
  assert.equal(api.isRowShort("continue", new Array(12)), true);
  assert.equal(api.isRowShort("top", new Array(7)), true);
  assert.equal(api.isRowShort("top", new Array(8)), false);
  assert.match(source, /if \(rowCycleIndex\[groupName\] <= 0\) \{\s*focus\(get\("watch-toggle"\)\);/);
  assert.match(source, /if \(index === group\.length - 1\) rowCycleIndex\[groupName\] = 0;/);
});

test("Watch Settings History: groups by complete show or movie and deletes series cleanly", () => {
  assert.match(html, /id="settings-history"/);
  assert.match(html, /id="settings-history-actions"[^>]*hidden/);
  assert.match(css, /body\.settings-active \.watch-content \{ height: 100vh; min-height: 0; overflow: hidden; \}/);
  assert.match(source, /function groupSettingsHistory\(rows\)/);
  assert.match(source, /return row\.type \+ ":" \+ row\.id;/);
  assert.doesNotMatch(source, /Delete entry|Delete all for show/);
  assert.match(source, /button\("Remove from History"/);
  assert.match(source, /core\.deleteHistory\(local, matchedRow\.type, matchedRow\.id, matchedRow\.season, matchedRow\.episode, true\)/);
  assert.match(source, /focusSettingsHistoryEntry\(null, savedIdx\)/);

  // Verify core history semantics for series vs movie deletion and Continue Watching hide
  const store = new Map();
  const storage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
  core.writeHistory(storage, { type: "tv", id: 2190, season: 1, episode: 1, title: "South Park", at: 1000 });
  core.writeHistory(storage, { type: "tv", id: 2190, season: 2, episode: 5, title: "South Park", at: 2000 });
  core.writeHistory(storage, { type: "movie", id: 550, title: "Fight Club", at: 3000 });
  assert.equal(core.readHistory(storage).length, 3);

  // Hiding from Continue Watching preserves underlying episode history
  core.setContinueHidden(storage, { type: "tv", id: 2190, at: Date.now() }, true);
  assert.equal(core.readHistory(storage).length, 3);

  // Series-level deletion removes all episodes of 2190 without touching movie 550
  core.deleteHistory(storage, "tv", 2190, 2, 5, true);
  const remaining = core.readHistory(storage);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].type, "movie");
  assert.equal(remaining[0].id, 550);
});

test("Watch Carousel Windowing: keeps all visible and preloaded posters mounted across 4+ loops when cards.length <= visible", () => {
  // Verify the fixed windowing expressions in search.js
  assert.match(source, /var initialEnd = visible \+ 2;/);
  assert.match(source, /var neededEnd = target \+ \(cards\.length > 1 \? controller\.visible \+ 2 : 0\);/);
  assert.match(source, /Number\(last\.dataset\.homeOrdinal\) > controller\.selected \+ controller\.visible \+ 1/);

  // Simulate the exact windowing math & DOM slot lifecycle across 32 consecutive forward steps
  // on an 8-card row where visible === 8 (the exact condition that previously collapsed to target + 1).
  const cards = Array.from({ length: 8 }, (_, i) => ({
    dataset: { homeKey: "k" + i, homeIndex: String(i), homeOrdinal: "" },
    style: {},
    classList: { remove() {}, add() {} },
    removeAttribute() {},
    addEventListener() {},
    querySelectorAll() { return []; },
    cloneNode() {
      return {
        dataset: { homeKey: this.dataset.homeKey, homeIndex: this.dataset.homeIndex, homeOrdinal: "" },
        style: {},
        classList: { remove() {}, add() {} },
        removeAttribute() {},
        addEventListener() {},
        querySelectorAll() { return []; },
        remove() {},
      };
    },
  }));

  const step = 220;
  const visible = 8;
  const capacity = visible + 7; // 15
  const rowClientWidth = 1750;
  const gutter = 100;
  const slots = Object.create(null);
  const pool = [];
  const children = [];

  function makeSlot(ordinal) {
    const src = cards[ordinal % cards.length];
    const reusedIdx = pool.findIndex(c => c.dataset.homeKey === src.dataset.homeKey);
    const slot = reusedIdx >= 0 ? pool.splice(reusedIdx, 1)[0] : src.cloneNode(true);
    slot.dataset.homeIndex = src.dataset.homeIndex;
    slot.dataset.homeOrdinal = String(ordinal);
    slot.style.left = (step * ordinal) + "px";
    return slot;
  }

  let start = 0, end = 0, selected = 0;
  slots[0] = makeSlot(0);
  children.push(slots[0]);
  const initialEnd = visible + 2;
  while (end < initialEnd) {
    end += 1;
    slots[end] = makeSlot(end);
    children.push(slots[end]);
  }
  assert.equal(end, 10, "preloads visible + 2 slots on initial mount even when cards.length === 8");

  for (let s = 1; s <= 32; s++) {
    const target = s;
    const neededEnd = target + visible + 2;
    while (end < neededEnd) {
      if (children.length >= capacity) {
        const oldFirst = children[0];
        if (oldFirst && Number(oldFirst.dataset.homeOrdinal) < target - 2) {
          delete slots[oldFirst.dataset.homeOrdinal];
          children.shift();
          pool.push(oldFirst);
          start = Number(children[0].dataset.homeOrdinal);
        }
      }
      end += 1;
      slots[end] = makeSlot(end);
      children.push(slots[end]);
    }
    selected = target;
    const x = -selected * step;

    // Simulate trimHomeCarousel right/left trimming
    const cycleStart = Math.floor(selected / cards.length) * cards.length;
    while (children.length > 0
        && (Number(children[0].dataset.homeOrdinal) < cycleStart
          || (children.length > capacity
            && gutter + Number(children[0].dataset.homeOrdinal) * step + x + 200 < -step))) {
      const removed = children.shift();
      delete slots[removed.dataset.homeOrdinal];
      pool.push(removed);
      if (pool.length > capacity) pool.shift();
    }
    start = Number(children[0].dataset.homeOrdinal);

    while (children.length > capacity
        && Number(children[children.length - 1].dataset.homeOrdinal) > selected + visible + 1
        && gutter + Number(children[children.length - 1].dataset.homeOrdinal) * step + x > rowClientWidth + step) {
      const removed = children.pop();
      delete slots[removed.dataset.homeOrdinal];
      pool.push(removed);
      if (pool.length > capacity) pool.shift();
    }
    end = Number(children[children.length - 1].dataset.homeOrdinal);

    // Every visible slot [selected .. selected + visible - 1] and preload [selected + visible] must be mounted
    for (let ord = selected; ord <= selected + visible; ord++) {
      assert.ok(slots[ord], `step ${s}: ordinal ${ord} must be mounted`);
    }
    assert.ok(children.length <= capacity + 2, `step ${s}: mounted count ${children.length} stays bounded`);
  }
});
