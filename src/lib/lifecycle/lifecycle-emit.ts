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
 * owns the connection + transaction. The deterministic id + emitter enumeration
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

/** A raw parameterised SQL op — the shape both writers' query lists already use. */
export interface ProducedEventInsertOp {
  text: string;
  values: unknown[];
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
  /** The PRODUCING EXTENSION and its PINNED VERSION, beside the run
   *  (cinatra#3029, plan §8.2: the produced event "gains the producing
   *  extension and its pinned version beside the run, for a mid-run write made
   *  by an embedded agent: the datum the repair road of the sibling plan
   *  reads"). Omitted ⇒ NULL — an emitter that cannot name one records nothing
   *  rather than a guess. */
  producingExtension?: string | null;
  producingExtensionVersion?: string | null;
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
     * A SQL boolean expression the insert is GUARDED on — the op becomes
     * `INSERT … SELECT … WHERE <guard>` instead of `INSERT … VALUES …`.
     *
     * Added for the object-backed contract's mint (enabler 0.13, cinatra#3028):
     * that writer's capture statement mints a revision on ONE of its two arms
     * and reuses an existing one on the other, so an unguarded same-transaction
     * emit would announce a revision the reuse arm never wrote. The guard is a
     * fragment the CALLER composes; it may reference its own literals and THIS
     * builder's own bound parameters (`$2` the organization, `$3` the artifact,
     * `$4` the representation revision) and nothing from the caller's other
     * statements. Omitted ⇒ the plain VALUES insert every existing choke point
     * already splices, byte-identical.
     */
    whereExistsSql?: string;
  },
): ProducedEventInsertOp {
  if (!isProducedEventEmitter(input.emitter)) {
    throw new Error(`[lifecycle-emit] unknown produced-event emitter "${input.emitter}"`);
  }
  const eventKind = input.eventKind ?? "artifact_produced";
  const eventId = producedEventId(input.artifactId, input.representationRevisionId, eventKind);
  const bound = `$1::text, $2::text, $3::text, $4::text, $5::text, $6::text,
        $7::text, $8::text, $9::text, $10::text,
        $11::text, NULL, 'pending',
        $12::text, $13::text`;
  return {
    text: `INSERT INTO "${schema}"."artifact_produced_outbox"
  (event_id, org_id, artifact_id, representation_revision_id, event_kind, emitter,
   producer_run_id, producer_agent_id, origin_kind, destination_class,
   continuation_mode, continuation_address, status,
   producing_extension, producing_extension_version)
${opts?.whereExistsSql ? `SELECT ${bound}\nWHERE ${opts.whereExistsSql}` : `VALUES (${bound})`}
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
      input.producingExtension ?? null,
      input.producingExtensionVersion ?? null,
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
