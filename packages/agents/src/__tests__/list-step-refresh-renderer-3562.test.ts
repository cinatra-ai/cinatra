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
import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";

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

/**
 * The gate records: `rows` holds what the real park seam wrote (by review task
 * id), which the resume road reads first; `value` is the fallback a test sets.
 */
const durableGate = vi.hoisted(() => ({ value: null as null | Record<string, unknown>, rows: new Map<string, Record<string, unknown>>(), readFails: false }));
/** The list step's binding as the process declares it now; a test can change it after a pause. */
const listBinding = vi.hoisted(() => ({ params: { refreshValue: "refresh" } as Record<string, unknown> }));
vi.mock("../field-renderer-bindings.server", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getMergedFieldRendererBindings: () => [
    { id: "@cinatra-ai/email-outreach-agent:list-picker", kind: "list-picker", priority: 90, params: listBinding.params },
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
  writeDurableHitlGateArtifact: vi.fn(async (artifact: Record<string, unknown>) => {
    durableGate.rows.set(String(artifact.reviewTaskId), JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>);
  }),
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
  readDurableHitlGateForContinue: async (_runId: string, reviewTaskId: string) => {
    if (durableGate.readFails) throw new Error("gate record read failed");
    const fallback = durableGate.value;
    return durableGate.rows.get(reviewTaskId) ?? (fallback && fallback.reviewTaskId === reviewTaskId ? fallback : null);
  },
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
 * An in-memory `ioredis` double with the string, list and hash commands the
 * gate sequence uses. It keeps each key's time to live in seconds as last set
 * (no clock runs), and answers `ttl` as Redis does: -2 absent, -1 none.
 *
 * `eval` runs the renderer gate list's commit script (the only script these
 * flows send with three keys) and the refresh note's compare-and-delete (one
 * key, the note's) step by step on the same maps, as the scripts read their
 * keys and arguments, in one synchronous call, so no other command runs in
 * between (as on Redis). Any other script answers "absent" (the answered-gate
 * consume, which these tests do not exercise). The commit's first check (a
 * place that is not a whole number below the limit, or a list that would grow
 * past it, returns -1) reads the limit from the script text it is given, so
 * the copy and the script cannot hold two limits.
 *
 * `loseReplyOnce` names keys whose next `set` is written and then fails, as a
 * write whose reply is lost does.
 */
