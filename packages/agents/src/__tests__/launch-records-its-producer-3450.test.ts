/**
 * A RUN RECORDS WHAT STARTED IT (cinatra#3450, epic #3248).
 *
 * The Measured: the outreach run of the account-scope "Build a list with AI"
 * road carried a task id and an execution attempt id but no trigger record, so
 * the child run's parent was attested with task and attempt ONLY — a reader of
 * the child could not see where it came from.
 *
 * The mechanism the issue first named — writing an `agent_run_triggers` row at
 * launch — cannot be the fix, and is corrected on the issue itself: the ABSENCE
 * of that row is the shipped signal for "no schedule chosen yet", so a row
 * written at launch would skip the schedule step for everyone. What the run
 * records instead is the producer key the launch fence already receives, on the
 * run itself, and the trigger record keeps meaning "a schedule was chosen".
 *
 * Two arms:
 *
 *   THE FENCE STAMPS IT. `launchAgentRun` is the ONE creation entry every
 *   product road goes through (`scripts/audit/run-creation-fence.mjs` allows a
 *   creator call in the store and in that coordinator alone), and every one of
 *   its call sites already passes `producer`. Both creation paths — the
 *   full-creation one and the pre-dispatch one — hand that key to the creator,
 *   so a road added tomorrow cannot forget it.
 *
 *   THE RECORD NAMES IT. A run row carrying a parent, a task, an attempt and a
 *   stored producer reads back as a record naming all four — the Measured's
 *   "task and attempt only" is exactly what this arm reads red without the
 *   change.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const RUN_ID = "run-3450-producer";
const ORG_ID = "org-3450";

const store = vi.hoisted(() => ({
  RunTransitionError: class RunTransitionError extends Error {
    readonly code: string;
    constructor(code: string) {
      super(code);
      this.name = "RunTransitionError";
      this.code = code;
    }
  },
  readAgentRunById: vi.fn(),
  transitionRunStatus: vi.fn(async () => undefined),
  recordRunLifecycleMoment: vi.fn(async () => undefined),
  createAgentRunPendingInput: vi.fn(),
  createAgentRun: vi.fn(),
}));

const enqueue = vi.hoisted(() => ({
  enqueueAgentRun: vi.fn(async () => undefined),
  enqueueDepsForTemplate: vi.fn(() => ({})),
}));

vi.mock("../store", () => store);
vi.mock("@/lib/agent-run-enqueue", () => enqueue);
vi.mock("@/lib/org-write/run-creation-authority", () => ({
  resolveRunCreationAuthority: vi.fn(async () => ({ kind: "system" })),
}));
vi.mock("../recommendation-hold", () => ({
  maybeHoldRunForRecommendation: vi.fn(async () => ({ held: false })),
  readRecommendationParkForRun: vi.fn(async () => null),
}));

// The run-record mapper is read through its own module, which takes no store
// value at runtime (the only edge back is a TYPE-ONLY import, fully erased), so
// the store mock above does not stand between this arm and the real mapper.
vi.mock("../db", () => ({
  db: {},
  agentBuilderPool: { on: () => {}, listenerCount: () => 1, end: vi.fn() },
}));

import { launchAgentRun } from "../lifecycle-coordinator";
import { deserializeRun } from "../agent-run-serde";

const AUTHORITY = { kind: "system" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  store.createAgentRun.mockResolvedValue({ id: RUN_ID, orgId: ORG_ID, status: "queued" });
  store.createAgentRunPendingInput.mockResolvedValue({
    id: RUN_ID,
    orgId: ORG_ID,
    status: "pending_input",
  });
  store.readAgentRunById.mockResolvedValue({ id: RUN_ID, orgId: ORG_ID, status: "queued" });
});

// The module mocks above are FILE-SCOPED by the runner's own module registry
// and are not released by anything this file calls; what the hook below
// releases is the call history and any spy, so one case cannot read another's
// arguments.
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("the launch fence hands the creator the key it was given", () => {
  it("stamps the producer on the FULL creation path", async () => {
    await launchAgentRun({
      producer: "run_page_create_and_trigger",
      frame: null,
      create: {
        kind: "full",
        input: { templateId: "tmpl-3450", runBy: null, inputParams: {}, orgId: ORG_ID },
      },
      dispatch: { kind: "enqueue", options: { jobId: RUN_ID } },
      authority: AUTHORITY,
    } as never);

    expect(store.createAgentRun).toHaveBeenCalledTimes(1);
    const created = store.createAgentRun.mock.calls[0]?.[0] as { launchProducer?: unknown };
    expect(created.launchProducer).toBe("run_page_create_and_trigger");
  });

  it("stamps the producer on the PRE-DISPATCH path too", async () => {
    // A run that waits for a trigger is created pre-dispatch and stays there —
    // it must reach dispatch already knowing what started it, exactly as it
    // already reaches dispatch knowing where it lives.
    await launchAgentRun({
      producer: "run_page_pending",
      frame: null,
      create: {
        kind: "pre_dispatch",
        input: { templateId: "tmpl-3450", runBy: null, inputParams: {}, orgId: ORG_ID },
      },
      dispatch: { kind: "await_trigger", why: "waiting on a schedule" },
      authority: AUTHORITY,
    } as never);

    expect(store.createAgentRunPendingInput).toHaveBeenCalledTimes(1);
    const created = store.createAgentRunPendingInput.mock.calls[0]?.[0] as {
      launchProducer?: unknown;
    };
    expect(created.launchProducer).toBe("run_page_pending");
  });

  it("stamps the key the CALLER passed, never one inferred here", async () => {
    // The inventory key is the producer's own; nothing on this path derives it
    // from the frame, the dispatch shape or the presence reading.
    await launchAgentRun({
      producer: "agent_as_tool",
      frame: null,
      create: {
        kind: "full",
        input: { templateId: "tmpl-3450", runBy: null, inputParams: {}, orgId: ORG_ID },
      },
      dispatch: { kind: "enqueue", options: { jobId: RUN_ID } },
      authority: AUTHORITY,
    } as never);

    const created = store.createAgentRun.mock.calls[0]?.[0] as { launchProducer?: unknown };
    expect(created.launchProducer).toBe("agent_as_tool");
  });
});

describe("the attestation a reader of a child run gets", () => {
  const row = (overrides: Record<string, unknown>) =>
    ({
      id: "child-run-3450",
      templateId: "tmpl-3450",
      versionId: null,
      runBy: null,
      status: "completed",
      inputParams: "{}",
      stepResults: null,
      startedAt: null,
      completedAt: null,
      error: null,
      title: null,
      createdAt: new Date("2026-09-13T00:00:00Z"),
      sourceType: "internal",
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
      orgId: ORG_ID,
      projectId: null,
      idempotencyKey: null,
      oboCeiling: null,
      dependentInstallId: null,
      executionAttemptId: null,
      humanPresent: null,
      lifecycleMoment: null,
      lifecycleCardKind: null,
      lifecycleCardRef: null,
      launchScopeAnchor: null,
      launchProducer: null,
      ...overrides,
    }) as unknown as Parameters<typeof deserializeRun>[0];

  it("names the task, the attempt, the parent AND what started it", () => {
    // The Measured, with the one reading it lacked: task and attempt were
    // already there, and the fourth is what tells the reader where the run
    // came from.
    const record = deserializeRun(
      row({
        parentRunId: "parent-run-3450",
        a2aTaskId: "task-3450",
        executionAttemptId: "attempt-3450",
        launchProducer: "run_page_create_and_trigger",
      }),
    );

    expect(record.parentRunId).toBe("parent-run-3450");
    expect(record.a2aTaskId).toBe("task-3450");
    expect(record.executionAttemptId).toBe("attempt-3450");
    expect(record.launchProducer).toBe("run_page_create_and_trigger");
  });

  it("surfaces it AS STORED — a run nobody recorded a start for reads null", () => {
    // No inference and no backfill: a row that predates the column reads null,
    // which is the honest record of a start nobody wrote down.
    const record = deserializeRun(row({}));
    expect(record.launchProducer).toBeNull();
  });
});
