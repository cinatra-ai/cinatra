import "server-only";

import {
  isDashboardArtifactType,
  type DashboardArtifactPointer,
} from "@/lib/dashboards/dashboard-artifact-surface";
import { resolveDashboardArtifactPointer } from "@/lib/dashboards/dashboard-artifact-pointer-resolvers";

/**
 * What a type's own read gate answers, past the row's own read authorization.
 * `ok` carries the dashboard's pointer for a dashboard row (null for every other
 * type): the page draws it in place of the generic floor wherever the display
 * dispatch answers a floor for the dashboard. `ok` also carries the dashboard's
 * live address (cinatra#4311): the pointer's canonical path, the address of the
 * canonical /dashboards route that enforces this same gate chain. It is null for
 * every other type, and for a pointer whose path is not one root-relative path.
 */
export type ArtifactTypeReadGate =
  | {
      readonly access: "ok";
      readonly dashboardPointer: DashboardArtifactPointer | null;
      readonly liveAddress: string | null;
    }
  | { readonly access: "not-found" }
  | { readonly access: "denied" };

const OK_NO_POINTER: ArtifactTypeReadGate = { access: "ok", dashboardPointer: null, liveAddress: null };
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
 * unknown access word, no access at all, `ok` without a pointer, no result, or
 * a result whose property read throws) throws the gate's own error, whose
 * message names no value, to the route's error boundary. A resolver that
 * rejects (a store failure) reaches that boundary with its own error. The
 * boundary draws its own diagnostic and no artifact display or content.
 */
export async function readArtifactTypeGate(artifact: {
  artifactId: string;
  objectType: string | null;
}): Promise<ArtifactTypeReadGate> {
  if (!isDashboardArtifactType(artifact.objectType)) return OK_NO_POINTER;
  const dashboard: unknown = await resolveDashboardArtifactPointer(artifact.artifactId);
  if (typeof dashboard !== "object" || dashboard === null) throw new ArtifactTypeReadGateError();
  let access: unknown;
  let pointer: unknown;
  let canonicalHref: unknown;
  try {
    ({ access, pointer } = dashboard as { access?: unknown; pointer?: unknown });
    if (typeof pointer === "object" && pointer !== null) {
      canonicalHref = (pointer as { canonicalHref?: unknown }).canonicalHref;
    }
  } catch {
    // A getter or proxy trap that throws: no known answer. Its error is not
    // read, because the thrower controls what it carries.
    throw new ArtifactTypeReadGateError();
  }
  if (access === "not-found") return NOT_FOUND;
  if (access === "denied") return DENIED;
  if (access === "ok" && typeof pointer === "object" && pointer !== null) {
    return {
      access: "ok",
      dashboardPointer: pointer as DashboardArtifactPointer,
      liveAddress: rootRelativePathOrNull(canonicalHref),
    };
  }
  throw new ArtifactTypeReadGateError();
}

/**
 * The canonical path as a live address, or null. Only one root-relative path of
 * this application passes: it starts with one "/" and holds no "//", no "\\",
 * no whitespace and no control character, so a browser cannot read it as an
 * address of another host.
 */
function rootRelativePathOrNull(href: unknown): string | null {
  if (typeof href !== "string") return null;
  if (!/^\/[^/\\]/.test(href)) return null;
  if (/[\s\\]|[\u0000-\u001f\u007f]|\/\//.test(href)) return null;
  return href;
}

/**
 * THE LIVE ADDRESS OF A DASHBOARD ROW ON A REVIEW SURFACE (cinatra#4311). The
 * review binder reads it for a dashboard target through this same gate, with the
 * reader's session. A row of another type answers null: its record's own address
 * stands. For a dashboard row, every answer that is not `ok` gives no address,
 * and so does a gate that cannot be read: a review card draws without the live
 * link rather than failing, and the gate's own error never reaches the card.
 */
export async function readDashboardLiveAddress(artifact: {
  artifactId: string;
  objectType: string | null;
}): Promise<{ readonly liveAddress: string | null } | null> {
  if (!isDashboardArtifactType(artifact.objectType)) return null;
  try {
    const gate = await readArtifactTypeGate(artifact);
    return { liveAddress: gate.access === "ok" ? gate.liveAddress : null };
  } catch {
    return { liveAddress: null };
  }
}
