import "server-only";

// ---------------------------------------------------------------------------
// THE ASSIGNABLE-SKILL POPULATION (cinatra#2348 S3 — epic #2345).
//
// The picker in `packages/extensions` needs an answer to ONE question: which
// catalog skills may an admin pin to an agent right now, and what do they look
// like? This module is that answer, and it is the epic's NEW public
// server-side export of `@cinatra-ai/skills`
// (`@cinatra-ai/skills/assignable-skill-search`) — the search action consumes
// it through that subpath, never through a package-internal path.
//
// THREE non-obvious commitments, each of which a naive implementation gets
// wrong:
//
//   1. THE PREDICATE IS NOT RE-IMPLEMENTED. Assignability is decided by S1's
//      shared `resolveSkillAssignability` (`agent-skill-assignability.ts`), the
//      same procedure the assign path validates with and the S2 resolution-time
//      revalidation re-checks. A picker filter written independently would drift
//      from the enforcement it advertises — and the picker is decoration, the
//      write path is the enforcement, so drift shows up as a row you can select
//      and cannot save.
//
//   2. THE CATALOG READ IS THE **PURE SNAPSHOT**. `readSkillsCatalogSnapshot`
//      (cinatra#1364) reads persisted rows and does nothing else. The other
//      catalog entry point, `readSkillsCatalog`, resolves to
//      `syncInstalledSkillsToDatabase()` — a full rebuild. A typeahead fires
//      one request per keystroke; pointing it at the syncing read would turn a
//      search box into a rebuild storm. The snapshot is passed EXPLICITLY into
//      the predicate's `readCatalog` seam, so the predicate and this module
//      decide on ONE read of ONE consistent catalog rather than two.
//
//   3. SKILL IDS COME FROM `deriveSkillRegistration`, via S1's
//      `buildSkillIdOwnership`. The five chat successor packages register their
//      skills under the VIRTUAL `@cinatra-ai/chat:` namespace, so the naive
//      `<packageName>:<slug>` id is simply wrong for them — it names a row that
//      does not exist, and those five skills would be invisible in the picker
//      forever. Going through the same derivation the registration path uses
//      also means the id this module returns is byte-identical to the one the
//      assignment store keys on.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO: authorization, agent resolution,
// already-assigned exclusion, query narrowing, paging, and display-name /
// vendor / lifecycle-label resolution. Those belong to the caller in
// `packages/extensions` — it owns the actor, the agent context and the standard
// display resolvers. This module answers "which skills, and what did their
// manifests declare", nothing more.
// ---------------------------------------------------------------------------

import {
  buildSkillIdOwnership,
  resolveSkillAssignability,
  type AssignabilityDeps,
  type SkillRole,
} from "./agent-skill-assignability";
import {
  readCatalogSnapshotSource,
  scanExtensionsSource,
} from "./agent-skill-assignment-sources";
import type { SkillExtensionDescriptor } from "./extension-skill-resolver";
import type { PersistedSkill } from "./skills-store";

/**
 * ONE assignable catalog skill, with the RAW manifest metadata its owning
 * extension declared.
 *
 * The metadata is raw on purpose: `extensionDisplayName` / `extensionVendorName`
 * / `extensionAuthor` are the INPUTS to the platform's standard display-name
 * and vendor resolvers, not resolved output. Resolving them here would fork the
 * precedence chain the Installed-extensions card already owns, and a package's
 * title must never differ between two surfaces.
 */
export type AssignableSkillCandidate = {
  /**
   * The CATALOG skill id — derived through `deriveSkillRegistration`, so the
   * chat-namespace successor packages carry their virtual `@cinatra-ai/chat:`
   * id and everything else its own `<scopedName>:<slug>`.
   */
  skillId: string;
  /** Catalog `name` (the skill's own label). */
  skillName: string;
  /** Catalog `description`; `""` when the row carries none. */
  skillDescription: string;
  /**
   * The REAL owning package — never the virtual `@cinatra-ai/chat` namespace,
   * because that is the package whose install row and lifecycle the caller
   * labels and the write path locks.
   */
  ownerPackageName: string;
  /** `cinatra.displayName` as declared, or `null`. */
  extensionDisplayName: string | null;
  /** `cinatra.vendor.name` as declared, or `null`. */
  extensionVendorName: string | null;
  /** npm `author` name as declared, or `null`. */
  extensionAuthor: string | null;
  /**
   * The RESOLVED role. Always `injectable` for a candidate this function
   * returns (that is conjunct 3 of the predicate) — carried so a caller can
   * assert it rather than assume it.
   */
  role: SkillRole;
};

