"use strict";

/**
 * Exercises every CdpTarget operation against headless Edge: element lookup
 * (selector / testId / text), waitFor, click, hover, fill, type, press,
 * selectOption, evaluate, title/url/content, screenshot, and navigate. Operation
 * effects are asserted by reading window.__events (recorded by the fixture), so
 * each assertion proves the action actually reached the DOM.
 */

const { test, before, after, describe } = require("node:test");
const assert = require("node:assert");

const { launch, waitFor } = require("./helpers/harness");

describe("CdpTarget operations (headless Edge)", () => {
  let h;
  let target;

  before(async () => {
    h = await launch();
    target = await h.mainTarget();
  });

  after(async () => {
    if (h) await h.close();
  });

  /** Resolves once window.__events contains an entry including `marker`. */
  const expectEvent = (marker, timeout = 10000) =>
    waitFor(async () => (await target.evaluate("window.__events")).some(s => s.includes(marker)), {
      timeout,
      message: `event ${marker}`,
    });

  test("evaluate returns a JSON value", async () => {
    assert.strictEqual(await target.evaluate("1 + 2"), 3);
    assert.strictEqual(await target.evaluate("document.title"), "find-repro cdp test page");
  });

  test("exists matches by selector, testId, and text", async () => {
    assert.strictEqual(await target.exists({ selector: "#btn" }), true);
    assert.strictEqual(await target.exists({ testId: "go-btn" }), true); // data-testid
    assert.strictEqual(await target.exists({ testId: "go-btn-tid" }), true); // data-tid fallback
    assert.strictEqual(await target.exists({ text: "Unique Marker Text", exact: true }), true);
    assert.strictEqual(await target.exists({ selector: "#does-not-exist" }), false);
  });

  test("waitFor resolves for a delayed element", async () => {
    assert.strictEqual(await target.waitFor({ selector: "#delayed" }, { timeout: 5000 }), true);
    assert.strictEqual(await target.waitFor({ selector: "#never" }, { timeout: 300 }), false);
  });

  test("click invokes the element handler", async () => {
    await target.click({ selector: "#btn" });
    await expectEvent("click:btn");
  });

  test("click by testId works", async () => {
    await target.click({ testId: "go-btn-tid" });
    await expectEvent("click:btn");
  });

  test("hover dispatches mouseover", async () => {
    await target.hover({ selector: "#hover" });
    await expectEvent("hover:hover");
  });

  test("fill sets value and fires input/change", async () => {
    await target.fill({ testId: "fill-input" }, "hello-fill");
    await expectEvent("input:fill=hello-fill");
    await expectEvent("change:fill=hello-fill");
    assert.strictEqual(await target.evaluate("document.getElementById('fillinput').value"), "hello-fill");
  });

  test("type inserts text via CDP Input", async () => {
    await target.type({ testId: "type-input" }, "typed-text");
    await expectEvent("input:type=typed-text");
    assert.strictEqual(await target.evaluate("document.getElementById('typeinput').value"), "typed-text");
  });

  test("press dispatches a key event to the focused element", async () => {
    await target.press("Enter", { testId: "key-input" });
    await expectEvent("keydown:Enter");
  });

  test("selectOption changes the select value", async () => {
    await target.selectOption({ selector: "#sel" }, "b");
    await expectEvent("change:sel=b");
    assert.strictEqual(await target.evaluate("document.getElementById('sel').value"), "b");
  });

  test("title and url reflect the page", async () => {
    assert.strictEqual(await target.title(), "find-repro cdp test page");
    assert.match(await target.url(), /main\.html$/);
  });

  test("content returns the live DOM", async () => {
    const html = await target.content();
    assert.match(html, /Unique Marker Text/);
    assert.match(html, /id="openwin"/);
  });

  test("screenshot returns a PNG buffer", async () => {
    const buf = await target.screenshot();
    assert.ok(Buffer.isBuffer(buf), "expected a Buffer");
    assert.ok(buf.length > 1000, `expected a non-trivial image, got ${buf.length} bytes`);
    assert.deepStrictEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]); // PNG signature
  });

  test("navigate loads a new url in the same target", async () => {
    await target.navigate(`${h.origin}/second.html`);
    await waitFor(async () => /second\.html$/.test(await target.url()), { message: "navigation to second.html" });
    assert.match(await target.content(), /Second Window/);
  });
});
