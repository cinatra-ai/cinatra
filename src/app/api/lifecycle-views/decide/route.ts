import "server-only";

import { z } from "zod";

import { LIFECYCLE_VIEW_REF_MAX_LENGTH } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { proposedScheduleSchema } from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";
import { enforceReviewRunAccess } from "@cinatra-ai/agents/artifact-review-gate-store";
import { decodeLifecycleGateRef } from "@/lib/lifecycle/lifecycle-card-ref";
import { decideTriggerScheduleProposal } from "@/lib/lifecycle/trigger-schedule-proposal-card";
import {
  MAX_SUGGESTION_ID_CHARS,
  MAX_SUGGESTION_PARTITION_IDS,
} from "@/lib/artifacts/artifact-review-decision";
import { submitReviewDecisionAction } from "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/actions";
import { resolveReviewActorContext } from "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-actor";
import { resolveAssistantWidgetBinding } from "@/lib/assistant-widget-handles";
import { emitWidgetAuthAudit } from "@/lib/widget-auth-audit";
import {
  WIDGET_LIFECYCLE_DECIDE_GRANT,
  resolveWidgetLifecycleActorContext,
} from "@/lib/lifecycle/widget-lifecycle-actor";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";

// ---------------------------------------------------------------------------
// POST /api/lifecycle-views/decide — the GATE-SCOPED decision entry for a review
// card that is not on the review page (cinatra#2566, epic #2564 S2).
//
// THIS IS NOT A NEW DECISION PRIMITIVE. It is a second ENTRY to the one that
// already exists. The body is decoded to a run + gate and handed to
// `submitReviewDecisionAction` — the same helper the review page's route-bound
// server action calls — which enforces the same order it always has: run access
// for the decision op FIRST (approve/reject → approveHitl, comment →
// respondToHitl), THEN the frozen pinned set read from the gate, then the
// #1807 core's re-validation (pinned-set membership, revision membership, gate
// CAS, provenance re-derived from the artifact type). Nothing about the decision
// is re-implemented here and nothing is relaxed.
//
// WHY THE ROUTE-BOUND-ONLY POSTURE COULD BE GENERALIZED. The page's action
// closed over its route params so a client could never name another gate. A card
// in a transcript has no route params, so it names its gate the only way it
// safely can: with the SERVER-MINTED, authenticated-encrypted ref it was drawn
// from. A client cannot mint one, cannot alter one (AES-GCM), and gains nothing
// by replaying one — the access checks run from scratch on every call. And the
// property that makes a review decidable exactly once was never the route
// binding: it is the gate CAS, which turns an identical-fingerprint retry into
// an idempotent success and a different decision into a conflict, whichever
// surface the second attempt came from.
//
// READ IS ENFORCED HERE, BEFORE THE DECISION OP, AGAINST ONE ACTOR CONTEXT. The shared helper checks the
// DECISION axis only (`approveHitl` for a terminal decision, `respondToHitl` for
// a comment), because on the review page a caller had already cleared run READ
// by loading the surface. A card has no such preceding page load, and run access
// ops are separate policy axes — an actor could hold a decision op without read.
// Requiring READ first restores the page's full precondition, and it keeps the
// order the whole review surface uses: run read → gate → decision axis. This is
// a tightening, never a relaxation: nothing that could be decided through the
// page becomes undecidable here.
//
// SUGGESTION DECISIONS RIDE THE SAME BODY (cinatra#2571, epic #2564 S6b). A card
// that shows suggestion chips sends the accepted/dismissed partition WITH the one
// terminal decision; there is no per-item endpoint here or anywhere (#2047 row 8).
// This route bounds its SHAPE and forwards it — the decision core validates it
// against the gate's pinned snapshot before the CAS and folds it into the
// fingerprint, so a forged or replayed id is refused by the same code that
// refuses a substituted target, and answers with the same uniform block.
//
// A DENIAL IS A UNIFORM `not-permitted` OUTCOME AT 200. The decision helper's own
// refusal shape is returned verbatim: an unauthorized caller and a caller naming
// a gate that no longer exists must be indistinguishable, so neither a status
// code nor a message may report which. Only a malformed body (400) and no
// session (401) are distinguishable, and neither depends on the ref.
//
// TWO AUTH BRANCHES, ONE DECISION (cinatra#2575, epic #2564 S8b; corrected
// 2026-08-11 and folded into this route rather than given an endpoint of its
// own):
//
//   · COOKIE SESSION — the first-party hosts, unchanged.
//   · BROKER `cwu_` — the site widget. Its actor is built by the SAME S8a module
//     the widget's refetch uses, consumed at THIS route's audience with the
//     `lifecycle.decide` scope required, and it is the SAME `ReviewActorContext`
//     shape — so from the READ below onwards, the two branches are one code path
//     and a widget reviewer's authorization and race outcomes are the page's by
//     construction, not by assertion.
//
// WHAT THIS BRANCH DELIBERATELY DOES NOT HAVE. No single-use action capability,
// no hosted confirmation window, no second decision endpoint, no reduced body.
// Those came from the invented premise that the embedding site holds the widget
// user's token; the widget session is the person's own cinatra authentication
// (hosted PKCE sign-in, cinatra#407), so a widget reviewer decides exactly as
// they do in the app.
//
// THE BRANCH IS DECIDED BY THE PRESENTED CREDENTIAL AND NEVER FALLS BACK. A
// request that presents the widget user-token header is a widget request; a
// failed widget consume 401s rather than dropping to an ambient cookie — which
// matters more here than anywhere, because this endpoint is same-origin to the
// embed iframe and an ambient cookie would RECORD A DECISION as somebody else.
// ---------------------------------------------------------------------------

