import "server-only";

import { z } from "zod";

import { readAgentRunById } from "@cinatra-ai/agents/store";
import { resolveRecommendationHoldStateForActor } from "@cinatra-ai/agents/run-recommendation-core";

import {
  WIDGET_RECOMMENDATION_READ_GRANT,
} from "@/lib/lifecycle/widget-lifecycle-actor";
import {
  resolveWidgetRecommendationCaller,
  widgetSessionOwnsRun,
} from "@/lib/lifecycle/recommendation-hold-widget-branch";

// ---------------------------------------------------------------------------
// POST /api/lifecycle-views/recommendation-hold — the BROKER READ of the
// run-start skills question (cinatra#2790, epic #2784 S9f).
//
// WHY THIS ENDPOINT EXISTS AT ALL. Every other lifecycle card resolves through
// `/api/lifecycle-views/resolve` with a `{viewType, ref}` envelope. The
// recommendation hold cannot: it is the ONE kind whose carriage is a typed
// INTERRUPT rather than a DATA_PART — the run is genuinely blocked on the
// answer — so it has no minted view ref to post, and S9c ruled it stays outside
// that per-kind envelope. It is addressed by the run the transcript already
// names.
//
// WHY IT IS BROKER-ONLY, AND WHY THAT IS THE POINT. The card's first-party hosts
// read through a cookie-bound server action and keep doing so, unchanged. This
// route serves the surface that CANNOT: the site widget, whose frame is
// same-origin to the app, where an ambient Cinatra cookie would answer as
// whoever else is signed in on that browser. That is precisely the guard the
// card used to carry in code ("a shortfall, not a design"). A request here
// presents the widget's own `cwu_` or it is refused — there is no session
// fallback to fall back TO.
//
// TWO GATES, IN ORDER, AND BOTH ARE REAL.
//
//   1. THE CREDENTIAL. The `cwu_` is consumed at THIS route's audience with the
//      `lifecycle.read` scope required, and the reader's LIVE org standing is
//      resolved from it. A session that signed in before this audience existed
//      carries the scope but not the audience and dies at the consume (AC-1).
//   2. THE RUN ↔ SESSION BINDING. The named run must be this person's own run in
//      the org the TOKEN is bound to (`widgetSessionOwnsRun`), so an unrelated
//      run id cannot be projected into a widget thread even by a reader whose
//      standing could read it elsewhere in the app.
//
// A DENIAL IS A 200 `{ state: "none" }`, NEVER A 403. The state is the same
// silence a run that was never held produces, so a caller holding a run id
// learns nothing about which runs exist. Only a missing/unusable credential
// (401) and a malformed body (400) are distinguishable, and neither depends on
// the run id.
// ---------------------------------------------------------------------------

const requestSchema = z
  .object({
    // The run the transcript's own `agent_run` part named. Bounded so a caller
    // cannot post an essay; the value is never trusted beyond the two gates.
    runId: z.string().min(1).max(256),
  })
  .strict();

const NO_ROW = { state: "none" } as const;

export async function POST(request: Request): Promise<Response> {
  const caller = await resolveWidgetRecommendationCaller(
    request,
    WIDGET_RECOMMENDATION_READ_GRANT,
  );
  if (!caller) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw: unknown = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: "Invalid recommendation hold request" }, { status: 400 });
  }

  // The access door first — the SAME door the core runs — so the binding below
  // never observes a run this reader may not read.
  const run = await readAgentRunById(
    parsed.data.runId,
    caller.actorCtx.actor,
    caller.actorCtx.roleHints,
  ).catch(() => null);
  if (!run || !widgetSessionOwnsRun(run, caller.claims)) {
    return Response.json(NO_ROW, { headers: { "Cache-Control": "no-store" } });
  }

  const state = await resolveRecommendationHoldStateForActor({
    runId: parsed.data.runId,
    who: { actor: caller.actorCtx.actor, roleHints: caller.actorCtx.roleHints ?? {} },
  });
  return Response.json(state, { headers: { "Cache-Control": "no-store" } });
}
