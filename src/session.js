"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { createConfig } = require("./config");
const { Logger } = require("./logger");
const { DevServerChecker } = require("./devServer");
const { ConfigurationManager } = require("./configuration");
const { ShellLauncher } = require("./shellLauncher");
const { CdpConnector } = require("./cdp");
const { ConsoleMonitor } = require("./consoleMonitor");
const { WorkerMonitor } = require("./workerMonitor");
const { TargetManager } = require("./targetManager");
const { StepRunner } = require("./stepRunner");

/**
 * Long-lived, stateful driver session shared by both the interactive (serve)
 * and batch (run) entry points. `start()` performs the full boot sequence and
 * leaves the host running; `runStep`/`runSteps` execute operations and return
 * observations; `shutdown()` tears everything down.
 */
class Session {
  /**
   * @param {object} [overrides] Config overrides (see config.js).
   * @param {object} [deps]
   * @param {Logger} [deps.logger]
   */
  constructor(overrides = {}, { logger } = {}) {
    this.config = createConfig(overrides);
    this.logger = logger || new Logger("find-repro");

    this.consoleMonitor = new ConsoleMonitor(this.logger.child("console"));
    this.devServer = new DevServerChecker(this.config, this.logger.child("devserver"));
    this.configuration = new ConfigurationManager(this.config, {
      logger: this.logger.child("config"),
    });
    this.shellLauncher = new ShellLauncher(this.config, {
      logger: this.logger.child("shell"),
      consoleMonitor: this.consoleMonitor,
    });
    this.cdp = new CdpConnector(this.config, this.logger.child("cdp"));
    this.workerMonitor = new WorkerMonitor(this.config, {
      consoleMonitor: this.consoleMonitor,
      logger: this.logger.child("workers"),
    });

    this.browser = null;
    this.targetManager = null;
    this.stepRunner = null;
    this.mainWindow = null;
    this._shuttingDown = false;
  }

  /**
   * Runs the full boot sequence and leaves the host ready for steps.
   * @returns {Promise<{title:string|undefined, url:string|undefined}>} main window info
   */
  async start() {
    fs.mkdirSync(this.config.sessionDir, { recursive: true });

    this.logger.log("checking dev server...");
    await this.devServer.check();

    this.logger.log("ensuring host configuration...");
    const summary = await this.configuration.ensure();
    this.logger.log(summary);

    this.logger.log("launching host...");
    const launchInfo = await this.shellLauncher.launch();
    if (launchInfo.reused) {
      this.logger.log("attached to an existing host instance");
    }

    this.logger.log("connecting over CDP...");
    this.browser = await this.cdp.connect();
    this.browser.on("disconnected", () => {
      if (!this._shuttingDown) this.logger.warn("browser disconnected unexpectedly");
    });

    // Capture Web Worker console (CDL / notification-toast / telemetry resolvers
    // run in separate worker targets that page.on('console') cannot see).
    this.workerMonitor.start();

    this.targetManager = new TargetManager(this.browser, this.config, {
      consoleMonitor: this.consoleMonitor,
      logger: this.logger.child("targets"),
      reconnect: () => this.reconnect(),
    });

    this.logger.log("waiting for main Teams window...");
    const page = await this.targetManager.init();
    this.mainWindow = await pageInfo(page);

    this.stepRunner = new StepRunner({
      targetManager: this.targetManager,
      consoleMonitor: this.consoleMonitor,
      config: this.config,
      logger: this.logger.child("step"),
    });

    this.logger.log("session ready");
    return this.mainWindow;
  }

  /**
   * Executes a single step and returns its observation.
   * @param {object} step
   * @param {object} [options] { wantDom?, wantScreenshot?, expectations? }
   */
  async runStep(step, options = {}) {
    const before = this.consoleMonitor.currentCursor();
    const res = await this.stepRunner.run(step);
    const { entries } = this.consoleMonitor.newSince(before);

    const page = this.targetManager.activePage;
    const observation = {
      op: step.op,
      status: res.status,
      ...(res.error ? { error: res.error } : {}),
      ...(res.data !== undefined ? { data: res.data } : {}),
      page: await pageInfo(page),
      console: entries,
    };

    if (options.wantDom) observation.dom = await safeContent(page);
    if (options.wantScreenshot) {
      observation.screenshot = await this._artifactScreenshot(page);
    }
    if (options.expectations) {
      observation.expectations = this.consoleMonitor.evaluate(options.expectations);
    }
    return observation;
  }

  /**
   * Executes a list of steps sequentially. By default it stops at the first
   * failing step; pass options.continueOnError to keep going.
   * @param {object[]} steps
   * @param {object} [options]
   */
  async runSteps(steps, options = {}) {
    const results = [];
    for (let i = 0; i < steps.length; i++) {
      const observation = await this.runStep(steps[i], options);
      observation.stepIndex = i;
      results.push(observation);
      if (observation.status === "error" && !options.continueOnError) break;
    }
    return results;
  }

  async _artifactScreenshot(page) {
    if (!page) return null;
    const dir = path.join(this.config.sessionDir, "screenshots");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `obs-${Date.now()}.png`);
    try {
      await page.screenshot({ path: file });
      return file;
    } catch (err) {
      this.logger.warn(`screenshot failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Refreshes the Playwright connection so it surfaces windows created after the
   * initial connect (Playwright's connectOverCDP does not auto-attach to Teams'
   * later top-level WebView2 windows). The previous connection is left open to
   * avoid invalidating in-flight page handles; duplicate console delivery is
   * de-duplicated by the ConsoleMonitor.
   * @returns {Promise<import("playwright-core").Browser>}
   */
  async reconnect() {
    const fresh = await this.cdp.connectFresh();
    this.browser = fresh;
    this.targetManager.browser = fresh;
    for (const ctx of fresh.contexts()) {
      ctx.on("page", page => this.consoleMonitor.attach(page));
      for (const page of ctx.pages()) this.consoleMonitor.attach(page);
    }
    this.targetManager.rebindActivePage();
    return fresh;
  }

  /** Tears down Playwright and the host process. */
  async shutdown() {
    this._shuttingDown = true;
    try {
      this.workerMonitor.stop();
    } catch {
      /* ignore */
    }
    try {
      if (this.browser) await this.browser.close();
    } catch {
      /* ignore */
    }
    this.shellLauncher.stop();
    this.logger.log("session shut down");
  }
}

async function pageInfo(page) {
  if (!page) return { title: undefined, url: undefined };
  let title;
  try {
    title = await Promise.race([
      page.title(),
      new Promise(resolve => setTimeout(() => resolve(undefined), 2000)),
    ]);
  } catch {
    title = undefined;
  }
  let url;
  try {
    url = page.url();
  } catch {
    url = undefined;
  }
  return { title, url };
}

async function safeContent(page) {
  if (!page) return null;
  try {
    return await page.content();
  } catch (err) {
    return `<!-- domSnapshot failed: ${err.message} -->`;
  }
}

module.exports = { Session };
