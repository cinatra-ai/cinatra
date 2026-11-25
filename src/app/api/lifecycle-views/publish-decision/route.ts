import "server-only";

import { z } from "zod";

import { readAgentRunById } from "@cinatra-ai/agents/store";
import {
  PUBLISH_DECISION_CARD_NONE,
  publishDecisionCardStateForWidgetRun,
  type PublishDecisionCardState,
} from "@cinatra-ai/agents/publish-decision-card-core";

import { decodePublishDecisionIslandRef } from "@/lib/lifecycle/lifecycle-card-ref";
import {
  mintWidgetPublishDecisionIslandUrl,
  WIDGET_PUBLISH_DECISION_READ_GRANT,
} from "@/lib/lifecycle/widget-lifecycle-actor";
import {
  resolveWidgetRecommendationCaller,
  widgetSessionOwnsRun,
} from "@/lib/lifecycle/recommendation-hold-widget-branch";

// ---------------------------------------------------------------------------
// GET /api/lifecycle-views/publish-decision?runId= -- the BROKER READ of the publish card (cinatra#4150).
//
// The hitl screen's road: `publish_decision` is carried by this read (its gate emits no typed interrupt), so it mints
// no view ref and is addressed by the run. The first-party hosts read through the cookie-bound server action; this
// route serves the site widget, which presents its own `cwu_` or is refused (401), with no session fallback.
//
// TWO GATES, IN ORDER: the credential at THIS route's audience with `lifecycle.read`, then the run read through its
// access door and bound to this widget session. A failure of the second answers 200 `{ state: "none" }`, the same
// silence a run with no decision produces. The route reads only; it sends no decision.
//
// THE ARTIFACTS ROWS' ADDRESSES (cinatra#4738). A widget frame sends no cookie, so an artifacts row's island is drawn
// only from an address that carries its own single-use credential, and that credential is minted HERE, for this reader,
// after both gates passed, exactly as the resolve route mints a review gate's (`mintWidgetPublishDecisionIslandUrl`
// over the same `cwu_` claims). Each row's ref must name THIS run, the run this widget session owns; a row whose
// address cannot be minted keeps `islandSrc: null` and its card frames nothing for it. The cookie hosts never reach
// this route and compose their own cookie-authenticated address from the ref.
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
  if (!state) return Response.json(PUBLISH_DECISION_CARD_NONE, NO_STORE);
  return Response.json(withWidgetIslandAddresses(state, run.id, caller.claims), NO_STORE);
}

/** Each artifacts row with a ref gets the widget address minted for exactly that row of exactly this run. */
function withWidgetIslandAddresses(
  state: PublishDecisionCardState,
  runId: string,
  claims: Parameters<typeof mintWidgetPublishDecisionIslandUrl>[0]["claims"],
): PublishDecisionCardState {
  if (state.state === "none") return state;
  const rows = state.rows.map((row) => {
    if (row.kind !== "artifacts" || row.ref === null) return row;
    const named = decodePublishDecisionIslandRef(row.ref);
    if (!named || named.runId !== runId) return { ...row, islandSrc: null };
    let islandSrc: string | null = null;
    try {
      islandSrc = mintWidgetPublishDecisionIslandUrl({
        claims,
        ref: row.ref,
        runId,
        decisionId: named.decisionId,
        input: named.input,
      });
    } catch {
      islandSrc = null;
    }
    return { ...row, islandSrc };
  });
  return { ...state, rows };
}
