// Compile-time side-effects inference.
//
// Pure functions — no DB, no network, no Redis. Called once at compile time
// from oas-compiler.ts; output is persisted on the compiled OAS root (and from
// there into agent_templates.trigger_mode + agent_templates.gated_steps) and
// read at runtime by the Trigger gate and at display time by the Trigger tab UI.
//
// Public surface:
//   - SIDE_EFFECT_PATTERNS    : readonly RegExp[] — the four canonical suffixes
//   - inferStepSideEffects    : (riskClass, override?) → boolean
//   - deriveTriggerMode       : (runtime?) → "full" | "start-only"
//   - collectGatedSteps       : (CompiledOas-shape) → GatedStep[]
//   - GatedStep, TriggerMode, InferenceCompiledOas, InferenceStep types

/**
 * Tool-name suffix patterns that indicate an irreversible external side effect.
 * Matched against the step's `riskClass` field (the existing author-set
 * tool-kind tag, e.g. "gmail_email_send", "linkedin_post_publish").
 *
 * The author can override per-step via `sideEffects: true|false` — the
 * override always wins over a pattern match, in either direction (e.g. a
 * dry-run preview for `gmail_email_send` can be ungated via `sideEffects: false`).
 */
export const SIDE_EFFECT_PATTERNS: readonly RegExp[] = [
  /_send$/,
  /_publish$/,
  /_post$/,
  /_delete$/,
];

/**
 * True when `riskClass` matches a side-effect pattern, OR when the optional
 * `override` is true. False when the override is false.
 *
 * Override semantics: explicit author intent always wins.
 *  - undefined → infer from pattern
 *  - true      → gated (regardless of pattern)
 *  - false     → not gated (regardless of pattern)
 */
export function inferStepSideEffects(
  riskClass: string,
  override?: boolean,
): boolean {
  if (override === true) return true;
  if (override === false) return false;
  return SIDE_EFFECT_PATTERNS.some((rx) => rx.test(riskClass));
}

export type GatedStep = {
  stepId: string;
  stepNumber: number;
  agentPath: string[];
  label: string;
  toolName: string;
  inferredOrManual: "inferred" | "manual";
};

export type TriggerMode = "full" | "start-only";

/**
 * Derive triggerMode from the agent's runtime classification.
 *  - wayflow / cinatra-linear → "full" (statically analyzable per-step)
 *  - langgraph / autogen / oasAdapter / unknown → "start-only" (conservative)
 *  - undefined → "full" (most cinatra agents are wayflow)
 *
 * The conservative default for unknown runtimes ensures we never claim "full"
 * gating coverage on a runtime whose step structure we cannot statically walk.
 */
export function deriveTriggerMode(runtime: string | undefined): TriggerMode {
  if (runtime === undefined) return "full";
  return runtime === "wayflow" || runtime === "cinatra-linear" ? "full" : "start-only";
}

/**
 * Structural input — matches the real CompiledAgentOas shape but only the
 * fields this module reads. Includes the optional `sideEffects` field
 * that oas-compiler.ts adds to CompiledAgentOasStep.
 *
 * Plain-object type (not a class) so callers can construct ad-hoc test
 * fixtures without needing the full compiler pipeline.
 */
export type InferenceStep = {
  stepNumber: number;
  riskClass?: string;
  description?: string;
  name?: string;
  sideEffects?: boolean;
  childAgent?: { packageName: string; inputMapping?: Record<string, string> };
};

export type InferenceCompiledOas = {
  packageName?: string | null;
  approvalPolicy?: { steps?: InferenceStep[] };
};

/**
 * Walk the compiled OAS's `approvalPolicy.steps[]` and collect every step
 * whose riskClass matches a side-effect pattern (or whose author marked it
 * as such via `sideEffects: true`). Sub-agent (`childAgent`) steps are
 * opaque — they only contribute a GatedStep when the parent step is
 * annotated `sideEffects: true`.
 *
 * Recursive sub-agent walking is out of scope here: `loadGlobalRegistry`
 * returns shared OAS components, not compiled sub-agent OAS. Recursive
 * analysis would need to invoke `compileOasAgentJson` per sub-agent package.
 *
 * The returned list preserves source order (matching `approvalPolicy.steps`).
 */
export function collectGatedSteps(root: InferenceCompiledOas): GatedStep[] {
  const out: GatedStep[] = [];
  const rootName = root.packageName ?? "RootAgent";
  const steps = root.approvalPolicy?.steps ?? [];

  for (const step of steps) {
    const stepIdBase = step.name ?? `step-${step.stepNumber}`;
    const labelBase = step.description ?? step.name ?? stepIdBase;

    if (step.childAgent) {
      // Opaque-childAgent rule: only contributes when annotated `sideEffects: true`.
      if (step.sideEffects === true) {
        out.push({
          stepId: stepIdBase,
          stepNumber: step.stepNumber,
          agentPath: [rootName, step.childAgent.packageName],
          label: labelBase,
          toolName: "(opaque)",
          inferredOrManual: "manual",
        });
      }
      continue;
    }

    const riskClass = step.riskClass ?? "";
    if (inferStepSideEffects(riskClass, step.sideEffects)) {
      out.push({
        stepId: stepIdBase,
        stepNumber: step.stepNumber,
        agentPath: [rootName],
        label: labelBase,
        toolName: riskClass,
        // sideEffects === false is already filtered out by inferStepSideEffects
        // above (it returns false), so the only explicit-override case that
        // reaches here is sideEffects === true.
        inferredOrManual: step.sideEffects === true ? "manual" : "inferred",
      });
    }
  }
  return out;
}
