/**
 * A REGENERATE THAT LANDS AFTER A CONTINUE, WITH THE REAL DECLARATION READ
 * (cinatra#3080).
 *
 * The sibling suite `review-floor-3080.integration.test.ts` answers the
 * producing step's Note-input declaration from a map the suite owns, so its
 * runs DECLARE the input by default. Its Regenerate-after-Continue case
 * therefore never met the refusal for a step that declares nothing, which is
 * every step today. This file replaces nothing: the declaration read
 * (`readProducingStepNoteInput`) is the real one, and it finds none.
 *
 * The rule pinned here: a Regenerate on a gate that a Continue already
 * resolved is BLOCKED (`gate-not-pending`), and the first decision stands. It
 * is never the retryable "Regenerate is not available" refusal, which belongs
 * to a gate that is still pending.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   CINATRA_TEST_DB_URL=postgres://…/postgres \
 *     pnpm exec vitest run --config vitest.integration.config.ts src/__tests__/regenerate-after-continue-real-declaration-3080.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import type { ReviewDecisionCommitPlan } from "@/lib/artifacts/artifact-review-decision";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

const TEST_SCHEMA = "cinatra_test_regen_after_continue_3080";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-3080-regen-after-continue";
const OWNER_ID = "user-owner-3080-rac";

let gateStore: typeof import("../artifact-review-gate-store");
let changesRequested: typeof import("../lifecycle-review-changes-requested-store");
let dbMod: { agentBuilderPool?: { end: () => Promise<void> } };
let client: Client;

type Target = { artifactId: string; representationRevisionId: string };

const target = (): Target => ({
  artifactId: `art-${randomUUID()}`,
  representationRevisionId: `rev-${randomUUID()}`,
});

/** A real run on a real template whose agent DECLARES `repairCapable: true`.
 *  The producing step declares no Note input: the contract has no field that
 *  could hold one, so nothing is seeded for it and the real read finds none. */
async function seedRun(): Promise<string> {
  const runId = `run-${randomUUID()}`;
  const templateId = `tmpl-${randomUUID()}`;
  await client.query(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_templates"
       (id, package_name, org_id, name, source_nl, compiled_plan, input_schema, approval_policy, lifecycle_config)
     VALUES ($1, $2, $3, 'regen-after-continue fixture', 'fixture', '[]', '{}', '{}', $4)`,
    [
      templateId,
      `@cinatra-ai/regen-after-continue-fixture-${templateId}`,
      ORG,
      JSON.stringify({ repairCapable: true }),
    ],
  );
  await client.query(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_runs" (id, template_id, org_id, run_by, status, input_params)
     VALUES ($1, $2, $3, $4, 'queued', '{}')`,
    [runId, templateId, ORG, OWNER_ID],
  );
  return runId;
}

async function emitLifecycleGate(runId: string, targets: Target[]): Promise<string> {
  const reviewTaskId = `lifecycle-review:${randomUUID()}`;
  await gateStore.emitArtifactReviewGate({ runId, orgId: ORG, reviewTaskId, targets });
  return reviewTaskId;
}

/** The CONTINUE plan — the former approve, storing the same disposition. */
function continuePlan(runId: string, reviewTaskId: string, targets: Target[]): ReviewDecisionCommitPlan {
  return {
    runId,
    reviewTaskId,
    disposition: "approve",
    terminal: true,
    fingerprint: `continue-${randomUUID()}`,
    comment: null,
    decidedBy: OWNER_ID,
    auditRows: targets.map((t) => ({
      artifactId: t.artifactId,
      representationRevisionId: t.representationRevisionId,
      disposition: "approve" as const,
      rendererProvenance: { kind: "floor" as const, packageName: null, digest: null },
    })),
    dispositionOps: [],
    resumeIntent: { kind: "approve", userResponse: "{}" },
    suggestionPlan: null,
  };
}

async function regenerate(runId: string, reviewTaskId: string, base: Target, note: string) {
  return changesRequested.recordReviewSurfaceChangesRequested({
    runId,
    reviewTaskId,
    baseTarget: base,
    currentBaseRevisionId: base.representationRevisionId,
    feedback: note,
    decidedBy: OWNER_ID,
    origin: "regenerate",
  });
}

