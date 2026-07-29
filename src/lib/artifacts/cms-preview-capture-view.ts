/**
 * The PURE view model for pinned preview captures (cinatra#2044 S6, L-B).
 *
 * THE CONTRACT THIS MODULE EXISTS TO MAKE TESTABLE: the review surface shows
 * ONLY what was pinned at gate creation. There is no fetch here, no URL of a
 * remote site, no live document — the single URL produced is the host's own
 * version-pinned artifact byte route for the STORED screenshot, which is served
 * under the same session/actor/tenant/tombstone gating as every other artifact
 * and carries the host's sandbox CSP. `assertNoRemoteDocumentUrls` is the
 * machine-checkable form of that promise, and the view-path test asserts it plus
 * a zero-call network spy.
 *
 * Region geometry is emitted as PERCENTAGES of the captured image so the overlay
 * scales with whatever width the panel renders at, and so the surface never has
 * to know the device pixel ratio the renderer used. The boxes come from the
 * ADAPTER's `data-cinatra-region` anchors only (#2044 forbids reviewer-side CSS
 * guessing) — this module transports them, it never infers one.
 *
 * PURE: no React, no DB, no server-only import.
 */
import type {
  CmsPreviewCaptureRole,
  CmsPreviewCaptureStatus,
  StoredPreviewCapture,
} from "./cms-preview-capture-store";

/** One region highlight, in percent of the captured image box. */
export interface PinnedCaptureRegionView {
  region: string;
  leftPct: number;
  topPct: number;
  widthPct: number;
  heightPct: number;
  /** L-D: this region is one the S4 read-back flagged as changed OUTSIDE the
   * reviewed scope. Set only on the verification pair, from the verification
   * record's own out-of-scope path list — never inferred from the picture. */
  drifted?: boolean;
}

export interface PinnedCaptureView {
  captureArtifactId: string;
  role: CmsPreviewCaptureRole;
  status: CmsPreviewCaptureStatus;
  /** The host's own version-pinned byte route for the stored PNG — null for a
   * degraded capture (there are no bytes, and the surface states the gap). */
  imageUrl: string | null;
  /** Named degrade reason, surfaced verbatim so the gap is explicit. */
  degradedReason: string | null;
  capturedAt: string;
  sourceOrigin: string | null;
  regions: PinnedCaptureRegionView[];
  /** sha256 of the sanitized page — the capture's context provenance. */
  captureDigest: string | null;
  /** How many executable constructs the sanitizer removed, if any. */
  removedConstructs: number;
  /** Cross-origin subresources the isolated renderer refused. */
  blockedSubresources: number;
  /**
   * L-D — set ONLY on a COMPOSED picture (the proposal): the adapter-marked
   * regions the proposed values were placed into, and every proposed field whose
   * value did NOT reach the picture. `null` on a straight fetched render. The
   * surface uses this to tell the reviewer, without hedging, which picture is a
   * photograph of the site and which is the proposal inside that photograph's
   * chrome.
   */
  composition: { substitutedRegions: string[]; unplacedFields: string[] } | null;
}

/** The host byte route for a pinned capture. Same-origin, version-pinned, and
 * authorization-gated by the route itself — never a remote document. */
export function pinnedCaptureImageUrl(
  captureArtifactId: string,
  representationRevisionId: string,
): string {
  return `/api/artifacts/${encodeURIComponent(captureArtifactId)}/versions/${encodeURIComponent(
    representationRevisionId,
  )}/preview`;
}

function toRegionViews(capture: StoredPreviewCapture): PinnedCaptureRegionView[] {
  const geometry = capture.data.geometry;
  if (!geometry) return [];
  const width = geometry.viewport?.width ?? 0;
  const height = geometry.contentHeight ?? 0;
  if (width <= 0 || height <= 0) return [];
  const clamp = (n: number) => Math.max(0, Math.min(100, n));
  return geometry.regions
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => ({
      region: r.region,
      leftPct: clamp((r.x / width) * 100),
      topPct: clamp((r.y / height) * 100),
      widthPct: clamp((r.width / width) * 100),
      heightPct: clamp((r.height / height) * 100),
    }));
}

