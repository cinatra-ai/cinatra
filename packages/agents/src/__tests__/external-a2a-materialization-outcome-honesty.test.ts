import { describe, it, expect, vi, beforeEach } from "vitest";

// cinatra#2497 — the external-A2A terminal path must run the SAME
// materialization-honesty contract #2496 established for the WayFlow path.
//
// Before this suite, the external branch of `runAgentBuilderExecutionJobInner`
// awaited the SSE proxy and then transitioned `running -> completed` with NO
// artifact materialization at all (an acknowledged v1 deferral), so an external
// run whose package declares artifact bindings reported a clean success having
// produced nothing — the silent-success class #2486 closed for the primary path.
//
// The contract pinned here:
//   * declared bindings are materialized at completion, resolved against the
//     stream's structured declared outputs (its merged artifact DATA parts);
//   * ANY failed outcome lands the run `failed`, with the reason in
//     `agent_runs.error` and the full outcome list in the same `stepResults`
//     payload the success edge writes, plus RUN_ERROR and no RUN_FINISHED;
//   * a run with NO declared bindings completes exactly as before — including
//     the non-cinatra external peer, whose connector-derived package name does
//     not resolve in the registry at all.
//
// Driven through the REAL external dispatch branch (`runAgentBuilderExecutionJob`)
// so the wiring — proxy hook → captured outputs → materializer → verdict — is
// proven, not just the helper in isolation.

