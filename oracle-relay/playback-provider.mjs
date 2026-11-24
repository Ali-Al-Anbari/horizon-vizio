import { catalogKey, safeUrl } from "./catalog.mjs";

const SOURCE_KEY = /^[a-z0-9_.:-]{1,80}$/i;

/**
 * Oracle playback adapter boundary. The resolver is responsible for matching
 * publisher metadata and verifying media bytes. It returns a bounded set of
 * renditions of exactly the requested canonical asset. force refreshes media
 * URLs; the relay independently pins the work and rendition keys in tickets.
 */
export function createPlaybackProvider({ enabled = false, relayPermitted = false, mediaHosts, resolveSources,
  bindEpisodeWork = false, episodeRenditions = 1 }) {
  const active = enabled === true && relayPermitted === true;
  if (!(mediaHosts instanceof RegExp) || mediaHosts.global || mediaHosts.sticky
      || typeof resolveSources !== "function") throw new TypeError("invalid_playback_provider");

  async function getPlaybackSource(assetId, options) {
    if (!active) throw new Error("provider_unavailable");
    const identity = catalogKey(assetId);
    if (!identity) throw new Error("title_unmapped");
    const result = await resolveSources(assetId, options);
    if (result?.assetId !== assetId) throw new Error("provider_identity_mismatch");
    const movie = identity.type === "movie";
    if (movie || bindEpisodeWork ? typeof result.work !== "string" || !SOURCE_KEY.test(result.work) : result.work !== null) {
      throw new Error("provider_identity_mismatch");
    }
    const sources = result.sources;
    if (!Array.isArray(sources) || !sources.length || sources.length > (movie ? 2 : episodeRenditions)) {
      throw new Error("invalid_provider_sources");
    }
    const keys = new Set();
    const urls = new Set();
    for (const source of sources) {
      if (source?.format !== "mp4" || typeof source.url !== "string" || typeof source.key !== "string"
        || !SOURCE_KEY.test(source.key) || keys.has(source.key)
        || (source.verified !== true && (!movie || source.verified !== false))) {
        throw new Error("invalid_provider_source");
      }
      const url = safeUrl(source.url, mediaHosts).href;
      if (urls.has(url)) throw new Error("invalid_provider_source");
      keys.add(source.key);
      urls.add(url);
    }
    return result;
  }

  return Object.freeze({ enabled: active, getPlaybackSource });
}
