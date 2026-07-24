import "server-only";

// ---------------------------------------------------------------------------
// lifecycle-produced-outbox-store (cinatra#2038, epic #2037 S0)
//
// The persistence half of the transactional `ArtifactProduced` outbox. The
// EMIT is written in the CALLER's transaction (same-tx atomicity — pass the
// caller's `tx`), keyed by the DETERMINISTIC `event_id` (sha256 of the gate key)
// so a replay is idempotent (PK conflict → no-op) and the reconciliation sweeper
// finds the exact id it expects.
//
// S0 lands emit / read / mark-processed + the DETECTION half of the sweeper
// (`findMissedProducedEmits`). S1 wires the emitters at each choke point and the
// backfill (which needs the emitter context the witness alone lacks).
// ---------------------------------------------------------------------------

import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "./db";
import { artifactProducedOutbox } from "./schema";
import {
  producedEventId,
  reconcileProducedEvents,
  validateProducedEvent,
  type ArtifactProducedEvent,
  type ExpectedEmit,
  type ProducedEventKind,
} from "@/lib/lifecycle/lifecycle-produced-event";

/** The caller's transaction handle (or the base db) — so an emit rides the local
 * artifact write's own transaction. */
type TxExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | TxExecutor;

export class ProducedEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProducedEventError";
  }
}

export interface EmitProducedResult {
  eventId: string;
  /** True when THIS call inserted the row; false when the deterministic id
   * already existed (idempotent replay). */
  inserted: boolean;
}

/**
 * Emit an `ArtifactProduced` event. The executor is REQUIRED — pass the CALLER's
 * transaction (`tx`) so the event row commits/rolls-back ATOMICALLY with the local
 * artifact/representation write (the same-transaction atomicity invariant), or
 * pass the base `db` for a deliberate standalone/reconciliation emit. It is NOT
 * defaulted: a default `db` would let a caller inside a transaction silently emit
 * an INDEPENDENTLY-committed event that survives a later rollback of its artifact.
 * Idempotent on the deterministic `event_id` PK: a re-emit under replay is a no-op
 * (`inserted: false`), never a duplicate.
 *
 * The event is validated FIRST — a row whose `eventId` is not the deterministic
 * id of its own tuple is rejected (it could not be found by the sweeper).
 */
export async function emitArtifactProduced(
  event: ArtifactProducedEvent,
  exec: Executor,
): Promise<EmitProducedResult> {
  const valid = validateProducedEvent(event);
  if (!valid.ok) throw new ProducedEventError(valid.error);

  const inserted = await exec
    .insert(artifactProducedOutbox)
    .values({
      eventId: event.eventId,
      orgId: event.orgId,
      artifactId: event.artifactId,
      representationRevisionId: event.representationRevisionId,
      eventKind: event.eventKind,
      emitter: event.emitter,
      producerRunId: event.producerRunId,
      producerAgentId: event.producerAgentId,
      originKind: event.originKind,
      destinationClass: event.destinationClass,
      continuationMode: event.continuationMode,
      continuationAddress: event.continuationAddress,
    })
    .onConflictDoNothing({ target: artifactProducedOutbox.eventId })
    .returning({ eventId: artifactProducedOutbox.eventId });

  return { eventId: event.eventId, inserted: inserted.length === 1 };
}

export interface ProducedEventRow {
  eventId: string;
  orgId: string;
  artifactId: string;
  representationRevisionId: string;
  eventKind: string;
  emitter: string;
  producerRunId: string | null;
  producerAgentId: string | null;
  originKind: string;
  destinationClass: string;
  continuationMode: string;
  continuationAddress: string | null;
  status: string;
  createdAt: Date;
  processedAt: Date | null;
}

export async function readProducedEvent(eventId: string): Promise<ProducedEventRow | null> {
  const rows = await db
    .select()
    .from(artifactProducedOutbox)
    .where(eq(artifactProducedOutbox.eventId, eventId))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    eventId: r.eventId,
    orgId: r.orgId,
    artifactId: r.artifactId,
    representationRevisionId: r.representationRevisionId,
    eventKind: r.eventKind,
    emitter: r.emitter,
    producerRunId: r.producerRunId,
    producerAgentId: r.producerAgentId,
    originKind: r.originKind,
    destinationClass: r.destinationClass,
    continuationMode: r.continuationMode,
    continuationAddress: r.continuationAddress,
    status: r.status,
    createdAt: r.createdAt,
    processedAt: r.processedAt,
  };
}

/** Mark an event PROCESSED (S1's orchestration handed it off). Idempotent:
 * re-processing a processed row is a no-op. Returns true iff a pending row was
 * transitioned. */
export async function markProducedEventProcessed(eventId: string): Promise<boolean> {
  const done = await db
    .update(artifactProducedOutbox)
    .set({ status: "processed", processedAt: sql`now()` })
    .where(
      and(
        eq(artifactProducedOutbox.eventId, eventId),
        eq(artifactProducedOutbox.status, "pending"),
      ),
    )
    .returning({ eventId: artifactProducedOutbox.eventId });
  return done.length === 1;
}

/**
 * The reconciliation sweeper's DETECTION half: given the durable witnesses of
 * committed local writes that SHOULD have emitted an event, return those whose
 * event row is MISSING — a SUPPRESSED emit (the artifact committed but its same-tx
 * event row is somehow absent). The backfill (re-emit) is S1 (it carries the
 * emitter context). Reads the present ids in one query, then defers the set-diff
 * to the pure `reconcileProducedEvents`.
 */
export async function findMissedProducedEmits(
  expected: readonly ExpectedEmit[],
): Promise<ExpectedEmit[]> {
  if (expected.length === 0) return [];
  const expectedIds = expected.map((e) =>
    producedEventId(e.artifactId, e.representationRevisionId, e.eventKind ?? ("artifact_produced" as ProducedEventKind)),
  );
  const present = await db
    .select({ eventId: artifactProducedOutbox.eventId })
    .from(artifactProducedOutbox)
    .where(inArray(artifactProducedOutbox.eventId, expectedIds));
  const presentSet = new Set(present.map((r) => r.eventId));
  return reconcileProducedEvents(expected, presentSet);
}
