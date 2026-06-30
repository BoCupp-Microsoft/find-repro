/**
 * Step-by-step driver for serve mode.
 *
 * Sends ONE step to a running `node bin/serve.mjs` session (via its
 * request.json/response.json file protocol), prints the observation, and — if
 * the step succeeded — appends it to a steps document you build up incrementally.
 * This lets you confirm each interaction against the live Teams host before
 * committing it to an example/repro.
 *
 * Prereq: serve mode is already running and "ready":
 *   node bin/serve.mjs           (in another terminal; status.json must say ready)
 *
 * Usage:
 *   node examples/drive.mjs --step '{"op":"evaluate","expression":"document.title"}'
 *   node examples/drive.mjs --op click --selector "[aria-label=\"Calendar\"]"
 *   node examples/drive.mjs --op waitForText --text "Meet now" --save examples/built.json
 *
 * Flags:
 *   --step <json>        Full step object as JSON (takes precedence).
 *   --op/--selector/--text/--testId/--value/--key/--expression/--url/--timeoutMs
 *                        Shorthands to assemble a step without writing JSON.
 *   --session-dir <dir>  serve session dir (default .session).
 *   --save <file>        Append the step to this steps doc on success
 *                        (default: examples/built.json). Use --no-save to skip.
 *   --dom / --screenshot Ask serve for a DOM snapshot / screenshot in the result.
 */

import fs from "node:fs";
import path from "node:path";

const sleep = ms => new Promise(r => setTimeout(r, ms));

function parse(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-save") o.save = false;
    else if (a === "--dom") o.dom = true;
    else if (a === "--screenshot") o.screenshot = true;
    else if (a === "--exact") o.exact = true;
    else if (a.startsWith("--")) o[a.slice(2)] = argv[++i];
  }
  return o;
}

function buildStep(o) {
  if (o.step) return JSON.parse(o.step);
  if (!o.op) throw new Error("provide --step <json> or --op <name> (+ locators)");
  const step = { op: o.op };
  for (const k of ["selector", "text", "testId", "value", "key", "expression", "url", "titlePrefix", "urlIncludes"]) {
    if (o[k] !== undefined) step[k] = o[k];
  }
  if (o.exact) step.exact = true;
  if (o.timeoutMs !== undefined) step.timeoutMs = Number(o.timeoutMs);
  return step;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

async function main() {
  const o = parse(process.argv.slice(2));
  const sessionDir = o["session-dir"] || ".session";
  const statusPath = path.join(sessionDir, "status.json");
  const requestPath = path.join(sessionDir, "request.json");
  const responsePath = path.join(sessionDir, "response.json");
  const saveFile = o.save === false ? null : o.save || path.join("examples", "built.json");

  const status = readJson(statusPath);
  if (!status || status.state !== "ready") {
    throw new Error(`serve session not ready (status: ${status ? status.state : "missing"}). Start: node bin/serve.mjs`);
  }

  const step = buildStep(o);
  const options = {};
  if (o.dom) options.wantDom = true;
  if (o.screenshot) options.wantScreenshot = true;

  const id = `drive-${Date.now()}`;
  console.log(`> sending step: ${JSON.stringify(step)}`);
  writeJsonAtomic(requestPath, { id, steps: [step], options });

  // Wait for the matching response.
  const deadline = Date.now() + 120000;
  let res = null;
  for (;;) {
    const r = readJson(responsePath);
    if (r && r.id === id) {
      res = r;
      break;
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for serve response");
    await sleep(200);
  }

  const obs = (res.results && res.results[0]) || {};
  console.log(`< status: ${res.status}`);
  if (obs.error) console.log(`< error: ${obs.error}`);
  if (obs.data !== undefined) console.log(`< data: ${JSON.stringify(obs.data)}`);
  if (obs.page) console.log(`< page: ${obs.page.title || ""} (${obs.page.url || ""})`);
  const console_ = obs.console || [];
  if (console_.length) {
    console.log(`< console (${console_.length}):`);
    for (const e of console_.slice(-15)) console.log(`    [${e.level}] ${String(e.text).slice(0, 200)}`);
  }
  if (obs.screenshot) console.log(`< screenshot: ${obs.screenshot}`);

  // Append to the build-up steps doc on success.
  if (saveFile && res.status === "ok") {
    const doc = readJson(saveFile) || { options: { continueOnError: false }, steps: [] };
    doc.steps = doc.steps || [];
    doc.steps.push(step);
    fs.mkdirSync(path.dirname(saveFile), { recursive: true });
    writeJsonAtomic(saveFile, doc);
    console.log(`✓ appended step #${doc.steps.length} to ${saveFile}`);
  } else if (saveFile) {
    console.log(`(not saved; step status was ${res.status})`);
  }

  process.exit(res.status === "ok" ? 0 : 1);
}

main().catch(err => {
  console.error(`drive error: ${err.message}`);
  process.exit(2);
});
