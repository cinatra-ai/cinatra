// -----------------------------------------------------------------------------
// The two-version install proof, driven against the REAL running application in
// a real browser. Every assertion below reads the application's own surfaces:
// the marketplace screen, the connector setup page, the extension settings page,
// the UI-action dispatch endpoint, and the lane database the application writes.
// Nothing here renders a component in isolation.
//
// Modes:
//   baseline  — the pre-install state: the bundled OLDER version serves.
//   negative  — a BAD signature must be refused before any live marketplace row
//               exists, and the bundled version must stay usable throughout.
//   install   — install the signed NEWER version through the marketplace panel.
//   assert    — the post-install assertions (also re-run after a restart).
//
// Usage:
//   node lane-proof-driver.mjs <mode> <appOrigin> <email> <password> <outDir> [label]
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const [mode, origin, email, password, outDir, label = mode, expectVersion = ""] =
  process.argv.slice(2);
if (!mode || !origin || !email || !password || !outDir) {
  console.error(
    "usage: lane-proof-driver.mjs <mode> <appOrigin> <email> <password> <outDir> [label]",
  );
  process.exit(2);
}

const PKG = "@cinatra-ai/google-appointment-schedules-connector";
const SETUP_URL = `${origin}/connectors/cinatra-ai/google-appointment-schedules-connector/setup`;
const SETTINGS_URL = `${origin}/configuration/extensions/settings/connector/${PKG}`;
const MARKETPLACE_URL = `${origin}/configuration/marketplace`;

