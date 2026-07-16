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

let wired = false;

/** Idempotently install the durable dashboard-lifecycle hook. */
export function wireExtensionDashboardLifecycleHook(): void {
  if (wired) return;
  wired = true;
  setExtensionDashboardLifecycleHook(extensionDashboardLifecycleHook);
}

// Wire on import — a side-effect import
// (`import "@/lib/extension-dashboard-lifecycle-wiring"`) installs the hook.
wireExtensionDashboardLifecycleHook();
