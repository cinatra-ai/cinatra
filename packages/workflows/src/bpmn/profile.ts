// Cinatra BPMN Profile 1.0 validator (BPMN-03) + WorkflowSpec lossiness guard.
//
// `validateBpmnAgainstProfile` fails CLOSED on the full moddle graph: exactly one
// process, exactly one start event, at least one end event, every flow node in the
// supported set, recursive descent into eventDefinitions + loopCharacteristics, and
// no conditionExpression on a sequenceFlow. Every unsupported construct yields a
// structured `bpmn_unsupported_construct` (element id + reason); cardinality issues
// yield `bpmn_structure_invalid`. All errors are collected (not first-only).
//
// `validateWorkflowSpecAgainstBpmnProfile` is the emit-side lossiness guard: a
// WorkflowSpec carrying any field outside the Profile 1.0 emit subset (with a
// non-default value) fails with `bpmn_unsupported_workflowspec_field`. It descends
// recursively into `foreach.template`.

import type { WorkflowSpec, TaskSpec } from "../spec/schema";
import {
  BPMN_ERROR_CODES,
  type BpmnUnsupportedConstructError,
  type BpmnUnsupportedWorkflowSpecFieldError,
} from "./errors";

// BPMN element $types accepted by Profile 1.0.
const SUPPORTED_FLOW_NODE_TYPES = new Set<string>([
  "bpmn:StartEvent",
  "bpmn:EndEvent",
  "bpmn:UserTask",
  "bpmn:ServiceTask",
  "bpmn:ManualTask",
  "bpmn:SendTask",
  "bpmn:ParallelGateway",
]);

// Loop characteristics: MultiInstance supported (foreach); Standard rejected.
const SUPPORTED_LOOP_TYPE = "bpmn:MultiInstanceLoopCharacteristics";

type ModdleElement = { $type: string; id?: string; [key: string]: unknown };

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function elementId(el: ModdleElement): string | null {
  return typeof el.id === "string" ? el.id : null;
}

function unsupported(el: ModdleElement, reason: string): BpmnUnsupportedConstructError {
  return {
    code: BPMN_ERROR_CODES.unsupportedConstruct,
    elementId: elementId(el),
    elementType: el.$type,
    reason,
  };
}

export type BpmnProfileValidationResult =
  | { ok: true }
  | { ok: false; errors: BpmnUnsupportedConstructError[]; structureErrors: string[] };

/**
 * Validate a parsed BPMN `definitions` moddle object against Cinatra Profile 1.0.
 * Returns ok, or the full set of unsupported-construct + structure errors.
 */
