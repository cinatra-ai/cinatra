/**
 * Visibility predicate for assigned skill rows.
 *
 * The visibility filter is applied at READ time on the
 * `getAssignedSkillIdsForAgent()` reader. Per-level dispatch ensures
 * scoped skills (personal/team/organization/workspace/project) do not
 * leak to actors who are not part of the owning scope.
 *
 * Matching is decoupled from access control by design: the matcher LLM
 * evaluates pairs without knowing the actor; this predicate is the
 * post-match access guard.
 *
 * The workspace tier means every workspace user can use the resource.
 * This predicate allows workspace-level rows for all authenticated
 * workspace actors. Platform admins are short-circuited above and see
 * everything.
 *
 * Defensive belt-and-suspenders: rows referencing skills no longer in
 * the live catalog map are filtered out. This catches missed cleanup
 * hooks, such as a `cleanupForSkill()` job that did not finish.
 */

import type { SkillMatchRow } from "./types";
import type {
  AgentAuthPolicy,
  AgentAuthPolicyVisibility,
} from "@cinatra-ai/agents/auth-policy";

export type VisibilityActor = {
  userId?: string;
  teamIds: string[];
  projectIds: string[];
  orgId?: string;
  /**
   * Set to "platform_admin" to bypass all per-level checks. Mirrors the
   * `actor.platformRole === "platform_admin"` short-circuit used by
   * `requireResourceAccess` in `@cinatra-ai/agents`.
   */
  platformRole?: "platform_admin" | "member";
};

export type VisibilitySkillMeta = {
  level: string;
  /** Owner id (user / team / org / project). Optional because some legacy rows omit it. */
  scope?: string;
  /** Set for `level: "agent"` skills - the canonical packageId of the owning agent. */
  agentId?: string;
  /**
   * Canonical EFFECTIVE access policy (multi-scope access W4, #1073) — the
   * skill's own `accessPolicy` else the parent package's, resolved by the feeder
   * (`resolveEffectiveSkillAccessPolicy` in @cinatra-ai/skills). When present its
   * `runListVisibility` union is the SOLE membership decision (any-match), so an
   * OR-policy like `[team:t1, project:p2]` admits members of EITHER scope — a
   * projection the single `(level, scope)` tuple below cannot represent. Absent
   * ⇒ the transitional `(level, scope)` fallback runs.
   */
  accessPolicy?: AgentAuthPolicy | null;
  /**
   * DURABLE owner identity for user-authored (personal/custom) skills
   * (cinatra#1416, AC1). `scope` is a projection of the access policy and
   * stops naming the owner once the skill is shared; this field never
   * changes. When set, the owner is admitted regardless of the policy union
   * (mirrors `requireResourceAccess`'s durable-owner short-circuit).
   */
  ownerUserId?: string;
};

const SCOPED_LEVELS = new Set(["personal", "team", "organization", "workspace", "project"]);

/**
 * Any-match decision for the canonical access-policy union in the LLM-matching
 * read filter (W4). Mirrors the per-token semantics of `requireResourceAccess`
 * / `matchSkillAccessToken`, adapted to the roleless read-time `VisibilityActor`
 * (no org-role / manage tier — list filtering is read-only). A single-token
 * policy reproduces the exact legacy per-level decision; multi-token is their OR.
 *
 *   workspace    → authenticated workspace user (userId + orgId)
 *   org:<id>     → actor's active org equals <id>
 *   team:<id>    → actor is a member of team <id>
 *   project:<id> → actor holds a grant on project <id>
 *   owner        → actor is the skill owner (`skill.scope` is the owner id)
 *   org (legacy) → bind to the skill's owning org (`skill.scope`), fail closed
 *   admin        → deny (platform_admin is short-circuited by the caller)
 */
function actorMatchesSkillPolicy(
  tokens: readonly AgentAuthPolicyVisibility[],
  actor: VisibilityActor,
  skill: VisibilitySkillMeta,
): boolean {
  const owner = skill.scope ?? "";
  return tokens.some((token) => {
    if (token === "workspace") return Boolean(actor.orgId && actor.userId);
    if (token.startsWith("org:")) return actor.orgId === token.slice("org:".length);
    if (token === "org") return owner !== "" && actor.orgId === owner;
    if (token.startsWith("team:")) return actor.teamIds.includes(token.slice("team:".length));
    if (token.startsWith("project:")) return actor.projectIds.includes(token.slice("project:".length));
    if (token === "owner") {
      // Durable owner identity first (cinatra#1416): the tuple's scope stops
      // naming the owner once the skill is shared.
      if (skill.ownerUserId) return actor.userId === skill.ownerUserId;
      return owner !== "" && actor.userId === owner;
    }
    // "admin" and anything unrecognized: deny (platform_admin already returned
    // above in the caller's short-circuit).
    return false;
  });
}

