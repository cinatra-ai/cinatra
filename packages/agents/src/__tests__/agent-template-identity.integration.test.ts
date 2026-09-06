// cinatra#2616 — the agent_templates IDENTITY CLAIM, proven against a REAL
// Postgres schema.
//
// The defect is a WRITE OUTCOME, so a stubbed store cannot prove it: the whole
// question is whether the foreign row's columns are still what they were and
// whether a genuinely concurrent second claimant is refused. Every case below
// writes through the real `createAgentTemplate` / `updateAgentTemplate` and the
// real claim operations, and reads back with raw SQL.
//
// Coverage map to the issue's acceptance criteria:
//   AC1 — org A owns `@x/y`; org B refuses; A's row is BYTE-IDENTICAL after
//         (every column, plus no new agent_versions row).
//   AC2 — two same-name claims race on independent pool connections through the
//         SAME operation the install path runs (`claimAgentTemplateIdentity`,
//         which owns the 23505 classification): exactly one wins, the loser gets
//         the collision refusal, and the loser's insert callback never ran.
//         Deliberately NOT driven through `installAgentFromPackage`: that path
//         holds a process-local install lock, so a same-process "race" there
//         would serialize and prove nothing about 23505.
//   AC4 — the MARKETPLACE caller's exact input shape (`orgId` absent,
//         `anchorOrgId` present — what `installAndRegisterSkills` produces)
//         claims as its actor's organization and is refused; and a fresh
//         marketplace install RECORDS its claim, so the next organization is
//         refused too.
//
// Skips when no DB is configured (same pattern as the sibling integration suites).
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string" &&
  dbUrl.length > 0 &&
  !dbUrl.includes("unused:unused@");

const ORG_A = `org_a_${randomUUID().slice(0, 8)}`;
const ORG_B = `org_b_${randomUUID().slice(0, 8)}`;
const ORG_C = `org_c_${randomUUID().slice(0, 8)}`;

const createdTemplateIds: string[] = [];

function pkg(): string {
  return `@claim-2616/${randomUUID().slice(0, 12)}`;
}

async function seed(input: {
  packageName: string;
  orgId?: string;
  ownerLevel?: "organization";
  ownerId?: string;
}): Promise<string> {
  const { createAgentTemplate } = await import("../store");
  const id = `t_${randomUUID()}`;
  await createAgentTemplate({
    id,
    name: "identity-claim-fixture",
    sourceNl: "x",
    compiledPlan: [],
    inputSchema: {},
    approvalPolicy: { steps: [] },
    packageName: input.packageName,
    packageVersion: "1.0.0",
    ...(input.orgId ? { orgId: input.orgId } : {}),
    ...(input.ownerLevel ? { ownerLevel: input.ownerLevel } : {}),
    ...(input.ownerId ? { ownerId: input.ownerId } : {}),
  });
  createdTemplateIds.push(id);
  return id;
}

/** Every column of the row, as the database holds it. */
async function snapshotRow(id: string): Promise<Record<string, unknown>> {
  const { db } = await import("../db");
  const res = await db.execute(
    sql`select * from ${sql.raw(schemaName())}.agent_templates where id = ${id}`,
  );
  const rows = (res as unknown as { rows?: Record<string, unknown>[] }).rows ?? [];
  return rows[0] ?? {};
}

async function versionCount(templateId: string): Promise<number> {
  const { db } = await import("../db");
  const res = await db.execute(
    sql`select count(*)::int as n from ${sql.raw(schemaName())}.agent_versions where template_id = ${templateId}`,
  );
  const rows = (res as unknown as { rows?: { n: number }[] }).rows ?? [];
  return rows[0]?.n ?? 0;
}

function schemaName(): string {
  return `"${(process.env.SUPABASE_SCHEMA?.trim() || "cinatra").replaceAll('"', '""')}"`;
}