export function validateBpmnAgainstProfile(definitions: unknown): BpmnProfileValidationResult {
  const errors: BpmnUnsupportedConstructError[] = [];
  const structureErrors: string[] = [];

  const defs = definitions as ModdleElement | null;
  const rootElements = asArray<ModdleElement>(defs?.rootElements);

  // Only bpmn:Process root elements are supported (no collaboration / choreography).
  const processes = rootElements.filter((e) => e.$type === "bpmn:Process");
  for (const re of rootElements) {
    if (re.$type !== "bpmn:Process") {
      errors.push(unsupported(re, `root element ${re.$type} is not supported (Profile 1.0 allows a single bpmn:Process)`));
    }
  }
  if (processes.length === 0) {
    structureErrors.push("no bpmn:Process found (Profile 1.0 requires exactly one)");
    return { ok: false, errors, structureErrors };
  }
  if (processes.length > 1) {
    structureErrors.push(`expected exactly one bpmn:Process, found ${processes.length}`);
  }

  const process = processes[0];
  const flowElements = asArray<ModdleElement>(process.flowElements);

  // id → $type, so a sequenceFlow can check its source node's kind.
  const typeById = new Map<string, string>();
  for (const el of flowElements) if (typeof el.id === "string") typeById.set(el.id, el.$type);
  const isTaskType = (t: string | undefined) =>
    t === "bpmn:UserTask" || t === "bpmn:ServiceTask" || t === "bpmn:ManualTask" || t === "bpmn:SendTask";

  let startCount = 0;
  let endCount = 0;

  for (const el of flowElements) {
    switch (el.$type) {
      case "bpmn:StartEvent": {
        startCount += 1;
        if (asArray(el.eventDefinitions).length > 0) {
          errors.push(unsupported(el, "typed start events (eventDefinitions) are not supported in Profile 1.0"));
        }
        break;
      }
      case "bpmn:EndEvent": {
        endCount += 1;
        if (asArray(el.eventDefinitions).length > 0) {
          errors.push(unsupported(el, "typed end events (eventDefinitions) are not supported in Profile 1.0"));
        }
        break;
      }
      case "bpmn:SequenceFlow": {
        if (el.conditionExpression) {
          errors.push(unsupported(el, "conditionExpression on sequenceFlow is not supported in Profile 1.0 (no condition semantics)"));
        }
        // cinatra:transitionOutcome may ONLY ride a task-outbound flow — the
        // outcome is a property of the upstream task's edge, not of a routing
        // node (gateway) or the start event. Catching it here (validator walks
        // ALL flows) covers placements the compiler's task-resolution path never
        // visits, e.g. a gateway → endEvent flow carrying an outcome.
        const flowExt = (el.extensionElements as { values?: unknown } | undefined)?.values;
        const hasOutcome = asArray<ModdleElement>(flowExt).some((v) => v.$type === "cinatra:TransitionOutcome");
        if (hasOutcome) {
          const srcType = typeById.get((el.sourceRef as ModdleElement | undefined)?.id ?? "");
          if (!isTaskType(srcType)) {
            errors.push(
              unsupported(el, `cinatra:transitionOutcome may only appear on a task-outbound sequenceFlow (source is ${srcType ?? "unknown"})`),
            );
          }
        }
        break;
      }
      case "bpmn:UserTask":
      case "bpmn:ServiceTask":
      case "bpmn:ManualTask":
      case "bpmn:SendTask": {
        const loop = el.loopCharacteristics as ModdleElement | undefined;
        if (loop) {
          if (loop.$type !== SUPPORTED_LOOP_TYPE) {
            errors.push(unsupported(loop, `loopCharacteristics ${loop.$type} is not supported (only ${SUPPORTED_LOOP_TYPE})`));
          } else {
            // A multiInstance loop MUST carry cinatra:foreachSource — native BPMN
            // multi-instance semantics (loopCardinality / completionCondition /
            // loopDataInputRef) are NOT supported and would silently lose the loop.
            const loopExt = (loop.extensionElements as { values?: unknown } | undefined)?.values;
            const hasForeach = asArray<ModdleElement>(loopExt).some((v) => v.$type === "cinatra:ForeachSource");
            if (!hasForeach) {
              errors.push(
                unsupported(
                  loop,
                  "multiInstanceLoopCharacteristics requires a cinatra:foreachSource (native loopCardinality / completionCondition is not supported in Profile 1.0)",
                ),
              );
            }
          }
        }
        break;
      }
      case "bpmn:ParallelGateway":
        break;
      default:
        errors.push(unsupported(el, `flow element ${el.$type} is not supported in Profile 1.0`));
    }
  }

  if (startCount !== 1) {
    structureErrors.push(`expected exactly one startEvent, found ${startCount}`);
  }
  if (endCount < 1) {
    structureErrors.push("expected at least one endEvent, found 0");
  }

  if (errors.length > 0 || structureErrors.length > 0) {
    return { ok: false, errors, structureErrors };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// WorkflowSpec lossiness guard (emit-side preflight).
// ---------------------------------------------------------------------------

export type WorkflowSpecProfileResult =
  | { ok: true }
  | { ok: false; errors: BpmnUnsupportedWorkflowSpecFieldError[] };

function lossyFieldError(field: string, taskKey: string | null, reason: string): BpmnUnsupportedWorkflowSpecFieldError {
  return { code: BPMN_ERROR_CODES.unsupportedWorkflowSpecField, field, taskKey, reason };
}

function checkTaskLossiness(task: TaskSpec, errors: BpmnUnsupportedWorkflowSpecFieldError[]): void {
  const key = task.key ?? null;
  const t = task as Record<string, unknown>;

  // `required` defaults to true (store: `t.required ?? true`); only `false` is a
  // non-default, lossy value (Profile 1.0 has no per-task required:false channel).
  if (t.required === false) {
    errors.push(lossyFieldError("required", key, "task.required:false is not representable in Profile 1.0 (required defaults to true)"));
  }
  if (t.pinned === true) errors.push(lossyFieldError("pinned", key, "task.pinned is not in Profile 1.0"));
  if (typeof t.risk === "string" && t.risk.length > 0) errors.push(lossyFieldError("risk", key, "task.risk is not in Profile 1.0"));
  if (t.parent != null) errors.push(lossyFieldError("parent", key, "task.parent (hierarchy) is not in Profile 1.0"));
  if (t.assignee != null) errors.push(lossyFieldError("assignee", key, "task.assignee is not in Profile 1.0"));
  if (t.missedWindowPolicy != null) errors.push(lossyFieldError("missedWindowPolicy", key, "task.missedWindowPolicy is not in Profile 1.0"));
  if (t.retryPolicy != null) errors.push(lossyFieldError("retryPolicy", key, "task.retryPolicy is not in Profile 1.0"));
  if (t.cancelPolicy != null) errors.push(lossyFieldError("cancelPolicy", key, "task.cancelPolicy is not in Profile 1.0"));

  if (task.type === "wait") {
    errors.push(lossyFieldError("type", key, 'task type "wait" is not in Profile 1.0'));
  }
  if (task.type === "approval") {
    if (t.solicitation != null) errors.push(lossyFieldError("approval.solicitation", key, "approval.solicitation is not in Profile 1.0"));
    if (t.deadlineIso8601 != null) errors.push(lossyFieldError("approval.deadlineIso8601", key, "approval.deadlineIso8601 is not in Profile 1.0"));
  }
  if (task.type === "manual" && typeof t.instructions === "string" && t.instructions.length > 0) {
    errors.push(lossyFieldError("manual.instructions", key, "manual.instructions is not in Profile 1.0"));
  }
  if (task.type === "notification" && Array.isArray(t.recipients) && t.recipients.length > 0) {
    errors.push(lossyFieldError("notification.recipients", key, "notification.recipients is not in Profile 1.0"));
  }

  // Recurse into foreach.template (single-level, but guard recursively).
  const foreach = t.foreach as { template?: TaskSpec } | undefined;
  if (foreach?.template) checkTaskLossiness(foreach.template, errors);
}

/**
 * Emit-side preflight: returns ok only if `spec` lives entirely within the
 * Profile 1.0 emittable subset. Used by BPMN-06 migration + any future export.
 */
export function validateWorkflowSpecAgainstBpmnProfile(spec: WorkflowSpec): WorkflowSpecProfileResult {
  const errors: BpmnUnsupportedWorkflowSpecFieldError[] = [];
  for (const task of spec.tasks) checkTaskLossiness(task, errors);
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}
