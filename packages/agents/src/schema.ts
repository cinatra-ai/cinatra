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

// Per-connector dependency value carried on the agent_templates.connector_dependencies
// column (JSON-as-text). Widened from a bare `Record<pkg, rangeString>` so a
// projected canonical connector edge carries its `requirement` alongside the
// range. The column stays a UNION for backward compatibility: legacy rows (and
// the legacy `cinatra.connectorDependencies` publish path, which writes bare
// strings) remain valid `string` members, read as `requirement: "required"`.
export type ConnectorDepRequirement = "required" | "optional";
export type ConnectorDepValue = { range: string; requirement: ConnectorDepRequirement };
export type ConnectorDependencyMap = Record<string, string | ConnectorDepValue>;

// Per-sub-agent dependency value carried on the agent_templates.agent_dependencies
// column (JSON-as-text). Widened from a bare `Record<pkg, rangeString>` (cinatra#1058)
// so a projected canonical AGENT edge carries its `requirement` alongside the range —
// the orchestrator-readiness gate needs it to route a missing OPTIONAL sub-agent to
// stop-run-hitl instead of hard-failing the run. The column stays a UNION for backward
// compatibility: legacy rows and REQUIRED edges remain bare `string` members, read as
// `requirement: "required"`; only OPTIONAL edges are persisted as `{ range, requirement }`.
export type AgentDepRequirement = "required" | "optional";
export type AgentDepValue = { range: string; requirement: AgentDepRequirement };
export type AgentDependencyMap = Record<string, string | AgentDepValue>;

/**
 * Flatten an {@link AgentDependencyMap} to bare `package → range` strings — the
 * shape the published packument's `cinatra.agentDependencies` and the A2A agent
 * card carry. Only the RUN-TIME orchestrator-readiness gate needs the union's
 * `requirement`; every EXPORT boundary flattens so the packument / resolver /
 * agent-card contract stays a plain range map (the `requirement` is carried by
 * canonical `cinatra.dependencies`, not this legacy field). (cinatra#1058)
 */
export function flattenAgentDependencyRanges(
  map: AgentDependencyMap,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(map).map(([k, v]) => [k, typeof v === "string" ? v : v.range]),
  );
}

/**
 * Build the published packument's legacy `agentDependencies` field from a
 * template record's stored deps — the null-tolerant flatten used at the
 * registry-publish boundary. An OPTIONAL edge's requirement rides canonical
 * `cinatra.dependencies`, not this legacy range map. Returns undefined when the
 * record has no deps. (cinatra#1058)
 */
