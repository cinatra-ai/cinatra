import { and, eq } from "drizzle-orm";
import { expireRunStream } from "@cinatra-ai/a2a";
import { db } from "./db";
import { agentRuns, agentRunOutputDerivations } from "./schema";
import { TERMINAL_RUN_STATUSES, RunTransitionError } from "./run-status";
import type { AgentRunStatus } from "./run-status";
import { dispatchRunWaitTransition } from "./run-wait-notifier"; // #1559/E9: zero-dep leaf seam

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
// the post-terminal derivation job can type the run's final output against the
// agent's validated `produces` WITHOUT re-reading run history. Deliberately
// carries NO registry read (produces/binding discovery is the job's concern) —
// it is written from purely transaction-local values inside the terminal tx.
export type DerivationOutboxCapture = {
  orgId: string;
  templateId: string;
  /** The run's pinned semver (null for a draft/dist-tag run — the job then
   *  resolves the current default manifest). */
  packageVersion: string | null;
  /** The run's runBy principal — the derived artifact's createdBy + the advisory
   *  notification recipient. */
  createdBy: string | null;
  /** The captured final-output snapshot (last-agent-message text, or its JSON
   *  serialization). */
  content: string;
  /** Whether `content` parsed as JSON (drives the derived artifact's MIME). */
  contentIsJson: boolean;
  /** sha256(content) — the `derived_output` ledger dedupe component. */
  contentHash: string;
};

/**
 * Commit a WayFlow terminal-success transition (→completed) as ONE transaction:
 * the status CAS + the final-output snapshot (completedAt/stepResults/error/
 * startedAt) in a single guarded UPDATE, then the derivation-outbox INSERT. The
 * CAS's `WHERE status = from` predicate is the win condition; a 0-row CAS returns
 * false having written nothing (the caller throws stale_from_status). The outbox
 * INSERT is `ON CONFLICT (run_id) DO NOTHING`, so a stop/retry re-drive that also
 * wins a (different) legal terminal edge never doubles the capture. Any INSERT/
 * UPDATE failure rolls the whole transaction back — the run never lands
 * `completed` with a missing outbox row, nor vice-versa.
 */
async function commitTerminalTransitionWithOutbox(
  runId: string,
  from: AgentRunStatus,
  to: AgentRunStatus,
  meta: { error?: string; startedAt?: Date; completedAt?: Date; stepResults?: unknown[] },
  outbox: DerivationOutboxCapture,
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const updates: Partial<typeof agentRuns.$inferInsert> = { status: to };
    // ONE terminal timestamp for the whole transactional write (the caller's, or
    // now()); no divergence between the snapshot and a side-effect clock.
    updates.completedAt = meta.completedAt ?? new Date();
    if (meta.stepResults !== undefined) {
      updates.stepResults = JSON.stringify(meta.stepResults);
    }
    if (meta.error !== undefined) updates.error = meta.error;
    if (meta.startedAt !== undefined) updates.startedAt = meta.startedAt;
    const cas = await tx
      .update(agentRuns)
      .set(updates)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, from)))
      .returning({ id: agentRuns.id });
    if (cas.length !== 1) return false;
    await tx
      .insert(agentRunOutputDerivations)
      .values({
        runId,
        orgId: outbox.orgId,
        templateId: outbox.templateId,
        packageVersion: outbox.packageVersion,
        createdBy: outbox.createdBy,
        content: outbox.content,
        contentIsJson: outbox.contentIsJson,
        contentHash: outbox.contentHash,
        status: "pending",
      })
      .onConflictDoNothing();
    return true;
  });
}

/**
 * cinatra#1893 terminal-success (→completed) transition WITH derivation-outbox
 * capture — the delegated implementation of `transitionRunStatus`' `derivationOutbox`
 * branch. The caller (transitionRunStatus) has ALREADY validated the from→to edge
 * against LEGAL_TRANSITIONS; this asserts the terminal target (`to === "completed"`,
 * so the overlay never absorbs a dispatch/HITL edge), commits the CAS + snapshot +
 * outbox INSERT as one atomic unit — so the derivation candidate is captured iff
 * (and exactly when) this drive wins the terminal transition (AC1 idempotency) —
 * then fires the post-commit side-effects (identical posture to the two-write path).
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
): Promise<void> {
  if (to !== "completed") {
    throw new Error(
      `transitionRunStatus: derivationOutbox is only legal for to==="completed" (got ${to})`,
    );
  }
  const won = await commitTerminalTransitionWithOutbox(runId, from, to, meta, derivationOutbox);
  if (!won) {
    throw new RunTransitionError({ code: "stale_from_status", runId, from, to });
  }
  // Side-effects fire AFTER the commit (identical posture to the two-write path):
  // the Redis TTL sweep is best-effort, and the run-wait notify runs even if the
  // TTL schedule throws.
  try {
    if (TERMINAL_RUN_STATUSES.has(to)) {
      void expireRunStream(runId).catch(() => {
        /* best-effort */
      });
    }
  } finally {
    await dispatchRunWaitTransition({
      runId,
      from,
      to,
      humanWaitGate: meta.humanWaitGate === true,
    });
  }
}
