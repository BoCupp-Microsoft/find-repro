/**
 * A page-like abstraction over a single CDP target session (page or iframe). All
 * DOM work is done via Runtime.evaluate — no Playwright. StepRunner searches a
 * window's page target plus iframe targets, so each CdpTarget only needs to act
 * on its own document.
 *
 * @typedef {import("./cdp-session.mjs").CdpSession} CdpSession
 */
class CdpTarget {
  /**
   * @param {CdpSession} cdp
   * @param {string} sessionId
   * @param {object} info TargetInfo
   */
  constructor(cdp, sessionId, info) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.info = info;
  }

  /** Runs an expression/function string in the target, returns the JSON value. */
  async evaluate(expression) {
    const { result, exceptionDetails } = await this.cdp.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      this.sessionId
    );
    if (exceptionDetails) {
      const ex = exceptionDetails.exception || {};
      throw new Error(ex.description || ex.value || exceptionDetails.text || "evaluate failed");
    }
    return result ? result.value : undefined;
  }

  /** True if any element matches a CSS selector / testId / text spec. */
  async exists(spec) {
    return this.evaluate(`(${findEl})(${JSON.stringify(spec)}) ? true : false`);
  }

  /** Waits until the spec matches in the requested state, or false on timeout.
   *  state: "attached" (in DOM) | "visible" (non-zero box) | "actionable" (a
   *  human could click it: visible, in-viewport, un-occluded, enabled). */
  async waitFor(spec, { state = "visible", timeout = 30000 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const ok =
        state === "actionable"
          ? (await this.actionablePoint(spec)).ok
          : await this.evaluate(
              `(() => { const el = (${findEl})(${JSON.stringify(spec)}); if (!el) return false; ` +
                `${state === "visible" ? "const r=el.getBoundingClientRect(); return r.width>0 && r.height>0;" : "return true;"} })()`
            );
      if (ok) return true;
      if (Date.now() > deadline) return false;
      await sleep(150);
    }
  }

  /**
   * Real mouse click via CDP Input. First waits for the element to be actionable
   * (visible, in-viewport, un-occluded, enabled) AND stable (same hit point on
   * two consecutive checks), then clicks the hit-tested point. Unlike a synthetic
   * el.click(), this carries user activation and produces trusted events, which
   * Teams' meeting/window-opening controls require. Waiting for actionability —
   * rather than mere DOM presence — is what makes a human able to click here too:
   * it absorbs fade-ins, animations, loading curtains, and late React hydration.
   * For an OOPIF the events are dispatched on the iframe's own session.
   */
  async click(spec, { timeout = 30000 } = {}) {
    const p = await this._stableActionablePoint(spec, timeout);
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y }, this.sessionId);
    const btn = { x: p.x, y: p.y, button: "left", clickCount: 1 };
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...btn }, this.sessionId);
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...btn }, this.sessionId);
  }

  async hover(spec, { timeout = 30000 } = {}) {
    const p = await this._stableActionablePoint(spec, timeout);
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y }, this.sessionId);
  }

  fill(spec, value) {
    return this._act(
      spec,
      `el.focus(); el.value=${JSON.stringify(value)}; ` +
        `el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));`
    );
  }

  selectOption(spec, value) {
    return this._act(
      spec,
      `el.value=${JSON.stringify(value)}; el.dispatchEvent(new Event('change',{bubbles:true}));`
    );
  }

  /** Focuses a match and inserts text via CDP so keypress handlers fire. */
  async type(spec, value) {
    await this._act(spec, "el.focus();");
    await this.cdp.send("Input.insertText", { text: String(value) }, this.sessionId);
  }

  async press(key, spec) {
    if (spec) await this._act(spec, "el.focus();");
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key }, this.sessionId);
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key }, this.sessionId);
  }

  /**
   * Single actionability probe (browser-side). Scrolls the match into view and
   * returns { ok, x, y } when a human could click it, else { ok:false, reason }.
   * Checks: found, connected, not display:none/visibility:hidden/opacity:0, not
   * disabled/aria-disabled, non-zero box, centre within the viewport, and the
   * centre point hit-tests to the element (or its ancestor/descendant) — i.e.
   * nothing (loading curtain, modal, overlay) is covering it.
   */
  async actionablePoint(spec) {
    return this.evaluate(
      `(() => {
        const findEl = ${findEl};
        const el = findEl(${JSON.stringify(spec)});
        if (!el) return { ok:false, reason:'not-found' };
        if (!el.isConnected) return { ok:false, reason:'detached' };
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0)
          return { ok:false, reason:'hidden' };
        if (el.disabled || el.getAttribute('aria-disabled') === 'true')
          return { ok:false, reason:'disabled' };
        el.scrollIntoView({ block:'center', inline:'center' });
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return { ok:false, reason:'zero-size' };
        const x = r.left + r.width/2, y = r.top + r.height/2;
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return { ok:false, reason:'offscreen' };
        const top = document.elementFromPoint(x, y);
        if (!top) return { ok:false, reason:'no-hit' };
        if (top !== el && !el.contains(top) && !top.contains(el))
          return { ok:false, reason:'occluded', by:(top.tagName||'') + (top.id?('#'+top.id):'') + (top.className && typeof top.className==='string'?('.'+top.className.trim().split(/\\s+/)[0]):'') };
        return { ok:true, x, y };
      })()`
    );
  }

  /** Polls actionablePoint until the element is actionable on two consecutive
   *  reads with a stable hit point (not mid-animation), then returns that point. */
  async _stableActionablePoint(spec, timeout) {
    const deadline = Date.now() + timeout;
    let last = null;
    let lastReason = "unknown";
    for (;;) {
      const p = await this.actionablePoint(spec);
      if (p && p.ok) {
        if (last && Math.abs(last.x - p.x) <= 2 && Math.abs(last.y - p.y) <= 2) return p;
        last = p;
      } else {
        last = null;
        lastReason = (p && p.reason) ? p.reason + (p.by ? " by " + p.by : "") : "unknown";
      }
      if (Date.now() > deadline) {
        throw new Error(`element not actionable within ${timeout}ms: ${JSON.stringify(spec)} (${lastReason})`);
      }
      await sleep(100);
    }
  }

  async _act(spec, body) {
    const ok = await this.evaluate(
      `(() => { const el = (${findEl})(${JSON.stringify(spec)}); if (!el) return false; ${body} return true; })()`
    );
    if (!ok) throw new Error(`element not found: ${JSON.stringify(spec)}`);
  }

  async title() {
    return safe(() => this.evaluate("document.title"), this.info.title);
  }

  async url() {
    return safe(() => this.evaluate("location.href"), this.info.url);
  }

  async content() {
    return safe(() => this.evaluate("document.documentElement.outerHTML"), "");
  }

  async navigate(url) {
    await this.cdp.send("Page.enable", undefined, this.sessionId).catch(() => {});
    await this.cdp.send("Page.navigate", { url }, this.sessionId);
  }

  async screenshot() {
    await this.cdp.send("Page.enable", undefined, this.sessionId).catch(() => {});
    const { data } = await this.cdp.send("Page.captureScreenshot", { format: "png" }, this.sessionId);
    return Buffer.from(data, "base64");
  }
}

/** Browser-side resolver: CSS selector | testId | exact/substr text -> Element. */
const findEl = `(spec) => {
  if (spec.selector) return document.querySelector(spec.selector);
  if (spec.testId) return document.querySelector('[data-testid="'+spec.testId+'"],[data-tid="'+spec.testId+'"]');
  if (spec.text) {
    const t = spec.text; const ex = spec.exact;
    const matches = el => { const s=(el.textContent||'').trim(); return ex ? s===t : s.includes(t); };
    const all = Array.from(document.querySelectorAll('button,a,[role="button"],[role="tab"],[role="menuitem"],span,div,li'));
    const cands = all.filter(matches);
    if (!cands.length) return null;
    // Prefer the innermost matches: drop any candidate that contains another
    // candidate, so we target the actual control instead of a large wrapper that
    // merely contains the text (wrappers are often zero-size / non-interactive).
    const innermost = cands.filter(el => !cands.some(o => o !== el && el.contains(o)));
    const pool = innermost.length ? innermost : cands;
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return pool.find(visible) || pool[0];
  }
  return null;
}`;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function safe(fn, fallback) {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export { CdpTarget };
