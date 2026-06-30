/**
 * Aggregates console/error/log output from every attached CDP target (pages,
 * workers, iframes) plus the host process stdout/stderr into a single ordered
 * buffer. Supports:
 *   - "new since last read" cursors (for the per-step observation payload);
 *   - evaluating named expectations (regex/substring) against captured text.
 *
 * Each entry: { seq, ts, source, level, text, page? }
 *   source: "worker" (any CDP target, via ingestTarget) | "host" (process stdio)
 *   level:  console message type / log level, or host stream name ("stdout"/"stderr")
 *   page:   { url } where url is the target's identifier (for "worker" entries)
 */
class ConsoleMonitor {
  /** @param {import("./logger.mjs").Logger} [logger] */
  constructor(logger) {
    this.logger = logger;
    this.entries = [];
    this._seq = 0;
  }

  _push(entry) {
    entry.seq = this._seq++;
    entry.ts = new Date().toISOString();
    this.entries.push(entry);
    return entry;
  }

  /** Ingests a single line from the host process stdio. */
  ingestHostLine(stream, line) {
    if (line == null || line === "") return;
    this._push({ source: "host", level: stream, text: line });
  }

  /**
   * Ingests a console/error/log message from any attached CDP target (page,
   * worker, or iframe), captured via the browser CDP session.
   * @param {string} target Target name/identifier (e.g. "page #1 Chat …" or a worker url)
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

export { ConsoleMonitor };
