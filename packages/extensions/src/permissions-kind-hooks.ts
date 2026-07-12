import "server-only";

// ---------------------------------------------------------------------------
// Per-kind hooks for the generic Extension Permissions layer.
//
// The polymorphic backend (extension_co_owners + extension_access_policy)
// handles the storage + most of the auth model identically across kinds. A
// small number of behaviours legitimately differ by kind:
//
//   • Cross-resource auth (skill consults parent-package co-owners; agent_run
//     enforces allowRunSharing on the policy).
//   • Per-kind side effects on save (skills project the policy back into
//     legacy `(level, scope)` tuple for matching/visibility readers that
//     have not yet migrated off the old schema).
//   • Resource existence + deletion cascades (the polymorphic tables can't
//     FK to a single target — each kind owns its own cascade hook).
//
// This module is the single registry that lists those hooks per kind. Server
// actions and the page-data loader consult it; call sites stay thin (no
// kind-aware branching outside this file).
// ---------------------------------------------------------------------------

import type {
  AgentAuthPolicy,
  AgentAuthPolicyVisibility,
} from "@cinatra-ai/agents/auth-policy";
import type { ActorContext } from "@/lib/authz";
import {
  hasAdminStandingOverExtension,
  type ExtensionOwnerContext,
} from "./enforce-extension-access";

export type ExtensionKind =
  | "agent_run"
  | "agent_template"
  | "skill_package"
  | "skill"
  // connector / artifact / workflow extension ACCESS flows through
  // the same polymorphic backend. For these kinds the polymorphic
  // `resource_id` is the canonical `installed_extension.id` (see
  // ./extension-resource-identity.ts) — there is no per-kind legacy access
  // table to dual-write, so their hooks are canonical-only.
  | "connector"
  | "artifact"
  | "workflow"
  // Per-connection grants (cinatra#950/#951): a `connection` is an
  // owner-bound entity in the `nango_connection` identity table
  // (./connection-identity-store.ts); its polymorphic `resource_id` is that
  // table's UUID. PERMISSIONS resource-kind vocabulary ONLY — deliberately
  // NOT an `installed_extension.kind`, package-store kind, or manifest kind.
  | "connection";

export const ALL_EXTENSION_KINDS: ExtensionKind[] = [
  "agent_run",
  "agent_template",
  "skill_package",
  "skill",
  "connector",
  "artifact",
  "workflow",
  "connection",
];

export function isExtensionKind(value: unknown): value is ExtensionKind {
  return (
    typeof value === "string" &&
    (ALL_EXTENSION_KINDS as string[]).includes(value)
  );
}

