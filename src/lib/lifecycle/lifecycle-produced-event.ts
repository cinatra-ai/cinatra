/**
 * The transactional `ArtifactProduced` EVENT contract (cinatra#2038, epic #2037
 * S0).
 *
 * Review is driven by a durable PRODUCED EVENT with ENUMERATED emitters, not by a
 * writer hook — because the local artifact write happens across several distinct
 * choke points (the file-form `createSemanticArtifact`, the dashboard twin
 * writer's own transaction, and object/CMS snapshot capture) and `objects_save`
 * / remote CMS writes sit outside any single one. Each emitter writes an event
 * row in the SAME local transaction as its artifact/representation write
 * (same-transaction atomicity), keyed by a DETERMINISTIC event id so a replay is
 * idempotent and a reconciliation sweeper can detect a suppressed emit.
 *
 * S0 lands the contract + the deterministic id + the emitter enumeration; S1
 * wires the actual emitters at each choke point.
 *
 * PURE (no DB): the id derivation + validation are a total function; the store
 * (same-tx insert, claim, sweeper) lives in
 * `packages/agents/src/lifecycle-produced-outbox-store.ts`.
 */

import { createHash } from "node:crypto";

import type {
  DestinationClass,
  LifecycleOriginKind,
} from "./lifecycle-policy";

// ---------------------------------------------------------------------------
// Event kind + emitters.
// ---------------------------------------------------------------------------

/** The event kind. One kind today; the id derivation includes it so a future
 * kind on the same artifact revision never collides. */
export type ProducedEventKind = "artifact_produced";

export const PRODUCED_EVENT_KINDS: readonly ProducedEventKind[] = ["artifact_produced"] as const;

/**
 * The ENUMERATED set of emitters. A produced event may ONLY originate from one of
 * these local write choke points — the closed set is the audit surface the S1
 * wiring and the reconciliation sweeper reason over. A row carrying any other
 * emitter is an invariant violation.
 */
export type ProducedEventEmitter =
  | "createSemanticArtifact"
  | "dashboard_twin_writer"
  | "object_cms_snapshot_capture";

export const PRODUCED_EVENT_EMITTERS: readonly ProducedEventEmitter[] = [
  "createSemanticArtifact",
  "dashboard_twin_writer",
  "object_cms_snapshot_capture",
] as const;

const EMITTER_SET: ReadonlySet<string> = new Set(PRODUCED_EVENT_EMITTERS);

export function isProducedEventEmitter(v: string): v is ProducedEventEmitter {
  return EMITTER_SET.has(v);
}

// ---------------------------------------------------------------------------
// Continuation mode + address (the S1 continuation contract's row-side half).
// ---------------------------------------------------------------------------

/**
 * Two continuation modes, carried on the event row:
 *   `checkpointed` — evaluate-then-park: the producing run parks at the
 *     checkpoint and is resumed by a decision/bypass/sweeper (per-flow opt-in).
 *   `async_effects_gated` — the run never pauses retroactively; the artifact's
 *     downstream EFFECTS are held until the decision (the standard mode).
 */
export type ContinuationMode = "checkpointed" | "async_effects_gated";

export const CONTINUATION_MODES: readonly ContinuationMode[] = [
  "checkpointed",
  "async_effects_gated",
] as const;

// ---------------------------------------------------------------------------
// The event.
// ---------------------------------------------------------------------------

/** The immutable identity of the produced artifact revision the event is about —
 * exactly the review target's shape (so the produced event and the review gate
 * key agree). */
export interface ProducedArtifactRef {
  artifactId: string;
  representationRevisionId: string;
}

/**
 * The `ArtifactProduced` event. `eventId` is DETERMINISTIC (see
 * `producedEventId`) — the gate key `(artifactId, representationRevisionId,
 * eventKind)` — so a re-emit under replay lands on the same row (idempotent) and
 * the sweeper can look for the exact id it expects.
 */
