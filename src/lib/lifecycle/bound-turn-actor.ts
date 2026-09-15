// ---------------------------------------------------------------------------
// The BOUND-TURN ACTOR (cinatra#2932, lifecycle-b W5a).
//
// From the plan (PLAN: Agents Lifecycle (B), §4, implementation note):
//
//   "The decision core (`submitReviewDecisionAction`, `approveReviewTask`,
//    `confirmTriggerScheduleProposal`) gains a bound-turn actor branch that
//    carries the person's own credential — cookie session, or the widget
//    credential minted fresh at the call — never the delegated chat token."
//
// WHAT THAT MEANS, AND WHY IT IS NOT THE PULL PRIMITIVES' ACTOR. The read side
// (`lifecycle-pull-mcp.ts`) builds its chat actor from the TRANSPORT's hints —
// platform role and org role, no teams, no project grants — and says so: that is
// deliberately narrower than the person's real standing, and narrow is safe for
// a read, because the worst outcome is a card the reader is entitled to and does
// not see.
//
// A DECISION CANNOT BE NARROW IN THAT WAY. "Using the action is pressing the
// button. Same identity, same permissions, same recorded decision." A person
// entitled to approve through a TEAM or a PROJECT grant must be able to, or the
// lent control is a worse button than the one on the card — and the failure
// would read as the assistant refusing rather than as an under-resolved actor.
//
// So this leaf resolves the person's LIVE standing at the moment of the call —
// membership now, org role now, teams now, project grants now, platform tier
// now — and hands back the same `ReviewActorContext` the review page builds. It
// is the SAME assembly the widget lifecycle actor uses (`resolveActorGrantsForUserInOrg`
// + `readUserIsPlatformAdmin` + `buildWidgetLifecycleRoleHints`, the exported
// in-app hint builder), called rather than copied, so "the person's own
// credential" has exactly one definition on every host.
//
// THE DELEGATED TOKEN IS THE TRANSPORT, NEVER THE AUTHORITY. Nothing on the
// frame's delegation — not the chat allowlist, not the widget's kind pin, not
// its `lifecycle.read` grant — is consulted here. The frame supplies WHO is
// calling; this module resolves WHAT that person may do, from the store, now.
// A membership revoked between the send and the tool call is honoured.
// ---------------------------------------------------------------------------

import "server-only";

import { resolveActorGrantsForUserInOrg } from "@/lib/auth-session";
import { readUserIsPlatformAdmin } from "@/lib/better-auth-db";
import { buildWidgetLifecycleRoleHints } from "@/lib/lifecycle/widget-lifecycle-frame-actor";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";

/** The live-standing reads, injectable so the assembly is testable without a store. */
export type BoundTurnActorPorts = {
  readonly resolveGrants: typeof resolveActorGrantsForUserInOrg;
  readonly isPlatformAdmin: typeof readUserIsPlatformAdmin;
};

const DEFAULT_PORTS: BoundTurnActorPorts = {
  resolveGrants: resolveActorGrantsForUserInOrg,
  isPlatformAdmin: readUserIsPlatformAdmin,
};

/**
 * Build the acting person's own actor context for a bound turn.
 *
 * `null` when there is nobody to act as: no attributable user, no org, or no
 * membership row in that org at this moment. A caller turns that into the same
 * refusal every other "not yours" produces — the absence of an actor is never
 * reported as a distinct reason.
 *
 * FAIL-CLOSED ON A READ ERROR. A standing lookup that throws yields `null`, so
 * an unreachable store refuses the decision rather than deciding with a stale or
 * assumed standing.
 */
export async function resolveBoundTurnActor(input: {
  readonly userId: string | null | undefined;
  readonly orgId: string | null | undefined;
  readonly ports?: Partial<BoundTurnActorPorts>;
}): Promise<ReviewActorContext | null> {
  const { userId, orgId } = input;
  if (!userId || !orgId) return null;
  const ports: BoundTurnActorPorts = { ...DEFAULT_PORTS, ...(input.ports ?? {}) };
  try {
    const grants = await ports.resolveGrants(userId, orgId);
    if (!grants.orgRole) return null;
    const platformRole = (await ports.isPlatformAdmin(userId))
      ? ("platform_admin" as const)
      : ("member" as const);
    return {
      actor: {
        actorType: "human",
        source: "agent",
        userId,
        orgId,
      },
      orgId,
      roleHints: buildWidgetLifecycleRoleHints({
        orgId,
        platformRole,
        orgRole: grants.orgRole,
        teamIds: grants.teamIds,
        teamRoles: grants.teamRoles,
        projectGrants: grants.projectGrants,
      }),
    } as ReviewActorContext;
  } catch {
    return null;
  }
}
