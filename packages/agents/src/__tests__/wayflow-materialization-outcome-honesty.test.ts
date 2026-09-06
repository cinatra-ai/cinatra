import { describe, it, expect, vi, beforeEach } from "vitest";

// cinatra#2486 — a run must never present as a CLEAN SUCCESS when the artifact
// materialization it declared actually failed.
//
// Before this suite, `handleWayflowTaskState`'s terminal-success branch called
// `materializeRunArtifacts`, logged any `ok:false` outcome, spliced it into
// `stepResults`, and then transitioned the run to `completed` regardless — so
// "the run is green" could mean "silently produced nothing". Both grounded
// triggers from the issue are covered here:
//
//   Trigger A — registry unreachable: the materializer's wholesale
//     `(binding-resolution)` failure outcome.
//   Trigger B — the write node's output was not parseable into the bound
//     shape: a per-binding `contentFrom`/`titleFrom` resolution failure.
//
// Both must land in the SURFACED-failure path: status `failed`, an `error`
// naming the materialization failure, a RUN_ERROR AG-UI event, and no
// RUN_FINISHED/`completed` claim.

const { publishAgUiEventSpy, materializeRunArtifactsSpy } = vi.hoisted(() => ({
  publishAgUiEventSpy: vi.fn(async () => undefined),
  materializeRunArtifactsSpy: vi.fn(async () => [] as Array<Record<string, unknown>>),
}));

