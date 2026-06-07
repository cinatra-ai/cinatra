/**
 * Agent-run A2A resume + WayFlow text-only user envelope contract.
 *
 * The HITL approval may submit `userResponse` as a JSON-stringified
 * envelope `{text: string, attachments?: LlmAttachmentRef[]}` to round-trip
 * artifact refs back into the agent run. The cinatra side passes this
 * payload through to the A2A sendTask as a TEXT-ONLY part — A2A messages
 * stay text-only by design. WayFlow then forwards body verbatim to
 * /api/llm-bridge; if WayFlow sets `body.user_envelope=true`, the bridge
 * opt-in parser extracts the embedded attachments.
 *
 * These tests assert the cinatra-side invariants:
 *   (a) sendTask.parts has a single text part.
 *   (b) the text content equals the userResponse envelope verbatim.
 *   (c) submittedValues parses the {text, attachments} JSON correctly.
 *   (d) the legacy plain-string userResponse path is unchanged.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type SendTaskInput = {
  message?: { parts?: Array<{ kind?: string; text?: string }> };
};
const sendTaskMock = vi.fn(async (_input: SendTaskInput) => ({
  id: "task-resume",
  status: { state: "completed" },
  contextId: "ctx-r1",
}));

vi.mock("server-only", () => ({}));

const dbWrites: Array<{ op: string; table: string; set: unknown }> = [];
const dbMock = vi.hoisted(() => {
  const update = vi.fn((_table: unknown) => ({
    set: vi.fn((payload: unknown) => ({
      where: vi.fn(async () => {
        // captured via dbWrites in beforeEach scope below.
      }),
    })),
  }));
  return { update };
});
vi.mock("../db", () => ({
  db: dbMock,
  agentBuilderPool: { on: () => {}, listenerCount: () => 1 },
}));

vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: vi.fn(),
  BACKGROUND_JOB_NAMES: { AGENT_BUILDER_EXECUTION: "agent-builder-execution" },
}));

type WriteHitlPromptInput = {
  submittedValues?: { text?: string; attachments?: unknown };
};
const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentRunByTaskId: vi.fn(),
  readAgentTemplateById: vi.fn(),
  writeHitlPrompt: vi.fn(async (_input: { submittedValues?: unknown }) => undefined),
}));
vi.mock("../store", () => storeMock);

vi.mock("../wayflow-url", () => ({
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
  WAYFLOW_A2A_TIMEOUT_MS: 60_000,
  createWayflowFetch: () => globalThis.fetch,
}));

vi.mock("@cinatra-ai/a2a", () => ({
  createExternalA2AClient: vi.fn(async () => ({
    sendTask: sendTaskMock,
  })),
}));

// Avoid pulling the full execution graph for downstream state handling.
vi.mock("../execution", () => ({
  handleWayflowTaskState: vi.fn(async () => undefined),
}));

import { approveReviewTaskInternal } from "../review-task-actions";

const REF = {
  artifactId: "art-1",
  // The bridge user_envelope schema strictly requires
  // `representationRevisionId`. The envelope is
  // forwarded verbatim by WayFlow to /api/llm-bridge with
  // user_envelope=true, so this test fixture must mirror the bridge's
  // post-rename strict schema or the resume turn would 400 in prod.
  representationRevisionId: "ver-1",
  digest: "sha256:abc",
  mime: "application/pdf",
  originKind: "upload" as const,
  filename: "report.pdf",
};

function setupRun(): void {
  storeMock.readAgentRunByTaskId.mockResolvedValue({
    id: "run-r1",
    templateId: "tpl-int",
    status: "pending_approval",
    a2aContextId: "ctx-r1",
  });
  storeMock.readAgentTemplateById.mockResolvedValue({
    id: "tpl-int",
    packageName: "@cinatra-ai/email-outreach-agent",
    sourceType: "internal",
  });
}

describe("agent-run resume + WayFlow text-only envelope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbWrites.length = 0;
    setupRun();
  });

  it("legacy plain-string userResponse: sendTask part text equals the string verbatim", async () => {
    await approveReviewTaskInternal("wayflow-task-r1", "actor-1", {
      userResponse: "approve",
    });
    expect(sendTaskMock).toHaveBeenCalledTimes(1);
    const call = sendTaskMock.mock.calls[0]?.[0] as unknown as {
      message?: { parts?: Array<{ kind?: string; text?: string }> };
    };
    expect(call?.message?.parts).toHaveLength(1);
    expect(call?.message?.parts?.[0]?.kind).toBe("text");
    expect(call?.message?.parts?.[0]?.text).toBe("approve");
  });

  it("envelope userResponse: sendTask STAYS text-only; text is the JSON envelope verbatim", async () => {
    const envelope = JSON.stringify({ text: "see attached", attachments: [REF] });
    await approveReviewTaskInternal("wayflow-task-r1", "actor-1", {
      userResponse: envelope,
    });
    expect(sendTaskMock).toHaveBeenCalledTimes(1);
    const call = sendTaskMock.mock.calls[0]?.[0] as unknown as {
      message?: { parts?: Array<{ kind?: string; text?: string }> };
    };
    // A2A invariant — exactly ONE text part, no file parts.
    expect(call?.message?.parts).toHaveLength(1);
    expect(call?.message?.parts?.[0]?.kind).toBe("text");
    expect(call?.message?.parts?.[0]?.text).toBe(envelope);
  });

  it("envelope userResponse: writeHitlPrompt submittedValues round-trips {text, attachments}", async () => {
    const env = { text: "see attached", attachments: [REF] };
    await approveReviewTaskInternal("wayflow-task-r1", "actor-1", {
      userResponse: JSON.stringify(env),
    });
    expect(storeMock.writeHitlPrompt).toHaveBeenCalledTimes(1);
    const arg = storeMock.writeHitlPrompt.mock.calls[0]?.[0] as unknown as {
      submittedValues?: { text?: string; attachments?: typeof env.attachments };
    };
    expect(arg?.submittedValues?.text).toBe("see attached");
    expect(arg?.submittedValues?.attachments).toEqual([REF]);
  });

  it("bare approval (no userResponse, no note): sendTask text is the canonical marker", async () => {
    await approveReviewTaskInternal("wayflow-task-r1", "actor-1", undefined);
    expect(sendTaskMock).toHaveBeenCalledTimes(1);
    const call = sendTaskMock.mock.calls[0]?.[0] as unknown as {
      message?: { parts?: Array<{ kind?: string; text?: string }> };
    };
    expect(call?.message?.parts?.[0]?.text).toBe("[Approved by operator]");
  });
});
