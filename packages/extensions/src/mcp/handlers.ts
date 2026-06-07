import { listExtensionPackages } from "@cinatra-ai/registries";
import { extensionRegistry } from "../index";
import {
  deriveTypeId,
  resolveExtensionPackageForLifecycle,
  type LifecycleResolution,
} from "../utils";
import type { Actor } from "@cinatra-ai/extension-types";
import { readInstanceIdentity } from "@/lib/instance-identity-store";
import { getEffectiveViewerScope } from "@/lib/marketplace-credentials";
import { loadDeploymentRegistryConfig } from "@/lib/deployment-registry-config";

// Uniform visibility gate.
//
// The publish path persists `origin` to the database
// `agent_templates.origin` / `skill_packages.origin` JSONB columns, not into
// the Verdaccio manifest. Reading `pkg.origin` from an extracted package
// manifest does not provide reliable visibility metadata for lifecycle
// enforcement.
//
// Keep the gate as a single chokepoint so a stronger origin source can be
// wired in one place. The `extensions_search` visibility filter protects read
// surfaces; this helper protects install/update/uninstall lifecycle surfaces
// whenever package resolution supplies origin metadata.
// A connector/workflow whose UI can only register at a static boot pass
// (bundled-react / declared cube contributions) raises a TYPED requires-rebuild
// error from its handler/saga. Surface it as a CLEAR result state (not a 500),
// mirroring the marketplace UI's requires-rebuild affordance. Both
// `ConnectorRequiresRebuildError` and `WorkflowInstallRequiresRebuildError`
// carry `code === "REQUIRES_REBUILD"`. Returns null for any other error (the
// caller re-throws).
function surfaceRequiresRebuild(
  err: unknown,
  input: { packageName: string; packageVersion: string },
): { success: false; requiresRebuild: true; packageName: string; packageVersion: string; message: string } | null {
  const code = (err as { code?: unknown } | null)?.code;
  if (code !== "REQUIRES_REBUILD") return null;
  return {
    success: false,
    requiresRebuild: true,
    packageName: input.packageName,
    packageVersion: input.packageVersion,
    message: err instanceof Error ? err.message : String(err),
  };
}

