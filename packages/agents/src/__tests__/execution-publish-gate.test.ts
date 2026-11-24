import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// cinatra#4150 (A4 without the moment, A10): the input-required branch classifies a
// publish gate FIRST. A verified `cinatra_publish_gate__<node>` claim parks the run on
// its decision record (written first and awaited) and offers no renderer and no generic
// review task. A record fault, or a missing or unverified claim on a template that lists
// publishing steps, ends the run failed. A template that lists none keeps today's road.
// A template that is not found or cannot be read fails only a pause that claims a publish
// gate; any other pause keeps today's road, where the interrupt is offered. These tests
// drive the real handleWayflowTaskState and the real claim verifier.

const { onInterruptSpy } = vi.hoisted(() => ({ onInterruptSpy: vi.fn() }));

vi.mock("@cinatra-ai/agent-ui-protocol/server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    enrichSchemaWithResolvedData: vi.fn(async (schema: unknown) => ({ ...(schema as object) })),
    readLatestAgUiInterrupt: async () => {
      const last = onInterruptSpy.mock.calls.at(-1) as
        | [Record<string, unknown>, string, Record<string, unknown>, string, string?]
        | undefined;
      if (!last) return null;
      const [schema, xRenderer, values, reviewTaskId, fieldName] = last;
      return { schema, xRenderer, values, reviewTaskId, fieldName };
    },
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
  readAgentTemplateVersionById: vi.fn(async () => null),
  readRunCoOwners: vi.fn(async () => []),
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
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  AGENT_RUN_TIMEOUT_MAX_SECONDS: 86_400,
}));

const gateStore = vi.hoisted(() => ({
  rememberLatestWayflowGateTask: vi.fn(async () => undefined),
  rememberWayflowGateNodeClaim: vi.fn(async () => undefined),
  rememberWayflowGateTask: vi.fn(async () => undefined),
}));
vi.mock("@cinatra-ai/a2a", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, ...gateStore };
});

const decisions = vi.hoisted(() => ({
  insertParkedDecision: vi.fn(),
  // The rows of the plan the run's current attempt was dispatched with (agent_runs.dispatch_publish_rows), for a node.
  readDispatchedPublishRows: vi.fn(async (_runId: string, _nodeId: string) => null as unknown),
  decide: vi.fn(),
  readLatestDecisionForRun: vi.fn(async () => null),
  readOpenDecisionForRun: vi.fn(async () => null),
  listDueParked: vi.fn(async () => []),
  listSettledWithWaitingRun: vi.fn(async () => []),
}));
vi.mock("../publish-decision-store", () => decisions);

import { handleWayflowTaskState } from "../execution";
import type { AgentRunRecord } from "../store";

const KEY = "test-context-attest-key-4150";
const CONTEXT = "ctx-gate-1";
const TASK = "task-gate-1";
const GATE = "cinatra_publish_gate__publish";
const AUTHORITY = { orgId: "org-test", can: () => true };
const SURFACED = { what: "the post", where: "the blog" };

function sign(node: string, key = KEY) {
  return { node, attestation: `g1:${createHmac("sha256", key).update(`g1\n${CONTEXT}\n${TASK}\n${node}`).digest("hex")}` };
}

function makeRun(): AgentRunRecord {
  return {
    id: "run-pub-1",
    templateId: "tmpl-1",
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
    packageVersion: null,
    a2aTaskId: null,
    a2aContextId: null,
    parentRunId: null,
    agUiEnabled: null,
    lgThreadId: null,
    traceId: null,
    timeoutSeconds: null,
    streamedText: null,
    producedReviewPark: null,
    authPolicy: null,
    orgId: "org-test",
    projectId: null,
    idempotencyKey: null,
    oboCeiling: null,
    dependentInstallId: null,
    humanPresent: null,
    lifecycleMoment: null,
    lifecycleCardKind: null,
    lifecycleCardRef: null,
    executionAttemptId: null,
  };
}

function makeTemplate(publishingSteps: string[] | null) {
  return {
    id: "tmpl-1",
    orgId: null,
    creatorId: null,
    name: "Publishing Agent",
    description: "",
    sourceNl: "",
    compiledPlan: [],
    inputSchema: { properties: {}, required: [] },
    outputSchema: null,
    taskSpec: null,
    status: "published",
    packageName: null,
    packageVersion: null,
    gatedSteps: [],
    publishingSteps,
    publishRows: { publish: [{ label: "Title", input: "title" }] } as Record<string, Array<{ label: string; input: string }>> | null,
    triggerMode: "none",
    approvalPolicy: { steps: [] },
    agentDependencies: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };
}

