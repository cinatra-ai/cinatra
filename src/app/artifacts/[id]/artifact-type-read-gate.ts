import "server-only";

import {
  isDashboardArtifactType,
  type DashboardArtifactPointer,
} from "@/lib/dashboards/dashboard-artifact-surface";
import { resolveDashboardArtifactPointer } from "@/lib/dashboards/dashboard-artifact-pointer-resolvers";

/**
 * What a type's own read gate answers, past the row's own read authorization.
 * `ok` carries the dashboard's pointer for a dashboard row (null for every other
 * type): the page draws it in place of the generic floor while no installed
 * display claims the dashboard.
 */
export type ArtifactTypeReadGate =
  | { readonly access: "ok"; readonly dashboardPointer: DashboardArtifactPointer | null }
  | { readonly access: "not-found" }
  | { readonly access: "denied" };

const OK_NO_POINTER: ArtifactTypeReadGate = { access: "ok", dashboardPointer: null };
const NOT_FOUND: ArtifactTypeReadGate = { access: "not-found" };
const DENIED: ArtifactTypeReadGate = { access: "denied" };

/** The gate refuses an answer it does not know. Its message names no value. */
export class ArtifactTypeReadGateError extends Error {
  constructor() {
    super("the dashboard read gate answered no known access");
    this.name = "ArtifactTypeReadGateError";
  }
}

/**
 * THE TYPE'S OWN READ GATE (cinatra#3092). A type whose row is a twin of a record
 * with its own authorization keeps that authorization on the artifact page too,
 * before the page reads the row's review or resolves its display. A dashboard
 * row passes the gate chain the canonical /dashboards/[id] route enforces
 * (`resolveDashboardArtifactPointer`): an absent row, a workspace dashboard, a
 * project template, an orphaned or archived extension dashboard is not found,
 * and a reader the dashboard's owner and project grant refuses is denied.
 *
 * AN ALLOW-LIST, NEVER A PASS-THROUGH. Only the three known answers are read:
 * `ok` with a pointer object, `not-found` and `denied`. Any other answer (an
 * unknown access word, no access at all, `ok` without a pointer, no result)
 * throws, exactly as a store failure throws, to the route's error boundary. That
 * boundary draws its own diagnostic and no artifact display or content.
 */
export async function readArtifactTypeGate(artifact: {
  artifactId: string;
  objectType: string | null;
}): Promise<ArtifactTypeReadGate> {
  if (!isDashboardArtifactType(artifact.objectType)) return OK_NO_POINTER;
  const dashboard: unknown = await resolveDashboardArtifactPointer(artifact.artifactId);
  if (typeof dashboard !== "object" || dashboard === null) throw new ArtifactTypeReadGateError();
  const { access, pointer } = dashboard as { access?: unknown; pointer?: unknown };
  if (access === "not-found") return NOT_FOUND;
  if (access === "denied") return DENIED;
  if (access === "ok" && typeof pointer === "object" && pointer !== null) {
    return { access: "ok", dashboardPointer: pointer as DashboardArtifactPointer };
  }
  throw new ArtifactTypeReadGateError();
}
