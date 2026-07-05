import Link from "next/link";
import { Kicker } from "@cinatra-ai/sdk-ui/section-header";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Play, Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { ListControls } from "@/components/list-controls";
import { getListConfigCookieName, getListViewCookieName, parseListConfigCookie } from "@/lib/list-view";
import { readInstalledAgentTemplates } from "./store";
import { selectHitlRunVisibleTemplates } from "./hitl-run-filter";
import { buildAgentWorkspacePath } from "@/lib/agent-url";
import { createDeterministicAgentsClient } from "./mcp/client/deterministic-client";
import type { AgentRunItem } from "./mcp/handlers";
import { Main } from "@/components/layout/main";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PaginatedTable } from "@/components/ui/paginated-table";
import { AgentBuilderRunScreen, AgentBuilderImportScreen } from "./screens";
import { AgentRunClient, type AgentRunRowModel } from "./agent-run-client";
import { AgentsTabNav } from "@/components/agents-tab-nav";

// ---------------------------------------------------------------------------
// AgentBuilder page exports
// ---------------------------------------------------------------------------

export async function AgentBuilderRunPage(props: {
  params: Promise<{ templateId: string }>;
}) {
  const { templateId } = await props.params;
  return AgentBuilderRunScreen({ templateId });
}

export async function AgentBuilderImportPage() {
  return AgentBuilderImportScreen();
}

// ---------------------------------------------------------------------------
// Canonical agents pages
// ---------------------------------------------------------------------------

export type AgentsSearchPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export type AgentsParamsPageProps<TParams extends Record<string, string>> = {
  params: Promise<TParams>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function pickSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function formatCreatedAt(value: string) {
  return value ? new Date(value).toLocaleString() : "—";
}

function statusBadgeVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "running" || status === "pending") return "default";
  if (status === "succeeded" || status === "completed") return "secondary";
  if (status === "failed") return "destructive";
  return "outline";
}

