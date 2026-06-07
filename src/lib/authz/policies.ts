/**
 * Authorization kernel — default-rights policy matrix.
 *
 * - DIRECT_GRANTS: per-role permissions assigned directly (not inherited).
 * - INHERITS: parent-pointer map describing role inheritance.
 * - EFFECTIVE_GRANTS: the flattened, frozen lookup table consulted by
 *   `can()` at evaluation time. Computed at module load.
 *
 * Cross-org guarding (resource.organizationId !== actor.organizationId)
 * is NOT done here — it lives in `enforce.can()`. This table answers
 * the question "if the actor were inside the right org, what could they
 * do?". The org-scope check is a separate, centralized predicate.
 *
 * This keeps scope checks centralized and the policy matrix limited to
 * role-to-permission rules.
 */
import type { Permission } from "./permissions";

/**
 * Explicit role array — single source of truth for role iteration.
 * Used to build EFFECTIVE_GRANTS without an `as unknown as` cast so a
 * future refactor that adds a Role variant but forgets DIRECT_GRANTS
 * fails at compile time.
 */
export const ALL_ROLES = [
  "platform_admin",
  "org_owner",
  "org_admin",
  "team_admin",
  "member",
  "service_account",
  "external_agent",
  // Additional roles wired through the better-auth admin plugin and the
  // per-scope `role_grant` store. The registry references `requireRole:
  // "release_manager"` for marketplace publish checks.
  "developer",
  "release_manager",
  "customer",
] as const;

export type Role = (typeof ALL_ROLES)[number];

/**
 * Per-role direct grants. Inheritance is applied by `flatten()` below.
 *
 * Authorization model:
 *   - platform_admin: cross-org reads ONLY via explicitly marked code
 *     paths; this table grants only platform-level powers.
 *   - org_owner ⊃ org_admin ⊃ member (via INHERITS)
 *   - team_admin ⊃ member (via INHERITS)
 *   - service_account / external_agent: tightly enumerated, NO
 *     inheritance from member (least privilege).
 */