vi.mock("@cinatra-ai/agent-ui-protocol/server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    publishAgUiEvent: publishAgUiEventSpy,
    enrichSchemaWithResolvedData: vi.fn(async (schema: unknown) => ({ ...(schema as object) })),
    DualAdapterDispatch: class MockDualAdapterDispatch {
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

vi.mock("@/lib/artifacts/run-artifact-materializer", () => ({
  materializeRunArtifacts: materializeRunArtifactsSpy,
}));

const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(async () => null),
  readAgentTemplates: vi.fn(async () => []),
  readAgentTemplateVersionBySemver: vi.fn(async () => null),
  readAgentTemplateVersionById: vi.fn(async () => null),
  transitionRunStatus: vi.fn(async () => undefined),
  RunTransitionError: class RunTransitionError extends Error {
    code: string;
    constructor(args: { code: string }) {
      super(args.code);
      this.code = args.code;
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
vi.mock("@cinatra-ai/a2a", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    rememberLatestWayflowGateTask: vi.fn(async () => undefined),
    rememberWayflowGateTask: vi.fn(async () => undefined),
    getOrAddWayflowRendererGateIndex: vi.fn(async () => 0),
  };
});
const enqueueBackgroundJobSpy = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/background-jobs", () => ({ enqueueBackgroundJob: enqueueBackgroundJobSpy }));

import { handleWayflowTaskState, CINATRA_ENDNODE_OUTPUTS_SENTINEL } from "../execution";
import type { AgentRunRecord } from "../store";

const TEST_AUTHORITY = { orgId: "org-mat", can: () => true };

function makeRun(): AgentRunRecord {
  return {
    id: "run-mat-1",
    templateId: "tmpl-mat-1",
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
    packageVersion: "1.0.0",
    a2aTaskId: "task-mat-1",
    a2aContextId: "ctx-mat-1",
    parentRunId: null,
    agUiEnabled: null,
    lgThreadId: null,
    traceId: null,
    timeoutSeconds: null,
    streamedText: null,
    authPolicy: null,
    orgId: "org-mat",
    projectId: null,
    idempotencyKey: null,
    oboCeiling: null,
    dependentInstallId: null,
  } as unknown as AgentRunRecord;
}

function completedTask(outputs: Record<string, unknown>) {
  return {
    id: "task-mat-1",
    contextId: "ctx-mat-1",
    status: { state: "completed", message: { parts: [] } },
    metadata: {},
    history: [
      { role: "agent", parts: [{ kind: "text", text: "here is the draft" }] },
      {
        role: "agent",
        parts: [
          {
            kind: "data",
            data: { [CINATRA_ENDNODE_OUTPUTS_SENTINEL]: outputs },
          },
        ],
      },
    ],
  };
}

function lastTransition() {
  const calls = storeMock.transitionRunStatus.mock.calls;
  return calls[calls.length - 1] as unknown as [
    string,
    string,
    string,
    Record<string, unknown> | undefined,
    unknown,
  ];
}

function agUiEventTypes(): string[] {
  return publishAgUiEventSpy.mock.calls.map(
    (c) => (c as unknown as [string, { type?: string }])[1]?.type ?? "",
  );
}

describe("cinatra#2486 — materialization failure is surfaced in the run outcome", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    materializeRunArtifactsSpy.mockResolvedValue([]);
  });

  it("Trigger A (registry unreachable): the wholesale binding-resolution failure fails the run", async () => {
    materializeRunArtifactsSpy.mockResolvedValue([
      {
        ok: false,
        outputId: "(binding-resolution)",
        nodeId: null,
        extension: null,
        error:
          "failed to load the run package's artifact bindings: connect ECONNREFUSED 127.0.0.1:4873",
      },
    ]);

    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: "run-mat-1",
      run: makeRun(),
      fromStatus: "running",
      task: completedTask({ title: "T", content: "C" }),
    });

    const [runId, from, to, meta] = lastTransition();
    expect(runId).toBe("run-mat-1");
    expect(from).toBe("running");
    expect(to).toBe("failed");
    expect(String(meta?.error)).toContain("(binding-resolution)");
    expect(String(meta?.error)).toContain("ECONNREFUSED");
    // The evidence still lands: the same stepResults payload carries the
    // per-output outcomes, so the failure is inspectable, not just a log line.
    const stepResults = meta?.stepResults as Array<Record<string, unknown>>;
    expect(Array.isArray(stepResults)).toBe(true);
    expect(stepResults[0]?.artifact_materializations).toHaveLength(1);
    // A failing run is not a derivation-outbox success capture.
    expect(meta?.derivationOutbox).toBeUndefined();
    expect(meta?.completedAt).toBeUndefined();
    expect(enqueueBackgroundJobSpy).not.toHaveBeenCalled();

    const types = agUiEventTypes();
    expect(types).toContain("RUN_ERROR");
    expect(types).not.toContain("RUN_FINISHED");
  });

  it("Trigger B (unparseable write output): a per-binding resolution failure fails the run", async () => {
    materializeRunArtifactsSpy.mockResolvedValue([
      {
        ok: false,
        outputId: "draft",
        nodeId: "end",
        extension: "@cinatra-ai/blog-post-artifact",
        error: 'contentFrom output "content" did not resolve to a string',
      },
    ]);

    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: "run-mat-1",
      run: makeRun(),
      fromStatus: "running",
      task: completedTask({ output: "```json\n{...}\n```" }),
    });

    const [, , to, meta] = lastTransition();
    expect(to).toBe("failed");
    expect(String(meta?.error)).toContain("draft");
    expect(String(meta?.error)).toContain("did not resolve to a string");
    expect(agUiEventTypes()).not.toContain("RUN_FINISHED");
  });

  it("a mixed batch (one ok, one failed) still fails the run — a partial write is not a success", async () => {
    materializeRunArtifactsSpy.mockResolvedValue([
      {
        ok: true,
        outputId: "draft",
        nodeId: "end",
        extension: "@cinatra-ai/blog-post-artifact",
        artifactId: "art-1",
        representationRevisionId: "rev-1",
        deduped: false,
      },
      {
        ok: false,
        outputId: "summary",
        nodeId: "end",
        extension: "@cinatra-ai/text-artifact",
        error: 'titleFrom output "summary_title" did not resolve to a non-empty string',
      },
    ]);

    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: "run-mat-1",
      run: makeRun(),
      fromStatus: "running",
      task: completedTask({ title: "T", content: "C" }),
    });

    const [, , to, meta] = lastTransition();
    expect(to).toBe("failed");
    expect(String(meta?.error)).toContain("summary");
  });

  it("a thrown materialization pass (defense-in-depth catch) fails the run", async () => {
    materializeRunArtifactsSpy.mockRejectedValue(new Error("boom in the materializer"));

    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: "run-mat-1",
      run: makeRun(),
      fromStatus: "running",
      task: completedTask({ title: "T", content: "C" }),
    });

    const [, , to, meta] = lastTransition();
    expect(to).toBe("failed");
    expect(String(meta?.error)).toContain("boom in the materializer");
  });

  it("resume terminal-success from pending_approval also fails honestly", async () => {
    materializeRunArtifactsSpy.mockResolvedValue([
      {
        ok: false,
        outputId: "draft",
        nodeId: "end",
        extension: "@cinatra-ai/blog-post-artifact",
        error: "write refused",
      },
    ]);

    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: "run-mat-1",
      run: makeRun(),
      fromStatus: "pending_approval",
      task: completedTask({ title: "T", content: "C" }),
    });

    const [, from, to] = lastTransition();
    expect(from).toBe("pending_approval");
    expect(to).toBe("failed");
  });

  it("a lost CAS on the failure edge publishes NO RUN_ERROR (the DB winner owns the verdict)", async () => {
    materializeRunArtifactsSpy.mockResolvedValue([
      {
        ok: false,
        outputId: "draft",
        nodeId: "end",
        extension: "@cinatra-ai/blog-post-artifact",
        error: "write refused",
      },
    ]);
    // A concurrent stop/cancel already moved the row off `running`.
    storeMock.transitionRunStatus.mockRejectedValueOnce(
      new storeMock.RunTransitionError({ code: "stale_from_status" }),
    );

    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: "run-mat-1",
      run: makeRun(),
      fromStatus: "running",
      task: completedTask({ title: "T", content: "C" }),
    });

    const [, , to] = lastTransition();
    expect(to).toBe("failed");
    const types = agUiEventTypes();
    expect(types).not.toContain("RUN_ERROR");
    expect(types).not.toContain("RUN_FINISHED");
    expect(enqueueBackgroundJobSpy).not.toHaveBeenCalled();
  });

  it("all-successful materializations still complete cleanly (no false failure)", async () => {
    materializeRunArtifactsSpy.mockResolvedValue([
      {
        ok: true,
        outputId: "draft",
        nodeId: "end",
        extension: "@cinatra-ai/blog-post-artifact",
        artifactId: "art-1",
        representationRevisionId: "rev-1",
        deduped: false,
      },
    ]);

    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: "run-mat-1",
      run: makeRun(),
      fromStatus: "running",
      task: completedTask({ title: "T", content: "C" }),
    });

    const [, , to, meta] = lastTransition();
    expect(to).toBe("completed");
    expect(meta?.error).toBeUndefined();
    expect(agUiEventTypes()).toContain("RUN_FINISHED");
  });

  it("a run declaring no bindings is untouched — empty outcomes still complete", async () => {
    materializeRunArtifactsSpy.mockResolvedValue([]);

    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: "run-mat-1",
      run: makeRun(),
      fromStatus: "running",
      task: completedTask({ title: "T", content: "C" }),
    });

    const [, , to, meta] = lastTransition();
    expect(to).toBe("completed");
    expect(meta?.stepResults).toBeDefined();
    expect(
      (meta?.stepResults as Array<Record<string, unknown>>)[0]?.artifact_materializations,
    ).toBeUndefined();
  });
});

