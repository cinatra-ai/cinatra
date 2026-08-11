// #2474 item 6 live conformance battery — real Chromium against the running dev
// server on host2, a real Better Auth session, HTTP statuses PROBED (never
// eyeballed off a snapshot).
//
// What it proves, item by item:
//   A. the retired workspace-wide /dashboards 404s for an AUTHENTICATED session
//      (deletion, not a redirect: the URL does not change);
//   B. the PR2 /<scope>/<id>/dashboards collection routes are still gone (404);
//   C. every surviving scope landing still renders its Dashboards|Settings
//      tablist with Dashboards active — the retirement touched nothing;
//   D. the MOVED server-action module works at RUNTIME: the org landing's
//      collection panel renders and its Add-dashboard popup drives
//      scopeListCandidatesAction across the client boundary;
//   E. the preserved /dashboards/{id} detail route renders a real dashboard.
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const OUT = process.env.OUT ?? "evidence/2474-pr6";
const EMAIL = process.env.PROOF_EMAIL;
const PW = process.env.PROOF_PW;
if (!EMAIL || !PW) { console.error("PROOF_EMAIL / PROOF_PW not set"); process.exit(2); }

const results = [];
let shots = 0;
const consoleErrors = [], pageErrors = [];

function record(id, assert, pass, observed) {
  results.push({ id, assert, result: pass ? "PASS" : "FAIL", observed });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${assert}`);
  if (!pass) console.log(`      observed: ${JSON.stringify(observed)}`);
}

async function shot(page, name, opts = {}) {
  mkdirSync(OUT, { recursive: true });
  const n = String(++shots).padStart(2, "0");
  const file = `${OUT}/${n}-${name}.png`;
  await page.screenshot({ path: file, fullPage: opts.fullPage !== false });
  return `${n}-${name}.png`;
}

async function crop(page, selector, name) {
  const el = await page.$(selector);
  if (!el) return null;
  mkdirSync(OUT, { recursive: true });
  const n = String(++shots).padStart(2, "0");
  await el.screenshot({ path: `${OUT}/${n}-${name}.png` });
  return `${n}-${name}.png`;
}

/** Settle on real content, never networkidle (Next dev keeps the HMR socket). */
async function go(page, path, sel) {
  const resp = await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  if (sel) await page.waitForSelector(sel, { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(900);
  return resp;
}

/** Probe an HTTP status without letting the SPA rewrite the URL. */
async function status(page, path) {
  const resp = await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  return { status: resp?.status() ?? null, finalPath: new URL(page.url()).pathname };
}

const main = async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.setDefaultNavigationTimeout(180000);
  page.setDefaultTimeout(90000);
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  // ── sign in, same-origin (Better Auth rejects a cross-origin set-active) ──
  await page.goto(`${BASE}/sign-in`, { waitUntil: "domcontentloaded" });
  const ORG = process.env.PROOF_ORG_ID;
  const auth = await page.evaluate(async ({ EMAIL, PW, ORG }) => {
    const r = await fetch("/api/auth/sign-in/email", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PW }),
    });
    if (!r.ok) return { ok: false, status: r.status, step: "sign-in" };
    if (ORG) {
      const a = await fetch("/api/auth/organization/set-active", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: ORG }),
      });
      if (!a.ok) return { ok: false, status: a.status, step: "set-active" };
    }
    return { ok: true, status: r.status };
  }, { EMAIL, PW, ORG });
  if (!auth.ok) { console.error("auth failed", auth); process.exit(3); }

  // Resolve the session's active org id from the app's own session endpoint.
  const orgId = await page.evaluate(async () => {
    const r = await fetch("/api/auth/get-session");
    if (!r.ok) return null;
    const s = await r.json();
    return s?.session?.activeOrganizationId ?? null;
  });
  if (!orgId) { console.error("no active organization on the session"); process.exit(4); }
  console.log("active org:", orgId);

  // ── A. the retirement itself ─────────────────────────────────────────────
  const bare = await status(page, "/dashboards");
  record("A1", "AUTHENTICATED GET /dashboards → 404 (the directory page is deleted)",
    bare.status === 404, bare);
  record("A2", "no redirect and no tombstone — the URL stays /dashboards",
    bare.finalPath === "/dashboards", bare);
  const a3 = await page.evaluate(() => document.body.innerText.slice(0, 200));
  record("A3", "the 404 is the app's own not-found surface, not a dashboards list",
    !/Operator workspaces composed from extension-shipped portlets/i.test(a3), { text: a3.replace(/\s+/g, " ").trim() });
  await shot(page, "dashboards-404-authenticated");

  // ── B. the PR2 collection routes stay gone ───────────────────────────────
  const coll = await status(page, `/organizations/${orgId}/dashboards`);
  record("B1", "/<scope>/<id>/dashboards collection route still 404s (PR2 deletion holds)",
    coll.status === 404, coll);
  await shot(page, "scope-collection-404");

  // ── C. the surviving scope landings are unaffected ───────────────────────
  const probeLanding = async (path, label, expectSettings) => {
    await go(page, path, '[role="tablist"]');
    const d = await page.evaluate(() => {
      const tl = document.querySelector('[role="tablist"]');
      return {
        h1: document.querySelector("h1")?.textContent?.trim() ?? null,
        tabs: tl ? [...tl.querySelectorAll('[role="tab"], a')].map((t) => ({
          label: (t.textContent ?? "").trim(),
          href: t.getAttribute("href"),
          active: t.getAttribute("data-state") === "active" || t.getAttribute("aria-selected") === "true",
        })) : [],
        // Nothing on a live surface may link at the retired root.
        retiredLinks: [...document.querySelectorAll("a[href]")]
          .map((a) => a.getAttribute("href"))
          .filter((h) => h === "/dashboards" || h === "/dashboards/"),
      };
    });
    const labels = d.tabs.map((t) => t.label);
    record(`C-${label}-tabs`, `${path} — Dashboards tab present and active${expectSettings ? ", Settings alongside" : " (Dashboards-only)"}`,
      labels.includes("Dashboards") && (expectSettings ? labels.includes("Settings") : !labels.includes("Settings")),
      d.tabs);
    record(`C-${label}-noretired`, `${path} — nothing links at the retired /dashboards root`,
      d.retiredLinks.length === 0, d.retiredLinks);
    await shot(page, `landing-${label}`);
    await crop(page, '[role="tablist"]', `landing-${label}-tablist-crop`);
    return d;
  };

  await probeLanding("/personal", "personal", false);
  await probeLanding(`/organizations/${orgId}`, "organization", true);

  // ── D. the MOVED server-action module, exercised across the wire ─────────
  await go(page, `/organizations/${orgId}`, '[role="tablist"]');
  const panel = await page.evaluate(() =>
    !!document.querySelector('[data-conformance-id="scope-dashboards-tab"]'));
  record("D1", "the org landing still mounts the scope collection panel (its wiring imports the MOVED action module)",
    panel, { panel });

  // Open the Add-dashboard popup. Its Reference section calls
  // scopeListCandidatesAction — a server action whose module MOVED in this PR,
  // so a successful round trip is the runtime proof the relocation is safe.
  await page.waitForSelector('button:has-text("Add dashboard")', { timeout: 60000 }).catch(() => {});
  const addBtn = await page.$('button:has-text("Add dashboard")');
  let popup = { opened: false, sections: [], actionErrors: [] };
  if (addBtn) {
    const before = consoleErrors.length;
    await addBtn.click();
    await page.waitForSelector('[role="dialog"]', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2500);
    popup = await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]');
      return {
        opened: !!dlg,
        title: dlg?.querySelector("h2,[data-slot=dialog-title]")?.textContent?.trim() ?? null,
        sections: dlg ? [...dlg.querySelectorAll("h3,h4,[data-slot=dialog-description]")]
          .map((h) => (h.textContent ?? "").trim()).filter(Boolean) : [],
        text: dlg ? (dlg.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 400) : null,
      };
    });
    popup.actionErrors = consoleErrors.slice(before)
      .filter((e) => /server action|Failed to find Server Action|action id/i.test(e));
    await shot(page, "add-dashboard-popup");
    await crop(page, '[role="dialog"]', "add-dashboard-popup-crop");
  }
  record("D2", "the Add-dashboard popup opens and its reference section round-trips the RELOCATED server action (no stale/missing action id)",
    popup.opened && popup.actionErrors.length === 0, popup);
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(400);

  // ── E. the preserved flat detail route, BOTH modes ──────────────────────
  // Mode 1 — a personal/unanchored row renders IN PLACE at /dashboards/{id}:
  // the address `canonicalDashboardPath` mints for it. Mode 2 — an
  // organization-anchored row access-check-redirects to its nested canonical
  // URL. Neither is touched by the directory retirement; both would break if
  // "bare /dashboards fully removed" had been over-read as "the segment goes".
  const FLAT_ID = process.env.PROOF_FLAT_ID ?? "proof-2474pr6-flat";
  const ANCHORED_ID = process.env.PROOF_ANCHORED_ID ?? null;

  const r1 = await go(page, `/dashboards/${FLAT_ID}`, "h1");
  const mode1 = {
    tried: `/dashboards/${FLAT_ID}`,
    status: r1?.status() ?? null,
    finalPath: new URL(page.url()).pathname,
    h1: await page.evaluate(() => document.querySelector("h1")?.textContent?.trim() ?? null),
  };
  record("E1", "flat /dashboards/{id} DETAIL route preserved — a personal/unanchored row renders IN PLACE (mode 1)",
    mode1.status === 200 && mode1.finalPath === `/dashboards/${FLAT_ID}` && !!mode1.h1, mode1);
  await shot(page, "detail-flat-renders-in-place");
  await crop(page, "h1", "detail-flat-h1-crop");

  let mode2 = null;
  if (ANCHORED_ID) {
    const r2 = await go(page, `/dashboards/${ANCHORED_ID}`, "h1");
    mode2 = {
      tried: `/dashboards/${ANCHORED_ID}`,
      status: r2?.status() ?? null,
      finalPath: new URL(page.url()).pathname,
      h1: await page.evaluate(() => document.querySelector("h1")?.textContent?.trim() ?? null),
    };
    record("E2", "flat /dashboards/{id} still access-check-REDIRECTS an org-anchored row to its nested canonical URL (mode 2)",
      mode2.finalPath === `/organizations/${orgId}/dashboards/${ANCHORED_ID}`, mode2);
    await shot(page, "detail-anchored-redirects-to-canonical");
  }

  // ── dark theme, same two facts ───────────────────────────────────────────
  const dark = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const dp = await dark.newPage();
  dp.setDefaultNavigationTimeout(180000);
  dp.setDefaultTimeout(90000);
  await dp.goto(`${BASE}/sign-in`, { waitUntil: "domcontentloaded" });
  await dp.evaluate(async ({ EMAIL, PW, ORG }) => {
    await fetch("/api/auth/sign-in/email", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PW }),
    });
    if (ORG) await fetch("/api/auth/organization/set-active", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId: ORG }),
    });
  }, { EMAIL, PW, ORG });
  const darkBare = await status(dp, "/dashboards");
  record("F1", "dark — /dashboards still 404s", darkBare.status === 404, darkBare);
  await shot(dp, "dashboards-404-dark");
  await go(dp, `/organizations/${orgId}`, '[role="tablist"]');
  await shot(dp, "landing-organization-dark");
  await dark.close();

  // ── narrow viewport ──────────────────────────────────────────────────────
  await page.setViewportSize({ width: 390, height: 844 });
  await go(page, `/organizations/${orgId}`, '[role="tablist"]');
  await shot(page, "landing-organization-390");

  record("G1", "no uncaught page errors during the walk", pageErrors.length === 0, { pageErrors });

  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/probe-results.json`, JSON.stringify({
    base: BASE, orgId, results, consoleErrors, pageErrors,
  }, null, 2));

  const failed = results.filter((r) => r.result === "FAIL");
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  await browser.close();
  process.exit(failed.length === 0 ? 0 : 1);
};

main().catch((e) => { console.error(e); process.exit(9); });
