import "server-only";

import { z } from "zod";

import { readAgentRunById } from "@cinatra-ai/agents/store";
import { RECOMMENDATION_DECISION_REFUSAL } from "@cinatra-ai/agents/recommendation-hold";
import {
  confirmRecommendationForActor,
  skipRecommendationForActor,
  writeRunSkillSelectionForActor,
} from "@cinatra-ai/agents/run-recommendation-core";
import { WIDGET_RECOMMENDATION_DECIDE_GRANT } from "@/lib/lifecycle/widget-lifecycle-actor";
import {
  resolveWidgetRecommendationCaller,
  widgetRunStartDispatcher,
  widgetSessionOwnsRun,
} from "@/lib/lifecycle/recommendation-hold-widget-branch";

// ---------------------------------------------------------------------------
// POST /api/lifecycle-views/recommendation-hold/decide — the BROKER DECISION on
// the run-start skills question (cinatra#2790, epic #2784 S9f).
//
// THIS IS NOT A SECOND DECISION PATH. The body is resolved to a verified actor
// and handed to `confirmRecommendationForActor` / `skipRecommendationForActor` —
// the same two functions the cookie-bound server actions call, which run the
// same hold-instance CAS, the same execute-tier selection write, the same
// verified release, the same resume announcement and the same dispatch, in the
// same order. What differs is where the identity came from, and nothing else.
//
// THE AUTHORITY IS BUILT FRESH FROM THE WIDGET'S OWN CREDENTIAL AT THE MOMENT OF
// THE CALL. The `cwu_` is consumed at THIS route's audience under the
// `lifecycle.decide` grant, the reader's live org standing is resolved from it,
// and the run must be that person's own run in the token's org before anything
// is written. A widget decision therefore can never be recorded against whoever
// else is signed in on the browser the frame happens to live in, and a run the
// conversation does not own cannot be decided from it.
//
// THE DISPATCH CARRIES THE SAME IDENTITY AS THE WRITE. A decision ends by
// releasing the park and dispatching the run, and the canonical dispatcher used
// to resolve its own identity from a cookie session — which a cross-site frame
// does not have. So this entry hands the core a dispatcher bound to the actor it
// just verified, for the ONE run it just bound, exactly as it already hands in
// the broker selection write. There is no session fallback and no widening: a
// widget principal dispatches the run it decided, in the org its credential
// binds, or nothing at all.
//
// EVERY REFUSAL IS THE SAME ONE. "You may not decide this run", "that hold is
// stale" and "there is no such run" answer identically at 200, exactly as the
// server actions do. Only a missing credential (401) and a malformed body (400)
// are distinguishable.
// ---------------------------------------------------------------------------

const requestSchema = z
  .object({
    runId: z.string().min(1).max(256),
    decision: z.enum(["confirm", "skip"]),
    /** The FULL kept set on a confirm. Bounded on shape only — the write bounds
     *  it against the agent's assigned deliverable set for THIS reader. */
    confirmedSkillIds: z.array(z.string().min(1).max(512)).max(200).optional(),
    /** Forced (non-recommended) additions, pinned to an exact revision. */
    forcedRevisions: z.record(z.string().min(1).max(512), z.string().min(1).max(512)).optional(),
    /** The kept skills settled through a chip's ADJUST panel (cinatra#2841). */
    adjustedSkillIds: z.array(z.string().min(1).max(512)).max(200).optional(),
    /** The hold this decision was taken against (cinatra#2568). */
    holdRef: z.string().min(1).max(4096).optional(),
    /** Serialized run intent, for request-aware scoring on the write. */
    promptText: z.string().max(20_000).optional(),
  })
  .strict();

const UNIFORM_REFUSAL = { ok: false as const, error: RECOMMENDATION_DECISION_REFUSAL };

export async function POST(request: Request): Promise<Response> {
  const caller = await resolveWidgetRecommendationCaller(
    request,
    WIDGET_RECOMMENDATION_DECIDE_GRANT,
  );
  if (!caller) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw: unknown = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: "Invalid recommendation decision request" }, { status: 400 });
  }

  const body = parsed.data;
  const who = {
    actor: caller.actorCtx.actor,
    roleHints: caller.actorCtx.roleHints ?? {},
  };

  // Run READ first, then the widget binding — before ANY write, so a decision
  // aimed at a run this conversation does not own leaves no trace on it.
  const run = await readAgentRunById(body.runId, who.actor, who.roleHints).catch(() => null);
  if (!run || !widgetSessionOwnsRun(run, caller.claims)) {
    return Response.json(
      { outcome: UNIFORM_REFUSAL },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // The BROKER dispatcher — minted here, for THIS credential and THIS run.
  const dispatch = widgetRunStartDispatcher({ claims: caller.claims, run });

  const outcome =
    body.decision === "skip"
      ? await skipRecommendationForActor({
          runId: body.runId,
          who,
          ...(body.holdRef !== undefined ? { holdRef: body.holdRef } : {}),
          dispatch,
        })
      : await confirmRecommendationForActor({
          runId: body.runId,
          confirmedSkillIds: body.confirmedSkillIds ?? [],
          who,
          // The BROKER selection write — the SAME execute-tier gate the session
          // action delegates to, resolved from the widget's own credential
          // instead of an ambient cookie.
          writeSelection: (write) => writeRunSkillSelectionForActor({ ...write, who }),
          ...(body.promptText !== undefined ? { promptText: body.promptText } : {}),
          ...(body.forcedRevisions ? { forcedRevisions: body.forcedRevisions } : {}),
          ...(body.adjustedSkillIds ? { adjustedSkillIds: body.adjustedSkillIds } : {}),
          ...(body.holdRef !== undefined ? { holdRef: body.holdRef } : {}),
          dispatch,
        });

  return Response.json({ outcome }, { headers: { "Cache-Control": "no-store" } });
}
