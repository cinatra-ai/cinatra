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
 *      instance setting on in beforeAll + resets it off in afterAll. Both go
 *      through the shared settings-row helper, which preserves the sibling
 *      settings on that row and waits the 10s
 *      readConnectorConfigFromDatabase cache out.
 *   5. project admin can grant a guest and revoke them, on an instance whose
 *      registration is CLOSED — the posture a real instance ships with. An
 *      invitation is an explicit admin road, so it has to work there; the
 *      describe closes registration itself rather than inheriting whatever
 *      an earlier suite happened to leave behind.
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
import { expect, test } from "@playwright/test";

import {
  closeRegistrationForFixtures,
  openRegistrationForFixtures,
  patchInstanceSettingsForFixtures,
} from "../open-registration";

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

  test("Webhooks is not a left-sidebar nav entry (moved under Configuration, cinatra#696)", async ({ page }) => {
    // The Tools → Webhooks registry moved under Configuration — it is no longer
    // a sidebar entry for any actor; the page lives at /configuration/webhooks.
    await page.goto("/desk", { waitUntil: "domcontentloaded" });
    await waitForHydration(page);
    const sidebar = page.getByRole("navigation");
    await expect(sidebar.getByText("Webhooks", { exact: true })).toHaveCount(0);
  });

  test("non-admin is denied the Webhooks registry page (cinatra#342, relocated #696)", async ({ page }) => {
    // The page re-enforces with requireAdminSession() at its new location.
    // Mirror the Access Control denial assertion above.
    const res = await page.goto("/configuration/webhooks", { waitUntil: "domcontentloaded" });
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

  test("non-admin is denied the /configuration landing page (cinatra#1563 — server gate unchanged)", async ({ page }) => {
    // Configuration moved from the sidebar to an admin-only top-bar cog
    // (cinatra#1563). Hiding the cog is DISCOVERABILITY only — /configuration
    // itself stays server-side admin-gated via requireAdminSession(), so a
    // non-admin deep-linking straight to it is still rejected/redirected.
    // Mirror the Access Control / Webhooks denials: assert status + absence of
    // the admin-only landing content (no hydration wait on an error page).
    const res = await page.goto("/configuration", { waitUntil: "domcontentloaded" });
    expect(res?.status() === 403 || res?.status() === 200).toBeTruthy();
    await expect(
      page.getByText(
        "Workspace controls for platform configuration, access, extensions, and operations.",
      ),
    ).toHaveCount(0);
  });

  test("non-admin sees no Configuration/Admin sidebar entry and no top-bar cog (cinatra#1563)", async ({ page }) => {
    await page.goto("/desk", { waitUntil: "domcontentloaded" });
    await waitForHydration(page);
    const sidebar = page.getByRole("navigation");
    // Configuration is no longer a sidebar entry for anyone; its former "Admin"
    // group heading is gone (its sole item left the sidebar).
    await expect(sidebar.getByText("Configuration", { exact: true })).toHaveCount(0);
    await expect(sidebar.getByText("Admin", { exact: true })).toHaveCount(0);
    // The top-bar cog is admin-only — a non-admin sees no Configuration affordance.
    await expect(page.getByTestId("topbar-configuration-cog")).toHaveCount(0);
  });
});

/**
 * cinatra#2700 (epic #2699) — THE GATE SWEEP, live.
 *
 * `/configuration` is the platform-admin area throughout. The twelve routes
 * enumerated below were reachable by any signed-in user before the sweep (the
 * extensions list, the LLM + Development + Telemetry pages, the five `apps/*`
 * redirect shims, and the two former carve-outs — the agent-approval detail and
 * the per-object artifact-restore page). Each must now land the member on
 * `/not-authorized`, which is the epic's own acceptance wording.
 *
 * A redirect SHIM is included deliberately: it must refuse at its own address
 * rather than forward a member to the destination's refusal.
 *
 * The source-level route table (all 34 pages + the 6 handler methods) lives in
 * src/app/configuration/__tests__/configuration-admin-gate.test.ts; this is the
 * live half.
 */
const SWEPT_ROUTES: Array<[route: string, what: string]> = [
  ["/configuration/extensions", "the extensions list (was session-only)"],
  ["/configuration/llm", "the LLM APIs page"],
  ["/configuration/llm/anthropic", "an LLM connector setup page"],
  ["/configuration/development", "Development"],
  ["/configuration/telemetry", "Telemetry"],
  ["/configuration/apps", "the apps → llm redirect shim"],
  ["/configuration/apps/apollo", "the apollo redirect shim"],
  ["/configuration/apps/gmail", "the gmail redirect shim"],
  ["/configuration/apps/openai", "the openai redirect shim"],
  ["/configuration/apps/openai-skills", "the openai-skills redirect shim"],
  [
    "/configuration/agents/approvals/rbac-uat-no-such-request",
    "the agent-approval detail (was author-readable)",
  ],
  [
    "/configuration/artifacts/restore/rbac-uat-no-such-change-set",
    "the artifact-restore page (was per-object only)",
  ],
];

