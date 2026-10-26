import { acquire, connect } from "@cloudflare/playwright";
import { allowedRequestUrl, HEIGHT, WIDTH } from "./browser-preview-core.js";
import { capturePageFrame, executePageCommand } from "./browser-preview-page.js";

const MAX_NAVIGATION_MS = 15_000;

function elapsed(start) { return Math.max(0, Math.round(performance.now() - start)); }

export class CloudflareBrowserEngine {
  constructor(binding, hosts) {
    this.binding = binding;
    this.hosts = hosts;
  }

  async create(url) {
    const { sessionId } = await acquire(this.binding, {
      keep_alive: 120_000,
      recording: false,
      guardrails: { allowedDomains: this.hosts },
    });
    try {
      const result = await this.withBrowser(sessionId, async browser => {
        const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT },
          serviceWorkers: "block", acceptDownloads: false });
        const page = await context.newPage();
        await this.restrictRequests(page);
        const start = performance.now();
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: MAX_NAVIGATION_MS });
        if (!response || response.status() >= 400) throw new Error("navigation_failed");
        const actionMs = elapsed(start);
        return this.capturePage(page, actionMs);
      });
      return { browserSessionId: sessionId, ...result };
    } catch (error) {
      await this.close(sessionId).catch(() => {});
      throw error;
    }
  }

  async withBrowser(sessionId, task) {
    const browser = await connect(this.binding, sessionId);
    try { return await task(browser); }
    finally {
      // Cloudflare connect(): close disconnects, retaining the remote session.
      // A disconnect failure must not turn a captured successful action into
      // an ambiguous input result.
      try { await browser.close(); } catch (_error) { /* session TTL still applies */ }
    }
  }

  async page(browser) {
    const pages = browser.contexts().flatMap(context => context.pages())
      .filter(page => page.url() !== "about:blank");
    if (pages.length !== 1) throw new Error("page_unavailable");
    const page = pages[0];
    // Playwright route handlers belong to the current client connection.
    // Reattach after reconnect while the Browser Run hostname guardrail stays
    // latched to the underlying browser session.
    await page.unroute("**/*");
    await this.restrictRequests(page);
    return page;
  }

  async restrictRequests(page) {
    const hosts = this.hosts;
    await page.route("**/*", route => {
      if (allowedRequestUrl(route.request().url(), hosts)) return route.continue();
      return route.abort();
    });
  }

  async capturePage(page, actionMs = 0) {
    return capturePageFrame(page, actionMs);
  }

  async perform(sessionId, command) {
    return this.withBrowser(sessionId, async browser => {
      const page = await this.page(browser);
      const start = performance.now();
      await executePageCommand(page, command, MAX_NAVIGATION_MS);
      return this.capturePage(page, elapsed(start));
    });
  }

  async capture(sessionId) {
    return this.withBrowser(sessionId, async browser => this.capturePage(await this.page(browser)));
  }

  async close(sessionId) {
    await this.binding.closeSession(sessionId);
  }

  async exists(sessionId) {
    return Boolean(await this.binding.getSession(sessionId));
  }
}
