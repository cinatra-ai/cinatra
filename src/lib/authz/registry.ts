/**
 * Central resource-type -> required-access registry.
 *
 * Declarative mapping of `(resourceType, action)` -> `RequiredAccess`
 * (permission + optional role gate + optional minimum scope). Consumed by
 * `src/lib/authz/require-access.ts` (the canonical `requireAccess` primitive)
 * and by the bidirectional authorization coverage test.
 *
 * The registry is code-side, version-controlled declarative data and never
 * lives in the DB.
 */

import type { Permission } from "./permissions";
import type { ResourceType } from "./resource-ref";
import type { Role } from "./policies";
import type { OwnerLevel } from "./resource-ref";

/** Canonical action vocabulary across all resource types. */
export type Action =
  | "read"
  | "list"
  | "write"
  | "admin"
  | "execute"
  | "create"
  | "update"
  | "delete"
  | "cancel"
  | "approve"
  | "install"
  | "uninstall"
  | "publish"
  | "fire"
  | "share";

/**
 * Effect class - domain risk tier. Used by the audit envelope and the
 * carve-out review process to escalate the bar for high-risk bypasses.
 */
export type EffectClass = "read" | "write" | "admin" | "execute";

/**
 * Required access spec attached to each `(resourceType, action)` cell.
 *
 * - `requiredPermission` is consumed by `can()` (the existing predicate).
 * - `requireRole` adds a role gate enforced inside `requireAccess` after
 *   `can()` succeeds (e.g. "release-manager only" for marketplace publish).
 * - `minScopeLevel` documents the minimum ownership tier at which the
 *   action can be authorized; the resolver matrix enforces it.
 */
export type RequiredAccess = {
  requiredPermission: Permission;
  requireRole?: Role;
  minScopeLevel?: OwnerLevel;
};

export type ClassificationEntry = {
  resourceType: ResourceType;
  action: Action;
  effect: EffectClass;
  requiredAccess: RequiredAccess;
};

// ---------------------------------------------------------------------------
// REGISTRY - flat table of classification entries. Keep alphabetically by
// (resourceType, action) for review-ease; coverage tests also assert uniqueness.
// ---------------------------------------------------------------------------

