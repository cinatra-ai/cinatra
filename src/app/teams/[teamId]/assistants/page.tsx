import type { Metadata } from "next";

import { ScopeSurfacePage } from "@/components/scope-surface-page";
import { ScopeAssistantsTab } from "@/components/scope-surfaces/scope-assistants-tab";
import { readScopeSurfaceAssistantRows } from "@/lib/scope-surface-eligibility.server";
import { requireAuthSession } from "@/lib/auth-session";
import { readScopeSurfaceEntityName } from "@/lib/scope-surface-entity-name";

export const metadata: Metadata = { title: "Assistants" };

// The header keeps naming the ENTITY on every tab: the ratified drawing makes
// this an entity page and the tab a tab OF it, so the tab's own name is carried
// by the strip, not by the heading. The name comes from the page's own gated
// read; a reader who may not be told it sees the scope's kind noun instead.
//
// The Assistants tab of the team scope (cinatra#2807, per-scope surfaces
// S1). The shell reads ONE thing about the scope - the entity's name for the
// page heading - behind that entity's own read gate; the tab's CONTENTS and
// their authorization arrive with the slice that fills this tab.
// cinatra#2808 (per-scope surfaces S2) fills this tab: the eligibility loader
// decides what this scope reaches, and the tab body draws it. An empty read
// keeps S1's honest placeholder — the shell never claims the scope holds
// nothing on a read it did not take.
export default async function TeamAssistantsPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = await params;
  await requireAuthSession();
  const scope = { kind: "team", id: teamId } as const;
  const [name, rows] = await Promise.all([
    readScopeSurfaceEntityName(scope),
    readScopeSurfaceAssistantRows(scope),
  ]);
  return (
    <ScopeSurfacePage
      scope={scope}
      tab="assistants"
      title={name ?? undefined}
      body={rows.length > 0 ? <ScopeAssistantsTab rows={rows} /> : undefined}
    />
  );
}