/**
 * Visibility filter applied at READ time.
 *
 * Rows for `level: "agent"` and `level: "system"` are passed through
 * unchanged. Those branches are handled by the caller's per-level
 * dispatch in `getAssignedSkillIdsForAgent`, but the filter is
 * defensive: it does not strip them.
 *
 * Rows with `level: "third-party"` also pass through unchanged by this
 * filter: once installed they are globally visible and have no per-actor
 * visibility rule. The filter's pass-through for non-SCOPED_LEVELS
 * values preserves those semantics.
 *
 * Rows for SCOPED_LEVELS are filtered:
 *  - personal     -> skill.scope === actor.userId
 *  - team         -> skill.scope in actor.teamIds
 *  - organization -> skill.scope === actor.orgId
 *  - workspace    -> any authenticated workspace user
 *  - project      -> skill.scope in actor.projectIds
 *
 * Platform admins (`actor.platformRole === "platform_admin"`) see
 * everything: the short-circuit returns the input rows untouched.
 *
 * Defensive belt-and-suspenders: rows whose `skillId` is not in
 * `skillsById` are filtered out because the referenced skill is no
 * longer installed.
 */
export function filterMatchRowsByVisibility(
  rows: SkillMatchRow[],
  skillsById: Map<string, VisibilitySkillMeta>,
  actor: VisibilityActor,
): SkillMatchRow[] {
  if (actor.platformRole === "platform_admin") return rows;
  return rows.filter((row) => {
    const skill = skillsById.get(row.skillId);
    if (!skill) return false; // defensive: skill no longer installed
    const level = skill.level;
    // DURABLE-owner short-circuit (cinatra#1416, AC1): the owner of a
    // user-authored skill always sees it — sharing must never lock the owner
    // out of their own skill's delivery (the policy union strips the
    // redundant `owner` token when broadened, and the projected tuple's
    // scope names the granted locus, not the owner).
    if (skill.ownerUserId && actor.userId && actor.userId === skill.ownerUserId) {
      return true;
    }
    // Canonical multi-scope enforcement (W4, #1073). When the effective policy
    // is present it is the SOLE membership decision (any-match) — the tuple
    // below can't represent an OR-policy. Applies at every level EXCEPT the
    // structural pass-throughs (agent/system/third-party) whose visibility is
    // decided by their bundling, not a per-actor scope union.
    const tokens = skill.accessPolicy?.runListVisibility;
    if (SCOPED_LEVELS.has(level) && tokens && tokens.length > 0) {
      return actorMatchesSkillPolicy(tokens, actor, skill);
    }
    if (!SCOPED_LEVELS.has(level)) return true; // agent / system / third-party pass through

    // "Workspace: All" means every workspace user, but the actor must be
    // an authenticated workspace user (userId + orgId). An org-less or
    // identity-less shape, such as a cookieless hosted-MCP path before
    // the actor envelope's orgId is threaded through, must not match
    // workspace rows wholesale. Workspace skills have scope:undefined,
    // so this must short-circuit before the empty-owner deny.
    if (level === "workspace") return Boolean(actor.orgId && actor.userId);

    const owner = skill.scope ?? "";
    // Defensive empty-string deny. Without this, a scope-less row
    // (`skill.scope` undefined -> `owner === ""`) and an identity-less
    // actor (`actor.userId` undefined -> `"" === ""`) leak the row past
    // the visibility filter for personal/team/organization/project
    // levels. The Better Auth session always carries a userId for
    // authenticated callers and the agents-store wraps unauthenticated
    // callers in a minimal envelope; but the predicate is the security
    // boundary and must not rely on upstream callers always populating
    // every identity slot. Empty owner OR empty actor slot -> DENY.
    if (!owner) return false;
    if (level === "personal") {
      if (!actor.userId) return false;
      return owner === actor.userId;
    }
    if (level === "team") return actor.teamIds.includes(owner);
    if (level === "organization") {
      if (!actor.orgId) return false;
      return owner === actor.orgId;
    }
    // Workspace handled above: every authenticated workspace user passes.
    if (level === "project") return actor.projectIds.includes(owner);
    return false;
  });
}
