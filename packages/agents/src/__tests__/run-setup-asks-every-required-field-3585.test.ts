/**
 * cinatra#3585 — A RUN ASKS FOR EVERY REQUIRED START FIELD, NOT JUST TWO.
 *
 * The reported shape: the run parks on the first required start field, takes its
 * answer, parks on the second, takes its answer — and then never parks again.
 * No third field is asked, the run sits at `queued` with no runtime task, and
 * the schedule step stays unavailable with nothing said.
 *
 * THE SEAM THAT MAKES IT REPRODUCIBLE HERE, and without which this file would
 * pass at the head and prove nothing: the fake background-job queue below
 * honours the QUEUE'S OWN duplicate-id rule. The installed bullmq add path
 * (`commands/addStandardJob-9.lua`) tests `EXISTS` on the job's id key and, when
 * it is taken, short-circuits into `includes/handleDuplicatedJob.lua`, which
 * stores NO second job and returns the pre-existing id. The queue also KEEPS its
 * completed jobs (`removeOnComplete: 200` in `src/lib/background-jobs.ts`), so
 * the id of a resume job that has already run is still taken when the next
 * confirmation arrives. The fake therefore never prunes an id it has seen.
 *
 * WHAT THIS FILE FAKES, AND WHY — each is another suite's subject, not this
 * file's:
 *   - the store's run row: an in-memory row the transitions and the merge write;
 *   - the guarded setup writer (`resume-run-from-setup-approval`): the merge
 *     shape is `approve-setup-field.test.ts`'s subject;
 *   - the park seam (`human-gate-park`): the AG-UI frame and the durable row are
 *     `human-gate-park.test.ts` / `human-gate-park-durable-row.test.ts`'s;
 *   - the declared input-schema resolver: the two declarations are this file's
 *     own fixtures;
 *   - the background-job module: the fake queue above.
 *
 * WHAT IT DOES NOT FAKE — these four ARE the code this file exists to drive:
 * the pending-field computation, the per-field setup branch, the setup resume
 * branch in `review-task-actions.ts`, and the setup hand-over arm that moves a
 * finished setup to the state the schedule step is drawn from.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run --maxWorkers=2 \
 *     src/__tests__/run-setup-asks-every-required-field-3585.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// One hoisted state object: the run row, the declaration under drive, the parks
// the seam recorded, and the fake queue's own books.
// ---------------------------------------------------------------------------
const H = vi.hoisted(() => ({
  row: null as null | Record<string, unknown>,
  template: null as null | Record<string, unknown>,
  declaration: null as null | {
    required: string[];
    properties: Record<string, Record<string, unknown>>;
  },
  /** The field/value the test just submitted; the faked guarded writer merges it. */
  lastAnswer: null as null | { fieldName: string; value: unknown },
  /** Every gate label the park seam was asked to park on, in order. */
  parks: [] as string[],
  edges: [] as string[],
  /** Arms the next enqueue to fail (a runner the resume cannot be handed back to). */
  failNextEnqueue: false,
  /**
   * Every custom job id the queue has ever been handed. NEVER pruned: the queue
   * keeps completed jobs, so an id that has already run is still taken.
   */
  knownJobIds: new Set<string>(),
  /** Custom ids the queue refused to create a second job for. */
  duplicatesSwallowed: [] as string[],
  pending: [] as Array<{ id: string; name: string; data: Record<string, unknown> }>,
  seq: 0,
}));

vi.mock("@/lib/background-jobs", () => ({
  BACKGROUND_JOB_NAMES: { AGENT_BUILDER_EXECUTION: "agent-builder-execution" },
  enqueueBackgroundJob: vi.fn(
    async (
      name: string,
      data: Record<string, unknown>,
      options?: { jobId?: string },
    ): Promise<string> => {
      if (H.failNextEnqueue) {
        H.failNextEnqueue = false;
        throw new Error("queue unreachable");
      }
      const custom = options?.jobId;
      if (typeof custom === "string") {
        if (H.knownJobIds.has(custom)) {
          // The queue's own rule: the id key exists, so no second job is stored
          // and the pre-existing id is handed back. The add is a silent no-op.
          H.duplicatesSwallowed.push(custom);
          return custom;
        }
        H.knownJobIds.add(custom);
        H.pending.push({ id: custom, name, data });
        return custom;
      }
      H.seq += 1;
      const minted = `minted-job-${H.seq}`;
      H.knownJobIds.add(minted);
      H.pending.push({ id: minted, name, data });
      return minted;
    },
  ),
}));

