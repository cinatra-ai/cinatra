import "server-only";

import type { ReactNode } from "react";
import type { ArtifactUiSlot } from "@cinatra-ai/sdk-extensions/artifact-contract";

import type { ArtifactRendererProps } from "@/lib/artifacts/artifact-renderer-props";

import { classifyLoadablePath } from "./renderer-resolution";
import { resolveRuntimeRendererForRoute } from "./runtime-renderer-route";
import { runRuntimeRendererFreshnessPreflight } from "./runtime-renderer-preflight";
import { ExtensionRendererSlot } from "./extension-renderer-slot";
import { DynamicRendererLoader } from "./dynamic-renderer-loader";
import { RendererDegradedNotice } from "./renderer-degraded-notice";

/**
 * MOUNT the resolved extension renderer for a `semantic`/`representation`
 * dispatch (epic #1620 M1 Slice A/B — cinatra#1630, plan §2.4–§2.5). This is the
 * piece that MOUNTS the dynamic seam: the dispatch leaf only knows the claimant
 * is `loadable`; this async server component classifies HOW it loads and routes:
 *
 *   - `build-map` → the existing server-only `ExtensionRendererSlot` (system /
 *     first-party bases; SSR/RSC fast path, unchanged).
 *   - `runtime`   → the main-realm dynamic client loader (`DynamicRendererLoader`)
 *     driven by the server-serialized descriptor + a BOUND freshness-preflight
 *     server action (marketplace-installed, ZERO host rebuild).
 *   - `none`      → the binding vanished between dispatch and mount (an archive
 *     race); degrade to the never-blank generic floor + a requires-rebuild notice.
 *
 * The generic floor node (`fallback`) is passed through to whichever path renders,
 * so the body is NEVER blank on any failure state.
 */
export async function ExtensionRendererMount({
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
  const path = classifyLoadablePath(generatedKey);

  if (path === "build-map") {
    return (
      <ExtensionRendererSlot
        generatedKey={generatedKey}
        packageName={packageName}
        slot={slot}
        props={props}
        fallback={fallback}
      />
    );
  }

  if (path === "runtime") {
    const descriptor = await resolveRuntimeRendererForRoute(generatedKey, props.propsApiVersion);
    if (!descriptor) {
      return floor(packageName, slot, fallback);
    }
    // Bind the descriptor's exact tuple into the freshness-preflight server action
    // so the client loader can re-confirm "still admitted" just before importing.
    const preflight = runRuntimeRendererFreshnessPreflight.bind(null, descriptor.tuple);
    return (
      <DynamicRendererLoader
        descriptor={descriptor}
        props={props}
        fallback={fallback}
        preflight={preflight}
      />
    );
  }

  // `none`: defensive — the pure leaf only routes a loadable claimant here, but a
  // teardown could have landed between dispatch and this resolve. Never blank.
  return floor(packageName, slot, fallback);
}

function floor(packageName: string, slot: ArtifactUiSlot, fallback: ReactNode): ReactNode {
  return (
    <>
      <RendererDegradedNotice packageName={packageName} slot={slot} failureClass="not-built" />
      {fallback}
    </>
  );
}