export type ExtensionKindHooks = {
  /**
   * Confirm the resource exists. Returning false short-circuits all
   * permissions actions with `error: "not_found"` and is also how the loader
   * decides to 404. Implementations should be cheap (single SQL read).
   */
  resourceExists: (resourceId: string) => Promise<boolean>;

  /**
   * Resolve the extension's OWNER CONTEXT (owner_level / owner_id /
   * organization_id) so the generic permission actions can build the
   * evaluator's owner-aware resource and delegate the `manage` decision to
   * `canExtensionAccess` — the single source of truth that admits owning-org
   * admins (admin-parity P2), the installer, and co-owners uniformly.
   *
   * Return `null` when the kind has no cleanly-resolvable owner anchor; the
   * caller then FALLS BACK to the legacy installer / co-owner / platform-admin
   * gate (no behavioural change for that kind). Implemented for the
   * installed-extension-anchored kinds (connector / artifact / workflow, whose
   * resource_id is the canonical installed_extension.id) and `connection` (the
   * nango identity row); other kinds resolve the same anchor as they gain one.
   */
  resolveOwnerContext?: (
    resourceId: string,
  ) => Promise<ExtensionOwnerContext | null>;

  /**
   * Return ADDITIONAL editor user ids beyond what the polymorphic
   * extension_co_owners table already grants. Examples:
   *   - skill: the parent skill_package's installer + its co-owners
   *     (so package-level grants implicitly carry down to children).
   *   - agent_run: the run's runBy (so the launching user can always edit
   *     their own run's policy, even if they never co-owned the run).
   *
   * Return undefined or [] when there are no extras. The set is unioned
   * with the polymorphic co-owners + installed_by_user_id in the auth gate.
   */
  extraEditors?: (resourceId: string) => Promise<string[] | undefined>;

  /**
   * Per-kind gate that runs BEFORE adding a co-owner. Returning a string
   * error code rejects with that code (e.g. "sharing_disabled" when an
   * agent_run's allowRunSharing is false). Return null/undefined to allow.
   */
  allowSharing?: (resourceId: string) => Promise<string | null | undefined>;

  /**
   * Per-kind WRITE-TIME policy veto (cinatra#953 W3). Runs in
   * `saveExtensionAccessPolicy` AFTER the auth gate (canEditExtension) and
   * BEFORE any write. Returning a string error code REJECTS the save with
   * that typed code; null/undefined allows. This is the ENFORCEMENT half of
   * the connector `access.scope.only` lock: the UI's disabled picker rows are
   * an affordance — this hook is what actually refuses an out-of-ceiling
   * grant (`scope_locked_by_connector`) or a grant against a locus outside
   * the saving actor's real memberships (`invalid_locus`).
   */
  validatePolicyWrite?: (
    resourceId: string,
    policy: AgentAuthPolicy,
    // `actor` carries admin-standing context (admin-parity P2): when the saving
    // actor holds admin standing over the resource's org, collective loci are
    // validated by the resource's org-containment rather than the actor's
    // personal memberships. Absent/undefined actor → the non-admin membership
    // path (unchanged behaviour).
    ctx: { userId: string; actor?: ActorContext | null },
  ) => Promise<string | null | undefined>;

  /**
   * Fires AFTER a successful policy write. Used for kind-specific
   * projections — e.g. skills also write (level, scope) into the legacy
   * payload column so matching/visibility readers continue to work until
   * those callers migrate to the canonical accessPolicy.
   *
   * Must not throw — the polymorphic write has already succeeded; failures
   * here are logged via console.warn. Edit-flow actions
   * (saveExtensionAccessPolicy / addExtensionCoOwner / removeExtensionCoOwner)
   * do NOT surface hook failures in their return value — the polymorphic
   * write is canonical and the legacy mirror is best-effort. Install-time
   * callers (importAgentTemplate / installGitHubSkillExtension) wrap their
   * own warnings[] separately for the operator-facing toast pipeline.
   */
  afterPolicyWrite?: (resourceId: string, policy: AgentAuthPolicy) => Promise<void>;

  /**
   * Compatibility dual-write hooks. Fires AFTER a successful polymorphic
   * co-owner insert / delete. Mirrors the change into the kind's legacy
   * co-owner table so existing readers that still query the legacy table per
   * kind stay in sync.
   *
   * Must not throw — the polymorphic write has already succeeded; failures
   * here are logged via console.warn. Edit-flow actions
   * (saveExtensionAccessPolicy / addExtensionCoOwner / removeExtensionCoOwner)
   * do NOT surface hook failures in their return value — the polymorphic
   * write is canonical and the legacy mirror is best-effort. Install-time
   * callers (importAgentTemplate / installGitHubSkillExtension) wrap their
   * own warnings[] separately for the operator-facing toast pipeline.
   */
  afterCoOwnerAdd?: (
    resourceId: string,
    targetUserId: string,
    grantedBy: string,
  ) => Promise<void>;
  afterCoOwnerRemove?: (
    resourceId: string,
    targetUserId: string,
  ) => Promise<void>;

  /**
   * Compatibility dual-write hook for the installer pointer. Mirrors into
   * the kind's legacy installer location (e.g.
   * skill_packages.payload->'installedByUserId', agent_runs.run_by).
   */
  afterInstallerSet?: (
    resourceId: string,
    installedByUserId: string | null,
  ) => Promise<void>;

  /**
   * Page-level redirect target for self-removal flows. Per-kind so the
   * PermissionsForm widget can land users somewhere reasonable after they
   * remove themselves from a resource.
   */
  selfRemoveRedirect: string;
};

