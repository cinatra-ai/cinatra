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

// `expectVersion`        — the version the SETTINGS surface must name (the row
//                          the lifecycle/settings seam resolves).
// `expectServingVersion` — the version whose MANIFEST must have produced the
//                          setup render. Defaults to `expectVersion`; they
//                          differ exactly when a newer row is present but has
//                          not activated, which is #2762 acceptance item 1.
const [
  mode,
  origin,
  email,
  password,
  outDir,
  label = mode,
  expectVersion = "",
  expectServingVersion = expectVersion,
] = process.argv.slice(2);
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

/** The version the image bundles. Anything else in play came from the lane
 *  registry. */
const BUNDLED_VERSION = "0.1.0";

/** What the placeholder must read for a given serving version.
 *
 *  The versions this lane publishes carry a `[lane v<x> from the registry]`
 *  stamp on that same declared placeholder (`publish-signed.mjs`,
 *  LANE_MANIFEST_MARK), because a newer version that renders identically to the
 *  bundled one cannot testify to which of the two actually served. With the
 *  stamp the setup surface NAMES the manifest that reached the render, so
 *  "the bundled implementation is still serving" is a visible fact rather than
 *  an inference. */
const placeholderFor = (version) =>
  !version || version === BUNDLED_VERSION
    ? DECLARED_PLACEHOLDER
    : `[lane v${version} from the registry] ${DECLARED_PLACEHOLDER}`;

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

/** `expectServingVersion` is the version whose MANIFEST must have produced this
 *  render. It is not always the version the settings surface names: when a
 *  newer row is present but unactivated, settings names the newer row while the
 *  bundled manifest is what actually serves, and telling those two apart is the
 *  whole point of #2762 acceptance item 1. */
async function assertDeclaredPlaceholder(tag, expectServingVersion = "") {
  // The dynamic-select for `calendarId`. With no Google Calendar connection in
  // this lane the options action returns nothing, which is exactly the state
  // that renders the declared placeholder.
  const empty = page.locator('[data-testid="dynamic-select-empty"]');
  await empty.first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
  const count = await empty.count();
  check(`${tag}: the dynamic-select empty slot renders`, count > 0);
  if (count === 0) return;
  const text = (await empty.first().innerText()).trim();
  const want = placeholderFor(expectServingVersion);
  check(
    `${tag}: the DECLARED placeholder renders (not the "No options available." fallback)`,
    text.endsWith(DECLARED_PLACEHOLDER),
    `rendered: ${JSON.stringify(text.slice(0, 180))}`,
  );
  const servedByBundle = !text.startsWith("[lane v");
  say(
    `setup surface is rendering the ${servedByBundle ? "BUNDLED" : "REGISTRY"} manifest` +
      (servedByBundle ? "" : ` (${/\[lane (v[\d.]+)/.exec(text)?.[1] ?? "?"})`),
  );
  if (expectServingVersion) {
    check(
      `${tag}: the setup surface renders the manifest of the SERVING version ${expectServingVersion}`,
      text === want,
      `rendered ${JSON.stringify(text.slice(0, 180))}`,
    );
  }
  return { renderedPlaceholder: text, servedByBundle };
}

/** Read every lifecycle affordance the settings surface renders, and say for
 *  each one whether the application enabled it and, when it did not, the reason
 *  the application itself printed.
 *
 *  This surface carries no `data-testid`. It is addressed the way it is built:
 *  `data-slot` for the containers and the disabled variant, accessible button
 *  text for the actions (`extension-settings-view.tsx`,
 *  `extension-settings-actions.tsx`). A disabled action renders
 *  `button[data-slot="disabled-action"][data-disabled-reason]`, and a reason
 *  that came from the SERVER capability is also printed visibly in
 *  `p[data-slot="lifecycle-capability-reason"]` — which is what puts
 *  "More than one install matches your scope" on the screen. */
