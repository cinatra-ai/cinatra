import "server-only";

// Dependency-install PLANNER (#180 PR-2, items 1/3/7).
//
// Given a ROOT install request, produce the ordered (DEPENDENCIES-FIRST,
// root LAST) exact-pinned to-install plan:
//
//  - The marketplace authorize closure (gatekept path) is the AUTHORIZATION
//    SET, not the install order: membership says what the grant may read,
//    nothing more. The to-install set is computed HERE: the closure walk over
//    manifest edges, FILTERED by the shared `isAutoInstallableEdge` predicate
//    (required runtime/install-time edges auto-install; PEER and OPTIONAL
//    edges NEVER do — their semantics are activation-time / per-kind).
//  - On the gatekept path every reached member must appear in the authorize
//    closure (a member outside it = AUTHORIZATION MISMATCH, fail-loud) and is
//    pinned at the closure's exact version. On the dev/non-gatekept path the
//    SAME walk runs with versions resolved against the registry — identical
//    semantics, no marketplace.
//  - RANGE CROSS-CHECK (item 7, version model v1): every edge's constraint
//    must be SATISFIED by the target's pin (semver-range → semver.satisfies;
//    exact → equality; git-ref → REFUSED, v1 supports registry coordinates
//    only). Fail-loud — server-side range RESOLUTION is explicitly v2.
//  - INSTALLED-VERSION CONFLICTS (item 7): a member already installed at a
//    DIFFERENT version than its pin fails with a precise upgrade instruction
//    — no silent upgrades. Already-installed-at-pin members are recorded
//    (`alreadyInstalled`) and skipped by the saga.
//  - TOPO ORDER: Kahn over the auto-installable edges among {root ∪
//    to-install}, DEPENDENCIES FIRST (an edge a→b means b installs before a);
//    deterministic lexicographic tie-break (test-pinned). A cycle cannot
//    enter via publish-side induction; defensively, the cyclic remainder is
//    appended in lexicographic order with a loud warning — the per-member
//    forward install gate stays the enforcement boundary.

import { satisfiesVersionRange, dependencyScopePrefixesFor } from "@cinatra-ai/registries";
import type { ExtensionDependency, InstalledExtension } from "@cinatra-ai/extensions/canonical-types";

/** One exact-pinned closure member ({name, version}) — structurally identical
 *  to the marketplace authorize closure entries (the vendored
 *  marketplace-mcp-client is banned for new importers; the planner stays
 *  decoupled from the wire package). */
export type DependencyClosurePin = { name: string; version: string };

export class DependencyPlanError extends Error {
  constructor(
    public readonly code:
      | "AUTHORIZATION_MISMATCH"
      | "RANGE_VIOLATION"
      | "INSTALLED_VERSION_CONFLICT"
      | "UNSUPPORTED_CONSTRAINT"
      | "MEMBER_UNRESOLVABLE"
      | "DEPENDENCY_SCOPE",
    message: string,
  ) {
    super(message);
    this.name = "DependencyPlanError";
  }
}

export type PlannedMember = {
  packageName: string;
  /** Exact pin. */
  version: string;
  /** Registry dispatch typeId (kind-derived; legacy null kind → "agent"). */
  typeId: string;
  /** The member's own manifest edges (dual-read) — drives the topo order. */
  edges: ExtensionDependency[];
  /** Already installed at exactly the pinned version — the saga skips it. */
  alreadyInstalled: boolean;
};

export type DependencyInstallPlan = {
  /** DEPENDENCIES FIRST; the root is ALWAYS the last entry. */
  ordered: PlannedMember[];
  root: { packageName: string; version: string };
  source: "marketplace-closure" | "manifest-walk";
  /** Kind per member (for the grant context's derived member resolutions). */
  memberKinds: Map<string, "agent" | "skill" | "connector" | "artifact" | "workflow">;
};

export type MemberSummary = {
  resolvedVersion: string;
  kind: "agent" | "skill" | "connector" | "artifact" | "workflow" | null;
  /** The resolved version's manifest (packument entry — carries `cinatra`). */
  manifest: unknown;
};

export type DependencyPlanDeps = {
  /**
   * Fetch a member's packument summary at an EXACT version (gatekept pins)
   * or a range/dist-tag (dev resolution). On the gatekept path this read
   * MUST ride the root grant (the caller runs the planner inside the grant
   * context, so the default registry readers derive the broker config).
   */
  fetchSummary: (packageName: string, versionOrRange: string) => Promise<MemberSummary>;
  /** Parse manifest dependency edges (the PR-1 dual-read helper). */
  parseEdges: (manifest: unknown, packageName: string) => ExtensionDependency[];
  /** Shared auto-install predicate (PR-1). */
  isAutoInstallableEdge: (dep: ExtensionDependency) => boolean;
  /** Canonical rows snapshot (scope-aware install check). */
  readInstalledRows: () => Promise<InstalledExtension[]>;
};

