/**
 * SDK-free Anthropic skill-delivery helpers.
 *
 * These helpers are extracted out of `anthropic.ts` so they can be unit
 * tested WITHOUT pulling in `@anthropic-ai/sdk` (and so the standing-invariant
 * enforcement is independently verifiable). They contain the structural
 * enforcement that skills reach Anthropic ONLY via `container.skills`, never
 * as function / shell / read_skill / bash tools.
 */

import type {
  LlmTool,
  LlmFunctionTool,
  LlmShellTool,
  LlmContainerSkillsTool,
} from "../types";
import {
  AnthropicFunctionToolSkillError,
  AnthropicSkillCapError,
} from "../errors";

/** Anthropic hard per-request Custom Skills maximum. */
export const ANTHROPIC_MAX_SKILLS_PER_REQUEST = 8;

export function isFunctionTool(tool: LlmTool): tool is LlmFunctionTool {
  return !("type" in tool) || tool.type === "function" || tool.type === undefined;
}

export function isShellTool(tool: LlmTool): tool is LlmShellTool {
  return "type" in tool && tool.type === "shell";
}

export function isContainerSkillsTool(
  tool: LlmTool,
): tool is LlmContainerSkillsTool {
  return "type" in tool && tool.type === "container_skills";
}

/**
 * Fail-closed enforcement of the skill-delivery invariant. Runs at the TOP of
 * `generate` and `stream`, before any tool processing, so EVERY caller is
 * covered (orchestration arms via the SkillDeliveryAdapter seam, plus the
 * chat runner / agent-stream / llm-bridge which build skill tools outside the
 * seam and pass them in `tools` / `extraTools`). A skill-bearing shell tool or
 * a `read_skill`/`bash` function tool reaching here is a structural
 * violation: throw, never translate or silently strip.
 *
 * Non-skill function tools (MCP function-tools transport, agent-defined
 * tools) and non-skill shell tools (shell with an empty `skills` array) are
 * untouched — this targets skill delivery only.
 */
export function assertNoFunctionToolSkillDelivery(
  tools: LlmTool[] | undefined,
): void {
  if (!tools) return;
  for (const tool of tools) {
    if (isShellTool(tool) && tool.skills && tool.skills.length > 0) {
      throw new AnthropicFunctionToolSkillError(
        `shell tool carrying ${tool.skills.length} skill(s) ` +
          `[${tool.skills.map((s) => s.name).join(", ")}]`,
      );
    }
    if (isFunctionTool(tool) && (tool.name === "read_skill" || tool.name === "bash")) {
      throw new AnthropicFunctionToolSkillError(`function tool "${tool.name}"`);
    }
  }
}

/**
 * Build the Anthropic top-level `container` request param from a
 * container_skills tool. Each pre-synced ref becomes a
 * `{ type: "custom", skill_id, version }` entry. Returns undefined when no
 * container_skills tool is present (no skills → no container param, no beta
 * stack).
 */
export function buildContainerSkillsParam(
  tools: LlmTool[] | undefined,
):
  | { skills: Array<{ type: "custom"; skill_id: string; version: string }> }
  | undefined {
  const containerTool = tools?.find(isContainerSkillsTool);
  if (!containerTool || containerTool.skills.length === 0) return undefined;
  // Enforce the hard 8/request cap at the provider boundary too.
  // AnthropicContainerSkillDelivery already caps, but a direct caller passing a
  // raw LlmContainerSkillsTool with 9+ skills must fail loud here rather than
  // emit an invalid API request.
  if (containerTool.skills.length > ANTHROPIC_MAX_SKILLS_PER_REQUEST) {
    throw new AnthropicSkillCapError(
      containerTool.skills.length,
      containerTool.skills.map((s) => s.catalogSkillId ?? s.skillId),
    );
  }
  return {
    skills: containerTool.skills.map((s) => ({
      type: "custom" as const,
      skill_id: s.skillId,
      version: s.version,
    })),
  };
}

/**
 * The single tool-array entry a container_skills tool contributes: the
 * code-execution tool. The skill refs themselves go in the top-level
 * `container` param (see buildContainerSkillsParam), NEVER as function tools.
 */
export const CONTAINER_SKILLS_CODE_EXECUTION_ENTRY = {
  type: "code_execution_20250825" as const,
  name: "code_execution" as const,
};