export async function AgentsPage({ searchParams }: AgentsSearchPageProps) {
  const client = createDeterministicAgentsClient({ actor: { actorType: "human", source: "ui" } });
  const [runs, resolvedSearchParams, cookieStore] = await Promise.all([
    client.agents.list() as Promise<AgentRunItem[]>,
    (searchParams ?? Promise.resolve({})) as Promise<Record<string, string | string[] | undefined>>,
    cookies(),
  ]);

  const preferredView = cookieStore.get(getListViewCookieName("/agents"))?.value;
  const requestedView = pickSearchParam(resolvedSearchParams.view);
  const view = requestedView === "cards" || requestedView === "table" ? requestedView : preferredView === "cards" ? "cards" : "table";
  const storedConfig = parseListConfigCookie(cookieStore.get(getListConfigCookieName("/agents"))?.value)[view] ?? {};
  const query = (pickSearchParam(resolvedSearchParams.q) ?? storedConfig.query ?? "").toLowerCase().trim();
  const sort = pickSearchParam(resolvedSearchParams.sort) ?? storedConfig.sort ?? "createdAt";
  const dir = (pickSearchParam(resolvedSearchParams.dir) ?? storedConfig.dir) === "asc" ? "asc" : "desc";
  const nextDirection = (column: string) => (sort === column && dir === "asc" ? "desc" : "asc");

  const filtered = runs
    .filter((run) => {
      if (query.length === 0) return true;
      return (
        run.name.toLowerCase().includes(query) ||
        run.agentType.toLowerCase().includes(query) ||
        run.status.toLowerCase().includes(query) ||
        run.id.toLowerCase().includes(query)
      );
    })
    .sort((a, b) => {
      const factor = dir === "asc" ? 1 : -1;
      if (sort === "agentType") return a.agentType.localeCompare(b.agentType) * factor;
      if (sort === "status") return a.status.localeCompare(b.status) * factor;
      if (sort === "name") return a.name.localeCompare(b.name) * factor;
      return a.createdAt.localeCompare(b.createdAt) * factor;
    });

  return (
    <Main className="grid-glow min-h-screen">
      <PageHeader
        title="Agents"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild>
              {/* cinatra#1007: /agents/run removed (not redirected) — the
                  run-agent picker moved to /agents. */}
              <Link href="/agents">
                <Play data-icon="inline-start" aria-hidden="true" />
                Run agent
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/chat?mode=create-agent">
                <Plus data-icon="inline-start" aria-hidden="true" />
                Create agent
              </Link>
            </Button>
          </div>
        }
      />
      <PageContent className="flex flex-col gap-8 pb-8">
        <ListControls
          basePath="/agents"
          searchPlaceholder="Search runs"
          query={query}
          view={view}
          filters={[]}
          sortValue={sort}
          sortOptions={[
            { value: "createdAt", label: "Created" },
            { value: "name", label: "Name" },
            { value: "agentType", label: "Agent type" },
            { value: "status", label: "Status" },
          ]}
          direction={dir}
          selectedColumns={[]}
          availableColumns={[]}
        />

        {view === "cards" ? (
          <section className="grid gap-4">
            {filtered.map((run) => (
              <Card key={run.id} className="border-line bg-surface backdrop-blur-none transition hover:-translate-y-0.5">
                <CardContent className="p-6">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <Kicker size="sm" tracking="wide">
                      {run.agentType}
                    </Kicker>
                    <Link href={run.href} className="mt-2 block text-2xl font-semibold underline-offset-4 hover:underline">
                      {run.name}
                    </Link>
                  </div>
                  <Badge variant={statusBadgeVariant(run.status)} className="rounded-chip capitalize">
                    {run.status}
                  </Badge>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-xs text-muted-foreground">Created: {formatCreatedAt(run.createdAt)}</span>
                </div>
                </CardContent>
              </Card>
            ))}
            {filtered.length === 0 && (
              <p className="text-sm text-muted-foreground py-8 text-center">No agent runs yet. Click &quot;Run agent&quot; to start one.</p>
            )}
          </section>
        ) : (
          <PaginatedTable className="min-w-full text-left text-sm">
                <TableHeader>
                  <TableRow>
                    <TableHead>
                      <Link href={`/agents?sort=name&dir=${nextDirection("name")}&view=table`} className="inline-flex items-center gap-2 hover:text-foreground">
                        Name
                      </Link>
                    </TableHead>
                    <TableHead>
                      <Link href={`/agents?sort=agentType&dir=${nextDirection("agentType")}&view=table`} className="inline-flex items-center gap-2 hover:text-foreground">
                        Agent type
                      </Link>
                    </TableHead>
                    <TableHead>
                      <Link href={`/agents?sort=status&dir=${nextDirection("status")}&view=table`} className="inline-flex items-center gap-2 hover:text-foreground">
                        Status
                      </Link>
                    </TableHead>
                    <TableHead>
                      <Link href={`/agents?sort=createdAt&dir=${nextDirection("createdAt")}&view=table`} className="inline-flex items-center gap-2 hover:text-foreground">
                        Created
                      </Link>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((run) => (
                    <TableRow key={run.id}>
                      <TableCell>
                        <Link href={run.href} className="font-semibold underline-offset-4 hover:underline">
                          {run.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{run.agentType}</TableCell>
                      <TableCell>
                        <Badge variant={statusBadgeVariant(run.status)} className="rounded-chip capitalize">
                          {run.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{formatCreatedAt(run.createdAt)}</TableCell>
                    </TableRow>
                  ))}
                  {filtered.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="py-8 text-center text-muted-foreground text-sm">
                        No agent runs yet. Click &quot;Run agent&quot; to start one.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </PaginatedTable>
        )}
      </PageContent>
    </Main>
  );
}

export async function NewAgentPage() {
  const allTemplates = await readInstalledAgentTemplates();
  // RUNTIME-LIFECYCLE GATE (cinatra#659): `readInstalledAgentTemplates` filters
  // by the agent-builder `status` (active|published) only — NOT the canonical
  // `installed_extension` source of truth. Intersect the LOCAL (non-external)
  // templates against the runtime install state so a disabled/uninstalled
  // (archived) agent disappears from the run picker without a rebuild. CG-1: a
  // template with NO canonical row (legacy/bundled/ungoverned) and a `null`
  // packageName stay listed (the bundled floor). External A2A templates are
  // governed by their own connector lifecycle, not an agent install row, so they
  // bypass this gate (the runnable set only includes scanned agent packages).
  // Fail-OPEN on a store outage (keep all).
  const { resolveRunnableAgentPackageNames } = await import("./runtime-install-gate");
  const runnable = await resolveRunnableAgentPackageNames(
    allTemplates
      .filter((t) => t.sourceType !== "external")
      .map((t) => t.packageName ?? null),
  );
  const lifecycleVisible = allTemplates.filter(
    (t) =>
      t.sourceType === "external" ||
      t.packageName == null ||
      runnable.has(t.packageName),
  );
  const visibleTemplates = selectHitlRunVisibleTemplates(lifecycleVisible);

  const rows: AgentRunRowModel[] = visibleTemplates.map<AgentRunRowModel>((t) => {
    const ioSkills = (() => {
      if (!t.ioSpec) return [] as string[];
      const raw: unknown = t.ioSpec;
      const candidate: unknown = typeof raw === "string"
        ? (() => {
            try { return JSON.parse(raw); } catch { return null; }
          })()
        : raw;
      if (!candidate || typeof candidate !== "object") return [] as string[];
      const maybeSkills = (candidate as { skills?: unknown }).skills;
      if (!Array.isArray(maybeSkills)) return [] as string[];
      return maybeSkills.filter((s): s is string => typeof s === "string");
    })();

    if (t.sourceType === "external" && t.connectorSlug && t.remoteAgentId) {
      return {
        key: `ext:${t.connectorSlug}:${t.remoteAgentId}`,
        name: t.name,
        description: t.description ?? "",
        version: t.packageVersion ?? "",
        skills: ioSkills,
        host: t.connectorSlug,
        runHref: `/agents/${encodeURIComponent(t.connectorSlug)}/${encodeURIComponent(t.remoteAgentId)}/new`,
      };
    }
    return {
      key: `local:${t.id}`,
      name: t.name,
      description: t.description ?? "",
      version: t.packageVersion ?? "",
      skills: ioSkills,
      host: "local",
      runHref: t.packageName ? buildAgentWorkspacePath(t.packageName) : "#",
    };
  });

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Run agent"
        description="Run an agent with a human-in-the-loop step, one of its sub-agents, or any agent from a connected external A2A server."
        divider={false}
      />
      {/* All Agents / Executions tab bar (cinatra#1007) — shown on both
          /agents (this page, the default "All Agents" tab) and
          /agents/executions (the dashboard, packages/dashboards'
          AgentsDashboardPage). TabsListRow's trailing rule replaces the
          PageHeader divider suppressed above. */}
      <AgentsTabNav activeTab="all" />
      <PageContent className="flex flex-col gap-6 pb-8">
        {rows.length === 0 ? (
          <section className="soft-panel rounded-card flex flex-col items-center justify-center gap-4 py-16 text-center">
            <h2 className="text-lg font-semibold">No human-in-the-loop agents installed</h2>
            <p className="text-muted-foreground text-sm max-w-md">
              Install an agent with review or approval steps from the marketplace, or connect an external A2A server.
            </p>
            <div className="flex flex-wrap gap-2 justify-center">
              <Button asChild>
                <Link href="/configuration/marketplace">Browse marketplace</Link>
              </Button>
              <Button asChild variant="outline">
                <Link href="/connectors?tool=a2a-server">Connect A2A server</Link>
              </Button>
            </div>
          </section>
        ) : (
          // ExtensionCard grid with client-side search toolbar (cinatra#814).
          // AgentRunClient receives the pre-built rows and filters on name +
          // description via a ToolbarSearchInput — same primitive used by the
          // marketplace and notifications archive pages.
          <AgentRunClient rows={rows} />
        )}
      </PageContent>
    </Main>
  );
}

