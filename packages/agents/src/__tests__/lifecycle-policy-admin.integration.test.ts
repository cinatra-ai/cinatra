/**
 * cinatra#2047 (defect D-3 + row 9) — REAL-store proofs for the lifecycle ADMIN
 * leaf: the org policy-bound WRITE path's read half, and the org-scoped
 * review-gate VOLUME rollup.
 *
 *   BOUNDS  — the listing reflects every tuple the product can write, is ordered
 *             like the lattice key, is ORG-ISOLATED, and round-trips through the
 *             resolver with exact-beats-`*` specificity intact.
 *   VOLUME  — the headline open count is EXACT; the rollups are cut along the
 *             policy key's own axes; a gate with no linked produced event is
 *             COUNTED (never dropped); a batch gate linked by several events is
 *             counted ONCE; resolved gates are excluded; another org's gates are
 *             invisible; the listing is the oldest-first backlog head and carries
 *             the producing run's package for the review deep-link.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   CINATRA_TEST_DB_URL=postgres://postgres:postgres@127.0.0.1:5634/policy2047 \
 *     pnpm --filter @cinatra-ai/agents test:integration lifecycle-policy-admin
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const TEST_SCHEMA = "cinatra_test_policy_2047";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-2047-admin";
const OTHER_ORG = "org-2047-other";

let policyStore: typeof import("../lifecycle-policy-store");
let dbMod: typeof import("../db");

async function pool(text: string, values: unknown[] = []) {
  return dbMod.agentBuilderPool.query(text, values);
}

/** Insert a PENDING review gate directly — this file proves the READ, so the
 * gate rows are fixtures, not an exercise of the emit path. */
