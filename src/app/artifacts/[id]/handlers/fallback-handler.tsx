/**
 * Fallback handler for non-allowlisted MIMEs.
 *
 * Renders a metadata card (filename, MIME, size, scope, created date)
 * when the artifact's MIME has no inline-preview path.
 *
 * Connector-ref external linking is NOT this component's concern: the
 * "Open in source application" action renders in the detail page's
 * `PageHeader.actions` (next to Download) whenever
 * `ArtifactSummary.sourceUrl` is non-null — the artifact service projects
 * it from `objects.data.connectorRef.url` via the validating
 * `connectorRefSourceUrl` accessor, so it appears regardless of which
 * MIME handler renders the body.
 */
import type { ReactElement } from "react";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";

export type FallbackHandlerProps = {
  readonly artifact: ArtifactSummary;
  readonly mime: string;
};

export function FallbackHandler({
  artifact,
  mime,
}: FallbackHandlerProps): ReactElement {
  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardHeader>
        <CardTitle>Preview unavailable for this file type</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">Name</dt>
          <dd className="text-foreground break-all">{artifact.title ?? artifact.artifactId}</dd>
          <dt className="text-muted-foreground">MIME</dt>
          <dd className="text-foreground font-mono text-xs">{mime || "unknown"}</dd>
          <dt className="text-muted-foreground">Size</dt>
          <dd className="text-foreground">{artifact.size} bytes</dd>
          <dt className="text-muted-foreground">Origin</dt>
          <dd className="text-foreground">{artifact.originKind ?? "—"}</dd>
          <dt className="text-muted-foreground">Created</dt>
          <dd className="text-foreground">{artifact.createdAt}</dd>
        </dl>
        <p className="text-muted-foreground text-xs">
          Use the Download button above to save the file locally.
        </p>
      </CardContent>
    </Card>
  );
}
