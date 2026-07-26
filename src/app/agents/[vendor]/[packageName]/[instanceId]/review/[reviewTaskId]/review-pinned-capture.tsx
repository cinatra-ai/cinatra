import "server-only";

import type { ReactNode } from "react";

import type {
  PinnedCapturePairView,
  PinnedCaptureView,
} from "@/lib/artifacts/cms-preview-capture-view";

/**
 * The PINNED page captures shown as review CONTEXT (cinatra#2044 S6, sub-lanes
 * L-B + L-D), rendered inside the target panel's representation area — beneath
 * the decided data, never in place of it.
 *
 * What a reviewer gets: the page as it looks NOW, side by side with how it will
 * look AFTER the change — both inside the site's own theme chrome, with the
 * adapter-marked owned regions outlined. On the S4 verification view the same
 * component shows the other pair #2044 names: what was REVIEWED against what was
 * actually APPLIED, with any out-of-scope drift outlined on the applied side.
 *
 * What the surface promises, and states on screen:
 *
 *   - Both pictures are STATIC IMAGES captured server-side and stored. They are
 *     served from the host's own version-pinned artifact byte route, so nothing
 *     here is a live document and no request reaches the site when this page is
 *     viewed. Re-opening an old gate shows the ORIGINAL pictures even after the
 *     site's theme changes.
 *   - The chrome around the owned regions is NON-DECISIONAL context. The decision
 *     binds to the content snapshot above, which is what the gate pinned — this
 *     block never carries an affordance.
 *   - Region outlines come EXCLUSIVELY from the adapter's own markers (#2044
 *     forbids reviewer-side CSS guessing). An adapter that marks nothing shows an
 *     unannotated page rather than a guess.
 *   - The PROPOSED picture is honestly labelled as COMPOSED: the site does not
 *     hold the proposal (that is the whole point of holding the effect), so its
 *     picture is the live page with the proposed values placed into the regions
 *     the adapter marked as its own. The caption says exactly that — it is never
 *     presented as a photograph of a page that exists.
 *   - A picture that could not be taken says WHY, in place, instead of leaving a
 *     silent gap (#2044's honest-fallback rule) — and one missing half never
 *     costs the reviewer the other.
 */
export function ReviewPinnedCapture({ pair }: { pair: PinnedCapturePairView | null }): ReactNode {
  if (!pair) return null;
  return (
    <div data-conformance-id="review-pinned-capture" className="mt-4 flex flex-col gap-2">
      <p
        className="font-mono text-badge-2xs uppercase tracking-widest text-muted-foreground"
        data-capture-pair={pair.kind}
      >
        {pair.kind === "review" ? "Visual before / after" : "Reviewed / applied"}
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        <PinnedCaptureBlock side="left" label={pair.leftLabel} capture={pair.left} />
        <PinnedCaptureBlock side="right" label={pair.rightLabel} capture={pair.right} />
      </div>
    </div>
  );
}

function PinnedCaptureBlock({
  side,
  label,
  capture,
}: {
  side: "left" | "right";
  label: string;
  capture: PinnedCaptureView | null;
}): ReactNode {
  const driftedCount = capture ? capture.regions.filter((r) => r.drifted).length : 0;
  return (
    <figure
      className="min-w-0 overflow-hidden rounded-control border border-line bg-surface"
      data-capture-side={side}
      data-capture-role={capture?.role ?? "missing"}
    >
      <figcaption className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <span className="font-sans text-xs font-bold text-foreground">{label}</span>
        <span className="inline-flex items-center rounded-full border border-line-strong px-2 py-0.5 text-badge-2xs font-semibold text-muted-foreground">
          Context · not decided here
        </span>
        {capture ? (
          <span className="font-mono text-badge-2xs tracking-tight text-muted-foreground">
            pinned {capture.capturedAt}
            {capture.sourceOrigin ? ` · ${capture.sourceOrigin}` : ""}
          </span>
        ) : null}
      </figcaption>

      {capture === null ? (
        <div className="px-3 py-3">
          <p className="font-sans text-xs font-bold text-foreground">
            This side was never captured
          </p>
          <p className="mt-1 max-w-[66ch] text-xs leading-relaxed text-muted-foreground">
            No capture was recorded for this half of the comparison. The content above is still the
            complete, reviewable change — only the visual context is missing.
          </p>
        </div>
      ) : capture.imageUrl ? (
        <>
          <div className="relative bg-surface-muted">
            {/* A stored PNG served by the host's version-pinned byte route. Plain
                <img> on purpose: no iframe, no remote document, nothing live. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={capture.imageUrl}
              alt={`${label} — capture pinned at review time`}
              className="block h-auto w-full"
            />
            {capture.regions.map((region, index) => (
              <span
                key={`${region.region}-${index}`}
                aria-hidden="true"
                data-cinatra-region-highlight={region.region}
                {...(region.drifted ? { "data-region-drifted": "true" } : {})}
                className={
                  region.drifted
                    ? "pointer-events-none absolute rounded-sm border-2 border-amber-500/80 bg-amber-500/15"
                    : "pointer-events-none absolute rounded-sm border-2 border-logo/70 bg-logo/10"
                }
                style={{
                  left: `${region.leftPct}%`,
                  top: `${region.topPct}%`,
                  width: `${region.widthPct}%`,
                  height: `${region.heightPct}%`,
                }}
              />
            ))}
          </div>
          <div className="border-t border-line px-3 py-2">
            <p className="font-mono text-badge-2xs leading-relaxed tracking-tight text-muted-foreground">
              {capture.composition
                ? `composed · the proposed ${formatList(capture.composition.substitutedRegions)} placed into the page's own region${capture.composition.substitutedRegions.length === 1 ? "" : "s"} · `
                : "as fetched from the site · "}
              {capture.regions.length > 0
                ? `${capture.regions.length} owned region${capture.regions.length === 1 ? "" : "s"} outlined (${capture.regions
                    .map((r) => r.region)
                    .join(", ")}) · `
                : "no owned regions marked by the site · "}
              static capture · no live page is loaded
              {capture.composition && capture.composition.unmatchedFields.length > 0
                ? ` · ${formatList(capture.composition.unmatchedFields)} ${
                    capture.composition.unmatchedFields.length === 1 ? "has" : "have"
                  } no marked region on this page`
                : ""}
              {driftedCount > 0
                ? ` · ${driftedCount} region${driftedCount === 1 ? "" : "s"} changed outside the reviewed scope`
                : ""}
              {capture.removedConstructs > 0
                ? ` · ${capture.removedConstructs} active element${capture.removedConstructs === 1 ? "" : "s"} removed`
                : ""}
              {capture.blockedSubresources > 0
                ? ` · ${capture.blockedSubresources} third-party request${capture.blockedSubresources === 1 ? "" : "s"} blocked`
                : ""}
            </p>
          </div>
        </>
      ) : (
        <div className="px-3 py-3">
          <p className="font-sans text-xs font-bold text-foreground">
            No page capture for this side
          </p>
          <p className="mt-1 max-w-[66ch] text-xs leading-relaxed text-muted-foreground">
            The page could not be captured when this review was opened
            {capture.degradedReason ? ` (${capture.degradedReason})` : ""}. The content above is
            still the complete, reviewable change — only the visual context is missing.
          </p>
        </div>
      )}
    </figure>
  );
}

/** "title, content and excerpt" — plain copy, no type keying. */
function formatList(values: readonly string[]): string {
  if (values.length === 0) return "nothing";
  if (values.length === 1) return values[0]!;
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}
