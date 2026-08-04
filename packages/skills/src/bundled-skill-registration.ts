import "server-only";

// ---------------------------------------------------------------------------
// ALWAYS-ON registration of an extension's co-located skill bundles
// (cinatra#2398).
//
// THE DEFECT THIS CLOSES. An extension ships its skills next to itself, at
// `<pkgDir>/skills/<slug>/SKILL.md`. Nothing on a PRODUCTION boot ever read
// that tree: the only boot-time scan lived on the dev path
// (`loadAllSkillPackagesAtBoot`, gated on `CINATRA_RUNTIME_MODE`), and the
// always-on `skills-catalog-rebuild` phase runs an engine whose disk scanner
// walks `data/skills` — never `extensions/**`, and never the canonical
// `data/skill-store/workspace` mirror the registration writes into. So on a
// production deployment a bundled skill reached the catalog only if some lazy
// consumer happened to self-heal it first (`ensureInstalledSkillRegistered`),
// and nothing guaranteed that before a picker read, a search, or a delivery
// revalidation. The operator-visible symptom: the assignable-skills picker
// offered none of the bundled injectable skills.
//
// WHY IT LIVES HERE AND NOT ON THE DEV LOADER. Promoting the dev watcher's
// `loadAllExtensionPackages` out of its dev gate would have been fewer lines
// and the wrong module: it walks ONE root (`cwd/extensions`), so a
// marketplace-installed skill extension in the runtime install dir would stay
// invisible; it applies no lifecycle gate, so a RETIRED extension's bundle
// would re-register itself on every boot; and it drags the connector /
// object-registry dev machinery into the production boot graph. This registrar
// is built on the same substrate the lazy resolver already uses —
// `scanSkillExtensions` (both roots) + `filterRetiredSkillExtensions`
// (tombstone-aware) + `registerColocatedWorkspaceSkills` (the one writer) — so
// the always-on path and the on-demand path can never disagree about what a
// bundled skill is or where it comes from.
//
// SCOPE. Workspace-level co-located bundles of `kind:"skill"` and
// `kind:"artifact"` packages: exactly the rows the assignment feature reads.
// The dev scan ALSO registers `kind:"agent"` bundles at `level:"agent"`, and
// those are deliberately NOT promoted here — an agent-level row is delivered
// unconditionally into that agent's runs by `resolveForAgent`'s direct
// self-match, with no assignability predicate and no install-status check in
// front of it, so turning that on in production is a delivery change that owes
// its own acceptance criteria rather than a free ride on this one.
// ---------------------------------------------------------------------------

import {
  deriveSkillRegistration,
  filterRetiredSkillExtensions,
  registerColocatedWorkspaceSkills,
  retireExtensionSkillsByExactId,
  scanSkillExtensions,
  type SkillExtensionDescriptor,
} from "./extension-skill-resolver";
import {
  isExtensionRegisteredSkill,
  readSkillsCatalogSnapshot,
  withSkillsCatalogRebuildLease,
} from "./skill-packages";
import type { PersistedSkill } from "./skills-store";

/**
 * The extension kinds whose co-located bundles register at WORKSPACE level.
 * Mirrors the dev scan's two `registerColocatedWorkspaceSkills` call sites
 * (`kind:"skill"` and `kind:"artifact"`); a connector's co-located widget-chat
 * bundle is NOT in this set, because the dev scan does not register it either —
 * it stays on the lazy capability resolver, unchanged by this slice.
 */
const WORKSPACE_COLOCATED_KINDS: ReadonlySet<string> = new Set(["skill", "artifact"]);

export type BundledSkillRegistrationResult = {
  /** Catalog ids that registered successfully on this pass. */
  registered: string[];
  /** Catalog ids retired because no installed extension ships them any more. */
  retired: string[];
  /**
   * Why the retirement sweep did not run, or `null` when it did. Absence of a
   * bundle on disk only justifies deleting its row when the scan that failed to
   * find it was answerable in the first place.
   */
  sweepSkippedReason: string | null;
};

/**
 * Register every installed extension's co-located workspace skill bundle, then
 * retire the catalog rows whose bundle no longer exists.
 *
 * Idempotent by construction: `registerExtensionSkill` upserts by skill id and
 * (since cinatra#2274) records no fresh revision for byte-identical bundles, so
 * a re-run over an unchanged tree converges on the same catalog. Deliberately
 * NOT short-circuited on "the row already looks current": the registration pass
 * is also what re-materializes a wiped store volume and re-proves each row's
 * content authority, and a fast path keyed on the catalog alone would skip
 * exactly the boots that needed the healing.
 *
 * Fail-soft PER PACKAGE and per skill (`registerColocatedWorkspaceSkills` owns
 * the inner frame; a package that throws is logged and skipped), and fail-soft
 * on an unanswerable scan. It does NOT swallow everything: a failure to acquire
 * the catalog-rebuild lease propagates, and the boot phase's `degraded` policy
 * is what turns that into a logged, non-aborting boot.
 */
