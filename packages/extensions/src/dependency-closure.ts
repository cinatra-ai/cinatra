// Extension-to-extension dependency closure.
//
// Dependencies are declared on the canonical manifest row as
// ExtensionDependency[] (see canonical-types.ts). The closure is computed
// over `active | locked` rows only — an `archived` dependency counts as
// MISSING. Required-missing fails install + blocks archive/uninstall/restore
// when the resulting closure would break. Optional-missing has per-kind
// declared behavior.
import "server-only";

import { satisfiesVersionRange } from "@cinatra-ai/registries";
import type {
  ExtensionDependency,
  ExtensionKind,
  InstalledExtension,
} from "./canonical-types";

/**
 * The set of statuses that count as "present" for closure purposes.
 * `archived` is intentionally excluded — an archived dependency is missing.
 */
const PRESENT_STATUSES = new Set(["active", "locked"]);

export type ClosureNode = {
  packageName: string;
  status: InstalledExtension["status"] | "missing";
  kind?: ExtensionKind;
};

// ---------------------------------------------------------------------------
// Shared edge predicates (#180). EVERY surface that decides "does this edge
// block an install / should this edge be auto-installed" keys on these two
// predicates — never on `requirement` alone — so peer/optional semantics can
// never drift between the install gate, the dependency (auto-install) phase,
// and the archive/uninstall dependent-blocking gates.
//
//   edgeType × requirement   install-blocking   auto-installable
//   runtime      required          YES                YES
//   install-time required          YES                YES
//   runtime      optional          no                 no
//   install-time optional          no                 no
//   peer         required          no                 no   (activation-time check)
//   peer         optional          no                 no   (activation-time check)
// ---------------------------------------------------------------------------

/**
 * True when a MISSING edge target must fail an install (and, symmetrically,
 * when archiving/uninstalling the target must be refused while a live
 * dependent holds this edge). PEER edges are never install-blocking — a peer
 * is a coexistence constraint checked at activation time via the per-kind
 * behaviors, not a presence requirement.
 */
export function isInstallBlockingEdge(dep: ExtensionDependency): boolean {
  return dep.requirement === "required" && dep.edgeType !== "peer";
}

/**
 * True when the dependency (auto-install) phase may pull this edge's target
 * into the to-install set. PEER edges are never auto-installed (installing a
 * peer on the dependent's behalf would invert the relationship); OPTIONAL
 * edges are never auto-installed either (the per-kind optional-missing
 * behaviors own that degradation, not the installer).
 */
export function isAutoInstallableEdge(dep: ExtensionDependency): boolean {
  return dep.requirement === "required" && dep.edgeType !== "peer";
}

export type ClosureResult = {
  ok: boolean;
  /** Install-blocking deps (required runtime/install-time edges) that are
   *  missing or archived (closure-breaking). */
  missingRequired: ClosureNode[];
  /** Optional deps that are missing or archived (per-kind behavior governs). */
  missingOptional: ClosureNode[];
  /** PEER deps that are missing or archived — never install-blocking, never
   *  auto-installed; surfaced to the activation-time per-kind behaviors. */
  missingPeer: ClosureNode[];
  /** PRESENT install-blocking deps whose installed version VIOLATES the
   *  declared constraint (#180 item 6). `ok` stays presence-based (the
   *  execution-closure surfaces keep their presence semantics); the
   *  install/restore/boot gates consume this bucket explicitly. */
  rangeViolations: RangeViolation[];
  /** Full visited set, for diagnostics. */
  visited: string[];
};

/** A PRESENT dependency whose installed version violates the edge's constraint (#180 item 6). */
export type RangeViolation = {
  packageName: string;
  /** The dependent that declared the violated edge. */
  via: string;
  installedVersion: string;
  constraint: string;
};

/** The installed (verdaccio-sourced) version of a canonical row, or null
 *  (dev/local/github sources carry no registry version → presence-only). */
export function installedVersionOfRow(row: InstalledExtension): string | null {
  const src = row.source as { type?: string; version?: string } | null | undefined;
  return src && src.type === "verdaccio" && typeof src.version === "string" && src.version
    ? src.version
    : null;
}

