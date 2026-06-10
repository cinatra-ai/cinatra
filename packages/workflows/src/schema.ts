import { sql } from "drizzle-orm";
import {
  pgSchema,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// All release-workflows tables live in the configurable cinatra schema
// (SUPABASE_SCHEMA, default "cinatra"). The same scoping formula every other
// source package uses (packages/agents/src/schema.ts).
const cinatraSchema = pgSchema(process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra");

// ---------------------------------------------------------------------------
// workflow_template — versioned, immutable, scoped template DAG (relative
// schedules + typed placeholders). Snapshot-on-instantiate: a workflow
// records source_template_id+version but never hard-FKs it.
// ---------------------------------------------------------------------------
export const workflowTemplate = cinatraSchema.table(
  "workflow_template",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    // Relative-scheduled, placeholdered DAG (one shared spec shape).
    definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
    ownerLevel: text("owner_level"),
    ownerId: text("owner_id"),
    // Auth-derived tenant boundary. Templates are tenant-scoped.
    orgId: text("org_id").notNull(),
    projectId: text("project_id"),
    // Marketplace packaging: where this template came from + its installed
    // lifecycle/visibility.
    origin: jsonb("origin").$type<Record<string, unknown> | null>(),
    visibility: text("visibility"),
    // Source npm package for extension-installed templates. The reader facet
    // intersects this against the lifecycle-live manifest set so a template is
    // surfaced only while its package is still installed. Null for templates
    // created directly in-app (not from an extension).
    packageName: text("package_name"),
    // Workflow extension lifecycle status is canonical (installed_extension),
    // written by the dispatcher.
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Unique per (org, key, version) — each org owns its own template versions
    // (templates are tenant-scoped; org_id is NOT NULL).
    orgKeyVersionUniq: uniqueIndex("workflow_template_org_key_version_uniq").on(
      t.orgId,
      t.key,
      t.version,
    ),
    orgIdIdx: index("workflow_template_org_id_idx").on(t.orgId),
    packageNameIdx: index("workflow_template_package_name_idx").on(t.packageName),
  }),
);

// ---------------------------------------------------------------------------
// workflow — a mutable, versioned workflow instance (draft → active → terminal).
// Postgres is the single source of truth.
// ---------------------------------------------------------------------------
export const workflow = cinatraSchema.table(
  "workflow",
  {
    id: text("id").primaryKey(),
    // Snapshot provenance — plain text, no FK (immutability/independence).
    sourceTemplateId: text("source_template_id"),
    sourceTemplateVersion: integer("source_template_version"),
    name: text("name").notNull(),
    product: text("product"),
    targetAtUtc: timestamp("target_at_utc", { withTimezone: true }),
    targetTz: text("target_tz"),
    status: text("status").notNull().default("draft"),
    ownerLevel: text("owner_level"),
    ownerId: text("owner_id"),
    orgId: text("org_id").notNull(),
    projectId: text("project_id"),
    createdBy: text("created_by"),
    // Monotonic spec revision (snapshot/staleness). Distinct from lock_version.
    specVersion: integer("spec_version").notNull().default(1),
    // Workflow-level optimistic CAS (lifecycle + active-edit).
    lockVersion: integer("lock_version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgStatusIdx: index("workflow_org_id_status_idx").on(t.orgId, t.status),
    sourceTemplateIdx: index("workflow_source_template_idx").on(
      t.sourceTemplateId,
      t.sourceTemplateVersion,
    ),
    // Partial index for project-scope filtering.
    projectIdIdx: index("workflow_project_id_idx").on(t.projectId).where(sql`project_id IS NOT NULL`),
  }),
);

