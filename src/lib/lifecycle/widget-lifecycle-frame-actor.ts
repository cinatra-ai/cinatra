import "server-only";

// ---------------------------------------------------------------------------
// The WIDGET LIFECYCLE ACTOR — LIVE-STANDING LEAF (cinatra#2574 S8a, split out
// by cinatra#2577 S8d).
//
// This is steps 2 and 3 of S8a's ladder — resolve the reader's LIVE standing in
// the token's org, then assemble the actor with that standing, the platform
// tier included since cinatra#2674 (epic #2564 S8e) — and
// nothing else. Step 1, the `cwu_` consume, lives in `widget-lifecycle-actor.ts`
// and stays THE ONE DOOR for a presented bearer.
//
// WHY IT IS A SEPARATE FILE, AND IT IS NOT ABOUT TIDINESS. S8d gave the MCP pull
// primitives a widget branch, and those primitives are registered on the MCP
// server, which is reachable from `/api/mcp`, `/api/a2a`, `/api/llm-bridge` and
// `/chat` — four routes carrying LOCKED first-party-graph budgets (the
// route-graph ratchet). The token door imports `@/lib/widget-user-auth`, which
// pulls the whole synchronous postgres store leaf and the connect-sites reader:
// fifteen modules onto each of those four routes, for a code path a widget frame
// never executes (it has no `cwu_` to consume). Splitting the two halves keeps
// the producer's reach to what it actually uses.
//
// THERE IS STILL EXACTLY ONE ASSEMBLY. Both entries call the SAME resolution and
// the SAME hint builder here — the token door delegates rather than duplicating —
// so "the widget reader's standing" has one definition, and the parity fixture
// that pins it against the in-app hints drives this file.
// ---------------------------------------------------------------------------

import { resolveActorGrantsForUserInOrg } from "@/lib/auth-session";
// cinatra#2674 (epic #2564 S8e) — the LIVE platform tier. This adds no module
// to the four route-locked graphs this file was split out to protect:
// `@/lib/auth-session` above already imports `@/lib/better-auth-db`, so the
// reader is a named export off a module that is already in reach.
import { readUserIsPlatformAdmin } from "@/lib/better-auth-db";
import type { ActorRoleHints } from "@/lib/authz/build-actor-context";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";
import {
  emitWidgetAuthAudit,
  type WidgetAuthAuditEvent,
} from "@/lib/widget-auth-audit";

/**
 * The platform tier a widget lifecycle actor carries when the reader is NOT a
 * platform admin. A named constant, not a literal, so the structural bar can
 * forbid hardcoded role literals on the lifecycle read paths without this
 * ordinary default tripping it.
 *
 * IT IS NO LONGER A CEILING (cinatra#2674, epic #2564 S8e). It used to be named
 * for the floor it imposed, and that floor's whole justification was that the
 * embedding site possessed the widget bearer. The frame-owned sign-in ends that
 * possession, so a reader who IS a platform admin now carries `platform_admin`
 * here exactly as they do in the app. The name changed with the meaning, so a
 * caller cannot keep reading a default as a guarantee.
 */
export const WIDGET_LIFECYCLE_DEFAULT_PLATFORM_ROLE = "member" as const;

/** Why a widget lifecycle read was refused. Shared with the token door, which
 *  adds the one reason only a presented bearer can produce. */
export type WidgetLifecycleStandingDenial = "not_org_member" | "unbound_principal";

/**
 * The MCP-frame entry's result (cinatra#2577). Deliberately carries no `claims`:
 * that entry never saw a `cwu_` row, and a nullable field would let a caller
 * reach for claims that structurally cannot be there.
 */
export type WidgetLifecycleFrameActorResult =
  | { ok: true; actorCtx: ReviewActorContext }
  | { ok: false; reason: WidgetLifecycleStandingDenial };

/**
 * The reader's live standing, resolved in the given org, as a `ReviewActorContext`.
 * Shared by BOTH entries — the token door calls it with the claims' org, the MCP
 * frame with the frame's — so there is one resolution and one assembly.
 *
 * Returns a denial rather than a narrower actor: an actor whose grants could not
 * be resolved is not safer, it is WRONG, and it would hide work its reader is
 * entitled to. Membership and grants come from ONE resolution (`orgRole` IS the
 * membership), never two observations of a changing fact.
 */
