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

import { resolveActorGrantsForUserInOrg } from "@/lib/auth-session";
import type { ActorRoleHints } from "@/lib/authz/build-actor-context";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";
import { emitWidgetAuthAudit, type WidgetAuthAuditEvent } from "@/lib/widget-auth-audit";
import {
  WIDGET_LIFECYCLE_DECIDE_REQUEST_ROUTE_PATH,
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

/**
 * The platform tier a widget lifecycle actor may ever carry. A named constant,
 * not a literal, so the structural bar can forbid hardcoded role literals on the
 * lifecycle read paths without this deliberate floor tripping it.
 */
export const WIDGET_LIFECYCLE_PLATFORM_ROLE_FLOOR = "member" as const;

/**
 * The scopes a widget lifecycle READ requires. Passed to the single token
 * verifier; never re-implemented as a second scope comparison here.
 */
export const WIDGET_LIFECYCLE_READ_REQUIRED_SCOPES = [
  WIDGET_LIFECYCLE_READ_SCOPE,
] as const;

/**
 * A GRANT — the (audience, required scopes, audit surface) triple one widget
 * lifecycle surface consumes its token under.
 *
 * cinatra#2575 (epic #2564 S8b). S8a had one surface, so the three values were
 * literals inside the resolver. S8b adds two more, and the failure mode of
 * letting each new caller pass its own strings is the one this whole module
 * exists to prevent: a surface that asks for a weaker audience or forgets a
 * scope does not error, it silently authorizes more than it should. So the
 * triples are DECLARED here, as a closed set, and a caller names one.
 */
export interface WidgetLifecycleGrant {
  /** The route path the token's audience must admit. */
  routePath: string;
  /** Every extension scope the surface requires, checked by the ONE verifier. */
  requiredScopes: readonly WidgetExtensionScope[];
  /**
   * The audit pair this surface writes. Spelled out as LITERALS on each grant
   * rather than assembled from the surface name, so every event this module can
   * emit is greppable and belongs to the audit module's closed union.
   */
  audit: { authorized: WidgetAuthAuditEvent; rejected: WidgetAuthAuditEvent };
}

/** Reading lifecycle work (S8a): the read grant at the resolve endpoint. */
export const WIDGET_LIFECYCLE_READ_GRANT: WidgetLifecycleGrant = {
  routePath: WIDGET_LIFECYCLE_READ_ROUTE_PATH,
  requiredScopes: WIDGET_LIFECYCLE_READ_REQUIRED_SCOPES,
  audit: {
    authorized: "widget_lifecycle_read_authorized",
    rejected: "widget_lifecycle_read_rejected",
  },
};

/**
 * ASKING for a decision to be confirmed (S8b). Requires BOTH grants: the request
 * discloses which gate is being decided and re-derives the gate's pinned set, so
 * it is a read as well as the first half of an act. Requiring only the decide
 * grant would let a session that may act but not read learn a gate's shape.
 */
export const WIDGET_LIFECYCLE_DECIDE_REQUEST_GRANT: WidgetLifecycleGrant = {
  routePath: WIDGET_LIFECYCLE_DECIDE_REQUEST_ROUTE_PATH,
  requiredScopes: [WIDGET_LIFECYCLE_READ_SCOPE, WIDGET_LIFECYCLE_DECIDE_SCOPE],
  audit: {
    authorized: "widget_lifecycle_decide_request_authorized",
    rejected: "widget_lifecycle_decide_request_rejected",
  },
};

/**
 * SPENDING a confirmed decision (S8b). Both grants again, for the same reason
 * and one more: the broker endpoint enforces run READ before the decision op,
 * exactly as the first-party gate-scoped entry does, so a token that cannot read
 * must not reach the check that would tell it whether a gate is there.
 */
export const WIDGET_LIFECYCLE_DECIDE_GRANT: WidgetLifecycleGrant = {
  routePath: WIDGET_LIFECYCLE_DECIDE_ROUTE_PATH,
  requiredScopes: [WIDGET_LIFECYCLE_READ_SCOPE, WIDGET_LIFECYCLE_DECIDE_SCOPE],
  audit: {
    authorized: "widget_lifecycle_decide_authorized",
    rejected: "widget_lifecycle_decide_rejected",
  },
};

export type WidgetLifecycleActorDenial =
  /** The `cwu_` failed the single verifier — includes the scope/audience gate. */
  | "token_rejected"
  /** The token is valid but its bound principal is no longer an org member. */
  | "not_org_member"
  /** The token carries no usable principal/org binding (defensive). */
  | "unbound_principal";

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
   * WHICH grant the calling surface consumes under (cinatra#2575). Defaults to
   * the READ grant, so every S8a caller is byte-unchanged. A caller may only
   * pass one of the declared triples above — never a hand-assembled one.
   */
  grant?: WidgetLifecycleGrant;
}): Promise<WidgetLifecycleActorResult> {
  const grant = input.grant ?? WIDGET_LIFECYCLE_READ_GRANT;
  const { authorized, rejected } = grant.audit;

  // 1. THE TOKEN. Consumed at the GRANT's audience with the GRANT's scopes
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

  // 2. THE LIVE STANDING — ONE resolution, in the TOKEN's org.
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
  //    older, higher standing. Here `orgRole` IS the membership: absent means
  //    not a member, and there is nothing else to fall back to. (The resolver
  //    still issues several queries internally, so this is not a transactional
  //    snapshot — it is the ordinary concurrent-change boundary. What it removes
  //    is the RECONCILIATION between two role readings, which was the defect.)
  const grants = await resolveActorGrantsForUserInOrg(claims.userId, claims.orgId);
  if (!grants.orgRole) {
    emitWidgetAuthAudit(rejected, {
      actor: claims.userId,
      orgId: claims.orgId,
      agentSlug: input.agentSlug,
      siteOrigin: claims.siteOrigin,
      reason: "not_org_member",
    });
    return { ok: false, reason: "not_org_member" };
  }

  // 3. THE ACTOR. `source: "a2a"` maps to `authSource: "a2a"`, matching the
  //    widget runtime's existing actor marking so a widget-originated authz
  //    audit row stays distinguishable from an in-app one. `authSource` is audit
  //    metadata; it is never consulted by a `can()` decision, so it cannot make
  //    this actor decide differently from the in-app one.
  const actorCtx: ReviewActorContext = {
    actor: {
      actorType: "human",
      source: "a2a",
      userId: claims.userId,
      orgId: claims.orgId,
    },
    orgId: claims.orgId,
    roleHints: buildWidgetLifecycleRoleHints({
      orgId: claims.orgId,
      orgRole: grants.orgRole,
      teamIds: grants.teamIds,
      teamRoles: grants.teamRoles,
      projectGrants: grants.projectGrants,
    }),
  };

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

  return { ok: true, actorCtx, claims };
}

