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
//   3. the actor, with platform standing floored (see the note below).
//
// EVERY ORG-SCOPED AXIS IS RESOLVED, NOT FLOORED. Org role, teams and project
// grants are the person's real ones, live — that is what #2577 means by "no role
// or grant axis is suppressed or floored because the surface is a widget", and
// it is what makes a widget reader see exactly the rows they see in the app.
//
// THE PLATFORM TIER IS THE ONE AXIS STILL FLOORED, AND IT IS AN OPEN QUESTION
// FOR THE OWNER (recorded, not decided here; codex rounds 0-1 on this PR).
// Round 0 read the corrected sentence literally and called the floor a parity
// shortfall — correctly: a platform admin can read something in Cinatra that the
// widget refuses them. This lane removed it and asked codex to confirm; round 1
// showed the removal is a NEW cross-org escalation. The embed receives the
// `cwu_` through a postMessage bootstrap the PARENT page composes, so the
// embedding site's own JavaScript possesses the bearer. Origin binding does not
// help against the bound origin itself. With the tier resolved live, a
// compromised CMS site would hold a platform admin's CROSS-ORG authority — over
// orgs that site has nothing to do with — and could spend it through the decide
// grant. The floor is a NARROWING, so keeping it can expose nothing; removing it
// can. The removal was therefore reverted and the conflict is stated in the PR
// body for a ruling, rather than shipped in either direction on this lane's say.
// ---------------------------------------------------------------------------

