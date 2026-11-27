// cinatra#4897: a flow document that carries a model step in a holder the run
// does not read steps from (OAS-RUNTIME-016). An agent node holds an Agent whose
// tool is a FlowTool with an inline Flow, and that inline Flow lists the model
// step among its `nodes`. The compile checks the document's structure only and
// accepts it; the run answers the step's calls with step_tool_step_unknown.
//
// The agent node is listed in the flow's `nodes`, so the graph reaches it. Left
// unlisted (`wired` false) it is a registry entry nothing refers to: never
// instantiated, so no run can call its step, and the document installs.

type Doc = Record<string, unknown>;

/** The path of the unread model step in the document `withUnreadModelStep` returns. */
export const UNREAD_MODEL_STEP_PATH =
  "$.$referenced_components.writer.agent.tools[0].flow.nodes[1]";

/**
 * `doc` with the agent node added to its `$referenced_components` and, when
 * `wired`, referenced from its `nodes`.
 */
export function withUnreadModelStep(doc: Doc, wired = true): Doc {
  const toolFlow = {
    component_type: "Flow",
    id: "tool-flow",
    name: "tool-flow",
    inputs: [],
    outputs: [],
    start_node: { $component_ref: "start" },
    nodes: [
      { $component_ref: "start" },
      {
        component_type: "ApiNode",
        id: "draft",
        name: "draft",
        url: "{{CINATRA_BASE_URL}}/api/llm-bridge",
        http_method: "POST",
        inputs: [],
        outputs: [],
      },
      { $component_ref: "end" },
    ],
    control_flow_connections: [],
    data_flow_connections: [],
    $referenced_components: {
      start: { component_type: "StartNode", id: "start", name: "start", inputs: [] },
      end: { component_type: "EndNode", id: "end", name: "end", outputs: [] },
    },
  };
  const writer = {
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
  const refs = (doc.$referenced_components ?? {}) as Doc;
  const nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  return {
    ...doc,
    ...(wired ? { nodes: [...nodes, { $component_ref: "writer" }] } : {}),
    $referenced_components: { ...refs, writer },
  };
}
