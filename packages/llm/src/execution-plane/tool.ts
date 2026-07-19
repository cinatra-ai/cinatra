/**
 * The `sandbox_execution` tool builder + type guard (exec-plane S1 #1706;
 * S2 provider translation #1707).
 *
 * Kept separate from the provider adapters: this module constructs the
 * provider-agnostic union member; the adapters translate it per provider
 * (OpenAI native `type:"shell"` with a function-tool fallback, Anthropic /
 * Gemini named function tool) and dispatch model calls back to `execute`.
 *
 * S2 contract change: the sealed session carrier NO LONGER rides on the tool
 * object. It is captured in the `execute` closure at build time, so it cannot
 * cross the provider boundary BY CONSTRUCTION — the adapters receive the tool
 * (to translate its model-facing schema) but there is no carrier field to
 * mis-emit, log, or smuggle. Only the executor binding (the broker client the
 * app wiring supplies) ever sees the carrier again.
 */

import type {
  LlmSandboxExecutionTool,
  LlmTool,
  SandboxEnvironmentMount,
  SandboxExecuteAction,
  SandboxExecuteOutput,
  SandboxExecutor,
  SandboxStagedSkill,
  SealedExecutionSessionCarrier,
} from "../types";

/** The single, contractual tool name for the execution capability. */
export const SANDBOX_EXECUTE_TOOL_NAME = "sandbox_execute" as const;

const SANDBOX_TOOL_DESCRIPTION =
  "Execute shell commands in an isolated, non-root sandbox: run scripts, and " +
  "install unprivileged packages (pip / npm / user-space binaries) that " +
  "persist across steps. Has internet access. Contains no credentials and no " +
  "host data.";

/**
 * Model-facing description suffix when catalog skill snapshots are staged
 * read-only into the sandbox (the merged skills+execution case).
 */
function stagedSkillsDescription(staged: SandboxStagedSkill[]): string {
  if (staged.length === 0) return "";
  const listing = staged
    .map((s) => `'/skills/${s.slug}/SKILL.md' — ${s.description}`)
    .join("; ");
  return (
    " Skill files are staged read-only under /skills/<slug>: " + listing + "."
  );
}

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
 * Build the provider-agnostic `sandbox_execution` tool.
 *
 * The sealed carrier + the executor binding are captured in the `execute`
 * closure (never fields on the tool). Staged skill snapshots (S2
 * skill-execution unification) ride as data so the OpenAI adapter can list
 * them on the single native shell declaration; their CONTENT is resolved
 * lazily by the executor at stage time.
 *
 * Skill-read attribution (S10 efficacy loop): each staged skill may carry an
 * `onRead` callback; the wrapper fires it (best-effort, at most once per
 * command batch per skill) when a command references the skill's staged
 * `/skills/<slug>` path — the sandbox-side read is otherwise invisible to the
 * in-process exposure recorder.
 */
export function buildSandboxExecutionTool(input: {
  sessionCarrier: SealedExecutionSessionCarrier;
  executor: SandboxExecutor;
  stagedSkills?: SandboxStagedSkill[];
  /**
   * The run's resolved L1 declared-environment mount (exec-plane S3,
   * cinatra#1708). Captured in the `execute` closure and passed to the executor
   * (→ `broker.openJob({ environment })`) — never a field on the tool object,
   * so it cannot cross the provider boundary. Absent ⇒ the L0 base.
   */
  environment?: SandboxEnvironmentMount;
}): LlmSandboxExecutionTool {
  const staged = input.stagedSkills ?? [];
  const execute = async (
    action: SandboxExecuteAction,
  ): Promise<SandboxExecuteOutput[]> => {
    // Best-effort attributable skill-read signal, per staged skill.
    for (const skill of staged) {
      if (!skill.onRead) continue;
      const marker = `/skills/${skill.slug}`;
      if (action.commands.some((c) => c.includes(marker))) {
        try {
          skill.onRead(skill.skillId);
        } catch {
          // Attribution must never break execution.
        }
      }
    }
    return input.executor({
      sessionCarrier: input.sessionCarrier,
      commands: action.commands,
      timeoutMs: action.timeoutMs ?? null,
      maxOutputLength: action.maxOutputLength ?? null,
      stagedSkills: staged,
      ...(input.environment ? { environment: input.environment } : {}),
    });
  };
  return {
    type: "sandbox_execution",
    toolName: SANDBOX_EXECUTE_TOOL_NAME,
    description: SANDBOX_TOOL_DESCRIPTION + stagedSkillsDescription(staged),
    ...(staged.length > 0 ? { stagedSkills: staged } : {}),
    execute,
  };
}

/**
 * Remove every `sandbox_execution` tool from a tool array. Called by the
 * orchestration entry points before handing tools to a provider adapter on
 * every NON-injected path (passthrough / unavailable): only the single
 * injection site may deliver the capability, so a smuggled or stale sandbox
 * tool never reaches a provider. Returns the input unchanged when it is
 * `undefined` so the byte-identical "no tools" shape is preserved for
 * text-only callers.
 */
export function stripSandboxExecutionTools(
  tools: LlmTool[] | undefined,
): LlmTool[] | undefined {
  if (!tools) return tools;
  const stripped = tools.filter((t) => !isSandboxExecutionTool(t));
  return stripped;
}
