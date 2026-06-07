// @cinatra-ai/workflows/state — transition matrices, roll-up, gate model.

export {
  TASK_STATUSES,
  WORKFLOW_STATUSES,
  ATTEMPT_STATUSES,
  APPROVAL_STATUSES,
  TransitionError,
  canTransition,
  assertTransition,
  isTerminalTaskStatus,
  isTerminalWorkflowStatus,
  rollUpWorkflowStatus,
} from "./transitions";
export type {
  TaskStatus,
  WorkflowStatus,
  AttemptStatus,
  ApprovalStatus,
  TransitionKind,
  TaskRollupInput,
} from "./transitions";

export {
  GATE_KINDS,
  GATE_STATES,
  EFFECTIVE_GATE_STATES,
  deriveEffectiveGateState,
  isDispatchable,
} from "./gates";
export type { GateKind, GateState, GateEntry, EffectiveGateState, GateEvaluation } from "./gates";
