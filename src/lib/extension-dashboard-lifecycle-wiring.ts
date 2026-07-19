import "server-only";

// Wires the host-injected ORG-SCOPED dashboard-archival lifecycle hook
// (cinatra#1628, S11a) — archive a (package, org)'s extension dashboards on the
// committed archive/uninstall transition, restore them on the restore transition.
// Re-homes the dashboard-archival step W5/#1035 dropped, attached to the committed
// lifecycle transition with exact (install, org) identity (NOT the org-less,
// in-memory capability-teardown hook).
//
// Kept SEPARATE from `@/lib/extensions` (which eagerly registers all five kind
// handlers + pulls the heavy host handler graph) so it can be loaded cheaply on
// every path that can archive/restore an extension — including the UI Server
// Actions in `@cinatra-ai/extensions`, which must NOT pull the full handler graph.
// This module touches only `@cinatra-ai/extensions` (the hook setter) + the
// dashboards single-writer (`archiveExtensionDashboards`/`restoreExtensionDashboards`),
// so importing it is cheap.
//
// Loaded at web-process boot via `src/instrumentation.node.ts` (so a UI Server
// Action's archive/restore always finds the hook wired) and re-imported as a side
// effect from `@/lib/extensions` (the MCP path) — both idempotent (last set wins).

import { setExtensionDashboardLifecycleHook } from "@cinatra-ai/extensions";
import { extensionDashboardLifecycleHook } from "@/lib/dashboards/extension-dashboard-lifecycle";
// TYPE-ERASED, LIGHTWEIGHT slot accessor (globalThis-backed; no heavy
// execution-plane graph). This module is THE org-scoped archive lifecycle seam
// (fires on the committed archive/restore transition with exact (package, org)
// identity), so it is where the exec-plane S3 A3 archive reference-drop composes
// (cinatra#1708 §2.2 — the data-teardown hook does NOT fire on archive).
import { getEnvironmentArchiveReferenceDropper } from "@/lib/execution/register-execution-environment-service";

let wired = false;

/** Idempotently install the durable, org-scoped archive/restore lifecycle hook.
 * COMPOSED (cinatra#1708 §2.2): the dashboard archive/restore AND the L1
 * environment-layer org-scoped reference drop. Each half is ISOLATED so one
 * failing half never short-circuits the other (both idempotent + best-effort;
 * the firer also swallows a throw). ARCHIVE drops only THAT org's refs
 * (`{ orgId, packageName }`); layers stay for the retention GC (restore = cache
 * hit or lazy rebuild). RESTORE re-materializes references lazily at the next
 * run-per-install, so no explicit re-add is needed here. */
export function wireExtensionDashboardLifecycleHook(): void {
  if (wired) return;
  wired = true;
  setExtensionDashboardLifecycleHook(async (input) => {
    const isolate = async (label: string, p: () => Promise<unknown> | unknown): Promise<void> => {
      try {
        await p();
      } catch (e) {
        console.warn(
          `[archive-lifecycle] ${label} failed for "${input.packageName}" (org "${input.organizationId}", ${input.transition}) (idempotent; backstopped):`,
          e,
        );
      }
    };
    await Promise.all([
      isolate("dashboards", () => extensionDashboardLifecycleHook(input)),
      isolate("env-layer-refs", async () => {
        if (input.transition !== "archive") return;
        const dropper = getEnvironmentArchiveReferenceDropper();
        if (dropper) await dropper({ orgId: input.organizationId, packageName: input.packageName });
      }),
    ]);
  });
}

// Wire on import — a side-effect import
// (`import "@/lib/extension-dashboard-lifecycle-wiring"`) installs the hook.
wireExtensionDashboardLifecycleHook();
