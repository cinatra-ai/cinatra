import "server-only";

// ---------------------------------------------------------------------------
// THE I/O SEAM for the assignable-skills picker search (cinatra#2348 S3, epic
// #2345).
//
// Same shape, and the same two reasons, as the S1 slice's
// `agent-skill-assignment-sources.ts`:
//
//   1. LAYERING. Every read below is reached through a LAZY dynamic import, so
//      importing the search action does not drag the skills catalog, the
//      canonical install store, the auth session graph or the host's
//      assignment store into whatever module graph the action lands in.
//
//   2. TESTABILITY. `vi.mock` keys on the IMPORTER's resolution, so a dynamic
//      import written in a different module than the mock call does not
//      reliably intercept. Collecting the seams in ONE module that the action
//      imports by RELATIVE path means the action's tests double exactly one
//      module — and still exercise the REAL admin gate ordering, the REAL pure
//      search model and the REAL display resolvers above it.
// ---------------------------------------------------------------------------

import type { AssignableSkillCandidate } from "@cinatra-ai/skills/assignable-skill-search";
import type { InstalledExtension } from "./canonical-types";

/**
 * Re-assert ADMIN standing server-side. Returns the admin's user id.
 *
 * THROWS when the caller is not an authenticated admin — `requireAdminSession`
 * is the platform's own gate and the same one the S1 assignment actions use, so
 * the picker and the write it feeds agree about who may see the population.
 * The action catches the throw and refuses; it never falls through.
 */
export async function requireAdminUserIdSource(): Promise<string> {
  const { requireAdminSession } = await import("@/lib/auth-session");
  const session = await requireAdminSession();
  return String(session?.user?.id ?? "");
}

/**
 * The assignable-skill POPULATION, through the NEW public server-side export of
 * `@cinatra-ai/skills`. Never a package-internal path, and never a second
 * implementation of the shared assignability predicate.
 */
export async function listAssignableSkillCandidatesSource(): Promise<AssignableSkillCandidate[]> {
  const { listAssignableSkillCandidates } = await import(
    "@cinatra-ai/skills/assignable-skill-search"
  );
  return listAssignableSkillCandidates();
}

/**
 * Resolve an agent reference to its CANONICAL package name through the shared
 * S1 resolver (exact → unique npm suffix → refuse on ambiguity).
 */
export async function resolveAgentPackageSource(agentRef: string) {
  const { resolveCanonicalAgentPackage } = await import(
    "@cinatra-ai/skills/agent-package-resolver"
  );
  return resolveCanonicalAgentPackage(agentRef);
}

/**
 * The S1 write-target gate: agent-kind, non-assistant, fail-closed on an
 * unreadable eligibility source. The SEARCH applies it too — an assistant has
 * no Skills section at all (the assistant injection branch ignores the
 * recommendation channel this epic feeds), so offering it a population would
 * advertise an assignment that could never be delivered.
 */
export async function assertAgentTargetSource(packageName: string) {
  const { assertAgentWriteTarget } = await import("@cinatra-ai/skills/agent-package-resolver");
  return assertAgentWriteTarget(packageName);
}

/** The skill ids ALREADY assigned to this agent — the exclusion set. */
export async function readAssignedSkillIdsSource(agentPackageName: string): Promise<string[]> {
  const { readAssignedSkillsForAgentPackage } = await import("@/lib/agent-assigned-skills-store");
  const rows = await readAssignedSkillsForAgentPackage(agentPackageName);
  return rows.map((r) => r.skillId);
}

/**
 * Canonical install rows for a set of package names, so a listed row can carry
 * `locked` vs `active`. LIVENESS is NOT decided here — the shared assignability
 * predicate already decided it (and counts `locked` as live, per
 * `screens/installed-rows.ts`); this read only refines the LABEL.
 */
export async function readInstallRowsSource(
  packageNames: readonly string[],
): Promise<Map<string, InstalledExtension[]>> {
  const { readInstalledExtensionsByPackageNames } = await import("./canonical-store");
  return readInstalledExtensionsByPackageNames(packageNames);
}