/**
 * cinatra#3208 — the OTHER half of the drifted-declaration proof. The
 * materializer's own suite
 * (src/lib/artifacts/__tests__/run-artifact-executed-declaration.test.ts) pins
 * WHICH declaration is resolved; these two pin what the run then STORES, over
 * the exact outcome arrays that suite records for the same fixture — the
 * blog-idea run whose executed declaration is the fan-out one while the package
 * registry still serves the retired scalar one.
 *
 * The composed sentence itself is built by module-private
 * `describeMaterializationFailure`, deliberately so: the honesty suites assert
 * it through the persisted `error`, which is the surface that actually matters.
 */
describe("cinatra#3208 — the stored run outcome follows the declaration that was resolved", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    materializeRunArtifactsSpy.mockResolvedValue([]);
  });

  it("the drifted registry declaration lands `failed` with the retired identifiers in agent_runs.error", async () => {
    // Verbatim the outcome the materializer produced for this run before
    // cinatra#3208 — and still produces for a template row that carries no
    // persisted declaration.
    materializeRunArtifactsSpy.mockResolvedValue([
      {
        ok: false,
        outputId: "ideaBatchDocument",
        nodeId: "endNode",
        extension: "@cinatra-ai/blog-idea-artifact",
        error: 'titleFrom output "ideaBatchTitle" did not resolve to a non-empty string',
      },
    ]);

    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: "run-mat-1",
      run: makeRun(),
      fromStatus: "running",
      task: completedTask({ title: "T", content: "C" }),
    });

    const [, , to, meta] = lastTransition();
    expect(to).toBe("failed");
    const error = String(meta?.error);
    expect(error).toContain(
      "artifact materialization failed — the run declared artifact output(s) it did not produce (1 of 1 failed)",
    );
    expect(error).toContain("ideaBatchDocument [@cinatra-ai/blog-idea-artifact]");
    expect(error).toContain('titleFrom output "ideaBatchTitle" did not resolve to a non-empty string');
  });

  it("the EXECUTED fan-out declaration lands `completed` with no error and one row per idea", async () => {
    materializeRunArtifactsSpy.mockResolvedValue([
      {
        ok: true,
        outputId: "ideas[0]",
        nodeId: "endNode",
        extension: "@cinatra-ai/blog-idea-artifact",
        artifactId: "art-1",
        representationRevisionId: "rep-1",
        deduped: false,
      },
      {
        ok: true,
        outputId: "ideas[1]",
        nodeId: "endNode",
        extension: "@cinatra-ai/blog-idea-artifact",
        artifactId: "art-2",
        representationRevisionId: "rep-2",
        deduped: false,
      },
    ]);

    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: "run-mat-1",
      run: makeRun(),
      fromStatus: "running",
      task: completedTask({ title: "T", content: "C" }),
    });

    const [, , to, meta] = lastTransition();
    expect(to).toBe("completed");
    expect(meta?.error).toBeUndefined();
    expect(
      (meta?.stepResults as Array<Record<string, unknown>>)[0]?.artifact_materializations,
    ).toHaveLength(2);
    expect(agUiEventTypes()).toContain("RUN_FINISHED");
  });
});