export async function AgentDataPage({ params }: AgentsParamsPageProps<{ agentId: string }>) {
  const { agentId: rawAgentId } = await params;
  const agentId = decodeURIComponent(rawAgentId);
  redirect(`/agents/${encodeURIComponent(agentId)}/results`);
}

export async function AgentDataAccountsPage({ params, searchParams }: AgentsParamsPageProps<{ agentId: string }>) {
  const { agentId: rawAgentId } = await params;
  const agentId = decodeURIComponent(rawAgentId);
  void searchParams;
  redirect(`/agents/${encodeURIComponent(agentId)}/results/accounts`);
}

export async function AgentDataContactsPage({ params, searchParams }: AgentsParamsPageProps<{ agentId: string }>) {
  const { agentId: rawAgentId } = await params;
  const agentId = decodeURIComponent(rawAgentId);
  void searchParams;
  redirect(`/agents/${encodeURIComponent(agentId)}/results/contacts`);
}

export async function AgentExecutionPage({ params }: AgentsParamsPageProps<{ agentId: string }>) {
  const { agentId: rawAgentId } = await params;
  const agentId = decodeURIComponent(rawAgentId);
  redirect(`/agents/${encodeURIComponent(agentId)}/configuration`);
}

export async function AgentRunsPage({ params }: AgentsParamsPageProps<{ agentId: string }>) {
  const { agentId: rawAgentId } = await params;
  const agentId = decodeURIComponent(rawAgentId);
  redirect(`/agents/${encodeURIComponent(agentId)}/results`);
}

export async function LegacyTranscriptPage({ params }: AgentsParamsPageProps<{ transcriptId: string }>) {
  const { transcriptId: rawTranscriptId } = await params;
  redirect(`/transcript-generators/transcripts/${encodeURIComponent(decodeURIComponent(rawTranscriptId))}`);
}
