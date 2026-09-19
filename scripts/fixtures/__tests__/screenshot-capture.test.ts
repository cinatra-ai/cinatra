import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { assertScreenshotFixtureRuntime, captureScreenshot } from "../lib/screenshot-capture.ts";

test("capture records the browser's redirected URL, viewport, time and actual PNG", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { location: "/rendered" }).end(); return; }
    res.setHeader("content-type", "text/html");
    res.end('<html><body style="background:#284b63;color:white"><h1 data-ready>Screenshot producer proof</h1></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${address.port}/redirect`);
    const before = Date.now();
    const capture = await captureScreenshot(page, "[data-ready]");
    assert.equal(capture.facts.capturedUrl, `http://127.0.0.1:${address.port}/rendered`);
    assert.deepEqual(capture.facts.viewport, { width: 640, height: 480 });
    assert.ok(Date.parse(capture.facts.capturedAt) >= before && Date.parse(capture.facts.capturedAt) <= Date.now());
    assert.equal(capture.bytes.readUInt32BE(16), 640);
    assert.equal(capture.bytes.readUInt32BE(20), 480);
    assert.ok(capture.bytes.length > 1000);
    // A capture whose facts changed while taking pixels must never be filed.
    const screenshot = page.screenshot.bind(page);
    page.screenshot = async (options) => {
      const bytes = await screenshot(options);
      await page.setViewportSize({ width: 800, height: 600 });
      return bytes;
    };
    await assert.rejects(captureScreenshot(page, "[data-ready]"), /navigated or resized/);
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("the development producer refuses unset, misspelled and production runtime modes", () => {
  for (const mode of [undefined, "production", "prod", "developmnt"]) {
    assert.throws(() => assertScreenshotFixtureRuntime({ CINATRA_RUNTIME_MODE: mode }), /require.*development/);
  }
  assert.doesNotThrow(() => assertScreenshotFixtureRuntime({ CINATRA_RUNTIME_MODE: "development", NODE_ENV: "production" }));
});
