// Run after connect-wordpress.mts. The frame performs its own authentication;
// the driver never reads or injects a widget credential.
import { chmod, stat, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { assertScreenshotFixtureRuntime } from "./lib/screenshot-capture.ts";

assertScreenshotFixtureRuntime();
const { values } = parseArgs({ options: {
  wordpress: { type: "string" }, "storage-state": { type: "string" }, evidence: { type: "string" },
} });
const state = values["storage-state"];
if (!state || ((await stat(state)).mode & 0o077)) throw new Error("A private authenticated --storage-state is required");
if (!values.wordpress || !values.evidence) throw new Error("--wordpress and --evidence are required");
const wordpress = new URL(values.wordpress);
if (!["http:", "https:"].includes(wordpress.protocol) || wordpress.username || wordpress.password) throw new Error("The CMS URL must be HTTP(S) without credentials");
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ storageState: state });
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);
  const response = await page.goto(`${wordpress.origin}/wp-admin/`, { waitUntil: "domcontentloaded" });
  if (!response?.ok()) throw new Error(`WordPress admin returned HTTP ${response?.status()}`);
  await page.locator('#cinatra-root[data-cinatra-mounted="true"]').waitFor({ state: "attached" });
  await page.locator(".cw-circle").click();
  const frame = page.frameLocator(".cw-frame");
  const active = '[data-embed-assistant][data-phase="active"]';
  const signedOut = '[data-embed-state="signin"]';
  await frame.locator(`${signedOut}, ${active}`).first().waitFor();
  console.log("The real CMS mounted the widget frame.");
  if (await frame.locator(signedOut).isVisible()) {
    const [popup] = await Promise.all([
      page.waitForEvent("popup"), frame.locator("[data-embed-signin]").click(),
    ]);
    // The existing first-party app session authorizes the popup. If it has
    // expired, fail here and refresh that session normally before retrying.
    if (!popup.isClosed()) await popup.waitForEvent("close", { timeout: 90_000 });
  }
  await frame.locator(active).waitFor();
  await frame.locator('[data-testid="chat-prompt-input"]').waitFor();
  await context.storageState({ path: state });
  await chmod(state, 0o600);
  await writeFile(values.evidence, JSON.stringify({
    capturedAt: new Date().toISOString(), wordpressOrigin: wordpress.origin,
    widgetFrame: "passed", evidence: "Real CMS mount, frame-owned sign-in popup, active assistant and visible composer",
    mediaRows: "not_checked",
  }, null, 2), { mode: 0o600 });
  console.log("The frame completed authentication and mounted its active composer.");
} finally {
  await browser.close();
}
