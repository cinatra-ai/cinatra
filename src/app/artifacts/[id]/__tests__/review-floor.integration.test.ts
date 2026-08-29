/**
 * THE FLOOR AGAINST A REAL STORE (cinatra#3080, acceptance items 3 and 4).
 *
 * The two items that are claims about STATE rather than about drawing, proven
 * where the state actually lives — a real Postgres, the real gate store, the
 * real repair store, a real seeded run:
 *
 *   item 3 — "Comment records the note and changes nothing else: the gate stays
 *            pending, the run stays parked, the frozen revision is unchanged, no
 *            successor gate exists — a real-store test proves all four."
 *   item 4 — Regenerate calls the change road's CANONICAL operation, settles the
 *            earlier gate, opens exactly one successor, refuses an empty note
 *            with a reason, is idempotent on a double press, and refuses a stale
 *            Continue-after-Regenerate (and the reverse) — the first decision
 *            stands. A legacy multi-target gate refuses Regenerate with a stated
 *            reason and still allows Comment and Continue.
 *
 * WHY THE CANONICAL OPERATION IS DRIVEN DIRECTLY. `submitReviewDecisionAction`
 * resolves a session actor and, for a Continue, needs the objects read pool this
 * lane DB deliberately does not wire (the sibling `review-gate-ports`
 * integration states the same limit). What that action DOES — which road each
 * floor action takes, under which access, with which refusal — is proven at the
 * action in `actions.review-floor.test.ts`; what the roads THEMSELVES do to the
 * store is proven here. Between them nothing is asserted only in a mock.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   CINATRA_DB_INTEGRATION_TESTS=1 \
 *   SUPABASE_DB_URL=postgres://…/cinatra_lane_3080 \
 *     pnpm test src/app/artifacts/[id]/__tests__/review-floor.integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import type { ReviewDecisionCommitPlan } from "@/lib/artifacts/artifact-review-decision";

const TEST_SCHEMA = "cinatra_test_review_floor_3080";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-3080-review-floor";
const OWNER_ID = "user-owner-3080";

let gateStore: typeof import("@cinatra-ai/agents/artifact-review-gate-store");
let changesRequested: typeof import("@cinatra-ai/agents/lifecycle-review-changes-requested");
let dbMod: { agentBuilderPool?: { end: () => Promise<void> } };
let client: Client;

type Target = { artifactId: string; representationRevisionId: string };

const target = (): Target => ({
  artifactId: `art-${randomUUID()}`,
  representationRevisionId: `rev-${randomUUID()}`,
});

/** Seed a real `agent_runs` row directly, for the same reason the sibling suite
 *  does: the store helper fires a best-effort objects shadow-write whose floating
 *  rejection to an unconfigured mirror host would flake the suite. */
