import "server-only";

// ---------------------------------------------------------------------------
// THE I/O SEAM for direct skill assignment (cinatra#2346 S1, epic #2345).
//
// Every real-world read the assignment slice performs is funneled through this
// ONE module, and every consumer inside the slice imports it by RELATIVE path.
// Two reasons, both load-bearing:
//
//   1. LAYERING. `@cinatra-ai/skills` must not hard-depend on
//      `@cinatra-ai/extensions` (which already depends on this package) nor on
//      the host app's module graph. Each reader below reaches its source
//      through a lazy dynamic import, so importing the predicate never drags
//      the canonical store or the app's agents-store into the module graph.
//
//   2. TESTABILITY. A cross-package specifier (`@/lib/...`,
//      `@cinatra-ai/extensions`) does not reliably intercept when the dynamic
//      import lives in a DIFFERENT module than the test's `vi.mock` call — the
//      mock registry keys on the importer's resolution. A relative specifier
//      inside this package always does. Collecting the seams here means the
//      slice's tests double ONE module and exercise the REAL predicate, the
//      REAL resolver and the REAL lock ordering above it.
// ---------------------------------------------------------------------------

import type { PersistedSkill } from "./skills-store";
import type { SkillExtensionDescriptor } from "./extension-skill-resolver";

/** The installed skill CATALOG (workspace/system rows the picker draws from). */
export async function readCatalogSource(): Promise<{ skills: PersistedSkill[] }> {
  const { readSkillsCatalog } = await import("./skills-store");
  return (await readSkillsCatalog()) as { skills: PersistedSkill[] };
}

/**
 * The PURE catalog SNAPSHOT (cinatra#2348 S3) — the persisted rows, normalized,
 * with NO scan / write / network / enqueue side effect.
 *
 * The picker population reads THIS, never `readCatalogSource` above: that one
 * resolves to `syncInstalledSkillsToDatabase()`, so a typeahead keystroke would
 * otherwise fire a full catalog rebuild per request. The DB state the snapshot
 * returns is kept current by the explicit `rebuildSkillsCatalog()` calls at
 * lifecycle points and by the catalog writers themselves (cinatra#1364), which
 * is exactly the contract a read-only search wants.
 */
export async function readCatalogSnapshotSource(): Promise<{ skills: PersistedSkill[] }> {
  const { readSkillsCatalogSnapshot } = await import("./skill-packages");
  const snapshot = await readSkillsCatalogSnapshot();
  return { skills: snapshot.skills };
}

/** The on-disk extension SCAN (the authority for skill-id ownership + roles). */
export async function scanExtensionsSource(): Promise<SkillExtensionDescriptor[]> {
  const { scanSkillExtensions } = await import("./extension-skill-resolver");
  return scanSkillExtensions();
}

/**
 * Aggregated canonical install status per package name. THROWS on a read
 * failure — the assignability predicate turns that into a refusal, never an
 * approval.
 */
export async function readInstallStatusSource(
  packageNames: string[],
): Promise<Map<string, "active" | "archived">> {
  const { readEffectiveStatusByPackageNames } = await import("@cinatra-ai/extensions");
  return readEffectiveStatusByPackageNames(packageNames);
}

/** The identity fields the canonical agent-package resolver matches on. */
export type AgentIdentitySource = {
  packageId: string;
  id?: string;
  identifier?: string;
  packageSlug?: string;
};

/**
 * The installed-agent POPULATION: DB-installed templates UNION the
 * provider-declared on-disk agents, deduped by packageId. The union is what
 * makes a template-free provider-declared agent resolvable at all.
 */
export async function readAgentPopulationSource(): Promise<AgentIdentitySource[]> {
  const { readAgentsForSkillMatching } = await import("@/lib/agents-store");
  const agents = await readAgentsForSkillMatching();
  return agents.map((a) => ({
    packageId: a.packageId,
    id: a.id,
    identifier: a.identifier,
    packageSlug: a.packageSlug,
  }));
}

/** Canonical `cinatra.kind` for a package (install row first, manifest second). */
export async function readPackageKindSource(packageName: string): Promise<string | null> {
  const { readCanonicalPackageKind } = await import("@/lib/agent-package-eligibility");
  const fromRow = await readCanonicalPackageKind(packageName);
  if (fromRow) return fromRow;
  // Provider-declared / image-shipped agents may carry NO canonical row. Their
  // on-disk `cinatra.kind` is still authoritative — it is the same declaration
  // the canonical row is derived from at install time — and without this arm a
  // template-free provider-declared agent could resolve but never be written to.
  const descriptors = await scanExtensionsSource();
  return descriptors.find((d) => d.pkgName === packageName)?.kind ?? null;
}

/**
 * Authoritative assistant predicate: the persisted assistant DECLARATION on the
 * canonical row, or the `agent_kind='assistant'` registry linkage. THROWS on a
 * read failure so the write-target gate fails closed.
 */
export async function isAssistantPackageSource(packageName: string): Promise<boolean> {
  const { isAssistantPackageName } = await import("@/lib/agent-package-eligibility");
  return isAssistantPackageName(packageName);
}
