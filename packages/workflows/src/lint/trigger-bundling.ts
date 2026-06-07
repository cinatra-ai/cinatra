import type { WorkflowSpec } from "../spec/schema";

// Trigger-boundary lint (the schema/import-lint portion; a separate runtime
// guard rejects trigger config at `trigger_config_set`). A workflow node's
// schedule is the single timing truth — an agent_task is dispatched as a
// run-now leaf with NO trigger data. Nesting a trigger inside a workflow would
// make the reconciler + Gantt "observability fiction".

const TRIGGER_PACKAGE_RE = /(^|\/)trigger(-agent)?$|@cinatra-ai\/trigger/i;
// Keys in an agent_task input that would (mis)configure a nested trigger.
const TRIGGER_INPUT_KEYS = ["triggerConfig", "trigger_config", "trigger", "cron", "schedule_trigger"];

export type TriggerLintFinding = {
  code: "TRIGGER_BUNDLING";
  message: string;
  path: string;
};

/**
 * Flag agent_task nodes that bundle / configure a trigger inside a workflow.
 * Returns an empty array when the spec is clean. Heuristic (a separate hard
 * runtime guard enforces the same rule); used at create/update + on
 * marketplace install.
 */
export function lintWorkflowSpecForTriggerBundling(spec: WorkflowSpec): TriggerLintFinding[] {
  const findings: TriggerLintFinding[] = [];
  spec.tasks.forEach((task, i) => {
    if (task.type !== "agent_task") return;
    const pkg = task.agentRef?.package ?? "";
    if (typeof pkg === "string" && TRIGGER_PACKAGE_RE.test(pkg)) {
      findings.push({
        code: "TRIGGER_BUNDLING",
        message: `Task "${task.key}" dispatches the trigger-agent. A workflow node is the timing truth; agent_task must be a run-now leaf.`,
        path: `tasks[${i}].agentRef.package`,
      });
    }
    const input = (task as { input?: Record<string, unknown> }).input;
    if (input && typeof input === "object") {
      for (const key of TRIGGER_INPUT_KEYS) {
        if (key in input) {
          findings.push({
            code: "TRIGGER_BUNDLING",
            message: `Task "${task.key}" passes trigger config "${key}" to an agent. Triggers do not nest inside workflows.`,
            path: `tasks[${i}].input.${key}`,
          });
        }
      }
    }
  });
  return findings;
}

/**
 * Flag an agent package manifest (package.json / agent.json) that declares the
 * trigger-agent as a dependency — used on marketplace install.
 */
export function lintManifestForTriggerBundling(manifest: {
  name?: string;
  dependencies?: Record<string, string>;
}): TriggerLintFinding[] {
  const deps = Object.keys(manifest.dependencies ?? {});
  const offenders = deps.filter((d) => TRIGGER_PACKAGE_RE.test(d));
  return offenders.map((d) => ({
    code: "TRIGGER_BUNDLING" as const,
    message: `Package "${manifest.name ?? "?"}" bundles the trigger-agent dependency "${d}"; triggers must not nest inside workflow agents.`,
    path: `dependencies.${d}`,
  }));
}
