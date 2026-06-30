#!/usr/bin/env node
"use strict";

/**
 * Batch / replay mode.
 *
 * Boots a Session, runs a full list of steps from a JSON file, writes a result
 * file, and exits (0 if every step succeeded, 1 otherwise). Useful for replaying
 * a confirmed repro as a regression check.
 *
 * Steps file shape:
 *   { "steps": [ {op...}, ... ],
 *     "options": { "wantDom": false, "wantScreenshot": false,
 *                  "continueOnError": false, "expectations": [ ... ] } }
 *
 * Result file shape:
 *   { "status": "ok"|"error", "mainWindow": {...}, "results": [ observation... ] }
 *
 * Usage: node bin/run.js --steps <file> [--out <file>] [--keep-open]
 *                        [--session-dir <path>] [--cdp-port <n>] [--start-url <url>]
 *                        [--overwrite-conflicts]
 */

const fs = require("node:fs");
const path = require("node:path");

const { Session } = require("../src/session");
const { parseArgs } = require("./argv");

async function main() {
  const { overrides, flags } = splitArgs(process.argv.slice(2));

  if (!flags.steps) {
    process.stderr.write("error: --steps <file> is required\n");
    process.exit(2);
  }
  const stepsDoc = JSON.parse(fs.readFileSync(flags.steps, "utf-8"));
  const steps = Array.isArray(stepsDoc.steps) ? stepsDoc.steps : [];
  const options = stepsDoc.options || {};

  const session = new Session(overrides);
  const outPath =
    flags.out || path.join(session.config.sessionDir, "result.json");

  let result;
  try {
    const mainWindow = await session.start();
    const results = await session.runSteps(steps, options);
    const status = results.some(r => r.status === "error") ? "error" : "ok";
    result = { status, mainWindow, results };
  } catch (err) {
    result = { status: "error", error: err.message, results: [] };
  } finally {
    if (!flags.keepOpen) {
      await session.shutdown();
    }
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf-8");
  process.stderr.write(`wrote ${outPath} (status=${result.status})\n`);
  const code = result.status === "ok" ? 0 : 1;
  if (flags.keepOpen) {
    // Host is intentionally left running; exit now so the held CDP socket
    // doesn't keep the process alive.
    process.stderr.write(`host left running (--keep-open); CDP on port ${session.config.cdpPort}\n`);
    process.exit(code);
  }
  process.exitCode = code;
}

/** Splits CLI args into Session overrides plus run-specific flags. */
function splitArgs(argv) {
  const flags = { steps: null, out: null, keepOpen: false };
  const passthrough = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--steps") flags.steps = argv[++i];
    else if (a === "--out") flags.out = argv[++i];
    else if (a === "--keep-open") flags.keepOpen = true;
    else passthrough.push(a);
  }
  return { overrides: parseArgs(passthrough), flags };
}

main().catch(err => {
  process.stderr.write(`fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
