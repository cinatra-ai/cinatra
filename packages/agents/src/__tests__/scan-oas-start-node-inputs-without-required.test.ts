/**
 * scanOasForStartNodeInputsWithoutRequired.
 *
 * Locks the contract: every StartNode input declared on the flow MUST be
 * covered by EITHER `metadata.cinatra.required` (pre-run HITL prompt) OR
 * `metadata.cinatra.hidden` (programmatic-only). Inputs in neither are
 * silently dropped at runtime.
 *
 * Emitted as a WARNING (not a blocker) so it surfaces through
 * `agent_source_review` but does not block `agent_source_validate` /
 * `agent_source_compile`. Some agents legitimately accept programmatic-only
 * StartNode inputs (orchestrators wire all values via sub-flow DataFlowEdges).
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/scan-oas-start-node-inputs-without-required.test.ts
 */
import { describe, expect, it } from "vitest";

import { scanOasForStartNodeInputsWithoutRequired } from "../validate-agent-json";

type OasFixture = Record<string, unknown>;

function buildOasWithStartNode(startNodeProps: Record<string, unknown>): OasFixture {
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "test-flow",
    name: "Test Flow",
    description: "Test fixture",
    metadata: { cinatra: { type: "node" } },
    nodes: [{ $component_ref: "start" }, { $component_ref: "end" }],
    start_node: { $component_ref: "start" },
    control_flow_connections: [],
    $referenced_components: {
      start: {
        component_type: "StartNode",
        id: "start",
        name: "Inputs",
        ...startNodeProps,
      },
      end: { component_type: "EndNode", id: "end" },
    },
  };
}

describe("scanOasForStartNodeInputsWithoutRequired", () => {
  it("emits NO finding when the StartNode declares no inputs", () => {
    const oas = buildOasWithStartNode({ inputs: [] });
    expect(scanOasForStartNodeInputsWithoutRequired(oas)).toEqual([]);
  });

  it("emits a warning when an input has neither `required` nor `hidden` coverage", () => {
    const oas = buildOasWithStartNode({
      inputs: [{ title: "url", type: "string", format: "uri" }],
      // No metadata.cinatra at all - representative of chat-built agents.
    });
    const findings = scanOasForStartNodeInputsWithoutRequired(oas);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: "start_node_inputs_without_required",
      severity: "warning",
      source: "deterministic",
      location: "$referenced_components.start",
    });
    expect(findings[0]!.message).toContain('"url"');
  });

  it("emits NO finding when every input is covered by `metadata.cinatra.required`", () => {
    const oas = buildOasWithStartNode({
      metadata: { cinatra: { required: ["url"] } },
      inputs: [{ title: "url", type: "string", format: "uri" }],
    });
    expect(scanOasForStartNodeInputsWithoutRequired(oas)).toEqual([]);
  });

  it("emits NO finding when every input is covered by `metadata.cinatra.hidden`", () => {
    const oas = buildOasWithStartNode({
      metadata: { cinatra: { required: [], hidden: ["campaignId"] } },
      inputs: [{ title: "campaignId", type: "string" }],
    });
    expect(scanOasForStartNodeInputsWithoutRequired(oas)).toEqual([]);
  });

  it("flags only the orphan inputs when some are covered and some are not", () => {
    const oas = buildOasWithStartNode({
      metadata: { cinatra: { required: ["url"], hidden: ["campaignId"] } },
      inputs: [
        { title: "url", type: "string" },
        { title: "campaignId", type: "string" },
        { title: "leakedField", type: "string" },
        { title: "anotherLeak", type: "string" },
      ],
    });
    const findings = scanOasForStartNodeInputsWithoutRequired(oas);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain('"leakedField"');
    expect(findings[0]!.message).toContain('"anotherLeak"');
    expect(findings[0]!.message).not.toContain('"url"');
    expect(findings[0]!.message).not.toContain('"campaignId"');
  });

  it("emits NO finding when there is no StartNode at all (defensive)", () => {
    const oas: OasFixture = {
      agentspec_version: "26.1.0",
      $referenced_components: {
        someOtherNode: { component_type: "AgentNode" },
      },
    };
    expect(scanOasForStartNodeInputsWithoutRequired(oas)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Nested Flow recursion.
  // The same invariant must apply to lane StartNodes inside a
  // ParallelFlowNode subflow's $referenced_components, not only the top
  // level, otherwise orphan lane inputs can pass review while disappearing
  // at runtime.
  // -------------------------------------------------------------------------

  it("RECURSES into nested Flow $referenced_components and flags orphaned lane StartNode inputs", () => {
    const oas: OasFixture = {
      agentspec_version: "26.1.0",
      component_type: "Flow",
      id: "parent",
      name: "Parent",
      metadata: { cinatra: { type: "flow" } },
      inputs: [],
      outputs: [],
      start_node: { $component_ref: "parent_start" },
      nodes: [{ $component_ref: "parent_start" }, { $component_ref: "parent_end" }],
      control_flow_connections: [],
      $referenced_components: {
        parent_start: { component_type: "StartNode", id: "parent_start", inputs: [] },
        parent_end: { component_type: "EndNode", id: "parent_end" },
        lane_flow: {
          component_type: "Flow",
          id: "lane_flow",
          name: "Lane",
          metadata: { cinatra: { type: "flow" } },
          inputs: [{ title: "leakedField", type: "string" }],
          outputs: [],
          start_node: { $component_ref: "lane_start" },
          nodes: [{ $component_ref: "lane_start" }, { $component_ref: "lane_end" }],
          control_flow_connections: [],
          $referenced_components: {
            lane_start: {
              component_type: "StartNode",
              id: "lane_start",
              // Orphan: declared as a lane input but not in required/hidden.
              inputs: [{ title: "leakedField", type: "string" }],
            },
            lane_end: { component_type: "EndNode", id: "lane_end" },
          },
        },
      },
    };
    const findings = scanOasForStartNodeInputsWithoutRequired(oas);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain('"leakedField"');
    // Location includes the nested path so authors can locate the offender.
    expect(findings[0]!.location).toBe(
      "$referenced_components.lane_flow.$referenced_components.lane_start",
    );
  });

  it("emits NO finding when nested lane StartNodes cover all inputs via hidden", () => {
    const oas: OasFixture = {
      agentspec_version: "26.1.0",
      component_type: "Flow",
      id: "parent",
      name: "Parent",
      metadata: { cinatra: { type: "flow" } },
      inputs: [],
      outputs: [],
      start_node: { $component_ref: "parent_start" },
      nodes: [{ $component_ref: "parent_start" }, { $component_ref: "parent_end" }],
      control_flow_connections: [],
      $referenced_components: {
        parent_start: { component_type: "StartNode", id: "parent_start", inputs: [] },
        parent_end: { component_type: "EndNode", id: "parent_end" },
        lane_flow: {
          component_type: "Flow",
          id: "lane_flow",
          name: "Lane",
          metadata: { cinatra: { type: "flow" } },
          inputs: [{ title: "bridged", type: "string" }],
          outputs: [],
          start_node: { $component_ref: "lane_start" },
          nodes: [{ $component_ref: "lane_start" }, { $component_ref: "lane_end" }],
          control_flow_connections: [],
          $referenced_components: {
            lane_start: {
              component_type: "StartNode",
              id: "lane_start",
              metadata: { cinatra: { hidden: ["bridged"] } },
              inputs: [{ title: "bridged", type: "string" }],
            },
            lane_end: { component_type: "EndNode", id: "lane_end" },
          },
        },
      },
    };
    expect(scanOasForStartNodeInputsWithoutRequired(oas)).toEqual([]);
  });
});
