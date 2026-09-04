import type { Metadata } from "next";

import { ScopeSurfacePage } from "@/components/scope-surface-page";
import { requireAuthSession } from "@/lib/auth-session";

export const metadata: Metadata = { title: "Workspace" };

// `/workspace` — the whole application, the scope above every organization
// (cinatra#2807, per-scope surfaces S1). The landing IS the Dashboards tab, and
// the strip carries no Settings: the workspace has no scope settings pane. The
// workspace dashboards themselves are their own slice (#2811); until they land
// this tab states what it will hold rather than claiming an empty collection.
export default async function WorkspacePage() {
  await requireAuthSession();
  return (
    <ScopeSurfacePage
      scope={{ kind: "workspace" }}
      tab="dashboards"
      title="Workspace"
      description="Everything in this application — the scope above every organization."
    />
  );
}
