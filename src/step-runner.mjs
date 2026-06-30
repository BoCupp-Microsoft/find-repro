import fs from "node:fs";
import path from "node:path";

/**
 * Executes a single step against the active (or an explicitly targeted) window.
 * Pure CDP — every op runs via a CdpTarget (Runtime.evaluate / Input / Page).
 * Selector ops search the window's page target AND iframe targets, because Teams
 * renders apps (Calendar, Meet, ...) inside iframes that are separate CDP targets.
 *
 * Ops: click | fill | type | press | hover | selectOption | goto | evaluate |
 *      waitForSelector | waitForText | sleep | screenshot | domSnapshot | switchTarget
 */
class StepRunner {
  /**
   * @param {object} deps
   * @param {import("./target-manager.mjs").TargetManager} deps.targetManager
   * @param {import("./cdp-session.mjs").CdpSession} deps.cdp
   * @param {object} deps.config
   * @param {import("./logger.mjs").Logger} [deps.logger]
   */
  constructor({ targetManager, cdp, config, logger }) {
    this.targetManager = targetManager;
    this.cdp = cdp;
    this.config = config;
    this.logger = logger;
  }

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
      case "switchTarget":
        return this.targetManager.switchTarget({
          selector: step.selector,
          titlePrefix: step.titlePrefix,
          urlIncludes: step.urlIncludes,
          timeoutMs: step.timeoutMs,
        });
      case "sleep":
        await sleep(step.ms ?? 0);
        return undefined;
    }

    const page = await this.targetManager.resolvePage(step.target);
    const spec = locatorSpec(step);

    switch (step.op) {
      case "click":
        await this._actAcrossFrames(page, spec, t => t.click(spec, { timeout }), timeout, "actionable");
        return undefined;
      case "hover":
        await this._actAcrossFrames(page, spec, t => t.hover(spec, { timeout }), timeout, "actionable");
        return undefined;
      case "fill":
        await this._actAcrossFrames(page, spec, t => t.fill(spec, String(step.value ?? "")), timeout);
        return undefined;
      case "type":
        await this._actAcrossFrames(page, spec, t => t.type(spec, String(step.value ?? "")), timeout);
        return undefined;
      case "press":
        if (spec) await this._actAcrossFrames(page, spec, t => t.press(step.key, spec), timeout);
        else await page.press(step.key);
        return undefined;
      case "selectOption":
        await this._actAcrossFrames(page, spec, t => t.selectOption(spec, step.value), timeout);
        return { selected: step.value };
      case "goto":
        await page.navigate(step.url);
        return { url: await page.url() };
      case "evaluate":
        return { result: await page.evaluate(step.expression) };
      case "waitForSelector": {
        const t = await this._waitAcrossFrames(page, { selector: step.selector }, waitState(step), timeout);
        return { frameUrl: await t.url() };
      }
      case "waitForText":
        await this._waitAcrossFrames(page, { text: step.text, exact: step.exact }, waitState(step), timeout);
        return undefined;
      case "screenshot":
        return { path: await this._screenshot(page, step) };
      case "domSnapshot":
        return { html: await page.content() };
      default:
        throw new Error(`unknown op '${step.op}'`);
    }
  }

  /** Frames to search: the page target + all iframe targets. */
  _frames() {
    return this.targetManager.allTargets();
  }

  /** Waits for spec to reach `state` in the page or any iframe, returns that
   *  target. state: "attached" | "visible" (default) | "actionable". */
  async _waitAcrossFrames(page, spec, state, timeout) {
    const deadline = Date.now() + timeout;
    for (;;) {
      for (const t of this._frames()) {
        try {
          if (await t.waitFor(spec, { state, timeout: 200 })) return t;
        } catch {
          /* frame gone */
        }
      }
      if (Date.now() > deadline) throw new Error(`not found within ${timeout}ms (state=${state}): ${JSON.stringify(spec)}`);
      await sleep(150);
    }
  }

  /** Finds the first frame where spec reaches `state`, then runs the action. */
  async _actAcrossFrames(page, spec, action, timeout, state = "visible") {
    const t = await this._waitAcrossFrames(page, spec, state, timeout);
    await action(t);
  }

  async _screenshot(page, step) {
    const dir = path.join(this.config.sessionDir, "screenshots");
    fs.mkdirSync(dir, { recursive: true });
    const file = step.path || path.join(dir, `shot-${Date.now()}.png`);
    fs.writeFileSync(file, await page.screenshot());
    return file;
  }
}

function locatorSpec(step) {
  if (step.selector) return { selector: step.selector };
  if (step.testId) return { testId: step.testId };
  if (step.text) return { text: step.text, exact: step.exact };
  return null;
}

/** Wait state for waitForSelector/waitForText: "attached" | "visible" (default)
 *  | "actionable" (gated on a human being able to click it). */
function waitState(step) {
  return step.state === "attached" || step.state === "actionable" ? step.state : "visible";
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export { StepRunner };
