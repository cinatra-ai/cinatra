/**
 * CinatraAgentSpec typed-contract definitions.
 *
 * Runtime complement to `AgentIOSpec` design-time composability metadata.
 * `AgentIOSpec` declares WHICH object types flow between agents; `CinatraAgentSpec`
 * enforces THE SHAPE of those payloads at execution boundaries with real Zod schemas.
 *
 * Pure utility file: no `import "server-only"`, no DB imports, no React imports.
 * Safe to import from client code paths, worker code paths, and test files.
 */
import type { z } from "zod";

// ---------------------------------------------------------------------------
// Tool shape — kept loose until it can safely align with the SDK's agent tool
// type. Intentionally structural to avoid a circular dep with the orchestration
// layer while the type vocabulary stabilizes.
// ---------------------------------------------------------------------------
export type CinatraTool = {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Provider literal union — mirrors the execution_provider DB column values.
//
// NOTE: store.ts AgentTemplateRecord.executionProvider remains WIDE to read
// historical DB rows with the legacy langgraph value. The two types diverge
// intentionally — spec.ts is what callers may SET, store.ts is what we
// tolerate READING.
// ---------------------------------------------------------------------------
export type CinatraAgentProvider = "openai" | "anthropic" | "gemini" | "default";

// ---------------------------------------------------------------------------
// CinatraAgentSpec — the typed contract each agent exposes at runtime.
// TInput / TOutput are Zod schemas; z.infer<TOutput> threads the inferred
// output type through to handoffs without the caller restating it.
// ---------------------------------------------------------------------------
export type CinatraAgentSpec<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
> = {
  name: string;
  instructions: string;
  inputSchema: TInput;
  outputSchema: TOutput;
  tools: CinatraTool[];
  handoffs?: Array<CinatraHandoff<z.infer<TOutput>>>;
  provider?: CinatraAgentProvider;
  durable?: boolean;       // true → distributed tier (BullMQ); default false
  hitlRequired?: boolean;  // true → distributed tier; default false
};

// ---------------------------------------------------------------------------
// CinatraHandoff — typed parent → child data passing.
// inputFilter narrows the parent's validated output into the child's input
// shape. This maps to the `@openai/agents` SDK handoff() inputFilter.
// ---------------------------------------------------------------------------
export type CinatraHandoff<TParentOutput> = {
  agent: CinatraAgentSpec;
  condition?: (output: TParentOutput) => boolean;
  inputFilter: (output: TParentOutput) => unknown;
};
