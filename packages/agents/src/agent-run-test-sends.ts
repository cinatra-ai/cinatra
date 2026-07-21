import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "./db";
import { agentRunTestSends } from "./schema";

// ---------------------------------------------------------------------------
// agent_run_test_sends store (eng#548 #1625, DESIGN-V3 contract (4)).
//
// The durable per-action idempotency + crash ledger for the run-scoped
// test-delivery send primitive. Dedupe identity is (run_id, submission_id): a
// transport retry of the SAME gate resume reuses the claimed row (never a second
// send); a genuine second send is a NEW gate re-entry with a NEW submission_id.
//
// Crash semantics (round-2/3): the DB transaction is NOT held across the outbound
// send. `claimTestSend` is the atomic exactly-once claim — INSERT … ON CONFLICT
// (run_id, submission_id) DO NOTHING — so a concurrent duplicate claim reads the
// existing row instead of sending again. The seq (monotonic per run) is assigned
// IN the claim INSERT and is the ordinal parse_action reads for the maxGateVisits
// halt guard. Per-run sends are gate-serialized (one HITL resume in flight at a
// time), so the MAX(seq)+1 assignment is not a real concurrency hazard; the
// UNIQUE (run_id, submission_id) is the invariant that fences transport retries.
//
// The pinned `selectedDraftIds` (resolved ONCE at phase-1, never rerandomized) is
// persisted in the claim BEFORE any outbound send, so a crash between claim and
// settle reconciles against a durable expected batch. Server-only.
// ---------------------------------------------------------------------------

export type TestSendStatus = "sending" | "sent" | "failed";