function enforceVisibility(
  resolution: LifecycleResolution,
  packageName: string,
): void {
  // This branch only enforces privacy when origin metadata is available from
  // package resolution; the structure keeps the fix localized.
  if (resolution.origin?.visibility !== "private") return;
  const identity = readInstanceIdentity();
  const vendorScope = getEffectiveViewerScope(identity);
  if (!vendorScope || resolution.origin.scope !== vendorScope) {
    throw new Error(
      `Package ${packageName} is private and not accessible from this instance.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Pure handler functions for extensions MCP tools.
// Each handler receives validated input and an actor already constructed by
// the registry layer (packages/extensions/src/mcp/registry.ts).
// ---------------------------------------------------------------------------

export function createExtensionsPrimitiveHandlers() {
  return {
    async extensions_search(input: {
      query?: string;
      limit?: number;
    }) {
      // Config injection plus server-side visibility filtering.
      // loadDeploymentRegistryConfig may throw if routingMode missing — let it propagate.
      const deployConfig = loadDeploymentRegistryConfig();
      const identity = readInstanceIdentity();
      const vendorScope = getEffectiveViewerScope(identity);

      // Kind-agnostic search with NO scope pre-prune (the prior default
      // `[instance, "@anthropics"]` would hide every public package from
      // every other vendor, defeating cross-vendor browsing). Visibility
      // is decided INSIDE listExtensionPackages via `viewerScope` so
      // `limit` slices AFTER filtering — otherwise the first N foreign-
      // private packages could fill the result and hide visible ones.
      const packages = await listExtensionPackages({
        query: input.query,
        limit: input.limit ?? 20,
        allowedScopes: undefined,
        viewerScope: vendorScope,
      }, {
        registryUrl: deployConfig.publicRegistryUrl,
        packageScope: vendorScope ?? "@cinatra-ai",
        // gatekept-install-allow-direct-registry: search/browse (catalog listing) path, not install/detail — gatekeeping install does not change browse read auth.
        token: deployConfig.publicReadToken,
        uiUrl: deployConfig.publicRegistryUrl,
      });

      return { packages };
    },

    async extensions_install(
      input: { packageName: string; packageVersion: string },
      actor: Actor,
    ) {
      // Kind-agnostic resolution plus uniform visibility checking.
      const resolution = await resolveExtensionPackageForLifecycle(
        input.packageName,
        input.packageVersion,
      );
      enforceVisibility(resolution, input.packageName);
      const typeId = resolution.typeId;
      // Dispatch + record the EXACT resolved version, not the raw input. The
      // authorize/resolution step already pins a concrete version: gatekept ON
      // → the exact authorized storefront version; OFF → the legacy packument
      // resolution (an exact version even when input was "latest"). Recording
      // the raw input would persist a moving tag ("latest") that drifts from
      // what was actually authorized/fetched. Fall back to the raw input only
      // if resolution did not yield a concrete version (defensive — keeps the
      // flag-OFF path non-breaking when a packument has no versions).
      const dispatchVersion = resolution.resolvedVersion ?? input.packageVersion;
      try {
        await extensionRegistry.install(
          typeId,
          {
            registryUrl: "",
            packageName: input.packageName,
            version: dispatchVersion,
          },
          actor,
        );
      } catch (err) {
        // Connector model-B / hot-install: a `requires-rebuild` failure is
        // a structured, non-fatal install outcome (the package activated but its UI
        // needs a host rebuild) — surface it to the caller instead of throwing.
        const surfaced = surfaceRequiresRebuild(err, input);
        if (surfaced) return surfaced;
        throw err;
      }
      return {
        success: true,
        packageName: input.packageName,
        packageVersion: dispatchVersion,
      };
    },

    async extensions_update(
      input: { packageName: string; packageVersion: string },
      actor: Actor,
    ) {
      // Kind-agnostic resolution plus uniform visibility checking.
      const resolution = await resolveExtensionPackageForLifecycle(
        input.packageName,
        input.packageVersion,
      );
      enforceVisibility(resolution, input.packageName);
      const typeId = resolution.typeId;
      // Dispatch + record the EXACT resolved version (see extensions_install).
      const dispatchVersion = resolution.resolvedVersion ?? input.packageVersion;
      try {
        await extensionRegistry.update(
          typeId,
          {
            registryUrl: "",
            packageName: input.packageName,
            version: dispatchVersion,
          },
          actor,
        );
      } catch (err) {
        // Connector model-B / hot-update: surface a `requires-rebuild`
        // outcome instead of throwing (see extensions_install).
        const surfaced = surfaceRequiresRebuild(err, input);
        if (surfaced) return surfaced;
        throw err;
      }
      return {
        success: true,
        packageName: input.packageName,
        packageVersion: dispatchVersion,
      };
    },

    async extensions_uninstall(
      input: { packageName: string; packageVersion: string },
      actor: Actor,
    ) {
      // Kind-agnostic resolution plus uniform visibility checking.
      const resolution = await resolveExtensionPackageForLifecycle(
        input.packageName,
        input.packageVersion,
      );
      enforceVisibility(resolution, input.packageName);
      const typeId = resolution.typeId;
      await extensionRegistry.uninstall(
        typeId,
        {
          registryUrl: "",
          packageName: input.packageName,
          version: input.packageVersion,
        },
        actor,
      );
      return {
        success: true,
        packageName: input.packageName,
      };
    },

    // -----------------------------------------------------------------------
    // Lifecycle management handlers
    // -----------------------------------------------------------------------

    async extensions_archive(
      input: { packageName: string; packageVersion: string },
      actor: Actor,
    ) {
      // Kind-agnostic resolution plus uniform visibility checking.
      const resolution = await resolveExtensionPackageForLifecycle(
        input.packageName,
        input.packageVersion,
      );
      enforceVisibility(resolution, input.packageName);
      const typeId = resolution.typeId;
      await extensionRegistry.archive(
        typeId,
        {
          registryUrl: "",
          packageName: input.packageName,
          version: input.packageVersion,
        },
        actor,
      );
      return { success: true, packageName: input.packageName };
    },

    async extensions_restore(
      input: { packageName: string },
      actor: Actor,
    ) {
      // Kind-agnostic resolution plus uniform visibility checking.
      // (restore takes no packageVersion — operates on whatever is installed.)
      const resolution = await resolveExtensionPackageForLifecycle(
        input.packageName,
      );
      enforceVisibility(resolution, input.packageName);
      const typeId = resolution.typeId;
      await extensionRegistry.restore(
        typeId,
        { registryUrl: "", packageName: input.packageName },
        actor,
      );
      return { success: true, packageName: input.packageName };
    },

    async extensions_force_delete(
      input: { packageName: string; packageVersion: string; reason?: string; confirmDestructive: true },
      actor: Actor,
    ) {
      // Defense-in-depth. The zod schema enforces
      // confirmDestructive: literal(true) at the registry layer, but a
      // direct caller of createExtensionsPrimitiveHandlers() (a unit test,
      // a server-side helper that bypasses registerTool) would silently
      // drop the guard. Restate the invariant here so the destructive
      // op is gated regardless of the call path.
      if (input.confirmDestructive !== true) {
        throw new Error(
          "extensions_force_delete requires confirmDestructive=true",
        );
      }
      // Kind-agnostic resolution plus uniform visibility checking.
      const resolution = await resolveExtensionPackageForLifecycle(
        input.packageName,
        input.packageVersion,
      );
      enforceVisibility(resolution, input.packageName);
      const typeId = resolution.typeId;
      const result = await extensionRegistry.forceDelete(
        typeId,
        {
          registryUrl: "",
          packageName: input.packageName,
          version: input.packageVersion,
        },
        actor,
        input.reason,
      );
      return {
        success: true,
        packageName: input.packageName,
        danglingReferences: result.danglingReferences,
      };
    },

    // DRY-RUN ONLY. Returns the full purge blast radius + a
    // `digest` carried to the destructive path: either the
    // `extensions_purge_execute` MCP tool or the human-origin
    // `cinatra extensions purge` CLI → /api/extensions/purge. This handler
    // NEVER calls purgeExtension(); it cannot destroy anything.
    async extensions_purge(input: { packageName: string }, _actor: Actor) {
      const { planExtensionPurge } = await import("../purge");
      const { defaultPurgeDeps } = await import("../purge-deps");
      const plan = await planExtensionPurge(
        { packageName: input.packageName },
        await defaultPurgeDeps(),
      );
      return {
        dryRun: true,
        ...plan,
        executeWith: plan.blocked
          ? null
          : {
              tool: "extensions_purge_execute",
              args: {
                packageName: input.packageName,
                expectedDigest: plan.digest,
                confirmDestructive: true,
              },
              cli: `cinatra extensions purge ${input.packageName} --confirm ${input.packageName} --digest ${plan.digest} --yes`,
            },
      };
    },

    // DESTRUCTIVE. Admin-gated (MUTATING_TOOLS) and MCP-invocable. Runs the
    // full fail-closed purge saga; all safeguards live inside purgeExtension.
    async extensions_purge_execute(
      input: {
        packageName: string;
        expectedDigest: string;
        confirmDestructive: true;
        reason?: string;
      },
      actor: Actor,
    ) {
      if (input.confirmDestructive !== true) {
        return {
          error: "extensions_purge_execute requires confirmDestructive=true",
        };
      }
      const { purgeExtension, ExtensionPurgeRefused } = await import(
        "../purge"
      );
      const { defaultPurgeDeps } = await import("../purge-deps");
      try {
        const result = await purgeExtension(
          {
            packageName: input.packageName,
            expectedDigest: input.expectedDigest,
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
            actor,
          },
          await defaultPurgeDeps(),
        );
        return { success: true, ...result };
      } catch (error) {
        if (error instanceof ExtensionPurgeRefused) {
          return { refused: true, error: error.message };
        }
        return {
          error: error instanceof Error ? error.message : "Purge failed.",
        };
      }
    },

    // Registry-only single-version ops. Kind-agnostic: pure Verdaccio
    // package-name+version operations, NO extensionRegistry / deriveTypeId /
    // DB / disk. Admin-gated (MUTATING_TOOLS). Both operations write a durable
    // extension_lifecycle_audit row BEFORE the mutation; audit-write failure
    // aborts so registry changes are never silent. The irreversible hard
    // delete additionally quarantines the target version's tarball first as a
    // recovery hedge and requires confirmDestructive:true.
    async extensions_registry_unpublish(
      input: { packageName: string; packageVersion: string; message?: string },
      actor: Actor,
    ) {
      // Locked canonical rows reject registry
      // removal (registry_remove ∈ LOCKED_REJECTED_OPS). Fail-closed for
      // system extensions even if the canonical store is unreachable.
      const { assertNoLockedCanonicalRow } = await import("../index");
      await assertNoLockedCanonicalRow(input.packageName, "registry_remove");
      const { loadVerdaccioConfigForServer } = await import(
        "@/lib/verdaccio-config"
      );
      const { deprecateAgentPackageVersion } = await import(
        "@cinatra-ai/agents/verdaccio/client"
      );
      const { computeDanglingReferences, writeExtensionLifecycleAuditEntry } =
        await import("../audit-log");
      const config = await loadVerdaccioConfigForServer();
      const ref = {
        registryUrl: config.registryUrl,
        packageName: input.packageName,
        version: input.packageVersion,
      };
      // Audit BEFORE mutation — write failure aborts (let it throw).
      await writeExtensionLifecycleAuditEntry({
        actor,
        operation: "registry_unpublish",
        packageRef: ref,
        destroyedRowSnapshot: null,
        danglingReferences: await computeDanglingReferences(ref),
        ...(input.message !== undefined ? { reason: input.message } : {}),
      });
      await deprecateAgentPackageVersion(
        {
          packageName: input.packageName,
          packageVersion: input.packageVersion,
          ...(input.message !== undefined ? { message: input.message } : {}),
        },
        config,
      );
      return {
        packageName: input.packageName,
        packageVersion: input.packageVersion,
        deprecated: true,
      };
    },

    async extensions_registry_delete(
      input: {
        packageName: string;
        packageVersion: string;
        confirmDestructive: true;
      },
      actor: Actor,
    ) {
      // Defense-in-depth: the zod schema enforces confirmDestructive:true at
      // the registry layer; restate here for direct callers.
      if (input.confirmDestructive !== true) {
        return {
          error: "extensions_registry_delete requires confirmDestructive=true",
        };
      }
      // Locked canonical rows reject registry
      // delete (registry_remove ∈ LOCKED_REJECTED_OPS).
      const { assertNoLockedCanonicalRow } = await import("../index");
      await assertNoLockedCanonicalRow(input.packageName, "registry_remove");
      const { loadVerdaccioConfigForServer } = await import(
        "@/lib/verdaccio-config"
      );
      const { deleteAgentPackageVersion, downloadAgentPackageTarball } =
        await import("@cinatra-ai/agents/verdaccio/client");
      const { computeDanglingReferences, writeExtensionLifecycleAuditEntry } =
        await import("../audit-log");
      const { quarantineExtensionBeforePurge } = await import("../quarantine");
      const config = await loadVerdaccioConfigForServer();
      const ref = {
        registryUrl: config.registryUrl,
        packageName: input.packageName,
        version: input.packageVersion,
      };
      // Recovery hedge BEFORE the irreversible delete: snapshot the target
      // version's tarball. Fail closed if it can't be quarantined.
      const q = await quarantineExtensionBeforePurge({
        packageName: input.packageName,
        versions: [input.packageVersion],
        distTags: {},
        templateSnapshot: null,
        downloadTarball: (version, destPath) =>
          downloadAgentPackageTarball(
            { packageName: input.packageName, packageVersion: version, destPath },
            config,
          ),
      });
      if (q.missingTarballs.length > 0) {
        return {
          error: `extensions_registry_delete refused: could not quarantine version ${input.packageVersion} of ${input.packageName} (no recovery snapshot). Quarantine dir: ${q.quarantineDir}`,
        };
      }
      // Audit BEFORE mutation.
      await writeExtensionLifecycleAuditEntry({
        actor,
        operation: "registry_delete",
        packageRef: ref,
        destroyedRowSnapshot: null,
        danglingReferences: await computeDanglingReferences(ref),
      });
      try {
        const result = await deleteAgentPackageVersion(
          {
            packageName: input.packageName,
            packageVersion: input.packageVersion,
          },
          config,
        );
        return {
          packageName: input.packageName,
          packageVersion: input.packageVersion,
          deleted: result.deleted,
          notFound: result.notFound,
          quarantineDir: q.quarantineDir,
        };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : "Delete failed.",
          quarantineDir: q.quarantineDir,
        };
      }
    },
  };
}
