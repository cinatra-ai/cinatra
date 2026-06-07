import { z } from "zod";

// ---------------------------------------------------------------------------
// Agent I/O spec
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Zod schemas mirror the TypeScript I/O contract.
// Used by validate-agent-json and the compiler's agent-io-spec validation path.
// ---------------------------------------------------------------------------

export const inputCardinalitySchema = z.enum(["one", "many"]);
export const outputCardinalitySchema = z.enum(["one", "one-per-input", "many"]);

export const agentIOPortSchema = z.object({
  type: z.string().min(1),
  cardinality: inputCardinalitySchema,
});

export const agentOutputPortSchema = z.object({
  type: z.string().min(1),
  cardinality: outputCardinalitySchema,
});

export const agentIOSpecSchema = z.object({
  input: z.array(agentIOPortSchema),
  output: z.array(agentOutputPortSchema),
});
