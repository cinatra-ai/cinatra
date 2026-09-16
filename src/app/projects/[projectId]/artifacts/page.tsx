import type { Metadata } from "next";

import { ScopeSurfacePage } from "@/components/scope-surface-page";
import { requireAuthSession } from "@/lib/auth-session";
import { readScopeSurfaceEntityName } from "@/lib/scope-surface-entity-name";

export const metadata: Metadata = { title: "Artifacts" };

// The header keeps naming the ENTITY on every tab: the ratified drawing makes
// this an entity page and the tab a tab OF it, so the tab's own name is carried
// by the strip, not by the heading. The name comes from the page's own gated
// read; a reader who may not be told it sees the scope's kind noun instead.
//
// The Artifacts tab of the project scope (cinatra#2807, per-scope surfaces
// S1). The shell reads ONE thing about the scope - the entity's name for the
// page heading - behind that entity's own read gate; the tab's CONTENTS and
// their authorization arrive with the slice that fills this tab.
export default async function ProjectArtifactsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  await requireAuthSession();
  const scope = { kind: "project", id: projectId } as const;
  const name = await readScopeSurfaceEntityName(scope);
  return <ScopeSurfacePage scope={scope} tab="artifacts" title={name ?? undefined} />;
}
