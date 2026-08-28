// W5c picture leg — provision the lane's people and the instance namespace
// THROUGH THE APP'S OWN SCREENS.
//
// The instance administrator is the first account, created through the app's
// own sign-up endpoint (the one the setup step's form posts to). The run owner
// and the bystander are ordinary accounts created the same way; neither is ever
// given a platform role. The instance namespace is typed into /setup/name, the
// screen that owns it, because an artifact cannot materialize before it is set.
//
// Every identity value comes from the environment. Nothing is written here.
//   env: APP_ORIGIN, ADMIN_EMAIL, ADMIN_PW, OWNER_EMAIL, OWNER_PW,
//        BYSTANDER_EMAIL, BYSTANDER_PW, INSTANCE_NAMESPACE,
//        INSTANCE_NAMESPACE_SLUG, OUT_JSON
import { chromium } from "@playwright/test";
import fs from "node:fs";

const APP = process.env.APP_ORIGIN;
const need = (n) => { const v = process.env[n]; if (!v) throw new Error(`01-lane-setup needs ${n}`); return v; };
const ADMIN = need("ADMIN_EMAIL"), ADMIN_PW = need("ADMIN_PW");
const OWNER = need("OWNER_EMAIL"), OWNER_PW = need("OWNER_PW");
const NS = need("INSTANCE_NAMESPACE");
const NAMESPACE = need("INSTANCE_NAMESPACE_SLUG");
need("APP_ORIGIN");

const browser = await chromium.launch();
const out = {};

async function signUp(ctx, email, password, name) {
  const r = await ctx.request.post(APP + "/api/auth/sign-up/email", {
    headers: { Origin: APP }, data: { email, password, name },
  });
  console.log(`${new Date().toISOString()} sign-up ${name} -> ${r.status()}`);
  if (r.ok()) return r.status();
  // RE-RUNNABLE. An account this driver already created answers the sign-up
  // form with a refusal, which is not a failure of the thing being provisioned
  // — the person exists. Signing in puts the session on this context so the
  // steps below (which need one) carry on against the SAME identity.
  const again = await ctx.request.post(APP + "/api/auth/sign-in/email", {
    headers: { Origin: APP }, data: { email, password },
  });
  console.log(`${new Date().toISOString()} sign-in ${name} -> ${again.status()}`);
  return again.status();
}

// 1. the instance administrator — the first account on a fresh instance
const adminCtx = await browser.newContext({ baseURL: APP, viewport: { width: 1440, height: 900 } });
await signUp(adminCtx, ADMIN, ADMIN_PW, "Ada Admin");
const adminPage = await adminCtx.newPage();
adminPage.setDefaultTimeout(300000);
adminPage.setDefaultNavigationTimeout(300000);

// 2. the instance namespace, typed into the screen that owns it
await adminPage.goto("/setup/name", { waitUntil: "domcontentloaded" });
await adminPage.waitForTimeout(6000);
const display = adminPage.locator("#instance-display-name");
if (await display.count()) {
  // BOTH FIELDS, AND THEN THE FORM'S OWN GATE. The display name auto-fills the
  // namespace, but the namespace is the field the Continue button is gated on
  // (`disabled = !isValid || pending`), so it is typed and blurred rather than
  // assumed — and the button is waited for instead of clicked at a timeout.
  await display.fill(NS);
  const namespaceField = adminPage.locator('#instance-name-form input[name="instanceNamespace"]');
  await namespaceField.fill(NAMESPACE);
  await namespaceField.blur();
  await adminPage.waitForTimeout(1500);
  const submit = adminPage.locator("#instance-name-form button[type=submit]").first();
  await submit.waitFor({ state: "visible" });
  for (let i = 0; i < 40 && (await submit.isDisabled()); i += 1) {
    await adminPage.waitForTimeout(1000);
  }
  console.log(`${new Date().toISOString()} Continue enabled=${!(await submit.isDisabled())}; namespace field holds ${JSON.stringify(await namespaceField.inputValue())}`);
  await submit.click();
  // The server action "can take seconds"; wait for what it DID rather than for
  // a stopwatch — the saved alert, or a page that has left this step.
  for (let i = 0; i < 60; i += 1) {
    await adminPage.waitForTimeout(2000);
    const path = new URL(adminPage.url()).pathname;
    const saved = await adminPage.getByText("Instance identity saved").count();
    if (saved > 0 || path !== "/setup/name") {
      console.log(`${new Date().toISOString()} /setup/name settled: saved=${saved > 0} path=${path}`);
      break;
    }
  }
  out.instanceIdentitySaved =
    (await adminPage.getByText("Instance identity saved").count()) > 0;
  console.log(`${new Date().toISOString()} /setup/name submitted; landed on ${new URL(adminPage.url()).pathname}; identity saved=${out.instanceIdentitySaved}`);
} else {
  console.log(`${new Date().toISOString()} /setup/name did not render its field; page is ${new URL(adminPage.url()).pathname}`);
}
out.adminLandedOn = new URL(adminPage.url()).pathname;

// 3. the ordinary accounts
const ownerCtx = await browser.newContext({ baseURL: APP });
out.ownerSignUp = await signUp(ownerCtx, OWNER, OWNER_PW, "Rita Owner");
if (process.env.BYSTANDER_EMAIL) {
  const byCtx = await browser.newContext({ baseURL: APP });
  out.bystanderSignUp = await signUp(byCtx, process.env.BYSTANDER_EMAIL, process.env.BYSTANDER_PW, "Ben Bystander");
  await byCtx.close();
}
await browser.close();
if (process.env.OUT_JSON) fs.writeFileSync(process.env.OUT_JSON, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