const KNOWN_KINDS = new Set(["agent", "skill", "connector", "artifact", "workflow"]);

function kindToTypeId(kind: string | null, packageName: string): string {
  if (kind === null) {
    // Legacy packages predating cinatra.kind — mirrors deriveTypeId's fallback.
    console.warn(
      `[extension-dependency-plan] ${packageName} has no cinatra.kind — assuming "agent" (legacy fallback)`,
    );
    return "agent";
  }
  if (!KNOWN_KINDS.has(kind)) {
    throw new DependencyPlanError(
      "MEMBER_UNRESOLVABLE",
      `${packageName}: unsupported extension kind "${kind}" — cannot dispatch its install.`,
    );
  }
  return kind;
}

/** The live row a scope-aware install check resolves: the org's own row wins, else the platform row. */
function findLiveRow(
  rows: InstalledExtension[],
  packageName: string,
  organizationId: string | null,
): InstalledExtension | null {
  const live = rows.filter(
    (r) => r.packageName === packageName && (r.status === "active" || r.status === "locked"),
  );
  return (
    live.find((r) => (r.organizationId ?? null) === organizationId) ??
    live.find((r) => (r.organizationId ?? null) === null) ??
    null
  );
}

/** Item-7 cross-check: the target's exact pin must SATISFY the edge's constraint. */
function assertPinSatisfiesConstraint(
  from: string,
  dep: ExtensionDependency,
  pin: string,
): void {
  const vc = dep.versionConstraint;
  if (vc.kind === "git-ref") {
    throw new DependencyPlanError(
      "UNSUPPORTED_CONSTRAINT",
      `${from} declares a git-ref constraint on ${dep.packageName} — git-ref dependency ` +
        `targets are not installable from the registry (version model v1 supports ` +
        `registry coordinates only). Republish ${from} with a semver range or exact version.`,
    );
  }
  if (vc.kind === "exact") {
    if (vc.version !== pin) {
      throw new DependencyPlanError(
        "RANGE_VIOLATION",
        `${from} requires ${dep.packageName}@${vc.version} exactly, but the resolved pin is ` +
          `${pin} — refusing (exact pins must satisfy manifest constraints; server-side ` +
          `re-resolution is not performed in v1).`,
      );
    }
    return;
  }
  // semver-range
  if (vc.range !== "*" && !satisfiesVersionRange(pin, vc.range)) {
    throw new DependencyPlanError(
      "RANGE_VIOLATION",
      `${from} requires ${dep.packageName}@"${vc.range}", but the resolved pin is ${pin} — ` +
        `refusing (the pin must satisfy every declared range; fix the manifest range or ` +
        `publish a satisfying version).`,
    );
  }
}

export type PlanDependencyInstallInput = {
  root: { packageName: string; version: string };
  orgId: string | null;
  /** The marketplace authorize closure (gatekept) — null on the dev path. */
  closure: DependencyClosurePin[] | null;
};

/**
 * Compute the ordered dependency-install plan. Pure over the injected seams —
 * unit-testable without a registry or DB.
 */