const reviewRequestSchema = z
  .object({
    /** The kind this body decides. OPTIONAL and defaulted for the review card
     *  (cinatra#2788, epic #2784 S9d): the shipped card posts no discriminant,
     *  and a decision endpoint is the last place to break a client that already
     *  works. A body that names the kind is checked against it; one that does
     *  not is the review shape, which is what it has always been. */
    kind: z.literal("artifact_review_gate").optional(),
    ref: z.string().min(1).max(LIFECYCLE_VIEW_REF_MAX_LENGTH),
    disposition: z.enum(["approve", "reject", "comment"]),
    // The rationale (§IV) — optional on approve, expected on reject, and the
    // substance of a comment. Bounded so a card cannot post an essay.
    comment: z.string().max(10_000).nullable().optional(),
    // The reviewer's per-item SUGGESTION choices (cinatra#2571, epic #2564 S6b),
    // carried ON the one terminal decision — there is deliberately no per-item
    // endpoint (#2047 row 8). Bounded here on SHAPE only: which ids are legitimate
    // is decided against the gate's PINNED snapshot inside the decision core, not
    // by this schema, and a card that sends more ids than a snapshot can hold is
    // rejected before any store is touched.
    suggestionDecisions: z
      .object({
        accepted: z.array(z.string().min(1).max(MAX_SUGGESTION_ID_CHARS)).max(MAX_SUGGESTION_PARTITION_IDS).optional(),
        dismissed: z.array(z.string().min(1).max(MAX_SUGGESTION_ID_CHARS)).max(MAX_SUGGESTION_PARTITION_IDS).optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// §VI's decisions, on the SAME endpoint (cinatra#2788, epic #2784 S9d).
//
// THE SCHEDULE CARD DOES NOT GET AN ENDPOINT OF ITS OWN, for exactly the reason
// this route's own header gives for the widget: "it gets an auth BRANCH on the
// endpoint that already exists". A second decision route would need a second
// widget AUDIENCE, which no already-minted `cwu_` carries — so every widget
// session that signed in before it existed would find §VI's floor dead, and the
// only fix would be a scope vocabulary nobody re-checks. One endpoint, one
// audience (`lifecycle.decide`), one consent class: "this decision changes org
// state". Which OPERATION a body asks for is the discriminant below, and each
// one is handed to the canonical path that already owns it — this route
// implements no scheduling logic of its own.
//
// FIVE OPERATIONS, ALL RE-AUTHORIZED SERVER-SIDE:
//
//   confirm — `confirmTriggerScheduleProposal`, the one transaction that spends
//             the proposal and creates the run. The token is re-verified against
//             the LIVE actor there, so a ref replayed by anyone else is refused
//             by the same sentence a forged one gets.
//   adjust  — `adjustTriggerSchedule`, i.e. RE-PROPOSE. It writes nothing. The
//             template is taken from the VERIFIED token, never from the body:
//             a caller cannot re-point somebody else's proposal at another agent.
//   save    — `updateRunTriggerScheduleForActor`, plan (A) §7.2's "Save changes,
//             which re-arms the trigger". It re-verifies the actor, refuses a
//             released trigger and a one-off that has already fired, and hands
//             the rest to the ONE `setRunTriggerForActor` — so a recurring change
//             cancels the prior scheduler and takes effect on future ticks only.
//   cancel  — `deleteRunTriggerForActor` (owner-or-admin), the canonical path.
//   release — `releaseTriggerNowForActor` (admin + install-scope dispatch
//             authority), the canonical path.
//
// THE CLIENT NEVER NAMES A RUN. `save`, `cancel` and `release` act on the run the REF
// resolves to, server-side, through the same resolver that drew the card. A body
// carrying a run id would be a way to operate a trigger the card never showed.
// ---------------------------------------------------------------------------

/** The re-proposed selections — §VI's option rows, and no cron field. */
const scheduleRequestSchema = z
  .object({
    kind: z.literal("trigger_schedule_proposal"),
    ref: z.string().min(1).max(LIFECYCLE_VIEW_REF_MAX_LENGTH),
    op: z.enum(["confirm", "adjust", "save", "cancel", "release"]),
    /** Present for `adjust` (re-propose) and `save` (re-arm an already-armed
     *  trigger — plan (A) §7.2's "Save changes"). Validated as §VI's closed
     *  selection vocabulary, which HAS no cron field, so a raw expression
     *  cannot enter through this door however it is spelled. */
    schedule: proposedScheduleSchema.optional(),
  })
  .strict();

const requestSchema = z.union([reviewRequestSchema, scheduleRequestSchema]);

/** The one refusal a caller ever sees for "not yours" / "not there". */
const UNIFORM_REFUSAL = {
  kind: "not-permitted" as const,
  message:
    "You do not have the run access this decision needs — a terminal decision requires approve access, a comment requires respond access.",
};

/** The `cwu_` proof header — the discriminant for the widget branch. */
const WIDGET_USER_TOKEN_HEADER = "X-Cinatra-Widget-User-Token";
/** The embed-forwarded parent (CMS) origin; re-checked against the token binding. */
const WIDGET_ORIGIN_HEADER = "X-Cinatra-Widget-Origin";
/** The embed-forwarded assistant handle; only a selector — the token is the authority. */
const WIDGET_ASSISTANT_HEADER = "X-Cinatra-Widget-Assistant";

/**
 * Resolve the widget branch's deciding actor from the presented `cwu_`.
 *
 * Returns `null` for every failure — a bad handle, a rejected token, a revoked
 * membership — because the caller turns all of them into the same 401 a missing
 * credential produces. It is the SAME construction the widget's lifecycle READ
 * uses, differing only in the grant it consumes under, so the person who was
 * shown a card and the person whose decision is recorded are resolved the same
 * way from the same token.
 */
async function resolveWidgetDecidingActor(
  request: Request,
  userToken: string,
): Promise<ReviewActorContext | null> {
  // An empty/whitespace bearer is refused HERE rather than left to the door, for
  // the reason the refetch route states: a branch that hands an empty string to
  // a token verifier is one rename away from handing it to something forgiving.
  // The two failures that happen BEFORE the actor door — an unusable bearer and
  // an unknown handle — are audited here, because the door never runs for them
  // and a decision attempt that leaves no record at all is the wrong kind of
  // silence (codex round 1 on finding 6). No identifiers: the handle is caller
  // input and the token is a secret, so the row carries neither.
  if (userToken.length === 0) {
    emitWidgetAuthAudit("widget_lifecycle_decide_rejected", { reason: "no_bearer" });
    return null;
  }
  const handle = request.headers.get(WIDGET_ASSISTANT_HEADER)?.trim().toLowerCase() ?? "";
  const binding = resolveAssistantWidgetBinding(handle);
  if (!binding) {
    emitWidgetAuthAudit("widget_lifecycle_decide_rejected", { reason: "unknown_handle" });
    return null;
  }
  const resolved = await resolveWidgetLifecycleActorContext({
    token: userToken,
    agentSlug: binding.agentSlug,
    requestOrigin: request.headers.get(WIDGET_ORIGIN_HEADER),
    grant: WIDGET_LIFECYCLE_DECIDE_GRANT,
  });
  return resolved.ok ? resolved.actorCtx : null;
}

export async function POST(request: Request): Promise<Response> {
  // The discriminant is the header's PRESENCE, not whether its value looks
  // usable: a caller that declares itself a widget is a widget, and a widget
  // whose token is unusable is refused rather than rescued by a cookie.
  const presentedUserToken = request.headers.get(WIDGET_USER_TOKEN_HEADER);
  const actorCtx =
    presentedUserToken !== null
      ? await resolveWidgetDecidingActor(request, presentedUserToken.trim())
      : await resolveReviewActorContext();
  if (!actorCtx) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw: unknown = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: "Invalid lifecycle decision request" }, { status: 400 });
  }

  // §VI's operations branch here — BEFORE the gate-ref decode, because a
  // schedule ref is not a gate ref and decoding it as one would answer the
  // uniform review refusal for a body that never asked a review question.
  if (parsed.data.kind === "trigger_schedule_proposal") {
    const outcome = await decideTriggerScheduleProposal({
      ref: parsed.data.ref,
      op: parsed.data.op,
      schedule: parsed.data.schedule,
      // A principal with no attributable user cannot hold or settle a proposal.
      userId: actorCtx.actor.userId ?? "",
      orgId: actorCtx.orgId,
      // The role the ACTOR was resolved with. `releaseTriggerNowForActor`
      // re-checks it, and then re-checks the install-scope dispatch authority
      // on top — this route asserts nothing about admin standing itself.
      role:
        actorCtx.roleHints?.platformRole === "platform_admin" ? "admin" : null,
    });
    return Response.json({ outcome }, { headers: { "Cache-Control": "no-store" } });
  }

  const payload = decodeLifecycleGateRef(parsed.data.ref);
  if (!payload) {
    // A ref that does not decode is answered exactly like a gate the caller may
    // not decide. Reporting "bad ref" separately would tell a prober that their
    // OTHER refs are well-formed.
    return Response.json(
      { outcome: UNIFORM_REFUSAL },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // Run READ first — see the header. A denial is the SAME uniform refusal a
  // failed decision-op check produces, so this check adds no new signal.
  const read = await enforceReviewRunAccess(
    payload.runId,
    actorCtx.actor,
    "read",
    actorCtx.roleHints,
  ).catch(() => ({ ok: false }) as const);
  if (!read.ok) {
    return Response.json(
      { outcome: UNIFORM_REFUSAL },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const comment = parsed.data.comment ?? null;
  const partition = parsed.data.suggestionDecisions ?? null;
  const outcome = await submitReviewDecisionAction(
    payload.runId,
    payload.reviewTaskId,
    parsed.data.disposition,
    comment,
    // ONE actor context for both checks — the read above and the decision-op
    // check inside. Resolving twice would let the two decisions be taken against
    // two separate reads of the same actor's role/team/project hints.
    actorCtx,
    // Forwarded UNVALIDATED beyond its shape: the ONE decision path normalizes it
    // and checks it against the gate's pinned snapshot before the CAS. This route
    // deciding which suggestions are real would be a second place that knows.
    partition
      ? { accepted: partition.accepted ?? [], dismissed: partition.dismissed ?? [] }
      : null,
  );

  return Response.json({ outcome }, { headers: { "Cache-Control": "no-store" } });
}
