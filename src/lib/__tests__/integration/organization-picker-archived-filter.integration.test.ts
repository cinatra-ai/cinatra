/**
 * cinatra#1942 (archive activation V1, Decision 4) — picker vs authz DB
 * integration proof.
 *
 * Plants ONE active org + ONE archived org, both owned by the same test
 * user, directly in public.organization/member (Better Auth tables live in
 * the shared public schema — there is no per-test schema for them, same
 * convention as org-write-archive-race.integration.test.ts), then exercises
 * the REAL better-auth-db.ts functions:
 *   - readTeamCreatableOrganizationsForUser  (V1 picker)      -> archived ABSENT
 *   - readOrgsWithTeamsForUserActiveOnly     (V1 picker, new) -> archived ABSENT
 *   - readOrgsWithTeamsForUser               (mixed/authz)    -> archived PRESENT
 *   - listAccessibleOrgIdsForUser            (authz)          -> archived PRESENT
 *
 * This is the "planted archived org — absent from picker, present in authz"
 * proof named in the archive-activation design's V1 test plan.
 *
 * Runs only under CINATRA_DB_INTEGRATION_TESTS=1 with a real SUPABASE_DB_URL
 * (the extension-lifecycle-db-tests CI job); self-skips otherwise. NOT run
 * on the operator box (no DB/dev-server there) — CI is the authority.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";

const dbUrl = process.env.SUPABASE_DB_URL ?? "";
const enabled =
  process.env.CINATRA_DB_INTEGRATION_TESTS === "1" &&
  dbUrl !== "" &&
  !dbUrl.includes("unused:unused");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const PUBLIC_SCHEMA_SQL = path.join(REPO_ROOT, "tests/e2e/rbac/fixtures/public-schema.sql");

describe.skipIf(!enabled)(
  "org picker vs authz — archived-org filtering on live Postgres (cinatra#1942 V1)",
  () => {
    let root: Client;
    let userId: string;
    let activeOrgId: string;
    let archivedOrgId: string;

    beforeAll(async () => {
      root = new Client({ connectionString: dbUrl });
      await root.connect();
      // The committed Better-Auth public schema (organization + archivedAt,
      // member, user, …) — idempotent (CREATE/ALTER … IF NOT EXISTS).
      await root.query(readFileSync(PUBLIC_SCHEMA_SQL, "utf8"));
    });

    afterAll(async () => {
      await root?.end();
    });

    beforeEach(async () => {
      // public.organization/user/member are shared tables — unique ids per test.
      userId = `user_picker_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      activeOrgId = `org_picker_active_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      archivedOrgId = `org_picker_archived_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

      await root.query(
        `INSERT INTO public."user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, false)`,
        [userId, "Picker Test User", `${userId}@example.test`],
      );
      await root.query(
        `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1, $2, $3, now())`,
        [activeOrgId, "Active Org", activeOrgId],
      );
      await root.query(
        `INSERT INTO public."organization" (id, name, slug, "createdAt", "archivedAt")
         VALUES ($1, $2, $3, now(), now())`,
        [archivedOrgId, "Archived Org", archivedOrgId],
      );
      // Owner membership in BOTH orgs — the archived org's own owner must
      // still resolve their membership (authz side of Decision 4).
      for (const orgId of [activeOrgId, archivedOrgId]) {
        await root.query(
          `INSERT INTO public."member" (id, "organizationId", "userId", role, "createdAt")
           VALUES ($1, $2, $3, 'owner', now())`,
          [`mem_${randomUUID().replace(/-/g, "").slice(0, 12)}`, orgId, userId],
        );
      }
    });

    afterEach(async () => {
      // member rows cascade-delete with their organization
      // (member_organizationId_fkey ON DELETE CASCADE).
      await root.query(`DELETE FROM public."organization" WHERE id = ANY($1)`, [
        [activeOrgId, archivedOrgId],
      ]);
      await root.query(`DELETE FROM public."user" WHERE id = $1`, [userId]);
    });

    it("readTeamCreatableOrganizationsForUser excludes the archived org (V1 picker)", async () => {
      const { readTeamCreatableOrganizationsForUser } = await import("@/lib/better-auth-db");
      const orgs = await readTeamCreatableOrganizationsForUser(userId, null);
      const ids = orgs.map((o) => o.id);
      expect(ids).toContain(activeOrgId);
      expect(ids).not.toContain(archivedOrgId);
    });

    it("readOrgsWithTeamsForUserActiveOnly excludes the archived org (V1 picker, new sibling)", async () => {
      const { readOrgsWithTeamsForUserActiveOnly } = await import("@/lib/better-auth-db");
      const orgs = await readOrgsWithTeamsForUserActiveOnly(userId);
      const ids = orgs.map((o) => o.id);
      expect(ids).toContain(activeOrgId);
      expect(ids).not.toContain(archivedOrgId);
    });

    it("readOrgsWithTeamsForUser (mixed/authz, UNFILTERED) still includes the archived org", async () => {
      const { readOrgsWithTeamsForUser } = await import("@/lib/better-auth-db");
      const orgs = await readOrgsWithTeamsForUser(userId);
      const ids = orgs.map((o) => o.id);
      expect(ids).toContain(activeOrgId);
      expect(ids).toContain(archivedOrgId);
    });

    it("listAccessibleOrgIdsForUser (authz, UNFILTERED) still includes the archived org", async () => {
      const { listAccessibleOrgIdsForUser } = await import("@/lib/better-auth-db");
      const ids = await listAccessibleOrgIdsForUser(userId);
      expect(ids).toContain(activeOrgId);
      expect(ids).toContain(archivedOrgId);
    });
  },
);
