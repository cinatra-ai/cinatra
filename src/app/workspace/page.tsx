import type { Metadata } from "next";

import { buildWorkspaceDashboardsTabBody } from "@/components/dashboards/workspace-dashboards-section";
import { ScopeSurfacePage } from "@/components/scope-surface-page";
import { requireAuthSession } from "@/lib/auth-session";

export const metadata: Metadata = { title: "Workspace" };

// `/workspace` — the whole application, the scope above every organization
// (cinatra#2807, per-scope surfaces S1). The landing IS the Dashboards tab, and
// the strip carries no Settings: the workspace has no scope settings pane. The
// Dashboards tab's body is the workspace's own collection (cinatra#2811): the
// viewer's workspace dashboards with the non-removable Overview, the references
// brought up from the scopes below, and the Add popup.
export default async function WorkspacePage() {
  await requireAuthSession();
  const dashboards = await buildWorkspaceDashboardsTabBody();
  return (
    <ScopeSurfacePage
      scope={{ kind: "workspace" }}
      tab="dashboards"
      title="Workspace"
      description="Everything in this application — the scope above every organization."
      body={dashboards}
    />
  );
}
