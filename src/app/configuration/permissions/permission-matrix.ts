/**
 * Permission matrix helper for the /configuration/permissions admin page.
 *
 * Derives a role × category matrix from EFFECTIVE_GRANTS without importing
 * the server-only authz barrel directly — this module may be imported from
 * a Next.js server component (which is fine) but must not be bundled into
 * client components. The underlying authz barrel is server-only via
 * `import "server-only"` so any client import will fail at build time anyway.
 */
import "server-only";
import { EFFECTIVE_GRANTS } from "@/lib/authz/index";
import type { Role } from "@/lib/authz/index";
import type { Permission } from "@/lib/authz/permissions";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PermissionCategory =
  | "agents"
  | "objects"
  | "projects"
  | "teams"
  | "organizations"
  | "skills"
  | "connectors"
  | "registry"
  | "administration";

export type MatrixCellState = "full" | "partial" | "none";

export type MatrixDisplayRightState = "granted" | "partial" | "denied";

export type MatrixRow = {
  role: Role;
  cells: Record<PermissionCategory, MatrixCellState>;
  counts: Record<PermissionCategory, { granted: number; total: number }>;
  permissions: Record<
    PermissionCategory,
    Array<{ permission: Permission; granted: boolean }>
  >;
  displayRights: Record<PermissionCategory, MatrixDisplayRight[]>;
};

export type MatrixDisplayRight = {
  key: string;
  label: string;
  permissions: Permission[];
  state: MatrixDisplayRightState;
  granted: number;
  total: number;
};

export const PERMISSION_LABELS: Record<Permission, string> = {
  "agent.read": "View agents",
  "agent.list": "List agents",
  "agent.execute": "Run agents",
  "agent.update": "Update agents",
  "agent.delete": "Delete agents",
  "agent.share": "Share agents",
  "agent.managePermissions": "Manage agent permissions",
  "run.read": "View agent runs",
  "run.list": "List agent runs",
  "run.readData": "View run data",
  "run.cancel": "Cancel runs",
  "run.share": "Share runs",
  "run.approveHitl": "Approve run checkpoints",
  "run.respondToHitl": "Respond to run checkpoints",
  "run.resume": "Resume runs",
  "run.editOutput": "Edit run output",
  "object.read": "View data",
  "object.list": "List data",
  "object.search": "Search data",
  "object.create": "Create data",
  "object.update": "Update data",
  "object.delete": "Delete data",
  "object.promoteScope": "Promote data scope",
  "project.read": "View projects",
  "project.list": "List projects",
  "project.create": "Create projects",
  "project.update": "Update projects",
  "project.delete": "Delete projects",
  "project.manageMembers": "Manage project members",
  "team.read": "View teams",
  "team.list": "List teams",
  "team.create": "Create teams",
  "team.update": "Update teams",
  "team.delete": "Delete teams",
  "team.manageMembers": "Manage team members",
  "organization.read": "View organizations",
  "organization.list": "List organizations",
  "organization.create": "Create organizations",
  "organization.update": "Update organizations",
  "organization.delete": "Delete organizations",
  "organization.manageMembers": "Manage organization members",
  "skill.read": "View skills",
  "skill.list": "List skills",
  "skill.assign": "Assign skills",
  "skill.create": "Create skills",
  "skill.update": "Update skills",
  "skill.delete": "Delete skills",
  "skill.install": "Install skills",
  "skill.manageVisibility": "Manage skill visibility",
  "connector.read": "View connectors",
  "connector.use": "Use connectors",
  "connector.create": "Create connectors",
  "connector.update": "Update connectors",
  "connector.delete": "Delete connectors",
  "registry.read": "View registry",
  "registry.install": "Install packages",
  "registry.update": "Update packages",
  "registry.uninstall": "Uninstall packages",
  "settings.read": "View administration settings",
  "settings.update": "Update administration settings",
  "audit.read": "View audit log",
  // Extended permission catalog.
  "artifact.read": "View artifacts",
  "artifact.list": "List artifacts",
  "artifact.create": "Create artifacts",
  "artifact.update": "Update artifacts",
  "artifact.delete": "Delete artifacts",
  "workflow_template.read": "View workflow templates",
  "workflow_template.list": "List workflow templates",
  "workflow_template.create": "Create workflow templates",
  "workflow_template.update": "Update workflow templates",
  "workflow_template.delete": "Delete workflow templates",
  "workflow.read": "View workflows",
  "workflow.list": "List workflows",
  "workflow.create": "Create workflows",
  "workflow.update": "Update workflows",
  "workflow.cancel": "Cancel workflows",
  "workflow.approve": "Approve workflow gates",
  "workflow.execute": "Execute workflows",
  "workflow_draft.read": "View workflow drafts",
  "workflow_draft.write": "Write workflow drafts",
  "workflow_draft.update": "Update workflow drafts",
  "workflow_run.read": "View workflow runs",
  "workflow_run.list": "List workflow runs",
  "workflow_run.cancel": "Cancel workflow runs",
  "workflow_extension.read": "View workflow extensions",
  "workflow_extension.publish": "Publish workflow extensions",
  "dashboard.read": "View dashboards",
  "dashboard.list": "List dashboards",
  "dashboard.create": "Create dashboards",
  "dashboard.update": "Update dashboards",
  "dashboard.delete": "Delete dashboards",
  "list.read": "View lists",
  "list.list": "List lists",
  "list.create": "Create lists",
  "list.update": "Update lists",
  "list.delete": "Delete lists",
  "entity.read": "View entities",
  "entity.list": "List entities",
  "entity.create": "Create entities",
  "entity.update": "Update entities",
  "entity.delete": "Delete entities",
  "trigger.read": "View triggers",
  "trigger.list": "List triggers",
  "trigger.create": "Create triggers",
  "trigger.update": "Update triggers",
  "trigger.delete": "Delete triggers",
  "trigger.fire": "Fire triggers",
  "notification.read": "View notifications",
  "notification.list": "List notifications",
  "notification.update": "Update notifications",
  "metric.read": "View metrics",
  "metric.list": "List metrics",
  "marketplace_template.read": "View marketplace templates",
  "marketplace_template.list": "List marketplace templates",
  "marketplace_template.publish": "Publish to marketplace",
  "extension_registry.read": "View extension registry",
  "extension_registry.list": "List extensions",
  "extension_registry.install": "Install extensions",
  "extension_registry.uninstall": "Uninstall extensions",
};

