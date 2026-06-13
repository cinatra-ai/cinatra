import { generate } from "@cinatra-ai/llm";
import { createDeterministicSkillsClient } from "@cinatra-ai/skills/mcp-client";
import { agentIOSpecSchema, type AgentIOSpec } from "@cinatra-ai/objects";
import type { CompiledStep } from "./store";
import { COMPILER_AGENTIC_SKILL_ID } from "./agent-builder-ids";

// Compile result type for the single agentic branch (WayFlow target).
export type CompileAgenticWorkflowResult = {
  type: "leaf" | "proxy" | "orchestrator" | "parallel" | "supervisor" | "iterative";
  mode: "agentic";
  taskSpec: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  inputSpec: AgentIOSpec;
  outputSpec: AgentIOSpec;
};

// compileWorkflow dispatches to compileAgenticWorkflow and returns the agentic-shaped result.
export type CompileWorkflowResult = CompileAgenticWorkflowResult;

export type CompileWorkflowOptions = {
  /** WayFlow is the only execution provider. The field is accepted as
   *  `"wayflow"` so callers can record provenance; the dispatch path is unchanged. */
  executionProvider?: "wayflow";
};

// ---------------------------------------------------------------------------
// LLM compilation helpers
// ---------------------------------------------------------------------------

// Module-level cache so repeated calls in a single process avoid re-reading disk
let cachedAgenticSkillBody: string | null = null;

async function loadSkillBodyById(skillId: string): Promise<string | null> {
  try {
    const client = createDeterministicSkillsClient({
      actor: { actorType: "system", source: "worker" },
    });
    const skill = await client.installed.get(skillId);
    const body = skill?.body ?? skill?.content ?? null;
    return body && body.trim().length > 0 ? body : null;
  } catch {
    return null;
  }
}

async function loadAgenticSkillBody(): Promise<string | null> {
  if (cachedAgenticSkillBody !== null) return cachedAgenticSkillBody;
  cachedAgenticSkillBody = await loadSkillBodyById(COMPILER_AGENTIC_SKILL_ID);
  return cachedAgenticSkillBody;
}

// ---------------------------------------------------------------------------
// Agentic task spec validation
// ---------------------------------------------------------------------------

// Pure validation helper — lives in validate-task-spec.ts for testability
export { validateAgenticTaskSpec } from "./validate-task-spec";

// ---------------------------------------------------------------------------
// parseIoSpec — parse an LLM-emitted AgentIOSpec with safe fallback
// ---------------------------------------------------------------------------
function parseIoSpec(raw: unknown): AgentIOSpec {
  const result = agentIOSpecSchema.safeParse(raw);
  return result.success ? result.data : { input: [], output: [] };
}

// ---------------------------------------------------------------------------
// compileAgenticWorkflow — agentic taskSpec branch (WayFlow target)
//
// Loads the shared agent-builder-compiler-agentic SKILL.md body. Emits a
// structured agent definition (type + taskSpec + schemas) validated by shape
// checks below. Fails loud on missing/too-short taskSpec or invalid type.
// ---------------------------------------------------------------------------

// Agentic-compile fallback prompt. Intentionally terse: when the
// agent-builder-compiler-agentic skill body is unavailable, failing loud is safer
// than emitting a speculative spec.
const MINIMAL_AGENTIC_FALLBACK_PROMPT = `MISCONFIGURED: skill 'agent-builder-compiler-agentic' is not loadable. A deployed Cinatra install must have this skill registered. This fallback prompt is intentionally terse so the failure is loud.`;

type AgenticAgentType =
  | "leaf"
  | "proxy"
  | "orchestrator"
  | "parallel"
  | "supervisor"
  | "iterative";

const VALID_AGENTIC_TYPES: readonly AgenticAgentType[] = [
  "leaf",
  "proxy",
  "orchestrator",
  "parallel",
  "supervisor",
  "iterative",
];

async function compileAgenticWorkflow(
  sourceNl: string,
  availableTools: string[],
  _options: CompileWorkflowOptions,
): Promise<CompileAgenticWorkflowResult> {
  const skillBody = await loadAgenticSkillBody();
  const base = skillBody ?? MINIMAL_AGENTIC_FALLBACK_PROMPT;

  const systemPrompt = [
    base,
    "",
    "Available tools (reference these exact names in the task spec where appropriate):",
    ...availableTools.map((name) => `- ${name}`),
  ].join("\n");

  const userPrompt = [
    "Task description:",
    sourceNl,
    "",
    "Produce a structured agent definition. The response MUST be",
    "a single JSON object with keys: type, taskSpec, inputSchema,",
    "outputSchema, inputSpec, outputSpec.",
    "",
    "Agent type MUST be one of: leaf | proxy | orchestrator | parallel | supervisor | iterative.",
    "taskSpec MUST be a free-form text description (second person, 'You are...') of the agent's",
    "goal, inputs, constraints, and step-by-step behaviour. At least 200 characters.",
    "",
    "Return ONLY valid JSON — no markdown fences, no prose.",
  ].join("\n");

  const response = await generate({
    system: systemPrompt,
    prompt: userPrompt,
    maxSteps: 1,
    maxTokens: 16384,
    logLabel: "agent-builder-compile-agentic",
  });

  const rawText = response.text?.trim() ?? "";

  let parsed: unknown;
  try {
    // Strip markdown code fences if the model included them despite instructions.
    const cleaned = rawText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(
      `compileAgenticWorkflow: LLM returned non-JSON response. Raw:\n${rawText.slice(0, 500)}`,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(
      `compileAgenticWorkflow: LLM response is not a JSON object. Raw:\n${rawText.slice(0, 500)}`,
    );
  }

  const p = parsed as Record<string, unknown>;

  const typeValue = p.type;
  if (
    typeof typeValue !== "string" ||
    !VALID_AGENTIC_TYPES.includes(typeValue as AgenticAgentType)
  ) {
    throw new Error(
      `compileAgenticWorkflow: invalid 'type' value '${String(typeValue)}'. Expected one of: ${VALID_AGENTIC_TYPES.join(", ")}.`,
    );
  }
  const agentType = typeValue as AgenticAgentType;

  const taskSpec = p.taskSpec;
  if (typeof taskSpec !== "string" || taskSpec.trim().length < 50) {
    throw new Error(
      `compileAgenticWorkflow: missing or too-short 'taskSpec' in LLM response (got ${typeof taskSpec === "string" ? taskSpec.length : 0} chars).`,
    );
  }

  const inputSchema: Record<string, unknown> =
    p.inputSchema && typeof p.inputSchema === "object"
      ? (p.inputSchema as Record<string, unknown>)
      : { type: "object", properties: {}, required: [] };
  const outputSchema: Record<string, unknown> | undefined =
    p.outputSchema && typeof p.outputSchema === "object"
      ? (p.outputSchema as Record<string, unknown>)
      : undefined;

  return {
    type: agentType,
    mode: "agentic",
    taskSpec,
    inputSchema,
    outputSchema,
    inputSpec: parseIoSpec(p.inputSpec),
    outputSpec: parseIoSpec(p.outputSpec),
  };
}

// ---------------------------------------------------------------------------
// compileWorkflow — single-path public API
// ---------------------------------------------------------------------------

export async function compileWorkflow(
  sourceNl: string,
  availableTools: string[],
  options: CompileWorkflowOptions = {},
): Promise<CompileWorkflowResult> {
  return compileAgenticWorkflow(sourceNl, availableTools, options);
}
