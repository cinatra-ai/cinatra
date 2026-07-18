/**
 * Execution-plane policy + central system-cue composition (exec-plane S1,
 * cinatra#1706).
 *
 * Two distinct gates — do not conflate them:
 *
 *  1. ROLLOUT flag (`isExecutionPlaneRolloutEnabled`): a TEMPORARY merge gate,
 *     default-OFF, so S1 lands dark. This is NOT the D4 policy default (the
 *     shipped policy default is ON) — it exists only so the injection wiring
 *     can merge before the broker/worker slice is live. When off, injection is
 *     a pure passthrough and live behavior is byte-identical.
 *
 *  2. AVAILABILITY posture (`ExecutionAvailability`): the D4 per-org / per-agent
 *     policy. When the rollout flag is on, this decides whether an identified
 *     caller actually gets the capability. `"enabled"` ⇒ inject; `"disabled"`
 *     (opt-out) ⇒ a structured `capability_unavailable` error (distinguishable
 *     from `no_session`), model stays usable.
 *
 * The cue is composed HERE, in the same module that builds the tool, so the
 * tool schema and its policy-derived system cue can never diverge (the epic's
 * "tool and cue cannot diverge" invariant): `injectExecutionCapability` calls
 * `composeExecutionCue` exactly once alongside `buildSandboxExecutionTool`.
 */

import type { ExecutionSession } from "./session";
import type { SandboxStagedSkill } from "../types";

/** Per-org / per-agent D4 availability posture, resolved by the caller. */
export type ExecutionAvailability = "enabled" | "disabled";

/**
 * The temporary S1 merge gate. Default-OFF. Reads
 * `CINATRA_EXECUTION_PLANE_ROLLOUT`; only the exact string `"on"` enables it
 * (any other value — unset, `""`, `"off"`, `"true"`, `"1"` — stays off, so the
 * dark default is impossible to trip by accident). Injectable override for
 * tests.
 */
export function isExecutionPlaneRolloutEnabled(override?: string): boolean {
  const raw = override ?? process.env.CINATRA_EXECUTION_PLANE_ROLLOUT;
  return raw === "on";
}

/**
 * Technical carve-out (D4): explicit single-step / structured-output tasks have
 * no post-tool turn in which the model could consume a tool result, so the
 * execution capability is suppressed by default for them. A structured-output
 * task (`outputSchema` present) or an explicit single-step budget
 * (`maxSteps === 1`) suppresses.
 */
export function shouldSuppressExecutionForTask(task: {
  outputSchema?: unknown;
  maxSteps?: number;
}): boolean {
  if (task.outputSchema !== undefined && task.outputSchema !== null) return true;
  if (task.maxSteps === 1) return true;
  return false;
}

/**
 * Non-streaming injected calls require a tool-aware step budget — at least one
 * post-tool step so the model can act on the sandbox result. Given the caller's
 * requested budget (possibly undefined), return a budget with ≥1 post-tool step
 * guaranteed (≥2 total). Never LOWERS an already-larger budget.
 */
export function ensureToolAwareStepBudget(requested: number | undefined): number {
  const MIN_TOOL_AWARE_STEPS = 2; // ≥1 model step + ≥1 post-tool step
  if (typeof requested !== "number" || !Number.isFinite(requested)) {
    return MIN_TOOL_AWARE_STEPS;
  }
  return Math.max(requested, MIN_TOOL_AWARE_STEPS);
}

/**
 * The short, policy-derived system cue that makes the model AWARE of the
 * execution capability. Composed centrally so it is emitted if and ONLY if the
 * matching tool is injected. Kept intentionally terse and free of any secret /
 * host detail — the sandbox holds no credentials or host data (D5), and the cue
 * says so, steering the model away from expecting ambient authority inside it.
 */
export function composeExecutionCue(
  session: ExecutionSession,
  opts?: { stagedSkills?: SandboxStagedSkill[] },
): string {
  const runNote = session.runId
    ? " Files you create persist across steps within this run."
    : " Files you create persist across the steps of this task.";
  const staged = opts?.stagedSkills ?? [];
  const skillNote =
    staged.length > 0
      ? " Skill files are staged read-only under /skills/<slug> inside the " +
        "sandbox (available: " +
        staged.map((s) => `/skills/${s.slug}`).join(", ") +
        ") — read them lazily with cat/head/tail when a skill applies."
      : "";
  return (
    "You have a `sandbox_execute` tool: an isolated, non-root sandbox for " +
    "running shell commands, scripts, and unprivileged package installs " +
    "(pip / npm / user-space binaries). It has internet access for downloading " +
    "and installing tools. It contains NO credentials and NO host data — use " +
    "the connector/MCP tools for authenticated actions, never the sandbox." +
    runNote +
    skillNote
  );
}
