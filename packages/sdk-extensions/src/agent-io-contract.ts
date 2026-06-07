// Agent I/O contract — the declarative input/output shape an agent extension
// declares (used by the composability check `canCompose`).
//
// Inlined here so `@cinatra-ai/sdk-extensions` is a true LEAF and does
// NOT import `@cinatra-ai/objects`. Structurally identical to the
// `@cinatra-ai/objects` `agent-io-spec` source of truth (objects keeps its zod
// schemas + runtime; this is the host-neutral type half).

export type InputCardinality = "one" | "many";
export type OutputCardinality = "one" | "one-per-input" | "many";

export type AgentIOPort = {
  type: string;
  cardinality: InputCardinality;
};

export type AgentOutputPort = {
  type: string;
  cardinality: OutputCardinality;
};

/**
 * Declarative input/output contract for an agent. Used by the composability
 * check utility (`canCompose`) to decide whether two agents can be chained.
 */
export type AgentIOSpec = {
  input: AgentIOPort[];
  output: AgentOutputPort[];
};
