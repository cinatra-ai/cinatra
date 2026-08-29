import { and, eq } from "drizzle-orm";
import { db } from "./db";
import { agentRuns, agentRunOutputDerivations } from "./schema";
import { RunTransitionError } from "./run-status";
import type { AgentRunStatus } from "./run-status";
// cinatra#1939 wave 2: this terminal-success delegate now runs INSIDE
// transitionRunStatus's guarded transaction on the passed `tx` (it no longer
// opens its own). The post-commit side-effects (expireRunStream /
// dispatchRunWaitTransition) are relocated to transitionRunStatus so no
// non-transactional side-effect runs inside the guard.
import type { GuardedRunTx } from "./org-write-run-seam";

// ---------------------------------------------------------------------------
// cinatra#1893 (epic #1883 A5): the unbound-output derivation-outbox capture.
// ---------------------------------------------------------------------------
//
// Extracted from packages/agents/src/store.ts (file-size ratchet #1893), mirroring
// the ./run-status and ./agent-run-hitl-prompts seam extractions. store.ts'
// canonical `transitionRunStatus` primitive delegates the terminal-success-with-
// capture path here (its `derivationOutbox` option is unchanged for callers).
//
// The transaction-local facts a WayFlow terminal-success transition captures so
// the post-terminal pickup can run the default road WITHOUT re-reading run
// history. Deliberately carries NO registry read (produces/binding discovery is
// the pickup's concern) — it is written from purely transaction-local values
// inside the terminal tx.
//
// cinatra#3029 (item 0.17). What is captured changed: not the run's final
// RESPONSE TEXT, which is not an output and takes no road, but the FAMILY of
// end-node outputs at or above the one-kilobyte document floor that no binding
// named — each with its serialised value, its reserved ledger id and its hash.
// `selectEndNodeOutputPickupItems` (./end-node-output-pickup) builds it; this
// type is what the terminal transaction persists.
export type EndNodeOutputCapture = {
  outputId: string;
  outputName: string;
  source: "end_node_output";
  content: string;
  contentIsJson: boolean;
  contentHash: string;
  byteLength: number;
};

// cinatra#3030 (item 0.22). The FILE half of the same family, captured BY
// REFERENCE. A file's bytes never ride the outbox row: "the pickup streams the
// bytes once into the store", and the run folder is read where the pickup runs —
// which is the point of handing the pickup over through this outbox at all.
export type RunFileCapture = {
  outputId: string;
  outputName: string;
  source: "file";
  /** Path relative to the run's `outputs` folder, with `/` separators. */
  relPath: string;
  byteLength: number;
};

export type RunOutputCapture = EndNodeOutputCapture | RunFileCapture;

export type DerivationOutboxCapture = {
  orgId: string;
  templateId: string;
  /** The run's pinned semver (null for a draft/dist-tag run — the pickup then
   *  resolves the current default manifest). */
  packageVersion: string | null;
  /** The run's runBy principal — the written artifacts' createdBy. */
  createdBy: string | null;
  /** The default road's item family — end-node outputs AND emitted files. Empty
   *  ⇒ the run made no document and left no file; the pickup settles the row
   *  without writing anything. */
  items: RunOutputCapture[];
};

/**
 * Commit a WayFlow terminal-success transition (→completed) as part of the
 * caller's ONE guarded transaction: the status CAS + the final-output snapshot
 * (completedAt/stepResults/error/startedAt) in a single UPDATE, then the
 * derivation-outbox INSERT — all on the passed `tx` (cinatra#1939 wave 2: it no
 * longer opens its own `db.transaction`, so the whole thing lands inside
 * transitionRunStatus's org-locked guard). The CAS's `WHERE` is ORG-SCOPED
 * (`AND org_id = orgId`, G1 Finding F) so a mismatched-org runId returns 0 rows →
 * false having written nothing (the caller throws stale_from_status). The outbox
 * INSERT is `ON CONFLICT (run_id) DO NOTHING`, so a stop/retry re-drive that also
 * wins a (different) legal terminal edge never doubles the capture. Any INSERT/
 * UPDATE failure rolls the whole guarded transaction back — the run never lands
 * `completed` with a missing outbox row, nor vice-versa.
 */
