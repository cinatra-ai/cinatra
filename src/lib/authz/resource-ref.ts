/**
 * Authorization kernel — resource envelope types.
 *
 * Pure types — no runtime values, no tier-restricting imports. The
 * OwnerLevel union intentionally DIVERGES from the UI ScopeLevel:
 * "project" is a scope refinement, not an ownership tier. Do NOT re-sync
 * them. See the OwnerLevel docblock below.
 */

/**
 * Resource categories. Add new categories here when introducing a new
 * resource type to the authz kernel. The "platform" sentinel is used
 * by `canDo()` for resource-less permission checks (e.g., "can this
 * user open the administration page at all?").
 */
export type ResourceType =
  | "agent"
  | "run"
  | "agent_run"
  | "object"
  | "project"
  | "skill"
  | "connector"
  | "connector_instance"
  | "registry"
  | "administration"
  | "audit"
  | "platform"
  // Expanded resource catalog.
  // Classification entries appear in `src/lib/authz/registry.ts`.
  | "artifact"
  | "extension_registry"
  | "marketplace_template"
  | "workflow_template"
  | "workflow"
  | "workflow_draft"
  | "workflow_run"
  | "workflow_extension"
  | "dashboard"
  | "list"
  | "entity_account"
  | "entity_contact"
  | "trigger"
  | "notification"
  | "metric_cost"
  | "metric_usage"
  | "audit_log"
  // Org/team resources used by nav visibility and the resolver matrix.
  | "organization"
  | "team";

/**
 * Four-tier ownership level. Deliberately DIVERGES from the UI `ScopeLevel`
 * (src/components/scope-badge.tsx), which retains a 5th `"project"` member:
 * a project is a **scope refinement**, NOT an ownership tier. A resource is
 * owned at exactly one of these four tiers; project scoping is carried
 * separately by the existing `visibility = 'project:<id>'` + `actor.projectIds`
 * mechanism (objects/derived stores) or by a typed `ProjectRefinementTarget`
 * (agent install / skill assignment). The resolver + enforce path REJECT
 * `ownerLevel:"project"`. Duplicated from ScopeLevel's first four members,
 * not imported (no UI→lib reverse dep) — they are intentionally NOT in sync.
 */
export type OwnerLevel = "user" | "team" | "organization" | "workspace";

/**
 * Project install / skill-assignment scope. `"project"` here is a scope
 * REFINEMENT target, never an ownership tier. Kept distinct from `OwnerLevel`
 * so the type system enforces the separation (agent install picker /
 * custom_skill_assignments) while the kernel/resolver only ever sees the 4
 * tiers.
 */
export type ProjectRefinementTarget = "user" | "team" | "organization" | "project";

const OWNER_LEVELS: ReadonlySet<string> = new Set([
  "user",
  "team",
  "organization",
  "workspace",
]);

export function isOwnerLevelValue(value: unknown): value is OwnerLevel {
  return typeof value === "string" && OWNER_LEVELS.has(value);
}

/**
 * Defensive read-path normalizer. The ownership tier has 4 valid values, but
 * a stale stored value must never type-leak or crash an authz read. Unknown or
 * stored `"project"` collapses to `"organization"` — the SAME mapping the
 * kernel's `ownerLevelToType` already applies to `project`/`workspace`
 * (behavior-preserving, non-leaking; project gating lives at the
 * data-fetch/visibility layer, not the tier). Hard rejection of
 * `ownerLevel:"project"` belongs at write/input boundaries (MCP zod) and the
 * resolver — NOT here on the read path.
 */
export function normalizeOwnerLevel(value: unknown): OwnerLevel {
  return isOwnerLevelValue(value) ? value : "organization";
}

/** Owner principal type — who/what owns this resource. */
export type OwnerType = "user" | "team" | "organization" | "service_account";

/** Visibility scope for shareable resources. */
export type Visibility = "private" | "team" | "organization" | "public";

/**
 * Resource reference passed to `can(actor, action, resource, ctx?)`.
 */
export type ResourceRef = {
  resourceType: ResourceType;
  resourceId: string;
  organizationId?: string;
  ownerType?: OwnerType;
  ownerId?: string;
  visibility?: Visibility;
  level?: OwnerLevel;
};
