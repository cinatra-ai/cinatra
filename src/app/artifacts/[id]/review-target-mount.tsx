import "server-only";

import type { ReactNode } from "react";

import type { ArtifactRendererProps } from "@/lib/artifacts/artifact-renderer-props";
import type {
  ReviewMountFloorReason,
  ReviewTargetMount as ReviewTargetMountDescriptor,
} from "@/lib/artifacts/artifact-review-preparation";

import { ArtifactDisplayMountPoint } from "./artifact-display-mount";

/**
 * The artifact-MOUNT BRIDGE for the generic review surface. Given a HOST-produced
 * mount descriptor + the pinned display props, it mounts the resolved extension
 * display inside a review context, with the never-blank floor on EVERY failure
 * class.
 *
 * NO CLIENT-SUPPLIED RENDERER-ID PATH: the descriptor is produced by the server
 * preparation action from the artifact's TYPE — this bridge only branches on the
 * OPAQUE `mount.kind` and passes the host's generatedKey / descriptor through.
 * There is deliberately no prop by which a caller could name a display; the
 * display's identity crosses ONLY as host-resolved side data. G1-clean.
 *
 * ONE MOUNT, CARD AND PAGE. The two loadable paths are not switched over here at
 * all any more: they are handed to the SHARED display primitive, the same one the
 * artifact page hands its mount to. What stays this surface's own is the floor's
 * WORDS — the card's sanitized, telemetry-safe diagnostic — and the artifact-level
 * floors the preparation core decides before a display is ever resolved.
 *
 * THE FORM RUNG IS GONE. It mounted the host's own text and markdown viewers
 * inside the card, which is core drawing the artifact's content on a surface the
 * ownership boundary gives to the artifact's own package. A text form now reaches
 * the reviewer through the pack that claims it, exactly as it reaches the reader
 * on the artifact's own page, or it reaches the floor.
 */
export async function ReviewTargetMount({
  mount,
  props,
  fallback,
}: {
  mount: ReviewTargetMountDescriptor;
  /** The pinned display props — non-null for the loadable paths; may be null on
   * an artifact-level floor (unknown / read-denied / non-member revision) where
   * there is no authorized artifact to render props from. */
  props: ArtifactRendererProps | null;
  /** The host's generic floor node — rendered on EVERY non-mount state. */
  fallback: ReactNode;
}): Promise<ReactNode> {
  return ArtifactDisplayMountPoint({
    mount,
    props,
    fallback,
    renderFloor: ({ packageName, slot, reason }) =>
      reviewFloor(packageName, slot, reason as ReviewMountFloorReason | "no-representation", fallback),
  });
}

/** A sanitized, telemetry-safe review floor: package + slot + reason ONLY, never
 * a raw error / manifest value — plus the caller's generic fallback (never
 * blank). Deliberately design-neutral (no branded chrome) so the fenced
 * decision-surface owns the visual notice. */
function reviewFloor(
  packageName: string | null,
  slot: string,
  reason: ReviewMountFloorReason | "no-representation",
  fallback: ReactNode,
): ReactNode {
  return (
    <div data-review-target-floor={reason} data-review-floor-package={packageName ?? ""} data-review-floor-slot={slot}>
      <p role="status" className="text-muted-foreground text-sm">
        {reviewTargetFloorDiagnostic(packageName, slot, reason)}
      </p>
      {fallback}
    </div>
  );
}

export function reviewTargetFloorDiagnostic(
  packageName: string | null,
  slot: string,
  reason: string,
): string {
  const pkg = packageName ? `package "${packageName}", ` : "";
  return `review target unavailable — ${pkg}slot "${slot}", reason "${reason}"`;
}
