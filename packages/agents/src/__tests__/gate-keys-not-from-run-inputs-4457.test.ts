import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// cinatra#4457 — a stored run input never stands in for a value-surfacing
// gate's own value, at the host boundary, on both roads.
//
// A gate that sets `metadata.cinatra.surfaceGateInputs` hands its values to the
// host only as its own message (one JSON object). These tests drive the real
// handleWayflowTaskState with such a gate and a run whose stored inputs hold
// values under the gate's keys, then read the gate back through the real
// deriveRunHitlContext:
//   - the INTERRUPT road: the frame the adapter emitted, after a JSON round trip
//     (what the event log stores);
//   - the DURABLE road: the row the park seam wrote, after a JSON round trip
//     (what the jsonb columns store), with no readable frame.
// When the message is absent or does not parse, the screen gets NO value for a
// gate key; a gate without the flag keeps its present values.
// ---------------------------------------------------------------------------

const { enrichSpy, onInterruptSpy, frameRoad, gateIndex } = vi.hoisted(() => ({
  enrichSpy: vi.fn(async (schema: unknown) => ({ ...(schema as object) })),
  onInterruptSpy: vi.fn(),
  // "frame": the reader serves the last emitted frame; "none": no frame.
  frameRoad: { mode: "frame" as "frame" | "none" },
  gateIndex: { value: 0 },
}));

const roundTrip = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function lastFrame() {
  const last = onInterruptSpy.mock.calls.at(-1) as
    | [Record<string, unknown>, string, Record<string, unknown>, string, string?]
    | undefined;
  if (!last) return null;
  const [schema, xRenderer, values, reviewTaskId, fieldName] = last;
  return roundTrip({ schema, xRenderer, values, reviewTaskId, ...(fieldName ? { fieldName } : {}) });
}

