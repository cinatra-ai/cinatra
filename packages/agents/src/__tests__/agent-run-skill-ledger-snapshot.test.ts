/**
 * Regression test for the per-run skill-usage ledger (agent_run_skills_used).
 *
 * Root cause of #848: the writer `snapshotSkillsAtRunStart` had ZERO
 * production call sites, so the ledger never populated and the run's Skills
 * tab was always empty. The fix wires the writer into the agent-execution
 * worker (`runAgentBuilderExecutionJob`) — the single per-run seam every run
 * type flows through.
 *
 * This test drives the worker through the setup-interrupt early-exit path
 * (same scaffold as execution-enrichment.test.ts) and asserts a run resolves
 * its assigned skills and snapshots them into the ledger with
 * skillKind="installed". A source-text foundation test cannot catch the
 * unwired-writer regression; a call-path test can.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Skill-ledger seam under test: getAssignedSkillIdsForAgent (resolution) +
// snapshotSkillsAtRunStart (the writer). Captured via vi.hoisted so the
// factories can reference them.
// ---------------------------------------------------------------------------
const skillLedgerMock = vi.hoisted(() => ({
  getAssignedSkillIdsForAgent: vi.fn(async () => [] as string[]),
  snapshotSkillsAtRunStart: vi.fn(),
}));
vi.mock("@/lib/agents-store", () => ({
  getAssignedSkillIdsForAgent: skillLedgerMock.getAssignedSkillIdsForAgent,
}));
vi.mock("@/lib/agent-run-skills-used", () => ({
  snapshotSkillsAtRunStart: skillLedgerMock.snapshotSkillsAtRunStart,
}));

// ---------------------------------------------------------------------------
// Adapter / enricher mocks — keep real classes, replace the enricher + the
// dispatcher so the setup-interrupt path runs without real UI transport.
// ---------------------------------------------------------------------------
const { enrichSpy, onInterruptSpy } = vi.hoisted(() => ({
  enrichSpy: vi.fn(async (schema: unknown) => ({ ...(schema as object), __enriched: true })),
  onInterruptSpy: vi.fn(),
}));
vi.mock("@cinatra-ai/agent-ui-protocol/server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    enrichSchemaWithResolvedData: enrichSpy,
    DualAdapterDispatch: class MockDualAdapterDispatch {
      onInterrupt = onInterruptSpy;
      onText = vi.fn();
      onTextChunk = vi.fn();
      onToolCall = vi.fn();
      onState = vi.fn();
      onError = vi.fn();
      onFinish = vi.fn();
      onResume = vi.fn();
    },
  };
});

const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(),
  readAgentTemplates: vi.fn(async () => []),
  readAgentTemplateVersionBySemver: vi.fn(async () => null),
  transitionRunStatus: vi.fn(async () => undefined),
  RunTransitionError: class RunTransitionError extends Error {
    code: string;
    constructor(code: string, msg: string) {
      super(msg);
      this.code = code;
    }
  },
  findSavedConnectionForAgentUrl: vi.fn(async () => null),
  updateAgentRunA2ATaskId: vi.fn(async () => undefined),
  updateAgentRunA2AContextId: vi.fn(async () => undefined),
}));
vi.mock("../store", () => storeMock);

vi.mock("../trigger-gate", () => ({ isTriggerReleased: vi.fn(async () => true) }));
vi.mock("../skill-autosave", () => ({
  runSkillAutosaveOnRunCompletion: vi.fn(async () => undefined),
}));
vi.mock("../wayflow-url", () => ({
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  AGENT_RUN_TIMEOUT_MAX_SECONDS: 86_400,
}));

import { runAgentBuilderExecutionJob } from "../execution";
import type { AgentRunRecord } from "../store";

function makeRun(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    id: "run-ledger-1",
    templateId: "tmpl-1",
    versionId: null,
    runBy: "user-a",
    status: "queued",
    inputParams: {},
    stepResults: null,
    startedAt: null,
    completedAt: null,
    error: null,
    title: null,
    createdAt: new Date("2026-01-01"),
    sourceType: "agent_builder",
    sourceId: null,
    packageVersion: null,
    a2aTaskId: null,
    a2aContextId: null,
    parentRunId: null,
    agUiEnabled: null,
    lgThreadId: null,
    traceId: null,
    timeoutSeconds: null,
    streamedText: null,
    authPolicy: null,
    orgId: "org-test",
    projectId: null,
    idempotencyKey: null,
    workflowId: null,
    workflowTaskId: null,
    oboCeiling: null,
    ...overrides,
  };
}

function makeTemplate(packageName: string | null, inputSchema: Record<string, unknown>) {
  return {
    id: "tmpl-1",
    orgId: null,
    creatorId: null,
    name: "Test Agent",
    description: "",
    sourceNl: "",
    compiledPlan: [],
    inputSchema,
    outputSchema: null,
    taskSpec: null,
    status: "published",
    packageName,
    packageVersion: null,
    gatedSteps: [],
    triggerMode: "none",
    approvalPolicy: null,
    agentDependencies: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };
}

describe("agent-run skill-usage ledger snapshot (#848)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    skillLedgerMock.getAssignedSkillIdsForAgent.mockResolvedValue([]);
    storeMock.transitionRunStatus.mockResolvedValue(undefined);
  });

  it("snapshots the run's resolved skill set at run start (writer is wired)", async () => {
    const run = makeRun();
    storeMock.readAgentRunById.mockResolvedValue(run);
    // Pending required field → the setup-interrupt loop pauses the run and
    // returns, giving a clean early exit AFTER the snapshot seam has run.
    storeMock.readAgentTemplateById.mockResolvedValue(
      makeTemplate("@cinatra-ai/blog-pipeline", {
        properties: { website: { type: "string", title: "Website" } },
        required: ["website"],
      }),
    );
    skillLedgerMock.getAssignedSkillIdsForAgent.mockResolvedValue([
      "@cinatra-ai/reviewer:agent-review-content",
      "@cinatra-ai/blog:blog-writing",
    ]);

    await runAgentBuilderExecutionJob({ runId: run.id }, "job-1");

    // Resolution uses the template's packageName (matches the sessionless
    // llm-bridge resolution — no actor argument).
    expect(skillLedgerMock.getAssignedSkillIdsForAgent).toHaveBeenCalledTimes(1);
    expect(skillLedgerMock.getAssignedSkillIdsForAgent).toHaveBeenCalledWith(
      "@cinatra-ai/blog-pipeline",
    );

    // The writer is invoked with the run id + the resolved skills, kind=installed.
    expect(skillLedgerMock.snapshotSkillsAtRunStart).toHaveBeenCalledTimes(1);
    expect(skillLedgerMock.snapshotSkillsAtRunStart).toHaveBeenCalledWith({
      runId: "run-ledger-1",
      skills: [
        { skillId: "@cinatra-ai/reviewer:agent-review-content", skillKind: "installed" },
        { skillId: "@cinatra-ai/blog:blog-writing", skillKind: "installed" },
      ],
    });
  });

  it("skips the snapshot for templates without a packageName (legacy / DB-only)", async () => {
    const run = makeRun({ id: "run-ledger-2" });
    storeMock.readAgentRunById.mockResolvedValue(run);
    storeMock.readAgentTemplateById.mockResolvedValue(
      makeTemplate(null, {
        properties: { website: { type: "string", title: "Website" } },
        required: ["website"],
      }),
    );

    await runAgentBuilderExecutionJob({ runId: run.id }, "job-2");

    expect(skillLedgerMock.getAssignedSkillIdsForAgent).not.toHaveBeenCalled();
    expect(skillLedgerMock.snapshotSkillsAtRunStart).not.toHaveBeenCalled();
  });
});
