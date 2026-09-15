/**
 * `/artifacts/[id]` detail page.
 *
 * Server component. Resolves the artifact via `getArtifact` (actor +
 * tenant + tombstone gating), picks a MIME handler from the
 * latest representation, and renders inside the canonical Main +
 * PageHeader (artifact name) + PageContent shell.
 *
 * EVERY ARTIFACT IS DRAWN BY ITS OWN EXTENSION'S DISPLAY. The page resolves the
 * display through the SHARED primitive the lifecycle review resolves through
 * (the resolver and failure policy in `./renderer-resolution`, the mount in
 * `./artifact-display-mount`): the semantic winner's `detail` display, then
 * an installed representation provider, then the floor. Core draws no artifact
 * content on any of those roads — the floor is a host diagnostic.
 *
 * `PageHeader.actions` carries the artifact-level actions:
 *   - "Open in source application" — only when `artifact.sourceUrl` is
 *     non-null (connector-ref artifacts; the service validates the URL to
 *     http/https before it ever reaches this href).
 */
import "server-only";
import { Suspense } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ExternalLink } from "lucide-react";

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
import { artifactKindLabelFor } from "@/lib/artifacts/artifact-kind-label";
import {
  absentArtifactContent,
  buildArtifactRendererProps,
  grantArtifactEdit,
  readOnlyArtifactEdit,
} from "@/lib/artifacts/artifact-renderer-props";
import { hostArtifactContentBuilder } from "./review-surface-roads";
import {
  artifactDisplayTitle,
  buildArtifactDetailHeader,
} from "./artifact-detail-header";
import { resolveArtifactContentClass } from "@/lib/artifacts/artifact-content-channel";
import {
  getRepresentationByIdForReplay,
  resolveEditorRevisionId,
} from "@/lib/artifacts/representation-store";
import { can } from "@/lib/authz/enforce";
import {
  ARTIFACT_EDIT_IDLE_PAUSE_MS,
  ARTIFACT_EDIT_TEXT_CAP_BYTES,
} from "@cinatra-ai/sdk-extensions/artifact-edit-channel";

import { isDashboardArtifactType } from "@/lib/dashboards/dashboard-artifact-surface";
import { resolveDashboardArtifactPointer } from "@/lib/dashboards/dashboard-artifact-pointer-resolvers";

