"use strict";

/**
 * Test harness for exercising the pure-CDP infrastructure (CdpSession,
 * CdpTarget, ConsoleMonitor) against a plain headless Edge — no Teams host, no
 * WebView2. It serves the local fixtures over HTTP (so workers load same-origin),
 * launches Edge with a remote-debugging port, and connects a CdpSession exactly
 * the way the product does. Everything a test needs is returned from launch().
 */

const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const http = require("node:http");
const path = require("node:path");

const { CdpSession } = require("../../src/cdpSession");
const { ConsoleMonitor } = require("../../src/consoleMonitor");
const { CdpTarget } = require("../../src/cdpTarget");

const FIXTURES = path.join(__dirname, "..", "fixtures");

/**
 * Resolves a Chromium browser (override with FIND_REPRO_TEST_BROWSER). Chrome is
 * preferred over Edge: enterprise-managed Edge installs may force a sign-in flow
 * (edge://force-signin) that hijacks navigation even in a throwaway profile,
 * which prevents the fixture page from ever loading.
 */
function findBrowser() {
  const candidates = [
    process.env.FIND_REPRO_TEST_BROWSER,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error("No Chromium browser found; set FIND_REPRO_TEST_BROWSER to chrome.exe/msedge.exe.");
}

/** Picks an unused TCP port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

/** Serves the fixtures directory; resolves to { server, origin }. */
function serveFixtures() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
      const file = path.join(FIXTURES, rel || "main.html");
      if (!file.startsWith(FIXTURES)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      fs.readFile(file, (err, body) => {
        if (err) {
          res.writeHead(404).end("not found");
          return;
        }
        res.writeHead(200, { "content-type": CONTENT_TYPES[path.extname(file)] || "application/octet-stream" });
        res.end(body);
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Polls fn() until it returns truthy or the timeout elapses; returns the value. */
async function waitFor(fn, { timeout = 15000, interval = 100, message = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeout}ms waiting for ${message}`);
    await sleep(interval);
  }
}

/** Waits for a captured console/error entry whose text matches `re`. */
async function waitForEntry(monitor, re, { timeout = 15000 } = {}) {
  try {
    return await waitFor(() => monitor.entries.find(e => re.test(e.text)), {
      timeout,
      message: `entry matching ${re}`,
    });
  } catch (err) {
    const dump = monitor.entries.map(e => `  [${e.level}] (${e.page && e.page.url}) ${e.text}`).join("\n");
    throw new Error(`${err.message}. Captured entries:\n${dump || "  (none)"}`);
  }
}

const silentLogger = { log() {}, warn() {}, child() { return this; } };

/**
 * Launches the full stack and returns:
 *   { cdp, monitor, origin, mainTarget(), targetFor(urlIncludes), close() }
 */
async function launch() {
  const { server, origin } = await serveFixtures();
  const port = await freePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-edge-"));
  const exe = findBrowser();

  const child = spawn(
    exe,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-popup-blocking",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      `${origin}/main.html`,
    ],
    { stdio: "ignore", windowsHide: true }
  );

  const monitor = new ConsoleMonitor(silentLogger);
  const cdp = new CdpSession(
    { cdpPort: port, cdpConnectTimeoutMs: 30000, cdpCommandTimeoutMs: 10000 },
    { consoleMonitor: monitor, logger: silentLogger }
  );

  await cdp.connect();

  const targetFor = async urlIncludes => {
    // Match on the live location.href (like the product's targetManager), not the
    // tracked targetInfo.url: a popup can finish navigating before any
    // Target.targetInfoChanged updates its cached url, leaving info.url empty.
    const target = await waitFor(
      async () => {
        for (const p of cdp.pages()) {
          const t = new CdpTarget(cdp, p.sessionId, p.info);
          let href = String(p.info.url || "");
          if (!href.includes(urlIncludes)) {
            try {
              href = String(await t.evaluate("location.href"));
            } catch {
              /* session not ready yet */
            }
          }
          if (href.includes(urlIncludes)) return t;
        }
        return null;
      },
      { message: `page target for ${urlIncludes}` }
    );
    // The target exists as soon as the navigation starts; wait for the fixture's
    // inline script to finish so its DOM, globals, and worker are all in place.
    await waitFor(
      async () => {
        try {
          return await target.evaluate("window.__fixtureReady === true");
        } catch {
          return false;
        }
      },
      { message: `fixture ready for ${urlIncludes}` }
    );
    return target;
  };

  // Make sure the initial page is attached before handing control to the test.
  await targetFor("main.html");

  const close = async () => {
    try {
      cdp.close();
    } catch {
      /* ignore */
    }
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
    server.closeAllConnections?.(); // drop the browser's keep-alive sockets so close() resolves
    await new Promise(r => server.close(r));
    // The profile dir stays locked for a moment after the browser is killed; retry.
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  };

  return {
    cdp,
    monitor,
    origin,
    mainTarget: () => targetFor("main.html"),
    targetFor,
    close,
  };
}

module.exports = { launch, waitFor, waitForEntry, sleep };