function pausedTask(claim?: unknown) {
  return {
    id: TASK,
    contextId: CONTEXT,
    status: { state: "input-required", message: { parts: [] } },
    metadata: {},
    history: [
      {
        role: "agent",
        parts: [{ kind: "text", text: JSON.stringify(SURFACED) }],
        ...(claim === undefined ? {} : { metadata: { cinatra_gate_node: claim } }),
      },
    ],
  };
}

function parkedRow(status = "parked") {
  return { id: "dec-1", runId: "run-pub-1", nodeId: "publish", status };
}

async function pause(claim?: unknown, fromStatus: "running" | "pending_approval" = "running") {
  const run = makeRun();
  await handleWayflowTaskState({ authority: AUTHORITY, runId: run.id, run, fromStatus, task: pausedTask(claim) });
}

const transitions = () =>
  (storeMock.transitionRunStatus.mock.calls as unknown as Array<[string, string, string, { error?: string } | undefined]>).map(
    ([, from, to, patch]) => ({ from, to, error: patch?.error }),
  );

const previousKey = process.env.CINATRA_CONTEXT_ATTEST_KEY;
beforeAll(() => {
  process.env.CINATRA_CONTEXT_ATTEST_KEY = KEY;
});
afterAll(() => {
  if (previousKey === undefined) delete process.env.CINATRA_CONTEXT_ATTEST_KEY;
  else process.env.CINATRA_CONTEXT_ATTEST_KEY = previousKey;
  vi.doUnmock("@cinatra-ai/agent-ui-protocol/server");
  vi.doUnmock("../store");
  vi.doUnmock("../trigger-gate");
  vi.doUnmock("../skill-autosave");
  vi.doUnmock("../wayflow-url");
  vi.doUnmock("@cinatra-ai/a2a");
  vi.doUnmock("../publish-decision-store");
  vi.resetModules();
});

beforeEach(() => {
  vi.clearAllMocks();
  storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(["publish"]));
  storeMock.transitionRunStatus.mockResolvedValue(undefined);
  decisions.insertParkedDecision.mockResolvedValue({ inserted: true, current: true, decision: parkedRow() });
  decisions.readDispatchedPublishRows.mockReset();
  decisions.readDispatchedPublishRows.mockResolvedValue([{ label: "Title", input: "title" }]);
  decisions.decide.mockResolvedValue({ outcome: "won", decision: parkedRow("run_ended") });
});

