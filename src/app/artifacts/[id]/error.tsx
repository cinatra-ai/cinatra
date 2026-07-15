"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * Route-segment error boundary for `/artifacts/[id]` (cinatra#1629, epic #1620
 * S2, AC-4 render-time half). A render-time throw from an extension-shipped
 * renderer is CONTAINED here — the rest of the app stays up, the detailed error
 * is telemetry-only, and recovery links to the GENERIC view (`?renderer=generic`,
 * which the page honors by forcing the generic floor and never mounting the
 * extension renderer). "Try again" re-renders the segment.
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

  const pathname = usePathname();
  const genericHref = `${pathname}?renderer=generic`;

  return (
    <Main className="min-h-screen">
      <PageContent className="flex flex-col gap-6 pb-8 pt-8">
        <Alert variant="destructive" data-testid="artifact-detail-error-boundary">
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>This view could not be rendered</AlertTitle>
          <AlertDescription>
            Something went wrong rendering this artifact. You can open the generic
            view instead, or try again.
          </AlertDescription>
        </Alert>
        <div className="flex gap-3">
          <Button asChild variant="outline">
            <Link href={genericHref}>Open the generic view</Link>
          </Button>
          <Button variant="outline" onClick={() => reset()}>
            Try again
          </Button>
        </div>
      </PageContent>
    </Main>
  );
}