// Both package mocks are plain factories that never load the real package.
// With the real packages loaded inside the factories (the real
// `@cinatra-ai/a2a` imports `@cinatra-ai/agents`), hitl-context read the real
// event log (Redis) instead of this reader in a lane run.
vi.mock("@cinatra-ai/agent-ui-protocol/server", () => {
  class MockAdapter {
    onInterrupt = vi.fn();
  }
  return {
    AgUiAdapter: MockAdapter,
    A2UiAdapter: MockAdapter,
    publishAgUiEvent: vi.fn(async () => undefined),
    publishA2UiEvent: vi.fn(async () => undefined),
    A2UI_MID_RUN_TRANSLATOR_KINDS: {},
    enrichSchemaWithResolvedData: enrichSpy,
    // The park seam reads the frame back once (it must see it to park); the
    // HITL context reader then reads it on the interrupt road, or finds none
    // on the durable road.
    readLatestAgUiInterrupt: async () => (frameRoad.mode === "frame" ? lastFrame() : null),
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

const storeMock = vi.hoisted(() => {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    readAgentRunById: vi.fn(),
    readAgentTemplateById: vi.fn(),
    readAgentTemplates: vi.fn(async () => []),
    readAgentTemplateVersionBySemver: vi.fn(async () => null),
    readAgentTemplateVersionById: vi.fn(async () => null),
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
    writeDurableHitlGateArtifact: vi.fn(async (artifact: Record<string, unknown>) => {
      rows.push(roundTrip(artifact));
    }),
    readLatestDurableHitlGateArtifact: vi.fn(async () => {
      const row = rows.at(-1);
      return row ? roundTrip(row) : null;
    }),
  };
});
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
// Hermetic: no Redis. The renderer-gate index of a two-gate flow is served
// from `gateIndex`.
vi.mock("@cinatra-ai/a2a", () => {
  return {
    expireRunStream: vi.fn(async () => undefined),
    rememberLatestWayflowGateTask: vi.fn(async () => undefined),
    rememberWayflowGateTask: vi.fn(async () => undefined),
    rememberWayflowGateNodeClaim: vi.fn(async () => undefined),
    getOrAddWayflowRendererGateIndex: vi.fn(async () => gateIndex.value),
  };
});

import { handleWayflowTaskState } from "../execution";
import { deriveRunHitlContext } from "../hitl-context";
// The schema key that carries the withheld keys, spelled out so this file runs
// red against the base for its assertions, not for a missing module.
const GATE_KEYS_NOT_FROM_RUN_INPUTS = "x-gate-keys-not-from-run-inputs";
import type { AgentRunRecord } from "../store";

const TEST_AUTHORITY = { orgId: "org-1", can: () => true };

const SCHEMA_RENDERER = "@cinatra-ai/list-curator-agent:scrape-schema";
const LIST_RENDERER = "@cinatra-ai/list-curator-agent:list-review";
const GATE_SCHEMA = { type: "object" };
const SCHEMA_GATE_KEYS = ["outputSchema", "seedUrls", "plan"];
const LIST_GATE_KEYS = ["candidateMembers", "listName", "dispatchedRuns", "failures"];

function gateStep(stepNumber: number, xRenderer: string, keys?: string[]) {
  return {
    nodeType: "input_message",
    stepNumber,
    requiresApproval: true,
    hitlOwnedBy: "self",
    skipLlm: true,
    xRenderer,
    inputMessageField: "userResponse",
    inputMessageSchema: GATE_SCHEMA,
    ...(keys ? { surfaceGateInputKeys: keys } : {}),
  };
}

function makeTemplate(steps: unknown[]) {
  return {
    id: "tmpl-4457",
    orgId: null,
    creatorId: null,
    name: "List Curator",
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
    triggerMode: "none",
    approvalPolicy: { steps },
    agentDependencies: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };
}

// The run's stored inputs: the start inputs plus values under the gate keys.
const STORED = {
  listName: "Stored list",
  seedUrls: ["https://stored.test/s"],
  candidateMembers: [{ name: "Stored" }],
  outputSchema: { type: "object", properties: { stored: { type: "string" } } },
  plan: "stored plan",
  campaignNote: "kept",
};

function makeRun(inputParams: Record<string, unknown> = STORED): AgentRunRecord {
  return {
    id: "run-4457",
    templateId: "tmpl-4457",
    versionId: null,
    runBy: "user-a",
    status: "running",
    inputParams,
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

/** A gate task. `text` undefined = no agent message at all. */
function gateTask(text: string | undefined, pendingApproval: Record<string, unknown> = {}) {
  return {
    id: "task-4457",
    contextId: "ctx-4457",
    status: { state: "input-required", message: { parts: [] } },
    metadata: { pendingApproval },
    history: text === undefined ? [] : [{ role: "agent", parts: [{ kind: "text", text }] }],
  };
}

type Road = "interrupt" | "durable";

/** Emit the gate, then read it back as the screen does, on one road. */
async function emitAndRead(
  road: Road,
  task: ReturnType<typeof gateTask>,
  run: AgentRunRecord = makeRun(),
) {
  frameRoad.mode = "frame";
  await handleWayflowTaskState({
    authority: TEST_AUTHORITY,
    runId: run.id,
    run,
    fromStatus: "running",
    task,
  });
  expect(onInterruptSpy).toHaveBeenCalledTimes(1);
  expect(storeMock.writeDurableHitlGateArtifact).toHaveBeenCalledTimes(1);
  const emitted = lastFrame()!;
  const durableReadsBefore = storeMock.readLatestDurableHitlGateArtifact.mock.calls.length;
  frameRoad.mode = road === "interrupt" ? "frame" : "none";
  const parked = { ...run, status: "pending_approval", a2aTaskId: task.id } as AgentRunRecord;
  const ctx = await deriveRunHitlContext(parked);
  expect(ctx).not.toBeNull();
  // The context comes from the road under test.
  expect(ctx!.reviewTaskId).toBe(`wayflow-${task.id}`);
  const durableReads =
    storeMock.readLatestDurableHitlGateArtifact.mock.calls.length - durableReadsBefore;
  expect(durableReads, "durable row reads by the screen's reader").toBe(road === "durable" ? 1 : 0);
  return { emitted, ctx: ctx! };
}

// Gate messages the host cannot parse as one object, and the absent message.
const UNPARSEABLE: Array<[string, string | undefined]> = [
  ["absent (no agent message)", undefined],
  ["empty", ""],
  ["cut short", '{"candidateMembers": [{"name": "Act'],
  ["plain text", "The list is ready."],
  ["JSON followed by text", '{"candidateMembers": [{"name": "Actual"}]} trailing'],
  ["a value JSON.parse refuses (NaN)", '{"candidateMembers": NaN, "listName": "x"}'],
];
const ROADS: Road[] = ["interrupt", "durable"];

describe("cinatra#4457 — a value-surfacing gate's keys never come from run inputs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMock.rows.length = 0;
    frameRoad.mode = "frame";
    gateIndex.value = 0;
    enrichSpy.mockImplementation(async (schema: unknown) => ({ ...(schema as object) }));
    storeMock.readAgentTemplateById.mockResolvedValue(
      makeTemplate([gateStep(6, LIST_RENDERER, LIST_GATE_KEYS)]),
    );
  });

  describe.each(ROADS)("%s road", (road) => {
    it.each(UNPARSEABLE)("message %s: no gate key reaches the screen; other run inputs do", async (_l, text) => {
      const { emitted, ctx } = await emitAndRead(road, gateTask(text));
      for (const k of LIST_GATE_KEYS) {
        expect(Object.prototype.hasOwnProperty.call(emitted.values, k), `emitted ${k}`).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(ctx.currentValues, k), `screen ${k}`).toBe(false);
      }
      // Run inputs that are not keys of this gate keep reaching the screen.
      expect(ctx.currentValues.campaignNote).toBe("kept");
      expect(ctx.currentValues.seedUrls).toEqual(STORED.seedUrls);
      expect(ctx.xRenderer).toBe(LIST_RENDERER);
      // The keys left absent ride in the gate's schema.
      expect(ctx.inputSchema[GATE_KEYS_NOT_FROM_RUN_INPUTS]).toEqual(LIST_GATE_KEYS);
    });

    it("a parsed message: the gate's own values win and the schema is unchanged", async () => {
      const message = JSON.stringify({
        candidateMembers: [{ name: "Actual" }],
        listName: null,
        dispatchedRuns: null,
        failures: null,
      });
      const { emitted, ctx } = await emitAndRead(road, gateTask(message));
      expect(ctx.currentValues.candidateMembers).toEqual([{ name: "Actual" }]);
      // The gate's own null is its value; the stored name does not fill it.
      expect(ctx.currentValues.listName).toBeNull();
      expect(ctx.currentValues.campaignNote).toBe("kept");
      expect(emitted.schema).toEqual(GATE_SCHEMA);
      expect(ctx.inputSchema).toEqual(GATE_SCHEMA);
    });

    it("a parsed message that lacks a gate key: that key stays absent", async () => {
      const message = JSON.stringify({ candidateMembers: [{ name: "Actual" }] });
      const { ctx } = await emitAndRead(road, gateTask(message));
      expect(ctx.currentValues.candidateMembers).toEqual([{ name: "Actual" }]);
      expect(Object.prototype.hasOwnProperty.call(ctx.currentValues, "listName")).toBe(false);
      expect(ctx.inputSchema[GATE_KEYS_NOT_FROM_RUN_INPUTS]).toEqual([
        "listName",
        "dispatchedRuns",
        "failures",
      ]);
    });

    it("an unparseable message with a pendingApproval value: the gate's pendingApproval value is kept", async () => {
      const { ctx } = await emitAndRead(
        road,
        gateTask("cut {", { listName: "Gate list" }),
      );
      expect(ctx.currentValues.listName).toBe("Gate list");
      expect(Object.prototype.hasOwnProperty.call(ctx.currentValues, "candidateMembers")).toBe(false);
      expect(ctx.inputSchema[GATE_KEYS_NOT_FROM_RUN_INPUTS]).toEqual([
        "candidateMembers",
        "dispatchedRuns",
        "failures",
      ]);
    });

    it("a gate WITHOUT the flag keeps its present values (run inputs fill its keys)", async () => {
      storeMock.readAgentTemplateById.mockResolvedValue(
        makeTemplate([gateStep(6, LIST_RENDERER)]),
      );
      const { emitted, ctx } = await emitAndRead(road, gateTask('{"candidateMembers": [{"name": "Act'));
      expect(ctx.currentValues.candidateMembers).toEqual(STORED.candidateMembers);
      expect(ctx.currentValues.listName).toBe(STORED.listName);
      expect(emitted.schema).toEqual(GATE_SCHEMA);
      expect(ctx.inputSchema).toEqual(GATE_SCHEMA);
    });

    const TWO_GATES: Array<[number, string, string[]]> = [
      [0, SCHEMA_RENDERER, SCHEMA_GATE_KEYS],
      [1, LIST_RENDERER, LIST_GATE_KEYS],
    ];
    it.each(TWO_GATES)("a two-gate flow, renderer gate %i: that gate's keys are withheld", async (idx, renderer, keys) => {
      storeMock.readAgentTemplateById.mockResolvedValue(
        makeTemplate([
          gateStep(3, SCHEMA_RENDERER, SCHEMA_GATE_KEYS),
          gateStep(6, LIST_RENDERER, LIST_GATE_KEYS),
        ]),
      );
      gateIndex.value = idx;
      const { ctx } = await emitAndRead(road, gateTask(""));
      expect(ctx.xRenderer).toBe(renderer);
      for (const k of keys) {
        expect(Object.prototype.hasOwnProperty.call(ctx.currentValues, k), `screen ${k}`).toBe(false);
      }
      // The other gate's keys are run inputs here, as before.
      const other = idx === 0 ? "candidateMembers" : "outputSchema";
      expect(ctx.currentValues[other]).toEqual(STORED[other as keyof typeof STORED]);
    });

    it("the sole gate after a resolver fault: the caught road keeps the gate's keys", async () => {
      // The positional resolver faults after the sole gate was read: the
      // handler reads `artifactReviewTargetsInput` once, the resolver's second
      // read throws, and the catch resolves to the sole gate.
      let reads = 0;
      const step: Record<string, unknown> = gateStep(6, LIST_RENDERER, LIST_GATE_KEYS);
      Object.defineProperty(step, "artifactReviewTargetsInput", {
        enumerable: true,
        get() {
          reads += 1;
          if (reads >= 2) throw new Error("resolver fault");
          return undefined;
        },
      });
      storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate([step]));
      const { ctx } = await emitAndRead(road, gateTask(undefined));
      expect(reads).toBeGreaterThanOrEqual(2);
      expect(ctx.xRenderer).toBe(LIST_RENDERER);
      for (const k of LIST_GATE_KEYS) {
        expect(Object.prototype.hasOwnProperty.call(ctx.currentValues, k), `screen ${k}`).toBe(false);
      }
    });

    it("a stored step whose key list holds no usable key (an empty string, a number, null): nothing is withheld", async () => {
      storeMock.readAgentTemplateById.mockResolvedValue(
        makeTemplate([gateStep(6, LIST_RENDERER, ["", 5, null] as unknown as string[])]),
      );
      const run = makeRun({ ...STORED, "": "empty-named" });
      const { emitted, ctx } = await emitAndRead(road, gateTask("cut {"), run);
      expect(ctx.currentValues[""]).toBe("empty-named");
      expect(ctx.currentValues.candidateMembers).toEqual(STORED.candidateMembers);
      expect(emitted.schema).toEqual(GATE_SCHEMA);
      expect(ctx.inputSchema).toEqual(GATE_SCHEMA);
    });

    it("a flagged gate with the artifact-review marker whose review core opens no review: the ordinary gate withholds the keys", async () => {
      const decide = vi.fn(async () => ({ review: false, why: "no review for this work" }));
      const readGate = vi.fn(async () => null);
      (globalThis as { __cinatraArtifactReviewGateSeam?: unknown }).__cinatraArtifactReviewGateSeam = {
        decideDeclaredReview: decide,
        emit: vi.fn(),
        readGate,
        listGates: vi.fn(async () => []),
      };
      try {
        storeMock.readAgentTemplateById.mockResolvedValue(
          makeTemplate([
            { ...gateStep(6, LIST_RENDERER, LIST_GATE_KEYS), artifactReviewTargetsInput: "reviewTargets" },
          ]),
        );
        const { ctx } = await emitAndRead(road, gateTask(""));
        // The marked branch ran and fell through to the ordinary gate.
        expect(decide).toHaveBeenCalledTimes(1);
        expect(readGate).toHaveBeenCalledTimes(1);
        for (const k of LIST_GATE_KEYS) {
          expect(Object.prototype.hasOwnProperty.call(ctx.currentValues, k), `screen ${k}`).toBe(false);
        }
        expect(ctx.currentValues.campaignNote).toBe("kept");
        expect(ctx.inputSchema[GATE_KEYS_NOT_FROM_RUN_INPUTS]).toEqual(LIST_GATE_KEYS);
      } finally {
        delete (globalThis as { __cinatraArtifactReviewGateSeam?: unknown }).__cinatraArtifactReviewGateSeam;
      }
    });

    it("a gate without the flag and without a step schema, whose pendingApproval holds the list key: the host does not pass the key on", async () => {
      const step: Record<string, unknown> = gateStep(6, LIST_RENDERER);
      delete step.inputMessageSchema;
      storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate([step]));
      const { emitted, ctx } = await emitAndRead(
        road,
        gateTask("cut {", { [GATE_KEYS_NOT_FROM_RUN_INPUTS]: ["campaignNote", "listName"] }),
      );
      expect(Object.prototype.hasOwnProperty.call(emitted.schema, GATE_KEYS_NOT_FROM_RUN_INPUTS)).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(ctx.inputSchema, GATE_KEYS_NOT_FROM_RUN_INPUTS)).toBe(false);
      // The run's inputs reach the screen as before.
      expect(ctx.currentValues.campaignNote).toBe("kept");
      expect(ctx.currentValues.listName).toBe(STORED.listName);
    });
  });
});

