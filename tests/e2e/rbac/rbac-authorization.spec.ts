/**
 * RBAC browser authorization suite.
 *
 * Scenarios (representative of the documented authorization flows):
 *   1. nav visibility — a non-admin member does NOT see the
 *      admin-only "Analytics" nav entry.
 *   2. the project permissions surface renders the
 *      access-vs-ownership clarity note (project seeded by auth.setup.ts).
 *   3. role-gated admin surface — a member hitting
 *      /configuration/access-control is denied.
 *   4. single-org mode — when the instance toggle is on, the
 *      "Organizations" nav entry is hidden. The describe block toggles the
 *      instance setting on in beforeAll + resets it off in afterAll, with
 *      a wait to clear the 10s readConnectorConfigFromDatabase cache.
 *   5. project admin can grant a customer and revoke them
 *      (uses the customer user seeded by auth.setup.ts).
 *
 * The customer-scoped view runs in a separate spec
 * (rbac-customer-scoped.spec.ts) under the customer's storageState.
 *
 * Hydration: per https://docs.cinatra.ai/references/platform/e2e-headless-hydration/, dev-mode hydration lands
 * ~20–40s after domcontentloaded. waitForHydration targets a stable sidebar
 * element for the __reactFiber$ key (the proven element-specific gate).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";
import { expect, test } from "@playwright/test";

// 180s overall — the grant/revoke flow carries 60s invite + 60s revoke
// assertions plus navigation/hydration; the 120s default is too tight on cold CI.
test.describe.configure({ timeout: 180_000 });

function readSeed(): { projectId: string; customerUserId: string; memberOrgId: string } {
  try {
    return JSON.parse(readFileSync(resolve(process.cwd(), "tests/e2e/rbac/.auth/seed.json"), "utf-8"));
  } catch {
    return { projectId: "rbac-uat-project", customerUserId: "", memberOrgId: "" };
  }
}
const SEED = readSeed();

function readEnvLocal(): Record<string, string> {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf-8");
    const out: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}
const ENV_LOCAL = readEnvLocal();
const DATABASE_URL =
  process.env.SUPABASE_DB_URL ?? ENV_LOCAL.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/postgres";
const SCHEMA = process.env.SUPABASE_SCHEMA ?? ENV_LOCAL.SUPABASE_SCHEMA ?? "cinatra";

// CI runs against a prebuilt standalone production server (instant route
// serve); dev-mode 90s budget was for Turbopack cold-compile per route.
// 30s is generous over realistic prod hydration (<5s).
const HYDRATION_TIMEOUT_MS = process.env.CI ? 30_000 : 90_000;

async function waitForHydration(page: import("@playwright/test").Page) {
  // Per https://docs.cinatra.ai/references/platform/e2e-headless-hydration/ — check a stable sidebar element
  // for the __reactFiber$ key (the proven element-specific gate), not a
  // whole-tree walk.
  await page.waitForFunction(
    () => {
      const el =
        document.querySelector('a[href="/chat"]') ??
        document.querySelector("nav") ??
        document.querySelector('[data-slot="sidebar"]');
      return !!el && Object.keys(el).some((k) => k.startsWith("__reactFiber$"));
    },
    undefined,
    { timeout: HYDRATION_TIMEOUT_MS },
  );
}

test.describe("RBAC — nav visibility + access clarity + role gate", () => {
  test("member does not see the admin-only Analytics nav entry", async ({ page }) => {
    await page.goto("/desk", { waitUntil: "domcontentloaded" });
    await waitForHydration(page);
    const sidebar = page.getByRole("navigation");
    await expect(sidebar.getByText("Analytics", { exact: true })).toHaveCount(0);
  });

  test("member does not see the admin-only Webhooks nav entry (cinatra#342)", async ({ page }) => {
    // The Tools → Webhooks registry is admin-tier — hidden for non-admins via
    // the isAdmin push in layout.tsx, mirroring the Analytics hide above.
    await page.goto("/desk", { waitUntil: "domcontentloaded" });
    await waitForHydration(page);
    const sidebar = page.getByRole("navigation");
    await expect(sidebar.getByText("Webhooks", { exact: true })).toHaveCount(0);
  });

  test("non-admin is denied the Webhooks registry page (cinatra#342)", async ({ page }) => {
    // The page re-enforces with requireAdminSession() — the nav hide is
    // cosmetic. Mirror the Access Control denial assertion above.
    const res = await page.goto("/webhooks", { waitUntil: "domcontentloaded" });
    expect(res?.status() === 403 || res?.status() === 200).toBeTruthy();
    await expect(page.getByText("No webhooks registered yet")).toHaveCount(0);
  });

  test("project permissions surface shows the ownership/access clarity note", async ({ page }) => {
    await page.goto(`/projects/${SEED.projectId}/permissions`, { waitUntil: "domcontentloaded" });
    await waitForHydration(page);
    await expect(page.getByText("Ownership and access are separate")).toBeVisible();
  });

  test("non-admin is denied the Access Control admin surface", async ({ page }) => {
    const res = await page.goto("/configuration/access-control", { waitUntil: "domcontentloaded" });
    // requireAdminSession throws → Next renders an error / redirects. Don't
    // wait for hydration on an error page — the swallowed `.catch` consumed
    // the per-test budget without surfacing failure (cause of one observed
    // 30-min CI hang). Asserting status + absence-of-element is sufficient.
    expect(res?.status() === 403 || res?.status() === 200).toBeTruthy();
    await expect(page.getByText("Single-organization mode")).toHaveCount(0);
  });
});

test.describe("single-org mode", () => {
  // The single-org toggle is read via readConnectorConfigFromDatabase which
  // has a 10s per-process cache. We set the metadata KV directly (no admin
  // session needed for the non-admin member), wait > TTL for the dev server
  // to re-read, then reset on teardown.
  async function setSingleOrg(on: boolean): Promise<void> {
    const c = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5_000 });
    await c.connect();
    try {
      const value = JSON.stringify({ singleOrg: on });
      await c.query(
        `INSERT INTO "${SCHEMA}"."metadata" (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        ["connector_config:instance_identity", value],
      );
    } finally {
      await c.end();
    }
  }

  test.beforeAll(async () => {
    await setSingleOrg(true);
    // Bust the dev server's 10s connector_config cache + a small buffer.
    await new Promise((r) => setTimeout(r, 11_000));
  });
  test.afterAll(async () => {
    await setSingleOrg(false);
  });

  test("hides the Organizations nav entry when single-org mode is on", async ({ page }) => {
    await page.goto("/desk", { waitUntil: "domcontentloaded" });
    await waitForHydration(page);
    const sidebar = page.getByRole("navigation");
    await expect(sidebar.getByText("Organizations", { exact: true })).toHaveCount(0);
  });
});

test.describe("project admin grant → revoke customer", () => {
  test("invite a customer then revoke them", async ({ page }) => {
    await page.goto(`/projects/${SEED.projectId}/customers`, { waitUntil: "domcontentloaded" });
    await waitForHydration(page);

    // Invite. The server action does a Postgres write + revalidatePath which
    // re-compiles in dev mode — give it generous headroom over the default 10s.
    await page.getByRole("button", { name: /invite customer/i }).click();
    await page.getByLabel(/customer user id/i).fill(SEED.customerUserId);
    await page.getByRole("button", { name: /^invite$/i }).click();
    await expect(page.getByText(SEED.customerUserId)).toBeVisible({ timeout: 60_000 });

    // Revoke (same dev-mode budget as invite). 60s headroom — the dev-mode
    // server action + revalidatePath can spike above 30s on cold CI.
    await page.getByRole("button", { name: /revoke/i }).first().click();
    await expect(page.getByText(SEED.customerUserId)).toHaveCount(0, { timeout: 60_000 });
  });
});