export function buildPublishAgentDependencies(
  map: AgentDependencyMap | null | undefined,
): Record<string, string> | undefined {
  return map ? flattenAgentDependencyRanges(map) : undefined;
}

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
  // Interaction axis (cinatra#1037 P1) — ORTHOGONAL to `type`. 'assistant' = a
  // conversational identity; 'executor' = a bounded task agent (default). The
  // physical column + CHECK invariants were added transformationally by
  // core__0019 (see src/lib/drizzle-store.ts); this ORM declaration is the READ
  // wiring so `$inferSelect` / deserializeTemplate can surface the kind. `.default`
  // keeps it optional on insert (writers omit it → DB default 'executor').
  agentKind:      text("agent_kind").notNull().default("executor"), // assistant | executor
  // Typed assistant sidecar (persona, skillBundle, allowedTools/Agents, modelPrefs, mcp policy) as
  // JSON-as-text. NULL for executor rows; NOT NULL for assistant rows (DB CHECK
  // agent_templates_agent_kind_config_check). Shape + write-time twin in src/lib/assistant-config.ts;
  // physical column added transformationally by core__0019. READ wiring only (writers use raw SQL /
  // normalizeAgentKindConfig; the ORM insert path never sets it). `.default(null)` keeps it optional on insert.
  assistantConfig: text("assistant_config"),
  // 1:1 template<->principal link (#1037 P1.3): the bare text id of the Better Auth
  // public."user" assistant principal a conversational (agent_kind='assistant') template is
  // registered AS. NULL for executor rows. No cross-schema FK (app owns integrity, like
  // assistant_threads.assistant_user_id). Physical column + partial unique index added by core__0054.
  assistantUserId: text("assistant_user_id"),
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
  // lifecycleConfig: the agent-manifest LIFECYCLE declarations (cinatra#2038,
  // epic #2037 S0) compiled onto the template trigger-style (like trigger_mode /
  // gated_steps): requestedSkips / producedTypes / repairCapable as JSON-as-text.
  // Nullable; null = the agent declares no lifecycle refinements. Physical column
  // added additively (ADD COLUMN IF NOT EXISTS) by artifact-review-gate-schema.ts + core__0079.
  lifecycleConfig:   text("lifecycle_config"),
  // agentAuthPolicy: template-level AgentAuthPolicy (JSON-as-text). Nullable;
  // null = use DEFAULT_AGENT_AUTH_POLICY. See packages/agent-builder/src/auth-policy.ts.
  agentAuthPolicy:   text("agent_auth_policy"),
  createdAt:         timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:         timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  createdAtIdx:   index("agent_templates_created_at_idx").on(t.createdAt),
  packageNameIdx: uniqueIndex("agent_templates_package_name_idx").on(t.packageName),
  // Partial UNIQUE index — mirrors the SQL DDL in src/lib/drizzle-store.ts +
  // migration core__0054 (`agent_templates_assistant_user_id_uniq` WHERE
  // assistant_user_id IS NOT NULL): the 1:1 template<->principal link (#1037 P1.3).
  // Name + predicate MUST match the DDL so drizzle-kit introspection treats them as
  // congruent and does not drop/recreate. Executor rows (NULL) are excluded.
  assistantUserIdIdx: uniqueIndex("agent_templates_assistant_user_id_uniq")
    .on(t.assistantUserId)
    .where(sql`assistant_user_id IS NOT NULL`),
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
  // cinatra#1937 (archive S1): per-dispatch execution bookkeeping, written
  // ATOMICALLY with every queued→running status CAS (store.ts). The deadline
  // is DB-clock (`now() + COALESCE(timeout_seconds, 24h-max)`); the attempt id
  // is minted fresh per dispatch — re-dispatches of the same run get a new
  // one. The archive program's lease math (S4) binds to these; until then
  // they are persisted bookkeeping (the 24h A2A transport abort structurally
  // bounds every dispatch at the default horizon).
  // Migration: see src/lib/drizzle-store.ts (ADD COLUMN IF NOT EXISTS pair).
  executionDeadlineAt: timestamp("execution_deadline_at", { withTimezone: true }),
  executionAttemptId:  text("execution_attempt_id"),
  // cinatra#1938 (archive S2): the DURABLE "paused inside a live attempt"
  // marker for the ONE ambiguous wait state, pending_approval (entered both
  // mid-attempt via running→ and pre-dispatch via queued→ setup interrupts).
  // Edge-derived inside the status CAS — no caller flag: running→
  // pending_approval copies the row's own execution_attempt_id in-SQL;
  // queued→pending_approval and every dispatch clear it. Archive leases /
  // run authority treat pending_approval as in-flight ONLY while this equals
  // the current execution_attempt_id (stale or cleared ⇒ parked,
  // fail-closed). pending_input needs no marker: every edge into it is
  // pre-dispatch, including the #1058 human wait (fires from queued).
  // Migration: see src/lib/drizzle-store.ts (ADD COLUMN IF NOT EXISTS).
  humanWaitAttemptId: text("human_wait_attempt_id"),
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
  // Idempotent child-run dispatch. Nullable/additive (DDL in
  // src/lib/drizzle-store.ts). A retried dispatch with the same
  // idempotency_key resolves to the SAME child run.
  idempotencyKey: text("idempotency_key"),
  // Delegated execution-actor snapshot. Captured at instantiate from the
  // requesting user's ActorContext and replayed at run-start re-authorization
  // plus mid-run authz checks. JSON text. NULL for legacy rows (callers fall
  // back to live-session derivation).
  // Migration: ALTER TABLE cinatra.agent_runs ADD COLUMN IF NOT EXISTS
  //   delegated_actor_snapshot text;
  delegatedActorSnapshot: text("delegated_actor_snapshot"),
  // Persisted agent-run OBO scope-ceiling chain (JSON-as-text). Derived at run
  // creation from the LOCKED template owner anchor + org + project launch, and
  // re-derived + containment-checked at MCP-token mint. NULL only for a corrupt
  // anchor (fails closed at mint) or a pre-backfill row. The DDL + backfill are
  // owned by src/lib/drizzle-store.ts.
  oboCeiling: text("obo_ceiling"),
  // run_token_hash: sha256-hex of the dispatch-minted per-run credential
  // (#1193 run-token spine). WRITE-ONLY at the store layer — deserializeRun
  // never surfaces it onto AgentRunRecord, and every run-creation path uses an
  // explicit column whitelist, so a resumed/cloned/child run never inherits a
  // parent's hash. Set only by the dispatcher (setAgentRunTokenHash) before the
  // blocking sendTask. Unique per run via the partial index below.
  // Migration: see src/lib/drizzle-store.ts run_token_hash entry + core__0020
  //   (ALTER TABLE cinatra.agent_runs ADD COLUMN IF NOT EXISTS run_token_hash text).
  runTokenHash: text("run_token_hash"),
  // dependent_install_id: the installed_extension row id a run executes AS
  // (cinatra#1392 Gap 2). Threaded onto the signed run lineage (ActorContext)
  // so the A2A dispatch seam resolves edge-bound serving against a TRUSTED
  // dependent identity. SERVER-ONLY: written only from the trusted dispatch
  // identity via an explicit column whitelist (never client input). Unlike
  // runTokenHash it IS surfaced by deserializeRun — buildActorContextFromRun
  // reads run.dependentInstallId to carry it onto the ActorContext.
  // Migration: src/lib/drizzle-store.ts dependent_install_id entry + core__0030.
  dependentInstallId: text("dependent_install_id"),
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
  // Partial UNIQUE index — mirrors the SQL DDL in src/lib/drizzle-store.ts
  // (`agent_runs_run_token_hash_uniq` WHERE run_token_hash IS NOT NULL). One
  // run per credential; a new all-NULL column cannot collide on existing rows.
  // Name MUST match the DDL so drizzle-kit introspection treats them as
  // congruent and does not drop/recreate.
  runTokenHashIdx: uniqueIndex("agent_runs_run_token_hash_uniq")
    .on(t.runTokenHash)
    .where(sql`run_token_hash IS NOT NULL`),
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
// auditor_proposal_snapshots — immutable, one-per-run snapshot of the audit
// run's generated review material (cinatra#1625).
//
// /api/auditor/run-skills (phase:run) generates the personal-skill `preview`
// (name/description/content) + the per-item SuggestionPatch[] from the audit
// material (the agent's own skills + matched skills + HITL-selected skills +
// the artifact + the user's applied changes) and writes EXACTLY ONE row here
// keyed by agent_run_id (UNIQUE). /api/auditor/apply replay-validates
// acceptedPatchIds ⊆ this row's patch_ids — the authoritative surfaced set,
// NOT a union of retry rows. Replaces the legacy audit_events
// "auditor_suggestions_emitted" path (which also failed to insert on a
// fresh-bootstrap DB whose audit_events table carries only the structured
// authz shape). Immutable: an idempotent retry that computes the same
// input_data_digest is a no-op returning the stored preview; a DIFFERENT
// digest for an existing run fails closed (never silently overwrites the
// snapshot a receipt may already be bound to).
// ---------------------------------------------------------------------------