describe("cinatra#4457 — the readers honour the schema's list on both roads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMock.rows.length = 0;
  });

  const parked = {
    ...makeRun(),
    status: "pending_approval",
    a2aTaskId: "task-x",
  } as AgentRunRecord;

  it.each(ROADS)("%s road: a listed key is left out of the run inputs, an unlisted one is not", async (road) => {
    const gate = {
      schema: { type: "object", [GATE_KEYS_NOT_FROM_RUN_INPUTS]: ["candidateMembers"] },
      xRenderer: LIST_RENDERER,
      values: { output: "x" },
      reviewTaskId: "wayflow-task-x",
    };
    if (road === "interrupt") {
      frameRoad.mode = "frame";
      onInterruptSpy(gate.schema, gate.xRenderer, gate.values, gate.reviewTaskId);
    } else {
      frameRoad.mode = "none";
      storeMock.rows.push({
        runId: parked.id,
        reviewTaskId: gate.reviewTaskId,
        xRenderer: gate.xRenderer,
        inputSchema: gate.schema,
        values: gate.values,
      });
    }
    const ctx = (await deriveRunHitlContext(parked))!;
    expect(Object.prototype.hasOwnProperty.call(ctx.currentValues, "candidateMembers")).toBe(false);
    expect(ctx.currentValues.listName).toBe(STORED.listName);
    expect(ctx.currentValues.output).toBe("x");
  });

  it.each(ROADS)("%s road: a list that is not an array of strings withholds nothing it does not name", async (road) => {
    const schema = { type: "object", [GATE_KEYS_NOT_FROM_RUN_INPUTS]: "candidateMembers" };
    if (road === "interrupt") {
      frameRoad.mode = "frame";
      onInterruptSpy(schema, LIST_RENDERER, {}, "wayflow-task-x");
    } else {
      frameRoad.mode = "none";
      storeMock.rows.push({
        runId: parked.id,
        reviewTaskId: "wayflow-task-x",
        xRenderer: LIST_RENDERER,
        inputSchema: schema,
        values: {},
      });
    }
    const ctx = (await deriveRunHitlContext(parked))!;
    expect(ctx.currentValues.candidateMembers).toEqual(STORED.candidateMembers);
  });

  it.each(ROADS)("%s road: a list entry that is an empty string or not a string withholds nothing", async (road) => {
    const parkedEmpty = {
      ...makeRun({ ...STORED, "": "empty-named" }),
      status: "pending_approval",
      a2aTaskId: "task-x",
    } as AgentRunRecord;
    const schema = { type: "object", [GATE_KEYS_NOT_FROM_RUN_INPUTS]: ["candidateMembers", "", 7, null] };
    if (road === "interrupt") {
      frameRoad.mode = "frame";
      onInterruptSpy(schema, LIST_RENDERER, {}, "wayflow-task-x");
    } else {
      frameRoad.mode = "none";
      storeMock.rows.push({
        runId: parkedEmpty.id,
        reviewTaskId: "wayflow-task-x",
        xRenderer: LIST_RENDERER,
        inputSchema: schema,
        values: {},
      });
    }
    const ctx = (await deriveRunHitlContext(parkedEmpty))!;
    expect(Object.prototype.hasOwnProperty.call(ctx.currentValues, "candidateMembers")).toBe(false);
    expect(ctx.currentValues[""]).toBe("empty-named");
    expect(ctx.currentValues.listName).toBe(STORED.listName);
  });
});
