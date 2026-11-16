import "server-only";

import { z } from "zod";

import {
  decidePublishDecisionForActor,
  mintWidgetPublishDecideGrant,
} from "@cinatra-ai/agents/publish-decision-card-core";

import { WIDGET_PUBLISH_DECISION_DECIDE_GRANT } from "@/lib/lifecycle/widget-lifecycle-actor";
import { resolveWidgetRecommendationCaller } from "@/lib/lifecycle/recommendation-hold-widget-branch";

// ---------------------------------------------------------------------------
// POST /api/lifecycle-views/publish-decision/decide -- the BROKER DECIDE of the publish card (cinatra#4150 part 7a-3b).
//
// The site widget's Publish and Do not publish. The first-party hosts keep their cookie-bound session action; this
// route serves the widget, which presents its own `cwu_` or is refused (401), with no session fallback: the embed frame
// is same-origin to the app, so an ambient cookie would decide as whoever else is signed in on that browser.
//
// THE CREDENTIAL, then THE DECISION'S OWN RULES: the `cwu_` is consumed at THIS route's audience with the existing
// `lifecycle.decide` scope required (an expired or revoked token, a revoked membership and a token without the scope
// or the audience are all refused there). The route then mints the widget publish grant for this run, this person and
// the token's org, and hands the ONE decide answer the same actor the read is served with. The decision's access check
// admits that actor only with the grant, only for the person's own run in that org, and then asks run.execute and
// run.approveHitl as for any decider. Every refusal is the card's "failed"; the route names no reason.
// ---------------------------------------------------------------------------

const requestSchema = z
  .object({
    runId: z.string().min(1).max(256),
    answer: z.enum(["approve", "decline"]),
    note: z.string().max(2000),
  })
  .strict();
const NO_STORE = { headers: { "Cache-Control": "no-store" } } as const;

export async function POST(request: Request): Promise<Response> {
  const caller = await resolveWidgetRecommendationCaller(request, WIDGET_PUBLISH_DECISION_DECIDE_GRANT);
  if (!caller) {
    return Response.json({ error: "Unauthorized" }, { status: 401, ...NO_STORE });
  }

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid publish decision" }, { status: 400, ...NO_STORE });
  }

  const widgetGrant = mintWidgetPublishDecideGrant(caller.claims, parsed.data.runId);
  if (!widgetGrant) return Response.json({ outcome: "failed" }, NO_STORE);
  const outcome = await decidePublishDecisionForActor({
    ...parsed.data,
    who: { actor: caller.actorCtx.actor, roleHints: caller.actorCtx.roleHints ?? {}, widgetGrant },
  });
  return Response.json({ outcome }, NO_STORE);
}