// ---------------------------------------------------------------------------
// Hook implementations — lazy-loaded so this module doesn't pull every kind's
// store layer into the bundle unconditionally.
// ---------------------------------------------------------------------------

async function agentRunHooks(): Promise<ExtensionKindHooks> {
  const { readAgentRunById, updateAgentRunAuthPolicy } = await import("@cinatra-ai/agents/store");
  const { syncLegacyCoOwnersFromCanonical } = await import("./permissions-store");
  return {
    resourceExists: async (id) => {
      const run = await readAgentRunById(id);
      return run !== null;
    },
    extraEditors: async (id) => {
      const run = await readAgentRunById(id);
      const out: string[] = [];
      if (run?.runBy) out.push(run.runBy);
      return out;
    },
    allowSharing: async (id) => {
      const run = await readAgentRunById(id);
      const effectivePolicy = (run as { effectivePolicy?: AgentAuthPolicy | null } | null)?.effectivePolicy;
      if (effectivePolicy && effectivePolicy.allowRunSharing !== true) {
        return "sharing_disabled";
      }
      return null;
    },
    // Dual-write so the legacy run-side readers (orchestrator-screens,
    // store enforce-access, MCP handlers — many callers) keep working
    // until they migrate to the polymorphic table.
    afterPolicyWrite: async (id, policy) => {
      await updateAgentRunAuthPolicy(id, policy);
    },
    // Snapshot-sync from canonical instead of mirroring per event.
    // This eliminates the add/remove reorder race.
    afterCoOwnerAdd: async (id) => {
      await syncLegacyCoOwnersFromCanonical({
        resourceKind: "agent_run",
        resourceId: id,
        legacyTable: "run_co_owners",
        legacyIdColumn: "run_id",
      });
    },
    afterCoOwnerRemove: async (id) => {
      await syncLegacyCoOwnersFromCanonical({
        resourceKind: "agent_run",
        resourceId: id,
        legacyTable: "run_co_owners",
        legacyIdColumn: "run_id",
      });
    },
    selfRemoveRedirect: "/agents",
  };
}

async function agentTemplateHooks(): Promise<ExtensionKindHooks> {
  const { readAgentTemplateById, updateAgentTemplateAuthPolicy } = await import(
    "@cinatra-ai/agents/store"
  );
  return {
    resourceExists: async (id) => {
      const template = await readAgentTemplateById(id);
      return template !== null;
    },
    extraEditors: async (id) => {
      // Imported templates carry creator_id. Treat the creator as an
      // implicit editor so they can manage the template's access without
      // first granting themselves a co-owner row.
      const template = await readAgentTemplateById(id);
      return template?.creatorId ? [template.creatorId] : [];
    },
    // Dual-write so the run enforcement path sees a generic-surface policy edit
    // (admin-parity P4, cinatra#1129). The polymorphic write lands the canonical
    // policy in extension_access_policy, but enforceRunAccess resolves a run's
    // effective policy from run.authPolicy ?? agent_templates.agent_auth_policy
    // ?? DEFAULT — the legacy template column. Without this mirror an
    // agent_template access-policy edit made through the generic Permissions
    // surface never reached enforceRunAccess. Must not throw (best-effort
    // mirror; the polymorphic write is canonical).
    afterPolicyWrite: async (id, policy) => {
      await updateAgentTemplateAuthPolicy(id, policy);
    },
    selfRemoveRedirect: "/configuration/extensions",
  };
}