/**
 * Evaluate ONE edge's versionConstraint against an installed version (#180
 * item 6 — the closure engine's version awareness). Returns the violated
 * constraint as a display string, or null when satisfied / not evaluable:
 *  - `*` ranges and rows without a registry version are presence-only;
 *  - `git-ref` constraints are not evaluable against a registry version (the
 *    planner refuses them at install time; here they stay presence-only).
 */
export function edgeVersionViolation(
  dep: ExtensionDependency,
  installedVersion: string | null,
): string | null {
  if (installedVersion === null) return null;
  const vc = dep.versionConstraint;
  if (vc.kind === "semver-range") {
    if (vc.range === "*" || satisfiesVersionRange(installedVersion, vc.range)) return null;
    return `"${vc.range}"`;
  }
  if (vc.kind === "exact") {
    return vc.version === installedVersion ? null : `=${vc.version}`;
  }
  return null; // git-ref: not evaluable here
}

export type ManifestLookup = (packageName: string) => InstalledExtension | undefined;

/**
 * Scope-aware manifest lookup over a full snapshot: a dependent at org scope
 * X resolves a dependency from X's own live (active|locked) row first, then
 * from the platform-scoped row (organizationId null). A live row in a
 * FOREIGN org never satisfies the edge — cross-org dependency bleed would be
 * fail-open (org B's closure "satisfied" by an install org B cannot see).
 * Platform-scoped dependents (organizationId null) resolve only
 * platform-scoped rows.
 */
export function makeScopedManifestLookup(
  rows: InstalledExtension[],
  organizationId: string | null,
): ManifestLookup {
  return (name) => {
    const live = rows.filter(
      (r) => r.packageName === name && PRESENT_STATUSES.has(r.status),
    );
    return (
      (organizationId != null
        ? live.find((r) => r.organizationId === organizationId)
        : undefined) ?? live.find((r) => r.organizationId == null)
    );
  };
}

/**
 * Compute the transitive dependency closure of a root extension over the
 * provided manifest snapshot. Cycles are handled (visited set). The lookup
 * returns the canonical row for a package name, or undefined if not installed.
 */
export function computeClosure(
  root: InstalledExtension,
  lookup: ManifestLookup,
): ClosureResult {
  const visited = new Set<string>();
  const missingRequired: ClosureNode[] = [];
  const missingOptional: ClosureNode[] = [];
  const missingPeer: ClosureNode[] = [];
  const rangeViolations: RangeViolation[] = [];

  const stack: { from: string; deps: ExtensionDependency[] }[] = [
    { from: root.packageName, deps: root.dependencies },
  ];
  visited.add(root.packageName);

  while (stack.length > 0) {
    const { from, deps } = stack.pop()!;
    for (const dep of deps) {
      const installed = lookup(dep.packageName);
      const present = installed && PRESENT_STATUSES.has(installed.status);

      if (!present) {
        const node: ClosureNode = {
          packageName: dep.packageName,
          status: installed ? installed.status : "missing",
          kind: installed?.kind,
        };
        // EdgeType-aware bucketing (#180): only an INSTALL-BLOCKING edge
        // (required runtime/install-time) breaks the closure. A PEER edge —
        // required or optional — is an activation-time concern (per-kind
        // behaviors), never install/boot/restore-blocking.
        if (dep.edgeType === "peer") missingPeer.push(node);
        else if (isInstallBlockingEdge(dep)) missingRequired.push(node);
        else missingOptional.push(node);
        // Do not recurse into a missing/archived dependency.
        continue;
      }

      // VERSION AWARENESS (#180 item 6): a PRESENT target of an
      // install-blocking edge must also SATISFY the edge's constraint.
      // Peer/optional edges stay presence-only (their semantics are
      // activation-time / per-kind, never blocking).
      if (isInstallBlockingEdge(dep)) {
        const violated = edgeVersionViolation(dep, installedVersionOfRow(installed!));
        if (violated !== null) {
          rangeViolations.push({
            packageName: dep.packageName,
            via: from,
            installedVersion: installedVersionOfRow(installed!) ?? "(unknown)",
            constraint: violated,
          });
        }
      }

      if (!visited.has(dep.packageName)) {
        visited.add(dep.packageName);
        stack.push({ from: dep.packageName, deps: installed!.dependencies });
      }
    }
  }

  return {
    ok: missingRequired.length === 0,
    missingRequired,
    missingOptional,
    missingPeer,
    rangeViolations,
    visited: [...visited],
  };
}

