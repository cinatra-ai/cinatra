/**
 * Auth setup for the SEEDED viewer of the unified /notifications v2 conformance
 * UAT (cinatra#1561, E11). Provisions a platform-admin viewer in an active org
 * and seeds BOTH the notification and the pending-approval substrate the E7 feed
 * merges, so the specs run against a deterministic production-build surface.
 *
 * Runtime order:
 *   1. Idempotent Better Auth sign-up.
 *   2. Promote to platform admin BEFORE sign-in (so the minted session carries
 *      the admin role — the agent-creation Inbox + the scope picker gate on it).
 *   3. Sign in (mints the session cookie).
 *   4. Ensure an organization (direct-pg insert) AND set it active via
 *      `organization/set-active` — the unified feed only runs the approval
 *      sources when the session carries `activeOrganizationId`; without this the
 *      page silently degrades to notifications-only and every approval assertion
 *      fails on an approval-less render.
 *   5. Seed notifications (mixed kinds + running + the E9 run-awaiting-human row)
 *      and approvals (an actionable Inbox row + a non-actionable Your-requests
 *      row) scoped to the active org.
 *   6. Persist the cookie state for the seeded chromium project.
 */
import { test as setup, expect } from "@playwright/test";

import {
  seedNotificationFixtures,
  seedApprovalFixtures,
} from "./seed";
import {
  DATABASE_URL,
  SCHEMA,
  ensureOrganizationByDirectInsert,
  grantAdminRoleByEmail,
  userIdByEmail,
} from "./setup-helpers";

const EMAIL = process.env.E2E_NOTIF_USER_EMAIL ?? "notif-uat@local.test";
const PASSWORD = process.env.E2E_NOTIF_USER_PASSWORD ?? "NotifUAT!2026";
const STORAGE_PATH = "tests/e2e/notifications/.auth/state.json";

setup(
  "seed the unified /notifications viewer (admin + org + notifications + approvals)",
  async ({ request, baseURL }) => {
    const origin = baseURL ?? "http://localhost:3100";
    const COMMON_HEADERS = { Origin: origin } as const;

    // 1. Sign-up (idempotent).
    const signUp = await request.post("/api/auth/sign-up/email", {
      data: { email: EMAIL, password: PASSWORD, name: "Notif UAT" },
      headers: COMMON_HEADERS,
      failOnStatusCode: false,
    });
    expect([200, 400, 422]).toContain(signUp.status());

    // 2. Promote to platform admin BEFORE sign-in (session-mint-time role).
    await grantAdminRoleByEmail(EMAIL);

    // 3. Sign-in.
    const signIn = await request.post("/api/auth/sign-in/email", {
      data: { email: EMAIL, password: PASSWORD },
      headers: COMMON_HEADERS,
    });
    expect(signIn.ok()).toBeTruthy();

    // 4. Ensure + ACTIVATE an organization (approval sources need an active org).
    const orgId = await ensureOrganizationByDirectInsert(EMAIL);
    const setActive = await request.post("/api/auth/organization/set-active", {
      data: { organizationId: orgId },
      headers: COMMON_HEADERS,
      failOnStatusCode: false,
    });
    expect(setActive.ok()).toBeTruthy();

    // 5. Seed both substrates the unified feed merges.
    const userId = await userIdByEmail(EMAIL);
    const notifs = await seedNotificationFixtures({ email: EMAIL, databaseUrl: DATABASE_URL, schema: SCHEMA });
    expect(notifs.terminalCount).toBeGreaterThanOrEqual(5);
    expect(notifs.runningCount).toBe(1);
    expect(notifs.unreadTerminalCount).toBe(4);

    const approvals = await seedApprovalFixtures({
      databaseUrl: DATABASE_URL,
      schema: SCHEMA,
      orgId,
      viewerUserId: userId,
    });
    expect(approvals.inboxActionableCount).toBe(1);
    expect(approvals.mineCount).toBe(1);

    // 6. Persist storage state.
    await request.storageState({ path: STORAGE_PATH });
  },
);
