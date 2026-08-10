import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { readInstalledAgentTemplates } from "./store";
import { selectHitlRunVisibleTemplates, templateHasOwnHitl } from "./hitl-run-filter";
import { isSurfaceableDraftTemplate } from "./draft-visibility";
import { getAuthSession, isPlatformAdmin } from "@/lib/auth-session";
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
 * The truthful action for an agent the picker may NOT offer a Run for
 * (cinatra#2605). The picker keeps the card — hiding it would delete the only
 * discovery path for the ~24 bundled opt-in agents — but the primary action
 * stops promising a run that cannot start, and points at what is actually
 * missing:
 *
 *   • not-installed → "Install", targeting the agent's OWN marketplace listing,
 *     the one detail route that carries install controls for an agent;
 *   • missing required dependency → "View requirements", targeting the same
 *     listing (a DETAILS destination, so the label never promises an install
 *     the target page cannot perform — the missing package may be a connector /
 *     artifact / skill whose detail route is details-only).
 *
 * Returns `null` for a runnable agent (the card renders Run, unchanged).
 */
function buildUnavailableAction(
  name: string,
  availability: AgentRunAvailability,
  detailHref: string | null,
): AgentRunRowModel["unavailable"] {
  if (availability.state === "runnable" || availability.state === "archived") return null;
  const marketplaceHref = detailHref ?? "/configuration/marketplace";
  if (availability.state === "not-installed") {
    return {
      reason: "This agent is not installed yet.",
      ctaLabel: detailHref ? "Install" : "Browse marketplace",
      ctaHref: marketplaceHref,
      ctaAriaLabel: `Install ${name}`,
    };
  }
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
  // DRAFT VISIBILITY (cinatra#2653): an imported agent template lands with
  // status='draft' (import-agent-core default) and the store's default
  // statuses hide drafts — so a fresh upload was invisible here with no UI to
  // find or publish it. Surface drafts to PLATFORM ADMINS (the same floor as
  // the upload path that creates them — requireAdminSession); everyone else
  // sees the picker exactly as before.
  const session = await getAuthSession();
  const draftsVisible = isPlatformAdmin(session);
  const allTemplates = await readInstalledAgentTemplates({
    statuses: draftsVisible
      ? ["active", "published", "draft"]
      : ["active", "published"],
  });
  // RUNTIME-LIFECYCLE + PROVISIONING GATE (cinatra#659, cinatra#2605):
  // `readInstalledAgentTemplates` filters by the agent-builder `status`
  // (active|published) only — NOT the canonical `installed_extension` source of
  // truth. Resolve each LOCAL (non-external) template's run AVAILABILITY against
  // the live install + required-dependency reality:
  //   • archived                     → the row DISAPPEARS (unchanged #659);
  //   • not-installed / missing dep  → the row STAYS but offers no Run — it
  //     cannot succeed, so the card carries the truthful CTA built below;
  //   • runnable                     → Run, as before.
  // CG-1: a template with NO canonical row that the catalog does not govern —
  // and a `null` packageName — stays runnable (the bundled/ungoverned floor).
  // External A2A templates are governed by their own connector lifecycle, not an
  // agent install row, so they bypass this gate. Fail-OPEN on a store outage
  // (every input reads runnable).
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
  const lifecycleVisible = allTemplates.filter((t) => availabilityOf(t).state !== "archived");
  // cinatra#2653 — drafts BYPASS the HITL run filter: that filter decides
  // which agents may offer a RUN, while a surfaceable draft is listed to be
  // FOUND and PUBLISHED (its card offers Publish, never Run). Routing drafts
  // through the filter would hide every HITL-less import — recreating the
  // exact invisibility this issue is about. `isSurfaceableDraftTemplate`
  // excludes assistant-kind drafts (the seeded builtin assistants are
  // permanent drafts by design) and external rows.
  const surfaceableDrafts = draftsVisible
    ? lifecycleVisible.filter(isSurfaceableDraftTemplate)
    : [];
  const runCandidates = lifecycleVisible.filter((t) => t.status !== "draft");
  const visibleTemplates = [
    ...selectHitlRunVisibleTemplates(runCandidates),
    ...surfaceableDrafts,
  ];

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
    // cinatra#2653 — a DRAFT row publishes instead of running: no Run href,
    // no marketplace listing (a draft is not published anywhere), no
    // availability CTA (the runtime gate governs runs; this card offers none).
    if (t.status === "draft") {
      return {
        key: `local:${t.id}`,
        name: t.name,
        description: t.description ?? "",
        version: t.packageVersion ?? "",
        skills: ioSkills,
        host: "local",
        runHref: "#",
        packageName: null,
        detailHref: null,
        unavailable: null,
        draft: {
          templateId: t.id,
          // Honest post-publish feedback (the #1007 picker lists only
          // HITL-gated agents + their descendants): a HITL-less agent
          // LEAVES this list once published — it serves as a sub-agent /
          // A2A surface instead. The card words its success toast from this.
          staysListedAfterPublish: templateHasOwnHitl(t),
        },
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
