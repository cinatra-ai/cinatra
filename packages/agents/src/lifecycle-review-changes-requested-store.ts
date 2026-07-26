import "server-only";

// ---------------------------------------------------------------------------
// lifecycle-review-changes-requested-store (cinatra#2040, epic #2037 S2 →
// cinatra#2063 prompt-window wiring)
//
// The SURFACE-SIDE composer for the S12 review surface's prompt-window
// `changes_requested` path (owner ruling 2026-07-25, cinatra#2063): when the
// lifecycle fence is ON and the reviewed gate is a LIFECYCLE review gate, the
// reviewer's typed prompt-window feedback (the existing Comment path) becomes a
// `changes_requested` decision that CLOSES the base gate and OPENS a repair.
//
// This module is a THIN resolve-then-record composer over the EXISTING S2 store
// entry point `recordChangesRequested` — there is NO parallel write path. It
// resolves the facts the entry point needs that the surface does not already
// hold (the gate identity + org, the producing run + continuation from the
// produced-event outbox, the producer's repair capability from its compiled
// manifest, the cycle lineage for a repair-successor gate), builds the typed
// `ChangesRequestedRequest` from the typed feedback (ONE free-text finding,
// mirroring the pre-migration WayFlow review HITL, which consumed a single typed
// `message`), and drives the entry point. The base-revision CAS witness
// (`currentBaseRevisionId`) is resolved by the CALLER (the review-gate-ports
// binder) through the same `revisionMember` port the preparation core uses, so
// this module adds no new artifact read path.
//
// Idempotent on the gate (the entry point is): a stable idempotency key derived
// from the gate + the exact feedback makes a response-lost retry with the same
// feedback re-derive the same repair; different feedback on an already-repairing
// gate is a gate-conflict (fail-closed). A thrown gate CAS conflict (the gate was
// resolved under the reviewer) is caught and surfaced as a typed `gate-not-pending`
// result so the surface renders its existing BLOCKED state — never a silent slip.
//
// FENCED with the rest of S2 — the surface only reaches this composer when
// `isLifecycleReviewOrchestrationActive()` is true (the action gates on it); with
// the fence off the Comment path stays byte-identical (a non-terminal annotation).
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";

import { db } from "./db";
import { agentRuns, agentTemplates } from "./schema";
import { readReviewGate } from "./artifact-review-gate-store";
import { readProducedEvent } from "./lifecycle-produced-outbox-store";
import {
  recordChangesRequested,
  readRepair,
  readRepairBySuccessorGateId,
  type RecordChangesRequestedResult,
} from "./lifecycle-repair-store";

import {
  isAutoReviewTaskId,
  isRepairSuccessorTaskId,
  isVerificationReopenTaskId,
  REPAIR_SUCCESSOR_TASK_PREFIX,
  VERIFICATION_REOPEN_TASK_PREFIX,
} from "@/lib/lifecycle/lifecycle-orchestration";
import { producedEventId, type ContinuationMode } from "@/lib/lifecycle/lifecycle-produced-event";
import type { ChangesRequestedRequest, RepairFinding } from "@/lib/lifecycle/lifecycle-repair";

/** Re-export the entry point's result so the surface (a src-side model) can map it
 * without reaching a second agents subpath. */
export type { RecordChangesRequestedResult } from "./lifecycle-repair-store";

/** The stable finding id the single prompt-window finding carries. Constant, so a
 * response-lost retry re-derives the identical `changes_requested` fingerprint
 * (the entry point keys the fingerprint on the idempotency key + the sorted
 * finding ids). The distinguishing datum across submits is the FEEDBACK, which the
 * idempotency key encodes below. */
const PROMPT_WINDOW_FINDING_ID = "prompt-window";