export async function planDependencyInstall(
  input: PlanDependencyInstallInput,
  deps: DependencyPlanDeps,
): Promise<DependencyInstallPlan> {
  const { root, orgId, closure } = input;
  const source = closure ? ("marketplace-closure" as const) : ("manifest-walk" as const);
  const closureByName = new Map((closure ?? []).map((c) => [c.name, c]));
  const installedRows = await deps.readInstalledRows();

  // DEPENDENCY-CONFUSION GATE (#157 / #103): confine the resolved tree to the
  // ROOT package's own vendor scope + the first-party base scope. The agent
  // resolver this planner SUPERSEDES inside the saga (installPackageWithDependencies)
  // applied this exact allowlist to every resolved node; without it here, a
  // saga-driven install (notably the dev/non-gatekept path, which has no
  // marketplace-closure membership gate) could auto-install an arbitrary,
  // attacker-chosen package scope a manifest edge names. Keyed on the root —
  // not on the installing instance's namespace — so ANY instance can install
  // first-party @cinatra-ai/* deps and a vendor package can depend on the
  // first-party base layer (issue #103). The gatekept path's
  // AUTHORIZATION_MISMATCH closure check is strictly stronger and runs in
  // addition; this gate is the floor for every path.
  const scopePrefixes = dependencyScopePrefixesFor(root.packageName);
  const assertInDependencyScope = (packageName: string, requestedFrom: string): void => {
    if (!scopePrefixes.some((prefix) => packageName.startsWith(prefix))) {
      throw new DependencyPlanError(
        "DEPENDENCY_SCOPE",
        `${requestedFrom} requires ${packageName}, which is outside the dependency-scope ` +
          `allowlist for ${root.packageName} (${scopePrefixes.join(", ")}) — refusing ` +
          `(dependency-confusion mitigation: an install's dependency tree is confined to the ` +
          `root package's own vendor scope plus the first-party base scope).`,
      );
    }
  };

  // node name -> resolved member info (root included; resolution memoized).
  const resolved = new Map<string, PlannedMember>();
  const memberKinds: DependencyInstallPlan["memberKinds"] = new Map();

  async function resolveNode(
    packageName: string,
    requestedBy: { from: string; edge: ExtensionDependency } | null,
  ): Promise<PlannedMember> {
    const memo = resolved.get(packageName);
    if (memo) {
      if (requestedBy) assertPinSatisfiesConstraint(requestedBy.from, requestedBy.edge, memo.version);
      return memo;
    }

    // 0. DEPENDENCY-CONFUSION GATE: every node — root AND every transitive
    //    dependency — must fall under the root's dependency-scope allowlist
    //    (mirrors the registries resolver this planner replaces inside the
    //    saga). A SCOPED root passes via its own scope (always in the
    //    allowlist); an UNSCOPED/malformed root is intentionally refused (same
    //    as the old resolver's root check). The gate's teeth are on
    //    out-of-scope dependency edges.
    assertInDependencyScope(packageName, requestedBy?.from ?? root.packageName);

    // 1. Determine the exact pin. The ROOT is exact-pinned ONLY on the
    //    gatekept path (the authorize result resolved the listed version); on
    //    the dev path the caller may pass "latest"/a dist-tag, so the root
    //    rides the SAME registry-resolution branch as members.
    let pin: string;
    if (packageName === root.packageName && closure) {
      pin = root.version;
    } else if (closure) {
      const entry = closureByName.get(packageName);
      if (!entry) {
        throw new DependencyPlanError(
          "AUTHORIZATION_MISMATCH",
          `${requestedBy?.from ?? root.packageName} requires ${packageName}, which is NOT a ` +
            `member of the marketplace-authorized closure for ${root.packageName}@${root.version} — ` +
            `refusing (the authorization set and the manifest walk disagree; the storefront ` +
            `listing may be stale).`,
        );
      }
      pin = entry.version;
    } else {
      // Dev path (root AND members): resolve the constraint against the
      // registry — the root's "constraint" is the caller's version argument
      // (exact, dist-tag, or absent→latest).
      const constraint =
        requestedBy === null
          ? root.version
          : requestedBy.edge.versionConstraint.kind === "exact"
            ? requestedBy.edge.versionConstraint.version
            : requestedBy.edge.versionConstraint.kind === "semver-range"
              ? requestedBy.edge.versionConstraint.range
              : null;
      if (constraint === null) {
        // git-ref — assertPinSatisfiesConstraint below produces the precise error.
        assertPinSatisfiesConstraint(requestedBy!.from, requestedBy!.edge, "0.0.0");
        throw new Error("unreachable");
      }
      const summary = await deps.fetchSummary(packageName, constraint);
      pin = summary.resolvedVersion;
      // Memoize the summary-derived fields below via the same fetch.
      const edges = deps.parseEdges(summary.manifest, packageName);
      if (requestedBy) assertPinSatisfiesConstraint(requestedBy.from, requestedBy.edge, pin);
      return finalizeNode(packageName, pin, summary, edges, requestedBy);
    }

    if (requestedBy) assertPinSatisfiesConstraint(requestedBy.from, requestedBy.edge, pin);
    const summary = await deps.fetchSummary(packageName, pin);
    if (summary.resolvedVersion !== pin) {
      throw new DependencyPlanError(
        "MEMBER_UNRESOLVABLE",
        `${packageName}: the registry resolved ${summary.resolvedVersion} for the exact pin ` +
          `${pin} — refusing (pin/read drift).`,
      );
    }
    const edges = deps.parseEdges(summary.manifest, packageName);
    return finalizeNode(packageName, pin, summary, edges, requestedBy);
  }

  function finalizeNode(
    packageName: string,
    pin: string,
    summary: MemberSummary,
    edges: ExtensionDependency[],
    requestedBy: { from: string; edge: ExtensionDependency } | null,
  ): PlannedMember {
    // 2. Installed check (item 7): same version → skip member; different →
    //    precise conflict refusal. The ROOT is exempt (installing over an
    //    existing root is the update flow the caller chose).
    let alreadyInstalled = false;
    if (packageName !== root.packageName) {
      const row = findLiveRow(installedRows, packageName, orgId);
      const installedVersion =
        row?.source && (row.source as { version?: string }).version
          ? (row.source as { version: string }).version
          : null;
      if (row && installedVersion && installedVersion !== pin) {
        throw new DependencyPlanError(
          "INSTALLED_VERSION_CONFLICT",
          `${packageName} is already installed at ${installedVersion}, but ` +
            `${requestedBy?.from ?? root.packageName} needs it at ${pin} — refusing to ` +
            `silently change an installed version. To proceed, update ${packageName} to ` +
            `${pin} explicitly (extensions_update ${packageName}@${pin}) and retry this install.`,
        );
      }
      if (row && (installedVersion === null || installedVersion === pin)) {
        // A live row with no verdaccio version (dev/local source) counts as
        // present — never auto-reinstall over a dev-managed install.
        alreadyInstalled = true;
      }
    }
    const member: PlannedMember = {
      packageName,
      version: pin,
      typeId: kindToTypeId(summary.kind, packageName),
      edges,
      alreadyInstalled,
    };
    if (summary.kind) memberKinds.set(packageName, summary.kind);
    resolved.set(packageName, member);
    return member;
  }

  // BFS the auto-installable closure from the root.
  const rootMember = await resolveNode(root.packageName, null);
  const queue: PlannedMember[] = [rootMember];
  const enqueued = new Set([root.packageName]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of current.edges) {
      if (!deps.isAutoInstallableEdge(edge)) continue;
      const target = await resolveNode(edge.packageName, {
        from: current.packageName,
        edge,
      });
      if (!enqueued.has(target.packageName)) {
        enqueued.add(target.packageName);
        // Recurse into an already-installed member too: its own edges were
        // gate-checked at ITS install, but the cross-check of MY edge against
        // ITS pin already ran in resolveNode; no need to walk its subtree —
        // its closure is guaranteed by its own forward gate.
        if (!target.alreadyInstalled) queue.push(target);
      }
    }
  }

  // 3. Topo order (Kahn): dependencies first, lexicographic tie-break.
  const nodes = [...resolved.values()];
  const names = new Set(nodes.map((n) => n.packageName));
  const dependsOn = new Map<string, Set<string>>(); // node -> in-plan deps
  for (const n of nodes) {
    dependsOn.set(
      n.packageName,
      new Set(
        n.edges
          .filter((e) => deps.isAutoInstallableEdge(e) && names.has(e.packageName))
          .map((e) => e.packageName),
      ),
    );
  }
  const ordered: PlannedMember[] = [];
  const placed = new Set<string>();
  let remaining = nodes.map((n) => n.packageName).sort();
  while (remaining.length > 0) {
    const ready = remaining.filter((name) => {
      const deps_ = dependsOn.get(name)!;
      return [...deps_].every((d) => placed.has(d));
    });
    if (ready.length === 0) {
      // Defensive cycle fallback: deterministic lexicographic order + loud warning.
      console.warn(
        `[extension-dependency-plan] dependency CYCLE among ${remaining.join(", ")} — ` +
          `installing in lexicographic order (the forward install gate remains the boundary).`,
      );
      for (const name of remaining) {
        ordered.push(resolved.get(name)!);
        placed.add(name);
      }
      remaining = [];
      break;
    }
    // Root NEVER places before all its in-plan deps are placed; among ready
    // nodes the root goes LAST (deterministic; the root closes the batch).
    const nextName =
      ready.find((n) => n !== root.packageName) ?? ready[0]!;
    ordered.push(resolved.get(nextName)!);
    placed.add(nextName);
    remaining = remaining.filter((n) => n !== nextName);
  }
  // Invariant: the root is the last entry (its deps all precede it; any
  // non-dependent siblings sort before it via the root-last ready rule).
  const rootIdx = ordered.findIndex((m) => m.packageName === root.packageName);
  if (rootIdx !== ordered.length - 1) {
    const [r] = ordered.splice(rootIdx, 1);
    ordered.push(r!);
  }

  // Surface the RESOLVED root version (dev "latest" → concrete) so the saga's
  // ledger/result/refresh messaging never carries a moving tag.
  const resolvedRoot = {
    packageName: root.packageName,
    version: resolved.get(root.packageName)!.version,
  };
  return { ordered, root: resolvedRoot, source, memberKinds };
}