async function skillPackageHooks(): Promise<ExtensionKindHooks> {
  const {
    writeSkillPackageAccessPolicy,
    setSkillPackageInstalledBy,
  } = await import("@cinatra-ai/skills/store");
  // Pure existence lookup — snapshot read (cinatra#1364).
  const { readSkillsCatalogSnapshot } = await import("@cinatra-ai/skills/skill-packages");
  const { syncLegacyCoOwnersFromCanonical } = await import("./permissions-store");
  return {
    resourceExists: async (id) => {
      const catalog = await readSkillsCatalogSnapshot();
      return catalog.skillPackages.some((p) => p.packageId === id || p.id === id);
    },
    // Dual-write so skill-package loaders that still read
    // `skill_packages.payload->accessPolicy` and the legacy
    // `skill_package_co_owners` table see the same data.
    afterPolicyWrite: async (id, policy) => {
      await writeSkillPackageAccessPolicy(id, policy);
    },
    // Snapshot-sync from canonical.
    afterCoOwnerAdd: async (id) => {
      await syncLegacyCoOwnersFromCanonical({
        resourceKind: "skill_package",
        resourceId: id,
        legacyTable: "skill_package_co_owners",
        legacyIdColumn: "package_id",
      });
    },
    afterCoOwnerRemove: async (id) => {
      await syncLegacyCoOwnersFromCanonical({
        resourceKind: "skill_package",
        resourceId: id,
        legacyTable: "skill_package_co_owners",
        legacyIdColumn: "package_id",
      });
    },
    afterInstallerSet: async (id, installedByUserId) => {
      // setSkillPackageInstalledBy preserves null; matches polymorphic semantics
      await setSkillPackageInstalledBy(id, installedByUserId);
    },
    selfRemoveRedirect: "/skills",
  };
}

async function skillHooks(): Promise<ExtensionKindHooks> {
  const { writeSkillAccessPolicy } = await import("@cinatra-ai/skills/store");
  // Pure existence/parent lookups — snapshot read (cinatra#1364).
  const { readSkillsCatalogSnapshot } = await import("@cinatra-ai/skills/skill-packages");
  const { syncLegacyCoOwnersFromCanonical } = await import("./permissions-store");
  return {
    resourceExists: async (id) => {
      const catalog = await readSkillsCatalogSnapshot();
      return catalog.skills.some((s) => s.id === id);
    },
    extraEditors: async (id) => {
      // Skills inherit edit rights from their parent skill_package's
      // installer + co-owners. The parent lookup goes through the
      // polymorphic table.
      const catalog = await readSkillsCatalogSnapshot();
      const skill = catalog.skills.find((s) => s.id === id);
      if (!skill?.packageId) return [];

      const { readExtensionInstalledBy, readExtensionCoOwners } = await import("./permissions-store");
      const parentInstaller = await readExtensionInstalledBy("skill_package", skill.packageId);
      const parentCoOwners = await readExtensionCoOwners("skill_package", skill.packageId);
      const extras = parentCoOwners.map((c) => c.userId);
      if (parentInstaller) extras.push(parentInstaller);
      return extras;
    },
    afterPolicyWrite: async (id, policy) => {
      // Compatibility projection — keep the legacy (level, scope) tuple in
      // sync with the canonical policy so the matching + visibility readers
      // that have not migrated yet keep producing correct results.
      await writeSkillAccessPolicy(id, policy);
    },
    // Dual-write to skill_co_owners so the legacy loader
    // (loadSkillPermissionsContext) keeps returning the picked co-owners
    // until it migrates to the polymorphic table. Snapshot-sync from
    // canonical to avoid add/remove reorder races.
    afterCoOwnerAdd: async (id) => {
      await syncLegacyCoOwnersFromCanonical({
        resourceKind: "skill",
        resourceId: id,
        legacyTable: "skill_co_owners",
        legacyIdColumn: "skill_id",
      });
    },
    afterCoOwnerRemove: async (id) => {
      await syncLegacyCoOwnersFromCanonical({
        resourceKind: "skill",
        resourceId: id,
        legacyTable: "skill_co_owners",
        legacyIdColumn: "skill_id",
      });
    },
    selfRemoveRedirect: "/skills",
  };
}

