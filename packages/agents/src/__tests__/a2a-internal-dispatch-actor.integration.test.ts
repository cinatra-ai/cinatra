/**
 * cinatra#2202 — REAL-STORE coverage for the authz seam the internal A2A
 * dispatch branch now feeds.
 *
 * Why a real store and not mocks: the recorded silent-authz-drop class. A
 * mocked membership resolver happily hands back `"member"` for a principal that
 * has no membership row at all, so a unit test can be green while the real
 * resolver would drop the actor and the write would proceed role-less. These
 * cases therefore run against a REAL Postgres: real `public."user"` /
 * `public."organization"` / `public."member"` rows, the real
 * `resolveRunCreationAuthority`, the real guarded `createAgentRun`, and a raw
 * SQL read-back of what was actually persisted.
 *
 * The chain under test is exactly the one `sendAgentBuilderMessage`'s internal
 * branch establishes: session principal (now carried in the ActorContext frame)
 * → `resolveRunCreationAuthority` → guarded `createAgentRun` → the persisted
 * `run_by` / `org_id` attribution.
 *
 * DB-gated: skips when SUPABASE_DB_URL is unset (matches the sibling suites).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string" &&
  dbUrl.length > 0 &&
  !isPlaceholderDbUrl(dbUrl);
const q = (s: string) => s.replaceAll('"', '""');

// Ids unique to THIS file (never shared with a sibling integration suite).
const ORG = "org-2202-a2a";
const OTHER_ORG = "org-2202-a2a-other";
const MEMBER_USER = "user-2202-member";
const OUTSIDER_USER = "user-2202-outsider";

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Raw read-back helper — the persisted truth, not an ORM projection. */
async function queryRows<T extends Record<string, unknown>>(
  text: string,
  values: unknown[],
): Promise<T[]> {
  return withClient(async (c) => (await c.query<T>(text, values)).rows);
}

