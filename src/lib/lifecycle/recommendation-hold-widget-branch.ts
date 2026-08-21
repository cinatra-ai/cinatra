import "server-only";

// ---------------------------------------------------------------------------
// THE BROKER BRANCH of the recommendation hold (cinatra#2790, epic #2784 S9f).
//
// ONE construction, two routes: the read and the decision resolve the reader the
// SAME way, differing only in the grant they consume under — so the person who
// was shown a card and the person whose decision is recorded are the same person
// by construction, not by assertion.
//
// THERE IS NO SESSION FALLBACK, and that is the whole point of this slice. The
// embed frame is same-origin to the app, so an ambient Cinatra cookie would
// happily answer a widget request — as whoever else is signed in on that
// browser. The card was withheld from the widget for exactly that reason. A
// request here proves itself with the widget's own `cwu_` or it is refused.
// ---------------------------------------------------------------------------

import { RECOMMENDATION_DECISION_REFUSAL } from "@cinatra-ai/agents/recommendation-hold";
import { dispatchRunStartForPrincipal } from "@cinatra-ai/agents/run-dispatch-core";
import type { RecommendationDispatch } from "@cinatra-ai/agents/run-recommendation-core";

import { resolveAssistantWidgetBinding } from "@/lib/assistant-widget-handles";
import { emitWidgetAuthAudit } from "@/lib/widget-auth-audit";
import {
  resolveWidgetLifecycleActorContext,
  type WidgetTokenGrant,
} from "@/lib/lifecycle/widget-lifecycle-actor";
import type { UserTokenClaims } from "@/lib/widget-user-auth";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";

/** The `cwu_` proof header — the discriminant for the widget branch. */
export const WIDGET_USER_TOKEN_HEADER = "X-Cinatra-Widget-User-Token";
/** The embed-forwarded parent (CMS) origin; re-checked against the token binding. */
export const WIDGET_ORIGIN_HEADER = "X-Cinatra-Widget-Origin";
/** The embed-forwarded assistant handle; only a selector — the token is authority. */
export const WIDGET_ASSISTANT_HEADER = "X-Cinatra-Widget-Assistant";

export type WidgetRecommendationCaller = {
  actorCtx: ReviewActorContext;
  claims: UserTokenClaims;
};

/**
 * Resolve the widget caller from the presented `cwu_`, under one grant.
 *
 * Returns `null` for every failure — an unusable bearer, an unknown handle, a
 * rejected token, a revoked membership — because the caller turns all of them
 * into the same 401 a missing credential produces. The two failures that happen
 * BEFORE the actor door are audited here, since the door never runs for them and
 * an attempt that leaves no record at all is the wrong kind of silence. No
 * identifiers: the handle is caller input and the token is a secret.
 */
export async function resolveWidgetRecommendationCaller(
  request: Request,
  grant: WidgetTokenGrant,
): Promise<WidgetRecommendationCaller | null> {
  const presented = request.headers.get(WIDGET_USER_TOKEN_HEADER);
  if (presented === null) return null;
  const token = presented.trim();
  if (token.length === 0) {
    emitWidgetAuthAudit(grant.auditRejected, { reason: "no_bearer" });
    return null;
  }
  const handle = request.headers.get(WIDGET_ASSISTANT_HEADER)?.trim().toLowerCase() ?? "";
  const binding = resolveAssistantWidgetBinding(handle);
  if (!binding) {
    emitWidgetAuthAudit(grant.auditRejected, { reason: "unknown_handle" });
    return null;
  }
  const resolved = await resolveWidgetLifecycleActorContext({
    token,
    agentSlug: binding.agentSlug,
    requestOrigin: request.headers.get(WIDGET_ORIGIN_HEADER),
    grant,
  });
  return resolved.ok ? { actorCtx: resolved.actorCtx, claims: resolved.claims } : null;
}

