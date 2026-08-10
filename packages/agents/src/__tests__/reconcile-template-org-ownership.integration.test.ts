// cinatra#2619 — STORE-TIER proof of the owning-org reconcile, against a REAL
// Postgres schema.
//
// The defect this covers is a ROW SHAPE, so a stubbed store cannot prove it:
// the whole question is what the columns actually hold after the write and
// whether the REAL evaluator admits the row afterwards. Every case below writes
// through the real `createAgentTemplate` / reads back through the real
// `readAgentTemplateById`, and the admission assertions call the REAL
// `assertActorWithinAgentTemplateScope` — the untouched evaluator (AC4) — so a
// "healed" claim means the run perimeter genuinely stops refusing.
//
// Coverage map to the issue's acceptance criteria:
//   AC2 — idempotent, and NEVER rewrites a template that already has an owner.
//   AC3 — an existing instance's damaged rows heal on the next boot pass.
//   AC4 — the evaluator is only ever CALLED here, never adapted.
//
// The two damaged shapes both occur in the wild and both are covered:
//   A. `owner_level='organization'`, `owner_id=''`, `org_id=NULL` — the state the
//      bootstrap DDL's own backfill (`owner_id = COALESCE(org_id,'')`) leaves
//      behind on the boot AFTER the import. This is the shape the issue reports
//      (`unknown_scope (scope: organization)`).
//   B. `owner_level=NULL`, `owner_id=NULL`, `org_id=NULL` — the state the import
//      itself leaves on the boot it runs, before that backfill has seen the row.
//      Denies as `unknown_scope` with a null level.
//
// Skips when no DB is configured (same pattern as the sibling integration suites).
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";

import type { ActorContext } from "@/lib/authz/actor-context";

const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string" &&
  dbUrl.length > 0 &&
  !dbUrl.includes("unused:unused@localhost:5432/unused");

const ORG = `org_${randomUUID().slice(0, 8)}`;
const OTHER_ORG = `org_${randomUUID().slice(0, 8)}`;

/** The reconcile's org source, injected — no Better Auth store in this tier. */
const oneOrg = { listOrganizationIds: async () => [ORG] };
const noOrg = { listOrganizationIds: async () => [] as string[] };
const twoOrgs = { listOrganizationIds: async () => [ORG, OTHER_ORG] };

function member(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: `user_${randomUUID().slice(0, 8)}`,
    organizationId: ORG,
    teamIds: [],
    projectGrants: [],
    projectIds: [],
    orgRole: "member",
    platformRole: "member",
    authSource: "ui",
    policyVersion: "v2",
    ...overrides,
  } as ActorContext;
}

const baseSeed = (id: string) => ({
  id,
  name: "org-reconcile-fixture",
  sourceNl: "x",
  compiledPlan: [],
  inputSchema: {},
  approvalPolicy: { steps: [] },
  packageName: `@cinatra-ai/rec-${randomUUID().slice(0, 8)}`,
  packageVersion: "1.0.0",
});

/** Shape A — the reported state: level stamped, owner empty, no org anchor. */
async function seedShapeA(): Promise<string> {
  const { createAgentTemplate } = await import("../store");
  const id = `t_${randomUUID()}`;
  // NOTE: `withDeterminateInstallScope` early-returns on a missing `orgId`, so
  // this pair is persisted verbatim — which is exactly how the real row got
  // here (the DDL backfill wrote the level, never the owner).
  await createAgentTemplate({
    ...baseSeed(id),
    ownerLevel: "organization",
    ownerId: "",
  });
  return id;
}

/** Shape B — freshly imported, no level at all. */
async function seedShapeB(): Promise<string> {
  const { createAgentTemplate } = await import("../store");
  const id = `t_${randomUUID()}`;
  await createAgentTemplate(baseSeed(id));
  return id;
}

async function readRow(id: string) {
  const { readAgentTemplateById } = await import("../store");
  const row = await readAgentTemplateById(id);
  expect(row).not.toBeNull();
  return row!;
}

function scopeRef(row: { id: string; orgId: string | null; ownerLevel: string | null; ownerId: string | null }) {
  return { id: row.id, orgId: row.orgId, ownerLevel: row.ownerLevel, ownerId: row.ownerId };
}

