/**
 * cinatra#2058 live-verify — the workspace-wide `/dashboards` directory page is
 * RETIRED with no redirect and no backward-compatibility shim. This smoke drives
 * the REAL stack (real Postgres + a Better Auth session + a real Next server, via
 * the dashboard-live-verify workflow) and proves the exact acceptance behaviors:
 *
 *   1. an AUTHENTICATED GET of `/dashboards` returns 404 (the directory route
 *      file is gone — nothing renders the workspace-wide list);
 *   2. a SESSIONLESS GET of `/dashboards` returns the SAME 404 (no redirect to
 *      `/sign-in`, URL unchanged): once the page file is deleted the route no
 *      longer exists, so a fresh cookieless context gets the identical 404 an
 *      authenticated request does — the retirement reveals nothing and adds no
 *      redirect (owner ruling #2058: "retire without redirect / backward
 *      compatibility"; grounded on the live prod-standalone stack, PR #2059). The
 *      auth GUARD itself is untouched by #2058 — that the guard still 307s a
 *      sessionless request on a real protected path is proven at the unit layer
 *      (`src/lib/__tests__/auth-route-guard-public-paths.test.ts`), the correct
 *      home for it: this standalone smoke does not exercise the middleware
 *      /sign-in redirect (a fresh context is not redirected here for ANY route,
 *      /artifacts included), so the e2e proves only the 404 retirement;
 *   3. the flat `/dashboards/[id]` detail route renders IN PLACE (200, URL
 *      unchanged) for a personal/user-owned dashboard — the canonical address for
 *      unanchored rows (detail mode 1, unchanged by #2058);
 *   4. the flat `/dashboards/[id]` route ACCESS-CHECK-REDIRECTS (→ the nested
 *      canonical URL) for an organization-anchored dashboard (detail mode 2,
 *      unchanged by #2058); and
 *   5. that nested canonical URL renders (200).
 *
 * The per-dashboard detail routing is deliberately NOT modified by #2058; items
 * 3–5 are regressions this smoke keeps honest. Evidence screenshots are written
 * to `test-results/` (uploaded by the dashboard-live-verify workflow).
 */
import fs from "node:fs";
import path from "node:path";

import { Pool } from "pg";
import { test, expect } from "@playwright/test";

import { APIVERSION_V12, V12_ANALYTICS_DASHBOARD_ID } from "./seed-data";

const EMAIL = process.env.E2E_USER_EMAIL ?? "option-a-test@local.test";
const DATABASE_URL =
  process.env.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5434/postgres";
const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
const EVIDENCE_DIR =
  process.env.RETIRE2058_EVIDENCE_DIR ?? path.join(process.cwd(), "test-results");

/** Deterministic id of the organization-anchored operator dashboard this smoke
 *  seeds to exercise the flat-route → nested-canonical redirect (detail mode 2). */
const ORG_ANCHORED_ID = "e2e-2058-org-anchored";

/** A minimal apiVersion 1.2 operator-dashboard envelope. The redirect under test
 *  fires BEFORE any config validation, and an unvalidated config renders the
 *  "unsupported format" card (still a 200) on the nested route — so this smoke's
 *  ROUTE-level assertions do not depend on portlet content. */
const V12_MINIMAL_ENVELOPE = { apiVersion: APIVERSION_V12, portlets: [] as unknown[] };

function evidencePath(name: string): string {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  return path.join(EVIDENCE_DIR, name);
}

/** The active org id of the seeded test user — resolved + memoized in beforeAll
 *  so the redirect-target assertion can name the exact nested canonical URL. */
let orgId = "";

