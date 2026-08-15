/**
 * The DURABLE gate fallback of `deriveRunHitlContext` (cinatra#2748).
 *
 * A paused run's gate used to live ONLY in the Redis run event log. That log
 * expires, and once the key was gone the run derived a formless
 * `{xRenderer:"", inputSchema:{}}` shell and rendered an unanswerable banner
 * forever. The park seam now writes a Postgres row for every VERIFIED gate, and
 * this derivation reads it when the frame is gone.
 *
 * The order under test:
 *   1. Redis HIT  → the frame answers; the durable row is never read.
 *   2. Redis MISS → the durable row renders the same form the frame did.
 *   3. BOTH MISS  → the pre-existing synthetic identities, byte for byte.
 *
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/hitl-context-durable-gate-fallback.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
import type { AgentRunRecord, AgentTemplateRecord } from "../store";

const readLatestAgUiInterrupt = vi.fn();
const readAgentTemplateById = vi.fn();
const readLatestDurableHitlGateArtifact = vi.fn();

vi.mock("@cinatra-ai/agent-ui-protocol/server", () => ({
  readLatestAgUiInterrupt: (...args: unknown[]) => readLatestAgUiInterrupt(...args),
}));
vi.mock("../store", () => ({
  readAgentTemplateById: (...args: unknown[]) => readAgentTemplateById(...args),
  readLatestDurableHitlGateArtifact: (...args: unknown[]) =>
    readLatestDurableHitlGateArtifact(...args),
}));

const TEMPLATE_SCHEMA = {
  type: "object",
  properties: { brief: { type: "string", title: "Brief" } },
  required: ["brief"],
};
const template = { inputSchema: TEMPLATE_SCHEMA } as unknown as AgentTemplateRecord;

const WAYFLOW_RENDERER = "@cinatra-ai/wayflow:review-form";

/** A WayFlow run parked on an in-panel gate. */
function wayflowRun(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    id: "run-2748",
    templateId: "tpl-1",
    status: "pending_approval",
    a2aTaskId: "task-a",
    inputParams: { audience: "founders" },
    ...overrides,
  } as unknown as AgentRunRecord;
}

/** A setup-loop run: paused before any execution started, so no a2aTaskId. */
function setupRun(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    id: "run-2748",
    templateId: "tpl-1",
    status: "pending_approval",
    a2aTaskId: null,
    inputParams: { audience: "founders" },
    ...overrides,
  } as unknown as AgentRunRecord;
}

const DURABLE_ROW = {
  runId: "run-2748",
  reviewTaskId: "wayflow-task-a",
  xRenderer: WAYFLOW_RENDERER,
  inputSchema: { type: "object", properties: { approve: { type: "boolean" } } },
  values: { stepNumber: 3 },
};

beforeEach(() => {
  vi.clearAllMocks();
  readAgentTemplateById.mockResolvedValue(template);
  readLatestDurableHitlGateArtifact.mockResolvedValue(null);
});

describe("deriveRunHitlContext — Redis stays the hot path", () => {
  it("answers from the interrupt and never touches the durable row", async () => {
    readLatestAgUiInterrupt.mockResolvedValue({
      xRenderer: WAYFLOW_RENDERER,
      schema: { type: "object", properties: { approve: { type: "boolean" } } },
      values: { stepNumber: 7 },
      reviewTaskId: "wayflow-task-a",
    });
    readLatestDurableHitlGateArtifact.mockResolvedValue(DURABLE_ROW);

    const { deriveRunHitlContext } = await import("../hitl-context");
    const ctx = await deriveRunHitlContext(wayflowRun(), { template });

    expect(ctx?.xRenderer).toBe(WAYFLOW_RENDERER);
    expect(ctx?.currentValues).toMatchObject({ stepNumber: 7 });
    expect(readLatestDurableHitlGateArtifact).not.toHaveBeenCalled();
  });

  it("never reads the durable row for a run that is not paused", async () => {
    const { deriveRunHitlContext } = await import("../hitl-context");

    await expect(
      deriveRunHitlContext(wayflowRun({ status: "running" } as Partial<AgentRunRecord>)),
    ).resolves.toBeNull();
    expect(readLatestDurableHitlGateArtifact).not.toHaveBeenCalled();
  });
});

