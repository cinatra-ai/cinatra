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

import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy";

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
  | "workflow";

export const ALL_EXTENSION_KINDS: ExtensionKind[] = [
  "agent_run",
  "agent_template",
  "skill_package",
  "skill",
  "connector",
  "artifact",
  "workflow",
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
  const { readAgentTemplateById } = await import("@cinatra-ai/agents/store");
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
    selfRemoveRedirect: "/configuration/extensions",
  };
}

async function skillPackageHooks(): Promise<ExtensionKindHooks> {
  const {
    readSkillsCatalog,
    writeSkillPackageAccessPolicy,
    setSkillPackageInstalledBy,
  } = await import("@cinatra-ai/skills/store");
  const { syncLegacyCoOwnersFromCanonical } = await import("./permissions-store");
  return {
    resourceExists: async (id) => {
      const catalog = await readSkillsCatalog();
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
  const { readSkillsCatalog, writeSkillAccessPolicy } = await import("@cinatra-ai/skills/store");
  const { syncLegacyCoOwnersFromCanonical } = await import("./permissions-store");
  return {
    resourceExists: async (id) => {
      const catalog = await readSkillsCatalog();
      return catalog.skills.some((s) => s.id === id);
    },
    extraEditors: async (id) => {
      // Skills inherit edit rights from their parent skill_package's
      // installer + co-owners. The parent lookup goes through the
      // polymorphic table.
      const catalog = await readSkillsCatalog();
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
      selfRemoveRedirect,
    };
  };
}

const connectorHooks = installedExtensionAnchoredHooks("connector", "/connectors");
const artifactHooks = installedExtensionAnchoredHooks("artifact", "/configuration/extensions");
const workflowHooks = installedExtensionAnchoredHooks("workflow", "/configuration/extensions");

const hookFactories: Record<ExtensionKind, () => Promise<ExtensionKindHooks>> = {
  agent_run: agentRunHooks,
  agent_template: agentTemplateHooks,
  skill_package: skillPackageHooks,
  skill: skillHooks,
  connector: connectorHooks,
  artifact: artifactHooks,
  workflow: workflowHooks,
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
