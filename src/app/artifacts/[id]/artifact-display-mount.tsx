import "server-only";

import type { ReactNode } from "react";
import type { ArtifactUiSlot } from "@cinatra-ai/sdk-extensions/artifact-contract";

import type { ArtifactRendererProps } from "@/lib/artifacts/artifact-renderer-props";

import { ExtensionRendererSlot } from "./extension-renderer-slot";
import { DynamicRendererLoader } from "./dynamic-renderer-loader";
import { runRuntimeRendererFreshnessPreflight } from "./runtime-renderer-preflight";
import type { ArtifactDisplayMountDescriptor } from "./renderer-resolution";

/**
 * MOUNT the resolved display. The two loadable paths are mounted here for both
 * roads; the FLOOR is handed back to the caller through `renderFloor`, because
 * the floor is the one thing each surface words in its own voice — the page's
 * notice and the review card's sanitized diagnostic are different pixels for the
 * same classification, and the classification is already decided above.
 */
export async function ArtifactDisplayMountPoint({
  mount,
  props,
  fallback,
  renderFloor,
}: {
  mount: ArtifactDisplayMountDescriptor;
  /** The display props snapshot. Null only on an artifact-level floor, where
   *  there is no authorized artifact to build one from. */
  props: ArtifactRendererProps | null;
  /** The never-blank floor node passed down to whichever path renders. */
  fallback: ReactNode;
  /** The surface's own floor pixels for a classified failure. */
  renderFloor: (floor: {
    packageName: string | null;
    slot: ArtifactUiSlot;
    reason: string;
  }) => ReactNode;
}): Promise<ReactNode> {
  if (mount.kind === "floor") {
    return renderFloor({ packageName: mount.packageName, slot: mount.slot, reason: mount.reason });
  }
  // Defensive: a loadable mount is always paired with a snapshot by both roads.
  if (!props) {
    return renderFloor({ packageName: mount.packageName, slot: mount.slot, reason: "no-representation" });
  }
  if (mount.kind === "build-map") {
    return (
      <ExtensionRendererSlot
        generatedKey={mount.generatedKey}
        packageName={mount.packageName}
        slot={mount.slot}
        props={props}
        fallback={fallback}
      />
    );
  }
  // Bind the descriptor's exact tuple into the freshness preflight so the client
  // loader re-confirms "still admitted" immediately before importing.
  const preflight = runRuntimeRendererFreshnessPreflight.bind(null, mount.descriptor.tuple);
  return (
    <DynamicRendererLoader
      descriptor={mount.descriptor}
      props={props}
      fallback={fallback}
      preflight={preflight}
    />
  );
}
