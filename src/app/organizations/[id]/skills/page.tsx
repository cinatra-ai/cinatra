import type { Metadata } from "next";

import { ScopeSurfaceSkillsTab } from "@/components/scope/scope-surface-skills-tab";
import { ScopeSurfacePage } from "@/components/scope-surface-page";
import { requireAuthSession } from "@/lib/auth-session";
import { readScopeSurfaceEntityName } from "@/lib/scope-surface-entity-name";

export const metadata: Metadata = { title: "Skills" };

// The header keeps naming the ENTITY on every tab: the ratified drawing makes
// this an entity page and the tab a tab OF it, so the tab's own name is carried
// by the strip, not by the heading. The name comes from the page's own gated
// read; a reader who may not be told it sees the scope's kind noun instead.
//
// The Skills tab of the organization scope (cinatra#2807, per-scope surfaces
// S1). The shell reads ONE thing about the scope - the entity's name for the
// page heading - behind that entity's own read gate; the tab's CONTENTS and
// their authorization arrive with the slice that fills this tab.
// The tab's CONTENTS (cinatra#2810, per-scope surfaces S4): the ownership
// subset this scope owns, read from each row's DURABLE ownership tuple and
// rendered through the landed list component. `tabRead` tells the shell the
// read HAPPENED, so an empty tab reports the scope owns nothing rather than
// claiming the tab is unfinished.
export default async function OrganizationSkillsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireAuthSession();
  const scope = { kind: "organization", id } as const;
  const name = await readScopeSurfaceEntityName(scope);
  return (
    <ScopeSurfacePage
      scope={scope}
      tab="skills"
      title={name ?? undefined}
      tabRead
      tabBody={<ScopeSurfaceSkillsTab scope={scope} />}
    />
  );
}