/**
 * THE RUN ↔ WIDGET-SESSION BINDING (issue #2790's regression: "an unrelated run
 * id cannot be projected into a widget thread").
 *
 * The run access door alone is not enough here, and saying why matters. That door
 * answers "may this person READ this run?", and for a platform admin or an org
 * owner the answer is yes for runs that have nothing to do with the conversation
 * they are looking at. A widget frame addresses its card by a run id taken off a
 * transcript part, so without a second binding a caller could name any run their
 * standing can read and have its skills question projected into a public site's
 * assistant.
 *
 * The binding is the widget principal itself: the run must belong to the org the
 * TOKEN is bound to, and must have been started BY this person. It is applied
 * BEFORE the state is read, and a failure is the same silence a run that does not
 * exist produces.
 *
 * A run with NO initiator is refused on this branch rather than admitted. In the
 * app a `runBy`-less run is decidable by any signed-in session (the trigger
 * semantics), but "anyone in the org" is not a binding to THIS conversation, and
 * a headless carrier run is exactly the kind a widget must not be able to reach
 * by id.
 */
export function widgetSessionOwnsRun(
  run: { runBy?: string | null; orgId?: string | null },
  claims: UserTokenClaims,
): boolean {
  if (!claims.userId || !claims.orgId) return false;
  if (!run.runBy) return false;
  if (run.runBy !== claims.userId) return false;
  // A run with no org recorded cannot be shown to belong to the token's org.
  if (!run.orgId || run.orgId !== claims.orgId) return false;
  return true;
}

/**
 * THE BROKER HOST'S DISPATCHER, bound to the actor this request already proved
 * (cinatra#2790, epic #2784 S9f).
 *
 * WHY IT EXISTS. A decision ends in a dispatch, and the canonical dispatch used
 * to resolve its own identity from a cookie session. On this surface there is no
 * cookie — the frame is cross-site by design — so the decision succeeded at every
 * step it owned (the credential authenticated, the park released, the selections
 * were written) and then died at the last one: the dispatch answered
 * `unauthorized`, the run stayed `pending_input`, and the card drew a refusal on
 * a decision the run had already accepted. The card must settle in place with the
 * run advancing (plan §6.4), so the entry hands the core a dispatcher carrying
 * the identity the entry itself verified — exactly as it already does for the
 * selection write.
 *
 * THERE IS NO SESSION FALLBACK HERE EITHER, and for the same reason as
 * everywhere else on this branch: the embed frame is same-origin to the app, so
 * an ambient Cinatra cookie would happily dispatch — as whoever else is signed in
 * on that browser.
 *
 * IT WIDENS NOTHING. The dispatcher is minted per request, for the ONE run the
 * caller supplied and this request already bound to the widget session, in the
 * org the credential names. It re-asserts that binding on every call — the run id
 * it is handed must be the run it was minted for, and {@link widgetSessionOwnsRun}
 * must still hold — and the dispatch core re-checks both facts again against the
 * row it loads for itself. A widget principal therefore reaches precisely the run
 * it decided and nothing else.
 */
export function widgetRunStartDispatcher(input: {
  claims: UserTokenClaims;
  /** The run row this request already read THROUGH the access door. */
  run: { id: string; runBy?: string | null; orgId?: string | null };
}): RecommendationDispatch {
  const { claims, run } = input;
  const refusal = { ok: false as const, error: RECOMMENDATION_DECISION_REFUSAL };
  return async ({ runId, templateSlug }) => {
    if (!claims.userId || !claims.orgId) return refusal;
    // Exactly the run this dispatcher was minted for — never a second one.
    if (!runId || runId !== run.id) return refusal;
    // The same binding the route consumed, re-asserted at the moment of use.
    if (!widgetSessionOwnsRun(run, claims)) return refusal;
    return dispatchRunStartForPrincipal(
      { runId, templateSlug },
      {
        via: "widget-credential",
        userId: claims.userId,
        orgId: claims.orgId,
        runId: run.id,
      },
    );
  };
}