import { ArtifactReadDeniedPanel } from "./read-denied-panel";
import { NoDisplayNotice } from "./no-display-notice";
import {
  DashboardPointerDetail,
  DashboardPointerLoading,
  DashboardPointerError,
} from "./dashboard-pointer-detail";
import { isSelectionPreparing } from "./renderer-dispatch";
import { ArtifactDisplayMountPoint } from "./artifact-display-mount";
import { resolveArtifactDisplayMount } from "./renderer-resolution";
import { RendererDegradedNotice } from "./renderer-degraded-notice";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function ArtifactDetailPage({ params }: PageProps) {
  const { id } = await params;
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
          title={artifactDisplayTitle(artifact)}
          description="A dashboard artifact — opens at its canonical surface."
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

  // THE EDITOR OPENS ON THE HEAD REVISION, read from the store.
  //
  // The artifact row's own `latestRepresentationRevisionId` is a pointer cached
  // at creation, and the edit-save road appends revisions without moving it —
  // so on this page, the one surface that edits, it names revision 1 forever
  // after the first save. Opening there hands the next save a base the store has
  // already built on, and the save is refused as stale: the reader is told their
  // first change collided with someone else, on a document nobody else touched.
  //
  // The REVIEW surfaces keep their own reading and are not touched by this: a
  // review is handed the revision its gate pinned and never asks for a latest,
  // which is the whole point of the pin. The two readings differ by design —
  // this page shows what the artifact has become, a review shows what was
  // approved.
  const revisionId = await resolveEditorRevisionId(
    orgId,
    id,
    artifact.latestRepresentationRevisionId,
  );
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
  // THE HEADER DESCRIBES THE REVISION UNDER IT, both halves of the sentence.
  // NO SIZE IS READ HERE ANY MORE. main carried a head-revision size for the
  // header's old `mime - bytes` description line; the ratified drawing closes
  // this header at the mono meta line and gives no size at all, and
  // `w3-artifact-page-header-closed` pins that the page hands the header none.
  // The header model carries no size cell either — the drawing draws a size on
  // the per-kind download card (the drawing's V.2), not on this line, so the
  // page resolves none for the header and passes none to it.
  const previewHref = revisionId
    ? `/api/artifacts/${id}/versions/${revisionId}/preview`
    : null;
  const downloadHref = revisionId
    ? `/api/artifacts/${id}/versions/${revisionId}/content`
    : null;

  // Activation barrier (§III): selection (pin / add-to-context) requires a
  // settled binding; a catalog browse-only identity shows "Preparing" until it
  // lands. Open still renders the row read-only.
  const selectionPreparing = isSelectionPreparing(artifact.effectiveIdentity);

  // THE DRAWN HEADER (ratified drawing, artifact-review §IV and §XI). The page
  // used to draw a title over the media type and a count of bytes, which the
  // third proof round graded FAIL on sixteen frames for five reasons: no
  // type, no revision, no owner level or visibility, no kind beside the title,
  // and a size counted out in bytes. The model is pure and tested; this page
  // draws it and decides nothing about it.
  const header = buildArtifactDetailHeader({
    artifact,
    mime,
    revisionId,
  });
  // `PageHeader` broadcasts this string to the trail's leaf crumb, so it is the
  // one place the Breadcrumb rule against a raw id in a name's place lands.
  const title = header.title;

  // THE CONTENT CHANNEL (enabler 0.3, cinatra#3027), WIRED FOR THIS CONSUMER
  // (enabler 0.20, cinatra#3026). The markdown editor draws the document from
  // the props and never fetches, so the page has to read the pinned revision on
  // the server and carry it. The class comes from the FORM the substrate
  // recorded, never from a guess about the mime.
  const representationForm = revisionId
    ? (getRepresentationByIdForReplay(orgId, revisionId)?.form ?? null)
    : null;
  const contentClass =
    revisionId && representationForm && mime
      ? resolveArtifactContentClass({ form: representationForm, mime })
      : null;
  // WIRED THROUGH THE SURFACE ROAD (wave 3 of `PLAN: Agents Lifecycle (D) -
  // Review`, cinatra#3091), not through the text-only ports this page bound
  // before the forward. The road carries the CHANNEL'S OWN read - every class
  // and the bound the caller names - so the json and cms-snapshot displays on
  // this page draw through the same channel the text one does, while the editor
  // above still decides on `content.kind === "text"`. Pinned by
  // `w3-forward-content-road-substance`: taking the narrower reader here would
  // silently un-ship the classes wave 3 added.
  const content =
    revisionId && representationForm
      ? await hostArtifactContentBuilder()({
          orgId,
          artifactId: artifact.artifactId,
          representationRevisionId: revisionId,
          form: representationForm,
          mime,
        })
      : absentArtifactContent(revisionId ?? null, contentClass ? "unsupported-form" : "absent");

  // THE EDIT CAPABILITY (enabler 0.20). Minted HERE and nowhere else: this is
  // the artifact's own page, the one surface the plan makes editable. The
  // affordance question is the pure decision (`can`) so a page view is not an
  // authorization event; the SAVE ENDPOINT asks the same question through
  // `requireAccess`, which is the boundary and audits. They ask it of the same
  // permission and the same resource, so the drawn affordance and the enforced
  // right can never disagree.
  const mayEditArtifact = can(actor, "artifact.update", {
    resourceType: "artifact",
    resourceId: id,
    organizationId: orgId,
  });
  const edit =
    revisionId && content.kind === "text" && !content.truncated && mayEditArtifact
      ? grantArtifactEdit({
          artifactId: id,
          baseRevisionId: revisionId,
          saveUrl: `/api/artifacts/${id}/edit`,
          idlePauseMs: ARTIFACT_EDIT_IDLE_PAUSE_MS,
          capBytes: ARTIFACT_EDIT_TEXT_CAP_BYTES,
        })
      : readOnlyArtifactEdit(
          !revisionId
            ? "no-representation"
            : content.kind !== "text"
              ? "unsupported-form"
              : content.truncated
                ? "content-truncated"
                : "no-write-rights",
        );

  // The normalized, serializable renderer props snapshot (AC-5) — supplied to an
  // extension-shipped renderer; the host context never crosses into it.
  const rendererProps = buildArtifactRendererProps({
    artifact,
    representation: revisionId ? { revisionId, mime } : null,
    previewHref,
    downloadHref,
    content,
    edit,
  });

  // THE NEVER-BLANK FLOOR, and it draws no artifact. It used to be the core
  // metadata card — the file's name, its media type, its size and its download —
  // which is the artifact's own content, and content is the display's. A file no
  // installed display can read belongs to a base of its own, and that base's
  // display is the download card; here core says only that nothing installed
  // draws this row.
  const genericFloor = <NoDisplayNotice />;

  // THE DISPLAY, resolved through the ONE primitive the lifecycle review also
  // resolves through, at the props version the snapshot above was built at.
  // Read authorization is already enforced above — a row the viewer may not read
  // never reaches here.
  const mount = await resolveArtifactDisplayMount({
    orgId,
    baseType: artifact.objectType,
    // The assertion-aware PRESENTATION identity — a row filed as "Marketing
    // strategy" draws as that. The shared effective identity is untouched
    // (context selection / replay / Graphiti still read it); they diverge by
    // design.
    identity: artifact.presentationIdentity,
    mime,
    propsApiVersion: rendererProps.propsApiVersion,
  });

  return (
    <Main className="min-h-screen">
      <PageHeader
        title={title}
        titleContent={
          <span className="flex flex-wrap items-baseline gap-3">
            <span>{title}</span>
            <span
              className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-sans text-xs font-semibold not-italic text-primary"
              data-testid="artifact-kind-label"
            >
              {/* THE KIND, IN THE PACK'S OWN WORDS, BESIDE THE TITLE. The
                  drawing writes the kind between the display title and the mono
                  meta line on the artifact's own page, so it is drawn inside the
                  h1 rather than in the header's small label slot above it. The
                  WORDS are not derived here: `artifactKindLabelFor` returns what
                  the claiming pack declares (`cinatra.displayName`) and floors to
                  the package-id derivation only when a pack has declared nothing.
                  The review line and the run page read the same function over the
                  same `objectType`, so no two surfaces can word one pack its own
                  way — the border correction main carries, kept whole here. */}
              {artifactKindLabelFor(artifact.objectType)}
            </span>
          </span>
        }
        meta={header.metaCells.join(" · ")}
        // THE HEADER CARRIES NO DOWNLOAD. The drawing closes this header at the
        // mono meta line, and it gives the download to the KIND: the pdf's own
        // download floor (§XI.2, §XI.4), the download card of a file nothing can
        // read (§V.2). A control the header adds on top of that is a second
        // download the drawing never draws — the fourth proof round measured it
        // on all twenty-two artifact frames. "Open in source application" is not
        // one: it is where a connector-referenced row came FROM, not its bytes.
        actions={
          artifact.sourceUrl ? (
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
          ) : null
        }
      />
      <PageContent
        className="flex flex-col gap-6 pb-8"
        data-render-dispatch={mount.dispatch}
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
        <ArtifactDisplayMountPoint
          mount={mount}
          props={rendererProps}
          fallback={genericFloor}
          renderFloor={({ packageName, slot, reason }) =>
            // A CLAIMANT THIS BUILD DOES NOT CARRY still says so by name, above
            // the floor. Every other floor is the terminal one, and its whole
            // reading is the host diagnostic — there is nothing of the artifact
            // for core to draw underneath it.
            packageName && reason === "requires-rebuild" ? (
              <>
                <RendererDegradedNotice
                  packageName={packageName}
                  slot={slot}
                  failureClass="not-built"
                />
                {genericFloor}
              </>
            ) : (
              genericFloor
            )
          }
        />
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
