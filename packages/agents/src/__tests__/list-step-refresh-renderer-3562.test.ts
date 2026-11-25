/**
 * cinatra#3562 — after a list step's Try again the run parks at the same list
 * step again, and that pause carries the list step's renderer, not the renderer
 * of the person step that follows it.
 *
 * The flow has two renderer pauses: the list step, then a second person step.
 * A pause is mapped to its step by position (`getOrAddWayflowRendererGateIndex`),
 * and every resume returns a fresh task id. A refresh is not an answer: it must
 * not advance the position. A pick after the refresh advances it normally.
 *
 * The refresh and the pick go through the real resume road
 * (`approveReviewTaskInternal`) and the real state handler
 * (`handleWayflowTaskState`), which the resume road calls with the task the
 * runtime returns. The renderer gate list lives in an in-memory `ioredis`
 * double under the real `@cinatra-ai/a2a` functions. The resolved renderer is
 * the second argument of the adapter's `onInterrupt`.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/list-step-refresh-renderer-3562.test.ts
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

import { RunTransitionError } from "../run-status";
import { buildListStepRefreshPayload, classifyGateRejection, isAlreadyResolvedError } from "../hitl-gate-submit";

const LIST_STEP_ID = "@cinatra-ai/email-outreach-agent:list-picker";
const SECOND_STEP_ID = "@cinatra-ai/email-outreach-agent:recipients-output";

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
    DualAdapterDispatch: class {
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

const durableGate = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }));
vi.mock("../field-renderer-bindings.server", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getMergedFieldRendererBindings: () => [
    { id: "@cinatra-ai/email-outreach-agent:list-picker", kind: "list-picker", priority: 90, params: { refreshValue: "refresh" } },
  ],
}));

const row = vi.hoisted(() => ({ status: "running" as string, a2aTaskId: null as string | null }));
const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentRunByTaskId: vi.fn(),
  readAgentTemplateById: vi.fn(),
  readAgentTemplates: vi.fn(async () => []),
  readAgentTemplateVersionBySemver: vi.fn(async () => null),
  readAgentTemplateVersionById: vi.fn(async () => null),
  readRunCoOwners: vi.fn(async () => []),
  readAgentRunMessages: vi.fn(async () => []),
  transitionRunStatus: vi.fn(),
  findSavedConnectionForAgentUrl: vi.fn(async () => null),
  updateAgentRunA2ATaskId: vi.fn(async (_runId: string, taskId: string) => {
    row.a2aTaskId = taskId;
    return { written: true };
  }),
  updateAgentRunA2AContextId: vi.fn(async () => undefined),
}));
vi.mock("../store", () => storeMock);
vi.mock("../trigger-gate", () => ({ isTriggerReleased: vi.fn(async () => true) }));
vi.mock("../skill-autosave", () => ({ runSkillAutosaveOnRunCompletion: vi.fn(async () => undefined) }));
vi.mock("../run-pause-claim", async (orig) => ({
  ...(await orig<typeof import("../run-pause-claim")>()),
  ...(await import("./pause-claim-test-fake")).pauseClaimFake,
}));
vi.mock("../publish-decision-store", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readLatestDecisionForRun: async () => null,
}));
vi.mock("../agent-run-hitl-prompts", () => ({
  captureHitlPromptForContinue: async () => "captured-prompt",
  readDurableHitlGateForContinue: async () => durableGate.value,
  recordSuccessfulContinue: async () => {},
  continueBindingDigest: () => "",
  continueGateDigest: () => "",
}));
vi.mock("../db", () => {
  const query: Record<string, unknown> = {};
  query.from = () => query;
  query.where = () => query;
  query.limit = async () => [];
  return { db: { select: () => query }, agentBuilderPool: { on: () => {}, listenerCount: () => 1 } };
});
vi.mock("../resume-run-from-setup-approval", () => ({ resumeRunFromSetupApproval: vi.fn(async () => undefined) }));
vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: vi.fn(async () => undefined),
  BACKGROUND_JOB_NAMES: { AGENT_BUILDER_EXECUTION: "agent-builder-execution" },
}));
vi.mock("../wayflow-url", async (orig) => ({
  ...(await orig<typeof import("../wayflow-url")>()),
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  createWayflowFetch: vi.fn(() => globalThis.fetch),
}));
vi.mock("@/lib/auth-session", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth-session")>()),
  resolveOrgRoleForUser: vi.fn(async () => "member"),
  requireAuthSession: vi.fn(async () => ({ user: { id: "reader-refresh" }, session: { activeOrganizationId: "org-1" } })),
}));
vi.mock("../wayflow-run-token-carrier", () => ({ mintResumeRunTokenMetadata: vi.fn(async () => ({ token: "t" })) }));

/**
 * An in-memory `ioredis` double with the string and list commands the gate
 * sequence uses. It keeps each key's time to live in seconds as last set
 * (no clock runs), and answers `ttl` as Redis does: -2 absent, -1 none.
 */
