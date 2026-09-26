import "server-only";

// ---------------------------------------------------------------------------
// The lifecycle card REF CODEC (cinatra#2566, epic #2564 S2 — extracted from
// S1's `lifecycle-card-refetch.ts` without a byte of behaviour change).
//
// S1 minted and decoded refs inside the refetch module, which is the right home
// for the RESOLVER but the wrong home for the MINT: the gate emission path
// (`packages/agents/src/execution.ts`) has to mint a ref when it marks a review
// gate, and importing the resolver there would drag the whole review-gate store
// + verification store graph into the run executor for two functions that need
// nothing but `node:crypto`. So the codec lives here, alone, and the refetch
// module re-exports it — S1's import surface is unchanged.
//
// The doctrine is S1's and is restated because it is load-bearing, not
// decorative:
//
//   THE REF IS NOT A CAPABILITY. It addresses a row; it grants nothing. Every
//   resolve and every decision re-runs the reader's access from scratch, so
//   forging or replaying a ref buys exactly one thing: an `absent`.
//
//   IT IS OPAQUE ON PURPOSE. A lifecycle envelope persists in
//   `assistant_turns.content` and is re-fed to the model, so a reversible ref
//   would hand the model — and every later reader of that transcript — run and
//   gate identifiers it never asked for and cannot otherwise see. The payload is
//   therefore authenticated-encrypted (AES-256-GCM) under a key derived from the
//   app secret.
//
//   FAIL-CLOSED ON KEY TROUBLE. A missing secret or a rotated key yields `null`
//   (no ref minted / nothing decoded → `absent`). Rotating the secret retires
//   the cards in already-persisted transcripts; runs and review pages stand
//   unaffected.
// ---------------------------------------------------------------------------

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

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
// The RUN-SCOPED SCHEDULE ref (cinatra#2788, epic #2784 S9d).
//
// §VI's card has two identities, because its subject has two lives. In a
// CONVERSATION the ref IS the proposal — a signed, single-use, expiring token
// minted for (viewer, organization, template), because before Confirm nothing
// exists to address. On the RUN PAGE and the REVIEW PAGE there is no such token
// to carry: those surfaces arrive by URL, hold no turn, and know a RUN. So the
// same card is addressed there by the run it settled into, and the resolver
// re-derives (viewer, organization, template) from the proposal's own consume
// row — which is exactly the plan's "keyed by (viewer, organization, template)"
// binding, read off the one row that records all three.
//
// A SEPARATE KEY LABEL, NOT A SEPARATE MODULE. The label below is derived from
// the app secret with a DIFFERENT info string than the gate ref's, so the two
// ref families are cryptographically disjoint: a gate ref presented to the
// schedule resolver does not decode, and a schedule ref presented to the review
// resolver does not either. That is what keeps "one ref addresses one kind of
// thing" true without a discriminator byte a caller could flip.
//
// STILL NOT A CAPABILITY. It addresses a run and grants nothing: the resolver
// re-runs the reader's run access and the proposal's own (viewer, org) binding
// on every call, so replaying one buys an `absent`.
// ---------------------------------------------------------------------------

/** Key-derivation label for the run-scoped schedule ref — disjoint from the
 *  gate ref's by construction. */
const SCHEDULE_RUN_REF_KEY_INFO = "cinatra:lifecycle-schedule-run-ref:v1";

function scheduleRunRefKey(): Buffer | null {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret).update(SCHEDULE_RUN_REF_KEY_INFO).digest();
}

/** What a run-scoped schedule ref addresses. */
export type ScheduleRunRefPayload = {
  runId: string;
  /**
   * The reference was minted where the run's OWN schedule step opened, in a
   * conversation (cinatra#3044).
   *
   * WHY THE REFERENCE CARRIES IT. The drawing's five readings are readings of
   * ONE card that was drawn in a conversation, and the fifth — a fired one-off,
   * rows read-only, no floor at all — has to keep being drawn after the schedule
   * is spent. The resolver cannot tell that card apart from a run that never had
   * a schedule step by looking at the trigger row: both end as an immediate row
   * with no proposal behind them, and the run row's own record of the moment is
   * cleared when the moment ends. The reference is the one durable thing that
   * outlives it — it is written into the turn's content and read back from there
   * for as long as the conversation exists.
   *
   * IT IS NOT A CAPABILITY AND NOT A CALLER'S FIELD. The whole payload is sealed
   * under this family's own key, so the stamp is only ever present because a
   * server minting site put it there; the resolver still re-runs the reader's
   * access on every call, and a stamped reference replayed by somebody else
   * still buys an absence.
   *
   * OMITTED, NEVER FALSE, ON THE WIRE: a reference minted anywhere else is
   * byte-for-byte what it has always been, and every reference minted before
   * this change decodes exactly as it did.
   */
  fromScheduleStep?: boolean;
};

