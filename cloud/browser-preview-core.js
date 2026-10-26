// Isolated browser preview policy. Arbitrary destinations are deliberately out
// of scope until a network-level public-address policy has been verified.
export const WIDTH = 1280;
export const HEIGHT = 720;
export const IDLE_MS = 90_000;
export const MAX_ACTIVE_MS = 5 * 60_000;
export const MAX_FRAME_BYTES = 1_500_000;
export const MAX_ACTIONS = 120;
export const MAX_FRAMES = 160;
export const STATE_KEY = "cloud_browser_preview_v1";
const EXTERNAL_HOSTS = ["example.com", "www.wikipedia.org", "www.google.com"];

export function previewOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    if (!/^[a-z0-9.-]+$/.test(url.hostname)) return null;
    return url.origin;
  } catch (_error) { return null; }
}

export function allowedHosts(origin) {
  const home = previewOrigin(origin);
  return home ? [new URL(home).hostname, ...EXTERNAL_HOSTS] : [];
}

export function fixtureUrl(origin) {
  const home = previewOrigin(origin);
  return home ? `${home}/browser-cloud-fixture.html` : null;
}

export function allowedRequestUrl(raw, hosts) {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.port && !url.username && !url.password
      && hosts.includes(url.hostname);
  } catch (_error) { return false; }
}

export function permittedUrl(raw, origin) {
  if (typeof raw !== "string" || raw.length > 1000 || /[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.port || url.username || url.password) return null;
    if (url.hash.length > 256) return null;
    const home = previewOrigin(origin);
    if (!home) return null;
    if (url.origin === home) {
      return ["/browser-cloud-fixture.html", "/browser-cloud-fixture-next.html"].includes(url.pathname)
        ? url.href : null;
    }
    return EXTERNAL_HOSTS.includes(url.hostname) ? url.href : null;
  } catch (_error) { return null; }
}

export function validCommand(body, origin) {
  if (!body || typeof body !== "object" || Array.isArray(body)
    || !Number.isSafeInteger(body.seq) || body.seq < 1) return null;
  const keys = Object.keys(body).sort().join(",");
  if (keys === "seq,url") {
    const url = permittedUrl(body.url, origin);
    return url ? { seq: body.seq, type: "navigate", url } : null;
  }
  if (keys === "seq,type,x,y" && body.type === "click"
    && Number.isFinite(body.x) && Number.isFinite(body.y)
    && body.x >= 0 && body.x < WIDTH && body.y >= 0 && body.y < HEIGHT) {
    return { seq: body.seq, type: "click", x: body.x, y: body.y };
  }
  if (keys === "deltaY,seq,type" && body.type === "scroll"
    && Number.isFinite(body.deltaY) && Math.abs(body.deltaY) <= 720 && body.deltaY !== 0) {
    return { seq: body.seq, type: "scroll", deltaY: body.deltaY };
  }
  if (keys === "seq,text,type" && body.type === "text"
    && typeof body.text === "string" && body.text.length > 0 && body.text.length <= 160
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.text)) {
    return { seq: body.seq, type: "text", text: body.text };
  }
  if (keys === "key,seq,type" && body.type === "key"
    && ["Enter", "Backspace", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(body.key)) {
    return { seq: body.seq, type: "key", key: body.key };
  }
  if (keys === "seq,type" && ["back", "forward", "refresh"].includes(body.type)) {
    return { seq: body.seq, type: body.type };
  }
  return null;
}

export function mapPoint(clientX, clientY, rect) {
  if (!rect || !Number.isFinite(clientX) || !Number.isFinite(clientY)
    || !Number.isFinite(rect.left) || !Number.isFinite(rect.top)
    || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)
    || rect.width <= 0 || rect.height <= 0) return null;
  // A 1280x720 image may be letterboxed by object-fit: contain.
  const scale = Math.min(rect.width / WIDTH, rect.height / HEIGHT);
  const width = WIDTH * scale;
  const height = HEIGHT * scale;
  const left = rect.left + (rect.width - width) / 2;
  const top = rect.top + (rect.height - height) / 2;
  if (clientX < left || clientX >= left + width || clientY < top || clientY >= top + height) return null;
  return { x: Math.min(WIDTH - 1, Math.floor((clientX - left) / scale)),
    y: Math.min(HEIGHT - 1, Math.floor((clientY - top) / scale)) };
}

export class BrowserSessionManager {
  constructor(kv, adapter, origin, now = () => Date.now()) {
    this.kv = kv;
    this.adapter = adapter;
    this.origin = previewOrigin(origin);
    this.now = now;
    this.frameBytes = null;
    this.serial = Promise.resolve();
  }

  enqueue(task) {
    const next = this.serial.then(task, task);
    this.serial = next.catch(() => {});
    return next;
  }

