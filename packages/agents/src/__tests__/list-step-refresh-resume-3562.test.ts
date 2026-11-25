/**
 * cinatra#3562 — a list step's Try again reaches the run as the flow's refresh
 * answer. The key `listStepRefresh` is a refresh request only on a list step
 * (read from the gate's durable record) whose schema declares no field of that
 * name; anywhere else it is an ordinary answer value. A request is taken only
 * when the list step's binding declares the same `params.refreshValue`, and
 * sends exactly that value as the resume text; any other request is refused
 * before the pause is claimed.
 *
 * A refresh answers no step: the flow parks at the same list step again. So it
 * stores no answer row, and the real submission walk
 * (`buildSubmissionMapByStepIndex`, which ties rows to declared pauses by
 * position) gives the later pick to the list step and leaves the next pause
 * unanswered.
 *
 * A refresh also mints no answered-gate provenance: the run-scoped persist
 * seam (answered-gate-provenance.ts) authorizes a draft or recipient write only
 * with a digest minted at an answer, and a refresh is none. The store under the
 * real mint and consume functions is an in-memory `ioredis` double.
 *
 * Harness mirrors resume-message-before-fence-4245.test.ts.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/list-step-refresh-resume-3562.test.ts
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

import { RunTransitionError } from "../run-status";
import { buildListStepRefreshPayload, listStepRefreshRequest } from "../hitl-gate-submit";

const LIST_STEP_ID = "@cinatra-ai/email-outreach-agent:list-picker";
/** `fail: true` makes the durable gate read throw, as a database error would. */
const durableGate = vi.hoisted(() => ({ value: null as null | Record<string, unknown>, fail: false }));
/** `generated: true` reads the application's real generated bindings, unchanged. */
const bindings = vi.hoisted(() => ({ list: [] as Array<Record<string, unknown>>, generated: false }));
vi.mock("../field-renderer-bindings.server", async () => {
  const { GENERATED_FIELD_RENDERER_BINDINGS } = await import("@/lib/generated/agent-bindings");
  return {
    getMergedFieldRendererBindings: () => (bindings.generated ? GENERATED_FIELD_RENDERER_BINDINGS : bindings.list),
  };
});

const row = vi.hoisted(() => ({ status: "pending_approval" as string }));
/** The answer rows the resume road stored, in capture order. */
type StoredRow = { stepKey: string; submittedValues: Record<string, unknown> | null; schemaSnapshot: null; capturedAt: Date };
const promptRows = vi.hoisted(() => ({ list: [] as StoredRow[] }));
const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentRunByTaskId: vi.fn(),
  readAgentTemplateById: vi.fn(),
  readRunCoOwners: vi.fn(async () => []),
  writeHitlPrompt: vi.fn(async (input: { stepKey: string; submittedValues?: Record<string, unknown> | null }) => {
    promptRows.list.push({
      stepKey: input.stepKey,
      submittedValues: input.submittedValues ?? null,
      schemaSnapshot: null,
      capturedAt: new Date(Date.UTC(2026, 10, 24, 10, promptRows.list.length)),
    });
  }),
  readAllHitlPromptsForRun: vi.fn(async () => promptRows.list),
  readReviewGateTimesForRun: vi.fn(async () => []),
  readAgentRunMessages: vi.fn(async () => []),
  transitionRunStatus: vi.fn(),
}));
vi.mock("../run-pause-claim", async (orig) => ({
  ...(await orig<typeof import("../run-pause-claim")>()),
  ...(await import("./pause-claim-test-fake")).pauseClaimFake,
}));
vi.mock("../store", () => storeMock);
// cinatra#4150: every resume road reads the run's newest publish decision before it
// sends. This suite is about another question, so no publish decision holds its run.
vi.mock("../publish-decision-store", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readLatestDecisionForRun: async () => null,
}));
vi.mock("../agent-run-hitl-prompts", () => ({
  captureHitlPromptForContinue: async (input: never) => {
    await (storeMock.writeHitlPrompt as unknown as (value: unknown) => Promise<void>)(input);
    return "captured-prompt";
  },
  readDurableHitlGateForContinue: async () => {
    if (durableGate.fail) throw new Error("gate record read failed");
    return durableGate.value;
  },
  recordSuccessfulContinue: async () => {},
  continueBindingDigest: () => "",
  continueGateDigest: () => "",
}));
// No rows: the install-scope guard reads nothing and decides nothing.
vi.mock("../db", () => {
  const query: Record<string, unknown> = {};
  query.from = () => query;
  query.where = () => query;
  query.limit = async () => [];
  return {
    db: { select: () => query },
    agentBuilderPool: { on: () => {}, listenerCount: () => 1 },
  };
});
vi.mock("../resume-run-from-setup-approval", () => ({
  resumeRunFromSetupApproval: vi.fn(async () => undefined),
}));
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
vi.mock("../wayflow-run-token-carrier", () => ({
  mintResumeRunTokenMetadata: vi.fn(async () => ({ token: "t" })),
}));
/**
 * An in-memory `ioredis` double for the answered-gate store: the real
 * `rememberAnsweredGateSubmission` writes into it and the real
 * `consumeAnsweredGateSubmission` reads it. `eval` does what the consume's Lua
 * does: absent, or delete on an equal digest, or mismatch.
 */
