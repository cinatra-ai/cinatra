// Contribution LINEAGE identity + adoption PLANNER (cinatra#1628, S11b).
//
// PURE + host-neutral: no `server-only`, no DB, no I/O — so both the reconciler
// orchestrator (src/lib) and the unit suite share ONE decision surface.
//
// LINEAGE-ID FORMAT is a HOST-PERSISTENCE detail (the `dashboards.contribution_id`
// column), NOT the author-facing ABI (which is `contributionKey` + `adopts` in the
// sdk-extensions leaf). So it lives here, next to the schema + single-writer that
// own the column — NOT in the SDK.
//
// Two lineage-id shapes the reconciler must recognize when it resolves an
// `adopts` edge against orphaned rows:
//   - `legacy:<package>`            — the WORKFLOW-era backfill format, written by
//                                     migration core__0051 (`'legacy:' || extension_id`).
//                                     Carrier-INDEPENDENT (encodes the ORIGIN
//                                     package, not the workflow/agent kind).
//   - `contribution:<package>#<key>` — the AGENT-era canonical format an adoption
//                                     re-keys a row TO (and a later re-home's
//                                     `adopts` edge names again).
//
// ADOPTION is NEVER inferred from short-key equality (the #1628 contract): a
// successor agent declares an explicit `adopts: [{ legacyPackage,
// legacyContributionKey }]` list; {@link planContributionAdoptions} resolves each
// edge to the candidate lineage ids above and matches THOSE against orphaned rows.

import type {
  DashboardContributionManifest,
  DashboardContributionAdoption,
} from "@cinatra-ai/sdk-extensions";

/** Prefix of the WORKFLOW-era backfill lineage id (migration core__0051). */
export const LEGACY_LINEAGE_PREFIX = "legacy:";
/** Prefix of the AGENT-era canonical contribution lineage id. */
export const CONTRIBUTION_LINEAGE_PREFIX = "contribution:";

/**
 * The WORKFLOW-era backfill lineage id for a package — MUST byte-match what
 * migration `core__0051` wrote (`'legacy:' || extension_id`) so the reconciler
 * finds the orphaned rows it backfilled. A template + its 0..N per-project
 * instances share this one value (they share `extension_id`).
 */
export function legacyContributionLineageId(packageName: string): string {
  return `${LEGACY_LINEAGE_PREFIX}${packageName}`;
}

/**
 * The AGENT-era canonical lineage id for a (package, author-local key). This is
 * the value an adopt-in-place re-key sets on the row, and the value a subsequent
 * re-home's `adopts` edge resolves back to. `#` separates package from key
 * unambiguously — a package name never contains `#`, an author-local
 * contribution key is strict lowercase kebab (no `#`).
 */
export function deriveContributionLineageId(packageName: string, contributionKey: string): string {
  return `${CONTRIBUTION_LINEAGE_PREFIX}${packageName}#${contributionKey}`;
}

/**
 * The candidate lineage ids an `adopts` edge could match, MOST-SPECIFIC first:
 *   1. the AGENT-era canonical id (a prior agent generation being re-homed), and
 *   2. the WORKFLOW-era backfill id (the original stranded workflow rows).
 * The reconciler matches orphaned rows against this whole set (a `contribution_id`
 * equal to ANY candidate).
 */
export function adoptionMatchLineageIds(edge: DashboardContributionAdoption): string[] {
  return [
    deriveContributionLineageId(edge.legacyPackage, edge.legacyContributionKey),
    legacyContributionLineageId(edge.legacyPackage),
  ];
}

/** A parsed, live successor contribution claim + the package that declares it. */
export type LiveContributionClaim = {
  /** The declaring package (the successor CARRIER — always `kind:"agent"`). */
  readonly packageName: string;
  /** The parsed, validated `cinatra.dashboardContribution` claim. */
  readonly contribution: DashboardContributionManifest;
};

/**
 * A single adopt-in-place operation the reconciler executes ATOMICALLY (one
 * transaction): re-key the orphaned rows matching ANY of `matchLineageIds` onto
 * the successor identity. There is EXACTLY ONE op per successor contribution — the
 * UNION of all its `adopts` edges' candidate lineages — so a multi-edge adoption
 * is one transaction (never order-dependent per-edge commits).
 */