const { publishAgUiEventSpy, materializeRunArtifactsSpy } = vi.hoisted(() => ({
  publishAgUiEventSpy: vi.fn(async () => undefined),
  materializeRunArtifactsSpy: vi.fn<
    (input: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>
  >(async () => []),
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
  // cinatra#2485 C: the shared run-scope guard rides `./store`'s surface.
  assertAgentRunScopeAuthorized: vi.fn(async () => undefined),
  assertAgentRunDispatchAuthorized: vi.fn(async () => undefined),
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(async () => null as unknown),
  readAgentTemplates: vi.fn(async () => []),
  readAgentTemplateVersionBySemver: vi.fn(async () => null),
  readAgentTemplateVersionById: vi.fn(async () => null),
  transitionRunStatus: vi.fn<
    (
      runId: string,
      from: string,
      to: string,
      meta?: Record<string, unknown>,
      authority?: unknown,
    ) => Promise<undefined>
  >(async () => undefined),
  RunTransitionError: class RunTransitionError extends Error {
    code: string;
    constructor(args: { code: string }) {
      super(args.code);
      this.code = args.code;
    }
  },
  findSavedConnectionForAgentUrl: vi.fn(() => ({
    providerConfigKey: "a2a-server",
    connectionId: "peer-1",
  })),
  updateAgentRunA2ATaskId: vi.fn(async () => undefined),
  updateAgentRunA2AContextId: vi.fn(async () => undefined),
  setAgentRunTokenHash: vi.fn(async () => undefined),
}));
vi.mock("../store", () => storeMock);
// cinatra#2485 C: the install-scope run gate reads the agent_templates /
// agent_runs rows straight from the DB. This suite already mocks the
// persistence hub (`../store`), so it mocks the gate's persistence too. The
// gate's own behavior is proven in `agent-template-scope.test.ts` (the
// four-level rule), `agent-run-scope-guard.test.ts` (the per-path matrix +
// fire-time recheck) and `agent-run-scope-enforcement-wiring.test.ts` (that all
// three layers actually call it).
vi.mock("../agent-run-serde", async (orig) => ({
  ...(await orig<typeof import("../agent-run-serde")>()),
  assertAgentRunScopeAuthorized: vi.fn(async () => undefined),
  assertAgentRunDispatchAuthorized: vi.fn(async () => undefined),
}));



vi.mock("../trigger-gate", () => ({ isTriggerReleased: vi.fn(async () => true) }));
vi.mock("../skill-autosave", () => ({
  runSkillAutosaveOnRunCompletion: vi.fn(async () => undefined),
}));
vi.mock("../wayflow-url", () => ({
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
  WAYFLOW_A2A_TIMEOUT_MS: 86_400_000,
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  describeWayflowDispatchError: vi.fn((err: unknown) => String(err)),
  AGENT_RUN_TIMEOUT_MAX_SECONDS: 86_400,
}));

// Job-entry scaffolding around the branch under test — none of it is
// load-bearing for the materialization contract, so it is stubbed inert.
vi.mock("@/lib/org-write/agent-run-authority-mint", () => ({
  mintAgentRunExecutionAuthority: vi.fn((orgId: string) => ({ orgId, can: () => true })),
}));
vi.mock("@/lib/org-write/dispatch-freeze", () => ({
  readOrgArchivedAtForDispatch: vi.fn(async () => null),
}));
vi.mock("@/lib/agents-store", () => ({
  getAssignedSkillIdsForAgent: vi.fn(async () => [] as string[]),
}));
vi.mock("@/lib/agent-run-skills-used", () => ({
  snapshotSkillsAtRunStart: vi.fn(async () => undefined),
}));
vi.mock("@/lib/run-selected-skill-revisions", () => ({
  // The pre-start selection clear (cinatra#3047) — a no-op for these arms,
  // which is exactly what it is on a run that has nothing to clear.
  clearRunSelectedSkillRevisionsBeforeStart: vi.fn(() => 0),
  // The pre-start selection REPLACE (cinatra#3047) — the hold-bound confirm's
  // one guarded write. `true` = it applied, which is what a pre-start run gives.
  replaceRunSelectedSkillRevisionsBeforeStart: vi.fn(() => true),
  readRunSelectedSkillRevisions: vi.fn(() => null),
}));
vi.mock("@cinatra-ai/skills/recommendation", () => ({
  resolveRunSkillDelivery: vi.fn(() => ({ skillIds: [] as string[] })),
}));
vi.mock("../recommendation-interception", () => ({
  autoApplyHeadlessRecommendation: vi.fn(async () => undefined),
  parseLifecycleConfig: vi.fn(() => null),
}));
const enqueueBackgroundJobSpy = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/background-jobs", () => ({ enqueueBackgroundJob: enqueueBackgroundJobSpy }));
vi.mock("@/lib/nango-system", () => ({
  getNangoConnection: vi.fn(async () => ({ credentials: { apiKey: "tok" } })),
}));

// The external A2A seam. `startExternalSseProxyFromStream` is replaced by a
// scriptable double that reproduces the real proxy's clean-completion contract
// (pinned independently by the packages/a2a suite): it invokes the caller's
// `onCleanCompletion` hook exactly once with the merged data parts, or not at
// all when the stream did not end cleanly.
const proxyState = vi.hoisted(() => ({
  cleanCompletion: true,
  structuredOutputs: null as Record<string, unknown> | null,
  lastRemoteState: "completed",
  lastOptions: null as Record<string, unknown> | null,
}));
vi.mock("@cinatra-ai/a2a", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    rememberLatestWayflowGateTask: vi.fn(async () => undefined),
    rememberWayflowGateTask: vi.fn(async () => undefined),
    getOrAddWayflowRendererGateIndex: vi.fn(async () => 0),
    createExternalA2AClient: vi.fn(async () => ({
      streamTask: () =>
        (async function* () {
          yield { kind: "status-update", id: "ext-task-2497", status: { state: "working" } };
        })(),
    })),
    startExternalSseProxyFromStream: vi.fn(
      async (
        _stream: unknown,
        _initialStatus: string,
        _runId: string,
        options?: Record<string, unknown>,
      ) => {
        proxyState.lastOptions = options ?? null;
        const hook = options?.onCleanCompletion as
          | ((result: {
              outputs: Record<string, unknown> | null;
              lastRemoteState: string;
            }) => void)
          | undefined;
        if (proxyState.cleanCompletion && hook) {
          hook({
            outputs: proxyState.structuredOutputs,
            lastRemoteState: proxyState.lastRemoteState,
          });
        }
      },
    ),
  };
});

import { runAgentBuilderExecutionJob } from "../execution";
import type { AgentRunRecord } from "../store";

const ORG = "org-ext";

