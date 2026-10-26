import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createEmbedHarness } from "./video-lab-embed-fake-dom.js";

const html = readFileSync(new URL("../video-lab/embed-matrix.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../video-lab/embed-matrix.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../video-lab/embed-lab.css", import.meta.url), "utf8");
const ids = ["candidate", "placeholder", "mode", "status", "timing", "signals", "observation",
  "strict", "origin", "unsandboxed", "user-play", "vidlink", "embedwave", "yapgrid", "yapgrid-sub", "yapgrid-off", "youtube",
  "ctl-play", "ctl-seek-back", "ctl-seek-fwd", "ctl-sub", "control-player",
  "fullscreen-api", "fullscreen-css", "stop",
  "observed-player", "observed-blank", "observed-media-error", "back-lab", "horizon"];
const VIDLOVE = "https://player.vidlove.cc/embed/tv/2190/13/2";
const VIDLINK = "https://vidlink.pro/tv/2190/13/2";
const EMBEDWAVE = "https://embedwave.cc/embed/tv/2190/13/2";
const YAPGRID = "https://yapgrid.com/embed/tv/2190/13/2";
const YAPGRID_SUB = "https://yapgrid.com/embed/tv/2190/13/2?lang=en";
const YAPGRID_OFF = "https://yapgrid.com/embed/tv/2190/13/2?sub_url="
  + encodeURIComponent("https://horizon-video-lab-preview.ali-al-anbari.workers.dev/empty.vtt")
  + "&sub_lang=en&sub_label=Off";
const STRICT = "allow-scripts allow-presentation";
// Tokens that would let embedded content open windows, show modal dialogs,
// navigate Horizon, submit forms, download, or capture input.
const FORBIDDEN_TOKENS = ["allow-popups", "allow-popups-to-escape-sandbox", "allow-top-navigation",
  "allow-top-navigation-by-user-activation", "allow-top-navigation-to-custom-protocols",
  "allow-modals", "allow-forms", "allow-downloads", "allow-pointer-lock", "allow-orientation-lock",
  "allow-storage-access-by-user-activation"];

const setup = () => createEmbedHarness({ html, script, ids });