const redis = vi.hoisted(() => {
  const store = new Map<string, string>();
  class FakeRedis {
    async set(key: string, value: string): Promise<"OK"> {
      store.set(key, value);
      return "OK";
    }
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    }
    async eval(_lua: string, _keys: number, key: string, digest: string): Promise<string> {
      const stored = store.get(key);
      if (stored === undefined) return "absent";
      if (stored !== digest) return "mismatch";
      store.delete(key);
      return "consumed";
    }
    async quit(): Promise<"OK"> {
      return "OK";
    }
    on(): this {
      return this;
    }
  }
  return { store, FakeRedis };
});
vi.mock("ioredis", () => ({ Redis: redis.FakeRedis, default: redis.FakeRedis }));
const sendTask = vi.hoisted(() => vi.fn());
vi.mock("@cinatra-ai/a2a", async (orig) => {
  const real = await orig<typeof import("@cinatra-ai/a2a")>();
  return {
    ...real,
    createExternalA2AClient: vi.fn(async () => ({ sendTask })),
    resolveRunIdByWayflowTaskId: vi.fn(async () => null),
    resolveLatestWayflowGateTaskId: vi.fn(async () => null),
    rememberLatestWayflowGateTask: vi.fn(async () => undefined),
    // The real mint, watched: it records into the in-memory store.
    rememberAnsweredGateSubmission: vi.fn(real.rememberAnsweredGateSubmission),
  };
});
const handleWayflowTaskState = vi.hoisted(() => vi.fn(async () => undefined));
// An unpinned run reads its steps from the live template (`readRunApprovalPolicySteps`).
vi.mock("../execution", () => ({
  handleWayflowTaskState,
  readRunApprovalPolicySteps: async (_run: unknown, template: { approvalPolicy?: { steps?: unknown } } | null) => template?.approvalPolicy?.steps,
}));

import { approveReviewTaskInternal } from "../review-task-actions";
import { buildSubmissionMapByStepIndex } from "../run-actions";

const RUN = {
  id: "run-refresh-3562",
  templateId: "tpl-refresh-3562",
  orgId: "org-1",
  runBy: "reader-refresh",
  authPolicy: null,
  a2aContextId: "ctx-refresh-3562",
  a2aTaskId: "task-refresh-3562",
  pauseGeneration: 1,
};
const TASK = "wayflow-task-refresh-3562";
const liveRun = () => ({ ...RUN, status: row.status });

