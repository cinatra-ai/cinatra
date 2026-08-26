// Set the instance's PUBLIC ORIGIN through the app's own UI
// (/configuration/development?tab=tunnel) — never by hand-editing the
// database. The origin itself is read from the environment so it appears in no
// file here. Prints pass/fail lines and the app's own readback.
import { chromium } from "@playwright/test";

const BASE = process.env.WALK_BASE;
const EMAIL = process.env.LANE_ACCOUNT;
const PASSWORD = process.env.LANE_SECRET;
const ORIGIN = process.env.LANE_PUBLIC_ORIGIN;
for (const [n, v] of Object.entries({
  WALK_BASE: BASE,
  LANE_ACCOUNT: EMAIL,
  LANE_SECRET: PASSWORD,
  LANE_PUBLIC_ORIGIN: ORIGIN,
}))
  if (!v) throw new Error(`set-public-origin needs ${n}`);

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

await page.goto("/configuration/development?tab=tunnel", { waitUntil: "domcontentloaded" });
const field = page.locator("#publicBaseUrl");
await field.waitFor();
await field.fill(ORIGIN);
console.log("PASS typed the origin into the tab's own field");
const save = page.getByRole("button", { name: "Save", exact: true });
await save.click();
await page.waitForTimeout(4000);

// The app's OWN readback: the settings endpoint every external client reads.
const settings = await page.request.get("/api/mcp-settings");
const body = await settings.json().catch(() => null);
const stored = body?.publicBaseUrl ?? body?.publicUrl ?? body?.url ?? null;
console.log(`PASS /api/mcp-settings answered ${settings.status()}`);
console.log(
  stored && String(stored).startsWith(ORIGIN)
    ? "PASS the app reads its public origin back as the one just saved"
    : `FAIL the app's readback does not match what was saved (${JSON.stringify(body)?.slice(0, 200)})`,
);
await browser.close();