/** Project stored captures into the surface's view model. */
export function buildPinnedCaptureViews(
  captures: readonly StoredPreviewCapture[],
): PinnedCaptureView[] {
  return captures.map((capture) => {
    const sanitization = capture.data.sanitization ?? null;
    const removed = sanitization
      ? Object.values(sanitization).reduce((sum, n) => sum + (Number(n) || 0), 0)
      : 0;
    return {
      captureArtifactId: capture.captureArtifactId,
      role: capture.data.role,
      status: capture.data.status,
      imageUrl:
        capture.data.status === "captured" && capture.representationRevisionId
          ? pinnedCaptureImageUrl(capture.captureArtifactId, capture.representationRevisionId)
          : null,
      degradedReason: capture.data.degradedReason,
      capturedAt: capture.data.capturedAt,
      sourceOrigin: capture.data.sourceOrigin,
      regions: toRegionViews(capture),
      captureDigest: capture.data.captureDigest,
      removedConstructs: removed,
      blockedSubresources: capture.data.network?.blockedRequests ?? 0,
      composition: capture.data.composition ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// L-D — the PAIR. #2044's "visual before/after" is not two independent pictures
// stacked; it is one comparison with a fixed reading order, in which either side
// may be honestly missing. This projection makes the ORDER and the MISSING-SIDE
// states data, so the surface renders a comparison and the whole matrix is
// unit-tested without React.
// ---------------------------------------------------------------------------

/** Which comparison a pair renders. */
export type PinnedCapturePairKind =
  /** Gate creation: the live page vs the proposal composed into its chrome. */
  | "review"
  /** S4 read-back: the reviewed proposal vs the page as it actually landed. */
  | "verification";

export interface PinnedCapturePairView {
  kind: PinnedCapturePairKind;
  /** The left-hand ("before") picture — absent when no capture exists at all. */
  left: PinnedCaptureView | null;
  /** The right-hand ("after") picture — absent when no capture exists at all. */
  right: PinnedCaptureView | null;
  leftLabel: string;
  rightLabel: string;
}

/** Role → the picture that plays each side, per comparison. */
const PAIR_ROLES: Record<
  PinnedCapturePairKind,
  { left: CmsPreviewCaptureRole; right: CmsPreviewCaptureRole; leftLabel: string; rightLabel: string }
> = {
  review: {
    left: "before",
    right: "current",
    leftLabel: "Now — the published page",
    rightLabel: "After this change — proposed",
  },
  verification: {
    left: "current",
    right: "applied",
    leftLabel: "Reviewed — what you approved",
    rightLabel: "Applied — what the site now shows",
  },
};

/**
 * Project the stored captures into ONE comparison.
 *
 * `driftedRegions` marks region outlines on the RIGHT-hand picture that the S4
 * read-back reported as out-of-scope changes. It comes from the verification
 * record's own `outOfScopePaths` — the surface never infers drift from pixels.
 */
export function buildPinnedCapturePair(
  views: readonly PinnedCaptureView[],
  kind: PinnedCapturePairKind,
  driftedRegions: readonly string[] = [],
): PinnedCapturePairView | null {
  const spec = PAIR_ROLES[kind];
  const pick = (role: CmsPreviewCaptureRole) => views.find((v) => v.role === role) ?? null;
  const left = pick(spec.left);
  const rightRaw = pick(spec.right);
  if (!left && !rightRaw) return null;
  const drift = new Set(driftedRegions);
  const right =
    rightRaw && drift.size > 0
      ? {
          ...rightRaw,
          regions: rightRaw.regions.map((r) =>
            drift.has(r.region) ? { ...r, drifted: true } : r,
          ),
        }
      : rightRaw;
  return {
    kind,
    left,
    right,
    leftLabel: spec.leftLabel,
    rightLabel: spec.rightLabel,
  };
}

/**
 * The INERT-BY-CONTRACT assertion: every URL the view model hands the surface
 * must be a host-relative path. A remote document url reaching the surface would
 * mean the review page fetches the site at view time — exactly what #2044
 * forbids — so this returns the offenders and the view-path test fails on any.
 */
export function findRemoteDocumentUrls(views: readonly PinnedCaptureView[]): string[] {
  const offenders: string[] = [];
  for (const view of views) {
    if (view.imageUrl === null) continue;
    if (!view.imageUrl.startsWith("/api/artifacts/")) offenders.push(view.imageUrl);
  }
  return offenders;
}