const redis = vi.hoisted(() => {
  const store = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const hashes = new Map<string, Map<string, string>>();
  const ttls = new Map<string, number>();
  const loseReplyOnce = new Set<string>();
  const has = (key: string) => store.has(key) || lists.has(key) || hashes.has(key);
  class FakeRedis {
    async set(key: string, value: string, mode?: string, seconds?: number): Promise<"OK"> {
      store.set(key, value);
      if (mode === "EX" && typeof seconds === "number") ttls.set(key, seconds);
      else ttls.delete(key);
      if (loseReplyOnce.delete(key)) throw new Error("Connection is closed.");
      return "OK";
    }
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    }
    async del(key: string): Promise<number> {
      ttls.delete(key);
      return (store.delete(key) ? 1 : 0) + (lists.delete(key) ? 1 : 0) + (hashes.delete(key) ? 1 : 0);
    }
    async hget(key: string, field: string): Promise<string | null> {
      return hashes.get(key)?.get(field) ?? null;
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
      if (!has(key)) return 0;
      ttls.set(key, seconds);
      return 1;
    }
    async ttl(key: string): Promise<number> {
      if (!has(key)) return -2;
      return ttls.get(key) ?? -1;
    }
    async eval(script: string, numKeys: number, ...rest: string[]): Promise<number | string> {
      if (numKeys === 1 && rest[0].startsWith("cinatra:wayflow:renderer-gate-repeat:")) {
        const [noteKey, noteAsRead] = rest;
        if (store.get(noteKey) !== noteAsRead) return 0;
        store.delete(noteKey);
        ttls.delete(noteKey);
        return 1;
      }
      if (numKeys !== 3) return "absent";
      const [listKey, noteKey, replacedKey, noteAsRead, ttl, taskId, at, refreshedTaskId, nRaw, mRaw, ...tail] = rest;
      const limitText = /or at >= (\d+) then return -1 end/.exec(script)?.[1];
      if (limitText === undefined || !script.includes(`if tonumber(ARGV[6]) + tonumber(ARGV[7]) > ${limitText} then return -1 end`)) {
        throw new Error("the commit script carries no place limit");
      }
      const place = at.trim() === "" ? Number.NaN : Number(at);
      if (!Number.isFinite(place) || place < 0 || !Number.isInteger(place) || place >= Number(limitText)) return -1;
      if (Number(nRaw) + Number(mRaw) > Number(limitText)) return -1;
      if ((store.get(noteKey) ?? "") !== noteAsRead) return 0;
      const n = Number(nRaw);
      const m = Number(mRaw);
      const list = lists.get(listKey) ?? [];
      if (list.length !== n) return 0;
      for (let i = 0; i < n; i += 1) if (list[i] !== tail[i]) return 0;
      if (m === 0) {
        if (Number(at) < 0 || Number(at) >= list.length) throw new Error("ERR index out of range");
        list[Number(at)] = taskId;
      } else {
        list.push(...tail.slice(n, n + m));
        lists.set(listKey, list);
      }
      ttls.set(listKey, Number(ttl));
      if (noteAsRead !== "") {
        store.delete(noteKey);
        ttls.delete(noteKey);
        const hash = hashes.get(replacedKey) ?? new Map<string, string>();
        hash.set(refreshedTaskId, at);
        hashes.set(replacedKey, hash);
        ttls.set(replacedKey, Number(ttl));
      }
      return 1;
    }
    async quit(): Promise<"OK"> {
      return "OK";
    }
    on(): this {
      return this;
    }
  }
  return { store, lists, hashes, ttls, loseReplyOnce, FakeRedis };
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
import { handleWayflowTaskState, RENDERER_GATE_PLACE_UNKNOWN_RUN_ERROR } from "../execution";

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
/** The run's version pin (cinatra#1040): unpinned unless a test pins it. */
const runPin = { packageVersion: null as string | null, versionId: null as string | null };
const liveRun = () => ({ ...RUN, ...runPin, status: row.status, a2aTaskId: row.a2aTaskId });
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
  runPin.packageVersion = null;
  runPin.versionId = null;
  redis.store.clear();
  redis.lists.clear();
  redis.hashes.clear();
  redis.ttls.clear();
  redis.loseReplyOnce.clear();
  // A refused send leaves its queued answer behind: drop it.
  sendTask.mockReset();
  durableGate.value = null;
  durableGate.rows.clear();
  listBinding.params = { refreshValue: "refresh" };
  storeMock.writeDurableHitlGateArtifact.mockImplementation(async (artifact: Record<string, unknown>) => {
    durableGate.rows.set(String(artifact.reviewTaskId), JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>);
  });
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

  it("two list steps share one renderer and the list is live: each Try again keeps its own step's place, through the real action for both", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue(threeSteps(LIST_STEP_ID));
    await atListStep();
    expect(renderers()).toEqual([LIST_STEP_ID, LIST_STEP_ID]);
    // The second list step (place 1) is refreshed: its task holds that place in the run's list.
    // red-first-expect: buildListStepRefreshPayload is not a function
    await refresh("task-list-1", "task-list-2");
    expect(renderers()).toEqual([LIST_STEP_ID, LIST_STEP_ID, LIST_STEP_ID]);
    await pick("task-list-2", "task-second-1");
    expect(renderers()).toEqual([LIST_STEP_ID, LIST_STEP_ID, LIST_STEP_ID, SECOND_STEP_ID]);
    expect(row.status).toBe("pending_approval");
  });

  it("two list steps share one renderer and the list is live: the first list step's Try again works too, and the second's after it", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue(threeSteps(LIST_STEP_ID));
    await firstPause("task-a-1");
    // red-first-expect: buildListStepRefreshPayload is not a function
    await refresh("task-a-1", "task-a-2");
    await pick("task-a-2", "task-b-1");
    await refresh("task-b-1", "task-b-2");
    await pick("task-b-2", "task-second-1");
    expect(renderers()).toEqual([LIST_STEP_ID, LIST_STEP_ID, LIST_STEP_ID, LIST_STEP_ID, SECOND_STEP_ID]);
    expect(sendTask).toHaveBeenCalledTimes(4);
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

describe("cinatra#3562 — a refreshed pause reported again keeps the next pause on the list step", () => {
  /** A reconnect or a retry reports a pause the run already parked at. */
  async function reportAgain(taskId: string): Promise<void> {
    await handleWayflowTaskState({ authority: TEST_AUTHORITY as never, runId: RUN.id, run: liveRun() as never, fromStatus: "pending_approval", task: pauseTask(taskId) as never });
  }

  it.each([1, 3])("the refreshed pause is reported %i time(s) before the next pause arrives: the next pause carries the list step's renderer, and a pick reaches the second step", async (times) => {
    await firstPause("task-list-1");
    sendTask.mockImplementationOnce(async () => {
      for (let i = 0; i < times; i += 1) await reportAgain("task-list-1");
      return pauseTask("task-list-2");
    });
    durableGate.value = listStepGate("task-list-1");
    // red-first-expect: buildListStepRefreshPayload is not a function
    await approveReviewTaskInternal("wayflow-task-list-1", RUN.runBy, buildListStepRefreshPayload("refresh"));
    expect(renderers()).toEqual(Array.from({ length: times + 2 }, () => LIST_STEP_ID));

    await pick("task-list-2", "task-second-1");
    expect(renderers().at(-1)).toBe(SECOND_STEP_ID);
    expect(row.status).toBe("pending_approval");
  });

  it("the refreshed pause is reported again, then the pause after the refresh is reported twice: every report carries the list step's renderer", async () => {
    await firstPause("task-list-1");
    sendTask.mockImplementationOnce(async () => {
      await reportAgain("task-list-1");
      return pauseTask("task-list-2");
    });
    durableGate.value = listStepGate("task-list-1");
    // red-first-expect: buildListStepRefreshPayload is not a function
    await approveReviewTaskInternal("wayflow-task-list-1", RUN.runBy, buildListStepRefreshPayload("refresh"));
    await reportAgain("task-list-2");
    expect(renderers()).toEqual([LIST_STEP_ID, LIST_STEP_ID, LIST_STEP_ID, LIST_STEP_ID]);

    await pick("task-list-2", "task-second-1");
    expect(renderers().at(-1)).toBe(SECOND_STEP_ID);
  });

  it("the refreshed pause and the next pause are reported in either order, or at once: both keep the list step's place, and the following pause takes the next one", async () => {
    const { getOrAddWayflowRendererGateIndex, rememberWayflowRendererGateRepeat } = await import("@cinatra-ai/a2a");
    // The list step is the run's second renderer pause (place 1).
    const atListStep = async (suffix: string): Promise<{ a: string; b: string; next: string }> => {
      const run = `${RUN.id}-${suffix}`;
      expect(await getOrAddWayflowRendererGateIndex(run, `first-${suffix}`)).toBe(0);
      expect(await getOrAddWayflowRendererGateIndex(run, `list-a-${suffix}`)).toBe(1);
      await rememberWayflowRendererGateRepeat(run, `list-a-${suffix}`);
      return { a: `list-a-${suffix}`, b: `list-b-${suffix}`, next: `second-${suffix}` };
    };
    const place = (suffix: string, taskId: string) => getOrAddWayflowRendererGateIndex(`${RUN.id}-${suffix}`, taskId);

    // The refreshed pause first, then the next pause, then the refreshed pause late.
    // red-first-expect: No "rememberWayflowRendererGateRepeat" export is defined on the "@cinatra-ai/a2a" mock
    let t = await atListStep("ab");
    expect([await place("ab", t.a), await place("ab", t.b), await place("ab", t.a)]).toEqual([1, 1, 1]);
    expect(await place("ab", t.next)).toBe(2);

    // The next pause first, then the refreshed pause.
    t = await atListStep("ba");
    expect([await place("ba", t.b), await place("ba", t.a), await place("ba", t.b)]).toEqual([1, 1, 1]);
    expect(await place("ba", t.next)).toBe(2);

    // Both at once, in both orders, and the next pause twice at once.
    t = await atListStep("ab2");
    expect(await Promise.all([place("ab2", t.a), place("ab2", t.b)])).toEqual([1, 1]);
    expect(await place("ab2", t.next)).toBe(2);
    t = await atListStep("ba2");
    expect(await Promise.all([place("ba2", t.b), place("ba2", t.a)])).toEqual([1, 1]);
    expect(await place("ba2", t.next)).toBe(2);
    t = await atListStep("bb");
    expect(await Promise.all([place("bb", t.b), place("bb", t.b)])).toEqual([1, 1]);
    expect(await place("bb", t.next)).toBe(2);

    // The list expired before the next pause: the refreshed pause reported again
    // keeps the note's place and leaves the note, which the next pause then uses.
    t = await atListStep("gone");
    redis.lists.delete(`cinatra:wayflow:renderer-gates:${RUN.id}-gone`);
    expect([await place("gone", t.a), await place("gone", t.b), await place("gone", t.a)]).toEqual([1, 1, 1]);
    expect(await place("gone", t.next)).toBe(2);
  });

  it("a note that names a task that is not the last renderer gate refuses every pause and stays", async () => {
    const { getOrAddWayflowRendererGateIndex } = await import("@cinatra-ai/a2a");
    const repeatKey = `cinatra:wayflow:renderer-gate-repeat:${RUN.id}`;
    redis.lists.set(RENDERER_GATES_KEY, ["task-first-1", "task-list-1"]);
    redis.store.set(repeatKey, JSON.stringify({ taskId: "task-first-1", index: 0 }));
    // red-first-expect: promise resolved "2" instead of rejecting
    for (let i = 0; i < 2; i += 1) {
      await expect(getOrAddWayflowRendererGateIndex(RUN.id, "task-next-1")).rejects.toThrow("is not the last renderer gate");
      expect(redis.store.has(repeatKey)).toBe(true);
    }
    expect(redis.lists.get(RENDERER_GATES_KEY)).toEqual(["task-first-1", "task-list-1"]);
  });
});

describe("cinatra#3562 — a refresh that was not sent, and a real answer, leave no note for the step", () => {
  const REPEAT_KEY = `cinatra:wayflow:renderer-gate-repeat:${RUN.id}`;

  it("the refresh's note is written but its reply is lost: nothing is sent, the step is put back with no note, and a pick reaches the second step", async () => {
    await firstPause("task-list-1");
    redis.loseReplyOnce.add(REPEAT_KEY);
    // red-first-expect: buildListStepRefreshPayload is not a function
    await expect(refresh("task-list-1", "task-list-2")).rejects.toThrow("Connection is closed.");
    expect(sendTask).not.toHaveBeenCalled();
    expect(row.status).toBe("pending_approval");
    expect(redis.store.has(REPEAT_KEY)).toBe(false);

    sendTask.mockReset();
    await pick("task-list-1", "task-second-1");
    expect(renderers()).toEqual([LIST_STEP_ID, SECOND_STEP_ID]);
    expect(redis.store.has(REPEAT_KEY)).toBe(false);
  });

  it("a real answer to a step with a note left for it removes the note before it is sent, and the next pause takes the next step", async () => {
    await firstPause("task-list-1");
    redis.store.set(REPEAT_KEY, JSON.stringify({ taskId: "task-list-1", index: 0 }));
    const noteAtSend: boolean[] = [];
    sendTask.mockImplementationOnce(async () => {
      noteAtSend.push(redis.store.has(REPEAT_KEY));
      return pauseTask("task-second-1");
    });
    durableGate.value = listStepGate("task-list-1");
    // red-first-expect: expected [ true ] to deeply equal [ false ]
    await approveReviewTaskInternal("wayflow-task-list-1", RUN.runBy, { approved: true, userResponse: JSON.stringify({ listIds: ["list-a"], listNames: ["List A"] }) });
    expect(noteAtSend).toEqual([false]);
    expect(renderers()).toEqual([LIST_STEP_ID, SECOND_STEP_ID]);
  });

  it("a real answer leaves a note that names another task", async () => {
    await firstPause("task-list-1");
    const otherNote = JSON.stringify({ taskId: "task-other-1", index: 0 });
    redis.store.set(REPEAT_KEY, otherNote);
    const noteAtSend: Array<string | undefined> = [];
    sendTask.mockImplementationOnce(async () => {
      noteAtSend.push(redis.store.get(REPEAT_KEY));
      throw new Error("the runtime is unreachable");
    });
    durableGate.value = listStepGate("task-list-1");
    await expect(
      approveReviewTaskInternal("wayflow-task-list-1", RUN.runBy, { approved: true, userResponse: JSON.stringify({ listIds: ["list-a"], listNames: ["List A"] }) }),
    ).rejects.toThrow("the runtime is unreachable");
    expect(noteAtSend).toEqual([otherNote]);
    expect(redis.store.get(REPEAT_KEY)).toBe(otherNote);
  });
});

describe("cinatra#3562 — a pause whose step cannot be established after a refresh is not shown", () => {
  const REPEAT_KEY = `cinatra:wayflow:renderer-gate-repeat:${RUN.id}`;

  /** The state handler is given the next pause: the outcome is checked, then the note is removed and the pause reported again. */
  async function refusedThenPlaced(note: string): Promise<void> {
    redis.store.set(REPEAT_KEY, note);
    const listBefore = [...(redis.lists.get(RENDERER_GATES_KEY) ?? [])];
    const shownBefore = renderers();
    // The run was resumed (a refresh was sent) and the runtime reports its next pause.
    row.status = "running";
    await firstPause("task-next-1");
    // Not shown at all: no screen, and so no fallback form, for this pause.
    expect(renderers()).toEqual(shownBefore);
    expect(row.status).toBe("failed");
    expect(storeMock.transitionRunStatus).toHaveBeenLastCalledWith(
      RUN.id,
      "running",
      "failed",
      { error: RENDERER_GATE_PLACE_UNKNOWN_RUN_ERROR },
      expect.anything(),
    );
    expect(RENDERER_GATE_PLACE_UNKNOWN_RUN_ERROR).toMatch(/^renderer_gate_place_unknown: /);
    // Nothing is consumed or rebuilt: the note and the list stay as they were.
    expect(redis.store.get(REPEAT_KEY)).toBe(note);
    expect(redis.lists.get(RENDERER_GATES_KEY) ?? []).toEqual(listBefore);

    // Without the note, the same pause takes the next place and its own step's screen.
    redis.store.delete(REPEAT_KEY);
    row.status = "running";
    await firstPause("task-next-1");
    expect(renderers()).toEqual([...shownBefore, SECOND_STEP_ID]);
    expect(row.status).toBe("pending_approval");
  }

  it("a note that cannot be read: the run ends failed with the fixed reason and the pause is not shown", async () => {
    await firstPause("task-list-1");
    // red-first-expect: to deeply equal [ Array(1) ]
    await refusedThenPlaced("{not a note");
  });

  it("a note that names a task that is not the last renderer gate: the run ends failed with the fixed reason and the pause is not shown", async () => {
    await firstPause("task-list-1");
    // The list holds the list step's pause last; the note names another task at place 0.
    // red-first-expect: to deeply equal [ Array(1) ]
    await refusedThenPlaced(JSON.stringify({ taskId: "task-other-1", index: 0 }));
  });

  it("a note whose place is past the limit: the run ends failed and no place is rebuilt", async () => {
    await firstPause("task-list-1");
    // red-first-expect: to deeply equal [ Array(1) ]
    await refusedThenPlaced(JSON.stringify({ taskId: "task-list-1", index: 1_000_000_000 }));
  });
});

describe("cinatra#3562 — the places of a run's renderer gates are bounded", () => {
  const REPEAT_KEY = `cinatra:wayflow:renderer-gate-repeat:${RUN.id}`;

  it("a stored policy whose steps are no list, or hold an entry that is no object, cannot be read: it is never a flow with no step", async () => {
    const { rendererGateStepsOf, rendererGateIndexOfRenderer, stepFiresRendererGate } = await import("../orchestrator-gate-predicate");
    // red-first-expect: rendererGateStepsOf is not a function
    expect(rendererGateStepsOf("steps")).toBeNull();
    expect(rendererGateStepsOf(undefined)).toBeNull();
    expect(rendererGateStepsOf({ 0: { xRenderer: "a" } })).toBeNull();
    for (const bad of [null, 7, "x", []]) {
      expect(rendererGateStepsOf([bad, { xRenderer: "a" }, { xRenderer: "list" }])).toBeNull();
    }
    expect(rendererGateStepsOf([])).toEqual([]);
    const readable = rendererGateStepsOf([{ xRenderer: "a" }, { xRenderer: "list" }]);
    expect(readable).toEqual([{ xRenderer: "a" }, { xRenderer: "list" }]);
    expect(readable!.filter(stepFiresRendererGate).length).toBe(2);
    expect(rendererGateIndexOfRenderer(readable!, "list")).toBe(1);
  });

  it("the place from the steps refuses a gate count or a place past its limit", async () => {
    const { rendererGateIndexOfRenderer, RENDERER_GATE_STEP_GATE_COUNT_LIMIT, RENDERER_GATE_INDEX_LIMIT } = await import("../orchestrator-gate-predicate");
    const s = (xRenderer: string, extra: Record<string, unknown> = {}) => ({ xRenderer, ...extra });
    // red-first-expect: rendererGateIndexOfRenderer is not a function
    expect(rendererGateIndexOfRenderer([s("a", { gateCount: 1_000_000_000 }), s("list")], "list")).toBeNull();
    expect(RENDERER_GATE_STEP_GATE_COUNT_LIMIT).toBe(64);
    expect(RENDERER_GATE_INDEX_LIMIT).toBe(1024);
    // The list's own limit (packages/a2a) is the same.
    const { RENDERER_GATE_PLACE_LIMIT } = await import("@cinatra-ai/a2a");
    expect(RENDERER_GATE_PLACE_LIMIT).toBe(RENDERER_GATE_INDEX_LIMIT);
    expect(rendererGateIndexOfRenderer([s("a", { gateCount: 65 }), s("list")], "list")).toBeNull();
    expect(rendererGateIndexOfRenderer([s("a", { gateCount: 1.5 }), s("list")], "list")).toBeNull();
    expect(rendererGateIndexOfRenderer([s("a", { gateCount: 0 }), s("list")], "list")).toBeNull();
    expect(rendererGateIndexOfRenderer([s("a", { gateCount: Number.POSITIVE_INFINITY }), s("list")], "list")).toBeNull();
    // A step after the list step is checked too.
    expect(rendererGateIndexOfRenderer([s("list"), s("b", { gateCount: 1_000_000_000 })], "list")).toBeNull();
    expect(rendererGateIndexOfRenderer([s("a", { gateCount: 64 }), s("list")], "list")).toBe(64);
    const many = (count: number) => Array.from({ length: count }, (_, i) => s(`a${i}`, { gateCount: 64 }));
    expect(rendererGateIndexOfRenderer([...many(15), s("list")], "list")).toBe(960);
    expect(rendererGateIndexOfRenderer([...many(16), s("list")], "list")).toBeNull();
  });

  it("a huge gate count on an earlier step after the list expired: the refresh is refused, nothing is sent, and no place is rebuilt", async () => {
    const FIRST_STEP_ID = "@cinatra-ai/email-outreach-agent:account-scope";
    const [listStep, secondStep] = TEMPLATE.approvalPolicy.steps;
    await firstPause("task-list-1");
    // The policy is replaced while the run waits: an earlier step now claims a huge gate count.
    storeMock.readAgentTemplateById.mockResolvedValue({
      ...TEMPLATE,
      approvalPolicy: { steps: [{ ...listStep, stepNumber: 1, xRenderer: FIRST_STEP_ID, gateCount: 1_000_000_000 }, { ...listStep, stepNumber: 2 }, { ...secondStep, stepNumber: 3 }] },
    });
    redis.lists.delete(RENDERER_GATES_KEY);
    const evalCalls = vi.spyOn(redis.FakeRedis.prototype, "eval");

    // red-first-expect: buildListStepRefreshPayload is not a function
    await expect(refresh("task-list-1", "task-list-2")).rejects.toThrow("its place in the run's steps is not known");
    expect(sendTask).not.toHaveBeenCalled();
    expect(redis.store.has(REPEAT_KEY)).toBe(false);
    expect(redis.lists.has(RENDERER_GATES_KEY)).toBe(false);
    // The rebuild of the list (the commit script) is never sent.
    expect(evalCalls.mock.calls.filter((call) => call[1] === 3)).toEqual([]);
    evalCalls.mockRestore();
  });

  it("a note that carries a place past the limit is refused on read, and its list is not rebuilt", async () => {
    const { getOrAddWayflowRendererGateIndex } = await import("@cinatra-ai/a2a");
    const evalCalls = vi.spyOn(redis.FakeRedis.prototype, "eval");
    for (const index of [1024, 1_000_000_000]) {
      redis.store.set(REPEAT_KEY, JSON.stringify({ taskId: "task-list-1", index }));
      // red-first-expect: promise resolved "+0" instead of rejecting
      await expect(getOrAddWayflowRendererGateIndex(RUN.id, "task-list-2")).rejects.toMatchObject({ code: "renderer_gate_place_unknown" });
      expect(redis.lists.has(RENDERER_GATES_KEY)).toBe(false);
      expect(redis.store.has(REPEAT_KEY)).toBe(true);
    }
    expect(evalCalls.mock.calls.filter((call) => call[1] === 3)).toEqual([]);
    evalCalls.mockRestore();
    // The last place within the limit is restored.
    redis.store.set(REPEAT_KEY, JSON.stringify({ taskId: "task-list-1", index: 1023 }));
    expect(await getOrAddWayflowRendererGateIndex(RUN.id, "task-list-2")).toBe(1023);
    expect(redis.lists.get(RENDERER_GATES_KEY)).toHaveLength(1024);
  });

  it("the commit script itself refuses a place past the limit, whatever its caller read", async () => {
    const { getOrAddWayflowRendererGateIndex } = await import("@cinatra-ai/a2a");
    const evalCalls = vi.spyOn(redis.FakeRedis.prototype, "eval");
    expect(await getOrAddWayflowRendererGateIndex(RUN.id, "task-list-1")).toBe(0);
    const commit = evalCalls.mock.calls.find((call) => call[1] === 3);
    evalCalls.mockRestore();
    const script = String(commit?.[0]);
    // red-first-expect: expected 'undefined' to contain 'or at >= 1024 then return -1 end'
    expect(script).toContain("or at >= 1024 then return -1 end");
    expect(script).toContain("if tonumber(ARGV[6]) + tonumber(ARGV[7]) > 1024 then return -1 end");
    // A rebuild of an expired list up to place 1024, sent straight to the script: refused, nothing written.
    redis.lists.delete(RENDERER_GATES_KEY);
    const note = JSON.stringify({ taskId: "task-list-1", index: 1024 });
    redis.store.set(REPEAT_KEY, note);
    const vacant = Array.from({ length: 1024 }, () => "");
    const fake = new redis.FakeRedis();
    const args = [RENDERER_GATES_KEY, REPEAT_KEY, `cinatra:wayflow:renderer-gate-replaced:${RUN.id}`, note, String(SEVEN_DAYS_S), "task-list-2"];
    expect(await fake.eval(script, 3, ...args, "1024", "task-list-1", "0", "1025", ...vacant, "task-list-2")).toBe(-1);
    expect(await fake.eval(script, 3, ...args, "1e9", "task-list-1", "0", "1", "task-list-2")).toBe(-1);
    expect(await fake.eval(script, 3, ...args, "-1", "task-list-1", "0", "1", "task-list-2")).toBe(-1);
    expect(redis.lists.has(RENDERER_GATES_KEY)).toBe(false);
    expect(redis.store.get(REPEAT_KEY)).toBe(note);
  });
});

describe("cinatra#3562 — a step that cannot be told is never refreshed and never shown under another screen", () => {
  const REPEAT_KEY = `cinatra:wayflow:renderer-gate-repeat:${RUN.id}`;
  const [listStep, secondStep] = TEMPLATE.approvalPolicy.steps;

  /** The refresh of the paused list step is refused: nothing is sent, no note is left, and the step waits again. */
  async function refreshRefused(): Promise<void> {
    let refusal: unknown = null;
    await refresh("task-list-1", "task-list-2").catch((error: unknown) => {
      refusal = error;
    });
    expect(String((refusal as Error | null)?.message)).toContain("takes no list step refresh now: its step is not among the flow's steps");
    expect(sendTask).not.toHaveBeenCalled();
    expect(redis.store.has(REPEAT_KEY)).toBe(false);
    expect(row.status).toBe("pending_approval");
    expect(storeMock.transitionRunStatus).toHaveBeenLastCalledWith(
      RUN.id,
      "running",
      "pending_approval",
      { pauseTaskId: "task-list-1" },
      expect.anything(),
    );
    expect(renderers()).toEqual([LIST_STEP_ID]);
  }

  it.each([
    ["is replaced by {}", {}],
    ["holds a step that is no object", { steps: [null, listStep, secondStep] }],
    ["holds one step that is not the list step", { steps: [secondStep] }],
    ["holds no step", { steps: [] }],
  ])("the policy %s while the run waits at the list step: Try again is refused", async (_label, approvalPolicy) => {
    await firstPause("task-list-1");
    storeMock.readAgentTemplateById.mockResolvedValue({ ...TEMPLATE, approvalPolicy });
    // red-first-expect: buildListStepRefreshPayload is not a function
    await refreshRefused();
  });

  /** The run is pinned to version 1.0.0, whose snapshot holds the policy the run was started with. */
  function pinRunToSnapshot(approvalPolicy: unknown): void {
    runPin.packageVersion = "1.0.0";
    const bySemver = async (templateId: string, semver: string) =>
      templateId === RUN.templateId && semver === "1.0.0"
        ? ({ templateId, semver, snapshot: { compiledPlan: [], taskSpec: null, approvalPolicy } } as never)
        : null;
    (storeMock.readAgentTemplateVersionBySemver as unknown as { mockImplementation: (f: typeof bySemver) => void }).mockImplementation(bySemver);
  }
  const reordered = () => ({
    ...TEMPLATE,
    approvalPolicy: { steps: [{ ...listStep, xRenderer: "@cinatra-ai/email-outreach-agent:account-scope" }, secondStep, listStep] },
  });

  it("the agent is edited while a pinned run waits at the list step: Try again uses the run's own steps, keeps the list step, and a pick reaches the second step", async () => {
    pinRunToSnapshot(TEMPLATE.approvalPolicy);
    await firstPause("task-list-1");
    // The live template now orders its steps differently; the running graph does not.
    storeMock.readAgentTemplateById.mockResolvedValue(reordered());
    // red-first-expect: buildListStepRefreshPayload is not a function
    await refresh("task-list-1", "task-list-2");
    expect(sendTask).toHaveBeenCalledTimes(1);
    expect(renderers()).toEqual([LIST_STEP_ID, LIST_STEP_ID]);
    await pick("task-list-2", "task-second-1");
    expect(renderers()).toEqual([LIST_STEP_ID, LIST_STEP_ID, SECOND_STEP_ID]);
    expect(row.status).toBe("pending_approval");
  });

  it("a pinned run whose required snapshot cannot be served: the pause is not shown", async () => {
    runPin.packageVersion = "1.0.0";
    runPin.versionId = "snapshot-gone";
    storeMock.readAgentTemplateVersionById.mockResolvedValue(null);
    // red-first-expect: expected [ Array(1) ] to deeply equal []
    await nextPauseNotShown();
  });

  it("an unpinned run reads the live template: a step put before the list step while it waits makes its place differ, so Try again is refused and the step waits as before", async () => {
    await firstPause("task-list-1");
    const firstStep = { ...listStep, xRenderer: "@cinatra-ai/email-outreach-agent:account-scope" };
    storeMock.readAgentTemplateById.mockResolvedValue({ ...TEMPLATE, approvalPolicy: { steps: [firstStep, listStep, secondStep] } });
    // red-first-expect: buildListStepRefreshPayload is not a function
    await expect(refresh("task-list-1", "task-list-2")).rejects.toThrow("its place in the run's steps is not known");
    expect(sendTask).not.toHaveBeenCalled();
    expect(redis.store.has(REPEAT_KEY)).toBe(false);
    expect(row.status).toBe("pending_approval");
  });

  /** The next pause arrives on a resumed run: it is not shown, and the run ends failed with the fixed reason. */
  async function nextPauseNotShown(): Promise<void> {
    const shownBefore = renderers();
    row.status = "running";
    await firstPause("task-next-1");
    expect(renderers()).toEqual(shownBefore);
    expect(row.status).toBe("failed");
    expect(storeMock.transitionRunStatus).toHaveBeenLastCalledWith(
      RUN.id,
      "running",
      "failed",
      { error: RENDERER_GATE_PLACE_UNKNOWN_RUN_ERROR },
      expect.anything(),
    );
  }

  it("the refresh note cannot be read (a Redis fault) at the next pause of a flow of two renderer steps: the pause is not shown", async () => {
    await firstPause("task-list-1");
    const get = vi.spyOn(redis.FakeRedis.prototype, "get").mockImplementation(async (key: string) => {
      if (key === REPEAT_KEY) throw new Error("Connection is closed.");
      return redis.store.get(key) ?? null;
    });
    // red-first-expect: to deeply equal [ Array(1) ]
    await nextPauseNotShown();
    get.mockRestore();
  });

  it("the commit of the next pause's place fails (a Redis fault) in a flow of two renderer steps: the pause is not shown", async () => {
    await firstPause("task-list-1");
    const evalCall = vi.spyOn(redis.FakeRedis.prototype, "eval").mockImplementation(async () => {
      throw new Error("Connection is closed.");
    });
    // red-first-expect: to deeply equal [ Array(1) ]
    await nextPauseNotShown();
    evalCall.mockRestore();
  });

  it("the next pause of a flow of two renderer steps is past its last step: the pause is not shown", async () => {
    await firstPause("task-list-1");
    row.status = "running";
    await firstPause("task-second-1");
    expect(renderers()).toEqual([LIST_STEP_ID, SECOND_STEP_ID]);
    // red-first-expect: to deeply equal [ …(2) ]
    await nextPauseNotShown();
  });

  it.each([
    ["is replaced by {}", {}],
    ["holds a step that is no object", { steps: [null, listStep, secondStep] }],
    ["holds a step whose gate count is past the limit", { steps: [listStep, { ...secondStep, gateCount: 1_000_000_000 }] }],
  ])("the policy %s at a pause: the pause is not shown", async (_label, approvalPolicy) => {
    storeMock.readAgentTemplateById.mockResolvedValue({ ...TEMPLATE, approvalPolicy });
    // red-first-expect: expected [ Array(1) ] to deeply equal []
    await nextPauseNotShown();
  });

  it("the policy cannot be read at a pause (its read fails): the pause is not shown", async () => {
    storeMock.readAgentTemplateById.mockRejectedValue(new Error("the database is unreachable"));
    // red-first-expect: expected [ Array(1) ] to deeply equal []
    await nextPauseNotShown();
  });

  it("a readable flow of one renderer step keeps its own screen through a Redis fault", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue({ ...TEMPLATE, approvalPolicy: { steps: [listStep] } });
    const lrange = vi.spyOn(redis.FakeRedis.prototype, "lrange").mockImplementation(async () => {
      throw new Error("Connection is closed.");
    });
    await firstPause("task-list-1");
    lrange.mockRestore();
    expect(renderers()).toEqual([LIST_STEP_ID]);
    expect(row.status).toBe("pending_approval");
  });

  it("a readable flow with no renderer step still takes the fallback screen", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue({ ...TEMPLATE, approvalPolicy: { steps: [{ stepNumber: 1, requiresApproval: true }] } });
    await firstPause("task-plain-1");
    expect(renderers()).toEqual([SCHEMA_FIELD_FALLBACK_RENDERER_ID]);
    expect(row.status).toBe("pending_approval");
  });
});

