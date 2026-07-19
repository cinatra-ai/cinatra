/**
 * `/configuration/artifacts` — the Artifacts console (cinatra#1786, epic #1785,
 * spec design@923fa0d8 `specs/app-artifacts.html` §IV). One page, three tabs
 * behind a canonical underline tablist (Application Design — Components · Tabs;
 * underline only, no pill tabs):
 *
 *   - Type definitions (default) — the global type registry: every type every
 *     installed artifact extension defines, alphabetical across all extensions.
 *   - Stored objects — the global stored-object inventory across every artifact
 *     extension, with entity-named scope labels.
 *   - Restore objects — the time-keyed change-set restore console (inline-modal
 *     Undo, authorized per object, no admin bypass). A single change set's
 *     restore has its own nested route, /configuration/artifacts/restore/[id].
 *
 * Admin-gated (`requireAdminSession`). The active tab is selected server-side
 * from `?tab=`; an unknown/absent tab falls through to Type definitions (a
 * legacy `?tab=` value never dead-ends on a blank). Artifact change review is
 * NOT here — it lives on the shared artifact-review surface (cinatra#1795).
 */
import type { Metadata } from "next";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";
import { requireAdminSession, requireActorContext } from "@/lib/auth-session";

import { ArtifactsConsoleTabs } from "@/components/artifacts/console/console-tabs";
import { TypeDefinitionsTab } from "@/components/artifacts/console/type-definitions-tab";
import { StoredObjectsTab } from "@/components/artifacts/console/stored-objects-tab";
import { RestoreObjectsTab } from "@/components/artifacts/console/restore-objects-tab";

export const metadata: Metadata = { title: "Artifacts" };
export const dynamic = "force-dynamic";

const CONSOLE_TABS = [
  { value: "definitions", label: "Type definitions" },
  { value: "objects", label: "Stored objects" },
  { value: "restore", label: "Restore objects" },
] as const;

type ConsoleTab = (typeof CONSOLE_TABS)[number]["value"];

function resolveTab(raw: string | undefined): ConsoleTab {
  return CONSOLE_TABS.some((t) => t.value === raw) ? (raw as ConsoleTab) : "definitions";
}

type PageProps = {
  searchParams?: Promise<{ tab?: string }>;
};

export default async function ArtifactsConsolePage({ searchParams }: PageProps) {
  const session = await requireAdminSession();
  const orgId = session.session?.activeOrganizationId ?? null;
  const sp = (await searchParams) ?? {};
  const tab = resolveTab(sp.tab);

  // Actor is needed only for the per-actor stored-object read.
  const actor = tab === "objects" ? await requireActorContext() : null;

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Artifacts"
        description="Every type your artifact extensions define, every stored object across them, and the change sets you can undo."
        divider={false}
      />
      <PageContent className="flex flex-col gap-4 pb-8">
        <ArtifactsConsoleTabs tabs={CONSOLE_TABS} activeTab={tab} />
        <div
          data-testid="artifacts-console"
          data-conformance-id="artifacts-console"
          data-active-tab={tab}
        >
          {tab === "definitions" ? (
            <TypeDefinitionsTab orgId={orgId} />
          ) : tab === "objects" ? (
            <StoredObjectsTab orgId={orgId} actor={actor ?? undefined} />
          ) : (
            <RestoreObjectsTab orgId={orgId} />
          )}
        </div>
      </PageContent>
    </Main>
  );
}
