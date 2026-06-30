/**
 * Exercises the CdpSession target graph and ConsoleMonitor capture against
 * headless Chromium, with no Teams host involved. Verifies that:
 *   - page, dedicated-worker, and newly window.open()'d targets are enumerated;
 *   - console output, uncaught errors, and unhandled promise rejections are
 *     captured from the main page, the worker, and a second window;
 * Windows are opened by a simulated user click on a button that calls
 * window.open (not Target.createTarget), matching how the product opens windows.
 */

import { test, before, after, describe } from "node:test";
import assert from "node:assert";

import { launch, waitFor, waitForEntry } from "./helpers/harness.mjs";

const nonce = () => Math.random().toString(36).slice(2, 10);

describe("CdpSession targets + ConsoleMonitor capture (headless Chromium)", () => {
  let h;
  let main;

  before(async () => {
    h = await launch();
    main = await h.mainTarget();
    // Wait until the dedicated worker has attached before running cases.
    await waitFor(() => h.cdp.workers().length >= 1, { message: "worker target to attach" });
  });

  after(async () => {
    if (h) await h.close();
  });

  test("enumerates the page and worker targets", () => {
    const pages = h.cdp.pages();
    const workers = h.cdp.workers();
    assert.ok(pages.length >= 1, `expected >=1 page, got ${pages.length}`);
    assert.ok(pages.some(p => /main\.html/.test(p.info.url)), "main page not enumerated");
    assert.ok(workers.length >= 1, `expected >=1 worker, got ${workers.length}`);
    assert.ok(workers.some(w => /worker\.js/.test(w.info.url)), "worker.js not enumerated");
    // Every tracked target has a stable, never-blank identifier.
    for (const [, t] of h.cdp.targets) assert.ok(t.name && t.name.trim().length > 0, "blank target name");
  });

  test("captures console output from the main page", async () => {
    const n = nonce();
    await main.evaluate(`window.emitConsole('[TEST] page-console ${n}')`);
    const entry = await waitForEntry(h.monitor, new RegExp(`page-console ${n}`));
    assert.ok(entry.page && entry.page.url, "captured entry should carry its source target name");
  });

  test("captures an uncaught error from the main page", async () => {
    const n = nonce();
    await main.evaluate(`window.emitError('[TEST] page-error ${n}')`);
    const entry = await waitForEntry(h.monitor, new RegExp(`page-error ${n}`));
    assert.match(entry.level, /error/i);
  });

  test("captures an unhandled promise rejection from the main page", async () => {
    const n = nonce();
    await main.evaluate(`window.emitRejection('[TEST] page-reject ${n}')`);
    await waitForEntry(h.monitor, new RegExp(`page-reject ${n}`));
  });

  test("captures console output from the worker", async () => {
    const n = nonce();
    await main.evaluate(`window.__worker.postMessage('log:${n}')`);
    await waitForEntry(h.monitor, new RegExp(`worker-log ${n}`));
  });

  test("captures an uncaught error from the worker", async () => {
    const n = nonce();
    await main.evaluate(`window.__worker.postMessage('error:${n}')`);
    const entry = await waitForEntry(h.monitor, new RegExp(`worker-error ${n}`));
    assert.match(entry.level, /error/i);
  });

  test("captures an unhandled promise rejection from the worker", async () => {
    const n = nonce();
    await main.evaluate(`window.__worker.postMessage('reject:${n}')`);
    await waitForEntry(h.monitor, new RegExp(`worker-reject ${n}`));
  });

  test("auto-attaches a window opened by a user click and captures its console", async () => {
    const before = h.cdp.pages().length;
    await main.click({ testId: "open-window" });

    const second = await h.targetFor("second.html");
    assert.ok(h.cdp.pages().length > before, "no new page target after window.open");

    const n = nonce();
    await second.evaluate(`window.emitConsole('[TEST] second-window ${n}')`);
    await waitForEntry(h.monitor, new RegExp(`second-window ${n}`));
  });
});
