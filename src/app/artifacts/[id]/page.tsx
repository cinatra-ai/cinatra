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
import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { Download, ExternalLink } from "lucide-react";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";

import { getAuthSession, requireActorContext } from "@/lib/auth-session";
import {
  readArtifactForDetail,
  type ArtifactSummary,
} from "@/lib/artifacts/artifact-service";
import { resolveArtifactVersionForServe } from "@/lib/artifacts/artifact-read";
import { buildArtifactRendererProps } from "@/lib/artifacts/artifact-renderer-props";

import { ArtifactReadDeniedPanel } from "./read-denied-panel";
import {
  pickArtifactRenderer,
  isSelectionPreparing,
  type ArtifactRenderDispatch,
} from "./renderer-dispatch";
import { resolveArtifactDispatchInputs } from "./renderer-resolution";
import { ExtensionRendererMount } from "./extension-renderer-mount";
import { RendererDegradedNotice } from "./renderer-degraded-notice";
import { MarkdownHandler } from "./handlers/markdown-handler";
import { PlainTextHandler } from "./handlers/plain-text-handler";
import { PdfHandler } from "./handlers/pdf-handler";
import { isIosUserAgent } from "./handlers/pdf-inline-support";
import { ImageHandler } from "./handlers/image-handler";
import { VideoHandler } from "./handlers/video-handler";
import { AudioHandler } from "./handlers/audio-handler";
import { FallbackHandler } from "./handlers/fallback-handler";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ArtifactDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  // `?renderer=generic` forces the generic floor — the recovery link the
  // route-segment error boundary (error.tsx) points at, and a manual escape
  // hatch. It never mounts the extension renderer (cinatra#1629 S2, AC-4).
  const forceGeneric = (await searchParams)?.renderer === "generic";
  const session = await getAuthSession();
  if (!session) redirect("/sign-in");
  const orgId = session.session?.activeOrganizationId;
  if (!orgId) redirect("/sign-in");

  const actor = await requireActorContext();
  // §III read authorization: distinguish not-found (404-hide) from a
  // list-visible-but-read-denied row, which the spec routes to the
  // not-authorized panel — never to the bytes and never to a generic 404.
  const access = readArtifactForDetail({ artifactId: id, orgId, actor });
  if (access.kind === "not-found") notFound();
  if (access.kind === "denied") return <ArtifactReadDeniedPanel />;
  const artifact: ArtifactSummary = access.artifact;

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
  const previewHref = revisionId
    ? `/api/artifacts/${id}/versions/${revisionId}/preview`
    : null;
  const downloadHref = revisionId
    ? `/api/artifacts/${id}/versions/${revisionId}/content`
    : null;

  // Renderer dispatch spine (cinatra#1629, epic #1620 S2): the pre-spine
  // always-true `hasTypedRenderer` signal is REPLACED by claimant-keyed
  // resolution through the two arbitration registries + the generated build map.
  // Precedence (total): semantic detail renderer (per-org effective-identity
  // winner) → representation viewer (org-scoped provider / first-party host
  // default) → generic fallback; a runtime-installed-but-unbuilt claimant
  // degrades to requires-rebuild. Read authorization is already enforced above —
  // a row the viewer may not read never reaches here. Unit-tested in
  // `renderer-dispatch.test.ts`; resolution seam in `renderer-resolution.ts`.
  const dispatch: ArtifactRenderDispatch = forceGeneric
    ? { kind: "fallback" }
    : pickArtifactRenderer(
        resolveArtifactDispatchInputs({
          orgId,
          baseType: artifact.objectType,
          identity: artifact.effectiveIdentity,
          mime,
        }),
      );

  // Activation barrier (§III): selection (pin / add-to-context) requires a
  // settled binding; a catalog browse-only identity shows "Preparing" until it
  // lands. Open still renders the row read-only.
  const selectionPreparing = isSelectionPreparing(artifact.effectiveIdentity);

  // UA hint for the PDF handler: known-iOS clients skip the broken
  // `<embed>` from the very first render (the client corrects the hint
  // post-hydration — iPadOS-as-Mac is indistinguishable server-side).
  // The page is already `force-dynamic`, so reading headers adds nothing.
  const pdfInitialFallback =
    dispatch.kind === "mime" && dispatch.handler === "pdf"
      ? isIosUserAgent((await headers()).get("user-agent") ?? "")
      : false;

  const title = artifact.title ?? artifact.artifactId;

  // The normalized, serializable renderer props snapshot (AC-5) — supplied to an
  // extension-shipped renderer; the host context never crosses into it.
  const rendererProps = buildArtifactRendererProps({
    artifact,
    representation: revisionId ? { revisionId, mime } : null,
    previewHref,
    downloadHref,
  });

  // The generic floor — reused by every degrade path so the body is never blank.
  const genericFloor = <FallbackHandler artifact={artifact} mime={mime} />;

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
                  <Link
                    href={artifact.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink data-icon="inline-start" aria-hidden="true" />
                    Open in source application
                  </Link>
                </Button>
              ) : null}
              {downloadHref ? (
                <Button asChild variant="outline">
                  <Link href={downloadHref} download>
                    <Download data-icon="inline-start" aria-hidden="true" />
                    Download
                  </Link>
                </Button>
              ) : null}
            </>
          ) : null
        }
      />
      <PageContent
        className="flex flex-col gap-6 pb-8"
        data-render-dispatch={dispatch.kind}
      >
        {/* §III activation barrier: pin / add-to-context is replaced by a
            muted "Preparing" label until the claim's binding lands. */}
        {selectionPreparing ? (
          <span
            className="inline-flex w-fit items-center rounded-md bg-surface-muted px-2 py-1 text-xs text-muted-foreground"
            data-testid="artifact-selection-preparing"
            data-conformance-id="artifacts-activation-preparing"
            title="Preparing — pinning and context selection unlock once this artifact's binding lands."
          >
            Preparing
          </span>
        ) : null}
        {(() => {
          switch (dispatch.kind) {
            // Extension-shipped semantic detail renderer or representation
            // viewer — MOUNTED through `ExtensionRendererMount`, which classifies
            // the loadable path: the build-map SSR fast path (system/first-party
            // bases) OR the main-realm dynamic client loader (marketplace-
            // installed, zero host rebuild). Either degrades to the generic floor
            // + a sanitized notice on any pre-render/pre-import failure.
            case "semantic":
            case "representation":
              return (
                <ExtensionRendererMount
                  generatedKey={dispatch.generatedKey}
                  packageName={dispatch.packageName}
                  // Both the semantic detail view and the detail-page
                  // representation viewer mount at slot `detail` (Slice B — the
                  // representation viewer resolves at `detail`, the neutral
                  // `preview` capability serves in-core reuse sites only).
                  slot="detail"
                  props={rendererProps}
                  fallback={genericFloor}
                />
              );
            // A runtime-installed claimant whose module is absent from this
            // build: generic floor + a "requires rebuild" notice (never blank).
            case "requires-rebuild":
              return (
                <>
                  <RendererDegradedNotice
                    packageName={dispatch.packageName}
                    slot={dispatch.slot}
                    failureClass="not-built"
                  />
                  {genericFloor}
                </>
              );
            // First-party host MIME handler (the always-effective default).
            case "mime": {
              if (!previewHref) return genericFloor;
              switch (dispatch.handler) {
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
                default:
                  return genericFloor;
              }
            }
            case "fallback":
            default:
              return genericFloor;
          }
        })()}
      </PageContent>
    </Main>
  );
}
