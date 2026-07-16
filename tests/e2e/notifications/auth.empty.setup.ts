/**
 * Auth setup for the EMPTY-state user of the unified /notifications v2
 * conformance UAT (cinatra#1561, E11). A distinct platform-admin viewer in an
 * active org with ZERO notifications and ZERO pending approvals, so the feed
 * renders the single universal "No notifications" empty state (spec §V — never a
 * per-type / per-source empty). It is admin + org'd exactly like the seeded
 * viewer, so the empty render is proven with BOTH feed halves live and genuinely
 * empty (not merely notifications-only via a missing org).
 *
 * Runs as its own setup project with its own request context, so the seeded
 * viewer's cookie jar / storage state is never disturbed.
 */
import { test as setup, expect } from "@playwright/test";

import {
  ensureOrganizationByDirectInsert,
  grantAdminRoleByEmail,
} from "./setup-helpers";

const EMAIL = process.env.E2E_NOTIF_EMPTY_USER_EMAIL ?? "notif-uat-empty@local.test";
const PASSWORD = process.env.E2E_NOTIF_EMPTY_USER_PASSWORD ?? "NotifEmptyUAT!2026";
const STORAGE_PATH = "tests/e2e/notifications/.auth/empty-state.json";

setup(
  "provision the empty-state /notifications viewer (admin + org, no rows)",
  async ({ request, baseURL }) => {
    const origin = baseURL ?? "http://localhost:3100";
    const COMMON_HEADERS = { Origin: origin } as const;

    const signUp = await request.post("/api/auth/sign-up/email", {
      data: { email: EMAIL, password: PASSWORD, name: "Notif Empty UAT" },
      headers: COMMON_HEADERS,
      failOnStatusCode: false,
    });
    expect([200, 400, 422]).toContain(signUp.status());

    await grantAdminRoleByEmail(EMAIL);

    const signIn = await request.post("/api/auth/sign-in/email", {
      data: { email: EMAIL, password: PASSWORD },
      headers: COMMON_HEADERS,
    });
    expect(signIn.ok()).toBeTruthy();

    const orgId = await ensureOrganizationByDirectInsert(EMAIL);
    const setActive = await request.post("/api/auth/organization/set-active", {
      data: { organizationId: orgId },
      headers: COMMON_HEADERS,
      failOnStatusCode: false,
    });
    expect(setActive.ok()).toBeTruthy();

    // Deliberately seed NOTHING.
    await request.storageState({ path: STORAGE_PATH });
  },
);
