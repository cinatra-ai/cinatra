import "server-only";

// ---------------------------------------------------------------------------
// Run-start recommendation HOLD/RELEASE (cinatra#2067, epic #2037 C3).
//
// The pre-execution hold that finishes the #2041 S3 chip-row surface: a
// HUMAN-PRESENT run PARKS at the run-start recommendation interception (reusing
// the S0 parked-continuation machinery) until the human confirms / adjusts /
// skips the recommended skill set; the decision RELEASES the park and the run
// dispatches. A HEADLESS run NEVER reaches here (the interactive run-start seams
// are the only callers, and `run.humanPresent` gates it a second time), so the
// S3 headless auto-apply path stays byte-identical.
//
//   maybeHoldRunForRecommendation — the pre-dispatch decision. Evaluates the
//     recommendation checkpoint with the SAME lattice the headless path uses
//     (`evaluatePolicy`, humanPresent:true) + the org rule + the agent manifest.
//     Parks ONLY when the checkpoint fires AND the request-aware scorer returns
//     at least one candidate; a policy-forbidden / policy-skipped / empty-
//     candidate run returns `held:false` and the caller dispatches normally
//     (issue #2067 item 3 — the row appears only when the checkpoint fires).
//   resolveRecommendationCandidateSkillIds — the ONE candidate-set seam every
//     chip-row surface resolves through (cinatra#2148 finding 1), actor-scoped
//     to the RUN's own owner/org.
//   readRecommendationParkForRun — the run's recommendation park (parked or
//     released), the chip-row's appearance discriminator in the run view.
//   releaseRecommendationParkForRun — release the park via the S0 sweeper when
//     the human decides (confirm/adjust/skip); a no-op when no live park exists.
//
// The park's protected effect is `none`: this holds the RUN's own execution
// (pre-dispatch), not a downstream external effect, so there is nothing to
// fail-closed-block — an abandoned held run simply stays an un-dispatched
// pending_input run (exactly today's abandoned-setup behavior).
// ---------------------------------------------------------------------------

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

import {
  LIFECYCLE_INTERACTION_SCHEMA_VERSION,
  LIFECYCLE_INTERRUPT_RENDERER_IDS,
  LIFECYCLE_VIEW_REF_MAX_LENGTH,
  declaresLifecycleInteraction,
  readLifecycleInterruptInteraction,
} from "@cinatra-ai/agent-ui-protocol/renderable-views/lifecycle-cards";
import type { InterruptEvent, ResumeEvent } from "@cinatra-ai/agent-ui-protocol";

import { evaluatePolicy } from "@/lib/lifecycle/lifecycle-policy";
import { evaluateThenPark } from "@/lib/lifecycle/lifecycle-continuation";
import { isRecommendationChipRowHoldActive } from "@/lib/lifecycle/lifecycle-activation";
import { getAssignedSkillIdsForAgent } from "@/lib/agents-store";
import { resolveAssignedSkillsActorForRun } from "@/lib/agent-run-actor-resolve";

import { resolveOrgPolicyRule, POLICY_ARTIFACT_TYPE_WILDCARD } from "./lifecycle-policy-store";
import { getRunRecommendations, parseLifecycleConfig } from "./recommendation-interception";
import {
  maybeParkCheckpoint,
  sweepParks,
  readContinuationParksForRun,
  type ParkRow,
} from "./lifecycle-continuation-park-store";
import type { AgentRunRecord, AgentTemplateRecord } from "./store";

/** The lifecycle checkpoint the run-start chip-row hold parks on. */
export const RECOMMENDATION_CHECKPOINT = "recommendation" as const;

/** The event id the recommendation park is keyed on. ONE recommendation park
 * per run (the park is unique on (run_id, event_id, checkpoint)), so a per-run
 * constant is correct and makes the park idempotent across retried holds. */
export function recommendationHoldEventId(runId: string): string {
  return `recommendation:run-start:${runId}`;
}

export type MaybeHoldResult =
  | { held: false; reason: string }
  | { held: true; parkId: string; reason: string };

