import "server-only";

// ---------------------------------------------------------------------------
// THE SHARED ASSIGNABILITY PREDICATE (cinatra#2346 S1 — epic #2345).
//
// This module is the epic's SINGLE canonical answer to "may an admin pin this
// skill to an agent?". It is implemented ONCE, here, and consumed by all three
// surfaces the epic names:
//
//   * S1 (this lane)  — assignment-time validation in
//                       `agent-assigned-skills-actions.ts`, and the hydration
//                       read's per-row status.
//   * S2              — resolution-time REVALIDATION in `src/lib/agents-store`
//                       (a skill that stopped being assignable must stop being
//                       delivered, not merely stop being pickable).
//   * S3              — the paged picker population in `packages/extensions`.
//
// Consumers import it through the PUBLIC subpath export
// `@cinatra-ai/skills/agent-skill-assignability` — never a package-internal
// path — so the predicate has exactly one definition and one import surface.
//
// THE PREDICATE (epic §"Decided architecture" item 1), all three conjuncts
// required, evaluated FAIL-CLOSED:
//
//   1. INSTALL      the owning skill-kind extension has a canonical
//                   `installed_extension` row whose status is `active` or
//                   `locked`. NO ROW IS NOT ASSIGNABLE — bundled/vendored
//                   skills that were never installed as their own extension
//                   are deliberately excluded (this is the one place the
//                   codebase's usual "no row = keep, it's an image-shipped
//                   bundle" fail-open rule is inverted: a picker offering a
//                   skill whose lifecycle nothing tracks could never honor the
//                   uninstall teardown S5 defines).
//   2. VISIBILITY   the catalog skill row is GLOBALLY visible: workspace- or
//                   system-level, with no owner scoping whatsoever — not
//                   personal, not agent-scoped, not team/project/org-scoped,
//                   not a user-authored custom skill. The assignment store has
//                   no owner tuple, so an owner-scoped skill could not be
//                   resolved consistently by an actor-less worker run.
//   3. ROLE         the skill's RESOLVED role is `injectable` — it is delivered
//                   into the model's context, rather than consumed by a host
//                   pipeline (`matcher`) or never delivered at all
//                   (`internal`).
//
// ROLE RESOLUTION uses authoritative manifest data only, in this order:
//   a. the owning package's own `cinatra.skillRole` declaration, when present;
//   b. otherwise, the DECLARED dependency edges of every scanned extension: a
//      package consumed through a `kind:"skill"` edge carrying `role:"matcher"`
//      or `role:"authoring"` is pipeline-consumed, so it is NOT injectable;
//   c. otherwise `injectable` — the meaning an absent role already carries at
//      the edge (see `DeclaredExtensionDependency.role` in
//      extension-skill-resolver.ts: "ABSENT means the plain injectable
//      delivery").
// Never a name suffix and never a directory heuristic.
//
// EVERY refusal carries a machine-readable `reason`, because three different
// surfaces render three different explanations from the same verdict, and the
// S2 revalidation logs which conjunct dropped a delivery.
// ---------------------------------------------------------------------------

import { resolveSkillOwnerPackageCandidates } from "./manifest-identity";
import {
  deriveSkillRegistration,
  type SkillExtensionDescriptor,
} from "./extension-skill-resolver";
import type { PersistedSkill, SkillLevel } from "./skills-store";
import {
  readCatalogSource,
  readInstallStatusSource,
  scanExtensionsSource,
} from "./agent-skill-assignment-sources";

/**
 * The PURE catalog SNAPSHOT read (cinatra#2348 S3), re-exported here ON PURPOSE
 * — this is the ONE public way an out-of-package consumer fills the `readCatalog`
 * seam below with the non-syncing read.
 *
 * `readCatalog` defaults to `readCatalogSource`, i.e.
 * `syncInstalledSkillsToDatabase()`: a full catalog rebuild (GitHub sync, disk
 * scan, DB write, prefill enqueue). That default is right for a rare
 * configuration WRITE, and wrong for anything that runs per request or per run
 * dispatch — the S3 picker population and the S2 resolution-time revalidation
 * both inject the snapshot instead. The seam module itself stays
 * package-INTERNAL (its consumers inside this slice import it by relative path
 * so one `vi.mock` doubles every real-world read), so the predicate's own
 * public subpath carries the read its seam expects rather than re-implementing
 * it at each caller.
 */
