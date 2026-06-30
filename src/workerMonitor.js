"use strict";

const http = require("node:http");
let WebSocket = null;
try {
  WebSocket = require("ws");
} catch {
  WebSocket = null;
}

/**
 * Captures console output from the host's **Web Worker** targets and feeds it
 * into the ConsoleMonitor.
 *
 * Why this exists: Playwright's `page.on('console')` only surfaces main-page (and
 * page-owned dedicated worker) console. Teams runs critical logic — the CDL,
 * the notification/toast resolvers, and telemetry — in separate top-level
 * **worker targets** (e.g. `precompiled-web-worker-*.js`,
 * `precompiled-telemetry-web-worker.js`). `page.workers()` returns 0 for these,
 * so their console (including errors like `ToastEventIsAlreadyRead`) is invisible
 * to a page-only listener. We attach to each worker target's CDP endpoint over a
 * raw WebSocket, enable Runtime/Log, and route their messages in.
 */
class WorkerMonitor {
  /**
   * @param {object} config
   * @param {object} deps
   * @param {import("./consoleMonitor").ConsoleMonitor} deps.consoleMonitor
   * @param {import("./logger").Logger} [deps.logger]
   */
  constructor(config, { consoleMonitor, logger } = {}) {
    this.config = config;
    this.consoleMonitor = consoleMonitor;
    this.logger = logger;
    this._attached = new Map(); // targetId -> ws
    this._timer = null;
    this._stopped = false;
  }

  log(msg) {
    if (this.logger) this.logger.log(msg);
  }

  /** Begins polling for worker targets and attaching to them. */
  start() {
    if (!WebSocket) {
      this.log("ws module unavailable; worker console capture disabled");
      return;
    }
    const poll = () => {
      if (this._stopped) return;
      this._discover().finally(() => {
        if (!this._stopped) {
          this._timer = setTimeout(poll, this.config.workerPollIntervalMs || 3000);
        }
      });
    };
    poll();
  }

  async _discover() {
    let targets;
    try {
      targets = await this._listWorkerTargets();
    } catch {
      return;
    }
    for (const t of targets) {
      const id = t.id || t.webSocketDebuggerUrl;
      if (!id || this._attached.has(id) || !t.webSocketDebuggerUrl) continue;
      this._attach(id, t);
    }
  }

  _attach(id, target) {
    const name = workerName(target);
    let ws;
    try {
      ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
    } catch (err) {
      return;
    }
    this._attached.set(id, ws);

    ws.on("open", () => {
      try {
        ws.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
        ws.send(JSON.stringify({ id: 2, method: "Log.enable" }));
      } catch {
        /* ignore */
      }
      this.log(`attached to worker console: ${name}`);
    });

    ws.on("message", raw => {
      let m;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (m.method === "Runtime.consoleAPICalled") {
        const text = (m.params.args || [])
          .map(a => (a.value !== undefined ? a.value : a.description !== undefined ? a.description : ""))
          .join(" ");
        this.consoleMonitor.ingestWorker(name, m.params.type || "log", text);
      } else if (m.method === "Log.entryAdded" && m.params && m.params.entry) {
        const e = m.params.entry;
        this.consoleMonitor.ingestWorker(name, e.level || "log", e.text || "");
      }
    });

    ws.on("close", () => this._attached.delete(id));
    ws.on("error", () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      this._attached.delete(id);
    });
  }

  _listWorkerTargets() {
    const port = this.config.cdpPort;
    return new Promise((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/json/list" }, res => {
        let body = "";
        res.on("data", d => (body += d));
        res.on("end", () => {
          try {
            const list = JSON.parse(body);
            resolve(
              Array.isArray(list)
                ? list.filter(t => t.type === "worker" || t.type === "shared_worker" || t.type === "service_worker")
                : []
            );
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on("error", reject);
      req.setTimeout(3000, () => {
        req.destroy();
        reject(new Error("timeout"));
      });
    });
  }

  stop() {
    this._stopped = true;
    if (this._timer) clearTimeout(this._timer);
    for (const ws of this._attached.values()) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this._attached.clear();
  }
}

function workerName(target) {
  const url = (target.url || target.title || "").split("#")[0];
  const file = url.split("/").pop() || "worker";
  return file;
}

module.exports = { WorkerMonitor };
