import "server-only";

// ---------------------------------------------------------------------------
// The AUTHORITATIVE REFETCH contract for lifecycle cards (cinatra#2565,
// epic #2564 S1). Design: design@6c20871b4108176c1d0193f19ecd2947f6c6355f
// `specs/app-lifecycle-cards.html` at that commit §IV.
//
// A lifecycle DATA_PART carries an opaque ref and nothing else, so EVERY fact a
// card shows has to come from here: given a ref and the reader, resolve the
// state the card may draw right now. That is what makes a persisted transcript
// safe to keep — the bytes in the thread say nothing, and a reader who lost
// access between the turn and the reload sees the card disappear rather than a
// stale snapshot of what they used to be allowed to see.
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

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

import {
  enforceReviewRunAccess,
  readReviewGate,
  readReviewGateState,
} from "@cinatra-ai/agents/artifact-review-gate-store";
import { readVerificationRecordForGate } from "@cinatra-ai/agents/lifecycle-verification-store";
import type {
  LifecycleCardState,
  LifecycleDataPartViewType,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";

/** The generic "nothing to draw" answer. Every denial path lands here. */
const ABSENT: LifecycleCardState = { state: "absent" };

/**
 * The reason a reader sees on a `restricted` card. It describes the READER's
 * standing on the run and names nothing about the item — no gate id, no policy
 * id, no counts. §IV requires the reason on screen; the refusal contract
 * requires it to be non-enumerating, and a fixed sentence satisfies both.
 */
export const LIFECYCLE_RESTRICTED_REASON =
  "Approving or rejecting needs approve access on this run.";

// ---------------------------------------------------------------------------
// The ref codec — genuinely opaque, stateless, fail-closed
// ---------------------------------------------------------------------------
//
// "Opaque" has to mean opaque, not "base64", or the ref stops being a ticket
// and becomes a disclosure: a lifecycle envelope is persisted in
// `assistant_turns.content` and re-fed to the model, so a reversible ref would
// hand the model (and every later reader of the transcript) run and gate
// identifiers it never asked for and cannot otherwise see through a card.
//
// So the payload is AUTHENTICATED-ENCRYPTED (AES-256-GCM) under a key derived
// from the app secret, exactly as the chat/agent-run MCP actor tokens are
// keyed. That keeps the resolve STATELESS — no new table, no new row lifecycle
// — while making the ref unreadable and untamperable off the wire.
//
// The ref is still NOT a capability. Decrypting it proves only that the server
// minted it; the resolver re-authorizes the reader from scratch, so a replayed
// ref for a gate the reader lost access to answers `absent`.
//
// FAIL-CLOSED on key trouble: a missing secret or a rotated key yields `null`
// (no ref minted / no state resolved → `absent`). A rotated secret therefore
// retires the cards in old transcripts rather than resurrecting them wrongly;
// the run and review pages are unaffected.

/**
 * What a gate-scoped ref addresses. Both the review gate and the verification
 * summary hang off a run's gate, so they share one payload shape (and one
 * access check — the run's).
 */
export type LifecycleGateRefPayload = { runId: string; reviewTaskId: string };

// Bounds keep an encoded ref inside LIFECYCLE_VIEW_REF_MAX_LENGTH (512), which
// in turn keeps the producer envelope inside the runtime's tool-result cap.
const REF_FIELD_MAX = 128;
const REF_MAX = 512;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Key-derivation label — changing it rotates every ref by construction. */
const REF_KEY_INFO = "cinatra:lifecycle-card-ref:v1";

function refKey(): Buffer | null {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret).update(REF_KEY_INFO).digest();
}

/**
 * Encode a gate-scoped ref. Returns `null` when the ids do not fit the bounds
 * or no key is available — a producer that cannot express its ref must refuse
 * rather than emit one that would be dropped downstream.
 */
