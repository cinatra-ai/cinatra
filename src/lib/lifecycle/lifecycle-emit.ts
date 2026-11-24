/**
 * The local-write PRODUCED-EVENT emitter helper (cinatra#2039, epic #2037 S1).
 *
 * S0 decreed that review is driven by a durable `ArtifactProduced` event written
 * in the SAME local transaction as the artifact/representation write (same-tx
 * atomicity), from an ENUMERATED set of choke points. This module is the shared,
 * PURE builder the raw-SQL writers (`createSemanticArtifact`'s Tx2 query list, the
 * dashboards twin writer's substrate query list) splice into their existing
 * transaction: it returns a single idempotent `INSERT … ON CONFLICT (event_id) DO
 * NOTHING` op keyed by the DETERMINISTIC produced-event id, so the event row
 * commits/rolls-back atomically with the artifact and a replay is a no-op.
 *
 * SWITCHED: `maybeBuildProducedEventInsertOp` returns `null` only when the
 * review-orchestration switch is explicitly OFF
 * (`CINATRA_LIFECYCLE_REVIEW_ORCHESTRATION=off`) — the caller then splices
 * nothing and the writer's transaction is byte-for-byte the pre-flip one. In the
 * DEFAULT (unset ⇒ active, the #2047 ruling) posture it adds exactly one
 * idempotent INSERT per enumerated write.
 *
 * PURE (no DB / server-only): a `{text, values}` op is all it returns; the caller
 * owns the connection + transaction. (`producerAttemptForRun` reads only the
 * caller's request frame, never the database.) The deterministic id + emitter enumeration
 * come from the S0 contract (`lifecycle-produced-event.ts`).
 */

import {
  producedEventId,
  isProducedEventEmitter,
  type ContinuationMode,
  type ProducedEventEmitter,
  type ProducedEventKind,
} from "./lifecycle-produced-event";
import { lifecycleOriginKind, type DestinationClass } from "./lifecycle-policy";
import { isLifecycleReviewOrchestrationActive } from "./lifecycle-activation";
import type { ArtifactOriginKind } from "@cinatra-ai/artifacts";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server/request-context";

/** A raw parameterised SQL op — the shape both writers' query lists already use. */
export interface ProducedEventInsertOp {
  text: string;
  values: unknown[];
}

/**
 * cinatra#4762 — the identity of the attempt that produced the output, as the attempt itself carries it:
 *   - `{ generation }`: the run's reset_generation the run worker captured when the attempt started executing (the
 *     run's frame, `runAttempt`); recorded as is.
 *   - `{ executionAttemptId }`: a verified dispatch of the attempt (an agent-run token's attempt claim, a verified
 *     executing source); the generation is read in the insert only while that dispatch is still the run's current one,
 *     so a dispatch a retry replaced records -1.
 * `null`: no attempt identity; the event records -1, which never counts as the attempt's output.
 */
export type ProducerAttempt = { generation: number } | { executionAttemptId: string };

/**
 * cinatra#4762 — the attempt a writer's produced event belongs to, from the frame the write runs in, never from a read
 * of the run row when the writer runs (a delayed writer of an ended attempt would read the next attempt there):
 *   1. the run worker's frame for this run (`runAttempt`): the reset generation captured when the attempt started;
 *   2. a verified dispatch of this run: the executing source a run-bound seam verified, or the agent-run token's
 *      attempt claim; the insert reads the generation only while that dispatch is the run's current one;
 *   3. anything else: no attempt identity (null), recorded as -1, and no review of it ever counts.
 * Kept in this module (not a new one) so no locked route's first-party graph grows.
 */
export function producerAttemptForRun(runId: string | null | undefined): ProducerAttempt | null {
  if (!runId) return null;
  const frame = mcpRequestContextStorage.getStore();
  if (!frame) return null;
  const carried = frame.runAttempt;
  if (carried && carried.runId === runId && Number.isSafeInteger(carried.resetGeneration)) {
    return { generation: carried.resetGeneration };
  }
  const source = frame.verifiedExecutedSource?.executionAttemptId;
  if (source && (frame.verifiedRunScopeId === runId || frame.runId === runId)) return { executionAttemptId: source };
  const actor = frame.delegatedActor;
  if (actor?.delegation === "agent_run" && actor.runId === runId && actor.executionAttemptId) {
    return { executionAttemptId: actor.executionAttemptId };
  }
  return null;
}

export interface BuildProducedEventInsertInput {
  orgId: string;
  artifactId: string;
  representationRevisionId: string;
  /** Which enumerated choke point is emitting (validated — an unknown emitter
   * throws, matching the S0 contract's closed emitter set). */
  emitter: ProducedEventEmitter;
  /** The PHYSICAL origin kind at the write; mapped onto the lattice provenance
   * axis via `lifecycleOriginKind`. */
  originKind: ArtifactOriginKind;
  /** The producing run + agent (provenance; NO FK — the event outlives run churn).
   * Null for a non-run producer (e.g. a direct upload). */
  producerRunId?: string | null;
  producerAgentId?: string | null;
  /** The destination-effect class. Defaults to `none` — a plain durable local
   * write has no external effect at creation time (external publish / promotion /
   * hand-off happen on distinct later paths, which emit their own events / gates). */
  destinationClass?: DestinationClass;
  /** The continuation mode. Defaults to the STANDARD `async_effects_gated` (epic
   * decision 3); a per-flow opt-in passes `checkpointed`. */
  continuationMode?: ContinuationMode;
  eventKind?: ProducedEventKind;
  /** cinatra#4762: the producing attempt (see ProducerAttempt). Required, so every writer names it; null records -1. */
  producerAttempt: ProducerAttempt | null;
}