test.describe("dashboards directory-page retirement (#2058) live-verify", () => {
  test.beforeAll(async () => {
    const pool = new Pool({ connectionString: DATABASE_URL });
    const schema = `"${SCHEMA.replaceAll('"', '""')}"`;
    try {
      // Resolve the seeded test user + its active org (auth.setup created both).
      const userRow = await pool.query(
        `SELECT id FROM public."user" WHERE email = $1 LIMIT 1`,
        [EMAIL],
      );
      if (userRow.rows.length === 0) {
        throw new Error(`#2058 seed: test user ${EMAIL} not found (auth.setup did not run?)`);
      }
      const userId = userRow.rows[0].id as string;
      const memberRow = await pool.query(
        `SELECT "organizationId" FROM public."member" WHERE "userId" = $1 LIMIT 1`,
        [userId],
      );
      if (memberRow.rows.length === 0) {
        throw new Error(`#2058 seed: user ${userId} has no org membership`);
      }
      orgId = memberRow.rows[0].organizationId as string;

      // Seed one ORGANIZATION-anchored operator dashboard (entity_type/entity_id
      // set → canonical URL is the nested `/organizations/{orgId}/dashboards/{id}`).
      // owner_level='organization' → every member of that org passes the read
      // gate (cinatra#1898: a dashboard is always visible to everyone in its
      // scope; the demoted `visibility` column is gone), so the flat route
      // REDIRECTS (rather than 404s) to the canonical URL. Idempotent on id.
      await pool.query(
        `INSERT INTO ${schema}.dashboards
           (id, name, config_json, config_version, owner_level, owner_id,
            organization_id, entity_type, entity_id, status, created_by)
         VALUES ($1, $2, $3::jsonb, $4, 'organization', $5, $5,
                 'organization', $5, 'published', $6)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           config_json = EXCLUDED.config_json,
           config_version = EXCLUDED.config_version,
           owner_level = EXCLUDED.owner_level,
           owner_id = EXCLUDED.owner_id,
           organization_id = EXCLUDED.organization_id,
           entity_type = EXCLUDED.entity_type,
           entity_id = EXCLUDED.entity_id,
           status = EXCLUDED.status`,
        [
          ORG_ANCHORED_ID,
          "E2E 2058 Org-Anchored",
          JSON.stringify(V12_MINIMAL_ENVELOPE),
          APIVERSION_V12,
          orgId,
          userId,
        ],
      );
    } finally {
      await pool.end();
    }
  });

  test("an AUTHENTICATED GET of /dashboards 404s (directory route retired)", async ({ page }) => {
    const resp = await page.goto("/dashboards", { waitUntil: "domcontentloaded" });
    expect(resp, "no response for GET /dashboards").not.toBeNull();
    expect(
      resp?.status(),
      `authenticated GET /dashboards must 404 (retired directory route); got ${resp?.status()}`,
    ).toBe(404);
    // No redirect away from /dashboards for an authenticated request.
    expect(new URL(page.url()).pathname).toBe("/dashboards");
    await page.screenshot({ path: evidencePath("2058-authed-dashboards-404.png"), fullPage: true });
  });

  test("a SESSIONLESS GET of /dashboards 404s exactly like an authenticated one — no /sign-in redirect (retirement is gone for everyone)", async ({
    browser,
  }) => {
    // A fresh context inherits no auth cookie. The retired directory route no
    // longer exists, so this GET 404s exactly as the authenticated one does
    // (proven at :123) — the route is simply gone for everyone, with no redirect
    // and nothing revealed. Grounded on the live prod-standalone stack (PR #2059):
    // a sessionless GET stays on /dashboards (it does NOT 307 to /sign-in),
    // matching the #2058 owner ruling ("retire without redirect / backward
    // compatibility") and the acceptance correction.
    //
    // The auth GUARD is untouched by #2058; that it still 307s a sessionless
    // request on a real protected path is proven at the unit layer
    // (src/lib/__tests__/auth-route-guard-public-paths.test.ts). This standalone
    // smoke does not exercise that middleware redirect (a fresh context is not
    // redirected here for ANY route), so it asserts only the 404 retirement.
    const ctx = await browser.newContext();
    try {
      const p = await ctx.newPage();
      const retired = await p.goto("/dashboards", { waitUntil: "domcontentloaded" });
      expect(retired, "no response for sessionless GET /dashboards").not.toBeNull();
      // 404, asserted exactly like the authenticated 404 at :123.
      expect(
        retired?.status(),
        `sessionless GET /dashboards must 404 (retired route, no redirect); got ${retired?.status()} @ ${p.url()}`,
      ).toBe(404);
      // No redirect away from /dashboards for a sessionless request either.
      expect(
        new URL(p.url()).pathname,
        `sessionless GET /dashboards must NOT redirect to /sign-in; landed on ${p.url()}`,
      ).toBe("/dashboards");
      await p.screenshot({
        path: evidencePath("2058-sessionless-dashboards-404.png"),
        fullPage: true,
      });
    } finally {
      await ctx.close();
    }
  });

  test("the flat /dashboards/[id] renders IN PLACE for a personal/user-owned dashboard (mode 1)", async ({
    page,
  }) => {
    const flatUrl = `/dashboards/${V12_ANALYTICS_DASHBOARD_ID}`;
    const resp = await page.goto(flatUrl, { waitUntil: "domcontentloaded" });
    expect(resp?.status(), `flat user-owned detail must render 200; got ${resp?.status()}`).toBe(200);
    // Unanchored (personal) row → the flat route IS canonical: no redirect.
    expect(new URL(page.url()).pathname).toBe(flatUrl);
    await page.screenshot({ path: evidencePath("2058-flat-personal-render.png"), fullPage: true });
  });

  test("the flat /dashboards/[id] access-check-redirects an org-anchored dashboard to its nested canonical URL (mode 2), which renders", async ({
    page,
  }) => {
    expect(orgId, "orgId not resolved in beforeAll").not.toBe("");
    const canonical = `/organizations/${orgId}/dashboards/${ORG_ANCHORED_ID}`;
    const resp = await page.goto(`/dashboards/${ORG_ANCHORED_ID}`, {
      waitUntil: "domcontentloaded",
    });
    // Playwright follows the 307 → we land on the nested canonical URL, which renders.
    expect(
      new URL(page.url()).pathname,
      `org-anchored flat route must redirect to the nested canonical URL; landed on ${page.url()}`,
    ).toBe(canonical);
    expect(resp?.status(), `nested canonical route must render 200; got ${resp?.status()}`).toBe(200);
    await page.screenshot({ path: evidencePath("2058-org-anchored-redirect.png"), fullPage: true });
  });

  test("the nested canonical route renders directly (200, no redirect) — mode 2 canonical address", async ({
    page,
  }) => {
    expect(orgId, "orgId not resolved in beforeAll").not.toBe("");
    const canonical = `/organizations/${orgId}/dashboards/${ORG_ANCHORED_ID}`;
    const resp = await page.goto(canonical, { waitUntil: "domcontentloaded" });
    expect(resp?.status(), `nested canonical must render 200; got ${resp?.status()}`).toBe(200);
    expect(new URL(page.url()).pathname).toBe(canonical);
  });
});