/** The gate's durable record, as the list step materialized it. */
function listStepGate(xRenderer = LIST_STEP_ID) {
  return {
    runId: RUN.id,
    reviewTaskId: TASK,
    xRenderer,
    inputSchema: { type: "object", properties: { accountScope: { type: "string" } } },
    values: {},
    materializedAt: "2026-11-24T00:00:00.000Z",
  };
}

function arrange() {
  row.status = "pending_approval";
  redis.store.clear();
  promptRows.list = [];
  bindings.generated = false;
  durableGate.value = listStepGate();
  durableGate.fail = false;
  bindings.list = [{ id: LIST_STEP_ID, kind: "list-picker", priority: 90, params: { refreshValue: "refresh" } }];
  storeMock.readAgentRunByTaskId.mockImplementation(async () => liveRun());
  storeMock.readAgentRunById.mockImplementation(async () => liveRun());
  storeMock.readAgentTemplateById.mockResolvedValue({
    id: RUN.templateId,
    packageName: "@cinatra-ai/email-outreach-agent",
    sourceType: "internal",
    agentAuthPolicy: null,
    // The flow's one renderer step is the list step: a refresh of it is sent only
    // when the compiled steps can be read and hold that step.
    approvalPolicy: { steps: [{ stepNumber: 1, requiresApproval: true, xRenderer: LIST_STEP_ID }] },
  });
  storeMock.transitionRunStatus.mockImplementation(async (runId: string, from: string, to: string) => {
    if (row.status !== from) {
      throw new RunTransitionError({ code: "stale_from_status", runId, from: from as never, to: to as never });
    }
    row.status = to;
  });
  sendTask.mockImplementation(async () => ({ id: "task-next", contextId: RUN.a2aContextId, status: { state: "input-required" } }));
}

/** The resume text of the one message sent. */
function sentText(): string {
  expect(sendTask).toHaveBeenCalledTimes(1);
  return JSON.stringify(sendTask.mock.calls[0]);
}

beforeAll(async () => {
  arrange();
  await approveReviewTaskInternal(TASK, RUN.runBy).catch(() => undefined);
}, 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  arrange();
});

