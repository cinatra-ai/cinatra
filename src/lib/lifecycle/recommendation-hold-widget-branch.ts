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