export { readCatalogSnapshotSource } from "./agent-skill-assignment-sources";

/** The skill-role vocabulary (#2089). `injectable` is the assignable one. */
export const SKILL_ROLES = ["injectable", "matcher", "internal"] as const;
export type SkillRole = (typeof SKILL_ROLES)[number];

/** The role an absent declaration and an unroled edge both mean. */
export const DEFAULT_SKILL_ROLE: SkillRole = "injectable";

/**
 * Catalog levels that are GLOBALLY visible. `personal` and `agent` are
 * owner-/agent-scoped by construction; `team`, `project` and `organization`
 * carry a scope id. Everything outside this set fails conjunct 2.
 */
const GLOBALLY_VISIBLE_LEVELS: ReadonlySet<SkillLevel> = new Set<SkillLevel>([
  "workspace",
  "system",
]);

/** Why a skill is not assignable. `null` on the assignable verdict. */
export type AssignabilityRefusal =
  /** No catalog row with this id. */
  | "unknown-skill"
  /** The catalog row is owner-scoped / not globally visible. */
  | "not-globally-visible"
  /** No `kind:"skill"` extension on disk owns this skill id. */
  | "no-owning-extension"
  /** The owning extension has no live canonical install row (incl. no row). */
  | "not-installed"
  /** The owning extension's install rows are all archived. */
  | "archived"
  /** The resolved role is not `injectable`. */
  | "not-injectable"
  /** The lifecycle-status read failed — fail closed, never assume live. */
  | "lifecycle-read-failed";

export type SkillAssignability = {
  skillId: string;
  assignable: boolean;
  /** `null` iff `assignable`. */
  reason: AssignabilityRefusal | null;
  /** The REAL owning package (never the virtual `@cinatra-ai/chat` namespace). */
  ownerPackageName: string | null;
  /** The resolved role, when one could be resolved. */
  role: SkillRole | null;
  /** Catalog display metadata, when the catalog row exists. */
  skill: { id: string; name: string; description: string; level: SkillLevel | null } | null;
};

// ---------------------------------------------------------------------------
// PURE core — no I/O, so the predicate itself is unit-testable without a DB or
// a filesystem, and so every caller provably shares ONE decision procedure.
// ---------------------------------------------------------------------------

/** The facts the predicate decides on. */
export type AssignabilityFacts = {
  skillId: string;
  /** The catalog row, or null when the id resolves to nothing. */
  skill: PersistedSkill | null;
  /** The REAL owning package name, or null when nothing on disk owns the id. */
  ownerPackageName: string | null;
  /**
   * The owning package's aggregated install status: `"active"` for a live
   * (active|locked) row, `"archived"` when rows exist but none is live,
   * `"none"` when the package has no canonical row at all, `"unreadable"`
   * when the status read failed.
   */
  installStatus: "active" | "archived" | "none" | "unreadable";
  /** The resolved role, or null when no owning package resolved. */
  role: SkillRole | null;
};

/**
 * True iff the catalog row is globally visible (conjunct 2).
 *
 * TWO sources, both consulted, because the legacy `(level, scope)` tuple is
 * documented as "a label/index hint … never an enforcement source": it is
 * PROJECTED from `accessPolicy.runListVisibility` at write time, so a policy
 * write that outran its projection would leave a scoped skill wearing a
 * `workspace` label. When a canonical `accessPolicy` is present it therefore
 * DECIDES — the read grant must include `workspace`, i.e. every workspace user
 * can resolve the skill. Only when no policy is stored does the projected tuple
 * stand in for it.
 *
 * Fail-closed in both directions: an owner/team:/project:/org:/admin-only read
 * grant is owner scoping and is refused, and so is a personal, agent-scoped or
 * user-authored row regardless of policy.
 */
