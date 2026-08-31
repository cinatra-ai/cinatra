import type { Metadata } from "next";

import { ScopeSurfacePage } from "@/components/scope-surface-page";
import { requireAuthSession } from "@/lib/auth-session";

export const metadata: Metadata = { title: "Artifacts" };

// The Artifacts tab of the project scope (cinatra#2807, per-scope surfaces
// S1). The shell reads nothing about the scope, so an authenticated viewer is
// the whole gate here; the per-scope read and its authorization arrive with the
// slice that fills this tab.
export default async function ProjectArtifactsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  await requireAuthSession();
  return <ScopeSurfacePage scope={{ kind: "project", id: projectId }} tab="artifacts" />;
}