const redis = vi.hoisted(() => {
  const store = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const ttls = new Map<string, number>();
  class FakeRedis {
    async set(key: string, value: string, mode?: string, seconds?: number): Promise<"OK"> {
      store.set(key, value);
      if (mode === "EX" && typeof seconds === "number") ttls.set(key, seconds);
      else ttls.delete(key);
      return "OK";
    }
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    }
    async del(key: string): Promise<number> {
      ttls.delete(key);
      return (store.delete(key) ? 1 : 0) + (lists.delete(key) ? 1 : 0);
    }
    async lrange(key: string): Promise<string[]> {
      return [...(lists.get(key) ?? [])];
    }
    async rpush(key: string, ...values: string[]): Promise<number> {
      const list = lists.get(key) ?? [];
      list.push(...values);
      lists.set(key, list);
      return list.length;
    }
    async lset(key: string, index: number, value: string): Promise<"OK"> {
      const list = lists.get(key);
      if (!list || index < 0 || index >= list.length) throw new Error("ERR index out of range");
      list[index] = value;
      return "OK";
    }
    async expire(key: string, seconds: number): Promise<number> {
      if (!store.has(key) && !lists.has(key)) return 0;
      ttls.set(key, seconds);
      return 1;
    }
    async ttl(key: string): Promise<number> {
      if (!store.has(key) && !lists.has(key)) return -2;
      return ttls.get(key) ?? -1;
    }
    async eval(): Promise<string> {
      return "absent";
    }
    async quit(): Promise<"OK"> {
      return "OK";
    }
    on(): this {
      return this;
    }
  }
  return { store, lists, ttls, FakeRedis };
});
vi.mock("ioredis", () => ({ Redis: redis.FakeRedis, default: redis.FakeRedis }));

const sendTask = vi.hoisted(() => vi.fn());
vi.mock("@cinatra-ai/a2a", async (orig) => ({
  ...(await orig<typeof import("@cinatra-ai/a2a")>()),
  createExternalA2AClient: vi.fn(async () => ({ sendTask, getTask: vi.fn() })),
  resolveRunIdByWayflowTaskId: vi.fn(async () => null),
  resolveLatestWayflowGateTaskId: vi.fn(async () => null),
}));

import { approveReviewTaskInternal } from "../review-task-actions";
import { handleWayflowTaskState } from "../execution";

const RUN = {
  id: "run-refresh-renderer-3562",
  templateId: "tpl-refresh-renderer-3562",
  versionId: null,
  orgId: "org-1",
  runBy: "reader-refresh",
  authPolicy: null,
  inputParams: {},
  a2aContextId: "ctx-refresh-renderer-3562",
  pauseGeneration: 1,
  sourceType: "agent_builder",
};
const liveRun = () => ({ ...RUN, status: row.status, a2aTaskId: row.a2aTaskId });
const TEST_AUTHORITY = { orgId: "org-1", can: () => true };

const TEMPLATE = {
  id: RUN.templateId,
  packageName: "@cinatra-ai/email-outreach-agent",
  sourceType: "internal",
  agentAuthPolicy: null,
  approvalPolicy: {
    steps: [
      {
        stepNumber: 1,
        requiresApproval: true,
        hitlOwnedBy: "self",
        xRenderer: LIST_STEP_ID,
        firesRendererGate: true,
        schema: { type: "object", properties: { listIds: { type: "array" } } },
      },
      {
        stepNumber: 2,
        requiresApproval: true,
        hitlOwnedBy: "self",
        xRenderer: SECOND_STEP_ID,
        firesRendererGate: true,
        schema: { type: "object", properties: { recipients: { type: "array" } } },
      },
    ],
  },
};

function pauseTask(id: string) {
  return { id, contextId: RUN.a2aContextId, status: { state: "input-required", message: { parts: [] } }, metadata: {}, history: [] };
}

