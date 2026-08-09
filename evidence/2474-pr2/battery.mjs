// #2474 PR2 live conformance battery — real Chromium against the running dev
// server, real sessions, geometry PROBED (never eyeballed off a snapshot).
// Spec pin: specs/app-artifacts.html §IX @ design@60cf789ec9b6d6455148a086cacc6ae43f447cef
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3477";
const OUT = process.env.OUT ?? "evidence/2474-pr2";
const ORG = "org-acme", TEAM = "team-platform", PROJ = "proj-brand";
const PW = process.env.FIXTURE_PW;
if (!PW) { console.error("FIXTURE_PW not set"); process.exit(2); }

const results = [];
let shots = 0;
const consoleErrors = [], pageErrors = [];

function record(id, assert, pass, observed) {
  results.push({ id, assert, result: pass ? "PASS" : "FAIL", observed });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${assert}`);
  if (!pass) console.log(`      observed: ${JSON.stringify(observed)}`);
}

// Sign in SAME-ORIGIN from a real page (Better Auth rejects a cross-origin
// set-active), so the session cookie + active org are exactly what a real
// browser session carries.
async function signIn(ctx, email) {
  const p = await ctx.newPage();
  await p.goto(`${BASE}/sign-in`, { waitUntil: "domcontentloaded" });
  const out = await p.evaluate(async ({ email, PW, ORG }) => {
    const r = await fetch("/api/auth/sign-in/email", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PW }),
    });
    if (!r.ok) return { step: "sign-in", status: r.status };
    const a = await fetch("/api/auth/organization/set-active", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId: ORG }),
    });
    return { step: a.ok ? "ok" : "set-active", status: a.status };
  }, { email, PW, ORG });
  if (out.step !== "ok") throw new Error(`${out.step} ${email} -> ${out.status}`);
  await p.close();
}

async function shot(page, name) {
  mkdirSync(OUT, { recursive: true });
  const n = String(++shots).padStart(2, "0");
  await page.screenshot({ path: `${OUT}/${n}-${name}.png`, fullPage: true });
  return `${n}-${name}.png`;
}

/** Settle on real content, never networkidle. */
async function go(page, path, sel = "[role=tablist]") {
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(sel, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(600);
}

const PANEL = '[data-conformance-id="scope-dashboards-tab"]';

async function probeScope(page, kind, path, noun, opts = {}) {
  await go(page, path);
  // Settle the per-user shell (it client-loads its dashboard list) before
  // probing, so the "shell is untouched" assert reads a rendered surface rather
  // than racing the fetch.
  await page.waitForFunction(
    () => [...document.querySelectorAll("button,[role=combobox],a")]
      .some((e) => /New dashboard|Overview/i.test(e.textContent ?? "")),
    null, { timeout: 30000 },
  ).catch(() => {});
  await page.waitForSelector('[data-conformance-id="scope-dashboards-tab"]', { timeout: 30000 }).catch(() => {});
  const d = await page.evaluate((PANEL) => {
    const panel = document.querySelector(PANEL);
    const tabs = document.querySelector('[role="tablist"]');
    const shellNames = ["Overview"];
    return {
      h1: document.querySelector("h1")?.textContent?.trim() ?? null,
      tabs: tabs ? [...tabs.querySelectorAll('[role="tab"]')].map((t) => ({
        label: t.textContent.trim(),
        active: t.getAttribute("data-state") === "active",
        href: t.getAttribute("href"),
      })) : null,
      panel: !!panel,
      heading: panel?.querySelector("h2")?.textContent?.trim() ?? null,
      headingTag: panel?.querySelector("h2") ? "h2" : null,
      state: panel?.getAttribute("data-state") ?? null,
      field: panel?.getAttribute("data-field") ?? null,
      add: !!panel?.querySelector('[data-action^="open-add-picker"]'),
      writeAccessNode: !!panel?.querySelector('[data-conformance-id="scope-dashboards-write-access"]'),
      rows: panel ? [...panel.querySelectorAll("li")].map((li) => ({
        name: li.querySelector(".font-semibold")?.textContent?.trim() ?? null,
        meta: li.querySelector("p")?.textContent?.trim() ?? null,
        remove: !!li.querySelector('[data-action^="remove-listing"]'),
        open: li.querySelector('[data-action^="open-dashboard"]')?.getAttribute("href") ?? null,
        glyph: !!li.querySelector("svg"),
        text: li.innerText.replace(/\s+/g, " ").trim(),
      })) : [],
      // render -> spec
      legacyLinks: [...document.querySelectorAll("a[href]")]
        .map((a) => a.getAttribute("href"))
        .filter((h) => /^\/(organizations|teams|projects)\/[^/]+\/dashboards$/.test(h)),
      panelCount: document.querySelectorAll(PANEL).length,
      // The per-user shell above the panel must still be there. Identified by
      // its own "New dashboard" toolbar control + the non-removable Overview
      // entry, NOT by a substring race against a client-loading list.
      shellPresent: (() => {
        const marker = [...document.querySelectorAll("button,[role=combobox],a")]
          .find((e) => /New dashboard|Overview/i.test(e.textContent ?? ""));
        return !!marker;
      })(),
      // Ordering is a DOM fact, not a text-index guess: the panel must follow
      // the shell in document order.
      panelAfterShell: (() => {
        if (!panel) return null;
        const marker = [...document.querySelectorAll("button,[role=combobox],a")]
          .find((e) => /New dashboard|Overview/i.test(e.textContent ?? ""));
        if (!marker) return null;
        // DOCUMENT_POSITION_FOLLOWING === 4 → panel comes after the marker.
        return (marker.compareDocumentPosition(panel) & 4) === 4;
      })(),
      // duplicate-lede check: the old page-level lede sentence must be gone
      oldLede: document.body.innerText.includes("The dashboards in "),
    };
  }, PANEL);

  const label = `${kind}-${opts.role ?? "admin"}-${opts.theme ?? "light"}`;
  const file = await shot(page, `${label}`);
  return { d, file };
}

const browser = await chromium.launch();
try {
  // ---- admin (org owner / team admin / project admin) -------------------
  const admin = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  admin.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  admin.on("weberror", (e) => pageErrors.push(String(e.error())));
  await signIn(admin, "admin@lane2474.test");
  const page = await admin.newPage();
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  // --- ORG ---
  {
    const { d } = await probeScope(page, "org", `/organizations/${ORG}`, "organization");
    record("A1", "§IX — the ORG landing mounts the scope collection panel (the fold; it used to be its own route)", d.panel, { heading: d.heading, state: d.state });
    record("A2", "#2474 PR2 — the panel heading names the scope KIND, as an h2 below the tablist", d.heading === "Dashboards in this organization" && d.headingTag === "h2", { heading: d.heading, tag: d.headingTag });
    record("A3", "#2547 observation — the duplicate page-level scope lede is gone", d.oldLede === false, { oldLedeStillPresent: d.oldLede });
    record("A4", "§IX — the tab lists BOTH a homed row and a secondary listing", d.rows.length === 2 && d.rows.some(r => r.name?.includes("Pipeline health")) && d.rows.some(r => r.name?.includes("Revenue attribution")), { rows: d.rows.map(r => r.name) });
    const homed = d.rows.find(r => r.name?.includes("Pipeline health"));
    const listed = d.rows.find(r => r.name?.includes("Revenue attribution"));
    record("A5", "§IX — Remove appears ONLY on the removable secondary listing, never on a homed row", homed?.remove === false && listed?.remove === true, { homedRemove: homed?.remove, listedRemove: listed?.remove });
    record("A6", "§IX — no Home/Listed relation badge and no per-row type label (removability reads from Remove alone)", d.rows.every(r => !/\b(Home|Listed)\b/.test(r.text)), { texts: d.rows.map(r => r.text) });
    record("A7", "§IX — every row carries a glyph, a name, an updated-time meta line and an Open affordance", d.rows.every(r => r.glyph && r.name && /updated /.test(r.meta ?? "") && r.open), { rows: d.rows });
    record("A8", "§VIII/§IX — Open targets the dashboard's CANONICAL surface (the nested route PR2 deliberately did NOT delete)", listed?.open === `/teams/${TEAM}/dashboards/dash-listed` && homed?.open === `/organizations/${ORG}/dashboards/dash-homed`, { homed: homed?.open, listed: listed?.open });
    record("A9", "§IX.2 — a scope MANAGER sees the Add affordance, inside the write-access conformance node", d.add && d.writeAccessNode, { add: d.add, node: d.writeAccessNode });
    record("A10", "#2474 — the per-user shell + non-removable Overview are untouched, and the panel sits BELOW them", d.shellPresent && d.panelAfterShell === true, { shell: d.shellPresent, after: d.panelAfterShell });
    record("A11", "render→spec — exactly ONE collection panel on the surface", d.panelCount === 1, { count: d.panelCount });
    record("A12", "render→spec — nothing on the page links to a retired /<scope>/<id>/dashboards collection route", d.legacyLinks.length === 0, { links: d.legacyLinks });
    record("A13", "PR1 invariant preserved — the landing still opens on Dashboards|Settings with Dashboards active", d.tabs?.length === 2 && d.tabs[0].active && d.tabs[0].label === "Dashboards", { tabs: d.tabs });
  }

  // --- TEAM ---
  {
    const { d } = await probeScope(page, "team", `/teams/${TEAM}`, "team");
    record("B1", "§IX — the TEAM landing mounts the collection panel, kind-named", d.panel && d.heading === "Dashboards in this team", { heading: d.heading });
    record("B2", "§IX — the team's homed dashboard lists on its own scope with NO Remove (it is homed here)", d.rows.length === 1 && d.rows[0].name?.includes("Revenue attribution") && d.rows[0].remove === false, { rows: d.rows });
    record("B3", "§IX.2 — a team admin sees Add", d.add === true, { add: d.add });
    record("B4", "PR1 invariant — tablist intact, Dashboards active", d.tabs?.length === 2 && d.tabs[0].active, { tabs: d.tabs });
    record("B5", "render→spec — no link to the retired collection route", d.legacyLinks.length === 0, { links: d.legacyLinks });
  }

  // --- PROJECT ---
  {
    const { d } = await probeScope(page, "project", `/projects/${PROJ}`, "project");
    record("C1", "§IX — the PROJECT landing mounts the collection panel, kind-named", d.panel && d.heading === "Dashboards in this project", { heading: d.heading });
    record("C2", "§IX.2 — a project admin sees Add", d.add === true, { add: d.add });
    record("C3", "#2474 — the project's per-user shell + Overview survive above the panel", d.shellPresent && d.panelAfterShell === true, { shell: d.shellPresent, after: d.panelAfterShell });
    record("C4", "render→spec — no link to the retired collection route", d.legacyLinks.length === 0, { links: d.legacyLinks });
  }

  // --- PERSONAL: no collection panel (not an add-to-scope target, §IX) ---
  {
    await go(page, "/personal");
    const d = await page.evaluate((PANEL) => ({
      panel: !!document.querySelector(PANEL),
      tabs: [...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent.trim()),
    }), PANEL);
    await shot(page, "personal-admin-light");
    record("D1", "§IX — a PERSONAL scope is not an add-to-scope target: no collection panel", d.panel === false, d);
    record("D2", "#1904 — personal keeps its Dashboards-only tablist", d.tabs.length === 1 && d.tabs[0] === "Dashboards", { tabs: d.tabs });
  }

  // --- the retired routes 404 for an AUTHENTICATED actor (no redirect) ---
  {
    const codes = {};
    for (const p of [`/organizations/${ORG}/dashboards`, `/teams/${TEAM}/dashboards`, `/projects/${PROJ}/dashboards`]) {
      const r = await admin.request.get(`${BASE}${p}`, { maxRedirects: 0 });
      codes[p] = r.status();
    }
    record("E1", "#2474 AC — the three collection routes are GONE: 404 for an authenticated actor, and NOT a redirect", Object.values(codes).every((c) => c === 404), codes);

    const canon = {};
    for (const p of [`/organizations/${ORG}/dashboards/dash-homed`, `/teams/${TEAM}/dashboards/dash-listed`]) {
      // Generous timeout: this is a dev server, and a route's FIRST hit pays a
      // Turbopack compile. A slow first compile is not a routing verdict.
      const r = await admin.request.get(`${BASE}${p}`, { maxRedirects: 0, timeout: 180000 });
      canon[p] = r.status();
    }
    record("E2", "the CANONICAL-HOME nested routes still serve 200 (the surface every Open targets)", Object.values(canon).every((c) => c === 200), canon);
  }

  // --- the Add picker (§IX.1) still opens from the folded panel ---
  {
    await go(page, `/organizations/${ORG}`);
    await page.click('[data-action^="open-add-picker"]');
    await page.waitForSelector('[data-conformance-id="scope-dashboards-add-picker"], [role=dialog]', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(700);
    const d = await page.evaluate(() => {
      const dlg = document.querySelector('[role=dialog]');
      return {
        open: !!dlg,
        title: dlg?.querySelector("h2,[data-slot=dialog-title]")?.textContent?.trim() ?? null,
        picker: !!document.querySelector('[data-conformance-id="scope-dashboards-add-picker"]'),
      };
    });
    await shot(page, "org-add-picker-open");
    record("F1", "§IX.1 — the add-to-scope picker still opens from the folded panel, titled with the entity-named scope label", d.open && /Add a dashboard to Organization: ACME Group/.test(d.title ?? ""), d);
    await page.keyboard.press("Escape");
  }

  // --- breadcrumb: the intermediate Dashboards crumb no longer links to a dead route ---
  {
    await go(page, `/organizations/${ORG}/dashboards/dash-homed`, "h1");
    const d = await page.evaluate(() => {
      const nav = document.querySelector("nav[aria-label*=readcrumb], nav");
      const items = nav ? [...nav.querySelectorAll("a,span,li")].map((e) => ({ tag: e.tagName, text: e.textContent.trim(), href: e.getAttribute?.("href") ?? null })) : [];
      return {
        deadLinks: [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"))
          .filter((h) => /^\/(organizations|teams)\/[^/]+\/dashboards$/.test(h)),
        crumbTexts: items.filter((i) => i.text === "Dashboards"),
      };
    });
    await shot(page, "org-canonical-dashboard-breadcrumb");
    record("G1", "the intermediate 'Dashboards' breadcrumb on a canonical dashboard URL is NOT a link to the deleted route", d.deadLinks.length === 0, d);
  }

  await admin.close();

  // ---- plain member (no write authority anywhere) -----------------------
  const memberCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await signIn(memberCtx, "member@lane2474.test");
  const mp = await memberCtx.newPage();
  mp.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  mp.on("pageerror", (e) => pageErrors.push(String(e)));

  for (const [kind, path] of [["org", `/organizations/${ORG}`], ["team", `/teams/${TEAM}`], ["project", `/projects/${PROJ}`]]) {
    await go(mp, path);
    const d = await mp.evaluate((PANEL) => {
      const panel = document.querySelector(PANEL);
      return {
        panel: !!panel,
        add: !!panel?.querySelector('[data-action^="open-add-picker"]'),
        writeNode: !!panel?.querySelector('[data-conformance-id="scope-dashboards-write-access"]'),
        removes: panel ? panel.querySelectorAll('[data-action^="remove-listing"]').length : -1,
        rows: panel ? panel.querySelectorAll("li").length : -1,
        disabledControls: panel ? [...panel.querySelectorAll("button[disabled]")].length : -1,
      };
    }, PANEL);
    await shot(mp, `${kind}-member-light`);
    record(`H-${kind}`, `§IX.2 — a member WITHOUT write authority still sees the ${kind} collection and every row, with Add and Remove SUPPRESSED (not disabled)`,
      d.panel && d.add === false && d.writeNode === false && d.removes === 0 && d.disabledControls === 0,
      d);
  }
  await memberCtx.close();

  // ---- dark theme + narrow viewport (§X axes) --------------------------
  const darkCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  await signIn(darkCtx, "admin@lane2474.test");
  const dp = await darkCtx.newPage();
  await go(dp, `/organizations/${ORG}`);
  await dp.evaluate(() => document.documentElement.classList.add("dark"));
  await dp.waitForTimeout(400);
  const darkD = await dp.evaluate((PANEL) => {
    const panel = document.querySelector(PANEL);
    const h = panel?.querySelector("h2");
    return { panel: !!panel, headingColor: h ? getComputedStyle(h).color : null, bg: getComputedStyle(document.body).backgroundColor };
  }, PANEL);
  await shot(dp, "org-admin-dark");
  record("I1", "§X theme axis — the collection panel renders in dark with themed tokens", darkD.panel && !!darkD.headingColor, darkD);
  await darkCtx.close();

  const narrowCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await signIn(narrowCtx, "admin@lane2474.test");
  const np = await narrowCtx.newPage();
  await go(np, `/organizations/${ORG}`);
  // GEOMETRY PROBED, not eyeballed: at 390px the heading+Add row must STACK
  // (Add below the heading), and nothing may overflow the page horizontally.
  const geo = await np.evaluate((PANEL) => {
    const panel = document.querySelector(PANEL);
    const h2 = panel?.querySelector("h2");
    const add = panel?.querySelector('[data-action^="open-add-picker"]');
    const hb = h2?.getBoundingClientRect(), ab = add?.getBoundingClientRect();
    return {
      headingBottom: hb?.bottom ?? null,
      addTop: ab?.top ?? null,
      stacked: hb && ab ? ab.top >= hb.bottom - 1 : null,
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      panelWidth: panel?.getBoundingClientRect().width ?? null,
      viewport: window.innerWidth,
    };
  }, PANEL);
  await shot(np, "org-admin-narrow-390");
  record("I2", "§X responsive — at 390px the Add affordance DROPS BENEATH the panel heading (geometry probed)", geo.stacked === true, geo);
  record("I3", "§X responsive — no horizontal page overflow at 390px; the panel shrinks to the viewport", geo.docOverflow <= 0 && geo.panelWidth <= geo.viewport, geo);
  await narrowCtx.close();

  record("J1", "no console errors and no page errors across the battery", consoleErrors.length === 0 && pageErrors.length === 0, { consoleErrors: consoleErrors.slice(0, 8), pageErrors: pageErrors.slice(0, 8) });
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.result === "PASS").length;
const failed = results.filter((r) => r.result === "FAIL").length;
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/probe-results.json`, JSON.stringify({
  issue: "cinatra#2474 PR2",
  specPin: "specs/app-artifacts.html §IX @ design@60cf789ec9b6d6455148a086cacc6ae43f447cef",
  base: BASE, ranAt: new Date().toISOString(),
  passed, failed, captures: shots, results,
}, null, 2));
console.log(`\n=== ${passed} PASS / ${failed} FAIL / ${shots} captures ===`);
process.exit(failed === 0 ? 0 : 1);