describe("a run that reaches a publish gate (A4 without the moment)", () => {
  it("writes ONE parked decision first, then waits in pending_approval, with no review offered", async () => {
    await pause(sign(GATE));
    expect(decisions.insertParkedDecision).toHaveBeenCalledTimes(1);
    expect(decisions.insertParkedDecision).toHaveBeenCalledWith({
      orgId: "org-test",
      runId: "run-pub-1",
      nodeId: "publish",
      gateTaskId: TASK,
      a2aContextId: CONTEXT,
      surfacedValues: SURFACED,
      declaredRows: [{ label: "Title", input: "title" }],
    });
    expect(transitions()).toEqual([{ from: "running", to: "pending_approval", error: undefined }]);
    expect(decisions.insertParkedDecision.mock.invocationCallOrder[0]!).toBeLessThan(
      storeMock.transitionRunStatus.mock.invocationCallOrder[0]!,
    );
    expect(onInterruptSpy).not.toHaveBeenCalled();
    expect(gateStore.rememberWayflowGateTask).not.toHaveBeenCalled();
  });

  // cinatra#4758: the pause records its own gate task in the compare-and-set that enters it, so the run row names this
  // gate's task for exactly this pause, and a Publish's claim bound to that task lands only here.
  // Red first at 7ca04b14: the park move named no task.
  it("the park move writes the gate's own task id with the pause", async () => {
    await pause(sign(GATE));
    expect((storeMock.transitionRunStatus.mock.calls[0] as unknown[])[3]).toEqual({ pauseTaskId: TASK });
  });

  it("the decision keeps the rows of the plan the attempt was DISPATCHED with, never the live template's (review finding 2)", async () => {
    // The live template was recompiled after the dispatch: it now labels the node's input differently and adds a row.
    storeMock.readAgentTemplateById.mockResolvedValue({
      ...makeTemplate(["publish"]),
      publishRows: { publish: [{ label: "Headline", input: "title" }, { label: "Body", input: "body" }] },
    });
    decisions.readDispatchedPublishRows.mockResolvedValue([{ label: "Title", input: "title" }]);
    await pause(sign(GATE));
    expect(decisions.readDispatchedPublishRows).toHaveBeenCalledWith("run-pub-1", "publish");
    expect(decisions.insertParkedDecision).toHaveBeenLastCalledWith(expect.objectContaining({ declaredRows: [{ label: "Title", input: "title" }] }));
    // The dispatched plan declares no rows for the node: an empty declaration is recorded, never the live template's.
    decisions.readDispatchedPublishRows.mockResolvedValue([]);
    await pause(sign(GATE));
    expect(decisions.insertParkedDecision).toHaveBeenLastCalledWith(expect.objectContaining({ declaredRows: [] }));
    // No recorded dispatch rows, or a read that faults, records nothing (null), and the park still goes on.
    for (const read of [async () => null, async () => { throw new Error("run store down"); }]) {
      vi.clearAllMocks();
      decisions.insertParkedDecision.mockResolvedValue({ inserted: true, current: true, decision: parkedRow() });
      storeMock.transitionRunStatus.mockResolvedValue(undefined);
      decisions.readDispatchedPublishRows.mockImplementation(read);
      await pause(sign(GATE));
      expect(decisions.insertParkedDecision).toHaveBeenLastCalledWith(expect.objectContaining({ declaredRows: null }));
      expect(transitions()).toEqual([{ from: "running", to: "pending_approval", error: undefined }]);
    }
  });

  it("a gate task whose stop a retry's reset already ended with its attempt fails the run, never wedges it running", async () => {
    decisions.insertParkedDecision.mockResolvedValue({
      inserted: false,
      current: false,
      decision: { ...parkedRow("run_ended"), runGeneration: 0 },
    });
    await pause(sign(GATE));
    expect(transitions().map((m) => `${m.from}->${m.to}:${(m.error ?? "").split(":")[0]}`)).toEqual([
      "running->failed:publish_decision_unrecorded",
    ]);
    expect(decisions.decide).not.toHaveBeenCalled();
    expect(onInterruptSpy).not.toHaveBeenCalled();
  });

  // Round 20: the park stamps the run's generation only while the run is held at a gate. A late park of an attempt that
  // already left it (failed, and maybe reset) is written as an ended attempt's row (-1): it is closed at once and never
  // holds, labels or stops the run's next attempt.
  it("a new stop written while the run is no longer held closes run_ended at once and fails nothing new", async () => {
    decisions.insertParkedDecision.mockResolvedValue({ inserted: true, current: false, decision: { ...parkedRow(), runGeneration: -1 } });
    await pause(sign(GATE));
    expect(decisions.decide).toHaveBeenCalledWith("dec-1", { from: "parked", to: "run_ended", actor: null });
    expect(transitions().map((m) => `${m.from}->${m.to}:${(m.error ?? "").split(":")[0]}`)).toEqual([
      "running->failed:publish_decision_unrecorded",
    ]);
    expect(onInterruptSpy).not.toHaveBeenCalled();
  });

  it("the prefix wins: a step the template does not list, or a template with no list, is still held", async () => {
    for (const steps of [[], null, ["another_step"]]) {
      vi.clearAllMocks();
      storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(steps));
      decisions.insertParkedDecision.mockResolvedValue({ inserted: true, current: true, decision: parkedRow() });
      await pause(sign(GATE));
      expect(decisions.insertParkedDecision).toHaveBeenCalledTimes(1);
      expect(transitions()).toEqual([{ from: "running", to: "pending_approval", error: undefined }]);
      expect(onInterruptSpy).not.toHaveBeenCalled();
    }
  });

  it("a lost move to pending_approval closes the decision run_ended", async () => {
    storeMock.transitionRunStatus.mockRejectedValueOnce(Object.assign(new Error("stale"), { code: "stale_from_status" }));
    await pause(sign(GATE));
    expect(decisions.decide).toHaveBeenCalledWith("dec-1", { from: "parked", to: "run_ended", actor: null });
    expect(onInterruptSpy).not.toHaveBeenCalled();
  });

  it("a gate that reaches an already waiting run records the decision and moves nothing", async () => {
    await pause(sign(GATE), "pending_approval");
    expect(decisions.insertParkedDecision).toHaveBeenCalledTimes(1);
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
    expect(onInterruptSpy).not.toHaveBeenCalled();
  });

  it("a store fault on the move to pending_approval is not swallowed: the row closes run_ended, nothing is offered", async () => {
    // The dispatch records the attempt failed; a row left parked would read as the open stop of a retry's next attempt.
    storeMock.transitionRunStatus.mockRejectedValueOnce(new Error("db down"));
    const run = makeRun();
    await expect(
      handleWayflowTaskState({ authority: AUTHORITY, runId: run.id, run, fromStatus: "running", task: pausedTask(sign(GATE)) }),
    ).rejects.toThrow("db down");
    expect(decisions.insertParkedDecision).toHaveBeenCalledTimes(1);
    expect(decisions.decide).toHaveBeenCalledTimes(1);
    expect(decisions.decide).toHaveBeenCalledWith("dec-1", { from: "parked", to: "run_ended", actor: null });
    expect(onInterruptSpy).not.toHaveBeenCalled();
  });

  it("a fault closing the row after a faulted move does not hide the move's own fault", async () => {
    storeMock.transitionRunStatus.mockRejectedValueOnce(new Error("db down"));
    decisions.decide.mockRejectedValueOnce(new Error("close failed"));
    const run = makeRun();
    await expect(
      handleWayflowTaskState({ authority: AUTHORITY, runId: run.id, run, fromStatus: "running", task: pausedTask(sign(GATE)) }),
    ).rejects.toThrow("db down");
    expect(decisions.decide).toHaveBeenCalledWith("dec-1", { from: "parked", to: "run_ended", actor: null });
  });

  it("a task without a context id is verified against the run's context id", async () => {
    const run = { ...makeRun(), a2aContextId: CONTEXT };
    const task = { ...pausedTask(sign(GATE)), contextId: null };
    await handleWayflowTaskState({ authority: AUTHORITY, runId: run.id, run, fromStatus: "running", task });
    expect(decisions.insertParkedDecision).toHaveBeenCalledWith(expect.objectContaining({ a2aContextId: CONTEXT, nodeId: "publish" }));
    expect(transitions()).toEqual([{ from: "running", to: "pending_approval", error: undefined }]);
  });

  it("with no context id on the task or the run, the claim cannot verify and a publishing template fails the run", async () => {
    const run = makeRun();
    const task = { ...pausedTask(sign(GATE)), contextId: null };
    await handleWayflowTaskState({ authority: AUTHORITY, runId: run.id, run, fromStatus: "running", task });
    expect(decisions.insertParkedDecision).not.toHaveBeenCalled();
    expect(transitions().map((m) => m.error ?? "")).toEqual([expect.stringMatching(/^publish_gate_unverified/)]);
  });

  it.each([
    ["a text that is no JSON", "publish it?"],
    ["a JSON array", "[1,2]"],
    ["a JSON string", '"the post"'],
    ["no text part", null],
  ])("%s surfaces no values: the row is written with an empty object", async (_label, text) => {
    const run = makeRun();
    const signed = pausedTask(sign(GATE));
    const parts = text === null ? [] : [{ kind: "text", text }];
    const task = { ...signed, history: [{ ...signed.history[0]!, parts }] };
    await handleWayflowTaskState({ authority: AUTHORITY, runId: run.id, run, fromStatus: "running", task });
    expect(decisions.insertParkedDecision).toHaveBeenCalledWith(expect.objectContaining({ surfacedValues: {} }));
    expect(transitions()).toEqual([{ from: "running", to: "pending_approval", error: undefined }]);
  });

  it("a gate task already answered is not parked again", async () => {
    decisions.insertParkedDecision.mockResolvedValue({ inserted: false, current: true, decision: parkedRow("declined") });
    await pause(sign(GATE));
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
    expect(onInterruptSpy).not.toHaveBeenCalled();
  });
});

