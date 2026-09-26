import type { Metadata } from "next";

import { ScopeSurfacePage } from "@/components/scope-surface-page";
import { ScopeAssistantsTab } from "@/components/scope-surfaces/scope-assistants-tab";
import { scopeSurfaceTabBody } from "@/components/scope-surfaces/scope-surface-tab-body";
import { readScopeSurfaceAssistantTab } from "@/lib/scope-surface-eligibility.server";
import { requireAuthSession } from "@/lib/auth-session";

export const metadata: Metadata = { title: "Assistants" };

// The header keeps naming the ENTITY on every tab: the ratified drawing makes
// this an entity page and the tab a tab OF it, so the tab's own name is carried
// by the strip, not by the heading. The name comes from the page's own gated
// read; a reader who may not be told it sees the scope's kind noun instead.
//
// The Assistants tab of the workspace scope (cinatra#2807, per-scope surfaces
// S1). This scope is named by the drawing itself, so the shell reads nothing
// about it at all; the tab's contents and their authorization arrive with the
// slice that fills this tab.
// cinatra#2808 (per-scope surfaces S2) fills this tab: the eligibility loader
// decides what this scope reaches, and the tab body draws it. A read that
// answered with no rows draws the tab's own empty reading (cinatra#3707); only
// a read that could not be taken passes no body, so the shell's placeholder is
// left to a tab that reads nothing at all.
export default async function WorkspaceAssistantsPage() {
  await requireAuthSession();
  const scope = { kind: "workspace" } as const;
  const assistants = await readScopeSurfaceAssistantTab(scope);
  return (
    <ScopeSurfacePage
      scope={scope}
      tab="assistants"
      title="Workspace"
      body={scopeSurfaceTabBody("assistants", assistants, (rows) => (
        <ScopeAssistantsTab rows={rows} />
      ))}
    />
  );
}
