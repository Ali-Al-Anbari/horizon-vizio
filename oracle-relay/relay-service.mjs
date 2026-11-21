/**
 * Horizon Watch — Audited Strict-TLS Akwam Resolver & Ticket-Authenticated Range Relay
 * Zero external npm dependencies (Node.js 20+ / 22+ built-ins only).
 *
 * Security & Reliability Controls:
 * - Short-lived, episode-scoped HMAC-SHA256 playback tickets (never exposes permanent server secrets).
 * - Ticket issuance (POST /ticket) requires an authenticated paired-device session hash
 *   (SHA-256 matching Horizon's __Host-horizon_session / X-Horizon-Device-Session model)
 *   OR server-side ISSUER_SECRET Bearer auth. Fail-closed on missing secrets.
 * - Bounded ticket lifetime (exp) + bounded refresh ceiling (maxExp, maxRefreshes).
 * - Strict upstream TLS (rejectUnauthorized: true) with verified intermediate + trusted roots.
 * - Strict redirect validation (no SSRF / open proxy), allowlist-only episodes & hosts.
 * - Issue A fix: Shared in-flight resolve Promise + 5s refresh cooldown (1 resolve per Reload).
 * - Issue B fix: Transparent single-retry on expired Downet URLs (HTTP 403/404/410/500).
 * - 1 GB RAM & $0 OCI Always Free safeguards: per-IP rate limit, concurrent-stream cap,
 *   daily egress byte cap, zero disk caching, zero secret/ticket/signed-URL logging.
 */
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import { catalogKey, createCatalog, MEDIA_HOST, publicLookup, safeUrl } from "./catalog.mjs";

export const DEFAULT_ALLOWLIST = {
  "fakhr-el-delta-s01e01": {
    title: "فخر الدلتا — S01E01",
    watchUrl:
      "https://akwam.ss/watch/171750/93906/%D9%81%D8%AE%D8%B1-%D8%A7%D9%84%D8%AF%D9%84%D8%AA%D8%A7/%D8%A7%D9%84%D8%AD%D9%84%D9%82%D8%A9-1",
    watchHostPattern: /^(akwam\.(ss|cc|to|org|top)|ak\.sv)$/i,
    mediaHostPattern: /^s\d+d\d+\.downet\.net$/i,
  },
};

const EXPIRED_UPSTREAM_STATUSES = new Set([403, 404, 410, 500]);
const SESSION_COOKIE = "__Host-horizon_session";

function timingSafeStrEqual(a, b) {
  if (!a || !b) return false;
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function sha256Hex(str) {
  return crypto.createHash("sha256").update(String(str)).digest("hex");
}

function b64urlEncode(bufOrStr) {
  return Buffer.from(bufOrStr).toString("base64url");
}

function b64urlDecode(str) {
  return Buffer.from(String(str), "base64url").toString("utf8");
}

export function signPlaybackTicket(payload, secret) {
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyPlaybackTicket(token, secret, expectedEpisodeId, nowSec = Math.floor(Date.now() / 1000)) {
  if (!token || typeof token !== "string") return { ok: false, reason: "missing_ticket" };
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed_ticket" };
  const [body, sig] = parts;
  const expectedSig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  if (!timingSafeStrEqual(sig, expectedSig)) return { ok: false, reason: "invalid_ticket_signature" };

  let payload;
  try {
    payload = JSON.parse(b64urlDecode(body));
  } catch {
    return { ok: false, reason: "invalid_ticket_payload" };
  }
  if (!payload || typeof payload !== "object") return { ok: false, reason: "invalid_ticket_payload" };
  if (!payload.ep || payload.ep !== expectedEpisodeId) return { ok: false, reason: "ticket_episode_mismatch" };
  if (!Number.isFinite(payload.exp) || nowSec > payload.exp) return { ok: false, reason: "ticket_expired" };
  if (Number.isFinite(payload.maxExp) && nowSec > payload.maxExp) return { ok: false, reason: "ticket_session_expired" };
  if (Number.isFinite(payload.iat) && payload.iat > nowSec + 30) return { ok: false, reason: "ticket_not_yet_valid" };
  return { ok: true, payload };
}

function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(name + "=")) {
      return trimmed.slice(name.length + 1).trim();
    }
  }
  return null;
}

