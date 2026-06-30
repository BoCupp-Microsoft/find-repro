"use strict";

const { CdpTarget } = require("./cdpTarget");

/**
 * Selects which CDP target subsequent steps act on. Everything is raw CDP — the
 * main window, the non-rendering core, later windows, and iframes are all page/
 * iframe targets tracked by CdpSession.
 *
 *  - On init it finds the main window: the page target whose DOM exposes an
 *    interactive app-bar rail (≥ minAppBarItems real buttons).
 *  - `switchTarget` re-scans page targets (incl. windows opened after boot) for a
 *    selector/title/url match; `resolvePage` searches the main window + iframes.
 */
class TargetManager {
  /**
   * @param {import("./cdpSession").CdpSession} cdp
   * @param {object} config
   * @param {object} [deps]
   * @param {import("./logger").Logger} [deps.logger]
   */
  constructor(cdp, config, { logger } = {}) {
    this.cdp = cdp;
    this.config = config;
    this.logger = logger;
    this.active = null; // CdpTarget
  }

  log(msg) {
    if (this.logger) this.logger.log(msg);
  }

  /** All page targets wrapped as CdpTargets. */
  pageTargets() {
    return this.cdp.pages().map(p => new CdpTarget(this.cdp, p.sessionId, p.info));
  }

  /** Page + iframe targets (for selector resolution across frames). */
  allTargets() {
    return [...this.cdp.pages(), ...this.cdp.iframes()].map(
      t => new CdpTarget(this.cdp, t.sessionId, t.info)
    );
  }

  /** Finds the main Teams window (interactive app bar) and sets it active. */
  async init() {
    const page = await this._pollForMainWindow();
    this.active = page;
    this.log(`main window ready: ${this._name(page)} url=${await page.url()}`);
    return page;
  }

  async _pollForMainWindow() {
    const { mainWindowTimeoutMs, targetPollIntervalMs } = this.config;
    const deadline = Date.now() + mainWindowTimeoutMs;
    const started = Date.now();
    let lastReport = 0;

    for (;;) {
      const pages = this.pageTargets();
      for (const page of pages) {
        if ((await this._railCount(page)) >= this.config.minAppBarItems) return page;
      }
      if (Date.now() - lastReport >= this.config.mainWindowReportIntervalMs) {
        lastReport = Date.now();
        const elapsed = Math.round((Date.now() - started) / 1000);
        const seen = await Promise.all(pages.map(async p => `${this._name(p)} rail=${await this._railCount(p)}`));
        this.log(`waiting for interactive app bar (${elapsed}s, ${pages.length} page(s)): ${seen.join(" | ") || "none"}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out after ${mainWindowTimeoutMs}ms waiting for an interactive Teams app bar.`);
      }
      await sleep(targetPollIntervalMs);
    }
  }

  /** Count of visible, real rail app buttons (excludes overflow/flyout). */
  async _railCount(page) {
    try {
      return await page.evaluate(`(() => {
        const vis = el => { if (!el) return false; const r = el.getBoundingClientRect();
          if (r.width<=0||r.height<=0) return false; const s=getComputedStyle(el);
          return s.visibility!=='hidden'&&s.display!=='none'; };
        const nav = document.querySelector('[data-tid="app-layout-area--nav"]') || document.querySelector('[data-tid="app-bar-wrapper"]');
        if (!vis(nav)) return 0;
        return Array.from(nav.querySelectorAll('button,a,[role="button"],[role="tab"]')).filter(el => {
          if (!vis(el)) return false; const label=el.getAttribute('aria-label')||''; const tid=el.getAttribute('data-tid')||'';
          if (!label) return false; if (/overflow|flyout/i.test(tid)) return false; if (/more apps/i.test(label)) return false; return true;
        }).length; })()`);
    } catch {
      return 0;
    }
  }

  /**
   * Switches the active page to a target matching the criteria, polling page
   * targets (incl. newly created windows) until one matches or it times out.
   * @param {object} opts { selector?, titlePrefix?, urlIncludes?, timeoutMs? }
   */
  async switchTarget(opts = {}) {
    const timeoutMs = opts.timeoutMs ?? this.config.switchTargetTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    if (!opts.selector && !opts.titlePrefix && !opts.urlIncludes) {
      throw new Error("switchTarget requires at least one of: selector, titlePrefix, urlIncludes");
    }
    for (;;) {
      for (const page of this.pageTargets()) {
        if (await this._matches(page, opts)) {
          this.active = page;
          const info = { title: await page.title(), url: await page.url() };
          this.log(`switched active target to ${this._name(page)} url=${info.url}`);
          return info;
        }
      }
      if (Date.now() > deadline) {
        throw new Error(`switchTarget timed out after ${timeoutMs}ms`);
      }
      await sleep(this.config.targetPollIntervalMs);
    }
  }

  async _matches(page, opts) {
    if (opts.urlIncludes && !String(await page.url()).includes(opts.urlIncludes)) return false;
    if (opts.titlePrefix) {
      const t = await page.title();
      if (!t || !t.startsWith(opts.titlePrefix)) return false;
    }
    if (opts.selector && !(await page.exists({ selector: opts.selector }))) return false;
    return true;
  }

  /** Resolves the target a step acts on: explicit override or active page. */
  async resolvePage(target) {
    if (!target) {
      if (!this.active) throw new Error("no active page");
      return this.active;
    }
    for (const page of this.pageTargets()) {
      if (await this._matches(page, target)) return page;
    }
    throw new Error(`no target page matched ${JSON.stringify(target)}`);
  }

  _name(page) {
    const t = this.cdp.targets.get(page.sessionId);
    return t ? t.name : page.sessionId;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { TargetManager };
