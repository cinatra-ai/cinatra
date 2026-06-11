import "server-only";

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  installAgentPackageWithDependencies,
  extractAgentPackage,
  cleanupExtractedAgentPackage,
  deleteAgentTemplate,
  readAgentTemplateByPackageName,
  updateAgentTemplate,
  readActiveExtensionTemplates,
} from "@cinatra-ai/agents";
import {
  upsertSkill,
  parseFrontmatter,
  deleteAgentSkillsForSlugs,
  // Agent install/update/uninstall hooks keep skill matches in sync.
  enqueueInlineForAgent,
  cleanupForAgent,
} from "@cinatra-ai/skills";
import {
  FIRST_PARTY_PACKAGE_SCOPE,
  InstanceNamespaceNotConfiguredError,
  vendorScopeOfPackage,
  type VerdaccioConfig,
} from "@cinatra-ai/registries";
import type { ExtensionTypeHandler, PackageRef, Actor } from "@cinatra-ai/extension-types";
// resolveInstallEnvironment routes to the correct registry based on extension origin.
import { resolveInstallEnvironment } from "@cinatra-ai/extensions/destination-resolver";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Inline slugify — mirrors the same function in packages/agent-builder/src/mcp/handlers.ts
// and packages/skills/src/skills-store.ts so slug shapes stay consistent.
function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Extract the root package, scan skills from tempDir/skills/ directory, and
 * upsert each into the skills catalog. Calls cleanupExtractedAgentPackage in
 * a finally block so the tempDir is always removed.
 *
 * Throws on upsertSkill failure — the caller (installAndRegisterSkills) is
 * responsible for the compensating rollback.
 *
 * NOTE: extractAgentPackage re-fetches from Verdaccio (or pacote cache); we
 * must re-extract because installAgentPackageWithDependencies already cleaned
 * up its own tempDir before returning.
 */
async function registerSkillsFromPackage(
  packageName: string,
  version: string | undefined,
  config: VerdaccioConfig,
): Promise<void> {
  // Hoist `extracted` so the outer try/finally cleans up
  // any partial tempDir even if extractAgentPackage throws midway through
  // extraction (disk full, tarball corruption). Today the registries
  // package handles its own cleanup-on-throw, but this is a defense-in-depth
  // boundary — any tempDir we know about gets reaped here.
  let extracted: Awaited<ReturnType<typeof extractAgentPackage>> | null = null;
  try {
    extracted = await extractAgentPackage(
      {
        packageName,
        packageVersion: version,
      },
      config,
    );

    // Guard: if extraction returned nothing (e.g. package has no tarball yet),
    // skip skill registration rather than crashing.
    if (!extracted) return;

    const skillsDir = join(extracted.tempDir, "skills");
    let entries: { isDirectory(): boolean; name: string }[] = [];
    try {
      entries = await readdir(skillsDir, { withFileTypes: true, encoding: "utf8" }) as unknown as { isDirectory(): boolean; name: string }[];
    } catch {
      // No skills/ directory — nothing to register.
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillMdPath = join(skillsDir, entry.name, "SKILL.md");
      let content: string;
      try {
        content = await readFile(skillMdPath, { encoding: "utf8" });
      } catch {
        continue; // No SKILL.md — skip this entry.
      }
      const { attributes } = parseFrontmatter(content);
      const attrs = attributes as Record<string, string>;
      await upsertSkill({
        type: "agent",
        packageName,
        agentId: packageName,
        name: attrs.name ?? entry.name,
        description: attrs.description ?? "",
        content,
        skillId: `custom:${slugify(packageName)}:${entry.name}`,
        prefillText: "-",
      });
    }
  } finally {
    if (extracted?.tempDir) {
      await cleanupExtractedAgentPackage(extracted.tempDir);
    }
  }
}