// ---------------------------------------------------------------------------
// The hold on the RUN WIRE (cinatra#2568, epic #2564 S4)
// ---------------------------------------------------------------------------
//
// S1 declared `recommendation_hold` as the one lifecycle kind whose carriage is
// `interrupt` — the run is genuinely BLOCKED on the answer. This section fills
// that named seam: the typed INTERRUPT the hold mints, the opaque ref that
// addresses THIS hold instance, and the LIVE-STATE SNAPSHOT a late joiner is
// reconstructed from.
//
// WHY A SNAPSHOT AND NOT A REPLAY. The event log is durable and a run can
// re-enter `pending_input` and be parked AGAIN, so its log can hold several
// hold interrupts of which at most one is live. Replaying history would
// resurrect a decided hold — the exact stale-gate failure cinatra#809 fixed for
// terminal runs. So the park table stays the ONLY authority on "is this run
// held, and by which hold": the wire announces, the park decides. Same shape as
// `deriveRunHitlContext`, which reads the run's CURRENT state rather than
// trusting what the log happens to contain.

/**
 * The ONE refusal these decisions give when the caller may not act (cinatra#2568, the S1
 * generic-refusal contract).
 *
 * The previous per-branch strings — "unauthorized", "run not found",
 * "forbidden", "selection not authorized" — were an ENUMERATION ORACLE: a
 * caller holding a guessed run id could tell "no such run" from "exists, not
 * yours" from "yours, wrong tier", and read a run's existence and ownership off
 * a decision endpoint. The AUTHORIZATION DECISIONS ARE UNCHANGED by this
 * constant; only what a refused caller learns is. Retryable, self-referential
 * failures (the hold could not be released; a connector/LLM preflight the
 * caller can fix) keep their own actionable messages — those describe the
 * CALLER'S OWN next step and enumerate nothing about anyone else's rows.
 *
 * Lives HERE rather than beside the actions that use it: that module is a
 * `"use server"` file, and Next allows a server-action module to export async
 * FUNCTIONS only — a constant export there fails the production build (and only
 * the production build; typecheck and vitest are both happy with it).
 */
export const RECOMMENDATION_DECISION_REFUSAL =
  "This run's skill selection cannot be decided from here.";

/**
 * A SKIP that could not be recorded. The skip evidence is the card's settled
 * state, so a decision this build cannot persist must not release the run
 * either — the person would be left with a dispatched run and a card that
 * silently vanished. Lives here for the same reason the refusal above does: a
 * `"use server"` module may export async functions only.
 */
export const RECOMMENDATION_SKIP_NOT_RECORDED =
  "This run's skill decision could not be recorded, so the run was left waiting. Try again.";

/**
 * The TYPED discriminator for the refusal above. The message is prose meant for
 * a person and may be reworded at any time; a caller that needs to branch on
 * "the skip was not recorded" — to offer a retry rather than a generic failure,
 * or to assert the outcome in a test — matches on this instead of on the copy.
 * It rides `RunRecommendationDecisionResult.code`, the same field the run
 * preflight already uses to carry an actionable outcome.
 */
export const RECOMMENDATION_SKIP_NOT_RECORDED_CODE = "recommendation_skip_not_recorded";

/** The `xRenderer` the typed hold interrupt declares. */
export const RECOMMENDATION_HOLD_RENDERER_ID =
  LIFECYCLE_INTERRUPT_RENDERER_IDS.recommendation_hold;

/** What a hold ref addresses: the run, and the hold INSTANCE within it. */
export type RecommendationHoldRefPayload = { runId: string; holdId: string };

// The ref codec. Authenticated-encrypted (AES-256-GCM) under a key derived from
// the app secret, mirroring the S1 lifecycle-card ref: opaque means opaque, so
// a consumer holding the event learns nothing from it, and a tampered ref does
// not decode. It is NOT a capability — the card's refetch re-authorizes the
// reader from scratch, so forging one buys an `absent`.
//
// DOMAIN-SEPARATED from the S1 gate ref by its key label AND its plaintext
// field names (`p` for the park, where the gate ref uses `g`): a gate ref can
// never be replayed as a hold ref, or the reverse, even though both are minted
// by the same instance.
const HOLD_REF_KEY_INFO = "cinatra:lifecycle-hold-ref:v1";
const HOLD_REF_FIELD_MAX = 128;
const HOLD_REF_IV_BYTES = 12;
const HOLD_REF_TAG_BYTES = 16;

function holdRefKey(): Buffer | null {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret).update(HOLD_REF_KEY_INFO).digest();
}

