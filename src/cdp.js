"use strict";

const net = require("node:net");
const { chromium } = require("playwright-core");
const { listTargets, isContentWindow, sleep } = require("./cdpTargets");

/**
 * Waits for the host's CDP port to open, waits for the real Teams content
 * window to exist, then attaches Playwright over CDP.
 *
 * The content-window wait is essential: Playwright's connectOverCDP only
 * surfaces page targets that exist at connect time. Teams creates its content
 * window (the one hosting the app bar) a while after launch, so we must wait for
 * it via the raw CDP HTTP endpoint before connecting — otherwise Playwright
 * never sees it.
 */
class CdpConnector {
  /**
   * @param {object} config
   * @param {import("./logger").Logger} [logger]
   */
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }

  log(msg) {
    if (this.logger) this.logger.log(msg);
  }

  /** Origin substring used to recognise content-window targets. */
  get startOrigin() {
    try {
      return new URL(this.config.startUrl).host;
    } catch {
      return "local.teams.office.com";
    }
  }

  /** Resolves on the first successful TCP connection to the debugging port. */
  waitForPort() {
    const { cdpPort, cdpConnectTimeoutMs } = this.config;
    const deadline = Date.now() + cdpConnectTimeoutMs;

    return new Promise((resolve, reject) => {
      const attempt = () => {
        const socket = net.connect(cdpPort, "127.0.0.1");
        socket.once("connect", () => {
          socket.end();
          resolve();
        });
        socket.once("error", () => {
          socket.destroy();
          if (Date.now() > deadline) {
            reject(
              new Error(`CDP port ${cdpPort} did not open within ${cdpConnectTimeoutMs}ms.`)
            );
            return;
          }
          setTimeout(attempt, 100);
        });
      };
      attempt();
    });
  }

  /**
   * Polls the raw CDP target list until the Teams content window exists.
   * @returns {Promise<object>} the matching target info
   */
  async waitForContentWindow() {
    const { cdpPort, mainWindowTimeoutMs, targetPollIntervalMs } = this.config;
    const origin = this.startOrigin;
    const deadline = Date.now() + mainWindowTimeoutMs;
    let lastReport = 0;

    for (;;) {
      const targets = await listTargets(cdpPort);
      const content = targets.find(t => isContentWindow(t, origin));
      if (content) {
        this.log(`content window present: title=${JSON.stringify(content.title)} url=${content.url}`);
        return content;
      }

      if (Date.now() - lastReport >= this.config.mainWindowReportIntervalMs) {
        lastReport = Date.now();
        const pages = targets.filter(t => t.type === "page");
        const summary = pages.map(p => `[${p.title}] ${shortUrl(p.url)}`).join(" | ");
        this.log(
          `waiting for content window (${pages.length} page target(s)): ${summary || "none yet"}`
        );
      }

      if (Date.now() > deadline) {
        throw new Error(
          `Timed out after ${mainWindowTimeoutMs}ms waiting for the Teams content window on ${origin}.`
        );
      }
      await sleep(targetPollIntervalMs);
    }
  }

  /**
   * Waits for the port and the content window, then connects Playwright.
   * @returns {Promise<import("playwright-core").Browser>}
   */
  async connect() {
    await this.waitForPort();
    this.log(`CDP port ${this.config.cdpPort} open`);
    await this.waitForContentWindow();
    const browser = await chromium.connectOverCDP(
      `http://localhost:${this.config.cdpPort}`,
      { timeout: 0 }
    );
    this.log("connected over CDP");
    return browser;
  }

  /**
   * Connects immediately without waiting (used to refresh the connection so
   * Playwright surfaces windows created after the initial connect).
   * @returns {Promise<import("playwright-core").Browser>}
   */
  async connectFresh() {
    return chromium.connectOverCDP(`http://localhost:${this.config.cdpPort}`, {
      timeout: 0,
    });
  }
}

function shortUrl(u) {
  return String(u || "").slice(0, 90);
}

module.exports = { CdpConnector };