export type ContributionAdoption = {
  readonly successorPackage: string;
  /** The AGENT-era canonical lineage id the matched rows are re-keyed TO. */
  readonly successorContributionId: string;
  /** The successor's declared DATA version — persisted as provenance. */
  readonly successorContributionVersion: number;
  /** Every explicit adopts edge this op honors (for audit provenance). */
  readonly legacyRefs: DashboardContributionAdoption[];
  /** The UNION of the edges' candidate legacy lineage ids to match orphans on. */
  readonly matchLineageIds: string[];
};

/** Why a successor's adoption was NOT planned (fail-closed, for diagnostics). */
export type SkippedAdoption = {
  readonly successorPackage: string;
  readonly legacyRefs: DashboardContributionAdoption[];
  readonly reason: "ambiguous_claimants";
  /** The other successor packages that also claim an overlapping legacy lineage. */
  readonly conflictingPackages: string[];
};

export type ContributionAdoptionPlan = {
  readonly adoptions: ContributionAdoption[];
  readonly skipped: SkippedAdoption[];
};

function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

/**
 * PURE adoption planner (the "consume the claim" decision surface).
 *
 * ONE candidate per successor CONTRIBUTION — the union of its `adopts` edges'
 * candidate lineages — so the reconciler re-keys all of a successor's orphans in a
 * SINGLE transaction (fail-closed rollback on collision, never a partial per-edge
 * commit). FAIL-CLOSED on AMBIGUITY: if two DIFFERENT successor contributions
 * claim any overlapping legacy lineage id, neither can be proven to own the
 * orphaned rows, so BOTH are SKIPPED (the orphan stays archived rather than
 * clobbered by an arbitrary winner).
 *
 * A claim with no `adopts` list contributes no adoption (fresh materialization of
 * a net-new contribution is a separate, deferred path — this planner is
 * adoption-only). Operator rows are never referenced here (adoption keys on the
 * extension-owned `contribution_id` lineage only).
 */
export function planContributionAdoptions(
  claims: readonly LiveContributionClaim[],
): ContributionAdoptionPlan {
  // One candidate per successor contribution (union of its edges' candidates).
  type Candidate = {
    successorPackage: string;
    successorContributionId: string;
    successorContributionVersion: number;
    legacyRefs: DashboardContributionAdoption[];
    matchLineageIds: string[];
  };
  const candidates: Candidate[] = [];
  for (const { packageName, contribution } of claims) {
    const edges = contribution.adopts ?? [];
    if (edges.length === 0) continue;
    candidates.push({
      successorPackage: packageName,
      successorContributionId: deriveContributionLineageId(packageName, contribution.contributionKey),
      successorContributionVersion: contribution.contributionVersion,
      legacyRefs: [...edges],
      matchLineageIds: dedupe(edges.flatMap(adoptionMatchLineageIds)),
    });
  }

  // Ambiguity index: a candidate legacy lineage id → the DISTINCT successor
  // identities that would match it. Any id claimed by >1 distinct successor is
  // contested; every candidate touching a contested id fails closed.
  const claimantsByLineage = new Map<string, Set<string>>();
  for (const c of candidates) {
    for (const id of c.matchLineageIds) {
      let set = claimantsByLineage.get(id);
      if (!set) {
        set = new Set<string>();
        claimantsByLineage.set(id, set);
      }
      set.add(c.successorContributionId);
    }
  }

  const adoptions: ContributionAdoption[] = [];
  const skipped: SkippedAdoption[] = [];
  for (const c of candidates) {
    const conflicting = new Set<string>();
    for (const id of c.matchLineageIds) {
      const set = claimantsByLineage.get(id);
      if (set && set.size > 1) {
        for (const other of set) {
          if (other !== c.successorContributionId) conflicting.add(other);
        }
      }
    }
    if (conflicting.size > 0) {
      skipped.push({
        successorPackage: c.successorPackage,
        legacyRefs: c.legacyRefs,
        reason: "ambiguous_claimants",
        conflictingPackages: [
          ...new Set(
            candidates
              .filter((o) => conflicting.has(o.successorContributionId))
              .map((o) => o.successorPackage),
          ),
        ].sort(),
      });
      continue;
    }
    adoptions.push({
      successorPackage: c.successorPackage,
      successorContributionId: c.successorContributionId,
      successorContributionVersion: c.successorContributionVersion,
      legacyRefs: c.legacyRefs,
      matchLineageIds: c.matchLineageIds,
    });
  }

  return { adoptions, skipped };
}
