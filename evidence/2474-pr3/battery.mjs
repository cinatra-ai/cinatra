/**
 * cinatra#2474 PR3 — the LIVE conformance battery for the unified Add-dashboard
 * popup.
 *
 * Drives a real Chromium against a REAL running dev server on this branch, with
 * REAL authenticated sessions (a scope MANAGER and a plain MEMBER), and asserts
 * against the ratified design spec `specs/app-artifacts.html` §IX / §IX.1 /
 * §IX.2 / §X @ design@60cf789ec9b6d6455148a086cacc6ae43f447cef.
 *
 * Every assertion is a live DOM / computed-style / GEOMETRY probe — measured,
 * never eyeballed off a screenshot. Screenshots are recorded alongside as
 * context, not as the evidence.
 *
 *   node evidence/2474-pr3/battery.mjs
 *
 * Environment (all local, all throwaway):
 *   LANE_BASE      the dev server origin (default http://localhost:3477)
 *   LANE_FIXTURES  path to the fixtures JSON written by the lane's fixture step
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";

const BASE = process.env.LANE_BASE ?? "http://localhost:3477";
const FIXTURES = JSON.parse(readFileSync(process.env.LANE_FIXTURES, "utf8"));
const OUT = path.resolve(process.env.LANE_EVIDENCE ?? "evidence/2474-pr3");
mkdirSync(OUT, { recursive: true });

const results = [];
let shot = 0;
function record(id, assertion, pass, observed) {
  results.push({ id, assertion, result: pass ? "PASS" : "FAIL", observed });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${assertion}\n        ${observed}`);
}

const consoleErrors = [];
const pageErrors = [];

async function capture(page, name) {
  const file = path.join(OUT, `${String(++shot).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return path.basename(file);
}

async function signIn(context, email, password) {
  const page = await context.newPage();
  wire(page);
  const res = await page.request.post(`${BASE}/api/auth/sign-in/email`, {
    headers: { "content-type": "application/json", origin: BASE },
    data: { email, password },
  });
  if (!res.ok()) throw new Error(`sign-in ${email} -> ${res.status()}`);
  // Switch the session's ACTIVE organization to the fixture org through the
  // app's own endpoint — the org landing's tenant fence (cinatra#2474 PR2) is
  // read off exactly this axis, so the proof must exercise the real switch.
  const active = await page.request.post(`${BASE}/api/auth/organization/set-active`, {
    headers: { "content-type": "application/json", origin: BASE },
    data: { organizationId: FIXTURES.orgId },
  });
  if (!active.ok()) throw new Error(`set-active ${email} -> ${active.status()} ${await active.text()}`);
  return page;
}

function wire(page) {
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(`${page.url()} :: ${m.text()}`);
  });
  page.on("pageerror", (e) => pageErrors.push(`${page.url()} :: ${e.message}`));
}

/** Wait for the per-user shell to settle (it client-loads its list). A surface
 *  that never settles is RECORDED, not swallowed — an absence assertion on a
 *  half-rendered page would pass for the wrong reason. */
const unsettled = [];
async function settle(page) {
  await page.waitForLoadState("domcontentloaded");
  try {
    await page
      .locator('[data-cinatra-dashboard-toolbar="true"], [data-cinatra-entity-dashboards-state]')
      .first()
      .waitFor({ state: "attached", timeout: 30_000 });
    await page
      .locator('[data-cinatra-entity-dashboards-state="loading"]')
      .waitFor({ state: "detached", timeout: 30_000 });
  } catch (err) {
    unsettled.push(`${page.url()} :: ${err.message.split("\n")[0]}`);
  }
}

const SCOPES = (f) => [
  { kind: "organization", label: "Organization: ACME", url: `${BASE}/organizations/${f.orgId}` },
  { kind: "team", label: "Team: Growth", url: `${BASE}/teams/${f.teamId}` },
  { kind: "project", label: "Project: Atlas", url: `${BASE}/projects/${f.projectId}` },
];

