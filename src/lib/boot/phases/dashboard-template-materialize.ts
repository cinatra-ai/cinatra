// Dashboard-TEMPLATE MATERIALIZE boot phase (cinatra#1896 Scope 2 / epic #1883
// install→materialize trigger).
//
// `materializeExtensionTemplate` had NO app-side caller on `origin/main`. This
// phase is the trigger: AFTER extension activation (the dual loaders + required-set
// enforcement + store rescans), for every org holding a LIVE install of a
// `kind:"artifact"` pack that ships a `form:"dashboard"` template, it materializes
// the pack's dashboard — so installing such a pack produces its dashboard (with the
// paired substrate twin + the #1896 meaning assertion) on the FIRST boot after it
// ships, no manual step.
//
// DORMANT by construction: candidate orgs are ONLY those with a live install of a
// dashboard-template pack (the current fleet ships none in the lock), so this
// reconciles zero orgs and is a clean no-op until such a pack is installed.
//
// Best-effort (`retryable`): idempotent (`materializeExtensionTemplate` upserts the
// single template row per (extension, org) in place, so a re-fire converges; the
// twin meaning-assertion mint is precedence-guarded), soft-failing (a reconcile
// error logs + retries next boot, never aborts boot), kill-switchable for
// operability.
//
// Deliberately NOT importing "server-only": unit tests import the phase list.

import type { BootPhase } from "@/lib/boot/boot-phase";

export function dashboardTemplateMaterializePhases(): BootPhase[] {
  return [
    {
      name: "dashboard-template-materialize",
      policy: "retryable",
      run: async () => {
        if (process.env.CINATRA_DISABLE_DASHBOARD_TEMPLATE_MATERIALIZE === "true") {
          return { skipped: "disabled via CINATRA_DISABLE_DASHBOARD_TEMPLATE_MATERIALIZE" };
        }
        const { reconcileAllDashboardTemplateMaterializations } = await import(
          "@/lib/dashboards/reconcile-template-materializations"
        );
        const r = await reconcileAllDashboardTemplateMaterializations();
        if (r.orgsReconciled === 0) {
          // No org holds a live dashboard-template pack — the dormant common case.
          return { skipped: "no candidate orgs (no live dashboard-template pack installed)" };
        }
        console.info(
          `[dashboard-template-materialize] orgs=${r.orgsReconciled} ` +
            `materialized=${r.materialized} failed=${r.failed}`,
        );
      },
    },
  ];
}
