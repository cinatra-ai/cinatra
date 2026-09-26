"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * Route-segment error boundary for `/artifacts/[id]`. A render-time throw from an
 * extension-shipped display is CONTAINED here — the rest of the app stays up and
 * the detailed error is telemetry-only. "Try again" re-renders the segment.
 *
 * THERE IS NO "OPEN THE GENERIC VIEW" ANY MORE. The link it offered forced a
 * host-drawn rendering of the artifact, which is the one thing the ownership
 * boundary keeps core out of: core draws the shell and the diagnostics, and the
 * artifact's bytes and fields belong to its package's display. So recovery is a
 * re-render, and a display that cannot draw leaves a diagnostic — never a core
 * copy of the work.
 */
export default function ArtifactDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Telemetry only — the sanitized diagnostic is already logged server-side by
    // the loader; here we surface the digest for correlation, never the message.
    console.error("[artifacts] detail render error", error.digest ?? "(no digest)");
  }, [error]);

  return (
    <Main className="min-h-screen">
      <PageContent className="flex flex-col gap-6 pb-8 pt-8">
        <Alert variant="destructive" data-testid="artifact-detail-error-boundary">
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>This view could not be rendered</AlertTitle>
          <AlertDescription>
            Something went wrong drawing this artifact. Try again, or open it in
            its source application if it has one.
          </AlertDescription>
        </Alert>
        <div className="flex gap-3">
          <Button variant="outline" onClick={() => reset()}>
            Try again
          </Button>
        </div>
      </PageContent>
    </Main>
  );
}