async function gateRow(runId: string, reviewTaskId: string) {
  const { rows } = await client.query(
    `SELECT id, status, disposition FROM "${q(TEST_SCHEMA)}"."artifact_review_gates"
     WHERE run_id = $1 AND review_task_id = $2`,
    [runId, reviewTaskId],
  );
  return rows[0] as { id: string; status: string; disposition: string | null } | undefined;
}

async function repairRowsFor(gateId: string) {
  const { rows } = await client.query(
    `SELECT id FROM "${q(TEST_SCHEMA)}"."lifecycle_repair" WHERE gate_id = $1`,
    [gateId],
  );
  return rows;
}

async function auditRowsFor(gateId: string) {
  const { rows } = await client.query(
    `SELECT disposition FROM "${q(TEST_SCHEMA)}"."artifact_review_audit" WHERE gate_id = $1`,
    [gateId],
  );
  return rows as Array<{ disposition: string }>;
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
    try {
      await admin.query(qy.text, (qy as { values?: unknown[] }).values as never[]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("does not exist") && !msg.includes("already exists")) throw err;
    }
  }
  await admin.end();
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;

  gateStore = await import("../artifact-review-gate-store");
  changesRequested = await import("../lifecycle-review-changes-requested-store");
  dbMod = (await import("../artifact-review-gate-store")) as unknown as {
    agentBuilderPool?: { end: () => Promise<void> };
  };
  client = new Client({ connectionString: DB_URL });
  await client.connect();
}, 90_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await client?.end().catch(() => {});
  await dbMod?.agentBuilderPool?.end?.().catch(() => {});
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_DB)("cinatra#3080 — Regenerate after Continue, with the real declaration read", () => {
  it("the real declaration read finds none for a seeded run", async () => {
    const runId = await seedRun();
    const { readProducingStepNoteInput } = await import("../lifecycle-repair-producer-registry");
    expect(await readProducingStepNoteInput(runId)).toBeNull();
  });

  it("a REGENERATE that lands after a Continue is BLOCKED as gate-not-pending — the first decision stands", async () => {
    const runId = await seedRun();
    const base = target();
    const reviewTaskId = await emitLifecycleGate(runId, [base]);

    const outcome = await gateStore.commitReviewDecision(continuePlan(runId, reviewTaskId, [base]));
    expect(outcome.status).toBe("committed");
    const settled = await gateRow(runId, reviewTaskId);
    const auditBefore = await auditRowsFor(settled!.id);

    const regenerated = await regenerate(runId, reviewTaskId, base, "too late");
    expect(regenerated.ok).toBe(false);
    if (regenerated.ok) throw new Error("unreachable");
    expect(regenerated.code).toBe("gate-not-pending");

    // The FIRST decision stands, and nothing was written.
    const after = await gateRow(runId, reviewTaskId);
    expect(after?.status).toBe("resolved");
    expect(after?.disposition).toBe("approve");
    expect(await repairRowsFor(after!.id)).toHaveLength(0);
    expect(await auditRowsFor(after!.id)).toEqual(auditBefore);
  });

  it("on a gate that is still PENDING the same press is the plain refusal, and the gate stays pending", async () => {
    const runId = await seedRun();
    const base = target();
    const reviewTaskId = await emitLifecycleGate(runId, [base]);

    const regenerated = await regenerate(runId, reviewTaskId, base, "make the sky bluer");
    expect(regenerated.ok).toBe(false);
    if (regenerated.ok) throw new Error("unreachable");
    expect(regenerated.code).toBe("regenerate-unavailable");
    const { REGENERATE_NO_NOTE_INPUT } = await import("@/lib/artifacts/review-surface-model");
    expect(regenerated.error).toBe(REGENERATE_NO_NOTE_INPUT);

    const after = await gateRow(runId, reviewTaskId);
    expect(after?.status).toBe("pending");
    expect(after?.disposition ?? null).toBeNull();
    expect(await repairRowsFor(after!.id)).toHaveLength(0);
  });
});
