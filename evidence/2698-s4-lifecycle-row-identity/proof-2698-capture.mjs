// cinatra#2698 (install-semantics S4) visual proof — real app, real dev server,
// real sessions, on a lane host.
//
// ONE user-visible change: on the §V extension settings page, a PLATFORM ADMIN
// whose session carries an ACTIVE ORGANIZATION can now operate the lifecycle
// affordances of a WORKSPACE-ANCHORED (org-NULL) install row. Before the slice
// the row was addressable from no session at all, so Archive / Activate /
// Reinstall / Force-delete rendered greyed with the reason
//   "Installed for the whole platform. Only a platform administrator with no
//    active organization can act on it."
// After the slice they render LIVE, and the greyed copy — where it still
// applies — drops the "with no active organization" clause.
//
// No credential is embedded: every account value comes from the environment.
import { chromium, request as pwRequest } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { Client } from "pg";

const BASE = process.env.PROOF_BASE ?? "http://localhost:3010";
const OUT = process.env.PROOF_OUT ?? "./proof-2698";
const DB = process.env.PROOF_DB;
const TAG = process.env.PROOF_TAG ?? "after"; // "before" (base) | "after" (branch)
const KIND = process.env.PROOF_KIND ?? "connector";
const PKG = process.env.PROOF_PKG ?? "@cinatra-ai/youtube-connector";
const ROUNDTRIP = process.env.PROOF_ROUNDTRIP === "1";
const HREF = `/configuration/extensions/settings/${KIND}/${PKG}`;

const ADMIN = {
  tag: "platform-admin",
  email: process.env.PROOF_ADMIN_EMAIL,
  password: process.env.PROOF_ADMIN_PW,
};
const ORGADMIN = {
  tag: "org-admin",
  email: process.env.PROOF_MEMBER_EMAIL,
  password: process.env.PROOF_MEMBER_PW,
};

mkdirSync(OUT, { recursive: true });
const results = [];
const note = (o) => {
  results.push(o);
  console.log(JSON.stringify(o));
};

// --- the row identity under test, read straight from the store -------------
const db = new Client({ connectionString: DB, connectionTimeoutMillis: 5000 });
await db.connect();
const rowSql = `SELECT id, package_name, kind, owner_level, owner_id, organization_id,
                       status, is_default, version, required_in_prod
                  FROM cinatra.installed_extension WHERE package_name = $1 ORDER BY id`;
const readRows = async () => (await db.query(rowSql, [PKG])).rows;

const rowsBefore = await readRows();
note({
  step: "row-identity",
  asserts:
    "the canonical rows this package carries in the store — ONE workspace-anchored, org-NULL row",
  rows: rowsBefore,
});

// --- the two sessions, as the database records their standing --------------
const users = (
  await db.query(
    `SELECT u.id, u.email, COALESCE(u.role,'') AS platform_role,
            m.role AS org_role, s."activeOrganizationId" IS NOT NULL AS session_has_active_org
       FROM public."user" u
       LEFT JOIN public.member m ON m."userId" = u.id
       LEFT JOIN LATERAL (SELECT "activeOrganizationId" FROM public.session
                           WHERE "userId" = u.id ORDER BY "createdAt" DESC LIMIT 1) s ON TRUE
      WHERE u.email = ANY($1) ORDER BY u.email`,
    [[ADMIN.email, ORGADMIN.email]],
  )
).rows;
note({
  step: "actors",
  asserts:
    "one platform admin (platform_role admin) and one org admin (platform_role user, org_role admin); both sessions carry an active organization",
  rows: users,
});

// --- sign in ---------------------------------------------------------------
async function signIn(who) {
  const ctx = await pwRequest.newContext({ baseURL: BASE });
  const r = await ctx.post("/api/auth/sign-in/email", {
    data: { email: who.email, password: who.password },
    headers: { Origin: BASE },
    failOnStatusCode: false,
    timeout: 180000,
  });
  const state = `${OUT}/state-${TAG}-${who.tag}.json`;
  await ctx.storageState({ path: state });
  note({ step: "sign-in", role: who.tag, httpStatus: r.status() });
  await ctx.dispose();
  return state;
}