// ---------------------------------------------------------------------------
// Installed-extension-anchored kinds (connector / artifact / workflow).
//
// For these kinds the polymorphic resource_id IS the canonical
// `installed_extension.id`. There is no per-kind legacy access table, so the
// hooks are canonical-only: resourceExists reads the installed_extension row,
// the installer is the implicit editor (already carried via installed_by), and
// there are no afterPolicyWrite / afterCoOwner* legacy projections.
// ---------------------------------------------------------------------------

function installedExtensionAnchoredHooks(
  expectedKind: "connector" | "artifact" | "workflow",
  selfRemoveRedirect: string,
): () => Promise<ExtensionKindHooks> {
  return async () => {
    const { readInstalledExtensionById } = await import("./canonical-store");
    return {
      // Fail closed on a kind mismatch: a {kind, resourceId} pair that resolves
      // to an installed_extension of a DIFFERENT kind is treated as not-found,
      // so the auth gate denies (and the loader 404s) rather than evaluating a
      // policy against the wrong resource.
      resourceExists: async (id) => {
        const row = await readInstalledExtensionById(id);
        return row !== null && row.kind === expectedKind;
      },
      // Owner context IS the canonical installed_extension row for these kinds
      // (resource_id === installed_extension.id). Kind-mismatched or missing
      // rows resolve to null → the caller falls back to the legacy gate.
      resolveOwnerContext: async (id) => {
        const row = await readInstalledExtensionById(id);
        if (row === null || row.kind !== expectedKind) return null;
        return {
          ownerLevel: row.ownerLevel,
          ownerId: row.ownerId,
          organizationId: row.organizationId,
        };
      },
      selfRemoveRedirect,
    };
  };
}

const connectorHooks = installedExtensionAnchoredHooks("connector", "/connectors");
const artifactHooks = installedExtensionAnchoredHooks("artifact", "/configuration/extensions");
const workflowHooks = installedExtensionAnchoredHooks("workflow", "/configuration/extensions");

