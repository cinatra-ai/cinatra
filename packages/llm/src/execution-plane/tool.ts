/**
 * The `sandbox_execution` tool builder + type guard (exec-plane S1,
 * cinatra#1706).
 *
 * Kept separate from the provider adapters: in S1 the adapters do not translate
 * this tool (S2 owns per-provider translation). This module only constructs the
 * provider-agnostic union member and identifies it in a tool array (for
 * idempotent dedup and carrier stripping).
 */

import type { LlmSandboxExecutionTool, LlmTool } from "../types";
import type { SealedExecutionSessionCarrier } from "../types";

/** The single, contractual tool name for the execution capability. */
export const SANDBOX_EXECUTE_TOOL_NAME = "sandbox_execute" as const;

const SANDBOX_TOOL_DESCRIPTION =
  "Execute shell commands in an isolated, non-root sandbox: run scripts, and " +
  "install unprivileged packages (pip / npm / user-space binaries) that " +
  "persist across steps. Has internet access. Contains no credentials and no " +
  "host data.";

/** Narrowing guard for the execution-plane union member. */
export function isSandboxExecutionTool(
  tool: LlmTool,
): tool is LlmSandboxExecutionTool {
  return "type" in tool && tool.type === "sandbox_execution";
}

/** True when a tool array already carries the execution tool (dedup check). */
export function hasSandboxExecutionTool(
  tools: LlmTool[] | undefined,
): boolean {
  return Boolean(tools?.some(isSandboxExecutionTool));
}

/**
 * Build the provider-agnostic `sandbox_execution` tool bound to a sealed
 * session carrier. The carrier is the ONLY session material on the tool and is
 * stripped before any provider-adapter call (`stripSandboxExecutionTools`).
 */
export function buildSandboxExecutionTool(
  sessionCarrier: SealedExecutionSessionCarrier,
): LlmSandboxExecutionTool {
  return {
    type: "sandbox_execution",
    toolName: SANDBOX_EXECUTE_TOOL_NAME,
    sessionCarrier,
    description: SANDBOX_TOOL_DESCRIPTION,
  };
}

/**
 * Remove every `sandbox_execution` tool from a tool array. Called by the
 * orchestration entry points immediately before handing tools to a provider
 * adapter in S1 (the adapters cannot translate it yet and, more importantly,
 * the opaque session carrier must never cross the provider boundary). Returns
 * `undefined` when the result would be empty AND the input was `undefined`, so
 * the byte-identical "no tools" shape is preserved for text-only callers.
 */
export function stripSandboxExecutionTools(
  tools: LlmTool[] | undefined,
): LlmTool[] | undefined {
  if (!tools) return tools;
  const stripped = tools.filter((t) => !isSandboxExecutionTool(t));
  return stripped;
}