/**
 * Assemble the role hints from a resolved grant bundle.
 *
 * Mirrors the in-app review actor's hint assembly exactly — the same axes, the
 * same "omit an axis the lineage did not resolve rather than forcing an
 * under-grant" rule — with ONE difference, which is the whole security posture
 * of this module: `platformRole` is the floor, never a resolved value.
 *
 * Exported so the parity fixture can drive it directly against the in-app hints
 * for the same bundle: the assertion is about these two assemblies, so the test
 * must call this one, not a copy of it.
 */
export function buildWidgetLifecycleRoleHints(input: {
  orgId: string;
  orgRole?: "org_owner" | "org_admin" | "member";
  teamIds?: string[];
  teamRoles?: Record<string, "team_admin" | "member">;
  projectGrants?: ActorRoleHints["projectGrants"];
}): ActorRoleHints {
  return {
    platformRole: WIDGET_LIFECYCLE_PLATFORM_ROLE_FLOOR,
    ...(input.orgRole ? { orgRole: input.orgRole } : {}),
    ...(input.teamRoles ? { teamRoles: input.teamRoles } : {}),
    ...(input.teamIds ? { teamIds: input.teamIds } : {}),
    ...(input.projectGrants ? { projectGrants: input.projectGrants } : {}),
    actorOrganizationId: input.orgId,
  };
}
