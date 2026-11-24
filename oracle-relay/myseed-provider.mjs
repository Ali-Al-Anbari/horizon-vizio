import { open } from "node:fs/promises";
import { mediaSignature, requestUpstream, safeUrl } from "./catalog.mjs";
import { createPlaybackProvider } from "./playback-provider.mjs";

export const MYSEED_MEDIA_HEADERS = Object.freeze({
  "User-Agent": "Horizon Watch",
  Accept: "video/mp4",
  "Accept-Encoding": "identity",
});

async function readDescriptor(path) {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 8192) throw new Error("invalid_myseed_descriptor_file");
    const buffer = Buffer.alloc(8193);
    const { bytesRead } = await file.read(buffer);
    if (bytesRead !== stat.size) throw new Error("invalid_myseed_descriptor_file");
    return JSON.parse(buffer.toString("utf8", 0, bytesRead));
  } finally {
    await file.close();
  }
}

export function createMySeedProvider({
  enabled, relayPermitted, hosts = [], descriptorFile, loadDescriptor,
  agent, request = requestUpstream, now = () => Date.now(),
} = {}) {
  const permitted = enabled === true && relayPermitted === true;
  const approvedHosts = permitted ? hosts.map(host => host.trim().toLowerCase()) : [];
  if (approvedHosts.length > 16 || approvedHosts.some(host =>
    host.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(host))) {
    throw new Error("invalid_myseed_media_hosts");
  }
  const mediaHosts = approvedHosts.length
    ? new RegExp("^(?:" + approvedHosts.map(host => host.replaceAll(".", "\\.")).join("|") + ")$")
    : /(?!)/;
  const loader = loadDescriptor || (descriptorFile ? () => readDescriptor(descriptorFile) : null);
  const provider = createPlaybackProvider({
    enabled: permitted && !!loader && approvedHosts.length > 0,
    relayPermitted,
    mediaHosts,
    async resolveSources(assetId, { force = false } = {}) {
      const descriptor = await loader(assetId, { force });
      if (descriptor?.assetId !== assetId) throw new Error("myseed_asset_unavailable");
      const { url, expiresAtMs, renditionId, workId } = descriptor;
      if (descriptor.format !== "mp4"
        || (expiresAtMs != null && (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= now()))) {
        throw new Error("invalid_or_expired_myseed_descriptor");
      }
      if (typeof workId !== "string" || !/^[a-z0-9_.:-]{1,73}$/i.test(workId)
        || typeof renditionId !== "string" || !/^[a-z0-9_.:-]{1,80}$/i.test(renditionId)
        || typeof url !== "string" || url.length > 4096) throw new Error("invalid_myseed_descriptor");
      const { href } = safeUrl(url, mediaHosts);
      const range = "bytes=0-11";
      const probe = await request(new URL(href), {
        agent, range, signal: AbortSignal.timeout(1500), headers: MYSEED_MEDIA_HEADERS,
      });
      const mime = String(probe.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      const size = Number(/^bytes 0-11\/(\d+)$/.exec(probe.headers["content-range"] || "")?.[1]);
      if (probe.status !== 206 || !Number.isSafeInteger(size) || size < 12
        || !["video/mp4", "application/octet-stream"].includes(mime) || probe.headers["content-encoding"]
        || (probe.headers["content-length"] !== undefined && Number(probe.headers["content-length"]) !== 12)
        || probe.bytes?.length !== 12 || mediaSignature(probe.bytes) !== "mp4" || probe.bytes.readUInt32BE(0) > size
        || (expiresAtMs != null && expiresAtMs <= now())) throw new Error("myseed_mp4_unverified");
      return { assetId, work: "myseed:" + workId,
        sources: [{ key: renditionId, url: href, format: "mp4", verified: true, expiresAtMs }] };
    },
    bindEpisodeWork: true,
  });
  return { ...provider, mediaHosts };
}