/**
 * Encode a hold ref. `null` when the ids do not fit the bounds or no key is
 * available — a producer that cannot express its ref refuses rather than
 * emitting one that would be dropped downstream.
 */
export function encodeRecommendationHoldRef(
  payload: RecommendationHoldRefPayload,
): string | null {
  const { runId, holdId } = payload;
  if (typeof runId !== "string" || runId.length === 0 || runId.length > HOLD_REF_FIELD_MAX) {
    return null;
  }
  if (typeof holdId !== "string" || holdId.length === 0 || holdId.length > HOLD_REF_FIELD_MAX) {
    return null;
  }
  const key = holdRefKey();
  if (!key) return null;
  try {
    const iv = randomBytes(HOLD_REF_IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([
      cipher.update(JSON.stringify({ r: runId, p: holdId }), "utf8"),
      cipher.final(),
    ]);
    const ref = Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
    return ref.length <= LIFECYCLE_VIEW_REF_MAX_LENGTH ? ref : null;
  } catch {
    return null;
  }
}

/** Decode a hold ref. `null` for anything that is not one of ours. */
export function decodeRecommendationHoldRef(
  ref: string,
): RecommendationHoldRefPayload | null {
  if (typeof ref !== "string" || ref.length === 0 || ref.length > LIFECYCLE_VIEW_REF_MAX_LENGTH) {
    return null;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(ref)) return null;
  const key = holdRefKey();
  if (!key) return null;
  try {
    const raw = Buffer.from(ref, "base64url");
    if (raw.length <= HOLD_REF_IV_BYTES + HOLD_REF_TAG_BYTES) return null;
    const iv = raw.subarray(0, HOLD_REF_IV_BYTES);
    const tag = raw.subarray(raw.length - HOLD_REF_TAG_BYTES);
    const body = raw.subarray(HOLD_REF_IV_BYTES, raw.length - HOLD_REF_TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const { r, p } = parsed as { r?: unknown; p?: unknown };
    if (typeof r !== "string" || r.length === 0 || r.length > HOLD_REF_FIELD_MAX) return null;
    if (typeof p !== "string" || p.length === 0 || p.length > HOLD_REF_FIELD_MAX) return null;
    return { runId: r, holdId: p };
  } catch {
    // Wrong key, tampered bytes, non-JSON plaintext, or a ref of another domain
    // (an S1 gate ref decrypts to `{r,g}` and fails the `p` check) — all "not
    // one of ours".
    return null;
  }
}

/**
 * Build the typed hold INTERRUPT. Pure — no I/O, so the SSE route can synthesize
 * the same frame the producer published and a test can assert one shape.
 *
 * `values` and `schema` are deliberately EMPTY: the wire payload is the ref and
 * nothing else. `reviewTaskId` is the hold's stable per-run gate identity, the
 * same synthetic-identity convention `deriveRunHitlContext` already uses
 * (`wayflow-…`, `setup-…`) — it names WHICH question the run is paused on and
 * is not a review-task row. The `interaction` discriminator is what stops any
 * consumer from treating it as one.
 *
 * Returns `null` when no ref can be minted (no app secret / oversized ids): an
 * interrupt without a resolvable ref would render a card that can never refetch,
 * so nothing is emitted at all.
 */
export function buildRecommendationHoldInterrupt(input: {
  runId: string;
  threadId: string;
  holdId: string;
}): InterruptEvent | null {
  const ref = encodeRecommendationHoldRef({
    runId: input.runId,
    holdId: input.holdId,
  });
  if (!ref) return null;
  return {
    type: "INTERRUPT",
    threadId: input.threadId,
    runId: input.runId,
    schema: {},
    xRenderer: RECOMMENDATION_HOLD_RENDERER_ID,
    values: {},
    reviewTaskId: recommendationHoldEventId(input.runId),
    interaction: {
      kind: "recommendation_hold",
      schemaVersion: LIFECYCLE_INTERACTION_SCHEMA_VERSION,
      ref,
    },
    timestamp: Date.now(),
  };
}

/**
 * The reserved hold id a RETIREMENT names: "this run has no live hold".
 *
 * A client cannot tell WHICH hold a lifecycle RESUME names — the ref is opaque
 * to it — so the wire meaning of one is simply "no lifecycle interaction is
 * live on this run". The SSE route needs to be able to SAY that at stream open:
 * a reconnecting client may be showing a hold that ended while it was
 * disconnected, and "not held" expressed as SILENCE would leave that card up
 * forever. Park ids are uuids, so this value can never collide with one; a log
 * frame naming it is rejected outright (see `readRecommendationHoldFromEvent`)
 * because only a synthesized snapshot may claim it.
 */
export const RECOMMENDATION_HOLD_NONE = "none";

/**
 * The paired RESUME. Emitted ONLY after a decision's release is VERIFIED, and
 * BOUND to the hold instance it retires: a RESUME for hold H must never clear a
 * card showing hold H'. Returns `null` when no ref can be minted, for the same
 * reason the interrupt does — an unpaired RESUME would be a blunt "clear
 * whatever you are showing", which is the failure this pairing exists to stop.
 */
export function buildRecommendationHoldResume(input: {
  runId: string;
  threadId: string;
  holdId: string;
}): ResumeEvent | null {
  const ref = encodeRecommendationHoldRef({
    runId: input.runId,
    holdId: input.holdId,
  });
  if (!ref) return null;
  return {
    type: "RESUME",
    threadId: input.threadId,
    runId: input.runId,
    reviewTaskId: recommendationHoldEventId(input.runId),
    interaction: {
      kind: "recommendation_hold",
      schemaVersion: LIFECYCLE_INTERACTION_SCHEMA_VERSION,
      ref,
    },
    timestamp: Date.now(),
  };
}

/**
 * The synthesized "this run is not held" frame. Not a decision record and never
 * published to the log — the SSE route emits it at stream open so a client that
 * reconnected while a hold ended converges instead of sitting on a stale card.
 */
export function buildRecommendationHoldRetirement(input: {
  runId: string;
  threadId: string;
}): ResumeEvent | null {
  return buildRecommendationHoldResume({
    ...input,
    holdId: RECOMMENDATION_HOLD_NONE,
  });
}

/**
 * Does this frame CLAIM to be a lifecycle interaction? Re-exported so the run's
 * SSE route can gate on presence before it gates on validity — an
 * `INTERRUPT`/`RESUME` that declares an interaction is subject to the hold
 * policy even when its ref cannot be decoded (a frame minted under a rotated
 * secret, a forward version, a forged payload). Forwarding such a frame
 * unfiltered would let it reach clients as an ordinary review-task gate.
 */
export { declaresLifecycleInteraction };

/**
 * Read the hold identity off an event, if it IS a typed hold frame for this run
 * (`INTERRUPT` announcing one, or `RESUME` retiring one). `null` for every other
 * event — an ordinary gate, a forged/foreign ref, or a hold ref minted for a
 * DIFFERENT run (which a cross-run replay would be).
 */
export function readRecommendationHoldFromEvent(
  event: unknown,
  expectedRunId: string,
): RecommendationHoldRefPayload | null {
  const interaction = readLifecycleInterruptInteraction(event);
  if (!interaction || interaction.kind !== "recommendation_hold") return null;
  const payload = decodeRecommendationHoldRef(interaction.ref);
  if (!payload || payload.runId !== expectedRunId) return null;
  // The retirement sentinel is a SYNTHESIZED-frame-only claim. A log frame that
  // names it is not a hold this run ever had, so it identifies nothing.
  if (payload.holdId === RECOMMENDATION_HOLD_NONE) return null;
  return payload;
}

/**
 * The LIVE-STATE SNAPSHOT: the typed hold interrupt for a run's CURRENT hold, or
 * `null` when the run is not held right now.
 *
 * This is the one authority a late joiner (a fresh SSE subscribe, a reload, a
 * reconnect mid-hold) is reconstructed from. It reads the park table, never the
 * event log, so a run that was held, decided, and parked again shows its CURRENT
 * hold only — and a run whose hold was released shows none, however many hold
 * frames its log still carries.
 *
 * Best-effort by contract: any read failure answers `null` (no card), never an
 * exception into the stream.
 */
export type RecommendationHoldSnapshot =
  /** The run IS held, by this hold, right now. */
  | { status: "held"; event: InterruptEvent; holdId: string }
  /** The run is definitively NOT held. */
  | { status: "not_held" }
  /**
   * The park could not be read, or the hold could not be expressed (no app
   * secret). DELIBERATELY its own answer: "I could not find out" must never be
   * reported as "not held", because a surface would then retire a card for a
   * run that is still waiting. Every consumer treats it as "change nothing".
   */
  | { status: "unknown" };

export async function deriveRecommendationHoldSnapshot(input: {
  runId: string;
  threadId: string;
}): Promise<RecommendationHoldSnapshot> {
  let park: ParkRow | null;
  try {
    park = await readRecommendationParkForRun(input.runId);
  } catch {
    return { status: "unknown" };
  }
  if (!park || park.status !== "parked") return { status: "not_held" };
  const event = buildRecommendationHoldInterrupt({
    runId: input.runId,
    threadId: input.threadId,
    holdId: park.id,
  });
  return event ? { status: "held", event, holdId: park.id } : { status: "unknown" };
}

/** The held-or-nothing projection of the snapshot above. */
export async function deriveRecommendationHoldInterrupt(input: {
  runId: string;
  threadId: string;
}): Promise<InterruptEvent | null> {
  const snapshot = await deriveRecommendationHoldSnapshot(input);
  return snapshot.status === "held" ? snapshot.event : null;
}

/**
 * Announce a newly-created hold on the run wire. Fire-and-forget and swallowed
 * on failure: the park is the source of truth and the snapshot above
 * reconstructs the card on the next subscribe, so a Redis hiccup must never
 * fail a run (the module's best-effort contract).
 */
export async function publishRecommendationHoldInterrupt(input: {
  runId: string;
  threadId: string;
  holdId: string;
}): Promise<void> {
  try {
    const event = buildRecommendationHoldInterrupt(input);
    if (!event) return;
    await publishHoldEvent(input.runId, event);
  } catch {
    /* best-effort — the park, not the wire, holds the run */
  }
}

/**
 * Announce that the hold is over. The caller must have VERIFIED the release
 * first: a RESUME on a still-parked run would clear the card while the run is
 * still waiting, which is precisely the false-success this program refuses.
 */
export async function publishRecommendationHoldResume(input: {
  runId: string;
  threadId: string;
  holdId: string;
}): Promise<void> {
  try {
    const event = buildRecommendationHoldResume(input);
    if (!event) return;
    await publishHoldEvent(input.runId, event);
  } catch {
    /* best-effort — see above */
  }
}

/**
 * The AG-UI publish, reached through a DYNAMIC import on purpose.
 *
 * This module is on the pre-dispatch path of every human-present run and is
 * imported by surfaces (the run screens, the trigger service) that have no
 * business pulling the Redis publish/subscribe transport into their graph just
 * to evaluate a policy. The wire is needed only when a hold actually changes
 * state, which is rare — so the transport is loaded at that moment and not at
 * module load. The `buildRecommendationHoldInterrupt` / `derive…` seams above
 * stay pure and transport-free, which is also what lets them be tested without
 * a Redis stub.
 */
async function publishHoldEvent(
  runId: string,
  event: InterruptEvent | ResumeEvent,
): Promise<void> {
  const { publishAgUiEvent } = await import("@cinatra-ai/agent-ui-protocol/server");
  await publishAgUiEvent(runId, event);
}

/** The run projection the candidate resolver needs to derive the run's own
 * actor. A structural subset of `AgentRunRecord`, so every caller can pass its
 * run row directly. */
export type RunForRecommendationCandidates = Pick<AgentRunRecord, "id" | "runBy" | "orgId"> & {
  sourceType?: string | null;
  dependentInstallId?: string | null;
};

/** The actor-scope filter shape `getAssignedSkillIdsForAgent` consumes. Kept to
 * the fields `confirmRunSkillSelectionAction` bounds its authoritative write
 * with — deliberately NO `platformRole` (see below). */
export type RecommendationCandidateActorFilter = {
  principalId: string;
  teamIds: string[];
  projectIds: string[];
  organizationId?: string;
};

/**
 * The ONE candidate-set seam every run-start recommendation surface resolves
 * through (cinatra#2148 finding 1): the hold decision, the run-view chip-row
 * prefetch, the chat-mounted chip-row state, and the skip-evidence writer.
 *
 * Actor-scoped by the RUN's own owner/org — `getAssignedSkillIdsForAgent`
 * deliberately treats an actor-FREE call as the most restrictive non-admin
 * caller, so the previous actor-less calls filtered EVERY scoped
 * (org / workspace / team / project / personal) assignment out of the candidate
 * set and the chip row under-recommended (only platform `system` skills and the
 * agent's own self-match survived).
 *
 * The actor is derived by the canonical, FAIL-CLOSED run→actor resolver
 * (`resolveAssignedSkillsActorForRun`, cinatra#1401) — the same authority the
 * llm-bridge already uses to resolve THIS run's delivered skill set. It expands
 * the owner's LIVE team/project/org membership and then re-gates on the freshest
 * `member` read, so a revoked/demoted owner resolves to `undefined` and we fall
 * back to EXACTLY today's actor-less call — never more.
 *
 * DELIBERATELY drops `platformRole`: the resolved filter carries only
 * `principalId / teamIds / projectIds / organizationId`, the SAME bounding shape
 * `confirmRunSkillSelectionAction` uses for the authoritative write. The
 * candidate set is therefore a subset of what the human's confirm can write
 * (never offering a chip the write would silently drop) and a subset of what the
 * bridge delivers (which does carry the admin short-circuit) — this seam widens
 * reads to the run owner's OWN membership scopes only, never past them via the
 * platform-admin bypass.
 *
 * PRESENTATION surfaces additionally pass `viewer` — the actor whose SCREEN the
 * chips land on. The returned set is then the INTERSECTION of the run's
 * capability and the viewer's own entitlement, which keeps two properties the
 * run-actor set alone cannot give:
 *   - a reader who holds run-READ but is not the run owner can never learn the
 *     owner's personal/team/project-scoped skill NAMES off this surface (the
 *     actor threading must not widen what a viewer can read);
 *   - every offered chip is a chip the viewer's own confirm write would accept
 *     (`confirmRunSkillSelectionAction` bounds with the SAME filter shape), so
 *     a confirm can never silently drop a chip the row offered.
 * For the run owner — the only actor with the execute standing the chip-row's
 * decision requires — the two sets are identical, so the org/workspace
 * assignments AC-a is about appear in full.
 *
 * Best-effort by contract: ANY resolution failure degrades to the actor-less
 * set, and a catalog failure to `[]` — a recommendation read must never fail a
 * run.
 */
export async function resolveRecommendationCandidateSkillIds(input: {
  run: RunForRecommendationCandidates;
  packageName: string;
  /** Present on PRESENTATION surfaces only — see the intersection note above. */
  viewer?: RecommendationCandidateActorFilter;
}): Promise<string[]> {
  const { run, packageName, viewer } = input;
  if (!packageName) return [];

  let actorFilter: RecommendationCandidateActorFilter | undefined;
  try {
    const runActor = await resolveAssignedSkillsActorForRun({
      id: run.id,
      runBy: run.runBy,
      orgId: run.orgId,
      sourceType: run.sourceType ?? null,
      dependentInstallId: run.dependentInstallId ?? null,
    });
    if (runActor) {
      actorFilter = {
        principalId: runActor.principalId,
        teamIds: runActor.teamIds ?? [],
        projectIds: runActor.projectIds ?? [],
        organizationId: runActor.organizationId ?? undefined,
      };
    }
  } catch {
    actorFilter = undefined;
  }

  let runCapabilityIds: string[];
  try {
    runCapabilityIds = actorFilter
      ? await getAssignedSkillIdsForAgent(packageName, actorFilter)
      : await getAssignedSkillIdsForAgent(packageName);
  } catch {
    return [];
  }
  if (!viewer || runCapabilityIds.length === 0) return runCapabilityIds;

  // Presentation intersection. Fail-CLOSED to the viewer's own entitlement: an
  // unreadable viewer set yields no chips rather than falling back to the wider
  // run-capability set.
  let viewerIds: string[];
  try {
    viewerIds = await getAssignedSkillIdsForAgent(packageName, viewer);
  } catch {
    return [];
  }
  const viewerSet = new Set(viewerIds);
  // Order is preserved from the run-capability resolve, which is itself a pure
  // function of DB state — so the rendered chip order stays deterministic.
  return runCapabilityIds.filter((id) => viewerSet.has(id));
}

/**
 * Decide whether a human-present run PARKS at the run-start recommendation
 * interception. Best-effort by contract — a recommendation write must never
 * fail a run — so the caller wraps this and, on ANY throw, dispatches normally
 * (fail-OPEN to today's behavior: no hold).
 *
 * Parks IFF: the run is human-present AND the recommendation checkpoint FIRES
 * (org rule + manifest, humanPresent:true) AND the request-aware scorer returns
 * at least one candidate. Otherwise returns `held:false` and the caller
 * dispatches the run unchanged.
 *
 * `held` answers "IS this run held?", NOT "did I just create a park" — a run
 * that is ALREADY parked answers `held:true` with the existing park id and
 * creates no second park (cinatra#2148). Answering `held:false` there made the
 * result unsafe for any caller without its own live-park pre-check: a RETRIED
 * run-start (a second immediate trigger, a double-clicked Run) would sail past
 * the live park and dispatch the very run the human is still deciding on.
 */
export async function maybeHoldRunForRecommendation(input: {
  run: Pick<AgentRunRecord, "id" | "orgId" | "humanPresent" | "inputParams" | "runBy"> & {
    sourceType?: string | null;
    dependentInstallId?: string | null;
    /** Thread identity for the run's AG-UI frames — the same value the
     * execution adapter uses (`new AgUiAdapter(runId, run.templateId, …)`), so
     * the hold's interrupt sits on the same thread as the run's own events.
     * Optional so every existing caller keeps compiling; falls back to the run
     * id, which is what a single-run thread degenerates to anyway. */
    templateId?: string | null;
  };
  template: Pick<AgentTemplateRecord, "packageName"> & {
    lifecycleConfig?: string | null;
  };
}): Promise<MaybeHoldResult> {
  const { run, template } = input;

  // Global activation switch (DEFAULT ON per the #2047 ruling). A deployment
  // that sets CINATRA_LIFECYCLE_RECOMMENDATION_CHIP_ROW=off gets the pre-flip
  // posture: the chip-row hold is inert and every run dispatches unheld (the S3
  // headless auto-apply stays byte-identical either way).
  if (!isRecommendationChipRowHoldActive()) return { held: false, reason: "fence off" };

  // Only an interactively-started, present-human run may park. A headless origin
  // (null/false) proceeds exactly as the S3 engine does today.
  if (run.humanPresent !== true) return { held: false, reason: "headless" };

  const packageName = template.packageName;
  if (!packageName) return { held: false, reason: "no package name" };

  // Idempotency + re-entry guard: if a recommendation park ALREADY exists for
  // this run, never create a new one. Two cases, and they answer DIFFERENTLY:
  //   parked  → the human has NOT decided yet. The run is held; say so, with the
  //             existing park id, so a retried run-start (a second immediate
  //             trigger, a double-clicked Run) cannot dispatch past a live park
  //             (cinatra#2148). No second park row is written.
  //   released / policy_unresolved → terminal. The human decided (or the TTL
  //             sweeper fail-closed the park), so the run dispatches. Without
  //             this branch `maybeParkCheckpoint`'s (run,event,checkpoint)
  //             conflict would hand back the TERMINAL park as a fresh hold and
  //             re-hold a run that is already done deciding.
  const existing = await readRecommendationParkForRun(run.id);
  if (existing) {
    return existing.status === "parked"
      ? { held: true, parkId: existing.id, reason: "recommendation already parked" }
      : { held: false, reason: `recommendation ${existing.status}` };
  }

  // Resolve the org bound for the recommendation checkpoint (PRE-production, so
  // resolved over the wildcard artifact type — an org expresses "require
  // recommendation for all this agent's runs" via the `*` rule). Without an
  // orgId the checkpoint stays silent → the humanPresent lattice default.
  const orgRule = run.orgId
    ? await resolveOrgPolicyRule(run.orgId, {
        checkpoint: RECOMMENDATION_CHECKPOINT,
        artifactType: POLICY_ARTIFACT_TYPE_WILDCARD,
        destinationClass: "none",
        originKind: "agent_produced",
      })
    : { bound: "silent" as const };

  const decision = evaluatePolicy({
    checkpoint: RECOMMENDATION_CHECKPOINT,
    artifactType: POLICY_ARTIFACT_TYPE_WILDCARD,
    destinationClass: "none",
    originKind: "agent_produced",
    humanPresent: true,
    orgRule,
    manifest: parseLifecycleConfig(template.lifecycleConfig) ?? undefined,
  });

  const outcome = evaluateThenPark(decision, {
    checkpoint: RECOMMENDATION_CHECKPOINT,
    destinationClass: "none",
  });

  // Policy-forbidden / policy-skipped → the checkpoint does not fire; no row,
  // dispatch normally (issue #2067 AC-4).
  if (outcome.kind === "proceed") {
    return { held: false, reason: outcome.reason };
  }

  // The checkpoint fired — but only PARK if the request-aware scorer actually
  // returns a candidate to confirm. Empty candidates → no row, dispatch
  // normally (issue #2067 AC-4). Candidates are bounded to the agent's
  // already-assigned deliverable set — resolved through the SHARED, run-actor-
  // scoped seam (cinatra#2148 finding 1) so an org/workspace-assigned skill is
  // part of the candidate set instead of being filtered out by an actor-free
  // resolve — so the chip-row can never surface a skill the run could not
  // deliver.
  const assignedSkillIds = await resolveRecommendationCandidateSkillIds({
    run,
    packageName,
  });
  let intentPromptText = "";
  try {
    intentPromptText = JSON.stringify(run.inputParams ?? {});
  } catch {
    intentPromptText = "";
  }
  const recommendations = await getRunRecommendations({
    agentId: packageName,
    intent: { promptText: intentPromptText },
    restrictToSkillIds: assignedSkillIds,
  });
  const hasCandidate = recommendations.some((r) => r.recommended) || recommendations.length > 0;
  if (!hasCandidate) {
    return { held: false, reason: "no recommendation candidates" };
  }

  const parked = await maybeParkCheckpoint(outcome, {
    runId: run.id,
    eventId: recommendationHoldEventId(run.id),
    policyDecisionId: null,
  });
  if (!parked.parked) {
    // evaluateThenPark said `park` but the store declined — treat as no hold
    // (fail-open to normal dispatch).
    return { held: false, reason: parked.reason };
  }
  // Announce the NEW hold on the run wire (cinatra#2568). Only here — the
  // already-parked branch above returns early, so a retried run-start never
  // re-announces a hold the human is already looking at. Awaited so a test can
  // observe it, but internally swallowed: the park holds the run, the wire only
  // tells the surfaces about it.
  await publishRecommendationHoldInterrupt({
    runId: run.id,
    threadId: recommendationHoldThreadId(run),
    holdId: parked.parkId,
  });
  return { held: true, parkId: parked.parkId, reason: outcome.reason };
}

/** The thread identity a run's AG-UI frames carry. Mirrors the execution
 * adapter's `new AgUiAdapter(runId, run.templateId, …)`. */
export function recommendationHoldThreadId(run: {
  id: string;
  templateId?: string | null;
}): string {
  return run.templateId && run.templateId.length > 0 ? run.templateId : run.id;
}

/** The run's recommendation park (parked or released), or null if none. The
 * chip-row appearance discriminator: a `parked` row ⇒ the interactive chip-row;
 * a `released` row ⇒ the read-only decided summary; null ⇒ no row. */
export async function readRecommendationParkForRun(runId: string): Promise<ParkRow | null> {
  const parks = await readContinuationParksForRun(runId);
  // A run holds at most ONE recommendation park (per-run constant event id).
  return parks.find((p) => p.checkpoint === RECOMMENDATION_CHECKPOINT) ?? null;
}

/**
 * Release the run's LIVE recommendation park (the human decided). Idempotent and
 * best-effort: a no-op when no park exists or it is already released. Returns
 * whether a live park was released.
 */
export async function releaseRecommendationParkForRun(
  runId: string,
  /**
   * INSTANCE BINDING (cinatra#2568). When given, the live park must BE this
   * hold or nothing is released. Without it this helper releases whichever park
   * is live at the moment it reads — so a decision taken against hold H,
   * arriving after the run was dispatched and parked again as H', would release
   * H'. The sweep itself is by park id, so what actually gets released is
   * always the row this call identified, never "whatever is live now".
   */
  expectedHoldId?: string,
): Promise<boolean> {
  const park = await readRecommendationParkForRun(runId);
  if (!park || park.status !== "parked") return false;
  if (expectedHoldId !== undefined && park.id !== expectedHoldId) return false;
  const { released } = await sweepParks({ releasedParkIds: [park.id] });
  return released > 0;
}