describe("deriveRunHitlContext — the durable row answers when the log expired", () => {
  beforeEach(() => {
    readLatestAgUiInterrupt.mockResolvedValue(null);
  });

  it("renders a WayFlow gate from the durable row", async () => {
    readLatestDurableHitlGateArtifact.mockResolvedValue(DURABLE_ROW);

    const { deriveRunHitlContext } = await import("../hitl-context");
    const ctx = await deriveRunHitlContext(wayflowRun(), { template });

    expect(readLatestDurableHitlGateArtifact).toHaveBeenCalledWith("run-2748");
    expect(ctx).toEqual({
      xRenderer: WAYFLOW_RENDERER,
      childRunId: null,
      reviewTaskId: "wayflow-task-a",
      inputSchema: DURABLE_ROW.inputSchema,
      currentValues: { audience: "founders", stepNumber: 3 },
    });
  });

  it("renders a setup gate from the durable row, field name included", async () => {
    readLatestDurableHitlGateArtifact.mockResolvedValue({
      runId: "run-2748",
      reviewTaskId: "setup-run-2748",
      xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
      inputSchema: { type: "string", title: "Brief" },
      values: { brief: "draft" },
      fieldName: "brief",
    });

    const { deriveRunHitlContext } = await import("../hitl-context");
    const ctx = await deriveRunHitlContext(setupRun(), { template });

    expect(ctx?.xRenderer).toBe(SCHEMA_FIELD_FALLBACK_RENDERER_ID);
    expect(ctx?.reviewTaskId).toBe("setup-run-2748");
    expect(ctx?.fieldName).toBe("brief");
    expect(ctx?.currentValues).toEqual({ audience: "founders", brief: "draft" });
  });

  it("lets the stored gate values win over the run input params", async () => {
    readLatestDurableHitlGateArtifact.mockResolvedValue({
      ...DURABLE_ROW,
      values: { audience: "operators" },
    });

    const { deriveRunHitlContext } = await import("../hitl-context");
    const ctx = await deriveRunHitlContext(wayflowRun(), { template });

    expect(ctx?.currentValues).toEqual({ audience: "operators" });
  });
});

describe("deriveRunHitlContext — both stores miss", () => {
  beforeEach(() => {
    readLatestAgUiInterrupt.mockResolvedValue(null);
  });

  it("keeps the WayFlow synthetic identity unchanged", async () => {
    const { deriveRunHitlContext } = await import("../hitl-context");
    const ctx = await deriveRunHitlContext(wayflowRun(), { template });

    expect(ctx).toEqual({
      xRenderer: "",
      childRunId: null,
      reviewTaskId: "wayflow-task-a",
      inputSchema: {},
      currentValues: { audience: "founders" },
    });
  });

  it("keeps the setup-loop generic form unchanged", async () => {
    const { deriveRunHitlContext } = await import("../hitl-context");
    const ctx = await deriveRunHitlContext(setupRun(), { template });

    expect(ctx).toEqual({
      xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
      childRunId: null,
      reviewTaskId: "setup-run-2748",
      inputSchema: TEMPLATE_SCHEMA,
      currentValues: { audience: "founders" },
    });
  });

  it("treats a durable row with no renderer as no row at all", async () => {
    // Such a row would pass the panel's "has xRenderer" check and then render
    // nothing — the exact unanswerable shell this change exists to remove.
    readLatestDurableHitlGateArtifact.mockResolvedValue({
      ...DURABLE_ROW,
      xRenderer: "",
    });

    const { deriveRunHitlContext } = await import("../hitl-context");
    const ctx = await deriveRunHitlContext(wayflowRun(), { template });

    expect(ctx?.xRenderer).toBe("");
    expect(ctx?.reviewTaskId).toBe("wayflow-task-a");
    expect(ctx?.inputSchema).toEqual({});
  });

  it("falls through to the synthetic identity when the durable read throws", async () => {
    readLatestDurableHitlGateArtifact.mockRejectedValue(new Error("store unavailable"));

    const { deriveRunHitlContext } = await import("../hitl-context");
    const ctx = await deriveRunHitlContext(wayflowRun(), { template });

    expect(ctx?.reviewTaskId).toBe("wayflow-task-a");
    expect(ctx?.xRenderer).toBe("");
  });
});
