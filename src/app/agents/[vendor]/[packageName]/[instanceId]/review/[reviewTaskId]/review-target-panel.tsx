import "server-only";

import type { ReactNode } from "react";

import type { PreparedReviewTarget } from "@/lib/artifacts/artifact-review-preparation";
import { ReviewTargetMount } from "@/app/artifacts/[id]/review-target-mount";
import type { PinnedCapturePairView } from "@/lib/artifacts/cms-preview-capture-view";

import { ReviewPinnedCapture } from "./review-pinned-capture";
import {
  reviewProvenanceConformanceId,
  reviewProvenanceLabel,
  reviewTypeLabel,
} from "@/lib/artifacts/review-surface-model";

/**
 * ONE review target panel (cinatra#1795 S12 item 4; spec design@458fb7ffce6cf4ab6a2c60d3ff47198135d8ea2f §II/§III):
 * the immutable target HEADER (display title + a mono meta line, inert — no edit
 * control, no revision picker, because the target is versioned and frozen) over
 * the RENDERER-PROVENANCE chip, over the REPRESENTATION SLOT into which the
 * artifact's type renderer mounts (fed host display-only props). Every target is
 * type-agnostic: it keys on the OPAQUE host mount kind only (G1-clean).
 *
 * Conformance anchors (design@458fb7ffce6cf4ab6a2c60d3ff47198135d8ea2f): the panel is `review-target`; the
 * provenance region is `review-provenance-native` (build-time), `review-
 * provenance-marketplace` (runtime), or `review-target-floor` (any floor) — the
 * §III axis derived from the mount kind — and there is NO region at all when the
 * host itself rendered a declared text form (cinatra#2931 W4): the three drawn
 * regions each state which package's renderer drew the work, or that nothing
 * did, and neither reading is true of the host's own markdown / plain-text
 * rendering. The reviewer gets the draft with nothing above it.
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
  const objectType = props?.artifact.objectType ?? "";
  const typeLabel = objectType ? reviewTypeLabel(objectType) : "Artifact";
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
      {/* §III — renderer provenance chip. NOTHING is drawn above the reviewed
          work when the host itself rendered a declared text form: that target
          has no provenance region at all (cinatra#2931 W4). */}
      {provenanceConformanceId !== null && provenance !== null ? (
        <div
          data-conformance-id={provenanceConformanceId}
          className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2"
        >
          {provenance.kind === "floor" ? (
            <span className="inline-flex items-center rounded-full border border-line-strong px-2 py-0.5 text-badge-xs font-semibold text-muted-foreground">
              Floor
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full border border-info/30 bg-info/10 px-2 py-0.5 text-badge-xs font-semibold text-info">
              {typeLabel}
            </span>
          )}
          {provenance.kind === "runtime" && provenance.packageName ? (
            <span className="inline-flex items-center rounded-full border border-line bg-surface-muted px-2 py-0.5 font-mono text-badge-2xs text-foreground">
              {provenance.packageName}
            </span>
          ) : null}
          <span className="font-mono text-badge-2xs tracking-tight text-muted-foreground">
            {provenance.kind === "build-time"
              ? `build-time · ${provenance.slot}`
              : provenance.kind === "runtime"
                ? `runtime · ${provenance.slot}`
                : "structured data"}
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
