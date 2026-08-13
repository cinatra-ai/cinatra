import "server-only";

// ---------------------------------------------------------------------------
// Live resolver for the AgentRunMcpActor at MCP-token mint time.
//
// Called by /api/llm-bridge when WayFlow → bridge has a resolved
// `agent_run` row carrying `orgId` and `runBy`. Looks up the LIVE
// platform role + org membership for that user and emits the actor or
// null (fall back to anonymous machine token).
//
// IMPORTANT: this MUST read fresh from the DB at every call (every LLM
// step inside the bridge). The run row carries the dispatcher's identity
// at dispatch time, but `enforceMcpBoundary` accepts {userId, orgId}
// without re-verifying the live `public.member` row. A demoted user
// could otherwise replay a stale token. The mint-time live check is the
// authority.
//
// Returns null and the caller falls back to the machine `client_credentials`
// token (preserves pre-fix behavior). The agent's MCP calls will then
// fail at the boundary with `not_org_member` — same outcome as before
// this fix, never an elevation.
// ---------------------------------------------------------------------------

import { eq, and } from "drizzle-orm";
import {
  betterAuthDb,
  betterAuthUsers,
  betterAuthMembers,
} from "@/lib/better-auth-db";
import type { AgentRunMcpActor } from "@cinatra-ai/llm";
import type { ActorContext } from "@/lib/authz/actor-context";
import { buildActorContextFromRun } from "@/lib/authz/build-actor-context-from-run";