describe("cinatra#3562 — the list step's Try again resumes the run with the declared refresh value", () => {
  it("takes the refresh for a list step whose binding declares it, and sends it as the resume text", async () => {
    // red-first-expect: buildListStepRefreshPayload is not a function
    await approveReviewTaskInternal(TASK, RUN.runBy, buildListStepRefreshPayload("refresh"));
    const text = sentText();
    expect(text).toContain('"text":"refresh"');
    expect(text).not.toContain("listIds");
    const { rememberAnsweredGateSubmission } = await import("@cinatra-ai/a2a");
    expect(rememberAnsweredGateSubmission).not.toHaveBeenCalled();
    expect(redis.store.size).toBe(0);
  });

  it("refuses a refresh the binding does not declare, before anything is held or sent", async () => {
    bindings.list = [{ id: LIST_STEP_ID, kind: "list-picker", priority: 90, params: {} }];
    // red-first-expect: buildListStepRefreshPayload is not a function
    await expect(
      approveReviewTaskInternal(TASK, RUN.runBy, buildListStepRefreshPayload("refresh")),
    ).rejects.toThrow("takes no such list step refresh");
    expect(sendTask).not.toHaveBeenCalled();
    expect(row.status).toBe("pending_approval");
  });

  it("refuses a value other than the declared one", async () => {
    // red-first-expect: buildListStepRefreshPayload is not a function
    await expect(
      approveReviewTaskInternal(TASK, RUN.runBy, buildListStepRefreshPayload("default")),
    ).rejects.toThrow("takes no such list step refresh");
    expect(sendTask).not.toHaveBeenCalled();
  });

  it("reads the key as an ordinary value on a gate that is not a list step, or whose record is missing (guard)", async () => {
    durableGate.value = listStepGate("@cinatra-ai/email-outreach-agent:output");
    bindings.list = [];
    await approveReviewTaskInternal(TASK, RUN.runBy, {
      approved: true,
      userResponse: JSON.stringify({ listStepRefresh: "keep me" }),
      listStepRefresh: "keep me",
    });
    expect(sentText()).toContain("keep me");
    vi.clearAllMocks();
    arrange();
    durableGate.value = null;
    bindings.list = [];
    await approveReviewTaskInternal(TASK, RUN.runBy, { approved: true, listStepRefresh: "keep me" });
    expect(sendTask).toHaveBeenCalledTimes(1);
  });

  it("refuses the hosts' refresh when the gate record is missing, and claims, sends and stores nothing", async () => {
    durableGate.value = null;
    const { claimPause } = (await import("./pause-claim-test-fake")).pauseClaimFake;
    // red-first-expect: buildListStepRefreshPayload is not a function
    await expect(
      approveReviewTaskInternal(TASK, RUN.runBy, buildListStepRefreshPayload("refresh")),
    ).rejects.toThrow("takes no such list step refresh");
    expect(claimPause).not.toHaveBeenCalled();
    expect(sendTask).not.toHaveBeenCalled();
    expect(storeMock.writeHitlPrompt).not.toHaveBeenCalled();
    expect(row.status).toBe("pending_approval");
  });

  it("refuses the hosts' refresh when the gate record read fails, and claims, sends and stores nothing", async () => {
    durableGate.fail = true;
    const { claimPause } = (await import("./pause-claim-test-fake")).pauseClaimFake;
    // red-first-expect: buildListStepRefreshPayload is not a function
    await expect(
      approveReviewTaskInternal(TASK, RUN.runBy, buildListStepRefreshPayload("refresh")),
    ).rejects.toThrow("takes no such list step refresh");
    expect(claimPause).not.toHaveBeenCalled();
    expect(sendTask).not.toHaveBeenCalled();
    expect(storeMock.writeHitlPrompt).not.toHaveBeenCalled();
    expect(row.status).toBe("pending_approval");
  });

  it("submits a single text field named like the key normally when the gate record is missing (guard)", async () => {
    durableGate.value = null;
    bindings.list = [];
    await approveReviewTaskInternal(TASK, RUN.runBy, {
      approved: true,
      approvedAt: "2026-11-24T00:00:00.000Z",
      userResponse: "a real answer",
      userResponseFieldName: "listStepRefresh",
      listStepRefresh: "a real answer",
    });
    expect(sentText()).toContain("a real answer");
    expect(storeMock.writeHitlPrompt).toHaveBeenCalledTimes(1);
  });

  it("submits a field named like the key on a list step whose schema declares it (guard)", async () => {
    durableGate.value = {
      ...listStepGate(),
      inputSchema: { type: "object", properties: { listStepRefresh: { type: "string" } } },
    };
    bindings.list = [{ id: LIST_STEP_ID, kind: "list-picker", priority: 90, params: {} }];
    await approveReviewTaskInternal(TASK, RUN.runBy, {
      approved: true,
      userResponse: JSON.stringify({ listStepRefresh: "a real answer" }),
      listStepRefresh: "a real answer",
    });
    expect(sentText()).toContain("a real answer");
  });

  it("submits a setup field named like the key normally (guard)", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue({
      id: RUN.templateId,
      packageName: "@cinatra-ai/email-outreach-agent",
      sourceType: "internal",
      agentAuthPolicy: null,
      inputSchema: { type: "object", properties: { listStepRefresh: { type: "string" } } },
    });
    const { resumeRunFromSetupApproval } = await import("../resume-run-from-setup-approval");
    await approveReviewTaskInternal(`setup-${RUN.id}`, RUN.runBy, {
      approved: true,
      listStepRefresh: "a setup answer",
    });
    expect(resumeRunFromSetupApproval).toHaveBeenCalledTimes(1);
    // The merge fragment carries the field's value as one of its parameters.
    const merge = (resumeRunFromSetupApproval as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      queryChunks: unknown[];
    };
    expect(merge.queryChunks.some((chunk) => typeof chunk === "string" && chunk.includes("a setup answer"))).toBe(true);
  });

  it("takes the refresh with a binding built by the shared validator from the pinned pack declaration plus `refreshValue`", async () => {
    // The binding is not read from the generated file: at today's pin the
    // email-outreach-agent release declares its list step without
    // `params.refreshValue` (the next test proves every refresh is refused
    // there). The consumer change that adds it is pinned after this change.
    // So this test takes the pinned declaration's own params, adds the
    // `refreshValue` that change declares, and passes the declaration through
    // `validateFieldRendererDeclarations`, the validator the binding generator
    // and the runtime collector both use.
    const { GENERATED_FIELD_RENDERER_BINDINGS } = await import("@/lib/generated/agent-bindings");
    const pinned = GENERATED_FIELD_RENDERER_BINDINGS.find((b) => b.id === LIST_STEP_ID) as
      | { params?: Record<string, unknown> }
      | undefined;
    expect(pinned?.params).toBeDefined();
    expect(pinned?.params).not.toHaveProperty("refreshValue");
    const { validateFieldRendererDeclarations } = await import(
      "../../../../scripts/extensions/agent-binding-kinds.mjs"
    );
    const { entries, errors } = validateFieldRendererDeclarations("@cinatra-ai/email-outreach-agent", [
      {
        id: LIST_STEP_ID,
        kind: "list-picker",
        priority: 90,
        params: { ...pinned?.params, refreshValue: "refresh" },
        component: { entry: "./src/renderers/list-picker.ts", propsApiVersion: 1 },
      },
    ]);
    expect(errors).toEqual([]);
    bindings.list = entries as Array<Record<string, unknown>>;
    // red-first-expect: buildListStepRefreshPayload is not a function
    await approveReviewTaskInternal(TASK, RUN.runBy, buildListStepRefreshPayload("refresh"));
    expect(sentText()).toContain('"text":"refresh"');
  });

  it("refuses every refresh with today's generated bindings, and claims nothing (no binding at the current pin declares refreshValue)", async () => {
    bindings.generated = true;
    const { GENERATED_FIELD_RENDERER_BINDINGS } = await import("@/lib/generated/agent-bindings");
    expect(GENERATED_FIELD_RENDERER_BINDINGS.some((b) => b.id === LIST_STEP_ID)).toBe(true);
    const { claimPause } = (await import("./pause-claim-test-fake")).pauseClaimFake;
    // red-first-expect: buildListStepRefreshPayload is not a function
    await expect(
      approveReviewTaskInternal(TASK, RUN.runBy, buildListStepRefreshPayload("refresh")),
    ).rejects.toThrow("takes no such list step refresh");
    expect(claimPause).not.toHaveBeenCalled();
    expect(sendTask).not.toHaveBeenCalled();
    expect(storeMock.writeHitlPrompt).not.toHaveBeenCalled();
    expect(row.status).toBe("pending_approval");
  });

  it("leaves an answer without the refresh key as it was (guard)", async () => {
    await approveReviewTaskInternal(TASK, RUN.runBy, { approved: true, userResponse: "refresh" });
    expect(sentText()).toContain('"text":"refresh"');
  });
});