function makeRun(): AgentRunRecord {
  return {
    id: "run-ext-1",
    templateId: "tmpl-ext-1",
    versionId: null,
    runBy: "user-a",
    status: "queued",
    inputParams: { topic: "widgets" },
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
    orgId: ORG,
    projectId: null,
    idempotencyKey: null,
    oboCeiling: null,
    dependentInstallId: null,
    humanPresent: null,
    executionAttemptId: null,
  } as unknown as AgentRunRecord;
}

/** An external A2A template, shaped as `upsertExternalAgentTemplate` writes one. */
function makeExternalTemplate() {
  return {
    id: "tmpl-ext-1",
    orgId: null,
    creatorId: null,
    name: "Peer Agent",
    description: null,
    sourceNl: "",
    compiledPlan: [],
    inputSchema: {},
    outputSchema: null,
    taskSpec: null,
    status: "active",
    type: "leaf",
    packageName: "@peer-1/blog-draft-writer-agent",
    packageVersion: null,
    sourceType: "external",
    agentUrl: "https://peer.test/a2a",
    connectorSlug: "peer-1",
    remoteAgentId: "blog-draft-writer-agent",
    executionProvider: "default",
    hitlRequired: false,
    gatedSteps: [],
    triggerMode: null,
    agentDependencies: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };
}

/** The LAST transition the run made — the terminal verdict under test. */
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

const FAILED_BINDING_OUTCOME = {
  ok: false,
  outputId: "draft",
  nodeId: "end",
  extension: "@cinatra-ai/blog-post-artifact",
  error: 'contentFrom output "content" did not resolve to a string',
};

const OK_BINDING_OUTCOME = {
  ok: true,
  outputId: "draft",
  nodeId: "end",
  extension: "@cinatra-ai/blog-post-artifact",
  artifactId: "art-1",
  representationRevisionId: "rev-1",
  deduped: false,
};

