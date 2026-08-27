// Provision the instance's namespace THROUGH THE APP'S OWN setup step
// (/setup/name). Without it the marketplace refuses to materialize an
// extension's registry identity ("Instance namespace is not configured").
// Nothing is written to the database here: the app's own server action does it.
import { chromium } from "@playwright/test";

const BASE = process.env.WALK_BASE;
const EMAIL = process.env.LANE_ACCOUNT;
const PASSWORD = process.env.LANE_SECRET;
const DISPLAY = process.env.LANE_INSTANCE_NAME;
for (const [n, v] of Object.entries({ WALK_BASE: BASE, LANE_ACCOUNT: EMAIL, LANE_SECRET: PASSWORD, LANE_INSTANCE_NAME: DISPLAY }))
  if (!v) throw new Error(`instance-namespace needs ${n}`);

const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: BASE });
const page = await context.newPage();
page.setDefaultTimeout(180_000);
page.setDefaultNavigationTimeout(180_000);
const signIn = await page.request.post("/api/auth/sign-in/email", { headers: { Origin: BASE }, data: { email: EMAIL, password: PASSWORD } });
console.log(signIn.ok() ? "PASS signed in" : `FAIL sign-in ${signIn.status()}`);
if (!signIn.ok()) process.exit(1);

await page.goto("/setup/name", { waitUntil: "domcontentloaded" });
console.log(`PASS reached ${new URL(page.url()).pathname}`);
const inputs = page.locator('input[type="text"], input:not([type])');
const n = await inputs.count();
console.log(`inputs on the step: ${n}`);
if (n === 0) { console.log("FAIL no field on the step"); await browser.close(); process.exit(1); }
await inputs.first().fill(DISPLAY);
await page.waitForTimeout(1500);
for (let i = 0; i < n; i += 1) {
  const v = await inputs.nth(i).inputValue().catch(() => "");
  console.log(`  field ${i}: ${JSON.stringify(v)}`);
}
const cont = page.getByRole("button", { name: /continue/i });
await cont.first().click();
await page.waitForTimeout(6000);
console.log(`PASS after Continue the app is on ${new URL(page.url()).pathname}`);
await browser.close();