const DIRECT_GRANTS: Record<Role, ReadonlySet<Permission>> = {
  platform_admin: new Set<Permission>([
    // Platform-wide powers — NOT a cross-org bypass on their own.
    // Cross-org reads are enabled separately by `can()` checking
    // `actor.platformRole === "platform_admin"` against an explicit
    // code path that explicitly opts into using it.
    //
    // INVARIANT: Resource-CRUD permissions
    // (`*.update`, `*.delete`, `*.share`, `*.execute`, `*.manage*`,
    // `*.editOutput`, `*.promoteScope`, `*.cancel`, `*.resume`,
    // `*.assign`, `*.approveHitl`, `*.respondToHitl`) MUST NOT appear
    // here. Future admin-only write powers (moderation, GDPR-deletion,
    // ownership transfer) must be added as named code paths via a
    // dedicated `withPlatformAdminBypass(...)` helper rather than as
    // grants in this table — see roadmap entry "Authorization Bypass
    // Convention". The exception is `registry.*`: registry operations
    // are platform-level by product decision, not resource CRUD on user data.
    //
    // Full ADR: https://docs.cinatra.ai/references/platform/authz-admin-powers/
    "settings.read",
    "settings.update",
    "audit.read",
    "organization.create",
    "registry.read",
    "registry.install",
    "registry.update",
    "registry.uninstall",
    // Platform_admin can also see/list every category; cross-org
    // filtering happens in `can()`.
    "agent.read",
    "agent.list",
    "run.read",
    "run.list",
    "object.read",
    "object.list",
    "object.search",
    "project.read",
    "project.list",
    "project.create",
    "team.read",
    "team.list",
    "team.create",
    "organization.read",
    "organization.list",
    "skill.read",
    "skill.list",
    "connector.read",
  ]),
  org_owner: new Set<Permission>([
    // Owner-only powers on top of org_admin.
    "project.manageMembers",
    "team.manageMembers",
    "organization.manageMembers",
    "organization.delete",
    "skill.manageVisibility",
    "agent.managePermissions",
    "object.promoteScope",
  ]),
  org_admin: new Set<Permission>([
    // Admin-level mutations within the org.
    "agent.update",
    "agent.delete",
    "agent.share",
    "object.update",
    "object.delete",
    "project.create",
    "project.update",
    "project.delete",
    "team.update",
    "team.delete",
    "team.create",
    "organization.update",
    "skill.create",
    "skill.update",
    "skill.delete",
    "skill.install",
    "connector.create",
    "connector.update",
    "connector.delete",
    "run.share",
    "run.editOutput",
    "settings.update",
    // Both platform_admin and org_admin may install, update, and uninstall
    // registry packages. Members keep registry.read only.
    "registry.install",
    "registry.update",
    "registry.uninstall",
    // mutations across the broadened resource catalog.
    // Publish powers (marketplace_template.publish / workflow_extension.publish)
    // are deliberately NOT here — they belong to the single-capability
    // release_manager role.
    "artifact.update",
    "artifact.delete",
    "workflow_template.update",
    "workflow_template.delete",
    "workflow.update",
    "workflow.execute",
    "workflow.cancel",
    "workflow.approve",
    "workflow_run.cancel",
    "dashboard.update",
    "dashboard.delete",
    "list.update",
    "list.delete",
    "entity.update",
    "entity.delete",
    "trigger.update",
    "trigger.delete",
    "extension_registry.install",
    "extension_registry.uninstall",
    // Metrics are admin-tier (cost/usage; admin-only per CLAUDE.md).
    "metric.read",
    "metric.list",
  ]),
  team_admin: new Set<Permission>([
    // Team-scoped admin operations.
    "team.update",
    "team.manageMembers",
    "agent.share",
    "skill.assign",
    // Team admins may install registry packages at team-target scope.
    // Target-team checks live in installRegistryPackageAtScope; the
    // team-owner short-circuit in enforce-resource-access.ts allows the
    // install when actor.teamRoles[ownerId] === "team_admin".
    // INHERITS does NOT leak this grant to member.
    "registry.install",
  ]),
  member: new Set<Permission>([
    // Default member capabilities — read/execute within their org.
    "agent.read",
    "agent.list",
    "agent.execute",
    "run.read",
    "run.list",
    "run.readData",
    "run.cancel",
    "run.respondToHitl",
    "run.approveHitl",
    "run.resume",
    "object.read",
    "object.list",
    "object.search",
    "object.create",
    "project.create",
    "project.read",
    "project.list",
    "team.read",
    "team.list",
    "organization.read",
    "organization.list",
    "skill.read",
    "skill.list",
    "connector.read",
    "connector.use",
    "registry.read",
    "settings.read",
    // read/list across the broadened resource catalog +
    // create for the content types members legitimately author (mirrors the
    // existing object.create precedent: members create, admins update/delete).
    "artifact.read",
    "artifact.list",
    "artifact.create",
    "workflow_template.read",
    "workflow_template.list",
    "workflow_template.create",
    "workflow.read",
    "workflow.list",
    "workflow.create",
    "workflow_draft.read",
    "workflow_draft.write",
    "workflow_draft.update",
    "workflow_run.read",
    "workflow_run.list",
    "workflow_extension.read",
    "dashboard.read",
    "dashboard.list",
    "dashboard.create",
    "list.read",
    "list.list",
    "list.create",
    "entity.read",
    "entity.list",
    "entity.create",
    "trigger.read",
    "trigger.list",
    "trigger.create",
    "trigger.fire",
    "notification.read",
    "notification.list",
    "notification.update",
    // metric.read / metric.list are admin-tier (cost/usage metrics are
    // admin-only per CLAUDE.md) — granted to org_admin below, NOT member.
    "marketplace_template.read",
    "marketplace_template.list",
    "extension_registry.read",
    "extension_registry.list",
  ]),
  service_account: new Set<Permission>([
    // Tightly enumerated — does NOT inherit member (least privilege).
    "agent.execute",
    "run.read",
  ]),
  external_agent: new Set<Permission>([
    // Tightly enumerated — does NOT inherit member (least privilege).
    "agent.execute",
    "run.read",
  ]),
  // three new roles wired through the better-auth admin
  // plugin + per-scope `role_grant` store. Grants are deliberately additive
  // to `member` (developer + customer) or to nothing (release_manager —
  // single-capability gate). Carefully scoped to avoid leaking resource-CRUD
  // power to platform_admin (invariant test still LOCKED).
  developer: new Set<Permission>([
    // Developer = agent-author scope: can author/edit agents inside chat,
    // read settings, install skills, but cannot share/delete others' work.
    "agent.read",
    "agent.list",
    "agent.update",
    "agent.execute",
    "skill.read",
    "skill.list",
    "skill.create",
    "skill.update",
    "skill.install",
    "skill.assign",
    "run.read",
    "run.list",
    "settings.read",
  ]),
  release_manager: new Set<Permission>([
    // Release-manager = SINGLE capability: approve a marketplace publish.
    // Cannot author, cannot modify grants. Read access to the marketplace
    // is implicit via membership; the publish power is the carve-out.
    "marketplace_template.read",
    "marketplace_template.list",
    "marketplace_template.publish",
    "workflow_extension.publish",
    "registry.read",
  ]),
  customer: new Set<Permission>([
    // Customer/external = scoped, read-mostly. Grants land via per-scope
    // role_grant rows tied to specific resource ids; the enforcement layer
    // gates whether the role-grant's scope matches the resource. No write
    // power outside HITL responses on explicitly-granted runs.
    "agent.read",
    "skill.read",
    "run.read",
    "run.respondToHitl",
    "notification.read",
    "notification.list",
    "notification.update",
  ]),
};

