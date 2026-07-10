// ---------------------------------------------------------------------------
// Produced-artifact ADVISORY (cinatra#1059).
//
// Posture decision (ratified on #1059, converged with codex): the agent→
// artifact `cinatra.produces` edge is an ADVISORY (soft) cross-kind edge — it
// NEVER blocks install and NEVER auto-installs. When an agent's produced
// artifact extension is absent the run keeps its deliberate DEGRADE posture
// (visible per-output materialization failure, default-floor typing) — see
// `src/lib/artifacts/run-artifact-materializer.ts`. This module computes, at
// install-finalize, WHICH produced-artifact extensions are absent so callers
// can surface a non-blocking advisory (`log-continue`, the canonical
// artifact optional-missing behavior in `dependency-closure.ts`).
//
// It is the FIRST production consumer of the pure cross-kind dependency graph
// (`cross-kind-dep-graph.ts`), used in SOFT mode: the produced artifacts are
// resolved ONLY through the caller-supplied installed set — they are
// deliberately NOT added as graph nodes, so a registry-known-but-uninstalled
// artifact still counts as missing.
//
// The reverse artifact→agent `agentDependencies` semantic-manifest field
// (`@cinatra-ai/objects/semantic-manifest`) is the dormant counterpart edge;
// it is KEPT (not removed) per the #1059 decision and feeds the SAME graph
// (already consumed by `decideUninstall` uninstall-safety and
// `checkAuthoringRecursionBudget`). NOTE: that field is distinct from the
// deprecated legacy agent-package `cinatra.agentDependencies` map.
// ---------------------------------------------------------------------------

import { buildCrossKindGraph, resolveInstall } from "./cross-kind-dep-graph";

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
    const row =
      (orgId != null && live.find((r) => r.organizationId === orgId)) ||
      live.find((r) => r.organizationId == null) ||
      null;
    if (row) governing.add(pkg);
  }
  return governing;
}

/**
 * Given an agent package's declared `produces` targets and the set of
 * scope-governing INSTALLED artifact package names, return the produced
 * artifact extensions that are ABSENT (the advisory). SOFT: never throws,
 * never blocks — the result is purely informational.
 *
 * Routes through the cross-kind graph (SOFT `resolveInstall`) as its first
 * production caller; the produced artifacts resolve ONLY via `installedArtifacts`
 * (they are not graph nodes), so an uninstalled-but-registry-known artifact
 * still counts missing. The returned list is de-duplicated and order-stable.
 */
export function computeMissingProducedArtifacts(
  agentPackageName: string,
  producesTargets: readonly string[],
  installedArtifacts: ReadonlySet<string>,
): string[] {
  const produces = [...new Set(producesTargets)];
  if (produces.length === 0) return [];
  const node = { packageName: agentPackageName, kind: "agent" as const, produces };
  const graph = buildCrossKindGraph([node]);
  const resolution = resolveInstall(graph, node, {
    installed: installedArtifacts,
    mode: "soft",
  });
  return resolution.unresolved;
}
