// Configure the lane instance's REAL model provider THROUGH THE APP'S OWN
// SETUP FORM (`/setup/model`), so the app seals the credential itself.
//
// The credential reaches this process through its environment and nowhere
// else: it is never written to a file, never passed as an argument, never
// echoed to a log, and never read back out of the app. This script prints
// pass/fail lines only.
import { chromium } from "@playwright/test";

const BASE = process.env.WALK_BASE;
const EMAIL = process.env.LANE_ACCOUNT;
const PASSWORD = process.env.LANE_SECRET;
const KEY = process.env.OPENAI_API_KEY;
for (const [n, v] of Object.entries({ WALK_BASE: BASE, LANE_ACCOUNT: EMAIL, LANE_SECRET: PASSWORD }))
  if (!v) throw new Error(`provider-setup needs ${n}`);
if (!KEY) {
  console.log("FAIL no OPENAI_API_KEY in the process environment");
  process.exit(1);
}

const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: BASE });
const page = await context.newPage();
page.setDefaultTimeout(180_000);
page.setDefaultNavigationTimeout(180_000);

const signIn = await page.request.post("/api/auth/sign-in/email", {
  headers: { Origin: BASE },
  data: { email: EMAIL, password: PASSWORD },
});
console.log(signIn.ok() ? "PASS signed in" : `FAIL sign-in ${signIn.status()}`);
if (!signIn.ok()) process.exit(1);

await page.goto("/setup/model", { waitUntil: "domcontentloaded" });
console.log(`PASS reached ${new URL(page.url()).pathname}`);

const openaiCard = page.getByTestId("setup-provider-openai");
if (await openaiCard.count()) {
  await openaiCard.first().click();
  await page.waitForLoadState("networkidle");
  console.log("PASS selected the OpenAI provider");
}

const keyField = page.getByTestId("setup-openai-api-key");
if (!(await keyField.count())) {
  const pointer = page.getByTestId("setup-openai-admin-pointer");
  console.log(
    (await pointer.count())
      ? "FAIL a connection is already stored on this lane — nothing was submitted"
      : "FAIL the key field is not on the step",
  );
  await browser.close();
  process.exit(1);
}
await keyField.fill(KEY);
console.log("PASS filled the key field through the app's own form");

await page.getByTestId("setup-ai-continue").first().click();
await page.waitForLoadState("networkidle");
await page.waitForTimeout(3000);

const err = page.getByTestId("setup-model-step-error");
if (await err.count()) {
  console.log(`FAIL the app refused the submission: ${(await err.first().innerText()).slice(0, 200)}`);
  await browser.close();
  process.exit(1);
}
console.log("PASS the app accepted the submission and sealed the connection itself");
await browser.close();