export const CLASSIFICATION_ENTRIES: readonly ClassificationEntry[] = [
  // ----- agent -----
  { resourceType: "agent", action: "read",    effect: "read",    requiredAccess: { requiredPermission: "agent.read" } },
  { resourceType: "agent", action: "list",    effect: "read",    requiredAccess: { requiredPermission: "agent.list" } },
  { resourceType: "agent", action: "execute", effect: "execute", requiredAccess: { requiredPermission: "agent.execute" } },
  { resourceType: "agent", action: "update",  effect: "write",   requiredAccess: { requiredPermission: "agent.update" } },
  { resourceType: "agent", action: "delete",  effect: "admin",   requiredAccess: { requiredPermission: "agent.delete" } },
  { resourceType: "agent", action: "share",   effect: "admin",   requiredAccess: { requiredPermission: "agent.share" } },
  { resourceType: "agent", action: "create",  effect: "write",   requiredAccess: { requiredPermission: "agent.update" } },
  // ----- agent_run / run -----
  { resourceType: "agent_run", action: "read",    effect: "read",    requiredAccess: { requiredPermission: "run.read" } },
  { resourceType: "agent_run", action: "list",    effect: "read",    requiredAccess: { requiredPermission: "run.list" } },
  { resourceType: "agent_run", action: "create",  effect: "execute", requiredAccess: { requiredPermission: "agent.execute" } },
  { resourceType: "agent_run", action: "execute", effect: "execute", requiredAccess: { requiredPermission: "agent.execute" } },
  { resourceType: "agent_run", action: "cancel",  effect: "write",   requiredAccess: { requiredPermission: "run.cancel" } },
  { resourceType: "agent_run", action: "share",   effect: "admin",   requiredAccess: { requiredPermission: "run.share" } },
  { resourceType: "agent_run", action: "update",  effect: "write",   requiredAccess: { requiredPermission: "run.editOutput" } },
  { resourceType: "run",       action: "read",    effect: "read",    requiredAccess: { requiredPermission: "run.read" } },
  { resourceType: "run",       action: "list",    effect: "read",    requiredAccess: { requiredPermission: "run.list" } },
  // ----- object -----
  { resourceType: "object", action: "read",   effect: "read",  requiredAccess: { requiredPermission: "object.read" } },
  { resourceType: "object", action: "list",   effect: "read",  requiredAccess: { requiredPermission: "object.list" } },
  { resourceType: "object", action: "create", effect: "write", requiredAccess: { requiredPermission: "object.create" } },
  { resourceType: "object", action: "update", effect: "write", requiredAccess: { requiredPermission: "object.update" } },
  { resourceType: "object", action: "delete", effect: "admin", requiredAccess: { requiredPermission: "object.delete" } },
  // ----- project -----
  { resourceType: "project", action: "read",   effect: "read",  requiredAccess: { requiredPermission: "project.read" } },
  { resourceType: "project", action: "list",   effect: "read",  requiredAccess: { requiredPermission: "project.list" } },
  { resourceType: "project", action: "create", effect: "write", requiredAccess: { requiredPermission: "project.create" } },
  { resourceType: "project", action: "update", effect: "write", requiredAccess: { requiredPermission: "project.update" } },
  { resourceType: "project", action: "delete", effect: "admin", requiredAccess: { requiredPermission: "project.delete" } },
  // ----- skill -----
  { resourceType: "skill", action: "read",      effect: "read",  requiredAccess: { requiredPermission: "skill.read" } },
  { resourceType: "skill", action: "list",      effect: "read",  requiredAccess: { requiredPermission: "skill.list" } },
  { resourceType: "skill", action: "create",    effect: "write", requiredAccess: { requiredPermission: "skill.create" } },
  { resourceType: "skill", action: "update",    effect: "write", requiredAccess: { requiredPermission: "skill.update" } },
  { resourceType: "skill", action: "delete",    effect: "admin", requiredAccess: { requiredPermission: "skill.delete" } },
  { resourceType: "skill", action: "install",   effect: "admin",   requiredAccess: { requiredPermission: "skill.install" } },
  { resourceType: "skill", action: "uninstall", effect: "admin",   requiredAccess: { requiredPermission: "skill.install" } },
  { resourceType: "skill", action: "execute",   effect: "execute", requiredAccess: { requiredPermission: "skill.assign" } },
  // ----- connector / connector_instance -----
  { resourceType: "connector",          action: "read",   effect: "read",  requiredAccess: { requiredPermission: "connector.read" } },
  { resourceType: "connector",          action: "create", effect: "write", requiredAccess: { requiredPermission: "connector.create" } },
  { resourceType: "connector",          action: "update", effect: "write", requiredAccess: { requiredPermission: "connector.update" } },
  { resourceType: "connector",          action: "delete", effect: "admin", requiredAccess: { requiredPermission: "connector.delete" } },
  // Runtime invocation uses the connector policy check for per-instance authority.
  { resourceType: "connector_instance", action: "read",    effect: "read",    requiredAccess: { requiredPermission: "connector.read" } },
  { resourceType: "connector_instance", action: "execute", effect: "execute", requiredAccess: { requiredPermission: "connector.use" } },
  { resourceType: "connector_instance", action: "admin",   effect: "admin",   requiredAccess: { requiredPermission: "connector.update" } },
  { resourceType: "connector_instance", action: "list",    effect: "read",    requiredAccess: { requiredPermission: "connector.read" } },
  // ----- registry / extension_registry / marketplace_template -----
  { resourceType: "registry",             action: "read",      effect: "read",  requiredAccess: { requiredPermission: "registry.read" } },
  { resourceType: "registry",             action: "install",   effect: "admin", requiredAccess: { requiredPermission: "registry.install" } },
  { resourceType: "registry",             action: "uninstall", effect: "admin", requiredAccess: { requiredPermission: "registry.uninstall" } },
  { resourceType: "extension_registry",   action: "read",      effect: "read",  requiredAccess: { requiredPermission: "extension_registry.read" } },
  { resourceType: "extension_registry",   action: "list",      effect: "read",  requiredAccess: { requiredPermission: "extension_registry.list" } },
  { resourceType: "extension_registry",   action: "install",   effect: "admin", requiredAccess: { requiredPermission: "extension_registry.install" } },
  { resourceType: "extension_registry",   action: "uninstall", effect: "admin", requiredAccess: { requiredPermission: "extension_registry.uninstall" } },
  { resourceType: "marketplace_template", action: "read",      effect: "read",  requiredAccess: { requiredPermission: "marketplace_template.read" } },
  { resourceType: "marketplace_template", action: "list",      effect: "read",  requiredAccess: { requiredPermission: "marketplace_template.list" } },
  { resourceType: "marketplace_template", action: "publish",   effect: "admin", requiredAccess: { requiredPermission: "marketplace_template.publish", requireRole: "release_manager" } },
  // ----- administration / audit / audit_log / platform -----
  { resourceType: "administration", action: "read",   effect: "read",  requiredAccess: { requiredPermission: "settings.read" } },
  { resourceType: "administration", action: "update", effect: "admin", requiredAccess: { requiredPermission: "settings.update" } },
  { resourceType: "audit",          action: "read",   effect: "read",  requiredAccess: { requiredPermission: "audit.read" } },
  { resourceType: "audit_log",      action: "read",   effect: "read",  requiredAccess: { requiredPermission: "audit.read" } },
  { resourceType: "audit_log",      action: "list",   effect: "read",  requiredAccess: { requiredPermission: "audit.read" } },
  { resourceType: "platform",       action: "read",   effect: "read",  requiredAccess: { requiredPermission: "settings.read" } },
  // ----- artifact -----
  { resourceType: "artifact", action: "read",   effect: "read",  requiredAccess: { requiredPermission: "artifact.read" } },
  { resourceType: "artifact", action: "list",   effect: "read",  requiredAccess: { requiredPermission: "artifact.list" } },
  { resourceType: "artifact", action: "create", effect: "write", requiredAccess: { requiredPermission: "artifact.create" } },
  { resourceType: "artifact", action: "update", effect: "write", requiredAccess: { requiredPermission: "artifact.update" } },
  { resourceType: "artifact", action: "delete", effect: "admin", requiredAccess: { requiredPermission: "artifact.delete" } },
  // ----- workflow_template / workflow / workflow_draft / workflow_run / workflow_extension -----
  { resourceType: "workflow_template",  action: "read",    effect: "read",    requiredAccess: { requiredPermission: "workflow_template.read" } },
  { resourceType: "workflow_template",  action: "list",    effect: "read",    requiredAccess: { requiredPermission: "workflow_template.list" } },
  { resourceType: "workflow_template",  action: "create",  effect: "write",   requiredAccess: { requiredPermission: "workflow_template.create" } },
  { resourceType: "workflow_template",  action: "update",  effect: "write",   requiredAccess: { requiredPermission: "workflow_template.update" } },
  { resourceType: "workflow_template",  action: "delete",  effect: "admin",   requiredAccess: { requiredPermission: "workflow_template.delete" } },
  { resourceType: "workflow",           action: "read",    effect: "read",    requiredAccess: { requiredPermission: "workflow.read" } },
  { resourceType: "workflow",           action: "list",    effect: "read",    requiredAccess: { requiredPermission: "workflow.list" } },
  { resourceType: "workflow",           action: "create",  effect: "write",   requiredAccess: { requiredPermission: "workflow.create" } },
  { resourceType: "workflow",           action: "update",  effect: "write",   requiredAccess: { requiredPermission: "workflow.update" } },
  { resourceType: "workflow",           action: "execute", effect: "execute", requiredAccess: { requiredPermission: "workflow.execute" } },
  { resourceType: "workflow",           action: "cancel",  effect: "write",   requiredAccess: { requiredPermission: "workflow.cancel" } },
  { resourceType: "workflow",           action: "approve", effect: "admin",   requiredAccess: { requiredPermission: "workflow.approve" } },
  { resourceType: "workflow_draft",     action: "read",    effect: "read",    requiredAccess: { requiredPermission: "workflow_draft.read" } },
  { resourceType: "workflow_draft",     action: "write",   effect: "write",   requiredAccess: { requiredPermission: "workflow_draft.write" } },
  { resourceType: "workflow_draft",     action: "update",  effect: "write",   requiredAccess: { requiredPermission: "workflow_draft.update" } },
  { resourceType: "workflow_run",       action: "read",    effect: "read",    requiredAccess: { requiredPermission: "workflow_run.read" } },
  { resourceType: "workflow_run",       action: "list",    effect: "read",    requiredAccess: { requiredPermission: "workflow_run.list" } },
  { resourceType: "workflow_run",       action: "cancel",  effect: "write",   requiredAccess: { requiredPermission: "workflow_run.cancel" } },
  { resourceType: "workflow_extension", action: "read",    effect: "read",    requiredAccess: { requiredPermission: "workflow_extension.read" } },
  { resourceType: "workflow_extension", action: "publish", effect: "admin",   requiredAccess: { requiredPermission: "workflow_extension.publish", requireRole: "release_manager" } },
  // ----- dashboard -----
  { resourceType: "dashboard", action: "read",   effect: "read",  requiredAccess: { requiredPermission: "dashboard.read" } },
  { resourceType: "dashboard", action: "list",   effect: "read",  requiredAccess: { requiredPermission: "dashboard.list" } },
  { resourceType: "dashboard", action: "create", effect: "write", requiredAccess: { requiredPermission: "dashboard.create" } },
  { resourceType: "dashboard", action: "update", effect: "write", requiredAccess: { requiredPermission: "dashboard.update" } },
  { resourceType: "dashboard", action: "delete", effect: "admin", requiredAccess: { requiredPermission: "dashboard.delete" } },
  // ----- list -----
  { resourceType: "list", action: "read",   effect: "read",  requiredAccess: { requiredPermission: "list.read" } },
  { resourceType: "list", action: "list",   effect: "read",  requiredAccess: { requiredPermission: "list.list" } },
  { resourceType: "list", action: "create", effect: "write", requiredAccess: { requiredPermission: "list.create" } },
  { resourceType: "list", action: "update", effect: "write", requiredAccess: { requiredPermission: "list.update" } },
  { resourceType: "list", action: "delete", effect: "admin", requiredAccess: { requiredPermission: "list.delete" } },
  // ----- entity_account / entity_contact -----
  { resourceType: "entity_account", action: "read",   effect: "read",  requiredAccess: { requiredPermission: "entity.read" } },
  { resourceType: "entity_account", action: "list",   effect: "read",  requiredAccess: { requiredPermission: "entity.list" } },
  { resourceType: "entity_account", action: "create", effect: "write", requiredAccess: { requiredPermission: "entity.create" } },
  { resourceType: "entity_account", action: "update", effect: "write", requiredAccess: { requiredPermission: "entity.update" } },
  { resourceType: "entity_account", action: "delete", effect: "admin", requiredAccess: { requiredPermission: "entity.delete" } },
  { resourceType: "entity_contact", action: "read",   effect: "read",  requiredAccess: { requiredPermission: "entity.read" } },
  { resourceType: "entity_contact", action: "list",   effect: "read",  requiredAccess: { requiredPermission: "entity.list" } },
  { resourceType: "entity_contact", action: "create", effect: "write", requiredAccess: { requiredPermission: "entity.create" } },
  { resourceType: "entity_contact", action: "update", effect: "write", requiredAccess: { requiredPermission: "entity.update" } },
  { resourceType: "entity_contact", action: "delete", effect: "admin", requiredAccess: { requiredPermission: "entity.delete" } },
  // ----- trigger -----
  { resourceType: "trigger", action: "read",   effect: "read",    requiredAccess: { requiredPermission: "trigger.read" } },
  { resourceType: "trigger", action: "list",   effect: "read",    requiredAccess: { requiredPermission: "trigger.list" } },
  { resourceType: "trigger", action: "create", effect: "write",   requiredAccess: { requiredPermission: "trigger.create" } },
  { resourceType: "trigger", action: "update", effect: "write",   requiredAccess: { requiredPermission: "trigger.update" } },
  { resourceType: "trigger", action: "delete", effect: "admin",   requiredAccess: { requiredPermission: "trigger.delete" } },
  { resourceType: "trigger", action: "fire",   effect: "execute", requiredAccess: { requiredPermission: "trigger.fire" } },
  // ----- notification -----
  { resourceType: "notification", action: "read",   effect: "read",  requiredAccess: { requiredPermission: "notification.read" } },
  { resourceType: "notification", action: "list",   effect: "read",  requiredAccess: { requiredPermission: "notification.list" } },
  { resourceType: "notification", action: "update", effect: "write", requiredAccess: { requiredPermission: "notification.update" } },
  // ----- metric_cost / metric_usage -----
  { resourceType: "metric_cost",  action: "read", effect: "read", requiredAccess: { requiredPermission: "metric.read" } },
  { resourceType: "metric_cost",  action: "list", effect: "read", requiredAccess: { requiredPermission: "metric.list" } },
  { resourceType: "metric_usage", action: "read", effect: "read", requiredAccess: { requiredPermission: "metric.read" } },
  { resourceType: "metric_usage", action: "list", effect: "read", requiredAccess: { requiredPermission: "metric.list" } },
  // ----- organization / team  -----
  { resourceType: "organization", action: "read",   effect: "read",  requiredAccess: { requiredPermission: "organization.read" } },
  { resourceType: "organization", action: "list",   effect: "read",  requiredAccess: { requiredPermission: "organization.list" } },
  { resourceType: "organization", action: "create", effect: "write", requiredAccess: { requiredPermission: "organization.create" } },
  { resourceType: "organization", action: "update", effect: "write", requiredAccess: { requiredPermission: "organization.update" } },
  { resourceType: "organization", action: "delete", effect: "admin", requiredAccess: { requiredPermission: "organization.delete" } },
  { resourceType: "team",         action: "read",   effect: "read",  requiredAccess: { requiredPermission: "team.read" } },
  { resourceType: "team",         action: "list",   effect: "read",  requiredAccess: { requiredPermission: "team.list" } },
  { resourceType: "team",         action: "create", effect: "write", requiredAccess: { requiredPermission: "team.create" } },
  { resourceType: "team",         action: "update", effect: "write", requiredAccess: { requiredPermission: "team.update" } },
  { resourceType: "team",         action: "delete", effect: "admin", requiredAccess: { requiredPermission: "team.delete" } },
];

