import { test } from "node:test";
import assert from "node:assert/strict";
import { createPlaybackProvider } from "../oracle-relay/playback-provider.mjs";

const movie = "movie-629040";
const episode = "tv-304229-s1-e1";
const source = { key: "210:0", url: "https://media.example/movie.mp4", format: "mp4", verified: true };
const descriptor = { assetId: movie, work: "123", sources: [source] };
const mediaHosts = /^media\.example$/;
const fixture = options => createPlaybackProvider({
  enabled: true, relayPermitted: true, mediaHosts, resolveSources: async () => descriptor, ...options,
});

test("disabled or unapproved playback providers perform no upstream resolution", async () => {
  const calls = [];
  const resolveSources = async id => { calls.push(id); return descriptor; };
  for (const settings of [{ enabled: false }, { relayPermitted: false }, { relayPermitted: "true" }]) {
    const provider = fixture({ resolveSources, ...settings });
    assert.equal(provider.enabled, false);
    await assert.rejects(provider.getPlaybackSource(movie), /provider_unavailable/);
  }
  assert.deepEqual(calls, []);
});

test("provider contract returns only the requested canonical asset and passes through refresh", async () => {
  const calls = [];
  const provider = fixture({ resolveSources: async (id, options) => {
    calls.push([id, options]);
    return descriptor;
  } });
  assert.equal(provider.enabled, true);
  assert.deepEqual(await provider.getPlaybackSource(movie), descriptor);
  assert.deepEqual(await provider.getPlaybackSource(movie, { force: true }), descriptor);
  await assert.rejects(provider.getPlaybackSource("https://arbitrary.example/v.mp4"), /title_unmapped/);
  await assert.rejects(provider.getPlaybackSource("movie-1316416"), /provider_identity_mismatch/);
  assert.deepEqual(calls.slice(0, 2), [[movie, undefined], [movie, { force: true }]]);
});

test("an unavailable Akwam result and an unavailable secondary remain unavailable", async () => {
  const missing = fixture({ resolveSources: async () => { throw new Error("title_not_found"); } });
  const unconfigured = fixture({ relayPermitted: false });
  await assert.rejects(missing.getPlaybackSource(movie), /title_not_found/);
  await assert.rejects(unconfigured.getPlaybackSource(movie), /provider_unavailable/);
});

test("provider contract refuses the wrong TV season or episode and unverified TV media", async () => {
  for (const assetId of ["tv-304229-s2-e1", "tv-304229-s1-e2"]) {
    const wrong = fixture({ resolveSources: async () => ({ assetId, work: null, sources: [source] }) });
    await assert.rejects(wrong.getPlaybackSource(episode), /provider_identity_mismatch/);
  }
  const weak = fixture({ resolveSources: async () => ({
    assetId: episode, work: null, sources: [{ ...source, verified: false }],
  }) });
  await assert.rejects(weak.getPlaybackSource(episode), /invalid_provider_source/);
});

test("provider contract rejects unapproved hosts, unsupported formats, and repeated or excessive renditions", async () => {
  for (const [sources, error] of [
    [[{ ...source, url: "https://127.0.0.1/movie.mp4" }], /disallowed_url/],
    [[{ ...source, url: "http://media.example/movie.mp4" }], /disallowed_url/],
    [[{ ...source, format: "hls" }], /invalid_provider_source/],
    [[source, source], /invalid_provider_source/],
    [[source, { ...source, key: "210:1" }], /invalid_provider_source/],
    [[source, source, source], /invalid_provider_sources/],
  ]) {
    const provider = fixture({ resolveSources: async () => ({ ...descriptor, sources }) });
    await assert.rejects(provider.getPlaybackSource(movie), error);
  }
  const alternate = { ...source, key: "210:1", url: "https://media.example/backup.mp4", verified: false };
  const provider = fixture({ resolveSources: async () => ({ ...descriptor, sources: [source, alternate] }) });
  assert.deepEqual((await provider.getPlaybackSource(movie)).sources, [source, alternate]);
});
