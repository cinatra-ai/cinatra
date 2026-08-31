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
 * the REPRESENTATION SLOT into which the artifact's type renderer mounts (fed
 * host display-only props). Every target is type-agnostic: it keys on the OPAQUE
 * host mount kind only (G1-clean).
 *
 * THE TARGET SAYS NOTHING ABOUT ITSELF (cinatra#3080, the ratified drawing at
 * the pin this route's conformance suite records). The panel used to draw a
 * RENDERER-PROVENANCE row beneath the header — the type chip again, the runtime
 * package's identity, and a `build-time · <slot>` / `runtime · <slot>`
 * resolution line. The drawing forbids that twice over: the renderer resolution
 * "is NOT put on screen: a display shows the work and nothing about itself — no
 * renderer name, no package identity, no provenance line — because the reader is
 * deciding on the work, not on what drew it", and it draws a build-time target
 * and a runtime one identically for exactly that reason; the markdown display's
 * own header is "the two tabs, and the saving indicator below, and nothing else
 * — no renderer chip and no provenance line, here or on any other surface this
 * display is drawn". The row is gone from every resolved renderer.
 *
 * THE FLOOR STILL SPEAKS — "and only because a reader must be told a render
 * failed". A target that resolved to no renderer keeps the drawing's own floor
 * mark (`Floor` over `structured data`) above the mount's sanitized
 * package · slot · reason diagnostic. That is the failure state's reading, not a
 * provenance line: it says the work could not be drawn, never who would have
 * drawn it.
 *
 * Conformance anchors (design@458fb7ffce6cf4ab6a2c60d3ff47198135d8ea2f): the panel is `review-target`; the
 * ONE region beneath the header is `review-target-floor`, drawn for a floor
 * mount alone. `review-provenance-native` (build-time) and
 * `review-provenance-marketplace` (runtime) are the older revision's anchors for
 * regions the newer drawing forbids: the model still classifies a mount into
 * them, and nothing renders them.
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

      {/* §III — the FLOOR's own mark, and nothing else. A resolved renderer
          draws no region here at all: the reader is deciding on the work, not
          on what drew it. A floor keeps its mark because a reader must be told
          a render failed, and the sanitized diagnostic follows inside the slot
          below. (The host's own text rendering has no region either, and never
          did — cinatra#2931 W4.) */}
      {provenanceConformanceId === "review-target-floor" && provenance !== null ? (
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