test("matrix CSP permits only verified providers and excludes same-origin frames", () => {
  assert.match(html, /frame-src https:\/\/player\.vidlove\.cc https:\/\/www\.youtube\.com https:\/\/vidlink\.pro https:\/\/embedwave\.cc https:\/\/yapgrid\.com/);
  assert.doesNotMatch(html, /frame-src[^";]*'self'/);
  assert.match(html, /sandbox="allow-scripts allow-presentation"/);
  assert.doesNotMatch(html, /allow-popups|allow-top-navigation|allow-forms|allow-downloads|allow-modals/);
  assert.doesNotMatch(script, /contentDocument|contentWindow|postMessage/);
  assert.match(script, /https:\/\/www\.youtube\.com\/embed\/M7lc1UVf-VE/);
});

test("sandboxed modes enforce their exact sandbox tokens; unsandboxed modes toggle allow permissions", () => {
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
  // Test experimental unsandboxed autoplay mode
  app.get("unsandboxed").click();
  const unsandboxedFrame = app.get("candidate");
  assert.equal(unsandboxedFrame.attributes.sandbox, undefined);
  assert.equal(unsandboxedFrame.attributes.allow, "autoplay; fullscreen");
  assert.equal(unsandboxedFrame.src, VIDLOVE);
  app.get("stop").click();
  assert.equal(app.get("candidate").attributes.sandbox, STRICT);

  // Test experimental unsandboxed user-init mode (no autoplay permission)
  app.get("user-play").click();
  const userInitFrame = app.get("candidate");
  assert.equal(userInitFrame.attributes.sandbox, undefined);
  assert.equal(userInitFrame.attributes.allow, "fullscreen");
  assert.equal(userInitFrame.src, VIDLOVE);
  app.get("stop").click();

  // Test VidLink
  app.get("vidlink").click();
  assert.equal(app.get("candidate").src, VIDLINK);
  assert.equal(app.get("candidate").attributes.sandbox, undefined);
  app.get("stop").click();

  // Test EmbedWave
  app.get("embedwave").click();
  assert.equal(app.get("candidate").src, EMBEDWAVE);
  assert.equal(app.get("candidate").attributes.allow, "autoplay; fullscreen; picture-in-picture; encrypted-media");
  app.get("stop").click();

  // Test YapGrid
  app.get("yapgrid").click();
  assert.equal(app.get("candidate").src, YAPGRID);
  assert.equal(app.get("candidate").attributes.sandbox, undefined);
  app.get("stop").click();

  // Test YapGrid with en subtitle
  app.get("yapgrid-sub").click();
  assert.equal(app.get("candidate").src, YAPGRID_SUB);
  assert.equal(app.get("candidate").attributes.sandbox, undefined);
  app.get("stop").click();

  // Test YapGrid with empty VTT subtitle suppression
  app.get("yapgrid-off").click();
  assert.equal(app.get("candidate").src, YAPGRID_OFF);
  assert.equal(app.get("candidate").attributes.sandbox, undefined);
  assert.match(app.get("mode").textContent, /YapGrid \(sub off\)/);
  app.get("stop").click();
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
  assert.equal(app.timers.size, 1);
  app.fireTimer(7000);
  assert.match(app.get("status").textContent, /No visible result was recorded/);
  app.get("observed-blank").click();
  assert.match(app.get("observation").textContent, /blank after flash or load.*manual/);
  assert.equal(app.timers.size, 0);
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

test("unexpected iframe focus is restored and frame does not auto-unload", () => {
  const app = setup();
  app.get("strict").click();
  const frame = app.get("candidate");
  frame.focus();
  assert.equal(app.document.activeElement.id, "strict");
  // No 30s auto-unload timer exists
  assert.equal([...app.timers.values()].some(t => t.delay === 30000), false);
  assert.equal(frame.hidden, false);
  app.get("horizon").click();
  assert.equal(app.navigation.at(-1), "https://horizon-vizio.ali-al-anbari.workers.dev/");
});

test("frame persists without automatic unloading and manual stop unloads cleanly", () => {
  const app = setup();
  app.get("origin").click();
  const frame = app.get("candidate");
  assert.deepEqual(app.delays(), [12000]);
  frame.dispatch("load");
  app.get("observed-media-error").click();
  // No auto-unload timers exist
  assert.equal(app.timers.size, 0);
  assert.equal(frame.hidden, false);

  // Manual stop works as expected
  app.get("stop").click();
  const fresh = app.assertDiscarded(frame);
  assert.equal(app.timers.size, 0);
  assert.equal(app.get("placeholder").hidden, false);
  assert.equal(app.get("mode").textContent, "Active mode: none.");
  assert.equal(app.document.activeElement.id, "stop");

  // Reusable
  app.get("strict").click();
  assert.deepEqual(fresh.navigations, [VIDLOVE]);
  app.key("Backspace");
  app.key("Backspace");
  assert.equal(app.navigation.at(-1), "embed-lab.html");
});

test("playback control buttons accurately report cross-origin limitations", () => {
  const app = setup();
  app.get("ctl-play").click();
  assert.match(app.get("status").textContent, /Load a provider before using playback controls/);

  app.get("yapgrid").click();
  app.get("ctl-play").click();
  assert.match(app.get("status").textContent, /Play\/Pause requested.*no public messaging API/);

  app.get("ctl-seek-back").click();
  assert.match(app.get("status").textContent, /Seek -10s requested.*use on-screen scrub controls/);

  app.get("ctl-seek-fwd").click();
  assert.match(app.get("status").textContent, /Seek \+10s requested.*use on-screen scrub controls/);

  app.get("ctl-sub").click();
  assert.match(app.get("status").textContent, /Subtitles requested.*YapGrid \(en sub\)/);
});

test("activating player-control mode focuses iframe without recreating, navigating, or unloading it", () => {
  const app = setup();
  // Trying to control player without an active embed warns user
  app.get("control-player").click();
  assert.match(app.get("status").textContent, /Load a provider before transferring remote control/);

  // Load YapGrid
  app.get("yapgrid").click();
  const frame = app.get("candidate");
  const initialNavigations = [...frame.navigations];

  // Activate Control YapGrid
  app.get("control-player").click();
  assert.equal(app.document.activeElement, frame, "iframe must receive focus");
  assert.equal(app.get("candidate"), frame, "iframe element identity must be preserved");
  assert.deepEqual(frame.navigations, initialNavigations, "no extra navigations or reloads");
  assert.equal(frame.hidden, false);
  assert.equal(app.timers.size, 1); // Only the 12s navigation timer, no auto-unload timers
  assert.match(app.get("signals").textContent, /transferred focus to player/);
  assert.match(app.get("status").textContent, /Remote focus transferred to player/);
  assert.match(app.get("status").textContent, /TV Home/);

  // Blur event does NOT steal focus back when controlling player
  app.fireWindow("blur");
  if (app.timers.has(0)) app.fireTimer(0);
  assert.equal(app.document.activeElement, frame, "focus must remain on iframe");

  // Unexpected iframe focus event does not kick focus back when controlling player
  frame.dispatch("focus");
  assert.equal(app.document.activeElement, frame);
  assert.match(app.get("signals").textContent, /player iframe focused/);

  // Back key safely returns focus to parent controls if parent receives key
  app.key("Backspace");
  assert.equal(app.document.activeElement.id, "control-player");
  assert.match(app.get("status").textContent, /Returned focus to Horizon controls/);

  // Controlling player in CSS fullscreen preserves fullscreen state
  app.get("fullscreen-css").click();
  assert.equal(app.stage.classList.contains("viewport-fullscreen"), true);
  app.get("control-player").click();
  assert.equal(app.stage.classList.contains("viewport-fullscreen"), true);
  assert.equal(app.document.activeElement, frame);
  assert.equal(app.get("candidate"), frame);

  // Stop unloads cleanly and exits player control
  app.get("stop").click();
  assert.equal(app.timers.size, 0);
  assert.equal(app.get("placeholder").hidden, false);
});

test("window blur with the iframe focused returns remote focus to the parent", () => {
  const app = setup();
  app.fireWindow("blur");
  assert.equal(app.timers.size, 0, "idle blur schedules nothing");
  app.get("youtube").click();
  app.document.activeElement = app.get("candidate");
  app.fireWindow("blur");
  app.fireWindow("blur");
  assert.deepEqual(app.delays(), [0, 12000]);
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

test("CSS fullscreen comparison toggles classes on stage and body and Back exits fullscreen first", () => {
  // CSS rules verify that fullscreen hides all parent UI and occupies full viewport
  assert.match(css, /\.stage\.viewport-fullscreen\s*\{[^}]*position:\s*fixed[^}]*width:\s*100vw[^}]*height:\s*100vh/);
  assert.match(css, /body\.stage-fullscreen\s+nav/);
  assert.match(css, /body\.stage-fullscreen\s+header/);
  assert.match(css, /display:\s*none\s*!important/);
  assert.doesNotMatch(css, /body\.stage-fullscreen\s+nav\s*\{[^}]*position:\s*fixed/);

  const app = setup();
  // Trying fullscreen without active embed warns user
  app.get("fullscreen-css").click();
  assert.match(app.get("status").textContent, /Load an embed before testing fullscreen/);

  // Load embed
  app.get("yapgrid").click();
  const frameBefore = app.get("candidate");
  const srcBefore = frameBefore.src;
  const navigationsBefore = [...frameBefore.navigations];
  assert.equal(app.stage.classList.contains("viewport-fullscreen"), false);

  // Enter CSS fullscreen
  app.get("fullscreen-css").click();
  assert.equal(app.stage.classList.contains("viewport-fullscreen"), true);
  assert.equal(app.document.body.classList.contains("stage-fullscreen"), true);
  // Verify iframe identity and src did not reload or change
  assert.equal(app.get("candidate"), frameBefore);
  assert.equal(app.get("candidate").src, srcBefore);
  assert.deepEqual(app.get("candidate").navigations, navigationsBefore, "no extra navigations on enter fullscreen");
  assert.match(app.get("fullscreen-css").textContent, /Exit CSS Fullscreen/);
  assert.match(app.get("status").textContent, /Entered CSS fullscreen/);
  // No auto-unload timers or reloads introduced
  assert.equal([...app.timers.values()].some(t => t.delay === 30000), false);

  // Back exits CSS fullscreen first without unloading or reloading iframe
  app.key("Backspace");
  assert.equal(app.stage.classList.contains("viewport-fullscreen"), false);
  assert.equal(app.document.body.classList.contains("stage-fullscreen"), false);
  assert.equal(app.get("candidate"), frameBefore);
  assert.equal(app.get("candidate").src, srcBefore);
  assert.deepEqual(app.get("candidate").navigations, navigationsBefore, "no extra navigations on exit fullscreen");
  assert.match(app.get("status").textContent, /Exited CSS fullscreen/);
  assert.equal(app.get("candidate").hidden, false);

  // Second Back unloads iframe
  app.key("Backspace");
  assert.equal(app.get("candidate").hidden, true);
});

test("API fullscreen attempts requestFullscreen on iframe and reports failure/success safely", async () => {
  const app = setup();
  app.get("unsandboxed").click();
  const frame = app.get("candidate");

  // Unsupported case
  app.get("fullscreen-api").click();
  assert.match(app.get("status").textContent, /Fullscreen API is not supported/);

  // Supported case (rejection)
  frame.requestFullscreen = () => Promise.reject(new Error("Vizio denied fullscreen"));
  app.get("fullscreen-api").click();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(app.get("status").textContent, /Iframe requestFullscreen rejected: Vizio denied fullscreen/);

  // Supported case (resolution)
  frame.requestFullscreen = () => Promise.resolve();
  app.get("fullscreen-api").click();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(app.get("status").textContent, /Iframe requestFullscreen succeeded/);
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

test("normal YapGrid mode remains unchanged and separate from experimental subtitle-off mode", () => {
  const app = setup();

  // Baseline mode
  app.get("yapgrid").click();
  const baselineFrame = app.get("candidate");
  assert.equal(baselineFrame.src, "https://yapgrid.com/embed/tv/2190/13/2");
  assert.equal(new URL(baselineFrame.src).search, "");
  assert.match(app.get("mode").textContent, /Active mode: YapGrid\./);
  app.get("stop").click();

  // Subtitle-off experimental mode
  app.get("yapgrid-off").click();
  const offFrame = app.get("candidate");
  const offUrl = new URL(offFrame.src);
  assert.equal(offUrl.origin + offUrl.pathname, "https://yapgrid.com/embed/tv/2190/13/2");
  assert.equal(offUrl.searchParams.get("sub_lang"), "en");
  assert.equal(offUrl.searchParams.get("sub_label"), "Off");
  assert.equal(offUrl.searchParams.get("sub_url"), "https://horizon-video-lab-preview.ali-al-anbari.workers.dev/empty.vtt");
  assert.match(app.get("mode").textContent, /Active mode: YapGrid \(sub off\)\./);
  app.get("stop").click();

  // Verify baseline is still intact after unloading experimental mode
  app.get("yapgrid").click();
  assert.equal(app.get("candidate").src, "https://yapgrid.com/embed/tv/2190/13/2");
  assert.equal(new URL(app.get("candidate").src).search, "");
});
