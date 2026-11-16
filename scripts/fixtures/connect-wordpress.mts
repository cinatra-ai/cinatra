// Exercises the CMS-owned PKCE ceremony. Never seeds cnx_/cwu_ credentials.
import { chmod, stat, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { assertScreenshotFixtureRuntime } from "./lib/screenshot-capture.ts";

assertScreenshotFixtureRuntime();
const { values } = parseArgs({ options: {
  app: { type: "string" }, wordpress: { type: "string" },
  "storage-state": { type: "string" }, evidence: { type: "string" },
  "connector-instance": { type: "string" },
} });
function origin(value: string | undefined, flag: string) {
  if (!value) throw new Error(`--${flag} is required`);
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.href !== `${parsed.origin}/`) {
    throw new Error(`--${flag} must be an HTTP(S) origin without credentials`);
  }
  return parsed.origin;
}
const app = origin(values.app, "app"), wordpress = origin(values.wordpress, "wordpress");
if (app === wordpress) throw new Error("The CMS must be a third-party origin");
const state = values["storage-state"];
if (!state || ((await stat(state)).mode & 0o077)) throw new Error("--storage-state must name a private (0600) authenticated Cinatra browser state");
const password = process.env.WIDGET_WP_PASSWORD;
if (!password) throw new Error("WIDGET_WP_PASSWORD is required in the environment");
if (!values.evidence) throw new Error("--evidence is required (outside the product tree)");
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ storageState: state });
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);
  await page.goto(`${wordpress}/wp-login.php`);
  await page.locator("#user_login").fill(process.env.WIDGET_WP_USER ?? "admin");
  await page.locator("#user_pass").fill(password);
  await Promise.all([page.waitForURL(/\/wp-admin\//, { waitUntil: "domcontentloaded" }), page.locator("#wp-submit").click()]);
  console.log("WordPress administrator signed in.");
  const settings = await page.goto(`${wordpress}/wp-admin/options-general.php?page=cinatra`, { waitUntil: "domcontentloaded" });
  if (!settings?.ok()) throw new Error(`WordPress settings returned HTTP ${settings?.status()}; check plugin activation and readable mount permissions`);
  await page.locator("#cinatra_connect_url").fill(app);
  await Promise.all([
    page.waitForURL((url) => url.origin === app && url.pathname === "/connect/authorize", { waitUntil: "domcontentloaded" }),
    page.getByRole("button", { name: "Connect with Cinatra", exact: true }).click(),
  ]);
  console.log("The CMS opened the application's PKCE authorization page.");
  const authorization = new URL(page.url());
  if (authorization.searchParams.get("client") !== "wordpress" || authorization.searchParams.get("code_challenge_method") !== "S256") throw new Error("The CMS did not initiate the expected PKCE ceremony");
  const callback = new URL(authorization.searchParams.get("redirect_uri") ?? "");
  if (callback.origin !== wordpress || callback.pathname !== "/wp-admin/admin-post.php") throw new Error("The authorization callback is not the fixture CMS");
  // Wait for React to attach the server-action form. A native form POST made
  // before hydration carries Origin:null under this page's no-referrer policy
  // and is correctly rejected by Next's Server Actions origin check.
  await page.waitForFunction(() => Array.from(document.querySelectorAll("form")).some((form) =>
    Object.keys(form).some((key) => key.startsWith("__reactProps$") &&
      typeof (form as unknown as Record<string, { action?: unknown }>)[key]?.action === "function"),
  ));
  await Promise.all([
    page.waitForURL((url) => url.origin === wordpress && url.pathname.endsWith("/options-general.php"), { waitUntil: "domcontentloaded" }),
    page.getByRole("button", { name: "Approve", exact: true }).click(),
  ]);
  // This notice is emitted only AFTER WordPress redeems the code server-side
  // at /api/connect/token and stores the returned credential. No token is read.
  await page.getByText("Connected to Cinatra. The integration credential is stored on this server.", { exact: true }).waitFor();
  const connectorInstance = values["connector-instance"]?.trim();
  if (connectorInstance) {
    // The connection response's installation identity is NOT the WordPress
    // connector instance the frame resolves. Save the selected real instance
    // through the CMS's own settings form, preserving the sealed credential.
    await page.locator("#cinatra_instance_id").fill(connectorInstance);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.getByRole("button", { name: "Save Changes", exact: true }).click(),
    ]);
    if (await page.locator("#cinatra_instance_id").inputValue() !== connectorInstance) throw new Error("WordPress did not save the connector instance selection");
  }
  await context.storageState({ path: state });
  await chmod(state, 0o600);
  await writeFile(values.evidence, JSON.stringify({
    capturedAt: new Date().toISOString(), appOrigin: app, wordpressOrigin: wordpress,
    client: "wordpress", pkce: "S256", siteConnection: "passed",
    connectorInstanceId: connectorInstance ?? null,
    evidence: "CMS success notice after real server-to-server token exchange",
    // Frame authorization and per-kind rendering are separate acceptance cells.
    widgetFrame: "not_checked", mediaRows: "not_checked",
  }, null, 2), { mode: 0o600 });
  console.log("WordPress completed the PKCE connection and server-side token exchange.");
} finally {
  await browser.close();
}