async function insertGate(over: {
  orgId?: string;
  runId?: string;
  reviewTaskId?: string;
  createdAt?: string;
  status?: string;
  targets?: number;
} = {}): Promise<{ gateId: string; runId: string; reviewTaskId: string }> {
  const gateId = `gate-${randomUUID()}`;
  const runId = over.runId ?? `run-${randomUUID()}`;
  const reviewTaskId = over.reviewTaskId ?? `lifecycle-review:${randomUUID()}`;
  const targets = Array.from({ length: over.targets ?? 1 }, () => ({
    artifactId: `art-${randomUUID()}`,
    representationRevisionId: `rev-${randomUUID()}`,
  }));
  const status = over.status ?? "pending";
  // The `artifact_review_gates_resolved_chk` CHECK requires a resolved gate to
  // carry its terminal disposition + fingerprint + resolution time, so a
  // RESOLVED fixture is stamped exactly as `commitReviewDecision` would.
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."artifact_review_gates"
       (id, run_id, org_id, review_task_id, status, pinned_targets, created_at,
        disposition, fingerprint, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, COALESCE($7::timestamptz, now()),
             $8, $9, $10)`,
    [
      gateId,
      runId,
      over.orgId ?? ORG,
      reviewTaskId,
      status,
      JSON.stringify(targets),
      over.createdAt ?? null,
      status === "pending" ? null : "approve",
      status === "pending" ? null : `fp-${randomUUID()}`,
      status === "pending" ? null : new Date(),
    ],
  );
  return { gateId, runId, reviewTaskId };
}

/** Link a produced event (+ its objects row) onto a gate so the rollup axes
 * resolve, exactly as orchestration does via `continuation_address`. */
async function linkEvent(
  gateId: string,
  over: {
    orgId?: string;
    artifactType?: string;
    destinationClass?: string;
    originKind?: string;
  } = {},
) {
  const artifactId = `art-${randomUUID()}`;
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."objects" (id, type, data, org_id)
     VALUES ($1, $2, '{}'::jsonb, $3) ON CONFLICT (id) DO NOTHING`,
    [artifactId, over.artifactType ?? "document", over.orgId ?? ORG],
  );
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."artifact_produced_outbox"
       (event_id, org_id, artifact_id, representation_revision_id, emitter,
        origin_kind, destination_class, continuation_mode, continuation_address, status)
     VALUES ($1, $2, $3, $4, 'createSemanticArtifact', $5, $6, 'async_effects_gated', $7, 'processed')`,
    [
      `ev-${randomUUID()}`,
      over.orgId ?? ORG,
      artifactId,
      `rev-${randomUUID()}`,
      over.originKind ?? "agent_produced",
      over.destinationClass ?? "none",
      gateId,
    ],
  );
}

/** Seed a template + run so the volume read can resolve the review deep-link's
 * package segments. */
async function seedRun(runId: string, packageName: string) {
  const templateId = `tpl-${randomUUID()}`;
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_templates"
       (id, name, source_nl, compiled_plan, input_schema, approval_policy, package_name)
     VALUES ($1, 'fixture', '', '[]', '{}', '{}', $2)`,
    [templateId, packageName],
  );
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_runs" (id, template_id, input_params, org_id)
     VALUES ($1, $2, '{}', $3)`,
    [runId, templateId, ORG],
  );
}

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;

  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
  await admin.query(`CREATE SCHEMA "${q(TEST_SCHEMA)}"`);
  const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
  for (const qy of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
    const head = qy.text.trim().slice(0, 6).toUpperCase();
    if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S") continue;
    if (qy.text.includes("user_slug_move_trg")) continue;
    // Sibling integration files bootstrap their OWN schema concurrently, and the
    // bootstrap touches shared `public` objects — two concurrent DDL statements
    // can deadlock, which Postgres resolves by aborting ONE of them. Each
    // statement is autocommit, so a bounded retry of the aborted one is safe and
    // deterministic; anything else propagates.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await admin.query(qy.text, (qy as { values?: unknown[] }).values as never[]);
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("does not exist") || msg.includes("already exists")) break;
        if (msg.includes("deadlock detected") && attempt < 5) {
          await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
  }
  await admin.end();
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;

  policyStore = await import("../lifecycle-policy-store");
  dbMod = await import("../db");
}, 90_000);

beforeEach(async () => {
  if (!HAS_DB) return;
  await pool(`TRUNCATE "${q(TEST_SCHEMA)}"."artifact_review_gates" CASCADE`);
  await pool(`TRUNCATE "${q(TEST_SCHEMA)}"."artifact_produced_outbox" CASCADE`);
  await pool(`TRUNCATE "${q(TEST_SCHEMA)}"."lifecycle_policy_rules" CASCADE`);
});

afterAll(async () => {
  if (!HAS_DB) return;
  await dbMod?.agentBuilderPool?.end().catch(() => {});
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_DB)("cinatra#2047 D-3 — org policy bounds are writable AND listable", () => {
  it("BOUNDS: every tuple the product can write round-trips through the listing", async () => {
    // The full key, exercised across all three axes + both bounds + the opt-in.
    await policyStore.upsertLifecyclePolicyRule({
      orgId: ORG, checkpoint: "review", artifactType: "document",
      destinationClass: "none", originKind: "agent_produced", bound: "required",
    });
    await policyStore.upsertLifecyclePolicyRule({
      orgId: ORG, checkpoint: "review", artifactType: policyStore.POLICY_ARTIFACT_TYPE_WILDCARD,
      destinationClass: "none", originKind: "agent_produced", bound: "forbidden",
    });
    await policyStore.upsertLifecyclePolicyRule({
      orgId: ORG, checkpoint: "recommendation", artifactType: "blog-post",
      destinationClass: "external_publish", originKind: "user_provided",
      bound: "required",
    });

    const rules = await policyStore.listLifecyclePolicyRules(ORG);
    expect(rules).toHaveLength(3);
    // Ordered like the lattice key: checkpoint → type → destination → origin.
    expect(rules[0].checkpoint).toBe("recommendation");
    expect(rules.slice(1).map((r) => r.artifactType)).toEqual(["*", "document"]);

    const rec = rules.find((r) => r.checkpoint === "recommendation")!;
    // cinatra#2047 row-3 re-scope: a listed bound carries no reviewer-eligibility field.
    expect(rec).not.toHaveProperty("selfApprovalOptIn");
    expect(rec.destinationClass).toBe("external_publish");
    expect(rec.originKind).toBe("user_provided");
  });

  it("BOUNDS: a re-save of the SAME tuple UPDATES in place (idempotent, no duplicate row)", async () => {
    const key = {
      orgId: ORG, checkpoint: "review" as const, artifactType: "document",
      destinationClass: "none" as const, originKind: "agent_produced" as const,
    };
    await policyStore.upsertLifecyclePolicyRule({ ...key, bound: "required" });
    await policyStore.upsertLifecyclePolicyRule({ ...key, bound: "forbidden" });

    const rules = await policyStore.listLifecyclePolicyRules(ORG);
    expect(rules).toHaveLength(1);
    expect(rules[0].bound).toBe("forbidden");
    expect(rules[0]).not.toHaveProperty("selfApprovalOptIn");
  });

  it("BOUNDS: exact beats `*`, and a retract returns the key to silent", async () => {
    const shared = {
      orgId: ORG, checkpoint: "review" as const,
      destinationClass: "none" as const, originKind: "agent_produced" as const,
    };
    await policyStore.upsertLifecyclePolicyRule({
      ...shared, artifactType: policyStore.POLICY_ARTIFACT_TYPE_WILDCARD, bound: "forbidden",
    });
    await policyStore.upsertLifecyclePolicyRule({
      ...shared, artifactType: "document", bound: "required",
    });

    const key = {
      checkpoint: "review" as const, artifactType: "document",
      destinationClass: "none" as const, originKind: "agent_produced" as const,
    };
    expect((await policyStore.resolveOrgPolicyRule(ORG, key)).bound).toBe("required");

    // Retract the EXACT rule → the wildcard takes over (not silent yet).
    await policyStore.deleteLifecyclePolicyRule({ orgId: ORG, ...key });
    expect((await policyStore.resolveOrgPolicyRule(ORG, key)).bound).toBe("forbidden");
    expect(await policyStore.listLifecyclePolicyRules(ORG)).toHaveLength(1);

    // Retract the wildcard too → fully silent, the core defaults decide again.
    await policyStore.deleteLifecyclePolicyRule({
      orgId: ORG, ...key, artifactType: policyStore.POLICY_ARTIFACT_TYPE_WILDCARD,
    });
    expect((await policyStore.resolveOrgPolicyRule(ORG, key)).bound).toBe("silent");
    expect(await policyStore.listLifecyclePolicyRules(ORG)).toHaveLength(0);
  });

  it("BOUNDS: the listing is ORG-ISOLATED — one org never sees another's bounds", async () => {
    await policyStore.upsertLifecyclePolicyRule({
      orgId: ORG, checkpoint: "review", artifactType: "document",
      destinationClass: "none", originKind: "agent_produced", bound: "required",
    });
    await policyStore.upsertLifecyclePolicyRule({
      orgId: OTHER_ORG, checkpoint: "review", artifactType: "secret-type",
      destinationClass: "none", originKind: "agent_produced", bound: "forbidden",
    });

    const mine = await policyStore.listLifecyclePolicyRules(ORG);
    expect(mine.map((r) => r.artifactType)).toEqual(["document"]);
    expect(mine.every((r) => r.orgId === ORG)).toBe(true);
    // ...and the resolver honours the same isolation.
    expect(
      (
        await policyStore.resolveOrgPolicyRule(ORG, {
          checkpoint: "review", artifactType: "secret-type",
          destinationClass: "none", originKind: "agent_produced",
        })
      ).bound,
    ).toBe("silent");
  });
});

describe.skipIf(!HAS_DB)("cinatra#2047 row 9 — org-scoped review-gate volume", () => {
  it("VOLUME: counts the org's OPEN gates and rolls them up along the policy key's axes", async () => {
    const a = await insertGate();
    await linkEvent(a.gateId, { artifactType: "document", destinationClass: "none", originKind: "agent_produced" });
    const b = await insertGate();
    await linkEvent(b.gateId, { artifactType: "document", destinationClass: "none", originKind: "agent_produced" });
    const c = await insertGate();
    await linkEvent(c.gateId, { artifactType: "blog-post", destinationClass: "external_publish", originKind: "agent_produced" });

    const v = await policyStore.readOrgReviewGateVolume({ orgId: ORG });
    expect(v.totalOpen).toBe(3);
    expect(v.byArtifactType).toEqual([
      { key: "document", open: 2 },
      { key: "blog-post", open: 1 },
    ]);
    expect(v.byDestinationClass).toEqual([
      { key: "none", open: 2 },
      { key: "external_publish", open: 1 },
    ]);
    expect(v.byOriginKind).toEqual([{ key: "agent_produced", open: 3 }]);
    expect(v.rollupTruncated).toBe(false);
  });

  it("VOLUME: a RESOLVED gate is not open volume", async () => {
    const open = await insertGate();
    await linkEvent(open.gateId);
    const done = await insertGate({ status: "resolved" });
    await linkEvent(done.gateId);

    const v = await policyStore.readOrgReviewGateVolume({ orgId: ORG });
    expect(v.totalOpen).toBe(1);
    expect(v.openGates.map((g) => g.gateId)).toEqual([open.gateId]);
  });

  it("VOLUME: another org's open gates are INVISIBLE", async () => {
    const mine = await insertGate();
    await linkEvent(mine.gateId);
    const theirs = await insertGate({ orgId: OTHER_ORG });
    await linkEvent(theirs.gateId, { orgId: OTHER_ORG, artifactType: "their-type" });

    const v = await policyStore.readOrgReviewGateVolume({ orgId: ORG });
    expect(v.totalOpen).toBe(1);
    expect(v.byArtifactType.map((b) => b.key)).not.toContain("their-type");
    expect(v.openGates.map((g) => g.gateId)).toEqual([mine.gateId]);
  });

  it("VOLUME: a gate with NO linked produced event is COUNTED, not dropped", async () => {
    // A flow-authored gate (or an auto-gate caught mid-crash-window before the
    // link stamps) has no outbox row. Under-reporting the backlog on a backlog
    // surface would be the worst possible failure, so it counts under `—`.
    const linked = await insertGate();
    await linkEvent(linked.gateId, { artifactType: "document" });
    const unlinked = await insertGate();

    const v = await policyStore.readOrgReviewGateVolume({ orgId: ORG });
    expect(v.totalOpen).toBe(2);
    expect(v.byArtifactType).toContainEqual({ key: "—", open: 1 });
    expect(v.byDestinationClass).toContainEqual({ key: "—", open: 1 });
    expect(v.rollupScanned).toBe(2);
    expect(v.openGates.map((g) => g.gateId).sort()).toEqual([linked.gateId, unlinked.gateId].sort());
  });

  it("VOLUME: a BATCH gate linked by SEVERAL events is counted ONCE (join fan-out de-duplicated)", async () => {
    const batch = await insertGate({ targets: 3 });
    await linkEvent(batch.gateId, { artifactType: "document" });
    await linkEvent(batch.gateId, { artifactType: "document" });
    await linkEvent(batch.gateId, { artifactType: "document" });

    const v = await policyStore.readOrgReviewGateVolume({ orgId: ORG });
    expect(v.totalOpen).toBe(1);
    expect(v.byArtifactType).toEqual([{ key: "document", open: 1 }]);
    expect(v.openGates).toHaveLength(1);
    expect(v.openGates[0].targetCount).toBe(3);
  });

  it("VOLUME: a HETEROGENEOUS batch gate is labelled `mixed`, never assigned one member's axes", async () => {
    // Production coalesces a batch by (orgId, producerRunId) — NOT by artifact
    // type / destination / origin — so one gate legitimately covers several
    // values on an axis. Picking one member's value would be arbitrary AND
    // nondeterministic (SQL gives no order within a gate).
    const batch = await insertGate({ targets: 2 });
    await linkEvent(batch.gateId, { artifactType: "document", destinationClass: "none" });
    await linkEvent(batch.gateId, {
      artifactType: "blog-post",
      destinationClass: "external_publish",
    });

    const v = await policyStore.readOrgReviewGateVolume({ orgId: ORG });
    expect(v.totalOpen).toBe(1);
    expect(v.byArtifactType).toEqual([{ key: "mixed", open: 1 }]);
    expect(v.byDestinationClass).toEqual([{ key: "mixed", open: 1 }]);
    // The axis both members AGREE on is still reported precisely.
    expect(v.byOriginKind).toEqual([{ key: "agent_produced", open: 1 }]);
    expect(v.openGates[0].artifactType).toBe("mixed");
  });

  it("VOLUME: the rollup is DETERMINISTIC across repeated reads of the same data", async () => {
    const batch = await insertGate({ targets: 3 });
    await linkEvent(batch.gateId, { artifactType: "a-type" });
    await linkEvent(batch.gateId, { artifactType: "b-type" });
    await linkEvent(batch.gateId, { artifactType: "c-type" });
    const first = await policyStore.readOrgReviewGateVolume({ orgId: ORG });
    const second = await policyStore.readOrgReviewGateVolume({ orgId: ORG });
    expect(second.byArtifactType).toEqual(first.byArtifactType);
    expect(second.openGates.map((g) => g.gateId)).toEqual(first.openGates.map((g) => g.gateId));
  });

  it("VOLUME: a cross-linked event from ANOTHER org contributes no axis (joins are tenant-anchored)", async () => {
    // The gate belongs to ORG; the event pointing at it is stamped OTHER_ORG.
    // The org-anchored join must ignore it entirely rather than let another
    // tenant's artifact type / axes bleed into this org's rollup.
    const gate = await insertGate();
    await linkEvent(gate.gateId, { orgId: OTHER_ORG, artifactType: "foreign-type" });

    const v = await policyStore.readOrgReviewGateVolume({ orgId: ORG });
    expect(v.totalOpen).toBe(1);
    expect(v.byArtifactType).toEqual([{ key: "—", open: 1 }]);
    expect(v.byDestinationClass).toEqual([{ key: "—", open: 1 }]);
    expect(v.openGates[0].artifactType).toBe("—");
  });

  it("VOLUME: a run in ANOTHER org contributes no package name to the deep-link", async () => {
    const gate = await insertGate();
    await linkEvent(gate.gateId);
    // Seed the producing run under a DIFFERENT org than the gate.
    const templateId = `tpl-${randomUUID()}`;
    await pool(
      `INSERT INTO "${q(TEST_SCHEMA)}"."agent_templates"
         (id, name, source_nl, compiled_plan, input_schema, approval_policy, package_name)
       VALUES ($1,'fixture','','[]','{}','{}',$2)`,
      [templateId, "@cinatra-ai/foreign-agent"],
    );
    await pool(
      `INSERT INTO "${q(TEST_SCHEMA)}"."agent_runs" (id, template_id, input_params, org_id)
       VALUES ($1,$2,'{}',$3)`,
      [gate.runId, templateId, OTHER_ORG],
    );

    const v = await policyStore.readOrgReviewGateVolume({ orgId: ORG });
    expect(v.openGates[0].runPackageName).toBeNull();
  });

  it("VOLUME: the listing is the OLDEST-FIRST backlog head, with age buckets", async () => {
    const old = await insertGate({ createdAt: new Date(Date.now() - 9 * 864e5).toISOString() });
    await linkEvent(old.gateId);
    const mid = await insertGate({ createdAt: new Date(Date.now() - 3 * 864e5).toISOString() });
    await linkEvent(mid.gateId);
    const fresh = await insertGate();
    await linkEvent(fresh.gateId);

    const v = await policyStore.readOrgReviewGateVolume({ orgId: ORG });
    expect(v.openGates.map((g) => g.gateId)).toEqual([old.gateId, mid.gateId, fresh.gateId]);
    expect(v.oldestOpenAt?.getTime()).toBe(v.openGates[0].createdAt.getTime());
    expect(v.aging).toEqual({ under24h: 1, under7d: 1, over7d: 1 });
    expect(v.openGates[0].ageMs).toBeGreaterThan(v.openGates[2].ageMs);
  });

  it("VOLUME: the listing limit caps the ROWS but never the headline total", async () => {
    for (let i = 0; i < 5; i += 1) {
      const g = await insertGate();
      await linkEvent(g.gateId);
    }
    const v = await policyStore.readOrgReviewGateVolume({ orgId: ORG, listingLimit: 2 });
    expect(v.totalOpen).toBe(5);
    expect(v.openGates).toHaveLength(2);
    // The rollup still describes ALL five (the scan is not the listing).
    expect(v.byArtifactType.reduce((n, b) => n + b.open, 0)).toBe(5);
  });

  it("VOLUME: the listing carries the producing run's package for the review deep-link", async () => {
    const g = await insertGate();
    await seedRun(g.runId, "@cinatra-ai/blog-draft-writer-agent");
    await linkEvent(g.gateId);

    const v = await policyStore.readOrgReviewGateVolume({ orgId: ORG });
    expect(v.openGates[0].runPackageName).toBe("@cinatra-ai/blog-draft-writer-agent");
    expect(v.openGates[0].runId).toBe(g.runId);
    expect(v.openGates[0].reviewTaskId).toBe(g.reviewTaskId);
  });

  it("VOLUME: an org with nothing open reports a clean zero (never a throw)", async () => {
    const v = await policyStore.readOrgReviewGateVolume({ orgId: "org-with-nothing" });
    expect(v).toMatchObject({
      totalOpen: 0,
      oldestOpenAt: null,
      aging: { under24h: 0, under7d: 0, over7d: 0 },
      byArtifactType: [],
      openGates: [],
      rollupScanned: 0,
      rollupTruncated: false,
    });
  });
});