/**
 * Build the same-tx produced-event INSERT op for a local writer. `schema` is the
 * caller's ALREADY-ESCAPED postgres schema identifier (both writers pass their
 * local escaped `schema`). Idempotent on the deterministic `event_id` PK.
 */
export function buildProducedEventInsertOp(
  schema: string,
  input: BuildProducedEventInsertInput,
  opts?: {
    /**
     * A SQL boolean expression the insert is GUARDED on, ANDed to the
     * run-row lock in `INSERT … SELECT … WHERE <lock> AND (<guard>)`.
     *
     * Added for the object-backed contract's mint (enabler 0.13, cinatra#3028):
     * that writer's capture statement mints a revision on ONE of its two arms
     * and reuses an existing one on the other, so an unguarded same-transaction
     * emit would announce a revision the reuse arm never wrote. The guard is a
     * fragment the CALLER composes; it may reference its own literals and THIS
     * builder's own bound parameters (`$2` the organization, `$3` the artifact,
     * `$4` the representation revision) and nothing from the caller's other
     * statements. Omitted ⇒ only the run-row lock guards the insert.
     */
    whereExistsSql?: string;
  },
): ProducedEventInsertOp {
  if (!isProducedEventEmitter(input.emitter)) {
    throw new Error(`[lifecycle-emit] unknown produced-event emitter "${input.emitter}"`);
  }
  const eventKind = input.eventKind ?? "artifact_produced";
  const eventId = producedEventId(input.artifactId, input.representationRevisionId, eventKind);
  // cinatra#4762: the producing attempt's reset generation, as the attempt carries it ($12), never the run row's
  // state when the writer runs: a delayed writer of an ended attempt would read the next attempt there. A verified
  // dispatch ($13) reads it only while that dispatch is the run's current one. No run, or no attempt identity: -1. The
  // review the event later raises carries THIS value, so output of an ended attempt never counts for the next one.
  const attempt = input.producerRunId ? input.producerAttempt : null;
  const generation = attempt && "generation" in attempt && Number.isSafeInteger(attempt.generation) ? attempt.generation : null;
  const dispatch = attempt && "executionAttemptId" in attempt && typeof attempt.executionAttemptId === "string" && attempt.executionAttemptId
    ? attempt.executionAttemptId : null;
  const bound = `$1::text, $2::text, $3::text, $4::text, $5::text, $6::text,
        $7::text, $8::text, $9::text, $10::text,
        $11::text, NULL, 'pending',
        coalesce($12::integer, (SELECT live_run.reset_generation FROM "${schema}"."agent_runs" live_run
          WHERE live_run.id = $7::text AND live_run.execution_attempt_id = $13::text
            AND live_run.status IN ('running', 'pending_approval')), -1)`;
  // cinatra#4762: the insert takes the producing run's row FOR KEY SHARE and holds it until the writer's transaction
  // ends. A Publish writes its release, and the call-site check reads the review fence, under the same row FOR UPDATE
  // (publish-decision-store withRunRowLock); the two modes conflict, so this output is either committed before that
  // read (and seen there) or written after it ends. Ordinary run updates take FOR NO KEY UPDATE, which does not
  // conflict. No run named ($7 null): no row, no lock. The count is never negative: the guard only takes the lock.
  const runLock = `(SELECT count(*) FROM (SELECT 1 FROM "${schema}"."agent_runs" run_lock
          WHERE run_lock.id = $7::text FOR KEY SHARE) locked_run) >= 0`;
  return {
    text: `INSERT INTO "${schema}"."artifact_produced_outbox"
  (event_id, org_id, artifact_id, representation_revision_id, event_kind, emitter,
   producer_run_id, producer_agent_id, origin_kind, destination_class,
   continuation_mode, continuation_address, status, producer_run_generation)
SELECT ${bound}
WHERE ${runLock}${opts?.whereExistsSql ? ` AND (${opts.whereExistsSql})` : ""}
ON CONFLICT (event_id) DO NOTHING`,
    values: [
      eventId,
      input.orgId,
      input.artifactId,
      input.representationRevisionId,
      eventKind,
      input.emitter,
      input.producerRunId ?? null,
      input.producerAgentId ?? null,
      lifecycleOriginKind(input.originKind),
      input.destinationClass ?? "none",
      input.continuationMode ?? "async_effects_gated",
      generation,
      dispatch,
    ],
  };
}

/**
 * SWITCHED variant: the produced-event INSERT op when S1 review orchestration is
 * active (the DEFAULT), else `null`. The write choke points splice
 * `...(op ? [op] : [])`, so an explicit opt-out leaves the writer's transaction
 * byte-identical to the pre-flip one.
 */
export function maybeBuildProducedEventInsertOp(
  schema: string,
  input: BuildProducedEventInsertInput,
  opts?: { whereExistsSql?: string },
): ProducedEventInsertOp | null {
  if (!isLifecycleReviewOrchestrationActive()) return null;
  return buildProducedEventInsertOp(schema, input, opts);
}
