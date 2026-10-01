/**
 * Fallback handler for non-allowlisted MIMEs.
 *
 * Renders a metadata card (filename, MIME, size, scope, created date)
 * when the artifact's MIME has no inline-preview path.
 *
 * THE SIZE IS THE RESOLVED REVISION'S, not the object row's cached one
 * (cinatra#3091, wave 3). V.2 draws this card as the file's name, its form, its
 * size and the download, and the first three have to describe the same bytes the
 * fourth hands over. `artifact.size` is written once at creation and never
 * rewritten by the append-only save road, so drawing it beside a control that
 * serves the PINNED representation put a stale number next to fresh bytes — the
 * split reading cinatra#3026 removed from the page header, which travels with
 * the size to whichever surface still draws one. The caller resolves the
 * representation already and now hands its size down.
 *
 * THE DOWNLOAD IS DRAWN HERE, not above it. The artifact page's header closes
 * at its mono meta line and gives the download to the KIND (fix leg 2), so this
 * card — which IS §V.2's "a file nothing of ours can read: its name, its form,
 * its size, and the download" — carries the control itself. Before this it
 * pointed at a Download button in the header; a card that names a control that
 * is not on the page leaves a person with no way to save the bytes at all.
 *
 * Connector-ref external linking is NOT this component's concern: the
 * "Open in source application" action renders in the detail page's
 * `PageHeader.actions` whenever
 * `ArtifactSummary.sourceUrl` is non-null — the artifact service projects
 * it from `objects.data.connectorRef.url` via the validating
 * `connectorRefSourceUrl` accessor, so it appears regardless of which
 * MIME handler renders the body.
 */
import type { ReactElement } from "react";
import Link from "next/link";
import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
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
  /** The size of the RESOLVED representation — the very bytes `downloadHref`
   *  hands over — or NULL where no representation resolved. The card's size and
   *  its download must describe ONE revision; see the docblock above. */
  readonly sizeBytes?: number | null;
  /** The content endpoint for the pinned representation, or NULL where the row
   *  has none — a row with no bytes draws no download, and never a dead one. */
  readonly downloadHref?: string | null;
};

export function FallbackHandler({
  artifact,
  mime,
  sizeBytes = null,
  downloadHref = null,
}: FallbackHandlerProps): ReactElement {
  // THE SIZE DESCRIBES THE BYTES THE CONTROL BELOW HANDS OVER. `artifact.size`
  // is the value cached on the object row at creation; the save road appends an
  // immutable revision and never rewrites it, so it is only ever right for the
  // FIRST revision. It stays as the last resort for a row with no resolved
  // representation at all — which draws no download either, so nothing can
  // disagree with it there.
  const drawnSizeBytes = sizeBytes ?? artifact.size;
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
          <dd className="text-foreground">{drawnSizeBytes} bytes</dd>
          <dt className="text-muted-foreground">Origin</dt>
          <dd className="text-foreground">{artifact.originKind ?? "—"}</dd>
          <dt className="text-muted-foreground">Created</dt>
          <dd className="text-foreground">{artifact.createdAt}</dd>
        </dl>
        {downloadHref ? (
          <Button asChild variant="outline">
            <Link href={downloadHref} download>
              <Download data-icon="inline-start" aria-hidden="true" />
              Download
            </Link>
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
