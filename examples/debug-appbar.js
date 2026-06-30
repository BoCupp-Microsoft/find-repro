"use strict";

/**
 * Diagnostic: connects a second CDP client to an already-running Teams host
 * (default port 9222, e.g. one held open by serve mode) and dumps every target
 * with its LIVE url/title, plus an app-bar probe for each page target. Use this
 * to see why the main-window (app bar) detection isn't matching.
 *
 * Usage: node examples/debug-appbar.js [--cdp-port 9222]
 */

const { CdpSession } = require("../src/cdpSession");
const { CdpTarget } = require("../src/cdpTarget");
const { ConsoleMonitor } = require("../src/consoleMonitor");

const sleep = ms => new Promise(r => setTimeout(r, ms));

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const PROBE = `(() => {
  const out = { href: location.href, title: document.title, ready: document.readyState, bodyLen: (document.body && document.body.innerText || '').length };
  const sels = ['[data-tid="app-layout-area--nav"]','[data-tid="app-bar-wrapper"]','[data-tid^="app-bar-"]','[role="navigation"]'];
  out.selectors = sels.map(s => ({ s, n: document.querySelectorAll(s).length }));
  const nav = document.querySelector('[data-tid="app-layout-area--nav"]') || document.querySelector('[data-tid="app-bar-wrapper"]');
  out.navFound = !!nav;
  if (nav) {
    const btns = Array.from(nav.querySelectorAll('button,a,[role="button"],[role="tab"]'));
    out.navButtons = btns.length;
    out.navLabels = btns.map(b => b.getAttribute('aria-label') || b.getAttribute('data-tid') || b.textContent.trim().slice(0,20)).slice(0, 20);
  }
  // Curtain / loading hints
  out.curtain = !!document.querySelector('[data-tid="app-loading-indicator"], [class*="loading" i], [aria-label*="setting things up" i]');
  return out;
})()`;

(async () => {
  const port = Number(arg("--cdp-port", "9222"));
  const monitor = new ConsoleMonitor({ log() {} });
  const cdp = new CdpSession(
    { cdpPort: port, cdpConnectTimeoutMs: 15000, cdpCommandTimeoutMs: 10000 },
    { consoleMonitor: monitor, logger: { log: () => {} } }
  );
  await cdp.connect();
  await sleep(1500); // let auto-attach enumerate

  const all = [...cdp.targets.values()];
  console.log(`\n=== ${all.length} target(s) on port ${port} ===`);
  for (const t of all) {
    console.log(`- ${t.info.type.padEnd(14)} info.url='${t.info.url}' info.title='${t.info.title}'`);
  }

  console.log(`\n=== page probes (live) ===`);
  for (const p of cdp.pages()) {
    const target = new CdpTarget(cdp, p.sessionId, p.info);
    try {
      const r = await target.evaluate(PROBE);
      console.log(`\n[page ${p.name}]`);
      console.log(JSON.stringify(r, null, 2));
    } catch (e) {
      console.log(`\n[page ${p.name}] probe failed: ${e.message}`);
    }
  }

  cdp.close();
  process.exit(0);
})().catch(e => {
  console.error("debug-appbar error:", e.stack || e);
  process.exit(1);
});