async function auditLifecycleActions(tag, expectEnabled = []) {
  const root = page.locator('main[data-surface-id="extension-settings"]');
  check(`${tag}: the extension settings surface mounted`, (await root.count()) > 0);

  // Bring the maintenance + danger-zone blocks into view so the capture SHOWS
  // the buttons the assertion talks about, rather than proving them off-screen.
  for (const slot of ["settings-maintenance", "settings-danger-zone"]) {
    const el = page.locator(`[data-slot="${slot}"]`).first();
    if ((await el.count()) > 0) await el.scrollIntoViewIfNeeded().catch(() => {});
  }
  await page.waitForTimeout(400);

  const buttons = await page.evaluate(() => {
    const scope = document.querySelector('main[data-surface-id="extension-settings"]');
    if (!scope) return [];
    return [...scope.querySelectorAll("button")].map((b) => ({
      label: (b.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60),
      disabled: b.disabled === true || b.getAttribute("aria-disabled") === "true",
      slot: b.getAttribute("data-slot"),
      reason: b.getAttribute("data-disabled-reason"),
    }));
  });
  const visibleReasons = await page.evaluate(() =>
    [...document.querySelectorAll('[data-slot="lifecycle-capability-reason"]')].map((p) =>
      (p.textContent ?? "").trim(),
    ),
  );

  say(`lifecycle buttons: ${JSON.stringify(buttons)}`);
  say(`visible capability reasons: ${JSON.stringify(visibleReasons)}`);

  // The regression the owner's own capture recorded: a successful install left
  // every lifecycle action denied as ambiguous. It must not come back.
  const ambiguous = visibleReasons.some((r) => /More than one install matches your scope/i.test(r));
  check(
    `${tag}: no lifecycle action is denied as "More than one install matches your scope"`,
    !ambiguous,
    ambiguous ? `reasons: ${JSON.stringify(visibleReasons)}` : "no ambiguity reason rendered",
  );

  for (const want of expectEnabled) {
    const hit = buttons.find((b) => b.label.toLowerCase().startsWith(want.toLowerCase()));
    check(
      `${tag}: "${want}" is rendered and ENABLED`,
      hit !== undefined && hit.disabled === false,
      hit === undefined ? "not rendered at all" : `disabled=${hit.disabled} reason=${hit.reason ?? "none"}`,
    );
  }
  await shot(page, "lifecycle-actions");
  return { buttons, visibleReasons };
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
  const placeholder = await assertDeclaredPlaceholder(label, expectServingVersion);
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

  // --- the LIFECYCLE affordances on that same settings surface ---
  // `Archive` and `Reinstall latest` must be live: they are the two the owner's
  // own capture showed denied as ambiguous after a successful install. The
  // `Activate` row is READ rather than demanded — on a row that is already
  // active the honest render is a status-tier "Already active", which is a
  // correct denial and not the ambiguity defect.
  const lifecycle = await auditLifecycleActions(label, ["Archive", "Reinstall latest"]);

  // --- a UI action driven explicitly against the row the setup surface chose ---
  if (setupInstallId) {
    await assertUiActionNot404(label, setupInstallId, "listAppointmentSchedules");
  }

  writeFileSync(
    path.join(outDir, `${label}-resolution.json`),
    JSON.stringify(
      {
        setupInstallId,
        settingsVersion,
        expectVersion,
        expectServingVersion,
        placeholder,
        setupCalls,
        lifecycle,
      },
      null,
      2,
    ),
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
    // ---------------------------------------------------------------------
    // The refusal path.
    //
    // This surface announces a failed install as a TOAST and keeps the panel
    // open, unredrawn, by design: "a failed install neither redraws the panel
    // with an error state nor grows its height"
    // (`extension-install-scope-panel.tsx`, the file's own header). The
    // in-panel `extension-install-panel-error` node is `sr-only` — real, but
    // invisible, so it cannot carry a screenshot.
    //
    // The toast is therefore the ONLY visible refusal UI, and it is mounted
    // with `duration={8000}` (`src/app/providers.tsx`). An earlier revision of
    // this driver slept 20s and then captured, i.e. it captured the screen
    // AFTER the toast had already gone — which is why that capture was
    // byte-identical to the open panel and carried no proof at all. The
    // capture below waits for the toast to be VISIBLE and shoots it there.
    // ---------------------------------------------------------------------
    const toast = page.locator('[data-sonner-toast][data-type="error"]').first();
    let toastText = "";
    let toastSeen = false;
    try {
      await toast.waitFor({ state: "visible", timeout: 180_000 });
      toastSeen = true;
      toastText = (await toast.innerText()).trim();
    } catch {
      toastSeen = false;
    }
    check(
      `${label}: the refusal is announced in a visible error toast`,
      toastSeen,
      toastSeen ? JSON.stringify(toastText.slice(0, 200)) : "no error toast became visible",
    );
    // Capture WHILE the toast is on screen. `fullPage` is deliberately off
    // here: the toast is a fixed-position overlay, and a full-page capture of
    // a scrolling document does not reliably contain it.
    const refusedFile = path.join(outDir, `${label}-install-refused.png`);
    await page.screenshot({ path: refusedFile });
    say(`screenshot: ${path.basename(refusedFile)}`);

    check(
      `${label}: a refused install does NOT redirect to the installed list`,
      !page.url().includes("/configuration/extensions"),
      `still on ${page.url()}`,
    );
    const panelStillOpen = await page
      .locator('[data-testid="extension-install-panel-body"]')
      .count();
    check(
      `${label}: the install panel stays open after the refusal`,
      panelStillOpen > 0,
      `panel bodies: ${panelStillOpen}`,
    );
    const alert = page.locator('[data-testid="extension-install-panel-error"]');
    const alertText = (await alert.count()) > 0 ? (await alert.first().innerText()).trim() : "";
    say(`refusal announced to assistive tech: ${JSON.stringify(alertText.slice(0, 200))}`);
    say(`refusal toast text: ${JSON.stringify(toastText.slice(0, 300))}`);
    writeFileSync(
      path.join(outDir, `${label}-refusal.json`),
      JSON.stringify({ toastSeen, toastText, srOnlyAlertText: alertText, url: page.url() }, null, 2),
      "utf8",
    );
  }
}

writeFileSync(path.join(outDir, `${label}-driver.txt`), lines.join("\n") + "\n", "utf8");
await browser.close();
say(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} (mode=${mode}, label=${label})`);
writeFileSync(path.join(outDir, `${label}-driver.txt`), lines.join("\n") + "\n", "utf8");
process.exit(failures === 0 ? 0 : 1);