export const PERMISSION_SHORT_LABELS: Record<Permission, string> = {
  "agent.read": "View",
  "agent.list": "List",
  "agent.execute": "Run",
  "agent.update": "Edit",
  "agent.delete": "Del",
  "agent.share": "Share",
  "agent.managePermissions": "Perms",
  "run.read": "View",
  "run.list": "List",
  "run.readData": "Data",
  "run.cancel": "Cancel",
  "run.share": "Share",
  "run.approveHitl": "Approve",
  "run.respondToHitl": "Reply",
  "run.resume": "Resume",
  "run.editOutput": "Edit",
  "object.read": "View",
  "object.list": "List",
  "object.search": "Search",
  "object.create": "Create",
  "object.update": "Edit",
  "object.delete": "Del",
  "object.promoteScope": "Scope",
  "project.read": "View",
  "project.list": "List",
  "project.create": "Create",
  "project.update": "Edit",
  "project.delete": "Del",
  "project.manageMembers": "Members",
  "team.read": "View",
  "team.list": "List",
  "team.create": "Create",
  "team.update": "Edit",
  "team.delete": "Del",
  "team.manageMembers": "Members",
  "organization.read": "View",
  "organization.list": "List",
  "organization.create": "Create",
  "organization.update": "Edit",
  "organization.delete": "Del",
  "organization.manageMembers": "Members",
  "skill.read": "View",
  "skill.list": "List",
  "skill.assign": "Assign",
  "skill.create": "Create",
  "skill.update": "Edit",
  "skill.delete": "Del",
  "skill.install": "Install",
  "skill.manageVisibility": "Visible",
  "connector.read": "View",
  "connector.use": "Use",
  "connector.create": "Create",
  "connector.update": "Edit",
  "connector.delete": "Del",
  "registry.read": "View",
  "registry.install": "Install",
  "registry.update": "Update",
  "registry.uninstall": "Remove",
  "settings.read": "View",
  "settings.update": "Edit",
  "audit.read": "Audit",
  // Short labels for the matrix cells.
  "artifact.read": "View",
  "artifact.list": "List",
  "artifact.create": "Add",
  "artifact.update": "Edit",
  "artifact.delete": "Del",
  "workflow_template.read": "View",
  "workflow_template.list": "List",
  "workflow_template.create": "Add",
  "workflow_template.update": "Edit",
  "workflow_template.delete": "Del",
  "workflow.read": "View",
  "workflow.list": "List",
  "workflow.create": "Add",
  "workflow.update": "Edit",
  "workflow.cancel": "Cancel",
  "workflow.approve": "Approve",
  "workflow.execute": "Run",
  "workflow_draft.read": "View",
  "workflow_draft.write": "Write",
  "workflow_draft.update": "Edit",
  "workflow_run.read": "View",
  "workflow_run.list": "List",
  "workflow_run.cancel": "Cancel",
  "workflow_extension.read": "View",
  "workflow_extension.publish": "Publish",
  "dashboard.read": "View",
  "dashboard.list": "List",
  "dashboard.create": "Add",
  "dashboard.update": "Edit",
  "dashboard.delete": "Del",
  "list.read": "View",
  "list.list": "List",
  "list.create": "Add",
  "list.update": "Edit",
  "list.delete": "Del",
  "entity.read": "View",
  "entity.list": "List",
  "entity.create": "Add",
  "entity.update": "Edit",
  "entity.delete": "Del",
  "trigger.read": "View",
  "trigger.list": "List",
  "trigger.create": "Add",
  "trigger.update": "Edit",
  "trigger.delete": "Del",
  "trigger.fire": "Fire",
  "notification.read": "View",
  "notification.list": "List",
  "notification.update": "Edit",
  "metric.read": "View",
  "metric.list": "List",
  "marketplace_template.read": "View",
  "marketplace_template.list": "List",
  "marketplace_template.publish": "Publish",
  "extension_registry.read": "View",
  "extension_registry.list": "List",
  "extension_registry.install": "Install",
  "extension_registry.uninstall": "Remove",
};

