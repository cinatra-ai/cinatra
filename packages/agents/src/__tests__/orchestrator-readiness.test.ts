/**
 * Unit tests for buildSubAgentNodes classifier.
 *
 * Exercises all 7 displayStatus branches without DB or React. Pure logic test.
 *
 * Note: this file lives in `src/__tests__/`. Vitest's default
 * include glob is `tests/**`, so this file is not auto-discovered by a bare
 * `pnpm vitest` run; invoke it explicitly via
 * `pnpm vitest run src/__tests__/orchestrator-readiness.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { buildSubAgentNodes, type SubAgentNodeData } from "../orchestrator-readiness";
import type { AgentRunRecord, AgentTemplateRecord } from "../store";
import type { OrchestratorLedger } from "../orchestrator-execution";

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeTemplate(
  overrides: Partial<AgentTemplateRecord> = {},
): AgentTemplateRecord {
  return {
    id: "tpl_default",
    name: "Default Template",
    type: "leaf",
    status: "published",
    packageName: "@cinatra/agent-default",
    packageVersion: "1.0.0",
    agentDependencies: {},
    inputSchema: {},
    description: null,
    ...overrides,
  } as AgentTemplateRecord;
}

function makeChildRun(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    id: "run_default",
    templateId: "tpl_default",
    status: "running",
    parentRunId: "parent_orch",
    packageVersion: "1.0.0",
    a2aTaskId: null,
    startedAt: null,
    completedAt: null,
    error: null,
    runBy: null,
    stepResults: null,
    ...overrides,
  } as AgentRunRecord;
}

function makeLedgerEntry(
  packageName: string,
  childRunId: string,
  status = "running",
): OrchestratorLedger[number] {
  return {
    childRunId,
    packageName,
    packageVersion: "1.0.0",
    status,
    a2aTaskId: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildSubAgentNodes", () => {
  it("returns empty array when agentDependencies is {}", () => {
    const result = buildSubAgentNodes({
      agentDependencies: {},
      childRuns: [],
      installedTemplatesByPackage: new Map(),
      ledger: [],
    });
    expect(result).toEqual([]);
  });

  it("classifies displayStatus as 'not-installed' when installed map has null", () => {
    const pkg = "@cinatra/agent-missing";
    const map = new Map<string, AgentTemplateRecord | null>();
    map.set(pkg, null);

    const result = buildSubAgentNodes({
      agentDependencies: { [pkg]: "^1.0.0" },
      childRuns: [],
      installedTemplatesByPackage: map,
      ledger: [],
    });

    expect(result).toHaveLength(1);
    expect(result[0].displayStatus).toBe("not-installed");
    expect(result[0].packageName).toBe(pkg);
    expect(result[0].displayName).toBe(pkg);
    expect(result[0].subAgentSlug).toBeNull();
    expect(result[0].childRunId).toBeNull();
    expect(result[0].readinessHint).toContain("not installed");
    expect(result[0].readinessHint).toContain(pkg);
  });

  it("classifies displayStatus as 'not-installed' when package is missing from map", () => {
    const pkg = "@cinatra/agent-absent";
    const result = buildSubAgentNodes({
      agentDependencies: { [pkg]: "^1.0.0" },
      childRuns: [],
      installedTemplatesByPackage: new Map(),
      ledger: [],
    });

    expect(result).toHaveLength(1);
    expect(result[0].displayStatus).toBe("not-installed");
  });

  it("classifies 'setup-not-started' when template exists but status is not 'published'", () => {
    const pkg = "@cinatra/agent-draft";
    const tpl = makeTemplate({
      id: "tpl_draft",
      name: "Draft Agent",
      status: "draft",
      packageName: pkg,
    });
    const map = new Map<string, AgentTemplateRecord | null>();
    map.set(pkg, tpl);

    const result = buildSubAgentNodes({
      agentDependencies: { [pkg]: "^1.0.0" },
      childRuns: [],
      installedTemplatesByPackage: map,
      ledger: [],
    });

    expect(result).toHaveLength(1);
    expect(result[0].displayStatus).toBe("setup-not-started");
    expect(result[0].displayName).toBe("Draft Agent");
    expect(result[0].subAgentSlug).toBe("draft-agent"); // derived via slugifyAgentTemplateName
    expect(result[0].readinessHint).toContain("Draft Agent");
    expect(result[0].readinessHint).toContain("configure");
  });

  it("classifies 'configured-pending-run' when template is published and no matching child run exists", () => {
    const pkg = "@cinatra/agent-ready";
    const tpl = makeTemplate({
      id: "tpl_ready",
      name: "Ready Agent",
      status: "published",
      packageName: pkg,
    });
    const map = new Map<string, AgentTemplateRecord | null>();
    map.set(pkg, tpl);

    const result = buildSubAgentNodes({
      agentDependencies: { [pkg]: "^1.0.0" },
      childRuns: [],
      installedTemplatesByPackage: map,
      ledger: [],
    });

    expect(result).toHaveLength(1);
    expect(result[0].displayStatus).toBe("configured-pending-run");
    expect(result[0].displayName).toBe("Ready Agent");
    expect(result[0].subAgentSlug).toBe("ready-agent");
    expect(result[0].childRunId).toBeNull();
    expect(result[0].readinessHint).toBeNull();
  });

  it("classifies 'running' for child status 'running'", () => {
    const pkg = "@cinatra/agent-active";
    const tpl = makeTemplate({ packageName: pkg, status: "published" });
    const childRun = makeChildRun({ id: "run_1", status: "running" });
    const map = new Map<string, AgentTemplateRecord | null>([[pkg, tpl]]);

    const result = buildSubAgentNodes({
      agentDependencies: { [pkg]: "^1.0.0" },
      childRuns: [childRun],
      installedTemplatesByPackage: map,
      ledger: [makeLedgerEntry(pkg, "run_1", "running")],
    });

    expect(result[0].displayStatus).toBe("running");
    expect(result[0].childRunId).toBe("run_1");
  });

  it("classifies 'running' for child status 'queued'", () => {
    const pkg = "@cinatra/agent-queued";
    const tpl = makeTemplate({ packageName: pkg, status: "published" });
    const childRun = makeChildRun({ id: "run_q", status: "queued" });
    const map = new Map<string, AgentTemplateRecord | null>([[pkg, tpl]]);

    const result = buildSubAgentNodes({
      agentDependencies: { [pkg]: "^1.0.0" },
      childRuns: [childRun],
      installedTemplatesByPackage: map,
      ledger: [makeLedgerEntry(pkg, "run_q", "queued")],
    });

    expect(result[0].displayStatus).toBe("running");
  });

  it("classifies 'running' for child status 'pending_input'", () => {
    const pkg = "@cinatra/agent-pendinginput";
    const tpl = makeTemplate({ packageName: pkg, status: "published" });
    const childRun = makeChildRun({ id: "run_pi", status: "pending_input" });
    const map = new Map<string, AgentTemplateRecord | null>([[pkg, tpl]]);

    const result = buildSubAgentNodes({
      agentDependencies: { [pkg]: "^1.0.0" },
      childRuns: [childRun],
      installedTemplatesByPackage: map,
      ledger: [makeLedgerEntry(pkg, "run_pi", "pending_input")],
    });

    expect(result[0].displayStatus).toBe("running");
  });

  it("classifies 'pending-hitl' for child status 'pending_approval'", () => {
    const pkg = "@cinatra/agent-hitl";
    const tpl = makeTemplate({ packageName: pkg, status: "published" });
    const childRun = makeChildRun({ id: "run_hitl", status: "pending_approval" });
    const map = new Map<string, AgentTemplateRecord | null>([[pkg, tpl]]);

    const result = buildSubAgentNodes({
      agentDependencies: { [pkg]: "^1.0.0" },
      childRuns: [childRun],
      installedTemplatesByPackage: map,
      ledger: [makeLedgerEntry(pkg, "run_hitl", "pending_approval")],
    });

    expect(result[0].displayStatus).toBe("pending-hitl");
  });

  it("classifies 'completed' for child status 'completed'", () => {
    const pkg = "@cinatra/agent-done";
    const tpl = makeTemplate({ packageName: pkg, status: "published" });
    const childRun = makeChildRun({ id: "run_done", status: "completed" });
    const map = new Map<string, AgentTemplateRecord | null>([[pkg, tpl]]);

    const result = buildSubAgentNodes({
      agentDependencies: { [pkg]: "^1.0.0" },
      childRuns: [childRun],
      installedTemplatesByPackage: map,
      ledger: [makeLedgerEntry(pkg, "run_done", "completed")],
    });

    expect(result[0].displayStatus).toBe("completed");
  });

  it("classifies 'failed' for child status 'failed'", () => {
    const pkg = "@cinatra/agent-failed";
    const tpl = makeTemplate({ packageName: pkg, status: "published" });
    const childRun = makeChildRun({ id: "run_failed", status: "failed", error: "boom" });
    const map = new Map<string, AgentTemplateRecord | null>([[pkg, tpl]]);

    const result = buildSubAgentNodes({
      agentDependencies: { [pkg]: "^1.0.0" },
      childRuns: [childRun],
      installedTemplatesByPackage: map,
      ledger: [makeLedgerEntry(pkg, "run_failed", "failed")],
    });

    expect(result[0].displayStatus).toBe("failed");
    expect(result[0].error).toBe("boom");
  });

  it("classifies 'failed' for child status 'stopped'", () => {
    const pkg = "@cinatra/agent-stopped";
    const tpl = makeTemplate({ packageName: pkg, status: "published" });
    const childRun = makeChildRun({ id: "run_stopped", status: "stopped" });
    const map = new Map<string, AgentTemplateRecord | null>([[pkg, tpl]]);

    const result = buildSubAgentNodes({
      agentDependencies: { [pkg]: "^1.0.0" },
      childRuns: [childRun],
      installedTemplatesByPackage: map,
      ledger: [makeLedgerEntry(pkg, "run_stopped", "stopped")],
    });

    expect(result[0].displayStatus).toBe("failed");
  });

  it("propagates childRun.error onto the node when present", () => {
    const pkg = "@cinatra/agent-err";
    const tpl = makeTemplate({ packageName: pkg, status: "published" });
    const childRun = makeChildRun({
      id: "run_err",
      status: "failed",
      error: "Something went wrong",
    });
    const map = new Map<string, AgentTemplateRecord | null>([[pkg, tpl]]);

    const result = buildSubAgentNodes({
      agentDependencies: { [pkg]: "^1.0.0" },
      childRuns: [childRun],
      installedTemplatesByPackage: map,
      ledger: [makeLedgerEntry(pkg, "run_err", "failed")],
    });

    expect(result[0].error).toBe("Something went wrong");
  });

  it("serialises startedAt and completedAt to ISO strings, scheduledAt null", () => {
    const pkg = "@cinatra/agent-times";
    const tpl = makeTemplate({ packageName: pkg, status: "published" });
    const startedAt = new Date("2026-04-14T10:00:00Z");
    const completedAt = new Date("2026-04-14T10:05:00Z");
    const childRun = makeChildRun({
      id: "run_times",
      status: "completed",
      startedAt,
      completedAt,
    });
    const map = new Map<string, AgentTemplateRecord | null>([[pkg, tpl]]);

    const result = buildSubAgentNodes({
      agentDependencies: { [pkg]: "^1.0.0" },
      childRuns: [childRun],
      installedTemplatesByPackage: map,
      ledger: [makeLedgerEntry(pkg, "run_times", "completed")],
    });

    expect(result[0].startedAt).toBe("2026-04-14T10:00:00.000Z");
    expect(result[0].completedAt).toBe("2026-04-14T10:05:00.000Z");
    expect(result[0].scheduledAt).toBeNull();
  });

  it("handles pre-run state with multiple deps and no child runs", () => {
    const pkgA = "@cinatra/agent-a";
    const pkgB = "@cinatra/agent-b";
    const tplA = makeTemplate({
      id: "tpl_a",
      name: "Agent A",
      packageName: pkgA,
      status: "published",
    });
    const tplB = makeTemplate({
      id: "tpl_b",
      name: "Agent B",
      packageName: pkgB,
      status: "published",
    });
    const map = new Map<string, AgentTemplateRecord | null>([
      [pkgA, tplA],
      [pkgB, tplB],
    ]);

    const result = buildSubAgentNodes({
      agentDependencies: { [pkgA]: "^1.0.0", [pkgB]: "^2.0.0" },
      childRuns: [],
      installedTemplatesByPackage: map,
      ledger: [],
    });

    expect(result).toHaveLength(2);
    expect(result.map((n: SubAgentNodeData) => n.displayStatus)).toEqual([
      "configured-pending-run",
      "configured-pending-run",
    ]);
    expect(result.map((n: SubAgentNodeData) => n.packageName)).toEqual([pkgA, pkgB]);
  });
});
