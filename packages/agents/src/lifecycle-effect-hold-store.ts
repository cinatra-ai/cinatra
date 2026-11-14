import "server-only";

// ---------------------------------------------------------------------------
// lifecycle-effect-hold-store (cinatra#3862 leg 1)
//
// The READ half of effects gating: whether an artifact revision's downstream
// external effect is held by its review, and the disposition-aware companion
// the CMS-review seam binds. Moved out of lifecycle-review-orchestration-store
// unchanged, so a caller that needs only this read (the CMS-review seam binder)
// no longer imports the whole orchestration store and its maintenance sweep.
// The orchestration store re-exports both functions and the type, so every
// existing importer is unchanged.
// ---------------------------------------------------------------------------

import { and, eq } from "drizzle-orm";

import { db } from "./db";
import { artifactProducedOutbox, artifactReviewGates, lifecycleContinuationPark } from "./schema";
import { producedEventId, type ProducedEventKind } from "@/lib/lifecycle/lifecycle-produced-event";
import { evaluateEffectHold, type EffectHoldVerdict } from "@/lib/lifecycle/lifecycle-orchestration";
import type { DestinationClass } from "@/lib/lifecycle/lifecycle-policy";

// ---------------------------------------------------------------------------
// Effects-gating predicate (the store half of `isArtifactEffectHeld`).
// ---------------------------------------------------------------------------

/**
 * Decide whether an artifact revision's downstream EXTERNAL effect is held by a
 * pending review. The external-effect paths (publish / visibility promotion /
 * pipeline hand-off) call this BEFORE acting: an ungated / non-external artifact
 * flows immediately; an external one is HELD fail-closed until its review gate
 * resolves. Pure verdict via `evaluateEffectHold`; this half resolves the facts
 * (the produced-event row + its linked gate status).
 */
export async function isArtifactEffectHeld(input: {
  artifactId: string;
  representationRevisionId: string;
  eventKind?: ProducedEventKind;
}): Promise<EffectHoldVerdict> {
  const eventId = producedEventId(
    input.artifactId,
    input.representationRevisionId,
    input.eventKind ?? "artifact_produced",
  );
  const [event] = await db
    .select({
      destinationClass: artifactProducedOutbox.destinationClass,
      status: artifactProducedOutbox.status,
      continuationAddress: artifactProducedOutbox.continuationAddress,
    })
    .from(artifactProducedOutbox)
    .where(eq(artifactProducedOutbox.eventId, eventId))
    .limit(1);

  if (!event) return evaluateEffectHold({ event: null, gateStatus: null });

  const policyUnresolvedPark = await hasPolicyUnresolvedPark(
    eventId,
    event.destinationClass as DestinationClass,
  );

  let gateStatus: "pending" | "resolved" | null = null;
  let gateDisposition: "approve" | "reject" | "changes_requested" | null = null;
  if (event.continuationAddress) {
    const [gate] = await db
      .select({ status: artifactReviewGates.status, disposition: artifactReviewGates.disposition })
      .from(artifactReviewGates)
      .where(eq(artifactReviewGates.id, event.continuationAddress))
      .limit(1);
    gateStatus = gate ? (gate.status === "resolved" ? "resolved" : "pending") : null;
    // S2 (cinatra#2040): a gate resolved as `changes_requested` keeps HOLDING the
    // effect (a repair is in flight) — thread the terminal disposition so the pure
    // verdict can distinguish it from an approve/reject resolution.
    gateDisposition = (gate?.disposition as "approve" | "reject" | "changes_requested" | null) ?? null;
  }

  return evaluateEffectHold({
    event: {
      destinationClass: event.destinationClass as DestinationClass,
      status: event.status,
      continuationAddress: event.continuationAddress,
    },
    gateStatus,
    gateDisposition,
    policyUnresolvedPark,
  });
}

/**
 * D-7 (cinatra#2047): does a CHECKPOINTED continuation park protecting THIS
 * event's effect sit in the terminal `policy_unresolved` state?
 *
 * The park is keyed on `(run_id, event_id, checkpoint)`, so several runs may hold
 * a park over the same event. The effect layer is revision-scoped, not run-scoped
 * — ANY run's terminal park over this revision blocks it — so the run is
 * deliberately not part of the predicate. The PROTECTED EFFECT, however, is:
 * matching `protected_effect = <the event's own destination class>` (Codex
 * convergence) means an unrelated or malformed park guarding a DIFFERENT effect
 * class can never fail-close this revision, and a `none`-class park (which guards
 * no external effect at all) is excluded by construction.
 */
async function hasPolicyUnresolvedPark(
  eventId: string,
  destinationClass: DestinationClass,
): Promise<boolean> {
  if (destinationClass === "none") return false;
  const [row] = await db
    .select({ id: lifecycleContinuationPark.id })
    .from(lifecycleContinuationPark)
    .where(
      and(
        eq(lifecycleContinuationPark.eventId, eventId),
        eq(lifecycleContinuationPark.status, "policy_unresolved"),
        eq(lifecycleContinuationPark.protectedEffect, destinationClass),
      ),
    )
    .limit(1);
  return row != null;
}

