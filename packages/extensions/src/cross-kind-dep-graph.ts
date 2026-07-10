import "server-only";

// ---------------------------------------------------------------------------
// Cross-Kind Dependency Lifecycle (machinery).
//
// One directed graph spanning extension KINDS:
//   - an `artifact` extension's `agentDependencies: string[]` → agent pkgs
//     its authoring/validator/enricher skills may invoke;
//   - an `agent` extension's `produces: SemanticArtifactRef[]` → artifact
//     extensions it emits typed outputs for.
//
// This module is PURE (no IO, no registry/db imports — operates on plain
// declared package names) so it is exhaustively unit-testable; the install/
// uninstall lifecycle callers feed it the installed set. It implements the
// cross-kind uninstall safety rule: uninstall must never silently delete a
// semantic type still in use by agents or artifacts.
//
// Validation posture is **registry-aware SOFT**: a declaration
// may reference a not-yet-installed extension without failing install
// (seed packs land later). The soft→STRICT flip is deferred.
//
// RATIFIED (cinatra#1059): for the agent→artifact `produces` edge the flip is
// NOT deferred pending work — it is DECIDED to stay SOFT (advisory). `produces`
// is optional-by-construction: a run completes and is useful without the
// artifact extension; only typed materialization degrades (see
// `src/lib/artifacts/run-artifact-materializer.ts`). Its FIRST production
// consumer is the produced-artifact advisory co-located at the bottom of this
// module (a non-blocking install-time advisory), NOT an install-blocking or
// auto-install caller. The reverse
// artifact→agent `agentDependencies` field (the semantic-manifest one, NOT the
// deprecated legacy agent-package `cinatra.agentDependencies` map) is KEPT as
// the dormant reverse advisory edge feeding this same graph.
//
// This module exposes `mode` so the flip is a one-line caller
// change, never a rewrite.
// ---------------------------------------------------------------------------

export type CrossKindNode = {
  packageName: string;
  kind: "artifact" | "agent" | "skill" | "connector";
  /** artifact extensions only — agent package names this artifact may invoke. */
  agentDependencies?: string[];
  /** agent extensions only — artifact package names this agent produces. */
  produces?: string[];
};

export type CrossKindGraph = {
  /** packageName → node */
  nodes: Map<string, CrossKindNode>;
  /** packageName → set of packageNames it depends on (cross-kind edges) */
  edges: Map<string, Set<string>>;
};

export function buildCrossKindGraph(nodes: CrossKindNode[]): CrossKindGraph {
  const nodeMap = new Map<string, CrossKindNode>();
  const edges = new Map<string, Set<string>>();
  for (const n of nodes) {
    nodeMap.set(n.packageName, n);
    if (!edges.has(n.packageName)) edges.set(n.packageName, new Set());
  }
  for (const n of nodes) {
    const out = edges.get(n.packageName)!;
    for (const dep of n.agentDependencies ?? []) out.add(dep);
    for (const dep of n.produces ?? []) out.add(dep);
  }
  return { nodes: nodeMap, edges };
}

export type InstallResolution = {
  ok: boolean;
  /** declared deps that ARE present in the (graph ∪ installed) universe */
  resolved: string[];
  /** declared deps NOT yet present (soft: warned, not fatal; strict: fatal) */
  unresolved: string[];
  mode: "soft" | "strict";
};

/**
 * Resolve a package's declared cross-kind deps against the known universe
 * (graph nodes ∪ an optional already-installed set). SOFT (default) never
 * fails on unresolved refs; STRICT flips `ok` to false when any
 * dep is unresolved.
 */
export function resolveInstall(
  graph: CrossKindGraph,
  pkg: CrossKindNode,
  opts?: { installed?: ReadonlySet<string>; mode?: "soft" | "strict" },
): InstallResolution {
  const mode = opts?.mode ?? "soft";
  const universe = new Set<string>(graph.nodes.keys());
  for (const k of opts?.installed ?? []) universe.add(k);
  const declared = [...(pkg.agentDependencies ?? []), ...(pkg.produces ?? [])];
  const resolved: string[] = [];
  const unresolved: string[] = [];
  for (const d of declared) (universe.has(d) ? resolved : unresolved).push(d);
  return { ok: mode === "soft" ? true : unresolved.length === 0, resolved, unresolved, mode };
}

