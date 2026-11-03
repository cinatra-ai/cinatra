import "server-only";

import { isDashboardArtifactType } from "@/lib/dashboards/dashboard-artifact-surface";
import { resolveDashboardArtifactPointer } from "@/lib/dashboards/dashboard-artifact-pointer-resolvers";

/** What a type's own read gate answers, past the row's own read authorization. */
export type ArtifactTypeReadGate = "ok" | "not-found" | "denied";

/**
 * THE TYPE'S OWN READ GATE (cinatra#3092). Every row draws through the page's one
 * display dispatch, but a type whose row is a twin of a record with its own
 * authorization keeps that authorization on the artifact page too. A dashboard
 * row passes the gate chain the canonical /dashboards/[id] route enforces
 * (`resolveDashboardArtifactPointer`): an absent row, a workspace dashboard, a
 * project template, an orphaned or archived extension dashboard is not found,
 * and a reader the dashboard's owner and project grant refuses is denied.
 *
 * This decides access only, never the drawing. A store failure throws to the
 * route's error boundary, so a row whose gate cannot be read is never drawn.
 */
export async function readArtifactTypeGate(artifact: {
  artifactId: string;
  objectType: string | null;
}): Promise<ArtifactTypeReadGate> {
  if (!isDashboardArtifactType(artifact.objectType)) return "ok";
  const dashboard = await resolveDashboardArtifactPointer(artifact.artifactId);
  return dashboard.access;
}
