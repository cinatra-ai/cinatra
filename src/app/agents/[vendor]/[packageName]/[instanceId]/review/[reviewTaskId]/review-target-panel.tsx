import "server-only";

import type { ReactNode } from "react";

import type { PreparedReviewTarget } from "@/lib/artifacts/artifact-review-preparation";
import { ReviewTargetMount } from "@/app/artifacts/[id]/review-target-mount";
import type { PinnedCapturePairView } from "@/lib/artifacts/cms-preview-capture-view";

import { ReviewPinnedCapture } from "./review-pinned-capture";
import {
  reviewProvenanceConformanceId,
  reviewProvenanceLabel,
  reviewRevisionMarker,
  reviewTargetRowFacts,
  reviewTypeLabel,
} from "@/lib/artifacts/review-surface-model";

/**
 * ONE review target panel (cinatra#1795 S12 item 4; spec design@458fb7ffce6cf4ab6a2c60d3ff47198135d8ea2f §II/§III):
 * the immutable target HEADER (display title + a mono meta line, inert — no edit
 * control, no revision picker, because the target is versioned and frozen) over
 * the REPRESENTATION SLOT into which the
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
  const { target, props, mount } = prepared;
  const title = props?.artifact.title ?? target.artifactId;
  const objectType = props?.artifact.objectType ?? "";
  const typeLabel = objectType ? reviewTypeLabel(objectType) : "Artifact";
  const revision = reviewRevisionMarker(target.representationRevisionId);
  const provenance = reviewProvenanceLabel(mount);
  const provenanceConformanceId = reviewProvenanceConformanceId(mount);

  return (
    <div
      data-conformance-id="review-target"
      data-field="name=type.displayName"
      className="overflow-hidden rounded-control border border-line bg-surface-strong"
    >
      {/* §II — the immutable target header (inert). */}
      <div className="border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-sans text-sm font-bold text-foreground">{title}</span>
          <span className="inline-flex items-center rounded-full border border-blue/30 bg-blue/10 px-2 py-0.5 text-xs font-semibold text-blue">
            {typeLabel}
          </span>
        </div>
        <p className="mt-1 font-mono text-badge-xs tracking-tight text-muted-foreground">
          {objectType ? <span>{objectType} · </span> : null}
          <span title={revision.full}>revision {revision.short}</span>
          <span className="text-mustard-ink"> · pinned</span>
          {props ? (
            <>
              {" · "}
              {reviewTargetRowFacts(props.artifact).join(" · ")}
            </>
          ) : null}
        </p>
      </div>

      {/* §V of the ratified drawing — THE RESOLUTION IS NOT PUT ON SCREEN.
          Verbatim: "It is not put on screen: a display shows the work and
          nothing about itself — no renderer name, no package identity, no
          provenance line — because the reader is deciding on the work, not on
          what drew it", and: "a build-time renderer and a runtime one are drawn
          the same way, because nothing on either target says which resolved it
          ... The one that does speak on a surface is the floor, and only because
          a reader must be told a render failed."

          An earlier ratified reading of this same section said the opposite —
          "a build-time renderer ... carries the extension's indigo chip; a
          runtime renderer ... carries the same chip plus its package identity"
          — and this panel was built to it. The drawing has since replaced that
          paragraph, and the markdown display's own section repeats the current
          rule for every surface it is drawn on: "no renderer chip and no
          provenance line, here or on any other surface this display is drawn".

          The host-derived provenance itself is UNCHANGED and still recorded with
          the decision (`provenanceFromResolvedMount`); what changed is that the
          reviewer is no longer shown it. Only the floor still speaks, and only
          to say a render failed. */}
      {provenance !== null && provenance.kind === "floor" && provenanceConformanceId !== null ? (
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
