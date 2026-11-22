import "server-only";

import { z } from "zod";

import { readAgentRunById } from "@cinatra-ai/agents/store";
import {
  PUBLISH_DECISION_CARD_NONE,
  publishDecisionCardStateForWidgetRun,
} from "@cinatra-ai/agents/publish-decision-card-core";

import { WIDGET_PUBLISH_DECISION_READ_GRANT } from "@/lib/lifecycle/widget-lifecycle-actor";
import {
  resolveWidgetRecommendationCaller,
  widgetSessionOwnsRun,
} from "@/lib/lifecycle/recommendation-hold-widget-branch";

// ---------------------------------------------------------------------------
// GET /api/lifecycle-views/publish-decision?runId= -- the BROKER READ of the publish card (cinatra#4150).
//
// The hitl screen's road, for the hitl screen's reasons: `publish_decision` is a typed INTERRUPT, so it mints no
// view ref and is addressed by the run. The first-party hosts read through the cookie-bound server action; this
// route serves the site widget, which presents its own `cwu_` or is refused (401), with no session fallback.
//
// TWO GATES, IN ORDER: the credential at THIS route's audience with `lifecycle.read`, then the run read through its
// access door and bound to this widget session. A failure of the second answers 200 `{ state: "none" }`, the same
// silence a run with no decision produces. The route reads only; it sends no decision.
// ---------------------------------------------------------------------------

const runIdSchema = z.string().min(1).max(256);
const NO_STORE = { headers: { "Cache-Control": "no-store" } } as const;

export async function GET(request: Request): Promise<Response> {
  const caller = await resolveWidgetRecommendationCaller(request, WIDGET_PUBLISH_DECISION_READ_GRANT);
  if (!caller) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = runIdSchema.safeParse(new URL(request.url).searchParams.get("runId"));
  if (!parsed.success) {
    return Response.json({ error: "Invalid publish card request" }, { status: 400 });
  }

  const who = caller.actorCtx;
  const run = await readAgentRunById(parsed.data, who.actor, who.roleHints).catch(() => null);
  if (!run || !widgetSessionOwnsRun(run, caller.claims)) {
    return Response.json(PUBLISH_DECISION_CARD_NONE, NO_STORE);
  }

  const reader = { actor: who.actor, roleHints: who.roleHints ?? {} };
  // The widget's own may-decide reading: the run rights of this reader, who is a human of source "a2a" (cinatra#4150).
  const state = await publishDecisionCardStateForWidgetRun(run, reader).catch(() => null);
  return Response.json(state ?? PUBLISH_DECISION_CARD_NONE, NO_STORE);
}
