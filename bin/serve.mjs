#!/usr/bin/env node
/**
 * Interactive / serve mode (primary).
 *
 * Boots a Session (host stays alive) and then drives it via watched files in
 * the session directory:
 *
 *   <sessionDir>\status.json    written by us: { state, mainWindow?, error? }
 *   <sessionDir>\request.json   written by the skill: a request (see below)
 *   <sessionDir>\response.json  written by us: the matching response
 *
 * Request shape:
 *   { "id": "<unique>", "steps": [ {op...}, ... ],
 *     "options": { "wantDom": false, "wantScreenshot": false,
 *                  "continueOnError": false, "expectations": [ ... ] } }
 *   or { "id": "<unique>", "type": "shutdown" }
 *
 * Response shape:
 *   { "id": "<same id>", "status": "ok"|"error", "results": [ observation... ],
 *     "mainWindow": {...}, "error"?: string }
 *
 * The `id` correlates request/response and prevents reprocessing the same file.
 *
 * Usage: node bin/serve.mjs [--session-dir <path>] [--cdp-port <n>]
 *                          [--start-url <url>] [--overwrite-conflicts]
 */

import fs from "node:fs";
import path from "node:path";

import { Session } from "../src/session.mjs";
import { parseArgs } from "./argv.mjs";

async function main() {
  const overrides = parseArgs(process.argv.slice(2));
  const session = new Session(overrides);
  const sessionDir = session.settings.sessionDir;
  fs.mkdirSync(sessionDir, { recursive: true });

  const statusPath = path.join(sessionDir, "status.json");
  const requestPath = path.join(sessionDir, "request.json");
  const responsePath = path.join(sessionDir, "response.json");

  // Clear any stale request/response from a previous run.
  safeUnlink(requestPath);
  safeUnlink(responsePath);
  writeJson(statusPath, { state: "starting" });

  try {
    const mainWindow = await session.start();
    writeJson(statusPath, { state: "ready", mainWindow });
  } catch (err) {
    writeJson(statusPath, { state: "error", error: err.message });
    await session.shutdown();
    process.exitCode = 1;
    return;
  }

  let lastProcessedId = null;
  let stop = false;

  const shutdown = async () => {
    if (stop) return;
    stop = true;
    await session.shutdown();
    writeJson(statusPath, { state: "stopped" });
  };
  process.on("SIGINT", () => shutdown().then(() => process.exit(0)));
  process.on("SIGTERM", () => shutdown().then(() => process.exit(0)));

  // Poll for new request files.
  while (!stop) {
    const request = readJson(requestPath);
    if (request && request.id && request.id !== lastProcessedId) {
      lastProcessedId = request.id;
      try {
        if (request.type === "shutdown") {
          writeJson(responsePath, { id: request.id, status: "ok", stopped: true });
          await shutdown();
          break;
        }
        const steps = Array.isArray(request.steps) ? request.steps : [];
        const results = await session.runSteps(steps, request.options || {});
        const overall = results.some(r => r.status === "error") ? "error" : "ok";
        writeJson(responsePath, {
          id: request.id,
          status: overall,
          mainWindow: session.mainWindow,
          results,
        });
      } catch (err) {
        writeJson(responsePath, { id: request.id, status: "error", error: err.message });
      }
    }
    await sleep(session.settings.requestPollIntervalMs);
  }
}

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null; // partial write; try again next tick
  }
}

/** Atomic write: write to a temp file then rename. */
function writeJson(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

function safeUnlink(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  process.stderr.write(`fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
