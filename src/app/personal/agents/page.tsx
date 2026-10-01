import type { Metadata } from "next";

import { ScopeSurfacePage } from "@/components/scope-surface-page";
import { ScopeAgentsTab } from "@/components/scope-surfaces/scope-agents-tab";
import { readScopeSurfaceAgentRows } from "@/lib/scope-surface-eligibility.server";
import { requireAuthSession } from "@/lib/auth-session";

export const metadata: Metadata = { title: "Agents" };

// The header keeps naming the ENTITY on every tab: the ratified drawing makes
// this an entity page and the tab a tab OF it, so the tab's own name is carried
// by the strip, not by the heading. The name comes from the page's own gated
// read; a reader who may not be told it sees the scope's kind noun instead.
//
// The Agents tab of the personal scope (cinatra#2807, per-scope surfaces
// S1). This scope is named by the drawing itself, so the shell reads nothing
// about it at all; the tab's contents and their authorization arrive with the
// slice that fills this tab.
// cinatra#2808 (per-scope surfaces S2) fills this tab: the eligibility loader
// decides what this scope reaches, and the tab body draws it. An empty read
// keeps S1's honest placeholder — the shell never claims the scope holds
// nothing on a read it did not take.
export default async function PersonalAgentsPage() {
  await requireAuthSession();
  const scope = { kind: "personal" } as const;
  const rows = await readScopeSurfaceAgentRows(scope);
  return (
    <ScopeSurfacePage
      scope={scope}
      tab="agents"
      title="Personal"
      body={rows.length > 0 ? <ScopeAgentsTab rows={rows} /> : undefined}
    />
  );
}
