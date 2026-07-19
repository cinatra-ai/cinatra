/**
 * `/artifacts` — the library, and nothing else (cinatra#1791, epic #1785,
 * spec design@923fa0d8 `specs/app-artifacts.html` §I/§II). It lists exactly
 * the acting user's artifacts, for EVERY user — there is no view toggle,
 * because the library is the lone view. The page opens with the standard page
 * header (title Artifacts, a one-line description, a closing etched rule),
 * then the library's own toolbar over the list.
 *
 * The former administrator surfaces moved off this page: type definitions,
 * stored objects, and change-set restore now live on the
 * `/configuration/artifacts` console (#1786); a single change set's targeted
 * restore has its own nested route there,
 * `/configuration/artifacts/restore/[changeSetId]`; artifact change review
 * lives on the shared artifact-review surface (#1795). Renderer dispatch (§III)
 * lives on the detail route `/artifacts/[id]`.
 *
 * The identity-gated view dispatch is retired outright — no resolver, no
 * segmented control, no refusal panel. A legacy deep link into a former admin
 * view carries no meaning here: it simply renders the library (no redirect, no
 * refusal), per the epic ruling.
 */
import "server-only";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";

import { getAuthSession, requireActorContext } from "@/lib/auth-session";
import { LibraryMode } from "@/components/artifacts/library-mode";

export const metadata: Metadata = { title: "Artifacts" };
export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<{
    q?: string;
    facet?: string;
  }>;
};

export default async function ArtifactsPage({ searchParams }: PageProps) {
  const session = await getAuthSession();
  if (!session) redirect("/sign-in");
  const orgId = session.session?.activeOrganizationId ?? null;
  if (!orgId) redirect("/sign-in");

  const sp = (await searchParams) ?? {};
  const actor = await requireActorContext();

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Artifacts"
        description="Everything your agents and uploads have produced."
      />
      <PageContent className="flex flex-col gap-4 pb-8">
        <LibraryMode orgId={orgId} actor={actor} query={sp.q} facet={sp.facet} />
      </PageContent>
    </Main>
  );
}
