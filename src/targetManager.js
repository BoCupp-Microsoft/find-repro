"use strict";

const { listTargets } = require("./cdpTargets");

/**
 * Tracks the WebView2 page targets exposed by the host and decides which one
 * subsequent steps act on.
 *
 *  - On init it identifies the main Teams window by finding the page whose DOM
 *    contains the app bar (left rail), and remembers it as the active page.
 *  - `switchTarget` re-scans all targets, including windows opened after boot
 *    (e.g. the Meet Now pre-join window), polling for a key selector before
 *    making the match the new active page.
 */
class TargetManager {
  /**
   * @param {import("playwright-core").Browser} browser
   * @param {object} config
   * @param {object} [deps]
   * @param {import("./consoleMonitor").ConsoleMonitor} [deps.consoleMonitor]
   * @param {import("./logger").Logger} [deps.logger]
   */
  constructor(browser, config, { consoleMonitor, logger, reconnect } = {}) {
    this.browser = browser;
    this.config = config;
    this.consoleMonitor = consoleMonitor;
    this.logger = logger;
    this.reconnect = reconnect;
    this.activePage = null;
  }

  log(msg) {
    if (this.logger) this.logger.log(msg);
  }

  /**
   * Ensures Playwright has surfaced every top-level window. Playwright's
   * connectOverCDP misses windows created after connect, so when the raw CDP
   * target list has more page targets than Playwright knows about, we reconnect.
   *
   * We compare by COUNT, not URL: Teams often opens a new window on the same URL
   * as an existing one (e.g. the meeting pre-join window shares the Calendar's
   * `?skipauthstrap=1` URL), so URL-based dedupe would miss it.
   */
  async _ensureAllWindowsAttached() {
    if (!this.reconnect) return;
    let raw;
    try {
      raw = await listTargets(this.config.cdpPort);
    } catch {
      return;
    }
    const rawPages = raw.filter(
      t => t.type === "page" && !String(t.url).startsWith("about:")
    );
    const known = this.allPages();
    if (rawPages.length > known.length) {
      this.log(
        `reconnecting to surface ${rawPages.length - known.length} new window(s) ` +
          `(raw=${rawPages.length}, known=${known.length})`
      );
      await this.reconnect();
    }
  }

  /** Re-binds activePage to the equivalent page on the current connection. */
  rebindActivePage() {
    if (!this.activePage) return;
    const url = safeUrl(this.activePage);
    const match = this.allPages().find(p => safeUrl(p) === url);
    if (match) this.activePage = match;
  }

  /** Enumerates every page across all browser contexts, attaching listeners. */
  allPages() {
    const pages = [];
    for (const context of this.browser.contexts()) {
      for (const page of context.pages()) {
        if (page.isClosed && page.isClosed()) continue;
        pages.push(page);
      }
    }
    if (this.consoleMonitor) {
      for (const page of pages) this.consoleMonitor.attach(page);
    }
    return pages;
  }

  /**
   * Finds the main Teams window (app bar present) and sets it active.
   * @returns {Promise<import("playwright-core").Page>}
   */
  async init() {
    // Capture console for any window opened later, too.
    for (const context of this.browser.contexts()) {
      context.on("page", page => {
        if (this.consoleMonitor) this.consoleMonitor.attach(page);
      });
    }

    const page = await this._pollForMainWindow();
    this.activePage = page;
    const info = await pageInfo(page);
    this.log(`main window ready: title=${JSON.stringify(info.title)} url=${info.url}`);
    return page;
  }

  async _pollForMainWindow() {
    const { mainWindowTimeoutMs, targetPollIntervalMs, appBarSelectors } = this.config;
    const deadline = Date.now() + mainWindowTimeoutMs;
    const started = Date.now();
    let lastReport = 0;

    for (;;) {
      const pages = this.allPages();
      // The main window is the page whose app bar rail is populated and
      // interactive (not merely the empty wrapper behind the loading curtain).
      for (const page of pages) {
        const sel = await firstSelectorPresent(page, appBarSelectors);
        if (!sel) continue;
        if (await this._isReady(page)) return page;
      }

      // Periodically report readiness so the wait is never a silent black box.
      if (Date.now() - lastReport >= this.config.mainWindowReportIntervalMs) {
        lastReport = Date.now();
        const elapsed = Math.round((Date.now() - started) / 1000);
        const seen = await Promise.all(
          pages.map(async p => {
            const i = await pageInfo(p);
            const items = await this._appBarItemCount(p);
            return `[${i.title ?? "?"}] appBarItems=${items}`;
          })
        );
        this.log(
          `waiting for interactive app bar (${elapsed}s, ${pages.length} target(s)): ` +
            `${seen.join(" | ") || "none yet"}`
        );
      }

      if (Date.now() > deadline) {
        const seen = await Promise.all(
          pages.map(async p => {
            const i = await pageInfo(p);
            return `[${i.title}] ${i.url}`;
          })
        );
        throw new Error(
          `Timed out after ${mainWindowTimeoutMs}ms waiting for an interactive Teams ` +
            `app bar (rail populated). Targets seen: ${seen.join(" | ") || "none"}`
        );
      }
      await sleep(targetPollIntervalMs);
    }
  }

