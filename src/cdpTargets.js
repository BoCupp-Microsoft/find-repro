"use strict";

const http = require("node:http");

/**
 * Helpers for the Chromium DevTools Protocol HTTP endpoints exposed on the
 * remote-debugging port (e.g. http://127.0.0.1:9222/json/list).
 *
 * We use the raw endpoint because Playwright's connectOverCDP only surfaces
 * page targets that exist at connect time; it does not auto-attach to Teams'
 * additional top-level WebView2 windows created later. Polling /json/list lets
 * us wait for the real content window before we connect (and to discover new
 * windows for multi-window scenarios).
 */

function getJson(port, urlPath) {
  return new Promise(resolve => {
    const req = http.get({ host: "127.0.0.1", port, path: urlPath }, res => {
      let body = "";
      res.on("data", d => (body += d));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

/** Returns the list of CDP targets, or [] if the endpoint isn't ready. */
async function listTargets(port) {
  const list = await getJson(port, "/json/list");
  return Array.isArray(list) ? list : [];
}

/**
 * True if a target looks like the main Teams content window (the one that hosts
 * the app bar): a page on the start origin that is neither the about:blank
 * loader nor the `#deepLink` orchestration shell.
 */
function isContentWindow(target, startOrigin) {
  if (!target || target.type !== "page") return false;
  const url = target.url || "";
  if (url.startsWith("about:")) return false;
  if (url.includes("deepLink")) return false;
  if (startOrigin && !url.includes(startOrigin)) return false;
  return true;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { getJson, listTargets, isContentWindow, sleep };
