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

/**
 * Boot diagnostics: scan a full manifest snapshot for any `active | locked` row
 * whose REQUIRED dependency closure is broken (a required dep is archived or
 * missing). PURE + non-throwing — instrumentation calls this at boot and LOGS
 * the result (it does NOT remediate). The lookup is built from the same rows,
 * so only `active | locked` rows count as present (an archived dep is missing).
 */
export function findBrokenClosures(
  rows: InstalledExtension[],
): { packageName: string; missingRequired: string[] }[] {
  const lookup: ManifestLookup = (name) =>
    rows.find((r) => r.packageName === name && PRESENT_STATUSES.has(r.status));
  const broken: { packageName: string; missingRequired: string[] }[] = [];
  for (const row of rows) {
    if (!PRESENT_STATUSES.has(row.status)) continue;
    const result = computeClosure(row, lookup);
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
