import fs from "node:fs";
import net from "node:net";
import childProcess from "node:child_process";

/**
 * Launches ms-teams.exe so that its underlying WebView2/Chromium exposes a CDP
 * endpoint our CdpSession can attach to.
 *
 * WebView2 reads extra browser flags from WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
 * which is how we open the remote-debugging port.
 *
 * Teams is a single-instance app: launching a second exe while one is already
 * running just hands off to the existing instance (and our debugging flag would
 * not take effect). To get a predictable, attachable instance this launcher:
 *   1. reuses an instance that already exposes the CDP port (if reuseExisting);
 *   2. otherwise optionally terminates a conflicting non-debug instance
 *      (killExisting) before spawning a fresh one.
 */
class ShellLauncher {
  /**
   * @param {object} config
   * @param {object} [deps]
   * @param {import("./logger.mjs").Logger} [deps.logger]
   * @param {import("./console-monitor.mjs").ConsoleMonitor} [deps.consoleMonitor]
   */
  constructor(config, { logger, consoleMonitor } = {}) {
    this.config = config;
    this.logger = logger;
    this.consoleMonitor = consoleMonitor;
    this.proc = null;
    this.reused = false;
  }

  log(msg) {
    if (this.logger) this.logger.log(msg);
  }

  /**
   * Ensures an attachable host is running.
   * @returns {Promise<{reused:boolean, pid:number|null}>}
   */
  async launch() {
    const { shellExe, cdpPort } = this.config;

    // 1. Reuse an already-debuggable instance.
    if (this.config.reuseExisting !== false && (await isPortOpen(cdpPort))) {
      this.reused = true;
      this.log(`CDP port ${cdpPort} already open; reusing the running host instance`);
      return { reused: true, pid: null };
    }

    if (!fs.existsSync(shellExe)) {
      throw new Error(`ms-teams.exe not found at: ${shellExe}`);
    }

    // 2. A non-debug instance would swallow our launch (single-instance app).
    const running = listTeamsPids();
    if (running.length > 0) {
      if (this.config.killExisting) {
        this.log(`terminating ${running.length} existing ms-teams instance(s) before launch: ${running.join(", ")}`);
        killTeams();
        await sleep(1500);
      } else {
        this.log(
          `WARNING: ${running.length} ms-teams instance(s) already running without the debug port. ` +
            `Teams is single-instance, so the new launch may not expose CDP. ` +
            `Close Teams or pass killExisting=true (--kill-existing).`
        );
      }
    }

    const browserArgs = [
      `--remote-debugging-port=${cdpPort}`,
      ...(this.config.extraBrowserArgs || []),
    ];

    // Spawn the exe directly (no shell) so proc.pid is the real host process and
    // we can terminate its tree on shutdown.
    const proc = childProcess.spawn(shellExe, browserArgs, {
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: browserArgs.join(" "),
      },
    });

    this.proc = proc;
    this.log(`launched ${shellExe} with CDP port ${cdpPort} (pid ${proc.pid})`);

    this._wireStream(proc.stdout, "stdout");
    this._wireStream(proc.stderr, "stderr");

    proc.on("exit", (code, signal) => {
      this.log(`launched ms-teams.exe process exited (code=${code}, signal=${signal})`);
    });

    return { reused: false, pid: proc.pid };
  }

  _wireStream(stream, name) {
    if (!stream) return;
    let buffer = "";
    stream.on("data", chunk => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        process.stderr.write(`[ms-teams:${name}] ${line}\n`);
        if (this.consoleMonitor) {
          this.consoleMonitor.ingestHostLine(name, line);
        }
      }
    });
  }

  /**
   * Terminates the host we launched (process tree). Does nothing when we reused
   * a pre-existing instance, so we never kill a host the dev started.
   */
  stop() {
    if (this.reused || !this.proc) return;
    const pid = this.proc.pid;
    if (!pid) return;
    try {
      // /T kills the whole tree (renderers, GPU, etc.); /F forces it.
      childProcess.spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } catch {
      try {
        this.proc.kill();
      } catch {
        /* ignore */
      }
    }
  }
}

function isPortOpen(port) {
  return new Promise(resolve => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** Returns the PIDs of running ms-teams.exe processes (Windows). */
function listTeamsPids() {
  try {
    const out = childProcess.execSync('tasklist /FI "IMAGENAME eq ms-teams.exe" /FO CSV /NH', {
      encoding: "utf-8",
    });
    return out
      .split(/\r?\n/)
      .filter(l => l.includes("ms-teams.exe"))
      .map(l => {
        const m = l.match(/^"[^"]*","(\d+)"/);
        return m ? Number(m[1]) : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function killTeams() {
  try {
    childProcess.spawnSync("taskkill", ["/IM", "ms-teams.exe", "/T", "/F"], {
      stdio: "ignore",
    });
  } catch {
    /* ignore */
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export { ShellLauncher };
