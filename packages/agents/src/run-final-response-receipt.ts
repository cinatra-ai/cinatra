// ---------------------------------------------------------------------------
// The run's TRANSCRIPT RECEIPT for a run executed on the agent runtime
// (cinatra#3002).
//
// THE DEFECT THIS MODULE CLOSES. A run that executes on the agent runtime
// finished `completed` and its page showed nothing: the completion card said
// "its output is in the run transcript below" and below it there was no
// transcript at all. The two sides had never agreed on what proves output.
//
//   The CARD derived its pointer from the run's INTENT — the completion
//   transition writes one `wayflow_response` entry into `agent_runs.step_results`,
//   and the card's evidence read counted that as proof that output is rendered
//   below.
//
//   The WRITER was never run on this path. The transcript the page renders is
//   `agent_run_messages` (`appendAgentRunMessage`), and the runtime completion
//   path never called it: the response reached a reader ONLY as ephemeral AG-UI
//   `TEXT_MESSAGE_*` frames (gone the moment the stream ends — nothing persists
//   them for this path; `agent_runs.streamed_text` is written by the external
//   peer proxy alone) and as the step-results JSON, which no screen renders.
//
// So a reader watching live saw the text stream past, and the same reader on
// reload saw an empty page under a card that named a transcript. This module is
// the missing writer: the runtime's final response is persisted as the run's own
// `final` transcript message, which is exactly the row the app-side writer would
// have written and exactly the row the run page reads.
//
// It is its own module rather than another function in `store.ts` because that
// hub is at its size ceiling (a thin vertical slice is the house pattern for
// this, see `agent-run-serde.ts`), and because the receipt is one concern:
// write the run's produced text where the run page reads it, once.
// ---------------------------------------------------------------------------

import { eq, and, max } from "drizzle-orm";

import { db } from "./db";
import { agentRunMessages } from "./schema";
import { appendAgentRunMessage, type AgentRunMessageRecord } from "./store";

/**
 * How many times a sequence collision is retried.
 *
 * `agent_run_messages` is unique over (run_id, sequence) and carries a SECOND
 * use — the run-window conversation rows — whose writer takes numbers from the
 * same space. A concurrent window turn can therefore take the number this write
 * just read, exactly as that writer's own retry loop anticipates. Re-read and
 * try again a bounded number of times rather than fail a run's receipt over a
 * lost race.
 */
export const RUN_FINAL_RESPONSE_SEQUENCE_ATTEMPTS = 5;

/**
 * Persist a terminal run's produced text as the run's `final` transcript
 * message — the receipt the run page renders.
 *
 * Returns the written record, or `null` when there is nothing to write (empty
 * text) or the receipt already exists. IDEMPOTENT by that second check: the
 * terminal handler can be re-entered (a redelivered task state, a retried
 * completion) and a run must not grow a second copy of its own answer.
 *
 * Callers treat a throw as non-fatal: a run that genuinely produced output must
 * not FAIL because its receipt could not be written. Without the receipt the
 * card simply reads the absence honestly (`run-status.ts` no longer lets step
 * results stand in for a transcript), which is the whole point of the pair.
 */
export async function recordRunFinalResponseMessage(input: {
  runId: string;
  text: string;
}): Promise<AgentRunMessageRecord | null> {
  if (!input.runId) throw new Error("recordRunFinalResponseMessage: runId is required");
  if (input.text.length === 0) return null;

  if (await hasFinalMessage(input.runId)) return null;

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < RUN_FINAL_RESPONSE_SEQUENCE_ATTEMPTS; attempt += 1) {
    // The high-water mark is read across the WHOLE run, window rows included:
    // the unique index is over (run_id, sequence) and does not care which use a
    // row belongs to.
    const [{ highWater } = { highWater: null }] = await db
      .select({ highWater: max(agentRunMessages.sequence) })
      .from(agentRunMessages)
      .where(eq(agentRunMessages.runId, input.runId));
    try {
      return await appendAgentRunMessage({
        runId: input.runId,
        sequence: (highWater ?? 0) + 1,
        body: { messageType: "final", role: "assistant", text: input.text },
      });
    } catch (err) {
      lastErr = err;
      if (!isUniqueViolation(err)) throw err;
      // Another writer took this number. Two writers can be racing here, and
      // they are not the same kind of race: a run-window turn simply took the
      // next sequence (retry with a fresh high-water mark), or a REDELIVERED
      // terminal state ran this same writer concurrently — in which case the
      // receipt now exists and a retry would append the run's own answer a
      // SECOND time. The check before the loop cannot see a row written after
      // it ran, so re-read it on every collision: that is what makes this
      // writer idempotent under concurrency rather than only under sequence.
      if (await hasFinalMessage(input.runId)) return null;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("recordRunFinalResponseMessage: could not claim a sequence number");
}

/** Does this run already carry its `final` transcript row? */
async function hasFinalMessage(runId: string): Promise<boolean> {
  const existing = await db
    .select({ id: agentRunMessages.id })
    .from(agentRunMessages)
    .where(
      and(eq(agentRunMessages.runId, runId), eq(agentRunMessages.messageType, "final")),
    )
    .limit(1);
  return existing.length > 0;
}

/**
 * Postgres unique-violation SQLSTATE, as the sibling writer on this same table
 * detects it (`run-window-conversation-store.ts`): node-postgres puts the
 * SQLSTATE on `code`, and drizzle re-throws the driver error sometimes WRAPPED,
 * with the original on `cause`. Reading only `code` misclassifies the wrapped
 * form as non-retryable, and the fail-soft caller then completes the run with
 * no receipt at all — the original blank-page defect, restored by a lost race.
 */
function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "23505") return true;
  const cause = (err as { cause?: unknown } | null)?.cause;
  return (cause as { code?: unknown } | null)?.code === "23505";
}
