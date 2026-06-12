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
  const missingPeer: ClosureNode[] = [];

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
    missingPeer,
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
    // Same predicate as the install gate: only an INSTALL-BLOCKING edge
    // (required runtime/install-time) blocks the archive — a peer edge is a
    // coexistence constraint, not a presence requirement, so it never holds
    // its target hostage.
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
 * TEMPORARY refusal copy: dependency AUTO-INSTALL is the next stage of #180
 * (the dependency phase / batch saga). Until it lands, this gate is
 * deliberately fail-LOUD with an actionable instruction instead of the
 * pre-#180 silent success that left a broken closure for the boot gate to
 * find. The copy is updated when the dependency phase ships.
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
    if (result.missingRequired.length > 0) {
      const missing = result.missingRequired.map((d) => `${d.packageName} (${d.status})`);
      const names = result.missingRequired.map((d) => d.packageName);
      throw new DependencyClosureError(
        "REQUIRED_MISSING",
        `Cannot install ${packageName} — it requires ${missing.join(", ")}. ` +
          `Dependency auto-install lands in the next stage of #180; install ` +
          `${names.join(", ")} first, then retry.`,
        names,
      );
    }
  }
}
