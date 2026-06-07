import { z } from "zod";
import {
  TASK_TYPES,
  DEPENDENCY_OUTCOMES,
  SCHEDULE_DIRECTIONS,
  SCHEDULE_ANCHOR_POINTS,
  OWNERSHIP_LEVELS,
  FAILURE_POLICIES,
  MISSED_WINDOW_POLICIES,
  REJECTION_POLICIES,
  PLACEHOLDER_TYPES,
} from "./types";

// Lenient ISO 8601 datetime — allows a trailing Z / numeric offset, or none
// (a bare local datetime resolved in the task/release tz). Deep tz semantics
// are handled by the schedule resolver, not the schema.
const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?$/;
// ISO 8601 duration (no fractional components; must have at least one field).
const ISO_DURATION_RE = /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/;
const LOCAL_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const TASK_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

export const isoDatetimeSchema = z
  .string()
  .regex(ISO_DATETIME_RE, "must be an ISO 8601 datetime");
export const isoDurationSchema = z
  .string()
  .regex(ISO_DURATION_RE, "must be an ISO 8601 duration (e.g. P7D, PT4H)");
const localTimeSchema = z.string().regex(LOCAL_TIME_RE, "must be HH:mm");
const tzSchema = z.string().min(1); // IANA tz name; validated at resolve time
const taskKeySchema = z.string().regex(TASK_KEY_RE, "invalid task key");

export const agentRefSchema = z.object({
  package: z.string().min(1),
  name: z.string().optional(),
  version: z.string().optional(),
  templateId: z.string().optional(),
});

export const approvalScopeSchema = z.object({
  level: z.enum(OWNERSHIP_LEVELS),
  id: z.string().optional(),
});

const assignmentSchema = z.object({
  level: z.enum(OWNERSHIP_LEVELS),
  id: z.string().min(1),
});

const dependencySchema = z.object({
  taskKey: z.string().min(1),
  outcome: z.enum(DEPENDENCY_OUTCOMES).optional(),
});

const absoluteScheduleSchema = z.object({
  mode: z.literal("absolute"),
  at: isoDatetimeSchema,
  tz: tzSchema.optional(),
  anchorPoint: z.enum(SCHEDULE_ANCHOR_POINTS).optional(),
  durationIso8601: isoDurationSchema.optional(),
});

const relativeScheduleSchema = z.object({
  mode: z.literal("relative"),
  anchor: z.string().min(1), // "release" or a task key
  offsetIso8601: isoDurationSchema,
  direction: z.enum(SCHEDULE_DIRECTIONS),
  localTime: localTimeSchema.optional(),
  tz: tzSchema.optional(),
  anchorPoint: z.enum(SCHEDULE_ANCHOR_POINTS).optional(),
  durationIso8601: isoDurationSchema.optional(),
});

export const scheduleSchema = z.discriminatedUnion("mode", [
  absoluteScheduleSchema,
  relativeScheduleSchema,
]);

const retryPolicySchema = z
  .object({
    strategy: z.enum(["fixed", "exponential"]).optional(),
    backoffSeconds: z.number().int().nonnegative().optional(),
  })
  .loose();

const commonTaskFields = {
  key: taskKeySchema,
  title: z.string().min(1),
  required: z.boolean().optional(),
  pinned: z.boolean().optional(),
  risk: z.string().optional(),
  // Hierarchy parent — the KEY of another task in this same workflow (a render
  // rollup + grouping concern). Keys are the spec's stable identity; the writer
  // resolves key→parent_task_id at the DB boundary. Cycle / self-parent /
  // unknown-key rejection lives in validate.ts.
  parent: taskKeySchema.optional(),
  schedule: scheduleSchema.optional(),
  dependsOn: z.array(dependencySchema).optional(),
  assignee: assignmentSchema.optional(),
  failurePolicy: z.enum(FAILURE_POLICIES).optional(),
  missedWindowPolicy: z.enum(MISSED_WINDOW_POLICIES).optional(),
  retryPolicy: retryPolicySchema.optional(),
  maxAttempts: z.number().int().positive().optional(),
  cancelPolicy: z.record(z.string(), z.unknown()).optional(),
};

