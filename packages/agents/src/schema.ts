import { sql } from "drizzle-orm";
import { pgSchema, text, integer, boolean, timestamp, index, uniqueIndex, primaryKey, jsonb } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Extension registry origin coordinates.
// Persisted as a single JSONB column on agent_templates and skill_packages.
// Do NOT add token/password
// fields here; those live in extension_destinations (drizzle-store.ts).
// ---------------------------------------------------------------------------
export type ExtensionOrigin = {
  packageName: string;
  version: string;
  /** null = public registry; opaque key into extension_destinations otherwise */
  destinationId: string | null;
  /** npm scope, e.g. "@cinatra" or "@vendorname" */
  scope: string;
  visibility: "public" | "private";
  /** Self-contained registry URL for install/update/migration */
  registryUrl: string;
  importedFrom?: {
    source: "github" | "zip" | "chat";
    url?: string;
    license?: string;
    licenseAcknowledged?: boolean;
    updatePolicy: "manual" | "auto";
    lastSyncedAt?: string;
  };
};

const cinatraSchema = pgSchema(process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra");

// ---------------------------------------------------------------------------
// agent_templates — the user-authored (and LLM-compiled) agent definition
// ---------------------------------------------------------------------------

export const agentTemplates = cinatraSchema.table("agent_templates", {
  id:             text("id").primaryKey(),
  orgId:          text("org_id"),
  // owner_level / owner_id carries the install target chosen by the user via
  // the scope picker. Nullable for rows that have not been backfilled yet.
  ownerLevel:     text("owner_level"),
  ownerId:        text("owner_id"),
  // first_run_at is set by an AFTER-INSERT trigger on agent_runs
  // (drizzle-store.ts migration block). Used by updateAgentTemplate to gate
  // ownership reassignment: once non-null, owner_level/owner_id are locked.
  // NULL on freshly-installed templates and any row inserted before backfill.
  firstRunAt:     timestamp("first_run_at", { withTimezone: true }),
  creatorId:      text("creator_id"),
  name:           text("name").notNull(),
  description:    text("description"),
  sourceNl:       text("source_nl").notNull(),      // natural-language input
  compiledPlan:   text("compiled_plan").notNull(),  // JSON string — array of CompiledStep
  inputSchema:    text("input_schema").notNull(),   // JSON string — zod-compatible parameter defs
  outputSchema:   text("output_schema"),            // JSON string (optional)
  approvalPolicy: text("approval_policy").notNull(),// JSON string — ApprovalPolicy
  status:         text("status").notNull().default("draft"), // draft | published | archived (agent-builder lifecycle)
  // Extension lifecycle state lives canonically in
  // `installed_extension` (read via readEffectiveStatusByPackageNames; written
  // via transitionExtensionByPackageName). The agent-builder `status` column
  // above is unrelated and stays.
  type:           text("type").notNull().default("leaf"), // leaf | proxy | orchestrator
  taskSpec:       text("task_spec"), // nullable; free-form task specification for LangGraph agents
  packageName:       text("package_name").notNull(), // stable package identity; NOT NULL because vendor/slug routing requires every template to declare an identity.
  packageVersion:    text("package_version"),    // semantic version string
  // Registry origin coordinates, stored as JSONB; null until backfilled.
  origin:            jsonb("origin").$type<ExtensionOrigin | null>(),
  currentVersionId:  text("current_version_id"), // pointer to the active version (null = latest)
  hitlScreens:       text("hitl_screens"),        // JSON string array of namespaced x-renderer IDs this template produces as HITL states
  agentDependencies: text("agent_dependencies"),  // JSON-stringified Record<string,string> of @cinatra/* dep ranges; nullable
  // JSON-stringified Record<string,string> of @cinatra-ai/<x>-connector
  // workspace dep ranges. Nullable; null = no connector dependencies declared on this template.
  // Persisted from `cinatra.connectorDependencies` in the published manifest.
  connectorDependencies: text("connector_dependencies"),
  ioSpec:            text("io_spec"),              // AgentIOSpec JSON; nullable
  hitlRequired:      boolean("hitl_required").notNull().default(false),                        // HITL gate flag
  executionProvider: text("execution_provider").notNull().default("wayflow"),                  // execution runtime provider
  // lg_graph_code: Python StateGraph module emitted by the compiler for
  // execution_provider='langgraph' templates. Nullable — only populated for LangGraph agents.
  // Deployed to LangGraph Server's graph registry on template save/publish.
  lgGraphCode:       text("lg_graph_code"),
  // lg_graph_id: stable identifier used to register/update the graph
  // with LangGraph Server (passed to client.runs.stream(thread_id, graph_id, ...)).
  // Nullable — only populated for execution_provider='langgraph' templates.
  lgGraphId:         text("lg_graph_id"),
  // sourceType: "internal" (Cinatra-built templates) or "external"
  // (A2A server templates dispatched via createExternalA2AClient).
  // NOT NULL DEFAULT 'internal' so all existing rows remain internal.
  sourceType:        text("source_type").notNull().default("internal"),
  // agentUrl: canonical base URL for external A2A servers.
  // Nullable — only populated for source_type='external' rows.
  agentUrl:          text("agent_url"),
  // connectorSlug: Nango connectionId for the saved A2A connector
  // that owns the external agent. Composite upsert key part 1.
  connectorSlug:     text("connector_slug"),
  // remoteAgentId: A2A skill id on the remote server. Composite
  // upsert key part 2 (stable across display-name changes + version bumps).
  remoteAgentId:     text("remote_agent_id"),
  // Trigger gate metadata. Populated by the OAS compiler.
  // triggerMode: "full" (statically analyzable runtime — gate per-step) | "start-only"
  //   (dynamic runtime — gate at run-start only). Nullable for templates compiled
  //   before trigger gates were available.
  triggerMode:       text("trigger_mode"),
  // JSON array of GatedStep objects extracted from approvalPolicy.steps
  // at compile time. Stored as TEXT (JSON-serialized) to match the existing pattern
  // used by other "JSON-as-text" columns in this table (compiledPlan, hitlScreens,
  // agentDependencies). Nullable; default null.
  gatedSteps:        text("gated_steps"),
  // agentAuthPolicy: template-level AgentAuthPolicy (JSON-as-text). Nullable;
  // null = use DEFAULT_AGENT_AUTH_POLICY. See packages/agent-builder/src/auth-policy.ts.
  agentAuthPolicy:   text("agent_auth_policy"),
  createdAt:         timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:         timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  createdAtIdx:   index("agent_templates_created_at_idx").on(t.createdAt),
  packageNameIdx: uniqueIndex("agent_templates_package_name_idx").on(t.packageName),
}));

