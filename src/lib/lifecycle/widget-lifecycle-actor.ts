import "server-only";

// ---------------------------------------------------------------------------
// The WIDGET LIFECYCLE ACTOR (cinatra#2574, epic #2564 S8a).
//
// THE PROBLEM THIS SOLVES. A widget turn already runs under a real cinatra
// principal — the `cwu_` token is minted by the hosted PKCE login against a
// Better-Auth session, an org-membership check and an explicit consent, and the
// CMS backend that redeems it cannot choose the userId. But the actor the widget
// RUNTIME builds from that principal is deliberately degraded: it hardcodes the
// member role and carries no team or project grants, because a chat turn needs a
// floor, not a permission profile. Reading lifecycle work is the opposite: every
// row is authorized against the reader's real standing, so an actor with empty
// grants does not "fail safe" — it fails WRONG. It hides a review the person is
// entitled to see through a team or a project, and it teaches the reader that
// the widget shows less than the app, which is how surfaces drift apart.
//
// So this module builds the FULL actor: the same org role, team memberships,
// team roles and project grants the in-app review surface resolves, through the
// SAME query lineage (`resolveActorGrantsForUserInOrg`), anchored to the org the
// TOKEN is bound to — never a session's active org, which the widget has no
// business reading.
//
// THE ONE DOOR. Every widget lifecycle read constructs its actor here. That is
// not a convention: the lifecycle grant is evaluated by the single token
// verifier (`consumeUserWidgetToken`'s `requiredScopes`), the degraded runtime
// context is barred from the lifecycle read paths by a structural test
// (`widget-lifecycle-degraded-actor-bar.test.ts`), and this module is the only
// producer of a `ReviewActorContext` on the widget branch.
//
// ORDER IS LOAD-BEARING AND FAIL-CLOSED, and every step can only narrow:
//   1. the token — consumed with the LIFECYCLE audience and the LIFECYCLE scope
//      required, so a session whose consent predates the grant is refused here
//      and never reaches a row (AC-1);
//   2. the live standing — org role, teams and project grants, resolved for
//      (user, token org) in ONE resolution: the org role IS the membership
//      re-check (the chat broker re-checks per turn; a read is no different — a
//      membership revoked one second ago must not serve one more row);
//   3. the actor, with platform standing FLOORED.
//
// THE PLATFORM-ROLE FLOOR (deliberate, and the one place widget ≠ app). A
// widget bearer lives in a browser on a public site and the site's backend
// possesses it by design, so it may carry the user's ORG standing — that is what
// "reading as yourself" means — but never their PLATFORM standing, which is
// cross-org and exists for operating cinatra, not for reading a CMS review. A
// platform admin therefore sees, through a widget, exactly what they would see
// without their platform tier: a strict SUBSET of the in-app set, never a
// superset. The parity fixture asserts both halves of that sentence.
// ---------------------------------------------------------------------------

import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";
import { emitWidgetAuthAudit } from "@/lib/widget-auth-audit";
// Steps 2 + 3 of the ladder live in the LIVE-STANDING LEAF, which this module
// delegates to rather than duplicating (cinatra#2577 split it out so the MCP
// pull's widget branch does not drag `widget-user-auth`'s synchronous postgres
// leaf onto four route-locked graphs). One resolution, one assembly, two entries.
import {
  resolveWidgetLifecycleStanding,
  type WidgetLifecycleStandingDenial,
} from "@/lib/lifecycle/widget-lifecycle-frame-actor";
import {
  WIDGET_LIFECYCLE_READ_ROUTE_PATH,
  WIDGET_LIFECYCLE_READ_SCOPE,
} from "@/lib/widget-lifecycle-scope";
import {
  consumeUserWidgetToken,
  type UserTokenClaims,
} from "@/lib/widget-user-auth";

// Re-exported so every S8a import path still resolves here — the split is an
// internal one, not a move of this module's public surface.
export {
  buildWidgetLifecycleRoleHints,
  resolveWidgetLifecycleActorForFrame,
  WIDGET_LIFECYCLE_PLATFORM_ROLE_FLOOR,
  type WidgetLifecycleFrameActorResult,
} from "@/lib/lifecycle/widget-lifecycle-frame-actor";

/**
 * The scopes a widget lifecycle READ requires. Passed to the single token
 * verifier; never re-implemented as a second scope comparison here.
 */
export const WIDGET_LIFECYCLE_READ_REQUIRED_SCOPES = [
  WIDGET_LIFECYCLE_READ_SCOPE,
] as const;