/**
 * Encode a run-scoped schedule ref. `null` when the id does not fit the bounds
 * or no key is available — a host that cannot mint its ref draws no card rather
 * than one that would be dropped downstream.
 */
export function encodeScheduleRunRef(payload: ScheduleRunRefPayload): string | null {
  const { runId, fromScheduleStep } = payload;
  if (typeof runId !== "string" || runId.length === 0 || runId.length > REF_FIELD_MAX) {
    return null;
  }
  const key = scheduleRunRefKey();
  if (!key) return null;
  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([
      cipher.update(
        JSON.stringify(fromScheduleStep === true ? { r: runId, s: 1 } : { r: runId }),
        "utf8",
      ),
      cipher.final(),
    ]);
    const ref = Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
    return ref.length <= REF_MAX ? ref : null;
  } catch {
    return null;
  }
}

/** Decode a run-scoped schedule ref. `null` for anything that is not one. */
export function decodeScheduleRunRef(ref: string): ScheduleRunRefPayload | null {
  if (typeof ref !== "string" || ref.length === 0 || ref.length > REF_MAX) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(ref)) return null;
  const key = scheduleRunRefKey();
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
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const { r, s: step } = parsed as { r?: unknown; s?: unknown };
    if (typeof r !== "string" || r.length === 0 || r.length > REF_FIELD_MAX) return null;
    // The stamp is present or it is not — anything else is read as absent
    // rather than as a truth value, which is what keeps an older reference
    // decoding exactly as it always did.
    return step === 1 ? { runId: r, fromScheduleStep: true } : { runId: r };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The SCHEDULE-FORM ref (cinatra#2934, lifecycle-b W5c).
//
// The schedule screen's window sits under the SCHEDULER FORM, not under the run's
// HITL gate row, so it needs a ref of its own to be bound by. It addresses one
// RUN: the form is the run's, there is one of it, and its rows are declared by
// `schedule-form-screen.ts` rather than read out of a row.
//
// A THIRD KEY LABEL, disjoint from both families above by construction: a gate
// ref presented here does not decode, a schedule-form ref presented to the gate
// resolver does not either, and neither decodes as cinatra#2788's run-scoped
// schedule CARD ref. That is what keeps "one ref addresses one kind of thing"
// true without a discriminator byte a caller could flip.
//
// STILL NOT A CAPABILITY. It addresses a run and grants nothing: the resolver
// re-runs the reader's run access on every call, and the form it names lends
// `fill` and no press at all.
// ---------------------------------------------------------------------------

/** Key-derivation label for the schedule-FORM ref — disjoint from both others. */
const SCHEDULE_FORM_REF_KEY_INFO = "cinatra:lifecycle-schedule-form-ref:v1";

function scheduleFormRefKey(): Buffer | null {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret).update(SCHEDULE_FORM_REF_KEY_INFO).digest();
}

/** What a schedule-form ref addresses: the run whose scheduler form is in view. */
export type ScheduleFormRefPayload = { runId: string };

/** Encode a schedule-form ref. `null` when it cannot be expressed. */
export function encodeScheduleFormRef(payload: ScheduleFormRefPayload): string | null {
  const { runId } = payload;
  if (typeof runId !== "string" || runId.length === 0 || runId.length > REF_FIELD_MAX) {
    return null;
  }
  const key = scheduleFormRefKey();
  if (!key) return null;
  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([
      cipher.update(JSON.stringify({ r: runId }), "utf8"),
      cipher.final(),
    ]);
    const ref = Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
    return ref.length <= REF_MAX ? ref : null;
  } catch {
    return null;
  }
}

/** Decode a schedule-form ref. `null` for anything that is not one. */
export function decodeScheduleFormRef(ref: string): ScheduleFormRefPayload | null {
  if (typeof ref !== "string" || ref.length === 0 || ref.length > REF_MAX) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(ref)) return null;
  const key = scheduleFormRefKey();
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
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const { r } = parsed as { r?: unknown };
    if (typeof r !== "string" || r.length === 0 || r.length > REF_FIELD_MAX) return null;
    return { runId: r };
  } catch {
    return null;
  }
}