export const auditorProposalSnapshots = cinatraSchema.table("auditor_proposal_snapshots", {
  id:              text("id").primaryKey(),
  agentRunId:      text("agent_run_id").notNull(),
  // The generated review payload the renderer consumes:
  // { id?, name, description, content, basedOnSkillIds?, patches: [{id,fieldPath,op,message}] }.
  preview:         jsonb("preview").notNull(),
  // The full authoritative SuggestionPatch[] (id, fieldPath, op, value, message)
  // apply sources patch CONTENT from — never the request body.
  patches:         jsonb("patches").notNull(),
  // Denormalized stable-id list for O(1) subset validation.
  patchIds:        jsonb("patch_ids").notNull(),
  // Digest of the audited input data — makes the write idempotent on retry and
  // fail-closed when the same run is re-run against different data.
  inputDataDigest: text("input_data_digest").notNull(),
  // Hash binding preview+patches+patchIds — the approval receipt is minted
  // against this hash so a re-generated snapshot cannot be approved by a stale
  // receipt.
  snapshotHash:    text("snapshot_hash").notNull(),
  // The host-derived "edited" | "clean" signal recorded for auditability.
  edited:          text("edited").notNull().default("clean"),
  createdAt:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  agentRunIdUniq: uniqueIndex("auditor_proposal_snapshots_agent_run_id_uniq").on(t.agentRunId),
}));

// ---------------------------------------------------------------------------
// auditor_approval_receipts — single-use Separation-of-Duties receipts
// (cinatra#1625).
//
// approveReviewTask (admin-gated, with the SoD self-approval guard) mints ONE
// receipt bound to (agent_run_id, snapshot_hash, reviewer_id) — conditionally,
// only when a pending auditor snapshot exists for the resolved run.
// /api/auditor/apply CONSUMES the receipt with a single-shot CAS
// (consumed_at IS NULL → now()); a second apply (or a forged resume replay)
// finds no live receipt and is rejected 403. The partial-unique index enforces
// at most one LIVE (unconsumed) receipt per run.
// ---------------------------------------------------------------------------

export const auditorApprovalReceipts = cinatraSchema.table("auditor_approval_receipts", {
  id:                text("id").primaryKey(),
  agentRunId:        text("agent_run_id").notNull(),
  snapshotHash:      text("snapshot_hash").notNull(),
  reviewerId:        text("reviewer_id").notNull(),
  acceptedPatchIds:  jsonb("accepted_patch_ids"),
  dismissedPatchIds: jsonb("dismissed_patch_ids"),
  consumedAt:        timestamp("consumed_at", { withTimezone: true }),
  createdAt:         timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // One LIVE receipt per run (a consumed receipt frees the slot; the CAS below
  // guarantees single consumption).
  liveReceiptUniq: uniqueIndex("auditor_approval_receipts_live_uniq")
    .on(t.agentRunId)
    .where(sql`consumed_at IS NULL`),
  runIdIdx: index("auditor_approval_receipts_run_id_idx").on(t.agentRunId),
}));

