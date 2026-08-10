import "server-only";

import { z } from "zod";

import { LIFECYCLE_VIEW_REF_MAX_LENGTH } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { enforceReviewRunAccess } from "@cinatra-ai/agents/artifact-review-gate-store";
import { decodeLifecycleGateRef } from "@/lib/lifecycle/lifecycle-card-ref";
import { submitReviewDecisionAction } from "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/actions";
import { resolveReviewActorContext } from "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-actor";

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
// A DENIAL IS A UNIFORM `not-permitted` OUTCOME AT 200. The decision helper's own
// refusal shape is returned verbatim: an unauthorized caller and a caller naming
// a gate that no longer exists must be indistinguishable, so neither a status
// code nor a message may report which. Only a malformed body (400) and no
// session (401) are distinguishable, and neither depends on the ref.
// ---------------------------------------------------------------------------

const requestSchema = z
  .object({
    ref: z.string().min(1).max(LIFECYCLE_VIEW_REF_MAX_LENGTH),
    disposition: z.enum(["approve", "reject", "comment"]),
    // The rationale (§IV) — optional on approve, expected on reject, and the
    // substance of a comment. Bounded so a card cannot post an essay.
    comment: z.string().max(10_000).nullable().optional(),
  })
  .strict();

/** The one refusal a caller ever sees for "not yours" / "not there". */
const UNIFORM_REFUSAL = {
  kind: "not-permitted" as const,
  message:
    "You do not have the run access this decision needs — a terminal decision requires approve access, a comment requires respond access.",
};

export async function POST(request: Request): Promise<Response> {
  const actorCtx = await resolveReviewActorContext();
  if (!actorCtx) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw: unknown = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: "Invalid lifecycle decision request" }, { status: 400 });
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
  const outcome = await submitReviewDecisionAction(
    payload.runId,
    payload.reviewTaskId,
    parsed.data.disposition,
    comment,
    // ONE actor context for both checks — the read above and the decision-op
    // check inside. Resolving twice would let the two decisions be taken against
    // two separate reads of the same actor's role/team/project hints.
    actorCtx,
  );

  return Response.json({ outcome }, { headers: { "Cache-Control": "no-store" } });
}