export function isGloballyVisibleCatalogRow(skill: PersistedSkill): boolean {
  if (skill.isCustomSkill === true) return false;
  if (skill.isCustom === true) return false;
  if (typeof skill.ownerUserId === "string" && skill.ownerUserId.trim() !== "") return false;
  if (typeof skill.agentId === "string" && skill.agentId.trim() !== "") return false;
  if (typeof skill.scope === "string" && skill.scope.trim() !== "") return false;
  // PRESENCE, not truthiness: a stored-but-malformed policy (`false`, `0`, `""`
  // — only reachable from corrupt data) must not read as "no policy" and fall
  // through to the weaker projected label. Anything present that is not a
  // readable policy object is refused.
  const policy = skill.accessPolicy;
  if (policy !== undefined && policy !== null) {
    if (typeof policy !== "object") return false;
    const grants = (policy as { runListVisibility?: unknown }).runListVisibility;
    return Array.isArray(grants) && grants.includes("workspace");
  }
  if (!skill.level) return false;
  return GLOBALLY_VISIBLE_LEVELS.has(skill.level);
}

/**
 * THE predicate. Pure, total, fail-closed, and evaluated in the epic's stated
 * conjunct order so a refusal names the FIRST thing that is wrong (the picker
 * and the S2 revalidation log read better when the reason is stable).
 */
export function evaluateAssignability(facts: AssignabilityFacts): SkillAssignability {
  const display = facts.skill
    ? {
        id: facts.skill.id,
        name: facts.skill.name,
        description: facts.skill.description ?? "",
        level: facts.skill.level ?? null,
      }
    : null;
  const base = {
    skillId: facts.skillId,
    ownerPackageName: facts.ownerPackageName,
    role: facts.role,
    skill: display,
  };
  const refuse = (reason: AssignabilityRefusal): SkillAssignability => ({
    ...base,
    assignable: false,
    reason,
  });

  if (!facts.skill) return refuse("unknown-skill");
  if (!isGloballyVisibleCatalogRow(facts.skill)) return refuse("not-globally-visible");
  if (!facts.ownerPackageName) return refuse("no-owning-extension");
  if (facts.installStatus === "unreadable") return refuse("lifecycle-read-failed");
  if (facts.installStatus === "none") return refuse("not-installed");
  if (facts.installStatus === "archived") return refuse("archived");
  if (facts.role !== "injectable") return refuse("not-injectable");
  return { ...base, assignable: true, reason: null };
}

// ---------------------------------------------------------------------------
// Role resolution (pure).
// ---------------------------------------------------------------------------

function normalizeRole(raw: unknown): SkillRole | null {
  return typeof raw === "string" && (SKILL_ROLES as readonly string[]).includes(raw)
    ? (raw as SkillRole)
    : null;
}

/**
 * Resolve each scanned skill package's role from AUTHORITATIVE manifest data.
 *
 * `descriptors` is the full scan (every kind), because the edges that classify
 * a skill package as pipeline-consumed are declared by its CONSUMERS (artifact
 * and agent extensions), not by the skill package itself.
 *
 * Precedence: the package's own `cinatra.skillRole` wins; otherwise a
 * `kind:"skill"` edge naming it with `role:"matcher"` / `role:"authoring"`
 * demotes it out of `injectable`; otherwise `injectable`.
 */