  read() { return this.kv.get(STATE_KEY) || null; }
  save(state) { this.kv.put(STATE_KEY, state); }
  clear() { this.kv.delete(STATE_KEY); this.frameBytes = null; }
  deadline() {
    const state = this.read();
    return state ? Math.min(state.startedAt + MAX_ACTIVE_MS, state.lastAt + IDLE_MS) : null;
  }
  async expire() {
    const state = this.read();
    if (state && this.now() >= this.deadline()) await this.close();
  }
  async close() {
    const state = this.read();
    if (!state) return;
    try { await this.adapter.close(state.browserSessionId); }
    catch (_error) { /* Browser Run's inactivity limit remains the final cleanup bound. */ }
    this.clear();
  }
  view(state) {
    return state ? { active: true, seq: state.seq, url: state.url,
      expiresAt: state.startedAt + MAX_ACTIVE_MS, idleAt: state.lastAt + IDLE_MS,
      lastError: state.lastError, actions: state.actions, frames: state.frames } : { active: false };
  }
  async status(deviceId) {
    await this.expire();
    const state = this.read();
    if (state && state.ownerDeviceId !== deviceId) return { error: "session_owned_elsewhere" };
    return this.view(state);
  }
  async start(deviceId) {
    await this.expire();
    const current = this.read();
    if (current) {
      if (current.ownerDeviceId !== deviceId) return { error: "session_busy" };
      if (!this.frameBytes) return { ...await this.frame(deviceId), reused: true };
      return { ...this.view(current), reused: true, frame: this.frameBytes };
    }
    if (!this.origin) return { error: "preview_origin_unconfigured" };
    let result;
    try { result = await this.adapter.create(fixtureUrl(this.origin), allowedHosts(this.origin)); }
    catch (_error) { return { error: "browser_unavailable" }; }
    if (!result || !result.browserSessionId || !result.frame || result.frame.byteLength > MAX_FRAME_BYTES) {
      if (result?.browserSessionId) await this.adapter.close(result.browserSessionId).catch(() => {});
      return { error: "browser_unavailable" };
    }
    const at = this.now();
    const state = { browserSessionId: result.browserSessionId, ownerDeviceId: deviceId,
      startedAt: at, lastAt: at, seq: 0, url: fixtureUrl(this.origin),
      lastError: null, actions: 0, frames: 1, windowAt: at, windowActions: 0,
      windowFrameAt: at, windowFrames: 0 };
    this.save(state);
    this.frameBytes = result.frame;
    return { ...this.view(state), frame: result.frame, timings: result.timings };
  }
  async perform(deviceId, command) {
    await this.expire();
    const state = this.read();
    if (!state || state.ownerDeviceId !== deviceId) return { error: "not_authorized" };
    if (!command || command.seq !== state.seq + 1) return { error: "stale_sequence", expectedSeq: state.seq + 1 };
    if (state.actions >= MAX_ACTIONS) return { error: "action_budget_exhausted" };
    if (state.frames >= MAX_FRAMES) return { error: "frame_budget_exhausted" };
    const at = this.now();
    if (at - state.windowAt >= 60_000) { state.windowAt = at; state.windowActions = 0; }
    if (state.windowActions >= 30) return { error: "rate_limited" };
    // Consume the sequence before browser input. A lost response must never
    // cause an ambiguous click or form submission to be replayed.
    state.seq++;
    state.actions++;
    state.windowActions++;
    state.lastAt = at;
    state.lastError = "processing";
    this.save(state);
    try {
      const result = await this.adapter.perform(state.browserSessionId, command);
      if (!result?.frame || result.frame.byteLength > MAX_FRAME_BYTES
        || !permittedUrl(result.url, this.origin)) {
        await this.close();
        return { error: "unsafe_browser_result" };
      }
      state.url = result.url;
      state.frames++;
      state.lastAt = this.now();
      state.lastError = null;
      this.frameBytes = result.frame;
      this.save(state);
      return { ...this.view(state), frame: result.frame, timings: result.timings };
    } catch (error) {
      if (await this.sessionGone(state.browserSessionId)) return { error: "session_expired" };
      const safeCode = ["text_target_unavailable", "navigation_failed", "page_unavailable"]
        .includes(error?.message) ? error.message : "action_unconfirmed";
      state.lastAt = this.now();
      state.lastError = safeCode;
      this.save(state);
      return { error: safeCode, seq: state.seq };
    }
  }
  async frame(deviceId) {
    await this.expire();
    const state = this.read();
    if (!state || state.ownerDeviceId !== deviceId) return { error: "not_authorized" };
    if (state.frames >= MAX_FRAMES) return { error: "frame_budget_exhausted" };
    const at = this.now();
    if (at - state.windowFrameAt >= 60_000) { state.windowFrameAt = at; state.windowFrames = 0; }
    if (state.windowFrames >= 20) return { error: "rate_limited" };
    state.windowFrames++;
    this.save(state);
    try {
      const result = await this.adapter.capture(state.browserSessionId);
      if (!result?.frame || result.frame.byteLength > MAX_FRAME_BYTES
        || !permittedUrl(result.url, this.origin)) {
        await this.close();
        return { error: "unsafe_browser_result" };
      }
      state.url = result.url;
      state.frames++;
      state.lastAt = this.now();
      this.frameBytes = result.frame;
      this.save(state);
      return { ...this.view(state), frame: result.frame, timings: result.timings };
    } catch (_error) {
      if (await this.sessionGone(state.browserSessionId)) return { error: "session_expired" };
      return { error: "frame_unavailable" };
    }
  }
  async end(deviceId) {
    const state = this.read();
    if (!state || state.ownerDeviceId !== deviceId) return { error: "not_authorized" };
    await this.close();
    return { active: false };
  }
  async revoke(deviceId) {
    const state = this.read();
    if (state?.ownerDeviceId === deviceId) await this.close();
  }
  async sessionGone(id) {
    if (typeof this.adapter.exists !== "function") return false;
    try {
      if (await this.adapter.exists(id)) return false;
      this.clear();
      return true;
    } catch (_error) { return false; }
  }
}
