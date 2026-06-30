"use strict";

/**
 * Aggregates console output from every WebView2 page plus the host process
 * stdout/stderr into a single ordered buffer. Supports:
 *   - "new since last read" cursors (for the per-step observation payload);
 *   - evaluating named expectations (regex/substring) against captured text.
 *
 * Each entry: { seq, ts, source, level, text, page? }
 *   source: "console" | "pageerror" | "host"
 *   level:  console message type, "error", or host stream name ("stdout"/"stderr")
 *   page:   { title?, url } for page-sourced entries
 */
class ConsoleMonitor {
  /** @param {import("./logger").Logger} [logger] */
  constructor(logger) {
    this.logger = logger;
    this.entries = [];
    this._seq = 0;
    this._attached = new WeakSet();
    this._dedupe = new Map();
  }

  _push(entry) {
    // De-duplicate identical messages delivered within a short window. Kept as a
    // safety net even though page (Playwright) and worker (CDP) capture paths are
    // now disjoint and shouldn't double-deliver.
    if (entry.source === "console" || entry.source === "pageerror") {
      const key = `${entry.source}|${entry.level}|${entry.page && entry.page.url}|${entry.text}`;
      const now = Date.now();
      const prev = this._dedupe.get(key);
      if (prev && now - prev < 1000) {
        return prev; // treat as the same logical entry
      }
      this._dedupe.set(key, now);
    }
    entry.seq = this._seq++;
    entry.ts = new Date().toISOString();
    this.entries.push(entry);
    return entry;
  }

  /** Attaches console/error listeners to a Playwright page (idempotent). */
  attach(page) {
    if (!page || this._attached.has(page)) return;
    this._attached.add(page);

    const pageInfo = () => ({ url: safeUrl(page) });

    page.on("console", msg => {
      this._push({
        source: "console",
        level: msg.type(),
        text: msg.text(),
        page: pageInfo(),
      });
    });

    page.on("pageerror", err => {
      this._push({
        source: "pageerror",
        level: "error",
        text: err && err.stack ? err.stack : String(err),
        page: pageInfo(),
      });
    });

    page.on("close", () => this._attached.delete(page));
  }

  /** Ingests a single line from the host process stdio. */
  ingestHostLine(stream, line) {
    if (line == null || line === "") return;
    this._push({ source: "host", level: stream, text: line });
  }

  /**
   * Ingests a console message from a non-page CDP target (a Web Worker, etc.),
   * captured via the browser CDP session. Pages are captured via attach().
   * @param {string} target Target name (e.g. precompiled-web-worker-*.js)
   * @param {string} level console type / log level
   * @param {string} text message text
   */
  ingestTarget(target, level, text) {
    if (text == null || text === "") return;
    this._push({ source: "worker", level: level || "log", text, page: { url: target } });
  }

  /**
   * Returns entries captured after `cursor`, plus the next cursor to use.
   * @param {number} [cursor] Last seq already seen (-1 for everything).
   */
  newSince(cursor = -1) {
    const items = this.entries.filter(e => e.seq > cursor);
    const next = this.entries.length ? this.entries[this.entries.length - 1].seq : cursor;
    return { entries: items, cursor: next };
  }

  /** Current cursor (seq of the last entry, or -1 if empty). */
  currentCursor() {
    return this.entries.length ? this.entries[this.entries.length - 1].seq : -1;
  }

  /**
   * Evaluates named expectations against captured text.
   * @param {Array<{name:string, pattern:string, flags?:string, since?:number}>} expectations
   * @returns {Array<{name:string, matched:boolean, entry?:object}>}
   */
  evaluate(expectations = []) {
    return expectations.map(exp => {
      let re;
      try {
        re = new RegExp(exp.pattern, exp.flags || "");
      } catch (err) {
        return { name: exp.name, matched: false, error: `bad pattern: ${err.message}` };
      }
      const since = typeof exp.since === "number" ? exp.since : -1;
      const hit = this.entries.find(e => e.seq > since && re.test(e.text));
      return hit
        ? { name: exp.name, matched: true, entry: hit }
        : { name: exp.name, matched: false };
    });
  }
}

function safeUrl(page) {
  try {
    return page.url();
  } catch {
    return undefined;
  }
}

module.exports = { ConsoleMonitor };
