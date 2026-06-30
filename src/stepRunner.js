"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * Executes a single step against the active (or an explicitly targeted) page.
 *
 * Supported operations (step.op):
 *   click | fill | type | press | hover | selectOption | goto | evaluate |
 *   waitForSelector | waitForText | sleep | screenshot | domSnapshot | switchTarget
 *
 * A step may include `target` ({ selector?, titlePrefix?, urlIncludes? }) to run
 * against a page other than the active one (without changing the active page).
 * Use the `switchTarget` op to permanently change the active page.
 */
class StepRunner {
  /**
   * @param {object} deps
   * @param {import("./targetManager").TargetManager} deps.targetManager
   * @param {import("./consoleMonitor").ConsoleMonitor} deps.consoleMonitor
   * @param {object} deps.config
   * @param {import("./logger").Logger} [deps.logger]
   */
  constructor({ targetManager, consoleMonitor, config, logger }) {
    this.targetManager = targetManager;
    this.consoleMonitor = consoleMonitor;
    this.config = config;
    this.logger = logger;
  }

  /**
   * @param {object} step
   * @returns {Promise<{status:string, error?:string, data?:any}>}
   */
  async run(step) {
    if (!step || typeof step.op !== "string") {
      return { status: "error", error: "step must have a string 'op'" };
    }
    const timeout = step.timeoutMs ?? this.config.stepTimeoutMs;
    try {
      const data = await this._dispatch(step, timeout);
      return { status: "ok", ...(data !== undefined ? { data } : {}) };
    } catch (err) {
      if (this.logger) this.logger.log(`step '${step.op}' failed: ${err.message}`);
      return { status: "error", error: err.message };
    }
  }

  async _dispatch(step, timeout) {
    switch (step.op) {
      case "switchTarget": {
        return this.targetManager.switchTarget({
          selector: step.selector,
          titlePrefix: step.titlePrefix,
          urlIncludes: step.urlIncludes,
          timeoutMs: step.timeoutMs,
        });
      }
      case "sleep": {
        await sleep(step.ms ?? 0);
        return undefined;
      }
    }

    const page = await this.targetManager.resolvePage(step.target);

    switch (step.op) {
      case "click":
        await (await this._locator(page, step, timeout)).click({ timeout });
        return undefined;
      case "hover":
        await (await this._locator(page, step, timeout)).hover({ timeout });
        return undefined;
      case "fill":
        await (await this._locator(page, step, timeout)).fill(String(step.value ?? ""), { timeout });
        return undefined;
      case "type":
        await (await this._locator(page, step, timeout)).pressSequentially(String(step.value ?? ""), { timeout });
        return undefined;
      case "press":
        if (hasLocatorTarget(step)) {
          await (await this._locator(page, step, timeout)).press(step.key, { timeout });
        } else {
          await page.keyboard.press(step.key);
        }
        return undefined;
      case "selectOption": {
        const result = await (await this._locator(page, step, timeout)).selectOption(step.value, { timeout });
        return { selected: result };
      }
      case "goto": {
        const resp = await page.goto(step.url, { timeout, waitUntil: step.waitUntil || "load" });
        return { url: page.url(), status: resp ? resp.status() : null };
      }
      case "evaluate": {
        const result = await page.evaluate(step.expression);
        return { result };
      }
      case "waitForSelector": {
        const { frame } = await this._waitAcrossFrames(
          page,
          root => root.locator(step.selector).first(),
          step.state || "visible",
          timeout
        );
        return { frameUrl: frame.url() };
      }
      case "waitForText": {
        await this._waitAcrossFrames(
          page,
          root =>
            root
              .getByText(step.text, step.exact != null ? { exact: step.exact } : undefined)
              .first(),
          "visible",
          timeout
        );
        return undefined;
      }
      case "screenshot": {
        const file = await this._screenshot(page, step);
        return { path: file };
      }
      case "domSnapshot": {
        const html = await this._domSnapshot(page, step, timeout);
        return { html };
      }
      default:
        throw new Error(`unknown op '${step.op}'`);
    }
  }

  /** Builds a locator from a step spec against a page or frame root. */
  _makeLocator(root, step) {
    if (step.selector) return root.locator(step.selector).first();
    if (step.testId) return root.getByTestId(step.testId).first();
    if (step.text) {
      return root
        .getByText(step.text, step.exact != null ? { exact: step.exact } : undefined)
        .first();
    }
    throw new Error(`step '${step.op}' requires one of: selector, testId, text`);
  }

  /**
   * Resolves a locator for the step, searching the main frame AND child frames.
   * Teams renders apps (Calendar, Meet, ...) inside iframes, so main-frame-only
   * lookups miss those controls. Returns a locator bound to the first frame that
   * contains a match. If `step.frameUrlIncludes` is set, only frames whose URL
   * contains that substring are considered.
   */
  async _locator(page, step, timeout) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const frames = this._candidateFrames(page, step);
      for (const frame of frames) {
        try {
          const loc = this._makeLocator(frame, step);
          if ((await loc.count()) > 0) return loc;
        } catch {
          /* frame detached/cross-origin; skip */
        }
      }
      if (Date.now() > deadline) {
        // Fall back to a main-frame locator so the caller's action surfaces a
        // standard Playwright timeout error with its call log.
        return this._makeLocator(page, step);
      }
      await sleep(150);
    }
  }

  /** Waits for a locator (built by `build`) to reach `state` in any frame. */
  async _waitAcrossFrames(page, build, state, timeout) {
    const deadline = Date.now() + timeout;
    let lastErr;
    for (;;) {
      for (const frame of page.frames()) {
        try {
          const loc = build(frame);
          if ((await loc.count()) > 0) {
            await loc.waitFor({ state, timeout: Math.max(500, deadline - Date.now()) });
            return { frame, locator: loc };
          }
        } catch (e) {
          lastErr = e;
        }
      }
      if (Date.now() > deadline) {
        throw lastErr || new Error("waitAcrossFrames: not found within timeout");
      }
      await sleep(150);
    }
  }

  /** Frames to search, optionally filtered by step.frameUrlIncludes. */
  _candidateFrames(page, step) {
    const frames = page.frames();
    if (step.frameUrlIncludes) {
      return frames.filter(f => (f.url() || "").includes(step.frameUrlIncludes));
    }
    return frames;
  }

  async _screenshot(page, step) {
    const dir = path.join(this.config.sessionDir, "screenshots");
    fs.mkdirSync(dir, { recursive: true });
    const name = step.path
      ? step.path
      : path.join(dir, `shot-${Date.now()}.png`);
    await page.screenshot({ path: name, fullPage: Boolean(step.fullPage) });
    return name;
  }

  async _domSnapshot(page, step, timeout) {
    if (step.selector) {
      const el = await page.waitForSelector(step.selector, { timeout });
      return el.evaluate(node => node.outerHTML);
    }
    return page.content();
  }
}

function hasLocatorTarget(step) {
  return Boolean(step.selector || step.testId || step.text);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { StepRunner };