/** The disposition-aware verdict of a captured external effect (cinatra#2043 S5
 * — the connector CMS-review seam's apply gate). A plain held/not-held cannot
 * tell `approve` from `reject` (both are "not held", but a rejected effect must
 * NEVER be applied), so this widens `isArtifactEffectHeld` into the five states
 * the connector's `resolveDisposition` seam consumes:
 *   - `held`     — the review gate is pending (or a repair is in flight); HOLD.
 *   - `approved` — the gate resolved `approve`; the effect is released → APPLY.
 *   - `rejected` — the gate resolved `reject`; the effect is tombstoned → REFUSE.
 *   - `ungated`  — the org lattice permitted the effect without a gate → APPLY.
 *   - `policy_unresolved` — a checkpointed park TTL-expired with the policy
 *                 unresolved; the effect is TERMINALLY blocked (cinatra#2047 D-7)
 *                 until an explicit later policy decision → HOLD/REFUSE, and it is
 *                 listed on the lifecycle-operations ops surface.
 *   - `unknown`  — no capture / an incoherent resolved state → fail-closed REFUSE. */
export type ArtifactEffectDisposition =
  | "held"
  | "approved"
  | "rejected"
  | "ungated"
  | "policy_unresolved"
  | "unknown";

/**
 * Resolve the disposition of an artifact revision's downstream EXTERNAL effect —
 * the disposition-aware companion of `isArtifactEffectHeld`. Reads the SAME facts
 * (the produced-event outbox row + its linked review gate) and reuses the pure
 * `evaluateEffectHold` verdict for the hold decision, then distinguishes an
 * approved release from a rejected tombstone via the gate's terminal disposition.
 * The connector's `@cinatra-ai/host:cms-review` `resolveDisposition` seam binds
 * this: the effect is held while the gate is pending, applied only on an
 * `approve`, and refused (fail-closed) on a `reject` / an indeterminate state.
 */
export async function resolveArtifactEffectDisposition(input: {
  artifactId: string;
  representationRevisionId: string;
  eventKind?: ProducedEventKind;
}): Promise<{ disposition: ArtifactEffectDisposition; gate: { gateId: string; runId: string } | null }> {
  const eventId = producedEventId(
    input.artifactId,
    input.representationRevisionId,
    input.eventKind ?? "artifact_produced",
  );
  const [event] = await db
    .select({
      destinationClass: artifactProducedOutbox.destinationClass,
      status: artifactProducedOutbox.status,
      continuationAddress: artifactProducedOutbox.continuationAddress,
    })
    .from(artifactProducedOutbox)
    .where(eq(artifactProducedOutbox.eventId, eventId))
    .limit(1);

  // No produced event for this revision — nothing was captured. Fail-closed:
  // the connector treats `unknown` as REFUSE (never a silent apply on a phantom).
  if (!event) return { disposition: "unknown", gate: null };

  // D-7 (cinatra#2047): join the continuation-park set. A TTL-expired park's
  // terminal `policy_unresolved` block is the effect's disposition, ahead of every
  // gate state — the always-resume path must never apply an effect whose policy
  // was never resolved.
  const policyUnresolvedPark = await hasPolicyUnresolvedPark(
    eventId,
    event.destinationClass as DestinationClass,
  );

  let gateStatus: "pending" | "resolved" | null = null;
  let gateDisposition: "approve" | "reject" | "changes_requested" | null = null;
  let gateRef: { gateId: string; runId: string } | null = null;
  if (event.continuationAddress) {
    const [gate] = await db
      .select({
        id: artifactReviewGates.id,
        runId: artifactReviewGates.runId,
        status: artifactReviewGates.status,
        disposition: artifactReviewGates.disposition,
      })
      .from(artifactReviewGates)
      .where(eq(artifactReviewGates.id, event.continuationAddress))
      .limit(1);
    if (gate) {
      gateRef = { gateId: gate.id, runId: gate.runId };
      gateStatus = gate.status === "resolved" ? "resolved" : "pending";
      gateDisposition = (gate.disposition as "approve" | "reject" | "changes_requested" | null) ?? null;
    }
  }

  const verdict = evaluateEffectHold({
    event: {
      destinationClass: event.destinationClass as DestinationClass,
      status: event.status,
      continuationAddress: event.continuationAddress,
    },
    gateStatus,
    gateDisposition,
    policyUnresolvedPark,
  });

  // TERMINAL policy block (D-7) — reported as its own disposition so a caller can
  // tell an ops-actionable dead end from an ordinary pending-gate hold. Both refuse
  // the apply; only this one is listed on the lifecycle-operations surface.
  if (verdict.policyUnresolved === true) {
    return { disposition: "policy_unresolved", gate: gateRef };
  }

  // HELD: the gate is pending (or a repair is in flight, `changes_requested`), or
  // an external effect awaits orchestration (fail-closed) — the connector holds.
  if (verdict.held) return { disposition: "held", gate: gateRef };

  // NOT held. An event with no continuation address is either non-external or
  // org-`forbidden` (the lattice permitted the effect without a gate) → ungated.
  if (!event.continuationAddress) return { disposition: "ungated", gate: null };

  // A continuation address that no longer resolves to a gate row is incoherent —
  // never apply on a vanished gate.
  if (!gateRef) return { disposition: "unknown", gate: null };

  // A resolved gate: approve releases (apply), reject tombstones (refuse).
  if (gateDisposition === "approve") return { disposition: "approved", gate: gateRef };
  if (gateDisposition === "reject") return { disposition: "rejected", gate: gateRef };

  // Resolved-but-no-terminal-disposition (or a value the effect-hold verdict did
  // not classify as still-held) is indeterminate → fail-closed.
  return { disposition: "unknown", gate: gateRef };
}
