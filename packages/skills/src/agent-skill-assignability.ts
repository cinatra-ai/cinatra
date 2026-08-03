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

/** True iff the catalog row is globally visible (conjunct 2). */
export function isGloballyVisibleCatalogRow(skill: PersistedSkill): boolean {
  if (skill.isCustomSkill === true) return false;
  if (skill.isCustom === true) return false;
  if (typeof skill.ownerUserId === "string" && skill.ownerUserId.trim() !== "") return false;
  if (typeof skill.agentId === "string" && skill.agentId.trim() !== "") return false;
  if (typeof skill.scope === "string" && skill.scope.trim() !== "") return false;
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
  const candidatesByPackage = new Map(
    ownerPackages.map((p) => [p, resolveSkillOwnerPackageCandidates({ packageName: p })] as const),
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
        const statuses = (candidatesByPackage.get(ownerPackageName) ?? [])
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