test.describe("cinatra#2700 — every swept /configuration route denies a non-admin", () => {
  for (const [route, what] of SWEPT_ROUTES) {
    test(`non-admin lands on /not-authorized for ${route} — ${what}`, async ({ page }) => {
      // No hydration wait: this is a refusal page, and waiting for hydration on
      // one burned a per-test budget in an earlier run (see the denials above).
      await page.goto(route, { waitUntil: "domcontentloaded" });
      expect(new URL(page.url()).pathname).toBe("/not-authorized");
      await expect(
        page.getByText("This area is limited to platform admins.", { exact: false }),
      ).toBeVisible();
    });
  }
});

test.describe("single-org mode", () => {
  // The single-org toggle is read via readConnectorConfigFromDatabase which
  // has a 10s per-process cache. The shared helper records the toggle on the
  // instance settings row and waits that cache out for us.
  //
  // It goes through the helper rather than writing the row here, because the
  // single-org toggle SHARES that row with the registration setting. A
  // hand-rolled whole-row write states one toggle and deletes the other, and a
  // missing registration key does not read as "unchanged" — it reads as
  // CLOSED. That is how this describe used to close the instance behind the
  // guest-invite describe below.
  async function setSingleOrg(on: boolean): Promise<void> {
    await patchInstanceSettingsForFixtures(
      { singleOrg: on },
      { databaseUrl: DATABASE_URL, schema: SCHEMA },
    );
  }

  test.beforeAll(async () => {
    await setSingleOrg(true);
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

test.describe("project admin grant → revoke guest (cinatra#1501)", () => {
  // A FRESH external email, deliberately NOT the seeded customer fixture: the
  // seeded customer is an org member (the session-resolution workaround in
  // auth.setup.ts), and the ratified guest model classifies org members as
  // "already a member" instead of granting. Inviting an unknown email
  // exercises the full new path — account creation + guest grant — for real.
  const GUEST_EMAIL = `rbac-guest-uat-${Date.now().toString(36)}@local.test`;

  // Registration CLOSED — the posture a real instance ships with, and the one
  // that makes this test worth running. The acting member is a project owner
  // and NOT a platform admin (auth.setup.ts is explicit about that), so this
  // is the ordinary case: someone who administers one project invites an
  // outside collaborator on an instance that turns strangers away. An
  // invitation is an explicit admin road; it has to land here, or the only
  // people who can ever bring a guest in are platform admins.
  //
  // Stated here rather than inherited: on an open instance the invite would
  // ride the public sign-up road and this test would prove nothing about the
  // closed one.
  test.beforeAll(async () => {
    await closeRegistrationForFixtures({ databaseUrl: DATABASE_URL, schema: SCHEMA });
  });
  test.afterAll(async () => {
    await openRegistrationForFixtures({ databaseUrl: DATABASE_URL, schema: SCHEMA });
  });

  test("invite a guest by email then revoke them", async ({ page }) => {
    await page.goto(`/projects/${SEED.projectId}/permissions`, { waitUntil: "domcontentloaded" });
    await waitForHydration(page);

    const guests = page.getByTestId("project-guests-section");
    await expect(guests).toBeVisible({ timeout: 30_000 });

    // Invite. The server action does account creation + two Postgres writes +
    // revalidatePath which re-compiles in dev mode — generous headroom.
    await guests.locator("#guest-email").fill(GUEST_EMAIL);
    await guests.getByRole("button", { name: /invite guest/i }).click();
    await expect(guests.getByText(GUEST_EMAIL, { exact: false })).toBeVisible({
      timeout: 60_000,
    });

    // The seeded ORG-MEMBER customer must be rejected by classification —
    // never relabeled a guest. Wait for the action's toast (any), THEN assert
    // its text: a wrong classification fails immediately with the actual copy
    // in the error instead of a blind 60s timeout after the toast expired.
    // Let invite #1's toast expire first so the next toast is unambiguous.
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 30_000 });
    await guests.locator("#guest-email").fill(process.env.E2E_RBAC_CUSTOMER_EMAIL ?? "rbac-customer-uat@local.test");
    await guests.getByRole("button", { name: /invite guest/i }).click();
    const memberInviteToast = page.locator("[data-sonner-toast]").last();
    await expect(memberInviteToast).toBeVisible({ timeout: 60_000 });
    await expect(memberInviteToast).toContainText(/belongs to an organization member/i);

    // Revoke (same dev-mode budget as invite). 60s headroom — the dev-mode
    // server action + revalidatePath can spike above 30s on cold CI.
    await guests.getByRole("button", { name: /revoke/i }).first().click();
    await expect(guests.getByText(GUEST_EMAIL, { exact: false })).toHaveCount(0, {
      timeout: 60_000,
    });
  });
});