export interface RecordReviewSurfaceChangesRequestedInput {
  /** The reviewed gate's run id (the route param — the auto-gate's producing run). */
  runId: string;
  /** The reviewed gate's task id — MUST be a lifecycle auto/repair-successor gate. */
  reviewTaskId: string;
  /** The single base target under review (the gate pins exactly one for the repair
   * path; the caller enforces single-target before reaching here). */
  baseTarget: { artifactId: string; representationRevisionId: string };
  /** The LIVE current revision of the base target, resolved by the CALLER via the
   * surface's `revisionMember` port (the pinned revision when still live; null when
   * tombstoned/removed) — the base-revision CAS witness the entry point re-checks. */
  currentBaseRevisionId: string | null;
  /** The reviewer's typed prompt-window feedback — becomes the single finding's
   * message. The caller passes it trimmed + non-empty (empty feedback stays a plain
   * annotation on the base comment path). */
  feedback: string;
}

/**
 * Resolve the producing agent's `repairCapable` declaration from its run's
 * compiled manifest lifecycle (`agent_templates.lifecycle_config`, JSON-as-text).
 * Best-effort + fail-soft: any missing link (orphan run, no template, absent/
 * malformed config, no `repairCapable`) yields FALSE — the entry point then routes
 * to a human / org route (never a producer repair), the safe default. Mirrors the
 * orchestration store's `resolveManifest` read, narrowed to the one boolean the
 * repair route keys on (kept local to avoid an import cycle — the orchestration
 * store imports the repair store).
 */
async function resolveRepairCapable(producerRunId: string | null): Promise<boolean> {
  if (!producerRunId) return false;
  try {
    const [run] = await db
      .select({ templateId: agentRuns.templateId })
      .from(agentRuns)
      .where(eq(agentRuns.id, producerRunId))
      .limit(1);
    if (!run?.templateId) return false;
    const [tmpl] = await db
      .select({ lifecycleConfig: agentTemplates.lifecycleConfig })
      .from(agentTemplates)
      .where(eq(agentTemplates.id, run.templateId))
      .limit(1);
    if (!tmpl?.lifecycleConfig) return false;
    const parsed = JSON.parse(tmpl.lifecycleConfig) as { repairCapable?: unknown };
    return parsed?.repairCapable === true;
  } catch {
    return false;
  }
}

/** Recover the original repair lineage id for a repair-SUCCESSOR gate (a repair
 * chain) so the cycle guard counts the WHOLE chain, not a fresh lineage per
 * successor. For a first-round auto gate this is undefined (the entry point
 * defaults the lineage to the base gate id). */
async function resolveLineageId(reviewTaskId: string): Promise<string | undefined> {
  if (isRepairSuccessorTaskId(reviewTaskId)) {
    // `repairSuccessorReviewTaskId` = `${PREFIX}${repairId}:${attempt}`; repairId is a
    // UUID (no colon), so the first segment after the prefix is the repair id.
    const repairId = reviewTaskId.slice(REPAIR_SUCCESSOR_TASK_PREFIX.length).split(":")[0];
    if (!repairId) return undefined;
    const repair = await readRepair(repairId);
    return repair?.lineageId ?? undefined;
  }
  // A post-change VERIFICATION-REOPEN gate (cinatra#2042): a FAILED verification of
  // a repaired revision reopened this gate. A changes_requested on it must thread the
  // ORIGINAL repair lineage so the cycle bound counts the verify→reopen→repair loop —
  // otherwise the bound RESETS to attempt 1 and the loop is unbounded. The reopen
  // task encodes the verification id `verify:<successorGateId>`; the repair whose
  // successor gate that is carries the lineage. (An external-change verification has
  // no repair successor ⇒ undefined ⇒ a fresh lineage, which is correct: a
  // human-driven external change is not an automated repair cycle.)
  if (isVerificationReopenTaskId(reviewTaskId)) {
    const verificationId = reviewTaskId.slice(VERIFICATION_REOPEN_TASK_PREFIX.length);
    const successorGateId = verificationId.startsWith("verify:")
      ? verificationId.slice("verify:".length)
      : verificationId;
    if (!successorGateId) return undefined;
    const repair = await readRepairBySuccessorGateId(successorGateId);
    return repair?.lineageId ?? undefined;
  }
  return undefined;
}