export function createHardenedRelay(config = {}) {
  const caBundlePath = config.caBundlePath || process.env.CA_BUNDLE_PATH || "/etc/horizon-relay/ca-bundle.pem";
  const ticketSigningSecret = config.ticketSigningSecret ?? process.env.TICKET_SIGNING_SECRET ?? "";
  const issuerSecret = config.issuerSecret ?? process.env.ISSUER_SECRET ?? "";
  const pairedDeviceHashesRaw = config.pairedDeviceHashes ?? process.env.PAIRED_DEVICE_HASHES ?? "";
  const allowedOrigin = config.allowedOrigin || process.env.ALLOWED_ORIGIN || "http://127.0.0.1:8788";
  const akwamProxyPermitted =
    config.akwamProxyPermitted ?? (process.env.AKWAM_PROXY_PERMITTED || "false") === "true";
  const maxConcurrentStreams = Number(config.maxConcurrentStreams || process.env.MAX_CONCURRENT_STREAMS || 8);
  const rateLimitMax = Number(config.rateLimitMax || process.env.RATE_LIMIT_MAX || 120);
  const ticketRateLimitMax = Number(config.ticketRateLimitMax || process.env.TICKET_RATE_LIMIT_MAX || 20);
  const ticketTtlSec = Number(config.ticketTtlSec || process.env.TICKET_TTL_SEC || 1800); // 30 min
  const ticketMaxSessionSec = Number(config.ticketMaxSessionSec || process.env.TICKET_MAX_SESSION_SEC || 10800); // 3h hard ceiling
  const maxTicketRefreshes = Number(config.maxTicketRefreshes || process.env.MAX_TICKET_REFRESHES || 3);
  const refreshCooldownMs = Number(config.refreshCooldownMs || process.env.REFRESH_COOLDOWN_MS || 5000);
  const cacheTtlMs = Number(config.cacheTtlMs || process.env.CACHE_TTL_MS || 10 * 60_000);
  const dailyEgressCapBytes = Number(config.dailyEgressCapGB || process.env.DAILY_EGRESS_CAP_GB || 200) * 1024 ** 3;
  const allowlist = Object.assign(Object.create(null), config.allowlist || DEFAULT_ALLOWLIST);
  const enableTestFaults = Boolean(config.enableTestFaults);

  // Parse paired-device registry: "deviceId:sha256hex,deviceId2:sha256hex"
  const pairedDevicesByHash = new Map();
  for (const item of String(pairedDeviceHashesRaw).split(",").map((s) => s.trim()).filter(Boolean)) {
    const idx = item.indexOf(":");
    if (idx > 0) {
      const devId = item.slice(0, idx).trim();
      const hash = item.slice(idx + 1).trim().toLowerCase();
      if (/^[0-9a-f]{64}$/.test(hash)) pairedDevicesByHash.set(hash, devId);
    }
  }

  // Fail-closed startup validation: never run unauthenticated or with weak/missing secrets
  if (ticketSigningSecret.length < 32) {
    throw new Error("TICKET_SIGNING_SECRET must be set and at least 32 characters.");
  }
  if (!issuerSecret && pairedDevicesByHash.size === 0) {
    throw new Error("At least one of ISSUER_SECRET or PAIRED_DEVICE_HASHES must be configured.");
  }
  if (!fs.existsSync(caBundlePath)) {
    throw new Error(`Verified CA bundle not found at ${caBundlePath}`);
  }

  const strictTlsAgent = new https.Agent({
    ca: fs.readFileSync(caBundlePath, "utf8"),
    rejectUnauthorized: true,
    keepAlive: true,
    maxSockets: Math.max(16, maxConcurrentStreams * 2),
  });
  const catalog = createCatalog({ agent: strictTlsAgent, ...config.catalog });
  const knownAsset = id => !!allowlist[id] || (akwamProxyPermitted && !!catalogKey(id));

  const descriptorCache = new Map();
  const inFlightResolves = new Map();
  const rateBuckets = new Map();
  const ticketRateBuckets = new Map();
  let egressWindowDay = new Date().toISOString().slice(0, 10);
  let dailyBytesStreamed = 0;

  const stats = {
    startedAt: Date.now(),
    ticketsIssued: 0,
    ticketsRejected: 0,
    resolveCount: 0,
    dedupedResolveHits: 0,
    cooldownReuses: 0,
    expiredAutoRetries: 0,
    tlsAuthorizedResponses: 0,
    http206Responses: 0,
    totalBytesStreamed: 0,
    activeStreams: 0,
    upstreamAborts: 0,
    rateLimitedCount: 0,
    peakRssBytes: process.memoryUsage().rss,
    peakHeapUsedBytes: process.memoryUsage().heapUsed,
  };

  function sampleMemory() {
    const m = process.memoryUsage();
    if (m.rss > stats.peakRssBytes) stats.peakRssBytes = m.rss;
    if (m.heapUsed > stats.peakHeapUsedBytes) stats.peakHeapUsedBytes = m.heapUsed;
  }
  const memTimer = setInterval(sampleMemory, 500);
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of rateBuckets) if (now > v.resetAt) rateBuckets.delete(k);
    for (const [k, v] of ticketRateBuckets) if (now > v.resetAt) ticketRateBuckets.delete(k);
  }, 60_000);

  function getClientIp(req) {
    const remote = req.socket.remoteAddress || "127.0.0.1";
    const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    if (isLoopback && req.headers["x-forwarded-for"]) {
      const parts = String(req.headers["x-forwarded-for"]).split(",").map((s) => s.trim()).filter(Boolean);
      return parts[parts.length - 1] || remote;
    }
    return remote;
  }

  function checkBucket(map, key, maxPerMin) {
    const now = Date.now();
    let b = map.get(key);
    if (!b || now > b.resetAt) {
      b = { count: 0, resetAt: now + 60_000 };
      map.set(key, b);
    }
    b.count += 1;
    return b.count <= maxPerMin;
  }

  function recordEgress(bytes) {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== egressWindowDay) {
      egressWindowDay = today;
      dailyBytesStreamed = 0;
    }
    dailyBytesStreamed += bytes;
    stats.totalBytesStreamed += bytes;
  }

  /**
   * Authenticates a caller attempting to mint a short-lived playback ticket.
   * Aligns with Horizon's paired-device session cookie (__Host-horizon_session)
   * and supports server-to-server ISSUER_SECRET Bearer auth from Horizon's Worker.
   * Note: CORS/Origin alone is NEVER treated as authentication.
   */
  function authenticateTicketIssuer(req) {
    // 1. Server-to-server Horizon Worker issuer auth
    const authHdr = req.headers.authorization || "";
    if (issuerSecret && authHdr.startsWith("Bearer ")) {
      const token = authHdr.slice(7).trim();
      if (timingSafeStrEqual(token, issuerSecret)) {
        return { ok: true, subject: "horizon-worker" };
      }
    }

    // 2. Horizon paired-device session auth (matches cloud/browser-preview-auth.js)
    const cookieTok = parseCookie(req.headers.cookie, SESSION_COOKIE);
    const hdrTok = req.headers["x-horizon-device-session"] ? String(req.headers["x-horizon-device-session"]).trim() : "";
    const sessionTok = cookieTok || hdrTok;
    if (sessionTok && /^[0-9a-f]{64}$/i.test(sessionTok)) {
      // Require CSRF action header when using browser cookie
      if (cookieTok && req.headers["x-horizon-action"] !== "ticket") {
        return { ok: false, reason: "missing_csrf_action_header" };
      }
      const hash = sha256Hex(sessionTok.toLowerCase());
      const devId = pairedDevicesByHash.get(hash);
      if (devId) return { ok: true, subject: devId };
    }

    return { ok: false, reason: "unauthorized_issuer" };
  }

  function corsHeaders(req) {
    const reqOrigin = req.headers.origin || "";
    const allow = reqOrigin && reqOrigin === allowedOrigin ? reqOrigin : allowedOrigin;
    return {
      "Access-Control-Allow-Origin": allow,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Range, Authorization, Content-Type, X-Horizon-Action, X-Horizon-Device-Session",
      "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges, Content-Type",
      Vary: "Origin",
    };
  }

  function sendJson(req, res, status, payload) {
    if (res.headersSent) return;
    res.writeHead(status, {
      ...corsHeaders(req),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(payload));
  }

  /**
   * Fetches watch page with manual redirect validation (prevents SSRF / open redirect abuse).
   */
  async function fetchWatchHtmlSafely(watchUrl, hostPattern) {
    let current = new URL(watchUrl);
    for (let hop = 0; hop <= 2; hop++) {
      if (current.protocol !== "https:" || !hostPattern.test(current.hostname)) {
        throw Object.assign(new Error("disallowed_watch_host"), { httpStatus: 502 });
      }
      const res = await fetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html",
        },
        signal: AbortSignal.timeout(12_000),
      });
      if ([301, 302, 307, 308].includes(res.status)) {
        const loc = res.headers.get("location");
        if (!loc) throw Object.assign(new Error("empty_redirect"), { httpStatus: 502 });
        current = new URL(loc, current);
        continue;
      }
      if (!res.ok) throw Object.assign(new Error("akwam_watch_http_" + res.status), { httpStatus: 502 });
      return res.text();
    }
    throw Object.assign(new Error("too_many_redirects"), { httpStatus: 502 });
  }

  async function resolveEpisode(id, { forceRefresh = false, bypassCooldown = false } = {}) {
    const entry = allowlist[id];
    if (!knownAsset(id)) throw Object.assign(new Error("episode_not_allowlisted"), { httpStatus: 403 });

    const now = Date.now();
    const cached = descriptorCache.get(id);
    const notNearExpiry = cached && (!cached.expiresAtMs || now + 60_000 < cached.expiresAtMs);

    if (cached && notNearExpiry) {
      if (!forceRefresh && now < cached.cacheUntilMs) return cached;
      if (forceRefresh && !bypassCooldown && now - cached.resolvedAtMs < refreshCooldownMs) {
        stats.cooldownReuses += 1;
        return cached;
      }
    }

    if (inFlightResolves.has(id)) {
      stats.dedupedResolveHits += 1;
      return inFlightResolves.get(id);
    }

    const promise = (async () => {
      let source;
      if (entry) {
        const html = await fetchWatchHtmlSafely(entry.watchUrl, entry.watchHostPattern);
        source = html.match(/<source\b[^>]*\bsrc\s*=\s*["'](https:\/\/[^"']+\.mp4)["']/i)?.[1];
        if (!source) throw Object.assign(new Error("no_mp4_source_found"), { httpStatus: 502 });
      } else source = await catalog.resolve(id, { force: forceRefresh });
      const parsed = safeUrl(source, entry?.mediaHostPattern || MEDIA_HOST);

      let expiresAtMs = null;
      for (const seg of parsed.pathname.split("/")) {
        if (/^\d{10}$/.test(seg) && Number(seg) > 1_700_000_000) {
          expiresAtMs = Number(seg) * 1000;
          break;
        }
      }

      const resolvedAtMs = Date.now();
      stats.resolveCount += 1;
      const record = {
        url: parsed.toString(),
        host: parsed.hostname,
        expiresAtMs,
        resolvedAtMs,
        cacheUntilMs: resolvedAtMs + cacheTtlMs,
      };
      if (descriptorCache.size >= 256 && !descriptorCache.has(id)) {
        descriptorCache.delete(descriptorCache.keys().next().value);
      }
      descriptorCache.set(id, record);
      return record;
    })();

    inFlightResolves.set(id, promise);
    try {
      return await promise;
    } finally {
      inFlightResolves.delete(id);
    }
  }

  function streamUpstream({ clientReq, clientRes, id, targetUrl, range, allowRetry }) {
    let parsedTarget;
    try {
      parsedTarget = enableTestFaults && id === "test-unreachable"
        ? new URL(targetUrl) : safeUrl(targetUrl, allowlist[id]?.mediaHostPattern || MEDIA_HOST);
    } catch {
      return sendJson(clientReq, clientRes, 502, { ok: false, error: "invalid_upstream_url" });
    }

    const upHeaders = { "User-Agent": "Mozilla/5.0" };
    if (range) upHeaders.Range = range;

    stats.activeStreams += 1;
    let streamDone = false;
    let clientAborted = false;
    const finishStream = () => {
      if (!streamDone) {
        streamDone = true;
        stats.activeStreams = Math.max(0, stats.activeStreams - 1);
      }
    };

    const upstreamReq = https.request(
      parsedTarget,
      {
        method: clientReq.method === "HEAD" ? "HEAD" : "GET",
        headers: upHeaders,
        agent: strictTlsAgent,
        lookup: publicLookup,
        timeout: 12_000,
      },
      async (upstreamRes) => {
        if (upstreamRes.socket && upstreamRes.socket.authorized) {
          stats.tlsAuthorizedResponses += 1;
        }
        const status = upstreamRes.statusCode || 502;

        // Issue B: Transparent single retry on expired Downet URL (403/404/410/500)
        if (allowRetry && !clientAborted && EXPIRED_UPSTREAM_STATUSES.has(status) && knownAsset(id)) {
          upstreamRes.resume();
          finishStream();
          descriptorCache.delete(id);
          stats.expiredAutoRetries += 1;
          try {
            const fresh = await resolveEpisode(id, { forceRefresh: true, bypassCooldown: true });
            if (clientAborted || clientRes.writableEnded) return;
            return streamUpstream({
              clientReq,
              clientRes,
              id,
              targetUrl: fresh.url,
              range,
              allowRetry: false,
            });
          } catch (err) {
            return sendJson(clientReq, clientRes, err.httpStatus || 502, {
              ok: false,
              error: "expired_recovery_failed",
            });
          }
        }

        if (![200, 206, 416].includes(status)) {
          upstreamRes.resume();
          finishStream();
          return sendJson(clientReq, clientRes, 502, { ok: false, error: "upstream_status_" + status });
        }

        if (status === 206) stats.http206Responses += 1;

        const outHeaders = {
          ...corsHeaders(clientReq),
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
          "Content-Type": "video/mp4",
        };
        for (const h of ["content-range", "content-length", "accept-ranges"]) {
          if (upstreamRes.headers[h]) outHeaders[h] = upstreamRes.headers[h];
        }

        clientRes.writeHead(status, outHeaders);
        if (clientReq.method === "HEAD") {
          upstreamRes.resume();
          finishStream();
          return clientRes.end();
        }

        upstreamRes.on("data", (chunk) => {
          recordEgress(chunk.length);
          if (dailyBytesStreamed > dailyEgressCapBytes) {
            upstreamReq.destroy();
            clientRes.destroy();
          }
        });
        upstreamRes.on("end", finishStream);
        upstreamRes.on("close", finishStream);
        upstreamRes.pipe(clientRes);
      }
    );

    const onClientClose = () => {
      if (!clientRes.writableEnded && !streamDone) {
        clientAborted = true;
        stats.upstreamAborts += 1;
        upstreamReq.destroy();
        finishStream();
      }
    };
    clientReq.once("close", onClientClose);
    clientRes.once("close", onClientClose);

    upstreamReq.on("timeout", () => {
      upstreamReq.destroy(Object.assign(new Error("upstream_timeout"), { code: "ETIMEDOUT" }));
    });

    upstreamReq.on("error", (err) => {
      finishStream();
      if (clientAborted) return;
      if (!clientRes.headersSent) {
        sendJson(clientReq, clientRes, 502, { ok: false, error: "upstream_unreachable", code: err.code || "ERR_UPSTREAM" });
      } else {
        clientRes.destroy();
      }
    });

    upstreamReq.end();
  }

  const server = http.createServer(async (req, res) => {
    sampleMemory();
    const reqUrl = new URL(req.url, "http://127.0.0.1");

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(req));
      return res.end();
    }

    if (reqUrl.pathname === "/health" && req.method === "GET") {
      const m = process.memoryUsage();
      return sendJson(req, res, 200, {
        ok: true,
        uptimeSec: Math.floor((Date.now() - stats.startedAt) / 1000),
        activeStreams: stats.activeStreams,
        heapMB: Number((m.heapUsed / 1048576).toFixed(2)),
        rssMB: Number((m.rss / 1048576).toFixed(2)),
      });
    }

    const clientIp = getClientIp(req);
    if (!checkBucket(rateBuckets, clientIp, rateLimitMax)) {
      stats.rateLimitedCount += 1;
      return sendJson(req, res, 429, { ok: false, error: "rate_limited" });
    }

    if (reqUrl.pathname === "/catalog" && req.method === "GET") {
      const auth = authenticateTicketIssuer(req);
      if (!auth.ok || auth.subject !== "horizon-worker") {
        return sendJson(req, res, 401, { ok: false, error: "unauthorized_issuer" });
      }
      const id = reqUrl.searchParams.get("id") || "";
      if (!akwamProxyPermitted || !knownAsset(id)) return sendJson(req, res, 404, { available: false });
      try {
        if (!allowlist[id]) await resolveEpisode(id);
        return sendJson(req, res, 200, { available: true, episodeId: id });
      } catch {
        return sendJson(req, res, 404, { available: false });
      }
    }

    // Mint short-lived, asset-scoped playback tickets.
    if (reqUrl.pathname === "/ticket" && req.method === "POST") {
      if (!checkBucket(ticketRateBuckets, clientIp, ticketRateLimitMax)) {
        stats.rateLimitedCount += 1;
        return sendJson(req, res, 429, { ok: false, error: "ticket_rate_limited" });
      }

      const auth = authenticateTicketIssuer(req);
      if (!auth.ok) {
        stats.ticketsRejected += 1;
        return sendJson(req, res, 401, { ok: false, error: auth.reason });
      }

      const id = reqUrl.searchParams.get("id") || "";
      if (!knownAsset(id)) {
        return sendJson(req, res, 403, { ok: false, error: "episode_not_allowlisted" });
      }

      const nowSec = Math.floor(Date.now() / 1000);
      let refreshes = 0;
      let maxExp = nowSec + ticketMaxSessionSec;

      // Optional bounded refresh from a prior ticket (prevents indefinite refresh chains)
      const prevTicket = reqUrl.searchParams.get("prev");
      if (prevTicket) {
        const prevCheck = verifyPlaybackTicket(prevTicket, ticketSigningSecret, id, nowSec);
        // Allow refresh even if exp recently lapsed, as long as signature & maxExp are valid
        if (!prevCheck.ok && prevCheck.reason !== "ticket_expired") {
          return sendJson(req, res, 401, { ok: false, error: prevCheck.reason });
        }
        let prevPayload;
        try {
          prevPayload = JSON.parse(b64urlDecode(prevTicket.split(".")[0]));
        } catch {
          return sendJson(req, res, 401, { ok: false, error: "invalid_prev_ticket" });
        }
        if (prevPayload.sub !== auth.subject || prevPayload.ep !== id) {
          return sendJson(req, res, 403, { ok: false, error: "ticket_subject_or_episode_mismatch" });
        }
        refreshes = Number(prevPayload.refreshes || 0) + 1;
        maxExp = Number(prevPayload.maxExp || maxExp);
        if (refreshes > maxTicketRefreshes || nowSec >= maxExp) {
          return sendJson(req, res, 403, { ok: false, error: "ticket_refresh_limit_exceeded" });
        }
      }

      if (!allowlist[id]) {
        try { await resolveEpisode(id); }
        catch { return sendJson(req, res, 404, { ok: false, error: "asset_unavailable" }); }
      }
      const exp = Math.min(nowSec + ticketTtlSec, maxExp);
      const payload = {
        ep: id,
        sub: auth.subject,
        jti: crypto.randomBytes(8).toString("hex"),
        iat: nowSec,
        exp,
        maxExp,
        refreshes,
      };
      const ticket = signPlaybackTicket(payload, ticketSigningSecret);
      stats.ticketsIssued += 1;

      return sendJson(req, res, 200, {
        ok: true,
        episodeId: id,
        ticket,
        expiresAt: new Date(exp * 1000).toISOString(),
        ttlSeconds: Math.max(0, exp - nowSec),
        refreshesRemaining: Math.max(0, maxTicketRefreshes - refreshes),
        relayPath: `/relay?id=${encodeURIComponent(id)}&ticket=${encodeURIComponent(ticket)}`,
      });
    }

    if (reqUrl.pathname === "/stats" && req.method === "GET") {
      const auth = authenticateTicketIssuer(req);
      if (!auth.ok) return sendJson(req, res, 401, { ok: false, error: "unauthorized" });
      sampleMemory();
      return sendJson(req, res, 200, {
        ...stats,
        peakRssMB: Number((stats.peakRssBytes / 1048576).toFixed(2)),
        peakHeapUsedMB: Number((stats.peakHeapUsedBytes / 1048576).toFixed(2)),
      });
    }

    if (reqUrl.pathname === "/relay" && (req.method === "GET" || req.method === "HEAD")) {
      if (!akwamProxyPermitted) {
        return sendJson(req, res, 403, { ok: false, error: "proxy_delivery_not_permitted" });
      }
      if (dailyBytesStreamed >= dailyEgressCapBytes) {
        return sendJson(req, res, 503, { ok: false, error: "daily_egress_cap_reached" });
      }
      if (stats.activeStreams >= maxConcurrentStreams) {
        return sendJson(req, res, 503, { ok: false, error: "max_concurrent_streams_reached" });
      }

      const id = reqUrl.searchParams.get("id") || "";
      const ticket = reqUrl.searchParams.get("ticket") || "";
      const tCheck = verifyPlaybackTicket(ticket, ticketSigningSecret, id);
      if (!tCheck.ok) {
        stats.ticketsRejected += 1;
        const code = tCheck.reason === "ticket_episode_mismatch" ? 403 : 401;
        return sendJson(req, res, code, { ok: false, error: tCheck.reason });
      }

      const range = req.headers.range ? req.headers.range.trim() : null;
      if (range && !/^bytes=\d*-\d*$/.test(range)) {
        return sendJson(req, res, 416, { ok: false, error: "invalid_range" });
      }

      if (enableTestFaults && id === "test-unreachable") {
        return streamUpstream({
          clientReq: req,
          clientRes: res,
          id,
          targetUrl: "https://127.0.0.1:1/unreachable.mp4",
          range,
          allowRetry: false,
        });
      }

      if (!knownAsset(id)) {
        return sendJson(req, res, 403, { ok: false, error: "episode_not_allowlisted" });
      }

      const forceRefresh = reqUrl.searchParams.get("refresh") === "1";
      try {
        const rec = await resolveEpisode(id, { forceRefresh });
        return streamUpstream({
          clientReq: req,
          clientRes: res,
          id,
          targetUrl: rec.url,
          range,
          allowRetry: true,
        });
      } catch (err) {
        return sendJson(req, res, err.httpStatus || 502, { ok: false, error: "media_unavailable" });
      }
    }

    return sendJson(req, res, 404, { ok: false, error: "not_found" });
  });

  server.on("close", () => {
    clearInterval(memTimer);
    clearInterval(cleanupTimer);
    strictTlsAgent.destroy();
  });

  function _seedExpiredCacheForTest(id) {
    descriptorCache.set(id, {
      url: "https://s303d1.downet.net/download/1600000000/0000000000000/Fakhr.El.Delta.S01E01.WEB-DL.AKWAM.mp4",
      host: "s303d1.downet.net",
      expiresAtMs: Date.now() + 3600_000,
      resolvedAtMs: Date.now() - 60_000,
      cacheUntilMs: Date.now() + 60_000,
    });
  }

  return { server, stats, _seedExpiredCacheForTest };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8790);
  const host = process.env.BIND_HOST || "127.0.0.1";
  const { server } = createHardenedRelay();
  server.listen(port, host, () => {
    console.log(JSON.stringify({ event: "relay_started", host, port }));
  });
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => server.close(() => process.exit(0)));
  }
}
