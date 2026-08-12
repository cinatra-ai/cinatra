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
import type { AgentRunAvailability } from "./runtime-install-gate";
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

/**
 * The truthful action for a LISTED agent the picker may still not offer a Run
 * for (cinatra#2605, narrowed by cinatra#2679).
 *
 * Since #2679 an agent the gate can prove is NOT INSTALLED is not listed at all
 * (owner ruling on PR #2658: "Agents that are not installed yet should not show
 * up in /agents at all, neither with an Install button"), so /agents no longer
 * builds an Install CTA — discovery and installation belong to the marketplace
 * (/configuration/marketplace and the per-agent listing under it), which the
 * empty state still points at.
 *
 * That leaves exactly ONE unavailable verdict a listed row can carry: a missing
 * required dependency. The agent itself IS installed; one of its own required
 * packages is not. The primary action then stops promising a run that cannot
 * start and points at what is missing — "View requirements", a DETAILS
 * destination, so the label never promises an install the target page cannot
 * perform (the missing package may be a connector / artifact / skill whose
 * detail route is details-only).
 *
 * Returns `null` for every other verdict (the card renders Run, unchanged).
 */
function buildUnavailableAction(
  name: string,
  availability: AgentRunAvailability,
  detailHref: string | null,
): AgentRunRowModel["unavailable"] {
  if (availability.state !== "missing-required-dependency") return null;
  const marketplaceHref = detailHref ?? "/configuration/marketplace";
  const missing = availability.missing
    .map((m) => m.displayName ?? m.packageName)
    .join(", ");
  return {
    reason: `This agent cannot run: ${missing} ${availability.missing.length === 1 ? "is" : "are"} not installed.`,
    ctaLabel: "View requirements",
    ctaHref: marketplaceHref,
    ctaAriaLabel: `${name} cannot run — ${missing} not installed. View requirements`,
  };
}

export async function NewAgentPage() {
  const allTemplates = await readInstalledAgentTemplates();
  // RUNTIME-LIFECYCLE + PROVISIONING GATE (cinatra#659, cinatra#2605,
  // cinatra#2679): `readInstalledAgentTemplates` filters by the agent-builder
  // `status` (active|published) only — NOT the canonical `installed_extension`
  // source of truth, which is why boot-seeded catalog templates reached this
  // page at all. Resolve each LOCAL (non-external) template's run AVAILABILITY
  // against the live install + required-dependency reality:
  //   • archived        → the row DISAPPEARS (unchanged #659);
  //   • not-installed   → the row DISAPPEARS (#2679 — this page lists only what
  //     is installed; the marketplace, not /agents, is where an agent is found
  //     and installed);
  //   • missing dep     → the row STAYS (the agent IS installed) but offers no
  //     Run — it cannot succeed, so the card carries the truthful CTA built
  //     above;
  //   • runnable        → Run, as before.
  // CG-1: a template with NO canonical row that the catalog does not govern —
  // and a `null` packageName — stays runnable (the bundled/ungoverned floor), so
  // #2679 hides only what the gate can PROVE is uninstalled, never a row it is
  // merely unsure about.
  // External A2A templates are governed by their own connector lifecycle, not an
  // agent install row, so they bypass this gate. Fail-OPEN on a store outage
  // (every input reads runnable) — an outage must not empty the page.
  const { resolveAgentRunAvailabilityMap } = await import("./runtime-install-gate");
  const availability = await resolveAgentRunAvailabilityMap(
    allTemplates
      .filter((t) => t.sourceType !== "external")
      .map((t) => ({ packageName: t.packageName ?? null, packageVersion: t.packageVersion ?? null })),
  );
  const availabilityOf = (t: (typeof allTemplates)[number]) =>
    t.sourceType === "external" || t.packageName == null
      ? ({ state: "runnable" } as const)
      : (availability.get(t.packageName) ?? ({ state: "runnable" } as const));
  const installedVisible = allTemplates.filter((t) => {
    const state = availabilityOf(t).state;
    return state !== "archived" && state !== "not-installed";
  });
  const visibleTemplates = selectHitlRunVisibleTemplates(installedVisible);

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
        // External A2A agents carry no agent install row (their connector's
        // lifecycle governs them) → never gated by the provisioning layer.
        unavailable: null,
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
      unavailable: buildUnavailableAction(t.name, availabilityOf(t), detailHref),
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
