// ---------------------------------------------------------------------------
// Agent-template RUN SCOPE evaluator — cinatra#2485 work item C.
//
// The install (or later-set) scope of an agent template is THE run-authorization
// gate: in-scope ⇒ run, out-of-scope ⇒ refuse. There is no separate "a run must
// be approved" gate, and no universal admin bypass.
//
// PURPOSE-BUILT, deliberately NOT `evaluateExtensionAccess`
// (`packages/extensions/src/enforce-extension-access.ts`): that evaluator grants
// `platform_admin` access to EVERY extension unconditionally (its
// "platform_admin bypasses every gate" short-circuit) and admits an org
// admin at every visibility tier. The locked model for RUN authorization has no
// universal grant — an admin's standing counts at ORG scope, and nowhere else.
// Reusing it here would silently hand every platform admin the right to run
// every personal/team/project-scoped agent in the instance.
//
// The locked four-level rule (owner decisions, epic #2485):
//   personal (`owner_level='user'`)   → the owning user, and only them
//   team     (`owner_level='team'`)   → `actor.teamIds ∋ owner_id`
//   project  (`owner_level='project'`)→ `actor.projectIds` / `projectGrants ∋ owner_id`
//   organization                      → a member of the owning org;
//                                       org_owner/org_admin standing counts HERE
//   anything else (null / 'workspace' / 'platform' / corrupt) → DENY
//
// `published` is NOT an authorization tier. A published agent is runnable within
// its scope, never globally: DISCOVERY may stay public, INVOCATION is scope-
// bound. That is why this evaluator never reads `status`.
//
// PURE — no I/O, no DB, no `server-only`. The async resolution/enforcement
// wrapper lives in `./agent-template-scope-guard`.
// ---------------------------------------------------------------------------

import type { ActorContext } from "@/lib/authz/actor-context";

/** The four scope levels that can authorize a run. */
export const AGENT_TEMPLATE_SCOPE_LEVELS = [
  "user",
  "team",
  "project",
  "organization",
] as const;

export type AgentTemplateScopeLevel =
  (typeof AGENT_TEMPLATE_SCOPE_LEVELS)[number];

/**
 * The minimum template projection the evaluator needs — mirrors the
 * `agent_templates` ownership columns (`organization_id` / `owner_level` /
 * `owner_id`). `status` is deliberately absent: publication is not authority.
 */
export type AgentTemplateScopeRef = {
  id: string;
  orgId: string | null;
  ownerLevel: string | null;
  ownerId: string | null;
};

export type AgentTemplateScopeDenyReason =
  /** No actor could be resolved for the run at all — fail closed. */
  | "no_actor"
  /** The actor belongs to a different organization than the template. */
  | "cross_org"
  /** `owner_level` is null / not one of the four levels, or `owner_id` is
   *  missing where the level requires one. Never guessed — always denied. */
  | "unknown_scope"
  /** personal scope, actor is not the owning user. */
  | "not_owner"
  /** team scope, actor does not hold the owning team. */
  | "not_team_member"
  /** project scope, actor holds no grant on the owning project. */
  | "not_project_member"
  /** organization scope, actor is not a member of the owning org. */
  | "not_org_member";

/** How an allowed decision was reached (audit/diagnostic detail). */
export type AgentTemplateScopeGrant =
  | "owner"
  | "team_member"
  | "project_member"
  | "org_member"
  | "org_admin";

export type AgentTemplateScopeDecision =
  | { allowed: true; level: AgentTemplateScopeLevel; via: AgentTemplateScopeGrant }
  | {
      allowed: false;
      reason: AgentTemplateScopeDenyReason;
      level: AgentTemplateScopeLevel | null;
    };

/**
 * Thrown by {@link assertActorWithinAgentTemplateScope}. Carries the machine-
 * readable reason so a caller can map it to its own refusal shape (a run
 * failure, an MCP error payload, an action result) without string matching.
 */
export class AgentTemplateScopeError extends Error {
  readonly code = "AGENT_TEMPLATE_SCOPE_DENIED" as const;
  readonly reason: AgentTemplateScopeDenyReason;
  readonly level: AgentTemplateScopeLevel | null;
  readonly templateId: string;
  /** Which enforcement layer refused (create / dispatch / execute). */
  readonly stage: string;

  constructor(input: {
    templateId: string;
    reason: AgentTemplateScopeDenyReason;
    level: AgentTemplateScopeLevel | null;
    stage?: string;
  }) {
    super(
      `agent-template-scope: ${input.stage ?? "check"} refused for template ` +
        `${input.templateId} — ${input.reason}` +
        (input.level ? ` (scope: ${input.level})` : ""),
    );
    this.name = "AgentTemplateScopeError";
    this.reason = input.reason;
    this.level = input.level;
    this.templateId = input.templateId;
    this.stage = input.stage ?? "check";
  }
}

/**
 * Normalize a persisted `owner_level` to one of the four authorizing levels.
 *
 * `null`, `'workspace'`, `'platform'` and any unrecognized value return `null`
 * — the caller DENIES. This is the deliberate divergence from
 * `normalizeOwnerLevel` (`src/lib/authz/resource-ref.ts`), which silently
 * coerces an unknown value to `"organization"`. Coercing here would turn a
 * pre-backfill / platform-fallback row into an org-wide run grant, which is
 * exactly the widening the epic forbids.
 */
export function normalizeAgentTemplateScopeLevel(
  ownerLevel: string | null | undefined,
): AgentTemplateScopeLevel | null {
  if (!ownerLevel) return null;
  return (AGENT_TEMPLATE_SCOPE_LEVELS as readonly string[]).includes(ownerLevel)
    ? (ownerLevel as AgentTemplateScopeLevel)
    : null;
}

