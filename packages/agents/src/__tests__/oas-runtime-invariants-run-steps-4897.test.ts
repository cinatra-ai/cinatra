/**
 * cinatra#4897: a model step sits in a holder the run reads steps from
 * (OAS-RUNTIME-016). The run knows a step only through `forEachRunStep`
 * ($referenced_components, a subflow, a ParallelFlowNode's subflows), by its id;
 * hasApiNodeStep refuses the calls of any other step (step_tool_step_unknown).
 *
 * The fleet sweep over every pinned pack is `oas-runtime-invariants.test.ts`.
 */
import { describe, it, expect } from "vitest";

import {
  forEachRunStep,
  hasApiNodeStep,
  scanOasForRuntimeInvariantFindings,
} from "../validate-oas-runtime-invariants";

type Node = Record<string, unknown>;

function modelStep(id: string): Node {
  return {
    component_type: "ApiNode",
    id,
    name: id,
    url: "{{CINATRA_BASE_URL}}/api/llm-bridge",
    http_method: "POST",
    inputs: [],
    outputs: [],
  };
}

function flow(components: Record<string, Node>, nodes: unknown[] = []): Node {
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "example-org-fixture",
    name: "Fixture",
    inputs: [],
    outputs: [],
    start_node: { $component_ref: "start" },
    nodes: [{ $component_ref: "start" }, ...nodes, { $component_ref: "end" }],
    control_flow_connections: [],
    data_flow_connections: [],
    $referenced_components: {
      start: { component_type: "StartNode", id: "start", name: "start", inputs: [] },
      end: { component_type: "EndNode", id: "end", name: "end", outputs: [] },
      ...components,
    },
  };
}

const unread = (doc: Node) =>
  scanOasForRuntimeInvariantFindings(doc).filter((f) => f.code === "OAS-RUNTIME-016");

describe("OAS-RUNTIME-016: a model step sits where the run reads steps (cinatra#4897)", () => {
  it("refuses a model step written inline in a flow's nodes list", () => {
    const doc = flow({}, [modelStep("draft")]);
    expect(hasApiNodeStep(doc, "draft")).toBe(false);
    const findings = unread(doc);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("blocker");
    expect(findings[0].location).toBe("$.nodes[1]");
    expect(findings[0].message).toContain('Model step "draft" at $.nodes[1] sits in $.nodes');
    expect(findings[0].message).toContain("step_tool_step_unknown");
  });

  it("accepts the same step in $referenced_components, referenced from nodes", () => {
    const doc = flow({ draft: modelStep("draft") }, [{ $component_ref: "draft" }]);
    expect(hasApiNodeStep(doc, "draft")).toBe(true);
    expect(unread(doc)).toEqual([]);
  });

  it("accepts a model step in a nested subflow and in a ParallelFlowNode's inline subflows", () => {
    const inner = flow({ draft: modelStep("draft") }, [{ $component_ref: "draft" }]);
    const branch = flow({ edit: modelStep("edit") }, [{ $component_ref: "edit" }]);
    const doc = flow(
      {
        sub: { component_type: "FlowNode", id: "sub", name: "sub", subflow: inner },
        fan: { component_type: "ParallelFlowNode", id: "fan", name: "fan", subflows: [branch] },
      },
      [{ $component_ref: "sub" }, { $component_ref: "fan" }],
    );
    expect(unread(doc)).toEqual([]);
  });

  it("refuses a model step in a tool's flow under an agent's tools", () => {
    const toolFlow = flow({ draft: modelStep("draft") }, [{ $component_ref: "draft" }]);
    const agentNode = {
      component_type: "AgentNode",
      id: "writer",
      name: "writer",
      agent: {
        component_type: "Agent",
        id: "writer-agent",
        name: "writer-agent",
        tools: [{ component_type: "FlowTool", id: "tool", name: "tool", flow: toolFlow }],
      },
    };
    const doc = flow({ writer: agentNode }, [{ $component_ref: "writer" }]);
    expect(hasApiNodeStep(doc, "draft")).toBe(false);
    const findings = unread(doc);
    expect(findings).toHaveLength(1);
    expect(findings[0].location).toBe(
      "$.$referenced_components.writer.agent.tools[0].flow.$referenced_components.draft",
    );
    expect(findings[0].message).toContain(
      "sits in $.$referenced_components.writer.agent.tools[0].flow.$referenced_components",
    );
  });

  it("accepts two read steps that share an id: the run treats them as one step", () => {
    const inner = flow({ draft: modelStep("draft") }, [{ $component_ref: "draft" }]);
    const doc = flow(
      { draft: modelStep("draft"), sub: { component_type: "FlowNode", id: "sub", name: "sub", subflow: inner } },
      [{ $component_ref: "draft" }, { $component_ref: "sub" }],
    );
    const ids: Array<string | null> = [];
    forEachRunStep(doc, ({ node, id }) => {
      if (node.component_type === "ApiNode") ids.push(id);
    });
    expect(ids).toEqual(["draft", "draft"]);
    expect(unread(doc)).toEqual([]);
  });

  it("refuses an unread step that reuses the id of a read step, naming the read step", () => {
    const doc = flow({ draft: modelStep("draft") }, [{ $component_ref: "draft" }, modelStep("draft")]);
    // The run finds the read step by the id, so the unread one would borrow its declaration.
    expect(hasApiNodeStep(doc, "draft")).toBe(true);
    const findings = unread(doc);
    expect(findings).toHaveLength(1);
    expect(findings[0].location).toBe("$.nodes[2]");
    expect(findings[0].message).toContain("also carried by the step at $.$referenced_components.draft");
  });

  it("does not search a node's payload for steps", () => {
    const api = { ...modelStep("call"), data: { example: modelStep("quoted") } };
    expect(unread(flow({ call: api }, [{ $component_ref: "call" }]))).toEqual([]);
  });

  it("yields each read step with its holder", () => {
    const doc = flow({ draft: modelStep("draft") }, [{ $component_ref: "draft" }]);
    const steps: Array<[string, string]> = [];
    forEachRunStep(doc, ({ path, holder }) => steps.push([path, holder]));
    expect(steps).toContainEqual(["$", "$"]);
    expect(steps).toContainEqual(["$.$referenced_components.draft", "$.$referenced_components"]);
  });
});