/**
 * Record a prompt-window `changes_requested` decision for the review surface.
 * Resolves the gate + producer facts and drives the S2 `recordChangesRequested`
 * entry point. Returns the entry point's typed result; a thrown gate CAS conflict
 * (the gate resolved under the reviewer) is folded into a typed `gate-not-pending`
 * failure so the surface renders its BLOCKED state.
 *
 * Guards (defence in depth — the action also checks these before calling):
 *   - the gate must exist and be a LIFECYCLE gate (auto/repair-successor task id);
 *   - the gate must pin EXACTLY the one base target (the repair path is single-base).
 * A non-lifecycle / mismatched / multi-target gate returns a typed failure rather
 * than closing the wrong gate.
 */
export async function recordReviewSurfaceChangesRequested(
  input: RecordReviewSurfaceChangesRequestedInput,
): Promise<RecordChangesRequestedResult> {
  const { runId, reviewTaskId, baseTarget, currentBaseRevisionId, feedback } = input;

  if (!isAutoReviewTaskId(reviewTaskId)) {
    return { ok: false, code: "not-a-lifecycle-gate", error: "not a lifecycle review gate" };
  }
  const trimmed = feedback.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: "empty-feedback", error: "changes_requested needs typed feedback" };
  }

  const gate = await readReviewGate(runId, reviewTaskId);
  if (!gate) {
    return { ok: false, code: "gate-not-pending", error: "the review gate is no longer available" };
  }
  // The repair path is single-base: the gate must pin exactly the one reviewed
  // target (a multi-target/batch gate is out of scope for this per-target repair).
  if (
    gate.pinnedTargets.length !== 1 ||
    gate.pinnedTargets[0].artifactId !== baseTarget.artifactId ||
    gate.pinnedTargets[0].representationRevisionId !== baseTarget.representationRevisionId
  ) {
    return { ok: false, code: "targets-mismatch", error: "the gate does not pin exactly this base target" };
  }

  // The produced event carries the continuation + producer provenance the repair
  // route keys on. Best-effort: a gate with no resolvable event (e.g. an orphan)
  // defaults to the effects-gated continuation + the gate's own run.
  const eventId = producedEventId(baseTarget.artifactId, baseTarget.representationRevisionId, "artifact_produced");
  const event = await readProducedEvent(eventId);
  const continuationMode: ContinuationMode =
    event?.continuationMode === "checkpointed" ? "checkpointed" : "async_effects_gated";
  const continuationAddress = event?.continuationAddress ?? null;
  const producerRunId = event?.producerRunId ?? gate.runId;
  const producerAgentId = event?.producerAgentId ?? null;

  const repairCapable = await resolveRepairCapable(producerRunId);
  const lineageId = await resolveLineageId(reviewTaskId);

  // A stable idempotency key over the gate + the EXACT feedback: a response-lost
  // retry with the same feedback re-derives the same repair (idempotent); different
  // feedback on an already-repairing gate is a gate-conflict (fail-closed).
  const idempotencyKey = `pw:${createHash("sha256").update(`${gate.id} ${trimmed}`).digest("hex")}`;
  const findings: RepairFinding[] = [{ id: PROMPT_WINDOW_FINDING_ID, message: trimmed }];
  const request: ChangesRequestedRequest = {
    gateId: gate.id,
    decisionId: idempotencyKey,
    idempotencyKey,
    baseTarget,
    expectedBaseRevisionId: baseTarget.representationRevisionId,
    findings,
    continuationMode,
    continuationAddress,
  };

  try {
    return await recordChangesRequested({
      runId,
      reviewTaskId,
      orgId: gate.orgId,
      request,
      repairCapable,
      producerRunId,
      producerAgentId,
      currentBaseRevisionId,
      lineageId,
    });
  } catch (err) {
    // The entry point THROWS a gate CAS conflict (the gate is not pending — a
    // different decision resolved it under the reviewer). Fold it into the typed
    // failure the surface maps to its BLOCKED state; the transaction rolled back,
    // so nothing was written.
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, code: "gate-not-pending", error: message };
  }
}