describe("a publish gate that cannot be held ends the run failed (A10)", () => {
  it("a decision record that cannot be written fails the run and offers nothing", async () => {
    decisions.insertParkedDecision.mockRejectedValue(new Error("db down"));
    await pause(sign(GATE));
    const moves = transitions();
    expect(moves).toHaveLength(1);
    expect(moves[0]!.from).toBe("running");
    expect(moves[0]!.to).toBe("failed");
    expect(moves[0]!.error).not.toContain("db down");
    expect(onInterruptSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["no claim", undefined],
    ["a claim signed with another key", sign(GATE, "another-key")],
    ["a claim signed for another step", { ...sign("some_other_step"), node: GATE }],
    ["a claim of another shape", { node: GATE }],
  ])("%s on a template that lists publishing steps fails the run publish_gate_unverified", async (_label, claim) => {
    await pause(claim);
    const moves = transitions();
    expect(moves).toHaveLength(1);
    expect(moves[0]!.to).toBe("failed");
    expect(moves[0]!.error).toMatch(/^publish_gate_unverified/);
    expect(decisions.insertParkedDecision).not.toHaveBeenCalled();
    expect(onInterruptSpy).not.toHaveBeenCalled();
  });

  it("a template that is not found fails closed for a pause that claims a publish gate it cannot prove", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue(null);
    await pause(sign(GATE, "another-key"));
    const moves = transitions();
    expect(moves.map((m) => m.to)).toEqual(["failed"]);
    expect(moves[0]!.error).toMatch(/^publish_gate_unverified/);
    expect(decisions.insertParkedDecision).not.toHaveBeenCalled();
    expect(onInterruptSpy).not.toHaveBeenCalled();
  });

  it("a stale answer to the fail move is swallowed (the run already left); any other fault is not", async () => {
    decisions.insertParkedDecision.mockRejectedValue(new Error("db down"));
    storeMock.transitionRunStatus.mockRejectedValueOnce(Object.assign(new Error("stale"), { code: "stale_from_status" }));
    await expect(pause(sign(GATE))).resolves.toBeUndefined();
    storeMock.transitionRunStatus.mockRejectedValueOnce(new Error("run store down"));
    await expect(pause(sign(GATE))).rejects.toThrow("run store down");
    expect(onInterruptSpy).not.toHaveBeenCalled();
  });

  it("a template that cannot be read fails closed for a pause that claims a publish gate it cannot prove", async () => {
    storeMock.readAgentTemplateById.mockRejectedValue(new Error("template store down"));
    await pause(sign(GATE, "another-key"));
    const moves = transitions();
    expect(moves.map((m) => m.to)).toEqual(["failed"]);
    expect(moves[0]!.error).toMatch(/^publish_gate_unverified/);
    expect(moves[0]!.error).not.toContain("template store down");
    expect(decisions.insertParkedDecision).not.toHaveBeenCalled();
    expect(onInterruptSpy).not.toHaveBeenCalled();
  });

  it("with no attestation key on the host, a publishing template's pause cannot verify and fails", async () => {
    delete process.env.CINATRA_CONTEXT_ATTEST_KEY;
    try {
      await pause(sign(GATE));
      expect(transitions().map((m) => m.to)).toEqual(["failed"]);
      expect(decisions.insertParkedDecision).not.toHaveBeenCalled();
    } finally {
      process.env.CINATRA_CONTEXT_ATTEST_KEY = KEY;
    }
  });
});

