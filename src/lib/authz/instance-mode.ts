/**
 * Single-org compatibility mode + nav/tab visibility resolution.
 *
 * Single-org mode (`instance_identity.singleOrg`) is a deployment-level admin
 * toggle. When on:
 *   - the "Organizations" sidebar entry is hidden,
 *   - org-creation paths are blocked for all users.
 * Existing org records are NOT migrated — the toggle is UI/UX + create-path
 * only; the underlying 4-tier scope model is untouched.
 *
 * Nav visibility: a small pure resolver maps a nav/tab target to
 * the `(resourceType, action)` it reads, then defers to `canRequireAccess`
 * so a nav item is hidden when the actor has no read access — no
 * reliance on "click → 403".
 */
import "server-only";

import type { ActorContext } from "./actor-context";
import { canRequireAccess } from "./require-access";
import type { ResourceType } from "./resource-ref";
import type { Action } from "./registry";

// ---------------------------------------------------------------------------
// Single-org mode
// ---------------------------------------------------------------------------

/** Read the single-org toggle. Defaults to false (multi-org). */
export async function isSingleOrgMode(): Promise<boolean> {
  try {
    const { readConnectorConfigFromDatabase } = await import("@/lib/database");
    const cfg = readConnectorConfigFromDatabase<{ singleOrg?: boolean } | null>("instance_identity", null);
    return cfg?.singleOrg === true;
  } catch {
    return false;
  }
}

/** Admin knob — set the single-org toggle. */
export async function setSingleOrgMode(singleOrg: boolean): Promise<void> {
  const { readConnectorConfigFromDatabase, writeConnectorConfigToDatabase } = await import("@/lib/database");
  const existing = readConnectorConfigFromDatabase<Record<string, unknown> | null>("instance_identity", null) ?? {};
  writeConnectorConfigToDatabase("instance_identity", { ...existing, singleOrg });
}

// Org-creation in single-org mode is gated authoritatively inside the
// better-auth organization plugin's `allowUserToCreateOrganization` hook
// (src/lib/auth.ts), which reads isSingleOrgMode() before the admin-role
// check. A standalone assert helper was removed as dead code — the
// better-auth hook is the single server-side enforcement point.

// ---------------------------------------------------------------------------
// Nav / tab visibility
// ---------------------------------------------------------------------------

/**
 * Canonical nav targets → the (resourceType, action) read that gates them.
 * Adding a nav item without a target here means it is always visible — the
 * default-deny posture is opt-in per target, matching the existing nav which
 * showed everything. New gated surfaces register here.
 */
export type NavTarget =
  | "agents"
  | "objects"
  | "projects"
  | "skills"
  | "connectors"
  | "webhooks"
  | "dashboards"
  | "lists"
  | "entities"
  | "workflows"
  | "triggers"
  | "notifications"
  | "metrics"
  | "marketplace"
  | "audit"
  | "organizations"
  | "administration";

const NAV_TARGET_GATE: Record<NavTarget, { resourceType: ResourceType; action: Action }> = {
  agents:         { resourceType: "agent", action: "list" },
  objects:        { resourceType: "object", action: "list" },
  projects:       { resourceType: "project", action: "list" },
  skills:         { resourceType: "skill", action: "list" },
  connectors:     { resourceType: "connector", action: "read" },
  // Inbound-webhook registry is a host-admin surface (cinatra#342). Gate on
  // administration/update → settings.update, which is platform_admin-only
  // (NOT member-granted, unlike settings.read). This keeps the catalog/coverage
  // parity admin-only; the load-bearing nav hide is the isAdmin push in layout.
  webhooks:       { resourceType: "administration", action: "update" },
  dashboards:     { resourceType: "dashboard", action: "list" },
  lists:          { resourceType: "list", action: "list" },
  entities:       { resourceType: "entity_account", action: "list" },
  workflows:      { resourceType: "workflow", action: "list" },
  triggers:       { resourceType: "trigger", action: "list" },
  notifications:  { resourceType: "notification", action: "list" },
  metrics:        { resourceType: "metric_cost", action: "read" },
  marketplace:    { resourceType: "marketplace_template", action: "list" },
  audit:          { resourceType: "audit_log", action: "read" },
  organizations:  { resourceType: "organization", action: "list" },
  administration: { resourceType: "administration", action: "read" },
};

/**
 * True when the actor may SEE the nav target (has read access to its target
 * resource). Used by the sidebar / tab-list to hide entries the actor can't
 * reach. Unknown targets default to visible (no gate registered).
 */
export function canSeeNavTarget(actor: ActorContext, target: NavTarget): boolean {
  const gate = NAV_TARGET_GATE[target];
  if (!gate) return true;
  // Build a scope-level resource ref in the actor's own org. Nav visibility is
  // an org-level read check — the per-page loader still does record-level authz.
  const resource = {
    resourceType: gate.resourceType,
    resourceId: `nav:${target}`,
    organizationId: actor.organizationId,
    ownerType: "organization" as const,
    ownerId: actor.organizationId,
  };
  return canRequireAccess(actor, resource, gate.action).allowed;
}

/**
 * Resolve which nav targets are visible. `singleOrg` hides "organizations"
 * regardless of access. Returns the filtered, ordered list the
 * sidebar renders.
 */
export function resolveVisibleNavTargets(
  actor: ActorContext,
  allTargets: readonly NavTarget[],
  opts: { singleOrg?: boolean } = {},
): NavTarget[] {
  return allTargets.filter((t) => {
    if (opts.singleOrg && t === "organizations") return false;
    return canSeeNavTarget(actor, t);
  });
}
