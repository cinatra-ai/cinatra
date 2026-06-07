// @cinatra-ai/workflows/spec — the shared template/draft/instance spec.

export {
  TASK_TYPES,
  DEPENDENCY_OUTCOMES,
  SCHEDULE_MODES,
  SCHEDULE_DIRECTIONS,
  SCHEDULE_ANCHOR_POINTS,
  OWNERSHIP_LEVELS,
  FAILURE_POLICIES,
  MISSED_WINDOW_POLICIES,
  REJECTION_POLICIES,
  PLACEHOLDER_TYPES,
  TARGET_ANCHOR,
  PLACEHOLDER_TOKEN_RE,
  VALIDATION_TIERS,
} from "./types";
export type {
  TaskType,
  DependencyOutcome,
  ScheduleMode,
  ScheduleDirection,
  ScheduleAnchorPoint,
  OwnershipLevel,
  FailurePolicy,
  MissedWindowPolicy,
  RejectionPolicy,
  PlaceholderType,
  ValidationTier,
} from "./types";

export {
  workflowSpecSchema,
  taskSchema,
  scheduleSchema,
  agentRefSchema,
  approvalScopeSchema,
  isoDatetimeSchema,
  isoDurationSchema,
} from "./schema";
export type {
  WorkflowSpec,
  TaskSpec,
  ScheduleSpec,
  RelativeSchedule,
  AbsoluteSchedule,
  AgentRef,
  ApprovalScope,
  TaskDependency,
  PlaceholderDecl,
} from "./schema";

export {
  SPEC_LIMITS,
  checkLimits,
  iso8601DurationToApproxDays,
  jsonDepth,
} from "./limits";
export type { StructuredSpecError } from "./limits";

export { validateTemplate, validateDraft, validateStart } from "./validate";
export type { ValidationResult, StartContext } from "./validate";
