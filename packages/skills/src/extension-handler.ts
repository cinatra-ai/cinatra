import "server-only";
import type {
  ExtensionTypeHandler,
  PackageRef,
  Actor,
  ExtensionDiscoveryScope,
} from "@cinatra-ai/extension-types";
import { visibleManifestPackageNames } from "@cinatra-ai/extension-types";
import { installSkillPackageFromGitHub } from "./github";
import { installSkillPackageFromVerdaccio } from "./verdaccio";
import { uninstallSkillPackage } from "./skills-store";
import { resolveSkillPackageSource } from "./skill-package-source";
import { listInstalledSkills, type SkillManifest } from "./skills-registry";
import {
  matchAgentsToSkills,
  readAgentSkillMatches,
  saveAgentSkillMatches,
} from "@/lib/agents-store";

// Row-level visibility for a single skill descriptor against the actor's
// resolved discovery scope. This is the per-row authority the reader facet
// applies on top of the coarse lifecycle-live manifest gate: the manifest gate
// only answers "is this package live?", never "may this actor see this row?".
//
// Levels mirror the canonical read-time skill semantics enforced everywhere
// skill rows are surfaced (see llm-matching/visibility.ts):
//   - workspace     -> every authenticated workspace user (scope.userId != null)
//   - personal      -> owning user only
//   - team          -> the owning team must be in the actor's teams
//   - organization  -> the actor's active org must match the owner
//   - project       -> the owning project must be in the actor's projects
//   - system        -> platform admins only
//   - agent / third-party / no level -> bundled-with-package rows whose
//     visibility is fully decided by the lifecycle-live manifest gate (their
//     package being live is the access decision); pass through here.
// Anything else fails closed (not visible).
function skillVisibleToScope(
  skill: SkillManifest,
  scope: ExtensionDiscoveryScope,
): boolean {
  if (scope.platformRole === "platform_admin") return true;

  const level = skill.level;
  const owner = skill.scope ?? "";

  switch (level) {
    case "workspace":
      // A workspace principal needs BOTH an authenticated user AND an active
      // org context (parity with the canonical skill/workspace access predicate
      // in packages/agents/src/auth-policy.ts). An org-less session must never
      // see workspace skill rows through discovery.
      return scope.userId != null && scope.organizationId != null;
    case "personal":
      return owner !== "" && scope.userId != null && owner === scope.userId;
    case "team":
      return owner !== "" && scope.teamIds.includes(owner);
    case "organization":
      return (
        owner !== "" &&
        scope.organizationId != null &&
        owner === scope.organizationId
      );
    case "project":
      return owner !== "" && (scope.projectIds ?? []).includes(owner);
    case "system":
      // System-level skills are admin-visibility-gated; non-admins handled by
      // the platform_admin short-circuit above.
      return false;
    case "agent":
    case undefined:
      // Visibility is decided by the lifecycle-live manifest gate: the package
      // being installed/active IS the access decision for these rows.
      return true;
    default:
      // Unknown level -> fail closed.
      return false;
  }
}

// See ./skill-package-source.ts for the pure-function dispatcher + the
// persisted-id shape contract. This module wires it into the
// ExtensionTypeHandler lifecycle
// methods (install / update / uninstall / archive / restore), each of which
// dispatches on the resolved kind.

export function createSkillExtensionHandler(): ExtensionTypeHandler {
  return {
    typeId: "skill",

    async install(ref: PackageRef, _actor: Actor): Promise<void> {
      const source = resolveSkillPackageSource(ref);
      if (source.kind === "github") {
        await installSkillPackageFromGitHub(ref.packageName);
      } else {
        await installSkillPackageFromVerdaccio({
          packageName: ref.packageName,
          packageVersion: ref.version,
        });
      }
      await matchAgentsToSkills();
    },

    async update(ref: PackageRef, _actor: Actor): Promise<void> {
      // upsert semantics — same as install per source kind.
      const source = resolveSkillPackageSource(ref);
      if (source.kind === "github") {
        await installSkillPackageFromGitHub(ref.packageName);
      } else {
        await installSkillPackageFromVerdaccio({
          packageName: ref.packageName,
          packageVersion: ref.version,
        });
      }
      await matchAgentsToSkills();
    },

    async uninstall(ref: PackageRef, _actor: Actor): Promise<void> {
      const source = resolveSkillPackageSource(ref);
      await uninstallSkillPackage(source.packageId);
      const { matches } = await readAgentSkillMatches();
      // trailing colon prevents partial-name collision (e.g. github:owner/repo vs github:owner/repo-fork)
      const filtered = matches.filter(
        (m) => !m.skillId.startsWith(`${source.packageId}:`)
      );
      await saveAgentSkillMatches(filtered);
    },

    // The per-kind skill_packages.extension_lifecycle_status column is dropped;
    // canonical archive/restore is owned by the dispatcher
    // (syncCanonicalManifestTransition). archive is a no-op because the status
    // flip was the only side-effect. restore still re-runs matching so agents
    // pick the skill back up once the canonical row returns to active.
    async archive(_ref: PackageRef, _actor: Actor): Promise<void> {
      // no-op — canonical archive owned by the dispatcher
    },

    async restore(_ref: PackageRef, _actor: Actor): Promise<void> {
      // Re-run matching now that the package is active again so agents pick it up.
      await matchAgentsToSkills();
    },

    // Reader facet (true-IoC). The skills catalog is the VISIBILITY authority;
    // the dispatcher's `manifests` are only a coarse lifecycle-live candidate
    // set. So we:
    //   1) intersect the catalog against the package names that are BOTH
    //      lifecycle-live AND owner-visible (the shared manifest gate), then
    //   2) apply the per-row skill visibility predicate so a scoped skill never
    //      leaks to an actor outside its owning scope.
    // This fixes BOTH over-exposure (we never surface another owner's row just
    // because its package name is live somewhere) and under-exposure (private /
    // scoped rows are included when the actor's scope permits).
    async listActive({ scope, manifests }) {
      const live = visibleManifestPackageNames(manifests, scope);
      const skills = await listInstalledSkills();
      return skills
        .filter((s) => s.packageName != null && live.has(s.packageName))
        .filter((s) => skillVisibleToScope(s, scope));
    },
  };
}