export type WidgetLifecycleActorDenial =
  /** The `cwu_` failed the single verifier — includes the scope/audience gate. */
  | "token_rejected"
  /** Every reason a resolved STANDING can refuse (shared with the frame entry). */
  | WidgetLifecycleStandingDenial;

export type WidgetLifecycleActorResult =
  | {
      ok: true;
      actorCtx: ReviewActorContext;
      claims: UserTokenClaims;
    }
  | { ok: false; reason: WidgetLifecycleActorDenial };

/**
 * Build the fully-resolved reviewing actor for a widget lifecycle READ.
 *
 * The caller supplies the presented bearer and the request's verified context;
 * it gets back either a `ReviewActorContext` — the exact shape every lifecycle
 * read already consumes (`resolveLifecycleCardState`, the review-gate ports) —
 * or a reason-coded denial. It NEVER returns a partially-resolved actor: an
 * actor that could not resolve its grants is not a narrower actor, it is a wrong
 * one, so the whole read is refused instead.
 *
 * The denial reason is for the AUDIT TRAIL and for the caller's own control
 * flow. It must not be echoed to the widget: the lifecycle surfaces answer every
 * denial with S1's generic `absent`, and a reason on the wire would re-open the
 * oracle that contract closes.
 */
export async function resolveWidgetLifecycleActorContext(input: {
  /** The raw presented `cwu_` bearer. */
  token: string;
  /** The agent slug the request is bound to (the handle↔token binding). */
  agentSlug: string;
  /** The request Origin — re-checked against the token's bound site origin. */
  requestOrigin: string | null;
}): Promise<WidgetLifecycleActorResult> {
  // 1. THE TOKEN. Consumed at the LIFECYCLE audience with the LIFECYCLE scope
  //    required, so the same verifier that authorizes a chat turn decides this
  //    too — with a strictly higher bar. A token minted before the grant existed
  //    holds neither the audience nor the scope and dies here (AC-1).
  const consumed = consumeUserWidgetToken({
    token: input.token,
    agentSlug: input.agentSlug,
    routePath: WIDGET_LIFECYCLE_READ_ROUTE_PATH,
    requestOrigin: input.requestOrigin,
    requiredScopes: WIDGET_LIFECYCLE_READ_REQUIRED_SCOPES,
  });
  if (!consumed.ok) {
    emitWidgetAuthAudit("widget_lifecycle_read_rejected", {
      agentSlug: input.agentSlug,
      reason: consumed.reason,
    });
    return { ok: false, reason: "token_rejected" };
  }
  const claims = consumed.claims;

  // Defensive: a row that validated but carries no principal/org cannot anchor
  // an authorization. There is no "best effort" actor to fall back to.
  if (!claims.userId || !claims.orgId) {
    emitWidgetAuthAudit("widget_lifecycle_read_rejected", {
      agentSlug: input.agentSlug,
      reason: "unbound_principal",
    });
    return { ok: false, reason: "unbound_principal" };
  }

  // 2 + 3. THE LIVE STANDING AND THE ACTOR — the shared leaf.
  //
  //    The token proves membership held at consent; this proves it holds now,
  //    against `claims.orgId` — the org the token is bound to — so a user's
  //    active org elsewhere can neither widen nor narrow what this widget
  //    session may read.
  //
  //    Membership and grants come from the SAME resolution (codex round 0,
  //    finding 2). A separate membership pre-check followed by a grant
  //    resolution is two observations of a changing fact, and any "prefer
  //    whichever answered" rule between them keeps the more generous one — so a
  //    demotion or a removal landing between the two would still hand out the
  //    older, higher standing. There `orgRole` IS the membership: absent means
  //    not a member, and there is nothing else to fall back to. (The resolver
  //    still issues several queries internally, so this is not a transactional
  //    snapshot — it is the ordinary concurrent-change boundary. What it removes
  //    is the RECONCILIATION between two role readings, which was the defect.)
  const standing = await resolveWidgetLifecycleStanding({
    userId: claims.userId,
    orgId: claims.orgId,
    auditSlug: input.agentSlug,
  });
  if (!standing.ok) return standing;

  emitWidgetAuthAudit("widget_lifecycle_read_authorized", {
    actor: claims.userId,
    orgId: claims.orgId,
    siteId: claims.siteId,
    client: claims.client,
    agentSlug: claims.agentSlug,
    siteOrigin: claims.siteOrigin,
    instanceId: claims.instanceId,
    grantedScopes: claims.grantedScopes.join(" "),
  });

  return { ok: true, actorCtx: standing.actorCtx, claims };
}

