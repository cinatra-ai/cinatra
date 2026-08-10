import "server-only";

// ---------------------------------------------------------------------------
// The BROKER-SURFACE capture pair (cinatra#2576, epic #2564 S8c) — the MINT half
// of the egress whose serve half is `/api/lifecycle-views/capture`.
//
// A widget review card needs the same before/after pictures the first-party
// review surface draws, addressed differently: the session byte route is
// unreachable from a broker-authenticated `<img>`, so each picture gets a
// sealed, gate-scoped, short-TTL capability URL instead. Everything else — which
// captures exist, which side each plays, how a missing side degrades — is the
// EXISTING projection, reused rather than reinvented, so the two tiers cannot
// drift into showing different comparisons.
//
// MINTING IS NOT AUTHORIZING. A capability grants only what the serving path
// re-proves: the live `cwu_` row, live run READ access, the gate's own frozen
// pinned set, the capture's binding to it. A caller that mints for a gate its
// reader may not see produces URLs that 404. The caller SHOULD still authorize
// first (that is the surface's job and, for the widget, S8a/S8d's), but a
// mistake there is contained rather than exploitable.
//
// THE TARGETS ARE GATE-DERIVED. This module never accepts a caller-supplied
// artifact id. It is handed a gate and a pinned target the gate itself froze, so
// there is no argument through which a surface could ask for a picture outside
// the gate — and the serving path re-derives the same binding independently.
//
// ONLY CAPTURES. The only URLs this module can emit come from
// `captureCapabilityUrl`, which addresses one route that serves one MIME. It has
// no reference to the artifact byte routes, and a structural test pins that.
// ---------------------------------------------------------------------------

import {
  buildPinnedCaptureViews,
  buildPinnedCapturePair,
  type PinnedCapturePairKind,
  type PinnedCapturePairView,
  type PinnedCaptureImageUrlMinter,
} from "@/lib/artifacts/cms-preview-capture-view";
import { readPinnedPreviewCaptures } from "@/lib/artifacts/cms-preview-capture-store";
import {
  captureCapabilityUrl,
  mintCaptureCapability,
  type CaptureCapabilityPayload,
} from "@/lib/lifecycle/capture-capability";

/** The verified widget principal a capability is minted for. */
export interface WidgetCapturePrincipal {
  orgId: string;
  userId: string;
  /** The `cwu_` token's own id — the capability's revocation handle. */
  jti: string;
  siteId: string;
  client: string;
  instanceId: string;
  /** The widget agent the token is bound to — re-checked live at serve time. */
  agentSlug: string;
}

/**
 * Build the capability minter for ONE reader on ONE gate.
 *
 * Exported on its own because it is the whole trust statement of the mint half:
 * every field except the capture's own two ids is FIXED by the closure, so a
 * projection that walks a list of captures cannot vary the principal, the site
 * or the gate between two pictures.
 */
export function buildCaptureCapabilityMinter(params: {
  principal: WidgetCapturePrincipal;
  runId: string;
  reviewTaskId: string;
}): PinnedCaptureImageUrlMinter {
  const { principal, runId, reviewTaskId } = params;
  return ({ captureArtifactId, representationRevisionId }) => {
    const payload: CaptureCapabilityPayload = {
      orgId: principal.orgId,
      userId: principal.userId,
      jti: principal.jti,
      siteId: principal.siteId,
      client: principal.client,
      instanceId: principal.instanceId,
      agentSlug: principal.agentSlug,
      runId,
      reviewTaskId,
      captureArtifactId,
      representationRevisionId,
    };
    const sealed = mintCaptureCapability(payload);
    // A capability that cannot be sealed degrades to the honest "no picture for
    // this side" state — never to a broken image.
    return sealed ? captureCapabilityUrl(sealed) : null;
  };
}

/**
 * The broker tier's counterpart of `loadPinnedCapturePair`: one store read for
 * one gate-pinned target, projected through the SAME pure pair builder, with the
 * capability minter substituted for the session byte route.
 *
 * Degrades to `null` on a store failure exactly as the first-party loader does:
 * a reader must always be able to read the decision even when the context
 * picture is unavailable (#2044's honest-fallback rule).
 */
export function buildBrokerCapturePair(params: {
  principal: WidgetCapturePrincipal;
  runId: string;
  reviewTaskId: string;
  /** A target THIS gate pinned — never a caller-chosen artifact. */
  target: { artifactId: string; representationRevisionId: string };
  kind: PinnedCapturePairKind;
  driftedRegions?: readonly string[];
}): PinnedCapturePairView | null {
  const { principal, runId, reviewTaskId, target, kind } = params;
  try {
    const stored = readPinnedPreviewCaptures({
      orgId: principal.orgId,
      boundArtifactId: target.artifactId,
      boundSnapshotRevisionId: target.representationRevisionId,
    });
    if (stored.length === 0) return null;
    const views = buildPinnedCaptureViews(
      stored,
      buildCaptureCapabilityMinter({ principal, runId, reviewTaskId }),
    );
    return buildPinnedCapturePair(views, kind, params.driftedRegions ?? []);
  } catch (err) {
    console.warn(
      "[widget-capture-egress] pinned capture lookup failed (the review is unaffected):",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
