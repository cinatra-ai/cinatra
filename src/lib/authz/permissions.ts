/**
 * Authorization kernel — permission catalog.
 *
 * String-literal union (NOT a TS enum) — serializes as a plain string
 * across BullMQ payloads and JSON audit events. Avoid TS enums here because
 * enum serialization can drift across process boundaries.
 *
 * ## Platform-level vs resource-CRUD
 *
 * Permissions are organized into two intentional groups, separated by
 * `// === ... ===` markers below:
 *
 *   1. Platform-level powers — `registry.*`, `settings.*`, `audit.*`.
 *      Owned by the platform, never by an end user. Ok to grant via
 *      DIRECT_GRANTS to `platform_admin` and selectively to `org_admin`.
 *   2. Resource-CRUD powers — everything else. Operate on a single
 *      tenant's data. **MUST NOT** be granted to `platform_admin` via
 *      DIRECT_GRANTS. Admin write power on user data is expressed as
 *      explicit, audited code paths via
 *      `withPlatformAdminBypass(...)` from `./admin-bypass`.
 *
 * The split is enforced by
 * `src/lib/authz/__tests__/platform-admin-grants-invariant.test.ts`.
 * If a new permission is added below, place it in the correct section and
 * re-check the invariant.
 */
export type Permission =
  // === Resource-CRUD powers ===
  // Agents
  | "agent.read"
  | "agent.list"
  | "agent.execute"
  | "agent.update"
  | "agent.delete"
  | "agent.share"
  | "agent.managePermissions"
  // Runs
  | "run.read"
  | "run.list"
  | "run.readData"
  | "run.cancel"
  | "run.share"
  | "run.approveHitl"
  | "run.respondToHitl"
  | "run.resume"
  | "run.editOutput"
  // Objects
  | "object.read"
  | "object.list"
  | "object.search"
  | "object.create"
  | "object.update"
  | "object.delete"
  | "object.promoteScope"
  // Projects
  | "project.read"
  | "project.list"
  | "project.create"
  | "project.update"
  | "project.delete"
  | "project.manageMembers"
  // Teams
  | "team.read"
  | "team.list"
  | "team.create"
  | "team.update"
  | "team.delete"
  | "team.manageMembers"
  // Organizations
  | "organization.read"
  | "organization.list"
  | "organization.create"
  | "organization.update"
  | "organization.delete"
  | "organization.manageMembers"
  // Skills
  | "skill.read"
  | "skill.list"
  | "skill.assign"
  | "skill.create"
  | "skill.update"
  | "skill.delete"
  | "skill.install"
  | "skill.manageVisibility"
  // Connectors
  | "connector.read"
  | "connector.use"
  | "connector.create"
  | "connector.update"
  | "connector.delete"
  // Broader resource catalog. Resource-CRUD powers only.
  // Artifacts
  | "artifact.read"
  | "artifact.list"
  | "artifact.create"
  | "artifact.update"
  | "artifact.delete"
  // Workflow templates / workflows / drafts / runs
  | "workflow_template.read"
  | "workflow_template.list"
  | "workflow_template.create"
  | "workflow_template.update"
  | "workflow_template.delete"
  | "workflow.read"
  | "workflow.list"
  | "workflow.create"
  | "workflow.update"
  | "workflow.cancel"
  | "workflow.approve"
  | "workflow.execute"
  | "workflow_draft.read"
  | "workflow_draft.write"
  | "workflow_draft.update"
  | "workflow_run.read"
  | "workflow_run.list"
  | "workflow_run.cancel"
  | "workflow_extension.read"
  | "workflow_extension.publish"
  // Dashboards
  | "dashboard.read"
  | "dashboard.list"
  | "dashboard.create"
  | "dashboard.update"
  | "dashboard.delete"
  // Lists
  | "list.read"
  | "list.list"
  | "list.create"
  | "list.update"
  | "list.delete"
  // Entities (accounts / contacts)
  | "entity.read"
  | "entity.list"
  | "entity.create"
  | "entity.update"
  | "entity.delete"
  // Triggers
  | "trigger.read"
  | "trigger.list"
  | "trigger.create"
  | "trigger.update"
  | "trigger.delete"
  | "trigger.fire"
  // Notifications
  | "notification.read"
  | "notification.list"
  | "notification.update"
  // Metrics (read-only for non-admins; admin/owner for retention/config)
  | "metric.read"
  | "metric.list"
  // Marketplace / extension registry
  | "marketplace_template.read"
  | "marketplace_template.list"
  | "marketplace_template.publish"
  | "extension_registry.read"
  | "extension_registry.list"
  | "extension_registry.install"
  | "extension_registry.uninstall"
  // === Platform-level powers ===
  // Registry
  | "registry.read"
  | "registry.install"
  | "registry.update"
  | "registry.uninstall"
  // Administration & audit
  | "settings.read"
  | "settings.update"
  | "audit.read";