export interface ArtifactProducedEvent {
  eventId: string;
  orgId: string;
  artifactId: string;
  representationRevisionId: string;
  eventKind: ProducedEventKind;
  emitter: ProducedEventEmitter;
  /** The producing run + agent (provenance; deliberately NO FK — the event
   * outlives run-row churn, the review-gate precedent). Null for a non-run
   * (e.g. direct upload) producer. */
  producerRunId: string | null;
  producerAgentId: string | null;
  originKind: LifecycleOriginKind;
  destinationClass: DestinationClass;
  continuationMode: ContinuationMode;
  /** The park/effect-gate address the continuation resumes/releases against.
   * Null until S1 assigns one. */
  continuationAddress: string | null;
}

/**
 * The DETERMINISTIC event id = a sha256 over the gate key `(artifactId,
 * representationRevisionId, eventKind)`. Uses a NUL separator; artifact/revision
 * ids are opaque store ids that never contain NUL, so the join is injective. The
 * same tuple always hashes to the same id, which is exactly what makes:
 *   - the outbox insert idempotent under replay (PK conflict → no-op), and
 *   - the sweeper's "is the event for THIS produced revision present?" check a
 *     single deterministic lookup.
 */
export function producedEventId(
  artifactId: string,
  representationRevisionId: string,
  eventKind: ProducedEventKind = "artifact_produced",
): string {
  const material = `${artifactId}\u0000${representationRevisionId}\u0000${eventKind}`;
  return createHash("sha256").update(material).digest("hex");
}

export type ValidateProducedEventResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Validate a candidate event: non-empty ids, a recognized emitter, and — the
 * load-bearing invariant — the `eventId` MUST equal the deterministic id derived
 * from its own `(artifactId, representationRevisionId, eventKind)`. A row whose
 * id was not derived this way could not be found by the sweeper and could smuggle
 * a duplicate past the PK, so it is rejected at the contract boundary.
 */
export function validateProducedEvent(event: ArtifactProducedEvent): ValidateProducedEventResult {
  if (!event.orgId) return { ok: false, error: "orgId is required" };
  if (!event.artifactId) return { ok: false, error: "artifactId is required" };
  if (!event.representationRevisionId) {
    return { ok: false, error: "representationRevisionId is required" };
  }
  if (!isProducedEventEmitter(event.emitter)) {
    return { ok: false, error: `unknown emitter "${event.emitter}"` };
  }
  const expected = producedEventId(
    event.artifactId,
    event.representationRevisionId,
    event.eventKind,
  );
  if (event.eventId !== expected) {
    return {
      ok: false,
      error: "eventId is not the deterministic id of its own (artifactId, representationRevisionId, eventKind)",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Reconciliation sweeper (pure half).
// ---------------------------------------------------------------------------

/** A witness that an artifact revision SHOULD have emitted a produced event — a
 * committed local artifact/representation the sweeper checks the outbox for. */
export interface ExpectedEmit {
  artifactId: string;
  representationRevisionId: string;
  eventKind?: ProducedEventKind;
}

/**
 * Given the set of expected emits (durable witnesses of committed local writes)
 * and the set of event ids ACTUALLY present in the outbox, return the expected
 * emits whose event is MISSING — a SUPPRESSED emit (a writer committed the
 * artifact but its same-tx event row was somehow absent). The reconciliation
 * store re-emits these; this pure core is the detection. Order-stable in the
 * input.
 */
export function reconcileProducedEvents(
  expected: readonly ExpectedEmit[],
  presentEventIds: ReadonlySet<string>,
): ExpectedEmit[] {
  const missing: ExpectedEmit[] = [];
  for (const e of expected) {
    const id = producedEventId(e.artifactId, e.representationRevisionId, e.eventKind ?? "artifact_produced");
    if (!presentEventIds.has(id)) missing.push(e);
  }
  return missing;
}
