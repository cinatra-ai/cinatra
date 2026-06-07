/**
 * Customer auth setup — signs in as the customer user created in the member
 * setup (auth.setup.ts) and saves a SEPARATE storageState for the EXT-02
 * scoped-view test.
 *
 * The customer is a `member`-role member of the project's org (added by
 * auth.setup.ts) — required so EXT-01's project_access grant can attach to
 * them. They have no platform/org admin role and no metric.read grant, so
 * the scoped-view assertions hold (Analytics hidden in nav; admin pages
 * denied). The customer's active org is set to the project's org so /desk
 * renders the app shell.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test as setup, expect } from "@playwright/test";

const CUSTOMER_EMAIL = process.env.E2E_RBAC_CUSTOMER_EMAIL ?? "rbac-customer-uat@local.test";
const CUSTOMER_PASSWORD = process.env.E2E_RBAC_CUSTOMER_PASSWORD ?? "RbacCustomerUAT!2026";
const CUSTOMER_STORAGE_PATH = "tests/e2e/rbac/.auth/customer-state.json";
const SEED_PATH = "tests/e2e/rbac/.auth/seed.json";

function readSeed(): { projectId: string; customerUserId: string; memberOrgId: string } {
  return JSON.parse(readFileSync(resolve(process.cwd(), SEED_PATH), "utf-8"));
}

setup("customer sign-in + save state", async ({ request, baseURL }) => {
  const origin = baseURL ?? "http://localhost:3000";
  const headers = { Origin: origin } as const;

  const signIn = await request.post("/api/auth/sign-in/email", {
    data: { email: CUSTOMER_EMAIL, password: CUSTOMER_PASSWORD },
    headers,
  });
  expect(signIn.ok()).toBeTruthy();

  // Set active org to the project's org (the customer was added as a member
  // there by auth.setup.ts).
  const seed = readSeed();
  await request.post("/api/auth/organization/set-active", {
    data: { organizationId: seed.memberOrgId },
    headers,
    failOnStatusCode: false,
  });

  await request.storageState({ path: CUSTOMER_STORAGE_PATH });
});
