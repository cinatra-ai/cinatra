// @vitest-environment jsdom
/**
 * THE READING A COMPLETED RUNTIME-EXECUTED RUN GETS, END TO END (cinatra#3002,
 * fix leg 2).
 *
 * The two halves of this issue were proved separately and still did not meet.
 * The writer suite proves a receipt row is written; the card suite proves the
 * card names a transcript only when `hasTranscript` is true. Between them sat
 * the defect the SECOND proof round measured on a real run: a gate-free,
 * text-answering run executed on the agent runtime, `completed`, whose answer
 * travelled as its flow's declared EndNode output — no transcript row was
 * written, so the card fell to the step-results reading and the run page never
 * drew the sentence the ratified drawing gives a finished run.
 *
 * This suite joins them on ONE run. It drives the real terminal handler over
 * the graded run's own shape into an in-memory `agent_run_messages`, then reads
 * the card the run page would draw from exactly the rows that write produced:
 *
 *   1. the run's answer becomes its transcript row, and the card draws the
 *      drawing's sentence, quoted:
 *        "This run finished. Its output is in the run transcript below."
 *   2. a run that genuinely produced no text writes no row and keeps the honest
 *      reading — the card never claims a transcript that is not there.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/runtime-run-completion-reading.test.tsx
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/** The rows the receipt writer would have written, as the run page reads them. */
const transcriptRows = vi.hoisted(() => [] as Array<{ runId: string; text: string }>);

const { publishAgUiEventSpy, materializeRunArtifactsSpy, recordRunFinalResponseMessageSpy } =
  vi.hoisted(() => ({
    publishAgUiEventSpy: vi.fn(async () => undefined),
    materializeRunArtifactsSpy: vi.fn(async () => [] as Array<Record<string, unknown>>),
    recordRunFinalResponseMessageSpy: vi.fn(
      async (_input: { runId: string; text: string }) => null,
    ),
  }));

vi.mock("@cinatra-ai/agent-ui-protocol/server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    publishAgUiEvent: publishAgUiEventSpy,
    enrichSchemaWithResolvedData: vi.fn(async (schema: unknown) => ({ ...(schema as object) })),
    DualAdapterDispatch: class MockDualAdapterDispatch {
      onInterrupt = vi.fn();
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

vi.mock("@/lib/artifacts/run-artifact-materializer", () => ({
  materializeRunArtifacts: materializeRunArtifactsSpy,
}));

// The receipt writer stands in for the TABLE here, not for a spy: the whole
// point of this suite is that the card is read from the rows the run's own
// completion actually left behind.
vi.mock("../run-final-response-receipt", () => ({
  recordRunFinalResponseMessage: async (input: { runId: string; text: string }) => {
    void recordRunFinalResponseMessageSpy(input);
    transcriptRows.push(input);
    return null;
  },
}));

const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(async () => null),
  readAgentTemplates: vi.fn(async () => []),
  readAgentTemplateVersionBySemver: vi.fn(async () => null),
  readAgentTemplateVersionById: vi.fn(async () => null),
  transitionRunStatus: vi.fn(async () => undefined),
  RunTransitionError: class RunTransitionError extends Error {
    code: string;
    constructor(args: { code: string }) {
      super(args.code);
      this.code = args.code;
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
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  AGENT_RUN_TIMEOUT_MAX_SECONDS: 86_400,
}));
vi.mock("@cinatra-ai/a2a", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    rememberLatestWayflowGateTask: vi.fn(async () => undefined),
    rememberWayflowGateTask: vi.fn(async () => undefined),
    getOrAddWayflowRendererGateIndex: vi.fn(async () => 0),
  };
});
vi.mock("@/lib/background-jobs", () => ({ enqueueBackgroundJob: vi.fn(async () => undefined) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/cinatra-toast", () => ({
  toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() },
}));
vi.mock("../run-actions", () => ({
  readRunOutputEvidence: vi.fn(async () => ({
    ok: true,
    outputs: [],
    hasTranscript: false,
    hasStepResults: false,
  })),
  createAndTriggerRun: vi.fn(async () => ({ ok: true, runId: "run-next" })),
}));

import { handleWayflowTaskState } from "../execution";
import type { AgentRunRecord } from "../store";

const TEST_AUTHORITY = { orgId: "org-3002", can: () => true };