describe("cinatra#3562 — a refresh note never outlives the answer to its step, and the refresh value is the one the pause recorded", () => {
  const REPEAT_KEY = `cinatra:wayflow:renderer-gate-repeat:${RUN.id}`;
  const [listStep, secondStep] = TEMPLATE.approvalPolicy.steps;
  const answerList = (taskId: string) =>
    approveReviewTaskInternal(`wayflow-${taskId}`, RUN.runBy, { approved: true, userResponse: JSON.stringify({ listIds: ["list-a"], listNames: ["List A"] }) });

  it("a note left by an unsent refresh is removed by the real answer even when the run's steps cannot be read at that moment, so the next pause takes its own step", async () => {
    runPin.packageVersion = "1.0.0";
    const bySemver = async (templateId: string, semver: string) =>
      ({ templateId, semver, snapshot: { compiledPlan: [], taskSpec: null, approvalPolicy: TEMPLATE.approvalPolicy } }) as never;
    const semverMock = storeMock.readAgentTemplateVersionBySemver as unknown as {
      mockImplementation: (f: typeof bySemver) => void;
      mockImplementationOnce: (f: () => Promise<never>) => void;
    };
    semverMock.mockImplementation(bySemver);
    await firstPause("task-list-1");
    // An unsent refresh of this step left its note.
    redis.store.set(REPEAT_KEY, JSON.stringify({ taskId: "task-list-1", index: 0 }));
    // The answer's read of the run's steps fails once.
    semverMock.mockImplementationOnce(async () => {
      throw new Error("the version store is unreachable");
    });
    const noteAtSend: boolean[] = [];
    sendTask.mockImplementationOnce(async () => {
      noteAtSend.push(redis.store.has(REPEAT_KEY));
      return pauseTask("task-second-1");
    });
    // red-first-expect: expected [ true ] to deeply equal [ false ]
    await answerList("task-list-1");
    expect(noteAtSend).toEqual([false]);
    expect(renderers()).toEqual([LIST_STEP_ID, SECOND_STEP_ID]);
  });

  it("a real answer whose note removal fails is not sent, and the step waits again", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue({ ...TEMPLATE, approvalPolicy: { steps: [listStep] } });
    await firstPause("task-list-1");
    const get = vi.spyOn(redis.FakeRedis.prototype, "get").mockImplementation(async (key: string) => {
      if (key === REPEAT_KEY) throw new Error("Connection is closed.");
      return redis.store.get(key) ?? null;
    });
    try {
      // red-first-expect: to throw error including 'Connection is closed.' but got 'Continue task identity mismatch'
      await expect(answerList("task-list-1")).rejects.toThrow("Connection is closed.");
    } finally {
      get.mockRestore();
    }
    expect(sendTask).not.toHaveBeenCalled();
    expect(row.status).toBe("pending_approval");
  });

  it("the pause records its list step's refresh value; a later change of the binding does not change what Try again sends", async () => {
    await firstPause("task-list-1");
    // The deployment now declares another value.
    listBinding.params = { refreshValue: "reload" };
    // The new value is not taken for a pause recorded under the old one.
    // red-first-expect: buildListStepRefreshPayload is not a function
    await expect(
      approveReviewTaskInternal("wayflow-task-list-1", RUN.runBy, buildListStepRefreshPayload("reload")),
    ).rejects.toThrow("takes no such list step refresh");
    expect(sendTask).not.toHaveBeenCalled();
    // The recorded value is taken and sent, and the next pause keeps the list step.
    sendTask.mockResolvedValueOnce(pauseTask("task-list-2"));
    await approveReviewTaskInternal("wayflow-task-list-1", RUN.runBy, buildListStepRefreshPayload("refresh"));
    expect(sendTask).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sendTask.mock.calls[0])).toContain('"refresh"');
    expect(JSON.stringify(sendTask.mock.calls[0])).not.toContain("reload");
    expect(renderers()).toEqual([LIST_STEP_ID, LIST_STEP_ID]);
  });

  const reportPauseAgain = (taskId: string) =>
    handleWayflowTaskState({ authority: TEST_AUTHORITY as never, runId: RUN.id, run: liveRun() as never, fromStatus: "pending_approval", task: pauseTask(taskId) as never });

  it("a later report of the same pause keeps the refresh value recorded at its first record, whatever the binding declares now", async () => {
    await firstPause("task-list-1");
    listBinding.params = { refreshValue: "reload" };
    await reportPauseAgain("task-list-1");
    // red-first-expect: buildListStepRefreshPayload is not a function
    await expect(
      approveReviewTaskInternal("wayflow-task-list-1", RUN.runBy, buildListStepRefreshPayload("reload")),
    ).rejects.toThrow("takes no such list step refresh");
    expect(sendTask).not.toHaveBeenCalled();
    sendTask.mockResolvedValueOnce(pauseTask("task-list-2"));
    await approveReviewTaskInternal("wayflow-task-list-1", RUN.runBy, buildListStepRefreshPayload("refresh"));
    expect(JSON.stringify(sendTask.mock.calls[0])).toContain('"refresh"');
    expect(JSON.stringify(sendTask.mock.calls[0])).not.toContain("reload");
  });

  it("a later report of a pause first recorded without a refresh value records none, after a deployment declares one", async () => {
    listBinding.params = {};
    await firstPause("task-list-1");
    listBinding.params = { refreshValue: "refresh" };
    await reportPauseAgain("task-list-1");
    // red-first-expect: buildListStepRefreshPayload is not a function
    await expect(refresh("task-list-1", "task-list-2")).rejects.toThrow("takes no such list step refresh");
    expect(sendTask).not.toHaveBeenCalled();
  });

  it("a later report whose read of the first record fails records no refresh value, so no other value can be sent", async () => {
    await firstPause("task-list-1");
    listBinding.params = { refreshValue: "reload" };
    durableGate.readFails = true;
    try {
      await reportPauseAgain("task-list-1");
    } finally {
      durableGate.readFails = false;
    }
    // red-first-expect: buildListStepRefreshPayload is not a function
    await expect(
      approveReviewTaskInternal("wayflow-task-list-1", RUN.runBy, buildListStepRefreshPayload("reload")),
    ).rejects.toThrow("takes no such list step refresh");
    expect(sendTask).not.toHaveBeenCalled();
  });

  it("a pause recorded while no binding declared a refresh value takes no refresh, even after a deployment declares one", async () => {
    listBinding.params = {};
    await firstPause("task-list-1");
    listBinding.params = { refreshValue: "refresh" };
    // red-first-expect: buildListStepRefreshPayload is not a function
    await expect(refresh("task-list-1", "task-list-2")).rejects.toThrow("takes no such list step refresh");
    expect(sendTask).not.toHaveBeenCalled();
    expect(row.status).toBe("pending_approval");
  });
});