export type UninstallDecision =
  | { action: "block"; dependents: string[]; reason: string }
  | { action: "archive"; reason: string }
  | { action: "remove"; reason: string };

/**
 * Block-or-archive on uninstall. If any INSTALLED package declares a
 * cross-kind dependency on `pkg` → BLOCK (listing the dependents). Else, if
 * `pkg` is an artifact extension with live artifact rows → ARCHIVE (keep the
 * type resolvable for replay — matches the artifact-handler doctrine).
 * Otherwise → REMOVE.
 */
export function decideUninstall(
  graph: CrossKindGraph,
  pkg: string,
  opts?: { installed?: ReadonlySet<string>; hasLiveArtifactRows?: boolean },
): UninstallDecision {
  const installed = opts?.installed ?? new Set(graph.nodes.keys());
  const dependents: string[] = [];
  for (const [name, deps] of graph.edges) {
    if (name === pkg) continue;
    if (!installed.has(name)) continue;
    if (deps.has(pkg)) dependents.push(name);
  }
  if (dependents.length > 0) {
    return {
      action: "block",
      dependents: dependents.sort(),
      reason: `uninstall blocked — ${dependents.length} installed extension(s) depend on "${pkg}" across kinds`,
    };
  }
  if (opts?.hasLiveArtifactRows) {
    return {
      action: "archive",
      reason: `"${pkg}" has live artifact rows — archived (kept resolvable for replay), not removed`,
    };
  }
  return { action: "remove", reason: `no installed dependents and no live rows — safe to remove "${pkg}"` };
}

/** All directed cycles across the cross-kind edges (DFS, path-stack). */
export function detectCycles(graph: CrossKindGraph): string[][] {
  const cycles: string[][] = [];
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  for (const k of graph.nodes.keys()) color.set(k, WHITE);
  const stack: string[] = [];
  const dfs = (u: string): void => {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of graph.edges.get(u) ?? []) {
      if (!graph.nodes.has(v)) continue; // unresolved (soft) — not a cycle
      const c = color.get(v);
      if (c === GRAY) {
        const i = stack.indexOf(v);
        cycles.push(stack.slice(i).concat(v));
      } else if (c === WHITE) {
        dfs(v);
      }
    }
    stack.pop();
    color.set(u, BLACK);
  };
  for (const k of graph.nodes.keys()) if (color.get(k) === WHITE) dfs(k);
  return cycles;
}

export const DEFAULT_AUTHORING_RECURSION_BUDGET = 8;

export type RecursionCheck = { withinBudget: boolean; maxDepthReached: number; budget: number };

/**
 * Authoring-chain recursion guard. Following cross-kind edges from `start`
 * (an authoring skill invokes its agentDependencies, which may produce
 * artifacts whose own authoring chains recurse), bound the traversal depth
 * so a pathological/cyclic authoring chain cannot exhaust the runtime.
 *
 * Contract: `budget` is the MAX ALLOWED depth, INCLUSIVE.
 * A chain whose deepest acyclic path is exactly `budget` is WITHIN budget;
 * one that would reach `budget + 1` is OVER. Descent is capped one level
 * past `budget` purely so the overflow is observable (then it stops — the
 * runtime guard); `onPath` independently prevents infinite cycle recursion.
 * `maxDepthReached` is the deepest depth observed (≤ budget + 1).
 */
export function checkAuthoringRecursionBudget(
  graph: CrossKindGraph,
  start: string,
  budget: number = DEFAULT_AUTHORING_RECURSION_BUDGET,
): RecursionCheck {
  let maxDepth = 0;
  const walk = (node: string, depth: number, onPath: Set<string>): void => {
    if (depth > maxDepth) maxDepth = depth;
    // Allow reaching budget+1 ONCE so an overflow is detectable, then stop
    // descending (bounds runtime on huge DAGs; cycles already bounded by
    // onPath).
    if (depth > budget) return;
    for (const next of graph.edges.get(node) ?? []) {
      if (!graph.nodes.has(next) || onPath.has(next)) continue;
      onPath.add(next);
      walk(next, depth + 1, onPath);
      onPath.delete(next);
    }
  };
  if (graph.nodes.has(start)) walk(start, 0, new Set([start]));
  return { withinBudget: maxDepth <= budget, maxDepthReached: maxDepth, budget };
}