const ADD = 'button:has-text("Add dashboard")';
const NEWD = 'button:has-text("New dashboard")';
const WRITE_ACCESS = '[data-conformance-id="scope-dashboards-write-access"]';
const OPEN_PICKER = '[data-action="open-add-picker -> add-picker-open"]';
const PICKER = '[data-conformance-id="scope-dashboards-add-picker"]';
const PANEL = '[data-conformance-id="scope-dashboards-tab"]';

const browser = await chromium.launch();
try {
  const managerCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const memberCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const manager = await signIn(managerCtx, FIXTURES.creds.manager.email, FIXTURES.creds.manager.password);
  const member = await signIn(memberCtx, FIXTURES.creds.member.email, FIXTURES.creds.member.password);

  // ── A · the MANAGER surface, per scope ────────────────────────────────────
  for (const scope of SCOPES(FIXTURES)) {
    await manager.goto(scope.url, { waitUntil: "domcontentloaded" });
    await settle(manager);

    // A1 — exactly ONE add entry point on the tab, and it is the toolbar's.
    const addCount = await manager.locator(ADD).count();
    const shots = await capture(manager, `manager-${scope.kind}-landing`);
    record(
      `A1.${scope.kind}`,
      "§IX/PR3 — the Dashboards tab offers exactly ONE 'Add dashboard' affordance (the consolidation)",
      addCount === 1,
      `"Add dashboard" controls on the tab: ${addCount} (capture ${shots})`,
    );

    // A2 — it lives in the toolbar, NOT in the collection panel below.
    const addInPanel = await manager.locator(`${PANEL} ${ADD}`).count();
    const addInToolbar = await manager
      .locator(`[data-cinatra-dashboard-toolbar="true"] ${ADD}, [data-slot="toolbar"] ${ADD}`)
      .count();
    record(
      `A2.${scope.kind}`,
      "PR3 — the single Add affordance is the tab TOOLBAR's; the collection panel carries none",
      addInPanel === 0 && addInToolbar >= 1,
      `in panel: ${addInPanel}; in toolbar: ${addInToolbar}`,
    );

    // A3 — §IX.2 annotation + the open-add-picker action ride that control.
    const annotated = manager.locator(`${WRITE_ACCESS} ${OPEN_PICKER}`);
    const annotatedCount = await annotated.count();
    const field = await manager.locator(WRITE_ACCESS).first().getAttribute("data-field");
    record(
      `A3.${scope.kind}`,
      "§IX.2 — the Add control carries scope-dashboards-write-access + manage-controls=collectionAdd.actorMayWriteScope, and the open-add-picker action",
      annotatedCount === 1 && field === "manage-controls=collectionAdd.actorMayWriteScope",
      `annotated open-add-picker controls: ${annotatedCount}; data-field=${JSON.stringify(field)}`,
    );

    // A4 — the popup opens and is titled for the scope (§IX.1).
    await manager.locator(ADD).first().click();
    const dialog = manager.locator('[data-slot="dialog-content"]');
    await dialog.waitFor({ state: "visible", timeout: 15_000 });
    const title = (await dialog.locator('[data-slot="dialog-title"]').innerText()).trim();
    record(
      `A4.${scope.kind}`,
      "§IX.1 — the popup is titled 'Add a dashboard to <entity-named scope>'",
      title === `Add a dashboard to ${scope.label}`,
      `title = ${JSON.stringify(title)}`,
    );

    // A5 — Create + Reference sections present; the catalog slot renders nothing
    //      (concept B's read is PR4 — PR3 ships no placeholder).
    const hasCreate = await dialog.getByRole("region", { name: "Create a new dashboard" }).count();
    const hasRef = await dialog.getByRole("region", { name: "Reference an existing dashboard" }).count();
    const sections = await dialog.locator("section").count();
    // Categorical, not just a <section> count: the popup's own section column
    // holds EXACTLY the two offered sections, in any element shape — so no
    // catalog placeholder can hide as a div/p/aside.
    const columnChildren = await dialog.evaluate((el) => {
      const col = el.querySelector('[data-slot="add-dashboard-sections"]');
      return col
        ? [...col.children].map(
            (c) => `${c.tagName.toLowerCase()}:${c.getAttribute("aria-label") ?? ""}`,
          )
        : null;
    });
    const catalogWords = await dialog
      .locator("text=/catalog/i")
      .count();
    record(
      `A5.${scope.kind}`,
      "PR3 — the popup offers exactly Create + Reference-existing and NO catalog placeholder in any element shape (B's read is PR4)",
      hasCreate === 1 &&
        hasRef === 1 &&
        sections === 2 &&
        Array.isArray(columnChildren) &&
        columnChildren.length === 2 &&
        columnChildren[0] === "section:Create a new dashboard" &&
        columnChildren[1] === "section:Reference an existing dashboard" &&
        catalogWords === 0,
      `create=${hasCreate} reference=${hasRef} sections=${sections} section-column children=${JSON.stringify(columnChildren)} nodes mentioning "catalog"=${catalogWords}`,
    );

    // A6 — the §IX.1 pool really loaded through the bound server action, and
    //      every candidate is dispositioned by the collection-add contract.
    await dialog.locator(`${PICKER} li`).first().waitFor({ state: "visible", timeout: 20_000 });
    const rows = await dialog.locator(`${PICKER} li`).allInnerTexts();
    const addable = await dialog.locator('[data-action="add-listing -> listing-added"]').count();
    const promo = await dialog.locator('[data-action="request-promotion -> promotion-requested"]').count();
    const notAddable = await dialog.locator(`${PICKER} li:has-text("Not addable")`).count();
    // Exactly ONE offer per INDIVIDUAL row — an aggregate sum could be satisfied
    // by a row with two offers and a row with none (codex convergence).
    const perRow = await dialog.locator(`${PICKER} li`).evaluateAll((lis) =>
      lis.map((li) => ({
        add: li.querySelectorAll('[data-action="add-listing -> listing-added"]').length,
        promote: li.querySelectorAll('[data-action="request-promotion -> promotion-requested"]').length,
        none: li.textContent?.includes("Not addable") ? 1 : 0,
      })),
    );
    const both = perRow.filter((r) => r.add + r.promote + r.none !== 1).length;
    const partitioned = addable + promo + notAddable === rows.length && both === 0;
    record(
      `A6.${scope.kind}`,
      "§IX.1 — the pool loads through the bound server action and every candidate carries EXACTLY ONE server-decided offer (addable | promotion | not-addable); no row is both add-able and scope-invisible",
      partitioned && rows.length > 0,
      `rows=${rows.length} addable=${addable} promotion=${promo} not-addable=${notAddable} rows-not-carrying-exactly-one-offer=${both} per-row=${JSON.stringify(perRow)} :: ${JSON.stringify(rows)}`,
    );

    // A6b — the recourse VOCABULARY is scope-exact (§IX.1): a team/organization
    //       target names that visibility; a PROJECT has no promotion widen at
    //       all, so its scope-invisible candidates read "Not addable".
    const promoLabels = await dialog
      .locator('[data-action="request-promotion -> promotion-requested"]')
      .allInnerTexts();
    const expectPromotion = scope.kind !== "project";
    const vocabOk = expectPromotion
      ? promo > 0 &&
        notAddable === 0 &&
        promoLabels.every((l) => l.trim() === `Request ${scope.kind} visibility…`)
      : promo === 0 && notAddable > 0;
    record(
      `A6b.${scope.kind}`,
      "§IX.1 — the scope-invisible recourse is scope-exact: team/organization offer the promotion request naming THAT visibility; a project offers none (null recourse), reading 'Not addable'",
      vocabOk,
      `promotion offers=${promo} labels=${JSON.stringify(promoLabels)} not-addable=${notAddable}`,
    );

    // A6c — a dashboard already present in THIS scope never appears in its pool.
    //       The fixture's org-owned dashboard is homed in the organization, so it
    //       is offered on team/project and withheld on the organization itself.
    const fixtureOffered = await dialog
      .locator(`${PICKER} li:has-text("Revenue attribution")`)
      .count();
    const presentInPanel = await manager
      .locator(`${PANEL} li:has-text("Revenue attribution")`)
      .count();
    // The rule, stated as a rule: a dashboard already PRESENT in this scope's
    // collection — homed here (the organization) or listed here (the project's
    // seeded listing) — is withheld from its pool; one that is not present (the
    // team) is offered. Read off the panel, so it can never drift from reality.
    const expectOffered = presentInPanel > 0 ? 0 : 1;
    record(
      `A6c.${scope.kind}`,
      "§IX.1 — the pool excludes exactly what is already present in this scope's collection: a dashboard shown in the panel is withheld from the picker, one that is not is offered",
      fixtureOffered === expectOffered,
      `"Revenue attribution": rows in the collection panel=${presentInPanel}, rows offered in the picker=${fixtureOffered} (expected ${expectOffered})`,
    );

    const dialogShot = await capture(manager, `manager-${scope.kind}-popup`);

    // A7 — §X: the popup is a BOUNDED panel (both axes) that really SCROLLS its
    //      own overflow. Squeezing the viewport forces the overflow rather than
    //      hoping the fixture pool happens to produce it.
    const box = await dialog.boundingBox();
    const overflowY = await dialog.evaluate((el) => getComputedStyle(el).overflowY);
    const vh = await manager.evaluate(() => window.innerHeight);
    await manager.setViewportSize({ width: 1440, height: 420 });
    // The bound is expressed in svh; wait for the reflow rather than measuring
    // the pre-resize layout.
    await manager
      .waitForFunction(
        () => {
          const el = document.querySelector('[data-slot="dialog-content"]');
          return !!el && el.getBoundingClientRect().height <= window.innerHeight * 0.851;
        },
        undefined,
        { timeout: 10_000 },
      )
      .catch(() => {});
    const scroll = await dialog.evaluate((el) => {
      const before = el.scrollTop;
      el.scrollTop = el.scrollHeight;
      return {
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        before,
        after: el.scrollTop,
        height: el.getBoundingClientRect().height,
        viewport: window.innerHeight,
      };
    });
    await manager.setViewportSize({ width: 1440, height: 900 });
    record(
      `A7.${scope.kind}`,
      "§X — the add-to-scope popup is a bounded panel: ≤520px wide, ≤85% of the viewport height, and its overflow really scrolls INSIDE it (never past the screen)",
      box.width <= 520.5 &&
        box.height <= vh * 0.851 &&
        overflowY === "auto" &&
        scroll.scrollHeight > scroll.clientHeight &&
        scroll.after > scroll.before &&
        scroll.height <= scroll.viewport * 0.851,
      `width=${box.width.toFixed(1)}px height=${box.height.toFixed(1)}px (85vh=${(vh * 0.85).toFixed(1)}px) overflow-y=${overflowY}; squeezed to 420px viewport: height=${scroll.height.toFixed(1)}px scrollHeight=${scroll.scrollHeight} clientHeight=${scroll.clientHeight} scrollTop ${scroll.before}->${scroll.after} (capture ${dialogShot})`,
    );

    await manager.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  }

  // ── B · the Create hand-off (org scope) ──────────────────────────────────
  {
    const org = SCOPES(FIXTURES)[0];
    await manager.goto(org.url, { waitUntil: "domcontentloaded" });
    await settle(manager);
    await manager.locator(ADD).first().click();
    const dialog = manager.locator('[data-slot="dialog-content"]');
    await dialog.waitFor({ state: "visible" });
    await dialog.getByRole("button", { name: "Create…" }).click();

    const prompt = manager.locator('[data-slot="dialog-content"]:has-text("New dashboard")');
    await prompt.waitFor({ state: "visible", timeout: 10_000 });
    const openDialogs = await manager.locator('[data-slot="dialog-content"]').count();
    const focused = await manager.evaluate(
      () => document.activeElement?.getAttribute("aria-label") ?? null,
    );
    record(
      "B1",
      "PR3 — choosing Create HANDS OFF: the popup closes, the preserved EntityDashboardNameDialog opens (not a nested dialog), and focus lands in its field",
      openDialogs === 1 && focused === "Dashboard name",
      `dialogs mounted after the hand-off: ${openDialogs}; document.activeElement aria-label = ${JSON.stringify(focused)}`,
    );
    const handoffShot = await capture(manager, "manager-org-create-handoff");

    // Unique per run: a repeat name is a legitimate server-side conflict, and
    // the battery must be re-runnable without tripping over its own history.
    const createdName = `Lane proof dashboard ${Date.now()}`;
    await manager.getByLabel("Dashboard name").fill(createdName);
    await manager.getByRole("button", { name: "Create", exact: true }).click();
    await prompt.waitFor({ state: "hidden", timeout: 20_000 });
    await manager
      .locator(`button[aria-label="Select dashboard"]:has-text("${createdName}")`)
      .waitFor({ state: "visible", timeout: 30_000 });
    record(
      "B2",
      "PR3 — the hand-off really creates: the named dashboard becomes the shell's selection",
      true,
      `the toolbar's dashboard-select now reads ${JSON.stringify(createdName)} (capture ${handoffShot})`,
    );
  }

  // ── C · adding a reference listing, end to end (team scope) ───────────────
  {
    const team = SCOPES(FIXTURES)[1];
    await manager.goto(team.url, { waitUntil: "domcontentloaded" });
    await settle(manager);
    const before = await manager.locator(`${PANEL} li`).count();

    await manager.locator(ADD).first().click();
    const dialog = manager.locator('[data-slot="dialog-content"]');
    await dialog.waitFor({ state: "visible" });
    await dialog.locator('[data-action="add-listing -> listing-added"]').first().click();
    await dialog.waitFor({ state: "hidden", timeout: 20_000 });

    await manager
      .locator(`${PANEL} li:has-text("Revenue attribution")`)
      .waitFor({ state: "visible", timeout: 30_000 });
    const after = await manager.locator(`${PANEL} li`).count();
    const removeOnRow = await manager
      .locator(`${PANEL} li:has-text("Revenue attribution") button:has-text("Remove")`)
      .count();
    const rowShot = await capture(manager, "manager-team-listing-added");
    record(
      "C1",
      "§IX.1 — a real Add through the popup writes the listing: the popup closes, the collection panel below gains the row, and the row carries Remove (a secondary listing, §IX)",
      after === before + 1 && removeOnRow === 1,
      `panel rows ${before} -> ${after}; Remove controls on the new row: ${removeOnRow} (capture ${rowShot})`,
    );

    // C2 — the added row leaves the candidate pool (no double-add).
    await manager.locator(ADD).first().click();
    await dialog.waitFor({ state: "visible" });
    await manager.locator(`${PICKER} [data-state], ${PICKER} li`).first().waitFor({ timeout: 20_000 });
    const stillOffered = await dialog
      .locator(`${PICKER} li:has-text("Revenue attribution")`)
      .count();
    record(
      "C2",
      "§IX.1 — the added dashboard leaves the candidate pool (already listed here), so it can never be added twice",
      stillOffered === 0,
      `"Revenue attribution" rows still offered in the picker: ${stillOffered}`,
    );
    await manager.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
  }

  // ── D · §IX.2 on a REAL member session (suppression, not disabling) ───────
  for (const scope of SCOPES(FIXTURES)) {
    await member.goto(scope.url, { waitUntil: "domcontentloaded" });
    await settle(member);

    const addCount = await member.locator(ADD).count();
    const annotationCount = await member.locator(WRITE_ACCESS).count();
    const pickerActionCount = await member.locator(OPEN_PICKER).count();
    const newCount = await member.locator(NEWD).count();
    const memberShot = await capture(member, `member-${scope.kind}-landing`);
    record(
      `D1.${scope.kind}`,
      "§IX.2 — a member without write authority gets NO scope-level Add: no 'Add dashboard' control, no write-access annotation, no open-add-picker action anywhere",
      addCount === 0 && annotationCount === 0 && pickerActionCount === 0,
      `Add controls=${addCount} write-access annotations=${annotationCount} open-add-picker actions=${pickerActionCount} (capture ${memberShot})`,
    );

    record(
      `D2.${scope.kind}`,
      "PR3 — the member KEEPS the per-user create, which is not a §IX.2 manage control",
      newCount === 1,
      `"New dashboard" controls: ${newCount}`,
    );

    // §IX.2's rule is about MANAGEMENT controls: none may render disabled. Probe
    // the tab's own controls (the dashboards toolbar + the collection panel) —
    // the page chrome around them is not in §IX's scope (the breadcrumb's
    // current-page crumb is an `aria-disabled` SPAN, an a11y pattern, not a
    // control, and counting it would be a false FAIL).
    const disabled = await member
      .locator(
        `[data-cinatra-dashboard-toolbar="true"] button:disabled, [data-slot="toolbar"] button:disabled, ${PANEL} button:disabled, ${PANEL} [aria-disabled='true']`,
      )
      .count();
    record(
      `D3.${scope.kind}`,
      "§IX.2 — suppression, not a disabled control: the member's Dashboards tab renders ZERO disabled controls in its toolbar or its collection panel",
      disabled === 0,
      `disabled controls in the tab's toolbar + collection panel: ${disabled}`,
    );

    const rows = await member.locator(`${PANEL} li`).count();
    const removes = await member.locator(`${PANEL} li button:has-text("Remove")`).count();
    const opens = await member.locator(`${PANEL} li a:has-text("Open")`).count();
    record(
      `D4.${scope.kind}`,
      "§IX.2 — read stays universal: the member still sees every collection row and can open it, with no Remove (asserted against a NON-EMPTY collection, so it cannot pass vacuously)",
      rows > 0 && opens === rows && removes === 0,
      `rows=${rows} Open affordances=${opens} Remove controls=${removes}`,
    );
  }

  // ── E · a MEMBER's create still works (the plain name prompt, unchanged) ──
  {
    const org = SCOPES(FIXTURES)[0];
    await member.goto(org.url, { waitUntil: "domcontentloaded" });
    await settle(member);
    await member.locator(NEWD).first().click();
    const prompt = member.locator('[data-slot="dialog-content"]');
    await prompt.waitFor({ state: "visible", timeout: 10_000 });
    const title = (await prompt.locator('[data-slot="dialog-title"]').innerText()).trim();
    record(
      "E1",
      "PR3 — with no scope source the toolbar keeps the DIRECT name prompt it always had (no one-option popup)",
      title === "New dashboard",
      `the dialog that opened is titled ${JSON.stringify(title)}`,
    );
    await member.keyboard.press("Escape");
    await prompt.waitFor({ state: "hidden" });
  }

  // ── F · Personal is untouched by PR3 ─────────────────────────────────────
  {
    await manager.goto(`${BASE}/personal`, { waitUntil: "domcontentloaded" });
    await settle(manager);
    const addCount = await manager.locator(ADD).count();
    const newCount = await manager.locator(NEWD).count();
    const annotations = await manager.locator(WRITE_ACCESS).count();
    await manager.locator(NEWD).first().click();
    const prompt = manager.locator('[data-slot="dialog-content"]');
    await prompt.waitFor({ state: "visible", timeout: 10_000 });
    const title = (await prompt.locator('[data-slot="dialog-title"]').innerText()).trim();
    const personalShot = await capture(manager, "manager-personal");
    record(
      "F1",
      "§IX — a personal scope is not an add-to-scope target: it carries no Add, and PR3 leaves its direct create prompt exactly as it was",
      addCount === 0 && newCount === 1 && annotations === 0 && title === "New dashboard",
      `Add controls=${addCount} New controls=${newCount} write-access annotations=${annotations} prompt=${JSON.stringify(title)} (capture ${personalShot})`,
    );
    await manager.keyboard.press("Escape");
    await prompt.waitFor({ state: "hidden" });
  }

  // ── G · the theme + breakpoint axes ──────────────────────────────────────
  {
    const org = SCOPES(FIXTURES)[0];
    // The app themes with next-themes `attribute="class"` (themes: cinatra |
    // dark, persisted in localStorage), so `prefers-color-scheme` alone does
    // NOT switch it — the probe must set the app's own theme and then verify
    // the class actually landed AND the painted surface really changed.
    const lightBg = await (async () => {
      await manager.goto(org.url, { waitUntil: "domcontentloaded" });
      await settle(manager);
      await manager.locator(ADD).first().click();
      const d = manager.locator('[data-slot="dialog-content"]');
      await d.waitFor({ state: "visible", timeout: 15_000 });
      const bg = await d.evaluate((el) => getComputedStyle(el).backgroundColor);
      await manager.keyboard.press("Escape");
      await d.waitFor({ state: "hidden" });
      return bg;
    })();

    const dark = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: "dark",
      storageState: await managerCtx.storageState(),
    });
    await dark.addInitScript(() => {
      try {
        window.localStorage.setItem("theme", "dark");
      } catch {}
    });
    const darkPage = await dark.newPage();
    wire(darkPage);
    await darkPage.goto(org.url, { waitUntil: "domcontentloaded" });
    await settle(darkPage);
    await darkPage.locator(ADD).first().click();
    const darkDialog = darkPage.locator('[data-slot="dialog-content"]');
    await darkDialog.waitFor({ state: "visible", timeout: 15_000 });
    const htmlClass = await darkPage.evaluate(
      () => document.documentElement.className,
    );
    const { bg, fg, contrast, resolved } = await darkDialog.evaluate((el) => {
      const cs = getComputedStyle(el);
      // Resolve any colour (incl. lab()) to sRGB by painting it once.
      const probe = document.createElement("span");
      document.body.appendChild(probe);
      // `lab()` stays `lab()` in the computed style, so parsing its components
      // as RGB would be nonsense. `color-mix(in srgb, …)` forces the resolution
      // into sRGB, whichever colour space the token was authored in.
      const toRgb = (value) => {
        probe.style.color = `color-mix(in srgb, ${value} 100%, ${value})`;
        const computed = getComputedStyle(probe).color;
        const m = computed.match(/-?[\d.]+/g) ?? [];
        const nums = m.slice(0, 3).map(Number);
        if (nums.length < 3) return null;
        // `color(srgb r g b)` yields 0..1 components; `rgb()` yields 0..255.
        return computed.startsWith("color(") ? nums.map((v) => v * 255) : nums;
      };
      const lum = ([r, g, b]) => {
        const c = [r, g, b]
          .map((v) => v / 255)
          .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      };
      const bgRgb = toRgb(cs.backgroundColor);
      const fgRgb = toRgb(cs.color);
      probe.remove();
      if (!bgRgb || !fgRgb) {
        return { bg: cs.backgroundColor, fg: cs.color, contrast: 0, resolved: null };
      }
      const a = lum(bgRgb);
      const b = lum(fgRgb);
      const hi = Math.max(a, b);
      const lo = Math.min(a, b);
      return {
        bg: cs.backgroundColor,
        fg: cs.color,
        contrast: (hi + 0.05) / (lo + 0.05),
        resolved: { bg: bgRgb.map(Math.round), fg: fgRgb.map(Math.round) },
      };
    });
    await darkDialog
      .locator(`${PICKER} li`)
      .first()
      .waitFor({ state: "visible", timeout: 20_000 });
    const rowsVisible = await darkDialog.locator(`${PICKER} li`).count();
    const darkShot = await capture(darkPage, "manager-org-popup-dark");
    record(
      "G1",
      "Theme axis — the popup renders in the app's DARK theme: the dark class lands, the painted surface differs from the light run, text keeps a MEASURED contrast ratio ≥ 4.5:1, and the §IX.1 rows still render",
      htmlClass.includes("dark") && bg !== lightBg && contrast >= 4.5 && rowsVisible > 0,
      `html class=${JSON.stringify(htmlClass)}; popup background dark=${bg} vs light=${lightBg}; color=${fg}; resolved sRGB=${JSON.stringify(resolved)}; measured contrast=${contrast.toFixed(2)}:1; picker rows=${rowsVisible} (capture ${darkShot})`,
    );
    await dark.close();

    // Narrow: the popup must shrink to the viewport and never overflow the page.
    await manager.setViewportSize({ width: 390, height: 844 });
    await manager.goto(org.url, { waitUntil: "domcontentloaded" });
    await settle(manager);
    const addBox = await manager.locator(ADD).first().boundingBox();
    // Reachability is proven by a real click that really opens the popup — not
    // by the affordance merely having a box somewhere (codex convergence).
    await manager.locator(ADD).first().click();
    const dialog = manager.locator('[data-slot="dialog-content"]');
    await dialog.waitFor({ state: "visible", timeout: 15_000 });
    const opened = await dialog.isVisible();
    const box = await dialog.boundingBox();
    const overflow = await manager.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    const narrowShot = await capture(manager, "manager-org-popup-390");
    record(
      "G2",
      "§X responsive — at 390px the popup shrinks to the viewport (max-width:100%), the page never scrolls horizontally, and the Add affordance stays reachable (never behind an overflow)",
      box.width <= 390 && box.x >= 0 && overflow === 0 && addBox !== null && opened,
      `popup x=${box.x.toFixed(1)} width=${box.width.toFixed(1)}px; document horizontal overflow=${overflow}px; Add affordance box=${JSON.stringify(addBox && { x: +addBox.x.toFixed(1), y: +addBox.y.toFixed(1), w: +addBox.width.toFixed(1) })}, clicked and the popup opened=${opened} (capture ${narrowShot})`,
    );
    await manager.keyboard.press("Escape");
    await manager.setViewportSize({ width: 1440, height: 900 });
  }

  // ── H · the retired standalone picker is gone from the running app ───────
  {
    const org = SCOPES(FIXTURES)[0];
    await manager.goto(org.url, { waitUntil: "domcontentloaded" });
    await settle(manager);
    const pickerBeforeOpen = await manager.locator(PICKER).count();
    record(
      "H1",
      "PR3 — there is no second picker surface: the §IX.1 picker exists ONLY inside the one popup (nothing renders it on the page)",
      pickerBeforeOpen === 0,
      `add-picker surfaces on the closed page: ${pickerBeforeOpen}`,
    );
  }

  record(
    "Z1",
    "No console errors, no page errors, and every surface actually SETTLED before it was probed (an absence assertion on a half-rendered page would pass for the wrong reason)",
    consoleErrors.length === 0 && pageErrors.length === 0 && unsettled.length === 0,
    `console errors=${consoleErrors.length} page errors=${pageErrors.length} unsettled surfaces=${unsettled.length}${consoleErrors.length ? ` :: ${consoleErrors.slice(0, 3).join(" | ")}` : ""}${pageErrors.length ? ` :: ${pageErrors.slice(0, 3).join(" | ")}` : ""}${unsettled.length ? ` :: ${unsettled.slice(0, 3).join(" | ")}` : ""}`,
  );
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.result === "PASS").length;
const failed = results.length - passed;
writeFileSync(
  path.join(OUT, "probe-results.json"),
  JSON.stringify(
    {
      base: BASE,
      // Recorded in the same `design@<sha>` form PR1 and PR2 used — the design
      // repository is private, so its slug never rides public text.
      designSpecPin: {
        file: "specs/app-artifacts.html",
        section: "IX",
        pin: "design@60cf789ec9b6d6455148a086cacc6ae43f447cef",
      },
      ranAt: new Date().toISOString(),
      passed,
      failed,
      consoleErrors,
      pageErrors,
      unsettledSurfaces: unsettled,
      results,
    },
    null,
    2,
  ),
);
console.log(`\n${passed} PASS / ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