// ---------------------------------------------------------------------------
// workflow_task — a heterogeneous step (agent_task/approval/manual/notification/
// wait/checkpoint). Carries the Gantt timing model (planned/actual + anchor)
// and first-class failure/retry/cancel/missed-window policy.
// ---------------------------------------------------------------------------
export const workflowTask = cinatraSchema.table(
  "workflow_task",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflow.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    // Self-referencing hierarchy link: a child points at its parent task.
    // Nullable (top-level tasks have none). ON DELETE SET NULL is
    // orphan-safe — deleting a parent floats its children to top-level rather
    // than cascade-deleting them. Same-workflow parentage is enforced in the
    // spec writer (a plain self-FK can't constrain workflow_id without a
    // composite FK, which is incompatible with SET NULL here).
    parentTaskId: text("parent_task_id").references((): AnyPgColumn => workflowTask.id, {
      onDelete: "set null",
    }),
    assigneeLevel: text("assignee_level"),
    assigneeId: text("assignee_id"),
    // Denormalized convenience; agentRef is the dispatch source of truth.
    agentPackage: text("agent_package"),
    agentRef: jsonb("agent_ref").$type<Record<string, unknown> | null>(),
    input: jsonb("input").$type<Record<string, unknown> | null>(),
    schedule: jsonb("schedule").$type<Record<string, unknown> | null>(),
    anchor: jsonb("anchor").$type<Record<string, unknown> | null>(),
    plannedStartUtc: timestamp("planned_start_utc", { withTimezone: true }),
    plannedEndUtc: timestamp("planned_end_utc", { withTimezone: true }),
    actualStartUtc: timestamp("actual_start_utc", { withTimezone: true }),
    actualEndUtc: timestamp("actual_end_utc", { withTimezone: true }),
    dueAtUtc: timestamp("due_at_utc", { withTimezone: true }),
    status: text("status").notNull().default("idle"),
    required: boolean("required").notNull().default(true),
    failurePolicy: text("failure_policy"),
    missedWindowPolicy: text("missed_window_policy"),
    retryPolicy: jsonb("retry_policy").$type<Record<string, unknown> | null>(),
    maxAttempts: integer("max_attempts"),
    cancelPolicy: jsonb("cancel_policy").$type<Record<string, unknown> | null>(),
    runId: text("run_id"),
    pinned: boolean("pinned").notNull().default(false),
    risk: text("risk"),
    // foreach declaration for parent tasks; NULL for normal tasks
    // and for materialized children (nested foreach is rejected at validate-time).
    foreachConfig: jsonb("foreach_config").$type<Record<string, unknown> | null>(),
    // internal rollup state for foreach parents
    // (foreach_has_failure / foreach_has_success / foreach_materialization_error).
    // NOT exposed via MCP DTOs except a carve-out for the materialization-error sentinel
    // and the two rollup booleans (see mcp/handlers.ts toPublicTaskDto).
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    // Per-task optimistic CAS.
    lockVersion: integer("lock_version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workflowKeyUniq: uniqueIndex("workflow_task_workflow_id_key_uniq").on(t.workflowId, t.key),
    dueIdx: index("workflow_task_workflow_id_status_due_idx").on(
      t.workflowId,
      t.status,
      t.dueAtUtc,
    ),
    parentIdx: index("workflow_task_workflow_id_parent_idx").on(t.workflowId, t.parentTaskId),
  }),
);

// ---------------------------------------------------------------------------
// workflow_dependency — execution edges, separate from schedule.anchor.
// Per-edge outcome semantics (success/skipped/failed).
// ---------------------------------------------------------------------------
export const workflowDependency = cinatraSchema.table(
  "workflow_dependency",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflow.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => workflowTask.id, { onDelete: "cascade" }),
    dependsOnTaskId: text("depends_on_task_id")
      .notNull()
      .references(() => workflowTask.id, { onDelete: "cascade" }),
    outcome: text("outcome").notNull().default("success"),
  },
  (t) => ({
    edgeUniq: uniqueIndex("workflow_dependency_edge_uniq").on(t.taskId, t.dependsOnTaskId),
    dependsOnIdx: index("workflow_dependency_depends_on_idx").on(t.dependsOnTaskId),
  }),
);

// ---------------------------------------------------------------------------
// workflow_gate — per-task gate ledger (timing/dependency/approval), each
// evaluated independently, with explainability (reason/details/blocker refs).
// ---------------------------------------------------------------------------
export const workflowGate = cinatraSchema.table(
  "workflow_gate",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflow.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => workflowTask.id, { onDelete: "cascade" }),
    gateKind: text("gate_kind").notNull(),
    state: text("state").notNull(),
    reason: text("reason"),
    details: jsonb("details").$type<Record<string, unknown> | null>(),
    blockerRefs: jsonb("blocker_refs").$type<unknown[] | null>(),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }),
  },
  (t) => ({
    taskGateUniq: uniqueIndex("workflow_gate_task_id_kind_uniq").on(t.taskId, t.gateKind),
  }),
);

// ---------------------------------------------------------------------------
// workflow_event — append-only OPERATIONAL log (dispatch/transition), distinct
// from the governance audit trail. task_id is plain text (history survives task
// deletion); task_key kept for readable history.
// ---------------------------------------------------------------------------
export const workflowEvent = cinatraSchema.table(
  "workflow_event",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflow.id, { onDelete: "cascade" }),
    taskId: text("task_id"),
    taskKey: text("task_key"),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown> | null>(),
    actorId: text("actor_id"),
    actorLevel: text("actor_level"),
    source: text("source"),
    correlationId: text("correlation_id"),
    idempotencyKey: text("idempotency_key"),
    specVersion: integer("spec_version"),
    lockVersion: integer("lock_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workflowCreatedIdx: index("workflow_event_workflow_id_created_idx").on(
      t.workflowId,
      t.createdAt,
    ),
  }),
);

// ---------------------------------------------------------------------------
// workflow_task_attempt — at-least-once dispatch guard (unique idempotency key).
// Evidence table: task_id FK RESTRICTs deletion of a task that has attempts.
// ---------------------------------------------------------------------------
export const workflowTaskAttempt = cinatraSchema.table(
  "workflow_task_attempt",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflow.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => workflowTask.id, { onDelete: "restrict" }),
    attemptNo: integer("attempt_no").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull(),
    childRunId: text("child_run_id"),
    error: jsonb("error").$type<Record<string, unknown> | null>(),
    // captured agent-run output, persisted at
    // attempt-completion. Used by foreach materializer to read source-task
    // items. Null for non-agent attempts and for in-flight runs.
    output: jsonb("output").$type<Record<string, unknown> | null>(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idemUniq: uniqueIndex("workflow_task_attempt_idempotency_key_uniq").on(t.idempotencyKey),
    attemptNoUniq: uniqueIndex("workflow_task_attempt_task_attempt_no_uniq").on(
      t.workflowId,
      t.taskId,
      t.attemptNo,
    ),
    childRunIdx: index("workflow_task_attempt_child_run_idx").on(t.childRunId),
  }),
);

