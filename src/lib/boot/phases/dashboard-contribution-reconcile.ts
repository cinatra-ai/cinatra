// dashboardContribution ADOPTION reconcile boot phase (cinatra#1628, S11c /
// remaining AC2 — the LIVE TRIGGER wiring).
//
// S11b (#1695) landed the adoption reconciler but deliberately left it WITHOUT a
// lifecycle trigger: "It is intentionally NOT auto-wired to a lifecycle trigger in
// this slice (no producer to trigger it); callers invoke it explicitly." This
// phase is that trigger. AFTER extension activation (the dual loaders + required-
// set enforcement + the store rescans), it reconciles dashboardContribution
// adoptions across every CANDIDATE org, so a successor `kind:"agent"` extension
// that declares an `adopts` edge re-homes the recoverably-archived orphan rows
// onto itself on the FIRST boot after it ships — no manual step, no image rebuild.
//
// DORMANT by construction: candidate orgs are ONLY those holding archived,
// contribution-keyed extension rows (the just-verified prod fleet holds ZERO), so
// with no legacy orphan this phase reconciles zero orgs and is a clean no-op. It
// becomes live the moment a legacy orphan exists AND a successor ships the claim.
//
// Best-effort (`retryable`): idempotent (the archived-only writer excludes
// already-adopted rows, so a re-fire converges), soft-failing (a reconcile error
// logs + retries next boot, never aborts boot), kill-switchable for operability.
//
// Deliberately NOT importing "server-only": unit tests import the phase list.

import type { BootPhase } from "@/lib/boot/boot-phase";

export function dashboardContributionReconcilePhases(): BootPhase[] {
  return [
    {
      name: "dashboard-contribution-reconcile",
      policy: "retryable",
      run: async () => {
        if (process.env.CINATRA_DISABLE_DASHBOARD_CONTRIBUTION_RECONCILE === "true") {
          return { skipped: "disabled via CINATRA_DISABLE_DASHBOARD_CONTRIBUTION_RECONCILE" };
        }
        const { reconcileAllDashboardContributionAdoptions } = await import(
          "@/lib/dashboards/reconcile-contribution-adoptions"
        );
        const r = await reconcileAllDashboardContributionAdoptions();
        if (r.orgsReconciled === 0) {
          // No org held an archived contribution row — the dormant common case.
          return { skipped: "no candidate orgs (no archived contribution rows)" };
        }
        console.info(
          `[dashboard-contribution-reconcile] orgs=${r.orgsReconciled} ` +
            `adopted=${r.adoptedRowCount} adoptions=${r.adoptionsRun} ` +
            `skipped=${r.skipped} failed=${r.failed}`,
        );
      },
    },
  ];
}
