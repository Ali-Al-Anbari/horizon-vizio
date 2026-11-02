import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const script = readFileSync(new URL("../video-lab/player-diagnostics.js", import.meta.url), "utf8");
const providersScript = readFileSync(new URL("../video-lab/playback-providers.js", import.meta.url), "utf8");

function fixture({ mse = true, hls = "", mp4 = "probably" } = {}) {
  const attributes = { allow: "autoplay; fullscreen; picture-in-picture", allowfullscreen: "",
    referrerpolicy: "no-referrer" };
  const frame = { contentWindow: {}, getAttribute(name) { return Object.hasOwn(attributes, name) ? attributes[name] : null; },
    setAttribute(name, value) { attributes[name] = value; } };
  const host = { navigator: { userAgent: "Vizio test agent" },
    getComputedStyle() { return { pointerEvents: "none" }; } };
  if (mse) host.MediaSource = { isTypeSupported(type) { return mse !== "no-codec" && type.startsWith("video/mp4"); } };
  const doc = { createElement() { return { canPlayType(type) {
    if (type.includes("mpegurl") || type.includes("mpegURL")) return hls;
    return mp4;
  } }; } };
  let time = 0;
  const clock = { performance: { now() { return time; } } };
  runInNewContext(script, { window: host });
  runInNewContext(providersScript, { window: host });
  return { diagnostics: host.HorizonPlayerDiagnostics.create(host, doc, frame, clock),
    providers: host.HorizonPlaybackProviders, frame, advance(ms) { time += ms; } };
}

test("diagnostics report browser media probes and iframe permissions without network access", () => {
  const app = fixture();
  app.diagnostics.reset("cinesrc");
  const data = app.diagnostics.snapshot();
  assert.equal(data.userAgent, "Vizio test agent");
  assert.match(data.mediaSource, /MediaSource|present; MSE fMP4 AVC\/AAC yes/);
  assert.match(data.mediaSource, /MSE TS AVC\/AAC no/);
  assert.match(data.nativeHls, /Apple HLS no/);
  assert.match(data.html5, /MP4 AVC\/AAC probably/);
  assert.match(data.permissions, /autoplay; fullscreen; picture-in-picture/);
  assert.match(data.permissions, /fullscreen: yes; sandbox: absent; referrer: no-referrer; pointer events: none/);
  assert.match(data.elapsed, /0s since iframe launch/);
  app.advance(25000);
  assert.match(app.diagnostics.snapshot().elapsed, /25s since iframe launch/);
});

test("missing MSE and native HLS is a capability warning, not a claimed CineSrc root cause", () => {
  const app = fixture({ mse: false, hls: "" });
  app.diagnostics.reset("cinesrc");
  assert.match(app.diagnostics.snapshot().mediaSource, /^absent/);
  assert.match(app.diagnostics.snapshot().assessment, /unsupported stream path is plausible/);
  const native = fixture({ mse: false, hls: "maybe" });
  native.diagnostics.reset("cinesrc");
  assert.doesNotMatch(native.diagnostics.snapshot().assessment, /unsupported stream path/);
  const noCodec = fixture({ mse: "no-codec", hls: "" });
  noCodec.diagnostics.reset("cinesrc");
  assert.match(noCodec.diagnostics.snapshot().assessment, /stream format incompatibility is plausible/);
});

test("diagnostic event and source rings are bounded, ordered, and redact URL-like data", () => {
  const app = fixture();
  app.diagnostics.reset("cinesrc");
  app.diagnostics.record({ type: "cinesrc:ready" });
  for (let i = 1; i <= 15; i++) {
    app.advance(1000);
    app.diagnostics.record({ type: "cinesrc:sourceused", sourceId: "server" + i });
  }
  app.diagnostics.record({ type: "cinesrc:sourceused", sourceId: "https://media.test/play?token=secret" });
  const data = app.diagnostics.snapshot();
  assert.match(data.sources, /^server9 → server10/);
  assert.match(data.sources, /server15 → \(redacted\)/);
  assert.match(data.sources, /last 8 of 16/);
  assert.doesNotMatch(JSON.stringify(data), /media\.test|token=secret/);
  assert.equal(data.events.split(" | ").length, 6);
  assert.match(data.assessment, /Sources changed without a play event/);
  app.diagnostics.record({ type: "cinesrc:play" });
  assert.match(app.diagnostics.snapshot().assessment, /Provider sent play/);
  app.diagnostics.record({ type: "cinesrc:sourceused", sourceId: "server17" });
  assert.match(app.diagnostics.snapshot().assessment, /Sources changed without a play event/);
});

