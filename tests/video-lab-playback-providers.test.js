import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const catalogScript = readFileSync(new URL("../video-lab/episode-catalog.js", import.meta.url), "utf8");
const providerScript = readFileSync(new URL("../video-lab/playback-providers.js", import.meta.url), "utf8");
const window = {};
runInNewContext(catalogScript, { window });
runInNewContext(providerScript, { window });
const catalog = window.HorizonEpisodes;
const providers = window.HorizonPlaybackProviders;

test("YapGrid remains fallback and visible selector cycles through VidBolt", () => {
  const movie = { movieId: 550 };
  const episode = { showId: 1396, season: 1, episode: 2 };
  assert.equal(providers.PRIMARY, "yapgrid");
  assert.equal(providers.FALLBACK, "yapgrid");
  assert.equal(providers.next("yapgrid"), "vidbolt");
  assert.equal(providers.next("vidrift"), "yapgrid");
  assert.equal(providers.next("vidbolt"), "yapgrid");
  assert.equal(providers.next("vidlink"), "yapgrid");
  assert.equal(providers.select("vidlink"), "vidlink");
  assert.equal(providers.select("unknown"), "yapgrid");
  assert.equal(providers.select("vidfast"), "vidfast");
  assert.equal(providers.select("cinesrc"), "yapgrid", "CineSrc cannot be selected; returns YapGrid");

  assert.equal(catalog.parse("?type=movie&id=550").provider, null);
  assert.equal(catalog.parse("?type=movie&id=550&provider=yapgrid").provider, "yapgrid");
  assert.equal(catalog.parse("?type=movie&id=550&provider=vidfast").provider, "vidfast");
  assert.equal(catalog.parse("?type=movie&id=550&provider=cinesrc").provider, null, "CineSrc parameter rejected");

  assert.equal(providers.embedUrl(movie, "yapgrid", "off", "https://example.test", catalog),
    "https://yapgrid.com/embed/movie/550");
  assert.equal(providers.embedUrl(movie, "vidfast", "off", "https://example.test", catalog),
    "https://vidfast.vc/movie/550");
  assert.equal(providers.embedUrl(episode, "yapgrid", "on", "https://example.test", catalog),
    "https://yapgrid.com/embed/tv/1396/1/2?lang=en");
  assert.equal(providers.embedUrl(episode, "vidfast", "off", "https://example.test", catalog),
    "https://vidfast.vc/tv/1396/1/2");
  assert.equal(providers.embedUrl(episode, "yapgrid", "off", "https://example.test", catalog),
    "https://yapgrid.com/embed/tv/1396/1/2?sub_url=https%3A%2F%2Fexample.test%2Fempty.vtt&sub_lang=en&sub_label=Off");
  assert.equal(catalog.pageUrl(episode, "off", false, null, false, null, null, "yapgrid"),
    "player-overlay.html?season=1&episode=2&sub=off&showId=1396");
  assert.equal(catalog.pageUrl(episode, "off", false, null, false, null, null, "vidfast"),
    "player-overlay.html?season=1&episode=2&sub=off&showId=1396&provider=vidfast");
});

test("invalid TMDB identifiers do not produce provider URLs", () => {
  for (const target of [null, { movieId: 0 }, { movieId: "550" },
    { movieId: Number.MAX_SAFE_INTEGER + 1 }, { showId: 1396, season: 0, episode: 2 },
    { showId: 1396, season: 1, episode: 1.5 }]) {
    assert.equal(providers.embedUrl(target, "vidfast", "off", "https://example.test", catalog), null);
    assert.equal(providers.embedUrl(target, "cinesrc", "off", "https://example.test", catalog), null);
  }
  assert.equal(catalog.parse("?type=movie&id=0&provider=vidfast").invalid, true);
  assert.equal(catalog.parse("?showId=1396&season=0&episode=2&provider=vidfast").invalid, true);
});

test("VidFast autoPlay=true is opt-in and leaves YapGrid and baseline unchanged", () => {
  const movie = { movieId: 550 };
  const episode = { showId: 1396, season: 1, episode: 2 };
  const url = (target, provider, mode) => providers.embedUrl(target, provider, "off",
    "https://example.test", catalog, mode);
  assert.equal(providers.vidFastMode("unknown"), "baseline");
  assert.equal(url(movie, "vidfast", "baseline"), "https://vidfast.vc/movie/550");
  assert.equal(url(movie, "vidfast", "autoPlayTrue"), "https://vidfast.vc/movie/550?autoPlay=true");
  assert.equal(url(episode, "vidfast", "autoPlayTrue"), "https://vidfast.vc/tv/1396/1/2?autoPlay=true");
  assert.equal(url(movie, "yapgrid", "autoPlayTrue"), "https://yapgrid.com/embed/movie/550");
  assert.equal(url(movie, "vidfast", "server=Proxy-01"), "https://vidfast.vc/movie/550");
});

