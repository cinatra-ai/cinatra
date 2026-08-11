import "server-only";

// ---------------------------------------------------------------------------
// The BROKER-SESSION LIVENESS re-check (cinatra#2575, epic #2564 S8b).
//
// THE PROBLEM. The widget's AG-UI stream resume is authorized by a standalone
// run-bound HMAC token (cinatra#1221, option A). A signature proves who minted
// it and for which run; it proves nothing about NOW. So a person signed out
// mid-run, a site suspended by its owner, a connection revoked or its credential
// rotated, or a membership removed, all left an outstanding resume token good
// for its full ten minutes — the transport kept delivering the run's events to a
// browser whose authority had already been withdrawn. #2575 asks for the
// opposite posture on every broker surface: no standalone-token trust.
//
// WHAT THIS IS. One function that answers "is the widget session behind this
// token still alive, still bound to the same things, and still held by a member
// of that org?" — and answers it from LIVE state every time it is asked.
//
// IT REUSES THE JTI-KEYED PROBE, DELIBERATELY. `readLiveWidgetCapturePrincipal`
// (cinatra#2576, S8c) already reads a `cwu_` row by its `jti` and re-checks
// expiry against the database clock, the interactive-bearer shape, and the live
// connect site's org, origin, client and credential GENERATION — everything the
// canonical verifier checks except the request-origin comparison, which does not
// exist for a same-origin caller. Writing a second probe here would be a second
// place that decides what "alive" means, and the pair would drift. Its name says
// "capture" because a capture served by `<img>` was its first consumer; what it
// does is not capture-specific, and a token is not more or less revoked
// depending on which surface asks.
//
// WHAT IT ADDS ON TOP. Live ORG MEMBERSHIP. The token row survives a membership
// removal — it is bound to a site and a person, not to a grant — so the probe
// alone would keep a demoted or removed member streaming. Membership is resolved
// through the SAME lineage the widget lifecycle actor uses
// (`resolveActorGrantsForUserInOrg`), where the org role IS the membership:
// absent means not a member, with nothing to fall back to.
//
// NO REASONS OUT. Every caller answers a request whose only refusal is a status
// code, so a reason would be an oracle. One boolean.
// ---------------------------------------------------------------------------

import { resolveActorGrantsForUserInOrg } from "@/lib/auth-session";
import { readLiveWidgetCapturePrincipal } from "@/lib/lifecycle/widget-capture-principal";

/** What a caller's token CLAIMS, to be checked against what is live. */
export interface WidgetBrokerSessionClaim {
  /** The `cwu_` widget session id the token was minted inside. */
  widgetJti: string;
  /** The registered connect site the session was authenticated for. */
  siteId: string;
  /** The cinatra principal. */
  userId: string;
  /** The org the principal acted in. */
  orgId: string;
  /** The canonical instance the origin resolved to at login. */
  instanceId: string;
}

/**
 * Is this widget session still live, still bound as claimed, and still a member?
 *
 * `false` for: an absent, expired or swept token row; a row that is no longer an
 * interactive per-user widget bearer; a bound site that is inactive, re-bound or
 * credential-rotated; ANY disagreement between what the token claims and what
 * the row says; and a principal who is no longer a member of the claimed org.
 *
 * DISAGREEMENT REFUSES rather than adopting the live values. A token claiming a
 * different person, org, site or instance than its own session row is not a
 * token that has drifted — it is a token being used for something it was not
 * minted for, and the safe reading of "these two disagree" is never "prefer the
 * newer one".
 *
 * NEVER THROWS: a store failure is `false`, because every caller's refusal path
 * must be uniform and an exception would surface as a distinguishable 500.
 */
export async function isWidgetBrokerSessionLive(
  claim: WidgetBrokerSessionClaim,
): Promise<boolean> {
  try {
    if (!claim.widgetJti || !claim.siteId || !claim.userId || !claim.orgId || !claim.instanceId) {
      return false;
    }
    const live = readLiveWidgetCapturePrincipal(claim.widgetJti);
    if (!live) return false;
    if (
      live.userId !== claim.userId ||
      live.orgId !== claim.orgId ||
      live.siteId !== claim.siteId ||
      live.instanceId !== claim.instanceId
    ) {
      return false;
    }
    // The membership the token row cannot speak for. Same lineage as the widget
    // lifecycle actor: the org role IS the membership.
    const grants = await resolveActorGrantsForUserInOrg(claim.userId, claim.orgId);
    return Boolean(grants.orgRole);
  } catch {
    return false;
  }
}