/**
 * Per-kind optional-missing behavior. Declared per kind, not generic — lives
 * here as the single source of truth; each kind's activation adapter consults
 * this.
 */
export type OptionalMissingBehavior =
  | "stop-run-hitl" // agent
  | "skip-step-audit" // connector
  | "log-continue" // skill, artifact
  | "fail-instantiate"; // workflow

export function optionalMissingBehaviorForKind(kind: ExtensionKind): OptionalMissingBehavior {
  switch (kind) {
    case "agent":
      return "stop-run-hitl";
    case "connector":
      return "skip-step-audit";
    case "skill":
      return "log-continue";
    case "artifact":
      return "log-continue";
    case "workflow":
      return "fail-instantiate";
  }
}

/** The per-kind dispatch outcome for a target's missing OPTIONAL deps. */
export type OptionalMissingAdvisory = {
  /** The DEPENDENT's kind — the behavior table is keyed on it. */
  kind: ExtensionKind;
  behavior: OptionalMissingBehavior;
  missingOptional: ClosureNode[];
};

/**
 * The single dispatch verdict every closure-consuming surface keys on.
 * Deliberately NOT one boolean: boot/restore gate on `requiredClosureOk`
 * only (optional-missing must never fail a boot or a lifecycle restore),
 * while execution surfaces (workflow instantiate today; agent-run /
 * connector-step later) gate on `executionBlock`.
 */
export type ExecutionClosureVerdict = {
  /** True when the target's REQUIRED transitive closure is intact. */
  requiredClosureOk: boolean;
  missingRequired: ClosureNode[];
  /**
   * Per-kind dispatch for the target's missing OPTIONAL deps (null when none
   * are missing). For "stop-run-hitl" / "skip-step-audit" / "log-continue"
   * this advisory IS the consumable handed to the respective run-layer
   * surface; "fail-instantiate" additionally raises `executionBlock`.
   */
  advisory: OptionalMissingAdvisory | null;
  /**
   * Non-null when the target must not execute/instantiate: its required
   * closure is broken (any kind), or its kind declares optional-missing as
   * "fail-instantiate" (workflow) and an optional dep is missing.
   */
  executionBlock:
    | { code: "REQUIRED_MISSING"; missing: string[] }
    | { code: "OPTIONAL_MISSING_FAILS_INSTANTIATE"; missing: string[] }
    | null;
};

/**
 * Compute the per-kind execution-closure verdict for one target row.
 *
 * Closure semantics are PRESENCE/STATUS-ONLY by design: a dep is satisfied by
 * any `active | locked` row of that package name — `versionConstraint` on the
 * dependency edge is deliberately NOT evaluated here (version pinning for the
 * required-in-prod set is enforced separately by
 * `verifyRequiredInProdInstalled` in required-in-prod.ts).
 */
export function evaluateExecutionClosure(
  target: InstalledExtension,
  lookup: ManifestLookup,
): ExecutionClosureVerdict {
  const result = computeClosure(target, lookup);
  // PEER edges ride the per-kind ACTIVATION-TIME behaviors (#180): a missing
  // peer is never install/boot/restore-blocking (computeClosure buckets it
  // out of missingRequired), but at the execution/instantiate surfaces it is
  // dispatched exactly like a missing optional dep — the dependent's kind
  // decides (stop-run-hitl / skip-step-audit / log-continue /
  // fail-instantiate).
  const missingAdvisory = [...result.missingOptional, ...result.missingPeer];
  const advisory: OptionalMissingAdvisory | null =
    missingAdvisory.length > 0
      ? {
          kind: target.kind,
          behavior: optionalMissingBehaviorForKind(target.kind),
          missingOptional: missingAdvisory,
        }
      : null;

  let executionBlock: ExecutionClosureVerdict["executionBlock"] = null;
  if (result.missingRequired.length > 0) {
    executionBlock = {
      code: "REQUIRED_MISSING",
      missing: result.missingRequired.map((d) => d.packageName),
    };
  } else if (advisory && advisory.behavior === "fail-instantiate") {
    executionBlock = {
      code: "OPTIONAL_MISSING_FAILS_INSTANTIATE",
      missing: advisory.missingOptional.map((d) => d.packageName),
    };
  }

  return {
    requiredClosureOk: result.missingRequired.length === 0,
    missingRequired: result.missingRequired,
    advisory,
    executionBlock,
  };
}

