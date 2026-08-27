import "server-only";

import { z } from "zod";

import { readAgentRunById } from "@cinatra-ai/agents/store";
import { agentHitlScreenStateForRun } from "@cinatra-ai/agents/agent-hitl-screen-core";

import { WIDGET_HITL_SCREEN_READ_GRANT } from "@/lib/lifecycle/widget-lifecycle-actor";
import {
  resolveWidgetRecommendationCaller,
  widgetSessionOwnsRun,
} from "@/lib/lifecycle/recommendation-hold-widget-branch";

// ---------------------------------------------------------------------------
// POST /api/lifecycle-views/hitl-screen — the BROKER READ of the question an
// agent paused to ask (cinatra#2930, lifecycle-b W3).
//
// WHY THIS ENDPOINT EXISTS AT ALL. The same reason the recommendation hold has
// one: `agent_hitl_screen` is carried as a typed INTERRUPT rather than a
// DATA_PART — the run is genuinely blocked on the answer — so it mints no view
// ref to post at `/api/lifecycle-views/resolve` and is addressed by the run the
// transcript already names.
//
// WHY IT IS BROKER-ONLY. The card's first-party hosts read through the
// cookie-bound server action and keep doing so, unchanged. This route serves the
// surface that CANNOT: the site widget, whose frame is same-origin to the app,
// where an ambient Cinatra cookie would answer as whoever else is signed in on
// that browser. A request here presents the widget's own `cwu_` or it is
// refused — there is no session fallback to fall back TO.
//
// TWO GATES, IN ORDER, AND BOTH ARE REAL — the same two the hold's route runs,
// through the same helpers:
//
//   1. THE CREDENTIAL, consumed at THIS route's own audience with the
//      `lifecycle.read` scope required. A token minted before this audience
//      existed carries the scope but not the audience and dies at the consume,
//      which is the fail-closed property the audience is FOR.
//   2. THE RUN <-> SESSION BINDING. The named run must be this person's own run
//      in the org the TOKEN is bound to, so an unrelated run id cannot be
//      projected into a widget thread even by a reader whose standing could read
//      it elsewhere in the app.
//
// A DENIAL IS A 200 `{ state: "none" }`, NEVER A 403. The state is the same
// silence a run that was never paused produces, so a caller holding a run id
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

const NO_SCREEN = { state: "none" } as const;

export async function POST(request: Request): Promise<Response> {
  const caller = await resolveWidgetRecommendationCaller(
    request,
    WIDGET_HITL_SCREEN_READ_GRANT,
  );
  if (!caller) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw: unknown = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: "Invalid HITL screen request" }, { status: 400 });
  }

  // The access door first — the SAME door the core runs — so the binding below
  // never observes a run this reader may not read.
  const run = await readAgentRunById(
    parsed.data.runId,
    caller.actorCtx.actor,
    caller.actorCtx.roleHints,
  ).catch(() => null);
  if (!run || !widgetSessionOwnsRun(run, caller.claims)) {
    return Response.json(NO_SCREEN, { headers: { "Cache-Control": "no-store" } });
  }

  const state = await agentHitlScreenStateForRun(run).catch(() => null);
  return Response.json(state ?? NO_SCREEN, { headers: { "Cache-Control": "no-store" } });
}
