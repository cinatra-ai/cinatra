/**
 * cinatra#3562 — a list step's Try again reaches the run as the flow's refresh
 * answer. The key `listStepRefresh` is a refresh request only on a list step
 * (read from the gate's durable record) whose schema declares no field of that
 * name; anywhere else it is an ordinary answer value. A request is taken only
 * when the list step's binding declares the same `params.refreshValue`, and
 * sends exactly that value as the resume text; any other request is refused
 * before the pause is claimed.
 *
 * Harness mirrors resume-message-before-fence-4245.test.ts.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/list-step-refresh-resume-3562.test.ts
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

import { RunTransitionError } from "../run-status";
import { buildListStepRefreshPayload, listStepRefreshRequest } from "../hitl-gate-submit";

const LIST_STEP_ID = "@cinatra-ai/email-outreach-agent:list-picker";
const durableGate = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }));
const bindings = vi.hoisted(() => ({ list: [] as Array<Record<string, unknown>> }));
vi.mock("../field-renderer-bindings.server", () => ({
  getMergedFieldRendererBindings: () => bindings.list,
}));

const row = vi.hoisted(() => ({ status: "pending_approval" as string }));
const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentRunByTaskId: vi.fn(),
  readAgentTemplateById: vi.fn(),
  readRunCoOwners: vi.fn(async () => []),
  writeHitlPrompt: vi.fn(async () => undefined),
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
  readDurableHitlGateForContinue: async () => durableGate.value,
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
}));
vi.mock("../wayflow-run-token-carrier", () => ({
  mintResumeRunTokenMetadata: vi.fn(async () => ({ token: "t" })),
}));
const sendTask = vi.hoisted(() => vi.fn());
vi.mock("@cinatra-ai/a2a", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createExternalA2AClient: vi.fn(async () => ({ sendTask })),
  resolveRunIdByWayflowTaskId: vi.fn(async () => null),
  resolveLatestWayflowGateTaskId: vi.fn(async () => null),
  rememberLatestWayflowGateTask: vi.fn(async () => undefined),
  rememberAnsweredGateSubmission: vi.fn(async () => undefined),
}));
const handleWayflowTaskState = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../execution", () => ({ handleWayflowTaskState }));

import { approveReviewTaskInternal } from "../review-task-actions";

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
  durableGate.value = listStepGate();
  bindings.list = [{ id: LIST_STEP_ID, kind: "list-picker", priority: 90, params: { refreshValue: "refresh" } }];
  storeMock.readAgentRunByTaskId.mockImplementation(async () => liveRun());
  storeMock.readAgentRunById.mockImplementation(async () => liveRun());
  storeMock.readAgentTemplateById.mockResolvedValue({
    id: RUN.templateId,
    packageName: "@cinatra-ai/email-outreach-agent",
    sourceType: "internal",
    agentAuthPolicy: null,
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

  it("takes the refresh with the binding the pack's own declaration yields", async () => {
    // The pack declares `params.refreshValue` on its list step's binding; the
    // generator and the runtime collector both pass it through this validator.
    const { validateFieldRendererDeclarations } = await import(
      "../../../../scripts/extensions/agent-binding-kinds.mjs"
    );
    const { entries, errors } = validateFieldRendererDeclarations("@cinatra-ai/email-outreach-agent", [
      {
        id: LIST_STEP_ID,
        kind: "list-picker",
        priority: 90,
        params: { selection: "multiple", minSelected: 1, refreshValue: "refresh" },
        component: { entry: "./src/renderers/list-picker.ts", propsApiVersion: 1 },
      },
    ]);
    expect(errors).toEqual([]);
    bindings.list = entries as Array<Record<string, unknown>>;
    // red-first-expect: buildListStepRefreshPayload is not a function
    await approveReviewTaskInternal(TASK, RUN.runBy, buildListStepRefreshPayload("refresh"));
    expect(sentText()).toContain('"text":"refresh"');
  });

  it("leaves an answer without the refresh key as it was (guard)", async () => {
    await approveReviewTaskInternal(TASK, RUN.runBy, { approved: true, userResponse: "refresh" });
    expect(sentText()).toContain('"text":"refresh"');
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
