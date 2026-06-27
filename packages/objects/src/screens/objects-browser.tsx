import "server-only";
import Link from "next/link";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Database, Search } from "lucide-react";
import { requireAdminSession, requireActorContext } from "@/lib/auth-session";
import { ASSET_TYPE_IDS, ENTITY_TYPE_IDS } from "@/lib/register-all-object-types";
import { createSessionObjectsClient } from "../objects-client";
import { ConfidenceBadge } from "./confidence-badge";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SearchParams = Promise<{
  type?: string;
  category?: string;
  confidence?: "high" | "low" | "dynamic" | "__all__";
  q?: string;
  family?: "assets" | "entities";
}>;

type ObjectRow = {
  id: string;
  type: string;
  name: string | null;
  data: Record<string, unknown>;
  classificationConfidence: number | null;
  createdAt: string | null;
  actor: {
    agentId: string | null;
    runId: string | null;
    source: string | null;
    userId: string | null;
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


function EmptyState({ isFiltered }: { isFiltered: boolean }) {
  if (isFiltered) {
    return (
      <div className="flex flex-col items-center gap-3 py-12 text-center">
        <Database className="h-12 w-12 text-muted-foreground" />
        <p className="text-base font-semibold text-foreground">No data matches these filters.</p>
        <p className="text-sm text-muted-foreground">
          Try a different type, category, or clear the search.
        </p>
        <Button variant="outline" asChild>
          <Link href="/data">Clear filters</Link>
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      <Database className="h-12 w-12 text-muted-foreground" />
      <p className="text-base font-semibold text-foreground">No data yet.</p>
      <p className="text-sm text-muted-foreground max-w-md">
        Data will appear here once an agent calls the objects_save MCP primitive. Try running
        any agent to populate the store.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ObjectsBrowserScreen — SSR server component
// ---------------------------------------------------------------------------

export async function ObjectsBrowserScreen({ searchParams }: { searchParams: SearchParams }) {
  // Admin gate + full actor-context client.
  await requireAdminSession();
  const actor = await requireActorContext();
  const client = createSessionObjectsClient(actor);
  const params = await searchParams;

  const typeFilter = params.type && params.type !== "__all__" ? params.type : undefined;
  const categoryFilter = params.category && params.category !== "__all__" ? params.category : undefined;
  const confidenceFilter = params.confidence && params.confidence !== "__all__" ? params.confidence : undefined;
  const familyFilter = params.family === "assets" || params.family === "entities" ? params.family : undefined;

  const { items } = await client.list({
    type: typeFilter,
    category: categoryFilter,
    query: params.q,
    limit: 200,
  });
  const rows = items as ObjectRow[];
  const { types: typeCatalog } = await client.typesList();

  // Sort newest-first (Graphiti's getEpisodes has no guaranteed order).
  rows.sort((a, b) => {
    if (!a.createdAt && !b.createdAt) return 0;
    if (!a.createdAt) return 1;
    if (!b.createdAt) return -1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  // Client-side confidence + family filter (server-side filter not yet in list primitive).
  const filtered = rows.filter((r) => {
    if (familyFilter === "assets" && !ASSET_TYPE_IDS.has(r.type)) return false;
    if (familyFilter === "entities" && !ENTITY_TYPE_IDS.has(r.type)) return false;
    if (!confidenceFilter) return true;
    const c = r.classificationConfidence;
    if (c == null) return confidenceFilter === "dynamic";
    if (confidenceFilter === "high") return c >= 0.8;
    if (confidenceFilter === "low") return c >= 0.4 && c < 0.8;
    if (confidenceFilter === "dynamic") return c < 0.4;
    return true;
  });

  return (
    <Main className="min-h-screen">
      <PageHeader
        title={familyFilter === "assets" ? "Assets" : familyFilter === "entities" ? "Entities" : "Data"}
        description="All data saved by agents — filter by type, category, or source."
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        {/* Filter row */}
        <section className="soft-panel rounded-card px-6 py-5">
          <form className="flex flex-wrap items-end gap-4" method="get">
            <Label className="flex flex-col gap-2">
              <span className="text-sm font-semibold text-foreground">Type</span>
              <Select name="type" defaultValue={params.type ?? "__all__"}>
                <SelectTrigger className="w-[240px]">
                  <SelectValue placeholder="(any)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">(any)</SelectItem>
                  {typeCatalog.map((t) => (
                    <SelectItem key={t.type} value={t.type}>
                      {t.type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Label>

            <Label className="flex flex-col gap-2">
              <span className="text-sm font-semibold text-foreground">Category</span>
              <Select name="category" defaultValue={params.category ?? "__all__"}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="(any)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">(any)</SelectItem>
                  <SelectItem value="profile">profile</SelectItem>
                  <SelectItem value="content">content</SelectItem>
                  <SelectItem value="project">project</SelectItem>
                  <SelectItem value="idea">idea</SelectItem>
                  <SelectItem value="report">report</SelectItem>
                </SelectContent>
              </Select>
            </Label>

            <Label className="flex flex-col gap-2">
              <span className="text-sm font-semibold text-foreground">Confidence</span>
              <Select name="confidence" defaultValue={params.confidence ?? "__all__"}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="(any)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">(any)</SelectItem>
                  <SelectItem value="high">High (&ge;0.8)</SelectItem>
                  <SelectItem value="low">Low (0.4&ndash;0.8)</SelectItem>
                  <SelectItem value="dynamic">Dynamic (&lt;0.4)</SelectItem>
                </SelectContent>
              </Select>
            </Label>

            <Label className="flex flex-col gap-2 min-w-[240px]">
              <span className="text-sm font-semibold text-foreground">Search</span>
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  name="q"
                  defaultValue={params.q ?? ""}
                  className="pl-8"
                  placeholder="free-text"
                />
              </div>
            </Label>

            <Button type="submit">Apply filters</Button>
            <Button type="reset" variant="ghost" asChild>
              <Link href="/data">Clear</Link>
            </Button>
          </form>
        </section>

        {/* Table */}
        <section className="soft-panel rounded-card px-6 py-6">
          <h2 className="text-lg font-semibold text-foreground mb-4">
            {filtered.length} data item{filtered.length === 1 ? "" : "s"}
          </h2>
          {filtered.length === 0 ? (
            <EmptyState
              isFiltered={Boolean(
                params.type || params.category || params.confidence || params.q || params.family,
              )}
            />
          ) : (
            <div className="divide-y divide-border">
              {filtered.map((row) => (
                <Link
                  key={row.id}
                  href={`/data/${row.id}`}
                  className="flex h-12 items-center gap-4 px-2 hover:bg-surface-muted"
                  aria-label="View object details"
                >
                  <span className="font-mono text-xs text-muted-foreground w-[240px] truncate">
                    {row.type}
                  </span>
                  <span className="text-sm text-foreground flex-1 truncate">{row.name ?? "(no name)"}</span>
                  <ConfidenceBadge confidence={row.classificationConfidence} />
                  <span className="text-xs text-muted-foreground w-[140px] truncate">
                    {row.actor.source ?? "—"}
                  </span>
                  <span className="text-xs text-muted-foreground w-[140px] text-right shrink-0">
                    {row.createdAt ? new Date(row.createdAt).toLocaleString(undefined, {
                      month: "short", day: "numeric", year: "numeric",
                      hour: "2-digit", minute: "2-digit",
                    }) : "—"}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </section>

      </PageContent>
    </Main>
  );
}