// ---------------------------------------------------------------------------
// agent_versions — immutable snapshots published from a template
// ---------------------------------------------------------------------------

export const agentVersions = cinatraSchema.table("agent_versions", {
  id:            text("id").primaryKey(),
  templateId:    text("template_id").notNull(),
  versionNumber: integer("version_number").notNull().default(1),
  contentHash:   text("content_hash").notNull(),
  snapshot:      text("snapshot").notNull(), // full JSON of compiledPlan + toolBindings + approvalPolicy
  createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  templateIdIdx: index("agent_versions_template_id_idx").on(t.templateId),
}));

// ---------------------------------------------------------------------------
// agent_runs — individual executions of a template (draft or versioned)
// ---------------------------------------------------------------------------

export const agentRuns = cinatraSchema.table("agent_runs", {
  id:          text("id").primaryKey(),
  templateId:  text("template_id").notNull(),
  versionId:   text("version_id"),              // nullable — draft runs don't pin a version
  runBy:       text("run_by"),
  status:      text("status").notNull().default("queued"), // queued | running | completed | failed | pending_approval | pending_input
  inputParams: text("input_params").notNull(),  // JSON string
  stepResults: text("step_results"),            // JSON string — array of per-step outputs
  startedAt:   timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  error:       text("error"),
  title:       text("title"),                                                     // nullable; user-given run name
  createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sourceType:  text("source_type").notNull().default("agent_builder"),            // 'agent_builder' | 'scrape' | 'research' | 'enrichment'
  sourceId:    text("source_id"),                                                 // nullable; config record id for legacy agents
  packageVersion: text("package_version"),                                        // pinned at request time (A2A version pinning)
  // Dual-write bridge for A2A task/run mapping (partial unique index in drizzle-store.ts).
  a2aTaskId: text("a2a_task_id"),
  // A2A context ID for WayFlow resume. fasta2a assigns a contextId per
  // conversation; resume requires sending a new message into the SAME context so the
  // flow continues from the input-required checkpoint rather than starting fresh.
  // Migration: see src/lib/drizzle-store.ts a2a_context_id entry.
  a2aContextId: text("a2a_context_id"),
  // Self-referential link to orchestrator parent run. Nullable, no CASCADE:
  // children survive parent deletion.
  parentRunId: text("parent_run_id"),
  // Explicit AG-UI capability marker. Set to true for runs created with AG-UI
  // support. Null for legacy runs (no backfill). Used by AgenticRunPanel
  // to decide: SSE path (agUiEnabled=true) vs. legacy polling path (agUiEnabled=null|false).
  // DB migration: ALTER TABLE cinatra.agent_runs ADD COLUMN ag_ui_enabled boolean;
  agUiEnabled: boolean("ag_ui_enabled"),
  // LangGraph Server thread correlation. Nullable — only set for runs
  // dispatched to LangGraph Server (template.executionProvider === "langgraph").
  // Required for HITL resume: the worker reads this to call
  // client.runs.stream(thread_id, graph_id, { command: { resume: ... } }).
  // Migration: see src/lib/drizzle-store.ts lg_thread_id entry (ADD COLUMN IF NOT EXISTS).
  lgThreadId: text("lg_thread_id"),
  // OTel trace ID correlation. Nullable — set at run start by
  // agentic-execution.ts once a root span is started. Correlates this
  // run record with the full span tree in the cinatra.traces table.
  // Migration: see src/lib/drizzle-store.ts trace_id entry (ADD COLUMN IF NOT EXISTS).
  traceId: text("trace_id"),
  // Server-side timeout. When set, the execution worker self-terminates
  // the run with status 'failed' and error 'timed_out' if elapsed seconds exceed
  // this value. NULL = no timeout (default behavior preserved).
  // Migration: ALTER TABLE cinatra.agent_runs ADD COLUMN IF NOT EXISTS timeout_seconds integer;
  timeoutSeconds: integer("timeout_seconds"),
  // streamed_text: accumulated external A2A peer text output persisted
  // on clean RUN_FINISHED by startExternalSseProxyFromStream (see packages/a2a/src/
  // external-sse-proxy.ts). NULL for: (a) internal LangGraph runs (never emit
  // TEXT_MESSAGE_*), (b) external runs that timed out or errored. The Results tab
  // reads this via initialStreamedText to hydrate after page refresh.
  // Migration: see src/lib/drizzle-store.ts streamed_text entry (ADD COLUMN IF NOT EXISTS).
  streamedText: text("streamed_text"),
  // authPolicy: per-run override of the template's agentAuthPolicy (JSON-as-text).
  // Nullable; null = inherit from agent_templates.agentAuthPolicy (or DEFAULT_AGENT_AUTH_POLICY).
  authPolicy: text("auth_policy"),
  // Every run-creation entry point resolves an orgId from session, ALS frame,
  // or source-run row before insert.
  orgId: text("org_id").notNull(),
  // Nullable project refinement. The DDL is owned by src/lib/drizzle-store.ts.
  // Read/written by createAgentRun and the run-worker entry that wraps
  // execution in a ProjectContext frame.
  projectId: text("project_id"),
  // Idempotent agent_run start for release-workflow dispatch. All
  // nullable/additive (DDL in src/lib/drizzle-store.ts). A retried workflow
  // dispatch with the same idempotency_key resolves to the SAME child run.
  idempotencyKey: text("idempotency_key"),
  workflowId: text("workflow_id"),
  workflowTaskId: text("workflow_task_id"),
  // Delegated execution-actor snapshot. Captured at instantiate from the
  // requesting user's ActorContext and replayed at run-start re-authorization
  // plus mid-run authz checks. JSON text. NULL for legacy rows (callers fall
  // back to live-session derivation).
  // Migration: ALTER TABLE cinatra.agent_runs ADD COLUMN IF NOT EXISTS
  //   delegated_actor_snapshot text;
  delegatedActorSnapshot: text("delegated_actor_snapshot"),
}, (t) => ({
  templateIdIdx:    index("agent_runs_template_id_idx").on(t.templateId),
  statusIdx:        index("agent_runs_status_idx").on(t.status),
  sourceLookupIdx:  index("agent_runs_source_lookup_idx").on(t.sourceType, t.sourceId, t.createdAt),
  // Partial index — matches the inline migration in drizzle-store.ts
  // which creates this index with a `WHERE parent_run_id IS NOT NULL` predicate.
  // Aligning the Drizzle schema declaration prevents `drizzle-kit generate`
  // from diffing against the live DB and attempting to drop/recreate as a
  // full index.
  parentRunIdIdx:   index("agent_runs_parent_run_id_idx")
    .on(t.parentRunId)
    .where(sql`parent_run_id IS NOT NULL`),
  // Index name MUST match the SQL DDL in src/lib/drizzle-store.ts
  // (`agent_runs_org_id_idx`). Drift causes drizzle-kit introspection to drop
  // and recreate the index.
  orgIdIdx:         index("agent_runs_org_id_idx").on(t.orgId),
  // Partial project indexes (DDL in drizzle-store.ts).
  // Names mirror the SQL DDL so drizzle-kit introspection treats them as
  // congruent and does not drop/recreate.
  projectIdx:       index("agent_runs_project_idx")
    .on(t.projectId, t.createdAt)
    .where(sql`project_id IS NOT NULL`),
  projectStatusIdx: index("agent_runs_project_status_idx")
    .on(t.projectId, t.status, t.createdAt)
    .where(sql`project_id IS NOT NULL`),
  // Partial unique idempotency index; names mirror the SQL DDL.
  idempotencyKeyIdx: uniqueIndex("agent_runs_idempotency_key_uniq")
    .on(t.idempotencyKey)
    .where(sql`idempotency_key IS NOT NULL`),
  workflowIdIdx: index("agent_runs_workflow_id_idx")
    .on(t.workflowId)
    .where(sql`workflow_id IS NOT NULL`),
}));

