import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsListRow, TabsTrigger } from "@/components/ui/tabs";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { getAuthSession, isPlatformAdmin } from "@/lib/auth-session";

import { availableSources } from "./sources/registry";
import type { ApprovalViewer, Direction, SourceCounts } from "./sources/types";
import { resolveApprovalsActiveView } from "./resolve-active-view";
import { SourceSection, SourceSkeleton } from "./source-section";

export const metadata: Metadata = { title: "Approvals" };

// — Unified approvals surface. Sidebar label stays "Approvals". Two DIRECTION
//   tabs:
//     • Inbox         (?direction=inbox, default) — items awaiting the viewer's
//                     decision, federated across the source registry.
//     • Your requests (?direction=mine)           — items the viewer submitted.
//   Per-source sections stream under their own Suspense boundary; a failed
//   source renders an inline section error and never blocks its siblings (the
//   safe loader in source-section.tsx). Legacy `?tab=agents|workflows` deep
//   links (config cards + next.config.ts redirects) map to Inbox via the pure
//   resolver, so those surfaces stay byte-unchanged.

function DirectionCountPill({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <Badge variant="default" className="min-w-5 px-1 text-[10px]">
      {count > 99 ? "99+" : count}
    </Badge>
  );
}

function pickParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AdministrationApprovalsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getAuthSession();
  const userId = session?.user?.id ?? null;
  const orgId = session?.session?.activeOrganizationId ?? null;

  const params = (await searchParams) ?? {};
  const explicitDirection = pickParam(params.direction);
  const legacyTab = pickParam(params.tab);
  const status = pickParam(params.status);

  const header = (
    <PageHeader
      title="Approvals"
      description="Requests awaiting a decision, and the requests you have submitted."
      divider={false}
    />
  );

  if (!userId || !orgId) {
    return (
      <Main className="min-h-screen">
        {header}
        <PageContent className="flex flex-col gap-6 pb-8">
          <Empty className="border-line">
            <EmptyHeader>
              <EmptyTitle>No active organization</EmptyTitle>
              <EmptyDescription>
                Select an organization to see approvals awaiting your decision.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </PageContent>
      </Main>
    );
  }

  const viewer: ApprovalViewer = { userId, orgId, isAdmin: isPlatformAdmin(session) };
  const sources = await availableSources(viewer);

  // Actionable counts across available sources (soft-fail per source). Feeds the
  // smart default direction and the direction-tab pills. (The sidebar badge
  // stays on pendingApprovalsCount() until it moves to the registry.)
  const countsList = await Promise.all(
    sources.map((s) => s.counts(viewer).catch(() => ({ inbox: 0, mine: 0 }) as SourceCounts)),
  );
  const inboxTotal = countsList.reduce((sum, c) => sum + c.inbox, 0);
  const mineTotal = countsList.reduce((sum, c) => sum + c.mine, 0);

  const { direction } = resolveApprovalsActiveView({
    explicitDirection,
    legacyTab,
    inboxCount: inboxTotal,
    mineCount: mineTotal,
  });

  const opts = status ? { status } : undefined;

  const renderSections = (dir: Direction) => {
    const applicable = sources.filter((s) => s.appliesTo(viewer, dir));
    if (applicable.length === 0) {
      return (
        <Empty className="border-line">
          <EmptyHeader>
            <EmptyTitle>
              {dir === "inbox" ? "Nothing awaiting your decision" : "No requests yet"}
            </EmptyTitle>
            <EmptyDescription>
              {dir === "inbox"
                ? "Requests that need your decision will appear here."
                : "Requests you submit will appear here while they await a decision."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      );
    }
    return applicable.map((s) => (
      <Suspense key={s.id} fallback={<SourceSkeleton title={s.title} />}>
        <SourceSection source={s} viewer={viewer} direction={dir} opts={opts} />
      </Suspense>
    ));
  };

  return (
    <Main className="min-h-screen">
      {header}
      <PageContent className="flex flex-col gap-6 pb-8">
        <Tabs defaultValue={direction}>
          <TabsListRow>
            <TabsTrigger value="inbox" asChild>
              <Link
                href="/configuration/approvals?direction=inbox"
                scroll={false}
                className="inline-flex items-center gap-2"
              >
                Inbox
                <DirectionCountPill count={inboxTotal} />
              </Link>
            </TabsTrigger>
            <TabsTrigger value="mine" asChild>
              <Link
                href="/configuration/approvals?direction=mine"
                scroll={false}
                className="inline-flex items-center gap-2"
              >
                Your requests
                <DirectionCountPill count={mineTotal} />
              </Link>
            </TabsTrigger>
          </TabsListRow>
          <TabsContent value="inbox" className="flex flex-col gap-6">
            {renderSections("inbox")}
          </TabsContent>
          <TabsContent value="mine" className="flex flex-col gap-6">
            {renderSections("mine")}
          </TabsContent>
        </Tabs>
      </PageContent>
    </Main>
  );
}