// --- the affordance probe: what the SERVER rendered ------------------------
const PROBE = () => {
  const rowsOf = (sec) =>
    [...sec.querySelectorAll(":scope > div")].map((row) => {
      const left = row.firstElementChild;
      const title =
        left && left.firstElementChild ? left.firstElementChild.textContent.trim() : null;
      const ctl = row.querySelector("button, a");
      const reasonEl = row.querySelector('[data-slot="lifecycle-capability-reason"]');
      return {
        row: title,
        control: ctl ? (ctl.textContent || "").replace(/\s+/g, " ").trim() : null,
        enabled: ctl
          ? !(ctl.disabled === true || ctl.getAttribute("aria-disabled") === "true")
          : null,
        disabledReason: ctl ? ctl.getAttribute("data-disabled-reason") : null,
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
    reasonsOnPage: [...document.querySelectorAll('[data-slot="lifecycle-capability-reason"]')].map(
      (n) => n.textContent.trim(),
    ),
  };
};

// Screenshots are recorded by FILE NAME only — the results file names the
// evidence, never a location on the machine that produced it.
async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  const parts = {};
  for (const [slot, suffix] of [
    ["settings-maintenance", "maintenance"],
    ["settings-danger-zone", "danger-zone"],
  ]) {
    const el = page.locator(`[data-slot="${slot}"]`).first();
    if ((await el.count()) > 0) {
      await el.screenshot({ path: `${OUT}/${name}-${suffix}.png` });
      parts[suffix] = `${name}-${suffix}.png`;
    }
  }
  return { file: `${name}.png`, parts };
}

async function openSettings(ctx, name, asserts) {
  const page = await ctx.newPage();
  const resp = await page.goto(`${BASE}${HREF}`, {
    waitUntil: "domcontentloaded",
    timeout: 180000,
  });
  await page
    .waitForSelector('[data-slot="settings-maintenance"], main, h1', {
      state: "visible",
      timeout: 180000,
    })
    .catch(() => {});
  await page.waitForTimeout(1500);
  const probe = await page.evaluate(PROBE);
  const files = await shot(page, name);
  note({
    step: name,
    asserts,
    httpStatus: resp && resp.status(),
    finalPath: new URL(page.url()).pathname,
    ...probe,
    files,
  });
  return { page, probe };
}

const browser = await chromium.launch({ headless: true });

// --- (a) the platform admin, active organization ---------------------------
const adminState = await signIn(ADMIN);
const adminCtx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  storageState: adminState,
  baseURL: BASE,
});
const { page: adminPage } = await openSettings(
  adminCtx,
  `${TAG}-a-platform-admin-active-org`,
  TAG === "before"
    ? "BEFORE (base): the platform admin's active organization makes the workspace-anchored row unaddressable — every lifecycle affordance is greyed and the reason names a session shape"
    : "AFTER (branch): the same platform admin, same active organization, same row — Archive and Reinstall are LIVE",
);

// --- the shipped write path, on the workspace-anchored row -----------------
if (ROUNDTRIP && TAG === "after") {
  try {
    await adminPage.getByRole("button", { name: "Archive", exact: true }).click();
    await adminPage.waitForTimeout(6000);
    const archived = await readRows();
    note({
      step: "roundtrip-archive",
      asserts:
        "the LIVE Archive button ran: the workspace-anchored row is archived and its anchor tuple is unchanged",
      rows: archived,
    });
    await adminPage.close();
    const { page: p2 } = await openSettings(
      adminCtx,
      `${TAG}-c-platform-admin-archived-row`,
      "AFTER (branch): with the workspace-anchored row archived, Activate (restore) is LIVE for the same platform admin",
    );
    await p2.getByRole("button", { name: "Activate", exact: true }).click();
    await p2.waitForTimeout(6000);
    const restored = await readRows();
    note({
      step: "roundtrip-activate",
      asserts:
        "the LIVE Activate button ran: the row is active again and STILL workspace-anchored (no re-anchor to the actor's organization)",
      rows: restored,
    });
    await p2.close();
  } catch (err) {
    note({ step: "roundtrip", error: String(err && err.message ? err.message : err) });
  }
} else {
  await adminPage.close();
}
await adminCtx.close();

// --- (b) the org admin, same row ------------------------------------------
const orgState = await signIn(ORGADMIN);
const orgCtx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  storageState: orgState,
  baseURL: BASE,
});
const { page: orgPage } = await openSettings(
  orgCtx,
  `${TAG}-b-org-admin`,
  "the org admin (not a platform admin) on the SAME row — unchanged by this slice",
);
await orgPage.close();
await orgCtx.close();

await browser.close();
await db.end();
writeFileSync(`${OUT}/results-${TAG}.json`, JSON.stringify(results, null, 2));
console.log("WROTE", `${OUT}/results-${TAG}.json`);