function rolesIncludeAdmin(roleField: string | null | undefined): boolean {
  return String(roleField ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .includes("admin");
}

// THE PLATFORM-ADMIN FLOOR IS GONE; THE MEMBERSHIP REQUIREMENT IS NOT
// (cinatra#2674, epic #2564 S8e; sharpened by codex round 0, finding 2).
//
// cinatra#408 SUPPRESSED the `platform_admin` short-circuit for the
// `public_site_widget` source type, so a widget carrier run could never resolve
// to platform admin at all. The justification was possession — the embedding
// site held the widget bearer — and S8e ends that, so the ROLE floor ends with
// it: a widget carrier now resolves the person's real tier.
//
// BUT THE SUPPRESSION WAS DOING A SECOND JOB, and dropping it wholesale would
// have thrown that away. The admin short-circuit returns BEFORE the membership
// row is read, so a platform admin resolves whether or not they are a member of
// the run's org. That is deliberate for an in-app carrier: an operator acts
// across orgs they do not belong to. It is WRONG for a widget carrier, whose
// whole existence rests on a `cwu_` that required live org membership and whose
// contract is that membership is re-checked live. Without the requirement below,
// a platform admin who started a widget run and was then REMOVED from the org
// would keep resolving — the run's next step would still authorize — where an
// ordinary member would be denied at the next read. That is a revocation
// bypass, not parity, and #2674 says in terms that removing the floor must not
// widen "membership/revocation checks".
//
// So the widget path REQUIRES A LIVE MEMBERSHIP ROW, and then carries the real
// tier. An admin member resolves `platform_admin`; an admin who is no longer a
// member resolves nothing at all. The distinction is not a floored axis — the
// tier is carried in full — it is the widget path keeping the live-membership
// contract it has always had.
//
// Everything else on the path is untouched: the widget turn that STARTS such a
// run still passes the full dual-token sequence, and the MCP boundary's
// per-instance pin, origin binding, closed tool policy, TTL and replay
// containment all stand.
const WIDGET_SOURCE_TYPE = "public_site_widget";

/**
 * Live-resolve the AgentRunMcpActor for a (runBy, orgId, runId) triple.
 *
 * Returns:
 * - actor with `platformRole: "platform_admin"` when the user row carries the
 *   admin role. On every source type EXCEPT the widget this is irrespective of
 *   membership (an operator acts across orgs); on the WIDGET path a live
 *   `public.member` row is required first (cinatra#2674 — the tier is carried,
 *   the live-membership contract is not weakened)
 * - actor with `platformRole: "member"` when a `public.member` row exists
 *   for (userId = runBy, organizationId = orgId)
 * - `null` otherwise (caller falls back to the machine token; boundary
 *   denies with `not_org_member` — never elevates). On the widget path that
 *   includes a platform admin who is no longer a member.
 */
export async function resolveAgentRunMcpActor(input: {
  runId: string;
  runBy: string;
  orgId: string;
  /**
   * The carrier run's `source_type`. It no longer suppresses the platform tier
   * (cinatra#2674) — but on the WIDGET path it still requires a live membership
   * row before ANY actor is returned, because that path's contract is live
   * membership and an admin short-circuit would step around it.
   */
  sourceType?: string | null;
  // Returns the actor IDENTITY (no `oboCeiling`): the scope-ceiling chain is not
  // known here — it is re-derived from the run's locked template anchor and
  // attached by the mint path (llm-bridge route / context-route-io) after a
  // containment check, before the token is issued. Omit keeps this resolver's
  // single responsibility (live identity + platform-role) intact.
}): Promise<Omit<AgentRunMcpActor, "oboCeiling"> | null> {
  if (!input.runBy || !input.orgId || !input.runId) return null;
  const [userRow] = await betterAuthDb
    .select({ id: betterAuthUsers.id, role: betterAuthUsers.role })
    .from(betterAuthUsers)
    .where(eq(betterAuthUsers.id, input.runBy))
    .limit(1);
  if (!userRow) return null;
  const isWidgetCarrier = input.sourceType === WIDGET_SOURCE_TYPE;
  if (!isWidgetCarrier && rolesIncludeAdmin(userRow.role)) {
    return {
      delegation: "agent_run",
      userId: input.runBy,
      orgId: input.orgId,
      runId: input.runId,
      platformRole: "platform_admin",
    };
  }
  const [memberRow] = await betterAuthDb
    .select({ id: betterAuthMembers.id })
    .from(betterAuthMembers)
    .where(
      and(
        eq(betterAuthMembers.userId, input.runBy),
        eq(betterAuthMembers.organizationId, input.orgId),
      ),
    )
    .limit(1);
  if (!memberRow) return null;
  return {
    delegation: "agent_run",
    userId: input.runBy,
    orgId: input.orgId,
    runId: input.runId,
    // The membership row is now proven, so the WIDGET carrier's real tier can be
    // carried here without stepping around the live check (cinatra#2674 + codex
    // round 0, finding 2). For every other source type an admin has already
    // returned above, so this line reads `member` there exactly as before.
    platformRole:
      isWidgetCarrier && rolesIncludeAdmin(userRow.role) ? "platform_admin" : "member",
  };
}

// ---------------------------------------------------------------------------
// #1401 — trustworthy ActorContext for llm-bridge assigned-skill delivery.
//
// The WayFlow llm-bridge route resolves an agent's assigned skills via
// `getAssignedSkillIdsForAgent(agentId, actor?)`. Actor-less, that resolver's
// visibility filter excludes every user/team/org/project/workspace-scoped
// `custom_skill_assignments` row, so ownership-scoped assignments never reach
// agent runs. This derives the actor from the run the route ALREADY vetted
// (`runForPorts`) so scoped assignments reach the runs they were assigned to.
//
// Two authorities are composed, deliberately (build first, gate LAST):
//   1. `buildActorContextFromRun` — the authoritative run→ActorContext builder
//      (the same one `/api/a2a` uses) that expands the owner's LIVE
//      team/project/org membership. It trusts `run.orgId` WITHOUT re-checking
//      membership (it emits `organizationId: run.orgId` even when the user is
//      not an org member), which is why (2) is required and is evaluated LAST.
//   2. `resolveAgentRunMcpActor` — the SAME live-membership + cinatra#408
//      platform-admin-suppression gate the MCP OBO mint uses. It reads the LIVE
//      `member` row, so a demoted/removed run owner resolves to `null` and we
//      fail closed. Evaluated LAST so the membership decision is the FRESHEST
//      read before the built actor (which carries `organizationId: run.orgId`)
//      is trusted — without this gate, or with it evaluated before the build, a
//      stale/revoked owner would still receive org/workspace-scoped assignments.
//
// The gate's suppression-aware `platformRole` is carried onto the final actor
// so a `public_site_widget` run owned by a platform admin does NOT admin-bypass
// the scoped-skill visibility filter (cinatra#408): a widget carrier resolves
// to `member`, never `platform_admin`.
//
// FAIL-CLOSED — returns `undefined` (⇒ the caller delivers EXACTLY today's
// actor-less set, never more) for any unverifiable identity: no vetted run, a
// run with no human `runBy`, a run missing its `orgId`, a run owner who is not
// a live member (nor a non-suppressed platform admin) of the run's org, or any
// builder failure. No caller-supplied identity is ever consulted — the run is
// selected only from the auth-injected context-id / dispatcher-signed binding /
// run-token spine, never from `body.agent_run_id`.
// ---------------------------------------------------------------------------

/**
 * Narrow projection of the vetted run this resolver needs. A structural subset
 * of `AgentRunRecord` (the route's `runForPorts` type) so the route can pass the
 * run row directly. `sourceType` drives the cinatra#408 platform-admin
 * suppression via `resolveAgentRunMcpActor`.
 */
export type VerifiedRunForAssignedSkills = {
  id: string;
  runBy: string | null;
  orgId: string;
  sourceType?: string | null;
  dependentInstallId?: string | null;
} | null | undefined;

export async function resolveAssignedSkillsActorForRun(
  run: VerifiedRunForAssignedSkills,
): Promise<ActorContext | undefined> {
  if (!run) return undefined;
  // A real human run owner is required: worker-originated runs (runBy === null)
  // carry no user identity to expand, so they fail closed to actor-less rather
  // than inheriting org/workspace-scoped assignments off the bare org anchor.
  if (typeof run.runBy !== "string" || run.runBy.length === 0) return undefined;
  // `orgId` anchors the membership expansion; a run without it cannot resolve a
  // trustworthy scope. (Structurally NOT NULL in production; guard defends
  // against a corrupt/raw-SQL fixture row.)
  if (typeof run.orgId !== "string" || run.orgId.length === 0) return undefined;
  try {
    // Expand the owner's LIVE team/project/org membership. teamIds/projectIds are
    // derived from live reads (empty when the user is not a member of run.orgId);
    // organizationId is set to run.orgId UNCONDITIONALLY (buildActorContextFromRun
    // trusts the run's org without re-checking membership).
    const actor = await buildActorContextFromRun({
      id: run.id,
      runBy: run.runBy,
      orgId: run.orgId,
      dependentInstallId: run.dependentInstallId ?? null,
    });
    // Live-membership + cinatra#408 platform-admin-suppression gate, evaluated
    // LAST so the membership decision is the FRESHEST read before the actor is
    // trusted. `null` ⇒ the owner is neither a current org member nor a
    // non-suppressed platform admin ⇒ fail closed. Ordering is LOAD-BEARING:
    // because buildActorContextFromRun emits `organizationId: run.orgId`
    // unconditionally (admitting org/workspace-scoped rows), gating on the
    // freshest read HERE is what stops an owner whose membership was revoked
    // before this point from receiving those rows — the org/workspace-bearing
    // actor is returned ONLY if this gate passes. (The residual window between
    // this gate and the downstream visibility computation is the accepted
    // read-time staleness class for run-derived actors, cinatra#1131: a demoted
    // owner's already-resolved actor replays until it is re-resolved. Full
    // membership↔visibility atomicity would require a shared transaction across
    // getAssignedSkillIdsForAgent — out of scope here.)
    const liveActor = await resolveAgentRunMcpActor({
      runId: run.id,
      runBy: run.runBy,
      orgId: run.orgId,
      sourceType: run.sourceType,
    });
    if (!liveActor) return undefined;
    // Carry the GATE's platformRole — the freshest read — into the actor. Since
    // cinatra#2674 the gate suppresses nothing, so this is the person's real
    // standing on every source type including the widget, and the scoped-skill
    // visibility filter sees the same actor it would for the same person in the
    // app (the #2574 parity criterion, assigned-skill leg).
    return { ...actor, platformRole: liveActor.platformRole };
  } catch (err) {
    // Fail-closed: a membership-resolution failure delivers only the actor-less
    // set, never a partial or guessed actor. Logged (not swallowed) so a
    // partial-outage signal survives.
    console.warn(
      `[llm-bridge] assigned-skills actor derivation failed for run ${run.id}; ` +
        `falling back to actor-less delivery`,
      err,
    );
    return undefined;
  }
}