// ---------------------------------------------------------------------------
// Note: planned_actions and review_tasks tables are no longer present.
// Synthetic IDs ("setup-{runId}", "lg-{runId}") replace DB rows.
// The audit_events table retains a reviewTaskId column (text, no FK) for
// historical audit rows; there is no FK constraint to enforce.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// audit_events — immutable log of human review decisions
// ---------------------------------------------------------------------------

export const auditEvents = cinatraSchema.table("audit_events", {
  id:           text("id").primaryKey(),
  reviewTaskId: text("review_task_id").notNull(),
  actorId:      text("actor_id").notNull(),
  eventType:    text("event_type").notNull(), // approved_all | rejected_all | approved_item | rejected_item | edited_item | regenerated_item | expired
  payload:      text("payload"),              // JSON or null
  createdAt:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  reviewTaskIdIdx: index("audit_events_review_task_id_idx").on(t.reviewTaskId),
}));

// ---------------------------------------------------------------------------
// agent_run_messages — per-run LLM conversation thread checkpoint
// ---------------------------------------------------------------------------
// Structured fields support tool-call replay after HITL pause/resume.
// role+content alone is insufficient for replay.
// ---------------------------------------------------------------------------

export const agentRunMessages = cinatraSchema.table("agent_run_messages", {
  id:          text("id").primaryKey(),
  runId:       text("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
  sequence:    integer("sequence").notNull(),
  role:        text("role").notNull(), // "user" | "assistant" | "tool" | "system"
  messageType: text("message_type").notNull().default("text"), // "text" | "tool_call" | "tool_result" | "final"
  toolCallId:  text("tool_call_id"),    // nullable — populated for tool_call + tool_result rows
  toolName:    text("tool_name"),       // nullable — populated for tool_call + tool_result rows
  content:     text("content").notNull().default(""), // legacy text content — kept for backward compat
  contentJson: text("content_json").notNull(),        // JSON-serialized structured message body (source of truth)
  createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  runIdSequenceIdx:  index("agent_run_messages_run_id_sequence_idx").on(t.runId, t.sequence),
  runIdSequenceUniq: uniqueIndex("agent_run_messages_run_id_sequence_uniq").on(t.runId, t.sequence),
  toolCallIdx:       index("agent_run_messages_tool_call_id_idx").on(t.toolCallId),
}));

