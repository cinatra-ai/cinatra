/**
 * Orchestrator readiness classifier (pure logic).
 *
 * Maps an orchestrator's declared `agentDependencies` + live child run rows
 * into a per-sub-agent `SubAgentNodeData[]` view model. Consumed by the
 * server-rendered orchestrator run dashboard.
 *
 * INVARIANT: This module is pure logic — no React, no JSX, no "use client",
 * no `import "server-only"`. Safe to import from both client and server code.
 * Client-side and server-rendered views depend on this classification staying
 * React-free so tests run without RTL / jsdom.
 *
 * Authoritative source of child status: the child `agent_runs` rows
 * (`childRuns`), NOT the ledger cache on the orchestrator's stepResults.
 * The ledger is used only to find the childRunId for a given packageName
 * (dispatch-time mapping); the current status is read from the child row,
 * which can have advanced past what the ledger cache last captured.
 *
 * Scheduled-window (`scheduledAt`) is not persisted by the execution model.
 * The field is declared on `SubAgentNodeData` now as `Date | null | undefined`
 * so scheduler support can populate it without a type migration; current
 * renderers ignore it.
 */

import type { AgentRunRecord, AgentTemplateRecord } from "./store";

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
import type { OrchestratorLedger } from "./orchestrator-execution";

// ---------------------------------------------------------------------------
// Types consumed by client ancillary components and the server-rendered dashboard.
// ---------------------------------------------------------------------------

export type SubAgentDisplayStatus =
  | "not-installed"
  | "setup-not-started"
  | "configured-pending-run"
  | "running"
  | "pending-hitl"
  | "completed"
  | "failed";

export type SubAgentNodeData = {
  packageName: string;
  displayName: string;
  subAgentSlug: string | null;
  childRunId: string | null;
  displayStatus: SubAgentDisplayStatus;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /**
   * Deferred — populated once scheduler windows are persisted. Current
   * renderers ignore this field; it exists so scheduler support can add a
   * Gantt column without a type migration on downstream consumers.
   */
  scheduledAt?: Date | null;
  readinessHint: string | null;
};

// ---------------------------------------------------------------------------
// buildSubAgentNodes — single object-arg signature used by dashboard callers.
// ---------------------------------------------------------------------------

export function buildSubAgentNodes(input: {
  agentDependencies: Record<string, string>;
  childRuns: Array<AgentRunRecord>;
  installedTemplatesByPackage: Map<string, AgentTemplateRecord | null>;
  ledger: OrchestratorLedger;
}): SubAgentNodeData[] {
  const { agentDependencies, childRuns, installedTemplatesByPackage, ledger } = input;

  const packageNames = Object.keys(agentDependencies);
  const nodes: SubAgentNodeData[] = [];

  for (const packageName of packageNames) {
    const template = installedTemplatesByPackage.get(packageName) ?? null;
    const ledgerEntry = ledger.find((e) => e.packageName === packageName) ?? null;
    const childRun = ledgerEntry
      ? childRuns.find((c) => c.id === ledgerEntry.childRunId) ?? null
      : null;

    let displayStatus: SubAgentDisplayStatus;
    let readinessHint: string | null;

    if (template == null) {
      displayStatus = "not-installed";
      readinessHint = `${packageName} is not installed — install it first`;
    } else if (template.status !== "published") {
      displayStatus = "setup-not-started";
      readinessHint = `${template.name} is scheduled but not yet configured — configure it now`;
    } else if (childRun == null) {
      displayStatus = "configured-pending-run";
      readinessHint = null;
    } else if (childRun.status === "pending_approval") {
      displayStatus = "pending-hitl";
      readinessHint = null;
    } else if (
      childRun.status === "running" ||
      childRun.status === "queued" ||
      childRun.status === "pending_input"
    ) {
      displayStatus = "running";
      readinessHint = null;
    } else if (childRun.status === "completed") {
      displayStatus = "completed";
      readinessHint = null;
    } else if (childRun.status === "failed" || childRun.status === "stopped") {
      displayStatus = "failed";
      readinessHint = null;
    } else {
      // Default fallback — an unknown child status is treated as
      // "configured-pending-run" so the UI surfaces the dispatch without
      // pretending the run is terminal.
      // Warn so newly added statuses are not silently swallowed.
      console.warn(
        `[orchestrator-readiness] Unknown child run status: ${childRun?.status} for package ${packageName}`,
      );
      displayStatus = "configured-pending-run";
      readinessHint = null;
    }

    nodes.push({
      packageName,
      displayName: template?.name ?? packageName,
      subAgentSlug: template?.name ? slugify(template.name) : null,
      childRunId: childRun?.id ?? null,
      displayStatus,
      error: childRun?.error ?? null,
      startedAt: childRun?.startedAt ? childRun.startedAt.toISOString() : null,
      completedAt: childRun?.completedAt ? childRun.completedAt.toISOString() : null,
      scheduledAt: null,
      readinessHint,
    });
  }

  return nodes;
}
