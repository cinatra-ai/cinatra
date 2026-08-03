import "server-only";

// ---------------------------------------------------------------------------
// LIFECYCLE TEARDOWN for direct agent<->skill assignment (cinatra#2350 S5,
// epic #2345).
//
// S1 gave the platform somewhere to remember an assignment; this module is
// where that memory gets ERASED when either side of the pair goes away. Two
// directions, both firing BEFORE their caller's early return — not merely
// before the heavier cleanup that follows it:
//
//   1. SKILL-package uninstall (`skills-store.ts:uninstallSkillPackage`)
//      sweeps every `agent_assigned_skills` row keyed on this package's EXACT
//      DERIVED catalog ids — via the SAME `deriveSkillRegistration`
//      derivation the S1 predicate's `buildSkillIdOwnership` uses, so the
//      virtual `@cinatra-ai/chat` namespace (the five chat successor
//      packages) is swept correctly. A virtual-namespace registration may
//      have NO native `skillPackages` catalog row at all, so this sweep is
//      driven off the REAL npm package name — recovered from the catalog
//      packageId per `skill-package-source.ts`'s own invertible
//      `verdaccio:<name>` / `github:<name>` contract — never off a native
//      catalog lookup that could legitimately come back empty.
//   2. AGENT-package uninstall (`extension-handler.ts` in `@cinatra-ai/agents`)
//      deletes every row keyed on the agent's canonical package name. Thin
//      re-export of the S1 store primitive so `@cinatra-ai/agents` — which
//      must not reach into the host app's `@/lib/**` graph directly — can
//      call it through `@cinatra-ai/skills`, a dependency it already has.
//
// LOCK ORDERING: both directions run under the SAME per-extension lifecycle
// lock the S1 assign flow acquires (`withInstallLock`), never a new one:
//   - the skill-side sweep runs inside `extensionRegistry.uninstall`'s call
//     chain, which already holds `withInstallLock(ref.packageName)` before
//     `handler.uninstall` (this sweep's caller) ever runs
//     (`packages/extensions/src/index.ts`);
//   - the agent-side delete is placed FIRST inside the `withInstallLock`
//     callback in `packages/agents/src/extension-handler.ts`'s own
//     `uninstall`.
// Either way, a concurrent assign (S1's `assignAgentSkill`, which acquires
// the OWNING skill package's lifecycle lock before inserting) either
// completes entirely before this teardown runs, or acquires the lock after
// and finds the skill/agent already gone — never both, and never a row
// landing after cleanup has swept past it.
//
// Both directions are DELIBERATELY NOT wrapped in a try/catch that swallows
// the failure: the co-owner cleanup earlier in `uninstallSkillPackage`
// (cinatra#2346/#300) is the precedent — if this cleanup fails, the whole
// uninstall must roll back rather than silently leave an orphan assignment
// that could re-apply on a later reinstall of the same package/agent.
// ---------------------------------------------------------------------------

import type { SkillExtensionDescriptor, SkillRegistration } from "./extension-skill-resolver";

export type SkillPackageTeardownDeps = {
  /** Default = the real filesystem scan (`./extension-skill-resolver`). */
  scanExtensions?: () => Promise<SkillExtensionDescriptor[]>;
  /** Default = the real derivation (`./extension-skill-resolver`). */
  deriveSkillRegistration?: (
    pkgName: string,
    pkgDirName: string,
    slug: string,
  ) => SkillRegistration;
  /** Default = the real store delete (`@/lib/agent-assigned-skills-store`). */
  deleteBySkillIds?: (skillIds: string[]) => Promise<{ deletedCount: number }>;
};

// Dynamic imports below mirror the rest of this slice's I/O seam
// (`agent-skill-assignment-sources.ts`) for two reasons, both load-bearing
// here specifically:
//   - `./extension-skill-resolver` imports `readSkillsCatalog` etc. FROM
//     `./skills-store`, and this module is imported BACK from
//     `./skills-store` (direction 1 above) — a static two-way import would be
//     a genuine load-time cycle, not just a lint nit. `skills-store.ts`
//     already dodges the same shape of cycle with `./github` via a dynamic
//     import (see its `tryAutoSyncConfiguredRepository`).
//   - `@/lib/agent-assigned-skills-store` is the host app's DB layer;
//     reaching it lazily keeps this package's module graph loadable with no
//     app context, exactly like `agent-assigned-skills-actions.ts` reaches
//     `@cinatra-ai/agents`'s `withInstallLock`.
async function defaultScanExtensions(): Promise<SkillExtensionDescriptor[]> {
  const { scanSkillExtensions } = await import("./extension-skill-resolver");
  return scanSkillExtensions();
}

