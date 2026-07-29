import "server-only";
import type {
  ExtensionTypeHandler,
  PackageRef,
  Actor,
  ExtensionDiscoveryScope,
  ActiveExtensionManifest,
} from "@cinatra-ai/extension-types";
import { visibleManifestPackageNames } from "@cinatra-ai/extension-types";
import { installSkillPackageFromGitHub } from "./github";
import { installSkillPackageFromVerdaccio } from "./verdaccio";
import { uninstallSkillPackage } from "./skills-store";
// Explicit catalog rebuild at skill-extension lifecycle points (cinatra#1364).
import { rebuildSkillsCatalog } from "./skill-packages";
import { resolveSkillPackageSource } from "./skill-package-source";
import { listInstalledSkills, type SkillManifest } from "./skills-registry";
import { matchAgentsToSkills } from "@/lib/agents-store";

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

/**
 * Two-stage facet filter shared by listActive/listArchived: intersect the skill
 * catalog against the owner-visible lifecycle-live package set (the shared
 * manifest gate), then apply the per-row skill-visibility predicate.
 *
 * ADMIN STANDING (P3): the shared manifest gate (`manifestVisibleToScope`, via
 * `visibleManifestPackageNames`) now admits a platform_admin to every package
 * and an org admin to their org's packages, and `skillVisibleToScope`
 * short-circuits `true` for a platform_admin — so PLATFORM-admin skills-catalog
 * parity is delivered here. The ORG-admin skills carve-out (surfacing another
 * user's personal/team/project skill row to an org admin) is DEFERRED: unlike
 * the connector/artifact facets, whose native catalogs are deployment-shipped
 * capability descriptors, the skill catalog holds per-owner PRIVATE rows joined
 * to manifests only by package name, and a skill row carries no owning-org
 * anchor. Bypassing the per-row owner check for an org admin on a package-name
 * match would risk a cross-org leak when two orgs author a private skill under a
 * colliding package name — so it must wait on a per-skill org anchor (tracked
 * with the write-surface skills carve-out). Until then the per-row predicate
 * stays authoritative for org admins, matching the P2 "no clean org anchor yet"
 * decision. No member-facing change.
 */
function filterSkillsForScope(
  skills: SkillManifest[],
  manifests: ActiveExtensionManifest[],
  scope: ExtensionDiscoveryScope,
): SkillManifest[] {
  const live = visibleManifestPackageNames(manifests, scope);
  return skills.filter(
    (skill) =>
      skill.packageName != null &&
      live.has(skill.packageName) &&
      skillVisibleToScope(skill, scope),
  );
}

// See ./skill-package-source.ts for the pure-function dispatcher + the
// persisted-id shape contract. This module wires it into the
// ExtensionTypeHandler lifecycle
// methods (install / update / uninstall / archive / restore), each of which
// dispatches on the resolved kind.

export function createSkillExtensionHandler(): ExtensionTypeHandler {
  return {
    typeId: "skill",

    async install(ref: PackageRef, actor: Actor): Promise<void> {
      const source = resolveSkillPackageSource(ref);
      if (source.kind === "github") {
        await installSkillPackageFromGitHub(ref.packageName);
      } else {
        // cinatra#793: the verdaccio installer consumes the FINALIZED unified-
        // store payload the dispatcher's pipeline just materialized — resolved
        // at the SAME org scope the dispatcher ensured the canonical row at.
        await installSkillPackageFromVerdaccio({
          packageName: ref.packageName,
          packageVersion: ref.version,
          orgId: actor.orgId ?? null,
        });
      }
      // Explicit lifecycle rebuild (cinatra#1364) BEFORE matching, so matching
      // evaluates the just-installed package's merged catalog rows.
      await rebuildSkillsCatalog({ reason: "skill-extension-install" });
      await matchAgentsToSkills();
    },

    async update(ref: PackageRef, actor: Actor): Promise<void> {
      // upsert semantics — same as install per source kind.
      const source = resolveSkillPackageSource(ref);
      if (source.kind === "github") {
        await installSkillPackageFromGitHub(ref.packageName);
      } else {
        await installSkillPackageFromVerdaccio({
          packageName: ref.packageName,
          packageVersion: ref.version,
          orgId: actor.orgId ?? null,
        });
      }
      await rebuildSkillsCatalog({ reason: "skill-extension-update" });
      await matchAgentsToSkills();
    },

    async uninstall(ref: PackageRef, _actor: Actor): Promise<void> {
      const source = resolveSkillPackageSource(ref);
      await uninstallSkillPackage(source.packageId);
      // Explicit lifecycle rebuild (cinatra#1364): reconcile the catalog after
      // the uninstall's disk + row removal. The Matches tab / registry read the
      // canonical `skill_matches` projection through `readAgentSkillMatches()`,
      // whose defensive filter drops rows for skills no longer in the rebuilt
      // catalog — so the uninstalled package's matches disappear with no extra
      // match-store reconcile pass here.
      // cinatra#2092 (S5): an uninstall REVOKES the package identity's upload
      // consent BEFORE the rebuild. Two reasons: the rebuild's projection then
      // sees no grant (so nothing can transiently re-qualify), and a later
      // re-install of the same package must ask for consent again instead of
      // silently inheriting the old grant. The rebuild's catalog transaction
      // schedules the delayed GC row at grace-window expiry, so the remote
      // copies are reclaimed with no manual step. Never fatal — the uninstall
      // itself must complete.
      try {
        const { revokeSkillPackageUploadConsent } = await import(
          "@/lib/anthropic-skill-config-service"
        );
        revokeSkillPackageUploadConsent({
          packageId: source.packageId,
          revokedBy: null,
        });
      } catch (err) {
        console.warn(
          "[skills/extension-handler] upload-consent revoke on uninstall failed:",
          err instanceof Error ? err.message : err,
        );
      }
      await rebuildSkillsCatalog({ reason: "skill-extension-uninstall" });
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
      const skills = await listInstalledSkills();
      return filterSkillsForScope(skills, manifests, scope);
    },

    // Archived twin of listActive (cinatra#948). The catalog RETAINS rows for
    // archived packages (archive is a canonical-lifecycle transition; the
    // per-kind archive() hook is a no-op), so the exact same two-stage
    // visibility applies: shared owner-scope manifest gate ∩ the per-row skill
    // visibility predicate — an archived scoped skill never leaks outside its
    // owning scope.
    async listArchived({ scope, manifests }) {
      const skills = await listInstalledSkills();
      return filterSkillsForScope(skills, manifests, scope);
    },
  };
}