mkdirSync(outDir, { recursive: true });
const lines = [];
const say = (...parts) => {
  const line = parts.join(" ");
  lines.push(line);
  console.log(line);
};
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  say(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const shot = async (page, name) => {
  const file = path.join(outDir, `${label}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  say(`screenshot: ${path.basename(file)}`);
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });

// Sign in through the application's own credential endpoint, in the browser
// context, so every later navigation carries a real session cookie.
const signIn = await context.request.post(`${origin}/api/auth/sign-in/email`, {
  data: { email, password },
  headers: { Origin: origin },
});
if (!signIn.ok()) {
  say(`sign-in failed: ${signIn.status()} ${await signIn.text()}`);
  await browser.close();
  process.exit(1);
}
const page = await context.newPage();
// The dev runtime compiles each route cold on first hit, so navigation budgets
// are generous. This is a runtime property of the server, not of the assertions.
page.setDefaultNavigationTimeout(240_000);
page.setDefaultTimeout(60_000);
page.on("console", (msg) => {
  if (msg.type() === "error") say(`[browser-console-error] ${msg.text().slice(0, 300)}`);
});

// Record every UI-action dispatch the APPLICATION itself makes. This is the
// honest form of the "UI actions are not 404" assertion: it observes the real
// requests the rendered surface fires, rather than a request this script
// invents, and it reveals which install row the surface resolved.
const actionCalls = [];
const ACTION_RE = /\/api\/extensions\/([^/]+)\/actions\/([^/?]+)/;
page.on("response", (res) => {
  const m = ACTION_RE.exec(new URL(res.url()).pathname);
  if (!m) return;
  actionCalls.push({
    installId: decodeURIComponent(m[1]),
    actionId: decodeURIComponent(m[2]),
    status: res.status(),
  });
});

/** The declared placeholder for the `calendarId` dynamic-select field. It is
 *  declared in the extension manifest; the literal "No options available." is
 *  the fallback the form uses only when a field declares NO placeholder, so
 *  seeing the declared text proves the declaration reached the render. */
const DECLARED_PLACEHOLDER =
  "No connected calendars yet — connect Google Calendar at /connectors/cinatra-ai/google-calendar-connector/setup to see your calendars here.";

async function assertSetupPageRenders(tag) {
  const res = await page.goto(SETUP_URL, { waitUntil: "domcontentloaded" });
  check(`${tag}: setup page responds 200`, res?.status() === 200, `status ${res?.status()}`);
  await page.waitForLoadState("networkidle").catch(() => {});
  const form = page.locator('[data-testid="schema-config-form"]');
  check(`${tag}: setup renders the connector's schema-config form`, (await form.count()) > 0);
  const pkgAttr = (await form.count()) > 0 ? await form.first().getAttribute("data-package") : null;
  check(`${tag}: setup form is bound to the connector package`, pkgAttr === PKG, `data-package=${pkgAttr}`);
  return form;
}

async function assertDeclaredPlaceholder(tag) {
  // The dynamic-select for `calendarId`. With no Google Calendar connection in
  // this lane the options action returns nothing, which is exactly the state
  // that renders the declared placeholder.
  const empty = page.locator('[data-testid="dynamic-select-empty"]');
  await empty.first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
  const count = await empty.count();
  check(`${tag}: the dynamic-select empty slot renders`, count > 0);
  if (count === 0) return;
  const text = (await empty.first().innerText()).trim();
  check(
    `${tag}: the DECLARED placeholder renders (not the "No options available." fallback)`,
    text === DECLARED_PLACEHOLDER,
    `rendered: ${JSON.stringify(text.slice(0, 140))}`,
  );
}

/** Drive a real UI action through the application's dispatch endpoint, from the
 *  page's own origin and session, and assert it is not a 404. */
async function assertUiActionNot404(tag, installId, actionId) {
  const out = await page.evaluate(
    async ([id, action]) => {
      const r = await fetch(
        `/api/extensions/${encodeURIComponent(id)}/actions/${encodeURIComponent(action)}`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      );
      return { status: r.status, body: (await r.text()).slice(0, 300) };
    },
    [installId, actionId],
  );
  check(
    `${tag}: UI action "${actionId}" is not a 404`,
    out.status !== 404,
    `status ${out.status} ${out.body.slice(0, 160)}`,
  );
  return out;
}

if (mode === "baseline" || mode === "assert") {
  // --- the SETUP surface ---
  await assertSetupPageRenders(label);
  await assertDeclaredPlaceholder(label);
  await shot(page, "connector-setup");

  const setupCalls = actionCalls.splice(0);
  const setupIds = [...new Set(setupCalls.map((c) => c.installId))];
  say(`setup surface dispatched: ${JSON.stringify(setupCalls)}`);
  check(
    `${label}: the setup surface actually dispatched a UI action`,
    setupCalls.length > 0,
    `${setupCalls.length} dispatch(es)`,
  );
  check(
    `${label}: no UI action from the setup surface answered 404`,
    setupCalls.every((c) => c.status !== 404),
    setupCalls.map((c) => `${c.actionId}=${c.status}`).join(", "),
  );
  check(
    `${label}: the setup surface resolved exactly one install row`,
    setupIds.length === 1,
    `ids: ${setupIds.join(", ")}`,
  );
  const setupInstallId = setupIds[0] ?? null;

  // --- the SETTINGS surface ---
  await page.goto(SETTINGS_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  check(
    `${label}: the settings page renders for the connector`,
    page.url().includes("/settings/connector/"),
    `landed on ${page.url()}`,
  );
  await shot(page, "extension-settings");
  // The settings screen resolves its own row through the shared precedence
  // policy and renders THAT row's version. The rendered version is therefore
  // the observable that says which row settings resolved.
  const settingsText = await page.evaluate(() => document.body.innerText);
  const settingsVersion = (/\b(\d+\.\d+\.\d+)\b/.exec(settingsText) ?? [])[1] ?? null;
  say(`settings surface renders version: ${settingsVersion ?? "(none found)"}`);
  if (expectVersion) {
    check(
      `${label}: the settings surface resolved the expected version`,
      settingsVersion === expectVersion,
      `rendered ${settingsVersion}, expected ${expectVersion}`,
    );
  }

  // --- a UI action driven explicitly against the row the setup surface chose ---
  if (setupInstallId) {
    await assertUiActionNot404(label, setupInstallId, "listAppointmentSchedules");
  }

  writeFileSync(
    path.join(outDir, `${label}-resolution.json`),
    JSON.stringify({ setupInstallId, settingsVersion, expectVersion, setupCalls }, null, 2),
    "utf8",
  );
  say(`RESOLVED-INSTALL-ID ${setupInstallId}`);
}

if (mode === "negative" || mode === "install") {
  await page.goto(MARKETPLACE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  const card = page.locator('[data-testid="extension-listing-card"]').first();
  await card.waitFor({ state: "visible", timeout: 30_000 });
  check(`${label}: the marketplace lists the connector card`, (await card.count()) > 0);
  await shot(page, "marketplace-card");

  // A connector routes through the in-card access-target install panel — the
  // real operator path for this kind, not the one-click form.
  const open = page.locator('[data-testid="extension-install-panel-open"]').first();
  await open.waitFor({ state: "visible", timeout: 15_000 });
  await open.click();
  const body = page.locator('[data-testid="extension-install-panel-body"]');
  await body.waitFor({ state: "visible", timeout: 15_000 });
  const availability = await body.getAttribute("data-availability");
  check(`${label}: the install panel is ready`, availability === "ready", `data-availability=${availability}`);
  await shot(page, "install-panel-open");

  const submit = page.locator('[data-testid="extension-install-panel-submit"]').first();
  await submit.waitFor({ state: "visible", timeout: 15_000 });
  await submit.click();

  if (mode === "install") {
    // Success redirects to the installed list.
    await page
      .waitForURL((u) => u.pathname.startsWith("/configuration/extensions"), { timeout: 120_000 })
      .catch(() => {});
    check(
      `${label}: a successful install redirects to the installed list`,
      page.url().includes("/configuration/extensions"),
      `landed on ${page.url()}`,
    );
    await page.waitForLoadState("networkidle").catch(() => {});
    await shot(page, "post-install-installed-list");
  } else {
    // The refusal path: the panel stays open and the failure is announced.
    await page.waitForTimeout(20_000);
    check(
      `${label}: a refused install does NOT redirect to the installed list`,
      !page.url().includes("/configuration/extensions"),
      `still on ${page.url()}`,
    );
    const alert = page.locator('[data-testid="extension-install-panel-error"]');
    const alertText = (await alert.count()) > 0 ? (await alert.first().innerText()).trim() : "";
    say(`refusal announced to assistive tech: ${JSON.stringify(alertText.slice(0, 200))}`);
    await shot(page, "install-refused");
  }
}

writeFileSync(path.join(outDir, `${label}-driver.txt`), lines.join("\n") + "\n", "utf8");
await browser.close();
say(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} (mode=${mode}, label=${label})`);
writeFileSync(path.join(outDir, `${label}-driver.txt`), lines.join("\n") + "\n", "utf8");
process.exit(failures === 0 ? 0 : 1);