beforeAll(async () => {
  if (!hasDb) return;
  await withClient(async (c) => {
    for (const orgId of [ORG, OTHER_ORG]) {
      await c.query(
        `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
        [orgId, orgId, orgId],
      );
    }
    for (const userId of [MEMBER_USER, OUTSIDER_USER]) {
      await c.query(
        `INSERT INTO public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, false, now(), now()) ON CONFLICT (id) DO NOTHING`,
        [userId, userId, `${userId}@2202.test`],
      );
    }
    // MEMBER_USER is a real member of ORG only. OUTSIDER_USER is a real user
    // with NO membership anywhere — the role-less principal.
    await c.query(
      `INSERT INTO public."member" (id, "organizationId", "userId", role, "createdAt")
       VALUES ($1, $2, $3, 'member', now()) ON CONFLICT (id) DO NOTHING`,
      [`m-2202-${ORG}`, ORG, MEMBER_USER],
    );
  });
}, 30_000);

afterAll(async () => {
  if (!hasDb) return;
  await withClient(async (c) => {
    await c.query(
      `DELETE FROM "${q(SCHEMA)}"."agent_runs" WHERE org_id = ANY($1)`,
      [[ORG, OTHER_ORG]],
    );
    await c.query(`DELETE FROM public."member" WHERE "userId" = ANY($1)`, [
      [MEMBER_USER, OUTSIDER_USER],
    ]);
    await c.query(`DELETE FROM public."user" WHERE id = ANY($1)`, [
      [MEMBER_USER, OUTSIDER_USER],
    ]);
    await c.query(`DELETE FROM public."organization" WHERE id = ANY($1)`, [
      [ORG, OTHER_ORG],
    ]);
  });
});

async function makeTemplate(): Promise<string> {
  const { createAgentTemplate } = await import("../store");
  const templateId = `t_${randomUUID()}`;
  await createAgentTemplate({
    id: templateId,
    name: `a2a-2202-${randomUUID().slice(0, 8)}`,
    sourceNl: "test",
    compiledPlan: [],
    inputSchema: {},
    approvalPolicy: { steps: [] },
    // cinatra#2485 C — the template's INSTALL SCOPE is what authorizes a run,
    // so the fixture agent is installed in ORG (`createAgentTemplate` stamps
    // `owner_level='organization'` / `owner_id=orgId` from this anchor). An
    // org-less fixture template has no determinate scope, so every run against
    // it is refused before this suite's own authority axis is ever exercised.
    orgId: ORG,
  });
  return templateId;
}

describe.skipIf(!hasDb)(
  "cinatra#2202 — internal A2A dispatch authz seam, against the REAL store",
  () => {
    it("resolves a run.execute authority for a principal that really is a member", async () => {
      const { resolveRunCreationAuthority } = await import(
        "@/lib/org-write/run-creation-authority"
      );
      const authority = await resolveRunCreationAuthority(ORG, {
        userId: MEMBER_USER,
      });
      expect(authority).toBeTruthy();
      expect(authority?.orgId).toBe(ORG);
      expect(authority?.can("run.execute")).toBe(true);
    });

    it("REFUSES (undefined) for a principal with no membership row — the role-less drop is never silently allowed", async () => {
      const { resolveRunCreationAuthority } = await import(
        "@/lib/org-write/run-creation-authority"
      );
      const authority = await resolveRunCreationAuthority(ORG, {
        userId: OUTSIDER_USER,
      });
      expect(authority).toBeUndefined();
    });

    it("REFUSES for a real member of a DIFFERENT org (cross-org owner ruling)", async () => {
      const { resolveRunCreationAuthority } = await import(
        "@/lib/org-write/run-creation-authority"
      );
      const authority = await resolveRunCreationAuthority(OTHER_ORG, {
        userId: MEMBER_USER,
      });
      expect(authority).toBeUndefined();
    });

    it("persists the actor's attribution (run_by + org_id) on the created run", async () => {
      const { resolveRunCreationAuthority } = await import(
        "@/lib/org-write/run-creation-authority"
      );
      const { createAgentRun } = await import("../store");
      const templateId = await makeTemplate();
      const runId = `r_${randomUUID()}`;
      const authority = await resolveRunCreationAuthority(ORG, {
        userId: MEMBER_USER,
      });

      await createAgentRun(
        {
          id: runId,
          templateId,
          inputParams: {},
          orgId: ORG,
          // The executor stamps runBy from the ActorContext frame's HumanUser
          // principal — the identity this issue's fix makes available at all.
          runBy: MEMBER_USER,
        },
        authority,
      );

      const rows = await queryRows<{ run_by: string | null; org_id: string }>(
        `SELECT run_by, org_id FROM "${q(SCHEMA)}"."agent_runs" WHERE id = $1`,
        [runId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].run_by).toBe(MEMBER_USER);
      expect(rows[0].org_id).toBe(ORG);
    });

    it("creates NO run at all when the principal is role-less — fail-closed, not an attribution-less row", async () => {
      const { resolveRunCreationAuthority } = await import(
        "@/lib/org-write/run-creation-authority"
      );
      const { createAgentRun } = await import("../store");
      const templateId = await makeTemplate();
      const runId = `r_${randomUUID()}`;
      const authority = await resolveRunCreationAuthority(ORG, {
        userId: OUTSIDER_USER,
      });
      expect(authority).toBeUndefined();

      // cinatra#2485 C — TWO fail-closed gates now stand in front of this write
      // and the run-scope guard is the FIRST: it re-resolves `runBy` LIVE and
      // refuses an actor with no membership row (`cross_org`) before the
      // undefined authority ever reaches `guardedRunWrite`. Assert WHICH gate
      // refused rather than accepting any throw, so a future silent-success
      // cannot pass here. The #2202 AUTHORITY seam itself stays pinned by the
      // sibling test below (no principal at all → the scope guard's org-anchored
      // autonomous branch admits, and the authority seam is what refuses).
      const refusal = await createAgentRun(
        {
          id: runId,
          templateId,
          inputParams: {},
          orgId: ORG,
          runBy: OUTSIDER_USER,
        },
        authority,
      ).then(
        () => null,
        (err: unknown) => err,
      );
      expect(refusal).not.toBeNull();
      expect((refusal as { code?: string }).code).toBe("AGENT_TEMPLATE_SCOPE_DENIED");
      expect((refusal as { reason?: string }).reason).toBe("cross_org");

      const rows = await queryRows<{ id: string }>(
        `SELECT id FROM "${q(SCHEMA)}"."agent_runs" WHERE id = $1`,
        [runId],
      );
      expect(rows).toHaveLength(0);
    });

    it("creates NO run when NO principal is supplied at all (the pre-fix internal-branch shape)", async () => {
      const { resolveRunCreationAuthority } = await import(
        "@/lib/org-write/run-creation-authority"
      );
      const { createAgentRun } = await import("../store");
      const templateId = await makeTemplate();
      const runId = `r_${randomUUID()}`;
      // No frame ⇒ no userId ⇒ no authority. This is exactly what the internal
      // branch produced before #2202: an executor running with no actor.
      const authority = await resolveRunCreationAuthority(ORG, {});
      expect(authority).toBeUndefined();

      await expect(
        createAgentRun(
          { id: runId, templateId, inputParams: {}, orgId: ORG },
          authority,
        ),
      ).rejects.toThrow();

      const rows = await queryRows<{ id: string }>(
        `SELECT id FROM "${q(SCHEMA)}"."agent_runs" WHERE id = $1`,
        [runId],
      );
      expect(rows).toHaveLength(0);
    });
  },
);
