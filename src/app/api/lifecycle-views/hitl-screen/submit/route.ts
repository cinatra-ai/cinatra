import "server-only";

import { z } from "zod";

import {
  submitAgentHitlScreenForActor,
  AGENT_HITL_SUBMIT_REFUSAL,
} from "@cinatra-ai/agents/agent-hitl-screen-submit";

import { WIDGET_HITL_SCREEN_SUBMIT_GRANT } from "@/lib/lifecycle/widget-lifecycle-actor";
import {
  resolveWidgetRecommendationCaller,
  widgetSessionOwnsRun,
} from "@/lib/lifecycle/recommendation-hold-widget-branch";

// ---------------------------------------------------------------------------
// POST /api/lifecycle-views/hitl-screen/submit — the BROKER ANSWER to the
// question an agent paused to ask (cinatra#2930, lifecycle-b W3).
//
// WHY THIS ENDPOINT EXISTS. Its sibling one directory up serves the READ of
// this card on a surface that has no session. This is the other half: the
// Continue. Without it the widget's card could show the question and not answer
// it, which is not the platform's rule for this surface — through the widget a
// person authenticates to Cinatra and has the SAME rights they have inside
// Cinatra, and answering a run's own gate is one of them.
//
// IT IS THE SAME SUBMIT, NOT A SECOND ONE. The body is resolved to a verified
// actor and handed to `submitAgentHitlScreenForActor`, which hands it to
// `approveReviewTaskInternal` — the auth-neutral core the cookie-bound
// `approveReviewTask` server action calls, and has always called, from the run
// page's Continue. Same merge, same allowlist, same type gate, same WayFlow
// resume, same CAS, same re-enqueue. The run resumes because it is the same
// resume.
//
// THE AUTHORITY IS BUILT FRESH FROM THE WIDGET'S OWN CREDENTIAL AT THE MOMENT
// OF THE CALL, and there is NO session fallback to fall back to. The embed
// frame is same-origin to the Cinatra app, so an ambient cookie would answer —
// and record an approval — as whoever else is signed in on that browser. A
// request here presents the widget's own `cwu_` or it is refused.
//
// THREE GATES, IN ORDER, AND ALL THREE ARE REAL:
//
//   1. THE CREDENTIAL, consumed at THIS route's own audience with the
//      `lifecycle.decide` scope required. Deciding is not reading: the read
//      audience one directory up does not admit here, and a token minted before
//      this audience existed carries the scope but not the audience and dies at
//      the consume. That is the fail-closed property the audience is FOR.
//   2. THE RUN <-> SESSION BINDING — `widgetSessionOwnsRun`, the same helper
//      and the same rule the read and the hold's decision use: this person's
//      own run, in the org the TOKEN is bound to. Applied to the row the core
//      already read THROUGH the access door, before anything is written.
//   3. THE RUN'S OWN ACCESS RULES — `run.execute` then `run.approveHitl`,
//      enforced by the shipped approval core against the actor resolved above.
//      These are the in-app checks, unchanged and no looser: a widget reader
//      clears a gate exactly when the same person clears it inside the app.
//
// AND THE GATE MUST BE THE RUN'S GATE. The caller names both a run and the
// review task it was SHOWN, and the core re-derives the run's own gate and
// refuses a mismatch — so a caller cannot borrow another run's gate id by
// naming it here. That check lives in the core, with the rule, rather than in
// this file.
//
// EVERY REFUSAL IS THE SAME REFUSAL, at 200. Only a missing/unusable credential
// (401) and a malformed body (400) are distinguishable, and neither depends on
// the run id.
// ---------------------------------------------------------------------------

/** The reviewer's answer, bounded the way the core bounds what it merges. */
const MAX_VALUES_BYTES = 65_536;

const requestSchema = z
  .object({
    /** The run the transcript's own `agent_run` part named. */
    runId: z.string().min(1).max(256),
    /** The gate the card was drawing. Checked against the run's own gate. */
    reviewTaskId: z.string().min(1).max(256),
    /** The answer, in the shape the run panel submits. Shape-bounded here;
     *  the merge itself is bounded against the template's declared inputs by
     *  the same core the in-app submit goes through. */
    values: z.unknown().optional(),
    /** Set on a single-field setup gate, exactly as the panel sets it. */
    fieldName: z.string().min(1).max(512).optional(),
  })
  .strict();

const UNIFORM_REFUSAL = { ok: false as const, error: AGENT_HITL_SUBMIT_REFUSAL };

export async function POST(request: Request): Promise<Response> {
  const caller = await resolveWidgetRecommendationCaller(
    request,
    WIDGET_HITL_SCREEN_SUBMIT_GRANT,
  );
  if (!caller) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw: unknown = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: "Invalid HITL screen submit" }, { status: 400 });
  }
  const body = parsed.data;

  // A payload too large to be an answer is refused HERE rather than carried to
  // the merge, so an oversized body cannot reach a database round trip.
  if (body.values !== undefined) {
    let serialized: string;
    try {
      serialized = JSON.stringify(body.values) ?? "";
    } catch {
      return Response.json({ error: "Invalid HITL screen submit" }, { status: 400 });
    }
    if (serialized.length > MAX_VALUES_BYTES) {
      return Response.json({ error: "Invalid HITL screen submit" }, { status: 400 });
    }
  }

  // Defensive: a token that validated but carries no principal cannot ground a
  // write. There is no "best effort" actor to fall back to.
  const actorId = caller.claims.userId;
  if (!actorId) {
    return Response.json(
      { outcome: UNIFORM_REFUSAL },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const outcome = await submitAgentHitlScreenForActor({
    runId: body.runId,
    reviewTaskId: body.reviewTaskId,
    ...(body.values !== undefined ? { values: body.values } : {}),
    ...(body.fieldName !== undefined ? { fieldName: body.fieldName } : {}),
    actorId,
    who: {
      actor: caller.actorCtx.actor,
      roleHints: caller.actorCtx.roleHints ?? {},
    },
    // THE WIDGET BINDING, re-asserted at the moment of use on the row the core
    // read through the access door.
    bindRun: (run) => widgetSessionOwnsRun(run, caller.claims),
  });

  return Response.json({ outcome }, { headers: { "Cache-Control": "no-store" } });
}