export async function resolveWidgetLifecycleStanding(input: {
  userId: string;
  orgId: string;
  /** Audit context only — the connector kind or agent slug. Never an authz input. */
  auditSlug: string;
  /**
   * WHICH series a standing denial is written to (cinatra#2683, codex round 1,
   * finding 2).
   *
   * This leaf is shared by every widget entry, and it used to record every
   * denial as a lifecycle READ. Once the conversation grants started coming
   * through it, a revoked user's refused ATTACHMENT UPLOAD was filed as a
   * lifecycle read — so an investigation filtered on the upload series missed
   * it, and the read series carried attempts that never happened. The caller
   * that knows the grant names the series; the MCP-frame entry has no grant and
   * keeps the read default it always had.
   */
  auditRejected?: WidgetAuthAuditEvent;
}): Promise<WidgetLifecycleFrameActorResult> {
  const grants = await resolveActorGrantsForUserInOrg(input.userId, input.orgId);
  // The PLATFORM tier, resolved live from the user record alongside the org axes
  // (cinatra#2674). It is read HERE, in the one shared assembly, so the token
  // door and the MCP-frame entry cannot carry different tiers for the same
  // person. `readUserIsPlatformAdmin` is fail-closed on any read error — an
  // unreadable role is `member`, which can only ever narrow.
  const platformRole = (await readUserIsPlatformAdmin(input.userId))
    ? ("platform_admin" as const)
    : WIDGET_LIFECYCLE_DEFAULT_PLATFORM_ROLE;
  if (!grants.orgRole) {
    emitWidgetAuthAudit(input.auditRejected ?? "widget_lifecycle_read_rejected", {
      actor: input.userId,
      orgId: input.orgId,
      agentSlug: input.auditSlug,
      reason: "not_org_member",
    });
    return { ok: false, reason: "not_org_member" };
  }
  return {
    ok: true,
    actorCtx: {
      // `source: "a2a"` maps to `authSource: "a2a"`, matching the widget
      // runtime's existing actor marking so a widget-originated authz audit row
      // stays distinguishable from an in-app one. `authSource` is audit metadata;
      // it is never consulted by a `can()` decision, so it cannot make this actor
      // decide differently from the in-app one.
      actor: {
        actorType: "human",
        source: "a2a",
        userId: input.userId,
        orgId: input.orgId,
      },
      orgId: input.orgId,
      roleHints: buildWidgetLifecycleRoleHints({
        orgId: input.orgId,
        platformRole,
        orgRole: grants.orgRole,
        teamIds: grants.teamIds,
        teamRoles: grants.teamRoles,
        projectGrants: grants.projectGrants,
      }),
    },
  };
}

/**
 * The SAME actor, for a widget lifecycle read that arrives across the MCP
 * boundary (cinatra#2577, epic #2564 S8d).
 *
 * WHY THIS IS A SECOND ENTRY AND NOT A SECOND DOOR. The function above starts
 * from a presented `cwu_` bearer, because the surfaces it serves are handed
 * one. A lifecycle PULL primitive is not: the `cwu_` never crosses the MCP
 * boundary. What crosses is the widget OBO token — turn-bound, 120 s-lived,
 * signed by this deployment, minted by the route FROM that same `cwu_` consume,
 * and carrying the `lifecycle.read` grant as its `lcr` claim beside the identity
 * and the instance pin it already carried. So steps 2 and 3 of the ladder are
 * identical and shared; only step 1 differs in WHICH signed artifact proves the
 * grant, and neither artifact is caller input.
 *
 * The CALLER must have checked the grant. This function takes the already-proven
 * `(userId, orgId)` of a widget frame and refuses to guess about consent: it is
 * not reachable from anywhere a grant has not been asserted, and the one caller
 * (`lifecycle-pull-mcp.ts`) asserts it on the frame before calling.
 *
 * Everything that can CHANGE between consent and this read is still re-resolved
 * here, live: membership, org role, teams, project grants. A revoked membership
 * or a demotion that lands mid-turn is honoured on the very next read.
 */
export async function resolveWidgetLifecycleActorForFrame(input: {
  /** The widget OBO frame's verified end user (`sub`). */
  userId: string;
  /** The widget OBO frame's verified org (`org`) — the read is scoped to it. */
  orgId: string;
  /** The connector kind the frame is bound to. Audit only; never an authz input. */
  kind: string;
}): Promise<WidgetLifecycleFrameActorResult> {
  if (!input.userId || !input.orgId) {
    emitWidgetAuthAudit("widget_lifecycle_read_rejected", {
      agentSlug: input.kind,
      reason: "unbound_principal",
    });
    return { ok: false, reason: "unbound_principal" };
  }

  const standing = await resolveWidgetLifecycleStanding({
    userId: input.userId,
    orgId: input.orgId,
    auditSlug: input.kind,
  });
  if (!standing.ok) return standing;

  emitWidgetAuthAudit("widget_lifecycle_read_authorized", {
    actor: input.userId,
    orgId: input.orgId,
    agentSlug: input.kind,
  });

  return standing;
}

/**
 * Assemble the role hints from a resolved grant bundle.
 *
 * Mirrors the in-app review actor's hint assembly EXACTLY — the same axes, the
 * same "omit an axis the lineage did not resolve rather than forcing an
 * under-grant" rule, and, since cinatra#2674, the same platform tier. There is
 * no longer a difference to describe: this is the in-app assembly, driven by a
 * widget-authenticated principal instead of a cookie-authenticated one.
 *
 * Exported so the parity fixture can drive it directly against the in-app hints
 * for the same bundle: the assertion is about these two assemblies, so the test
 * must call this one, not a copy of it.
 */
export function buildWidgetLifecycleRoleHints(input: {
  orgId: string;
  /** The reader's REAL platform tier. Defaults to `member` when a caller cannot
   *  resolve one — an unresolved tier narrows, it never elevates. */
  platformRole?: "platform_admin" | "member";
  orgRole?: "org_owner" | "org_admin" | "member";
  teamIds?: string[];
  teamRoles?: Record<string, "team_admin" | "member">;
  projectGrants?: ActorRoleHints["projectGrants"];
}): ActorRoleHints {
  return {
    platformRole: input.platformRole ?? WIDGET_LIFECYCLE_DEFAULT_PLATFORM_ROLE,
    ...(input.orgRole ? { orgRole: input.orgRole } : {}),
    ...(input.teamRoles ? { teamRoles: input.teamRoles } : {}),
    ...(input.teamIds ? { teamIds: input.teamIds } : {}),
    ...(input.projectGrants ? { projectGrants: input.projectGrants } : {}),
    actorOrganizationId: input.orgId,
  };
}