describe("cinatra#2497 — external-A2A completion is honest about artifact materialization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    proxyState.cleanCompletion = true;
    proxyState.structuredOutputs = { title: "A draft", content: "the body" };
    proxyState.lastRemoteState = "completed";
    proxyState.lastOptions = null;
    materializeRunArtifactsSpy.mockResolvedValue([]);
    storeMock.readAgentRunById.mockResolvedValue(makeRun());
    storeMock.readAgentTemplateById.mockResolvedValue(makeExternalTemplate());
    storeMock.transitionRunStatus.mockResolvedValue(undefined);
    storeMock.findSavedConnectionForAgentUrl.mockReturnValue({
      providerConfigKey: "a2a-server",
      connectionId: "peer-1",
    });
  });

  it("materializes the run's declared bindings against the stream's structured outputs", async () => {
    materializeRunArtifactsSpy.mockResolvedValue([OK_BINDING_OUTCOME]);

    await runAgentBuilderExecutionJob({ runId: "run-ext-1" }, "job-ext-1");

    // The v1 deferral was "no materialization at all" — the pass must now run,
    // and it must resolve bindings against what the stream actually surfaced.
    expect(materializeRunArtifactsSpy).toHaveBeenCalledTimes(1);
    expect(materializeRunArtifactsSpy.mock.calls[0]![0]).toMatchObject({
      runId: "run-ext-1",
      orgId: ORG,
      templateId: "tmpl-ext-1",
      createdBy: "user-a",
      endNodeOutputs: { title: "A draft", content: "the body" },
    });
  });

  it("a per-binding materialization failure lands the run FAILED, not a silent green", async () => {
    materializeRunArtifactsSpy.mockResolvedValue([FAILED_BINDING_OUTCOME]);

    await runAgentBuilderExecutionJob({ runId: "run-ext-1" }, "job-ext-1");

    const [runId, from, to, meta] = lastTransition();
    expect(runId).toBe("run-ext-1");
    expect(from).toBe("running");
    expect(to).toBe("failed");
    // The reason reaches the run-status/UI surface, not just a log line.
    // Issue 3033: the persisted `error` is now the drawn floor -
    // a sanitized package / slot / reason triple - and the producer's own
    // sentence keeps going to the server log (execution.ts writes one warn per
    // failed outcome before this composes); this suite asserts the PERSISTED row.
    expect(String(meta?.error)).toContain("draft");
    expect(String(meta?.error)).toContain("output-not-produced");
    expect(String(meta?.error)).not.toContain("did not resolve to a string");
    // ...and the full evidence lands in the same payload a green run would carry.
    const stepResults = meta?.stepResults as Array<Record<string, unknown>>;
    expect(Array.isArray(stepResults)).toBe(true);
    expect(stepResults[0]?.kind).toBe("external_a2a_response");
    expect(stepResults[0]?.a2aTaskId).toBe("ext-task-2497");
    expect(stepResults[0]?.artifact_materializations).toEqual([FAILED_BINDING_OUTCOME]);
    expect(stepResults[0]?.output_data).toEqual({ title: "A draft", content: "the body" });

    const types = agUiEventTypes();
    expect(types).toContain("RUN_ERROR");
    expect(types).not.toContain("RUN_FINISHED");
  });

  it("a mixed batch still fails the run — a partially materialized run is not a success", async () => {
    materializeRunArtifactsSpy.mockResolvedValue([
      OK_BINDING_OUTCOME,
      { ...FAILED_BINDING_OUTCOME, outputId: "summary" },
    ]);

    await runAgentBuilderExecutionJob({ runId: "run-ext-1" }, "job-ext-1");

    const [, , to, meta] = lastTransition();
    expect(to).toBe("failed");
    expect(String(meta?.error)).toContain("review target unavailable");
    expect(String(meta?.error)).toContain("summary");
    // Nothing is dropped: the successful ref is preserved alongside the failure.
    expect(meta?.stepResults as unknown[]).toBeDefined();
    const outcomes = (meta?.stepResults as Array<Record<string, unknown>>)[0]
      ?.artifact_materializations as unknown[];
    expect(outcomes).toHaveLength(2);
  });

  it("a THROWN materialization pass fails the run rather than completing it blind", async () => {
    materializeRunArtifactsSpy.mockRejectedValue(new Error("artifact stack unavailable"));

    await runAgentBuilderExecutionJob({ runId: "run-ext-1" }, "job-ext-1");

    const [, , to, meta] = lastTransition();
    expect(to).toBe("failed");
    expect(String(meta?.error)).toContain("(materializer)");
    expect(String(meta?.error)).toContain("materializer-failed");
    expect(String(meta?.error)).not.toContain("artifact stack unavailable");
    expect(agUiEventTypes()).not.toContain("RUN_FINISHED");
  });

  it("all-successful materializations still complete cleanly, carrying the refs", async () => {
    materializeRunArtifactsSpy.mockResolvedValue([OK_BINDING_OUTCOME]);

    await runAgentBuilderExecutionJob({ runId: "run-ext-1" }, "job-ext-1");

    const [, from, to, meta] = lastTransition();
    expect(from).toBe("running");
    expect(to).toBe("completed");
    expect(meta?.error).toBeUndefined();
    const stepResults = meta?.stepResults as Array<Record<string, unknown>>;
    expect(stepResults[0]?.artifact_materializations).toEqual([OK_BINDING_OUTCOME]);

    const types = agUiEventTypes();
    expect(types).toContain("RUN_FINISHED");
    expect(types).not.toContain("RUN_ERROR");
  });

  it("a run whose package declares NO bindings completes exactly as before", async () => {
    materializeRunArtifactsSpy.mockResolvedValue([]);

    await runAgentBuilderExecutionJob({ runId: "run-ext-1" }, "job-ext-1");

    const [, from, to, meta] = lastTransition();
    expect(from).toBe("running");
    expect(to).toBe("completed");
    // Byte-identical to the pre-#2497 terminal write: no meta at all.
    expect(meta).toBeUndefined();
    expect(agUiEventTypes()).toContain("RUN_FINISHED");
  });

  it("an ordinary A2A peer whose package is provably absent completes — a 404 is positive evidence of no bindings", async () => {
    // An external template's package name is `@{connectorSlug}/{remoteAgentId}`.
    // It resolves ONLY when the peer really is a published cinatra agent; a
    // DEFINITIVE 404 therefore proves this peer declares no binding at all.
    // Failing closed on it (the WayFlow posture) would fail EVERY such run.
    materializeRunArtifactsSpy.mockResolvedValue([
      {
        ok: false,
        outputId: "(binding-resolution)",
        nodeId: null,
        extension: null,
        bindingResolution: "package-not-found",
        error:
          "failed to load the run package's artifact bindings: 404 Not Found - GET https://registry.test/@peer-1%2fblog-draft-writer-agent",
      },
    ]);

    await runAgentBuilderExecutionJob({ runId: "run-ext-1" }, "job-ext-1");

    const [, , to, meta] = lastTransition();
    expect(to).toBe("completed");
    // Not persisted either: it would stamp a permanent false-alarm outcome on
    // every external run's stepResults (which A2A callers are served).
    expect(meta).toBeUndefined();
  });

  it("a registry OUTAGE still fails the run — an unreadable package is not proof that nothing was owed", async () => {
    // The #2486 Trigger-A regression this gate must not reopen: a federated
    // cinatra peer whose package really does declare bindings, during a
    // transient registry failure. `unavailable` is evidence-free, so it stays
    // fatal exactly as on the WayFlow path — only a proven 404 is tolerated.
    materializeRunArtifactsSpy.mockResolvedValue([
      {
        ok: false,
        outputId: "(binding-resolution)",
        nodeId: null,
        extension: null,
        bindingResolution: "unavailable",
        error:
          "failed to load the run package's artifact bindings: connect ECONNREFUSED 127.0.0.1:4873",
      },
    ]);

    await runAgentBuilderExecutionJob({ runId: "run-ext-1" }, "job-ext-1");

    const [, , to, meta] = lastTransition();
    expect(to).toBe("failed");
    expect(String(meta?.error)).toContain("binding-resolution-failed");
    expect(String(meta?.error)).not.toContain("ECONNREFUSED");
    expect(agUiEventTypes()).toContain("RUN_ERROR");
  });

  it("forwards the run's OWN template + version pin, so cinatra#2498's short-circuit reaches this path", async () => {
    // cinatra#2498 narrows the outage above: a template the host can locally
    // PROVE declares no binding at the run's pinned version never reads the
    // registry at all, so it cannot produce the `unavailable` outcome this path
    // (correctly) treats as fatal. That short-circuit lives inside the
    // materializer and is pinned there
    // (src/lib/artifacts/__tests__/run-artifact-materializer.test.ts — "a run
    // whose package is locally known to declare NO bindings survives a registry
    // outage (never calls the registry)"). What THIS path owes it is the pair of
    // inputs its version-pin guard consults: the run's own `templateId` and its
    // pinned `packageVersion`, forwarded unchanged. Pinned here so a future
    // refactor cannot quietly pass the TEMPLATE's version (or drop the pin) and
    // silently disable the narrowing for every external run — the two halves
    // compose into: a provably binding-less pinned template completes cleanly
    // through external A2A while the registry is down.
    storeMock.readAgentRunById.mockResolvedValue({
      ...makeRun(),
      packageVersion: "1.2.3",
    } as unknown as AgentRunRecord);
    // What the short-circuit returns for that run — no registry read happened,
    // so there is no wholesale outcome for this path to weigh at all.
    materializeRunArtifactsSpy.mockResolvedValue([]);

    await runAgentBuilderExecutionJob({ runId: "run-ext-1" }, "job-ext-1");

    expect(materializeRunArtifactsSpy).toHaveBeenCalledTimes(1);
    expect(materializeRunArtifactsSpy.mock.calls[0]![0]).toMatchObject({
      templateId: "tmpl-ext-1",
      packageVersion: "1.2.3",
    });
    const [, from, to, meta] = lastTransition();
    expect(from).toBe("running");
    expect(to).toBe("completed");
    // Byte-identical to the pre-#2497 terminal write: nothing was owed.
    expect(meta).toBeUndefined();
    expect(agUiEventTypes()).toContain("RUN_FINISHED");
    expect(agUiEventTypes()).not.toContain("RUN_ERROR");
  });

  it.each([
    "failed",
    "canceled",
    "rejected",
    "working",
    "submitted",
    "input-required",
    "auth-required",
    "unknown",
  ])(
    'a remote task last seen "%s" materializes nothing — only an observed "completed" is success',
    async (state) => {
      // The stream ends cleanly in all of these: a peer that reports `failed`
      // closes normally, and so does one that simply stops mid-flight. Writing
      // artifacts for the former, or failing the run for outputs the latter had
      // not produced yet, are both wrong — hence an ALLOW-list.
      proxyState.lastRemoteState = state;
      materializeRunArtifactsSpy.mockResolvedValue([OK_BINDING_OUTCOME]);

      await runAgentBuilderExecutionJob({ runId: "run-ext-1" }, "job-ext-1");

      expect(materializeRunArtifactsSpy).not.toHaveBeenCalled();
      // Verdict deliberately unchanged from before #2497 (remote-state honesty
      // is a separate contract, tracked as a residual) — but nothing was written.
      const [, , to, meta] = lastTransition();
      expect(to).toBe("completed");
      expect(meta).toBeUndefined();
    },
  );

  it("a lost CAS on the failure edge emits no RUN_ERROR — the DB winner owns the verdict", async () => {
    materializeRunArtifactsSpy.mockResolvedValue([FAILED_BINDING_OUTCOME]);
    storeMock.transitionRunStatus.mockImplementation(
      async (_runId: string, _from: string, to: string) => {
        if (to === "failed") {
          throw new storeMock.RunTransitionError({ code: "stale_from_status" });
        }
        return undefined;
      },
    );

    await runAgentBuilderExecutionJob({ runId: "run-ext-1" }, "job-ext-1");

    const [, , to] = lastTransition();
    expect(to).toBe("failed");
    const types = agUiEventTypes();
    expect(types).not.toContain("RUN_ERROR");
    expect(types).not.toContain("RUN_FINISHED");
  });

  it("an unexpected transition error still reaches the panel — the surrendered RUN_ERROR is not lost", async () => {
    // The proxy handed terminal AG-UI ownership to this branch and published
    // nothing itself. If the finalize path throws a non-stale error, the outer
    // failure handler must therefore publish RUN_ERROR itself, or the panel
    // spins forever on a run the DB already marked failed.
    materializeRunArtifactsSpy.mockResolvedValue([OK_BINDING_OUTCOME]);
    storeMock.transitionRunStatus.mockImplementation(
      async (_runId: string, _from: string, to: string) => {
        if (to === "completed") throw new Error("connection terminated unexpectedly");
        return undefined;
      },
    );

    await runAgentBuilderExecutionJob({ runId: "run-ext-1" }, "job-ext-1");

    const [, , to, meta] = lastTransition();
    expect(to).toBe("failed");
    expect(String(meta?.error)).toContain("connection terminated unexpectedly");
    expect(agUiEventTypes()).toContain("RUN_ERROR");
  });

  it("a stream that did not complete cleanly materializes nothing and stays as before", async () => {
    // Timeout / stream-error end: the proxy already published its own RUN_ERROR
    // and never handed over structured outputs. Stream-completion honesty is a
    // separate contract — this run's verdict is deliberately unchanged — but the
    // terminal AG-UI success is NOT ours to announce on top of that error.
    proxyState.cleanCompletion = false;
    materializeRunArtifactsSpy.mockResolvedValue([]);

    await runAgentBuilderExecutionJob({ runId: "run-ext-1" }, "job-ext-1");

    // A broken stream produced no verdict-worthy success: nothing is
    // materialized, and the proxy keeps terminal AG-UI ownership.
    expect(materializeRunArtifactsSpy).not.toHaveBeenCalled();
    const [, , to, meta] = lastTransition();
    expect(to).toBe("completed");
    expect(meta).toBeUndefined();
    expect(agUiEventTypes()).not.toContain("RUN_FINISHED");
    expect(agUiEventTypes()).not.toContain("RUN_ERROR");
  });

  it("takes the proxy's clean-completion hook, so the proxy does not announce success first", async () => {
    materializeRunArtifactsSpy.mockResolvedValue([FAILED_BINDING_OUTCOME]);

    await runAgentBuilderExecutionJob({ runId: "run-ext-1" }, "job-ext-1");

    // The hook is what transfers terminal AG-UI ownership to this branch; without
    // it the panel would show RUN_FINISHED ahead of the contradicting RUN_ERROR.
    expect(typeof proxyState.lastOptions?.onCleanCompletion).toBe("function");
  });
});