// ---------------------------------------------------------------------------
// Produced-artifact ADVISORY (cinatra#1059).
//
// Posture decision (ratified on #1059, converged with codex): the agent→
// artifact `cinatra.produces` edge is an ADVISORY (soft) cross-kind edge — it
// NEVER blocks install and NEVER auto-installs. When an agent's produced
// artifact extension is absent the run keeps its deliberate DEGRADE posture
// (visible per-output materialization failure, default-floor typing) — see
// `src/lib/artifacts/run-artifact-materializer.ts`. These helpers compute, at
// install-finalize, WHICH produced-artifact extensions are absent so callers
// can surface a non-blocking advisory (`log-continue`, the canonical artifact
// optional-missing behavior in `dependency-closure.ts`).
//
// They are the FIRST production consumer of the graph above (`resolveInstall`
// in SOFT mode). Co-located here (rather than a standalone module) so the
// produced-artifact advisory adds NO new reachable first-party module to the
// dev-perf-tracked route graphs (the route-graph ratchet already counts this
// module) while keeping the produces-edge machinery in one place.
// ---------------------------------------------------------------------------

/** A canonical installed-extension row, narrowed to the fields the advisory
 *  scope-pick needs (mirror of the `installed_extension` columns read via
 *  `readInstalledExtensionsByPackageName`). */
export type InstalledArtifactRowLike = {
  packageName: string;
  kind: string;
  status: string;
  organizationId: string | null;
};

/**
 * The set of artifact package names that have a GOVERNING live install for the
 * installing org scope. Mirrors the row-pick in
 * `src/lib/artifacts/artifact-extension-access.ts` EXACTLY so the advisory and
 * the write-gate agree on "present for this org":
 *   - only `active|locked` rows govern (archived/removed do NOT);
 *   - the governing row is the org-owned live row if present, else an ambient
 *     (platform/workspace, `organizationId == null`) live row;
 *   - a package whose only live rows belong to OTHER orgs is NOT governing here
 *     (no cross-org presence bleed) → still counts as missing.
 */
export function governingInstalledArtifactSet(
  rows: readonly InstalledArtifactRowLike[],
  orgId: string | null | undefined,
): Set<string> {
  const byPkg = new Map<string, InstalledArtifactRowLike[]>();
  for (const r of rows) {
    if (r.kind !== "artifact") continue;
    if (r.status !== "active" && r.status !== "locked") continue;
    const list = byPkg.get(r.packageName);
    if (list) list.push(r);
    else byPkg.set(r.packageName, [r]);
  }
  const governing = new Set<string>();
  for (const [pkg, live] of byPkg) {
    const pick =
      (orgId != null && live.find((r) => r.organizationId === orgId)) ||
      live.find((r) => r.organizationId == null) ||
      null;
    if (pick) governing.add(pkg);
  }
  return governing;
}

/**
 * Given an agent package's declared `produces` targets and the set of
 * scope-governing INSTALLED artifact package names, return the produced
 * artifact extensions that are ABSENT (the advisory). SOFT: never throws,
 * never blocks — the result is purely informational.
 *
 * Routes through the cross-kind graph (SOFT `resolveInstall`); the produced
 * artifacts resolve ONLY via `installedArtifacts` (they are not graph nodes),
 * so an uninstalled-but-registry-known artifact still counts missing. The
 * returned list is de-duplicated and order-stable.
 */
export function computeMissingProducedArtifacts(
  agentPackageName: string,
  producesTargets: readonly string[],
  installedArtifacts: ReadonlySet<string>,
): string[] {
  const produces = [...new Set(producesTargets)];
  if (produces.length === 0) return [];
  const node: CrossKindNode = { packageName: agentPackageName, kind: "agent", produces };
  const graph = buildCrossKindGraph([node]);
  const resolution = resolveInstall(graph, node, {
    installed: installedArtifacts,
    mode: "soft",
  });
  return resolution.unresolved;
}