/**
 * Boot diagnostics: scan a full manifest snapshot for any `active | locked` row
 * whose REQUIRED dependency closure is broken (a required dep is archived or
 * missing). PURE + non-throwing — the boot gate calls this and decides what to
 * do with the result (it does NOT remediate). Each row's deps resolve through
 * the SCOPE-AWARE lookup (own org row, then platform row — a foreign org's
 * live row never satisfies the edge), and only `active | locked` rows count
 * as present (an archived dep is missing).
 */
export function findBrokenClosures(
  rows: InstalledExtension[],
): { packageName: string; missingRequired: string[]; rangeViolations: string[] }[] {
  const broken: { packageName: string; missingRequired: string[]; rangeViolations: string[] }[] = [];
  for (const row of rows) {
    if (!PRESENT_STATUSES.has(row.status)) continue;
    const result = computeClosure(row, makeScopedManifestLookup(rows, row.organizationId));
    if (result.missingRequired.length > 0 || result.rangeViolations.length > 0) {
      broken.push({
        packageName: row.packageName,
        missingRequired: result.missingRequired.map((d) => d.packageName),
        // VERSION AWARENESS (#180 item 6): a present-but-range-violating
        // install-blocking dep breaks the closure the same way a missing one
        // does — boot/restore gates consume both.
        rangeViolations: result.rangeViolations.map(
          (v) => `${v.packageName}@${v.installedVersion} violates ${v.constraint} required by ${v.via}`,
        ),
      });
    }
  }
  return broken;
}

export class DependencyClosureError extends Error {
  constructor(
    public readonly code: "REQUIRED_MISSING" | "ARCHIVE_BREAKS_CLOSURE" | "UPDATE_BREAKS_DEPENDENTS" | "RANGE_VIOLATION",
    message: string,
    public readonly dependents: string[],
  ) {
    super(message);
    this.name = "DependencyClosureError";
  }
}

/**
 * UPDATE GATE (#180 item 6): refuse updating `packageName` to `newVersion`
 * when any LIVE dependent's install-blocking edge on it would be violated —
 * NAMING the dependents and their constraints. Scope-aware: a dependent's
 * edge counts only when its scoped lookup resolves to the row being updated
 * (own-org row first, then platform row). `*` ranges and git-ref constraints
 * are not evaluable → never block. PURE over the snapshot — wire it BEFORE
 * any durable mutation.
 */
export function assertUpdateDoesNotBreakDependents(
  packageName: string,
  newVersion: string,
  allRows: InstalledExtension[],
  opts?: { organizationId?: string | null },
): void {
  // The TARGET row(s) of this update: at an explicit scope, exactly the live
  // row(s) at that (package, org); with NO scope given (the direct agent
  // writer carries none), conservatively every live row of the package.
  const targetIds = new Set(
    allRows
      .filter(
        (r) =>
          r.packageName === packageName &&
          PRESENT_STATUSES.has(r.status) &&
          (opts?.organizationId === undefined ||
            (r.organizationId ?? null) === (opts.organizationId ?? null)),
      )
      .map((r) => r.id),
  );
  if (targetIds.size === 0) return; // nothing live is being updated → nothing can break

  const violations: { dependent: string; constraint: string }[] = [];
  for (const row of allRows) {
    if (row.packageName === packageName) continue;
    if (!PRESENT_STATUSES.has(row.status)) continue;
    // A dependent binds IFF its OWN scoped lookup resolves THE row being
    // updated (row identity, not just name): an org-scoped dependent falling
    // back to the platform row blocks a platform update; a platform dependent
    // resolving the platform row never blocks an ORG-scoped update.
    const resolved = makeScopedManifestLookup(allRows, row.organizationId)(packageName);
    if (!resolved || !targetIds.has(resolved.id)) continue;
    for (const dep of row.dependencies) {
      if (dep.packageName !== packageName) continue;
      if (!isInstallBlockingEdge(dep)) continue;
      const violated = edgeVersionViolation(dep, newVersion);
      if (violated !== null) violations.push({ dependent: row.packageName, constraint: violated });
    }
  }
  if (violations.length > 0) {
    const names = [...new Set(violations.map((v) => v.dependent))];
    throw new DependencyClosureError(
      "UPDATE_BREAKS_DEPENDENTS",
      `Cannot update ${packageName} to ${newVersion} — it would break ` +
        `${names.length} installed dependent(s): ` +
        violations.map((v) => `${v.dependent} requires ${packageName}@${v.constraint}`).join("; ") +
        `. Update the dependent(s) to versions whose declared ranges admit ` +
        `${newVersion}, or keep ${packageName} at a satisfying version.`,
      names,
    );
  }
}