export type TestSendRecord = {
  id: string;
  runId: string;
  submissionId: string;
  seq: number;
  status: TestSendStatus;
  recipientEmail: string | null;
  selectedDraftIds: string[];
  resultJson: Record<string, unknown> | null;
  claimedAt: Date;
  leaseExpiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

function deserialize(row: typeof agentRunTestSends.$inferSelect): TestSendRecord {
  return {
    id:               row.id,
    runId:            row.runId,
    submissionId:     row.submissionId,
    seq:              row.seq,
    status:           row.status as TestSendStatus,
    recipientEmail:   row.recipientEmail,
    selectedDraftIds: (row.selectedDraftIds as string[] | null) ?? [],
    resultJson:       row.resultJson ?? null,
    claimedAt:        row.claimedAt,
    leaseExpiresAt:   row.leaseExpiresAt,
    createdAt:        row.createdAt,
    updatedAt:        row.updatedAt,
  };
}

export type ClaimTestSendResult =
  | { kind: "claimed"; row: TestSendRecord }
  | { kind: "existing"; row: TestSendRecord };

/**
 * The atomic exactly-once send claim. INSERT a `sending` row assigning the
 * next per-run `seq`, fenced by UNIQUE (run_id, submission_id) via
 * ON CONFLICT DO NOTHING. A fresh insert ⇒ `claimed` (proceed to send); a
 * conflict ⇒ `existing` (a retry of the same resume — the caller returns the
 * prior result or the in-flight/ambiguous state, never a second send).
 */
export async function claimTestSend(input: {
  runId: string;
  submissionId: string;
  selectedDraftIds: string[];
  recipientEmail: string | null;
  leaseSeconds: number;
}): Promise<ClaimTestSendResult> {
  const id = `arts_${randomUUID()}`;
  const res = await db.execute(sql`
    INSERT INTO ${agentRunTestSends}
      (id, run_id, submission_id, seq, status, recipient_email, selected_draft_ids, lease_expires_at)
    SELECT ${id}, ${input.runId}, ${input.submissionId},
           COALESCE((SELECT MAX(seq) FROM ${agentRunTestSends} WHERE run_id = ${input.runId}), 0) + 1,
           'sending', ${input.recipientEmail},
           ${JSON.stringify(input.selectedDraftIds)}::jsonb,
           now() + make_interval(secs => ${input.leaseSeconds})
    ON CONFLICT (run_id, submission_id) DO NOTHING
    RETURNING id
  `);
  const insertedId = (res.rows as Array<{ id: string }>)[0]?.id;
  const row = await readTestSendBySubmission(input.runId, input.submissionId);
  if (!row) {
    // Neither inserted nor found — the only explanation is a concurrent delete
    // (not an operation this store exposes). Surface loudly rather than send blind.
    throw new Error(
      `claimTestSend: claim for (${input.runId}, ${input.submissionId}) neither inserted nor found`,
    );
  }
  return insertedId ? { kind: "claimed", row } : { kind: "existing", row };
}

export type RecordPreClaimFailureResult =
  | { kind: "recorded"; row: TestSendRecord }
  | { kind: "existing"; row: TestSendRecord };

/**
 * eng#548 #1625 (F3) — record a PRE-CLAIM failure (invalid recipient, no
 * selection, campaign-access-denied, null-owner) as a terminal `failed` ledger
 * row that ALLOCATES the next per-run `seq`. The gate wires `seq` → `gateCycle`
 * (the renderer's rehydration token), so advancing it on a pre-claim failure is
 * what keeps the HITL screen from stranding: without a fresh seq the token never
 * changes and the renderer's pending state never clears.
 *
 * Because the submission id is fresh-per-gate-visit (F1), each visit's pre-claim
 * failure is a DISTINCT row → distinct seq → gateCycle advances even for repeated
 * identical failure REASONS. A `failed` row is user-correctable and NOT counted
 * toward the send cap (`readSentCountForRun` counts only `sent`), so overloading
 * `failed` for both post-send and pre-claim failures is safe; `result_json.reason`
 * distinguishes them.
 *
 * Fenced by UNIQUE (run_id, submission_id) via ON CONFLICT DO NOTHING, then it
 * reads back the WINNING row (like `claimTestSend`): a same-submission transport
 * retry returns `existing` with whatever the authoritative row is (a prior
 * `failed`/`sent`/`sending`), and the caller returns `ledgerRowToResult(row)`
 * verbatim — never synthesizing a fresh seq over a row that already settled.
 * `selected_draft_ids` is empty (nothing was planned) and `lease_expires_at` is a
 * non-null inert `now()` (the row is terminal and never reconciled).
 */
export async function recordPreClaimFailure(input: {
  runId: string;
  submissionId: string;
  recipientEmail: string | null;
  result: Record<string, unknown>;
}): Promise<RecordPreClaimFailureResult> {
  const id = `arts_${randomUUID()}`;
  const res = await db.execute(sql`
    INSERT INTO ${agentRunTestSends}
      (id, run_id, submission_id, seq, status, recipient_email, selected_draft_ids, result_json, lease_expires_at)
    SELECT ${id}, ${input.runId}, ${input.submissionId},
           COALESCE((SELECT MAX(seq) FROM ${agentRunTestSends} WHERE run_id = ${input.runId}), 0) + 1,
           'failed', ${input.recipientEmail},
           '[]'::jsonb, ${JSON.stringify(input.result)}::jsonb,
           now()
    ON CONFLICT (run_id, submission_id) DO NOTHING
    RETURNING id
  `);
  const insertedId = (res.rows as Array<{ id: string }>)[0]?.id;
  const row = await readTestSendBySubmission(input.runId, input.submissionId);
  if (!row) {
    throw new Error(
      `recordPreClaimFailure: row for (${input.runId}, ${input.submissionId}) neither inserted nor found`,
    );
  }
  return insertedId ? { kind: "recorded", row } : { kind: "existing", row };
}

/**
 * Settle a claimed row to its terminal state with the typed result. Idempotent
 * by construction — settling the same row twice writes the same terminal shape.
 * Returns the settled record, or null if the row vanished (cascade delete).
 */
export async function settleTestSend(input: {
  id: string;
  status: Extract<TestSendStatus, "sent" | "failed">;
  result: Record<string, unknown>;
}): Promise<TestSendRecord | null> {
  const [row] = await db
    .update(agentRunTestSends)
    .set({
      status:     input.status,
      resultJson: input.result,
      updatedAt:  new Date(),
    })
    .where(eq(agentRunTestSends.id, input.id))
    .returning();
  return row ? deserialize(row) : null;
}

export async function readTestSendBySubmission(
  runId: string,
  submissionId: string,
): Promise<TestSendRecord | null> {
  const [row] = await db
    .select()
    .from(agentRunTestSends)
    .where(
      and(
        eq(agentRunTestSends.runId, runId),
        eq(agentRunTestSends.submissionId, submissionId),
      ),
    );
  return row ? deserialize(row) : null;
}

/**
 * The authoritative PERFORMED-send count for a run — rows the ledger considers a
 * completed outbound send (`sent`). A `failed` row is user-correctable (does not
 * count toward the cap); a `sending` row is in-flight. parse_action compares this
 * against the template-trusted `maxGateVisits` for the halt guard (contract (3)).
 */
export async function readSentCountForRun(runId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentRunTestSends)
    .where(
      and(
        eq(agentRunTestSends.runId, runId),
        eq(agentRunTestSends.status, "sent"),
      ),
    );
  return row?.n ?? 0;
}

/** The highest per-run seq assigned so far (0 when no send claimed). */
export async function readMaxSeqForRun(runId: string): Promise<number> {
  const [row] = await db
    .select({ maxSeq: sql<number>`COALESCE(MAX(${agentRunTestSends.seq}), 0)::int` })
    .from(agentRunTestSends)
    .where(eq(agentRunTestSends.runId, runId));
  return row?.maxSeq ?? 0;
}

/** Most-recent-first ledger for a run (debug / audit / test assertions). */
export async function readTestSendsForRun(runId: string): Promise<TestSendRecord[]> {
  const rows = await db
    .select()
    .from(agentRunTestSends)
    .where(eq(agentRunTestSends.runId, runId))
    .orderBy(desc(agentRunTestSends.seq));
  return rows.map(deserialize);
}