/**
 * The human identity an actor carries, for personal-scope matching.
 *
 * STRICT: only a `HumanUser` principal. A ServiceAccount / ExternalA2AAgent /
 * InternalWorker never satisfies personal scope even when it names a user via
 * `runAsUserId` / `delegatedBy` — a delegated token must not widen a
 * personal-scoped agent to whatever principal happens to carry the claim. The
 * delegated paths resolve the ORIGINAL human into a `HumanUser` actor before
 * calling here (see `./agent-template-scope-guard`), so no legitimate path
 * loses.
 */
function humanUserId(actor: ActorContext): string | undefined {
  return actor.principalType === "HumanUser" ? actor.principalId : undefined;
}

function holdsProject(actor: ActorContext, projectId: string): boolean {
  if (actor.projectIds?.includes(projectId)) return true;
  return Boolean(actor.projectGrants?.some((g) => g.projectId === projectId));
}

function hasOrgAdminStanding(actor: ActorContext): boolean {
  return actor.orgRole === "org_owner" || actor.orgRole === "org_admin";
}

/**
 * PURE four-level scope evaluation. Never throws.
 *
 * Order matters:
 *   1. no actor            → deny (fail closed).
 *   2. cross-org guard     → an actor outside the template's organization is
 *      denied BEFORE any level rule, so a matching owner_id / team id / project
 *      id from another tenant can never admit. This is also what keeps a
 *      PLATFORM-FALLBACK install (an org-less canonical row) from ever being
 *      read as cross-org run authority: this evaluator only ever reads the
 *      template's OWN `organization_id` / `owner_level` / `owner_id`, and an
 *      org-less template with no determinate owner level lands in (3).
 *   3. unrecognized/absent scope → deny.
 *   4. the level rule.
 */
export function evaluateActorWithinAgentTemplateScope(
  template: AgentTemplateScopeRef,
  actor: ActorContext | null | undefined,
): AgentTemplateScopeDecision {
  if (!actor) return { allowed: false, reason: "no_actor", level: null };

  const level = normalizeAgentTemplateScopeLevel(template.ownerLevel);

  // (2) Cross-org guard — evaluated before the level rule so a same-id match
  // from a foreign tenant can never admit. NO platform-admin exemption: the
  // locked model has no universal grant.
  if (template.orgId && actor.organizationId !== template.orgId) {
    return { allowed: false, reason: "cross_org", level };
  }

  // (3) Unknown / null scope → deny. Never coerced to "organization".
  if (!level) return { allowed: false, reason: "unknown_scope", level: null };

  switch (level) {
    case "user": {
      if (!template.ownerId) {
        return { allowed: false, reason: "unknown_scope", level };
      }
      return humanUserId(actor) === template.ownerId
        ? { allowed: true, level, via: "owner" }
        : { allowed: false, reason: "not_owner", level };
    }
    case "team": {
      if (!template.ownerId) {
        return { allowed: false, reason: "unknown_scope", level };
      }
      return actor.teamIds?.includes(template.ownerId)
        ? { allowed: true, level, via: "team_member" }
        : { allowed: false, reason: "not_team_member", level };
    }
    case "project": {
      if (!template.ownerId) {
        return { allowed: false, reason: "unknown_scope", level };
      }
      return holdsProject(actor, template.ownerId)
        ? { allowed: true, level, via: "project_member" }
        : { allowed: false, reason: "not_project_member", level };
    }
    case "organization": {
      // The owning org is the template's org anchor when it has one; an
      // org-less row must name the org explicitly on `owner_id` (otherwise
      // there is no determinate scope → deny, never "any org").
      const owningOrgId = template.orgId ?? template.ownerId;
      if (!owningOrgId) {
        return { allowed: false, reason: "unknown_scope", level };
      }
      // An `owner_id` that names a DIFFERENT org than the row's own anchor is
      // corrupt ownership — fail closed rather than pick a winner.
      if (template.orgId && template.ownerId && template.ownerId !== template.orgId) {
        return { allowed: false, reason: "unknown_scope", level };
      }
      if (actor.organizationId !== owningOrgId) {
        return { allowed: false, reason: "not_org_member", level };
      }
      // Org-admin standing counts AT ORG SCOPE (owner ruling). Recorded as its
      // own grant so the decision is legible in audit; it does NOT extend to the
      // personal / team / project levels above.
      return hasOrgAdminStanding(actor)
        ? { allowed: true, level, via: "org_admin" }
        : { allowed: true, level, via: "org_member" };
    }
  }
}

/**
 * Assert the actor may run the template. Throws {@link AgentTemplateScopeError}
 * on refusal; returns the allowing decision otherwise.
 *
 * THE single evaluator for run authorization — invoked at all three enforcement
 * layers (creation perimeter, dispatch guard, worker fire-time recheck) through
 * `./agent-template-scope-guard`.
 */
export function assertActorWithinAgentTemplateScope(
  template: AgentTemplateScopeRef,
  actor: ActorContext | null | undefined,
  opts?: { stage?: string },
): Extract<AgentTemplateScopeDecision, { allowed: true }> {
  const decision = evaluateActorWithinAgentTemplateScope(template, actor);
  if (!decision.allowed) {
    throw new AgentTemplateScopeError({
      templateId: template.id,
      reason: decision.reason,
      level: decision.level,
      stage: opts?.stage,
    });
  }
  return decision;
}
