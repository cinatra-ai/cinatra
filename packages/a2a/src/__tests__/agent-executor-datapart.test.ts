/**
 * RED tests for `stepResultsToArtifact` DataPart emission.
 *
 * Contract: when a stepResult carries an `output_data` object, the
 * artifact must include a DataPart (`kind: "data"`) carrying that data,
 * in addition to the back-compat TextPart. Empty input still produces the
 * legacy `(no step results)` TextPart fallback.
 *
 * `stepResultsToArtifact` is exported with an `/** @internal *` tag for
 * testing so this contract can be verified directly.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@cinatra/agent-builder", () => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(),
  createAgentRun: vi.fn(),
  updateAgentRunA2ATaskId: vi.fn(),
  jsonSchemaToZod: vi.fn(() => ({ parse: vi.fn() })),
}));

import { stepResultsToArtifact } from "../agent-executor";

describe("stepResultsToArtifact DataPart emission", () => {
  it("emits a DataPart when a stepResult carries output_data", () => {
    const artifact = stepResultsToArtifact([
      {
        kind: "langgraph_response",
        output: "txt",
        output_data: { campaignId: "c-1" },
      },
    ]);
    const dataPart = artifact.parts.find((p: any) => p.kind === "data");
    expect(dataPart).toBeDefined();
    expect((dataPart as any).data).toEqual({ campaignId: "c-1" });
  });

  it("still emits a TextPart for back-compat when output_data is present", () => {
    const artifact = stepResultsToArtifact([
      {
        kind: "langgraph_response",
        output: "txt",
        output_data: { campaignId: "c-1" },
      },
    ]);
    const textPart = artifact.parts.find((p: any) => p.kind === "text");
    expect(textPart).toBeDefined();
  });

  it("emits no DataPart when stepResult has no output_data", () => {
    const artifact = stepResultsToArtifact([
      { kind: "langgraph_response", output: "txt" },
    ]);
    const dataParts = artifact.parts.filter((p: any) => p.kind === "data");
    expect(dataParts).toHaveLength(0);
    const textParts = artifact.parts.filter((p: any) => p.kind === "text");
    expect(textParts).toHaveLength(1);
  });

  it("emits the '(no step results)' TextPart fallback for empty input", () => {
    const artifact = stepResultsToArtifact([]);
    expect(artifact.parts).toHaveLength(1);
    expect(artifact.parts[0]).toMatchObject({
      kind: "text",
      text: "(no step results)",
    });
  });
});
