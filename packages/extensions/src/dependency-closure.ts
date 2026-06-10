// Extension-to-extension dependency closure.
//
// Dependencies are declared on the canonical manifest row as
// ExtensionDependency[] (see canonical-types.ts). The closure is computed
// over `active | locked` rows only — an `archived` dependency counts as
// MISSING. Required-missing fails install + blocks archive/uninstall/restore
// when the resulting closure would break. Optional-missing has per-kind
// declared behavior.
import "server-only";

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

export type ClosureResult = {
  ok: boolean;
  /** Required deps that are missing or archived (closure-breaking). */
  missingRequired: ClosureNode[];
  /** Optional deps that are missing or archived (per-kind behavior governs). */
  missingOptional: ClosureNode[];
  /** Full visited set, for diagnostics. */
  visited: string[];
};

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

  const stack: { deps: ExtensionDependency[] }[] = [{ deps: root.dependencies }];
  visited.add(root.packageName);

  while (stack.length > 0) {
    const { deps } = stack.pop()!;
    for (const dep of deps) {
      const installed = lookup(dep.packageName);
      const present = installed && PRESENT_STATUSES.has(installed.status);

      if (!present) {
        const node: ClosureNode = {
          packageName: dep.packageName,
          status: installed ? installed.status : "missing",
          kind: installed?.kind,
        };
        if (dep.requirement === "required") missingRequired.push(node);
        else missingOptional.push(node);
        // Do not recurse into a missing/archived dependency.
        continue;
      }

      if (!visited.has(dep.packageName)) {
        visited.add(dep.packageName);
        stack.push({ deps: installed!.dependencies });
      }
    }
  }

  return {
    ok: missingRequired.length === 0,
    missingRequired,
    missingOptional,
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
  const advisory: OptionalMissingAdvisory | null =
    result.missingOptional.length > 0
      ? {
          kind: target.kind,
          behavior: optionalMissingBehaviorForKind(target.kind),
          missingOptional: result.missingOptional,
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
): { packageName: string; missingRequired: string[] }[] {
  const broken: { packageName: string; missingRequired: string[] }[] = [];
  for (const row of rows) {
    if (!PRESENT_STATUSES.has(row.status)) continue;
    const result = computeClosure(row, makeScopedManifestLookup(rows, row.organizationId));
    if (result.missingRequired.length > 0) {
      broken.push({
        packageName: row.packageName,
        missingRequired: result.missingRequired.map((d) => d.packageName),
      });
    }
  }
  return broken;
}

export class DependencyClosureError extends Error {
  constructor(
    public readonly code: "REQUIRED_MISSING" | "ARCHIVE_BREAKS_CLOSURE",
    message: string,
    public readonly dependents: string[],
  ) {
    super(message);
    this.name = "DependencyClosureError";
  }
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
    const requiresTarget = row.dependencies.some(
      (d) => d.packageName === target.packageName && d.requirement === "required",
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
