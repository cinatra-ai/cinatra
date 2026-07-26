import "server-only";

import type { ReactNode } from "react";

import type { PinnedCaptureView } from "@/lib/artifacts/cms-preview-capture-view";

/**
 * The PINNED page capture shown as review CONTEXT (cinatra#2044 S6, sub-lane
 * L-B), rendered inside the target panel's representation area — beneath the
 * decided data, never in place of it.
 *
 * What a reviewer gets: the actual rendered page as it stood when the gate was
 * created, with the site's own theme chrome visible, and the adapter-marked
 * owned regions outlined. What the surface promises, and states on screen:
 *
 *   - The picture is a STATIC IMAGE that was captured server-side and stored.
 *     It is served from the host's own version-pinned artifact byte route, so
 *     nothing here is a live document and no request reaches the site when this
 *     page is viewed. Re-opening an old gate shows the ORIGINAL picture even
 *     after the site's theme changes.
 *   - The chrome around the owned regions is NON-DECISIONAL context. The
 *     decision binds to the content snapshot above, which is what the gate
 *     pinned — this block never carries an affordance.
 *   - Region outlines come EXCLUSIVELY from the adapter's own markers (#2044
 *     forbids reviewer-side CSS guessing). An adapter that marks nothing shows
 *     an unannotated page rather than a guess.
 *   - A capture that could not be taken says WHY, in place, instead of leaving a
 *     silent gap (#2044's honest-fallback rule).
 */
export function ReviewPinnedCapture({ captures }: { captures: PinnedCaptureView[] }): ReactNode {
  if (captures.length === 0) return null;
  return (
    <div data-conformance-id="review-pinned-capture" className="mt-4 flex flex-col gap-3">
      {captures.map((capture) => (
        <PinnedCaptureBlock key={capture.captureArtifactId} capture={capture} />
      ))}
    </div>
  );
}

function PinnedCaptureBlock({ capture }: { capture: PinnedCaptureView }): ReactNode {
  const roleLabel = capture.role === "before" ? "Published page" : "Staged page";
  return (
    <figure className="overflow-hidden rounded-control border border-line bg-surface">
      <figcaption className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <span className="font-sans text-xs font-bold text-foreground">{roleLabel}</span>
        <span className="inline-flex items-center rounded-full border border-line-strong px-2 py-0.5 text-badge-2xs font-semibold text-muted-foreground">
          Context · not decided here
        </span>
        <span className="font-mono text-badge-2xs tracking-tight text-muted-foreground">
          pinned {capture.capturedAt}
          {capture.sourceOrigin ? ` · ${capture.sourceOrigin}` : ""}
        </span>
      </figcaption>

      {capture.imageUrl ? (
        <>
          <div className="relative bg-surface-muted">
            {/* A stored PNG served by the host's version-pinned byte route. Plain
                <img> on purpose: no iframe, no remote document, nothing live. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={capture.imageUrl}
              alt={`${roleLabel} capture pinned at review time`}
              className="block h-auto w-full"
            />
            {capture.regions.map((region, index) => (
              <span
                key={`${region.region}-${index}`}
                aria-hidden="true"
                data-cinatra-region-highlight={region.region}
                className="pointer-events-none absolute rounded-sm border-2 border-logo/70 bg-logo/10"
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
              {capture.regions.length > 0
                ? `${capture.regions.length} owned region${capture.regions.length === 1 ? "" : "s"} outlined (${capture.regions
                    .map((r) => r.region)
                    .join(", ")}) · `
                : "no owned regions marked by the site · "}
              static capture · no live page is loaded
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
            No page capture for this review
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