describe.skipIf(!hasDb)("cinatra#2619 — owning-org reconcile (real Postgres)", () => {
  it("AC3: BOTH damaged shapes heal, and the REAL evaluator then admits an org member", async () => {
    const { reconcileAgentTemplateOrgOwnership } = await import(
      "../reconcile-template-org-ownership"
    );
    const { evaluateActorWithinAgentTemplateScope } = await import("../auth-policy");

    const a = await seedShapeA();
    const b = await seedShapeB();

    // Before: the perimeter refuses BOTH, for the two distinct reasons the
    // issue names.
    const beforeA = evaluateActorWithinAgentTemplateScope(scopeRef(await readRow(a)), member());
    const beforeB = evaluateActorWithinAgentTemplateScope(scopeRef(await readRow(b)), member());
    expect(beforeA).toMatchObject({ allowed: false, reason: "unknown_scope", level: "organization" });
    expect(beforeB).toMatchObject({ allowed: false, reason: "unknown_scope", level: null });

    const result = await reconcileAgentTemplateOrgOwnership(oneOrg);
    expect(result.status).toBe("healed");
    expect(result.orgId).toBe(ORG);
    expect(result.templateIds).toEqual(expect.arrayContaining([a, b]));

    const healedA = await readRow(a);
    const healedB = await readRow(b);

    // The org anchor is written on both.
    expect(healedA.orgId).toBe(ORG);
    expect(healedB.orgId).toBe(ORG);
    // Shape A keeps its '' owner sentinel — the reconcile writes org_id ONLY on
    // a row that already carries a level, which is what keeps
    // `agent_owner_move_trg` (AFTER UPDATE OF owner_level, owner_id) from firing.
    expect(healedA.ownerLevel).toBe("organization");
    expect(healedA.ownerId).toBe("");
    // Shape B gains the level it never had; its owner_id is deliberately left
    // NULL, so the relocation trigger's two prefixes both compute to 'workspace'
    // and the row it enqueues is a SAME-PATH one — which the pass then deletes
    // in its own transaction (pinned by its own case below).
    expect(healedB.ownerLevel).toBe("organization");
    expect(healedB.ownerId).toBeNull();

    // And the perimeter now ADMITS — the whole point.
    expect(evaluateActorWithinAgentTemplateScope(scopeRef(healedA), member())).toMatchObject({
      allowed: true,
      level: "organization",
    });
    expect(evaluateActorWithinAgentTemplateScope(scopeRef(healedB), member())).toMatchObject({
      allowed: true,
      level: "organization",
    });

    // An actor from ANOTHER org is still refused — healing anchors the row, it
    // does not widen it.
    expect(
      evaluateActorWithinAgentTemplateScope(scopeRef(healedA), member({ organizationId: OTHER_ORG })),
    ).toMatchObject({ allowed: false, reason: "cross_org" });
  });

  it("AC2: a second pass is a pure no-op — same rows, byte-identical, not re-listed", async () => {
    const { reconcileAgentTemplateOrgOwnership } = await import(
      "../reconcile-template-org-ownership"
    );
    const a = await seedShapeA();
    const b = await seedShapeB();

    const first = await reconcileAgentTemplateOrgOwnership(oneOrg);
    expect(first.templateIds).toEqual(expect.arrayContaining([a, b]));
    const afterFirstA = await readRow(a);
    const afterFirstB = await readRow(b);

    const second = await reconcileAgentTemplateOrgOwnership(oneOrg);
    // The ids this pass healed are NOT candidates again.
    expect(second.templateIds).not.toEqual(expect.arrayContaining([a]));
    expect(second.templateIds).not.toEqual(expect.arrayContaining([b]));

    const afterSecondA = await readRow(a);
    const afterSecondB = await readRow(b);
    for (const [before, after] of [
      [afterFirstA, afterSecondA],
      [afterFirstB, afterSecondB],
    ] as const) {
      expect(after.orgId).toBe(before.orgId);
      expect(after.ownerLevel).toBe(before.ownerLevel);
      expect(after.ownerId).toBe(before.ownerId);
      // No write at all ⇒ the row was not even touched.
      expect(after.updatedAt?.toISOString?.() ?? after.updatedAt).toEqual(
        before.updatedAt?.toISOString?.() ?? before.updatedAt,
      );
    }
  });

  it("AC2: never rewrites a template that already has an owner — narrower levels and org-anchored rows are untouched", async () => {
    const { createAgentTemplate } = await import("../store");
    const { reconcileAgentTemplateOrgOwnership } = await import(
      "../reconcile-template-org-ownership"
    );

    // (1) A PERSONAL template with no org anchor. Widening it to the
    // organization would hand one person's agent to every member — the exact
    // escalation `withDeterminateInstallScope` refuses at the write boundary.
    const personalId = `t_${randomUUID()}`;
    const ownerUserId = `user_${randomUUID().slice(0, 8)}`;
    await createAgentTemplate({ ...baseSeed(personalId), ownerLevel: "user", ownerId: ownerUserId });

    // (2) A TEAM template, likewise org-less.
    const teamId = `t_${randomUUID()}`;
    const owningTeamId = `team_${randomUUID().slice(0, 8)}`;
    await createAgentTemplate({ ...baseSeed(teamId), ownerLevel: "team", ownerId: owningTeamId });

    // (3) A row that is ALREADY anchored to a DIFFERENT org. `org_id IS NULL`
    // excludes it; re-anchoring it would be a cross-tenant move.
    const otherOrgId = `t_${randomUUID()}`;
    await createAgentTemplate({ ...baseSeed(otherOrgId), orgId: OTHER_ORG });

    const before = await Promise.all([readRow(personalId), readRow(teamId), readRow(otherOrgId)]);

    const result = await reconcileAgentTemplateOrgOwnership(oneOrg);
    for (const id of [personalId, teamId, otherOrgId]) {
      expect(result.templateIds).not.toEqual(expect.arrayContaining([id]));
    }

    const after = await Promise.all([readRow(personalId), readRow(teamId), readRow(otherOrgId)]);
    for (let i = 0; i < before.length; i += 1) {
      expect(after[i].orgId).toBe(before[i].orgId);
      expect(after[i].ownerLevel).toBe(before[i].ownerLevel);
      expect(after[i].ownerId).toBe(before[i].ownerId);
      expect(after[i].updatedAt?.toISOString?.() ?? after[i].updatedAt).toEqual(
        before[i].updatedAt?.toISOString?.() ?? before[i].updatedAt,
      );
    }
    // The already-anchored row kept the OTHER org — never re-homed.
    expect(after[2].orgId).toBe(OTHER_ORG);
  });

  it("refuses to guess: no organization, and MORE than one, both skip with a reason and write nothing", async () => {
    const { reconcileAgentTemplateOrgOwnership } = await import(
      "../reconcile-template-org-ownership"
    );
    const a = await seedShapeA();
    const before = await readRow(a);

    const none = await reconcileAgentTemplateOrgOwnership(noOrg);
    expect(none.status).toBe("skipped");
    expect(none.reason).toBe("no-organization");
    expect(none.anchored).toBe(0);
    // It still SAW the damage — a silent zero would hide the deficit.
    expect(none.scanned).toBeGreaterThan(0);

    const many = await reconcileAgentTemplateOrgOwnership(twoOrgs);
    expect(many.status).toBe("skipped");
    expect(many.reason).toBe("ambiguous-organizations");
    expect(many.organizationCount).toBe(2);
    expect(many.anchored).toBe(0);

    const after = await readRow(a);
    expect(after.orgId).toBeNull();
    expect(after.ownerLevel).toBe("organization");
    expect(after.ownerId).toBe("");
    expect(after.updatedAt?.toISOString?.() ?? after.updatedAt).toEqual(
      before.updatedAt?.toISOString?.() ?? before.updatedAt,
    );
  });

  it("arm B (codex round 1): a row already anchored but carrying NO level is healed too — the partial-heal shape cannot brick a template", async () => {
    const { createAgentTemplate } = await import("../store");
    const { reconcileAgentTemplateOrgOwnership } = await import(
      "../reconcile-template-org-ownership"
    );
    const { evaluateActorWithinAgentTemplateScope } = await import("../auth-policy");
    const { db } = await import("../db");
    const { agentTemplates } = await import("../schema");
    const { eq } = await import("drizzle-orm");

    // The exact residue a crash between the two writes would leave: org anchored,
    // level still NULL. The evaluator denies it (level null), and a predicate
    // keyed only on `org_id IS NULL` would never look at it again.
    const id = `t_${randomUUID()}`;
    await createAgentTemplate({ ...baseSeed(id), orgId: ORG });
    await db
      .update(agentTemplates)
      .set({ ownerLevel: null, ownerId: null })
      .where(eq(agentTemplates.id, id));

    const before = await readRow(id);
    expect(before.orgId).toBe(ORG);
    expect(before.ownerLevel).toBeNull();
    expect(evaluateActorWithinAgentTemplateScope(scopeRef(before), member())).toMatchObject({
      allowed: false,
      reason: "unknown_scope",
      level: null,
    });

    const result = await reconcileAgentTemplateOrgOwnership(oneOrg);
    expect(result.templateIds).toEqual(expect.arrayContaining([id]));

    const after = await readRow(id);
    // Only the LEVEL moved — the anchor it already had is not rewritten.
    expect(after.orgId).toBe(ORG);
    expect(after.ownerLevel).toBe("organization");
    expect(after.ownerId).toBeNull();
    expect(evaluateActorWithinAgentTemplateScope(scopeRef(after), member())).toMatchObject({
      allowed: true,
      level: "organization",
    });
  });

  it("arm B never re-homes: a level-less row anchored to ANOTHER org is stamped for ITS OWN org, not the resolved one", async () => {
    const { createAgentTemplate } = await import("../store");
    const { reconcileAgentTemplateOrgOwnership } = await import(
      "../reconcile-template-org-ownership"
    );
    const { evaluateActorWithinAgentTemplateScope } = await import("../auth-policy");
    const { db } = await import("../db");
    const { agentTemplates } = await import("../schema");
    const { eq } = await import("drizzle-orm");

    const id = `t_${randomUUID()}`;
    await createAgentTemplate({ ...baseSeed(id), orgId: OTHER_ORG });
    await db
      .update(agentTemplates)
      .set({ ownerLevel: null, ownerId: null })
      .where(eq(agentTemplates.id, id));

    await reconcileAgentTemplateOrgOwnership(oneOrg);

    const after = await readRow(id);
    // The anchor is untouched — the row still belongs to OTHER_ORG.
    expect(after.orgId).toBe(OTHER_ORG);
    expect(after.ownerLevel).toBe("organization");
    // …and an ORG member is refused on it, as they must be.
    expect(evaluateActorWithinAgentTemplateScope(scopeRef(after), member())).toMatchObject({
      allowed: false,
      reason: "cross_org",
    });
  });

  it("the level stamp leaves NO failed relocation behind — the same-path rows it manufactures are dropped in the same transaction", async () => {
    const { reconcileAgentTemplateOrgOwnership } = await import(
      "../reconcile-template-org-ownership"
    );
    const { db } = await import("../db");
    const { sql } = await import("drizzle-orm");
    const schema = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";

    const b = await seedShapeB();
    const result = await reconcileAgentTemplateOrgOwnership(oneOrg);
    expect(result.templateIds).toEqual(expect.arrayContaining([b]));
    expect(result.levelStamped).toBeGreaterThan(0);

    // `agent_owner_move_trg` fires on the level stamp and enqueues a row whose
    // old_path == new_path (both prefixes resolve to 'workspace' because
    // owner_id stays NULL). The relocation worker would mark such a row FAILED
    // ("target exists"). None may survive the pass.
    const rows = await db.execute<{ id: string; old_path: string; new_path: string; status: string }>(
      sql`select id, old_path, new_path, status
            from ${sql.identifier(schema)}.${sql.identifier("path_relocations")}
           where subject_kind = 'agent_template' and subject_id = ${b}`,
    );
    expect(rows.rows.filter((r) => r.old_path === r.new_path)).toEqual([]);
  });

  it("the going-forward half: an import that KNOWS its org is born with the determinate anchor and needs no heal", async () => {
    const { createAgentTemplate } = await import("../store");
    const { reconcileAgentTemplateOrgOwnership } = await import(
      "../reconcile-template-org-ownership"
    );
    const { evaluateActorWithinAgentTemplateScope } = await import("../auth-policy");

    // What `importAgentTemplateCore` now does when `resolveOwningOrgId` answers:
    // it passes `orgId`, and the write boundary stamps the full anchor.
    const id = `t_${randomUUID()}`;
    await createAgentTemplate({ ...baseSeed(id), orgId: ORG });

    const row = await readRow(id);
    expect(row.orgId).toBe(ORG);
    expect(row.ownerLevel).toBe("organization");
    expect(row.ownerId).toBe(ORG);
    // Runnable straight away — no reconcile in the loop.
    expect(evaluateActorWithinAgentTemplateScope(scopeRef(row), member())).toMatchObject({
      allowed: true,
      level: "organization",
    });

    // …and the reconcile does not consider it a candidate.
    const result = await reconcileAgentTemplateOrgOwnership(oneOrg);
    expect(result.templateIds).not.toEqual(expect.arrayContaining([id]));
  });
});
