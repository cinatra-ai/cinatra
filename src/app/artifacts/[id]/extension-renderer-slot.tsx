import "server-only";

import type { ReactNode } from "react";
import type { ArtifactUiSlot } from "@cinatra-ai/sdk-extensions/artifact-contract";

import { loadArtifactRenderer } from "@/lib/artifacts/artifact-renderer-loader";
import {
  artifactRendererPropsAtVersion,
  type ArtifactRendererProps,
} from "@/lib/artifacts/artifact-renderer-props";

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
  // This seam receives a snapshot ALREADY BUILT by its caller at the host's
  // ceiling. Since the ceiling moved to v2 (wave 3, cinatra#3091) that is no
  // longer the version most of the fleet negotiates: every build-map display
  // declares v1 today, so a bare inequality here would degrade EVERY ONE of
  // them the day the ceiling moved — the flag day the window exists to prevent,
  // arriving through the seam instead of through the loader.
  //
  // So the snapshot is NARROWED to the negotiated version instead. That is the
  // second half of the enabler's sentence ("then build the snapshot at that
  // version") in the only form a seam holding a finished snapshot can honour:
  // drop what the older shape has no place for, invent nothing.
  //
  // A negotiation ABOVE the snapshot's own version is still a degrade, and must
  // be: narrowing is safe, widening would be a guess at a field the host never
  // built. The loader cannot produce that case today (it negotiates against
  // this very version as its ceiling) and this stays the fail-closed half.
  if (result.negotiatedPropsApiVersion > props.propsApiVersion) {
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

  const negotiatedProps = artifactRendererPropsAtVersion(
    props,
    result.negotiatedPropsApiVersion,
  );

  const { Component } = result;
  return <Component {...negotiatedProps} />;
}