/**
 * Inheritance edges: child → list of parents whose grants are folded
 * into the child's effective grants.
 *
 * Order matters in two places:
 *   - org_owner ⊃ org_admin ⊃ member  (via two-hop chain)
 *   - team_admin ⊃ member             (single hop)
 *
 * platform_admin, service_account, and external_agent intentionally
 * have NO entries — their grants are exactly DIRECT_GRANTS.
 */
const INHERITS: Partial<Record<Role, Role[]>> = {
  org_owner: ["org_admin"],
  org_admin: ["member"],
  team_admin: ["member"],
};

function flatten(role: Role, path: ReadonlyArray<Role> = []): Set<Permission> {
  // Throw on cycle detection rather than silently returning an empty
  // Set. A cycle in INHERITS would otherwise produce a partially
  // incorrect EFFECTIVE_GRANTS table at runtime; we want the failure to
  // be visible at module load. The `path` is per-branch (immutable
  // chain from the root call), not a shared mutated Set, so diamond
  // inheritance — A → B → member, A → C → member — is not mistaken
  // for a cycle.
  if (path.includes(role)) {
    throw new Error(
      `authz policy cycle detected at role "${role}" (chain: ${path.join(
        " -> ",
      )} -> ${role})`,
    );
  }
  const nextPath = [...path, role];
  const grants = new Set<Permission>(DIRECT_GRANTS[role]);
  for (const parent of INHERITS[role] ?? []) {
    for (const p of flatten(parent, nextPath)) grants.add(p);
  }
  return grants;
}

/**
 * Frozen, flattened role → permission lookup. Computed once at module
 * load; consulted by `enforce.can()` on every evaluation.
 *
 * Iterates ALL_ROLES rather than `Object.keys(DIRECT_GRANTS)` so adding
 * a Role variant without updating DIRECT_GRANTS fails at compile time.
 * The single (non-`unknown`) cast preserves the structural relationship
 * between the produced object and `Record<Role, ...>`.
 *
 * Inner values are frozen `ReadonlyArray<Permission>` rather than `Set`
 * because `Object.freeze` on the outer record does NOT freeze inner
 * Sets — `EFFECTIVE_GRANTS.member.add(...)` would otherwise succeed at
 * runtime and persistently elevate every member's permissions for the
 * lifetime of the process. Callers should consult permissions through
 * `roleHasPermission()` so the underlying storage can change without
 * breaking consumers.
 */
const EFFECTIVE_GRANTS_COMPUTED = Object.fromEntries(
  ALL_ROLES.map(
    (r) => [r, Object.freeze(Array.from(flatten(r)))] as const,
  ),
) as Record<Role, ReadonlyArray<Permission>>;

export const EFFECTIVE_GRANTS: Readonly<Record<Role, ReadonlyArray<Permission>>> =
  Object.freeze(EFFECTIVE_GRANTS_COMPUTED);

/**
 * Public permission-lookup API. Use this rather than indexing
 * EFFECTIVE_GRANTS directly so the underlying storage can change
 * without breaking consumers.
 */
export function roleHasPermission(role: Role, perm: Permission): boolean {
  return EFFECTIVE_GRANTS[role].includes(perm);
}