test("VidFast messages require active provider, exact origin, and expected iframe source", () => {
  const source = { postMessage() {} };
  const frame = { contentWindow: source };
  const validEvent = {
    origin: "https://vidfast.vc",
    source,
    data: {
      type: "PLAYER_EVENT",
      data: {
        event: "timeupdate",
        currentTime: 24.5,
        duration: 120,
        playing: true,
        tmdbId: 550
      }
    }
  };

  const parsed = providers.acceptEvent(validEvent, frame, "vidfast");
  assert.ok(parsed);
  assert.equal(parsed.type, "vidfast:timeupdate");
  assert.equal(parsed.currentTime, 24.5);
  assert.equal(parsed.duration, 120);
  assert.equal(parsed.playing, true);
  assert.equal(parsed.tmdbId, 550);

  // Accepts stringified JSON PLAYER_EVENT
  const stringified = providers.acceptEvent({ ...validEvent, data: JSON.stringify(validEvent.data) }, frame, "vidfast");
  assert.ok(stringified);
  assert.equal(stringified.type, "vidfast:timeupdate");

  // Accepts MEDIA_DATA progress sync event
  const mediaData = providers.acceptEvent({
    origin: "https://vidfast.vc",
    source: frame.contentWindow,
    data: { type: "MEDIA_DATA", data: { t550: { id: 550, progress: { watched: 10, duration: 100 } } } }
  }, frame, "vidfast");
  assert.ok(mediaData);
  assert.equal(mediaData.type, "vidfast:media_data");
  assert.equal(mediaData.itemCount, 1);

  // Accepts status event (e.g. 404 or 200)
  const statusEv = providers.acceptEvent({
    origin: "https://vidfast.vc",
    source: frame.contentWindow,
    data: { event: "status", data: 404 }
  }, frame, "vidfast");
  assert.ok(statusEv);
  assert.equal(statusEv.type, "vidfast:status");
  assert.equal(statusEv.statusCode, 404);

  // Accepts NEXT_EPISODE_AVAILABLE
  const nextEp = providers.acceptEvent({
    origin: "https://vidfast.vc",
    source: frame.contentWindow,
    data: { type: "NEXT_EPISODE_AVAILABLE", data: { season: 1, episode: 2 } }
  }, frame, "vidfast");
  assert.ok(nextEp);
  assert.equal(nextEp.type, "vidfast:nextepisode");
  assert.equal(nextEp.season, 1);
  assert.equal(nextEp.episode, 2);

  // Rejects wrong origin
  assert.equal(providers.acceptEvent({ ...validEvent, origin: "https://evil.test" }, frame, "vidfast"), null);
  // Rejects wrong source window
  assert.equal(providers.acceptEvent({ ...validEvent, source: {} }, frame, "vidfast"), null);
  // Rejects when provider is yapgrid
  assert.equal(providers.acceptEvent(validEvent, frame, "yapgrid"), null);
  // Rejects malformed payload
  assert.equal(providers.acceptEvent({ ...validEvent, data: { type: "unrecognized" } }, frame, "vidfast"), null);
  assert.equal(providers.acceptEvent({ ...validEvent, data: { type: "PLAYER_EVENT", data: { event: "unknown_event" } } }, frame, "vidfast"), null);

  assert.equal(providers.diagnosticRejection({ ...validEvent, origin: "https://wrong.test" }, frame, "vidfast"), "origin");
  assert.equal(providers.diagnosticRejection({ ...validEvent, data: { type: "unknown" } }, frame, "vidfast"), "envelope");
  assert.equal(providers.diagnosticRejection({ ...validEvent, source: {} }, frame, "vidfast"), null);
  assert.equal(providers.diagnosticRejection(validEvent, frame, "yapgrid"), null);
});

test("documented postMessage commands target VidFast with correct arguments", () => {
  const posted = [];
  const frame = { contentWindow: { postMessage(data, origin) { posted.push({ data, origin }); } } };

  assert.equal(providers.sendCommand(frame, "play", [], "vidfast"), true);
  assert.equal(providers.sendCommand(frame, "pause", [], "vidfast"), true);
  assert.equal(providers.sendCommand(frame, "seek", [90], "vidfast"), true);
  assert.equal(providers.sendCommand(frame, "getStatus", [], "vidfast"), true);
  assert.equal(providers.sendCommand(frame, "seek", [-1], "vidfast"), false);
  assert.equal(providers.sendCommand(frame, "unknown", [], "vidfast"), false);

  assert.equal(posted.length, 4);
  assert.equal(posted[0].origin, "https://vidfast.vc");
  assert.equal(posted[0].data.command, "play");
  assert.equal(posted[1].data.command, "pause");
  assert.equal(posted[2].data.command, "seek");
  assert.equal(posted[2].data.time, 90);
  assert.equal(posted[3].data.command, "getStatus");
});