describe("every other pause keeps today's road", () => {
  it.each([
    ["no claim, no publishing steps", [], undefined],
    ["no claim, a legacy template", null, undefined],
    ["a verified claim of another step on a publishing template", ["publish"], sign("review_step")],
  ])("%s: no decision, the interrupt is offered", async (_label, steps, claim) => {
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(steps as string[] | null));
    await pause(claim);
    expect(decisions.insertParkedDecision).not.toHaveBeenCalled();
    expect(transitions().map((m) => m.to)).not.toContain("failed");
    expect(onInterruptSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no claim", undefined],
    ["an unverified claim of another step", sign("review_step", "another-key")],
    ["a verified claim of another step", sign("review_step")],
  ])("a template that cannot be read keeps today's road for %s: no decision, the interrupt is offered", async (_label, claim) => {
    storeMock.readAgentTemplateById.mockRejectedValue(new Error("template store down"));
    await pause(claim);
    expect(decisions.insertParkedDecision).not.toHaveBeenCalled();
    expect(transitions().map((m) => m.to)).not.toContain("failed");
    expect(onInterruptSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no claim", undefined],
    ["an unverified claim of another step", sign("review_step", "another-key")],
    ["a verified claim of another step", sign("review_step")],
  ])("a template that is not found keeps today's road for %s: no decision, the interrupt is offered", async (_label, claim) => {
    storeMock.readAgentTemplateById.mockResolvedValue(null);
    await pause(claim);
    expect(decisions.insertParkedDecision).not.toHaveBeenCalled();
    expect(transitions().map((m) => m.to)).not.toContain("failed");
    expect(onInterruptSpy).toHaveBeenCalledTimes(1);
  });
});

// cinatra#4150 W4: a stop that surfaces more than the decision record holds (rows over long lists) is refused by name,
// before any record is written, with a fixed text that quotes no value.
describe("a stop whose surfaced values are over the record's cap ends the run failed, by name (W4)", () => {
  const withText = (text: string) => {
    const signed = pausedTask(sign(GATE));
    return { ...signed, history: [{ ...signed.history[0]!, parts: [{ kind: "text", text }] }] };
  };
  const drive = async (text: string) => {
    const run = makeRun();
    await handleWayflowTaskState({ authority: AUTHORITY, runId: run.id, run, fromStatus: "running", task: withText(text) });
  };

  it("the host's cap is the record's own cap", async () => {
    const { PUBLISH_SURFACED_VALUES_MAX_BYTES } = await import("../publish-decision-actions");
    expect(PUBLISH_SURFACED_VALUES_MAX_BYTES).toBe(64 * 1024);
    const store = readFileSync(join(__dirname, "..", "publish-decision-store.ts"), "utf8");
    expect(store).toContain("export const PUBLISH_DECISION_MAX_SURFACED_BYTES = 64 * 1024;");
  });

  it("at the cap the decision is recorded; one byte over writes no record and fails the run publish_decision_too_large", async () => {
    const filler = 64 * 1024 - JSON.stringify({ what: "" }).length;
    await drive(JSON.stringify({ what: "x".repeat(filler) }));
    expect(decisions.insertParkedDecision).toHaveBeenCalledTimes(1);
    expect(transitions()).toEqual([{ from: "running", to: "pending_approval", error: undefined }]);
    vi.clearAllMocks();

    const SECRET = "sk-live-SECRET-0123";
    await drive(JSON.stringify({ what: `${SECRET}${"x".repeat(filler + 1 - SECRET.length)}` }));
    expect(decisions.insertParkedDecision).not.toHaveBeenCalled();
    expect(onInterruptSpy).not.toHaveBeenCalled();
    const moves = transitions();
    expect(moves).toHaveLength(1);
    expect(moves[0]!.to).toBe("failed");
    expect(moves[0]!.error).toBe(
      "publish_decision_too_large: the values this step surfaced for the decision are over 65536 bytes, so no decision was recorded and the step did not run",
    );
    expect(moves[0]!.error).not.toContain("SECRET");
  });
});

// pre-2 finding 1: surfaced values nested past the serializer's depth cannot be measured. At base 46f770fe the measure
// threw out of the gate handling (red there); now the stop takes the unrecorded road with its fixed text.
describe("surfaced values that cannot be measured end the run failed as unrecorded (pre-2)", () => {
  it("a deeply nested value writes no record, offers nothing and fails the run publish_decision_unrecorded", async () => {
    const depth = 200_000;
    const text = `{"what":${"[".repeat(depth)}${"]".repeat(depth)}}`;
    // The parse of the surfaced text is not what fails: the guard's own measure is.
    expect(() => JSON.stringify(JSON.parse(text))).toThrow(RangeError);
    const signed = pausedTask(sign(GATE));
    const task = { ...signed, history: [{ ...signed.history[0]!, parts: [{ kind: "text", text }] }] };
    const run = makeRun();
    // At base the measure's RangeError escapes here and the case fails.
    await handleWayflowTaskState({ authority: AUTHORITY, runId: run.id, run, fromStatus: "running", task });
    expect(decisions.insertParkedDecision).not.toHaveBeenCalled();
    expect(onInterruptSpy).not.toHaveBeenCalled();
    expect(transitions()).toEqual([
      { from: "running", to: "failed", error: "publish_decision_unrecorded: the publish decision could not be recorded" },
    ]);
  });
});
