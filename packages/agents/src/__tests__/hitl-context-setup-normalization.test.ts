/**
 * The NORMALIZATION BOUNDARY of `deriveRunHitlContext`.
 *
 * A setup-loop interrupt is the one interrupt shape that legitimately carries
 * no review-task identity: setup gates have no review_task row at all (the
 * synthetic `setup-<runId>` id exists to bypass them). The derivation must
 * therefore produce an ACTIONABLE setup context whether or not the stored
 * interrupt carried an id — and stay actionable when the interrupt is equally
 * thin in its other fields (no renderer, or a renderer with nothing to render).
 * A context that passes the panel's "has xRenderer" gate but carries an empty
 * schema is present without being actionable, which is the same dead end as no
 * context at all.
 *
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/hitl-context-setup-normalization.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
import type { AgentRunRecord, AgentTemplateRecord } from "../store";

const readLatestAgUiInterrupt = vi.fn();
const readAgentTemplateById = vi.fn();
// The durable gate row (cinatra#2748) is the fallback BELOW the interrupt, so
// every case here keeps it empty and proves the interrupt path is untouched.
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

/** A setup-loop run: paused before any execution started, so no a2aTaskId. */
function setupRun(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    id: "run-2725",
    templateId: "tpl-1",
    status: "pending_approval",
    a2aTaskId: null,
    inputParams: { audience: "founders" },
    ...overrides,
  } as unknown as AgentRunRecord;
}

beforeEach(() => {
  vi.clearAllMocks();
  readAgentTemplateById.mockResolvedValue(template);
  readLatestDurableHitlGateArtifact.mockResolvedValue(null);
});

describe("deriveRunHitlContext — raw setup interrupt normalization", () => {
  it("keeps the interrupt's own review-task id when it carries one", async () => {
    readLatestAgUiInterrupt.mockResolvedValue({
      xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
      schema: { type: "string", title: "Brief" },
      values: { brief: "draft" },
      reviewTaskId: "setup-run-2725",
      fieldName: "brief",
    });

    const { deriveRunHitlContext } = await import("../hitl-context");
    const ctx = await deriveRunHitlContext(setupRun(), { template });

    expect(ctx).not.toBeNull();
    expect(ctx?.reviewTaskId).toBe("setup-run-2725");
    expect(ctx?.xRenderer).toBe(SCHEMA_FIELD_FALLBACK_RENDERER_ID);
    expect(ctx?.inputSchema).toEqual({ type: "string", title: "Brief" });
    expect(ctx?.fieldName).toBe("brief");
  });

  it("synthesizes the setup id when the interrupt carries NONE — same actionable context", async () => {
    readLatestAgUiInterrupt.mockResolvedValue({
      xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
      schema: { type: "string", title: "Brief" },
      values: { brief: "draft" },
      reviewTaskId: "",
      fieldName: "brief",
    });

    const { deriveRunHitlContext } = await import("../hitl-context");
    const ctx = await deriveRunHitlContext(setupRun(), { template });

    expect(ctx?.reviewTaskId).toBe("setup-run-2725");
    expect(ctx?.xRenderer).toBe(SCHEMA_FIELD_FALLBACK_RENDERER_ID);
    expect(ctx?.inputSchema).toEqual({ type: "string", title: "Brief" });
  });

  it("falls back to the generic setup renderer when the interrupt names none", async () => {
    readLatestAgUiInterrupt.mockResolvedValue({
      xRenderer: "",
      schema: {},
      values: {},
      reviewTaskId: "",
    });

    const { deriveRunHitlContext } = await import("../hitl-context");
    const ctx = await deriveRunHitlContext(setupRun(), { template });

    expect(ctx?.xRenderer).toBe(SCHEMA_FIELD_FALLBACK_RENDERER_ID);
    expect(ctx?.reviewTaskId).toBe("setup-run-2725");
    // Actionable: the generic form gets the template's input schema rather
    // than an empty object it could render nothing from.
    expect(ctx?.inputSchema).toEqual(TEMPLATE_SCHEMA);
  });

  it("does NOT hand the template schema to a gate that named its own renderer", async () => {
    // Values-driven renderers emit an empty schema on purpose; substituting the
    // template's input schema would render the wrong form.
    readLatestAgUiInterrupt.mockResolvedValue({
      xRenderer: "@cinatra-ai/blog:idea-selection",
      schema: {},
      values: { ideas: ["a", "b"] },
      reviewTaskId: "",
    });

    const { deriveRunHitlContext } = await import("../hitl-context");
    const ctx = await deriveRunHitlContext(setupRun(), { template });

    expect(ctx?.xRenderer).toBe("@cinatra-ai/blog:idea-selection");
    expect(ctx?.inputSchema).toEqual({});
  });

  it("keeps the WayFlow gate identity when the run has an a2a task", async () => {
    readLatestAgUiInterrupt.mockResolvedValue({
      xRenderer: "",
      schema: {},
      values: {},
      reviewTaskId: "",
    });

    const { deriveRunHitlContext } = await import("../hitl-context");
    const ctx = await deriveRunHitlContext(setupRun({ a2aTaskId: "task-77" }), {
      template,
    });

    expect(ctx?.reviewTaskId).toBe("wayflow-task-77");
    // No setup-renderer substitution off the setup path.
    expect(ctx?.xRenderer).toBe("");
  });

  it("still yields a context when the template read fails on the no-interrupt path", async () => {
    // The derivation contract is "a paused run always has a context". A failed
    // template read must degrade the SCHEMA, never the whole response.
    readLatestAgUiInterrupt.mockResolvedValue(null);
    readAgentTemplateById.mockRejectedValue(new Error("template row missing"));

    const { deriveRunHitlContext } = await import("../hitl-context");
    const ctx = await deriveRunHitlContext(setupRun());

    expect(ctx?.reviewTaskId).toBe("setup-run-2725");
    expect(ctx?.xRenderer).toBe(SCHEMA_FIELD_FALLBACK_RENDERER_ID);
    expect(ctx?.inputSchema).toEqual({});
  });

  it("returns null for a run that is not paused on a gate", async () => {
    const { deriveRunHitlContext } = await import("../hitl-context");
    expect(await deriveRunHitlContext(setupRun({ status: "running" }))).toBeNull();
  });
});