test("CineSrc reference code remains preserved but unselected", () => {
  const movie = { movieId: 550 };
  const episode = { showId: 1396, season: 1, episode: 2 };
  assert.equal(providers.CINESRC, "cinesrc");
  // Direct reference embedUrl call preserves compatibility
  assert.equal(providers.embedUrl(movie, "cinesrc", "off", "https://example.test", catalog),
    "https://cinesrc.st/embed/movie/550");
  assert.equal(providers.embedUrl(episode, "cinesrc", "off", "https://example.test", catalog),
    "https://cinesrc.st/embed/tv/1396?s=1&e=2&autonext=false");

  // But provider select excludes CineSrc from active playback
  assert.equal(providers.select("cinesrc"), "yapgrid");
});

test("VidLink variants use documented player and autoplay parameters for movie and TV IDs", () => {
  const url = (target, mode) => providers.embedUrl(target, "vidlink", "off", "https://example.test", catalog, mode);
  assert.equal(url({ movieId: 550 }, "defaultOff"), "https://vidlink.pro/movie/550?player=default&autoplay=false");
  assert.equal(url({ movieId: 550 }, "defaultOn"), "https://vidlink.pro/movie/550?player=default&autoplay=true");
  assert.equal(url({ movieId: 550 }, "jwOn"), "https://vidlink.pro/movie/550?player=jw&autoplay=true");
  assert.equal(url({ showId: 1396, season: 2, episode: 3 }, "jwOn"),
    "https://vidlink.pro/tv/1396/2/3?player=jw&autoplay=true");
  assert.equal(url({ movieId: 550 }, "unknown"), url({ movieId: 550 }, "defaultOff"));
  assert.equal(url({ movieId: "550" }, "defaultOff"), null);
  assert.equal(providers.select("vidfast"), "vidfast", "legacy direct route remains available for reference");
  assert.equal(catalog.parse("?type=movie&id=550&provider=vidlink").provider, "vidlink");
});

test("VidLink messages require exact origin, expected frame, and separate envelopes", () => {
  const source = {};
  const frame = { contentWindow: source };
  const event = data => ({ origin: "https://vidlink.pro", source, data });
  const play = providers.acceptEvent(event({ type: "PLAYER_EVENT", data: { event: "play", currentTime: 0, duration: 120 } }), frame, "vidlink");
  assert.equal(play.type, "vidlink:play");
  assert.equal(providers.acceptEvent(event({ type: "MEDIA_DATA", data: { 550: { progress: { watched: 5 } } } }), frame, "vidlink").type,
    "vidlink:media_data");
  assert.equal(providers.acceptEvent(event({ type: "PLAYER_EVENT", data: { event: "timeupdate", currentTime: 10.5, duration: 120 } }), frame, "vidlink").currentTime, 10.5);
  assert.equal(providers.acceptEvent({ ...event({ type: "PLAYER_EVENT", data: { event: "play" } }), origin: "https://vidfast.vc" }, frame, "vidlink"), null);
  assert.equal(providers.acceptEvent({ ...event({ type: "PLAYER_EVENT", data: { event: "play" } }), source: {} }, frame, "vidlink"), null);
  assert.equal(providers.acceptEvent(event({ type: "PLAYER_EVENT", data: { event: "timeupdate", currentTime: "10" } }), frame, "vidlink"), null);
  assert.equal(providers.acceptEvent(event({ type: "PLAYER_EVENT", data: { event: "unknown" } }), frame, "vidlink"), null);
  assert.equal(providers.acceptEvent(event({ type: "PLAYER_EVENT", data: { event: "play" } }), frame, "vidfast"), null);
  assert.equal(providers.diagnosticRejection(event({ type: "bad" }), frame, "vidlink"), "envelope");
  assert.equal(providers.sendCommand({ contentWindow: { postMessage() { throw Error("unexpected"); } } }, "play", [], "vidlink"), false);
});

