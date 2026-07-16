/**
 * Per-test re-seed for the unified /notifications v2 conformance specs
 * (cinatra#1561, E11).
 *
 * The suite runs single-worker/serial, but the decide spec (reject → the row
 * leaves the `agent_creation_request` pending set) and the mark-all spec (marks
 * notifications read) MUTATE the shared seeded state. Re-seeding the full
 * fixture set before EVERY state-dependent test makes the specs order- and
 * retry-independent: the seeders are delete-then-insert idempotent, so a
 * beforeEach reset restores the canonical state regardless of what a prior test
 * (or a prior retry) mutated. Scoped to the main seeded viewer's user + active
 * org (resolved idempotently — `ensureOrganizationByDirectInsert` returns the
 * existing membership's org), so the empty-state user is never touched.
 */
import { seedApprovalFixtures, seedNotificationFixtures } from "./seed";
import {
  DATABASE_URL,
  SCHEMA,
  ensureOrganizationByDirectInsert,
  userIdByEmail,
} from "./setup-helpers";

const EMAIL = process.env.E2E_NOTIF_USER_EMAIL ?? "notif-uat@local.test";

export async function reseedMainViewer(): Promise<void> {
  const [userId, orgId] = await Promise.all([
    userIdByEmail(EMAIL),
    ensureOrganizationByDirectInsert(EMAIL),
  ]);
  await seedNotificationFixtures({ email: EMAIL, databaseUrl: DATABASE_URL, schema: SCHEMA });
  await seedApprovalFixtures({ databaseUrl: DATABASE_URL, schema: SCHEMA, orgId, viewerUserId: userId });
}
