import http from "node:http";
import net from "node:net";
// Uses Node's built-in global WebSocket (stable in Node 22+, verified Node 24) —
// no `ws` dependency, matching the zero-install Teams skill-script convention.

/**
 * Strongly-typed wrapper over a single browser-level Chromium DevTools Protocol
 * session (one WebSocket, flat mode). This is the ONLY protocol path: no
 * Playwright. It connects to the browser endpoint and `setAutoAttach`es so we
 * attach to every target — the non-rendering core, the main window, any later
 * windows, and all workers/iframes — current and future. Page DOM, navigation,
 * screenshots, and console all flow through here (see CdpTarget for the page
 * abstraction). Replaces /json/list polling, per-worker sockets, and reconnects.
 *
 * Method names and params are raw CDP strings (see the DevTools Protocol docs at
 * https://chromedevtools.github.io/devtools-protocol/); the loose `Protocol`
 * typedef below keeps the JSDoc valid without a playwright-core dependency.
 *
 * @typedef {Record<string, any>} Protocol
 */
class CdpSession {
  /**
   * @param {object} config { cdpPort, cdpConnectTimeoutMs }
   * @param {object} [deps]
   * @param {import("./console-monitor.mjs").ConsoleMonitor} [deps.consoleMonitor]
   * @param {import("./logger.mjs").Logger} [deps.logger]
   */
  constructor(config, { consoleMonitor, logger } = {}) {
    this.config = config;
    this.consoleMonitor = consoleMonitor;
    this.logger = logger;
    this.ws = null;
    this._nextId = 1;
    this._pending = new Map();
    /** sessionId -> { info, ord, name } */
    this.targets = new Map();
    /** per-type ordinal counters for stable, never-blank identifiers */
    this._ordinals = {};
    /** flat dispatcher: "Method" or "Method@sessionId" -> Set<fn> */
    this._listeners = new Map();
    /** targetIds with an in-flight attachToTarget (reconcile de-dupe) */
    this._attaching = new Set();
    this._reconcileTimer = null;
  }

  log(msg) {
    if (this.logger) this.logger.log(msg);
  }

  /** Waits for the port, connects to the browser endpoint, enables auto-attach. */
  async connect() {
    await this._waitForPort();
    const url = await this._browserWsUrl();
    await new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", ev => this._onMessage(ev.data));
    await this.setAutoAttach();
    // Auto-attach events alone are not enough: during WebView2 startup the real
    // content window's target churns (attaches then immediately detaches), and
    // the long-lived session never receives a fresh attach for it. Periodically
    // reconcile against Target.getTargets() and attach to anything we're missing.
    await this.reconcileTargets();
    this._reconcileTimer = setInterval(
      () => this.reconcileTargets().catch(() => {}),
      this.config.targetReconcileIntervalMs || 1500
    );
    this._reconcileTimer.unref?.();
    this.log("cdp session connected; auto-attach enabled");
  }

  /**
   * Reconciles the tracked target set against the authoritative Target.getTargets():
   *  1. Refreshes each tracked target's info (type/url/title). This is essential
   *     because targetInfoChanged is not always delivered — notably the WebView2
   *     content window first attaches as type "other" with an empty url and is
   *     only reported as a real "page" by getTargets(); without this refresh
   *     pages() never sees the main window.
   *  2. Attaches to any attachable target we are not yet tracking, self-healing
   *     auto-attach events missed during startup churn (attach/detach cycles).
   */
  async reconcileTargets() {
    if (!this.ws) return;
    let infos;
    try {
      infos = await this.getTargets();
    } catch {
      return;
    }
    const byId = new Map(infos.map(i => [i.targetId, i]));
    for (const tracked of this.targets.values()) {
      const fresh = byId.get(tracked.info.targetId);
      if (!fresh) continue;
      if (fresh.type !== tracked.info.type || fresh.url !== tracked.info.url || fresh.title !== tracked.info.title) {
        const prevType = tracked.info.type;
        const before = tracked.name;
        tracked.info = fresh;
        tracked.name = identifier(fresh.type, tracked.ord, fresh);
        // Only log the meaningful type transition (e.g. "other" -> "page"); url/
        // title churn (Teams rewrites document.title constantly) would be noise.
        if (fresh.type !== prevType) this.log(`refreshed ${before} -> ${tracked.name}`);
      }
    }
    const tracked = new Set();
    for (const t of this.targets.values()) tracked.add(t.info.targetId);
    for (const info of infos) {
      if (!RECONCILE_TYPES.has(info.type)) continue;
      if (tracked.has(info.targetId) || this._attaching.has(info.targetId)) continue;
      this._attaching.add(info.targetId);
      this.send("Target.attachToTarget", { targetId: info.targetId, flatten: true })
        .catch(() => {})
        .finally(() => this._attaching.delete(info.targetId));
    }
  }