test("VidRift history and VidBolt URLs use documented shapes with autoplay default", () => {
  const url = (target, provider, mode) => providers.embedUrl(target, provider, "off", "https://example.test", catalog, mode);
  assert.equal(url({ movieId: 550 }, "vidrift"), "https://embed.vidrift.net/embed/movie/550");
  assert.equal(url({ showId: 1396, season: 2, episode: 3 }, "vidrift"), "https://embed.vidrift.net/embed/tv/1396/2/3");
  assert.equal(url({ movieId: 550 }, "vidbolt"), "https://vidbolt.xyz/movie/550?autoPlay=true");
  assert.equal(url({ movieId: 550 }, "vidbolt", "autoPlayOff"), "https://vidbolt.xyz/movie/550");
  assert.equal(providers.embedUrl({ movieId: 550 }, "vidbolt", "off", "https://example.test", catalog, null, 42.5),
    "https://vidbolt.xyz/movie/550?autoPlay=true&startAt=42.5");
  assert.equal(url({ showId: 1396, season: 2, episode: 3 }, "vidbolt", "autoPlayTrue"),
    "https://vidbolt.xyz/tv/1396/2/3?autoPlay=true");
  assert.equal(url({ movieId: 0 }, "vidrift"), null);
  assert.equal(url({ showId: 1396, season: 0, episode: 1 }, "vidbolt"), null);
  assert.equal(catalog.parse("?type=movie&id=550&provider=vidbolt").provider, "vidbolt");
  assert.equal(catalog.pageUrl({ showId: 1396, season: 2, episode: 3 }, "off", false,
    null, false, null, null, "vidrift"), "player-overlay.html?season=2&episode=3&sub=off&showId=1396&provider=vidrift");
});

test("experimental commands use exact provider payloads and origins", () => {
  const posted = [];
  const frame = { contentWindow: { postMessage(data, origin) { posted.push({ data, origin }); } } };
  for (const command of ["get-state", "play", "pause", "seek-backward", "seek-forward", "volume50", "unmute"])
    assert.equal(providers.sendCommand(frame, command, [], "vidrift"), true);
  assert.deepEqual(posted.map(item => item.origin), Array(7).fill("https://embed.vidrift.net"));
  assert.deepEqual(posted.map(item => JSON.stringify(item.data)), [
    '{"type":"vidrift:get-state"}', '{"type":"vidrift:play"}', '{"type":"vidrift:pause"}',
    '{"type":"vidrift:skip","seconds":-10}', '{"type":"vidrift:skip","seconds":10}',
    '{"type":"vidrift:set","volume":0.5}', '{"type":"vidrift:set","muted":false}'
  ]);
  assert.equal(providers.sendCommand(frame, "resume", [42], "vidrift"), true);
  assert.equal(JSON.stringify(posted.at(-1).data), '{"type":"vidrift:resume","currentTime":42}');
  assert.equal(providers.sendCommand(frame, "resume", [-1], "vidrift"), false);
  posted.length = 0;
  assert.equal(providers.sendCommand(frame, "play", [], "vidbolt"), true);
  assert.equal(providers.sendCommand(frame, "pause", [], "vidbolt"), true);
  assert.equal(providers.sendCommand(frame, "seek", [120], "vidbolt"), true);
  assert.equal(providers.sendCommand(frame, "volume50", [], "vidbolt"), true);
  assert.deepEqual(posted.map(item => JSON.stringify(item.data)), [
    '{"type":"play"}', '{"type":"pause"}', '{"type":"seek","time":120}',
    '{"type":"volume","volume":0.5}'
  ]);
  assert.ok(posted.every(item => item.origin === "https://vidbolt.xyz"));
  assert.equal(providers.sendCommand(frame, "seek", [-1], "vidbolt"), false);
  assert.equal(providers.sendCommand(frame, "unmute", [], "vidbolt"), false);
});