/**
 * Topological DEPENDENCIES-FIRST order over package names (#180 item 8 — the
 * runtime loader's activation order). Kahn with a DETERMINISTIC lexicographic
 * tie-break; a cycle (which publish-side induction cannot create) falls back
 * to lexicographic order for the cyclic remainder with a LOUD warning. Edges
 * to packages outside `names` are ignored (activation order is only
 * meaningful among the packages being activated).
 */
export function orderPackagesByDependencyFirst(
  names: readonly string[],
  edgesByPackage: ReadonlyMap<string, readonly ExtensionDependency[]>,
): string[] {
  const inSet = new Set(names);
  const dependsOn = new Map<string, Set<string>>();
  for (const name of names) {
    dependsOn.set(
      name,
      new Set(
        (edgesByPackage.get(name) ?? [])
          .filter((d) => d.edgeType !== "peer" && inSet.has(d.packageName))
          .map((d) => d.packageName),
      ),
    );
  }
  const ordered: string[] = [];
  const placed = new Set<string>();
  let remaining = [...names].sort();
  while (remaining.length > 0) {
    const ready = remaining.filter((n) => [...dependsOn.get(n)!].every((d) => placed.has(d)));
    if (ready.length === 0) {
      console.warn(
        `[dependency-closure] dependency CYCLE among ${remaining.join(", ")} — activating in ` +
          `lexicographic order (deterministic fallback; publish-side induction cannot create cycles).`,
      );
      for (const n of remaining) {
        ordered.push(n);
        placed.add(n);
      }
      break;
    }
    const next = ready[0]!; // lexicographic tie-break (remaining stays sorted)
    ordered.push(next);
    placed.add(next);
    remaining = remaining.filter((n) => n !== next);
  }
  return ordered;
}

/**
 * Install gate: required-missing fails install. Returns the closure result so
 * the caller can log optional-missing per-kind.
 */
export function assertInstallClosure(
  candidate: InstalledExtension,
  lookup: ManifestLookup,
): ClosureResult {
  const result = computeClosure(candidate, lookup);
  // VERSION AWARENESS (#180 item 6): a restore whose install-blocking deps
  // are present at VIOLATING versions is as broken as one with missing deps.
  if (result.ok && result.rangeViolations.length > 0) {
    throw new DependencyClosureError(
      "RANGE_VIOLATION",
      `Cannot install ${candidate.packageName} — installed dependency versions violate its declared constraints: ` +
        result.rangeViolations
          .map((v) => `${v.packageName}@${v.installedVersion} violates ${v.constraint} (required by ${v.via})`)
          .join("; "),
      result.rangeViolations.map((v) => v.packageName),
    );
  }
  if (!result.ok) {
    throw new DependencyClosureError(
      "REQUIRED_MISSING",
      `Cannot install ${candidate.packageName} — required dependencies missing or archived: ${result.missingRequired
        .map((d) => `${d.packageName} (${d.status})`)
        .join(", ")}`,
      result.missingRequired.map((d) => d.packageName),
    );
  }
  return result;
}

/**
 * Archive/uninstall closure gate: refuse when archiving the target would break
 * a REQUIRED edge from a still-active dependent. `allRows` is the full
 * manifest snapshot; `target` is the package about to be archived/uninstalled.
 */