/** The ratified drawing's own completion sentence for a finished run. */
const DRAWN_SENTENCE = "This run finished. Its output is in the run transcript below.";
/** The honest reading a run with no text of its own keeps. */
const NO_TRANSCRIPT_READING =
  "This run finished. Its output was recorded during the run, but it is not part of this run's transcript.";

/** The one output `Agent Code Reviewer` declares. */
const REVIEW_FINDINGS =
  "Three findings: the package slug does not match packageName, the component " +
  "ids are not stable kebab-case, and the version was not bumped on republish.";

function makeRun(): AgentRunRecord {
  return {
    id: "run-3002",
    templateId: "tmpl-3002",
    versionId: null,
    runBy: "user-a",
    status: "running",
    inputParams: {},
    stepResults: null,
    startedAt: null,
    completedAt: null,
    error: null,
    title: null,
    createdAt: new Date("2026-01-01"),
    sourceType: "agent_builder",
    sourceId: null,
    packageVersion: "1.0.0",
    a2aTaskId: "task-3002",
    a2aContextId: "ctx-3002",
    parentRunId: null,
    agUiEnabled: null,
    lgThreadId: null,
    traceId: null,
    timeoutSeconds: null,
    streamedText: null,
    authPolicy: null,
    orgId: "org-3002",
    projectId: null,
    idempotencyKey: null,
    oboCeiling: null,
    dependentInstallId: null,
  } as unknown as AgentRunRecord;
}

/** The run the second proof round dispatched: gate-free, executed on the agent
 *  runtime, its answer carried by the flow's declared EndNode output. */
function gateFreeRuntimeRun(outputs: Record<string, unknown>) {
  return {
    id: "task-3002",
    contextId: "ctx-3002",
    status: { state: "completed", message: { parts: [] } },
    metadata: {},
    history: [
      { role: "user", parts: [{ kind: "text", text: "Review this agent." }] },
      {
        role: "agent",
        parts: [{ kind: "data", data: { __cinatra_endnode_outputs__: outputs } }],
      },
    ],
  };
}

/** The evidence the run page reads AFTER the run completed — the transcript
 *  half taken from the rows the completion actually wrote, the step-results
 *  half from the one `wayflow_response` entry every runtime run leaves. */
function evidenceAfterCompletion() {
  return {
    outputs: [],
    hasTranscript: transcriptRows.length > 0,
    hasStepResults: true,
  };
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  transcriptRows.length = 0;
  materializeRunArtifactsSpy.mockResolvedValue([]);
});

describe("cinatra#3002 — a completed runtime-executed run's completion reading", () => {
  it("writes the run's answer as its transcript row and draws the drawing's sentence over it", async () => {
    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: "run-3002",
      run: makeRun(),
      fromStatus: "running",
      task: gateFreeRuntimeRun({ findings: REVIEW_FINDINGS }),
    });

    // Exactly one final transcript row, carrying the run's produced text.
    expect(transcriptRows).toHaveLength(1);
    expect(transcriptRows[0].runId).toBe("run-3002");
    expect(transcriptRows[0].text).toBe(REVIEW_FINDINGS);

    const { RunCompletionCard } = await import("../run-completion-affordances");
    render(
      <RunCompletionCard
        runId="run-3002"
        agentId="cinatra-ai/code-reviewer-agent"
        outputHint="transcript"
        initialEvidence={evidenceAfterCompletion()}
      />,
    );

    expect(screen.queryByText(DRAWN_SENTENCE)).not.toBeNull();
    expect(screen.queryByText(NO_TRANSCRIPT_READING)).toBeNull();
    expect(document.querySelector('[data-run-completion="with-output"]')).not.toBeNull();
  });

  it("keeps the honest reading for a completed run that genuinely produced no text", async () => {
    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: "run-3002",
      run: makeRun(),
      fromStatus: "running",
      task: gateFreeRuntimeRun({ ideas: ["one", "two"], count: 2 }),
    });

    expect(transcriptRows).toHaveLength(0);

    const { RunCompletionCard } = await import("../run-completion-affordances");
    render(
      <RunCompletionCard
        runId="run-3002"
        agentId="cinatra-ai/code-reviewer-agent"
        outputHint="transcript"
        initialEvidence={evidenceAfterCompletion()}
      />,
    );

    expect(screen.queryByText(NO_TRANSCRIPT_READING)).not.toBeNull();
    expect(screen.queryByText(DRAWN_SENTENCE)).toBeNull();
  });
});
