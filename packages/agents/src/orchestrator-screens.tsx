/**
 * Orchestrator RSC screens (sole owner of OrchestratorRunScreen).
 *
 * Layout shell: Main (from @/components/layout/main) wrapping AgentPageLayout
 * — exactly what RunScreen / ResultsScreen in instance-screens.tsx use.
 * Verified from packages/agent-builder/src/agent-page-layout.tsx:
 *   AgentPageLayout({ agentId, instanceId, activeTab, templateName, description?,
 *                     actions?, initialRunName, runId, children })
 *
 * CRITICAL: Direct relative imports are used throughout this file — NOT from
 * "./index" — to avoid a circular ESM dependency. orchestrator-screens.tsx is
 * re-exported from index.ts in Task 4 of this plan; importing ./index here
 * would create a cycle that breaks the Turbopack module graph.
 *
 * Security: actorUserId / run.runBy check is repeated inside each
 * RSC (belt-and-suspenders). The dispatching screen (instance-screens.tsx)
 * does its own check; these screens re-verify so a future caller bypassing
 * instance-screens can't leak data.
 *
 * Security: OrchestratorLedgerSchema.safeParse → empty ledger on
 * malformed stepResults. The UI renders the empty-children state instead of
 * trusting raw JSON.
 *
 * Security: keys prefixed with "__cinatra_" are stripped from the
 * inputParams summary before display.
 */
import "server-only";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Main } from "@/components/layout/main";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getAuthSession, isPlatformAdmin } from "@/lib/auth-session";

// Direct relative imports — not ./index (avoids circular dependency)
import {
  readAgentRunById,
  readAgentRunsByParent,
  readAgentTemplateBySlug,
  readAgentTemplates,
  readRunCoOwners,
} from "./store";
import type { AgentTemplateRecord } from "./store";
import { OrchestratorLedgerSchema } from "./orchestrator-execution";
import { buildSubAgentNodes } from "./orchestrator-readiness";
import type { SubAgentNodeData } from "./orchestrator-readiness";
import { OrchestratorRunPanel } from "./orchestrator-run-panel";
import { AgentPageLayout } from "./agent-page-layout";

function buildExtensionHeaderLink(packageName: string | null | undefined) {
  if (!packageName) return null;
  const match = /^@([^/]+)\/(.+)$/.exec(packageName);
  if (!match) return null;
  return {
    extensionIdentifier: packageName,
    extensionHref: `/configuration/marketplace/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`,
  };
}

// ---------------------------------------------------------------------------
// OrchestratorHITLPanel — condensed summary of run.inputParams + edit link.
// Keys prefixed with "__cinatra_" are internal and must be stripped.
// ---------------------------------------------------------------------------

