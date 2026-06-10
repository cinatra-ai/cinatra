/**
 * `/artifacts/[id]` detail page.
 *
 * Server component. Resolves the artifact via `getArtifact` (actor +
 * tenant + tombstone gating), picks a MIME handler from the
 * latest representation, and renders inside the canonical Main +
 * PageHeader (artifact name) + PageContent shell.
 *
 * MIME → handler mapping:
 *   - `text/markdown` / `.md` / `.markdown` → MarkdownHandler (rendered
 *     + raw side-by-side; reuses `marked` from the chat-page renderer).
 *   - `text/plain` → PlainTextHandler (`<pre class="whitespace-pre-wrap">`).
 *   - `application/pdf` → PdfHandler (`<embed>`, browser viewer; iOS
 *     WebKit gets a dynamically-imported react-pdf inline fallback —
 *     the request UA seeds its initial render, see #70).
 *   - `image/*` → ImageHandler (`<img>`, even for SVG — never inline
 *     `<svg>` from artifact content).
 *   - allowlisted `video/*` → VideoHandler (`<video controls>`, range-
 *     streamed by the preview route).
 *   - allowlisted `audio/*` → AudioHandler (`<audio controls>`).
 *   - everything else → FallbackHandler (metadata card).
 *
 * Selection itself lives in `./pick-handler.ts` (unit-tested for parity
 * with the preview route's allowlist).
 *
 * `PageHeader.actions` carries the artifact-level actions:
 *   - Download — always (when a representation exists); hits the existing
 *     content endpoint (always `attachment` per `downloadDispositionFor`).
 *   - "Open in source application" — only when `artifact.sourceUrl` is
 *     non-null (connector-ref artifacts; the service validates the URL to
 *     http/https before it ever reaches this href).
 */
import "server-only";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { Download, ExternalLink } from "lucide-react";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";

import { getAuthSession, requireActorContext } from "@/lib/auth-session";
import {
  getArtifact,
  type ArtifactSummary,
} from "@/lib/artifacts/artifact-service";
import { resolveArtifactVersionForServe } from "@/lib/artifacts/artifact-read";

import { pickHandler } from "./pick-handler";
import { MarkdownHandler } from "./handlers/markdown-handler";
import { PlainTextHandler } from "./handlers/plain-text-handler";
import { PdfHandler } from "./handlers/pdf-handler";
import { isIosUserAgent } from "./handlers/pdf-inline-support";
import { ImageHandler } from "./handlers/image-handler";
import { VideoHandler } from "./handlers/video-handler";
import { AudioHandler } from "./handlers/audio-handler";
import { FallbackHandler } from "./handlers/fallback-handler";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ id: string }> };

export default async function ArtifactDetailPage({ params }: PageProps) {
  const { id } = await params;
  const session = await getAuthSession();
  if (!session) redirect("/sign-in");
  const orgId = session.session?.activeOrganizationId;
  if (!orgId) redirect("/sign-in");

  const actor = await requireActorContext();
  const artifact: ArtifactSummary | null = getArtifact({
    artifactId: id,
    orgId,
    actor,
  });
  if (!artifact) notFound();

  const revisionId = artifact.latestRepresentationRevisionId;
  // Latest representation is required for any in-page rendering. Without
  // it (rare — artifact metadata without a materialized representation),
  // fall through to the fallback handler.
  const resolved = revisionId
    ? resolveArtifactVersionForServe({
        orgId,
        artifactId: id,
        representationRevisionId: revisionId,
      })
    : null;

  const mime = resolved?.mime ?? artifact.mime ?? "";
  const handler = pickHandler(mime);
  const previewHref = revisionId
    ? `/api/artifacts/${id}/versions/${revisionId}/preview`
    : null;
  const downloadHref = revisionId
    ? `/api/artifacts/${id}/versions/${revisionId}/content`
    : null;

  // UA hint for the PDF handler: known-iOS clients skip the broken
  // `<embed>` from the very first render (the client corrects the hint
  // post-hydration — iPadOS-as-Mac is indistinguishable server-side).
  // The page is already `force-dynamic`, so reading headers adds nothing.
  const pdfInitialFallback =
    handler === "pdf"
      ? isIosUserAgent((await headers()).get("user-agent") ?? "")
      : false;

  const title = artifact.title ?? artifact.artifactId;

  return (
    <Main className="min-h-screen">
      <PageHeader
        title={title}
        description={`${mime || "unknown"} · ${artifact.size} bytes`}
        divider={false}
        actions={
          downloadHref || artifact.sourceUrl ? (
            <>
              {artifact.sourceUrl ? (
                <Button asChild variant="outline">
                  <a
                    href={artifact.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink data-icon="inline-start" aria-hidden="true" />
                    Open in source application
                  </a>
                </Button>
              ) : null}
              {downloadHref ? (
                <Button asChild variant="outline">
                  <a href={downloadHref} download>
                    <Download data-icon="inline-start" aria-hidden="true" />
                    Download
                  </a>
                </Button>
              ) : null}
            </>
          ) : null
        }
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        {(() => {
          if (!previewHref) {
            return <FallbackHandler artifact={artifact} mime={mime} />;
          }
          switch (handler) {
            case "markdown":
              return (
                <MarkdownHandler
                  artifactId={id}
                  revisionId={revisionId as string}
                  orgId={orgId}
                />
              );
            case "text":
              return (
                <PlainTextHandler
                  artifactId={id}
                  revisionId={revisionId as string}
                  orgId={orgId}
                />
              );
            case "pdf":
              return (
                <PdfHandler
                  previewHref={previewHref}
                  downloadHref={downloadHref as string}
                  initialFallback={pdfInitialFallback}
                />
              );
            case "image":
              return <ImageHandler previewHref={previewHref} alt={title} />;
            case "video":
              return <VideoHandler previewHref={previewHref} />;
            case "audio":
              return <AudioHandler previewHref={previewHref} />;
            case "fallback":
            default:
              return <FallbackHandler artifact={artifact} mime={mime} />;
          }
        })()}
      </PageContent>
    </Main>
  );
}