// ---------------------------------------------------------------------------
// agent_run_hitl_prompts — captured WayFlow HITL amendment messages
// ---------------------------------------------------------------------------

export const agentRunHitlPrompts = cinatraSchema.table("agent_run_hitl_prompts", {
  id:         text("id").primaryKey(),
  runId:      text("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
  agentId:    text("agent_id").notNull(),   // template.packageName e.g. "@cinatra-ai/email-outreach-agent"
  stepKey:    text("step_key").notNull(),   // bare WayFlow task.id (no "wayflow-" prefix)
  message:    text("message").notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  excluded:   boolean("excluded").notNull().default(false),
  submittedValues: jsonb("submitted_values").$type<Record<string, unknown> | null>(),
  schemaSnapshot: jsonb("schema_snapshot").$type<Record<string, unknown> | null>(),
}, (t) => ({
  runIdAgentIdx: index("agent_run_hitl_prompts_run_id_agent_idx").on(t.runId, t.agentId),
}));

// ---------------------------------------------------------------------------
// agent_registry_entries — published registry entries for team sharing
// ---------------------------------------------------------------------------

export const agentRegistryEntries = cinatraSchema.table("agent_registry_entries", {
  id:               text("id").primaryKey(),
  templateId:       text("template_id").notNull(),
  versionId:        text("version_id").notNull(),
  orgId:            text("org_id").notNull(),
  publishedBy:      text("published_by").notNull(),
  semver:           text("semver").notNull(),
  title:            text("title").notNull(),
  description:      text("description"),
  toolAccess:       text("tool_access").notNull(),              // JSON array stored as text
  riskLevel:        text("risk_level").notNull(),               // low | medium | high | critical
  hasApprovalGates: boolean("has_approval_gates").notNull().default(false),
  changelog:        text("changelog"),
  status:           text("status").notNull().default("active"), // active | deprecated | yanked
  createdAt:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  orgIdIdx:      index("agent_registry_entries_org_id_idx").on(t.orgId),
  templateIdIdx: index("agent_registry_entries_template_id_idx").on(t.templateId),
}));

