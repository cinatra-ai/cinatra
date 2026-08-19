import "server-only";

// ---------------------------------------------------------------------------
// The AUTHORITATIVE REFETCH contract for lifecycle cards (cinatra#2565,
// epic #2564 S1). Design: design@6c20871b4108176c1d0193f19ecd2947f6c6355f
// `specs/app-lifecycle-cards.html` at that commit §IV.
//
// A lifecycle DATA_PART carries an opaque ref and nothing else, so EVERY fact a
// card shows has to come from here: given a ref and the reader, resolve what the
// card may draw right now. That is what makes a persisted transcript safe to
// keep — the bytes in the thread say nothing, and a reader who lost access
// between the turn and the reload sees the card disappear rather than a stale
// snapshot of what they used to be allowed to see.
//
// THE ANSWER IS A PER-KIND ENVELOPE (epic S9, slice S9c): `{ kind, state, body }`,
// where the kind selects the one body type that kind is authorized to carry. The
// state ladder is unchanged and still shared by every kind; what the envelope
// adds is the per-kind reading a card cannot be drawn without. `absent` carries
// no body on any path — that is the privacy contract below, unweakened.
//
// THE REF IS NOT A CAPABILITY. It addresses a row; it grants nothing. Every
// resolve re-runs the reader's access from scratch, so forging a ref buys an
// attacker exactly one thing: an `absent`.
//
// ABSENT SWALLOWS EVERYTHING (the generic-refusal contract). No access, no such
// row, a ref that does not decode, a store that threw — all answer `absent`.
// The card then draws no DOM at all (§IV), so the surface cannot be used to
// probe which runs, gates or records exist.
//
// ORDER IS LOAD-BEARING, and it mirrors `loadReviewGateSurface`: run READ
// access first (a reader with none never learns whether the gate exists), then
// the gate's own state, then the decision axis. Reversing the first two would
// leak gate existence to anyone holding a ref.
// ---------------------------------------------------------------------------