async function defaultDeriveSkillRegistration(
  pkgName: string,
  pkgDirName: string,
  slug: string,
): Promise<SkillRegistration> {
  const { deriveSkillRegistration } = await import("./extension-skill-resolver");
  return deriveSkillRegistration(pkgName, pkgDirName, slug);
}

async function defaultDeleteBySkillIds(skillIds: string[]): Promise<{ deletedCount: number }> {
  const { deleteAssignedSkillsForSkillIds } = await import("@/lib/agent-assigned-skills-store");
  return deleteAssignedSkillsForSkillIds(skillIds);
}

/**
 * Derive the EXACT catalog ids a REAL npm skill package owns, via the SAME
 * derivation `buildSkillIdOwnership` (S1's predicate) uses. A per-slug throw
 * (reserved chat-namespace impersonation, `deriveSkillRegistration`'s guard)
 * degrades only that slug — mirrors `buildSkillIdOwnership`'s fail-soft
 * posture — never the sweep as a whole.
 *
 * Returns `[]` when the scan carries no `kind:"skill"` descriptor for this
 * package name — including simply "this package owns no skills", which is a
 * normal outcome, not a failure.
 */
export async function deriveOwnedAssignedSkillIds(
  realPackageName: string,
  deps: SkillPackageTeardownDeps = {},
): Promise<string[]> {
  if (!realPackageName) return [];
  const scanExtensions = deps.scanExtensions ?? defaultScanExtensions;
  const derive = deps.deriveSkillRegistration ?? defaultDeriveSkillRegistration;
  const descriptors = await scanExtensions();
  const owned = descriptors.find((d) => d.kind === "skill" && d.pkgName === realPackageName);
  if (!owned) return [];
  const ids: string[] = [];
  for (const slug of owned.slugs) {
    try {
      const reg = await derive(owned.pkgName, owned.pkgDirName, slug);
      ids.push(reg.skillId);
    } catch {
      // A package impersonating the reserved `@cinatra-ai/chat` namespace
      // degrades only THIS slug — never aborts the sweep for the rest of the
      // package's legitimate skills.
    }
  }
  return ids;
}

/**
 * Sweep `agent_assigned_skills` rows for a skill package being uninstalled —
 * called by `skills-store.ts:uninstallSkillPackage` BEFORE its
 * missing-native-package early return. `packageId` is the catalog packageId
 * (`verdaccio:<name>` / `github:<name>`, per `skill-package-source.ts`); the
 * real npm package name is recovered from it, not looked up in the native
 * `skillPackages` catalog — a virtual-namespace registration may have no row
 * there at all.
 */
export async function sweepAssignedSkillsForSkillPackageId(
  packageId: string,
  deps: SkillPackageTeardownDeps = {},
): Promise<{ deletedCount: number }> {
  const realPackageName = packageId.replace(/^verdaccio:/, "").replace(/^github:/, "");
  const ids = await deriveOwnedAssignedSkillIds(realPackageName, deps);
  if (ids.length === 0) return { deletedCount: 0 };
  const deleteBySkillIds = deps.deleteBySkillIds ?? defaultDeleteBySkillIds;
  return deleteBySkillIds(ids);
}

/**
 * Delete every `agent_assigned_skills` row for an agent package being
 * uninstalled — called by `@cinatra-ai/agents`'s `extension-handler.ts`
 * FIRST inside its `withInstallLock` callback, before the provider-only
 * early return (a template-free, provider-declared agent can still carry
 * assignments — S1's canonical resolver is what makes them assignable at
 * all).
 */
export async function deleteAssignedSkillsForAgentPackage(
  agentPackageName: string,
): Promise<{ deletedCount: number }> {
  const { deleteAssignedSkillsForAgentPackage: deleteRows } = await import(
    "@/lib/agent-assigned-skills-store"
  );
  return deleteRows(agentPackageName);
}