vi.mock("../store", async () => {
  const { RunTransitionError } = await vi.importActual<typeof import("../run-status")>(
    "../run-status",
  );
  const readRow = (id: string) =>
    H.row && H.row.id === id
      ? { ...H.row, inputParams: { ...(H.row.inputParams as Record<string, unknown>) } }
      : null;
  return {
    RunTransitionError,
    readAgentRunById: vi.fn(async (id: string) => readRow(id)),
    readAgentRunByTaskId: vi.fn(async () => null),
    readAgentTemplateById: vi.fn(async () => H.template),
    readAgentTemplates: vi.fn(async () => []),
    readInstalledAgentTemplates: vi.fn(async () => []),
    readAgentTemplateVersionBySemver: vi.fn(async () => null),
    readAgentTemplateVersionById: vi.fn(async () => null),
    readRunCoOwners: vi.fn(async () => []),
    writeHitlPrompt: vi.fn(async () => undefined),
    writeDurableHitlGateArtifact: vi.fn(async () => undefined),
    findSavedConnectionForAgentUrl: vi.fn(async () => null),
    updateAgentRunA2ATaskId: vi.fn(async () => undefined),
    updateAgentRunA2AContextId: vi.fn(async () => undefined),
    updateAgentRunStreamedText: vi.fn(async () => undefined),
    setAgentRunTokenHash: vi.fn(async () => undefined),
    transitionRunStatus: vi.fn(
      async (
        runId: string,
        from: string,
        to: string,
        extra?: { error?: string } | undefined,
      ): Promise<void> => {
        if (!H.row || H.row.id !== runId) throw new Error(`no run ${runId}`);
        if (H.row.status !== from) {
          throw new RunTransitionError({
            code: "stale_from_status",
            runId,
            from: from as never,
            to: to as never,
          });
        }
        H.row.status = to;
        if (extra && typeof extra.error === "string") H.row.error = extra.error;
        H.edges.push(`${from}->${to}`);
      },
    ),
  };
});

vi.mock("../human-gate-park", () => ({
  parkRunOnHumanGate: vi.fn(async (options: { gateLabel: string; parkRun: () => Promise<void> }) => {
    H.parks.push(options.gateLabel);
    await options.parkRun();
    return { outcome: "parked" as const };
  }),
}));

vi.mock("../resume-run-from-setup-approval", () => ({
  resumeRunFromSetupApproval: vi.fn(async (runId: string): Promise<void> => {
    // The guarded CAS: it merges the answered field and moves the run
    // pending_approval -> queued, and it updates no row when the run has already
    // left pending_approval (a second submission of the SAME gate).
    if (!H.row || H.row.id !== runId) throw new Error(`no run ${runId}`);
    if (H.row.status !== "pending_approval") {
      throw new Error(`setup CAS updated no row for run ${runId}`);
    }
    if (H.lastAnswer) {
      (H.row.inputParams as Record<string, unknown>)[H.lastAnswer.fieldName] =
        H.lastAnswer.value;
    }
    H.row.status = "queued";
  }),
}));

vi.mock("../input-schema-resolver", async (orig) => ({
  ...(await orig<typeof import("../input-schema-resolver")>()),
  resolveTemplateInputSchema: vi.fn(async () => ({
    type: "object" as const,
    required: [...(H.declaration?.required ?? [])],
    properties: { ...(H.declaration?.properties ?? {}) },
  })),
}));

// The install-scope gate reads agent_runs / agent_templates straight from the DB;
// this suite mocks the persistence hub, so it mocks the gate's persistence too.
// The gate's own behaviour is proven in agent-run-scope-guard.test.ts.
vi.mock("../agent-run-serde", async (orig) => ({
  ...(await orig<typeof import("../agent-run-serde")>()),
  assertAgentRunScopeAuthorized: vi.fn(async () => undefined),
  assertAgentRunDispatchAuthorized: vi.fn(async () => undefined),
}));