import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";
import {
  emitWidgetAuthAudit,
  type WidgetAuthAuditEvent,
} from "@/lib/widget-auth-audit";
// Steps 2 + 3 of the ladder live in the LIVE-STANDING LEAF, which this module
// delegates to rather than duplicating (cinatra#2577 split it out so the MCP
// pull's widget branch does not drag `widget-user-auth`'s synchronous postgres
// leaf onto four route-locked graphs). One resolution, one assembly, two entries.
import {
  resolveWidgetLifecycleStanding,
  type WidgetLifecycleStandingDenial,
} from "@/lib/lifecycle/widget-lifecycle-frame-actor";
import {
  WIDGET_LIFECYCLE_DECIDE_ROUTE_PATH,
  WIDGET_LIFECYCLE_DECIDE_SCOPE,
  WIDGET_LIFECYCLE_READ_ROUTE_PATH,
  WIDGET_LIFECYCLE_READ_SCOPE,
  type WidgetExtensionScope,
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

/**
 * The GRANTS a widget lifecycle request can be consumed under (cinatra#2575 +
 * #2577, corrected 2026-08-11). A grant is a (route audience, required scope)
 * pair, and it is the ONLY thing that differs between a widget read and a widget
 * decision: both build the SAME full actor, through the same ladder, against the
 * same live standing. Naming the pair here keeps the audience and the scope from
 * drifting apart at a call site.
 */
export const WIDGET_LIFECYCLE_READ_GRANT = {
  routePath: WIDGET_LIFECYCLE_READ_ROUTE_PATH,
  requiredScopes: [WIDGET_LIFECYCLE_READ_SCOPE],
  auditAuthorized: "widget_lifecycle_read_authorized",
  auditRejected: "widget_lifecycle_read_rejected",
} as const;

/**
 * The DECIDE grant — the review card's decision bar on the widget surface. It
 * authorizes reaching the one decision endpoint as this person; whether this
 * person may decide THIS gate is still the core decision module's answer, taken
 * against the same actor, in the same order, as on the review page.
 */
export const WIDGET_LIFECYCLE_DECIDE_GRANT = {
  routePath: WIDGET_LIFECYCLE_DECIDE_ROUTE_PATH,
  requiredScopes: [WIDGET_LIFECYCLE_DECIDE_SCOPE],
  auditAuthorized: "widget_lifecycle_decide_authorized",
  auditRejected: "widget_lifecycle_decide_rejected",
} as const;

/**
 * WHAT A GRANT IS, generalized (cinatra#2683, epic #2564 S8f).
 *
 * A (route audience, required scope set) pair, plus the two audit events its
 * authorization decision is recorded under. S8f gave the conversation column's
 * own data paths their grants (`@/lib/widget-conversation-grants`), and every one
 * of them is consumed through THIS door — so the type is the shape, not a union
 * of the two lifecycle constants.
 *
 * THE AUDIT EVENTS TRAVEL WITH THE GRANT, deliberately. They used to be derived
 * from an `isDecide` comparison against one constant, which is a rule that has to
 * be extended by hand every time a grant is added — and a grant whose author
 * forgot would have been recorded as a lifecycle READ. Naming the pair here means
 * a new grant cannot exist without saying where its decisions are written down.
 */
export type WidgetTokenGrant = {
  routePath: string;
  /** KNOWN scopes only — the verifier's own vocabulary. A grant cannot demand a
   *  scope this build does not recognize, which is what keeps "unknown tokens
   *  grant nothing" true from both ends. */
  requiredScopes: readonly WidgetExtensionScope[];
  auditAuthorized: WidgetAuthAuditEvent;
  auditRejected: WidgetAuthAuditEvent;
};

/** @deprecated Kept as the pre-S8f name for the two lifecycle grants. New call
 *  sites type against {@link WidgetTokenGrant}. */
export type WidgetLifecycleGrant = WidgetTokenGrant;

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
  /**
   * WHICH grant this request is consumed under. Defaults to READ so every S8a
   * call site is unchanged; the decision entry passes
   * `WIDGET_LIFECYCLE_DECIDE_GRANT`, and S8f's conversation entries pass theirs.
   * Nothing else about the ladder varies — the actor a decision is taken with is
   * byte-for-byte the actor a read is served with, which is what makes "same
   * authorization outcome on both surfaces" true rather than asserted.
   */
  grant?: WidgetTokenGrant;
}): Promise<WidgetLifecycleActorResult> {
  const grant = input.grant ?? WIDGET_LIFECYCLE_READ_GRANT;
  // The audit names the OPERATION, not just the module (codex round 0, finding
  // 6). A widget DECISION authenticated under the decide grant used to be
  // recorded as a read, which makes an investigation of a suspicious decision
  // read the wrong rows. Carried BY the grant (S8f) so a grant cannot exist
  // without naming its trail, and so the two can never disagree.
  const authorized = grant.auditAuthorized;
  const rejected = grant.auditRejected;
  // 1. THE TOKEN. Consumed at the grant's audience with the grant's scope
  //    required, so the same verifier that authorizes a chat turn decides this
  //    too — with a strictly higher bar. A token minted before the grant existed
  //    holds neither the audience nor the scope and dies here (AC-1).
  const consumed = consumeUserWidgetToken({
    token: input.token,
    agentSlug: input.agentSlug,
    routePath: grant.routePath,
    requestOrigin: input.requestOrigin,
    requiredScopes: grant.requiredScopes,
  });
  if (!consumed.ok) {
    emitWidgetAuthAudit(rejected, {
      agentSlug: input.agentSlug,
      reason: consumed.reason,
    });
    return { ok: false, reason: "token_rejected" };
  }
  const claims = consumed.claims;

  // Defensive: a row that validated but carries no principal/org cannot anchor
  // an authorization. There is no "best effort" actor to fall back to.
  if (!claims.userId || !claims.orgId) {
    emitWidgetAuthAudit(rejected, {
      agentSlug: input.agentSlug,
      reason: "unbound_principal",
    });
    return { ok: false, reason: "unbound_principal" };
  }

  // 2 + 3. THE LIVE STANDING AND THE ACTOR — the shared leaf.
  //
  //    The leaf writes the denial under THIS grant's series (cinatra#2683, codex
  //    round 1, finding 2). It used to write a READ row unconditionally and this
  //    door added a second, grant-named one beside it — so a refused upload was
  //    also recorded as a refused lifecycle read, and an investigation of either
  //    series read attempts that never happened. One denial, one row, named for
  //    the operation that was actually attempted. (The MCP-frame entry has no
  //    grant and keeps the read default, which is what it has always written.)
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
    auditRejected: rejected,
  });
  if (!standing.ok) return standing;

  emitWidgetAuthAudit(authorized, {
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

