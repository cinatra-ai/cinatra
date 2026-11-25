/**
 * cinatra#3562 — after a list step's Try again the run pauses at the same list
 * step again, and that pause carries the list step's screen, not the screen of
 * the step after it.
 *
 * A pause is mapped to its step by its place in the run's renderer pauses
 * (`getOrAddWayflowRendererGateIndex`), and every resume returns a fresh task
 * id. The runtime signs the node that paused the run on every pause (the
 * `cinatra_gate_node` claim, cinatra#3745). The rule: a pause whose VERIFIED
 * node is the node of the run's last placed renderer pause is that step again
 * and takes its place. A pause with no claim, or a claim that does not verify,
 * is placed as before (appended), and a refresh of a pause without a verified
 * node is refused in a flow with more than one renderer step.
 *
 * The refresh and the pick go through the real resume road
 * (`approveReviewTaskInternal`) and the real state handler
 * (`handleWayflowTaskState`), which the resume road calls with the task the
 * runtime returns. The place records live in an in-memory `ioredis` double
 * under the real `@cinatra-ai/a2a` functions. The resolved renderer is the
 * second argument of the adapter's `onInterrupt`.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/list-step-refresh-renderer-3562.test.ts
 */
import { createHmac } from "node:crypto";
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

import { RunTransitionError } from "../run-status";
import { buildListStepRefreshPayload } from "../hitl-gate-submit";

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
  /** The run's other record with the highest recorded place, as the store's query orders them. */
  readLastPlacedDurableRendererGate: async (_runId: string, exceptReviewTaskId: string) => {
    if (durableGate.readFails) throw new Error("gate record read failed");
    let best: { reviewTaskId: string; inputSchema: Record<string, unknown> } | null = null;
    for (const [reviewTaskId, record] of durableGate.rows) {
      const schema = (record.inputSchema ?? {}) as Record<string, unknown>;
      const place = schema["x-cinatra-gate-place"];
      if (reviewTaskId === exceptReviewTaskId || typeof place !== "number") continue;
      if (best === null || place >= (best.inputSchema["x-cinatra-gate-place"] as number)) best = { reviewTaskId, inputSchema: schema };
    }
    return best;
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
 */
const redis = vi.hoisted(() => {
  const store = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const hashes = new Map<string, Map<string, string>>();
  const ttls = new Map<string, number>();
  /** When set, the write of a pause's signed node claim fails. */
  const faults = { claimWriteFails: false };
  const has = (key: string) => store.has(key) || lists.has(key) || hashes.has(key);
  class FakeRedis {
    async set(key: string, value: string, mode?: string, seconds?: number): Promise<"OK"> {
      if (faults.claimWriteFails && key.startsWith("cinatra:wayflow:gate-node:")) throw new Error("claim write failed");
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
    async expire(key: string, seconds: number): Promise<number> {
      if (!has(key)) return 0;
      ttls.set(key, seconds);
      return 1;
    }
    async ttl(key: string): Promise<number> {
      if (!has(key)) return -2;
      return ttls.get(key) ?? -1;
    }
    async hset(key: string, field: string, value: string): Promise<number> {
      const hash = hashes.get(key) ?? new Map<string, string>();
      hash.set(field, value);
      hashes.set(key, hash);
      return 1;
    }
    /**
     * The renderer pause place script (two keys: the list and the node hash),
     * RUN AS SHIPPED: the script text the code sends is turned line by line
     * into JavaScript (the few Lua forms it uses) and runs on the same maps in
     * one synchronous call, as Redis runs a script. Lua tables count from 1, so
     * a list read answers with an empty first slot. Any other script answers
     * "absent".
     */
    async eval(script: string, numKeys: number, ...rest: string[]): Promise<number | string> {
      if (numKeys !== 2 || !rest[0].startsWith("cinatra:wayflow:renderer-gates:")) return "absent";
      const call = (command: string, key: string, ...args: Array<string | number>): unknown => {
        switch (command) {
          case "LRANGE":
            return [null, ...(lists.get(key) ?? [])];
          case "RPUSH": {
            const list = lists.get(key) ?? [];
            list.push(...args.map(String));
            lists.set(key, list);
            return list.length;
          }
          case "HGET":
            return hashes.get(key)?.get(String(args[0])) ?? null;
          case "HSET": {
            const hash = hashes.get(key) ?? new Map<string, string>();
            hash.set(String(args[0]), String(args[1]));
            hashes.set(key, hash);
            return 1;
          }
          case "HDEL": {
            const hash = hashes.get(key);
            const had = hash?.delete(String(args[0])) ?? false;
            if (hash && hash.size === 0) hashes.delete(key);
            return had ? 1 : 0;
          }
          case "DEL":
            ttls.delete(key);
            return (lists.delete(key) ? 1 : 0) + (hashes.delete(key) ? 1 : 0);
          case "EXPIRE":
            if (!has(key)) return 0;
            ttls.set(key, Number(args[0]));
            return 1;
          default:
            throw new Error(`the place script called ${command}, which this double does not know`);
        }
      };
      const js = script
        .replace(/local function (\w+)\(\)/g, "const $1 = () => {")
        .replace(/\blocal\b/g, "let")
        .replace(/for (\w+) = 1, #(\w+) do/g, "for (let $1 = 1; $1 <= $2.length - 1; $1++) {")
        .replace(/for (\w+) = 1, (\w+) do/g, "for (let $1 = 1; $1 <= $2; $1++) {")
        .replace(/#(\w+)/g, "($1.length - 1)")
        .replace(/\bif (.+) then (.+) end$/gm, "if ($1) { $2 }")
        .replace(/\bif (.+) then$/gm, "if ($1) {")
        .replace(/^\s*else\s*$/gm, "} else {")
        .replace(/^\s*end\s*$/gm, "}")
        .replace(/ ~= /g, " !== ")
        .replace(/ == /g, " === ")
        .replace(/ and /g, " && ")
        .replace(/ \.\. /g, " + ")
        .replace(/redis\.call\(/g, "call(")
        .replace(/tonumber\(/g, "Number(");
      const [listKey, nodesKey, ...argv] = rest;
      return new Function("KEYS", "ARGV", "call", js)([null, listKey, nodesKey], [null, ...argv], call) as number;
    }
    async quit(): Promise<"OK"> {
      return "OK";
    }
    on(): this {
      return this;
    }
  }
  return { store, lists, hashes, ttls, faults, FakeRedis };
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

/** The runtime's signing key for the pause claims (CINATRA_CONTEXT_ATTEST_KEY). */
const ATTEST_KEY = "attest-key-3562";
/** The flow nodes: the list step's gate, the step after it, and a second list step's gate. */
const LIST_NODE = "recipients-scope_gate";
const SECOND_NODE = "recipients-review_gate";
const OTHER_LIST_NODE = "recipients-rescope_gate";

/** How a pause names its node: signed (the default), not at all, or with a signature that does not verify. */
type Claim = "signed" | "none" | "forged";

/**
 * A pause the runtime reports: `node` is the node that paused the run, carried
 * as the loader signs it on the last agent message (`cinatra_gate_node`).
 */
function pauseTask(id: string, node: string | null = LIST_NODE, claim: Claim = "signed", text?: string) {
  const attestation =
    claim === "forged"
      ? `g1:${createHmac("sha256", "another-key").update(`g1\n${RUN.a2aContextId}\n${id}\n${node}`).digest("hex")}`
      : `g1:${createHmac("sha256", ATTEST_KEY).update(`g1\n${RUN.a2aContextId}\n${id}\n${node}`).digest("hex")}`;
  const metadata = node !== null && claim !== "none" ? { cinatra_gate_node: { node, attestation } } : {};
  const parts = text === undefined ? [] : [{ kind: "text", text }];
  return {
    id,
    contextId: RUN.a2aContextId,
    status: { state: "input-required", message: { parts: [] } },
    metadata: {},
    history: [{ role: "agent", parts, metadata }],
  };
}

const renderers = (): string[] => onInterruptSpy.mock.calls.map((call) => call[1] as string);

/** The runtime parks at `next`; the operator answers the pause `taskId`. */
async function answer(taskId: string, next: ReturnType<typeof pauseTask>, values: Record<string, unknown>): Promise<void> {
  sendTask.mockResolvedValueOnce(next);
  await approveReviewTaskInternal(`wayflow-${taskId}`, RUN.runBy, values);
}
/** Try again on `taskId`; the runtime pauses at the list step's node again as `nextTaskId`. */
const refresh = (taskId: string, nextTaskId: string, node: string | null = LIST_NODE, claim: Claim = "signed") =>
  answer(taskId, pauseTask(nextTaskId, node, claim), buildListStepRefreshPayload("refresh"));
/** A pick on `taskId`; the runtime pauses at the next step's node as `nextTaskId`. */
const pick = (taskId: string, nextTaskId: string, node: string | null = SECOND_NODE, claim: Claim = "signed") =>
  answer(taskId, pauseTask(nextTaskId, node, claim), {
    approved: true,
    userResponse: JSON.stringify({ listIds: ["list-a"], listNames: ["List A"] }),
  });

async function firstPause(taskId: string, node: string | null = LIST_NODE, claim: Claim = "signed"): Promise<void> {
  await handleWayflowTaskState({ authority: TEST_AUTHORITY as never, runId: RUN.id, run: liveRun() as never, fromStatus: "running", task: pauseTask(taskId, node, claim) as never });
}
/** The runtime reports a pause it already reported (a reconnect, a retry). */
async function reportAgain(taskId: string, node: string | null = LIST_NODE): Promise<void> {
  await handleWayflowTaskState({ authority: TEST_AUTHORITY as never, runId: RUN.id, run: liveRun() as never, fromStatus: "pending_approval", task: pauseTask(taskId, node) as never });
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
  redis.faults.claimWriteFails = false;
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
  process.env.CINATRA_CONTEXT_ATTEST_KEY = ATTEST_KEY;
  arrange();
  await firstPause("warm-up").catch(() => undefined);
}, 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  arrange();
});

const RENDERER_GATES_KEY = `cinatra:wayflow:renderer-gates:${RUN.id}`;
const NODES_KEY = `cinatra:wayflow:renderer-gate-nodes:${RUN.id}`;
const NOT_KNOWN = "takes no list step refresh: the step it waits at is not known";
/** The step number each pause's screen was drawn for, in order. */
const stepNumbers = (): unknown[] => onInterruptSpy.mock.calls.map((call) => (call[2] as Record<string, unknown>).stepNumber);

describe("cinatra#3562 — a pause on the node of the last placed pause is that step again", () => {
  it("the pause after a refresh keeps the list step's place and screen, and the pick after it reaches the next step's screen", async () => {
    await firstPause("task-list-1");
    expect(renderers()).toEqual([LIST_STEP_ID]);

    // red-first-expect: buildListStepRefreshPayload is not a function
    await refresh("task-list-1", "task-list-2");
    expect(renderers()).toEqual([LIST_STEP_ID, LIST_STEP_ID]);
    expect(redis.lists.get(RENDERER_GATES_KEY)).toEqual(["task-list-1"]);

    await pick("task-list-2", "task-second-1");
    expect(renderers()).toEqual([LIST_STEP_ID, LIST_STEP_ID, SECOND_STEP_ID]);
    expect(stepNumbers()).toEqual([1, 1, 2]);
    expect(row.status).toBe("pending_approval");
  });

  it("repeated refreshes always keep the same place", async () => {
    await firstPause("task-list-1");
    // red-first-expect: buildListStepRefreshPayload is not a function
    await refresh("task-list-1", "task-list-2");
    await refresh("task-list-2", "task-list-3");
    await refresh("task-list-3", "task-list-4");
    expect(renderers()).toEqual([LIST_STEP_ID, LIST_STEP_ID, LIST_STEP_ID, LIST_STEP_ID]);

    await pick("task-list-4", "task-second-1");
    expect(renderers().at(-1)).toBe(SECOND_STEP_ID);
  });

  it("a pause on another node advances to the next place, as before (guard)", async () => {
    await firstPause("task-list-1");
    await pick("task-list-1", "task-second-1");
    expect(renderers()).toEqual([LIST_STEP_ID, SECOND_STEP_ID]);
    expect(redis.lists.get(RENDERER_GATES_KEY)).toEqual(["task-list-1", "task-second-1"]);
  });

  it("a pause reported again keeps its place, before and after a refresh", async () => {
    await firstPause("task-list-1");
    await reportAgain("task-list-1");
    // red-first-expect: buildListStepRefreshPayload is not a function
    await refresh("task-list-1", "task-list-2");
    await reportAgain("task-list-2");
    await reportAgain("task-list-1");
    expect(renderers()).toEqual([LIST_STEP_ID, LIST_STEP_ID, LIST_STEP_ID, LIST_STEP_ID, LIST_STEP_ID]);

    await pick("task-list-2", "task-second-1");
    await reportAgain("task-second-1", SECOND_NODE);
    expect(renderers().slice(-2)).toEqual([SECOND_STEP_ID, SECOND_STEP_ID]);
  });

  it("a context gate between the refresh and the list step's next pause takes no place", async () => {
    await firstPause("task-list-1");
    const contextAsk = JSON.stringify({ slotMeta: { slotId: "slot-1", resolutionMode: "ask" }, candidates: [], selectedRefs: [] });
    // red-first-expect: buildListStepRefreshPayload is not a function
    await answer("task-list-1", pauseTask("task-context-1", "context_gate", "signed", contextAsk), buildListStepRefreshPayload("refresh"));
    expect(redis.lists.get(RENDERER_GATES_KEY)).toEqual(["task-list-1"]);
    // The context ask is answered and the run pauses at the list step again.
    await answer("task-context-1", pauseTask("task-list-2", LIST_NODE), { approved: true, userResponse: "{}" });
    expect(renderers().at(-1)).toBe(LIST_STEP_ID);
    expect(redis.lists.get(RENDERER_GATES_KEY)).toEqual(["task-list-1"]);

    await pick("task-list-2", "task-second-1");
    expect(renderers().at(-1)).toBe(SECOND_STEP_ID);
  });
});

describe("cinatra#3562 — two list steps share one renderer", () => {
  const SHARED_TEMPLATE = {
    ...TEMPLATE,
    approvalPolicy: {
      steps: [
        { ...TEMPLATE.approvalPolicy.steps[0], stepNumber: 1 },
        { ...TEMPLATE.approvalPolicy.steps[0], stepNumber: 2 },
        { ...TEMPLATE.approvalPolicy.steps[1], stepNumber: 3 },
      ],
    },
  };

  it("each list step's Try again keeps its own place, and the step after them gets its own screen", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue(SHARED_TEMPLATE);
    await firstPause("task-a-1", LIST_NODE);
    // red-first-expect: buildListStepRefreshPayload is not a function
    await refresh("task-a-1", "task-a-2", LIST_NODE);
    await pick("task-a-2", "task-b-1", OTHER_LIST_NODE);
    await refresh("task-b-1", "task-b-2", OTHER_LIST_NODE);
    await refresh("task-b-2", "task-b-3", OTHER_LIST_NODE);
    await pick("task-b-3", "task-second-1", SECOND_NODE);
    expect(stepNumbers()).toEqual([1, 1, 2, 2, 2, 3]);
    expect(renderers().at(-1)).toBe(SECOND_STEP_ID);
  });
});

describe("cinatra#3562 — without a verified node, pauses are placed as before", () => {
  it("a refresh of a pause with no node claim is refused, and nothing is sent", async () => {
    await firstPause("task-list-1", LIST_NODE, "none");
    // red-first-expect: buildListStepRefreshPayload is not a function
    await expect(refresh("task-list-1", "task-list-2")).rejects.toThrow(NOT_KNOWN);
    expect(sendTask).not.toHaveBeenCalled();
    expect(row.status).toBe("pending_approval");
  });

  it("a refresh of a pause whose claim does not verify is refused, and nothing is sent", async () => {
    await firstPause("task-list-1", LIST_NODE, "forged");
    // red-first-expect: buildListStepRefreshPayload is not a function
    await expect(refresh("task-list-1", "task-list-2")).rejects.toThrow(NOT_KNOWN);
    expect(sendTask).not.toHaveBeenCalled();
    expect(row.status).toBe("pending_approval");
  });

  it("a refresh is refused when the signing key was not set when the pause was recorded", async () => {
    const key = process.env.CINATRA_CONTEXT_ATTEST_KEY;
    delete process.env.CINATRA_CONTEXT_ATTEST_KEY;
    try {
      await firstPause("task-list-1");
    } finally {
      process.env.CINATRA_CONTEXT_ATTEST_KEY = key;
    }
    // red-first-expect: buildListStepRefreshPayload is not a function
    await expect(refresh("task-list-1", "task-list-2")).rejects.toThrow(NOT_KNOWN);
    expect(sendTask).not.toHaveBeenCalled();
  });

  it("a pause verified when it was recorded still refreshes after the signing key is removed", async () => {
    await firstPause("task-list-1");
    const key = process.env.CINATRA_CONTEXT_ATTEST_KEY;
    delete process.env.CINATRA_CONTEXT_ATTEST_KEY;
    try {
      // red-first-expect: buildListStepRefreshPayload is not a function
      await refresh("task-list-1", "task-list-2", null, "none");
    } finally {
      process.env.CINATRA_CONTEXT_ATTEST_KEY = key;
    }
    expect(sendTask).toHaveBeenCalledTimes(1);
  });

  it("a pause after a refresh with a claim that does not verify takes a new place: no place is reused without a verified node", async () => {
    await firstPause("task-list-1");
    // red-first-expect: buildListStepRefreshPayload is not a function
    await refresh("task-list-1", "task-list-2", LIST_NODE, "forged");
    expect(renderers()).toEqual([LIST_STEP_ID, SECOND_STEP_ID]);
    expect(redis.lists.get(RENDERER_GATES_KEY)).toEqual(["task-list-1", "task-list-2"]);
    // An unverified pause clears the last node: a signed pause on the list
    // node after it is not matched across it.
    expect(redis.hashes.get(NODES_KEY)?.get("last")).toBeUndefined();
  });

  it("a pause after a refresh with no claim takes a new place too", async () => {
    await firstPause("task-list-1");
    // red-first-expect: buildListStepRefreshPayload is not a function
    await refresh("task-list-1", "task-list-2", LIST_NODE, "none");
    expect(renderers()).toEqual([LIST_STEP_ID, SECOND_STEP_ID]);
  });
});

describe("cinatra#3562 — when the run's place records expire", () => {
  /** Every Redis record of the run is gone (the seven-day expiry, or never written). */
  const allRedisRecordsGone = () => {
    redis.lists.clear();
    redis.hashes.clear();
    redis.store.clear();
    redis.ttls.clear();
  };
  const SHARED_LIST_TEMPLATE = {
    ...TEMPLATE,
    approvalPolicy: {
      steps: [
        { ...TEMPLATE.approvalPolicy.steps[0], stepNumber: 1 },
        { ...TEMPLATE.approvalPolicy.steps[0], stepNumber: 2 },
        { ...TEMPLATE.approvalPolicy.steps[1], stepNumber: 3 },
      ],
    },
  };

  it("after the records expire (7 days), a pause reported again keeps its step: its place is read from its durable record", async () => {
    await firstPause("task-list-1");
    await pick("task-list-1", "task-second-1");
    allRedisRecordsGone();
    // red-first-expect: expected '@cinatra-ai/email-outreach-agent:list
    await reportAgain("task-second-1", SECOND_NODE);
    expect(renderers().at(-1)).toBe(SECOND_STEP_ID);
  });

  it("a gate that waits ten days still refreshes, and the pause after the refresh keeps the step", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue(SHARED_LIST_TEMPLATE);
    await firstPause("task-a-1", LIST_NODE);
    await pick("task-a-1", "task-b-1", OTHER_LIST_NODE);
    allRedisRecordsGone();
    // red-first-expect: buildListStepRefreshPayload is not a function
    await refresh("task-b-1", "task-b-2", OTHER_LIST_NODE);
    await refresh("task-b-2", "task-b-3", OTHER_LIST_NODE);
    await pick("task-b-3", "task-second-1", SECOND_NODE);
    expect(stepNumbers()).toEqual([1, 2, 2, 2, 3]);
  });

  it("a refresh is taken when the pause's node claim could not be written", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue(SHARED_LIST_TEMPLATE);
    await firstPause("task-a-1", LIST_NODE);
    redis.faults.claimWriteFails = true;
    await pick("task-a-1", "task-b-1", OTHER_LIST_NODE);
    redis.faults.claimWriteFails = false;
    // red-first-expect: buildListStepRefreshPayload is not a function
    await refresh("task-b-1", "task-b-2", OTHER_LIST_NODE);
    expect(stepNumbers()).toEqual([1, 2, 2]);
  });

  it("a pause first recorded without a verified node and reported again with one is repaired: its refresh keeps the step", async () => {
    await firstPause("task-list-1", LIST_NODE, "none");
    await reportAgain("task-list-1");
    // red-first-expect: expected undefined to be 'recipients-scope_gate'
    expect((durableGate.rows.get("wayflow-task-list-1")?.inputSchema as Record<string, unknown>)["x-cinatra-gate-node"]).toBe(LIST_NODE);
    await refresh("task-list-1", "task-list-2");
    expect(renderers().at(-1)).toBe(LIST_STEP_ID);
    await pick("task-list-2", "task-second-1");
    expect(renderers().at(-1)).toBe(SECOND_STEP_ID);
  });

  it("a later report never replaces a recorded node or place", async () => {
    await firstPause("task-list-1");
    await reportAgain("task-list-1", null);
    const schema = durableGate.rows.get("wayflow-task-list-1")?.inputSchema as Record<string, unknown>;
    // red-first-expect: expected undefined to be 'recipients-scope_gate'
    expect(schema["x-cinatra-gate-node"]).toBe(LIST_NODE);
    expect(schema["x-cinatra-gate-place"]).toBe(0);
  });

  const SEVEN_DAYS_S = 7 * 24 * 3600;
  /** Both records age apart (the node hash closer to its end), as if days passed. */
  const ageApart = () => {
    redis.ttls.set(RENDERER_GATES_KEY, 600);
    redis.ttls.set(NODES_KEY, 5);
  };

  it("a pause reported again renews the lifetime of the list and the node records together", async () => {
    await firstPause("task-list-1");
    // red-first-expect: buildListStepRefreshPayload is not a function
    await refresh("task-list-1", "task-list-2");
    ageApart();
    await reportAgain("task-list-1");
    expect([redis.ttls.get(RENDERER_GATES_KEY), redis.ttls.get(NODES_KEY)]).toEqual([SEVEN_DAYS_S, SEVEN_DAYS_S]);
  });

  it("a pause that took an earlier place, reported again, renews both records too", async () => {
    await firstPause("task-list-1");
    // red-first-expect: buildListStepRefreshPayload is not a function
    await refresh("task-list-1", "task-list-2");
    ageApart();
    await reportAgain("task-list-2");
    expect([redis.ttls.get(RENDERER_GATES_KEY), redis.ttls.get(NODES_KEY)]).toEqual([SEVEN_DAYS_S, SEVEN_DAYS_S]);
  });

  it("node records left from an ended list are not read: the place comes from the durable record", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue({
      ...TEMPLATE,
      approvalPolicy: {
        steps: [
          { ...TEMPLATE.approvalPolicy.steps[0], stepNumber: 1 },
          { ...TEMPLATE.approvalPolicy.steps[0], stepNumber: 2 },
          { ...TEMPLATE.approvalPolicy.steps[1], stepNumber: 3 },
        ],
      },
    });
    await firstPause("task-a-1", LIST_NODE);
    await pick("task-a-1", "task-b-1", OTHER_LIST_NODE);
    // red-first-expect: buildListStepRefreshPayload is not a function
    await refresh("task-b-1", "task-b-2", OTHER_LIST_NODE);
    expect(stepNumbers()).toEqual([1, 2, 2]);
    // The list ends alone; the node hash still says task-b-2 is place 1.
    redis.lists.delete(RENDERER_GATES_KEY);
    await reportAgain("task-b-2", OTHER_LIST_NODE);
    // The stale hash is dropped and the place is rebuilt from the durable record.
    expect(stepNumbers().at(-1)).toBe(2);
    expect(redis.hashes.get(NODES_KEY)?.get("task:task-b-2")).toBeUndefined();
    expect(redis.lists.get(RENDERER_GATES_KEY)).toEqual(["~recovered", "task-b-2"]);
    expect(redis.ttls.get(NODES_KEY)).toBe(SEVEN_DAYS_S);
  });
});

describe("cinatra#3562 — the refresh value is the one the pause recorded", () => {
  it("a later change of the binding does not change what Try again sends", async () => {
    await firstPause("task-list-1");
    // The page receives the recorded value with the pause: the hosts send it.
    // red-first-expect: expected undefined to be 'refresh'
    expect((onInterruptSpy.mock.calls[0][0] as Record<string, unknown>)["x-cinatra-list-step-refresh-value"]).toBe("refresh");
    listBinding.params = { refreshValue: "reload" };
    await expect(
      approveReviewTaskInternal("wayflow-task-list-1", RUN.runBy, buildListStepRefreshPayload("reload")),
    ).rejects.toThrow("takes no such list step refresh");
    expect(sendTask).not.toHaveBeenCalled();
    sendTask.mockResolvedValueOnce(pauseTask("task-list-2"));
    await approveReviewTaskInternal("wayflow-task-list-1", RUN.runBy, buildListStepRefreshPayload("refresh"));
    expect(JSON.stringify(sendTask.mock.calls[0])).toContain('"refresh"');
    expect(JSON.stringify(sendTask.mock.calls[0])).not.toContain("reload");
    expect(renderers()).toEqual([LIST_STEP_ID, LIST_STEP_ID]);
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

  it("a later report of the same pause keeps the value of its first record", async () => {
    await firstPause("task-list-1");
    listBinding.params = { refreshValue: "reload" };
    await reportAgain("task-list-1");
    // red-first-expect: buildListStepRefreshPayload is not a function
    await expect(
      approveReviewTaskInternal("wayflow-task-list-1", RUN.runBy, buildListStepRefreshPayload("reload")),
    ).rejects.toThrow("takes no such list step refresh");
    expect(sendTask).not.toHaveBeenCalled();
  });

  it("a later report whose read of the first record fails writes nothing over it: the recorded value still refreshes", async () => {
    await firstPause("task-list-1");
    listBinding.params = { refreshValue: "reload" };
    durableGate.readFails = true;
    try {
      await reportAgain("task-list-1");
    } finally {
      durableGate.readFails = false;
    }
    const schema = durableGate.rows.get("wayflow-task-list-1")?.inputSchema as Record<string, unknown>;
    // red-first-expect: expected undefined to be 'refresh'
    expect(schema["x-cinatra-list-step-refresh-value"]).toBe("refresh");
    await expect(
      approveReviewTaskInternal("wayflow-task-list-1", RUN.runBy, buildListStepRefreshPayload("reload")),
    ).rejects.toThrow("takes no such list step refresh");
    sendTask.mockResolvedValueOnce(pauseTask("task-list-2"));
    await approveReviewTaskInternal("wayflow-task-list-1", RUN.runBy, buildListStepRefreshPayload("refresh"));
    expect(renderers().at(-1)).toBe(LIST_STEP_ID);
  });
});

describe("cinatra#3562 — a refresh is refused when the run's steps do not hold its step", () => {
  it.each([
    ["the steps cannot be read", { ...TEMPLATE, approvalPolicy: {} }],
    ["the step is not among the steps", { ...TEMPLATE, approvalPolicy: { steps: [TEMPLATE.approvalPolicy.steps[1]] } }],
  ])("%s: nothing is sent", async (_case, template) => {
    await firstPause("task-list-1");
    storeMock.readAgentTemplateById.mockResolvedValue(template);
    // red-first-expect: buildListStepRefreshPayload is not a function
    await expect(refresh("task-list-1", "task-list-2")).rejects.toThrow("its step is not among the flow's steps");
    expect(sendTask).not.toHaveBeenCalled();
    expect(row.status).toBe("pending_approval");
  });
});