test("repeated reports of one server are not misclassified as server cycling", () => {
  const app = fixture();
  app.diagnostics.reset("cinesrc");
  app.diagnostics.record({ type: "cinesrc:sourceused", sourceId: "server1" });
  app.diagnostics.record({ type: "cinesrc:sourceused", sourceId: "server1" });
  assert.doesNotMatch(app.diagnostics.snapshot().assessment, /Sources changed/);
});

test("iframe load and error are logged separately from provider messages", () => {
  const app = fixture();
  app.diagnostics.reset("cinesrc");
  app.advance(1000);
  app.diagnostics.recordFrame("load");
  app.advance(2000);
  app.diagnostics.recordFrame("error");
  app.diagnostics.recordRejected("origin");
  app.diagnostics.recordRejected("envelope");
  const data = app.diagnostics.snapshot();
  assert.equal(data.frameEvents, "+1s iframe load | +3s iframe error");
  assert.equal(data.events, "none received");
  assert.equal(data.messageChecks, "Direct-frame ignored: origin 1; envelope 1");
  app.diagnostics.record({ type: "cinesrc:ready" });
  assert.match(app.diagnostics.snapshot().events, /ready/);
  app.diagnostics.reset("cinesrc");
  assert.equal(app.diagnostics.snapshot().frameEvents, "none observed");
  assert.equal(app.diagnostics.snapshot().messageChecks, "Direct-frame ignored: origin 0; envelope 0");
});

test("only validated CineSrc messages affect diagnostics and error categories", () => {
  const app = fixture();
  app.diagnostics.reset("cinesrc");
  const source = app.frame.contentWindow;
  const accept = (data, origin = "https://cinesrc.st", eventSource = source) =>
    app.providers.acceptEvent({ origin, source: eventSource, data }, app.frame, "cinesrc");
  assert.equal(accept({ type: "cinesrc:ready" }, "https://wrong.test"), null);
  assert.equal(accept({ type: "cinesrc:ready" }, "https://cinesrc.st", {}), null);
  assert.equal(accept({ type: "cinesrc:timeupdate", currentTime: "bad", duration: 50 }), null);
  assert.equal(app.diagnostics.snapshot().events, "none received");
  app.diagnostics.record(accept({ type: "cinesrc:ready" }));
  assert.match(app.diagnostics.snapshot().assessment, /decoded playback has not been confirmed/);
  app.diagnostics.record(accept({ type: "cinesrc:error", error: "MEDIA_ERR_DECODE" }));
  assert.match(app.diagnostics.snapshot().assessment, /decoding or format error/);
  app.diagnostics.reset("cinesrc");
  app.diagnostics.record(accept({ type: "cinesrc:error", error: "https://media.test/x?token=secret" }));
  assert.equal(app.diagnostics.snapshot().assessment, "Provider reports an error; cause is not identified.");
  assert.doesNotMatch(app.diagnostics.snapshot().events, /media\.test|token=secret/);
  app.diagnostics.reset("yapgrid");
  app.diagnostics.record({ type: "cinesrc:sourceused", sourceId: "server1" });
  assert.equal(app.diagnostics.snapshot().events, "none received");
});

test("VidFast diagnostics record sync heartbeats, status codes, and safe envelope types", () => {
  const app = fixture();
  app.diagnostics.reset("vidfast");

  // Heartbeat tracking without claiming decoded video playback
  app.advance(5000);
  app.diagnostics.record({ type: "vidfast:media_data", event: "media_data", itemCount: 2 });
  assert.match(app.diagnostics.snapshot().events, /sync \(1\)/);
  assert.match(app.diagnostics.snapshot().assessment, /VidFast reports sync heartbeat \(1\)/);

  // Status code tracking
  app.advance(5000);
  app.diagnostics.record({ type: "vidfast:status", event: "status", statusCode: 404 });
  assert.match(app.diagnostics.snapshot().events, /status 404/);
  assert.match(app.diagnostics.snapshot().assessment, /status_404/);

  // Safe rejection metadata without leaking raw data
  app.diagnostics.recordRejected("envelope", { data: { type: "unrecognized_action" } });
  assert.equal(app.diagnostics.snapshot().messageChecks,
    "Direct-frame ignored: origin 0; envelope 1 (last: unrecognized_action)");
});

