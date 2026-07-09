import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { readInstalledAgentTemplates } from "./store";
import { selectHitlRunVisibleTemplates } from "./hitl-run-filter";
import { buildAgentWorkspacePath } from "@/lib/agent-url";
import { Main } from "@/components/layout/main";
import { Button } from "@/components/ui/button";
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

export type AgentsParamsPageProps<TParams extends Record<string, string>> = {
  params: Promise<TParams>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * "More details" target for an agent card (design#25 §VIII): the agent's
 * marketplace listing detail route, mirroring the §VI installed-extensions
 * card's own detailHref wiring (registry-catalog-screen.tsx `detailHrefFor`).
 * Unscoped / legacy package names have no listing route → null, so the card
 * renders no More-details action for them.
 */
function agentDetailHref(packageName: string): string | null {
  const scopedMatch = /^@([^/]+)\/(.+)$/.exec(packageName);
  return scopedMatch
    ? `/configuration/marketplace/${scopedMatch[1]}/${scopedMatch[2]}`
    : null;
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
        // External A2A agents have no marketplace listing → no More-details.
        packageName: null,
        detailHref: null,
      };
    }
    // detailHref (and thus the §V modal + its loader key packageName) exists
    // ONLY for a scoped listing — agentDetailHref returns null for unscoped /
    // legacy packages, so those render Run only, in lockstep with A2A above.
    const detailHref = t.packageName ? agentDetailHref(t.packageName) : null;
    return {
      key: `local:${t.id}`,
      name: t.name,
      description: t.description ?? "",
      version: t.packageVersion ?? "",
      skills: ioSkills,
      host: "local",
      runHref: t.packageName ? buildAgentWorkspacePath(t.packageName) : "#",
      packageName: detailHref ? (t.packageName ?? null) : null,
      detailHref,
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