  /** Resolves on the first successful TCP connection to the debugging port. */
  _waitForPort() {
    const { cdpPort, cdpConnectTimeoutMs } = this.config;
    const deadline = Date.now() + (cdpConnectTimeoutMs || 60000);
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
            reject(new Error(`CDP port ${cdpPort} did not open within ${cdpConnectTimeoutMs}ms.`));
            return;
          }
          setTimeout(attempt, 100);
        });
      };
      attempt();
    });
  }

  /** Resolves the browser-level WebSocket URL from /json/version. */
  _browserWsUrl() {
    return new Promise((resolve, reject) => {
      const req = http.get(
        { host: "127.0.0.1", port: this.config.cdpPort, path: "/json/version" },
        res => {
          let body = "";
          res.on("data", d => (body += d));
          res.on("end", () => {
            try {
              resolve(JSON.parse(body).webSocketDebuggerUrl);
            } catch (err) {
              reject(err);
            }
          });
        }
      );
      req.on("error", reject);
      req.setTimeout(3000, () => req.destroy(new Error("timeout")));
    });
  }

  /**
   * Sends a typed CDP command, optionally on a child target's session.
   * @template {keyof Protocol["CommandParameters"]} M
   * @param {M} method
   * @param {Protocol["CommandParameters"][M]} [params]
   * @param {string} [sessionId]
   * @returns {Promise<Protocol["CommandReturnValues"][M]>}
   */
  send(method, params, sessionId) {
    const id = this._nextId++;
    const msg = { id, method, params: params || {} };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pending.delete(id)) reject(new Error(`CDP ${method} timed out`));
      }, this.config.cdpCommandTimeoutMs || 10000);
      this._pending.set(id, {
        resolve: v => (clearTimeout(timer), resolve(v)),
        reject: e => (clearTimeout(timer), reject(e)),
      });
      // Global WebSocket.send takes no callback; it throws synchronously if the
      // socket isn't open, so surface that as a rejection.
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  /** Subscribe to a CDP event, optionally scoped to one session. Returns unsub. */
  on(method, handler, sessionId) {
    const key = sessionId ? `${method}@${sessionId}` : method;
    if (!this._listeners.has(key)) this._listeners.set(key, new Set());
    this._listeners.get(key).add(handler);
    return () => this._listeners.get(key)?.delete(handler);
  }

  /** Auto-attach (flat) so all current/future pages and workers attach. */
  setAutoAttach(sessionId) {
    return this.send(
      "Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      sessionId
    );
  }

  /** @returns {Promise<Protocol["Target"]["TargetInfo"][]>} */
  async getTargets() {
    const { targetInfos } = await this.send("Target.getTargets");
    return targetInfos;
  }

  /** Tracked page targets (window candidates): [{ sessionId, info, name }]. */
  pages() {
    return [...this.targets.entries()]
      .filter(([, t]) => t.info.type === "page")
      .map(([sessionId, t]) => ({ sessionId, info: t.info, name: t.name }));
  }

  /** Tracked iframe targets: [{ sessionId, info, name }]. */
  iframes() {
    return [...this.targets.entries()]
      .filter(([, t]) => t.info.type === "iframe")
      .map(([sessionId, t]) => ({ sessionId, info: t.info, name: t.name }));
  }

  /** Tracked worker targets (dedicated/shared/service): [{ sessionId, info, name }]. */
  workers() {
    return [...this.targets.entries()]
      .filter(([, t]) => /worker/i.test(t.info.type))
      .map(([sessionId, t]) => ({ sessionId, info: t.info, name: t.name }));
  }

  _onMessage(raw) {
    let m;
    try {
      m = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch {
      return;
    }
    if (m.id && this._pending.has(m.id)) {
      const { resolve, reject } = this._pending.get(m.id);
      this._pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      return;
    }
    this._builtin(m.method, m.params || {}, m.sessionId);
    this._emit(m.method, m.params || {}, m.sessionId);
  }

  _emit(method, params, sessionId) {
    const fire = key => this._listeners.get(key)?.forEach(fn => fn(params, sessionId));
    if (sessionId) fire(`${method}@${sessionId}`);
    fire(method);
  }

  _builtin(method, params, sessionId) {
    switch (method) {
      case "Target.attachedToTarget":
        this._onAttached(params);
        break;
      case "Target.targetInfoChanged":
        this._onInfoChanged(params);
        break;
      case "Target.detachedFromTarget": {
        const gone = this.targets.get(params.sessionId);
        if (gone) this.log(`detached ${gone.name}`);
        this.targets.delete(params.sessionId);
        break;
      }
      case "Runtime.consoleAPICalled":
        this._ingest(sessionId, params.type || "log", argsText(params.args));
        break;
      case "Runtime.exceptionThrown": {
        const d = params.exceptionDetails || {};
        const ex = d.exception || {};
        this._ingest(sessionId, "error", String(ex.description || ex.value || d.text || "exception"));
        break;
      }
      case "Log.entryAdded":
        this._ingest(sessionId, (params.entry && params.entry.level) || "log", params.entry && params.entry.text);
        break;
    }
  }

  /** @param {Protocol["Target"]["attachedToTarget"]} p */
  _onAttached(p) {
    const sid = p.sessionId;
    const info = p.targetInfo;
    this._attaching.delete(info.targetId);
    const ord = (this._ordinals[info.type] = (this._ordinals[info.type] || 0) + 1);
    const name = identifier(info.type, ord, info);
    this.targets.set(sid, { info, ord, name });
    this.log(`attached ${name}`);
    this.setAutoAttach(sid).catch(() => {});
    this.send("Runtime.enable", undefined, sid).catch(() => {});
    this.send("Log.enable", undefined, sid).catch(() => {});
    // Resume any target that attached in a paused ("waiting for debugger") state.
    // A popup opened via window.open attaches to its opener and can block the
    // opener's script (the very click that opened it) until it is resumed.
    this.send("Runtime.runIfWaitingForDebugger", undefined, sid).catch(() => {});
  }

  /** @param {Protocol["Target"]["targetInfoChanged"]} p */
  _onInfoChanged(p) {
    const sid = this._sidFor(p.targetInfo.targetId);
    const tracked = this.targets.get(sid);
    if (!tracked) return;
    const before = tracked.name;
    tracked.info = p.targetInfo;
    const after = identifier(p.targetInfo.type, tracked.ord, p.targetInfo);
    if (after !== before) {
      tracked.name = after;
      this.log(`updated ${before} -> ${after}`);
    }
  }

  _sidFor(targetId) {
    for (const [sid, t] of this.targets) if (t.info.targetId === targetId) return sid;
    return undefined;
  }

  _ingest(sessionId, level, text) {
    if (!this.consoleMonitor || !text) return;
    const t = this.targets.get(sessionId);
    this.consoleMonitor.ingestTarget(t ? t.name : "cdp", level, text);
  }

  close() {
    if (this._reconcileTimer) {
      clearInterval(this._reconcileTimer);
      this._reconcileTimer = null;
    }
    try {
      if (this.ws) this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/** Target types the reconcile loop will attach to (windows, app frames, workers). */
const RECONCILE_TYPES = new Set(["page", "iframe", "worker", "shared_worker", "service_worker"]);

/** Stable, never-blank identifier: `type #ord title|url|targetId`. */
function identifier(type, ord, info) {
  const tail = (info.title || stripHash(info.url) || stripHash(info.targetId) || "?").trim();
  return `${type} #${ord} ${tail.slice(0, 60)}`;
}

function stripHash(u) {
  return String(u || "").split("#")[0];
}

function argsText(args) {
  return (args || [])
    .map(a => (a.value !== undefined ? a.value : a.description !== undefined ? a.description : ""))
    .join(" ");
}

export { CdpSession };
