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

  const { Component } = result;
  return <Component {...props} />;
}
