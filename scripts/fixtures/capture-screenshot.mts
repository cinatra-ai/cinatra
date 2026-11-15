// Development operator fixture. No production route, injected facts, or mock PNG.
// Run with: node --env-file=.env.local scripts/fixtures/capture-screenshot.mjs
//   --org ... --run ... --url ...
//   --ready '[data-testid="..."]' --title ... --output capture-light
import { parseArgs } from "node:util";
import { stat } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { assertScreenshotFixtureRuntime, captureScreenshot } from "./lib/screenshot-capture.ts";

assertScreenshotFixtureRuntime();
const { values } = parseArgs({ options: Object.fromEntries([
  "org", "run", "url", "ready", "title", "output", "storage-state", "palette", "width", "height",
].map((name) => [name, { type: "string" as const }])) });
function required(name: string) {
  const value = values[name];
  if (!value?.trim()) throw new Error(`--${name} is required`);
  return value;
}
const width = Number(values.width ?? 1440), height = Number(values.height ?? 1000);
if (![width, height].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 4096)) throw new Error("Viewport dimensions must be integers from 1 to 4096");
const palette = values.palette ?? "light";
if (palette !== "light" && palette !== "dark") throw new Error("--palette must be light or dark");
const url = new URL(required("url"));
if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("--url must be HTTP(S), without credentials");
if (values["storage-state"] && ((await stat(values["storage-state"])).mode & 0o077)) throw new Error("Browser storage state must be private (chmod 600)");
const { prepareScreenshotProducer } = await import("./lib/file-screenshot.ts");
const file = await prepareScreenshotProducer(required("run"), required("org"));
const ready = required("ready"), title = required("title"), output = required("output");
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: palette,
    ...(values["storage-state"] ? { storageState: values["storage-state"] } : {}),
  });
  const page = await context.newPage();
  const response = await page.goto(url.href, { waitUntil: "domcontentloaded" });
  if (!response?.ok()) throw new Error(`Capture navigation failed (HTTP ${response?.status() ?? "none"})`);
  const capture = await captureScreenshot(page, ready);
  const result = await file(capture, output, title);
  console.log(JSON.stringify({ ...result, facts: result.deduped ? undefined : capture.facts, palette }));
} finally {
  await browser.close();
}