describe("cinatra#3562 — a refresh carries nothing but its value and mints no answered-gate provenance", () => {
  const PERSIST = JSON.stringify({ drafts: [{ id: "d1", subject: "S", body: "B" }] });

  /** The real persist seam's decision for a payload presented for this gate. */
  async function persistWith(resumePayloadJson: string) {
    const { enforceAnsweredGateProvenance } = await import("@/app/api/agents/passthrough/answered-gate-provenance");
    return enforceAnsweredGateProvenance({
      tool: "email_outreach_initial_drafts_update",
      runId: RUN.id,
      verifiedSubmissionId: TASK.slice("wayflow-".length),
      resumePayloadJson,
    });
  }

  it("a structured answer mints provenance that the real persist seam consumes once (guard)", async () => {
    durableGate.value = null;
    await approveReviewTaskInternal(TASK, RUN.runBy, { approved: true, userResponse: PERSIST });
    expect(redis.store.size).toBe(1);
    expect(await persistWith(PERSIST)).toEqual({ ok: true });
    expect((await persistWith(PERSIST)).ok).toBe(false);
  });

  it("a taken refresh mints nothing, and a persist presenting its payload finds no provenance", async () => {
    // red-first-expect: buildListStepRefreshPayload is not a function
    const payload = buildListStepRefreshPayload("refresh");
    await approveReviewTaskInternal(TASK, RUN.runBy, payload);
    expect(sendTask).toHaveBeenCalledTimes(1);
    const { rememberAnsweredGateSubmission, rememberLatestWayflowGateTask } = await import("@cinatra-ai/a2a");
    expect(rememberAnsweredGateSubmission).not.toHaveBeenCalled();
    expect(rememberLatestWayflowGateTask).not.toHaveBeenCalled();
    expect(storeMock.writeHitlPrompt).not.toHaveBeenCalled();
    expect(redis.store.size).toBe(0);
    for (const presented of ["refresh", JSON.stringify(payload)]) {
      const decision = await persistWith(presented);
      expect(decision.ok).toBe(false);
      if (!decision.ok) expect(decision.error).toMatch(/no unconsumed answered-gate submission/);
    }
  });

  it.each([
    ["a userResponse that carries persist JSON", { userResponse: PERSIST }],
    ["an extra key with persist JSON", { drafts: [{ id: "d1", subject: "S", body: "B" }] }],
    ["an approval note", { approvalNote: "note" }],
    ["a userResponse other than the refresh value", { userResponse: "refresh " }],
  ])("refuses a refresh with %s, and claims, sends, stores and mints nothing", async (_name, extra) => {
    const { claimPause } = (await import("./pause-claim-test-fake")).pauseClaimFake;
    // red-first-expect: buildListStepRefreshPayload is not a function
    const crafted = { ...buildListStepRefreshPayload("refresh"), ...extra };
    await expect(approveReviewTaskInternal(TASK, RUN.runBy, crafted)).rejects.toThrow("takes no such list step refresh");
    const { rememberAnsweredGateSubmission } = await import("@cinatra-ai/a2a");
    expect(claimPause).not.toHaveBeenCalled();
    expect(sendTask).not.toHaveBeenCalled();
    expect(storeMock.writeHitlPrompt).not.toHaveBeenCalled();
    expect(rememberAnsweredGateSubmission).not.toHaveBeenCalled();
    expect(redis.store.size).toBe(0);
    expect(row.status).toBe("pending_approval");
    expect((await persistWith(PERSIST)).ok).toBe(false);
  });
});

