import type { ReactElement } from "react";
import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { ArtifactUiSlot } from "@cinatra-ai/sdk-extensions/artifact-contract";
import type { ArtifactRendererFailureClass } from "@/lib/artifacts/artifact-renderer-loader";

/**
 * The SANITIZED, user-facing degrade notice rendered ABOVE the generic floor
 * when an extension-shipped renderer cannot mount (cinatra#1629, epic #1620 S2,
 * AC-4). Shows only the package + slot + failure class — the detailed error is
 * telemetry-only (logged server-side by the loader). Never blank: the generic
 * renderer always renders beneath this.
 */
export function RendererDegradedNotice({
  packageName,
  slot,
  failureClass,
}: {
  packageName: string;
  slot: ArtifactUiSlot;
  failureClass: ArtifactRendererFailureClass;
}): ReactElement {
  const requiresRebuild = failureClass === "not-built" || failureClass === "absent";
  return (
    <Alert
      variant="default"
      data-testid="artifact-renderer-degraded"
      data-render-failure-class={failureClass}
      data-render-degraded-package={packageName}
      data-render-degraded-slot={slot}
    >
      <AlertTriangle aria-hidden="true" />
      <AlertTitle>
        {requiresRebuild
          ? "This view requires a rebuild"
          : "Showing the generic view"}
      </AlertTitle>
      <AlertDescription>
        {requiresRebuild
          ? `The ${packageName} extension's ${slot} view is not part of this build. Showing the generic view instead.`
          : `The ${packageName} extension's ${slot} view could not be loaded. Showing the generic view instead.`}
      </AlertDescription>
    </Alert>
  );
}