afterAll(async () => {
  if (!hasDb || createdTemplateIds.length === 0) return;
  const { db } = await import("../db");
  for (const id of createdTemplateIds) {
    await db.execute(
      sql`delete from ${sql.raw(schemaName())}.agent_versions where template_id = ${id}`,
    );
    await db.execute(
      sql`delete from ${sql.raw(schemaName())}.agent_templates where id = ${id}`,
    );
  }
});

describe.skipIf(!hasDb)("cinatra#2616 — agent_templates identity claim (real DB)", () => {
  it("AC1: a foreign organization's publish REFUSES, and the owner's row is byte-identical after", async () => {
    const { updateAgentTemplate } = await import("../store");
    const { resolveAgentTemplateIdentityClaim, claimAgentTemplateIdentity } = await import(
      "../agent-template-identity"
    );
    const { AgentTemplateIdentityConflictError, organizationIdentityClaim } = await import(
      "../agent-template-identity"
    );

    const packageName = pkg();
    const id = await seed({
      packageName,
      orgId: ORG_A,
      ownerLevel: "organization",
      ownerId: ORG_A,
    });
    const before = await snapshotRow(id);
    const versionsBefore = await versionCount(id);
    expect(before.org_id).toBe(ORG_A);

    // 1. the inert-window resolution refuses.
    await expect(
      resolveAgentTemplateIdentityClaim({
        packageName,
        claim: organizationIdentityClaim(ORG_B),
      }),
    ).rejects.toBeInstanceOf(AgentTemplateIdentityConflictError);

    // 2. the whole claim operation refuses WITHOUT running the insert.
    let insertRan = false;
    await expect(
      claimAgentTemplateIdentity(
        { packageName, claim: organizationIdentityClaim(ORG_B) },
        {
          insert: async () => {
            insertRan = true;
            return { templateId: "never", versionId: "never" };
          },
        },
      ),
    ).rejects.toBeInstanceOf(AgentTemplateIdentityConflictError);
    expect(insertRan).toBe(false);

    // 3. the WRITE itself refuses even when the caller reaches it with the row
    //    id in hand — the guard is the predicate, not the preceding read. This
    //    patch changes ownership AND scalars, so it exercises BOTH statements
    //    `_updateAgentTemplateImpl` issues.
    await expect(
      updateAgentTemplate(
        id,
        {
          name: "hijacked-by-org-b",
          orgId: ORG_B,
          ownerLevel: "organization",
          ownerId: ORG_B,
          packageVersion: "9.9.9",
        },
        organizationIdentityClaim(ORG_B),
      ),
    ).rejects.toBeInstanceOf(AgentTemplateIdentityConflictError);

    // BYTE-IDENTICAL: every column, including updated_at. If the ownership
    // write had committed before the main write refused (the non-transactional
    // shape), updated_at alone would have moved.
    const after = await snapshotRow(id);
    expect(after).toEqual(before);
    expect(await versionCount(id)).toBe(versionsBefore);
  });

  it("AC2: two claimants race the same NEW name — exactly one wins, the loser is refused", async () => {
    const { claimAgentTemplateIdentity } = await import("../agent-template-identity");
    const { AgentTemplateIdentityConflictError, organizationIdentityClaim } = await import(
      "../agent-template-identity"
    );

    const packageName = pkg();
    const inserted: string[] = [];
    const racer = (orgId: string) =>
      claimAgentTemplateIdentity(
        { packageName, claim: organizationIdentityClaim(orgId) },
        {
          insert: async () => {
            const id = await seed({
              packageName,
              orgId,
              ownerLevel: "organization",
              ownerId: orgId,
            });
            inserted.push(id);
            return { templateId: id, versionId: randomUUID() };
          },
        },
      );

    // Independent pool connections, genuinely concurrent.
    const results = await Promise.allSettled([racer(ORG_A), racer(ORG_B)]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((fulfilled[0] as PromiseFulfilledResult<{ mode: string }>).value.mode).toBe("created");
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      AgentTemplateIdentityConflictError,
    );

    // Exactly ONE row exists under the name, and it belongs to the winner. No
    // partial adoption: the loser wrote nothing.
    const { db } = await import("../db");
    const res = await db.execute(
      sql`select id, org_id from ${sql.raw(schemaName())}.agent_templates where package_name = ${packageName}`,
    );
    const rows = (res as unknown as { rows?: { id: string; org_id: string }[] }).rows ?? [];
    expect(rows).toHaveLength(1);
    expect(inserted).toHaveLength(1);
    expect(rows[0].id).toBe(inserted[0]);
    expect([ORG_A, ORG_B]).toContain(rows[0].org_id);
  });

  it("AC2: the 23505 branch is classified — a loser whose INSERT collides is refused, not adopted", async () => {
    // Deterministic form of the race above: the claimant resolves the name as
    // UNCLAIMED, and the winner commits while its insert is in flight. The
    // insert then raises 23505 and the operation must re-resolve against the
    // committed winner and REFUSE — never fall through to adopting it.
    const { claimAgentTemplateIdentity } = await import("../agent-template-identity");
    const { AgentTemplateIdentityConflictError, organizationIdentityClaim } = await import(
      "../agent-template-identity"
    );

    const packageName = pkg();
    let attempted = 0;
    await expect(
      claimAgentTemplateIdentity(
        { packageName, claim: organizationIdentityClaim(ORG_B) },
        {
          insert: async () => {
            attempted += 1;
            // ORG_A wins the name first…
            await seed({
              packageName,
              orgId: ORG_A,
              ownerLevel: "organization",
              ownerId: ORG_A,
            });
            // …and THIS insert now hits the unique index.
            await seed({ packageName, orgId: ORG_B });
            return { templateId: "unreachable", versionId: "unreachable" };
          },
        },
      ),
    ).rejects.toBeInstanceOf(AgentTemplateIdentityConflictError);
    expect(attempted).toBe(1);

    // Exactly one row, owned by the winner — no partial adoption.
    const { db } = await import("../db");
    const res = await db.execute(
      sql`select org_id from ${sql.raw(schemaName())}.agent_templates where package_name = ${packageName}`,
    );
    const rows = (res as unknown as { rows?: { org_id: string }[] }).rows ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].org_id).toBe(ORG_A);
  });

  it("AC4: the marketplace input shape claims as its actor org and is refused on a foreign name", async () => {
    const { resolveAgentTemplateIdentityClaim } = await import("../agent-template-identity");
    const { AgentTemplateIdentityConflictError, deriveAgentTemplateIdentityClaim } = await import(
      "../agent-template-identity"
    );

    const packageName = pkg();
    await seed({ packageName, orgId: ORG_A, ownerLevel: "organization", ownerId: ORG_A });

    // EXACTLY what installAndRegisterSkills produces: no orgId, anchorOrgId set.
    const marketplaceClaim = deriveAgentTemplateIdentityClaim({
      claimantOrgId: null,
      orgId: null,
      anchorOrgId: ORG_B,
    });
    expect(marketplaceClaim).toEqual({ kind: "organization", orgId: ORG_B });

    await expect(
      resolveAgentTemplateIdentityClaim({ packageName, claim: marketplaceClaim }),
    ).rejects.toBeInstanceOf(AgentTemplateIdentityConflictError);
  });

  it("AC4: a fresh marketplace install RECORDS its claim, so the next organization is refused", async () => {
    const { resolveAgentTemplateIdentityClaim } = await import("../agent-template-identity");
    const {
      AgentTemplateIdentityConflictError,
      agentTemplateIdentityClaimOrgToRecord,
      deriveAgentTemplateIdentityClaim,
    } = await import("../agent-template-identity");

    const packageName = pkg();
    const claim = deriveAgentTemplateIdentityClaim({ anchorOrgId: ORG_A });
    // The install path stamps this on the fresh row when the caller supplies no
    // orgId — which is exactly the marketplace caller.
    const recorded = agentTemplateIdentityClaimOrgToRecord(claim, undefined);
    expect(recorded).toBe(ORG_A);

    const id = await seed({ packageName, orgId: recorded });
    // withDeterminateInstallScope derives the determinate anchor from it, so the
    // row is born runnable instead of waiting for the #2620 boot reconcile.
    const row = await snapshotRow(id);
    expect(row.org_id).toBe(ORG_A);
    expect(row.owner_level).toBe("organization");
    expect(row.owner_id).toBe(ORG_A);

    await expect(
      resolveAgentTemplateIdentityClaim({
        packageName,
        claim: deriveAgentTemplateIdentityClaim({ anchorOrgId: ORG_B }),
      }),
    ).rejects.toBeInstanceOf(AgentTemplateIdentityConflictError);
  });

  it("an ORG-LESS row is unclaimed, and adopting it RECORDS the claim", async () => {
    const { updateAgentTemplate } = await import("../store");
    const { resolveAgentTemplateIdentityClaim } = await import("../agent-template-identity");
    const { AgentTemplateIdentityConflictError, organizationIdentityClaim } = await import(
      "../agent-template-identity"
    );

    const packageName = pkg();
    // The boot-seeded / bundled shape: no org anchor at all.
    const id = await seed({ packageName });
    expect((await snapshotRow(id)).org_id).toBeNull();

    // Any organization may claim it — refusing here would brick every fresh
    // instance's first install of a bundled agent.
    const resolved = await resolveAgentTemplateIdentityClaim({
      packageName,
      claim: organizationIdentityClaim(ORG_B),
    });
    expect(resolved.outcome).toBe("owned");

    // Adopting it records the claim, so it does not stay up for grabs.
    const updated = await updateAgentTemplate(
      id,
      { orgId: ORG_B, ownerLevel: "organization", ownerId: ORG_B },
      organizationIdentityClaim(ORG_B),
    );
    expect(updated?.orgId).toBe(ORG_B);

    await expect(
      resolveAgentTemplateIdentityClaim({
        packageName,
        claim: organizationIdentityClaim(ORG_C),
      }),
    ).rejects.toBeInstanceOf(AgentTemplateIdentityConflictError);
  });

  it("the owning organization's own re-install still succeeds", async () => {
    const { updateAgentTemplate } = await import("../store");
    const { organizationIdentityClaim } = await import("../agent-template-identity");

    const packageName = pkg();
    const id = await seed({
      packageName,
      orgId: ORG_A,
      ownerLevel: "organization",
      ownerId: ORG_A,
    });
    const updated = await updateAgentTemplate(
      id,
      { name: "re-installed", packageVersion: "2.0.0", orgId: ORG_A },
      organizationIdentityClaim(ORG_A),
    );
    expect(updated?.name).toBe("re-installed");
    expect(updated?.packageVersion).toBe("2.0.0");
  });

  it("the PLATFORM claim (boot seed / CLI) still updates an org-owned row", async () => {
    // Deliberate: once a fresh instance's #2620 reconcile has anchored the
    // bundled agents to its single organization, a boot version-bump upsert must
    // still be able to update them. Restricting the platform arm to org-less
    // rows would stop bundled-agent upgrades on every such instance.
    const { updateAgentTemplate } = await import("../store");
    const { PLATFORM_IDENTITY_CLAIM } = await import("../agent-template-identity");

    const packageName = pkg();
    const id = await seed({
      packageName,
      orgId: ORG_A,
      ownerLevel: "organization",
      ownerId: ORG_A,
    });
    const updated = await updateAgentTemplate(
      id,
      { packageVersion: "3.0.0" },
      PLATFORM_IDENTITY_CLAIM,
    );
    expect(updated?.packageVersion).toBe("3.0.0");
  });

  it("an incoherent claim (claiming as one org, stamping another) is refused at derivation", async () => {
    const { deriveAgentTemplateIdentityClaim } = await import("../agent-template-identity");
    expect(() =>
      deriveAgentTemplateIdentityClaim({ claimantOrgId: ORG_A, orgId: ORG_B }),
    ).toThrow(/disagreeing organizations/);
  });
});
