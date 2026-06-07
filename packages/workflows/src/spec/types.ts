// Domain constants for the release-workflow spec. Pure (no Zod import) so the
// Zod schema module can import these without a cycle.

export const TASK_TYPES = [
  "agent_task",
  "approval",
  "manual",
  "notification",
  "wait",
  "checkpoint",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const DEPENDENCY_OUTCOMES = ["success", "skipped", "failed"] as const;
export type DependencyOutcome = (typeof DEPENDENCY_OUTCOMES)[number];

export const SCHEDULE_MODES = ["absolute", "relative"] as const;
export type ScheduleMode = (typeof SCHEDULE_MODES)[number];

export const SCHEDULE_DIRECTIONS = ["before", "after"] as const;
export type ScheduleDirection = (typeof SCHEDULE_DIRECTIONS)[number];

// Which point on a task's bar the schedule resolves to. The other bound is
// derived from `durationIso8601` (defaults to a zero-length milestone at `due`).
export const SCHEDULE_ANCHOR_POINTS = ["start", "end", "due"] as const;
export type ScheduleAnchorPoint = (typeof SCHEDULE_ANCHOR_POINTS)[number];

export const OWNERSHIP_LEVELS = ["user", "team", "organization", "workspace"] as const;
export type OwnershipLevel = (typeof OWNERSHIP_LEVELS)[number];

export const FAILURE_POLICIES = ["block", "skip"] as const;
export type FailurePolicy = (typeof FAILURE_POLICIES)[number];

export const MISSED_WINDOW_POLICIES = ["require_manual_decision", "fire_asap"] as const;
export type MissedWindowPolicy = (typeof MISSED_WINDOW_POLICIES)[number];

export const REJECTION_POLICIES = ["needs_revision", "cancel", "skip"] as const;
export type RejectionPolicy = (typeof REJECTION_POLICIES)[number];

export const PLACEHOLDER_TYPES = ["string", "number", "date", "boolean"] as const;
export type PlaceholderType = (typeof PLACEHOLDER_TYPES)[number];

// The special schedule anchor that resolves to the workflow's release date.
export const TARGET_ANCHOR = "target" as const;

// `{{name}}` placeholder token used in template-mode string values.
export const PLACEHOLDER_TOKEN_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

// Validation tiers (each strictly stronger than the previous).
export const VALIDATION_TIERS = ["template", "draft", "start"] as const;
export type ValidationTier = (typeof VALIDATION_TIERS)[number];