// foreach declaration. Schema SHAPE parses recursively via
// z.lazy so taskSchema can be its own template, BUT validate.ts REJECTS any
// nested foreach (a foreach declared inside another foreach's template) with
// error code `foreach_nested_not_supported` — single-level fan-out only.
const foreachAsRe = /^[a-z][a-zA-Z0-9_]*$/;
export const FOREACH_ROLLUP_POLICIES = ["any_fails", "best_effort", "all_or_nothing"] as const;
export type ForeachRollupPolicy = (typeof FOREACH_ROLLUP_POLICIES)[number];
export const FOREACH_MAX_FANOUT_HARD_CEILING = 500 as const;
export const FOREACH_MAX_FANOUT_DEFAULT = 50 as const;

const foreachSchema: z.ZodType<unknown> = z.object({
  source: taskKeySchema,
  as: z.string().regex(foreachAsRe, "foreach.as must match /^[a-z][a-zA-Z0-9_]*$/"),
  itemKey: z.string().nullable().optional(),
  template: z.lazy(() => taskSchema),
  rollupPolicy: z.enum(FOREACH_ROLLUP_POLICIES).optional(),
  maxFanout: z
    .number()
    .int()
    .positive()
    .max(FOREACH_MAX_FANOUT_HARD_CEILING, `maxFanout must be ≤ ${FOREACH_MAX_FANOUT_HARD_CEILING}`)
    .optional(),
});

const agentTaskSchema = z.object({
  ...commonTaskFields,
  type: z.literal("agent_task"),
  agentRef: agentRefSchema,
  input: z.record(z.string(), z.unknown()).optional(),
  foreach: foreachSchema.optional(),
});
const approvalTaskSchema = z.object({
  ...commonTaskFields,
  type: z.literal("approval"),
  requiredScope: approvalScopeSchema,
  solicitation: scheduleSchema.optional(),
  deadlineIso8601: isoDatetimeSchema.optional(),
  rejectionPolicy: z.enum(REJECTION_POLICIES).optional(),
  foreach: foreachSchema.optional(),
});
const manualTaskSchema = z.object({
  ...commonTaskFields,
  type: z.literal("manual"),
  instructions: z.string().optional(),
  foreach: foreachSchema.optional(),
});
const notificationTaskSchema = z.object({
  ...commonTaskFields,
  type: z.literal("notification"),
  message: z.string().optional(),
  recipients: z.array(z.string()).optional(),
  foreach: foreachSchema.optional(),
});
const waitTaskSchema = z.object({ ...commonTaskFields, type: z.literal("wait"), foreach: foreachSchema.optional() });
const checkpointTaskSchema = z.object({ ...commonTaskFields, type: z.literal("checkpoint"), foreach: foreachSchema.optional() });

export const taskSchema = z.discriminatedUnion("type", [
  agentTaskSchema,
  approvalTaskSchema,
  manualTaskSchema,
  notificationTaskSchema,
  waitTaskSchema,
  checkpointTaskSchema,
]);

const placeholderDeclSchema = z.object({
  type: z.enum(PLACEHOLDER_TYPES),
  required: z.boolean().optional(),
  description: z.string().optional(),
  default: z.unknown().optional(),
});

const targetSchema = z.object({
  at: isoDatetimeSchema.optional(),
  tz: tzSchema,
});

export const workflowSpecSchema = z.object({
  key: z.string().optional(),
  name: z.string().min(1),
  product: z.string().optional(),
  target: targetSchema.optional(),
  placeholders: z.record(z.string(), placeholderDeclSchema).optional(),
  tasks: z.array(taskSchema),
  // Additive: loose extension metadata bag. Backwards-compatible — specs without
  // `metadata` continue to parse; unknown keys are not dropped here because the
  // field is explicit. The BPMN compiler populates
  // `metadata.placeholderHints[name] = { kind }` for typed launcher pickers. Kept
  // loose (`Record<string, unknown>`) so future Profile bumps need no schema change.
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// Zod-first: types are inferred so they never drift from the schema.
export type WorkflowSpec = z.infer<typeof workflowSpecSchema>;
export type TaskSpec = z.infer<typeof taskSchema>;
export type ScheduleSpec = z.infer<typeof scheduleSchema>;
export type RelativeSchedule = z.infer<typeof relativeScheduleSchema>;
export type AbsoluteSchedule = z.infer<typeof absoluteScheduleSchema>;
export type AgentRef = z.infer<typeof agentRefSchema>;
export type ApprovalScope = z.infer<typeof approvalScopeSchema>;
export type TaskDependency = z.infer<typeof dependencySchema>;
export type PlaceholderDecl = z.infer<typeof placeholderDeclSchema>;

export { TASK_TYPES };
