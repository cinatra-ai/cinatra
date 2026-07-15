/**
 * `/artifacts` — the consolidated surface (cinatra#1431, epic #1424, spec
 * design@4c6799db `specs/app-artifacts.html`). One page replaces
 * two: it absorbs the former `/data` browser outright (removed, no redirects —
 * §VII). A user-facing LIBRARY (§II, every user) and the administrator modes —
 * RAW OBJECTS (§IV), TYPES & APPROVALS (§V), UNDO (§VI) — hang off one page,
 * selected by `?mode=`.
 *
 * The mode control is identity-gated, NOT just view-gated (§I): the
 * authorization boundary is HERE, server-side. A non-administrator can only
 * ever resolve to Library; a deep link into any admin mode resolves to the
 * inline not-authorized panel and the admin query NEVER runs (UI hiding of the
 * segments is affordance only). Renderer dispatch (§III) lives on the detail
 * route `/artifacts/[id]`.
 */
import "server-only";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";

import { getAuthSession, requireActorContext, isPlatformAdmin } from "@/lib/auth-session";

import {
  resolveRequestedArtifactsMode,
  planArtifactsContent,
} from "@/components/artifacts/artifacts-modes";
import { ArtifactsModeControl } from "@/components/artifacts/artifacts-mode-control";
import { ArtifactsNotAuthorizedPanel } from "@/components/artifacts/not-authorized-panel";
import { LibraryMode } from "@/components/artifacts/library-mode";
import { RawObjectsMode } from "@/components/artifacts/raw-objects-mode";
import { TypesApprovalsMode } from "@/components/artifacts/types-approvals-mode";
import { UndoMode } from "@/components/artifacts/undo-mode";
import { TargetedRestoreMode } from "@/components/artifacts/targeted-restore-mode";
import { MergeProposalsMode } from "@/components/artifacts/merge-proposals-mode";
import { loadAuthorizedTargetedRestore } from "@/lib/object-history/restore-eligibility";

export const metadata: Metadata = { title: "Artifacts" };
export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<{
    mode?: string;
    q?: string;
    facet?: string;
    /** Undo deep-link (§VI): the change-set id whose restore modal auto-opens. */
    openRestore?: string;
  }>;
};

export default async function ArtifactsPage({ searchParams }: PageProps) {
  const session = await getAuthSession();
  if (!session) redirect("/sign-in");
  const orgId = session.session?.activeOrganizationId ?? null;
  if (!orgId) redirect("/sign-in");

  const isAdmin = isPlatformAdmin(session);
  const sp = (await searchParams) ?? {};
  const resolved = resolveRequestedArtifactsMode(sp.mode, isAdmin);

  // §VI carve-out: a non-admin `?mode=undo` is NOT the admin browser. Only when
  // it carries an `openRestore` the actor is per-object-authorized to reverse
  // does it become a targeted restore; otherwise it falls through to Library
  // (never the not-authorized panel). Load + authorize ONCE server-side, ONLY
  // for that narrow case (a non-admin denied-undo with an id) — the loaded
  // result is rendered directly, so there is no check-then-reload race.
  const nonAdminUndoDeepLink =
    resolved.kind === "denied" &&
    resolved.mode === "undo" &&
    typeof sp.openRestore === "string" &&
    sp.openRestore.length > 0;
  const targetedRestore = nonAdminUndoDeepLink
    ? await loadAuthorizedTargetedRestore(sp.openRestore as string)
    : null;
  const plan = planArtifactsContent({
    resolved,
    openRestore: sp.openRestore,
    targetedRestoreEligible: targetedRestore !== null,
  });
  // Collapse the (already-impossible: the verdict IS the load) "targeted but
  // nothing loaded" case to the AC3-safe Library fallback — a lost / revoked
  // change-set must never dead-end.
  const content: typeof plan =
    plan.render === "targeted-restore" && !targetedRestore
      ? { render: "library" }
      : plan;

  // The mode control still reflects the admin-mode gate (a non-admin sees
  // Library active; the Undo segment never appears — unchanged).
  const activeMode = resolved.kind === "allowed" ? resolved.mode : "library";

  // Actor context only needed for the per-actor data modes (library / raw) —
  // including the Library fall-through for a non-eligible non-admin undo link.
  const needsActor = content.render === "library" || content.render === "raw";
  const actor = needsActor ? await requireActorContext() : null;

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Artifacts"
        description={
          isAdmin
            ? "Everything your agents and uploads have produced, and — for administrators — the raw objects beneath."
            : "Everything your agents and uploads have produced."
        }
      />
      <PageContent className="flex flex-col gap-4 pb-8">
        <div
          className="flex flex-col gap-4"
          data-testid={isAdmin ? "artifacts-surface" : "artifacts-mode-nonadmin"}
          data-conformance-id={isAdmin ? "artifacts-surface" : "artifacts-mode-nonadmin"}
        >
          <ArtifactsModeControl activeMode={activeMode} isAdmin={isAdmin} />
          {!isAdmin ? (
            <p className="font-mono text-badge-xs text-muted-foreground">
              No <em>Raw objects</em>, <em>Types</em> or the <em>Undo</em> browser
              — those sub-views are administrator-only (a targeted restore
              you&apos;re authorized for is still reachable — §VI).
            </p>
          ) : null}

          {content.render === "denied" ? (
            <ArtifactsNotAuthorizedPanel mode={content.mode} />
          ) : content.render === "targeted-restore" && targetedRestore ? (
            <TargetedRestoreMode loaded={targetedRestore} />
          ) : content.render === "raw" ? (
            <RawObjectsMode orgId={orgId} actor={actor!} query={sp.q} typeFilter={sp.facet} />
          ) : content.render === "types" ? (
            <TypesApprovalsMode orgId={orgId} />
          ) : content.render === "undo" ? (
            <UndoMode orgId={orgId} openRestore={sp.openRestore} />
          ) : content.render === "merge" ? (
            <MergeProposalsMode orgId={orgId} />
          ) : (
            <LibraryMode orgId={orgId} actor={actor!} query={sp.q} facet={sp.facet} />
          )}
        </div>
      </PageContent>
    </Main>
  );
}