// ---------------------------------------------------------------------------
// Generic artifact-REVIEW GATE store (cinatra#1796, epic #1620 S13) — the
// persistence backing the #1795/#1807 generic artifact-review surface: the
// emitting gate PINS immutable `{artifactId, representationRevisionId}` targets
// and a terminal decision CAS-resolves the gate, transactionally with the audit
// rows, the reject→tombstone disposition record, and the exactly-once-persisted
// resume intent (at-least-once delivery). Mirrors core__0072 + the bootstrap leaf
// src/lib/artifacts/artifact-review-gate-schema.ts.
//
// No FK to agent_runs ON PURPOSE (auditor-review-companion precedent): the gate
// is keyed by run id (validated at write time by the emitting gate's run-access
// guard) and must outlive run-row churn. The child tables FK to the gate.
// ---------------------------------------------------------------------------

/** A frozen review target as pinned in `pinned_targets` — no renderer identity. */
export type PinnedReviewTargetRow = {
  artifactId: string;
  representationRevisionId: string;
};

export const artifactReviewGates = cinatraSchema.table("artifact_review_gates", {
  id:            text("id").primaryKey(),
  runId:         text("run_id").notNull(),
  orgId:         text("org_id").notNull(),
  reviewTaskId:  text("review_task_id").notNull(),
  // 'pending' (emitted, frozen target set) | 'resolved' (terminal decision).
  status:        text("status").notNull().default("pending"),
  // The frozen [{artifactId, representationRevisionId}] set (resolved once at
  // gate creation) — the pinned-membership witness the prep + decision cores
  // check caller targets against.
  pinnedTargets: jsonb("pinned_targets").notNull(),
  // Terminal disposition + idempotency fingerprint, stamped ONLY on resolve.
  disposition:   text("disposition"),
  fingerprint:   text("fingerprint"),
  resolvedBy:    text("resolved_by"),
  resolvedAt:    timestamp("resolved_at", { withTimezone: true }),
  createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Gate-store extensions (cinatra#2038, epic #2037 S0). expiresAt: optional TTL
  // for the gate. reopenCount: lineage attempt counter (bounded reopen cycles).
  // Added additively by artifact-review-gate-schema.ts + core__0079.
  expiresAt:     timestamp("expires_at", { withTimezone: true }),
  reopenCount:   integer("reopen_count").notNull().default(0),
}, (t) => ({
  // One gate per (run, task) — makes emit idempotent + is the pending anchor.
  runTaskUniq: uniqueIndex("artifact_review_gates_run_task_uniq").on(t.runId, t.reviewTaskId),
  orgIdx:      index("artifact_review_gates_org_idx").on(t.orgId),
}));

export const artifactReviewAudit = cinatraSchema.table("artifact_review_audit", {
  id:                       text("id").primaryKey(),
  gateId:                   text("gate_id").notNull().references(() => artifactReviewGates.id, { onDelete: "cascade" }),
  runId:                    text("run_id").notNull(),
  reviewTaskId:             text("review_task_id").notNull(),
  // The decision fingerprint the audit row belongs to — makes the insert
  // idempotent under a response-lost retry (same decision → no duplicate rows).
  decisionFingerprint:      text("decision_fingerprint").notNull(),
  artifactId:               text("artifact_id").notNull(),
  representationRevisionId: text("representation_revision_id").notNull(),
  disposition:              text("disposition").notNull(),
  // HOST-derived renderer provenance (re-resolved from the artifact TYPE at
  // submit; never a client claim). digest only for a runtime (dynamic) load.
  rendererKind:             text("renderer_kind").notNull(),
  rendererPackage:          text("renderer_package"),
  rendererDigest:           text("renderer_digest"),
  createdAt:                timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  rowUniq: uniqueIndex("artifact_review_audit_row_uniq")
    .on(t.gateId, t.decisionFingerprint, t.artifactId, t.representationRevisionId),
  gateIdx: index("artifact_review_audit_gate_idx").on(t.gateId),
}));

export const artifactReviewDispositions = cinatraSchema.table("artifact_review_dispositions", {
  id:                       text("id").primaryKey(),
  gateId:                   text("gate_id").notNull().references(() => artifactReviewGates.id, { onDelete: "cascade" }),
  orgId:                    text("org_id").notNull(),
  runId:                    text("run_id").notNull(),
  artifactId:               text("artifact_id").notNull(),
  representationRevisionId: text("representation_revision_id").notNull(),
  // The op union admits ONLY 'tombstone' — a review can never hard-delete.
  kind:                     text("kind").notNull(),
  // NULL ⇒ pending downstream tombstone application on the objects store.
  appliedAt:                timestamp("applied_at", { withTimezone: true }),
  createdAt:                timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  rowUniq:     uniqueIndex("artifact_review_dispositions_uniq")
    .on(t.gateId, t.artifactId, t.representationRevisionId),
  pendingIdx:  index("artifact_review_dispositions_pending_idx")
    .on(t.createdAt)
    .where(sql`applied_at IS NULL`),
}));

