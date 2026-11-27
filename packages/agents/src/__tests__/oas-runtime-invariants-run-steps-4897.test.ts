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

  it("does not take an ordinary ApiNode for a model step: a url that does not end at the bridge route", () => {
    const status = { ...modelStep("status"), url: "{{CINATRA_BASE_URL}}/api/llm-bridge/status" };
    expect(unread(flow({}, [status]))).toEqual([]);
    expect(unread(flow({}, [{ ...status, url: "/api/llm-bridge/status" }]))).toEqual([]);
    // The same node at the bridge route itself is a model step the run does not read.
    expect(unread(flow({}, [{ ...status, url: "/api/llm-bridge" }]))).toHaveLength(1);
  });

  it.each(["{{CINATRA_BASE_URL}}", "", "https://app.example.test"])(
    "decides on the url's path: a query, a fragment or a trailing slash does not hide a model step (%j)",
    (base) => {
      for (const tail of ["?x=1", "#a", "/", "/?x=1", "?next=/other#a"]) {
        const doc = flow({}, [{ ...modelStep("draft"), url: `${base}/api/llm-bridge${tail}` }]);
        expect(unread(doc), `${base}/api/llm-bridge${tail}`).toHaveLength(1);
      }
    },
  );

  it.each(["{{CINATRA_BASE_URL}}", "", "https://app.example.test"])(
    "does not take another route for a model step, with or without a query (%j)",
    (base) => {
      const urls = ["/status", "/status?x=1", "-other", "-other?x=1", "-other/"].map((tail) => `${base}/api/llm-bridge${tail}`);
      // The bridge route named only in another route's query is not the route called.
      urls.push(`${base}/status?next=/api/llm-bridge`);
      for (const url of urls) {
        expect(unread(flow({}, [{ ...modelStep("draft"), url }])), url).toEqual([]);
      }
    },
  );

  it("reads a model step with a query the same way in rule 015 (no 'not a model-bridge step' finding)", () => {
    const step = { ...modelStep("draft"), url: "/api/llm-bridge?x=1", metadata: { cinatra: { tools: ["objects_read"] } } };
    const findings = scanOasForRuntimeInvariantFindings(flow({ draft: step }, [{ $component_ref: "draft" }]));
    expect(findings.filter((f) => f.code === "OAS-RUNTIME-015")).toEqual([]);
  });

  it("does not search a node's payload for steps", () => {
    const api = { ...modelStep("call"), data: { example: modelStep("quoted") } };
    expect(unread(flow({ call: api }, [{ $component_ref: "call" }]))).toEqual([]);
  });

  it("does not take a step-shaped object in a request body, config or headers for a step", () => {
    const shaped = modelStep("quoted");
    const api = {
      ...modelStep("call"),
      body: shaped,
      config: { example: shaped, list: [shaped] },
      headers: { example: shaped },
      query_params: [shaped],
      // The payload names the keys that nest components in a document; none of them is entered.
      data: { nodes: [shaped], tools: [shaped], flow: shaped, $referenced_components: { quoted: shaped } },
    };
    const doc = flow({ call: api }, [{ $component_ref: "call" }]);
    expect(unread(doc)).toEqual([]);
    // The same step written where the document nests components is still refused.
    expect(unread(flow({ call: api }, [{ $component_ref: "call" }, shaped]))).toHaveLength(1);
  });

  it("does not take a step-shaped object in a payload for a step in an unread holder either", () => {
    const shaped = modelStep("quoted");
    const toolFlow = flow({ call: { ...modelStep("call"), body: shaped, config: shaped } }, [{ $component_ref: "call" }]);
    const writer = {
      component_type: "AgentNode",
      id: "writer",
      name: "writer",
      agent: { component_type: "Agent", id: "a", name: "a", tools: [{ component_type: "FlowTool", id: "t", name: "t", flow: toolFlow }] },
    };
    const findings = unread(flow({ writer }, [{ $component_ref: "writer" }]));
    // The tool flow's own model step is unread; the payloads inside it add nothing.
    expect(findings.map((f) => f.location)).toEqual([
      "$.$referenced_components.writer.agent.tools[0].flow.$referenced_components.call",
    ]);
  });

  // Every key through which the document nests components: a model step reached only
  // through it, from a node the run reads, is refused. (`$referenced_components`,
  // `subflow` and `subflows` are read holders; they are covered below, inside a flow the run does not read.)
  const holderKeys: Array<[string, boolean]> = [
    ["start_node", false],
    ["nodes", true],
    ["control_flow_connections", true],
    ["data_flow_connections", true],
    ["from_node", false],
    ["to_node", false],
    ["source_node", false],
    ["destination_node", false],
    ["flow", false],
    ["agent", false],
    ["agents", true],
    ["tools", true],
    ["toolboxes", true],
    ["tool", false],
    ["workers", true],
    ["group_manager", false],
    ["first_agent", false],
    ["relationships", true],
  ];
  it.each(holderKeys)("refuses a model step reached through the key %s (a list: %s)", (key, isList) => {
    const holder = { component_type: "AgentNode", id: "holder", name: "holder", [key]: isList ? [modelStep("draft")] : modelStep("draft") };
    const findings = unread(flow({ holder }, [{ $component_ref: "holder" }]));
    expect(findings.map((f) => f.location)).toEqual([`$.$referenced_components.holder.${key}${isList ? "[0]" : ""}`]);
    expect(findings[0].message).toContain(`sits in $.$referenced_components.holder.${key}`);
  });

  it("refuses a model step reached through a nested list of lists (relationships)", () => {
    const holder = { component_type: "AgentNode", id: "holder", name: "holder", relationships: [[modelStep("draft")]] };
    const findings = unread(flow({ holder }, [{ $component_ref: "holder" }]));
    expect(findings.map((f) => f.location)).toEqual(["$.$referenced_components.holder.relationships[0][0]"]);
  });

  it("refuses a model step reached through $referenced_components, subflow and subflows inside a flow the run does not read", () => {
    const innerSub = flow({ viaSubflow: modelStep("viaSubflow") }, [{ $component_ref: "viaSubflow" }]);
    const innerPar = flow({ viaSubflows: modelStep("viaSubflows") }, [{ $component_ref: "viaSubflows" }]);
    const toolFlow = flow(
      {
        viaRefs: modelStep("viaRefs"),
        sub: { component_type: "FlowNode", id: "sub", name: "sub", subflow: innerSub },
        fan: { component_type: "ParallelFlowNode", id: "fan", name: "fan", subflows: [innerPar] },
      },
      [{ $component_ref: "viaRefs" }, { $component_ref: "sub" }, { $component_ref: "fan" }],
    );
    const writer = {
      component_type: "AgentNode",
      id: "writer",
      name: "writer",
      agent: { component_type: "Agent", id: "a", name: "a", tools: [{ component_type: "FlowTool", id: "t", name: "t", flow: toolFlow }] },
    };
    const base = "$.$referenced_components.writer.agent.tools[0].flow.$referenced_components";
    const locations = unread(flow({ writer }, [{ $component_ref: "writer" }])).map((f) => f.location).sort();
    expect(locations).toEqual(
      [
        `${base}.viaRefs`,
        `${base}.sub.subflow.$referenced_components.viaSubflow`,
        `${base}.fan.subflows[0].$referenced_components.viaSubflows`,
      ].sort(),
    );
  });

  it("yields each read step with its holder", () => {
    const doc = flow({ draft: modelStep("draft") }, [{ $component_ref: "draft" }]);
    const steps: Array<[string, string]> = [];
    forEachRunStep(doc, ({ path, holder }) => steps.push([path, holder]));
    expect(steps).toContainEqual(["$", "$"]);
    expect(steps).toContainEqual(["$.$referenced_components.draft", "$.$referenced_components"]);
  });
});
