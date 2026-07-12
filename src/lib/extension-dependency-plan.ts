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

import { satisfiesVersionRange, dependencyScopePrefixesFor, comparePluginVersions } from "@cinatra-ai/registries";
import type {
  ExtensionDependency,
  ExtensionOwnerLevel,
  InstalledExtension,
} from "@cinatra-ai/extensions/canonical-types";
import {
  assertUpdateDoesNotBreakDependents,
  DependencyClosureError,
  installedVersionOfRow,
} from "@cinatra-ai/extensions/dependency-closure";

/** One exact-pinned closure member ({name, version}) — structurally identical
 *  to the marketplace authorize closure entries (the vendored
 *  marketplace-mcp-client is banned for new importers; the planner stays
 *  decoupled from the wire package). */
export type DependencyClosurePin = { name: string; version: string };

/**
 * The canonical ROW-OWNERSHIP tuple the planner resolves rows against
 * (cinatra#1039 Phase 1, decision 1) — the `(organizationId, ownerLevel,
 * ownerId)` identity a canonical install row is keyed on (canonical-store's
 * `CanonicalIdentity`). Deliberately named `rowOwnership` (NEVER "scope") to
 * stay visibly distinct from the access-popup's `accessTarget`: this is WHO
 * OWNS the installed row (the conflict/dedupe basis), not who may USE it.
 *
 * On the extension-saga path the caller derives the canonical default
 * (`ownerLevel: orgId ? "organization" : "platform"`); the agent path (Phase 2)
 * threads its real five-level tuple. Decision 4: the ROOT's tuple is forced,
 * immutable, onto every transitive `PlannedMember`.
 */
export type RowOwnership = {
  ownerLevel: ExtensionOwnerLevel;
  ownerId: string | null;
  organizationId: string | null;
};

/**
 * One level of a RESOLVED scope-ancestry chain (cinatra#1039 decision 2). The
 * planner walks the chain IN ORDER; the FIRST level holding a live row of the
 * package is the conflict basis, else the next ancestor, else platform (the
 * chain's LAST element). `matches` selects the live rows AT this level;
 * `organizationId` is the level's org key (the dependent-break admissibility
 * check evaluates at the resolved level's org).
 *
 * The chain is produced by the INJECTED `resolveScopeAncestry` seam — NOT a
 * naive tuple walk: the tuple alone cannot derive project→owning-team ancestry
 * (a project's owning team is `project.owner_id` when `owner_level==="team"`,
 * read via `readProjectById`), so the resolver is a seam. The extension-saga
 * default yields the `[organization, platform]` binary that reproduces the
 * pre-#1039 `findLiveRowsInScope` behavior exactly.
 */
export type ResolvedScopeLevel = {
  /** Debug label, e.g. `"organization:org_x"`, `"team:team_y"`, `"platform"`. */
  label: string;
  /** The org key of rows at this level (dependent-break check scope). */
  organizationId: string | null;
  /** Selects the live rows AT this scope level. */
  matches: (row: InstalledExtension) => boolean;
};