// ---------------------------------------------------------------------------
// agent_share_bindings — per-entry permission grants (user or org level)
// ---------------------------------------------------------------------------

export const agentShareBindings = cinatraSchema.table("agent_share_bindings", {
  id:              text("id").primaryKey(),
  registryEntryId: text("registry_entry_id").notNull(),
  subjectType:     text("subject_type").notNull(),              // user | org
  subjectId:       text("subject_id").notNull(),
  canView:         boolean("can_view").notNull().default(true),
  canRun:          boolean("can_run").notNull().default(false),
  canEditDraft:    boolean("can_edit_draft").notNull().default(false),
  canPublish:      boolean("can_publish").notNull().default(false),
  canApprove:      boolean("can_approve").notNull().default(false),
  grantedBy:       text("granted_by").notNull(),
  createdAt:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  registryEntryIdIdx: index("agent_share_bindings_registry_entry_id_idx").on(t.registryEntryId),
}));

// ---------------------------------------------------------------------------
// agent_forks — provenance tracking for forked registry entries
// ---------------------------------------------------------------------------

export const agentForks = cinatraSchema.table("agent_forks", {
  id:               text("id").primaryKey(),
  registryEntryId:  text("registry_entry_id").notNull(),
  forkedTemplateId: text("forked_template_id").notNull(),
  forkedBy:         text("forked_by").notNull(),
  createdAt:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  registryEntryIdIdx: index("agent_forks_registry_entry_id_idx").on(t.registryEntryId),
}));

// ---------------------------------------------------------------------------
// agent_template_versions — immutable per-save snapshots of a template
// ---------------------------------------------------------------------------

export const agentTemplateVersions = cinatraSchema.table("agent_template_versions", {
  id:            text("id").primaryKey(),
  templateId:    text("template_id").notNull(),
  versionNumber: integer("version_number").notNull(),
  semver:        text("semver").notNull(),
  bumpType:      text("bump_type").notNull(),
  changelogLine: text("changelog_line"),
  contentHash:   text("content_hash").notNull(),
  snapshot:      text("snapshot").notNull(),
  createdBy:     text("created_by"),
  createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  templateIdIdx:       index("agent_template_versions_template_id_idx").on(t.templateId, t.versionNumber),
  templateVersionUniq: uniqueIndex("agent_template_versions_template_version_uniq").on(t.templateId, t.versionNumber),
}));