export const DISPLAY_RIGHTS_BY_CATEGORY: Partial<
  Record<PermissionCategory, ReadonlyArray<{ key: string; label: string; permissions: Permission[] }>>
> = {
  agents: [
    { key: "view", label: "View", permissions: ["agent.read", "run.read"] },
    { key: "list", label: "List", permissions: ["agent.list", "run.list"] },
    { key: "run", label: "Run", permissions: ["agent.execute"] },
    { key: "data", label: "Run data", permissions: ["run.readData"] },
    { key: "edit", label: "Edit", permissions: ["agent.update", "run.editOutput"] },
    { key: "delete", label: "Delete", permissions: ["agent.delete"] },
    { key: "cancel", label: "Cancel", permissions: ["run.cancel"] },
    { key: "share", label: "Share", permissions: ["agent.share", "run.share"] },
    { key: "approve", label: "Approve", permissions: ["run.approveHitl"] },
    { key: "respond", label: "Respond", permissions: ["run.respondToHitl"] },
    { key: "resume", label: "Resume", permissions: ["run.resume"] },
    { key: "permissions", label: "Permissions", permissions: ["agent.managePermissions"] },
  ],
};

function getDisplayRightDefinitions(
  category: PermissionCategory,
): ReadonlyArray<{ key: string; label: string; permissions: Permission[] }> {
  return DISPLAY_RIGHTS_BY_CATEGORY[category]
    ?? PERMISSIONS_BY_CATEGORY[category].map((permission) => ({
      key: permission,
      label: PERMISSION_SHORT_LABELS[permission],
      permissions: [permission],
    }));
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Display order for roles in the matrix table.
 * Excludes service_account and external_agent — they are machine principals
 * and not human-readable rows in the permissions matrix.
 */
export const ROLES_IN_ORDER: ReadonlyArray<Role> = [
  "platform_admin",
  "org_owner",
  "org_admin",
  "team_admin",
  "member",
] as const;

export const CATEGORIES_IN_ORDER: ReadonlyArray<PermissionCategory> = [
  "agents",
  "objects",
  "projects",
  "teams",
  "organizations",
  "skills",
  "connectors",
  "registry",
  "administration",
] as const;

// ---------------------------------------------------------------------------
// Permission → category mapping
// ---------------------------------------------------------------------------

/**
 * Maps each display category to the permission strings used to evaluate
 * the cell state in the matrix.
 *
 * Design intent:
 *
 *   The matrix displays PLATFORM_ADMIN's actual permission set as the
 *   reference for "full" access. platform_admin is not the OR of all
 *   possible permissions — it is a platform-governance role with read +
 *   list rights across domains and full registry management.
 *   Mutation-heavy permissions (cancel, share, editOutput for runs;
 *   create/delete for skills/objects) are granted to org-scoped roles
 *   via inheritance; they are intentionally absent from platform_admin's
 *   direct grants to keep platform governance distinct from org-scoped mutation authority.
 *
 * Category definitions are the perms platform_admin DIRECTLY holds in
 * each prefix group so that the "full" state maps naturally to
 * "platform admin has complete access to this domain at their scope."
 *
 * Cell state semantics:
 *   "full"    — role has ALL permissions listed for this category
 *   "partial" — role has SOME (≥1) but not all
 *   "none"    — role has NONE of the permissions in this category
 *
 * Every permission family used by the product UI should have a visible column
 * here so role affordances do not drift away from the policy table.
 */
export const PERMISSIONS_BY_CATEGORY: Record<PermissionCategory, ReadonlyArray<Permission>> = {
  agents: [
    "agent.read",
    "agent.list",
    "agent.execute",
    "run.read",
    "run.list",
    "run.readData",
    "agent.update",
    "run.editOutput",
    "agent.delete",
    "run.cancel",
    "agent.share",
    "run.share",
    "run.approveHitl",
    "run.respondToHitl",
    "run.resume",
    "agent.managePermissions",
  ],
  objects: [
    // Platform-admin level: read + list + search.
    "object.read",
    "object.list",
    "object.search",
    "object.create",
    "object.update",
    "object.delete",
    "object.promoteScope",
  ],
  projects: [
    "project.read",
    "project.list",
    "project.create",
    "project.update",
    "project.delete",
    "project.manageMembers",
  ],
  teams: [
    "team.read",
    "team.list",
    "team.create",
    "team.update",
    "team.delete",
    "team.manageMembers",
  ],
  organizations: [
    "organization.read",
    "organization.list",
    "organization.create",
    "organization.update",
    "organization.delete",
    "organization.manageMembers",
  ],
  skills: [
    "skill.read",
    "skill.list",
    "skill.assign",
    "skill.create",
    "skill.update",
    "skill.delete",
    "skill.install",
    "skill.manageVisibility",
  ],
  connectors: [
    "connector.read",
    "connector.use",
    "connector.create",
    "connector.update",
    "connector.delete",
  ],
  registry: [
    // Registry management perms — install/update/uninstall are platform-
    // governance operations granted only to platform_admin and org_admin+.
    // registry.read (granted to member) is intentionally excluded from
    // the category list so member/team_admin show "none" (no management
    // rights) rather than "partial" (some rights). This produces a clean
    // "full | full | full | none | none" column matching the intended management-only summary.
    "registry.install",
    "registry.update",
    "registry.uninstall",
  ],
  administration: [
    "settings.read",
    "settings.update",
    "audit.read",
  ],
};

// ---------------------------------------------------------------------------
// Matrix builder
// ---------------------------------------------------------------------------

function computeCellState(
  grants: ReadonlyArray<Permission>,
  categoryPerms: ReadonlyArray<Permission>,
): MatrixCellState {
  let count = 0;
  for (const perm of categoryPerms) {
    if (grants.includes(perm)) {
      count++;
    }
  }
  if (count === 0) return "none";
  if (count === categoryPerms.length) return "full";
  return "partial";
}

/**
 * Build the permission matrix rows — one row per role in ROLES_IN_ORDER,
 * one cell per category in CATEGORIES_IN_ORDER.
 *
 * Cell state:
 *  "full"    — role has ALL permissions in the category
 *  "partial" — role has SOME permissions in the category
 *  "none"    — role has NO permissions in the category
 */
export function buildPermissionMatrix(): MatrixRow[] {
  return ROLES_IN_ORDER.map((role) => {
    const grants = EFFECTIVE_GRANTS[role];
    const cells = {} as Record<PermissionCategory, MatrixCellState>;
    const counts = {} as MatrixRow["counts"];
    const permissions = {} as MatrixRow["permissions"];
    const displayRights = {} as MatrixRow["displayRights"];
    for (const category of CATEGORIES_IN_ORDER) {
      const categoryPerms = PERMISSIONS_BY_CATEGORY[category];
      cells[category] = computeCellState(grants, categoryPerms);
      counts[category] = {
        granted: categoryPerms.filter((perm) => grants.includes(perm)).length,
        total: categoryPerms.length,
      };
      permissions[category] = categoryPerms.map((permission) => ({
        permission,
        granted: grants.includes(permission),
      }));
      displayRights[category] = getDisplayRightDefinitions(category).map((right) => {
        const granted = right.permissions.filter((permission) => grants.includes(permission)).length;
        return {
          ...right,
          granted,
          total: right.permissions.length,
          state: granted === right.permissions.length ? "granted" : granted > 0 ? "partial" : "denied",
        };
      });
    }
    return { role, cells, counts, permissions, displayRights };
  });
}
