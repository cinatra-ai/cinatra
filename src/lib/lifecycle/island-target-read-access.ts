import "server-only";

// ---------------------------------------------------------------------------
// THE ARTIFACT READ, RE-PROVEN AT SERVE TIME (cinatra#4738).
//
// A sealed byte or capture capability is minted while the island prepares a target, and that preparation reads the
// artifact as the reader (`object.read`). Run access alone does not carry that read: a reader can keep the run and
// still be refused one of its artifacts, and the panel then draws the `read-denied` floor. The serving paths must
// therefore re-prove the same read before a byte or a picture goes out, or a capability (or a pinned set a gate or a
// publish row still shows) would hand out what the panel withheld.
//
// The read runs as the SEALED user with the person's live standing in the sealed organization, resolved through the
// same leaf the island's own actor comes from, so the answer at serve time is the answer the panel had. A reader
// whose standing no longer resolves keeps nothing. The answer is the subset of targets this reader may read.
// ---------------------------------------------------------------------------

import { readArtifactForDetail } from "@/lib/artifacts/artifact-service";
import { buildActorContextFromPrimitive } from "@/lib/authz/build-actor-context";
import { resolveWidgetLifecycleStanding } from "@/lib/lifecycle/widget-lifecycle-frame-actor";

/** The audit context of a standing denial on this path. Never an authorization input. */
const SERVE_AUDIT_SLUG = "lifecycle-island-serve";

/** The targets this sealed reader may still read (`object.read`), or `null` when the reader has no standing. */
export async function readIslandTargetsReadableBy<T extends { artifactId: string }>(input: {
  targets: readonly T[];
  userId: string;
  orgId: string;
}): Promise<T[] | null> {
  const standing = await resolveWidgetLifecycleStanding({
    userId: input.userId,
    orgId: input.orgId,
    auditSlug: SERVE_AUDIT_SLUG,
  });
  if (!standing.ok) return null;
  const actor = buildActorContextFromPrimitive(standing.actorCtx.actor, input.orgId, standing.actorCtx.roleHints);
  return input.targets.filter(
    (target) => readArtifactForDetail({ artifactId: target.artifactId, orgId: input.orgId, actor }).kind === "ok",
  );
}