test("experimental events validate origin, source, identity, payloads, and error reasons", () => {
  const source = {};
  const frame = { contentWindow: source };
  const movie = { movieId: 550 };
  const rift = data => ({ origin: "https://embed.vidrift.net", source, data: { tmdbId: 550, mediaType: "movie", ...data } });
  const state = providers.acceptEvent(rift({ type: "vidrift:state", paused: false,
    currentTime: 10, duration: 100, volume: 0.5, muted: true, audios: [{}, {}], servers: [{}] }), frame, "vidrift", movie);
  assert.equal(state.type, "vidrift:state");
  assert.equal(state.audioCount, 2);
  assert.equal(state.serverCount, 1);
  const serverState = providers.acceptEvent(rift({ type: "vidrift:state", paused: true,
    currentTime: 20, duration: 100, volume: 0.14999999999999997, muted: false,
    server: "vela", source: "0", servers: [{ value: "vela", state: "ready" },
      { value: "nova", state: "failed" }] }), frame, "vidrift", movie);
  assert.equal(serverState.server, "vela");
  assert.equal(serverState.source, "0");
  assert.deepEqual(Array.from(serverState.servers, item => `${item.value}:${item.state}`), ["vela:ready", "nova:failed"]);
  assert.equal(providers.acceptEvent(rift({ type: "vidrift:command-error", command: "vidrift:set",
    field: "muted", reason: "click-required" }), frame, "vidrift", movie).reason, "click-required");
  assert.equal(providers.acceptEvent(rift({ type: "vidrift:progress", currentTime: 10, duration: 100 }), frame, "vidrift", movie).currentTime, 10);
  assert.equal(providers.acceptEvent({ ...rift({ type: "vidrift:paused", currentTime: 10 }), origin: "https://vidbolt.xyz" }, frame, "vidrift", movie), null);
  assert.equal(providers.acceptEvent({ ...rift({ type: "vidrift:paused", currentTime: 10 }), source: {} }, frame, "vidrift", movie), null);
  assert.equal(providers.acceptEvent(rift({ type: "vidrift:paused", tmdbId: 551, currentTime: 10 }), frame, "vidrift", movie), null);
  assert.equal(providers.diagnosticRejection(rift({ type: "vidrift:paused", tmdbId: 551, currentTime: 10 }), frame, "vidrift", movie), "identity:mismatch-tmdbId");
  assert.equal(providers.diagnosticRejection(rift({ type: "vidrift:state", paused: false }), frame, "vidrift", movie), "shape");
  assert.equal(providers.diagnosticRejection(rift({ type: "vidrift:ui-hidden" }), frame, "vidrift", movie), "unsupported-type");
  assert.equal(providers.diagnosticRejection(rift({ type: "vidrift:ui-hidden", mediaType: undefined }), frame, "vidrift", movie), "identity:missing-mediaType");
  assert.equal(providers.acceptEvent(rift({ type: "vidrift:command-error", tmdbId: undefined,
    mediaType: undefined, command: "vidrift:play", reason: "click-required" }), frame, "vidrift", movie).reason, "click-required");
  assert.equal(providers.acceptEvent(rift({ type: "vidrift:command-error", tmdbId: undefined,
    mediaType: undefined, command: "play", reason: "click-required" }), frame, "vidrift", movie).command, "play");
  assert.equal(providers.acceptEvent(rift({ type: "vidrift:command-error", tmdbId: undefined,
    mediaType: undefined, reason: "click-required" }), frame, "vidrift", movie).command, "unknown");
  assert.equal(providers.acceptEvent(rift({ type: "vidrift:command-error", tmdbId: 551,
    command: "vidrift:play", reason: "click-required" }), frame, "vidrift", movie), null);
  assert.equal(providers.diagnosticRejection(rift({ type: "vidrift:command-error", tmdbId: 551 }), frame, "vidrift", movie), "identity:mismatch-tmdbId");
  assert.equal(providers.diagnosticRejection({ ...rift({ type: "vidrift:paused", currentTime: 10 }), source: {} }, frame, "vidrift", movie), "source");
  assert.equal(providers.acceptEvent(rift({ type: "vidrift:state", paused: false, currentTime: 2,
    duration: 10, volume: 1, muted: false, season: null, episode: null }), frame, "vidrift", movie).type, "vidrift:state");
  assert.equal(providers.acceptEvent(rift({ type: "vidrift:command-error", tmdbId: "550",
    command: "vidrift:play", reason: "click-required" }), frame, "vidrift", movie).reason, "click-required");
  assert.equal(providers.acceptEvent(rift({ type: "vidrift:state", tmdbId: [550], paused: false,
    currentTime: 1, duration: 2, volume: 0.5, muted: false }), frame, "vidrift", movie), null);
  const bolt = data => ({ origin: "https://vidbolt.xyz", source, data });
  assert.equal(providers.acceptEvent(bolt({ type: "ready" }), frame, "vidbolt").type, "vidbolt:ready");
  assert.equal(providers.acceptEvent(bolt({ type: "timeupdate", time: 12.5 }), frame, "vidbolt").currentTime, 12.5);
  assert.equal(providers.acceptEvent(bolt({ type: "durationchange", duration: 100 }), frame, "vidbolt").duration, 100);
  assert.equal(providers.acceptEvent(bolt({ type: "timeupdate", time: "12" }), frame, "vidbolt"), null);
  assert.equal(providers.acceptEvent(bolt({ type: "ready" }), frame, "vidrift", movie), null);
});