test("VidLink diagnostics distinguish progress events from confirmed picture and audio", () => {
  const app = fixture();
  app.diagnostics.reset("vidlink");
  app.diagnostics.recordFrame("load");
  assert.match(app.diagnostics.snapshot().assessment, /iframe load alone does not confirm playback/);
  app.diagnostics.record({ type: "vidlink:media_data", itemCount: 1 });
  assert.match(app.diagnostics.snapshot().assessment, /picture and audio remain unverified/);
  app.diagnostics.record({ type: "vidlink:play", event: "play" });
  assert.match(app.diagnostics.snapshot().assessment, /picture and audio still require TV confirmation/);
  app.diagnostics.record({ type: "vidlink:timeupdate", currentTime: 10, duration: 100 });
  app.diagnostics.record({ type: "vidlink:timeupdate", currentTime: 11, duration: 100 });
  assert.equal(app.diagnostics.snapshot().events.split("timeupdate").length, 2, "frequent updates stay compact");
  app.diagnostics.record({ type: "vidlink:error", error: "network_error" });
  assert.match(app.diagnostics.snapshot().assessment, /reports an error/);
  app.diagnostics.reset("vidlink");
  assert.equal(app.diagnostics.snapshot().events, "none received");
  assert.equal(app.diagnostics.snapshot().frameEvents, "none observed");
});

test("VidRift and VidBolt diagnostics bound commands, signals, and explicit failures", () => {
  const app = fixture();
  app.diagnostics.reset("vidrift");
  app.diagnostics.recordFrame("load");
  app.diagnostics.recordCommand("get-state");
  app.diagnostics.record({ type: "vidrift:state", paused: false, muted: true, volume: 0.5, currentTime: 12 });
  assert.match(app.diagnostics.snapshot().events, /sent get-state.*state/);
  assert.match(app.diagnostics.snapshot().events, /paused false; muted true; volume 50%; time 12s/);
  app.diagnostics.record({ type: "vidrift:state", paused: true, muted: false,
    volume: 0.14999999999999997, currentTime: 12, server: "vela", source: "0",
    servers: [{ value: "vela", state: "ready" }, { value: "nova", state: "failed" }] });
  assert.match(app.diagnostics.snapshot().sources, /server vela; source 0; options vela ready, nova failed/);
  app.diagnostics.record({ type: "vidrift:progress", currentTime: 17, duration: 100 });
  app.advance(5000);
  assert.match(app.diagnostics.snapshot().elapsed, /progress event 5s ago; reported time increase 5s ago/);
  assert.match(app.diagnostics.snapshot().assessment, /remain unverified/);
  app.diagnostics.record({ type: "vidrift:command-error", command: "vidrift:set", field: "muted", reason: "click-required" });
  assert.match(app.diagnostics.snapshot().assessment, /click-required/);
  assert.match(app.diagnostics.snapshot().events, /command-error vidrift:set muted click-required/);
  assert.match(app.diagnostics.snapshot().events, /last sent get-state/);
  app.frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
  assert.match(app.diagnostics.snapshot().permissions, /referrer: strict-origin-when-cross-origin/);
  app.diagnostics.recordRejected("identity", { data: { type: "vidrift:state" } });
  assert.match(app.diagnostics.snapshot().messageChecks, /accepted 4; rejected 1; last identity vidrift.state/);
  for (let index = 0; index < 5; index += 1)
    app.diagnostics.recordRejected("identity:mediaType", { data: { type: "vidrift:ui-hidden" } });
  assert.match(app.diagnostics.snapshot().messageChecks, /accepted 4; rejected 6; last identity:mediaType vidrift.ui-hidden/);
  assert.equal(app.diagnostics.snapshot().messageChecks.split("vidrift.ui-hidden").length - 1, 5,
    "last plus four recent rejections stay bounded");
  app.diagnostics.reset("vidbolt");
  app.diagnostics.record({ type: "vidbolt:ready" });
  app.diagnostics.recordCommand("seek");
  app.diagnostics.record({ type: "vidbolt:timeupdate", currentTime: 10 });
  assert.match(app.diagnostics.snapshot().events, /ready.*sent seek.*timeupdate/);
  assert.match(app.diagnostics.snapshot().assessment, /playback and sound remain unverified/);
  app.diagnostics.reset("vidbolt");
  assert.equal(app.diagnostics.snapshot().events, "none received");
});