export type AssignableSkillPopulationDeps = {
  /** PURE catalog snapshot. Default = `readSkillsCatalogSnapshot`. */
  readCatalogSnapshot?: () => Promise<{ skills: PersistedSkill[] }>;
  /** On-disk extension scan. Default = the real filesystem scan. */
  scanExtensions?: () => Promise<SkillExtensionDescriptor[]>;
  /** Canonical install status. Passed straight through to the predicate. */
  readInstallStatus?: AssignabilityDeps["readInstallStatus"];
};

function orNull(value: string | undefined): string | null {
  return value === undefined ? null : value;
}

/**
 * Every catalog skill that is assignable RIGHT NOW, in no particular order.
 *
 * FAIL-CLOSED, twice over. A failed catalog read or extension scan yields an
 * EMPTY population rather than a partial one: an empty picker is a visibly
 * degraded picker, whereas a partial one silently misrepresents which skills
 * exist. And every id still goes through the predicate, whose own failure modes
 * (unreadable lifecycle state, archived install, non-injectable role) each
 * refuse rather than approve — so a source outage can never widen the offer.
 *
 * ONE read of each source: the catalog snapshot and the scan are read here and
 * handed to the predicate through its injection seams, so the whole population
 * decides against a single consistent view.
 */
export async function listAssignableSkillCandidates(
  deps: AssignableSkillPopulationDeps = {},
): Promise<AssignableSkillCandidate[]> {
  const readCatalogSnapshot = deps.readCatalogSnapshot ?? readCatalogSnapshotSource;
  const scanExtensions = deps.scanExtensions ?? scanExtensionsSource;

  let catalog: { skills: PersistedSkill[] };
  let descriptors: SkillExtensionDescriptor[];
  try {
    [catalog, descriptors] = await Promise.all([readCatalogSnapshot(), scanExtensions()]);
  } catch (err) {
    console.warn(
      "[skills/assignable-skill-search] catalog snapshot or extension scan failed — " +
        "offering NO assignable skills (fail-closed):",
      err instanceof Error ? err.message : err,
    );
    return [];
  }

  // The candidate id set: every skill id a scanned `kind:"skill"` extension
  // owns, derived through `deriveSkillRegistration` (S1's helper). Starting
  // from the SCAN rather than from the catalog is what keeps a user-authored
  // custom skill — which no extension owns — out of the candidate set before
  // the predicate ever sees it.
  const ownership = buildSkillIdOwnership(descriptors);
  if (ownership.size === 0) return [];

  const verdicts = await resolveSkillAssignability([...ownership.keys()], {
    readCatalog: async () => catalog,
    scanExtensions: async () => descriptors,
    readInstallStatus: deps.readInstallStatus,
  });

  const descriptorByPackage = new Map<string, SkillExtensionDescriptor>();
  for (const ext of descriptors) {
    if (ext.kind !== "skill") continue;
    if (!descriptorByPackage.has(ext.pkgName)) descriptorByPackage.set(ext.pkgName, ext);
  }

  const out: AssignableSkillCandidate[] = [];
  for (const [skillId, verdict] of verdicts) {
    if (!verdict.assignable) continue;
    // Both are non-null on an assignable verdict (conjuncts 1-3 all passed);
    // the guards keep this total rather than asserting.
    if (!verdict.ownerPackageName || !verdict.skill || verdict.role === null) continue;
    const ext = descriptorByPackage.get(verdict.ownerPackageName);
    out.push({
      skillId,
      skillName: verdict.skill.name,
      skillDescription: verdict.skill.description,
      ownerPackageName: verdict.ownerPackageName,
      extensionDisplayName: orNull(ext?.displayName),
      extensionVendorName: orNull(ext?.vendorName),
      extensionAuthor: orNull(ext?.author),
      role: verdict.role,
    });
  }
  return out;
}