// ---------------------------------------------------------------------------
// workflow_dispatch_lease — durable dispatch lease: one live lease per task,
// held by the dispatcher that claimed the task. Acquired inside the claim tx,
// heartbeat-extended while the executor is in flight, released in the same tx
// that records the outcome. An EXPIRED lease on a running agent_task whose
// attempt has no child_run_id is the durable signal that the dispatcher
// crashed mid-dispatch (a slow in-flight dispatch keeps its lease alive via
// heartbeat) — the reconciler then takes the lease over and re-dispatches the
// SAME attempt under its original idempotency key. Transient operational
// state, NOT evidence — every FK CASCADEs.
// ---------------------------------------------------------------------------
export const workflowDispatchLease = cinatraSchema.table(
  "workflow_dispatch_lease",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflow.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => workflowTask.id, { onDelete: "cascade" }),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => workflowTaskAttempt.id, { onDelete: "cascade" }),
    // Per-process holder (diagnostics) + per-acquire ownership token. ALL
    // ownership checks (heartbeat, release, outcome settle) key on the token,
    // never the holder alone — two overlapping claims in one process must not
    // alias each other's lease.
    holderId: text("holder_id").notNull(),
    token: text("token").notNull(),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    // One live lease per task — the acquire path UPSERTs on this.
    taskUniq: uniqueIndex("workflow_dispatch_lease_task_id_uniq").on(t.taskId),
    workflowIdx: index("workflow_dispatch_lease_workflow_idx").on(t.workflowId),
  }),
);

// ---------------------------------------------------------------------------
// workflow_artifact — produced drafts linked to the producing task, versioned
// and pinned while referenced. Evidence table (task_id RESTRICT).
// ---------------------------------------------------------------------------
export const workflowArtifact = cinatraSchema.table(
  "workflow_artifact",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflow.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => workflowTask.id, { onDelete: "restrict" }),
    // For artifacts produced by an LLM-emitting agent_task, `kind` is the
    // artifact extension package name (e.g. `@cinatra-ai/blog-post-artifact`)
    // and `ref` is `'<artifactId>:<representationRevisionId>'`. Legacy rows
    // (e.g. `kind: "agent_run"`, `kind: "agent_output"`) retain their
    // free-form `ref` shape and are excluded from the partial unique index.
    kind: text("kind").notNull(),
    ref: text("ref").notNull(),
    version: integer("version").notNull().default(1),
    pinned: boolean("pinned").notNull().default(true),
    // Links the artifact back to the authoring ledger step that emitted it.
    // Nullable; legacy rows do not carry it. Populated by the host's
    // ChildRunStatus.producedArtifacts injection at agent_task settle.
    authoringStepId: text("authoring_step_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workflowTaskIdx: index("workflow_artifact_workflow_task_idx").on(t.workflowId, t.taskId),
    authoringStepIdx: index("workflow_artifact_authoring_step_idx").on(t.authoringStepId),
  }),
);

// ---------------------------------------------------------------------------
// workflow_approval — workflow-native, human-only approval. Own
// solicitation schedule + deadline; review-packet hash for staleness; resolved
// approvers for the inbox. Evidence table (task_id RESTRICT).
// ---------------------------------------------------------------------------
export const workflowApproval = cinatraSchema.table(
  "workflow_approval",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflow.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => workflowTask.id, { onDelete: "restrict" }),
    requiredScope: jsonb("required_scope").$type<Record<string, unknown>>().notNull(),
    resolvedApproverIds: jsonb("resolved_approver_ids").$type<string[] | null>(),
    solicitationSchedule: jsonb("solicitation_schedule").$type<Record<string, unknown> | null>(),
    deadlineUtc: timestamp("deadline_utc", { withTimezone: true }),
    reviewPacketHash: text("review_packet_hash"),
    status: text("status").notNull().default("pending"),
    rejectionPolicy: text("rejection_policy"),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    notificationState: jsonb("notification_state").$type<Record<string, unknown> | null>(),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusDeadlineIdx: index("workflow_approval_status_deadline_idx").on(t.status, t.deadlineUtc),
    approverGinIdx: index("workflow_approval_resolved_approvers_gin")
      .using("gin", t.resolvedApproverIds),
  }),
);

export const releaseWorkflowsSchemaTables = {
  workflowTemplate,
  workflow,
  workflowTask,
  workflowDependency,
  workflowGate,
  workflowEvent,
  workflowTaskAttempt,
  workflowDispatchLease,
  workflowArtifact,
  workflowApproval,
};
