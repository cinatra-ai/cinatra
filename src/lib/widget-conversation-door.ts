import "server-only";

// ---------------------------------------------------------------------------
// THE LIGHT DOOR onto the widget branch (cinatra#2683, epic #2564 S8f).
// ---------------------------------------------------------------------------
// Every conversation route S8f opened a widget branch on imports THIS module and
// nothing heavier. It holds two things: the header names that discriminate the
// branch, and a lazy entry that loads the actual ladder.
//
// WHY THE SPLIT IS NOT COSMETIC. The ladder pulls `widget-user-auth`'s
// synchronous postgres leaf, the connect-sites reader and the authz kernel —
// dozens of modules a FIRST-PARTY request never executes, because it presents no
// `cwu_` to consume. Statically importing them from `/api/assistants/autosave`
// (a two-field settings route) would put all of them on that route's graph, for
// a code path that runs only when a widget declares itself. cinatra#2577 split
// the live-standing leaf out for exactly this reason; this is the same
// discipline one level up.
//
// NOTHING ABOUT THE AUTH CHANGES HERE. The lazy entry is the only entry: it
// cannot answer, cannot fall back, and cannot be skipped. All it decides is WHEN
// the ladder is loaded, which is "when a caller says it is a widget".
// ---------------------------------------------------------------------------

import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";
import type { ActorContext } from "@/lib/authz/actor-context";
import type { WidgetTokenGrant } from "@/lib/lifecycle/widget-lifecycle-actor";
import type { UserTokenClaims } from "@/lib/widget-user-auth";

/** The `cwu_` proof header — the discriminant for the widget branch. */
export const WIDGET_USER_TOKEN_HEADER = "X-Cinatra-Widget-User-Token";
/** The embed-forwarded parent (CMS) origin; re-checked against the token binding. */
export const WIDGET_ORIGIN_HEADER = "X-Cinatra-Widget-Origin";
/** The embed-forwarded assistant handle; only a selector — the token is the authority. */
export const WIDGET_ASSISTANT_HEADER = "X-Cinatra-Widget-Assistant";

/**
 * Does this request DECLARE itself a widget request?
 *
 * PRESENCE, not usability. Selecting the widget branch only for a non-empty
 * token would send a request that DID present the widget header — with an empty
 * or whitespace value — down the session branch, where an ambient cookie would
 * answer it as somebody else. A caller that declares itself a widget is a
 * widget, and a widget whose token is unusable is refused by the ladder.
 *
 * A route reads this ONCE and branches on it. It must never ask a second
 * question to decide the branch: the second question belongs to the ladder, and
 * the ladder's answer to it is "no".
 */
export function isWidgetBranchRequest(request: Request): boolean {
  return request.headers.get(WIDGET_USER_TOKEN_HEADER) !== null;
}

/** The authenticated widget caller: who they are, and what their token proved. */
export type WidgetConversationCaller = {
  /** The S8a FULL actor — live standing, platform tier floored. */
  actorCtx: ReviewActorContext;
  /** The consumed token's claims. `userId`/`orgId` are the WIDGET PRINCIPAL and
   *  are the only identity a per-row check may use. */
  claims: UserTokenClaims;
  /** The same actor in the authz kernel's shape, for a route whose server module
   *  takes an `ActorContext` (the `can()` checks, the decision executor). */
  kernelActor: ActorContext;
};

/**
 * Authenticate the widget branch, loading the ladder on demand.
 *
 * Returns `null` for EVERY failure — an unusable bearer, an unknown handle, a
 * rejected token, a revoked membership — because the caller turns all of them
 * into the one refusal a missing credential produces. Distinguishing them on the
 * wire would make the endpoint an oracle for facts (which handles exist, which
 * tokens are live) the caller has no standing to learn.
 */
export async function authenticateWidgetConversationRequest(
  request: Request,
  grant: WidgetTokenGrant,
): Promise<WidgetConversationCaller | null> {
  const { authenticateWidgetConversationRequest: authenticate } = await import(
    "@/lib/widget-conversation-branch"
  );
  return authenticate(request, grant);
}
