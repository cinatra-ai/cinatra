import "server-only";

// The dashboardContribution ADOPTION reconciler (cinatra#1628, S11b).
//
// This is the host side that CONSUMES the `cinatra.dashboardContribution` claim
// the generator emits onto `NormalizedExtensionRecord`: it resolves the LIVE
// successor claims for an org, parses each field-tolerantly (degrade-with-
// diagnostic via the sdk leaf's `parseDashboardContribution` — a malformed claim
// is DROPPED, never fatal), plans the adopt-in-place operations (fail-closed on
// cross-extension ambiguity), and drives the dashboards single-writer's
// transactional `adoptExtensionDashboards` per planned op.
//
// RECOVERY POSTURE (the #1628 contract). At S11-land no successor
// `dashboardContribution` exists yet, so this reconciler is DORMANT — it becomes
// live only once a successor `kind:"artifact"` meaning pack that declares `adopts`
// ships. The reader gate + the orphan sweep already stopped the leak; adoption is
// the deferred restore that re-homes the recoverably-archived orphan rows onto
// the successor IN PLACE (AC2 "re-key not duplicate"). It is intentionally NOT
// auto-wired to a lifecycle trigger in this slice (no producer to trigger it);
// callers invoke it explicitly.
//
// LIVENESS matches the reader gate's oracle: a package is live iff it has an
// `active`/`locked` canonical `installed_extension` row addressable to the org (a
// system-locked row is org-null; a per-org install must match).

// The transactional single-writer (heavy — pulls the dashboards store). Imported
// as the DEFAULT adopter; injectable so a unit test needs no DB.
import { adoptExtensionDashboards } from "@cinatra-ai/dashboards/extension-materialization";
// The PURE planner + claim type (light — no store), on their own stable subpath.
import {
  planContributionAdoptions,
  type LiveContributionClaim,
} from "@cinatra-ai/dashboards/contribution-lineage";
import {
  parseDashboardContribution,
  isDashboardContributionCarrierKind,
} from "@cinatra-ai/sdk-extensions";

/** The canonical statuses that count as LIVE (mirrors the reader-gate oracle). */
const LIVE_STATUSES = new Set(["active", "locked"]);

/** A candidate live record carrying a raw `dashboardContribution` pass-through. */
export type LiveContributionCandidate = {
  readonly packageName: string;
  readonly kind: unknown;
  readonly rawContribution: unknown;
};

/**
 * PURE parse-and-collect: turn raw live records into validated successor claims.
 * FIELD-TOLERANT (degrade-with-diagnostic): a record whose `dashboardContribution`
 * fails `parseDashboardContribution` is DROPPED with a diagnostic (never fatal, the
 * other records keep reconciling); a non-`artifact` carrier is ignored
 * (defense-in-depth — the generator already gates emission on `kind:"artifact"`); a
 * null/absent claim is skipped.
 */
export function parseLiveContributionClaims(
  candidates: readonly LiveContributionCandidate[],
): LiveContributionClaim[] {
  const claims: LiveContributionClaim[] = [];
  for (const c of candidates) {
    if (c.rawContribution == null) continue;
    if (!isDashboardContributionCarrierKind(c.kind)) continue;
    const parsed = parseDashboardContribution(c.rawContribution);
    if (!parsed.ok) {
      console.warn(
        `[dashboards/reconcile] dropping invalid dashboardContribution for ${c.packageName}: ${parsed.diagnostic}`,
      );
      continue;
    }
    claims.push({ packageName: c.packageName, contribution: parsed.contribution });
  }
  return claims;
}

/**
 * Resolve the LIVE, parsed successor claims for `organizationId` from the
 * canonical install store + the generated manifest, then parse them field-
 * tolerantly via {@link parseLiveContributionClaims}. Liveness matches the
 * reader-gate oracle (active/locked, org-addressable).
 */
async function defaultResolveLiveClaims(
  organizationId: string,
): Promise<LiveContributionClaim[]> {
  const { listInstalledExtensions } = await import("@cinatra-ai/extensions/canonical-store");
  const { STATIC_EXTENSION_MANIFEST } = await import("@/lib/generated/extensions.server");

  const livePackages = new Set<string>();
  const rows = await listInstalledExtensions({});
  for (const row of rows) {
    if (!LIVE_STATUSES.has(row.status)) continue;
    if (row.organizationId === null || row.organizationId === organizationId) {
      livePackages.add(row.packageName);
    }
  }

  const candidates: LiveContributionCandidate[] = [];
  for (const packageName of livePackages) {
    const record = STATIC_EXTENSION_MANIFEST[packageName];
    if (!record) continue;
    candidates.push({ packageName, kind: record.kind, rawContribution: record.dashboardContribution });
  }
  return parseLiveContributionClaims(candidates);
}

export type ReconcileAdoptionDeps = {
  /** Override live-claim resolution (tests inject synthetic claims). */
  readonly resolveLiveClaims?: (organizationId: string) => Promise<LiveContributionClaim[]>;
  /** Override the transactional writer (tests). */
  readonly adopt?: typeof adoptExtensionDashboards;
};

export type ReconcileAdoptionResult = {
  /** Rows re-keyed onto a successor across all committed adoptions. */
  readonly adoptedRowCount: number;
  /** Adoption operations that committed (each = one successor). */
  readonly adoptionsRun: number;
  /** Successors skipped fail-closed at PLAN time (ambiguous claimants). */
  readonly skipped: number;
  /** Adoptions whose transaction ROLLED BACK at WRITE time (e.g. a uniqueness
   *  collision from two orphan templates collapsing onto one successor) — contained
   *  per successor, nothing partially adopted. */
  readonly failed: number;
};

