import "server-only";

import type { ReactNode } from "react";

import type { PreparedReviewTarget } from "@/lib/artifacts/artifact-review-preparation";
import { ReviewTargetMount } from "@/app/artifacts/[id]/review-target-mount";
import type { PinnedCapturePairView } from "@/lib/artifacts/cms-preview-capture-view";

import { ReviewPinnedCapture } from "./review-pinned-capture";
import {
  reviewProvenanceConformanceId,
  reviewProvenanceLabel,
} from "@/lib/artifacts/review-surface-model";

/**
 * ONE review target panel (cinatra#1795 S12 item 4; spec design@458fb7ffce6cf4ab6a2c60d3ff47198135d8ea2f §II/§III):
 * the immutable target HEADER (display title + a mono meta line, inert — no edit
 * control, no revision picker, because the target is versioned and frozen) over
 * the REPRESENTATION SLOT into which the artifact's type renderer mounts (fed
 * host display-only props). Every target is type-agnostic: it keys on the OPAQUE
 * host mount kind only (G1-clean).
 *
 * NOTHING IS DRAWN ABOVE THE WORK ANY MORE. The panel used to open a
 * renderer-provenance region over every rendered target — a type chip, a package
 * chip for a runtime tier, and a mono `build-time · detail` line. §V of the
 * ratified artifact-review drawing forbids it outright: the resolution "is not
 * put on screen: a display shows the work and nothing about itself — no renderer
 * name, no package identity, no provenance line". §V.1 repeats it for the display
 * in the slot, and the lifecycle-cards drawing §III says it a third time.
 *
 * THE ISSUE QUOTED AN OLDER SENTENCE. cinatra#3141's own wording asks for a chip
 * here, which is what the drawing said at the commit this repository's pin names.
 * The drawing at its default branch is the text that governs the branch under
 * proof, and it decides against the region.
 *
 * Conformance anchors: the panel is `review-target`; the ONE region left is
 * `review-target-floor`, which the drawing keeps and requires — "the one that
 * does speak on a surface is the floor, and only because a reader must be told a
 * render failed".
 *
 * THE FALLBACK FACE IS GONE (plan `PLAN: Agents Lifecycle (B)` §5). The panel
 * used to pass a generic "no type renderer resolved" card — a sentence, a table
 * of technical fields, and Preview / Download links — as the floor node beneath
 * every degrade. A download link is never the body of a review, and inside a
 * third-party application those links were dead ends demanding a login that
 * never exists there. What remains is the sanitized diagnostic the mount draws
 * for a genuine no-renderer state and for each defensive state (a deleted or
 * unreadable target, a display mid-upgrade, a runtime failure), which keep their
 * own honest readings.
 */
export function ReviewTargetPanel({
  prepared,
  orgId,
  capturePair = null,
}: {
  prepared: PreparedReviewTarget;
  /** The reviewing surface's TRUSTED organization scope, from the host that
   * already authorized this reader — the form rung reads bytes under it. */
  orgId: string;
  /** S6 (#2044 L-B + L-D): the visual before/after PAIR pinned at gate creation
   * for this target — the live page beside the proposal composed into its chrome.
   * `null` for every target that has no captures, which renders nothing: the
   * pictures are additive context beneath the decided representation, never a
   * substitute. */
  capturePair?: PinnedCapturePairView | null;
}): ReactNode {
  const { props, mount } = prepared;
  const provenance = reviewProvenanceLabel(mount);
  const provenanceConformanceId = reviewProvenanceConformanceId(mount);

  return (
    <div
      data-conformance-id="review-target"
      data-field="name=type.displayName"
      className="overflow-hidden rounded-control border border-line bg-surface-strong"
    >
      {/* §IV — THE TARGET HEADER IS THE CARD'S NOW (cinatra#3141 item 7).
          The header used to be drawn here, inside the island document, which is
          the one part of the review a reader only sees once an iframe has
          painted: while the frame was still arriving the card drew a skeleton
          over it, and past the island's bounded wait it drew a recovery panel,
          and neither carried a title, a type or a revision. A pending gate on
          the run page drew with no header at all.

          `ReviewTargetHeader`, in the card, draws it in every one of those
          states — so what stays here is the part that genuinely needs the
          server: the provenance reading and the representation itself. Exactly
          one header per pinned target, and the card is the only place one can
          come from. */}
      {/* §V — THE FLOOR'S REGION, AND NO OTHER. The model gives every rendered
          rung a null region id, so this one null check IS the floor gate: a
          resolved renderer draws no region here at all — the reader is deciding
          on the work, not on what drew it. A floor keeps its mark because a
          reader must be told a render failed, and the sanitized diagnostic
          follows inside the slot below. A resolved renderer draws no
          region here at all: the reader is deciding on the work, not on what
          drew it. A floor keeps its mark because a reader must be told a render
          failed, and the sanitized diagnostic follows inside the slot below.
          (The host's own text rendering has no region either, and never did —
          cinatra#2931 W4.) */}
      {provenanceConformanceId !== null && provenance !== null ? (
        <div
          data-conformance-id={provenanceConformanceId}
          className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2"
        >
          <span className="inline-flex items-center rounded-full border border-line-strong px-2 py-0.5 text-badge-xs font-semibold text-muted-foreground">
            Floor
          </span>
          <span className="font-mono text-badge-2xs tracking-tight text-muted-foreground">
            structured data
          </span>
        </div>
      ) : null}

      {/* The representation slot — the type renderer mounts here, or the floor.
          S6: the PINNED before/after pair follows as non-decisional visual context. */}
      <div className="p-4" data-review-representation-slot="">
        <ReviewTargetMount mount={mount} props={props} orgId={orgId} fallback={null} />
        <ReviewPinnedCapture pair={capturePair} />
      </div>
    </div>
  );
}