async function commitTerminalTransitionWithOutbox(
  runId: string,
  from: AgentRunStatus,
  to: AgentRunStatus,
  meta: { error?: string; startedAt?: Date; completedAt?: Date; stepResults?: unknown[] },
  outbox: DerivationOutboxCapture,
  orgId: string,
  tx: GuardedRunTx,
): Promise<boolean> {
  const dtx = tx as unknown as typeof db;
  const updates: Partial<typeof agentRuns.$inferInsert> = { status: to };
  // ONE terminal timestamp for the whole transactional write (the caller's, or
  // now()); no divergence between the snapshot and a side-effect clock.
  updates.completedAt = meta.completedAt ?? new Date();
  if (meta.stepResults !== undefined) {
    updates.stepResults = JSON.stringify(meta.stepResults);
  }
  if (meta.error !== undefined) updates.error = meta.error;
  if (meta.startedAt !== undefined) updates.startedAt = meta.startedAt;
  const cas = await dtx
    .update(agentRuns)
    .set(updates)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, from), eq(agentRuns.orgId, orgId)))
    .returning({ id: agentRuns.id });
  if (cas.length !== 1) return false;
  await dtx
    .insert(agentRunOutputDerivations)
    .values({
      runId,
      // Use the GUARDED orgId (the lock/permit scope), not the caller-supplied
      // outbox.orgId: the org-scoped CAS above already proved the run belongs to
      // `orgId`, so that is the authoritative org for the derivation row. Keying
      // the insert off the capture's orgId would let a drifted capture write a
      // row under another org inside this org's guarded transaction (codex).
      orgId,
      templateId: outbox.templateId,
      packageVersion: outbox.packageVersion,
      createdBy: outbox.createdBy,
      // The RETIRED response-text columns stay NULL (cinatra#3029): a row
      // captured after this slice carries `items` and nothing else.
      content: null,
      contentIsJson: false,
      contentHash: null,
      items: outbox.items,
      status: "pending",
    })
    .onConflictDoNothing();
  return true;
}

/**
 * cinatra#1893 terminal-success (→completed) transition WITH derivation-outbox
 * capture — the delegated implementation of `transitionRunStatus`' `derivationOutbox`
 * branch. The caller (transitionRunStatus) has ALREADY validated the from→to edge
 * against LEGAL_TRANSITIONS AND opened the org-write kernel guard; this asserts the
 * terminal target (`to === "completed"`, so the overlay never absorbs a dispatch/
 * HITL edge) and commits the CAS + snapshot + outbox INSERT as one atomic unit on
 * the passed guarded `tx` — so the derivation candidate is captured iff (and
 * exactly when) this drive wins the terminal transition (AC1 idempotency).
 *
 * cinatra#1939 wave 2: post-commit side-effects are NO LONGER fired here — they
 * are relocated to transitionRunStatus (POST-COMMIT, after the guard returns):
 * `expireRunStream` on terminal, and — for parity with today's derivationOutbox
 * path — NO `dispatchRunWaitTransition` (this branch never notified). Keeping the
 * side-effects out of the guarded body is the codex #2/#13 invariant.
 */
export async function transitionRunToCompletedWithDerivationOutbox(
  runId: string,
  from: AgentRunStatus,
  to: AgentRunStatus,
  meta: {
    error?: string;
    startedAt?: Date;
    completedAt?: Date;
    stepResults?: unknown[];
    humanWaitGate?: boolean;
  },
  derivationOutbox: DerivationOutboxCapture,
  orgId: string,
  tx: GuardedRunTx,
  // cinatra#1940 P1 (Decision 4): the per-run lease-settle helper, THREADED from
  // transitionRunStatus (passed by reference to avoid a run-transition ⇄
  // run-terminal-derivation-outbox import cycle). Runs on THIS same guarded `tx`
  // so the CAS + outbox INSERT + lease DELETE commit as one atomic unit.
  settleLeaseInTx: (tx: GuardedRunTx, orgId: string, runId: string) => Promise<void>,
): Promise<void> {
  if (to !== "completed") {
    throw new Error(
      `transitionRunStatus: derivationOutbox is only legal for to==="completed" (got ${to})`,
    );
  }
  const won = await commitTerminalTransitionWithOutbox(runId, from, to, meta, derivationOutbox, orgId, tx);
  if (!won) {
    // Rolls back the guarded tx (fail-closed: mismatched-org or stale `from`).
    throw new RunTransitionError({ code: "stale_from_status", runId, from, to });
  }
  // cinatra#1940 P1 fold: →completed is terminal, so settle the run's lease in
  // this same guarded tx (statement order: CAS → outbox INSERT → lease DELETE).
  await settleLeaseInTx(tx, orgId, runId);
}
