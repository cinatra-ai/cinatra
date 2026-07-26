/**
 * `/artifacts/[id]` detail page.
 *
 * Server component. Resolves the artifact via `getArtifact` (actor +
 * tenant + tombstone gating), picks a MIME handler from the
 * latest representation, and renders inside the canonical Main +
 * PageHeader (artifact name) + PageContent shell.
 *
 * Renderer dispatch (spine — cinatra#1629 / #1630):
 *   - `application/pdf`, `image/*`, allowlisted `video/*` + `audio/*` →
 *     the system `-artifact` base's build-bundled renderer, resolved as a
 *     `representation` through the representation-provider registry (the boot
 *     registrar binds the four bases for every org; the preview route still
 *     streams the bytes the extension renderer points `urls.preview` at).
 *   - `text/markdown` / `text/plain` → the core-owned never-blank FLOOR
 *     (MarkdownHandler / PlainTextHandler), a first-party `mime` dispatch.
 *   - everything else → FallbackHandler (generic metadata card).
 *
 * First-party FLOOR selection lives in `./pick-handler.ts`; the precedence leaf
 * in `./renderer-dispatch.ts`; the resolution seam in `./renderer-resolution.ts`.
 *
 * `PageHeader.actions` carries the artifact-level actions:
 *   - Download — always (when a representation exists); hits the existing
 *     content endpoint (always `attachment` per `downloadDispositionFor`).
 *   - "Open in source application" — only when `artifact.sourceUrl` is
 *     non-null (connector-ref artifacts; the service validates the URL to
 *     http/https before it ever reaches this href).
 */
import "server-only";
import { Suspense } from "react";
import Link from "next/link";
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

import { isDashboardArtifactType } from "@/lib/dashboards/dashboard-artifact-surface";
import { resolveDashboardArtifactPointer } from "@/lib/dashboards/dashboard-artifact-pointer-resolvers";

import { ArtifactReadDeniedPanel } from "./read-denied-panel";
import {
  DashboardPointerDetail,
  DashboardPointerLoading,
  DashboardPointerError,
} from "./dashboard-pointer-detail";
import {
  pickArtifactRenderer,
  isSelectionPreparing,
  type ArtifactRenderDispatch,
} from "./renderer-dispatch";
import { resolveArtifactDispatchInputs } from "./renderer-resolution";
import { ensureActivatedRepresentationProviders } from "@/lib/artifacts/activated-artifact-renderer-binder";
import { ExtensionRendererMount } from "./extension-renderer-mount";
import { RendererDegradedNotice } from "./renderer-degraded-notice";
import { MarkdownHandler } from "./handlers/markdown-handler";
import { PlainTextHandler } from "./handlers/plain-text-handler";
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

  // §VIII — a dashboard artifact opens as a POINTER, never an inline render
  // (owner ruling 2026-07-20; spec app-artifacts.html §VIII, design@5daf862). It carries
  // NO renderer dispatch and NO Download: the detail is a pointer surface that
  // navigates to the dashboard's canonical surface. The dual authorization + the
  // dashboard name/scope resolve inside the streamed boundary, so the loading /
  // error / not-authorized states are the pointer surface's own frames.
  if (isDashboardArtifactType(artifact.objectType)) {
    return (
      <Main className="min-h-screen">
        <PageHeader
          title="Dashboard"
          description="A dashboard artifact — opens at its canonical surface."
          divider={false}
        />
        <PageContent
          className="flex flex-col gap-6 pb-8"
          data-render-dispatch="dashboard-pointer"
        >
          <Suspense fallback={<DashboardPointerLoading />}>
            <DashboardPointerBoundary artifactId={id} />
          </Suspense>
        </PageContent>
      </Main>
    );
  }

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
  // ACTIVATION-COUPLED BINDING (cinatra#2044 L-A3): reconcile the org's
  // build-bundled NON-SYSTEM (`guardedOptional`) renderer providers from the
  // canonical install rows before the SYNC dispatch below, so an org that has
  // actually INSTALLED such a pack resolves its representation renderer — and an
  // org that has not (or that uninstalled it) does not. The system bases keep
  // their own unconditional reconcile inside `resolveRepresentationDispatch`.
  if (!forceGeneric) await ensureActivatedRepresentationProviders(orgId);
  const dispatch: ArtifactRenderDispatch = forceGeneric
    ? { kind: "fallback" }
    : pickArtifactRenderer(
        resolveArtifactDispatchInputs({
          orgId,
          baseType: artifact.objectType,
          // Renderer dispatch presents the assertion-aware PRESENTATION identity
          // (epic #1883 A6) — a row filed as "Marketing strategy" renders as
          // that. The shared effective identity is untouched (context selection
          // / replay / Graphiti still read it); they diverge by design.
          identity: artifact.presentationIdentity,
          mime,
        }),
      );

  // Activation barrier (§III): selection (pin / add-to-context) requires a
  // settled binding; a catalog browse-only identity shows "Preparing" until it
  // lands. Open still renders the row read-only.
  const selectionPreparing = isSelectionPreparing(artifact.effectiveIdentity);

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
            // First-party host MIME handler — the core-owned never-blank FLOOR
            // that survives the G2 cutover: markdown (DEFER) + escaped plain-text
            // (STAY). pdf / image / audio / video MIGRATED to the system
            // `-artifact` bases and resolve as `representation` above, never here.
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
                // Any other handler kind is unreachable post-cutover (pickHandler
                // only yields markdown/text); the generic floor keeps it
                // never-blank if a stale build ever produced one.
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

/**
 * §VIII pointer boundary — streams the READY pointer behind the detail page's
 * Suspense (fallback = the loading frame). Applies the Phase-1 DUAL
 * AUTHORIZATION: `denied` routes to the not-authorized panel (the object.read
 * gate already passed above — this is the "may list but not read" case);
 * `not-found` 404s (existence stays hidden); a dashboards-source failure renders
 * the error frame rather than bubbling. NEVER renders the dashboard inline.
 */
async function DashboardPointerBoundary({ artifactId }: { artifactId: string }) {
  let resolved;
  try {
    resolved = await resolveDashboardArtifactPointer(artifactId);
  } catch {
    return <DashboardPointerError />;
  }
  if (resolved.access === "not-found") notFound();
  if (resolved.access === "denied") return <ArtifactReadDeniedPanel />;
  return <DashboardPointerDetail pointer={resolved.pointer} />;
}
