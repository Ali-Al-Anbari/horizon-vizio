import { createCatalog, findCatalogRoots } from "./catalog.mjs";
import { performance } from "node:perf_hooks";
import https from "node:https";
import { readFileSync } from "node:fs";

const sample = [
  "movie-1316421", // Project X / المشروع إكس
  "movie-917242", // El Gawahergy / الجواهرجي
  "tv-297621-s1-e1", "tv-297621-s1-e30", // Pride of the Delta / فخر الدلتا
  "tv-304331-s1-e1", "tv-304331-s1-e15", // Aftershocks / توابع
  "tv-122543-s6-e1", "tv-122543-s6-e30", // Al Maddah / المداح
  "tv-122543-s5-e1", "tv-122543-s5-e30",
  "tv-301322-s1-e1", "tv-301322-s1-e30", // Ifraj / إفراج
  "tv-122543-s4-e1", // Earlier season, discovered without an indexed root
];
const expanded = [
  "movie-1246595", "movie-800139", "movie-1197989", "movie-8335308",
  "movie-1324331", "movie-1758475", "movie-362739", "movie-620371",
  "movie-629040", "movie-1498134", "movie-1316416",
  "tv-260606-s1-e1", "tv-260606-s1-e15", "tv-260606-s1-e30",
  "tv-244644-s1-e1", "tv-244644-s1-e15", "tv-244644-s2-e1", "tv-244644-s2-e30",
  "tv-102045-s1-e1", "tv-102045-s1-e30", "tv-102045-s2-e15", "tv-102045-s3-e30",
  "tv-220993-s1-e1", "tv-220993-s1-e15", "tv-220993-s1-e99",
  "tv-156219-s1-e1", "tv-156219-s1-e30",
  "tv-218324-s1-e1", "tv-218324-s2-e8", "tv-218324-s3-e15",
  "tv-122543-s2-e30", "tv-122543-s3-e15", "tv-122543-s4-e30", "tv-122543-s9-e1",
];
// Exact title/year identities from Watch metadata. TV uses S01E01.
const modernEgyptian = [
  "movie-1224392", "movie-1119605", "movie-1250602", "movie-1261562", "movie-1276086",
  "movie-1232790", "movie-1170841", "movie-1324136", "movie-1316404", "movie-1324315",
  "tv-224882-s1-e1", "tv-246245-s1-e1", "tv-246244-s1-e1", "tv-245985-s1-e1", "tv-260658-s1-e1",
  "tv-271181-s1-e1", "tv-276068-s1-e1", "tv-271790-s1-e1", "tv-304229-s1-e1", "tv-302614-s1-e1",
];
const unseenMovies = ["movie-84250", "movie-280470", "movie-47324", "movie-44085", "movie-517814", "movie-7973"];
const agent = process.env.CA_BUNDLE_PATH ? new https.Agent({
  ca: readFileSync(process.env.CA_BUNDLE_PATH), rejectUnauthorized: true, keepAlive: true, maxSockets: 6,
}) : undefined;
if (process.argv[2] === "--find") {
  try {
    const paths = await findCatalogRoots(process.argv[3], process.argv.slice(4), agent);
    console.log(JSON.stringify({ candidatePaths: paths, identityReviewRequired: true }));
  } catch {
    console.error("Catalog search unavailable");
    process.exitCode = 1;
  }
  agent?.destroy();
} else {
  const args = process.argv.slice(2);
  const cold = args.includes("--cold");
  const assets = args.filter(id => !id.startsWith("--"));
  const selections = assets.length ? assets : args.includes("--expanded") ? expanded
    : args.includes("--modern-egyptian") ? modernEgyptian : args.includes("--unseen-movies") ? unseenMovies : sample;
  const options = { agent, probeFormats: args.includes("--probe-formats"), ...(args.includes("--discover-only") ? { roots: {} } : {}) };
  const catalog = createCatalog(options);
  const started = performance.now();
  const cpu = process.cpuUsage();
  let verified = 0, bestEffort = 0, mapped = 0, watchMatches = 0, titleMatches = 0, seasonMatches = 0, timeouts = 0;
  const signatures = { mp4: 0, matroska: 0, webm: 0, hls: 0, ebml: 0 };
  const times = [];
  for (const id of selections) {
    const resolver = cold ? createCatalog(options) : catalog;
    const known = resolver.has(id);
    if (known) mapped++;
    const start = performance.now();
    let watchMatch = false, titleMatch = false;
    const probes = [];
    let reason = "range_mp4_verified";
    try {
      const descriptor = await resolver.resolveSources(id, {
        onTitleMatch: () => { titleMatch = true; titleMatches++; },
        onWatchMatch: () => { watchMatch = true; watchMatches++; },
        onProbe: result => probes.push(result),
      });
      if (descriptor.sources[0].verified) verified++;
      else { bestEffort++; reason = "mp4_candidate_unverified"; }
    } catch (error) {
      reason = /^(?:title_unmapped|title_not_found|title_identity_mismatch|ambiguous_title|metadata_unverified|metadata_episode_missing|episode_identity_mismatch|episode_missing|ambiguous_episode|watch_link_unverified|range_mp4_unverified|(?:metadata|catalog)_http_\d{3}|invalid_catalog_page|catalog_challenge|identity_redirect|catalog_redirect_limit|non_public_dns|disallowed_url|response_size_limit)$/.test(error.message)
        ? error.message : ["AbortError", "TimeoutError"].includes(error.name) ? "timeout"
          : /^(?:UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|CERT_HAS_EXPIRED|ECONNRESET|ENOTFOUND|ECONNREFUSED|ETIMEDOUT)$/.test(error.code)
            ? error.code : "transport_or_tls_error";
    }
    const seasonMatch = id.startsWith("tv-") ? titleMatch : null;
    if (seasonMatch) seasonMatches++;
    if (reason === "timeout" || reason === "ETIMEDOUT") timeouts++;
    for (const format of new Set(probes.filter(probe => probe.rangeValid).map(probe => probe.format))) {
      if (Object.hasOwn(signatures, format)) signatures[format]++;
    }
    const ms = Math.round(performance.now() - start);
    times.push(ms);
    console.log(JSON.stringify({ id, mapped: known, titleMatch, seasonMatch, watchMatch, result: reason, probes, ms }));
  }
  const ordered = times.slice().sort((a, b) => a - b);
  console.log(JSON.stringify({ count: selections.length, mapped, titleMatches, seasonMatches, watchMatches,
    verified, bestEffort, signatures, playbackTested: 0, timeouts, p95LookupMs: ordered[Math.ceil(0.95 * times.length) - 1],
    averageLookupMs: Math.round(times.reduce((sum, ms) => sum + ms, 0) / times.length),
    elapsedMs: Math.round(performance.now() - started),
    cpuMs: Math.round((process.cpuUsage(cpu).user + process.cpuUsage(cpu).system) / 1000),
    peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) }));
  agent?.destroy();
}