const triggerStoreMock = vi.hoisted(() => ({
  readRunTriggerByRunId: vi.fn(async (): Promise<{ triggerType: string } | null> => null),
}));
vi.mock("../trigger-store", () => triggerStoreMock);
vi.mock("../trigger-gate", () => ({ isTriggerReleased: vi.fn(async () => true) }));
vi.mock("../skill-autosave", () => ({
  runSkillAutosaveOnRunCompletion: vi.fn(async () => undefined),
}));
vi.mock("../wayflow-url", () => ({
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
  WAYFLOW_A2A_TIMEOUT_MS: 60_000,
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  describeWayflowDispatchError: vi.fn((e: unknown) => String(e)),
  AGENT_RUN_TIMEOUT_MAX_SECONDS: 86_400,
}));
vi.mock("@cinatra-ai/a2a", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, rememberLatestWayflowGateTask: vi.fn(async () => undefined) };
});
// The setup resume grounds its guarded write on the resuming principal via
// resolveOrgRoleForUser; stub that membership read so the session mint succeeds.
vi.mock("@/lib/auth-session", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth-session")>()),
  resolveOrgRoleForUser: vi.fn(async () => "member"),
}));

import { transitionRunStatus } from "../store";
import { runAgentBuilderExecutionJob } from "../execution";
import { approveReviewTaskInternal } from "../review-task-actions";

// ---------------------------------------------------------------------------
// The two declarations, in the shape the two publish agents declare: required
// titles in order, NO `default` on any of them, NO renderer id on any of them
// (so both take the per-field setup road), and one hidden field carrying a
// default.
// ---------------------------------------------------------------------------
type Declaration = {
  readonly label: string;
  readonly required: readonly string[];
  readonly properties: Record<string, Record<string, unknown>>;
};

const THREE_REQUIRED: Declaration = {
  label: "three required start fields",
  required: ["postArtifactId", "postRepresentationRevisionId", "wordpressInstanceId"],
  properties: {
    postArtifactId: { type: "string", title: "postArtifactId" },
    postRepresentationRevisionId: { type: "string", title: "postRepresentationRevisionId" },
    wordpressInstanceId: { type: "string", title: "wordpressInstanceId" },
    cinatra_run_id: { type: "string", title: "cinatra_run_id", "x-hidden": true, default: "" },
  },
};

const SIX_REQUIRED: Declaration = {
  label: "six required start fields",
  required: [
    "linkedinArtifactId",
    "linkedinRepresentationRevisionId",
    "linkedinAccountId",
    "destinationType",
    "destinationId",
    "destinationName",
  ],
  properties: {
    linkedinArtifactId: { type: "string", title: "linkedinArtifactId" },
    linkedinRepresentationRevisionId: {
      type: "string",
      title: "linkedinRepresentationRevisionId",
    },
    linkedinAccountId: { type: "string", title: "linkedinAccountId" },
    destinationType: { type: "string", title: "destinationType" },
    destinationId: { type: "string", title: "destinationId" },
    destinationName: { type: "string", title: "destinationName" },
    cinatra_run_id: { type: "string", title: "cinatra_run_id", "x-hidden": true, default: "" },
  },
};

const RUN_ID = "run-3585";
const ORG_ID = "org-3585";

function seed(declaration: Declaration): void {
  H.declaration = {
    required: [...declaration.required],
    properties: { ...declaration.properties },
  };
  H.row = {
    id: RUN_ID,
    templateId: "tmpl-3585",
    versionId: null,
    runBy: "user-3585",
    status: "queued",
    inputParams: {} as Record<string, unknown>,
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
    authPolicy: null,
    orgId: ORG_ID,
    projectId: null,
    idempotencyKey: null,
    oboCeiling: null,
    dependentInstallId: null,
    humanPresent: true,
    executionAttemptId: null,
  };
  H.template = {
    id: "tmpl-3585",
    orgId: ORG_ID,
    creatorId: null,
    name: "Publish Agent",
    description: "",
    sourceNl: "",
    compiledPlan: [],
    inputSchema: {
      properties: declaration.properties,
      required: [...declaration.required],
    },
    outputSchema: null,
    taskSpec: null,
    status: "published",
    packageName: "@cinatra/publish-agent-3585",
    packageVersion: "1.0.0",
    gatedSteps: [],
    triggerMode: "full",
    approvalPolicy: null,
    agentDependencies: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };
}

/** Runs every job the fake queue really created, in the order it created them. */
async function drainQueue(): Promise<void> {
  let guard = 0;
  while (H.pending.length > 0) {
    if ((guard += 1) > 50) throw new Error("queue drain did not settle");
    const job = H.pending.shift()!;
    await runAgentBuilderExecutionJob(job.data as { runId: string }, job.id);
  }
}

/** The gate label the setup loop parks with, for a named field. */
const parkLabel = (fieldName: string) => `setup field '${fieldName}'`;

