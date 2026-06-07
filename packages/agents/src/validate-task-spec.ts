/**
 * Pure validation helpers for agentic task specs.
 * Extracted from compiler.ts so they can be unit-tested without pulling in
 * server-only imports (generate, db, etc.).
 */

const MIN_TASK_SPEC_LENGTH = 100;

/**
 * Throws if `taskSpec` is too short or fails tool-grounding. Pure function —
 * easy to unit-test independently of generate.
 */
export function validateAgenticTaskSpec(
  taskSpec: string,
  availableTools: string[],
): void {
  const trimmed = taskSpec.trim();

  // Check 1: length floor
  if (trimmed.length <= MIN_TASK_SPEC_LENGTH) {
    throw new Error(
      `compileAgenticWorkflow: generated taskSpec is too short (length=${trimmed.length}, required > ${MIN_TASK_SPEC_LENGTH}). The LLM did not produce a usable task description.`,
    );
  }

  // Check 2: tool grounding — at least one of the available tool names must
  //          appear in the spec text. Without this, the spec is "ungrounded"
  //          and the runtime agent will have no idea which tools to call.
  //
  // Exception: self-contained specs explicitly declare they use no Cinatra tools.
  // Only match Cinatra-specific phrases to avoid false positives on tool-using
  // specs that happen to contain common English words like "self-contained".
  // The compiler's agentic SKILL.md instructs the LLM to emit one of these two
  // exact phrases when the user requests an LLM-only agent.
  const isSelfContained =
    trimmed.includes("no Cinatra platform tools") ||
    trimmed.includes("no Cinatra tools");

  if (!isSelfContained) {
    const mentionsAtLeastOneTool = availableTools.some((toolName) =>
      trimmed.includes(toolName),
    );
    if (!mentionsAtLeastOneTool) {
      throw new Error(
        `compileAgenticWorkflow: generated taskSpec is ungrounded — it does not mention any tool from availableTools (${availableTools.length} tools available, no tool reference found in spec). The LLM produced a spec that cannot be executed by the agentic runner.`,
      );
    }
  }
}