export class DependencyPlanError extends Error {
  constructor(
    public readonly code:
      | "AUTHORIZATION_MISMATCH"
      | "RANGE_VIOLATION"
      | "INSTALLED_VERSION_CONFLICT"
      | "UNSUPPORTED_CONSTRAINT"
      | "MEMBER_UNRESOLVABLE"
      | "NONCONFORMANT_METADATA"
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
  /**
   * The resolved ROW-OWNERSHIP tuple this member is installed/updated at
   * (cinatra#1039 decision 4). This is the ROOT install's tuple, forced
   * IMMUTABLY onto every transitive member — manifests, install callbacks, and
   * existing-row selection may NEVER override it. The executor STAMPS each
   * install/update member at this scope. On the extension-saga path it is the
   * canonical default (`ownerLevel: orgId ? "organization" : "platform"`), so
   * every existing plan carries the same tuple it already installs at
   * (behavior-neutral); the agent path (Phase 2) threads its real tuple.
   */
  rowOwnership: RowOwnership;
  /**
   * How the saga realizes this member (#1039 Option B, dev/non-gatekept path):
   *  - `"install"`: a member NOT present pre-batch — installed fresh; rolled
   *    back (compensated) if a later member fails.
   *  - `"update"`: a shared dependency already installed at an OLDER version
   *    that is a CLEAN dedupe-upward (`upgradable-clean`) — upgraded in place to
   *    the new pin via the durable update pipeline. It is a COMMITTED upgrade:
   *    the compatibility proof (every live dependent admits the pin + the new
   *    version is self-satisfiable in place) makes leaving it at the new version
   *    provably non-breaking, so a later member's failure does NOT roll it back
   *    (only fresh `install` members roll back). Emitted ONLY on the
   *    non-gatekept path; the gatekept path keeps the hard refusal (its
   *    host-computed-set dedupe rides the deferred durable-restore subsystem).
   *  - `"install-side-by-side"` (cinatra#1040 S3): a shared dependency whose
   *    conflict class is `disjoint-dependents` — the admissible-range
   *    intersection is EMPTY (the installed default is OLDER, and at least one
   *    live dependent's edge refuses the pin), so no single version can serve
   *    both. The new version installs SIDE BY SIDE as its own NON-DEFAULT
   *    canonical row (storage + journal + resolved edges only — versioned
   *    runtime activation is the S4 slice; the default keeps every global-name
   *    surface). Emitted ONLY on the non-gatekept path (`closure === null` —
   *    "dev path" is shorthand for non-gatekept throughout this module); EVERY
   *    class on the gatekept path keeps the evidence-carrying hard refusal per
   *    the ratified Option-B contract (#1296 fence untouched). Rolled back
   *    (version-scoped teardown) if a later member fails.
   */
  action: "install" | "update" | "install-side-by-side";
  /**
   * For an `"install-side-by-side"` member: the computed conflict evidence
   * (the live dependents whose edges refuse the pin + the closure engine's
   * dependent+constraint message) — carried so the surface can say WHY the
   * install went side-by-side instead of dedupe-upward.
   */
  sideBySideEvidence?: { dependents: string[]; detail: string };
  /**
   * For an `"install-side-by-side"` member: the RESOLVED conflict row's org
   * scope (codex round-1). The scope resolution may have fallen back to the
   * PLATFORM row (org install, platform default) — the side-by-side row must
   * install NEXT TO that resolved default (same scope), and its version-scoped
   * journal/compensation/sweep must address the same scope, NOT the requesting
   * actor's org (which has no default sibling there).
   */
  sideBySideScopeOrgId?: string | null;
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
  /**
   * cinatra#1039 decision 2: resolve the ordered scope-ancestry fallback chain
   * for the root install's `rowOwnership` tuple (project→owning-team→org→
   * platform). INJECTED — the tuple alone cannot derive project→team ancestry
   * (needs `readProjectById`), so this is a SEAM, never a naive tuple walk.
   *
   * OPTIONAL: when ABSENT the planner falls back to the `[organization,
   * platform]` binary derived from `input.orgId` — the EXACT pre-#1039
   * `findLiveRowsInScope` behavior, so every existing caller/test is unchanged.
   * The extension saga provides the binary explicitly (behavior-neutral); the
   * agent path (Phase 2) provides the real ladder.
   */
  resolveScopeAncestry?: (
    rowOwnership: RowOwnership,
  ) => Promise<ResolvedScopeLevel[]> | ResolvedScopeLevel[];
  /**
   * cinatra#1039 decision 3: before a dedupe-upward MUTATES an existing shared
   * row (emits `action:"update"`), the requesting principal must be
   * INDEPENDENTLY authorized to mutate THAT row's exact scope — `assertCanInstallAtTarget`
   * re-run against the EXISTING ROW's `{level,id}`, not merely satisfied at the
   * requested/root scope. Throws (fail-closed) on deny; the planner then keeps
   * the evidence-carrying INSTALLED_VERSION_CONFLICT refusal (side-by-side at
   * the requesting scope is the #1040 follow-up, not this slice).
   *
   * A thrown DependencyPlanError PROPAGATES unchanged (a planner-domain failure,
   * not an authz deny); any OTHER throw is treated as an authorization DENY and
   * converted to the cross-scope INSTALLED_VERSION_CONFLICT refusal.
   *
   * INJECTED so the planner stays pure: the extension-saga default authorizes
   * its own already-established scope (behavior-neutral — its rows are org-owned
   * and the root auth ran at the org); the agent path (Phase 2) wires
   * `assertCanInstallAtTarget` against the row's `{level,id}`; fail-closed tests
   * inject a denying stub. OPTIONAL: absent = permit (pre-#1039 behavior).
   */
  authorizeExistingRowMutation?: (row: InstalledExtension) => Promise<void> | void;
};

/**
 * The canonical DEFAULT `rowOwnership` (cinatra#1039): an org install is
 * `organization`-owned, a null-org install is `platform`-owned. The value the
 * extension saga derives + passes explicitly, and the fallback the planner
 * applies when a caller omits the tuple — so an absent tuple plans identically.
 */
export function defaultRowOwnership(orgId: string | null): RowOwnership {
  return {
    ownerLevel: orgId ? "organization" : "platform",
    ownerId: orgId ?? null,
    organizationId: orgId ?? null,
  };
}

/**
 * The DEFAULT `[organization, platform]` ancestry chain (cinatra#1039) — the
 * fallback the planner uses when no `resolveScopeAncestry` seam is injected, and
 * the exact chain the extension saga's seam returns. Reproduces the pre-#1039
 * `findLiveRowsInScope` binary EXACTLY: an org install resolves the org's own
 * rows first, else platform; a platform install resolves platform only.
 */
export function defaultOrgPlatformChain(orgId: string | null): ResolvedScopeLevel[] {
  const platform: ResolvedScopeLevel = {
    label: "platform",
    organizationId: null,
    matches: (r) => (r.organizationId ?? null) === null,
  };
  if (orgId === null) return [platform];
  return [
    {
      label: `organization:${orgId}`,
      organizationId: orgId,
      matches: (r) => (r.organizationId ?? null) === orgId,
    },
    platform,
  ];
}

const KNOWN_KINDS = new Set(["agent", "skill", "connector", "artifact", "workflow"]);

/**
 * Resolve a member's dispatch typeId from its declared `cinatra.kind`.
 *
 * `willInstall` distinguishes a member the saga WILL actually install (the root
 * + every to-install dependency) from an already-installed legacy member the
 * saga SKIPS:
 *
 *  - For a member that WILL install, a NULL kind is FAIL-FAST: silently routing
 *    a kind-less package into the "agent" install contract (the old legacy
 *    fallback) only defers the failure to a cryptic downstream Zod reject when
 *    the agent path reads agent-only manifest fields the package never declared
 *    (the opaque "Install failed" #781 describes). A clear, actionable
 *    NONCONFORMANT_METADATA error names the real defect — the publisher must
 *    declare `cinatra.kind` — instead of misrouting. An explicitly UNKNOWN kind
 *    stays a (separate) loud MEMBER_UNRESOLVABLE for the same reason.
 *  - For an already-installed member the saga skips (no dispatch happens), the
 *    legacy null→"agent" fallback is preserved so a stale, kind-less row already
 *    on disk never BLOCKS installing an otherwise-conformant root. The
 *    platform-wide `deriveTypeId` (utils.ts) keeps the same legacy fallback for
 *    uninstall/purge/force_delete of such rows; this is deliberately untouched.
 */
function kindToTypeId(
  kind: string | null,
  packageName: string,
  willInstall: boolean,
): string {
  if (kind === null) {
    if (!willInstall) {
      // Already-installed, saga-SKIPPED legacy row — never dispatched, so the
      // legacy null→agent fallback (mirrors deriveTypeId) is harmless and keeps
      // a kind-less on-disk row from blocking a conformant root install.
      console.warn(
        `[extension-dependency-plan] ${packageName} has no cinatra.kind — assuming "agent" (legacy already-installed fallback; not dispatched)`,
      );
      return "agent";
    }
    throw new DependencyPlanError(
      "NONCONFORMANT_METADATA",
      `${packageName} declares no cinatra.kind — its package metadata is non-conformant and ` +
        `cannot be installed. The publisher must republish ${packageName} with an explicit ` +
        `cinatra.kind (agent, skill, connector, artifact, or workflow).`,
    );
  }
  if (!KNOWN_KINDS.has(kind)) {
    throw new DependencyPlanError(
      "MEMBER_UNRESOLVABLE",
      `${packageName}: unsupported extension kind "${kind}" — cannot dispatch its install.`,
    );
  }
  return kind;
}

/**
 * The live rows a scope-aware install check resolves: the org's own scope wins
 * when it holds ANY live row, else the platform scope. Since cinatra#1040 a
 * scope can hold MULTIPLE version rows of one package (side-by-side), so this
 * returns the full scope SET; `defaultLiveRow` picks the conflict basis.
 */
function findLiveRowsInScope(
  rows: InstalledExtension[],
  packageName: string,
  organizationId: string | null,
): InstalledExtension[] {
  const live = rows.filter(
    (r) => r.packageName === packageName && (r.status === "active" || r.status === "locked"),
  );
  const org = live.filter((r) => (r.organizationId ?? null) === organizationId);
  if (org.length > 0) return org;
  return live.filter((r) => (r.organizationId ?? null) === null);
}

/**
 * LADDER-AWARE scope resolution (cinatra#1039 decision 2): walk the resolved
 * ancestry `chain` in order and return the live rows at the FIRST level holding
 * any, together with WHICH level matched (so the conflict classifier can
 * re-scope its own dependent/self-satisfiability checks to that level via the
 * sub-chain rooted there). Returns `{ rows: [], level: null }` when no level in
 * the chain holds a live row.
 *
 * For the extension-saga default chain `[organization, platform]` this is
 * IDENTICAL to `findLiveRowsInScope(rows, packageName, orgId)`: the org level
 * wins when it holds any live row, else the platform level.
 */
function resolveScopeRows(
  rows: InstalledExtension[],
  packageName: string,
  chain: ResolvedScopeLevel[],
): { rows: InstalledExtension[]; level: ResolvedScopeLevel | null; index: number } {
  const live = rows.filter(
    (r) => r.packageName === packageName && (r.status === "active" || r.status === "locked"),
  );
  for (let i = 0; i < chain.length; i++) {
    const at = live.filter(chain[i]!.matches);
    if (at.length > 0) return { rows: at, level: chain[i]!, index: i };
  }
  return { rows: [], level: null, index: -1 };
}

/**
 * The DEFAULT row of a scope set — the conflict-classification basis
 * (cinatra#1040 S3). A row/fixture without `isDefault` counts as default.
 * Returns null when the set holds no default OR more than one (cross-owner
 * ambiguity) — callers fail closed rather than classifying against an
 * arbitrary owner's install.
 */
function defaultLiveRow(scopeRows: InstalledExtension[]): InstalledExtension | null {
  const defaults = scopeRows.filter((r) => r.isDefault !== false);
  return defaults.length === 1 ? defaults[0]! : null;
}

/** The row's REGISTRY version: the canonical `version` column (S1) when it is a
 *  real registry version, else the verdaccio source version, else null
 *  (presence-only dev/github/local rows — the `0.0.0` floor is presence-only). */
function registryVersionOfRow(row: InstalledExtension): string | null {
  if (typeof row.version === "string" && row.version.length > 0 && row.version !== "0.0.0") {
    return row.version;
  }
  return installedVersionOfRow(row);
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

/**
 * Classification of a member already installed at a version DIFFERENT from the
 * pin the current install requires (the `INSTALLED_VERSION_CONFLICT` site).
 * This is the DEDUPE-UPWARD eligibility analysis (#1039): it decides whether
 * the conflict is a clean upward-dedupe opportunity, a disjoint refusal, or an
 * out-of-scope newer/downgrade case — and CARRIES the computed evidence
 * (conflicting or admitting dependents) so the refusal names them.
 *
 * PURE over its inputs (no I/O) and independent of the install path, so it is
 * unit-testable in isolation and reusable by the dependency-batch executor.
 *
 *  - `installed-newer`: the live version is NEWER than the required pin — a
 *    downgrade / side-by-side concern, explicitly out of scope here.
 *  - `disjoint-dependents`: the live version is OLDER (an upgrade would dedupe
 *    upward) BUT at least one live dependent's install-blocking edge would be
 *    VIOLATED by the pin — no common admissible version exists. `dependents`
 *    names them; `detail` is the closure engine's dependent+constraint message.
 *  - `upgradable-needs-own-deps`: OLDER + every live dependent admits the pin,
 *    BUT the new version's own required closure is NOT already satisfied by
 *    present rows (`unmetDeps`) — an upward-dedupe would have to install/upgrade
 *    the dep's own dependencies, which is not self-satisfiable in place.
 *  - `upgradable-clean`: OLDER + every live dependent admits the pin + the new
 *    version's required closure is already satisfied in place — a clean upward
 *    dedupe (the new version is a valid, non-breaking, self-satisfiable state).
 */
export type InstalledVersionConflictClass =
  | { kind: "installed-newer" }
  | { kind: "disjoint-dependents"; dependents: string[]; detail: string }
  | { kind: "upgradable-needs-own-deps"; unmetDeps: string[] }
  | { kind: "upgradable-clean" };

/**
 * Compute the dedupe-upward eligibility of an installed-version conflict. See
 * {@link InstalledVersionConflictClass}. `newEdges` are the NEW (pin) version's
 * manifest dependency edges; `installedRows` is the pre-install canonical
 * snapshot; `isAutoInstallableEdge` is the shared required-edge predicate.
 *
 * `orgId` is the scope of the RESOLVED conflict row (the row actually
 * installed) — NOT necessarily the requesting install's org: a scope-aware
 * install check resolves the org's own row first, else the platform row, so an
 * org install can conflict with a PLATFORM row. Dependent-admissibility and
 * self-satisfiability are both evaluated at this resolved scope (a platform
 * conflict is checked against platform dependents/rows).
 */
export function classifyInstalledVersionConflict(args: {
  packageName: string;
  installedVersion: string;
  pin: string;
  newEdges: ExtensionDependency[];
  installedRows: InstalledExtension[];
  orgId: string | null;
  isAutoInstallableEdge: (dep: ExtensionDependency) => boolean;
  /**
   * cinatra#1039 decision 2: the resolved scope-ancestry SUB-CHAIN rooted at the
   * CONFLICT ROW's level (that level → … → platform), used to resolve the NEW
   * version's OWN required deps ladder-aware for the self-satisfiability check.
   * OPTIONAL: when absent, each dep resolves via the `[organization, platform]`
   * binary derived from `orgId` (behavior-neutral — the extension-saga default).
   * The dependent-break admissibility check always uses `orgId` (the resolved
   * level's org), unchanged.
   */
  depScopeChain?: ResolvedScopeLevel[];
}): InstalledVersionConflictClass {
  const {
    packageName,
    installedVersion,
    pin,
    newEdges,
    installedRows,
    orgId,
    isAutoInstallableEdge,
    depScopeChain,
  } = args;

  // NEWER (or equal — equal never reaches here) installed than required: a
  // downgrade / side-by-side concern, out of dedupe-upward scope.
  if (comparePluginVersions(installedVersion, pin) !== "update-available") {
    return { kind: "installed-newer" };
  }

  // OLDER installed → an upgrade would dedupe upward. (i) ADMISSIBILITY: does
  // every live dependent's install-blocking edge admit the pin? Reuse the
  // canonical update gate — its error already NAMES the dependents + the exact
  // violated constraints (the conflict evidence outcome 5 requires).
  try {
    assertUpdateDoesNotBreakDependents(packageName, pin, installedRows, { organizationId: orgId });
  } catch (err) {
    if (err instanceof DependencyClosureError && err.code === "UPDATE_BREAKS_DEPENDENTS") {
      return { kind: "disjoint-dependents", dependents: err.dependents, detail: err.message };
    }
    throw err;
  }

  // (ii) TRANSITIVE SELF-SATISFIABILITY: every REQUIRED (auto-installable) edge
  // of the NEW version must ALREADY resolve to a present row at an admissible
  // version — no new install, no chained update. (One level here; the planner's
  // BFS enforces the deeper transitive closure by the same predicate when a
  // dedupe-upward member is actually emitted.)
  const unmetDeps: string[] = [];
  for (const edge of newEdges) {
    if (!isAutoInstallableEdge(edge)) continue;
    // Ladder-aware (decision 2): resolve the dep at the conflict row's level
    // and below via the sub-chain; absent → the org-binary (behavior-neutral).
    const depRows = depScopeChain
      ? resolveScopeRows(installedRows, edge.packageName, depScopeChain).rows
      : findLiveRowsInScope(installedRows, edge.packageName, orgId);
    if (depRows.length === 0) {
      unmetDeps.push(edge.packageName);
      continue;
    }
    // Satisfied when ANY live row in the resolved scope admits the edge
    // (side-by-side versions, cinatra#1040 S3): the write-time edge resolver
    // binds the satisfying sibling. A dev/local-sourced row (no registry
    // version) is presence-only — it satisfies the edge (the planner never
    // auto-reinstalls over it).
    const satisfied = depRows.some((depRow) => {
      const depVersion = registryVersionOfRow(depRow);
      return depVersion === null
        ? true
        : edge.versionConstraint.kind === "semver-range"
          ? edge.versionConstraint.range === "*" ||
            satisfiesVersionRange(depVersion, edge.versionConstraint.range)
          : edge.versionConstraint.kind === "exact"
            ? edge.versionConstraint.version === depVersion
            : false; // git-ref: not satisfiable against a registry version
    });
    if (!satisfied) unmetDeps.push(edge.packageName);
  }
  if (unmetDeps.length > 0) return { kind: "upgradable-needs-own-deps", unmetDeps };
  return { kind: "upgradable-clean" };
}

export type PlanDependencyInstallInput = {
  root: { packageName: string; version: string };
  orgId: string | null;
  /**
   * cinatra#1039 decision 1+4: the ROOT install's resolved ROW-OWNERSHIP tuple,
   * forced immutably onto every transitive member (decision 4) and driving the
   * ladder-aware conflict basis via `deps.resolveScopeAncestry` (decision 2).
   * OPTIONAL: when absent, derived as the canonical default
   * (`defaultRowOwnership(orgId)` = `{ ownerLevel: orgId ? "organization" :
   * "platform", ownerId: orgId, organizationId: orgId }`) — the exact value the
   * extension saga passes explicitly, so an absent tuple plans IDENTICALLY.
   */
  rowOwnership?: RowOwnership;
  /** The marketplace authorize closure (gatekept) — null on the dev path. */
  closure: DependencyClosurePin[] | null;
  /**
   * How the saga realizes the ROOT member (#1039 Option B, update-time slice).
   *  - `"install"` (default): a FRESH root install — the root is exempt from
   *    the installed-version conflict check (installing over an existing root is
   *    the caller's chosen update flow) and installs LAST as a fresh member.
   *  - `"update"`: the caller (`updateExtensionPackage` / `extensions_update` on
   *    the dev/non-gatekept path) is UPDATING an already-installed root in place.
   *    The root member is emitted as a COMMITTED `action:"update"` (routed
   *    through the durable update pipeline), while the NEW version's newly
   *    required dependencies auto-install as fresh members FIRST (dependencies-
   *    first) and a clean shared-dependency dedupe-upward executes as its own
   *    committed update. Honored ONLY on the non-gatekept path (`closure ===
   *    null`); the gatekept update path is the deferred durable-restore slice
   *    (#1296) and keeps the direct in-place update, so the root stays
   *    `action:"install"` there and is never routed through this planner.
   */
  rootAction?: "install" | "update";
};

/**
 * Compute the ordered dependency-install plan. Pure over the injected seams —
 * unit-testable without a registry or DB.
 */
export async function planDependencyInstall(
  input: PlanDependencyInstallInput,
  deps: DependencyPlanDeps,
): Promise<DependencyInstallPlan> {
  const { root, orgId, closure, rootAction = "install" } = input;
  const source = closure ? ("marketplace-closure" as const) : ("manifest-walk" as const);
  const closureByName = new Map((closure ?? []).map((c) => [c.name, c]));
  const installedRows = await deps.readInstalledRows();

  // cinatra#1039 decision 1+4: the ROOT install's rowOwnership tuple — the
  // extension saga passes the canonical default explicitly; an absent tuple is
  // derived to the same default, so plans are identical. Forced IMMUTABLY onto
  // every member emitted below (existing-row selection never overrides it).
  const rowOwnership = input.rowOwnership ?? defaultRowOwnership(orgId);
  // decision 2: resolve the ladder-aware scope-ancestry chain ONCE via the
  // injected seam. ABSENT → the [organization, platform] binary that reproduces
  // the pre-#1039 findLiveRowsInScope behavior exactly (behavior-neutral).
  const scopeChain: ResolvedScopeLevel[] = deps.resolveScopeAncestry
    ? await deps.resolveScopeAncestry(rowOwnership)
    : defaultOrgPlatformChain(orgId);

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
      return await finalizeNode(packageName, pin, summary, edges, requestedBy);
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
    return await finalizeNode(packageName, pin, summary, edges, requestedBy);
  }

  async function finalizeNode(
    packageName: string,
    pin: string,
    summary: MemberSummary,
    edges: ExtensionDependency[],
    requestedBy: { from: string; edge: ExtensionDependency } | null,
  ): Promise<PlannedMember> {
    // 2. Installed check (item 7): same version → skip member; different →
    //    conflict CLASSIFICATION. The ROOT is exempt from the conflict check
    //    (installing/updating over an existing root is the flow the caller
    //    chose) — but on an UPDATE it is realized as a COMMITTED in-place
    //    update member (#1039 Option B update-time slice), routed through the
    //    durable update pipeline instead of a fresh install.
    let alreadyInstalled = false;
    let action: PlannedMember["action"] = "install";
    let sideBySideEvidence: PlannedMember["sideBySideEvidence"];
    let sideBySideScopeOrgId: string | null | undefined;
    if (packageName === root.packageName) {
      // #1039 Option B (update-time): the ROOT of an UPDATE is a committed
      // `action:"update"` member on the non-gatekept path. A fresh install
      // keeps `action:"install"`; the gatekept update path is the deferred
      // durable-restore slice (#1296) and never reaches this planner, so the
      // root there would (defensively) stay a fresh install.
      if (rootAction === "update" && closure === null) {
        action = "update";
      }
    } else {
      // Scope-resolved live SET (cinatra#1040 S3): a scope can hold multiple
      // side-by-side version rows. A row already at the EXACT pin (any
      // sibling) → the member is present, skipped (idempotent re-plans with
      // side-by-side rows installed). Otherwise the conflict basis is the
      // scope's DEFAULT row — ambiguity (0 or >1 defaults across owners)
      // fails closed rather than classifying an arbitrary owner's install.
      // Ladder-aware (decision 2): the FIRST ancestry level holding a live row
      // is the conflict basis. `scopeIndex` locates that level so the classifier
      // re-scopes its own checks to the SUB-CHAIN rooted there. For the
      // extension default `[organization, platform]` this equals the pre-#1039
      // `findLiveRowsInScope(installedRows, packageName, orgId)`.
      const { rows: scopeRows, index: scopeIndex } = resolveScopeRows(
        installedRows,
        packageName,
        scopeChain,
      );
      const atPin = scopeRows.find((r) => registryVersionOfRow(r) === pin);
      const row = atPin ?? (scopeRows.length > 0 ? defaultLiveRow(scopeRows) : null);
      if (scopeRows.length > 0 && row === null) {
        throw new DependencyPlanError(
          "MEMBER_UNRESOLVABLE",
          `${packageName}: ${scopeRows.length} live installed rows in scope but no single DEFAULT ` +
            `version row (cross-owner ambiguity) — cannot classify the installed-version conflict; ` +
            `fail closed.`,
        );
      }
      const installedVersion = row ? registryVersionOfRow(row) : null;
      if (row && installedVersion && installedVersion !== pin) {
        // DEDUPE-UPWARD (#1039, Option B): classify the conflict and CARRY the
        // computed evidence. On the non-gatekept path a CLEAN upward-dedupe
        // (`upgradable-clean` — every live dependent admits the pin AND the new
        // version is self-satisfiable in place) is EXECUTED as an in-place
        // `action:"update"` member instead of refusing: a provably non-breaking,
        // COMMITTED upgrade (the saga leaves it at the new version even if a
        // later member fails). Every other class — and EVERY class on the
        // gatekept path (`closure != null`, whose host-computed-set dedupe rides
        // the deferred durable-restore subsystem) — keeps the evidence-carrying
        // hard refusal (INSTALLED_VERSION_CONFLICT). The refusal now names the
        // conflicting or admitting dependents so the operator knows WHY.
        const conflict = classifyInstalledVersionConflict({
          packageName,
          installedVersion,
          pin,
          newEdges: edges,
          installedRows,
          // The conflict is about the ROW ACTUALLY INSTALLED, which the scope
          // resolution may have bound to the PLATFORM row (org fell back). Admissibility
          // + self-satisfiability MUST be evaluated at THAT row's scope, not the
          // requested `orgId`: a platform-scoped conflict is checked against
          // platform dependents/rows (an org-scoped check would see no target
          // and miss platform dependents, or satisfy new deps from org rows a
          // platform install cannot use).
          orgId: row.organizationId ?? null,
          isAutoInstallableEdge: deps.isAutoInstallableEdge,
          // Resolve the NEW version's own required deps from the conflict row's
          // level downward (decision 2). Behavior-neutral for the extension
          // default (the sub-chain is [organization, platform] or [platform]).
          depScopeChain: scopeIndex >= 0 ? scopeChain.slice(scopeIndex) : undefined,
        });
        // Option B execution: a CLEAN dedupe-upward on the non-gatekept path is
        // realized as a committed in-place update, NOT a refusal. `closure` is
        // non-null only on the gatekept path — there the compatibility proof is
        // still a hard REFUSE-UP-FRONT gate (durable-restore is deferred), so the
        // switch below runs for every class as before.
        if (conflict.kind === "upgradable-clean" && closure === null) {
          // DECISION 3 (cinatra#1039): a dedupe-upward MUTATES the existing
          // shared row, so before emitting the committed `action:"update"` the
          // requesting principal must be INDEPENDENTLY authorized to mutate THAT
          // ROW's exact scope — re-authorized against the EXISTING ROW, not
          // merely satisfied at the requested/root scope (a team request must
          // not upgrade a project-scoped row without proving authorization for
          // that project). Unauthorized → keep the evidence-carrying
          // INSTALLED_VERSION_CONFLICT refusal (side-by-side at the requesting
          // scope is the #1040 follow-up). The extension-saga authorizer permits
          // its own already-established org scope (behavior-neutral); the agent
          // path (Phase 2) wires assertCanInstallAtTarget against the row.
          let rowMutationAuthorized = true;
          if (deps.authorizeExistingRowMutation) {
            try {
              await deps.authorizeExistingRowMutation(row);
            } catch (err) {
              // A planner-domain error propagates unchanged; any OTHER throw is
              // treated as an authorization DENY → the cross-scope refusal below.
              if (err instanceof DependencyPlanError) throw err;
              rowMutationAuthorized = false;
            }
          }
          if (rowMutationAuthorized) {
            action = "update";
          } else {
            const requestedFrom = requestedBy?.from ?? root.packageName;
            throw new DependencyPlanError(
              "INSTALLED_VERSION_CONFLICT",
              `${packageName} is already installed at ${installedVersion} in an ownership scope ` +
                `you are not authorized to modify (owner-level ${row.ownerLevel}` +
                `${row.ownerId ? `, owner ${row.ownerId}` : ""}, org ${row.organizationId ?? "platform"}), ` +
                `but ${requestedFrom} needs it at ${pin} — refusing to upgrade a shared dependency ` +
                `row across an ownership scope you do not control. Install ${pin} at your own scope, ` +
                `or have an admin of that scope update ${packageName} to ${pin} first.`,
            );
          }
        } else if (conflict.kind === "disjoint-dependents" && closure === null) {
          // SIDE-BY-SIDE (cinatra#1040 S3, non-gatekept path only): the
          // admissible-range intersection is EMPTY — the installed default is
          // older AND at least one live dependent's edge refuses the pin, so
          // neither dedupe-upward nor staying put can serve every dependent.
          // Instead of the evidence-carrying refusal, the new version installs
          // SIDE BY SIDE as its own NON-DEFAULT canonical row; the write-time
          // edge resolver binds the new dependent to it, while the default row
          // keeps every global-name surface (versioned runtime activation is
          // the S4 slice). The gatekept path (`closure !== null`) keeps the
          // hard refusal below for EVERY class — ratified Option-B contract,
          // #1296 fence untouched.
          action = "install-side-by-side";
          sideBySideEvidence = { dependents: conflict.dependents, detail: conflict.detail };
          // The RESOLVED basis row's scope (may be the platform fallback).
          sideBySideScopeOrgId = row.organizationId ?? null;
        } else {
        const requestedFrom = requestedBy?.from ?? root.packageName;
        const base =
          `${packageName} is already installed at ${installedVersion}, but ` +
          `${requestedFrom} needs it at ${pin} — refusing to silently change an installed version.`;
        let detail: string;
        switch (conflict.kind) {
          case "disjoint-dependents":
            detail =
              ` The installed version is OLDER, but upgrading it to ${pin} would break ` +
              `installed dependent(s) whose declared ranges do not admit ${pin}: ` +
              `${conflict.detail} Update the named dependent(s) to versions that admit ` +
              `${pin} first, or keep ${packageName} at a satisfying version.`;
            break;
          case "upgradable-needs-own-deps":
            detail =
              ` The installed version is OLDER and every installed dependent admits ${pin}, ` +
              `but ${packageName}@${pin} needs dependencies not yet installed in a satisfying ` +
              `state (${conflict.unmetDeps.join(", ")}). Install those first, then update ` +
              `${packageName} to ${pin} (extensions_update ${packageName}@${pin}) and retry.`;
            break;
          case "upgradable-clean":
            // Reached ONLY on the gatekept path (the non-gatekept path took the
            // execute-as-update branch above): a clean dedupe-upward the
            // gatekept host-computed-set dedupe (deferred) would resolve, but
            // which is refused here for now.
            detail =
              ` The installed version is OLDER, every installed dependent admits ${pin}, and ` +
              `${packageName}@${pin} needs no new dependencies — update ${packageName} to ${pin} ` +
              `explicitly (extensions_update ${packageName}@${pin}) and retry this install.`;
            break;
          case "installed-newer":
            detail =
              ` The installed version is NEWER than ${pin} — refusing to downgrade. Pin ` +
              `${requestedFrom} to a range that admits ${installedVersion}, or remove ` +
              `${packageName} first if a downgrade is truly intended.`;
            break;
        }
        throw new DependencyPlanError("INSTALLED_VERSION_CONFLICT", base + detail);
        }
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
      // A null kind FAILS FAST for any member the saga will actually install
      // (the root is never alreadyInstalled, so it is always checked); an
      // already-installed, saga-skipped legacy row keeps the legacy fallback.
      typeId: kindToTypeId(summary.kind, packageName, !alreadyInstalled),
      edges,
      alreadyInstalled,
      // decision 4: the ROOT install's tuple, forced IMMUTABLY onto EVERY member
      // (existing-row selection above never overrides it — `row` informs the
      // conflict class, not the member's ownership).
      rowOwnership,
      action,
      ...(sideBySideEvidence ? { sideBySideEvidence } : {}),
      ...(sideBySideScopeOrgId !== undefined ? { sideBySideScopeOrgId } : {}),
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