export const artifactReviewResumeOutbox = cinatraSchema.table("artifact_review_resume_outbox", {
  // PK gate_id ⇒ at most ONE resume per resolved gate (exactly-once; no
  // resolved-but-unresumed stranding and no double-resume).
  gateId:         text("gate_id").primaryKey().references(() => artifactReviewGates.id, { onDelete: "cascade" }),
  runId:          text("run_id").notNull(),
  reviewTaskId:   text("review_task_id").notNull(),
  // Discriminated so a reject can never drain down the approve wire.
  kind:           text("kind").notNull(),
  responseText:   text("response_text").notNull(),
  status:         text("status").notNull().default("pending"),
  attempts:       integer("attempts").notNull().default(0),
  leaseToken:     text("lease_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  createdAt:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:      timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // Gate-store extensions (cinatra#2038, epic #2037 S0). maxAttempts: the resume
  // delivery cap; deadLetteredAt: the DEAD-LETTER state marker (NULL = live;
  // non-null = exhausted its attempts, ops-surfaced); lastError: the last delivery
  // error (ops). Added additively by artifact-review-gate-schema.ts + core__0079.
  maxAttempts:    integer("max_attempts").notNull().default(20),
  deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
  lastError:      text("last_error"),
}, (t) => ({
  statusIdx: index("artifact_review_resume_outbox_status_idx").on(t.status, t.createdAt),
  deadIdx:   index("artifact_review_resume_outbox_dead_idx").on(t.deadLetteredAt).where(sql`dead_lettered_at IS NOT NULL`),
}));

// ---------------------------------------------------------------------------
// lifecycle-interceptions S0 (cinatra#2038, epic #2037) — the FOUNDATION tables
// every later slice (S1–S7b) builds against. DDL twin: the
// lifecycleInterceptionsSchemaQueries function in
// src/lib/artifacts/artifact-review-gate-schema.ts + migration core__0079.
// ---------------------------------------------------------------------------

/** The org-scoped policy LATTICE bounds. A row is a `required`/`forbidden` bound
 * per (checkpoint, artifact type, destination class, origin kind); the ABSENCE of
 * a row is `silent` (unconstrained) and is never stored. */
export const lifecyclePolicyRules = cinatraSchema.table("lifecycle_policy_rules", {
  id:                text("id").primaryKey(),
  orgId:             text("org_id").notNull(),
  checkpoint:        text("checkpoint").notNull(),        // recommendation | review | verification
  artifactType:      text("artifact_type").notNull(),
  destinationClass:  text("destination_class").notNull(), // none | external_publish | visibility_promotion | pipeline_handoff
  originKind:        text("origin_kind").notNull(),       // agent_produced | user_provided | intermediate
  bound:             text("bound").notNull(),             // required | forbidden
  selfApprovalOptIn: boolean("self_approval_opt_in").notNull().default(false),
  createdAt:         timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:         timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  keyUniq: uniqueIndex("lifecycle_policy_rules_key_uniq")
    .on(t.orgId, t.checkpoint, t.artifactType, t.destinationClass, t.originKind),
  orgIdx:  index("lifecycle_policy_rules_org_idx").on(t.orgId),
}));

/** The transactional ArtifactProduced outbox. `eventId` is the DETERMINISTIC id
 * (sha256 of the gate key) so a same-tx re-emit under replay is idempotent. */
export const artifactProducedOutbox = cinatraSchema.table("artifact_produced_outbox", {
  eventId:                  text("event_id").primaryKey(),
  orgId:                    text("org_id").notNull(),
  artifactId:               text("artifact_id").notNull(),
  representationRevisionId: text("representation_revision_id").notNull(),
  eventKind:                text("event_kind").notNull().default("artifact_produced"),
  emitter:                  text("emitter").notNull(),
  producerRunId:            text("producer_run_id"),
  producerAgentId:          text("producer_agent_id"),
  originKind:               text("origin_kind").notNull(),
  destinationClass:         text("destination_class").notNull(),
  continuationMode:         text("continuation_mode").notNull(),
  continuationAddress:      text("continuation_address"),
  status:                   text("status").notNull().default("pending"), // pending | processed | reconciled
  createdAt:                timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt:              timestamp("processed_at", { withTimezone: true }),
}, (t) => ({
  revisionUniq: uniqueIndex("artifact_produced_outbox_revision_uniq")
    .on(t.artifactId, t.representationRevisionId, t.eventKind),
  statusIdx:    index("artifact_produced_outbox_status_idx").on(t.status, t.createdAt),
  orgIdx:       index("artifact_produced_outbox_org_idx").on(t.orgId),
}));

/** Checkpointed-mode continuation park (evaluate-then-park). A parked run always
 * resumes by `ttlExpiresAt` (terminal policy_unresolved on the protected effect
 * when unresolved). */
