/**
 * The local-write PRODUCED-EVENT emitter helper (cinatra#2039, epic #2037 S1).
 *
 * S0 decreed that review is driven by a durable `ArtifactProduced` event written
 * in the SAME local transaction as the artifact/representation write (same-tx
 * atomicity), from an ENUMERATED set of choke points. This module is the shared,
 * PURE builder the raw-SQL writers (`createSemanticArtifact`'s Tx2 query list, the
 * dashboards twin writer's substrate query list) splice into their existing
 * transaction: it returns a single idempotent `INSERT … ON CONFLICT (event_id)`
 * op keyed by the DETERMINISTIC produced-event id, so the event row
 * commits/rolls-back atomically with the artifact and a replay is a no-op (a
 * newer attempt of the same run only records itself, cinatra#4762).
 *
 * SWITCHED: `maybeBuildProducedEventInsertOp` returns `null` only when the
 * review-orchestration switch is explicitly OFF
 * (`CINATRA_LIFECYCLE_REVIEW_ORCHESTRATION=off`) — the caller then splices
 * nothing and the writer's transaction is byte-for-byte the pre-flip one. In the
 * DEFAULT (unset ⇒ active, the #2047 ruling) posture it adds exactly one
 * idempotent INSERT per enumerated write.
 *
 * PURE (no DB / server-only): a `{text, values}` op is all it returns; the caller
 * owns the connection + transaction. (`producerAttemptForRun` and the builder's
 * own publishing-call claim, `publishCallClaimForRun`, read only the caller's
 * request frame, never the database.) The deterministic id + emitter enumeration
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

/**
 * cinatra#4762 — the in-flight fence's abort. The produced-event insert casts this text to integer while a publishing
 * call of the run holds its decision, so Postgres raises SQLSTATE 22P02 with the message
 * `invalid input syntax for type integer: "<this text>"`: an error no other statement of a writer raises, so it is
 * never read as a division by zero (an unknown base, a lost compare-and-set) or as any other refusal.
 */
export const PUBLISH_CALL_IN_FLIGHT_SENTINEL = "cinatra_publish_call_in_flight";
const PUBLISH_CALL_IN_FLIGHT_MESSAGE = `invalid input syntax for type integer: "${PUBLISH_CALL_IN_FLIGHT_SENTINEL}"`;

/** cinatra#4762 — the code of the refusal, as the review store's own in-flight refusal carries it. */
export const PUBLISH_CALL_IN_FLIGHT_CODE = "publish_call_in_flight";

/**
 * cinatra#4762 — a write of the run's output refused because a publishing call of the run's current attempt is in
 * flight. Temporary: the same write succeeds once the call has ended. Nothing of the write was committed.
 */
export class PublishCallInFlightError extends Error {
  readonly code = PUBLISH_CALL_IN_FLIGHT_CODE;
  readonly retryable = true;
  constructor() {
    super("A publishing call of this run is in flight; the write is refused until it ends. Try again.");
    this.name = "PublishCallInFlightError";
  }
}

/**
 * cinatra#4762 — whether `error` is the in-flight fence's abort: the typed error, an error carrying its code, or the
 * database error the fence raises (22P02 with the fence's own message; the code may be lost by a bridge that keeps
 * the message). Causes are followed.
 */
export function isPublishCallInFlightAbort(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let e = error; e && typeof e === "object" && !seen.has(e); e = (e as { cause?: unknown }).cause) {
    seen.add(e);
    if (e instanceof PublishCallInFlightError) return true;
    const { code, message } = e as { code?: unknown; message?: unknown };
    if (code === PUBLISH_CALL_IN_FLIGHT_CODE) return true;
    if ((code === undefined || code === "22P02") && typeof message === "string" && message.includes(PUBLISH_CALL_IN_FLIGHT_MESSAGE)) {
      return true;
    }
  }
  return false;
}

/** cinatra#4762 — the error a writer rethrows: the typed in-flight refusal for the fence's abort, else `error` itself. */
export function publishCallInFlightOr(error: unknown): unknown {
  return isPublishCallInFlightAbort(error) && !(error instanceof PublishCallInFlightError) ? new PublishCallInFlightError() : error;
}

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
 * cinatra#4762 — the publishing call claim a write of `runId` runs under: the released decision the passthrough route's
 * call check claimed for the call whose frame the write runs in (`publishCallClaim`, written only by that route from the
 * claim the server took). Null with no frame, no claim, or a claim of another run. The produced event passes the
 * in-flight fence of exactly this claim: the call's own output is what the call publishes, while every other claim of
 * the run still refuses it, and so does every claim for a write that runs under none.
 */