/**
 * Reconcile dashboardContribution adoptions for one org. Idempotent (the
 * transactional writer excludes already-adopted rows) and fail-closed (ambiguous
 * claimants are skipped, never adopted). Returns a summary.
 */
export async function reconcileDashboardContributionAdoptions(
  organizationId: string,
  deps: ReconcileAdoptionDeps = {},
): Promise<ReconcileAdoptionResult> {
  const resolveLiveClaims = deps.resolveLiveClaims ?? defaultResolveLiveClaims;
  const adopt = deps.adopt ?? adoptExtensionDashboards;

  // System actor for the lifecycle-triggered adoption audit rows (install authz
  // is gated upstream — adoption is a system write, like the materialize/archive
  // path, so it does NOT re-run the user-facing dashboard access resolver).
  const actor = {
    userId: "system:dashboard-contribution-reconciler",
    organizationId,
    teamIds: [] as string[],
    orgRole: "owner" as const,
    teamRoles: {} as Record<string, "admin" | "member">,
  };

  const claims = await resolveLiveClaims(organizationId);
  const plan = planContributionAdoptions(claims);

  for (const s of plan.skipped) {
    const edges = s.legacyRefs.map((r) => `${r.legacyPackage}#${r.legacyContributionKey}`).join(", ");
    console.warn(
      `[dashboards/reconcile] AMBIGUOUS adoption skipped (fail-closed): ${s.successorPackage} ` +
        `adopts [${edges}] — contested by [${s.conflictingPackages.join(", ")}]; the orphan rows are ` +
        `left archived (recoverable) until the ambiguity is resolved.`,
    );
  }

  let adoptedRowCount = 0;
  let adoptionsRun = 0;
  let failed = 0;
  for (const op of plan.adoptions) {
    try {
      const n = await adopt(undefined, {
        organizationId,
        successorPackage: op.successorPackage,
        successorContributionId: op.successorContributionId,
        matchLineageIds: op.matchLineageIds,
        appliedContributionVersion: op.successorContributionVersion,
        actor,
      });
      adoptedRowCount += n;
      adoptionsRun += 1;
    } catch (err) {
      // The adopt runs in ONE transaction; a uniqueness collision (two orphan
      // templates collapsing onto one successor lineage, or a successor that
      // already has a template) rolls the WHOLE op back — nothing partially
      // adopted. Contain it per successor (fail-closed) so a sibling successor
      // still reconciles; the contested orphan stays archived (recoverable).
      failed += 1;
      console.warn(
        `[dashboards/reconcile] adoption ROLLED BACK for ${op.successorPackage} ` +
          `(the orphan rows are left archived — recoverable):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { adoptedRowCount, adoptionsRun, skipped: plan.skipped.length, failed };
}


// ---------------------------------------------------------------------------
// ALL-ORGS reconcile — the boot / install TRIGGER entry point (cinatra#1628,
// S11c / remaining AC2). S11b left the per-org reconciler WITHOUT a lifecycle
// trigger; this is the fan-out the boot phase drives. Candidate orgs are only
// those holding archived, contribution-keyed extension rows (the only orgs an
// adoption can touch), so the whole path is DORMANT until a legacy orphan exists
// AND a successor ships. Per-org failures are contained.
// ---------------------------------------------------------------------------

export type ReconcileAllResult = {
  readonly orgsReconciled: number;
  readonly adoptedRowCount: number;
  readonly adoptionsRun: number;
  readonly skipped: number;
  readonly failed: number;
};

export type ReconcileAllDeps = ReconcileAdoptionDeps & {
  /** Override candidate-org resolution (tests). Defaults to the archived-orphan
   *  org scan (the reconcile is a no-op for any other org). */
  readonly resolveCandidateOrgIds?: () => Promise<string[]>;
};

async function defaultResolveCandidateOrgIds(): Promise<string[]> {
  const { listOrgIdsWithArchivedExtensionRows } = await import(
    "@cinatra-ai/dashboards/extension-dashboard-reads"
  );
  return listOrgIdsWithArchivedExtensionRows();
}

export async function reconcileAllDashboardContributionAdoptions(
  deps: ReconcileAllDeps = {},
): Promise<ReconcileAllResult> {
  const resolveCandidateOrgIds = deps.resolveCandidateOrgIds ?? defaultResolveCandidateOrgIds;
  const orgIds = await resolveCandidateOrgIds();

  let orgsReconciled = 0;
  let adoptedRowCount = 0;
  let adoptionsRun = 0;
  let skipped = 0;
  let failed = 0;
  for (const orgId of orgIds) {
    try {
      const r = await reconcileDashboardContributionAdoptions(orgId, deps);
      adoptedRowCount += r.adoptedRowCount;
      adoptionsRun += r.adoptionsRun;
      skipped += r.skipped;
      failed += r.failed;
      orgsReconciled += 1;
    } catch (err) {
      // Contain a per-org failure so a sibling org still reconciles.
      failed += 1;
      console.warn(
        `[dashboards/reconcile] org ${orgId} reconcile threw (contained):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { orgsReconciled, adoptedRowCount, adoptionsRun, skipped, failed };
}