/** The durable record of the pause the operator answers, as the list step materialized it. */
function listStepGate(taskId: string) {
  return {
    runId: RUN.id,
    reviewTaskId: `wayflow-${taskId}`,
    xRenderer: LIST_STEP_ID,
    inputSchema: { type: "object", properties: { listIds: { type: "array" } } },
    values: {},
    materializedAt: "2026-11-24T00:00:00.000Z",
  };
}

const renderers = (): string[] => onInterruptSpy.mock.calls.map((call) => call[1] as string);

/** The runtime parks at `nextTaskId`; the operator answers the pause `taskId`. */
async function answer(taskId: string, nextTaskId: string, values: Record<string, unknown>): Promise<void> {
  durableGate.value = listStepGate(taskId);
  sendTask.mockResolvedValueOnce(pauseTask(nextTaskId));
  await approveReviewTaskInternal(`wayflow-${taskId}`, RUN.runBy, values);
}
const refresh = (taskId: string, nextTaskId: string) => answer(taskId, nextTaskId, buildListStepRefreshPayload("refresh"));
const pick = (taskId: string, nextTaskId: string) =>
  answer(taskId, nextTaskId, { approved: true, userResponse: JSON.stringify({ listIds: ["list-a"], listNames: ["List A"] }) });

async function firstPause(taskId: string): Promise<void> {
  await handleWayflowTaskState({ authority: TEST_AUTHORITY as never, runId: RUN.id, run: liveRun() as never, fromStatus: "running", task: pauseTask(taskId) as never });
}

function arrange() {
  row.status = "running";
  row.a2aTaskId = null;
  redis.store.clear();
  redis.lists.clear();
  redis.ttls.clear();
  // A refused send leaves its queued answer behind: drop it.
  sendTask.mockReset();
  durableGate.value = null;
  storeMock.readAgentRunByTaskId.mockImplementation(async () => liveRun());
  storeMock.readAgentRunById.mockImplementation(async () => liveRun());
  storeMock.readAgentTemplateById.mockResolvedValue(TEMPLATE);
  storeMock.transitionRunStatus.mockImplementation(async (runId: string, from: string, to: string) => {
    if (row.status !== from) {
      throw new RunTransitionError({ code: "stale_from_status", runId, from: from as never, to: to as never });
    }
    row.status = to;
  });
}

beforeAll(async () => {
  arrange();
  await firstPause("warm-up").catch(() => undefined);
}, 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  arrange();
});

describe("cinatra#3562 — a refreshed list step keeps its own renderer", () => {
  it("the pause after a refresh carries the list step's renderer, and a pick then reaches the second step", async () => {
    await firstPause("task-list-1");
    expect(renderers()).toEqual([LIST_STEP_ID]);

    // red-first-expect: buildListStepRefreshPayload is not a function
    await refresh("task-list-1", "task-list-2");
    expect(renderers()).toEqual([LIST_STEP_ID, LIST_STEP_ID]);

    await pick("task-list-2", "task-second-1");
    expect(renderers()).toEqual([LIST_STEP_ID, LIST_STEP_ID, SECOND_STEP_ID]);
    expect(row.status).toBe("pending_approval");
  });

  it("two refreshes in a row both keep the list step's renderer", async () => {
    await firstPause("task-list-1");
    // red-first-expect: buildListStepRefreshPayload is not a function
    await refresh("task-list-1", "task-list-2");
    await refresh("task-list-2", "task-list-3");
    expect(renderers()).toEqual([LIST_STEP_ID, LIST_STEP_ID, LIST_STEP_ID]);

    await pick("task-list-3", "task-second-1");
    expect(renderers()).toEqual([LIST_STEP_ID, LIST_STEP_ID, LIST_STEP_ID, SECOND_STEP_ID]);
  });
});

const RENDERER_GATES_KEY = `cinatra:wayflow:renderer-gates:${RUN.id}`;
const SEVEN_DAYS_S = 7 * 24 * 3600;

