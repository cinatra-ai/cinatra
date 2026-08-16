// cinatra#2698 (install-semantics S4, rework) visual proof — real app, real dev
// server, real browser sessions, on a lane host. No mockup; no credential in the
// file (every account value comes from the environment).
import { chromium, request as pwRequest } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import pg from "pg";

const BASE = process.env.PROOF_BASE ?? "http://localhost:3010";
const OUT = process.env.PROOF_OUT ?? "./evidence/2698-s4-supersession";
const DB = process.env.PROOF_DB;
const PKG = "@cinatra-ai/youtube-connector";
const SETTINGS = `/configuration/extensions/settings/connector/${PKG}`;
const ADMIN = { tag: "platform-admin", email: process.env.PROOF_ADMIN_EMAIL, password: process.env.PROOF_PW };
const ORGADMIN = { tag: "org-admin", email: process.env.PROOF_MEMBER_EMAIL, password: process.env.PROOF_PW };

mkdirSync(OUT, { recursive: true });
const results = [];
const note = (o) => { results.push(o); console.log(JSON.stringify(o).slice(0, 700)); };

const db = new pg.Client({ connectionString: DB, connectionTimeoutMillis: 5000 });
await db.connect();
note({
  step: "row-identity",
  asserts: "the package carries TWO canonical rows: the LIVE workspace-anchored row that supersedes, and the SUPERSEDED organization row — archived in place, its id and its own access policy retained",
  rows: (await db.query(
    `SELECT id, package_name, kind, owner_level, owner_id, organization_id, status, version
       FROM cinatra.installed_extension WHERE package_name = $1 ORDER BY owner_level`, [PKG])).rows,
  retainedPolicies: (await db.query(
    `SELECT p.resource_id, p.policy FROM cinatra.extension_access_policy p
       JOIN cinatra.installed_extension e ON e.id = p.resource_id
      WHERE e.package_name = $1 ORDER BY e.owner_level`, [PKG])).rows,
});

async function signIn(who) {
  const ctx = await pwRequest.newContext({ baseURL: BASE });
  const r = await ctx.post("/api/auth/sign-in/email", {
    data: { email: who.email, password: who.password },
    headers: { Origin: BASE }, failOnStatusCode: false, timeout: 180000,
  });
  const state = `/tmp/state-${who.tag}.json`;
  await ctx.storageState({ path: state });
  note({ step: "sign-in", role: who.tag, httpStatus: r.status() });
  await ctx.dispose();
  return state;
}

const INSTALLED_PROBE = () => {
  const cards = [...document.querySelectorAll('[data-slot="installed-extension-card"], article')];
  const text = (n) => (n.textContent || '').replace(/\s+/g, ' ').trim();
  const yt = cards.filter((c) => /YouTube\s*Connector/i.test(text(c)));
  return {
    totalCards: cards.length,
    youtubeConnectorCardCount: yt.length,
    youtubeConnectorCardText: yt.map((c) => text(c).slice(0, 240)),
  };
};

const MARKET_PROBE = () => {
  const up = (n, k) => { let e = n; for (let i = 0; i < k && e.parentElement; i++) e = e.parentElement; return e; };
  const all = [...document.querySelectorAll("[data-cta-state]")].map((n) => ({
    state: n.getAttribute("data-cta-state"),
    cta: (n.textContent || "").replace(/\s+/g, " ").trim(),
    head: (up(n, 5).textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
  }));
  const yt = all.filter((c) => /youtube/i.test(c.head));
  return {
    catalogCardCount: all.length,
    youtubeCard: yt,
    workspaceReachPillPresent: yt.some((c) => /Installed \(Workspace: All\)/.test(c.cta)),
    youtubeInstallActionOffered: yt.some((c) => c.state === "install" || c.state === "restore" || c.state === "update"),
  };
};

const SETTINGS_PROBE = () => {
  const rowsOf = (sec) => [...sec.querySelectorAll(":scope > div")].map((row) => {
    const left = row.firstElementChild;
    const title = left && left.firstElementChild ? left.firstElementChild.textContent.trim() : null;
    const ctl = row.querySelector("button, a");
    const reasonEl = row.querySelector('[data-slot="lifecycle-capability-reason"]');
    return {
      row: title,
      control: ctl ? (ctl.textContent || "").replace(/\s+/g, " ").trim() : null,
      enabled: ctl ? !(ctl.disabled === true || ctl.getAttribute("aria-disabled") === "true") : null,
      capabilityReason: reasonEl ? reasonEl.textContent.trim() : null,
    };
  });
  const out = [];
  for (const sel of ['[data-slot="settings-maintenance"]', '[data-slot="settings-danger-zone"]']) {
    const sec = document.querySelector(sel);
    if (sec) out.push(...rowsOf(sec).filter((r) => r.control || r.row));
  }
  return {
    affordances: out,
    h1: document.querySelector("h1")?.textContent?.trim() ?? null,
    reasonsOnPage: [...document.querySelectorAll('[data-slot="lifecycle-capability-reason"]')].map((n) => n.textContent.trim()),
  };
};

async function visit(ctx, path, name, asserts, probe) {
  const page = await ctx.newPage();
  const resp = await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 300000 });
  await page.waitForSelector("main, h1", { state: "visible", timeout: 300000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const data = await page.evaluate(probe).catch((e) => ({ probeError: String(e) }));
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  note({ step: name, asserts, httpStatus: resp && resp.status(), finalPath: new URL(page.url()).pathname, ...data, file: `${name}.png` });
  await page.close();
}

const browser = await chromium.launch({ headless: true });

const adminCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: await signIn(ADMIN), baseURL: BASE });
await visit(adminCtx, "/configuration/extensions?tab=active", "a-installed-list-one-card",
  "(a) the installed list, Active filter: ONE card for the package — the effective (workspace) row. The superseded organization row contributes nothing to it.", INSTALLED_PROBE);
await visit(adminCtx, SETTINGS, "b-settings-platform-admin-active-org",
  "(b) design §V for a PLATFORM ADMIN whose session carries an ACTIVE ORGANIZATION, on the effective workspace row: Archive and Reinstall latest are LIVE and no refusal copy is on the page.", SETTINGS_PROBE);
await visit(adminCtx, "/configuration/marketplace", "c-marketplace-installed-workspace-all",
  "(c) the marketplace card for the same package: the disabled pill states the reach — 'Installed (Workspace: All)' — and no install action is offered.", MARKET_PROBE);
await visit(adminCtx, "/configuration/extensions?tab=archived", "d-archived-organization-row",
  "(d) the Archived filter: the SUPERSEDED organization row is visible to an authorized admin, and restorable through the ordinary guarded path once the workspace install is gone.", INSTALLED_PROBE);
await adminCtx.close();

const orgCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: await signIn(ORGADMIN), baseURL: BASE });
await visit(orgCtx, "/configuration/marketplace", "e-marketplace-org-admin-gated",
  "(e) the SAME marketplace address as an organization administrator who is not a platform administrator: the configuration area is platform-admin-only, so this account never reaches the card at all.", MARKET_PROBE);
await orgCtx.close();

await browser.close();
await db.end();
writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
console.log("WROTE results.json");
