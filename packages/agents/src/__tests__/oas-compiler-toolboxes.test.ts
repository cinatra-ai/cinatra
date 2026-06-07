/**
 * Verify the compile-pass propagates `metadata.cinatra.toolboxes` onto every
 * bridge-targeting ApiNode's `data.toolbox_ids`. The bridge falls back to
 * `body.toolbox_ids ?? ["cinatra-mcp"]`, so propagation is required for an
 * agent declaring `toolboxes: ["web_search"]` to avoid receiving the full
 * Cinatra MCP suite at runtime.
 */
import { describe, expect, it } from "vitest";

import { propagateToolboxesIntoApiNodes } from "../oas-compiler";

function makeFlowWithBridgeApiNode(extraData: Record<string, unknown> = {}) {
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "test-flow",
    name: "Test",
    metadata: { cinatra: { type: "leaf", hitlScreens: [] } },
    inputs: [],
    outputs: [],
    start_node: { $component_ref: "start" },
    nodes: [],
    control_flow_connections: [],
    data_flow_connections: [],
    $referenced_components: {
      bridge_api: {
        component_type: "ApiNode",
        id: "bridge_api",
        name: "Call bridge",
        url: "{{CINATRA_BASE_URL}}/api/llm-bridge",
        http_method: "POST",
        data: {
          agent_id: "test-agent",
          ...extraData,
        },
      },
    },
  } as Record<string, unknown>;
}

function makeFlowWithoutBridge() {
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "test-flow",
    name: "Test",
    metadata: { cinatra: { type: "leaf", hitlScreens: [] } },
    inputs: [],
    outputs: [],
    start_node: { $component_ref: "start" },
    nodes: [],
    control_flow_connections: [],
    data_flow_connections: [],
    $referenced_components: {
      other_api: {
        component_type: "ApiNode",
        id: "other_api",
        name: "Call external",
        url: "https://api.example.com/foo",
        http_method: "POST",
        data: {},
      },
    },
  } as Record<string, unknown>;
}

describe("propagateToolboxesIntoApiNodes", () => {
  it("propagates ['web_search'] onto a bridge-targeting ApiNode", () => {
    const flow = makeFlowWithBridgeApiNode();
    propagateToolboxesIntoApiNodes(flow, ["web_search"]);
    const node = (flow.$referenced_components as Record<string, unknown>)
      .bridge_api as Record<string, unknown>;
    const data = node.data as Record<string, unknown>;
    expect(data.toolbox_ids).toEqual(["web_search"]);
  });

  it("propagates ['cinatra-mcp', 'web_search'] (mixed list)", () => {
    const flow = makeFlowWithBridgeApiNode();
    propagateToolboxesIntoApiNodes(flow, ["cinatra-mcp", "web_search"]);
    const node = (flow.$referenced_components as Record<string, unknown>)
      .bridge_api as Record<string, unknown>;
    expect((node.data as Record<string, unknown>).toolbox_ids).toEqual([
      "cinatra-mcp",
      "web_search",
    ]);
  });

  it("does NOT overwrite an explicit ApiNode-level data.toolbox_ids", () => {
    const flow = makeFlowWithBridgeApiNode({
      toolbox_ids: ["operator-override"],
    });
    propagateToolboxesIntoApiNodes(flow, ["web_search"]);
    const node = (flow.$referenced_components as Record<string, unknown>)
      .bridge_api as Record<string, unknown>;
    expect((node.data as Record<string, unknown>).toolbox_ids).toEqual([
      "operator-override",
    ]);
  });

  it("does NOT touch non-bridge ApiNodes", () => {
    const flow = makeFlowWithoutBridge();
    propagateToolboxesIntoApiNodes(flow, ["web_search"]);
    const node = (flow.$referenced_components as Record<string, unknown>)
      .other_api as Record<string, unknown>;
    expect((node.data as Record<string, unknown>).toolbox_ids).toBeUndefined();
  });

  it("no-ops on empty toolboxes array", () => {
    const flow = makeFlowWithBridgeApiNode();
    propagateToolboxesIntoApiNodes(flow, []);
    const node = (flow.$referenced_components as Record<string, unknown>)
      .bridge_api as Record<string, unknown>;
    expect((node.data as Record<string, unknown>).toolbox_ids).toBeUndefined();
  });

  it("recurses into nested Flow components (orchestrator pattern)", () => {
    const flow = {
      $referenced_components: {
        outer_flow_node: {
          component_type: "FlowNode",
          subflow: { $component_ref: "child_flow" },
        },
        child_flow: {
          component_type: "Flow",
          $referenced_components: {
            nested_bridge: {
              component_type: "ApiNode",
              url: "{{CINATRA_BASE_URL}}/api/llm-bridge",
              data: {},
            },
          },
        },
      },
    } as Record<string, unknown>;
    propagateToolboxesIntoApiNodes(flow, ["web_search"]);
    const nested = ((flow.$referenced_components as Record<string, unknown>)
      .child_flow as Record<string, unknown>)
      .$referenced_components as Record<string, unknown>;
    const apiNode = nested.nested_bridge as Record<string, unknown>;
    expect((apiNode.data as Record<string, unknown>).toolbox_ids).toEqual([
      "web_search",
    ]);
  });
});