export function resolveSkillPackageRoles(
  descriptors: readonly SkillExtensionDescriptor[],
): Map<string, SkillRole> {
  const roles = new Map<string, SkillRole>();
  const declaredByConsumers = new Map<string, string>();
  for (const ext of descriptors) {
    for (const dep of ext.dependencies) {
      if (dep.kind !== undefined && dep.kind !== "skill") continue;
      if (!dep.role) continue;
      // `matcher` and `authoring` are both host-pipeline surfaces: the skill is
      // consumed by the matcher runtime / the authoring flow, never delivered
      // through the injection contract this epic feeds.
      if (dep.role !== "matcher" && dep.role !== "authoring") continue;
      if (!declaredByConsumers.has(dep.packageName)) {
        declaredByConsumers.set(dep.packageName, dep.role);
      }
    }
  }
  for (const ext of descriptors) {
    if (ext.kind !== "skill") continue;
    const declared = normalizeRole(ext.skillRole);
    if (declared) {
      roles.set(ext.pkgName, declared);
      continue;
    }
    roles.set(ext.pkgName, declaredByConsumers.has(ext.pkgName) ? "matcher" : DEFAULT_SKILL_ROLE);
  }
  return roles;
}

/**
 * Map every skill id a scanned `kind:"skill"` extension owns to its REAL
 * package name.
 *
 * Derivation goes through `deriveSkillRegistration`, so the five chat
 * successor packages — whose catalog rows carry the VIRTUAL
 * `@cinatra-ai/chat` package name — still map back to the real package whose
 * install row and lifecycle lock the predicate and the write path need. Using
 * the catalog row's own `packageName` here would resolve them to a package
 * that does not exist, and they would be permanently unassignable.
 */
export function buildSkillIdOwnership(
  descriptors: readonly SkillExtensionDescriptor[],
): Map<string, string> {
  const owners = new Map<string, string>();
  for (const ext of descriptors) {
    if (ext.kind !== "skill") continue;
    for (const slug of ext.slugs) {
      let skillId: string;
      try {
        skillId = deriveSkillRegistration(ext.pkgName, ext.pkgDirName, slug).skillId;
      } catch {
        // A package impersonating the reserved namespace degrades only itself.
        continue;
      }
      if (!owners.has(skillId)) owners.set(skillId, ext.pkgName);
    }
  }
  return owners;
}

// ---------------------------------------------------------------------------
// I/O composition. Every source is injectable so the predicate is testable
// without a database, a filesystem, or the extensions package.
// ---------------------------------------------------------------------------

export type AssignabilityDeps = {
  /** Catalog reader. Default = the real skills catalog. */
  readCatalog?: () => Promise<{ skills: PersistedSkill[] }>;
  /** Extension scan. Default = the real filesystem scan. */
  scanExtensions?: () => Promise<SkillExtensionDescriptor[]>;
  /**
   * Aggregated canonical install status by package name. Default = the
   * extensions package's `readEffectiveStatusByPackageNames`, reached through
   * a dynamic import because `@cinatra-ai/skills` must never hard-depend on
   * `@cinatra-ai/extensions` (which already depends on this package).
   *
   * A THROW means "unreadable" and every verdict fails closed — this is NOT
   * the fail-open posture the skill-delivery scan filter uses, because
   * offering an assignment against an unknown lifecycle state is a
   * configuration write, not a degraded read.
   */
  readInstallStatus?: (packageNames: string[]) => Promise<Map<string, "active" | "archived">>;
};

/**
 * Resolve the assignability verdict for a set of skill ids in ONE pass (one
 * catalog read, one scan, one status read) — the picker asks about a page of
 * skills, the write path about one, the S2 revalidation about a run's whole
 * assigned set.
 *
 * Fail-closed end to end: a failed catalog read, a failed scan or a failed
 * status read yields a REFUSAL for every requested id, never an approval.
 */