import {
  decodeLifecycleGateRef,
  encodeLifecycleGateRef,
  type LifecycleGateRefPayload,
} from "@/lib/lifecycle/lifecycle-card-ref";
import {
  enforceReviewRunAccess,
  readReviewGate,
  readReviewGateState,
} from "@cinatra-ai/agents/artifact-review-gate-store";
// The READ leaf, not the verification write store (cinatra#2567): this resolver
// only asks whether a reading exists, and reaching it through the write store
// dragged the whole verification lane onto every graph the MCP surface carries.
import { readVerificationRecordForGate } from "@cinatra-ai/agents/lifecycle-verification-read-store";
import type {
  LifecycleCardState,
  LifecycleDataPartViewType,
  LifecycleResolveEnvelope,
  LifecycleResolveEnvelopeFor,
  VerificationSummaryBody,
  VerificationSummaryFieldDiff,
  VerificationSummaryOutcome,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";
import {
  VERIFICATION_SUMMARY_MAX_FIELD_DIFF,
  VERIFICATION_SUMMARY_MAX_SCOPE_PATHS,
  VERIFICATION_SUMMARY_OUTCOMES,
  VERIFICATION_SUMMARY_PATH_MAX_LENGTH,
  VERIFICATION_SUMMARY_REVISION_MAX_LENGTH,
  VERIFICATION_SUMMARY_VALUE_MAX_LENGTH,
  VERIFICATION_SUMMARY_VIEW_VERSION,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";
import type { VerificationRecordRead } from "@cinatra-ai/agents/lifecycle-verification-read-store";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";

/** The generic "nothing to draw" answer. Every denial path lands here. */
const ABSENT: LifecycleCardState = { state: "absent" };

/**
 * The generic "nothing to draw" ENVELOPE for one kind. `absent` carries no body
 * — that is the privacy contract, expressed in the one place every denial path
 * already lands.
 */
function absentEnvelope<K extends LifecycleDataPartViewType>(
  kind: K,
): LifecycleResolveEnvelopeFor<K> {
  return { kind, state: ABSENT, body: null } as LifecycleResolveEnvelopeFor<K>;
}

/**
 * The reason a reader sees on a `restricted` card. It describes the READER's
 * standing on the run and names nothing about the item — no gate id, no policy
 * id, no counts. §IV requires the reason on screen; the refusal contract
 * requires it to be non-enumerating, and a fixed sentence satisfies both.
 */
export const LIFECYCLE_RESTRICTED_REASON =
  "Approving or rejecting needs approve access on this run.";

// ---------------------------------------------------------------------------
// The ref codec now lives in `@/lib/lifecycle/lifecycle-card-ref` (cinatra#2566)
// so the gate-emission path can MINT a ref without importing this resolver's
// store graph. Re-exported here unchanged: S1's import surface is preserved and
// there is still exactly ONE codec.
// ---------------------------------------------------------------------------

export {
  decodeLifecycleGateRef,
  encodeLifecycleGateRef,
  type LifecycleGateRefPayload,
};

// ---------------------------------------------------------------------------
// The per-kind resolvers
// ---------------------------------------------------------------------------

async function resolveReviewGateState(
  payload: LifecycleGateRefPayload,
  actorCtx: ReviewActorContext,
): Promise<LifecycleCardState> {
  const { runId, reviewTaskId } = payload;
  // 1. Run READ access — before anything reveals that the gate exists.
  const read = await enforceReviewRunAccess(
    runId,
    actorCtx.actor,
    "read",
    actorCtx.roleHints,
  );
  if (!read.ok) return ABSENT;

  // 2. The gate's own state.
  //    - `resolved`    → "no longer open" (§IV `settled`): it WAS this reader's
  //                      gate and it has been decided, so the card says so and
  //                      offers a refresh instead of letting a stale decision
  //                      through.
  //    - `unavailable` → `absent`. This covers a gate that never existed and a
  //                      row too corrupt to read, so drawing "no longer open"
  //                      here would let a replayed or garbage ref produce card
  //                      DOM for nothing at all. Nothing to draw means draw
  //                      nothing.
  const gate = await readReviewGateState(runId, reviewTaskId);
  if (gate.status === "unavailable") return ABSENT;
  if (gate.status !== "pending") return { state: "settled" };

  // 3. The decision axis (§IV `restricted`): a terminal decision needs approve
  //    access; commenting needs respond access. Resolved against the ACTUAL
  //    reader, never a role guess.
  const [decide, comment] = await Promise.all([
    enforceReviewRunAccess(runId, actorCtx.actor, "approveHitl", actorCtx.roleHints),
    enforceReviewRunAccess(runId, actorCtx.actor, "respondToHitl", actorCtx.roleHints),
  ]);
  if (!decide.ok) {
    return {
      state: "restricted",
      canDecide: false,
      canComment: comment.ok,
      reason: LIFECYCLE_RESTRICTED_REASON,
    };
  }
  return { state: "pending", canDecide: true, canComment: comment.ok };
}

/** Clamp one string to a ceiling the body schema will accept. */
function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Project one persisted verification record into §VII's SANITIZED body.
 *
 * WHAT TRAVELS. The verdict, the two pinned revisions, the inspected scope and
 * the before/after field diff — the same reading the run's own "Core analysis"
 * surface already shows this reader, who has cleared run READ and whose gate and
 * record were both found. Nothing here is new disclosure; it is the existing
 * disclosure, reached through the card instead of the page.
 *
 * WHAT DOES NOT. The record id, the gate id and the artifact ids. They name
 * nothing on screen, and an addressable id inside a card body is an invitation
 * to read one out of it.
 *
 * WHAT MAKES IT `null`. A verdict outside the closed set. That is a row this
 * build cannot read, and an unreadable row draws nothing rather than an unknown
 * verdict — the same fail-closed posture the rest of this module takes.
 *
 * Every field is clamped to the contract's ceilings, so a pathological row
 * cannot turn one resolve into an unbounded response.
 */
function projectVerificationBody(
  record: VerificationRecordRead,
): VerificationSummaryBody | null {
  const outcomes: readonly string[] = VERIFICATION_SUMMARY_OUTCOMES;
  if (!outcomes.includes(record.outcome)) return null;
  const reviewedRevisionId = record.reviewedTarget.representationRevisionId;
  const repairedRevisionId = record.repairedTarget.representationRevisionId;
  if (!reviewedRevisionId || !repairedRevisionId) return null;

  const fieldDiff: VerificationSummaryFieldDiff[] = record.fieldDiff
    .filter((row) => typeof row?.field === "string" && row.field.length > 0)
    .slice(0, VERIFICATION_SUMMARY_MAX_FIELD_DIFF)
    .map((row) => ({
      field: clamp(row.field, VERIFICATION_SUMMARY_PATH_MAX_LENGTH),
      before:
        typeof row.before === "string"
          ? clamp(row.before, VERIFICATION_SUMMARY_VALUE_MAX_LENGTH)
          : null,
      after:
        typeof row.after === "string"
          ? clamp(row.after, VERIFICATION_SUMMARY_VALUE_MAX_LENGTH)
          : null,
    }));

  const scopePaths = (record.scopeManifest?.paths ?? [])
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .slice(0, VERIFICATION_SUMMARY_MAX_SCOPE_PATHS)
    .map((p) => clamp(p, VERIFICATION_SUMMARY_PATH_MAX_LENGTH));

  return {
    version: VERIFICATION_SUMMARY_VIEW_VERSION,
    outcome: record.outcome as VerificationSummaryOutcome,
    reviewedRevisionId: clamp(reviewedRevisionId, VERIFICATION_SUMMARY_REVISION_MAX_LENGTH),
    repairedRevisionId: clamp(repairedRevisionId, VERIFICATION_SUMMARY_REVISION_MAX_LENGTH),
    scopePaths,
    fieldDiff,
  };
}

async function resolveVerificationSummary(
  payload: LifecycleGateRefPayload,
  actorCtx: ReviewActorContext,
): Promise<LifecycleResolveEnvelopeFor<"verification_summary">> {
  const { runId, reviewTaskId } = payload;
  const absent = absentEnvelope("verification_summary");
  const read = await enforceReviewRunAccess(
    runId,
    actorCtx.actor,
    "read",
    actorCtx.roleHints,
  );
  if (!read.ok) return absent;
  // The record hangs off the gate ROW id, so the gate is resolved first. A
  // missing gate or missing record is `absent` — there is no reading to show.
  const gate = await readReviewGate(runId, reviewTaskId);
  if (!gate) return absent;
  const record = await readVerificationRecordForGate(gate.id);
  if (!record) return absent;
  // A record this build cannot read is indistinguishable from no record at all.
  const body = projectVerificationBody(record);
  if (!body) return absent;
  // §VII: the verification card "carries no floor at all — it asks nothing, so
  // it draws nothing to press". What it DOES have is a reading, and the reading
  // travels here — a card that resolved `advisory` with nothing to draw could
  // never be drawn.
  return { kind: "verification_summary", state: { state: "advisory" }, body };
}

/**
 * The trigger schedule proposal (§VI) resolves `absent` HERE — and that is the
 * finished state, not the S1 placeholder it replaces.
 *
 * Its live resolver is `POST /api/lifecycle-views/resolve`, which handles the
 * kind BEFORE reaching this dispatcher and calls
 * `resolveTriggerScheduleProposalCard` directly. It has to: §VI's card needs a
 * typed BODY — the option rows before Confirm, the trigger's chrome after — and
 * this dispatcher's contract is the STATE alone. Resolving it in both places
 * would be two answers to one question, free to disagree, with the card able to
 * draw a `pending` floor over a settled body.
 *
 * Keeping the arm inert also keeps a MEASURED promise. This module is reachable
 * from the self-MCP surface (`lifecycle-pull-mcp` authorizes through it), which
 * the app's auth plugins mount, so anything it can reach lands on five locked
 * dev-perf route graphs. Delegating here put the card resolver and its view
 * schema on all five for a path production never takes — the route-graph
 * ratchet measured it. `lifecycle-pull-mcp`'s render primitives only ever pass
 * the two gate-scoped kinds, so nothing is lost.
 *
 * A test pins the route as the ONLY resolver, so "filling in" this arm later is
 * a deliberate act rather than a quiet re-import.
 */
async function resolveTriggerScheduleProposal(): Promise<
  LifecycleResolveEnvelopeFor<"trigger_schedule_proposal">
> {
  return absentEnvelope("trigger_schedule_proposal");
}

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

/**
 * Resolve one lifecycle card's authoritative answer: the state ladder, and the
 * body its kind is authorized to carry. NEVER throws and never distinguishes a
 * denial from an absence: a store failure, a malformed ref and a forbidden row
 * all answer the same bodyless `absent`.
 */
export async function resolveLifecycleCardState(params: {
  viewType: LifecycleDataPartViewType;
  ref: string;
  actorCtx: ReviewActorContext;
}): Promise<LifecycleResolveEnvelope> {
  const { viewType, ref, actorCtx } = params;
  try {
    switch (viewType) {
      case "artifact_review_gate": {
        const payload = decodeLifecycleGateRef(ref);
        // The review card draws its target through its own island, so its
        // envelope carries state and no body — and the parse REFUSES one.
        return {
          kind: "artifact_review_gate",
          state: payload ? await resolveReviewGateState(payload, actorCtx) : ABSENT,
          body: null,
        };
      }
      case "verification_summary": {
        const payload = decodeLifecycleGateRef(ref);
        return payload
          ? await resolveVerificationSummary(payload, actorCtx)
          : absentEnvelope("verification_summary");
      }
      case "trigger_schedule_proposal":
        return await resolveTriggerScheduleProposal();
    }
  } catch {
    // A store/transport failure must not become an existence signal either.
    return absentEnvelope(viewType);
  }
}