export async function registerBundledColocatedSkills(): Promise<BundledSkillRegistrationResult> {
  // ONE lease around the whole pass (cinatra#2398). Each `upsertSkill` is a
  // read-merge-REPLACE of the entire catalog, so two instances booting at once
  // would interleave those replaces with each other and with a leased rebuild.
  // The TTL is sized for a full bundle pass (the rebuild's 300s default is
  // sized for a rebuild) and the wait stays above it, so a crashed holder
  // always expires inside the wait rather than deadlocking a boot.
  return withSkillsCatalogRebuildLease(runRegistrationPass, {
    reason: "boot-bundled-skill-registration",
    leaseTtlMs: 600_000,
    leaseWaitMs: 660_000,
  });
}

async function runRegistrationPass(): Promise<BundledSkillRegistrationResult> {
  // The STRICT scan first: it is the only one whose "this bundle is not there"
  // is evidence rather than a swallowed error, so it is the only one allowed to
  // license a retirement. When it throws we still register — from the fail-soft
  // scan, which is what every other consumer sees — and skip the sweep.
  let strictScan: SkillExtensionDescriptor[] | null = null;
  let sweepSkippedReason: string | null = null;
  try {
    strictScan = await scanSkillExtensions({ strict: true });
  } catch (err) {
    sweepSkippedReason = `extension scan was not answerable (${err instanceof Error ? err.message : String(err)})`;
  }
  const scanned = strictScan ?? (await scanSkillExtensions());

  // Tombstone gate: a RETIRED extension must not re-register its bundle on the
  // next boot. Fail-open like every other delivery-path consumer of this filter.
  const live = await filterRetiredSkillExtensions(scanned);

  const registered: string[] = [];
  for (const ext of live) {
    if (!WORKSPACE_COLOCATED_KINDS.has(ext.kind)) continue;
    if (ext.slugs.length === 0) continue;
    try {
      registered.push(
        ...(await registerColocatedWorkspaceSkills({
          pkgDir: ext.pkgDir,
          pkgName: ext.pkgName,
          pkgDirName: ext.pkgDirName,
        })),
      );
    } catch (err) {
      console.warn(
        `[cinatra:skills] bundled registration skipped (${ext.pkgName}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const retired = strictScan
    ? await retireVanishedBundledSkills(strictScan)
    : [];

  console.info(
    `[cinatra:skills] bundled colocated registration: ${registered.length} skill(s) registered ` +
      `from ${live.filter((e) => WORKSPACE_COLOCATED_KINDS.has(e.kind) && e.slugs.length > 0).length} ` +
      `extension package(s); ${retired.length} retired` +
      (sweepSkippedReason ? ` (retirement sweep SKIPPED — ${sweepSkippedReason})` : ""),
  );
  return { registered, retired, sweepSkippedReason };
}

/**
 * A slug that no package ships, used ONLY to read back the NAMESPACE half of
 * `deriveSkillRegistration` (the package name it derives is a function of the
 * package name + directory alone). Needed because a package that dropped its
 * LAST bundle has no slug left to derive from — and that package is precisely
 * the one whose orphaned row the sweep exists to retire.
 */
const NAMESPACE_PROBE_SLUG = "\u0000namespace-probe";

/**
 * Retire the catalog rows that carry extension provenance but whose bundle no
 * installed extension ships any more.
 *
 * TWO ASYMMETRIC SETS, and the asymmetry is the whole safety argument:
 *
 *  - THE KEEP-SET is derived from EVERY scanned descriptor, of EVERY kind, not
 *    just the two kinds this module registers. `registerExtensionSkill` is
 *    reached from other paths too, so narrowing it to what this pass writes
 *    would delete rows a perfectly live package still owns.
 *  - THE SWEEPABLE NAMESPACES are only those a scanned package of a kind THIS
 *    pass registers would mint ids under. That is what keeps the sweep off rows
 *    written by the OTHER callers of `registerExtensionSkill`: the llm-bridge
 *    registers a mounted bundle under a PATH-DERIVED package name
 *    (`@<vendor>/<dir>`), which for a provider package deliberately differs from
 *    the name this scan derives — such a row carries extension provenance, is
 *    absent from the keep-set, and must never be swept for it.
 *
 * So a row is retired only when the scan can positively say "the package that
 * owns this namespace is still installed and no longer ships this slug".
 *
 * NOT covered, deliberately: a bundled package removed from the image ENTIRELY
 * takes its namespace with it, so its rows are left alone — the scan cannot
 * distinguish that from a foreign id it has no business deleting.
 *
 * For the WORKSPACE rows this pass owns, such a leftover is inert rather than
 * harmful: with no scanned package owning the id, the shared assignability
 * predicate refuses it as `no-owning-extension`, so it can be neither offered
 * for assignment nor delivered through the assignment channel. That claim is
 * deliberately NOT extended to agent-bound rows: `resolveForAgent`'s direct
 * self-match delivers a `level:"agent"` row without consulting the predicate or
 * the install status at all, so a stale agent row from a removed package keeps
 * being delivered. That is pre-existing (nothing here registers or retires
 * agent-level rows) and out of this issue's scope, named rather than implied.
 *
 * The sweep is per-id, so one row the database refuses to delete (a stale skill
 * that still carries co-owner grants — `skill_co_owners.skill_id` is
 * ON DELETE RESTRICT) does not block the retirement of the others. Each
 * candidate is re-checked against the same predicate at retirement time, on the
 * row as freshly read there; that narrows the window between selection and
 * deletion but does not close it — the catalog writer is a read-merge-replace,
 * as it is for every other writer in the store. With nothing to retire (the
 * overwhelmingly common boot) the sweep performs NO catalog write at all.
 */
async function retireVanishedBundledSkills(
  strictScan: readonly SkillExtensionDescriptor[],
): Promise<string[]> {
  const stillShipped = new Set<string>();
  const sweepableNamespaces = new Set<string>();
  for (const ext of strictScan) {
    if (WORKSPACE_COLOCATED_KINDS.has(ext.kind)) {
      try {
        sweepableNamespaces.add(
          deriveSkillRegistration(ext.pkgName, ext.pkgDirName, NAMESPACE_PROBE_SLUG).packageName,
        );
      } catch {
        // A package impersonating the reserved namespace vouches for nothing.
      }
    }
    for (const slug of ext.slugs) {
      try {
        stillShipped.add(deriveSkillRegistration(ext.pkgName, ext.pkgDirName, slug).skillId);
      } catch {
        // A package impersonating the reserved namespace derives no id — and
        // therefore vouches for none. It degrades only itself, as everywhere else.
      }
    }
  }

  let snapshot;
  try {
    snapshot = await readSkillsCatalogSnapshot();
  } catch (err) {
    console.warn(
      "[cinatra:skills] bundled retirement sweep skipped — catalog snapshot unreadable:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }

  const candidates = snapshot.skills.filter(
    (skill) =>
      isSweepableBundledRow(skill) &&
      !stillShipped.has(skill.id) &&
      sweepableNamespaces.has(skillIdNamespace(skill.id)),
  );
  const retired: string[] = [];
  for (const candidate of candidates) {
    try {
      retired.push(
        ...(await retireExtensionSkillsByExactId([candidate.id], {
          require: isSweepableBundledRow,
        })),
      );
    } catch (err) {
      console.warn(
        `[cinatra:skills] could not retire vanished bundled skill "${candidate.id}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return retired;
}

/**
 * The package half of a catalog skill id (`@scope/pkg:slug` → `@scope/pkg`).
 * Split on the FIRST colon, the same way the delivery path's owner-candidate
 * derivation does — a scoped npm name never contains one.
 */
function skillIdNamespace(skillId: string): string {
  return skillId.split(":")[0] ?? skillId;
}

/**
 * A row this sweep may delete: written by an extension registrar (the RECORDED
 * provenance, never a derived guess) and owned by nobody in particular. Every
 * owner-bearing shape is excluded, so a personal, agent-bound or scoped row can
 * never be swept even if something stamped it with extension provenance.
 *
 * Exported for the regression tests, which pin each refusal separately.
 */
export function isSweepableBundledRow(skill: PersistedSkill): boolean {
  if (!isExtensionRegisteredSkill(skill)) return false;
  if (skill.isCustomSkill === true) return false;
  if (typeof skill.ownerUserId === "string" && skill.ownerUserId.trim() !== "") return false;
  if (typeof skill.agentId === "string" && skill.agentId.trim() !== "") return false;
  if (typeof skill.scope === "string" && skill.scope.trim() !== "") return false;
  return true;
}