describe("cinatra#3562 — a refreshed list step keeps its place when the run's step list expires", () => {
  // The list step is the run's SECOND renderer step here, so a lost place shows:
  // place 0 is the first step's renderer, not the list step's.
  const FIRST_STEP_ID = "@cinatra-ai/email-outreach-agent:account-scope";
  const step = (stepNumber: number, xRenderer: string) => ({
    stepNumber,
    requiresApproval: true,
    hitlOwnedBy: "self",
    xRenderer,
    firesRendererGate: true,
    schema: { type: "object", properties: {} },
  });
  const threeSteps = (firstRenderer: string) => ({
    ...TEMPLATE,
    approvalPolicy: { steps: [step(1, firstRenderer), step(2, LIST_STEP_ID), step(3, SECOND_STEP_ID)] },
  });
  const dropList = () => {
    redis.lists.delete(RENDERER_GATES_KEY);
    redis.ttls.delete(RENDERER_GATES_KEY);
  };
  /** The first step is answered: the run parks at the list step, its second renderer pause. */
  async function atListStep(): Promise<void> {
    await firstPause("task-first-1");
    await pick("task-first-1", "task-list-1");
  }

  it("the list is gone when Try again is pressed: the refresh is taken, its pause carries the list step's renderer, and a pick reaches the next step", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue(threeSteps(FIRST_STEP_ID));
    await atListStep();
    expect(renderers()).toEqual([FIRST_STEP_ID, LIST_STEP_ID]);
    dropList();

    // red-first-expect: buildListStepRefreshPayload is not a function
    await refresh("task-list-1", "task-list-2");
    expect(sendTask).toHaveBeenCalledTimes(2);
    expect(renderers()).toEqual([FIRST_STEP_ID, LIST_STEP_ID, LIST_STEP_ID]);

    await pick("task-list-2", "task-second-1");
    expect(renderers()).toEqual([FIRST_STEP_ID, LIST_STEP_ID, LIST_STEP_ID, SECOND_STEP_ID]);
    expect(row.status).toBe("pending_approval");
  });

  it("the list expires between the refresh and the next pause: the pause still carries the list step's renderer", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue(threeSteps(FIRST_STEP_ID));
    await atListStep();
    // The list expires while the refresh's resume is under way.
    sendTask.mockImplementationOnce(async () => {
      dropList();
      return pauseTask("task-list-2");
    });
    durableGate.value = listStepGate("task-list-1");
    // red-first-expect: buildListStepRefreshPayload is not a function
    await approveReviewTaskInternal("wayflow-task-list-1", RUN.runBy, buildListStepRefreshPayload("refresh"));
    expect(renderers()).toEqual([FIRST_STEP_ID, LIST_STEP_ID, LIST_STEP_ID]);

    await pick("task-list-2", "task-second-1");
    expect(renderers()).toEqual([FIRST_STEP_ID, LIST_STEP_ID, LIST_STEP_ID, SECOND_STEP_ID]);
    expect(row.status).toBe("pending_approval");
  });

  it("the list is gone and the flow has two steps with the list step's renderer: the refresh is refused, nothing is sent, and the step can be tried and answered again", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue(threeSteps(LIST_STEP_ID));
    await atListStep();
    expect(renderers()).toEqual([LIST_STEP_ID, LIST_STEP_ID]);
    dropList();

    let refusal: unknown = null;
    // red-first-expect: buildListStepRefreshPayload is not a function
    await refresh("task-list-1", "task-list-2").catch((error: unknown) => {
      refusal = error;
    });
    expect(String((refusal as Error | null)?.message)).toContain("its place in the run's steps is not known");
    // What the run panel's submit is given: a thrown error that is neither a
    // gate that moved on nor one already answered, so it shows its error toast
    // and draws the step again, with Try again (see the run panel's test).
    expect(classifyGateRejection(refusal)).toBeNull();
    expect(isAlreadyResolvedError((refusal as Error).message)).toBe(false);
    expect(sendTask).toHaveBeenCalledTimes(1);
    expect(redis.store.has(`cinatra:wayflow:renderer-gate-repeat:${RUN.id}`)).toBe(false);
    expect(row.status).toBe("pending_approval");
    expect(storeMock.transitionRunStatus).toHaveBeenLastCalledWith(
      RUN.id,
      "running",
      "pending_approval",
      { pauseTaskId: "task-list-1" },
      expect.anything(),
    );
    expect(renderers()).toEqual([LIST_STEP_ID, LIST_STEP_ID]);

    // Another try reaches the same check (no claim is left behind), and a pick is sent.
    await expect(refresh("task-list-1", "task-list-2")).rejects.toThrow("its place in the run's steps is not known");
    await pick("task-list-1", "task-second-1");
    expect(sendTask).toHaveBeenCalledTimes(2);
    expect(row.status).toBe("pending_approval");
  });

  it("writing the refresh note renews the list's time to live before the resume is sent", async () => {
    await firstPause("task-list-1");
    // The list was written long ago: one minute is left.
    redis.ttls.set(RENDERER_GATES_KEY, 60);
    const ttlAtSend: number[] = [];
    sendTask.mockImplementationOnce(async () => {
      ttlAtSend.push(await new redis.FakeRedis().ttl(RENDERER_GATES_KEY));
      return pauseTask("task-list-2");
    });
    durableGate.value = listStepGate("task-list-1");
    // red-first-expect: buildListStepRefreshPayload is not a function
    await approveReviewTaskInternal("wayflow-task-list-1", RUN.runBy, buildListStepRefreshPayload("refresh"));
    expect(ttlAtSend).toEqual([SEVEN_DAYS_S]);
    expect(renderers()).toEqual([LIST_STEP_ID, LIST_STEP_ID]);
  });
});