export async function resolveSkillAssignability(
  skillIds: readonly string[],
  deps: AssignabilityDeps = {},
): Promise<Map<string, SkillAssignability>> {
  const out = new Map<string, SkillAssignability>();
  const wanted = [...new Set(skillIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (wanted.length === 0) return out;

  const readCatalog = deps.readCatalog ?? readCatalogSource;
  const scanExtensions = deps.scanExtensions ?? scanExtensionsSource;
  const readInstallStatus = deps.readInstallStatus ?? readInstallStatusSource;

  let catalog: { skills: PersistedSkill[] };
  let descriptors: SkillExtensionDescriptor[];
  try {
    [catalog, descriptors] = await Promise.all([readCatalog(), scanExtensions()]);
  } catch (err) {
    console.warn(
      "[skills/assignability] catalog or extension scan failed — refusing every id (fail-closed):",
      err instanceof Error ? err.message : err,
    );
    for (const id of wanted) {
      out.set(id, {
        skillId: id,
        assignable: false,
        reason: "lifecycle-read-failed",
        ownerPackageName: null,
        role: null,
        skill: null,
      });
    }
    return out;
  }

  const byId = new Map((catalog.skills ?? []).map((s) => [s.id, s] as const));
  const ownership = buildSkillIdOwnership(descriptors);
  const roles = resolveSkillPackageRoles(descriptors);

  // The candidate-key union absorbs `installed_extension.package_name` identity
  // drift (slugified legacy rows), exactly like the delivery-scan lifecycle
  // gate does.
  const ownerPackages = [...new Set(wanted.map((id) => ownership.get(id)).filter(Boolean) as string[])];
  // Every package name the scan knows. A drift candidate that IS another
  // scanned package's canonical name belongs to THAT package, not to this one:
  // `slugify` is lossy, so `@a/b-c` and a package literally named `a-b-c` share
  // a candidate key, and the unrelated package's row must never vouch for this
  // one. Dropping such keys leaves only genuinely ambiguous-to-nobody aliases.
  const scannedPackageNames = new Set(descriptors.map((d) => d.pkgName));
  const candidatesByPackage = new Map(
    ownerPackages.map(
      (p) =>
        [
          p,
          resolveSkillOwnerPackageCandidates({ packageName: p }).filter(
            (c) => c === p || !scannedPackageNames.has(c),
          ),
        ] as const,
    ),
  );
  let statusMap: Map<string, "active" | "archived"> | null = null;
  const allCandidates = [...new Set([...candidatesByPackage.values()].flat())];
  if (allCandidates.length > 0) {
    try {
      statusMap = await readInstallStatus(allCandidates);
    } catch (err) {
      console.warn(
        "[skills/assignability] install-status read failed — refusing every id (fail-closed):",
        err instanceof Error ? err.message : err,
      );
      statusMap = null;
    }
  } else {
    statusMap = new Map();
  }

  for (const id of wanted) {
    const ownerPackageName = ownership.get(id) ?? null;
    let installStatus: AssignabilityFacts["installStatus"] = "none";
    if (ownerPackageName) {
      if (statusMap === null) {
        installStatus = "unreadable";
      } else {
        // EXACT npm-form key FIRST. The candidate union exists only to absorb
        // legacy slug-form rows, and `slugify` is lossy: `@a/b-c` and a package
        // literally named `a-b-c` share a candidate key, so an unrelated
        // package's ACTIVE row must never be able to vouch for this one. Only
        // when the canonical name has no row at all do the drift candidates
        // stand in.
        const exact = statusMap.get(ownerPackageName);
        const statuses =
          exact !== undefined
            ? [exact]
            : (candidatesByPackage.get(ownerPackageName) ?? [])
                .map((c) => statusMap!.get(c))
                .filter((s): s is "active" | "archived" => s !== undefined);
        installStatus = statuses.includes("active")
          ? "active"
          : statuses.includes("archived")
            ? "archived"
            : "none";
      }
    }
    out.set(
      id,
      evaluateAssignability({
        skillId: id,
        skill: byId.get(id) ?? null,
        ownerPackageName,
        installStatus,
        role: ownerPackageName ? (roles.get(ownerPackageName) ?? DEFAULT_SKILL_ROLE) : null,
      }),
    );
  }
  return out;
}

/** Single-id convenience over {@link resolveSkillAssignability}. */
export async function resolveOneSkillAssignability(
  skillId: string,
  deps: AssignabilityDeps = {},
): Promise<SkillAssignability> {
  const map = await resolveSkillAssignability([skillId], deps);
  return (
    map.get(skillId) ?? {
      skillId,
      assignable: false,
      reason: "unknown-skill",
      ownerPackageName: null,
      role: null,
      skill: null,
    }
  );
}

// ---------------------------------------------------------------------------
// SKILL-SIDE lifecycle teardown for direct skill assignment
// (cinatra#2350 S5, epic #2345).
//
// Uninstalling a skill extension deletes every `agent_assigned_skills` row that
// names one of ITS catalog skills. Three properties make this correct rather
// than merely plausible, and each one is the reason for a specific choice
// below:
//
//   1. EXACT DERIVED IDS, VIRTUAL NAMESPACE INCLUDED. The ids come from
//      `deriveSkillRegistration` (through S1's `buildSkillIdOwnership`), never
//      from `<pkg>:<slug>` string-building and never from the catalog row's own
//      `packageName`. The five chat successor packages register their skills
//      under the VIRTUAL `@cinatra-ai/chat:` namespace, so their assignment
//      rows carry ids that name a package which does not exist — a naive
//      derivation would sweep nothing and leave every one of those assignments
//      behind. Conversely the virtual name is never used as a MATCH key: one
//      successor package's uninstall must not sweep its four siblings' ids.
//
//   2. ORDERED BEFORE THE UNINSTALL PATH'S EARLY RETURNS. `uninstallSkillPackage`
//      returns `false` when no NATIVE catalog package row matches the persisted
//      package id — precisely the shape a virtual-namespace registration can
//      have. Running the teardown after that return would skip the packages that
//      need it most, so it runs FIRST, before any early return and before the
//      catalog rewrite and the disk removal. That ordering is also what makes
//      the on-disk scan the authority here: the package's files are still
//      present when the teardown reads them.
//
//   3. UNDER THE SAME PER-EXTENSION LIFECYCLE LOCK THE ASSIGN FLOW TAKES.
//      S1's `assignAgentSkill` runs its revalidate→insert section inside
//      `withInstallLock(<owning skill package>)`. The teardown takes the same
//      lock on the same key, so "assign lands after cleanup swept" is not a race
//      that can be lost — it cannot occur. The lock is re-entrant, so the
//      dispatcher path (which already holds it for the package being
//      uninstalled) pays nothing, while a direct caller (the MCP uninstall
//      handler) acquires it here.
//
// WHY A FAILURE IS FATAL. A surviving row is not an audit record, it is an
// orphan that REAPPLIES: reinstalling the package re-derives the same ids, S2's
// resolution-time revalidation starts passing again, and the skill is delivered
// again from a configuration nobody re-made. The sibling co-owner and
// polymorphic-permission cleanups in the same uninstall path are fatal for
// exactly that reason, and this one is ordered ahead of all of them — so a
// failure aborts the uninstall before anything destructive has happened.
//
// WHY IT LIVES IN THIS MODULE rather than a teardown module of its own. It
// consumes `buildSkillIdOwnership` above — the epic's single derivation of
// "which catalog skill ids does this package own" — and the same
// `scanExtensionsSource` seam, so co-location is what keeps the sweep keyed on
// exactly the ids the assign path could ever have written. It also costs the
// route graph nothing: this module is already reachable from all five locked
// routes, and both writes below are reached through dynamic imports of modules
// that are already on those graphs, so no `absorbs` raise is needed for what is
// otherwise one leaf function. The two halves stay separable: nothing above
// this banner imports anything below it.
// ---------------------------------------------------------------------------

/** The reserved VIRTUAL namespace. Never a real package, never a match key. */
const RESERVED_VIRTUAL_PACKAGE = "@cinatra-ai/chat";

/** The persisted-id prefixes `resolveSkillPackageSource` mints. */
const PACKAGE_ID_PREFIXES = ["verdaccio:", "github:"] as const;

/**
 * The package NAME a persisted `skill_packages` id denotes.
 *
 * The id shape is locked by `resolveSkillPackageSource`
 * (`verdaccio:<name>` / `github:<owner>/<repo>`), so the name is recovered by
 * dropping the source prefix. A raw name with no prefix is accepted as-is —
 * `uninstallSkillPackage` is also reachable from callers that pass a catalog
 * package id verbatim.
 *
 * EXACT, never npm-normalized (codex round 1, adopted). An earlier draft also
 * offered the `@`-prefixed twin, so `github:acme/skills` matched a scanned
 * `@acme/skills` — two unrelated identities from two different registries, and
 * the sweep would have deleted the npm package's assignments. GitHub-installed
 * packs mint their catalog ids as `github:<owner>/<repo>:<slug>` and are not
 * assignable through `buildSkillIdOwnership` at all, so the alias bought
 * nothing and could only ever over-delete.
 */
export function skillPackageName(packageId: string): string | null {
  const raw = String(packageId ?? "").trim();
  if (!raw) return null;
  const prefix = PACKAGE_ID_PREFIXES.find((p) => raw.startsWith(p));
  const name = prefix ? raw.slice(prefix.length).trim() : raw;
  return name || null;
}

export type OwnedSkillIds = {
  /** The REAL owning package name (the lifecycle-lock key), when scanned. */
  ownerPackageName: string | null;
  /** The exact derived catalog skill ids that package owns. */
  skillIds: string[];
};

/**
 * PURE: the exact derived catalog skill ids owned by `packageName`, plus the
 * real package name to lock on.
 *
 * Matching is EXACT on the SCANNED package name, never on the catalog row's
 * `packageName` — that field carries the virtual namespace for the chat
 * successor packages and would either match nothing or match four unrelated
 * packages.
 *
 * OWNERSHIP IS ARBITRATED OVER THE WHOLE SCAN (codex round 1, adopted). The
 * derivation runs against the matched descriptors, but every derived id is then
 * re-checked against `buildSkillIdOwnership` over ALL descriptors and dropped
 * unless that map awards it to this package. Two chat successor packages that
 * ship the same slug derive the SAME virtual id; without this arbitration each
 * one's uninstall would delete the other's assignment, and the map's own
 * first-seen rule is what the predicate and the picker already treat as the
 * authority.
 */
export function deriveOwnedSkillIds(
  packageName: string | null,
  descriptors: readonly SkillExtensionDescriptor[],
): OwnedSkillIds {
  const empty = { ownerPackageName: null, skillIds: [] };
  if (!packageName || packageName === RESERVED_VIRTUAL_PACKAGE) return empty;

  const owned = descriptors.filter((d) => d.kind === "skill" && d.pkgName === packageName);
  if (owned.length === 0) return empty;

  // `buildSkillIdOwnership` is S1's shared derivation (the same helper the
  // predicate and the S3 picker use), so the ids the teardown sweeps are the ids
  // the assign path could ever have written — by construction, not by a parallel
  // implementation that could drift.
  const authority = buildSkillIdOwnership(descriptors);
  const skillIds = [...buildSkillIdOwnership(owned).keys()].filter(
    (id) => authority.get(id) === packageName,
  );
  return { ownerPackageName: packageName, skillIds };
}

export type SkillPackageTeardownDeps = {
  /** The on-disk extension scan. Default = the slice's real I/O seam. */
  scanExtensions?: () => Promise<SkillExtensionDescriptor[]>;
  /** Row delete by catalog skill id. Default = the canonical store. */
  deleteBySkillIds?: (
    skillIds: string[],
  ) => Promise<{ removed: Array<{ agentPackageName: string; skillId: string }> }>;
  /** The per-extension lifecycle lock. Default = the real `withInstallLock`. */
  withLifecycleLock?: <T>(packageName: string, fn: () => Promise<T>) => Promise<T>;
};

async function defaultDeleteBySkillIds(skillIds: string[]) {
  const { deleteAssignedSkillsForSkillIds } = await import("@/lib/agent-assigned-skills-store");
  return deleteAssignedSkillsForSkillIds(skillIds);
}

async function defaultWithLifecycleLock<T>(packageName: string, fn: () => Promise<T>): Promise<T> {
  const { withInstallLock } = await import("@cinatra-ai/agents");
  return withInstallLock(packageName, fn);
}

/** Length-bound + strip control characters; logged as an ARGUMENT (S1's `forLog`). */
function forLog(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 200);
}

export type SkillPackageTeardownResult = {
  ownerPackageName: string | null;
  skillIds: string[];
  removed: Array<{ agentPackageName: string; skillId: string }>;
};

/**
 * Run `uninstall` with this package's assignment rows swept FIRST and the whole
 * uninstall held inside the package's lifecycle lock.
 *
 * THE LOCK SPANS THE SCAN, THE SWEEP AND THE WHOLE UNINSTALL (codex rounds 1+2,
 * adopted). An earlier draft
 * held it only across the DELETE, which left a real same-process gap for the
 * direct caller that has no outer lock (the skills MCP uninstall handler): sweep
 * → release → a concurrent assign takes the lock, revalidates against a package
 * that is still on disk and still in the catalog, and commits → the uninstall
 * then removes the package, leaving exactly the orphan the sweep exists to
 * prevent. Holding the lock until the uninstall has finished makes that
 * interleaving unreachable, and costs the registry path nothing — it already
 * holds the same lock on the same key, and the lock is re-entrant.
 *
 * The sweep THROWS on a failed scan or a failed delete, before `uninstall` is
 * called — see the fatality note at the top of this section.
 *
 * RESIDUAL, recorded rather than papered over: the lifecycle lock is
 * process-local (it is what every install/uninstall/purge path in the platform
 * serializes on), so a sibling worker's assign is ordered by neither this lock
 * nor S1's. S1 documents the same residual and compensates with a post-commit
 * revalidation under its own lock; widening the serialization to a cross-process
 * lease would change every lifecycle path, not this one.
 */
export async function withSkillAssignmentTeardown<T>(
  packageId: string,
  uninstall: () => Promise<T>,
  deps: SkillPackageTeardownDeps = {},
): Promise<T> {
  const packageName = skillPackageName(packageId);
  const scanExtensions = deps.scanExtensions ?? scanExtensionsSource;
  const deleteBySkillIds = deps.deleteBySkillIds ?? defaultDeleteBySkillIds;
  const withLifecycleLock = deps.withLifecycleLock ?? defaultWithLifecycleLock;

  // An id that denotes no package cannot be serialized on and owns nothing.
  if (!packageName) return uninstall();

  // THE LOCK IS TAKEN BEFORE THE SCAN (codex round 2, adopted). Deriving first
  // and locking second left the derivation reading a snapshot that a concurrent
  // update — holding the lifecycle lock — could invalidate before the sweep ran:
  // the uninstall would then sweep a STALE id set and remove a package whose
  // newly-restored slug already carried an assignment. The zero-id branch was
  // worse still, running the whole destructive uninstall unlocked. Everything —
  // scan, derivation, sweep, uninstall — is now one critical section on the
  // package's own key, which is also the key `assignAgentSkill` derives from the
  // predicate's `ownerPackageName` (exact matching makes the two identical).
  return withLifecycleLock(packageName, async () => {
    const { ownerPackageName, skillIds } = deriveOwnedSkillIds(packageName, await scanExtensions());
    if (!ownerPackageName || skillIds.length === 0) return uninstall();

    const { removed } = await deleteBySkillIds(skillIds);
    if (removed.length > 0) {
      console.warn(
        "[skills/assignment-teardown] uninstall removed direct skill assignments — package / count / pairs:",
        forLog(ownerPackageName),
        removed.length,
        removed.map((r) => `${forLog(r.agentPackageName)}\u2192${forLog(r.skillId)}`).join(", "),
      );
    }
    return uninstall();
  });
}