function OrchestratorHITLPanel(props: {
  agentId: string;
  instanceId: string;
  inputParams: unknown;
}) {
  const { agentId, instanceId, inputParams } = props;

  // Coerce inputParams to a Record, then strip internal keys
  const params: Record<string, unknown> =
    inputParams !== null &&
    typeof inputParams === "object" &&
    !Array.isArray(inputParams)
      ? (inputParams as Record<string, unknown>)
      : {};

  const displayEntries = Object.entries(params).filter(
    ([key]) => !key.startsWith("__cinatra_"),
  );

  if (displayEntries.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold text-foreground">
          Run inputs
        </CardTitle>
        <CardAction>
          <Button asChild variant="outline" size="sm">
            <Link href={`/agents/${agentId}/${encodeURIComponent(instanceId)}`}>
              Edit inputs
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {displayEntries.map(([key, value]) => (
            <div key={key} className="flex flex-col gap-0.5">
              <dt className="text-xs text-muted-foreground">{key}</dt>
              <dd className="text-sm text-foreground truncate">
                {value === null || value === undefined
                  ? "—"
                  : typeof value === "object"
                  ? JSON.stringify(value)
                  : String(value)}
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// readiness alerts — uses shadcn Alert with no raw palette colors.
// The alert.tsx in this repo only exposes "default" and "destructive" variants.
// "default" (bg-card + text-card-foreground with border) is on-brand for hints.
// ---------------------------------------------------------------------------

function ReadinessAlertsSection({ nodes }: { nodes: SubAgentNodeData[] }) {
  const hintNodes = nodes.filter((n) => n.readinessHint !== null);
  if (hintNodes.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {hintNodes.map((node) => (
        <Alert key={node.packageName} variant="default">
          <AlertDescription>{node.readinessHint}</AlertDescription>
        </Alert>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared data-fetch helper — avoids repeating the same pattern twice.
// ---------------------------------------------------------------------------

async function loadOrchestratorScreenData(agentId: string, instanceId: string) {
  const session = await getAuthSession();
  const actorUserId = session?.user?.id ?? null;

  const template = await readAgentTemplateBySlug(agentId, {
    actorUserId,
    includeNonPublished: true,
  });
  if (!template || template.type !== "orchestrator") notFound();

  const run = await readAgentRunById(instanceId);
  if (!run) notFound();
  const isAdmin = isPlatformAdmin(session);
  if (!isAdmin) {
    const isOwner = run.runBy && run.runBy === actorUserId;
    let isCoOwner = false;
    if (!isOwner && actorUserId) {
      const coOwnerRows = await readRunCoOwners(run.id);
      isCoOwner = coOwnerRows.some((c) => c.userId === actorUserId);
    }
    if (!isOwner && !isCoOwner) notFound();
  }

  // Authoritative child rows (never trust ledger for status)
  const children = await readAgentRunsByParent(run.id);

  // Trust boundary — ledger may be malformed; safeParse + empty-on-failure
  const ledgerParse = OrchestratorLedgerSchema.safeParse(run.stepResults);
  const ledger = ledgerParse.success ? ledgerParse.data : [];

  const deps = (template.agentDependencies ?? {}) as Record<string, string>;

  // Installed-template lookup per unique package name.
  // readAgentTemplates returns { items, total, hasMore } — MUST unwrap .items.
  // actorUserId is NOT a valid ReadAgentTemplatesOptions field — omit it.
  const uniquePackages = Array.from(
    new Set([
      ...Object.keys(deps),
      ...ledger.map((e) => e.packageName),
    ]),
  );
  // WR-01: parallelize with Promise.all instead of serial for...of loop.
  // WR-02: omit status filter so draft/non-published templates are passed
  //         through to buildSubAgentNodes, which handles classification itself.
  const installedTemplatesByPackage = new Map<string, AgentTemplateRecord | null>(
    await Promise.all(
      uniquePackages.map(async (pkg) => {
        const matches = await readAgentTemplates({
          packageName: pkg,
          limit: 1,
        });
        return [pkg, matches.items[0] ?? null] as const;
      }),
    ),
  );

  // MUST use the single object-arg signature shipped by 69-01
  const nodes: SubAgentNodeData[] = buildSubAgentNodes({
    agentDependencies: deps,
    childRuns: children,
    installedTemplatesByPackage,
    ledger,
  });

  // Run name lives canonically on agent_runs.title
  const runName = run.title ?? "";

  return { template, run, nodes, runName };
}

// ---------------------------------------------------------------------------
// OrchestratorRunScreen — sole owner of this symbol in @cinatra/agent-builder.
// 69-01 ships pure logic only; this plan is the single declaration point.
// ---------------------------------------------------------------------------

export async function OrchestratorRunScreen({
  agentId,
  instanceId,
}: {
  agentId: string;
  instanceId: string;
}) {
  const { template, run, nodes, runName } = await loadOrchestratorScreenData(
    agentId,
    instanceId,
  );
  const extensionHeaderLink = buildExtensionHeaderLink(template.packageName);

  return (
    <Main className="min-h-screen">
      <AgentPageLayout
        agentId={agentId}
        instanceId={instanceId}
        activeTab="run"
        templateName={template.name}
        initialRunName={runName}
        runId={run.id}
        extensionIdentifier={extensionHeaderLink?.extensionIdentifier}
        extensionHref={extensionHeaderLink?.extensionHref}
      >
        <OrchestratorHITLPanel
          agentId={agentId}
          instanceId={instanceId}
          inputParams={run.inputParams}
        />
        <ReadinessAlertsSection nodes={nodes} />
        <OrchestratorRunPanel
          orchestratorRunId={run.id}
          orchestratorStatus={run.status}
          nodes={nodes}
          agentId={agentId}
          instanceId={instanceId}
        />
      </AgentPageLayout>
    </Main>
  );
}