async function seedRun(): Promise<string> {
  const runId = `run-${randomUUID()}`;
  await client.query(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_runs" (id, template_id, org_id, run_by, status, input_params)
     VALUES ($1, $2, $3, $4, 'queued', '{}')`,
    [runId, `tmpl-${randomUUID()}`, ORG, OWNER_ID],
  );
  return runId;
}

/** A LIFECYCLE auto-review gate — the class the change road recognises. */
async function emitLifecycleGate(runId: string, targets: Target[]): Promise<string> {
  const reviewTaskId = `lifecycle-review:${randomUUID()}`;
  await gateStore.emitArtifactReviewGate({ runId, orgId: ORG, reviewTaskId, targets });
  return reviewTaskId;
}

/** The COMMENT plan the decision core builds: non-terminal, audit only. */
function commentPlan(runId: string, reviewTaskId: string, targets: Target[]): ReviewDecisionCommitPlan {
  return {
    runId,
    reviewTaskId,
    disposition: "comment",
    terminal: false,
    fingerprint: `comment-${randomUUID()}`,
    comment: "please tighten the opening",
    decidedBy: OWNER_ID,
    auditRows: targets.map((t) => ({
      artifactId: t.artifactId,
      representationRevisionId: t.representationRevisionId,
      disposition: "comment" as const,
      rendererProvenance: { kind: "floor" as const, packageName: null, digest: null },
    })),
    dispositionOps: [],
    resumeIntent: null,
    suggestionPlan: null,
  };
}

/** The CONTINUE plan — the former approve, storing the same disposition. */
function continuePlan(
  runId: string,
  reviewTaskId: string,
  targets: Target[],
): ReviewDecisionCommitPlan {
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

async function regenerate(
  runId: string,
  reviewTaskId: string,
  base: Target,
  note: string,
  prompt?: string,
) {
  return changesRequested.recordReviewSurfaceChangesRequested({
    runId,
    reviewTaskId,
    baseTarget: base,
    currentBaseRevisionId: base.representationRevisionId,
    feedback: note,
    ...(prompt === undefined ? {} : { prompt }),
    decidedBy: OWNER_ID,
  });
}

async function gateRow(runId: string, reviewTaskId: string) {
  const { rows } = await client.query(
    `SELECT id, status, disposition, pinned_targets FROM "${q(TEST_SCHEMA)}"."artifact_review_gates"
     WHERE run_id = $1 AND review_task_id = $2`,
    [runId, reviewTaskId],
  );
  return rows[0] as
    | { id: string; status: string; disposition: string | null; pinned_targets: unknown }
    | undefined;
}

async function repairRowsFor(gateId: string) {
  const { rows } = await client.query(
    `SELECT id, attempt, findings, idempotency_key FROM "${q(TEST_SCHEMA)}"."lifecycle_repair" WHERE gate_id = $1`,
    [gateId],
  );
  return rows as Array<{
    id: string;
    attempt: number;
    findings: unknown;
    idempotency_key: string;
  }>;
}

async function runStatus(runId: string): Promise<string> {
  const { rows } = await client.query(
    `SELECT status FROM "${q(TEST_SCHEMA)}"."agent_runs" WHERE id = $1`,
    [runId],
  );
  return (rows[0] as { status: string }).status;
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

  gateStore = await import("@cinatra-ai/agents/artifact-review-gate-store");
  changesRequested = await import("@cinatra-ai/agents/lifecycle-review-changes-requested");
  dbMod = (await import("@cinatra-ai/agents/artifact-review-gate-store")) as unknown as {
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

describe.skipIf(!HAS_DB)("item 3 — Comment records the note and changes NOTHING else", () => {
  it("leaves the gate pending, the run parked, the revision frozen and no successor open", async () => {
    const runId = await seedRun();
    const base = target();
    const reviewTaskId = await emitLifecycleGate(runId, [base]);
    const before = await gateRow(runId, reviewTaskId);
    const runBefore = await runStatus(runId);

    await gateStore.commitReviewDecision(commentPlan(runId, reviewTaskId, [base]));

    const after = await gateRow(runId, reviewTaskId);
    // 1. the gate stays PENDING …
    expect(after?.status).toBe("pending");
    expect(after?.disposition ?? null).toBeNull();
    // 2. … the run stays parked exactly where it was …
    expect(await runStatus(runId)).toBe(runBefore);
    // 3. … the frozen revision is unchanged …
    expect(JSON.stringify(after?.pinned_targets)).toBe(JSON.stringify(before?.pinned_targets));
    // 4. … and no successor is opened: the change road was never entered.
    expect(await repairRowsFor(after!.id)).toHaveLength(0);
  });

  it("records the note — the WORDS themselves, readable back off the gate", async () => {
    const runId = await seedRun();
    const base = target();
    const reviewTaskId = await emitLifecycleGate(runId, [base]);
    const plan = commentPlan(runId, reviewTaskId, [base]);
    await gateStore.commitReviewDecision(plan);

    // THAT a comment was filed …
    const audit = await client.query(
      `SELECT disposition FROM "${q(TEST_SCHEMA)}"."artifact_review_audit"
       WHERE decision_fingerprint = $1`,
      [plan.fingerprint],
    );
    expect(audit.rows).toHaveLength(1);
    expect((audit.rows[0] as { disposition: string }).disposition).toBe("comment");

    // … and WHAT WAS WRITTEN. The audit row has no body column, so a test that
    // stops at the disposition would pass with the reviewer's words discarded —
    // which is exactly what happened once the Comment→changes_requested overload
    // was removed. The note lives on the gate's advisory seam, decision-free.
    const gate = await gateRow(runId, reviewTaskId);
    const notes = await client.query(
      `SELECT body, author_id, idempotency_key FROM "${q(TEST_SCHEMA)}"."gate_advisory_comments"
       WHERE gate_id = $1`,
      [gate!.id],
    );
    expect(notes.rows).toHaveLength(1);
    const note = notes.rows[0] as { body: string; author_id: string; idempotency_key: string };
    expect(note.body).toBe("please tighten the opening");
    expect(note.author_id).toBe(OWNER_ID);
    expect(note.idempotency_key).toBe(plan.fingerprint);
  });

  it("a RESPONSE-LOST retry of the same comment re-files the same note, not a second", async () => {
    const runId = await seedRun();
    const base = target();
    const reviewTaskId = await emitLifecycleGate(runId, [base]);
    const plan = commentPlan(runId, reviewTaskId, [base]);
    await gateStore.commitReviewDecision(plan);
    await gateStore.commitReviewDecision(plan);
    const gate = await gateRow(runId, reviewTaskId);
    const notes = await client.query(
      `SELECT id FROM "${q(TEST_SCHEMA)}"."gate_advisory_comments" WHERE gate_id = $1`,
      [gate!.id],
    );
    expect(notes.rows).toHaveLength(1);
    expect(gate?.status).toBe("pending");
  });

  it("a SECOND comment still changes nothing — the gate does not drift toward a decision", async () => {
    const runId = await seedRun();
    const base = target();
    const reviewTaskId = await emitLifecycleGate(runId, [base]);
    await gateStore.commitReviewDecision(commentPlan(runId, reviewTaskId, [base]));
    await gateStore.commitReviewDecision(commentPlan(runId, reviewTaskId, [base]));
    const after = await gateRow(runId, reviewTaskId);
    expect(after?.status).toBe("pending");
    expect(await repairRowsFor(after!.id)).toHaveLength(0);
  });
});

describe.skipIf(!HAS_DB)("item 4 — Regenerate rides the change road's canonical operation", () => {
  // WHAT "one successor" MEANS HERE, exactly. The canonical operation opens ONE
  // repair lineage on the change road; the successor review GATE is minted later,
  // when the producing step answers with the next revision — that is the change
  // road's own slice, not this one. So this proves the two things this call is
  // responsible for: one lineage, and no second review gate minted now.
  it("settles the earlier gate as superseded and opens exactly ONE successor lineage", async () => {
    const runId = await seedRun();
    const base = target();
    const reviewTaskId = await emitLifecycleGate(runId, [base]);

    const result = await regenerate(runId, reviewTaskId, base, "make the sky bluer");
    expect(result.ok).toBe(true);

    const after = await gateRow(runId, reviewTaskId);
    // The EARLIER gate is settled in the change road's own representation.
    expect(after?.status).toBe("resolved");
    expect(after?.disposition).toBe("changes_requested");
    // EXACTLY ONE successor lineage — never two, never none.
    expect(await repairRowsFor(after!.id)).toHaveLength(1);
    // … and no second REVIEW GATE was minted by this call: the run still holds
    // the one (now settled) gate. A Regenerate that quietly opened a parallel
    // pending gate would satisfy the lineage count and still be wrong.
    const gates = await client.query(
      `SELECT id, status FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE run_id = $1`,
      [runId],
    );
    expect(gates.rows).toHaveLength(1);
    expect((gates.rows[0] as { status: string }).status).toBe("resolved");
  });

  it("refuses an EMPTY note with a reason, and writes nothing at all", async () => {
    const runId = await seedRun();
    const base = target();
    const reviewTaskId = await emitLifecycleGate(runId, [base]);

    for (const note of ["", "   ", "\n\t "]) {
      const result = await regenerate(runId, reviewTaskId, base, note);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.code).toBe("empty-feedback");
      expect(result.error.length).toBeGreaterThan(0);
    }
    const after = await gateRow(runId, reviewTaskId);
    expect(after?.status).toBe("pending");
    expect(await repairRowsFor(after!.id)).toHaveLength(0);
  });

  it("is IDEMPOTENT on a double press — one revision asked for, one successor", async () => {
    const runId = await seedRun();
    const base = target();
    const reviewTaskId = await emitLifecycleGate(runId, [base]);

    const first = await regenerate(runId, reviewTaskId, base, "warmer light");
    const second = await regenerate(runId, reviewTaskId, base, "warmer light");
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(second.repairId).toBe(first.repairId);
    expect(second.idempotent).toBe(true);

    const after = await gateRow(runId, reviewTaskId);
    expect(await repairRowsFor(after!.id)).toHaveLength(1);
  });

  it("a CONTINUE that lands after a Regenerate is refused as stale — the first decision stands", async () => {
    const runId = await seedRun();
    const base = target();
    const reviewTaskId = await emitLifecycleGate(runId, [base]);

    const regenerated = await regenerate(runId, reviewTaskId, base, "again please");
    expect(regenerated.ok).toBe(true);

    // The Continue arrives second. The gate CAS has already moved.
    const outcome = await gateStore.commitReviewDecision(continuePlan(runId, reviewTaskId, [base]));
    expect(outcome.status).toBe("conflict");

    const after = await gateRow(runId, reviewTaskId);
    // The FIRST decision stands, untouched.
    expect(after?.disposition).toBe("changes_requested");
  });

  it("a REGENERATE that lands after a Continue is refused as stale — the reverse holds too", async () => {
    const runId = await seedRun();
    const base = target();
    const reviewTaskId = await emitLifecycleGate(runId, [base]);

    const outcome = await gateStore.commitReviewDecision(continuePlan(runId, reviewTaskId, [base]));
    expect(outcome.status).toBe("committed");

    const regenerated = await regenerate(runId, reviewTaskId, base, "too late");
    expect(regenerated.ok).toBe(false);
    if (regenerated.ok) throw new Error("unreachable");
    expect(regenerated.code).toBe("gate-not-pending");

    const after = await gateRow(runId, reviewTaskId);
    // The FIRST decision stands: Continue's stored `approve`, unmigrated.
    expect(after?.disposition).toBe("approve");
    expect(await repairRowsFor(after!.id)).toHaveLength(0);
  });

  it("a LEGACY multi-target gate refuses Regenerate — and Comment and Continue still work", async () => {
    const runId = await seedRun();
    const a = target();
    const b = target();
    const reviewTaskId = await emitLifecycleGate(runId, [a, b]);

    const regenerated = await regenerate(runId, reviewTaskId, a, "make it again");
    expect(regenerated.ok).toBe(false);
    if (regenerated.ok) throw new Error("unreachable");
    // A STATED reason, not a silent no-op.
    expect(regenerated.code).toBe("targets-mismatch");
    expect(regenerated.error.length).toBeGreaterThan(0);

    // COMMENT still lands, and still changes nothing.
    await gateStore.commitReviewDecision(commentPlan(runId, reviewTaskId, [a, b]));
    expect((await gateRow(runId, reviewTaskId))?.status).toBe("pending");

    // CONTINUE still resolves it.
    const outcome = await gateStore.commitReviewDecision(continuePlan(runId, reviewTaskId, [a, b]));
    expect(outcome.status).toBe("committed");
    const after = await gateRow(runId, reviewTaskId);
    expect(after?.disposition).toBe("approve");
    expect(await repairRowsFor(after!.id)).toHaveLength(0);
  });
});

describe.skipIf(!HAS_DB)("item 5 — the note and the picture's prompt are two values, in the store", () => {
  it("records the prompt as its OWN finding beside the note, never appended to it", async () => {
    const runId = await seedRun();
    const base = target();
    const reviewTaskId = await emitLifecycleGate(runId, [base]);

    const result = await regenerate(runId, reviewTaskId, base, "warmer light", "a red bicycle at golden hour");
    expect(result.ok).toBe(true);

    const after = await gateRow(runId, reviewTaskId);
    const [repair] = await repairRowsFor(after!.id);
    const findings = repair.findings as Array<{ id: string; message: string }>;
    expect(findings).toHaveLength(2);
    expect(findings.find((f) => f.id === "prompt-window")?.message).toBe("warmer light");
    expect(findings.find((f) => f.id === "picture-prompt")?.message).toBe(
      "a red bicycle at golden hour",
    );
  });

  it("records ONE finding when there is no prompt — byte-identical to before the field existed", async () => {
    const runId = await seedRun();
    const base = target();
    const reviewTaskId = await emitLifecycleGate(runId, [base]);

    await regenerate(runId, reviewTaskId, base, "warmer light");
    const after = await gateRow(runId, reviewTaskId);
    const [repair] = await repairRowsFor(after!.id);
    expect(repair.findings).toEqual([{ id: "prompt-window", message: "warmer light" }]);
  });

  it("an EDITED prompt is a different request — it cannot silently re-derive the first repair", async () => {
    const runId = await seedRun();
    const base = target();
    const reviewTaskId = await emitLifecycleGate(runId, [base]);

    const first = await regenerate(runId, reviewTaskId, base, "warmer light", "a red bicycle");
    expect(first.ok).toBe(true);
    const second = await regenerate(runId, reviewTaskId, base, "warmer light", "a blue bicycle");
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    // The gate is already repairing on the first request; a second, DIFFERENT
    // one is a conflict rather than a quiet reuse of the first repair.
    expect(second.code).toBe("gate-conflict");
  });
});
