import "server-only";

import { z } from "zod";

import { readAgentRunById } from "@cinatra-ai/agents/store";
import {
  PUBLISH_DECISION_MAX_NOTE_LENGTH,
  decidePublishDecisionCardForWidgetReader,
} from "@cinatra-ai/agents/publish-decision-card-core";

import { WIDGET_PUBLISH_DECISION_DECIDE_GRANT } from "@/lib/lifecycle/widget-lifecycle-actor";
import {
  resolveWidgetRecommendationCaller,
  widgetSessionOwnsRun,
} from "@/lib/lifecycle/recommendation-hold-widget-branch";

// ---------------------------------------------------------------------------
// POST /api/lifecycle-views/publish-decision/decide -- the BROKER ANSWER to the publish card (cinatra#4758).
//
// The site widget's Allow and Do not allow. The first-party hosts answer through the cookie-bound server action; this
// route serves the widget, which presents its own `cwu_` or is refused (401), with no session fallback: the frame is
// same-origin to the app, so an ambient cookie would answer as whoever else is signed in on that browser.
//
// THREE GATES, IN ORDER: the credential at THIS route's audience with `lifecycle.decide` (the read audience one
// directory up does not admit here); the run read through its access door and bound to this widget session; then the
// SAME decision roads the app's card takes (run.execute then run.approveHitl, one guarded decision write naming this
// person, then the run released to its publishing step or stopped). Every refusal answers `{ outcome: "failed" }` at
// 200; a late answer is `{ outcome: "not_open" }`.
// ---------------------------------------------------------------------------

const requestSchema = z
  .object({
    runId: z.string().min(1).max(256),
    decisionId: z.string().min(1).max(256),
    answer: z.enum(["approve", "decline"]),
    note: z.string().max(PUBLISH_DECISION_MAX_NOTE_LENGTH).optional(),
  })
  .strict();

const NO_STORE = { headers: { "Cache-Control": "no-store" } } as const;

export async function POST(request: Request): Promise<Response> {
  const caller = await resolveWidgetRecommendationCaller(request, WIDGET_PUBLISH_DECISION_DECIDE_GRANT);
  if (!caller) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid publish decision" }, { status: 400 });
  }
  const body = parsed.data;

  const who = { actor: caller.actorCtx.actor, roleHints: caller.actorCtx.roleHints ?? {} };
  // The run READ and the widget binding come before ANY write, so an answer aimed at a run this conversation does not
  // own leaves no trace on it.
  const run = await readAgentRunById(body.runId, who.actor, who.roleHints).catch(() => null);
  if (!run || !widgetSessionOwnsRun(run, caller.claims)) {
    return Response.json({ outcome: "failed" }, NO_STORE);
  }

  const outcome = await decidePublishDecisionCardForWidgetReader(
    { runId: run.id, decisionId: body.decisionId, answer: body.answer, note: body.note ?? null },
    who,
  );
  return Response.json({ outcome }, NO_STORE);
}