export const lifecycleContinuationPark = cinatraSchema.table("lifecycle_continuation_park", {
  id:                 text("id").primaryKey(),
  runId:              text("run_id").notNull(),
  eventId:            text("event_id").notNull(),
  checkpoint:         text("checkpoint").notNull(),
  policyDecisionId:   text("policy_decision_id"),
  protectedEffect:    text("protected_effect").notNull(),
  reevaluationIntent: boolean("reevaluation_intent").notNull().default(false),
  status:             text("status").notNull().default("parked"), // parked | released | policy_unresolved
  ttlExpiresAt:       timestamp("ttl_expires_at", { withTimezone: true }).notNull(),
  createdAt:          timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt:         timestamp("resolved_at", { withTimezone: true }),
}, (t) => ({
  runEventUniq: uniqueIndex("lifecycle_continuation_park_run_event_uniq")
    .on(t.runId, t.eventId, t.checkpoint),
  dueIdx:       index("lifecycle_continuation_park_due_idx").on(t.status, t.ttlExpiresAt),
}));

/** The zero-authority advisory seam — gate-bound, provenance-stamped, idempotent,
 * DECISION-FREE (no decision columns exist). Rows live WITH the gate. */
export const gateAdvisoryComments = cinatraSchema.table("gate_advisory_comments", {
  id:             text("id").primaryKey(),
  gateId:         text("gate_id").notNull().references(() => artifactReviewGates.id, { onDelete: "cascade" }),
  authorId:       text("author_id").notNull(),
  authorKind:     text("author_kind").notNull(), // user | agent | service
  body:           text("body").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  runCausation:   text("run_causation"),
  createdAt:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idemUniq: uniqueIndex("gate_advisory_comments_idem_uniq").on(t.gateId, t.idempotencyKey),
  gateIdx:  index("gate_advisory_comments_gate_idx").on(t.gateId, t.createdAt),
}));

/** DECIDED SCHEMA (S4): post-change verification records. */
export const artifactVerificationRecords = cinatraSchema.table("artifact_verification_records", {
  id:                              text("id").primaryKey(),
  gateId:                          text("gate_id").notNull().references(() => artifactReviewGates.id, { onDelete: "cascade" }),
  reviewedArtifactId:              text("reviewed_artifact_id").notNull(),
  reviewedRepresentationRevisionId:text("reviewed_representation_revision_id").notNull(),
  repairedArtifactId:              text("repaired_artifact_id").notNull(),
  repairedRepresentationRevisionId:text("repaired_representation_revision_id").notNull(),
  scopeManifest:                   jsonb("scope_manifest").notNull().default(sql`'{"paths":[]}'::jsonb`),
  fieldDiff:                       jsonb("field_diff").notNull().default(sql`'[]'::jsonb`),
  visualDiff:                      jsonb("visual_diff"),
  outcome:                         text("outcome").notNull(), // verified | drifted | unmet
  createdAt:                       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  gateIdx: index("artifact_verification_records_gate_idx").on(t.gateId),
}));

/** DECIDED SCHEMA (S3): the immutable per-run selected skill-revision set. */
export const runSelectedSkillRevisions = cinatraSchema.table("run_selected_skill_revisions", {
  id:              text("id").primaryKey(),
  runId:           text("run_id").notNull(),
  skillId:         text("skill_id").notNull(),
  skillRevisionId: text("skill_revision_id").notNull(),
  selectionSource: text("selection_source").notNull(),
  selectedAt:      timestamp("selected_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  runSkillUniq: uniqueIndex("run_selected_skill_revisions_uniq").on(t.runId, t.skillId),
  runIdx:       index("run_selected_skill_revisions_run_idx").on(t.runId),
}));

/** DECIDED SCHEMA (S5): a CMS snapshot-as-target + its apply binding. */
export const cmsSnapshotTargets = cinatraSchema.table("cms_snapshot_targets", {
  id:                   text("id").primaryKey(),
  artifactId:           text("artifact_id").notNull(),
  snapshotRevisionId:   text("snapshot_revision_id").notNull(),
  scopeManifest:        jsonb("scope_manifest").notNull().default(sql`'{"paths":[]}'::jsonb`),
  connectorInstance:    text("connector_instance").notNull(),
  resourceType:         text("resource_type").notNull(),
  resourceId:           text("resource_id"),
  baseRemoteRevisionRef:text("base_remote_revision_ref"),
  operationId:          text("operation_id").notNull(),
  createdAt:            timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  operationUniq: uniqueIndex("cms_snapshot_targets_operation_uniq").on(t.operationId),
  artifactIdx:   index("cms_snapshot_targets_artifact_idx").on(t.artifactId),
}));

/** DECIDED SCHEMA (S4 auditor re-home): gate-bound immutable suggestion snapshots. */
export const gateSuggestionSnapshots = cinatraSchema.table("gate_suggestion_snapshots", {
  id:        text("id").primaryKey(),
  gateId:    text("gate_id").notNull().references(() => artifactReviewGates.id, { onDelete: "cascade" }),
  payload:   jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  gateIdx: index("gate_suggestion_snapshots_gate_idx").on(t.gateId),
}));

