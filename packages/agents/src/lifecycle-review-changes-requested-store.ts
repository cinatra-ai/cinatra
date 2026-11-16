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
// manifest; the entry point derives the repair lineage from the gate itself,
// cinatra#4312), builds the typed
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
import type { OrgWriteAuthority } from "@cinatra-ai/org-write-kernel";
import { pgSchema, text } from "drizzle-orm/pg-core";

import { db } from "./db";
import { agentRuns, agentTemplates } from "./schema";
import {
  coreRepairsObjectType,
  type CoreRepairableProducedRole,
} from "./lifecycle-repair-producer-registry";
import { listReviewGatesForRun, readReviewGate } from "./artifact-review-gate-store";
import { readProducedEvent } from "./lifecycle-produced-outbox-store";
import {
  recordChangesRequested,
  type RecordChangesRequestedResult,
} from "./lifecycle-repair-store";

import { isAutoReviewTaskId } from "@/lib/lifecycle/lifecycle-orchestration";
import {
  baseReviewTaskId,
  DECLARED_REVIEW_TASK_PREFIX,
  hasPendingSiblingLeg,
  isDeclaredReviewLeg,
  isDeclaredReviewTaskId,
} from "@/lib/artifacts/artifact-review-target";
import { resolveOrgRoleForUser } from "@/lib/auth-session";
import { sessionAuthorityFromResolvedRole } from "@/lib/org-write/authority";
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

/** cinatra#4245: the refusal for the step's own declared gate (`wayflow-<task>`)
 * when it does not meet every condition of a change request that ends the run's
 * pause. The review action maps it back to the plain annotation. */
const DECLARED_GATE_NOT_ELIGIBLE = "declared-gate-not-eligible";

/** cinatra#4245: the deciding user is no member of the gate's org, so no session
 * authority can end the pause (fail closed; nothing is written). */
const DECLARED_GATE_NOT_PERMITTED = "declared-gate-not-permitted";

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
  /** The DECIDING actor (cinatra#2047 D-2) — resolved server-side from the live
   * session by the binder, never a client claim. Stamped on the resolved gate so
   * a `changes_requested` decision carries the same decider of record an
   * approve/reject does. */
  decidedBy?: string | null;
}

// A minimal read-only projection of `objects` — the artifact TYPE the core
// repair capability keys on. Defined LOCALLY (a second pgSchema instance over the
// SAME app schema), exactly as the orchestration store does for its own context
// read, so this agents-package store reads `objects.type` without depending on
// the host objects-store drizzle table.
const appSchemaRef = pgSchema(process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra");
const objectsTypeRef = appSchemaRef.table("objects", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
});

/**
 * Does CORE implement the repair for the artifact under review (cinatra#2047
 * D-1)? Core's repair capability is keyed on the produced-artifact ROLE it
 * implements, never on a package (see `lifecycle-repair-producer-registry`), so
 * this reads the base artifact's object type and asks the pure predicate,
 * resolving each role's claimant through the generated role bindings.
 *
 * Best-effort + fail-soft in the same direction as the manifest read: an
 * unreadable artifact, an unresolvable role, or a reduced universe with no
 * claimant all yield FALSE (route to a human — the safe default).
 */
