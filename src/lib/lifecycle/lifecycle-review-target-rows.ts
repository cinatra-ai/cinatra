import "server-only";

// ---------------------------------------------------------------------------
// THE GATE'S OWN TARGET ROWS (cinatra#3051).
//
// WHAT THIS IS FOR. The review card's target panel used to have no reading of
// its own: the immutable header (`app-artifact-review` §IV) and the never-blank
// floor (§V) were both drawn INSIDE the island document, so every outcome that
// is not a completed frame load presented the reader with a panel that named
// nothing — no title, no package, no revision, no ownership, no visibility, no
// floor. Measured inside a third-party application at the pending instant, that
// is exactly what the card drew.
//
// The header's fields are facts of the gate's OWN pinned rows. They do not
// depend on the preview arriving, so they travel with the answer that already
// authorized the card, and the card draws them at its first render.
//
// ONE LOADER, SO THE TWO READINGS CANNOT DISAGREE. These rows are projected
// from the SAME `loadReviewGateSurface` the island renders from — never a second
// read path with its own idea of what a target is. What the card names before
// the frame paints is therefore what the frame paints.
//
// IT AUTHORIZES NOTHING. The loader re-runs the reader's run access and reads
// the pinned set from the frozen gate, exactly as it does for the island; a
// reader who may not read the run gets no rows, and the caller only asks at all
// for a state the card's own ladder already admitted.
//
// DISPLAY FACTS ONLY. Ids, the display title, the type id, the two scope facts,
// the MIME, the updated time, and the package whose renderer the host resolved.
// No bytes, no renderer descriptor, no href — the representation stays the
// island's job.
// ---------------------------------------------------------------------------

import type { ReviewTargetRow } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { REVIEW_TARGET_ROWS_MAX } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { REVIEW_TARGET_ROW_FIELD_MAX_LENGTH } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import type { PreparedReviewTarget } from "@/lib/artifacts/artifact-review-preparation";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";
import { loadReviewGateSurface } from "@/app/artifacts/[id]/review-gate-ports";
import type { LifecycleGateRefPayload } from "@/lib/lifecycle/lifecycle-card-ref";

/**
 * How long an answer waits for the rows before going without them.
 *
 * THE CARD MUST NEVER WAIT ON THIS. The rows are what the panel NAMES its target
 * with; the card itself is authorized by the state beside them. So a surface
 * load that is slow — or stuck behind a store that is — must cost the header and
 * the floor, never the card: past this bound the answer carries no rows and the
 * panel draws its §V line alone, which is still strictly more than the blank it
 * used to draw. The losing read is abandoned, not cancelled (the loader takes no
 * signal); it settles into nothing and is collected.
 *
 * Bounded well under the island's own 12-second load bound, because a header
 * that arrives after the frame it was meant to stand in for has arrived too
 * late to be worth anything.
 */
export const REVIEW_TARGET_ROWS_DEADLINE_MS = 2_000;

/** Clamp one display string to the ceiling the row schema accepts. `null` for
 *  anything that is not a usable string, so a row never carries `"undefined"`. */
function field(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > REVIEW_TARGET_ROW_FIELD_MAX_LENGTH
    ? trimmed.slice(0, REVIEW_TARGET_ROW_FIELD_MAX_LENGTH)
    : trimmed;
}

/** The package whose renderer the host resolved for this target, where one
 *  resolved. The form rung is the host's own renderer and names no package. */
function packageOf(mount: PreparedReviewTarget["mount"]): string | null {
  switch (mount.kind) {
    case "build-map":
    case "runtime":
      return mount.packageName;
    case "floor":
      return mount.packageName;
    case "form":
      return null;
  }
}

/**
 * ONE prepared target, as the row the card draws its header and floor from.
 *
 * Exported for its own unit test: this is the projection that must not drift
 * from what `ReviewTargetPanel` reads off the same object.
 */
export function reviewTargetRowFor(prepared: PreparedReviewTarget): ReviewTargetRow {
  const artifact = prepared.props?.artifact ?? null;
  return {
    artifactId: prepared.target.artifactId,
    representationRevisionId: prepared.target.representationRevisionId,
    // The panel's own fallback, kept identical: a target with no readable
    // artifact is named by its id rather than by nothing.
    title: field(artifact?.title),
    objectType: field(artifact?.objectType),
    ownerLevel: field(artifact?.ownerLevel),
    visibility: field(artifact?.visibility),
    mime: field(artifact?.mime),
    updatedAt: field(artifact?.updatedAt),
    packageName: field(packageOf(prepared.mount)),
  };
}

/**
 * The rows for one gate, for one reader. `null` — never a reason and never a
 * throw — for every answer that is not a surface with targets: no run access, no
 * such gate, a gate too damaged to read, a store that failed. The card then
 * draws its floor without a header rather than nothing at all, which is still
 * strictly more than it drew before this.
 */
export async function resolveReviewTargetRows(
  payload: LifecycleGateRefPayload,
  actorCtx: ReviewActorContext,
): Promise<readonly ReviewTargetRow[] | null> {
  try {
    const surface = await Promise.race([
      loadReviewGateSurface({
        runId: payload.runId,
        reviewTaskId: payload.reviewTaskId,
        actorCtx,
      }),
      new Promise<null>((resolve) => {
        const timer = setTimeout(() => resolve(null), REVIEW_TARGET_ROWS_DEADLINE_MS);
        // Node keeps the process alive for a pending timer; this one must never
        // hold a request open past the answer it was racing.
        timer.unref?.();
      }),
    ]);
    if (!surface) return null;
    // `ready` and `settled` are the two readings that HAVE a pinned set. Every
    // other answer is a denial or an absence, and both draw no rows here for
    // the same reason the island draws no panels for them.
    if (surface.kind !== "ready" && surface.kind !== "settled") return null;
    return surface.targets.slice(0, REVIEW_TARGET_ROWS_MAX).map(reviewTargetRowFor);
  } catch {
    return null;
  }
}