export function encodeLifecycleGateRef(
  payload: LifecycleGateRefPayload,
): string | null {
  const { runId, reviewTaskId } = payload;
  if (typeof runId !== "string" || runId.length === 0 || runId.length > REF_FIELD_MAX) {
    return null;
  }
  if (
    typeof reviewTaskId !== "string" ||
    reviewTaskId.length === 0 ||
    reviewTaskId.length > REF_FIELD_MAX
  ) {
    return null;
  }
  const key = refKey();
  if (!key) return null;
  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([
      cipher.update(JSON.stringify({ r: runId, g: reviewTaskId }), "utf8"),
      cipher.final(),
    ]);
    const ref = Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
    return ref.length <= REF_MAX ? ref : null;
  } catch {
    return null;
  }
}

/** Decode a gate-scoped ref. `null` for anything that is not one of ours. */
export function decodeLifecycleGateRef(
  ref: string,
): LifecycleGateRefPayload | null {
  if (typeof ref !== "string" || ref.length === 0 || ref.length > REF_MAX) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(ref)) return null;
  const key = refKey();
  if (!key) return null;
  try {
    const raw = Buffer.from(ref, "base64url");
    if (raw.length <= IV_BYTES + TAG_BYTES) return null;
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(raw.length - TAG_BYTES);
    const body = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const { r, g } = parsed as { r?: unknown; g?: unknown };
    if (typeof r !== "string" || r.length === 0 || r.length > REF_FIELD_MAX) return null;
    if (typeof g !== "string" || g.length === 0 || g.length > REF_FIELD_MAX) return null;
    return { runId: r, reviewTaskId: g };
  } catch {
    // Wrong key, tampered bytes, non-JSON plaintext — all "not one of ours".
    return null;
  }
}

// ---------------------------------------------------------------------------
// The per-kind resolvers
// ---------------------------------------------------------------------------

async function resolveReviewGate(
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

async function resolveVerificationSummary(
  payload: LifecycleGateRefPayload,
  actorCtx: ReviewActorContext,
): Promise<LifecycleCardState> {
  const { runId, reviewTaskId } = payload;
  const read = await enforceReviewRunAccess(
    runId,
    actorCtx.actor,
    "read",
    actorCtx.roleHints,
  );
  if (!read.ok) return ABSENT;
  // The record hangs off the gate ROW id, so the gate is resolved first. A
  // missing gate or missing record is `absent` — there is no reading to show.
  const gate = await readReviewGate(runId, reviewTaskId);
  if (!gate) return ABSENT;
  const record = await readVerificationRecordForGate(gate.id);
  if (!record) return ABSENT;
  // §VII: the verification card "carries no floor at all — it asks nothing, so
  // it draws nothing to press".
  return { state: "advisory" };
}

/**
 * The trigger schedule proposal (§VI) has a Confirm/Adjust floor whose
 * single-use proposal token, store and arm-before-expose sequence are S5's
 * (#2569). Until that producer exists there is no row to authorize against, and
 * the honest answer is `absent` — a placeholder that rendered a floor with no
 * proposal behind it would be exactly the "AI arms a schedule" failure the epic
 * forbids. S5 replaces this body; the wire type, the registry entry and this
 * dispatch arm are already in place so it fills a seam rather than adding one.
 */
async function resolveTriggerScheduleProposal(): Promise<LifecycleCardState> {
  return ABSENT;
}

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

/**
 * Resolve one lifecycle card's authoritative state. NEVER throws and never
 * distinguishes a denial from an absence: a store failure, a malformed ref and
 * a forbidden row all answer `absent`.
 */
export async function resolveLifecycleCardState(params: {
  viewType: LifecycleDataPartViewType;
  ref: string;
  actorCtx: ReviewActorContext;
}): Promise<LifecycleCardState> {
  const { viewType, ref, actorCtx } = params;
  try {
    switch (viewType) {
      case "artifact_review_gate": {
        const payload = decodeLifecycleGateRef(ref);
        return payload ? await resolveReviewGate(payload, actorCtx) : ABSENT;
      }
      case "verification_summary": {
        const payload = decodeLifecycleGateRef(ref);
        return payload ? await resolveVerificationSummary(payload, actorCtx) : ABSENT;
      }
      case "trigger_schedule_proposal":
        return await resolveTriggerScheduleProposal();
    }
  } catch {
    // A store/transport failure must not become an existence signal either.
    return ABSENT;
  }
}