/**
 * Install the full dep tree, then register skills for the root package.
 * On skill-registration failure, compensate by deleting the root template
 * (dep templates may be pre-existing upserts from prior installs — deleting
 * them would destroy unrelated installs).
 *
 * PluginDependencyCycleError from installAgentPackageWithDependencies
 * propagates without any rollback — no template was created.
 */
async function installAndRegisterSkills(ref: PackageRef, status?: "draft" | "published" | "active"): Promise<{ rootTemplateId: string; installedTemplateIds: string[]; wayflowReload?: import("./wayflow-reload-client").ReloadResult }> {
  // Hold the per-package install lock
  // across the entire flow (install + skill registration + compensation) so
  // a concurrent install can't commit a newer state in the window between
  // installAgentPackageWithDependencies's commit and the compensation's
  // delete-template / delete-disk-dir / reload steps. The lock is re-entrant
  // (AsyncLocalStorage), so installAgentPackageWithDependencies's nested
  // withInstallLock call is a no-op and doesn't deadlock.
  const { withInstallLock } = await import("./materialize-agent-package");
  return withInstallLock(ref.packageName, async () => {
  // Auth gate runs in the caller (extensions_install MCP handler or installRegistryPackage).
  // resolveInstallEnvironment reads extension origin to determine registry + topology.
  // The version is threaded so the gatekept-install path (when enabled) authorizes
  // the EXACT listed version; it is ignored on the legacy path. The resolved config
  // (broker + grant when gatekept) is reused for BOTH the dependency install and the
  // skill-scan SECOND root fetch in registerSkillsFromPackage below.
  let config: VerdaccioConfig;
  try {
    const installEnv = await resolveInstallEnvironment(ref.packageName, ref.version);
    const authTokenArgExt = installEnv.args.find((a) => a.includes(":_authToken="));
    const extToken = authTokenArgExt ? authTokenArgExt.split(":_authToken=")[1] : null;
    // Explicit null guard so downstream registry
    // client never makes an unauthenticated request without a valid auth token.
    // routingMode is always "scope-based" | "shared-acl" (never "public") per
    // DeploymentRegistryConfig; throw unconditionally when token extraction fails.
    if (!extToken) {
      throw new Error(
        `[resolveInstallEnvironment] No _authToken arg found in install args for ${ref.packageName}`,
      );
    }
    // packageScope is keyed on the PACKAGE BEING INSTALLED, never on the
    // instance identity: the instance namespace is a publish-time concept, and
    // keying the install path on it broke first-party installs on any instance
    // whose namespace isn't "cinatra-ai" (issue #103). The dependency-scope
    // gate itself derives its allowlist from the root package name inside
    // installAgentPackageWithDependencies; this field is informational install
    // plumbing (registryUrl + token carry the actual routing/auth).
    config = {
      registryUrl: installEnv.registryUrl,
      packageScope: vendorScopeOfPackage(ref.packageName) ?? FIRST_PARTY_PACKAGE_SCOPE,
      token: extToken,
      uiUrl: installEnv.registryUrl,
    };
  } catch (e) {
    if (e instanceof InstanceNamespaceNotConfiguredError) {
      throw new Error(
        "Instance vendor name is not configured. Visit /setup/name to provision a registry identity before installing extensions.",
      );
    }
    throw e;
  }

  const result = await installAgentPackageWithDependencies(
    {
      packageName: ref.packageName,
      packageVersion: ref.version,
      status,
    },
    config,
  );

  try {
    await registerSkillsFromPackage(ref.packageName, ref.version, config);
  } catch (skillErr) {
    // Compensating rollback — root template + any partial-success skill rows
    // already upserted before the throw. Without the skill
    // cleanup, a multi-skill package that fails midway leaves orphan skill
    // rows in the catalog whose slug points at a template that was just
    // deleted. The next install attempt would self-heal (upsertSkill
    // refreshes in place), but in the interim the catalog is inconsistent.
    try {
      await deleteAgentTemplate(result.rootTemplateId);
    } catch (rollbackErr) {
      // Log rollback failure but rethrow the ORIGINAL skill error.
      // eslint-disable-next-line no-console
      console.error(
        "[agent-extension-handler] Rollback (deleteAgentTemplate) failed:",
        rollbackErr,
      );
    }
    try {
      await deleteAgentSkillsForSlugs([slugify(ref.packageName)]);
    } catch (skillRollbackErr) {
      // Same: log + rethrow the ORIGINAL skill error.
      // eslint-disable-next-line no-console
      console.error(
        "[agent-extension-handler] Rollback (deleteAgentSkillsForSlugs) failed:",
        skillRollbackErr,
      );
    }
    // installAgentPackageWithDependencies
    // already mounted the agent on the WayFlow runtime via its reload. We are
    // rolling back the DB + skills; ALSO delete the disk dir and trigger
    // another reload so WayFlow drops the now-orphan mount.
    try {
      const { rmDirForRolledBackInstall, triggerReloadAfterRollback } = await import(
        "./extension-handler-rollback"
      );
      await rmDirForRolledBackInstall(ref.packageName);
      await triggerReloadAfterRollback();
    } catch (diskRollbackErr) {
      // eslint-disable-next-line no-console
      console.error(
        "[agent-extension-handler] Rollback (disk + reload) failed:",
        diskRollbackErr,
      );
    }
    throw skillErr;
  }

  return {
    rootTemplateId: result.rootTemplateId,
    installedTemplateIds: result.installedTemplateIds,
    wayflowReload: result.wayflowReload,
  };
  });
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Returns an ExtensionTypeHandler for typeId "agent".
 *
 * Registered at bootstrap time via src/lib/extensions.ts:
 *   extensionRegistry.register(createAgentExtensionHandler());
 *
 * Install / update:
 *   1. Calls installAgentPackageWithDependencies — handles Verdaccio extraction,
 *      OAS compilation, DB sync, and recursive dep installs via @cinatra-ai/registries.
 *   2. Re-extracts the ROOT package to scan tempDir/skills/ for SKILL.md files.
 *   3. Calls upsertSkill for each skill found via parseFrontmatter.
 *   4. On skill-registration failure: compensating deleteAgentTemplate(rootTemplateId).
 *
 * Uninstall:
 *   1. Looks up agent_templates row by packageName; no-ops if absent.
 *   2. Deregisters skills via deleteAgentSkillsForSlugs (skills-first order).
 *   3. Hard-deletes the agent_templates row. agent_runs rows are left intact
 *      (orphaned runs preserve audit history).
 */
export function createAgentExtensionHandler(): ExtensionTypeHandler {
  return {
    typeId: "agent",

    async install(ref: PackageRef, _actor: Actor) {
      // Pass status:"active" so freshly installed extensions
      // appear in /agents/run (which filters by status IN ('active','published')).
      // installAgentPackageWithDependencies defaults to "draft", which would
      // exclude new installs from all readInstalledAgentTemplates queries.
      const result = await installAndRegisterSkills(ref, "active");
      // Queue an inline re-evaluation against this
      // newly-installed agent. Idempotent jobId via BullMQ pending-dedup
      // keeps repeated installs from duplicating work. Failures MUST NOT abort the install.
      try {
        await enqueueInlineForAgent(ref.packageName);
      } catch (err) {
        console.warn(
          `[agent-extension-handler] enqueueInlineForAgent failed for ${ref.packageName}:`,
          err instanceof Error ? err.message : err,
        );
      }
      return result as unknown as void;
    },

    async update(ref: PackageRef, _actor: Actor) {
      // installAgentPackageWithDependencies performs a true upsert — existing
      // template rows are updated in-place (preserving run history and trigger
      // config). Skill registration re-upserts with new-version content.
      const result = await installAndRegisterSkills(ref);
      // Re-evaluate the agent against current skills.
      try {
        await enqueueInlineForAgent(ref.packageName);
      } catch (err) {
        console.warn(
          `[agent-extension-handler] enqueueInlineForAgent failed for ${ref.packageName}:`,
          err instanceof Error ? err.message : err,
        );
      }
      return result as unknown as void;
    },

    async uninstall(ref: PackageRef, _actor: Actor): Promise<void> {
      // Serialize with any
      // concurrent install of the same package so we never race on the
      // disk dir. Re-entrant via AsyncLocalStorage; the extensions
      // forceDelete wrapper (which also calls this method) re-enters as
      // a no-op if it ever holds the lock externally.
      const { withInstallLock } = await import("./materialize-agent-package");
      await withInstallLock(ref.packageName, async () => {
        const existing = await readAgentTemplateByPackageName(ref.packageName);
        if (!existing) return;

        // Skills first — if template delete failed mid-flight, skills would
        // otherwise become orphans pointing at a missing agent.
        await deleteAgentSkillsForSlugs([slugify(ref.packageName)]);
        await deleteAgentTemplate(existing.id);

        // Purge skill_matches rows by agent
        // packageId. Failures MUST NOT raise (uninstall is best-effort here).
        try {
          await cleanupForAgent(ref.packageName);
        } catch (err) {
          console.warn(
            `[agent-extension-handler] cleanupForAgent failed for ${ref.packageName}:`,
            err instanceof Error ? err.message : err,
          );
        }

        // Delete the disk
        // directory + reload the WayFlow runtime so the orphan mount drops.
        // Without this, extensions_uninstall (and extensions_force_delete via
        // the registry forceDelete wrapper that calls this method) would
        // leave the agent files on disk; the runtime would keep serving the
        // deleted agent until the container restarted. Best-effort: failures
        // here log but don't raise — the DB delete already happened and is
        // the durable signal.
        try {
          const { rmDirForRolledBackInstall, triggerReloadAfterRollback } =
            await import("./extension-handler-rollback");
          await rmDirForRolledBackInstall(ref.packageName);
          await triggerReloadAfterRollback();
        } catch (diskCleanupErr) {
          console.warn(
            `[agent-extension-handler] disk cleanup + reload failed for ${ref.packageName}:`,
            diskCleanupErr instanceof Error
              ? diskCleanupErr.message
              : diskCleanupErr,
          );
        }
      });
    },

    // The canonical archive/restore write is owned by the dispatcher
    // (extensionRegistry.archive/restore → syncCanonicalManifestTransition,
    // the sole canonical writer). These handler methods do not flip a
    // column; they are kept as guarded no-ops so the dispatcher's per-kind
    // dispatch contract (handler.archive/restore exists for every typeId)
    // stays satisfied. There is no agent-specific archive side-effect beyond
    // the manifest state, so the body is intentionally empty.
    async archive(_ref: PackageRef, _actor: Actor): Promise<void> {
      // no-op — canonical archive owned by the dispatcher
    },

    async restore(_ref: PackageRef, _actor: Actor): Promise<void> {
      // no-op — canonical restore owned by the dispatcher
    },

    // Reader facet (true-IoC). The agent native store is the VISIBILITY
    // authority; the dispatcher's `manifests` are only a coarse lifecycle-live
    // candidate set. So we:
    //   1) ask the visibility-correct agent reader for the templates this actor
    //      may see (origin visibility + the actor's vendor scope + the
    //      exact-identity-wins-then-platform-fallback effective-status rule), then
    //   2) keep only those whose package is lifecycle-live per `manifests`.
    // This fixes BOTH over-exposure (we never read another owner's row by package
    // name) and under-exposure (private/vendor rows are included via the scope).
    async listActive({ scope, manifests }) {
      const livePackageNames = new Set(manifests.map((m) => m.packageName));
      const visibleActive = await readActiveExtensionTemplates(scope.vendorScope ?? undefined);
      return visibleActive.filter(
        (template) => template.packageName != null && livePackageNames.has(template.packageName),
      );
    },
  };
}
