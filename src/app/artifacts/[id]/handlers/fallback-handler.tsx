/**
 * Fallback handler for non-allowlisted MIMEs.
 *
 * Renders a metadata card (filename, MIME, size, scope, created date)
 * when the artifact's MIME has no inline-preview path.
 *
 * **Connector-ref external linking is DEFERRED** to a future milestone:
 * a "prominent external link if connector-ref-shaped" is desired,
 * but the canonical `ArtifactSummary` does NOT expose the underlying
 * `objects.data` (the artifact-service `toSummary` deliberately drops
 * it), and no typed `connectorRef.url` / `externalUrl` field exists on
 * the service yet. This ships the metadata card + the universal
 * Download button; the "Open in source application" button lands when
 * a future milestone adds a typed connector-ref accessor to the
 * artifact service. This is a deliberate scope cut, not a missing
 * feature.
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
