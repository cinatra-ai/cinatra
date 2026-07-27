import "server-only";

// ---------------------------------------------------------------------------
// lifecycle-continuation-park-store (cinatra#2038, epic #2037 S0)
//
// The durable half of the CHECKPOINTED continuation mode (evaluate-then-park).
// The pre-park synchronous DECISION is the pure `evaluateThenPark`
// (src/lib/lifecycle/lifecycle-continuation.ts); this store PERSISTS the park and
// runs the sweeper:
//
//   maybeParkCheckpoint — parks ONLY when the evaluate-then-park outcome is
//     `park`; a `proceed` (policy skip/forbidden/ungated) NEVER parks (the AC
//     invariant). Idempotent on (run_id, event_id, checkpoint).
//   sweepParks — the resume sweeper. Releases parks whose linked decision
//     RESOLVED (release/skip) and TTL-fail-closes the rest of the DUE parks into a
//     terminal `policy_unresolved` block on the protected effect (always-resume;
//     never an indefinite strand). Ops-surfaced.
//   strandPark — the forced-strand GUARD: refuses to tear down a still-parked
//     (non-terminal) park; only an already-resolved park is strippable.
//   readPolicyUnresolvedParks — the ops visibility reader for blocked effects.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { and, eq, inArray, lte, sql } from "drizzle-orm";

import { db } from "./db";
import { artifactProducedOutbox, lifecycleContinuationPark } from "./schema";
import {
  isStrandable,
  resolvePark,
  type EvaluateThenParkOutcome,
} from "@/lib/lifecycle/lifecycle-continuation";