describe("cinatra#3562 — which write is a refresh request", () => {
  it("only a mid-run list step's write with a nonblank string `refresh`", () => {
    const write = { listIds: [], listNames: [], refresh: "refresh" };
    // red-first-expect: listStepRefreshRequest is not a function
    expect(listStepRefreshRequest(LIST_STEP_ID, TASK, write)).toBe("refresh");
    expect(listStepRefreshRequest(LIST_STEP_ID, `setup-${RUN.id}`, write)).toBeNull();
    expect(listStepRefreshRequest("@cinatra-ai/email-outreach-agent:output", TASK, write)).toBeNull();
    expect(listStepRefreshRequest(LIST_STEP_ID, TASK, { listIds: ["a"], listNames: ["A"] })).toBeNull();
    expect(listStepRefreshRequest(LIST_STEP_ID, TASK, { refresh: "  " })).toBeNull();
    expect(listStepRefreshRequest(LIST_STEP_ID, TASK, { refresh: true })).toBeNull();
    expect(listStepRefreshRequest(LIST_STEP_ID, TASK, "refresh")).toBeNull();
  });
});

describe("cinatra#3562 — a refresh is no answer of the list step in the run's answer history", () => {
  /** The list step, then the next pause, as the policy declares them. */
  const POLICY_STEPS = [
    { stepNumber: 1, xRenderer: LIST_STEP_ID },
    { stepNumber: 2, xRenderer: "schema-field" },
  ];
  const HITL_STEPS = [
    { index: 1, stepNumber: 1 },
    { index: 2, stepNumber: 2 },
  ];
  const PICK = {
    approved: true,
    userResponse: JSON.stringify({ listIds: ["list-a"], listNames: ["List A"] }),
  };

  /** One answer at a parked list step; the flow then parks again (a new task). */
  async function answerAt(reviewTaskId: string, values: Record<string, unknown>) {
    row.status = "pending_approval";
    durableGate.value = { ...listStepGate(), reviewTaskId };
    await approveReviewTaskInternal(reviewTaskId, RUN.runBy, values);
  }

  /** The real walk over the stored rows: step index -> the answer's step key. */
  async function walk() {
    const entries = await buildSubmissionMapByStepIndex(RUN.id, "@cinatra-ai/email-outreach-agent", POLICY_STEPS, HITL_STEPS);
    return new Map(entries.map(([index, entry]) => [index, entry]));
  }

  it("gives the pick after a refresh to the list step and leaves the next pause unanswered", async () => {
    // red-first-expect: buildListStepRefreshPayload is not a function
    await answerAt("wayflow-task-list-1", buildListStepRefreshPayload("refresh"));
    await answerAt("wayflow-task-list-2", PICK);
    expect(sendTask).toHaveBeenCalledTimes(2);
    const map = await walk();
    expect(map.get(1)?.stepKey).toBe("task-list-2");
    expect(map.get(1)?.submittedValues).toMatchObject({ listIds: ["list-a"] });
    expect(map.has(2)).toBe(false);
  });

  it("gives the pick after two refreshes to the list step and leaves the next pause unanswered", async () => {
    // red-first-expect: buildListStepRefreshPayload is not a function
    await answerAt("wayflow-task-list-1", buildListStepRefreshPayload("refresh"));
    await answerAt("wayflow-task-list-2", buildListStepRefreshPayload("refresh"));
    await answerAt("wayflow-task-list-3", PICK);
    expect(sendTask).toHaveBeenCalledTimes(3);
    const map = await walk();
    expect(map.get(1)?.stepKey).toBe("task-list-3");
    expect(map.has(2)).toBe(false);
  });

  it("keeps the pick on the list step after a refresh refused for a missing gate record", async () => {
    row.status = "pending_approval";
    durableGate.value = null;
    // red-first-expect: buildListStepRefreshPayload is not a function
    await expect(
      approveReviewTaskInternal("wayflow-task-list-1", RUN.runBy, buildListStepRefreshPayload("refresh")),
    ).rejects.toThrow("takes no such list step refresh");
    await answerAt("wayflow-task-list-2", PICK);
    expect(sendTask).toHaveBeenCalledTimes(1);
    const map = await walk();
    expect(map.get(1)?.stepKey).toBe("task-list-2");
    expect(map.get(1)?.submittedValues).toMatchObject({ listIds: ["list-a"] });
    expect(map.has(2)).toBe(false);
  });

  it("still ties a pick and the next pause's answer to their own steps (guard)", async () => {
    await answerAt("wayflow-task-list-1", PICK);
    durableGate.value = null;
    row.status = "pending_approval";
    await approveReviewTaskInternal("wayflow-task-next", RUN.runBy, { approved: true, userResponse: JSON.stringify({ note: "next" }) });
    const map = await walk();
    expect(map.get(1)?.stepKey).toBe("task-list-1");
    expect(map.get(2)?.stepKey).toBe("task-next");
  });
});
