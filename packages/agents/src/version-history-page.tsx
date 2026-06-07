import "server-only";
import { requireAdminSession } from "@/lib/auth-session";
import { notFound } from "next/navigation";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { readAgentTemplateById, readAgentTemplateVersions, diffSnapshots } from "./store";
import { VersionHistoryList, type VersionRow } from "./version-history-list";

type VersionHistoryPageProps = {
  templateId: string;
  searchParams?: {
    cursor?: string;
  };
};

export async function VersionHistoryPage({ templateId, searchParams }: VersionHistoryPageProps) {
  await requireAdminSession();

  const template = await readAgentTemplateById(templateId);
  if (!template) notFound();

  const page = await readAgentTemplateVersions(templateId, {
    limit: 50,
    cursor: searchParams?.cursor,
  });

  const currentVersionId = template.currentVersionId ?? page.items[0]?.id ?? null;

  // Pre-compute diffs server-side so the client component receives plain strings
  const rows: VersionRow[] = page.items.map((v, idx) => {
    const older = page.items[idx + 1];
    return {
      id: v.id,
      semver: v.semver,
      bumpType: v.bumpType,
      changelogLine: v.changelogLine,
      createdAt: v.createdAt.toISOString(),
      createdBy: v.createdBy,
      diff: older ? diffSnapshots(older.snapshot, v.snapshot) : null,
      isCurrent: v.id === currentVersionId,
    };
  });

  return (
    <Main className="min-h-screen">
      <PageHeader
        label="Version history"
        title={template.name}
        description="Every save creates an immutable snapshot. Use Diff to inspect changes, Restore to make any version the live one."
        actions={
          <Button asChild variant="outline">
            <Link href={`/agents/builder/${templateId}`}>Back to agent</Link>
          </Button>
        }
      />
      <PageContent className="flex flex-col gap-4 pb-8">
        <VersionHistoryList items={rows} templateId={templateId} />

        {page.hasMore && page.nextCursor ? (
          <div className="flex justify-center">
            <Button asChild variant="outline" size="sm">
              <Link href={`/agents/builder/${templateId}/history?cursor=${page.nextCursor}`}>
                Load older versions
              </Link>
            </Button>
          </div>
        ) : null}
      </PageContent>
    </Main>
  );
}