/** DECIDED SCHEMA (S4 auditor re-home): the suggestion decision-application ledger. */
export const suggestionDecisionLedger = cinatraSchema.table("suggestion_decision_ledger", {
  id:           text("id").primaryKey(),
  suggestionId: text("suggestion_id").notNull().references(() => gateSuggestionSnapshots.id, { onDelete: "cascade" }),
  gateId:       text("gate_id").notNull(),
  decision:     text("decision").notNull(), // applied | dismissed
  decidedBy:    text("decided_by").notNull(),
  decidedAt:    timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  suggestionUniq: uniqueIndex("suggestion_decision_ledger_uniq").on(t.suggestionId),
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
// agent_run_test_sends — durable per-action idempotency + crash ledger for the
// run-scoped test-delivery send primitive (#1625, DESIGN-V3 contract (4)).
//
// One row per gate-submission send action. The dedupe identity is
// (run_id, submission_id) where submission_id is the trusted per-resume WayFlow
// task id (a transport retry of the SAME resume reuses the row; a genuine second
// send is a NEW gate re-entry ⇒ new task ⇒ new submission_id ⇒ new row). `seq` is
// the monotonic-per-run ordinal parse_action reads for the maxGateVisits halt
// guard. `selected_draft_ids` pins the phase-1 plan BEFORE any outbound send so a
// crash between claim and update reconciles against a durable expected batch
// (never rerandomized). NO FK-outliving churn concern here — the run FK cascades.
// ---------------------------------------------------------------------------

export const agentRunTestSends = cinatraSchema.table("agent_run_test_sends", {
  id:              text("id").primaryKey(),
  runId:           text("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
  submissionId:    text("submission_id").notNull(),
  seq:             integer("seq").notNull(),
  // 'sending' (claimed, outbound in flight) | 'sent' | 'failed'
  status:          text("status").notNull().default("sending"),
  recipientEmail:  text("recipient_email"),
  // The pinned concrete draft-id set resolved at phase-1 (random_initial resolved
  // ONCE) — the authoritative expected batch for crash reconciliation.
  selectedDraftIds: jsonb("selected_draft_ids").$type<string[]>().notNull(),
  // The typed discriminated send result ({ok,...}); null while 'sending'.
  resultJson:      jsonb("result_json").$type<Record<string, unknown> | null>(),
  claimedAt:       timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  leaseExpiresAt:  timestamp("lease_expires_at", { withTimezone: true }).notNull(),
  createdAt:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:       timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  runSubmissionUniq: uniqueIndex("agent_run_test_sends_run_id_submission_id_uniq").on(t.runId, t.submissionId),
  runIdIdx:          index("agent_run_test_sends_run_id_idx").on(t.runId),
}));

// ---------------------------------------------------------------------------
// agent_run_output_derivations — transactional outbox for the produces-scoped
// capture of an unbound agent run's FINAL output (cinatra#1893, epic #1883 A5).
//
// ONE row per non-empty WayFlow terminal-success run, inserted ATOMICALLY with
// the terminal status CAS + final-output snapshot in transitionRunStatus'
// `derivationOutbox` branch (PK run_id + ON CONFLICT DO NOTHING ⇒ capture is
// idempotent under a stop/retry re-drive). The post-terminal derivation job
// derives the captured `content` against the run agent's validated `produces`.
// `status` carries the lifecycle: pending (unclaimed) → deriving (LEASED,
// in-flight) → terminal done|no_match|no_produces. The recoverable row lease
// (lease_token + lease_expires_at, attempts bumped atomically on claim)
// SERIALIZES the derivation decision so the one-shot job and the reconciliation
// sweep can never split a run into no_match+artifact.
// ---------------------------------------------------------------------------

export const agentRunOutputDerivations = cinatraSchema.table("agent_run_output_derivations", {
  runId:          text("run_id").primaryKey().references(() => agentRuns.id, { onDelete: "cascade" }),
  orgId:          text("org_id").notNull(),
  templateId:     text("template_id").notNull(),
  packageVersion: text("package_version"),
  createdBy:      text("created_by"),
  // The captured final-output snapshot (the run's last-agent-message text, or
  // its JSON serialization) + a flag recording whether it parsed as JSON.
  content:        text("content").notNull(),
  contentIsJson:  boolean("content_is_json").notNull().default(false),
  // sha256(content) — the derived_output ledger dedupe component.
  contentHash:    text("content_hash").notNull(),
  // pending | deriving | done | no_match | no_produces
  status:         text("status").notNull().default("pending"),
  attempts:       integer("attempts").notNull().default(0),
  leaseToken:     text("lease_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  detail:         jsonb("detail").$type<Record<string, unknown> | null>(),
  createdAt:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:      timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  statusIdx: index("agent_run_output_derivations_status_idx").on(t.status, t.createdAt),
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

// ---------------------------------------------------------------------------
// project_dispatch_attempts — the dynamic-dispatch primitive's dispatch-attempt
// LEDGER (cinatra#1032 deliverable 2). One row per deliberate dispatch attempt,
// UNIQUE (org_id, item_natural_key, action_version) — the ledger key. The row
// is written AHEAD of createAgentRun and carries the deterministically derived
// idempotency_key passed VERBATIM to createAgentRun, so a tick that crashes
// between dispatch and record re-converges onto the SAME child run (via
// agent_runs_idempotency_key_uniq) instead of dispatching a duplicate.
//
// run_id is provenance only — deliberately NO foreign key: the ledger is
// append-only history that outlives the operational run row (an FK SET NULL
// would erase the historical run identity and re-open a redispatch ambiguity;
// a dispatched row whose run cannot be read surfaces as DISPATCH_RUN_MISSING,
// never as a fresh dispatch under the same action version).
// version is the optimistic-CAS counter (agent_run_pm_links precedent).
// ---------------------------------------------------------------------------

export const projectDispatchAttempts = cinatraSchema.table("project_dispatch_attempts", {
  id:             text("id").primaryKey(), // `pda_<uuid>`
  orgId:          text("org_id").notNull(),
  projectRef:     text("project_ref").notNull(),      // PM project scope (natural-key prefix)
  itemNaturalKey: text("item_natural_key").notNull(), // `<projectRef>/<taskId>` (immutable)
  actionVersion:  integer("action_version").notNull(),// deliberate-retry counter
  workerRole:     text("worker_role").notNull(),      // allowlist binding provenance
  workerPackage:  text("worker_package").notNull(),
  workerVersionConstraint: text("worker_version_constraint").notNull(), // canonical `kind:value` fingerprint
  idempotencyKey: text("idempotency_key").notNull(),  // passed VERBATIM to createAgentRun
  runId:          text("run_id"),                     // provenance; null until settled (NO FK, see above)
  status:         text("status").notNull().default("pending"), // 'pending' | 'dispatched' | 'failed' (CHECK in DDL)
  error:          text("error"),                      // last dispatch error; null = healthy
  version:        integer("version").notNull().default(0), // optimistic-CAS counter
  createdAt:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:      timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  itemActionUniq: uniqueIndex("project_dispatch_attempts_item_action_uniq").on(t.orgId, t.itemNaturalKey, t.actionVersion),
  projectIdx:     index("project_dispatch_attempts_project_idx").on(t.orgId, t.projectRef),
}));

// ---------------------------------------------------------------------------
// project_leases — the project-level lease (cinatra#1032 deliverable 2): at
// most one active tick per PM project scope. Keyed (org_id, project_ref).
// `version` is the FENCING token — bumped on every (re)acquisition, so a stale
// holder (crashed/expired tick) presenting an old version is rejected by the
// lease-fenced ledger claim even after the lease row was stolen. Stale-lease
// recovery = an acquire whose conditional upsert only wins when
// expires_at <= now() (or the caller is the live holder re-acquiring).
// ---------------------------------------------------------------------------

export const projectLeases = cinatraSchema.table("project_leases", {
  orgId:       text("org_id").notNull(),
  projectRef:  text("project_ref").notNull(),
  holderId:    text("holder_id").notNull(),
  acquiredAt:  timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt:   timestamp("expires_at", { withTimezone: true }).notNull(),
  version:     integer("version").notNull().default(1), // fencing token
}, (t) => ({
  pk: primaryKey({ columns: [t.orgId, t.projectRef] }),
}));

// ---------------------------------------------------------------------------
// project_instances — the project-instance registry (cinatra#1032
// deliverable 3): the STICKY instantiation-time binding record, keyed
// (org_id, project_ref).
//
//   template_package / template_id — which installed agent package's
//   `cinatra/project-template.json` the project was instantiated from; the
//   template's stable id is pinned so dispatch refuses a template swap under
//   the same project ref.
//   pm_agent_package — the PM SEAT: the project-management agent (the
//   pm-work-store capability binding, proven at instantiation). Only this
//   agent's tick runs may dispatch workers for the project.
//   provider_id / provider_mode — the PM work-store provider chosen ONCE at
//   instantiation ('configured' = an explicitly configured provider won;
//   'auto' = exactly one connected provider existed; CHECK in DDL). Selection
//   fails closed on none/several; no runtime path re-runs selection, so a
//   project can never silently migrate between PM tools.
//   project_id — nullable cinatra project refinement (mirrors
//   agent_runs.project_id semantics).
// ---------------------------------------------------------------------------

export const projectInstances = cinatraSchema.table("project_instances", {
  orgId:           text("org_id").notNull(),
  projectRef:      text("project_ref").notNull(),
  projectId:       text("project_id"),
  templatePackage: text("template_package").notNull(),
  templateId:      text("template_id").notNull(),
  templateDigest:  text("template_digest").notNull(), // finalized-install digest at instantiation (provenance)
  pmAgentPackage:  text("pm_agent_package").notNull(),
  providerId:      text("provider_id").notNull(),
  providerMode:    text("provider_mode").notNull(), // 'configured' | 'auto' (CHECK in DDL)
  createdAt:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:       timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.orgId, t.projectRef] }),
}));
