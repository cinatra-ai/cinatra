// cinatra#4897: a flow document that carries a model step in a holder the run
// does not read steps from (OAS-RUNTIME-016). An agent node holds an Agent whose
// tool is a FlowTool with an inline Flow, and that inline Flow holds the model
// step. The compile checks the document's structure only and accepts it; the run
// answers the step's calls with step_tool_step_unknown.

type Doc = Record<string, unknown>;

/** The path of the unread model step in the document `withUnreadModelStep` returns. */
export const UNREAD_MODEL_STEP_PATH =
  "$.$referenced_components.writer.agent.tools[0].flow.$referenced_components.draft";

/** `doc` with the agent node added to its `$referenced_components` (not wired into its nodes). */
export function withUnreadModelStep(doc: Doc): Doc {
  const toolFlow = {
    component_type: "Flow",
    id: "tool-flow",
    name: "tool-flow",
    inputs: [],
    outputs: [],
    start_node: { $component_ref: "start" },
    nodes: [{ $component_ref: "start" }, { $component_ref: "draft" }, { $component_ref: "end" }],
    control_flow_connections: [],
    data_flow_connections: [],
    $referenced_components: {
      start: { component_type: "StartNode", id: "start", name: "start", inputs: [] },
      draft: {
        component_type: "ApiNode",
        id: "draft",
        name: "draft",
        url: "{{CINATRA_BASE_URL}}/api/llm-bridge",
        http_method: "POST",
        inputs: [],
        outputs: [],
      },
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
  return { ...doc, $referenced_components: { ...refs, writer } };
}
