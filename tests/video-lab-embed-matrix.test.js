import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createEmbedHarness } from "./video-lab-embed-fake-dom.js";

const html = readFileSync(new URL("../video-lab/embed-matrix.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../video-lab/embed-matrix.js", import.meta.url), "utf8");
const ids = ["candidate", "placeholder", "mode", "status", "timing", "signals", "observation",
  "strict", "origin", "unsandboxed", "youtube", "stop", "observed-player", "observed-blank",
  "observed-media-error", "back-lab", "horizon"];
const VIDLOVE = "https://player.vidlove.cc/embed/tv/2190/13/2";
const STRICT = "allow-scripts allow-presentation";
// Tokens that would let embedded content open windows, show modal dialogs,
// navigate Horizon, submit forms, download, or capture input.
const FORBIDDEN_TOKENS = ["allow-popups", "allow-popups-to-escape-sandbox", "allow-top-navigation",
  "allow-top-navigation-by-user-activation", "allow-top-navigation-to-custom-protocols",
  "allow-modals", "allow-forms", "allow-downloads", "allow-pointer-lock", "allow-orientation-lock",
  "allow-storage-access-by-user-activation"];

const setup = () => createEmbedHarness({ html, script, ids });

test("matrix CSP excludes same-origin frames and sandboxed modes prohibit popup and top navigation", () => {
  assert.match(html, /frame-src https:\/\/player\.vidlove\.cc https:\/\/www\.youtube\.com/);
  assert.doesNotMatch(html, /frame-src[^";]*'self'/);
  assert.match(html, /sandbox="allow-scripts allow-presentation"/);
  assert.doesNotMatch(html, /allow-popups|allow-top-navigation|allow-forms|allow-downloads|allow-modals/);
  assert.doesNotMatch(script, /frame\.focus\(|contentDocument|contentWindow|postMessage/);
  assert.match(script, /https:\/\/www\.youtube\.com\/embed\/M7lc1UVf-VE/);
});

test("sandboxed modes enforce their exact sandbox tokens; unsandboxed removes sandbox completely", () => {
  const expected = {
    strict: STRICT,
    origin: "allow-scripts allow-same-origin allow-presentation",
    youtube: STRICT,
  };
  const app = setup();
  assert.equal(app.markup.allow, "autoplay; fullscreen");
  assert.equal(app.markup.referrerpolicy, "no-referrer");
  assert.equal(app.markup.tabindex, "-1");
  for (const [mode, sandbox] of Object.entries(expected)) {
    app.get(mode).click();
    const frame = app.get("candidate");
    assert.equal(frame.attributes.sandbox, sandbox, mode);
    assert.equal(frame.attributes.allow, "autoplay; fullscreen", mode);
    const tokens = sandbox.split(" ");
    for (const token of FORBIDDEN_TOKENS) assert.equal(tokens.includes(token), false, `${mode}: ${token}`);
    if (tokens.includes("allow-same-origin")) assert.equal(frame.src, VIDLOVE);
    app.get("stop").click();
  }
  // Test experimental unsandboxed mode
  app.get("unsandboxed").click();
  const unsandboxedFrame = app.get("candidate");
  assert.equal(unsandboxedFrame.attributes.sandbox, undefined);
  assert.equal(unsandboxedFrame.src, VIDLOVE);
  app.get("stop").click();
  assert.equal(app.get("candidate").attributes.sandbox, STRICT);
});

test("matrix page records the confirmed physical Vizio outcomes", () => {
  const results = /<p id="results"[^>]*>([^<]*)<\/p>/.exec(html);
  assert.ok(results);
  assert.match(results[1], /VidLove strict — blank/);
  assert.match(results[1], /VidLove same-origin — provider error page \("This site broke the player"/);
  assert.match(results[1], /small ad or overlay inside the frame/);
  assert.match(results[1], /YouTube official sample strict — black/);
  assert.match(results[1], /fixtures A and B .* rendered/);
  assert.match(html, /Experiment concluded/);
  assert.doesNotMatch(html, /behavior on this Vizio is unverified/);
});

test("strict and same-origin candidate modes use the same URL and require unload between trials", () => {
  const app = setup();
  const first = app.get("candidate");
  assert.equal(app.document.activeElement.id, "strict");
  app.key("Enter");
  assert.equal(first.src, VIDLOVE);
  assert.equal(first.attributes.sandbox, STRICT);
  assert.match(app.get("mode").textContent, /VidLove · strict/);
  app.get("origin").click();
  assert.match(app.get("status").textContent, /Stop and unload before switching/);
  assert.equal(first.attributes.sandbox, STRICT);
  assert.deepEqual(first.navigations, [VIDLOVE]);
  app.key("Backspace");
  const second = app.assertDiscarded(first);
  assert.equal(app.navigation.length, 0);
  app.get("origin").click();
  assert.deepEqual(second.navigations, [VIDLOVE]);
  assert.equal(second.attributes.sandbox, "allow-scripts allow-same-origin allow-presentation");
  app.key("Backspace");
  app.assertDiscarded(second);
  app.key("Backspace");
  assert.equal(app.navigation.at(-1), "embed-lab.html");
});

test("official YouTube embed is a separate strict cross-origin comparison", () => {
  const app = setup();
  app.get("youtube").click();
  assert.equal(app.get("candidate").src, "https://www.youtube.com/embed/M7lc1UVf-VE");
  assert.equal(app.get("candidate").attributes.sandbox, STRICT);
  assert.match(app.get("mode").textContent, /YouTube official sample/);
  assert.equal(app.document.activeElement.id, "youtube");
});

test("load-event timing and no-visible-report state never claim playback", () => {
  const app = setup();
  app.get("strict").click();
  app.advance(240);
  app.get("candidate").dispatch("load");
  assert.match(app.get("timing").textContent, /\+240 ms.*rendering and playback unverified/);
  assert.equal(app.timers.size, 2);
  app.fireTimer(7000);
  assert.match(app.get("status").textContent, /No visible result was recorded/);
  app.get("observed-blank").click();
  assert.match(app.get("observation").textContent, /blank after flash or load.*manual/);
  assert.equal(app.timers.size, 1);
  app.get("stop").click();
  assert.equal(app.timers.size, 0);
});

test("no-load timeout, parent CSP, and parent errors remain distinct", () => {
  const app = setup();
  app.get("origin").click();
  app.fireTimer(12000);
  assert.match(app.get("status").textContent, /No parent iframe load event/);
  app.fireDocument("securitypolicyviolation", { effectiveDirective: "frame-src" });
  assert.match(app.get("status").textContent, /Parent CSP blocked/);
  app.get("candidate").dispatch("load");
  assert.match(app.get("status").textContent, /Parent CSP blocked/);
  assert.equal([...app.timers.values()].some(value => value.delay === 7000), false);
  app.fireWindow("error");
  assert.match(app.get("signals").textContent, /parent error event/);
  app.fireWindow("unhandledrejection");
  assert.match(app.get("status").textContent, /child media state remains unavailable/);
});

test("unexpected iframe focus is restored and safety unload does not need a remote key", () => {
  const app = setup();
  app.get("strict").click();
  const frame = app.get("candidate");
  frame.focus();
  assert.equal(app.document.activeElement.id, "strict");
  app.fireTimer(30000);
  app.assertDiscarded(frame);
  assert.equal(app.timers.size, 0);
  assert.match(app.get("status").textContent, /auto-unloaded after 30 seconds/);
  app.get("horizon").click();
  assert.equal(app.navigation.at(-1), "https://horizon-vizio.ali-al-anbari.workers.dev/");
});

test("30-second safety unload runs from the request even after a rendered load and releases everything", () => {
  const app = setup();
  app.get("origin").click();
  const frame = app.get("candidate");
  assert.deepEqual(app.delays(), [12000, 30000]);
  frame.dispatch("load");
  app.get("observed-media-error").click();
  // A rendered, observed frame still has the request-time safety timer pending:
  // this is the disappearing frame seen on the TV.
  assert.deepEqual(app.delays(), [30000]);
  app.fireTimer(30000);
  const fresh = app.assertDiscarded(frame);
  assert.equal(app.timers.size, 0);
  assert.match(app.get("signals").textContent, /30-second safety unload → unloaded\.$/);
  assert.equal(app.get("placeholder").hidden, false);
  assert.equal(app.get("mode").textContent, "Active mode: none.");
  assert.equal(app.document.activeElement.id, "stop");
  // The matrix is immediately reusable; a late event from the discarded frame
  // is ignored even while a new mode is active.
  app.get("strict").click();
  assert.deepEqual(fresh.navigations, [VIDLOVE]);
  frame.dispatch("load");
  assert.match(app.get("timing").textContent, /waiting for parent load event/);
  // Remote Back is not trapped.
  app.key("Backspace");
  app.key("Backspace");
  assert.equal(app.navigation.at(-1), "embed-lab.html");
});

test("window blur with the iframe focused returns remote focus to the parent", () => {
  const app = setup();
  app.fireWindow("blur");
  assert.equal(app.timers.size, 0, "idle blur schedules nothing");
  app.get("youtube").click();
  app.document.activeElement = app.get("candidate");
  app.fireWindow("blur");
  app.fireWindow("blur");
  assert.deepEqual(app.delays(), [0, 12000, 30000]);
  app.fireTimer(0);
  assert.equal(app.document.activeElement.id, "youtube");
  assert.match(app.get("signals").textContent, /frame took focus; restored/);
  app.document.activeElement = app.get("candidate");
  app.fireWindow("blur");
  app.get("stop").click();
  assert.equal(app.timers.size, 0, "stop clears a pending blur check");
});

test("pagehide discards the iframe and clears all timers", () => {
  const app = setup();
  app.get("youtube").click();
  const frame = app.get("candidate");
  app.fireWindow("pagehide");
  app.assertDiscarded(frame);
  assert.equal(app.timers.size, 0);
  assert.deepEqual(app.navigation, []);
});

function filesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = new URL(name, dir);
    if (statSync(path).isDirectory()) return filesUnder(new URL(name + "/", dir));
    return /\.(html|js|css|json|txt)$/.test(name) ? [path] : [];
  });
}

test("failed embed provider stays isolated from the main Horizon interface", () => {
  const frontend = new URL("../frontend/", import.meta.url);
  for (const file of filesUnder(frontend)) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /vidlove|embed-lab|embed-matrix|video-lab/i, file.pathname);
  }
  const configs = readdirSync(new URL("../", import.meta.url)).filter(name => /^wrangler.*\.jsonc$/.test(name));
  for (const name of configs) {
    const text = readFileSync(new URL("../" + name, import.meta.url), "utf8");
    if (name === "wrangler.video-lab-preview.jsonc") {
      assert.match(text, /"directory": "\.\/video-lab"/);
      assert.match(text, /"name": "horizon-video-lab-preview"/);
    } else {
      assert.doesNotMatch(text, /video-lab/, name);
    }
  }
  const lab = readFileSync(new URL("../video-lab/index.html", import.meta.url), "utf8");
  assert.match(lab, /frame-src 'none'/);
  assert.doesNotMatch(lab, /vidlove/i);
  const worker = readFileSync(new URL("../video-lab-media-worker.js", import.meta.url), "utf8");
  assert.doesNotMatch(worker, /vidlove|youtube/i);
});
