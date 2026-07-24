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
 * FENCED: `maybeBuildProducedEventInsertOp` returns `null` when the S1 activation
 * fence is OFF (the default) — the caller then splices nothing, so `origin/main`
 * writers are byte-for-byte unchanged. Flipping the fence on adds exactly one
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
}

/**
 * Build the same-tx produced-event INSERT op for a local writer. `schema` is the
 * caller's ALREADY-ESCAPED postgres schema identifier (both writers pass their
 * local escaped `schema`). Idempotent on the deterministic `event_id` PK.
 */
export function buildProducedEventInsertOp(
  schema: string,
  input: BuildProducedEventInsertInput,
): ProducedEventInsertOp {
  if (!isProducedEventEmitter(input.emitter)) {
    throw new Error(`[lifecycle-emit] unknown produced-event emitter "${input.emitter}"`);
  }
  const eventKind = input.eventKind ?? "artifact_produced";
  const eventId = producedEventId(input.artifactId, input.representationRevisionId, eventKind);
  return {
    text: `INSERT INTO "${schema}"."artifact_produced_outbox"
  (event_id, org_id, artifact_id, representation_revision_id, event_kind, emitter,
   producer_run_id, producer_agent_id, origin_kind, destination_class,
   continuation_mode, continuation_address, status)
VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text,
        $7::text, $8::text, $9::text, $10::text,
        $11::text, NULL, 'pending')
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
    ],
  };
}

/**
 * FENCED variant: the produced-event INSERT op when S1 review orchestration is
 * active, else `null`. The write choke points splice `...(op ? [op] : [])`, so an
 * inactive fence leaves the writer's transaction byte-identical to `origin/main`.
 */
export function maybeBuildProducedEventInsertOp(
  schema: string,
  input: BuildProducedEventInsertInput,
): ProducedEventInsertOp | null {
  if (!isLifecycleReviewOrchestrationActive()) return null;
  return buildProducedEventInsertOp(schema, input);
}