async function resolveCoreRepairCapable(artifactId: string): Promise<boolean> {
  try {
    const [row] = await db
      .select({ type: objectsTypeRef.type })
      .from(objectsTypeRef)
      .where(eq(objectsTypeRef.id, artifactId))
      .limit(1);
    if (!row?.type) return false;
    const { resolveExtensionRole } = await import("@/lib/extension-roles");
    return coreRepairsObjectType(row.type, (role: CoreRepairableProducedRole) =>
      resolveExtensionRole(role),
    );
  } catch {
    return false;
  }
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

/**
 * Record a prompt-window `changes_requested` decision for the review surface.
 * Resolves the gate + producer facts and drives the S2 `recordChangesRequested`
 * entry point. Returns the entry point's typed result; a thrown gate CAS conflict
 * (the gate resolved under the reviewer) is folded into a typed `gate-not-pending`
 * failure so the surface renders its BLOCKED state.
 *
 * Guards (defence in depth — the action also checks these before calling):
 *   - the gate must exist and be a LIFECYCLE gate (auto/repair-successor task id),
 *     a later leg (the picture's) of a per-artifact DECLARED review (cinatra#3035
 *     W11), proven by the family witness on its pin, or the step's own DECLARED
 *     gate (`wayflow-<task>`, cinatra#4245);
 *   - the gate must pin EXACTLY the one base target (the repair path is single-base).
 * A non-lifecycle / mismatched / multi-target gate returns a typed failure rather
 * than closing the wrong gate.
 *
 * The step's own declared gate (cinatra#4245) takes the
 * change request only when every condition of the issue holds: one pinned target;
 * no other gate of the same review step of the run pending; the produced event of
 * that revision names this gate as its continuation address, in the gate's org,
 * with the gate's run as its producing run, on the effects-gated continuation; and
 * a producer that can repair. Any other case is `declared-gate-not-eligible` (the
 * action keeps the plain note). An eligible request names the pause it ends
 * (`declaredPause`, with the deciding member's session authority), so the record
 * writes the run's end mark and the drain stops the run before its repair run. A
 * picture leg keeps its plain change request: the run stays paused (cinatra#4312).
 */
export async function recordReviewSurfaceChangesRequested(
  input: RecordReviewSurfaceChangesRequestedInput,
): Promise<RecordChangesRequestedResult> {
  const { runId, reviewTaskId, baseTarget, currentBaseRevisionId, feedback } = input;

  const lifecycleGate = isAutoReviewTaskId(reviewTaskId);
  if (!lifecycleGate && !isDeclaredReviewTaskId(reviewTaskId)) {
    return { ok: false, code: "not-a-lifecycle-gate", error: "not a lifecycle review gate" };
  }
  // cinatra#4245: the step's own declared gate (no `#n` leg suffix) ends the pause.
  const declaredStep = !lifecycleGate && baseReviewTaskId(reviewTaskId) === reviewTaskId;
  const notEligible = (why: string): RecordChangesRequestedResult => ({
    ok: false,
    code: DECLARED_GATE_NOT_ELIGIBLE,
    error: `the declared review gate cannot take a change request: ${why}`,
  });
  const trimmed = feedback.trim();
  if (trimmed.length === 0) {
    if (declaredStep) return notEligible("the comment is empty");
    return { ok: false, code: "empty-feedback", error: "changes_requested needs typed feedback" };
  }

  const gate = await readReviewGate(runId, reviewTaskId);
  if (!gate) {
    return { ok: false, code: "gate-not-pending", error: "the review gate is no longer available" };
  }
  // A later leg (the picture's) of a declared per-artifact review is read from the
  // family witness on its pin; a `#n` gate without it keeps its plain Comment.
  if (!lifecycleGate && !declaredStep && !isDeclaredReviewLeg({ runId, orgId: gate.orgId, reviewTaskId, pinnedTargets: gate.pinnedTargets })) {
    return { ok: false, code: "not-a-lifecycle-gate", error: "not a lifecycle review gate" };
  }
  // The repair path is single-base: the gate must pin exactly the one reviewed
  // target (a multi-target/batch gate is out of scope for this per-target repair).
  if (
    gate.pinnedTargets.length !== 1 ||
    gate.pinnedTargets[0].artifactId !== baseTarget.artifactId ||
    gate.pinnedTargets[0].representationRevisionId !== baseTarget.representationRevisionId
  ) {
    if (declaredStep) return notEligible("the gate does not pin exactly this one target");
    return { ok: false, code: "targets-mismatch", error: "the gate does not pin exactly this base target" };
  }
  if (declaredStep && hasPendingSiblingLeg({ reviewTaskId, gates: await listReviewGatesForRun(runId) })) {
    return notEligible("another gate of the same review step is pending");
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
  if (declaredStep) {
    if (!event || event.continuationAddress !== gate.id || event.orgId !== gate.orgId || event.producerRunId !== gate.runId) {
      return notEligible("no produced event names this gate");
    }
    if (event.continuationMode !== "async_effects_gated") return notEligible("the continuation is not effects-gated");
  }

  // A producer is repair-capable when it DECLARES the capability in its compiled
  // manifest, OR when CORE implements the repair for the artifact type under
  // review (the first repairing producer's implementation lives in core, so no
  // package manifest can declare it — cinatra#2047 D-1).
  const repairCapable =
    (await resolveRepairCapable(producerRunId)) ||
    (await resolveCoreRepairCapable(baseTarget.artifactId));
  // An escalated repair is never drained, so the run would wait at an ended pause.
  if (declaredStep && !repairCapable) return notEligible("the producer cannot repair");

  // The pause the request ends, under the deciding member's session authority in
  // the gate's org; a decider who is no member (or none) writes nothing.
  let declaredPause: { pauseTaskId: string; authority: OrgWriteAuthority } | undefined;
  if (declaredStep) {
    const role = input.decidedBy ? await resolveOrgRoleForUser(gate.orgId, input.decidedBy) : undefined;
    if (role === undefined) {
      return { ok: false, code: DECLARED_GATE_NOT_PERMITTED, error: "the deciding user is no member of the gate's organization" };
    }
    declaredPause = {
      pauseTaskId: reviewTaskId.slice(DECLARED_REVIEW_TASK_PREFIX.length),
      authority: sessionAuthorityFromResolvedRole(gate.orgId, role),
    };
  }

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
      decidedBy: input.decidedBy ?? null,
      ...(declaredPause ? { declaredPause } : {}),
    });
  } catch (err) {
    // The entry point THROWS a gate CAS conflict (the gate is not pending — a
    // different decision resolved it under the reviewer). Fold it into the typed
    // failure the surface maps to its BLOCKED state; the transaction rolled back,
    // so nothing was written.
    const message = err instanceof Error ? err.message : String(err);
    // A declared request's guard refusal or database error is no settled gate:
    // the transaction rolled back, so it is retryable (never a silent block).
    if (declaredPause && !message.includes("gate CAS conflict")) {
      return { ok: false, code: "declared-record-failed", error: message };
    }
    return { ok: false, code: "gate-not-pending", error: message };
  }
}