export function assertArchiveDoesNotBreakClosure(
  target: InstalledExtension,
  allRows: InstalledExtension[],
): void {
  const blockingDependents: string[] = [];
  for (const row of allRows) {
    if (row.packageName === target.packageName) continue;
    if (!PRESENT_STATUSES.has(row.status)) continue; // archived dependents don't block
    // Same predicate as the install gate: only an INSTALL-BLOCKING edge
    // (required runtime/install-time) blocks the archive — a peer edge is a
    // coexistence constraint, not a presence requirement, so it never holds
    // its target hostage.
    //
    // DELIBERATELY PRESENCE-BASED (#180 item 6 reconciliation): archiving the
    // target removes it ENTIRELY, so any install-blocking edge breaks —
    // version evaluation could only WEAKEN this gate (skipping a dependent
    // whose edge the current version already violates would let the archive
    // orphan it further). A version-violating dependent therefore still
    // blocks; the violation itself is surfaced by the boot/forward gates.
    const requiresTarget = row.dependencies.some(
      (d) => d.packageName === target.packageName && isInstallBlockingEdge(d),
    );
    if (requiresTarget) blockingDependents.push(row.packageName);
  }
  if (blockingDependents.length > 0) {
    throw new DependencyClosureError(
      "ARCHIVE_BREAKS_CLOSURE",
      `Cannot archive/uninstall ${target.packageName} — required by active dependents: ${blockingDependents.join(", ")}. Archive or detach them first.`,
      blockingDependents,
    );
  }
}

/**
 * FORWARD install gate (#180 item 5): at the END of a fresh install — after
 * the candidate row's manifest edges were persisted, before the install
 * reports success — refuse when any live row of `packageName` has a broken
 * install-blocking closure. PURE over the provided snapshot; each row's deps
 * resolve through the scope-aware lookup (own org row, then platform row).
 *
 * `organizationId` UNDEFINED checks every live row of the package; `null`
 * checks the platform-scoped row; a string checks that org's row — the same
 * scope the install pipeline finalized.
 *
 * With the dependency phase live (#180 PR-2), the batch installer satisfies
 * install-blocking edges DEPENDENCIES-FIRST before the root reaches this
 * gate — so a refusal here means the edge was NOT auto-installable into
 * place (the dependency phase only auto-installs required runtime/
 * install-time edges; a plan/manifest drift mid-install can also land here).
 * The copy stays actionable: name the missing deps, instruct an explicit
 * install + retry.
 */
export function assertForwardInstallClosureForPackage(
  packageName: string,
  allRows: InstalledExtension[],
  opts?: { organizationId?: string | null },
): void {
  const targets = allRows.filter(
    (r) =>
      r.packageName === packageName &&
      PRESENT_STATUSES.has(r.status) &&
      (opts?.organizationId === undefined ||
        (r.organizationId ?? null) === (opts.organizationId ?? null)),
  );
  for (const target of targets) {
    const result = computeClosure(target, makeScopedManifestLookup(allRows, target.organizationId));
    // VERSION AWARENESS (#180 item 6): present-but-violating install-blocking
    // deps refuse the fresh install exactly like missing ones.
    if (result.rangeViolations.length > 0) {
      throw new DependencyClosureError(
        "RANGE_VIOLATION",
        `Cannot install ${packageName} — installed dependency versions violate its declared constraints: ` +
          result.rangeViolations
            .map((v) => `${v.packageName}@${v.installedVersion} violates ${v.constraint} (required by ${v.via})`)
            .join("; ") +
          `. Update the violating dependencies to satisfying versions first, then retry.`,
        result.rangeViolations.map((v) => v.packageName),
      );
    }
    if (result.missingRequired.length > 0) {
      const missing = result.missingRequired.map((d) => `${d.packageName} (${d.status})`);
      const names = result.missingRequired.map((d) => d.packageName);
      throw new DependencyClosureError(
        "REQUIRED_MISSING",
        `Cannot install ${packageName} — it requires ${missing.join(", ")}, which ` +
          `dependency auto-install did not put in place (only required runtime/` +
          `install-time edges auto-install; the plan may also have drifted ` +
          `mid-install). Install ${names.join(", ")} first, then retry.`,
        names,
      );
    }
  }
}