export function publishCallClaimForRun(runId: string | null | undefined): string | null {
  if (!runId) return null;
  const claim = mcpRequestContextStorage.getStore()?.publishCallClaim;
  return claim && claim.runId === runId && typeof claim.decisionId === "string" && claim.decisionId ? claim.decisionId : null;
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
  // (publish-decision-store withRunRowLock); the two modes conflict. A writer whose artifact rows precede this insert
  // takes the same lock before its first write (producerRunLockOps), so its output is either committed before that
  // read (and seen there) or begun after it ends; this insert's own lock covers a writer that writes nothing before
  // it. Ordinary run updates take FOR NO KEY UPDATE, which does not conflict. No run named ($7 null): no row, no lock.
  // The count is never negative: the guard only takes the lock.
  // cinatra#4762: a replay writes nothing (the event id names the artifact revision). A NEWER attempt of the same run
  // that writes the same revision again (a retry that reproduced identical bytes) records itself as the event's
  // attempt; nothing else of the event changes. A review raised for an earlier attempt of exactly that revision then
  // counts for the newer attempt too (artifact-review-gate-store listReviewLineageForRun, reproducedGeneration): a
  // person approved exactly these bytes. An event with no generation keeps it; a writer of no attempt (-1) restamps nothing.
  const runLock = `(SELECT count(*) FROM (SELECT 1 FROM "${schema}"."agent_runs" run_lock
          WHERE run_lock.id = $7::text FOR KEY SHARE) locked_run) >= 0`;
  // cinatra#4762: no output of the run while a publishing call of its current attempt holds its released decision
  // (publish-decision-store claimPublishCall): that call read the review fence without this output, so the cast of the
  // fence's sentinel (PUBLISH_CALL_IN_FLIGHT_SENTINEL) aborts the writer's whole transaction with an error of its own,
  // which each writer surfaces as PublishCallInFlightError. The writer took the run row before its first write
  // (producerRunLockOps), in an earlier statement, so this read sees every claim committed before that lock.
  // The claim the write itself runs under ($14, publishCallClaimForRun: the server's claim, carried in the call's frame)
  // is not counted: that call's own output is what it publishes. A write under no claim ($14 null) counts every claim.
  const ownClaim = input.producerRunId ? publishCallClaimForRun(input.producerRunId) : null;
  const noPublishCall = `(CASE WHEN EXISTS (SELECT 1 FROM "${schema}"."agent_run_publish_decisions" call_claim
          JOIN "${schema}"."agent_runs" claim_run ON claim_run.id = call_claim.run_id
          WHERE call_claim.run_id = $7::text AND call_claim.calls_in_flight > 0
            AND coalesce(call_claim.run_generation, claim_run.reset_generation) = claim_run.reset_generation
            AND call_claim.id IS DISTINCT FROM $14::text)
        THEN '${PUBLISH_CALL_IN_FLIGHT_SENTINEL}' ELSE '1' END)::integer = 1`;
  return {
    text: `INSERT INTO "${schema}"."artifact_produced_outbox"
  (event_id, org_id, artifact_id, representation_revision_id, event_kind, emitter,
   producer_run_id, producer_agent_id, origin_kind, destination_class,
   continuation_mode, continuation_address, status, producer_run_generation)
SELECT ${bound}
WHERE ${runLock} AND ${noPublishCall}${opts?.whereExistsSql ? ` AND (${opts.whereExistsSql})` : ""}
ON CONFLICT (event_id) DO UPDATE SET producer_run_generation = EXCLUDED.producer_run_generation
WHERE "${schema}"."artifact_produced_outbox".producer_run_id = EXCLUDED.producer_run_id
  AND "${schema}"."artifact_produced_outbox".org_id = EXCLUDED.org_id
  AND "${schema}"."artifact_produced_outbox".producer_run_generation IS NOT NULL
  AND EXCLUDED.producer_run_generation >= 0
  AND EXCLUDED.producer_run_generation > "${schema}"."artifact_produced_outbox".producer_run_generation`,
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
      ownClaim,
    ],
  };
}

/**
 * cinatra#4762 — the ops a writer runs BEFORE its first write when it splices `eventOp`: the producing run's row FOR
 * KEY SHARE, held until the writer's transaction ends. The event insert takes the same lock, but it runs LAST, after
 * the writer's artifact rows; without this op a Publish's locked fence read (FOR UPDATE, publish-decision-store
 * withRunRowLock) could run while those rows are already written and see no event. With it, an output whose rows have
 * begun is committed before that read (and seen there), or that read ran before its first write.
 * `[]` when no event op is spliced (CINATRA_LIFECYCLE_REVIEW_ORCHESTRATION=off: the transaction stays the pre-flip
 * one, as the event is) or no run is named (no row to lock). KEY SHARE conflicts only with FOR UPDATE: ordinary run
 * updates (FOR NO KEY UPDATE) and other writers of the run (KEY SHARE) never wait on it.
 */
export function producerRunLockOps(
  schema: string,
  producerRunId: string | null | undefined,
  eventOp: ProducedEventInsertOp | null,
): ProducedEventInsertOp[] {
  if (!eventOp || !producerRunId) return [];
  return [runRowKeyShareOp(schema, producerRunId)];
}

/**
 * cinatra#4762 — the same lock for a writer that takes it before it has built its event (a dashboards content
 * writer, whose twin builds the event after the dashboards rows): the lock when the review orchestration is active
 * (the event will be spliced) and a run is named, else `[]`, as `producerRunLockOps`.
 */
export function producerRunLockOpsBeforeEvent(
  schema: string,
  producerRunId: string | null | undefined,
): ProducedEventInsertOp[] {
  if (!isLifecycleReviewOrchestrationActive() || !producerRunId) return [];
  return [runRowKeyShareOp(schema, producerRunId)];
}

function runRowKeyShareOp(schema: string, producerRunId: string): ProducedEventInsertOp {
  return { text: `SELECT 1 FROM "${schema}"."agent_runs" WHERE id = $1::text FOR KEY SHARE`, values: [producerRunId] };
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
