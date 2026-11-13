/**
 * cinatra#4264 slice B1a: where the step snapshots are wired in.
 *
 * T3 order: `handleWayflowTaskState` verifies and stores the leg's snapshot
 * claims for ITS OWN runId BEFORE the task/context resync, so a response that
 * names another run's task or context cannot move this run first.
 * T6 resume roads: `mintResumeRunTokenMetadata`, the ONE function the four
 * resume callers use, carries the node list when the run's stored lifecycle
 * declares `regenerate`, and is the token alone otherwise; each of the four
 * callers hands its result to `message.metadata`.
 *
 * Red at main: the handler stores no snapshot; the carrier returns the token
 * only.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  order: [] as string[],
  persist: vi.fn(),
  readRun: vi.fn(),
  readTemplate: vi.fn(),
}));

vi.mock("@cinatra-ai/agent-ui-protocol/server", () => {
  class MockAdapter {
    onInterrupt = vi.fn();
  }
  return {
    AgUiAdapter: MockAdapter,
    A2UiAdapter: MockAdapter,
    publishAgUiEvent: vi.fn(async () => undefined),
    publishA2UiEvent: vi.fn(async () => undefined),
    A2UI_MID_RUN_TRANSLATOR_KINDS: {},
    enrichSchemaWithResolvedData: vi.fn(async (s: unknown) => s),
    readLatestAgUiInterrupt: async () => null,
    DualAdapterDispatch: class {
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
vi.mock("../store", () => ({
  readAgentRunById: h.readRun,
  readAgentTemplateById: h.readTemplate,
  readAgentTemplates: vi.fn(async () => []),
  readAgentTemplateVersionBySemver: vi.fn(async () => null),
  readAgentTemplateVersionById: vi.fn(async () => null),
  transitionRunStatus: vi.fn(async () => undefined),
  RunTransitionError: class RunTransitionError extends Error {},
  findSavedConnectionForAgentUrl: vi.fn(async () => null),
  setAgentRunTokenHash: vi.fn(async () => undefined),
  updateAgentRunA2ATaskId: vi.fn(async () => {
    h.order.push("resync-task");
  }),
  updateAgentRunA2AContextId: vi.fn(async () => {
    h.order.push("resync-context");
  }),
}));
vi.mock("../step-snapshots", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../step-snapshots")>()),
  persistStepSnapshots: h.persist,
}));
vi.mock("../trigger-gate", () => ({ isTriggerReleased: vi.fn(async () => true) }));
vi.mock("../skill-autosave", () => ({ runSkillAutosaveOnRunCompletion: vi.fn(async () => undefined) }));
vi.mock("../wayflow-url", () => ({
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  AGENT_RUN_TIMEOUT_MAX_SECONDS: 86_400,
}));
vi.mock("@cinatra-ai/a2a", () => ({
  expireRunStream: vi.fn(async () => undefined),
  // The leg stops here: the order up to this point is what the test reads.
  rememberLatestWayflowGateTask: vi.fn(async () => {
    throw new Error("stop after the resync");
  }),
  rememberWayflowGateTask: vi.fn(async () => undefined),
  rememberWayflowGateNodeClaim: vi.fn(async () => undefined),
  getOrAddWayflowRendererGateIndex: vi.fn(async () => 0),
}));

import { formatWayflowInterruptLog, handleWayflowTaskState } from "../execution";
import { mintResumeRunTokenMetadata } from "../wayflow-run-token-carrier";
import { CINATRA_RUN_TOKEN_MESSAGE_KEY } from "@/lib/agent-run-token";
import { CINATRA_SNAPSHOT_NODES_METADATA_KEY, CINATRA_SNAPSHOT_RUN_METADATA_KEY } from "../step-snapshots";

beforeEach(() => {
  h.order.length = 0;
  h.persist.mockReset();
  h.persist.mockImplementation(async (args: { runId: string }) => {
    h.order.push(`persist:${args.runId}`);
    return { stored: [], dropped: 0 };
  });
  h.readRun.mockReset();
  h.readTemplate.mockReset();
});

describe("T3: snapshots are stored for the handler's runId before the resync", () => {
  it("persist runs first, with the handler's own runId, even when the response names another run's task and context", async () => {
    const task = {
      id: "task-of-R2",
      contextId: "ctx-of-R2",
      status: { state: "input-required", message: { parts: [] } },
      metadata: {},
      history: [{ role: "agent", parts: [], metadata: { cinatra_step_snapshots: [] } }],
    };
    await expect(
      handleWayflowTaskState({
        runId: "R1",
        run: { id: "R1", orgId: "org-1", templateId: "tmpl-1", a2aTaskId: "task-of-R1", a2aContextId: "ctx-of-R1" } as never,
        fromStatus: "running",
        task: task as never,
        authority: { orgId: "org-1", can: () => true } as never,
      }),
    ).rejects.toThrow("stop after the resync");
    expect(h.order).toEqual(["persist:R1", "resync-task", "resync-context"]);
    expect(h.persist.mock.calls[0]![0]).toMatchObject({ runId: "R1", orgId: "org-1", history: task.history });
  });
});

describe("T6: every resume carries the node list through mintResumeRunTokenMetadata", () => {
  const LIFECYCLE = JSON.stringify({ regenerate: [{ artifactNode: "file_image", step: "produce", noteInput: "note" }] });

  it("adds the list when the stored lifecycle declares regenerate", async () => {
    h.readRun.mockResolvedValue({ id: "R1", templateId: "tmpl-1", sourceType: "agent_builder" });
    h.readTemplate.mockResolvedValue({ lifecycleConfig: LIFECYCLE });
    const metadata = await mintResumeRunTokenMetadata("R1");
    expect(metadata[CINATRA_SNAPSHOT_NODES_METADATA_KEY]).toEqual(["file_image", "produce"]);
    expect(metadata[CINATRA_SNAPSHOT_RUN_METADATA_KEY]).toBe("R1");
    expect(typeof metadata[CINATRA_RUN_TOKEN_MESSAGE_KEY]).toBe("string");
  });

  it("is the token alone without a declaration, and on a repair run", async () => {
    h.readRun.mockResolvedValue({ id: "R1", templateId: "tmpl-1", sourceType: "agent_builder" });
    h.readTemplate.mockResolvedValue({ lifecycleConfig: JSON.stringify({ review: {} }) });
    expect(Object.keys(await mintResumeRunTokenMetadata("R1"))).toEqual([CINATRA_RUN_TOKEN_MESSAGE_KEY]);
    h.readRun.mockResolvedValue({ id: "R1", templateId: "tmpl-1", sourceType: "lifecycle_repair" });
    h.readTemplate.mockResolvedValue({ lifecycleConfig: LIFECYCLE });
    expect(Object.keys(await mintResumeRunTokenMetadata("R1"))).toEqual([CINATRA_RUN_TOKEN_MESSAGE_KEY]);
  });

  it("each of the four resume callers sends that function's result as the message metadata", () => {
    const root = path.resolve(__dirname, "..");
    for (const file of [
      "review-task-actions.ts",
      "mcp/handlers.ts",
      "orchestrator-actions.ts",
      "artifact-review-resume-delivery.ts",
    ]) {
      const source = readFileSync(path.join(root, file), "utf8");
      expect(source, file).toMatch(/const resumeMetadata = await mintResumeRunTokenMetadata\(/);
      expect(source, file).toMatch(/metadata: resumeMetadata/);
    }
  });

  it("the initial dispatch adds metadata only when the list is not empty", () => {
    const source = readFileSync(path.resolve(__dirname, "../execution.ts"), "utf8");
    expect(source).toMatch(
      /\.\.\.\(Object\.keys\(snapshotMetadata\)\.length > 0 \? \{ metadata: snapshotMetadata \} : \{\}\)/,
    );
  });
});

describe("Review 2 MF3: the input-required leg's log line carries no snapshot claim", () => {
  it("logs history_last without the claims or their inputs", () => {
    const task = {
      id: "task-1",
      metadata: { pendingApproval: { gate: "review" } },
      history: [
        { role: "user", parts: [{ kind: "text", text: "go" }] },
        {
          role: "agent",
          parts: [{ kind: "text", text: "drafted" }],
          metadata: {
            keep: 1,
            cinatra_step_snapshots: [
              { node: "produce", inputs_json: '{"prompt":"PRIVATE-PROMPT-4264"}', sha256: "0".repeat(64), flow_sha256: "f".repeat(64), attestation: "n1:x" },
            ],
          },
        },
      ],
    };
    const line = formatWayflowInterruptLog("R1", task as never, { gate: "review" });
    expect(line).toContain("[wayflow-interrupt] run=R1 task=task-1");
    expect(line).toContain("history_last=");
    expect(line).toContain("drafted");
    expect(line).not.toContain("PRIVATE-PROMPT-4264");
    expect(line).not.toContain("cinatra_step_snapshots");
  });

  it("drops a claims-only carrier message from history_last", () => {
    const task = {
      id: "task-2",
      metadata: {},
      history: [
        { role: "agent", parts: [{ kind: "text", text: "earlier" }] },
        {
          role: "agent",
          messageId: "cinatra-step-snapshots-task-2",
          parts: [],
          metadata: { cinatra_step_snapshots: [{ node: "produce", inputs_json: '{"p":"PRIVATE-CARRIER-4264"}' }] },
        },
      ],
    };
    const line = formatWayflowInterruptLog("R1", task as never, {});
    expect(line).not.toContain("PRIVATE-CARRIER-4264");
    expect(line).toContain("earlier");
  });

  it("the input-required branch logs through that function", () => {
    const source = readFileSync(path.resolve(__dirname, "../execution.ts"), "utf8");
    expect(source).toMatch(/console\.log\(formatWayflowInterruptLog\(runId, task, interruptPayload\)\)/);
    expect(source).not.toMatch(/history_last=\$\{\(JSON\.stringify\(\(task as \{ history\?: unknown\[\] \}\)\.history\?\.slice\(-1\)\)/);
  });
});
