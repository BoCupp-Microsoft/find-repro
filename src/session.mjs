import fs from "node:fs";
import path from "node:path";

import { createSettings } from "./settings.mjs";
import { Logger } from "./logger.mjs";
import { DevServerChecker } from "./dev-server.mjs";
import { HostConfigManager } from "./host-config.mjs";
import { ShellLauncher } from "./shell-launcher.mjs";
import { CdpSession } from "./cdp-session.mjs";
import { ConsoleMonitor } from "./console-monitor.mjs";
import { TargetManager } from "./target-manager.mjs";
import { StepRunner } from "./step-runner.mjs";

/**
 * Long-lived, stateful driver session shared by both the interactive (serve)
 * and batch (run) entry points. `start()` performs the full boot sequence and
 * leaves the host running; `runStep`/`runSteps` execute operations and return
 * observations; `shutdown()` tears everything down. Pure CDP — no Playwright.
 */
class Session {
  /**
   * @param {object} [overrides] Settings overrides (see settings.mjs).
   * @param {object} [deps]
   * @param {Logger} [deps.logger]
   */
  constructor(overrides = {}, { logger } = {}) {
    this.settings = createSettings(overrides);
    this.logger = logger || new Logger("find-repro");

    this.consoleMonitor = new ConsoleMonitor(this.logger.child("console"));
    this.devServer = new DevServerChecker(this.settings, this.logger.child("devserver"));
    this.hostConfig = new HostConfigManager(this.settings, {
      logger: this.logger.child("config"),
    });
    this.shellLauncher = new ShellLauncher(this.settings, {
      logger: this.logger.child("shell"),
      consoleMonitor: this.consoleMonitor,
    });
    this.cdp = new CdpSession(this.settings, {
      consoleMonitor: this.consoleMonitor,
      logger: this.logger.child("cdp"),
    });

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
    fs.mkdirSync(this.settings.sessionDir, { recursive: true });

    this.logger.log("checking dev server...");
    await this.devServer.check();

    this.logger.log("ensuring host configuration...");
    const summary = await this.hostConfig.ensure();
    this.logger.log(summary);

    this.logger.log("launching host...");
    const launchInfo = await this.shellLauncher.launch();
    if (launchInfo.reused) {
      this.logger.log("attached to an existing host instance");
    }

    this.logger.log("connecting over CDP...");
    await this.cdp.connect();

    this.targetManager = new TargetManager(this.cdp, this.settings, {
      logger: this.logger.child("targets"),
    });

    this.logger.log("waiting for main Teams window...");
    const page = await this.targetManager.init();
    this.mainWindow = await pageInfo(page);

    this.stepRunner = new StepRunner({
      targetManager: this.targetManager,
      cdp: this.cdp,
      config: this.settings,
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

    const page = this.targetManager.active;
    const observation = {
      op: step.op,
      status: res.status,
      ...(res.error ? { error: res.error } : {}),
      ...(res.data !== undefined ? { data: res.data } : {}),
      page: await pageInfo(page),
      console: entries,
    };

    if (options.wantDom) observation.dom = await safeContent(page);
    if (options.wantScreenshot) observation.screenshot = await this._artifactScreenshot(page);
    if (options.expectations) observation.expectations = this.consoleMonitor.evaluate(options.expectations);
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
    const dir = path.join(this.settings.sessionDir, "screenshots");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `obs-${Date.now()}.png`);
    try {
      fs.writeFileSync(file, await page.screenshot());
      return file;
    } catch (err) {
      this.logger.warn(`screenshot failed: ${err.message}`);
      return null;
    }
  }

  /** Tears down the CDP session and the host process. */
  async shutdown() {
    this._shuttingDown = true;
    try {
      this.cdp.close();
    } catch {
      /* ignore */
    }
    this.shellLauncher.stop();
    this.logger.log("session shut down");
  }
}

async function pageInfo(page) {
  if (!page) return { title: undefined, url: undefined };
  return { title: await page.title(), url: await page.url() };
}

async function safeContent(page) {
  if (!page) return null;
  try {
    return await page.content();
  } catch (err) {
    return `<!-- domSnapshot failed: ${err.message} -->`;
  }
}

export { Session };