// ---------------------------------------------------------------------------
// agent_run_triggers — per-run trigger gate (immediate / scheduled / recurring)
// ---------------------------------------------------------------------------
// One trigger per top-level run. Primary key IS the foreign key (one-to-one
// with agent_runs). The FK references agent_runs.id (NOT agent_run_instances —
// that table does not exist).
// ---------------------------------------------------------------------------

export const agentRunTriggers = cinatraSchema.table("agent_run_triggers", {
  runId:          text("run_id").primaryKey().references(() => agentRuns.id, { onDelete: "cascade" }),
  triggerType:    text("trigger_type").notNull().default("immediate"), // 'immediate' | 'scheduled' | 'recurring'
  scheduledAt:    timestamp("scheduled_at", { withTimezone: true }),
  cronExpression: text("cron_expression"),
  timezone:       text("timezone").notNull().default("UTC"),
  enabled:        boolean("enabled").notNull().default(true),
  releasedAt:     timestamp("released_at", { withTimezone: true }),
  jobSchedulerId: text("job_scheduler_id"),
  createdAt:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:      timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  releasedAtIdx: index("agent_run_triggers_released_at_idx").on(t.releasedAt),
}));

// ---------------------------------------------------------------------------
// agent_run_pm_links — schedule↔PM-task sync link table (cinatra#317).
// ---------------------------------------------------------------------------
// One row per schedule-DEFINING trigger that has been mirrored to an external
// project-management provider (Plane today). Keyed by run_id (one-to-one with
// the trigger, which is itself one-to-one with the top-level agent_run), so the
// PM mirror tracks the schedule definition, NOT the recurring child runs.
//
// Deliberately a LINK TABLE (issue #317 "prefer a link table over columns on
// agent_run_triggers"): a Plane outage / missing provider leaves the trigger
// untouched — the absence of a link row is the natural "not mirrored" state and
// the trigger lifecycle never blocks on PM. external_task_id is nullable so a
// failed first push still records the attempt (provider + sync_error) without a
// task id. sync_error holds the last fail-open error text (null = healthy).
// version is an optimistic-concurrency counter for the reconcile loop (#318).
//
// FK on run_id → agent_runs.id ON DELETE CASCADE: deleting a run tears down its
// trigger AND its PM link row together (the external task cleanup is the
// connector's job via deleteTriggerTask, invoked from the trigger lifecycle).
// ---------------------------------------------------------------------------

export const agentRunPmLinks = cinatraSchema.table("agent_run_pm_links", {
  runId:         text("run_id").primaryKey().references(() => agentRuns.id, { onDelete: "cascade" }),
  provider:      text("provider").notNull(), // PM provider id, e.g. 'plane'
  externalTaskId: text("external_task_id"),  // provider work-item id; null until first successful push
  syncedAt:      timestamp("synced_at", { withTimezone: true }), // last successful mirror; null until first success
  syncError:     text("sync_error"),         // last fail-open error text; null = healthy
  version:       integer("version").notNull().default(0), // optimistic-concurrency counter (reconcile #318)
  createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:     timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  providerIdx: index("agent_run_pm_links_provider_idx").on(t.provider),
}));

// ---------------------------------------------------------------------------
// run_co_owners — per-run sharing join table.
// Composite PK (run_id, user_id) is the natural uniqueness AND lookup index.
// FK on run_id with ON DELETE CASCADE ensures rows are removed when the
// underlying agent_run is deleted.
//
// Cross-schema FKs to Better Auth public."user"
// (run_co_owners_user_id_fkey, run_co_owners_granted_by_fkey) are added by
// the runtime migration in src/lib/drizzle-store.ts. The Drizzle schema
// here intentionally does NOT declare references() for those columns:
// importing the betterAuthUsers symbol from src/lib/better-auth-db.ts into
// this package crosses the cinatra-app -> agent-builder package boundary
// and trips the AGENTS.md "no cross-package internal imports" rule. The
// runtime migration is the source of truth for those constraints; the
// in-app drizzle layer treats user_id / granted_by as plain text.
// ---------------------------------------------------------------------------

export const runCoOwners = cinatraSchema.table("run_co_owners", {
  runId:     text("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
  userId:    text("user_id").notNull(),
  grantedBy: text("granted_by").notNull(),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk:        primaryKey({ columns: [t.runId, t.userId] }),
  userIdIdx: index("run_co_owners_user_id_idx").on(t.userId),
}));