export class ContinuationParkError extends Error {
  readonly code: "forced-strand" | "not-found" | "conflict";
  constructor(code: "forced-strand" | "not-found" | "conflict", message: string) {
    super(message);
    this.name = "ContinuationParkError";
    this.code = code;
  }
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export interface MaybeParkInput {
  runId: string;
  eventId: string;
  policyDecisionId?: string | null;
  ttlMs?: number;
}

export type MaybeParkResult =
  | { parked: false; reason: string }
  | { parked: true; parkId: string; reevaluationIntent: boolean };

/**
 * Evaluate-then-park: given the pure outcome, park ONLY when it says `park`. A
 * `proceed` outcome returns `parked: false` and writes NO row — the AC invariant
 * that a checkpointed run whose policy says skip never parks. The park row is
 * idempotent on (run_id, event_id, checkpoint): a re-attempt returns the existing
 * park id.
 */
export async function maybeParkCheckpoint(
  outcome: EvaluateThenParkOutcome,
  input: MaybeParkInput,
): Promise<MaybeParkResult> {
  if (outcome.kind === "proceed") {
    return { parked: false, reason: outcome.reason };
  }
  // Floor at 1ms only — a sub-second TTL is the caller's explicit choice; the
  // floor exists solely to bar a zero/negative interval.
  const ttlMs = Math.max(1, input.ttlMs ?? DEFAULT_TTL_MS);

  // Retry once. An insert-conflict means a park already exists for this
  // (run, event, checkpoint) — normally we return it (idempotent). But that park
  // can be concurrently STRANDED (deleted once terminal) between our conflict and
  // our read, leaving the slot free again; rather than fabricate a park id that
  // names no row, we RE-ATTEMPT the insert into the now-free slot.
  for (let attempt = 0; attempt < 2; attempt++) {
    const id = randomUUID();
    const [row] = await db
      .insert(lifecycleContinuationPark)
      .values({
        id,
        runId: input.runId,
        eventId: input.eventId,
        checkpoint: outcome.checkpoint,
        policyDecisionId: input.policyDecisionId ?? null,
        protectedEffect: outcome.protectedEffect,
        reevaluationIntent: outcome.reevaluationIntent,
        status: "parked",
        ttlExpiresAt: sql`now() + (${ttlMs} || ' milliseconds')::interval`,
      })
      .onConflictDoNothing({
        target: [
          lifecycleContinuationPark.runId,
          lifecycleContinuationPark.eventId,
          lifecycleContinuationPark.checkpoint,
        ],
      })
      .returning({ id: lifecycleContinuationPark.id });

    if (row) {
      return { parked: true, parkId: row.id, reevaluationIntent: outcome.reevaluationIntent };
    }
    // Conflict — the slot is occupied. Return the existing park (idempotent) IFF
    // it is still present; if it vanished (concurrently stranded), loop and retry.
    const existing = await db
      .select({ id: lifecycleContinuationPark.id })
      .from(lifecycleContinuationPark)
      .where(
        and(
          eq(lifecycleContinuationPark.runId, input.runId),
          eq(lifecycleContinuationPark.eventId, input.eventId),
          eq(lifecycleContinuationPark.checkpoint, outcome.checkpoint),
        ),
      )
      .limit(1);
    if (existing[0]) {
      return { parked: true, parkId: existing[0].id, reevaluationIntent: outcome.reevaluationIntent };
    }
  }
  throw new ContinuationParkError(
    "conflict",
    `park slot ${input.runId}/${input.eventId}/${outcome.checkpoint} is being concurrently mutated; retry`,
  );
}

export interface ParkRow {
  id: string;
  runId: string;
  eventId: string;
  checkpoint: string;
  policyDecisionId: string | null;
  protectedEffect: string;
  reevaluationIntent: boolean;
  status: "parked" | "released" | "policy_unresolved";
  ttlExpiresAt: Date;
  resolvedAt: Date | null;
}

export async function readPark(parkId: string): Promise<ParkRow | null> {
  const rows = await db
    .select()
    .from(lifecycleContinuationPark)
    .where(eq(lifecycleContinuationPark.id, parkId))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return toParkRow(r);
}

export interface SweepParksInput {
  /** Park ids whose linked decision RESOLVED (release or resolved-skip) — the
   * sweeper releases these regardless of TTL. */
  resolvedSkipParkIds?: readonly string[];
  releasedParkIds?: readonly string[];
  /** Bound on rows swept per pass. */
  limit?: number;
}

export interface SweepParksResult {
  released: number;
  blocked: number;
}

/**
 * The resume sweeper (one pass). Two effects, both CAS-guarded on `status =
 * 'parked'` so a concurrent sweep never double-transitions:
 *
 *   1. RELEASE — parks whose decision resolved (released / resolved-skip) move to
 *      `released` (the protected effect is not blocked). This is the "a parked run
 *      whose decision resolves skip is released by the sweeper" path.
 *   2. TTL FAIL-CLOSE — the remaining DUE parks (ttl_expires_at <= now) always
 *      resume into a terminal `policy_unresolved` block on the protected effect
 *      (ops-surfaced). This is the ONLY path that blocks an effect.
 *
 * The `resolvePark` pure transition dictates the terminal status + whether the
 * effect blocks; the store applies it.
 */
export async function sweepParks(input: SweepParksInput = {}): Promise<SweepParksResult> {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  const resolveIds = [
    ...new Set([...(input.resolvedSkipParkIds ?? []), ...(input.releasedParkIds ?? [])]),
  ];

  let released = 0;
  let blocked = 0;

  // 1. Decision-resolved releases (bounded by the caller's explicit id list). The
  // pure transition confirms the effect is not blocked for a resolved-skip /
  // release; the status='parked' CAS makes it exactly-once under concurrent sweeps.
  if (resolveIds.length > 0) {
    const transition = resolvePark({ kind: "resolved_skip" });
    const rows = await db
      .update(lifecycleContinuationPark)
      .set({ status: transition.status, resolvedAt: sql`now()` })
      .where(
        and(
          inArray(lifecycleContinuationPark.id, resolveIds),
          eq(lifecycleContinuationPark.status, "parked"),
        ),
      )
      .returning({ id: lifecycleContinuationPark.id });
    released += rows.length; // the ACTUAL number transitioned
  }

  // 2. TTL fail-close of the due parks, BOUNDED to `limit` per pass via a LIMIT
  // subquery (a bare UPDATE has no LIMIT). The status='parked' CAS keeps it
  // exactly-once; `blocked` reports the ACTUAL count transitioned.
  const ttlTransition = resolvePark({ kind: "ttl_expired" }); // → policy_unresolved, blocked
  const dueIds = db
    .select({ id: lifecycleContinuationPark.id })
    .from(lifecycleContinuationPark)
    .where(
      and(
        eq(lifecycleContinuationPark.status, "parked"),
        lte(lifecycleContinuationPark.ttlExpiresAt, sql`now()`),
      ),
    )
    .limit(limit);
  const dueRows = await db
    .update(lifecycleContinuationPark)
    .set({ status: ttlTransition.status, resolvedAt: sql`now()` })
    .where(
      and(
        inArray(lifecycleContinuationPark.id, dueIds),
        eq(lifecycleContinuationPark.status, "parked"),
      ),
    )
    .returning({ id: lifecycleContinuationPark.id });
  blocked += dueRows.length;

  return { released, blocked };
}

/**
 * The forced-strand GUARD. A park may be torn down ONLY when it is already
 * terminal (released / policy_unresolved) — a still-`parked` (non-terminal) park
 * can NEVER be stranded: every park must terminate through the sweeper. Throws
 * `forced-strand` on an attempt to strip a live park (the AC's "a forced-strand
 * attempt fails").
 */
export async function strandPark(parkId: string): Promise<void> {
  const park = await readPark(parkId);
  if (!park) throw new ContinuationParkError("not-found", `park ${parkId} not found`);
  if (!isStrandable(park)) {
    throw new ContinuationParkError(
      "forced-strand",
      `park ${parkId} is still ${park.status} — a live park cannot be stranded; it must resolve through the sweeper`,
    );
  }
  await db.delete(lifecycleContinuationPark).where(eq(lifecycleContinuationPark.id, parkId));
}

/** Run-scoped park reader (cinatra#2066, C0). Lists EVERY checkpointed
 * continuation park a run owns — parked, released, or policy_unresolved — so the
 * canonical run-detail aggregate can surface a run's parked continuations
 * alongside its gates. Ordered by creation for a stable rail projection. */
export async function readContinuationParksForRun(runId: string): Promise<ParkRow[]> {
  const rows = await db
    .select()
    .from(lifecycleContinuationPark)
    .where(eq(lifecycleContinuationPark.runId, runId))
    .orderBy(lifecycleContinuationPark.createdAt);
  return rows.map(toParkRow);
}

/** An ops row: the park PLUS the produced-event coordinates an operator needs to
 * act on it (which artifact/revision, and which org owns it). The park table
 * carries no org column — the org lives on the produced event the park is keyed
 * to, so the ops read JOINS it (which is also what makes the surface org-scopable
 * at all). */
export interface PolicyUnresolvedParkRow extends ParkRow {
  orgId: string | null;
  artifactId: string | null;
  representationRevisionId: string | null;
}

/**
 * Ops visibility: the parks the sweeper fail-closed into a terminal
 * `policy_unresolved` block (their protected effect is blocked pending an explicit
 * policy decision). Consumed by the lifecycle-operations ops surface
 * (`/configuration/lifecycle-operations`, cinatra#2047 D-7) — S0's continuation
 * contract calls this state "ops-surfaced", and until #2047 nothing read it.
 *
 * `orgId` SCOPES the read through the joined produced event (a multi-tenant ops
 * surface must never show another org's blocked effects); omitting it returns the
 * unscoped set (tests / a single-org instance script).
 */
export async function readPolicyUnresolvedParks(opts?: {
  orgId?: string;
  limit?: number;
}): Promise<PolicyUnresolvedParkRow[]> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 100, 500));
  const rows = await db
    .select({
      park: lifecycleContinuationPark,
      orgId: artifactProducedOutbox.orgId,
      artifactId: artifactProducedOutbox.artifactId,
      representationRevisionId: artifactProducedOutbox.representationRevisionId,
    })
    .from(lifecycleContinuationPark)
    // LEFT join: a park whose produced event was purged still MUST be visible to
    // ops (it is exactly the kind of orphan an operator needs to see), it simply
    // carries no artifact coordinates. An org-scoped read excludes it by the
    // predicate below, which is correct — an unattributable park has no org.
    .leftJoin(
      artifactProducedOutbox,
      eq(artifactProducedOutbox.eventId, lifecycleContinuationPark.eventId),
    )
    .where(
      opts?.orgId
        ? and(
            eq(lifecycleContinuationPark.status, "policy_unresolved"),
            eq(artifactProducedOutbox.orgId, opts.orgId),
          )
        : eq(lifecycleContinuationPark.status, "policy_unresolved"),
    )
    .orderBy(lifecycleContinuationPark.resolvedAt)
    .limit(limit);
  return rows.map((r) => ({
    ...toParkRow(r.park),
    orgId: r.orgId ?? null,
    artifactId: r.artifactId ?? null,
    representationRevisionId: r.representationRevisionId ?? null,
  }));
}

function toParkRow(r: typeof lifecycleContinuationPark.$inferSelect): ParkRow {
  return {
    id: r.id,
    runId: r.runId,
    eventId: r.eventId,
    checkpoint: r.checkpoint,
    policyDecisionId: r.policyDecisionId,
    protectedEffect: r.protectedEffect,
    reevaluationIntent: r.reevaluationIntent,
    status: r.status as ParkRow["status"],
    ttlExpiresAt: r.ttlExpiresAt,
    resolvedAt: r.resolvedAt,
  };
}