// ---------------------------------------------------------------------------
// Indexed lookup. Built once at module load. O(1) lookup for the
// `requireAccess` primitive.
// ---------------------------------------------------------------------------

const REGISTRY_BY_RESOURCE_AND_ACTION = (() => {
  const index = new Map<string, ClassificationEntry>();
  for (const entry of CLASSIFICATION_ENTRIES) {
    const key = `${entry.resourceType}::${entry.action}`;
    if (index.has(key)) {
      throw new Error(
        `Duplicate classification entry for ${key}; check src/lib/authz/registry.ts`,
      );
    }
    index.set(key, entry);
  }
  return index;
})();

/**
 * Look up the classification entry for a `(resourceType, action)` tuple.
 * Returns `undefined` when no entry exists; the caller decides whether the
 * absence is a programming error (coverage test) or a fail-closed deny
 * (`requireAccess`).
 */
export function lookupClassification(
  resourceType: ResourceType,
  action: Action,
): ClassificationEntry | undefined {
  return REGISTRY_BY_RESOURCE_AND_ACTION.get(`${resourceType}::${action}`);
}

/**
 * Read-only snapshot of all registered (resourceType, action) pairs.
 * Consumed by coverage tests to assert authorization coverage.
 */
export function listRegisteredTuples(): { resourceType: ResourceType; action: Action }[] {
  return CLASSIFICATION_ENTRIES.map((e) => ({ resourceType: e.resourceType, action: e.action }));
}
