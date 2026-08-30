import "server-only";

import type { ReactNode } from "react";
import type { ArtifactUiSlot } from "@cinatra-ai/sdk-extensions/artifact-contract";

import { loadArtifactRenderer } from "@/lib/artifacts/artifact-renderer-loader";
import type { ArtifactRendererProps } from "@/lib/artifacts/artifact-renderer-props";

import { RendererDegradedNotice } from "./renderer-degraded-notice";

/**
 * Mount an extension-shipped artifact renderer resolved by the dispatch spine
 * (cinatra#1629, epic #1620 S2). Async server component: it loads the renderer
 * through the failure-isolated loader and either renders it with the authorized
 * props snapshot, or DEGRADES to the generic floor (`fallback`) + a sanitized
 * notice. It never imports the generic renderer itself — the caller passes the
 * floor node, so this seam stays free of core per-type pixels. A present-but-
 * broken renderer throws through this component to the route-segment error
 * boundary (`error.tsx`) — the render-time containment half of AC-4.
 */
export async function ExtensionRendererSlot({
  generatedKey,
  packageName,
  slot,
  props,
  fallback,
}: {
  generatedKey: string;
  packageName: string;
  slot: ArtifactUiSlot;
  props: ArtifactRendererProps;
  fallback: ReactNode;
}): Promise<ReactNode> {
  const result = await loadArtifactRenderer({
    generatedKey,
    packageName,
    slot,
    expectedPropsApiVersion: props.propsApiVersion,
  });

  if (!result.ok) {
    return (
      <>
        <RendererDegradedNotice
          packageName={packageName}
          slot={slot}
          failureClass={result.failureClass}
        />
        {fallback}
      </>
    );
  }

  // THE SNAPSHOT MUST BE THE ONE THE DISPLAY NEGOTIATED (enabler 0.4 of
  // `PLAN: Agents Lifecycle (C)`, cinatra#3027): "resolve the display, read its
  // declared props version, then build the snapshot at that version."
  //
  // This seam receives a snapshot ALREADY BUILT by its caller, so when the
  // negotiated version is not the version that snapshot carries it cannot honour
  // the second half of the sentence — and handing an older display a newer shape
  // is exactly what the enabler forbids ("a v1 display admitted under a v2 host
  // must be handed a v1 snapshot, not a v2 one it cannot read"). It therefore
  // degrades under the SAME `abi-incompatible` class the strict equality used to
  // produce, rather than mounting a shape the display never agreed to. Building
  // a per-version snapshot at this seam is the sibling plan's wiring; until it
  // lands, this is the fail-closed half of the ratchet, and it is a no-op while
  // the host window holds a single version.
  if (result.negotiatedPropsApiVersion !== props.propsApiVersion) {
    return (
      <>
        <RendererDegradedNotice
          packageName={packageName}
          slot={slot}
          failureClass="abi-incompatible"
        />
        {fallback}
      </>
    );
  }

  const { Component } = result;
  return <Component {...props} />;
}