describe("cinatra#3562 — the place a refresh keeps, and when it is refused", () => {
  const REPEAT_KEY = `cinatra:wayflow:renderer-gate-repeat:${RUN.id}`;

  it("a list whose last entry is another task refuses the note, even with a place from the steps", async () => {
    redis.lists.set(`cinatra:wayflow:renderer-gates:${RUN.id}`, ["task-first-1", "task-list-1"]);
    const { rememberWayflowRendererGateRepeat } = await import("@cinatra-ai/a2a");
    // red-first-expect: No "rememberWayflowRendererGateRepeat" export is defined on the "@cinatra-ai/a2a" mock
    await expect(rememberWayflowRendererGateRepeat(RUN.id, "task-other", 1)).rejects.toThrow("its place in the run's steps is not known");
    await expect(rememberWayflowRendererGateRepeat(RUN.id, "task-first-1", 0)).rejects.toThrow("its place in the run's steps is not known");
    expect(redis.store.has(REPEAT_KEY)).toBe(false);
  });

  it("a gone list with no place from the steps refuses the note", async () => {
    const { rememberWayflowRendererGateRepeat } = await import("@cinatra-ai/a2a");
    // red-first-expect: No "rememberWayflowRendererGateRepeat" export is defined on the "@cinatra-ai/a2a" mock
    await expect(rememberWayflowRendererGateRepeat(RUN.id, "task-list-1", null)).rejects.toThrow("its place in the run's steps is not known");
    await expect(rememberWayflowRendererGateRepeat(RUN.id, "task-list-1", -1)).rejects.toThrow("its place in the run's steps is not known");
    expect(redis.store.has(REPEAT_KEY)).toBe(false);
  });

  it("a flow with one renderer step writes no note for a refresh", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue({ ...TEMPLATE, approvalPolicy: { steps: [TEMPLATE.approvalPolicy.steps[0]] } });
    await firstPause("task-list-1");
    // red-first-expect: buildListStepRefreshPayload is not a function
    await refresh("task-list-1", "task-list-2");
    expect(sendTask).toHaveBeenCalledTimes(1);
    expect(redis.store.has(REPEAT_KEY)).toBe(false);
    expect(renderers()).toEqual([LIST_STEP_ID, LIST_STEP_ID]);
  });

  it("the place from the steps is the one renderer step's gate index, walked as the resolver walks", async () => {
    const { rendererGateIndexOfRenderer } = await import("../orchestrator-gate-predicate");
    const s = (xRenderer: string, extra: Record<string, unknown> = {}) => ({ xRenderer, ...extra });
    // red-first-expect: rendererGateIndexOfRenderer is not a function
    expect(rendererGateIndexOfRenderer([s("a"), s("list"), s("b")], "list")).toBe(1);
    // A phantom step takes no place; a step of two gates takes two.
    expect(rendererGateIndexOfRenderer([s("a", { firesRendererGate: false }), s("b", { gateCount: 2 }), s("list")], "list")).toBe(2);
    // No step, two steps, or a step of several gates: no one place.
    expect(rendererGateIndexOfRenderer([s("a"), s("b")], "list")).toBeNull();
    expect(rendererGateIndexOfRenderer([s("list"), s("list")], "list")).toBeNull();
    expect(rendererGateIndexOfRenderer([s("a"), s("list", { gateCount: 2 })], "list")).toBeNull();
  });
});