  /**
   * True when the page's app bar rail is populated and interactive. While the
   * loading curtain is up the rail contains only the overflow button; once ready
   * it holds the real app buttons (Activity, Chat, Calendar, ...), each a
   * focusable element with an aria-label. We require at least `minAppBarItems`.
   */
  async _isReady(page) {
    return (await this._railButtonCount(page)) >= this.config.minAppBarItems;
  }

  /** Count of visible, real rail app buttons (excludes the overflow/flyout). */
  async _appBarItemCount(page) {
    return this._railButtonCount(page);
  }

  async _railButtonCount(page) {
    try {
      return await page.evaluate(() => {
        const visible = el => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          const s = getComputedStyle(el);
          return s.visibility !== "hidden" && s.display !== "none";
        };
        const nav =
          document.querySelector('[data-tid="app-layout-area--nav"]') ||
          document.querySelector('[data-tid="app-bar-wrapper"]');
        if (!visible(nav)) return 0;
        const candidates = nav.querySelectorAll(
          'button, a, [role="button"], [role="tab"]'
        );
        return Array.from(candidates).filter(el => {
          if (!visible(el)) return false;
          const label = el.getAttribute("aria-label") || "";
          const tid = el.getAttribute("data-tid") || "";
          if (!label) return false;
          // Exclude the overflow / "View more apps" / flyout controls.
          if (/overflow|flyout/i.test(tid)) return false;
          if (/more apps/i.test(label)) return false;
          return true;
        }).length;
      });
    } catch {
      return 0;
    }
  }

  /**
   * Switches the active page to a target matching the given criteria, polling
   * (including newly created windows) until one matches or it times out.
   * @param {object} opts
   * @param {string} [opts.selector] CSS selector that must be present.
   * @param {string} [opts.titlePrefix] Page title must start with this.
   * @param {string} [opts.urlIncludes] Page URL must contain this substring.
   * @param {number} [opts.timeoutMs]
   * @returns {Promise<{title:string|undefined, url:string|undefined}>}
   */
  async switchTarget(opts = {}) {
    const timeoutMs = opts.timeoutMs ?? this.config.switchTargetTimeoutMs;
    const intervalMs = this.config.targetPollIntervalMs;
    const deadline = Date.now() + timeoutMs;

    if (!opts.selector && !opts.titlePrefix && !opts.urlIncludes) {
      throw new Error("switchTarget requires at least one of: selector, titlePrefix, urlIncludes");
    }

    for (;;) {
      // Surface any windows opened after connect (e.g. Meet Now pre-join).
      await this._ensureAllWindowsAttached();
      const pages = this.allPages();
      for (const page of pages) {
        if (await this._matches(page, opts)) {
          this.activePage = page;
          const info = await pageInfo(page);
          this.log(`switched active target to title=${JSON.stringify(info.title)} url=${info.url}`);
          return info;
        }
      }
      if (Date.now() > deadline) {
        throw new Error(
          `switchTarget timed out after ${timeoutMs}ms ` +
            `(selector=${opts.selector || ""} titlePrefix=${opts.titlePrefix || ""} urlIncludes=${opts.urlIncludes || ""})`
        );
      }
      await sleep(intervalMs);
    }
  }

  async _matches(page, opts) {
    if (opts.urlIncludes) {
      const url = safeUrl(page);
      if (!url || !url.includes(opts.urlIncludes)) return false;
    }
    if (opts.titlePrefix) {
      const info = await pageInfo(page);
      if (!info.title || !info.title.startsWith(opts.titlePrefix)) return false;
    }
    if (opts.selector) {
      if (!(await hasSelector(page, opts.selector))) return false;
    }
    return true;
  }

  /**
   * Resolves the page a step should act on: an explicit target override or the
   * current active page.
   * @param {object} [target] { selector?, titlePrefix?, urlIncludes? }
   */
  async resolvePage(target) {
    if (!target) {
      if (!this.activePage) throw new Error("no active page");
      return this.activePage;
    }
    let pages = this.allPages();
    for (const page of pages) {
      if (await this._matches(page, target)) return page;
    }
    // The target window may have opened after connect; refresh and retry.
    await this._ensureAllWindowsAttached();
    pages = this.allPages();
    for (const page of pages) {
      if (await this._matches(page, target)) return page;
    }
    throw new Error(`no target page matched ${JSON.stringify(target)}`);
  }
}

async function firstSelectorPresent(page, selectors) {
  for (const sel of selectors) {
    if (await hasSelector(page, sel)) return sel;
  }
  return null;
}

async function hasSelector(page, selector) {
  try {
    const el = await page.$(selector);
    return Boolean(el);
  } catch {
    return false;
  }
}

async function pageInfo(page) {
  return { title: await safeTitle(page), url: safeUrl(page) };
}

function safeUrl(page) {
  try {
    return page.url();
  } catch {
    return undefined;
  }
}

async function safeTitle(page) {
  try {
    return await Promise.race([
      page.title(),
      new Promise(resolve => setTimeout(() => resolve(undefined), 2000)),
    ]);
  } catch {
    return undefined;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { TargetManager };