// ---------------------------------------------------------------------------
// Connection hooks (cinatra#950/#951). The polymorphic resource_id is the
// `nango_connection` identity UUID. Canonical-only (no legacy access table):
// resourceExists reads the LIVE identity row (a soft-deleted connection fails
// closed — the auth gate denies and the loader 404s), and the connection's
// OWNER is the implicit editor (owner-bound entity: the creator manages the
// grant without first co-owning their own connection).
// ---------------------------------------------------------------------------
async function connectionHooks(): Promise<ExtensionKindHooks> {
  const { readNangoConnectionById } = await import("./connection-identity-store");

  // The connector's declared access ceiling, from the W1 registration CACHE —
  // resolved through the SAME resolution the W2 use-gate clamps with, so the
  // write rejection and the read clamp can never disagree. Dynamic import:
  // the use-gate module is server-only and already sits in the routes that
  // carry this hook's callers.
  const resolveDeclaration = async (
    identity: import("./connection-identity-store").NangoConnectionIdentity,
  ) => {
    const { resolveConnectionAccessDeclaration } = await import("@/lib/connection-use-gate");
    return resolveConnectionAccessDeclaration(identity);
  };

  return {
    resourceExists: async (id) => {
      const row = await readNangoConnectionById(id);
      return row !== null;
    },
    // A connection is an owner-bound (user-level) entity anchored to its org.
    // The org anchor is what admits an owning-org admin's `manage` standing
    // (admin-parity P2 — see/re-scope/revoke, but never `use`, per the
    // evaluator's connection carve-out).
    resolveOwnerContext: async (id) => {
      const row = await readNangoConnectionById(id);
      if (row === null) return null;
      return {
        ownerLevel: "user",
        ownerId: row.ownerUserId,
        organizationId: row.organizationId,
      };
    },
    extraEditors: async (id) => {
      const row = await readNangoConnectionById(id);
      return row ? [row.ownerUserId] : [];
    },
    // Write-time enforcement of the connector's `access.scope.only` ceiling +
    // real-locus validation (cinatra#953 W3). The UI lock is an affordance;
    // THIS is the enforcement — a direct action call with a broader grant is
    // rejected with a typed code before any write.
    validatePolicyWrite: async (id, policy, ctx) => {
      const identity = await readNangoConnectionById(id);
      if (!identity) return "not_found";

      // Multi-scope W1: each field is a token ARRAY. This write-validator
      // checks every token across all three fields is a real, actor-held locus
      // within the connector ceiling — so flatten the selections into the full
      // token set (fail-closed: EVERY token must pass). Identical to the
      // pre-array behavior when each field holds a single token.
      const visibilities: AgentAuthPolicyVisibility[] = [
        ...policy.runListVisibility,
        ...policy.runDataVisibility,
        ...policy.runExecuteVisibility,
      ];
      const ownerOnly = visibilities.every((v) => v === "owner");

      // 1. The `only` ceiling (fail-closed). package_unresolved = the ceiling
      // cannot be read → refuse everything except an owner-only policy.
      const resolution = await resolveDeclaration(identity);
      if (resolution.kind === "package_unresolved") {
        return ownerOnly ? null : "scope_locked_by_connector";
      }
      const declaration = resolution.declaration;
      if (declaration?.mode === "only") {
        const { visibilityWithinCeiling } = await import("@/lib/connection-use-gate");
        const withinCeiling = visibilities.every((v) =>
          visibilityWithinCeiling(v, declaration.scope, identity.organizationId),
        );
        if (!withinCeiling) return "scope_locked_by_connector";
      }
      if (ownerOnly) return null; // narrowing to owner-only is always a real locus

      // 2. REAL-LOCI validation (all modes): every collective token must name a
      // concrete locus of the identity's own org. For a NON-admin actor the
      // locus must be one the SAVING actor actually holds (org / team / project
      // membership). For an actor with ADMIN STANDING over the connection's org
      // (admin-parity P2), the locus is validated by ORG-CONTAINMENT of the
      // connection's own org instead of the admin's personal memberships — an
      // admin re-scopes any org-anchored connection to any locus of that org
      // without first being a member. The `only` ceiling above still clamps the
      // admin (vendor ceilings are not overridden by admin standing). Bare
      // legacy "org" and `workspace`-on-null-org are refused in BOTH branches.
      const collective = [...new Set(visibilities.filter((v) => v !== "owner"))];

      const connectionOwner: ExtensionOwnerContext = {
        ownerLevel: "user",
        ownerId: identity.ownerUserId,
        organizationId: identity.organizationId,
      };
      const adminStanding =
        ctx.actor != null && hasAdminStandingOverExtension(ctx.actor, connectionOwner);

      const needsMemberships =
        !adminStanding &&
        collective.some(
          (v) => v.startsWith("org:") || v.startsWith("team:") || v.startsWith("project:"),
        );
      let actorOrgs: Array<{ id: string; teams: Array<{ id: string }> }> = [];
      let actorProjectIds = new Set<string>();
      if (needsMemberships) {
        const { readOrgsWithTeamsForUser, readProjectsForUser } = await import(
          "@/lib/better-auth-db"
        );
        actorOrgs = await readOrgsWithTeamsForUser(ctx.userId);
        if (identity.organizationId) {
          actorProjectIds = new Set(
            (await readProjectsForUser(ctx.userId, identity.organizationId)).map((p) => p.id),
          );
        }
      }
      for (const v of collective) {
        if (v === "admin") continue; // admin tier is owner-org-anchored, not id-carrying
        if (v === "workspace") {
          // A null-org connection must never gain a workspace grant — there
          // is no cross-org guard to contain it (mirrors the seam's null-org
          // narrowing).
          if (identity.organizationId === null) return "invalid_locus";
          continue;
        }
        if (v === "org") return "invalid_locus"; // legacy bare token — never a concrete locus
        if (v.startsWith("org:")) {
          const orgId = v.slice("org:".length);
          if (identity.organizationId === null || orgId !== identity.organizationId) {
            return "invalid_locus";
          }
          // Admin standing is over THIS org, so containment is already proven;
          // a non-admin must additionally be a member of the org.
          if (!adminStanding && !actorOrgs.some((o) => o.id === orgId)) {
            return "invalid_locus";
          }
          continue;
        }
        if (v.startsWith("team:")) {
          const teamId = v.slice("team:".length);
          if (adminStanding) {
            // Org-containment only: the team must belong to the connection's org.
            if (identity.organizationId === null) return "invalid_locus";
            const { readTeamForOrg } = await import("@/lib/better-auth-db");
            if (!(await readTeamForOrg(teamId, identity.organizationId))) {
              return "invalid_locus";
            }
          } else {
            // readOrgsWithTeamsForUser joins team.organizationId, so a hit under
            // the identity's org proves BOTH containment and actor membership.
            const owningOrg = actorOrgs.find((o) => o.teams.some((t) => t.id === teamId));
            if (!owningOrg || owningOrg.id !== identity.organizationId) return "invalid_locus";
          }
          continue;
        }
        if (v.startsWith("project:")) {
          const projectId = v.slice("project:".length);
          // Non-admin: the actor must hold the project. Admin standing skips the
          // personal-access requirement but STILL requires org-containment below.
          if (!adminStanding && !actorProjectIds.has(projectId)) return "invalid_locus";
          const { readProjectById } = await import("@/lib/projects-store");
          const project = await readProjectById(projectId);
          if (!project || project.organizationId !== identity.organizationId) {
            return "invalid_locus";
          }
          continue;
        }
        return "invalid_locus"; // unknown token shape — fail closed
      }
      return null;
    },
    // Person-grant (co-owner) writes under an `only` ceiling: the read-side
    // clamp strips person-grants wherever the declaration's collective
    // dimension cannot be verified for a person (user/team/project), so
    // adding one would create a DEAD grant — refuse it at write time.
    // `only:"user"` additionally means the connection is never shareable.
    allowSharing: async (id) => {
      const identity = await readNangoConnectionById(id);
      if (!identity) return "sharing_disabled";
      const resolution = await resolveDeclaration(identity);
      if (resolution.kind === "package_unresolved") return "sharing_disabled";
      const declaration = resolution.declaration;
      if (
        declaration?.mode === "only" &&
        (declaration.scope === "user" ||
          declaration.scope === "team" ||
          declaration.scope === "project")
      ) {
        return "sharing_disabled";
      }
      return null;
    },
    selfRemoveRedirect: "/connectors",
  };
}

const hookFactories: Record<ExtensionKind, () => Promise<ExtensionKindHooks>> = {
  agent_run: agentRunHooks,
  agent_template: agentTemplateHooks,
  skill_package: skillPackageHooks,
  skill: skillHooks,
  connector: connectorHooks,
  artifact: artifactHooks,
  workflow: workflowHooks,
  connection: connectionHooks,
};

let cache: Partial<Record<ExtensionKind, ExtensionKindHooks>> = {};

/**
 * Resolve the per-kind hook bundle. Cached per process so the underlying
 * store modules only load once.
 */
export async function getExtensionKindHooks(kind: ExtensionKind): Promise<ExtensionKindHooks> {
  const cached = cache[kind];
  if (cached) return cached;
  const factory = hookFactories[kind];
  const hooks = await factory();
  cache[kind] = hooks;
  return hooks;
}

// Test-only escape hatch — tests can override individual hooks per kind
// without monkey-patching the module's module-level state directly.
export function __resetExtensionKindHooksCacheForTesting(
  overrides?: Partial<Record<ExtensionKind, ExtensionKindHooks>>,
): void {
  cache = overrides ? { ...overrides } : {};
}