/** Answers the field the run is currently parked on, through the setup gate. */
async function answer(fieldName: string): Promise<void> {
  H.lastAnswer = { fieldName, value: `answer-for-${fieldName}` };
  await approveReviewTaskInternal(
    `setup-${RUN_ID}`,
    "actor-3585",
    { [fieldName]: `answer-for-${fieldName}` },
    fieldName,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  H.row = null;
  H.template = null;
  H.declaration = null;
  H.lastAnswer = null;
  H.parks.length = 0;
  H.edges.length = 0;
  H.failNextEnqueue = false;
  H.knownJobIds.clear();
  H.duplicatesSwallowed.length = 0;
  H.pending.length = 0;
  H.seq = 0;
  triggerStoreMock.readRunTriggerByRunId.mockResolvedValue(null);
});

afterEach(() => {
  // The package's FULL run must stay green with this file present: every mock
  // this file mounted is restored and no module graph is left rewritten.
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

/**
 * Drives one declaration through the real setup road: start the run, then for
 * every required field in turn assert the run is parked on THAT field (the
 * ordinal, not merely the count), answer it, and drain the jobs the queue really
 * created. After the LAST field the assertion is the hand-over instead: the run
 * reaches the state the schedule step is drawn from.
 */
async function drive(declaration: Declaration): Promise<void> {
  seed(declaration);

  await runAgentBuilderExecutionJob({ runId: RUN_ID }, "job-start");

  const required = declaration.required;
  for (let n = 0; n < required.length; n += 1) {
    const fieldName = required[n]!;
    // Parked on field n+1 — the run is waiting, and it is waiting on THIS field.
    expect(H.row!.status, `run should be parked on field ${n + 1} (${fieldName})`).toBe(
      "pending_approval",
    );
    expect(H.parks[H.parks.length - 1], `park ${n + 1} names ${fieldName}`).toBe(
      parkLabel(fieldName),
    );

    await answer(fieldName);
    await drainQueue();
  }

  // Every field is in, so the run is handed over instead of parked again.
  expect(H.parks).toEqual(required.map((f) => parkLabel(f)));
  // cinatra#3585, the cut itself: every confirmation asked the queue for an id
  // of its own, so NONE of them was swallowed as a duplicate of an earlier one.
  // Under the old constant `resume-setup-<runId>` this list held one entry per
  // confirmation after the first.
  expect(H.duplicatesSwallowed).toEqual([]);
  expect(H.row!.status, "the run reaches the state the schedule step is drawn from").toBe(
    "pending_trigger",
  );
}

describe("cinatra#3585 — the run asks for every required start field", () => {
  it("asks for all three of a three-field declaration in order and then hands the run to the schedule step", async () => {
    await drive(THREE_REQUIRED);
  });

  it("asks for all six of a six-field declaration in order and then hands the run to the schedule step", async () => {
    await drive(SIX_REQUIRED);
  });

  it("lands the run failed, naming the field, when the resume cannot be handed back to the runner", async () => {
    seed(THREE_REQUIRED);
    await runAgentBuilderExecutionJob({ runId: RUN_ID }, "job-start");
    expect(H.row!.status).toBe("pending_approval");

    // The runner cannot be reached for this confirmation. The caller is told the
    // REAL cause — the enqueue failure itself, not a secondary one.
    H.failNextEnqueue = true;
    await expect(answer("postArtifactId")).rejects.toThrow("queue unreachable");

    // The reading is ON THE RUN, not only in the thrown error.
    expect(H.row!.status).toBe("failed");
    expect(String(H.row!.error)).toContain("postArtifactId");
    expect(String(H.row!.error).toLowerCase()).toContain("handed back");
  });

  it("still reports the enqueue failure when the run cannot even be landed failed", async () => {
    seed(THREE_REQUIRED);
    await runAgentBuilderExecutionJob({ runId: RUN_ID }, "job-start");
    expect(H.row!.status).toBe("pending_approval");

    // The runner cannot be reached AND the compensating write is refused too
    // (an archived org refuses the terminal capability, a database outage, …).
    // The caller must still be told the enqueue failure, which is the real
    // cause: a secondary failure must never replace it.
    H.failNextEnqueue = true;
    vi.mocked(transitionRunStatus).mockRejectedValueOnce(new Error("org archived"));
    await expect(answer("postArtifactId")).rejects.toThrow("queue unreachable");

    // Nothing was landed, because the landing itself was refused — the run is
    // left exactly where the refused write found it.
    expect(H.row!.status).toBe("queued");
  });
});
