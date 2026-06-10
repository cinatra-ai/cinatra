import { eq, ne, desc, max, asc, and, or, ilike, sql, inArray, isNull, isNotNull, lt, type SQL } from "drizzle-orm";
import type { AgentIOSpec } from "@cinatra-ai/objects";
import { expireRunStream } from "@cinatra-ai/a2a";
import { listSavedNangoConnections } from "@cinatra-ai/nango-connector";
import { randomUUID, createHash } from "node:crypto";
import { diffLines } from "diff";
import semver from "semver";
import { buildListPage } from "@/lib/mcp-pagination";
import type { ListPage } from "@/lib/mcp-pagination";
import { shadowUpsertObject, shadowDeleteObject } from "@/lib/objects-dual-write";
// sealed-room filter value helper.
// Returns the effective projectId for the agent_runs table given the
// per-table feature flag (CINATRA_SEALED_ROOM_AGENT_RUNS) and ambient/
// project mode. Used by readAgentRunsByTemplateRaw + readAgentRuns to
// append the `WHERE agent_runs.project_id = $projectId` clause.
import { sealedRoomFilterValue } from "@/lib/sealed-room";
import { db, agentBuilderPool } from "./db";
import {
  agentTemplates,
  agentVersions,
  agentRuns,
  auditEvents,
  agentRegistryEntries,
  agentShareBindings,
  agentForks,
  agentRunMessages,
  agentTemplateVersions,
  agentRunHitlPrompts,
  runCoOwners,
} from "./schema";
// GatedStep type used in CreateAgentTemplateInput patches +
// AgentTemplateRecord row deserialization. The persistence column is JSON-as-text;
// this type represents the in-memory shape after JSON.parse.
import type { GatedStep } from "./trigger-infer-side-effects";
// ExtensionOrigin included in AgentTemplateRecord so callers
// can read origin.visibility without a separate readAgentTemplateOrigin call.
import type { ExtensionOrigin } from "./schema";
// AgentAuthPolicy persisted as JSON-as-text in
// agent_templates.agent_auth_policy and (per-run override) agent_runs.auth_policy.
// enforceRunAccess is the policy enforcer; PrimitiveActorContext is the actor
// envelope every MCP / route call site already constructs.
import type { AgentAuthPolicy, ActorRoleHints } from "./auth-policy";
import {
  enforceRunAccess,
  AgentAuthPolicySchema,
  DEFAULT_AGENT_AUTH_POLICY,
  resolveEffectivePolicy,
} from "./auth-policy";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";

// ---------------------------------------------------------------------------
// Defensive AgentAuthPolicy JSON parser.
//
// JSON.parse on an unguarded raw column can throw on malformed input
// (direct SQL writes, partial migrations, dev tools), and a static `as
// AgentAuthPolicy` cast lies about the runtime shape — `JSON.parse("null")`
// returns null, and `{"runListVisibility":"EVIL"}` typechecks but is
// semantically broken. Wrap parse + zod validation with try/catch so a
// bad row degrades gracefully to null (which downstream code treats as
// "no override; inherit from template / use DEFAULT_AGENT_AUTH_POLICY").
//
// This intentionally does NOT touch the existing compiledPlan /
// approvalPolicy / gatedSteps parses — those predate this parser and are
// out of scope unless parser symmetry is needed.
// ---------------------------------------------------------------------------
function parseAuthPolicySafe(raw: string | null): AgentAuthPolicy | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = AgentAuthPolicySchema.safeParse(parsed);
    if (!result.success) {
      // eslint-disable-next-line no-console
      console.warn(
        "[agent-builder/store] AgentAuthPolicy row failed zod validation; treating as null override",
        { issues: result.error.issues },
      );
      return null;
    }
    return result.data;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[agent-builder/store] AgentAuthPolicy row failed JSON.parse; treating as null override",
      { error: err instanceof Error ? err.message : String(err) },
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type CompiledStep = {
  stepNumber: number;
  name: string;
  description: string;
  toolName: string; // MCP primitive name e.g. "scrape_source_instance_create"
  toolArgs: Record<string, unknown>;
  riskClass:
    | "read_only"
    | "external_lookup"
    | "draft_create"
    | "send_external_message"
    | "delete"
    | "financial_commitment";
  requiresApproval: boolean; // true for send_external_message, delete, financial_commitment
  maxRetries?: number; // default 2 at execution time; 0 for send_external_message/delete/financial_commitment
  failFast?: boolean;  // default true at execution time
};

export type ApprovalPolicy = {
  steps: Array<{
    stepNumber: number;
    riskClass: string;
    requiresApproval: boolean;
  }>;
};

export type AgentTemplateRecord = {
  id: string;
  orgId: string | null;
  creatorId: string | null;
  name: string;
  description: string | null;
  sourceNl: string;
  compiledPlan: CompiledStep[];
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  approvalPolicy: ApprovalPolicy;
  status: string;
  type: "leaf" | "proxy" | "orchestrator" | "parallel" | "supervisor" | "iterative" | "node" | "flow";    // includes OAS-aligned node/flow templates
  taskSpec: string | null;                    // free-form task specification for LangGraph agents
  packageName?: string | null;               // stable package identity
  packageVersion?: string | null;            // semantic version string
  currentVersionId: string | null;           // pointer to the active version (null = latest)
  hitlScreens: string[] | null;              // namespaced x-renderer IDs this template produces as HITL states
  agentDependencies?: Record<string, string>; // @cinatra/* dep ranges; optional ({} or absent when none)
  connectorDependencies?: Record<string, string>; // @cinatra-ai/<x>-connector dep ranges; optional
  ioSpec?: AgentIOSpec | null; // declared I/O contract; null when not yet set
  hitlRequired: boolean;
  executionProvider: "openai" | "anthropic" | "gemini" | "langgraph" | "wayflow" | "default";
  lgGraphCode: string | null;                                         // Python StateGraph module; null for non-LangGraph templates
  lgGraphId: string | null;                                           // identifier registered with LangGraph Server
  // external A2A template columns. sourceType discriminates
  // Cinatra-built ("internal") from remote A2A servers ("external").
  // The other three are null for internal templates; for external they carry
  // the canonical base URL and the composite upsert key
  // (connector_slug, remote_agent_id) — stable across name + version changes.
  sourceType: "internal" | "external";
  agentUrl: string | null;
  connectorSlug: string | null;
  remoteAgentId: string | null;
  // trigger gate metadata persisted on each agent_source_compile.
  // Gate and UI code read these directly.
  // Null for templates compiled before trigger metadata existed.
  triggerMode: "full" | "start-only" | null;
  // JSON-as-text persisted (matches compiledPlan/hitlScreens convention);
  // deserialized to GatedStep[] here so callers can read it as a typed array.
  gatedSteps: GatedStep[] | null;
  // template-level default AgentAuthPolicy. null = use
  // DEFAULT_AGENT_AUTH_POLICY from auth-policy.ts. Persisted as JSON-as-text
  // in agent_templates.agent_auth_policy.
  agentAuthPolicy: AgentAuthPolicy | null;
  // soft-lifecycle for extension packages (agent templates installed
  // from Verdaccio). 'active' = visible/usable; 'archived' = hidden but retained.
  extensionLifecycleStatus: "active" | "archived";
  // registry origin coordinates (null for legacy rows).
  // Grandfather clause: null origin rows are treated as "public" visibility.
  // Optional in the type so legacy fixture objects in tests remain valid.
  origin?: ExtensionOrigin | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AgentVersionRecord = {
  id: string;
  templateId: string;
  versionNumber: number;
  contentHash: string;
  snapshot: Record<string, unknown>;
  createdAt: Date;
};

export type AgentRunRecord = {
  id: string;
  templateId: string;
  versionId: string | null;
  runBy: string | null;
  status: string;
  inputParams: Record<string, unknown>;
  stepResults: unknown[] | null;
  startedAt: Date | null;
  completedAt: Date | null;
  error: string | null;
  title: string | null;            // user-given run name
  createdAt: Date;                  // row creation timestamp
  sourceType: string;              // 'agent_builder' | 'scrape' | 'research' | 'enrichment'
  sourceId: string | null;         // reference to config record id for legacy agents
  packageVersion: string | null;   // pinned at request time (A2A version pinning)
  a2aTaskId: string | null;        // A2A task id persisted by InProcessAgentExecutor
  a2aContextId: string | null;     // fasta2a context id for WayFlow resume
  parentRunId: string | null;      // orchestrator parent run id (federated workspace linkage)
  agUiEnabled: boolean | null;     // true for runs with AG-UI SSE capability; null for legacy runs
  lgThreadId: string | null;       // LangGraph Server thread ID; null for non-LangGraph runs
  traceId: string | null;         // OTel trace ID; null until agentic-execution starts a root span
  timeoutSeconds: number | null;  // server-side timeout; null = no timeout
  // external A2A peer text output persisted on clean RUN_FINISHED.
  // NULL for internal runs and for externals that timed out / errored.
  streamedText: string | null;
  // per-run override of the template's agentAuthPolicy. null = inherit.
  // Persisted as JSON-as-text in agent_runs.auth_policy.
  authPolicy: AgentAuthPolicy | null;
  // org-scoping column is required and NOT NULL.
  // Every run-creation entry point now resolves an orgId before insert.
  //
  //
  orgId: string;
  // nullable project refinement. The run
  // worker reads this row at the entry of `runAgentBuilderExecutionJob`
  // and wraps execution in a `mcpRequestContextStorage.run({ ...,
  // projectContext: { projectId } }, ...)` frame so every artifact/object
  // write inside the run inherits `objects.project_id = projectId`
  // (substrate-excluded types stay NULL).
  projectId: string | null;
  // idempotent agent-task dispatch provenance. NULL for every
  // run not created by the release-workflows engine. Surfaced so the engine's
  // agent_task executor can verify the child run it polls is the one it spawned.
  idempotencyKey: string | null;
  workflowId: string | null;
  workflowTaskId: string | null;
};

export type CreateAgentTemplateInput = {
  id: string;
  orgId?: string;
  creatorId?: string;
  name: string;
  description?: string;
  sourceNl: string;
  compiledPlan: CompiledStep[];
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  approvalPolicy: ApprovalPolicy;
  status?: string;
  type?: "leaf" | "proxy" | "orchestrator" | "parallel" | "supervisor" | "iterative" | "node" | "flow";    // defaults to "leaf"; includes node/flow
  taskSpec?: string | null;                    // populated only for agentic mode
  packageName?: string;                        // stable package identity (one-time set)
  packageVersion?: string;                     // semantic version string
  hitlScreens?: string[] | null;              // namespaced x-renderer IDs this template produces as HITL states
  agentDependencies?: Record<string, string>;  // @cinatra/* dep ranges; omit or {} to write SQL NULL
  connectorDependencies?: Record<string, string>; // @cinatra-ai/<x>-connector dep ranges; omit or {} to write SQL NULL
  ioSpec?: AgentIOSpec | null; // pass null to clear; omit to leave unchanged
  hitlRequired?: boolean;                                               // defaults to false
  executionProvider?: "openai" | "anthropic" | "gemini" | "langgraph" | "wayflow" | "default";  // defaults to "wayflow"
  lgGraphCode?: string | null;                                        // Python StateGraph module; null for non-LangGraph templates
  lgGraphId?: string | null;                                          // identifier registered with LangGraph Server
  // trigger gate metadata. Patched by
  // agent_source_compile on every recompile.
  triggerMode?: "full" | "start-only" | null;
  gatedSteps?: GatedStep[] | null;
  // template-level default policy; pass null or omit to leave unset
  // (resolves to DEFAULT_AGENT_AUTH_POLICY at read time).
  agentAuthPolicy?: AgentAuthPolicy | null;
  // the extension soft-lifecycle patch field was removed.
  // Extension archive/restore now routes through the canonical manifest
  // (transitionExtensionByPackageName); updateAgentTemplate no longer writes
  // the (dropped) extension_lifecycle_status column.
  // install-time owner tier. Values are threaded from installRegistryPackageAtScope
  // through install-from-package and createLocalAgentTemplateVersion to this writer.
  // NULL means "no owner tier set".
  // (back-compat for legacy create paths and legacy rows).
  ownerLevel?: "user" | "team" | "organization" | "workspace" | "project";
  ownerId?: string;
};

export type CreateAgentVersionInput = {
  id: string;
  templateId: string;
  contentHash: string;
  snapshot: Record<string, unknown>;
};

export type CreateAgentRunInput = {
  id: string;
  templateId: string;
  versionId?: string;
  runBy?: string;
  inputParams: Record<string, unknown>;
  title?: string;        // user-given run name
  sourceType?: string;   // defaults to 'agent_builder'
  sourceId?: string;     // reference to config record id for legacy agents
  packageVersion?: string; // pinned at request time (A2A version pinning)
  a2aTaskId?: string;    // A2A task id (when run created via A2A path)
  parentRunId?: string | null; // orchestrator parent run id; only accepted at create time.
                               // updateAgentRun* helpers refuse to mutate it.
  timeoutSeconds?: number | null; // server-side timeout (seconds); null = no timeout
  // org id resolved by every entry point before insert.
  // Required at the store layer; runtime PG NOT NULL enforces.
  orgId: string;
  // nullable project refinement. Resolved
  // by the 3 callers:
  //  • MCP `agent_run` handler reads `mcpRequestContextStorage.projectContext`
  //    (transport-boundary set by the chat surface; NULL when no project).
  //  • A2A external dispatch (`a2a-actions.ts`): inherit from parent run if
  //    any; else NULL.
  //  • Registry server action (`runFromRegistry`): NULL (out-of-project
  //    server-action invocation).
  projectId?: string | null;
  // idempotent agent-task dispatch (additive; all optional).
  // When the release-workflows engine dispatches an agent_task it passes a
  // run-scoped idempotencyKey (`${workflowId}:${taskId}:${attemptNo}`) plus the
  // workflow/task provenance. A retried at-least-once dispatch with the same key
  // resolves to the SAME child run via the partial-unique index rather than
  // spawning a duplicate. Omitted by every legacy caller → behavior unchanged.
  idempotencyKey?: string;
  workflowId?: string;
  workflowTaskId?: string;
  // delegated execution-actor snapshot.
  // JSON-serializable identity captured at instantiate. The run-worker
  // replays it at re-authz time. Optional — legacy callers (test fixtures,
  // schema-only paths) omit; new MCP handlers populate it from the actor.
  delegatedActorSnapshot?: string | null;
};

// ---------------------------------------------------------------------------
// packageName auto-derive.
//
// Every template row now carries a NOT NULL packageName. Templates created
// via the internal save path that omit packageName receive an auto-derived
// `@user-<userId>/<slug>` identity. Existing templates created with an
// explicit packageName pass through unchanged.
//
// `slugify` mirrors the looser slugifyAgentTemplateName variant used for
// route lookups but enforces the strict `[a-z0-9-]` charset that the
// strict regex (resolveWayflowUrl) demands.
// ---------------------------------------------------------------------------

export function slugify(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "untitled";
}

export function derivePackageName(input: {
  packageName?: string | null;
  userId?: string | null;
  name: string;
  id?: string | null;
}): string {
  const trimmed = input.packageName?.trim();
  if (trimmed) return trimmed;
  // Append slugified id to guarantee uniqueness, mirroring
  // the migration backfill formula in src/lib/drizzle-store.ts. Without the
  // id suffix two templates with the same (creator, name) collide on the
  // unique index. The slugify pass also enforces the strict resolveWayflowUrl
  // charset (lowercase + [a-z0-9-]) so manifests round-trip cleanly through
  // the catch-all proxy.
  const userPartRaw = input.userId?.trim() || "unknown";
  const userPart = slugify(userPartRaw);
  const slug = slugify(input.name);
  const idPart = input.id ? slugify(input.id) : "";
  return idPart ? `@user-${userPart}/${slug}-${idPart}` : `@user-${userPart}/${slug}`;
}

// ---------------------------------------------------------------------------
// Template row serialization helpers
// ---------------------------------------------------------------------------

function serializeTemplate(input: CreateAgentTemplateInput) {
  // derive packageName when callers omit it. The DB column
  // is NOT NULL, so a literal null would crash on
  // INSERT; auto-derive guarantees every row has a stable identity.
  const packageName = derivePackageName({
    packageName: input.packageName,
    userId: input.creatorId ?? null,
    name: input.name,
    id: input.id,
  });
  return {
    id: input.id,
    orgId: input.orgId ?? null,
    // owner tier. NULL when caller did not specify; the
    // backfill covers legacy rows.
    ownerLevel: input.ownerLevel ?? null,
    ownerId: input.ownerId ?? null,
    creatorId: input.creatorId ?? null,
    name: input.name,
    description: input.description ?? null,
    sourceNl: input.sourceNl,
    compiledPlan: JSON.stringify(input.compiledPlan),
    inputSchema: JSON.stringify(input.inputSchema),
    outputSchema: input.outputSchema ? JSON.stringify(input.outputSchema) : null,
    approvalPolicy: JSON.stringify(input.approvalPolicy),
    status: input.status ?? "draft",
    type: input.type ?? "leaf",
    taskSpec: input.taskSpec ?? null,
    packageName,
    packageVersion: input.packageVersion ?? null,
    hitlScreens: input.hitlScreens ? JSON.stringify(input.hitlScreens) : null,
    agentDependencies:
      input.agentDependencies && Object.keys(input.agentDependencies).length > 0
        ? JSON.stringify(input.agentDependencies)
        : null,
    connectorDependencies:
      input.connectorDependencies && Object.keys(input.connectorDependencies).length > 0
        ? JSON.stringify(input.connectorDependencies)
        : null,
    ioSpec: input.ioSpec ? JSON.stringify(input.ioSpec) : null,
    hitlRequired: input.hitlRequired ?? false,
    executionProvider: input.executionProvider ?? "wayflow",
    lgGraphCode: input.lgGraphCode ?? null,
    lgGraphId: input.lgGraphId ?? null,
    // null on initial create; populated by
    // agent_source_compile on the first recompile.
    triggerMode: input.triggerMode ?? null,
    gatedSteps: input.gatedSteps ? JSON.stringify(input.gatedSteps) : null,
    // template-level AgentAuthPolicy as JSON-as-text. null = use
    // DEFAULT_AGENT_AUTH_POLICY at read time.
    agentAuthPolicy: input.agentAuthPolicy ? JSON.stringify(input.agentAuthPolicy) : null,
  };
}

export function deserializeTemplate(row: typeof agentTemplates.$inferSelect): AgentTemplateRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    creatorId: row.creatorId,
    name: row.name,
    description: row.description,
    sourceNl: row.sourceNl,
    compiledPlan: JSON.parse(row.compiledPlan) as CompiledStep[],
    inputSchema: JSON.parse(row.inputSchema) as Record<string, unknown>,
    outputSchema: row.outputSchema ? (JSON.parse(row.outputSchema) as Record<string, unknown>) : null,
    approvalPolicy: JSON.parse(row.approvalPolicy) as ApprovalPolicy,
    status: row.status,
    // normalize unknown values (null, legacy rows, direct SQL writes) to "leaf"
    // widened to six values (parallel|supervisor|iterative added)
    // preserve OAS-aligned "flow" and "node" types (were silently coerced to "leaf")
    type: (row.type === "proxy" ? "proxy"
         : row.type === "orchestrator" ? "orchestrator"
         : row.type === "parallel" ? "parallel"
         : row.type === "supervisor" ? "supervisor"
         : row.type === "iterative" ? "iterative"
         : row.type === "node" ? "node"
         : row.type === "flow" ? "flow"
         : "leaf") as AgentTemplateRecord["type"],
    taskSpec: row.taskSpec,
    packageName: row.packageName ?? null,
    packageVersion: row.packageVersion ?? null,
    currentVersionId: row.currentVersionId ?? null,
    hitlScreens: row.hitlScreens ? (JSON.parse(row.hitlScreens) as string[]) : null,
    agentDependencies: row.agentDependencies
      ? (JSON.parse(row.agentDependencies) as Record<string, string>)
      : {},
    connectorDependencies: row.connectorDependencies
      ? (JSON.parse(row.connectorDependencies) as Record<string, string>)
      : {},
    ioSpec: row.ioSpec ? (JSON.parse(row.ioSpec) as AgentIOSpec) : null,
    hitlRequired: row.hitlRequired ?? false, // null from pre-migration rows → false
    executionProvider: (row.executionProvider === "openai" ? "openai"
      : row.executionProvider === "anthropic" ? "anthropic"
      : row.executionProvider === "gemini" ? "gemini"
      : row.executionProvider === "langgraph" ? "langgraph"
      : row.executionProvider === "wayflow" ? "wayflow"
      : "default") as "openai" | "anthropic" | "gemini" | "langgraph" | "wayflow" | "default",
    lgGraphCode: row.lgGraphCode ?? null,
    lgGraphId: row.lgGraphId ?? null,
    // external A2A template columns.
    // Unknown values (e.g. stray strings from direct SQL writes) fall back
    // to "internal" so downstream type-narrow branches stay sound.
    sourceType: (row.sourceType === "external" ? "external" : "internal") as
      | "internal"
      | "external",
    agentUrl: row.agentUrl ?? null,
    connectorSlug: row.connectorSlug ?? null,
    remoteAgentId: row.remoteAgentId ?? null,
    // trigger gate metadata. Stored as text columns;
    // deserialized to typed values here. Unknown trigger_mode strings (e.g.
    // direct SQL writes) coerce to null so callers can default to "full"
    // conservatively at the gate.
    triggerMode: (row.triggerMode === "full" ? "full"
                : row.triggerMode === "start-only" ? "start-only"
                : null) as "full" | "start-only" | null,
    gatedSteps: row.gatedSteps ? (JSON.parse(row.gatedSteps) as GatedStep[]) : null,
    // JSON-as-text deserialization. Returns null when column is null.
    // fix: defensive parse — see parseAuthPolicySafe definition above.
    agentAuthPolicy: parseAuthPolicySafe(row.agentAuthPolicy ?? null),
    // the per-kind column was dropped; status is canonical
    // (installed_extension). deserializeTemplate is a synchronous row mapper
    // and cannot query the manifest, so it defaults to "active". The marketplace
    // readers (readActiveExtensionTemplates / readArchivedExtensionTemplates)
    // OVERRIDE this from readEffectiveStatusByPackageNames; callers that need
    // the authoritative status must use those readers (or the canonical store).
    extensionLifecycleStatus: "active" as "active" | "archived",
    // origin JSONB deserialized as-is; null for legacy rows.
    // Callers that need visibility should read origin?.visibility ?? 'public' (grandfather clause).
    origin: (row.origin as ExtensionOrigin | null | undefined) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// CRUD — agent_templates
// ---------------------------------------------------------------------------

// a template write creates
// a "dependent edge" that the purge dependents hard-block detects iff it
// persists ANY of: a non-empty `agentDependencies` (readAgentTemplatesDependingOn
// — JSONB `?` key match) OR a `compiledPlan` / `approvalPolicy`
// (readAgentTemplatesReferencingChildPackage — `LIKE %"pkg"%` substring match
// on the compiled/runtime JSON, see store.ts readAgentTemplatesReferencingChildPackage).
// Locking only on agentDependencies would leave the
// compiledPlan/approvalPolicy edge unserialized against the purge saga.
// Substring detection over-detects by design (fail-safe), so we must
// conservatively serialize whenever any of those three is written.
function templateWriteCreatesDependentEdge(v: {
  agentDependencies?: Record<string, string> | null;
  compiledPlan?: unknown;
  approvalPolicy?: unknown;
}): boolean {
  return (
    (!!v.agentDependencies && Object.keys(v.agentDependencies).length > 0) ||
    v.compiledPlan != null ||
    v.approvalPolicy != null
  );
}

export async function createAgentTemplate(
  input: CreateAgentTemplateInput,
): Promise<AgentTemplateRecord> {
  // DB-writer chokepoint for the global extension-lifecycle lock. Without
  // serializing a dependent-edge write against the purge saga, a dependent
  // could be inserted AFTER purge's final dependents re-scan and BEFORE
  // dbPurgeAtomic deletes the dependency — an orphan pointing at deleted
  // rows. This single chokepoint covers importAgentTemplateCore, agent_update,
  // compile/save, and any future caller. Writes with no dependent edge skip
  // the lock (hot metadata path). Re-entrant: install/purge holders pass
  // through as a no-op. Dynamic import avoids module init-order/TDZ coupling.
  if (templateWriteCreatesDependentEdge(input)) {
    const { withGlobalExtensionLifecycleLock } = await import(
      "./materialize-agent-package"
    );
    return withGlobalExtensionLifecycleLock(() =>
      _createAgentTemplateImpl(input),
    );
  }
  return _createAgentTemplateImpl(input);
}

async function _createAgentTemplateImpl(
  input: CreateAgentTemplateInput,
): Promise<AgentTemplateRecord> {
  const [row] = await db
    .insert(agentTemplates)
    .values(serializeTemplate(input))
    .returning();
  const record = deserializeTemplate(row);

  // shadow-write the newly created agent template.
  // Dates must be ISO-serialised for JSONB (Drizzle returns Date instances).
  shadowUpsertObject({
    id: record.id,
    type: "@cinatra-ai/agent-builder:agent-template",
    data: {
      ...record,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    },
    orgId: record.orgId ?? null,
    createdBy: record.creatorId ?? null,
  });

  return record;
}

export type ReadAgentTemplatesOptions = {
  query?: string;           // name search (case-insensitive)
  status?: string;          // filter by status field
  type?: "leaf" | "proxy" | "orchestrator" | "parallel" | "supervisor" | "iterative" | "node" | "flow"; // widened ; adds node/flow
  packageName?: string;     // filter by packageName (needed by orchestrator-ready check)
  hasNoPackageName?: boolean; // true → only return templates with packageName IS NULL (hand-compiled, not package-installed)
  limit?: number;           // default 50, max 200
  offset?: number;          // default 0
  // When set, applies WHERE org_id = $1 to template list query.
  organizationId?: string;
  // Admin cross-org marker.
  // Set true ONLY by handlers that have verified isPlatformAdmin(session) === true.
  skipOrgFilter?: boolean;
};

export async function readAgentTemplates(opts: ReadAgentTemplatesOptions = {}): Promise<ListPage<AgentTemplateRecord>> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;

  const conditions: SQL[] = [];
  if (opts.query) conditions.push(ilike(agentTemplates.name, `%${opts.query}%`));
  if (opts.status) conditions.push(eq(agentTemplates.status, opts.status));
  if (opts.type) conditions.push(eq(agentTemplates.type, opts.type));
  if (opts.packageName) conditions.push(eq(agentTemplates.packageName, opts.packageName));
  if (opts.hasNoPackageName) conditions.push(isNull(agentTemplates.packageName));
  // Org-scope filter; handlers with platform_admin set skipOrgFilter=true.
  if (opts.organizationId && !opts.skipOrgFilter) {
    conditions.push(eq(agentTemplates.orgId, opts.organizationId));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [countResult, rows] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(agentTemplates).where(where),
    db.select().from(agentTemplates).where(where).orderBy(desc(agentTemplates.createdAt)).limit(limit).offset(offset),
  ]);

  const total = countResult[0]?.count ?? 0;
  let items = rows.map(deserializeTemplate);
  // Defense-in-depth. The SQL filter above is the
  // primary mechanism (correctness + performance). This post-filter
  // re-asserts the contract on the deserialized records — guards against
  // any caller path where the SQL where clause was bypassed (e.g. a
  // mocked db in tests) and matches the documented behavior that
  // organizationId narrows the result set even when the underlying query
  // returns more rows.
  if (opts.organizationId && !opts.skipOrgFilter) {
    items = items.filter((t) => t.orgId === opts.organizationId);
  }
  return buildListPage(items, total, offset, limit);
}

export async function readAgentTemplateById(
  id: string,
): Promise<AgentTemplateRecord | null> {
  const [row] = await db
    .select()
    .from(agentTemplates)
    .where(eq(agentTemplates.id, id));
  return row ? deserializeTemplate(row) : null;
}

// ---------------------------------------------------------------------------
// Slug-based lookup — generic agent configuration workspace
// ---------------------------------------------------------------------------

export function slugifyAgentTemplateName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function readAgentTemplateBySlug(
  slug: string,
  options?: { actorUserId?: string | null; includeNonPublished?: boolean },
): Promise<AgentTemplateRecord | null> {
  const normalized = slug.trim().toLowerCase();
  if (!normalized) return null;

  // 1) Direct ID match first (cheap constant-time lookup). This also avoids
  //    slug-vs-id collisions: if the caller passes a real UUID it always wins
  //    over any name-derived slug.
  const byId = await readAgentTemplateById(normalized);
  if (byId) return applyAgentTemplateVisibility(byId, options);

  // 1b) Package-name lookup: if slug contains '/' it's a vendor/packageName path
  //     segment from the new /agents/{vendor}/{packageName}/... URL structure.
  //     Prepend '@' to reconstruct the npm scoped package name and query by
  //     package_name. Example: old-scope/email-outreach → "@cinatra-ai/email-outreach-agent".
  if (normalized.includes("/")) {
    const packageName = `@${normalized}`;
    const byPackage = await db
      .select()
      .from(agentTemplates)
      .where(eq(agentTemplates.packageName, packageName))
      .limit(1);
    if (byPackage.length > 0) {
      const record = deserializeTemplate(byPackage[0]);
      return applyAgentTemplateVisibility(record, options);
    }
    // No match for package-name format — return null without falling through
    // to the name-slug lookup (which would slugify and mis-match).
    return null;
  }

  // 2) DB-side slugify. Must match slugifyAgentTemplateName exactly:
  //    lower -> replace non-alphanumeric runs with '-' -> trim leading/trailing dashes.
  const slugExpr = sql`trim(both '-' from regexp_replace(lower(${agentTemplates.name}), '[^a-z0-9]+', '-', 'g'))`;

  const rows = await db
    .select()
    .from(agentTemplates)
    .where(sql`${slugExpr} = ${normalized}`)
    .limit(2); // LIMIT 2 lets us detect ambiguous collisions

  if (rows.length === 0) return null;
  if (rows.length > 1) {
    // Two distinct template names slugified to the same value.
    console.warn(
      `[agent-builder] slug collision for '${normalized}': ${rows
        .map((r) => r.id)
        .join(", ")}. Refusing to resolve.`,
    );
    return null;
  }
  const record = deserializeTemplate(rows[0]);
  return applyAgentTemplateVisibility(record, options);
}

function applyAgentTemplateVisibility(
  record: AgentTemplateRecord,
  options?: { actorUserId?: string | null; includeNonPublished?: boolean },
): AgentTemplateRecord | null {
  // Published templates are visible to everyone.
  if (record.status === "published") return record;
  // Non-published (draft/archived) require an explicit opt-in.
  if (!options?.includeNonPublished) return null;
  // Creator-owned: only visible to the creator.
  if (record.creatorId) {
    return options?.actorUserId && record.creatorId === options.actorUserId ? record : null;
  }
  // Unclaimed (creatorId null, e.g. created via MCP): visible to any authenticated actor.
  return options?.actorUserId ? record : null;
}

export async function updateAgentTemplate(
  id: string,
  patch: Partial<CreateAgentTemplateInput>,
): Promise<AgentTemplateRecord | null> {
  // same DB-writer
  // chokepoint as createAgentTemplate: patching a non-empty agentDependencies
  // OR a compiledPlan / approvalPolicy creates/refreshes a dependent edge the
  // purge dependents scan detects, and MUST be serialized against the purge
  // saga (re-entrant no-op when the caller already holds the global lock).
  // Pure metadata patches (status/name/etc.) skip the lock.
  if (templateWriteCreatesDependentEdge(patch)) {
    const { withGlobalExtensionLifecycleLock } = await import(
      "./materialize-agent-package"
    );
    return withGlobalExtensionLifecycleLock(() =>
      _updateAgentTemplateImpl(id, patch),
    );
  }
  return _updateAgentTemplateImpl(id, patch);
}

async function _updateAgentTemplateImpl(
  id: string,
  patch: Partial<CreateAgentTemplateInput>,
): Promise<AgentTemplateRecord | null> {
  const updates: Partial<ReturnType<typeof serializeTemplate>> & { updatedAt?: Date } = {
    updatedAt: new Date(),
  };

  if (patch.name !== undefined) updates.name = patch.name;
  if (patch.description !== undefined) updates.description = patch.description ?? null;
  if (patch.sourceNl !== undefined) updates.sourceNl = patch.sourceNl;
  if (patch.compiledPlan !== undefined) updates.compiledPlan = JSON.stringify(patch.compiledPlan);
  if (patch.inputSchema !== undefined) updates.inputSchema = JSON.stringify(patch.inputSchema);
  if (patch.outputSchema !== undefined)
    updates.outputSchema = patch.outputSchema ? JSON.stringify(patch.outputSchema) : null;
  if (patch.approvalPolicy !== undefined) updates.approvalPolicy = JSON.stringify(patch.approvalPolicy);
  if (patch.status !== undefined) updates.status = patch.status;
  if (patch.orgId !== undefined) updates.orgId = patch.orgId ?? null;
  if (patch.creatorId !== undefined) updates.creatorId = patch.creatorId ?? null;
  if (patch.type !== undefined) updates.type = patch.type;
  if (patch.taskSpec !== undefined) updates.taskSpec = patch.taskSpec ?? null;
  // lgGraphCode / lgGraphId patchable. Use `null` to clear; omit to leave unchanged.
  if (patch.lgGraphCode !== undefined) updates.lgGraphCode = patch.lgGraphCode ?? null;
  if (patch.lgGraphId !== undefined) updates.lgGraphId = patch.lgGraphId ?? null;
  // These two fields were originally create-only.
  // Without these branches, updateAgentTemplate silently dropped patches, so
  // administrators could not flip an existing template to execution_provider='langgraph'.
  if (patch.hitlRequired !== undefined) updates.hitlRequired = patch.hitlRequired ?? false;
  if (patch.executionProvider !== undefined) updates.executionProvider = patch.executionProvider ?? "default";
  if (patch.hitlScreens !== undefined)
    updates.hitlScreens = patch.hitlScreens ? JSON.stringify(patch.hitlScreens) : null;
  if (patch.ioSpec !== undefined)
    updates.ioSpec = patch.ioSpec ? JSON.stringify(patch.ioSpec) : null;
  if (patch.agentDependencies !== undefined)
    updates.agentDependencies =
      patch.agentDependencies && Object.keys(patch.agentDependencies).length > 0
        ? JSON.stringify(patch.agentDependencies)
        : null;
  if (patch.connectorDependencies !== undefined)
    updates.connectorDependencies =
      patch.connectorDependencies && Object.keys(patch.connectorDependencies).length > 0
        ? JSON.stringify(patch.connectorDependencies)
        : null;
  if (patch.packageVersion !== undefined) updates.packageVersion = patch.packageVersion ?? null;
  // trigger gate metadata patch guards. Both nullable so a
  // legacy template can be cleared back to null (e.g. on schema downgrade).
  // gatedSteps is JSON-stringified so the text column stays canonical.
  if (patch.triggerMode !== undefined) updates.triggerMode = patch.triggerMode ?? null;
  if (patch.gatedSteps !== undefined)
    updates.gatedSteps = patch.gatedSteps ? JSON.stringify(patch.gatedSteps) : null;
  // template-level AgentAuthPolicy patch handler. null clears the
  // override; omit to leave the column unchanged.
  if (patch.agentAuthPolicy !== undefined)
    updates.agentAuthPolicy = patch.agentAuthPolicy ? JSON.stringify(patch.agentAuthPolicy) : null;
  // extension soft-lifecycle is no longer a column write;
  // archive/restore route through the canonical manifest.
  // owner tier patch guards. Without these, the upsert branch in
  // installAgentFromPackage silently dropped ownerLevel/ownerId on re-install,
  // producing an auth-vs-state divergence (audit row claims new scope, DB row
  // keeps prior scope). null clears the column; omit to leave unchanged.
  if (patch.ownerLevel !== undefined) updates.ownerLevel = patch.ownerLevel ?? null;
  if (patch.ownerId !== undefined) updates.ownerId = patch.ownerId ?? null;

  // pre-run gate for ownership reassignment.
  //
  // When the patch actually CHANGES ownership (vs just re-supplying the same
  // ownerLevel/ownerId on a re-install), we enforce the rule via a SQL-conditional
  // UPDATE: WHERE first_run_at IS NULL. If 0 rows are affected, either the
  // template doesn't exist OR it has been run, in which case we throw
  // CannotReassignAfterFirstRun. The trigger enqueue_agent_owner_move then
  // fires automatically as part of the UPDATE, queuing a path_relocations row.
  //
  // For non-ownership patches (name, status, version, etc.) we fall through to
  // the simple update path below, unchanged.
  const ownershipChanging =
    (patch.ownerLevel !== undefined || patch.ownerId !== undefined);
  if (ownershipChanging) {
    const current = await db
      .select({ ownerLevel: agentTemplates.ownerLevel, ownerId: agentTemplates.ownerId })
      .from(agentTemplates)
      .where(eq(agentTemplates.id, id));
    const cur = current[0];
    if (cur) {
      const nextLevel = patch.ownerLevel === undefined ? cur.ownerLevel : (patch.ownerLevel ?? null);
      const nextId = patch.ownerId === undefined ? cur.ownerId : (patch.ownerId ?? null);
      const ownershipActuallyChanged = nextLevel !== cur.ownerLevel || nextId !== cur.ownerId;
      if (ownershipActuallyChanged) {
        // Atomic gate: only succeeds if first_run_at IS NULL.
        const gated = await db
          .update(agentTemplates)
          .set({ ownerLevel: nextLevel, ownerId: nextId, updatedAt: new Date() })
          .where(
            and(
              eq(agentTemplates.id, id),
              isNull(agentTemplates.firstRunAt),
            ) as SQL<unknown>,
          )
          .returning({ id: agentTemplates.id });
        if (gated.length === 0) {
          // Either template missing or it's been run. Distinguish for callers.
          const probe = await db
            .select({ firstRunAt: agentTemplates.firstRunAt })
            .from(agentTemplates)
            .where(eq(agentTemplates.id, id));
          if (probe.length === 0) {
            // Template doesn't exist — return null (existing contract for unknown id)
            return null;
          }
          throw new CannotReassignAfterFirstRun(id);
        }
        // Ownership applied; strip from `updates` so the unconditional UPDATE
        // below doesn't try to write the same fields again (and re-fire the trigger).
        delete updates.ownerLevel;
        delete updates.ownerId;
      } else {
        // No actual change — drop from updates to avoid spurious trigger fires.
        delete updates.ownerLevel;
        delete updates.ownerId;
      }
    }
  }

  const [row] = await db
    .update(agentTemplates)
    .set(updates)
    .where(eq(agentTemplates.id, id))
    .returning();
  if (!row) return null;
  const record = deserializeTemplate(row);

  // re-upsert the mutated agent template.
  shadowUpsertObject({
    id: record.id,
    type: "@cinatra-ai/agent-builder:agent-template",
    data: {
      ...record,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    },
    orgId: record.orgId ?? null,
    createdBy: record.creatorId ?? null,
  });

  return record;
}

export async function deleteAgentTemplate(id: string): Promise<boolean> {
  // Clean up the polymorphic
  // `extension_co_owners` + `extension_access_policy` rows for this
  // agent_template BEFORE removing the template row. The polymorphic
  // tables have no FK to agent_templates(id) (one FK can't span multiple
  // kind-specific resource tables), so the app layer must do the cleanup.
  // Best-effort but explicit: any orphan rows that survive can re-apply
  // grants if the same template id is later reused.
  try {
    const { deleteExtensionPermissions } = await import("@cinatra-ai/extensions/permissions-store");
    await deleteExtensionPermissions("agent_template", id);
  } catch (err) {
    console.warn(
      "[agents/store] deleteExtensionPermissions(agent_template) failed:",
      err instanceof Error ? err.message : err,
    );
  }
  const result = await db.delete(agentTemplates).where(eq(agentTemplates.id, id));
  const deleted = (result.rowCount ?? 0) > 0;
  if (deleted) shadowDeleteObject(id);
  return deleted;
}

/** Delete all external agent templates for a connectorSlug except the canonical remoteAgentId. */
export async function deleteExternalAgentTemplatesByConnectorSlugExcept(
  connectorSlug: string,
  keepRemoteAgentId: string,
): Promise<number> {
  const result = await db
    .delete(agentTemplates)
    .where(
      and(
        eq(agentTemplates.connectorSlug, connectorSlug),
        ne(agentTemplates.remoteAgentId, keepRemoteAgentId),
      ),
    );
  return result.rowCount ?? 0;
}

export async function deleteExternalAgentTemplatesByConnectorSlug(
  connectorSlug: string,
): Promise<number> {
  const result = await db
    .delete(agentTemplates)
    .where(eq(agentTemplates.connectorSlug, connectorSlug));
  return result.rowCount ?? 0;
}

// seeds the io_spec column for code-based agents whose ioSpec is declared
// in plugin/definition.ts but not yet written to DB. Safe to call on every startup.
export async function seedCodeBasedAgentIoSpec(
  agentId: string,
  ioSpec: AgentIOSpec
): Promise<void> {
  await db
    .update(agentTemplates)
    .set({ ioSpec: JSON.stringify(ioSpec) })
    .where(
      and(
        eq(agentTemplates.packageName, agentId),
        isNull(agentTemplates.ioSpec)
      )
    );
}

// packageName is identity, not a label. Only writes when packageName is NULL.
export async function setAgentTemplatePackageName(
  templateId: string,
  packageName: string,
  packageVersion?: string,
): Promise<void> {
  const updateValues: Record<string, unknown> = { packageName };
  if (packageVersion !== undefined) {
    updateValues.packageVersion = packageVersion;
  }
  await db.update(agentTemplates)
    .set(updateValues)
    .where(
      and(
        eq(agentTemplates.id, templateId),
        isNull(agentTemplates.packageName),
      ),
    );
}

// lookup by stable package identity.
export async function readAgentTemplateByPackageName(
  packageName: string,
): Promise<AgentTemplateRecord | null> {
  const rows = await db
    .select()
    .from(agentTemplates)
    .where(eq(agentTemplates.packageName, packageName))
    .limit(1);
  return rows.length > 0 ? deserializeTemplate(rows[0]) : null;
}

/**
 * Visibility policy: is this agent template PUBLICLY discoverable?
 *
 * Global, actor-less discovery surfaces (the public unauthenticated
 * `/.well-known/agent.json` A2A card + the global MCP `tools/list`) must NOT
 * advertise PRIVATE agents' name/description metadata — `private` means
 * "not discoverable outside its scope", not merely "not invokable" (invocation
 * is separately auth-gated). Grandfather clause (matches the rest of the store):
 * a null `origin` / absent visibility is treated as `public`. Pure — safe for
 * both the server-only registry and the host A2A route.
 */
export function isAgentPubliclyDiscoverable(template: {
  origin?: { visibility?: string | null } | null;
}): boolean {
  return (template.origin?.visibility ?? "public") === "public";
}

// retrieve all published templates that have a packageName set.
// Used by registerPublishedAgentTools to dynamically wire each as an MCP tool.
// Secondary sort desc(createdAt) ensures that when multiple published entries
// share the same packageName (due to successive compile_and_write calls), the
// newest is found first by resolveAgentByPackageName's .find call.
export async function readPublishedAgentTemplates(): Promise<AgentTemplateRecord[]> {
  const rows = await db
    .select()
    .from(agentTemplates)
    .where(
      and(
        eq(agentTemplates.status, "published"),
        isNotNull(agentTemplates.packageName),
      ),
    )
    .orderBy(asc(agentTemplates.name), desc(agentTemplates.createdAt));
  return rows.map(deserializeTemplate);
}

// used by RegistryCatalogScreen to annotate installed state.
// Includes draft + published templates — any template with a packageName is "installed".
export async function readAllAgentTemplatesWithPackageName(): Promise<AgentTemplateRecord[]> {
  const rows = await db
    .select()
    .from(agentTemplates)
    .where(isNotNull(agentTemplates.packageName))
    .orderBy(asc(agentTemplates.name));
  return rows.map(deserializeTemplate);
}

// used by /agents/run discovery page to show only installed agents.
// Filters agent_templates WHERE packageName IS NOT NULL AND status IN (statuses).
// Default statuses = ["active", "published"] so draft templates never leak to /agents/run.
export async function readInstalledAgentTemplates(
  options?: { statuses?: string[] },
): Promise<AgentTemplateRecord[]> {
  const statuses = options?.statuses ?? ["active", "published"];
  if (statuses.length === 0) return [];
  const rows = await db
    .select()
    .from(agentTemplates)
    .where(
      and(
        isNotNull(agentTemplates.packageName),
        inArray(agentTemplates.status, statuses),
      ),
    )
    .orderBy(asc(agentTemplates.name));
  return rows.map(deserializeTemplate);
}

// ---------------------------------------------------------------------------
// external A2A template helpers
// ---------------------------------------------------------------------------

/**
 * Normalize an agent URL to its canonical form so the agent_url column stores
 * a consistent value regardless of how callers supply it.
 *
 * Contract:
 *   - lowercase scheme + host
 *   - strip trailing slashes on both the path and the root
 *   - preserve path/query verbatim otherwise
 *
 * Used by upsertExternalAgentTemplate and findSavedConnectionForAgentUrl so
 * their comparisons are slash-/case-insensitive.
 */
function normalizeAgentUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  try {
    const u = new URL(trimmed);
    const host = u.host.toLowerCase();
    const scheme = u.protocol.toLowerCase();
    const rest = `${u.pathname}${u.search}`.replace(/\/+$/, "");
    return `${scheme}//${host}${rest}`;
  } catch {
    return trimmed;
  }
}

/**
 * Read an external agent_templates row by its composite identity
 * (connector_slug, remote_agent_id). This is the AUTHORITATIVE lookup for
   * external templates: stable across display-name changes and version bumps.
 * across display-name changes and version bumps.
 *
 * Internal templates always return null here since their connector_slug column
 * is NULL.
 */
export async function readAgentTemplateByConnectorAndRemoteId(
  connectorSlug: string,
  remoteAgentId: string,
): Promise<AgentTemplateRecord | null> {
  const rows = await db
    .select()
    .from(agentTemplates)
    .where(
      and(
        eq(agentTemplates.connectorSlug, connectorSlug),
        eq(agentTemplates.remoteAgentId, remoteAgentId),
      ),
    )
    .limit(1);
  return rows.length > 0 ? deserializeTemplate(rows[0]) : null;
}

/**
 * Upsert an external A2A server template, keyed on the composite
 * (connector_slug, remote_agent_id). packageName is DERIVED as
 * `@{connectorSlug}/{remoteAgentId}` so the existing readAgentTemplateByPackageName
 * read path still functions, but it is NOT the authoritative identity.
 *
 * Call sites:
 *   - sendAgentBuilderMessage external branch (dispatch-time re-upsert)
 *   - Explicit admin "sync connector" flow (future)
 *
 * Never called from route resolvers, page renders, or RSC paths.
 */
export async function upsertExternalAgentTemplate(input: {
  connectorSlug: string;
  remoteAgentId: string;
  name: string;
  description?: string | null;
  agentUrl: string;
  version?: string | null;
}): Promise<{ id: string }> {
  const normalizedUrl = normalizeAgentUrl(input.agentUrl);
  const packageName = `@${input.connectorSlug}/${input.remoteAgentId}`;
  const existing = await readAgentTemplateByConnectorAndRemoteId(
    input.connectorSlug,
    input.remoteAgentId,
  );

  if (existing) {
    await db
      .update(agentTemplates)
      .set({
        name: input.name,
        description: input.description ?? existing.description ?? null,
        sourceType: "external",
        agentUrl: normalizedUrl,
        connectorSlug: input.connectorSlug,
        remoteAgentId: input.remoteAgentId,
        packageName,
        packageVersion: input.version ?? existing.packageVersion ?? null,
        status: "active",
        updatedAt: new Date(),
      })
      .where(eq(agentTemplates.id, existing.id));
    return { id: existing.id };
  }

  const id = randomUUID();
  await db.insert(agentTemplates).values({
    id,
    orgId: null,
    creatorId: null,
    name: input.name,
    description: input.description ?? null,
    // Required NOT NULL text columns on agent_templates that are irrelevant
    // for external templates — fill with empty-JSON sentinels so the row is
    // accepted by the NOT NULL constraints without polluting the domain model.
    sourceNl: "",
    compiledPlan: "[]",
    inputSchema: "{}",
    approvalPolicy: '{"steps":[]}',
    status: "active",
    type: "leaf",
    packageName,
    packageVersion: input.version ?? null,
    sourceType: "external",
    agentUrl: normalizedUrl,
    connectorSlug: input.connectorSlug,
    remoteAgentId: input.remoteAgentId,
    executionProvider: "default",
    hitlRequired: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { id };
}

/**
 * Rename the remoteAgentId (and derived packageName) of an external template
 * in-place by primary key. Used by a2a-dev-auto-connect to replace
 * the synthetic "agent" placeholder with a real name-derived slug once the
 * agent card has been fetched.
 */
export async function renameExternalAgentTemplateRemoteId(
  id: string,
  newRemoteAgentId: string,
  connectorSlug: string,
): Promise<void> {
  await db
    .update(agentTemplates)
    .set({
      remoteAgentId: newRemoteAgentId,
      packageName: `@${connectorSlug}/${newRemoteAgentId}`,
      updatedAt: new Date(),
    })
    .where(eq(agentTemplates.id, id));
}

/**
 * Locate the saved Nango A2A connection whose stored metadata.baseUrl matches
 * the given agentUrl (normalized comparison).
 *
 * Returns the SavedNangoConnection record (providerConfigKey + connectionId)
 * so the caller can fetch fresh credentials via getNangoConnection.
 *
 * Returns null when no connection matches — the caller should propagate a
 * user-facing "no credentials for external A2A server" error.
 */
export function findSavedConnectionForAgentUrl(
  agentUrl: string,
): {
  providerConfigKey: string;
  connectionId: string;
  metadata?: Record<string, unknown>;
} | null {
  const connections = listSavedNangoConnections("a2aServer");
  const normalized = normalizeAgentUrl(agentUrl);
  for (const conn of connections) {
    const baseUrl = (conn.metadata as Record<string, unknown> | undefined)
      ?.baseUrl;
    if (
      typeof baseUrl === "string" &&
      normalizeAgentUrl(baseUrl) === normalized
    ) {
      return {
        providerConfigKey: conn.providerConfigKey,
        connectionId: conn.connectionId,
        metadata: conn.metadata as Record<string, unknown> | undefined,
      };
    }
  }
  return null;
}

// update packageVersion without touching packageName.
// setAgentTemplatePackageName guards `WHERE package_name IS NULL`; this is the
// complementary accessor for the version-update path (install-after-bootstrap / update flow).
export async function updateAgentTemplatePackageVersion(
  templateId: string,
  packageVersion: string,
): Promise<void> {
  await db.update(agentTemplates)
    .set({ packageVersion })
    .where(eq(agentTemplates.id, templateId));
}

// ---------------------------------------------------------------------------
// CRUD — agent_versions
// ---------------------------------------------------------------------------

export async function createAgentVersion(
  input: CreateAgentVersionInput,
): Promise<AgentVersionRecord> {
  // Auto-compute version number as max(existing)+1 for this templateId
  const [maxResult] = await db
    .select({ maxVersion: max(agentVersions.versionNumber) })
    .from(agentVersions)
    .where(eq(agentVersions.templateId, input.templateId));

  const nextVersion = (maxResult?.maxVersion ?? 0) + 1;

  const [row] = await db
    .insert(agentVersions)
    .values({
      id: input.id,
      templateId: input.templateId,
      versionNumber: nextVersion,
      contentHash: input.contentHash,
      snapshot: JSON.stringify(input.snapshot),
    })
    .returning();

  return {
    id: row.id,
    templateId: row.templateId,
    versionNumber: row.versionNumber,
    contentHash: row.contentHash,
    snapshot: JSON.parse(row.snapshot) as Record<string, unknown>,
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// CRUD — agent_runs
// ---------------------------------------------------------------------------

export async function createAgentRun(
  input: CreateAgentRunInput,
): Promise<AgentRunRecord> {
  const values = {
    id: input.id,
    templateId: input.templateId,
    versionId: input.versionId ?? null,
    runBy: input.runBy ?? null,
    status: "queued",
    inputParams: JSON.stringify(input.inputParams),
    title: input.title ?? null,
    sourceType: input.sourceType ?? "agent_builder",
    sourceId: input.sourceId ?? null,
    packageVersion: input.packageVersion ?? null,
    a2aTaskId: input.a2aTaskId ?? null,
    parentRunId: input.parentRunId ?? null,
    // all new runs created via this path have AG-UI SSE capability.
    // This discriminator routes SSE vs. legacy polling.
    agUiEnabled: true,
    timeoutSeconds: input.timeoutSeconds ?? null,
    // org id is required at the store layer; the column is
    // NOT NULL after the DDL migration.
    orgId: input.orgId,
    // nullable project refinement. Persisted here so the
    // run-worker entry can read `run.projectId` and set the inheritance
    // frame before any artifact/object write.
    projectId: input.projectId ?? null,
    // idempotent agent-task dispatch provenance (nullable;
    // only the release-workflows engine populates these).
    idempotencyKey: input.idempotencyKey ?? null,
    workflowId: input.workflowId ?? null,
    workflowTaskId: input.workflowTaskId ?? null,
    // delegated execution-actor snapshot.
    // Persist whatever the caller supplied; the run-worker reads this at
    // re-authz time to reconstruct the originating user's authority.
    delegatedActorSnapshot: input.delegatedActorSnapshot ?? null,
  } as const;

  // Fast path: no idempotency key → plain insert, legacy behavior unchanged.
  if (!input.idempotencyKey) {
    const [row] = await db.insert(agentRuns).values(values).returning();
    return deserializeRun(row);
  }

  // race-safe idempotent insert. The reconciler dispatches
  // agent_task work at-least-once (BullMQ retries + crash recovery), so the
  // SAME (workflowId:taskId:attemptNo) key can arrive on two concurrent
  // workers. The partial-unique index `agent_runs_idempotency_key_uniq`
  // guarantees one child run per key; the loser of the race catches the unique
  // violation (pg 23505), re-reads, and verifies provenance before returning
  // the winning row — a reused or forged key can never alias onto a foreign run.
  try {
    const [row] = await db.insert(agentRuns).values(values).returning();
    return deserializeRun(row);
  } catch (insertErr: unknown) {
    // drizzle-orm wraps the driver error, so the Postgres SQLSTATE may live on
    // `.code` (raw pg error) OR `.cause.code` (DrizzleQueryError wrapper).
    const e = insertErr as { code?: string; cause?: { code?: string } };
    const pgCode = e?.code ?? e?.cause?.code;
    if (pgCode !== "23505") throw insertErr;
    const [existing] = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.idempotencyKey, input.idempotencyKey))
      .limit(1);
    // Violation on a different constraint (e.g. the primary-key `id`) — there is
    // no matching idempotency row to return, so re-surface the original error.
    if (!existing) throw insertErr;
    // Provenance invariants: the existing run MUST belong to the same tenant,
    // template, and workflow task. A mismatch means the key was reused across
    // unrelated runs — fail closed rather than return someone else's run.
    if (
      existing.orgId !== input.orgId ||
      existing.templateId !== input.templateId ||
      existing.workflowId !== (input.workflowId ?? null) ||
      existing.workflowTaskId !== (input.workflowTaskId ?? null)
    ) {
      throw new Error(
        `[createAgentRun] idempotency key collision with mismatched provenance ` +
          `for key "${input.idempotencyKey}" (existing run ${existing.id})`,
      );
    }
    return deserializeRun(existing);
  }
}

export async function updateAgentRunStatus(
  id: string,
  status: string,
  patch?: Partial<AgentRunRecord>,
): Promise<void> {
  // unified terminal-status detection via TERMINAL_RUN_STATUSES
  // (defined below). This was once a local `terminalStatuses` array;
  // unifying prevents drift if a new terminal state is ever added.
  const isTerminal = TERMINAL_RUN_STATUSES.has(status as AgentRunStatus);
  const updates: Partial<typeof agentRuns.$inferInsert> = { status };

  if (isTerminal) {
    updates.completedAt = new Date();
  }

  if (patch?.stepResults !== undefined) {
    updates.stepResults = JSON.stringify(patch.stepResults);
  }
  if (patch?.error !== undefined) {
    updates.error = patch.error;
  }
  if (patch?.startedAt !== undefined) {
    updates.startedAt = patch.startedAt ?? undefined;
  }

  await db.update(agentRuns).set(updates).where(eq(agentRuns.id, id));

  // centralized Redis Streams TTL cleanup. Every terminal
  // transition (completed/failed/stopped) schedules a 1h EXPIRE on the
  // per-run stream key so durable event logs are bounded. Fire-and-forget:
  // a Redis outage must NEVER block terminal status propagation to callers.
  // This is the SINGLE hook for all terminal paths in the agent-builder
  // package — every worker (agentic-execution, execution, langgraph-
  // execution, orchestrator-execution, agentic-resume, resume) and the
  // MCP cancel handler funnel through this function, so new paths inherit
  // TTL scheduling automatically without additional patches.
  if (isTerminal) {
    void expireRunStream(id).catch(() => { /* best-effort */ });
  }
}

// ---------------------------------------------------------------------------
// OTel trace ID setter.
// Called by agentic-execution.ts  after a root span is started.
// Accepts null to explicitly clear the correlation (rare; included for symmetry).
// ---------------------------------------------------------------------------
export async function updateAgentRunTraceId(
  runId: string,
  traceId: string | null,
): Promise<void> {
  await db
    .update(agentRuns)
    .set({ traceId })
    .where(eq(agentRuns.id, runId));
}

/**
 * Atomically transition an agent run's status from a specific expected
 * state to a new state. Returns true if exactly one row was updated
 * (i.e. the previous status matched), false otherwise.
 *
 * This is the compare-and-swap primitive that triggerAgentRun uses to
 * guarantee that two concurrent "Run" clicks cannot both enqueue a job:
 * only the first request whose UPDATE matches `pending_input` succeeds.
 */
export async function updateAgentRunStatusConditional(
  id: string,
  expectedStatus: string,
  nextStatus: string,
): Promise<boolean> {
  const result = await db
    .update(agentRuns)
    .set({ status: nextStatus })
    .where(and(eq(agentRuns.id, id), eq(agentRuns.status, expectedStatus)))
    .returning({ id: agentRuns.id });
  return result.length === 1;
}

// ---------------------------------------------------------------------------
// canonical run-status transition primitive
// ---------------------------------------------------------------------------
//
// transitionRunStatus is the single entry point for every agent_runs.status
// change. It enforces:
//   (1) the from→to edge is one of LEGAL_TRANSITIONS (illegal → throws);
//   (2) the DB row is still in the expected `from` state (stale → throws);
//   (3) terminal-state side-effects fire exactly once (delegates to
//       updateAgentRunStatus, which owns expireRunStream in that helper).
//
// DO NOT call updateAgentRunStatusConditional directly from any other file.
// DO NOT call updateAgentRunStatus for status CHANGES from any other file —
// use transitionRunStatus. updateAgentRunStatus is still the correct call for
// the narrow meta-only case handled by updateAgentRunMeta below.

export type AgentRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "pending_approval"
  | "pending_input"
  | "stopped"
  // gated state for runs whose trigger has not yet released.
  // The pending_input → armed flip pairs with the armed → queued
  // transition fired by the release job to close the loop.
  | "armed"
  // first-step form open, awaiting submit.
  // Transient waiting state; not terminal. Used by the trigger UI to mark
  // a run that the user is actively configuring before it transitions to
  // armed (scheduled/recurring) or queued (immediate).
  | "pending_trigger"
  // IN-FLIGHT WayFlow run paused at a TriggerWaitNode.
  // Distinct from `pending_trigger` (which is the pre-dispatch form-open
  // state). A `waiting_trigger` run has an active a2aContextId held open by
  // the WayFlow worker; the trigger-release-job resumes it by sending an A2A
  // message into that same context (NOT by re-dispatching from start).
  | "waiting_trigger";

export const TERMINAL_RUN_STATUSES: ReadonlySet<AgentRunStatus> = new Set([
  "completed",
  "failed",
  "stopped",
]);

// Derived from exhaustive grep of existing updateAgentRunStatus* callsites
// Transition table includes cancel/reject edges from any live state so
// user-cancel works consistently.
// and <non-terminal>→failed edges so user-cancel works from any live state).
const LEGAL_TRANSITIONS = new Set<`${AgentRunStatus}->${AgentRunStatus}`>([
  // Setup / dispatch
  "pending_input->queued",        // run-actions.ts: triggerAgentRun, createAndTriggerRunCore, startDevChildPreviewRun
  "queued->pending_input",        // run-actions.ts: compensation reverts (x2)
  "queued->pending_approval",     // execution.ts: setup-interrupt loop (per-field + grouped)
  "queued->running",              // execution.ts: dispatch CAS (langgraph + external branches)
  "pending_approval->running",    // langgraph-execution.ts:89 (resume CAS)

  // Running transitions
  "running->pending_approval",    // langgraph-stream-handler: interrupt paths A/B/C
  "running->completed",           // langgraph-execution.ts:253; execution.ts:439 (external proxy)
  "running->failed",              // many — OAS compile, SSE error, timeout, missing lgThreadId, outer catch, etc.
  "running->stopped",             // langgraph-execution.ts: outcome.kind === "stopped_rejected"

  // Early failures from queued
  "queued->failed",               // execution.ts: template not found, snapshot corrupt, orchestrator gate, etc.

  // Successes from paused states (resume terminal-success).
  // A WayFlow run that returns task.status.state === "completed" on resume must
  // transition pending_approval -> completed without an intermediate hop. The
  // multi-gate handler (handleWayflowTaskState in execution.ts) calls
  // transitionRunStatus(runId, "pending_approval", "completed", ...) directly
  // when fromStatus === "pending_approval" and the task state is terminal-success.
  // Without this edge, the helper would throw RunTransitionError code="illegal_transition"
  // (NOT swallowable).
  "pending_approval->completed",  // execution.ts: handleWayflowTaskState (resume terminal-success path)

  // Failures from paused states
  "pending_approval->failed",     // langgraph-resume-handler.ts + actions.ts rejectReviewTask setup-path
  "pending_input->failed",        // actions.ts rejectReviewTask setup-path

  // User-driven resets / resumes
  "failed->pending_input",        // run-actions.ts: resetAgentRun
  "stopped->queued",              // orchestrator-actions.ts: resumeStoppedOrchestratorAction
  "queued->stopped",              // orchestrator-actions.ts:165 (compensation) + mcp/handlers.ts + orchestrator-execution.ts cancel

  // Cancel paths — user-press-Stop must work from any non-terminal state (Pitfall 3)
  "pending_approval->stopped",    // mcp/handlers.ts: agent_run_stop + orchestrator-execution.ts cancel
  "pending_input->stopped",       // mcp/handlers.ts: agent_run_stop

  // gated trigger lifecycle.
  // transitions pending_input → armed when the user submits a
  // scheduled/recurring trigger; the release job transitions
  // armed → queued when the gate opens and then enqueues
  // AGENT_BUILDER_EXECUTION. Cancel/fail edges mirror the pattern used
  // by other gated states.
  "pending_input->armed",         // run-actions.ts:setRunTrigger
  "armed->queued",                // trigger-release-job.ts
  "armed->stopped",               // run-actions.ts:cancelRun  + bulk stop paths
  "armed->failed",                // defensive — failure during arming/release
  "armed->pending_input",         // user removes trigger, returns to setup
  // pending_trigger lifecycle (form-open transient state).
  "pending_input->pending_trigger",   // user opens the trigger form
  "pending_trigger->pending_input",   // user navigates away without submitting
  "pending_trigger->armed",           // form submit with scheduled/recurring fallback
  // TriggerWaitNode pause/resume in-flight WayFlow run.
  // Distinct lifecycle from `armed` (clone-on-tick); `waiting_trigger` resumes
  // the same a2aContextId.
  "running->waiting_trigger",         // execution.ts: WayFlow yielded at TriggerWaitNode
  "waiting_trigger->running",         // trigger-release-job.ts: A2A resume into existing context
  "waiting_trigger->stopped",         // user-press-Stop during the trigger wait
  "waiting_trigger->failed",          // timeout expiry, stale release, or A2A resume failure
]);

// Test-only export: lets transition-coverage.test.ts import the set without
// re-typing it. Named with double-underscore to signal "internal".
export const __LEGAL_TRANSITIONS__: ReadonlySet<string> = LEGAL_TRANSITIONS;

/**
 * Structured error thrown by transitionRunStatus. Callers differentiate via
 * `code`:
 *   - "illegal_transition"  — programmer error; the from→to pair is not in
 *                              LEGAL_TRANSITIONS. Do NOT catch and swallow.
 *   - "stale_from_status"   — race; the DB row changed between read and CAS.
 *                              Usually benign (another worker won); log + continue.
 */
/**
 * thrown when ownership reassignment is attempted on a template
 * that has already been run (first_run_at IS NOT NULL). The pre-run gate is
 * enforced atomically in SQL via WHERE first_run_at IS NULL. Callers (UI,
 * server actions) should catch this and surface a clear error to the user
 * suggesting they uninstall + reinstall to change ownership.
 */
export class CannotReassignAfterFirstRun extends Error {
  readonly code = "CANNOT_REASSIGN_AFTER_FIRST_RUN" as const;
  readonly templateId: string;
  constructor(templateId: string) {
    super(
      `Agent template ${templateId} has been run and cannot be reassigned. ` +
        `Uninstall and reinstall to change ownership.`,
    );
    this.name = "CannotReassignAfterFirstRun";
    this.templateId = templateId;
  }
}

export class RunTransitionError extends Error {
  readonly code: "illegal_transition" | "stale_from_status";
  readonly runId: string;
  readonly from: AgentRunStatus;
  readonly to: AgentRunStatus;

  constructor(args: {
    code: "illegal_transition" | "stale_from_status";
    runId: string;
    from: AgentRunStatus;
    to: AgentRunStatus;
    message?: string;
  }) {
    super(
      args.message ??
        `transitionRunStatus(${args.runId}) ${args.code}: ${args.from} → ${args.to}`,
    );
    this.name = "RunTransitionError";
    this.code = args.code;
    this.runId = args.runId;
    this.from = args.from;
    this.to = args.to;
  }
}

/**
 * single canonical entry point for agent_runs.status changes.
 *
 * @throws {RunTransitionError} code="illegal_transition" when (from, to) ∉ LEGAL_TRANSITIONS
 * @throws {RunTransitionError} code="stale_from_status" when CAS row-count is 0
 */
export async function transitionRunStatus(
  runId: string,
  from: AgentRunStatus,
  to: AgentRunStatus,
  meta?: {
    error?: string;
    startedAt?: Date;
    completedAt?: Date;
    stepResults?: unknown[];
  },
): Promise<void> {
  if (!LEGAL_TRANSITIONS.has(`${from}->${to}` as const)) {
    throw new RunTransitionError({ code: "illegal_transition", runId, from, to });
  }
  const won = await updateAgentRunStatusConditional(runId, from, to);
  if (!won) {
    throw new RunTransitionError({ code: "stale_from_status", runId, from, to });
  }
  // Delegate terminal-state side-effects + meta patching to updateAgentRunStatus.
  // The CAS already wrote the status column; re-writing it here is a no-op that
  // still runs the terminal-detection branch (expireRunStream) and meta-patch
  // logic. Skip the call for non-terminal transitions with no meta (the CAS's
  // single UPDATE was enough).
  if (meta || TERMINAL_RUN_STATUSES.has(to)) {
    await updateAgentRunStatus(runId, to, meta as Partial<AgentRunRecord> | undefined);
  }
}

/**
 * Patch meta columns on an agent run WITHOUT touching status. Used by
 * langgraph-execution.ts:160 where the CAS to "running" already happened
 * one line earlier and we just need to persist startedAt.
 *
 * DO NOT add `status` to the `updates` object here. That's the invariant
 * that distinguishes this from transitionRunStatus — callers of this
 * function MUST be sure the DB status column is already what they want.
 */
export async function updateAgentRunMeta(
  id: string,
  patch: {
    error?: string;
    startedAt?: Date;
    completedAt?: Date;
    stepResults?: unknown[];
  },
): Promise<void> {
  const updates: Partial<typeof agentRuns.$inferInsert> = {};
  if (patch.stepResults !== undefined) {
    updates.stepResults = JSON.stringify(patch.stepResults);
  }
  if (patch.error !== undefined) {
    updates.error = patch.error;
  }
  if (patch.startedAt !== undefined) {
    updates.startedAt = patch.startedAt ?? undefined;
  }
  if (patch.completedAt !== undefined) {
    updates.completedAt = patch.completedAt ?? undefined;
  }
  if (Object.keys(updates).length === 0) return;
  await db.update(agentRuns).set(updates).where(eq(agentRuns.id, id));
}

/**
 * meta-only write of the accumulated external-A2A streamed text.
 *
 * Called EXACTLY ONCE per run by startExternalSseProxyFromStream on the clean
 * completion path (never on timeout or error). DO NOT call from any other site
 * and DO NOT route through updateAgentRunStatus (per the store.ts:980 contract:
 * status changes go through transitionRunStatus; meta-only writes use dedicated
 * helpers like this one and updateAgentRunMeta).
 */
export async function updateAgentRunStreamedText(
  runId: string,
  text: string,
): Promise<void> {
  if (!runId) throw new Error("updateAgentRunStreamedText: runId is required");
  await db
    .update(agentRuns)
    .set({ streamedText: text })
    .where(eq(agentRuns.id, runId));
}

/**
 * Clear failure metadata from a run after a failed → pending_input reset.
 * Clears error, startedAt, completedAt so the next run starts fresh.
 */
export async function clearAgentRunFailureMetadata(id: string): Promise<void> {
  await db
    .update(agentRuns)
    .set({ error: null, startedAt: null, completedAt: null })
    .where(eq(agentRuns.id, id));
}

/**
 * read a single agent_runs row, optionally enforcing
 * AgentAuthPolicy.
 *
 * - When `actor` is omitted, the read is unauthenticated. Internal
 *   worker / scheduler call sites that have no untrusted user input continue to
 *   read freely (they are inside the run's execution context already).
 * - When `actor` is supplied, the run is loaded first and then handed to
 *   `enforceRunAccess(run, actor, "read")`, which throws AuthzError 404 hidden
 *   when the row is null and AuthzError 403 forbidden when the policy denies.
 *
 * Cross-org enforcement is active. AgentRunRecord
 * carries orgId from agent_runs.org_id , and the
 * { ...run, effectivePolicy } spread below threads it into enforceRunAccess.
 * The kernel cross-org guard inside `can` denies non-admin actors whose
 * `actor.organizationId` (sourced from session.activeOrganizationId via
 * ActorRoleHints.actorOrganizationId) differs from `run.orgId`. The owner
 * short-circuit still allows the run owner regardless of actor org.
 */
export async function readAgentRunById(
  id: string,
  actor?: PrimitiveActorContext,
  roles?: ActorRoleHints,
): Promise<AgentRunRecord | null> {
  const [row] = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, id));
  const run = row ? deserializeRun(row) : null;
  if (actor) {
    // Resolve the effective AgentAuthPolicy and pass it through to
    // enforceRunAccess so the policy fields the user configured in the
    // Permissions tab actually gate access (not just live as decorative UI).
    // Falls back to template.agentAuthPolicy and then DEFAULT_AGENT_AUTH_POLICY
    // — exactly matching the resolution order PermissionsScreen uses for the
    // surfaced "source: run-override / template-default" badge.
    //
    // Use the shared resolveEffectivePolicy helper so
    // a future change to the resolution order (e.g. workspace-default tier
    // in that helper) only needs to land in one place.
    let effectivePolicy: AgentAuthPolicy | null = null;
    let coOwnerUserIds: string[] | undefined;
    if (run) {
      if (run.authPolicy) {
        effectivePolicy = run.authPolicy;
      } else {
        const template = await readAgentTemplateById(run.templateId);
        effectivePolicy = resolveEffectivePolicy(run, template);
      }
      // Load run_co_owners and thread the userId
      // list into the access probe so enforceRunAccess' co-owner branch
      // actually fires in production. Without this, every co-owner row
      // written via the new RunSharingPanel produced zero downstream
      // authorization effect — the co-owner could not read, resume, or
      // approve HITL on the shared run because run.coOwnerUserIds was
      // structurally undefined at the enforceRunAccess boundary.
      const coOwnerRows = await readRunCoOwners(run.id);
      coOwnerUserIds = coOwnerRows.map((r) => r.userId);
    }
    // enforceRunAccess handles run=null by throwing AuthzError(404, "hidden")
    // so callers get the locked 404-on-missing semantics.
    // Forward roles into enforceRunAccess so admin
    // role hints resolved by the MCP handler bridge actually reach the kernel.
    await enforceRunAccess(
      run ? { ...run, effectivePolicy, coOwnerUserIds } : run,
      actor,
      "read",
      roles,
    );
  }
  return run;
}

export type ReadAgentRunsByTemplateOptions = {
  status?: string;              // filter by run status
  actorUserId?: string | null;  // when set, returns ONLY runs owned by this actor
  limit?: number;               // default 50, max 200
  offset?: number;              // default 0
  // when supplied, the result set is post-filtered per-row against
  // each row's effective AgentAuthPolicy. List-level upfront probe is NOT
  // applied. Throws nothing at the
  // list layer; rows the actor cannot read are silently filtered out.
  actor?: PrimitiveActorContext;
  // resolved role hints from the call site's session
  // lookup. Forwarded into the per-row enforceRunAccess so admin role hints
  // resolved by the MCP handler bridge actually reach the kernel + policy gate.
  roles?: ActorRoleHints;
  // Organization filter
  organizationId?: string;
  // Admin cross-org marker.
  skipOrgFilter?: boolean;
};

export async function readAgentRunsByTemplate(
  templateId: string,
  opts: ReadAgentRunsByTemplateOptions = {},
): Promise<ListPage<AgentRunRecord>> {
  // The previous list-level probe was
  //   { id: templateId, runBy: null, orgId: null }
  // and the owner short-circuit (`run.runBy && run.runBy === actor.userId`)
  // could never fire on it because runBy was null by design. Falling through
  // to can denied every authenticated user — no MCP user could list runs,
  // even for templates they owned. Removed the upfront probe entirely.
  // Authorization is enforced per-row by the post-filter loop further down,
  // where each row carries a real `runBy` so the owner short-circuit fires
  // correctly. The post-filter is the only gate; rows the actor cannot read
  // are silently filtered out (matches the "list returns rows you can read"
  // UX promise).

  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;

  const conditions = [eq(agentRuns.templateId, templateId)];
  if (opts.status) conditions.push(eq(agentRuns.status, opts.status));
  if (opts.actorUserId) conditions.push(eq(agentRuns.runBy, opts.actorUserId));
  // Org-scope filter; handlers with platform_admin set skipOrgFilter=true.
  if (opts.organizationId && !opts.skipOrgFilter) {
    conditions.push(eq(agentRuns.orgId, opts.organizationId));
  }

  const where = and(...conditions);

  // Order by createdAt DESC for strict newest-first ordering (added createdAt column).
  // Falls back to id DESC as a tiebreaker for runs inserted in the same millisecond.
  const [countResult, rows] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(agentRuns).where(where),
    db.select().from(agentRuns).where(where)
      .orderBy(desc(agentRuns.createdAt), sql`id DESC`)
      .limit(limit).offset(offset),
  ]);

  const total = countResult[0]?.count ?? 0;
  let items = rows.map(deserializeRun);
  // Defense-in-depth post-filter. See readAgentRuns / readAgentTemplates.
  if (opts.organizationId && !opts.skipOrgFilter) {
    items = items.filter((r) => r.orgId === opts.organizationId);
  }

  // Post-filter the result set against the per-row policy when an
  // actor is supplied. For each row, ask enforceRunAccess(run, actor, "list")
  // with the row's effective policy resolved from
  // run.authPolicy ?? template.agentAuthPolicy ?? DEFAULT_AGENT_AUTH_POLICY.
  // Allowed rows are returned; denied rows are silently filtered out
  // (matching the "list returns rows you can read" UX promise).
  //
  // NOTE: this changes the .total field semantics — it remains the unfiltered
  // count from the DB so pagination math stays consistent across pages with
  // mixed policies. A future phase that needs accurate filtered counts should
  // push this filter into SQL.
  if (opts.actor) {
    // Resolve template policy ONCE for the whole page (most rows share the
    // template's default). Uses shared resolveEffectivePolicy helper.
    const template = await readAgentTemplateById(templateId);
    const filtered: AgentRunRecord[] = [];
    for (const run of items) {
      const effectivePolicy = resolveEffectivePolicy(run, template);
      // Load co-owners per row so the co-owner
      // branch of enforceRunAccess actually fires on the list path.
      // Without this, a user shared into a run via the RunSharingPanel
      // could not see that run on a list call. Per-row read is acceptable
      // for the initial implementation; future optimization can issue a single IN-list query.
      const coOwnerRows = await readRunCoOwners(run.id);
      const coOwnerUserIds = coOwnerRows.map((r) => r.userId);
      try {
        // Forward roles into per-row enforceRunAccess
        // so admin role hints reach the kernel + policy gate.
        // Thread per-row orgId so the kernel cross-org
        // guard fires on this list path. Earlier implementations hardcoded null because
        // AgentRunRecord did not carry orgId.
        await enforceRunAccess(
          {
            id: run.id,
            runBy: run.runBy,
            orgId: run.orgId,
            effectivePolicy,
            coOwnerUserIds,
          },
          opts.actor,
          "list",
          opts.roles,
        );
        filtered.push(run);
      } catch {
        // Silent filter — denied rows are not surfaced.
      }
    }
    return buildListPage(filtered, total, offset, limit);
  }

  return buildListPage(items, total, offset, limit);
}

// ---------------------------------------------------------------------------
// raw variant of readAgentRunsByTemplate.
// Returns rows without per-row enforceRunAccess so the MCP handler can
// iterate + enforce explicitly with empty-list semantics (drop denied rows
// instead of propagating errors). The handler is responsible for calling
// enforceRunAccess and emitting denial audit-events per row.
// ---------------------------------------------------------------------------
export type ReadAgentRunsByTemplateRawOptions = {
  status?: string;
  limit?: number;
  offset?: number;
  organizationId?: string;
  skipOrgFilter?: boolean;
  // sealed-room read filter. When the
  // resolved value (via sealedRoomFilterValue) is non-null, the WHERE
  // adds `AND agent_runs.project_id = $projectId`. The handler is
  // responsible for the assertProjectReadAccess gate; this option is
  // the SQL-data-layer half.
  projectId?: string | null;
};

export async function readAgentRunsByTemplateRaw(
  templateId: string,
  opts: ReadAgentRunsByTemplateRawOptions = {},
): Promise<{ items: AgentRunRecord[]; total: number }> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;

  const conditions = [eq(agentRuns.templateId, templateId)];
  if (opts.status) conditions.push(eq(agentRuns.status, opts.status));
  if (opts.organizationId && !opts.skipOrgFilter) {
    conditions.push(eq(agentRuns.orgId, opts.organizationId));
  }
  // sealed-room project filter. sealedRoomFilterValue
  // returns null when ambient OR when the per-table feature flag
  // (CINATRA_SEALED_ROOM_AGENT_RUNS) is OFF.
  const effectiveProjectId = sealedRoomFilterValue("agent_runs", opts.projectId);
  if (effectiveProjectId !== null) {
    conditions.push(eq(agentRuns.projectId, effectiveProjectId));
  }

  const where = and(...conditions);

  const [countResult, rows] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(agentRuns).where(where),
    db.select().from(agentRuns).where(where)
      .orderBy(desc(agentRuns.createdAt), sql`id DESC`)
      .limit(limit).offset(offset),
  ]);

  const total = countResult[0]?.count ?? 0;
  let items = rows.map(deserializeRun);
  // Defense-in-depth org filter (mirrors readAgentRunsByTemplate behavior).
  if (opts.organizationId && !opts.skipOrgFilter) {
    items = items.filter((r) => r.orgId === opts.organizationId);
  }

  return { items, total };
}

function deserializeRun(row: typeof agentRuns.$inferSelect): AgentRunRecord {
  return {
    id: row.id,
    templateId: row.templateId,
    versionId: row.versionId,
    runBy: row.runBy,
    status: row.status,
    inputParams: JSON.parse(row.inputParams) as Record<string, unknown>,
    stepResults: row.stepResults ? (JSON.parse(row.stepResults) as unknown[]) : null,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    error: row.error,
    title: row.title,
    createdAt: row.createdAt,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    packageVersion: row.packageVersion ?? null,
    a2aTaskId: row.a2aTaskId ?? null,
    a2aContextId: row.a2aContextId ?? null,
    parentRunId: row.parentRunId ?? null,
    agUiEnabled: row.agUiEnabled ?? null,
    lgThreadId: row.lgThreadId ?? null,
    traceId: row.traceId ?? null,
    timeoutSeconds: row.timeoutSeconds ?? null,
    streamedText: row.streamedText ?? null,
    // per-run override; null when not set.
    // Defensive parse — see parseAuthPolicySafe definition above.
    authPolicy: parseAuthPolicySafe(row.authPolicy ?? null),
    // orgId from agent_runs.org_id; column is NOT NULL after the
    // DDL migration.
    orgId: row.orgId,
    // nullable project refinement (
    // DDL). Drizzle returns the typed column directly.
    projectId: row.projectId ?? null,
    // idempotent agent-task dispatch provenance.
    idempotencyKey: row.idempotencyKey ?? null,
    workflowId: row.workflowId ?? null,
    workflowTaskId: row.workflowTaskId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Global run list (templateId optional)
// ---------------------------------------------------------------------------

export type ReadAgentRunsOptions = {
  templateId?: string;
  templateIds?: string[];
  status?: string;
  sourceType?: string;
  limit?: number;
  offset?: number;
  // Organization filter
  organizationId?: string;
  // Admin cross-org marker.
  skipOrgFilter?: boolean;
  // sealed-room read filter. When the
  // resolved value (via sealedRoomFilterValue) is non-null, the WHERE
  // adds `AND agent_runs.project_id = $projectId`. Handler-side
  // assertProjectReadAccess gates upstream.
  projectId?: string | null;
};

export async function readAgentRuns(
  opts: ReadAgentRunsOptions = {},
): Promise<ListPage<AgentRunRecord>> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;

  const conditions: SQL[] = [];
  // templateIds takes precedence over templateId
  if (opts.templateIds && opts.templateIds.length > 0) {
    conditions.push(inArray(agentRuns.templateId, opts.templateIds));
  } else if (opts.templateId) {
    conditions.push(eq(agentRuns.templateId, opts.templateId));
  }
  if (opts.status) conditions.push(eq(agentRuns.status, opts.status));
  if (opts.sourceType) conditions.push(eq(agentRuns.sourceType, opts.sourceType));
  // Org-scope filter; handlers with platform_admin set skipOrgFilter=true.
  if (opts.organizationId && !opts.skipOrgFilter) {
    conditions.push(eq(agentRuns.orgId, opts.organizationId));
  }
  // sealed-room project filter. Returns null when
  // ambient OR when CINATRA_SEALED_ROOM_AGENT_RUNS is OFF.
  const effectiveProjectId = sealedRoomFilterValue("agent_runs", opts.projectId);
  if (effectiveProjectId !== null) {
    conditions.push(eq(agentRuns.projectId, effectiveProjectId));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [countResult, rows] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(agentRuns).where(where),
    db.select().from(agentRuns).where(where)
      .orderBy(desc(agentRuns.createdAt), sql`id DESC`)
      .limit(limit).offset(offset),
  ]);

  const total = countResult[0]?.count ?? 0;
  let items = rows.map(deserializeRun);
  // Defense-in-depth post-filter. See readAgentTemplates
  // for rationale; this re-asserts the contract on deserialized records.
  if (opts.organizationId && !opts.skipOrgFilter) {
    items = items.filter((r) => r.orgId === opts.organizationId);
  }
  return buildListPage(items, total, offset, limit);
}

// ---------------------------------------------------------------------------
// Bulk stop
// ---------------------------------------------------------------------------

export type BulkStopResult = {
  stopped: number;
  alreadyTerminal: number;
  total: number;
};

/** Stop all active runs matching the given IDs. Returns stopped/alreadyTerminal counts. */
export async function bulkStopAgentRuns(runIds: string[]): Promise<BulkStopResult> {
  if (runIds.length === 0) return { stopped: 0, alreadyTerminal: 0, total: 0 };

  const activeStatuses = ["queued", "running", "pending_approval", "pending_input"];
  const rows = await db.select({ id: agentRuns.id, status: agentRuns.status })
    .from(agentRuns)
    .where(inArray(agentRuns.id, runIds));

  const toStop = rows.filter((r) => activeStatuses.includes(r.status)).map((r) => r.id);
  const alreadyTerminal = rows.length - toStop.length;

  if (toStop.length > 0) {
    await db.update(agentRuns)
      .set({ status: "stopped", completedAt: new Date() })
      .where(inArray(agentRuns.id, toStop));
    // compatibility — fire expireRunStream for each stopped run so
    // Redis Streams TTL cleanup applies to bulk-stopped runs the same as
    // single-stop runs routed through updateAgentRunStatus.
    for (const id of toStop) {
      void expireRunStream(id).catch(() => { /* best-effort */ });
    }
  }

  return { stopped: toStop.length, alreadyTerminal, total: rows.length };
}

/** Stop all active runs for a given template. Returns stopped/alreadyTerminal counts. */
export async function bulkStopAgentRunsByTemplate(templateId: string): Promise<BulkStopResult> {
  const activeStatuses = ["queued", "running", "pending_approval", "pending_input"];
  const rows = await db.select({ id: agentRuns.id, status: agentRuns.status })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.templateId, templateId),
        inArray(agentRuns.status, activeStatuses),
      ),
    );

  if (rows.length === 0) return { stopped: 0, alreadyTerminal: 0, total: 0 };

  const ids = rows.map((r) => r.id);
  await db.update(agentRuns)
    .set({ status: "stopped", completedAt: new Date() })
    .where(inArray(agentRuns.id, ids));
  // compatibility — fire expireRunStream for each stopped run.
  for (const id of ids) {
    void expireRunStream(id).catch(() => { /* best-effort */ });
  }

  return { stopped: rows.length, alreadyTerminal: 0, total: rows.length };
}

/**
 * Fetch all direct children of an orchestrator run.
 *
 * Returns agent_runs rows whose parent_run_id equals parentRunId, ordered by
 * createdAt ASC (oldest first — orchestrator UIs typically render children in
 * dispatch order). Returns [] when no children exist.
 *
 * Security: this is a read-only surface. Callers must apply the same
 * runBy/org scoping they apply to readAgentRunById.
 */
export async function readAgentRunsByParent(
  parentRunId: string,
): Promise<AgentRunRecord[]> {
  if (!parentRunId) return [];
  const rows = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.parentRunId, parentRunId))
    .orderBy(asc(agentRuns.createdAt));
  return rows.map(deserializeRun);
}

/**
 * Persist the A2A taskId for a run created by InProcessAgentExecutor.execute.
 *
 * UNCONDITIONAL OVERWRITE (was first-writer-wins via WHERE a2a_task_id IS NULL).
 * The multi-gate handler (handleWayflowTaskState) needs to resync the task ID after every
 * WayFlow response because WayFlow may assign a new task ID on resume. Without this change
 * the resync no-ops on every call after the first and the next reverse-lookup by a2aTaskId
 * fails.
 *
 * Cross-row collisions are still prevented by the unique partial index on a2a_task_id;
 * the only behavior change is that the SAME row is permitted to overwrite its own value.
 */
export async function updateAgentRunA2ATaskId(
  runId: string,
  taskId: string,
): Promise<void> {
  if (!runId || !taskId) {
    throw new Error("updateAgentRunA2ATaskId: runId and taskId are required");
  }
  // retry on `tuple concurrently updated`. A multi-gate
  // WayFlow flow overwrites this column once per gate from
  // `handleWayflowTaskState`, which runs in the BullMQ worker AT THE SAME
  // TIME the worker is transitioning run.status on the same row. The
  // concurrent UPDATEs collide and Postgres aborts one with
  // `tuple concurrently updated` (a transient, retry-safe executor error).
  // The caller wraps this in `.catch( => undefined)`, so without an
  // internal retry the column silently stays stale — and the NEXT gate's
  // approval reverse-lookup by a2a_task_id misses. The Redis reverse-map
  // (resolveRunIdByWayflowTaskId) is the authoritative fallback; this
  // retry just keeps the DB column accurate too.
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await db
        .update(agentRuns)
        .set({ a2aTaskId: taskId })
        .where(eq(agentRuns.id, runId));
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isConcurrentUpdate = msg.includes("tuple concurrently updated");
      if (!isConcurrentUpdate || attempt === MAX_ATTEMPTS) throw err;
      // Small jittered backoff so the colliding txn commits first.
      await new Promise((r) => setTimeout(r, 25 * attempt + Math.random() * 25));
    }
  }
}

/**
 * Persist the fasta2a contextId for a WayFlow run. The context ID
 * is needed to resume an input-required task: a new message sent into the SAME
 * contextId continues the existing conversation rather than starting fresh.
 */
export async function updateAgentRunA2AContextId(
  runId: string,
  contextId: string,
): Promise<void> {
  if (!runId || !contextId) return;
  await db
    .update(agentRuns)
    .set({ a2aContextId: contextId })
    .where(eq(agentRuns.id, runId));
}

/**
 * Look up a run by its A2A taskId. Returns null for unknown taskIds.
 * Backed by the unique partial index `agent_runs_a2a_task_id_idx`.
 */
export async function readAgentRunByTaskId(
  taskId: string,
): Promise<AgentRunRecord | null> {
  if (!taskId) return null;
  const [row] = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.a2aTaskId, taskId))
    .limit(1);
  return row ? deserializeRun(row) : null;
}

export async function readAgentRunByContextId(
  contextId: string,
): Promise<AgentRunRecord | null> {
  if (!contextId) return null;
  const [row] = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.a2aContextId, contextId))
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  return row ? deserializeRun(row) : null;
}

/**
 * Update the user-given title for an agent run.
 * Used by run-name-actions.ts and by legacy-agent adapters .
 */
export async function updateAgentRunTitle(
  id: string,
  title: string,
): Promise<void> {
  await db
    .update(agentRuns)
    .set({ title })
    .where(eq(agentRuns.id, id));
}

/**
 * update the per-run authPolicy override on agent_runs.auth_policy.
 * Pass `null` to clear the override (causes downstream readers to fall back to
 * the template's agentAuthPolicy or DEFAULT_AGENT_AUTH_POLICY).
 *
 * Authorization is the caller's responsibility. The server action
 * (`saveRunAuthPolicy` in permissions-actions.ts) gates this call with a
 * session check + ownership/admin check before invoking — mirroring the
 * existing pattern of updateAgentRunTitle. Store functions are dumb writers;
 * server actions own authz.
 */
export async function updateAgentRunAuthPolicy(
  id: string,
  policy: AgentAuthPolicy | null,
): Promise<void> {
  await db
    .update(agentRuns)
    .set({ authPolicy: policy ? JSON.stringify(policy) : null })
    .where(eq(agentRuns.id, id));
}

// ---------------------------------------------------------------------------
// run_co_owners DAO. addRunCoOwner uses ON CONFLICT DO NOTHING
// for atomic idempotency (the composite PK enforces uniqueness; double-add is
// a no-op rather than an error).
// ---------------------------------------------------------------------------

export type RunCoOwnerRecord = {
  runId: string;
  userId: string;
  grantedBy: string;
  grantedAt: Date;
};

export async function readRunCoOwners(runId: string): Promise<RunCoOwnerRecord[]> {
  const rows = await db
    .select()
    .from(runCoOwners)
    .where(eq(runCoOwners.runId, runId))
    .orderBy(asc(runCoOwners.grantedAt));
  return rows;
}

/**
 * single resolver for the run.coOwnerUserIds branch
 * required by enforceRunAccess. Centralises the readRunCoOwners → userId
 * extraction + dedup used before calling the policy
 * kernel from MCP handlers.
 *
 * Returns dedup list preserving first-seen order. Empty list when no
 * co-owners exist (caller MUST still pass coOwnerUserIds: [] explicitly
 * — undefined is the "skip the branch" sentinel in auth-policy.ts).
 */
export async function resolveRunCoOwnerUserIds(runId: string): Promise<string[]> {
  const rows = await readRunCoOwners(runId);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    if (!seen.has(r.userId)) {
      seen.add(r.userId);
      out.push(r.userId);
    }
  }
  return out;
}

export async function addRunCoOwner(
  runId: string,
  userId: string,
  grantedBy: string,
): Promise<void> {
  await db
    .insert(runCoOwners)
    .values({ runId, userId, grantedBy })
    .onConflictDoNothing();
}

export async function removeRunCoOwner(
  runId: string,
  userId: string,
): Promise<void> {
  await db
    .delete(runCoOwners)
    .where(and(eq(runCoOwners.runId, runId), eq(runCoOwners.userId, userId)));
}

/**
 * Clear the original run owner. Used when the owner removes themselves from
 * the ownership list (only allowed if at least one co-owner remains, enforced
 * by the server action).
 */
export async function clearRunRunBy(runId: string): Promise<void> {
  await db
    .update(agentRuns)
    .set({ runBy: null })
    .where(eq(agentRuns.id, runId));
}

/**
 * Find all agent_runs for a given source type and source config ID.
 * Used by legacy agent packages (scrape, research, enrichment) to query their runs.
 * Orders by createdAt DESC for deterministic newest-first ordering.
 */
export async function readAgentRunsBySourceId(
  sourceType: string,
  sourceId: string,
  limit = 50,
): Promise<AgentRunRecord[]> {
  const rows = await db
    .select()
    .from(agentRuns)
    .where(and(
      eq(agentRuns.sourceType, sourceType),
      eq(agentRuns.sourceId, sourceId),
    ))
    .orderBy(desc(agentRuns.createdAt))
    .limit(limit);
  return rows.map(deserializeRun);
}

/**
 * Find the most recent agent_run for a source type + source ID.
 * Used by stop/cancel to find the running run.
 * Orders by createdAt DESC for deterministic "most recent" ordering.
 */
export async function findMostRecentRunBySource(
  sourceType: string,
  sourceId: string,
): Promise<AgentRunRecord | null> {
  const rows = await db
    .select()
    .from(agentRuns)
    .where(and(
      eq(agentRuns.sourceType, sourceType),
      eq(agentRuns.sourceId, sourceId),
    ))
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  if (rows.length === 0) return null;
  return deserializeRun(rows[0]);
}

// ---------------------------------------------------------------------------
// Domain types — audit_events
// ---------------------------------------------------------------------------

export type AuditEventRecord = {
  id: string;
  reviewTaskId: string;
  actorId: string;
  eventType: string;
  payload: string | null;
  createdAt: Date;
};

export type CreateAuditEventInput = Omit<AuditEventRecord, "id" | "createdAt">;

// ---------------------------------------------------------------------------
// Note: there are no planned_actions / review_tasks CRUD functions.
// Tables dropped; synthetic IDs ("setup-{runId}", "lg-{runId}") replace DB rows.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CRUD — audit_events
// ---------------------------------------------------------------------------

export async function createAuditEvent(
  input: CreateAuditEventInput,
): Promise<AuditEventRecord> {
  const id = randomUUID();
  await db.insert(auditEvents).values({
    id,
    reviewTaskId: input.reviewTaskId,
    actorId: input.actorId,
    eventType: input.eventType,
    payload: input.payload ?? null,
  });
  const rows = await db.select().from(auditEvents).where(eq(auditEvents.id, id)).limit(1);
  return rows[0];
}

export async function readAuditEventsByReviewTask(
  reviewTaskId: string,
): Promise<AuditEventRecord[]> {
  return db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.reviewTaskId, reviewTaskId))
    .orderBy(auditEvents.createdAt);
}

// ---------------------------------------------------------------------------
// agent_run_hitl_prompts — WayFlow HITL prompt capture
// ---------------------------------------------------------------------------

export type WriteHitlPromptInput = {
  runId: string;
  agentId: string;
  stepKey: string;
  message: string;
  submittedValues?: Record<string, unknown> | null;   //
  schemaSnapshot?: Record<string, unknown> | null;
  excluded?: boolean;                                  // Pattern 4(b): bare-approval rows pass true so autosave skips them
};

export async function writeHitlPrompt(input: WriteHitlPromptInput): Promise<void> {
  if (input.message.length > 32_768) {
    throw new Error(`[writeHitlPrompt] message too large (${input.message.length} chars)`);
  }
  if (input.schemaSnapshot !== null && input.schemaSnapshot !== undefined) {
    const snap = JSON.stringify(input.schemaSnapshot);
    if (snap.length > 32_768) {
      console.warn(
        `[writeHitlPrompt] schemaSnapshot too large (${snap.length} bytes), storing null`,
      );
      input = { ...input, schemaSnapshot: null };
    }
  }
  await db.insert(agentRunHitlPrompts).values({
    id: randomUUID(),
    runId: input.runId,
    agentId: input.agentId,
    stepKey: input.stepKey,
    message: input.message,
    submittedValues: input.submittedValues ?? null,   //
    schemaSnapshot: input.schemaSnapshot ?? null,
    excluded: input.excluded ?? false,                //
  });
}

export type HitlPromptRecord = {
  id: string;
  runId: string;
  agentId: string;
  stepKey: string;
  message: string;
  capturedAt: Date;
  excluded: boolean;
  submittedValues: Record<string, unknown> | null;   //
  schemaSnapshot: Record<string, unknown> | null;
};

/**
 * Reads all non-excluded HITL amendment prompts for a run, scoped to a specific agent.
 *
 * @param runId   - The agent_runs.id of the run.
 * @param agentId - The template's `packageName` (e.g. "@cinatra-ai/email-outreach-agent").
 *                  Must match the value stored at write time via writeHitlPrompt.
 */
export async function updateHitlPromptExcluded(id: string, excluded: boolean): Promise<void> {
  await db
    .update(agentRunHitlPrompts)
    .set({ excluded })
    .where(eq(agentRunHitlPrompts.id, id));
}

export async function readHitlPromptsForRun(
  runId: string,
  agentId: string,
): Promise<HitlPromptRecord[]> {
  return db
    .select()
    .from(agentRunHitlPrompts)
    .where(
      and(
        eq(agentRunHitlPrompts.runId, runId),
        eq(agentRunHitlPrompts.agentId, agentId),
        eq(agentRunHitlPrompts.excluded, false),
      ),
    )
    .orderBy(agentRunHitlPrompts.capturedAt);
}

// ---------------------------------------------------------------------------
// sibling read: NO excluded filter. Submission-map builder needs
// every gate row in capture order so row-order alignment with approvalPolicy
// gates survives Pattern 4(b) (bare-approval rows flagged excluded=true).
// readHitlPromptsForRun (excluded=false filter) stays unchanged for autosave.
// ---------------------------------------------------------------------------
export async function readAllHitlPromptsForRun(
  runId: string,
  agentId: string,
): Promise<HitlPromptRecord[]> {
  return db
    .select()
    .from(agentRunHitlPrompts)
    .where(
      and(
        eq(agentRunHitlPrompts.runId, runId),
        eq(agentRunHitlPrompts.agentId, agentId),
      ),
    )
    .orderBy(agentRunHitlPrompts.capturedAt);
}

/**
 * returns the distinct set of agent_id values for a run's
 * non-excluded captured HITL prompts. Used by the autosave-on-completion path
 * (`runSkillAutosaveOnRunCompletion` in `./skill-autosave`) to fan out one
 * personal-skill generation per distinct leaf agent.
 *
 * v1 "distinct leaf" semantics: distinct values of `agent_id` as captured
 * by `writeHitlPrompt`. For flat WayFlow runs this is one value (the run's
 * own template.packageName). For composed orchestrator runs the captured
 * agent_id is whatever the paused run's template.packageName was at gate
   * time, preserving distinct child-agent capture.
 *
 * @param runId - The agent_runs.id of the run.
 * @returns      Distinct agent_id values, ordered ascending. Empty array if none.
 */
export async function readNonExcludedAgentIdsForRun(runId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ agentId: agentRunHitlPrompts.agentId })
    .from(agentRunHitlPrompts)
    .where(
      and(
        eq(agentRunHitlPrompts.runId, runId),
        eq(agentRunHitlPrompts.excluded, false),
      ),
    );
  return rows.map((r) => r.agentId).sort();
}

// ---------------------------------------------------------------------------
// Note: readReviewTasksByRunId, readPlannedActionByRunAndStep,
// updatePlannedActionProvenance are absent because those tables were dropped.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// HITL context helpers — composed agent HITL bubbling
// ---------------------------------------------------------------------------

export type ChildRunHitlContext = {
  xRenderer: string | null;
  inputSchema: Record<string, unknown> | null;
  childRunId: string;
  currentValues: Record<string, unknown> | null;
};

/**
 * Reads the HITL context for a child run: extracts the first x-renderer value
 * found in the child run's inputSchema and reads the current inputParams as
 * currentValues. Returns null when the run does not exist.
 */
export async function readChildRunHitlContext(
  runId: string,
): Promise<ChildRunHitlContext | null> {
  const run = await readAgentRunById(runId);
  if (!run) return null;

  // Parse the child template's inputSchema to find x-renderer values.
  // inputSchema is stored as a JSON object on AgentRunRecord — for child runs
  // started by invokeAgentAsTool, this is the template.inputSchema.
  // We need to look it up from the template.
  const [templateRows] = await db
    .select({ inputSchema: agentTemplates.inputSchema })
    .from(agentTemplates)
    .where(eq(agentTemplates.id, run.templateId))
    .limit(1);

  let parsedSchema: Record<string, unknown> | null = null;
  let xRenderer: string | null = null;

  if (templateRows?.inputSchema) {
    try {
      parsedSchema = JSON.parse(templateRows.inputSchema) as Record<string, unknown>;
      // Scan properties for x-renderer annotation
      const props = (parsedSchema?.properties ?? {}) as Record<string, Record<string, unknown>>;
      for (const propSchema of Object.values(props)) {
        const hint = propSchema?.["x-renderer"];
        if (typeof hint === "string") {
          xRenderer = hint;
          break; // Use first renderer found — composed HITL typically has one gate
        }
      }
    } catch {
      // Malformed JSON — ignore
    }
  }

  return {
    xRenderer,
    inputSchema: parsedSchema,
    childRunId: runId,
    currentValues:
      run.inputParams && typeof run.inputParams === "object"
        ? (run.inputParams as Record<string, unknown>)
        : null,
  };
}

// ---------------------------------------------------------------------------
// Additional version readers (needed by registry actions)
// ---------------------------------------------------------------------------

export async function readAgentVersionById(
  id: string,
): Promise<AgentVersionRecord | null> {
  const rows = await db
    .select()
    .from(agentVersions)
    .where(eq(agentVersions.id, id))
    .limit(1);
  if (!rows[0]) return null;
  const row = rows[0];
  return {
    id: row.id,
    templateId: row.templateId,
    versionNumber: row.versionNumber,
    contentHash: row.contentHash,
    snapshot: JSON.parse(row.snapshot) as Record<string, unknown>,
    createdAt: row.createdAt,
  };
}

export async function readAgentVersionsByTemplate(
  templateId: string,
): Promise<AgentVersionRecord[]> {
  const rows = await db
    .select()
    .from(agentVersions)
    .where(eq(agentVersions.templateId, templateId))
    .orderBy(desc(agentVersions.createdAt));
  return rows.map((row) => ({
    id: row.id,
    templateId: row.templateId,
    versionNumber: row.versionNumber,
    contentHash: row.contentHash,
    snapshot: JSON.parse(row.snapshot) as Record<string, unknown>,
    createdAt: row.createdAt,
  }));
}

// ---------------------------------------------------------------------------
// Domain types — agent_registry_entries
// ---------------------------------------------------------------------------

export type RegistryEntryRecord = {
  id: string;
  templateId: string;
  versionId: string;
  orgId: string;
  publishedBy: string;
  semver: string;
  title: string;
  description: string | null;
  toolAccess: string[];          // parsed from JSON on read
  riskLevel: string;
  hasApprovalGates: boolean;
  changelog: string | null;
  status: string;
  createdAt: Date;
};

export type CreateRegistryEntryInput = Omit<RegistryEntryRecord, "id" | "createdAt" | "toolAccess"> & {
  toolAccess: string[];           // store serializes to JSON
};

export type ShareBindingRecord = {
  id: string;
  registryEntryId: string;
  subjectType: string;
  subjectId: string;
  canView: boolean;
  canRun: boolean;
  canEditDraft: boolean;
  canPublish: boolean;
  canApprove: boolean;
  grantedBy: string;
  createdAt: Date;
};

export type CreateShareBindingInput = Omit<ShareBindingRecord, "id" | "createdAt">;

export type AgentForkRecord = {
  id: string;
  registryEntryId: string;
  forkedTemplateId: string;
  forkedBy: string;
  createdAt: Date;
};

export type CreateAgentForkInput = Omit<AgentForkRecord, "id" | "createdAt">;

// ---------------------------------------------------------------------------
// CRUD — agent_registry_entries
// ---------------------------------------------------------------------------

function deserializeRegistryEntry(row: typeof agentRegistryEntries.$inferSelect): RegistryEntryRecord {
  return {
    id: row.id,
    templateId: row.templateId,
    versionId: row.versionId,
    orgId: row.orgId,
    publishedBy: row.publishedBy,
    semver: row.semver,
    title: row.title,
    description: row.description,
    toolAccess: JSON.parse(row.toolAccess) as string[],
    riskLevel: row.riskLevel,
    hasApprovalGates: row.hasApprovalGates,
    changelog: row.changelog,
    status: row.status,
    createdAt: row.createdAt,
  };
}

export async function createRegistryEntry(
  input: CreateRegistryEntryInput,
): Promise<RegistryEntryRecord> {
  const id = randomUUID();
  await db.insert(agentRegistryEntries).values({
    id,
    templateId: input.templateId,
    versionId: input.versionId,
    orgId: input.orgId,
    publishedBy: input.publishedBy,
    semver: input.semver,
    title: input.title,
    description: input.description ?? null,
    toolAccess: JSON.stringify(input.toolAccess),
    riskLevel: input.riskLevel,
    hasApprovalGates: input.hasApprovalGates,
    changelog: input.changelog ?? null,
    status: input.status,
  });
  const rows = await db
    .select()
    .from(agentRegistryEntries)
    .where(eq(agentRegistryEntries.id, id))
    .limit(1);
  return deserializeRegistryEntry(rows[0]);
}

export async function readRegistryEntries(orgId: string): Promise<RegistryEntryRecord[]> {
  const rows = await db
    .select()
    .from(agentRegistryEntries)
    .where(and(eq(agentRegistryEntries.orgId, orgId), inArray(agentRegistryEntries.status, ["active", "published"])))
    .orderBy(desc(agentRegistryEntries.createdAt));
  return rows.map(deserializeRegistryEntry);
}

export async function readAllRegistryEntries(): Promise<RegistryEntryRecord[]> {
  const rows = await db
    .select()
    .from(agentRegistryEntries)
    .where(inArray(agentRegistryEntries.status, ["active", "published"]))
    .orderBy(desc(agentRegistryEntries.createdAt));
  return rows.map(deserializeRegistryEntry);
}

export async function readRegistryEntryById(
  id: string,
): Promise<RegistryEntryRecord | null> {
  const rows = await db
    .select()
    .from(agentRegistryEntries)
    .where(eq(agentRegistryEntries.id, id))
    .limit(1);
  return rows[0] ? deserializeRegistryEntry(rows[0]) : null;
}

export async function readRegistryEntriesByTemplate(
  templateId: string,
): Promise<RegistryEntryRecord[]> {
  const rows = await db
    .select()
    .from(agentRegistryEntries)
    .where(eq(agentRegistryEntries.templateId, templateId))
    .orderBy(desc(agentRegistryEntries.createdAt));
  return rows.map(deserializeRegistryEntry);
}

export async function updateRegistryEntryStatus(
  id: string,
  status: string,
): Promise<void> {
  await db.update(agentRegistryEntries).set({ status }).where(eq(agentRegistryEntries.id, id));
}

// ---------------------------------------------------------------------------
// CRUD — agent_share_bindings
// ---------------------------------------------------------------------------

export async function createShareBinding(
  input: CreateShareBindingInput,
): Promise<ShareBindingRecord> {
  const id = randomUUID();
  await db.insert(agentShareBindings).values({
    id,
    registryEntryId: input.registryEntryId,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    canView: input.canView,
    canRun: input.canRun,
    canEditDraft: input.canEditDraft,
    canPublish: input.canPublish,
    canApprove: input.canApprove,
    grantedBy: input.grantedBy,
  });
  const rows = await db
    .select()
    .from(agentShareBindings)
    .where(eq(agentShareBindings.id, id))
    .limit(1);
  return rows[0];
}

export async function readShareBindingsForEntry(
  registryEntryId: string,
): Promise<ShareBindingRecord[]> {
  return db
    .select()
    .from(agentShareBindings)
    .where(eq(agentShareBindings.registryEntryId, registryEntryId));
}

export async function updateShareBinding(
  id: string,
  patch: Partial<Omit<ShareBindingRecord, "id" | "createdAt" | "registryEntryId" | "subjectType" | "subjectId">>,
): Promise<void> {
  await db.update(agentShareBindings).set(patch).where(eq(agentShareBindings.id, id));
}

// ---------------------------------------------------------------------------
// CRUD — agent_forks
// ---------------------------------------------------------------------------

export async function createAgentFork(
  input: CreateAgentForkInput,
): Promise<AgentForkRecord> {
  const id = randomUUID();
  await db.insert(agentForks).values({
    id,
    registryEntryId: input.registryEntryId,
    forkedTemplateId: input.forkedTemplateId,
    forkedBy: input.forkedBy,
  });
  const rows = await db
    .select()
    .from(agentForks)
    .where(eq(agentForks.id, id))
    .limit(1);
  return rows[0];
}

export async function readForksByEntry(
  registryEntryId: string,
): Promise<AgentForkRecord[]> {
  return db
    .select()
    .from(agentForks)
    .where(eq(agentForks.registryEntryId, registryEntryId))
    .orderBy(desc(agentForks.createdAt));
}

/**
 * Batch-fetch the most recent run per template (by createdAt DESC).
 * Returns a map of templateId → { runId, title }.
 * Title prefers the dedicated title column, falls back to __agent_run_name in inputParams.
 */
export async function readLatestRunPerTemplate(
  templateIds: string[],
): Promise<Map<string, { runId: string; title: string | null }>> {
  if (templateIds.length === 0) return new Map();

  // DISTINCT ON (template_id) ordered by created_at DESC gives the most recent run per template.
  // Use parameterized array binding (not sql.raw) to prevent SQL injection.
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (template_id) id, template_id, title, input_params
    FROM ${agentRuns}
    WHERE template_id = ANY(ARRAY[${sql.join(templateIds.map((id) => sql`${id}`), sql`, `)}])
    ORDER BY template_id, created_at DESC NULLS LAST, id DESC
  `);

  const result = new Map<string, { runId: string; title: string | null }>();
  for (const row of rows.rows as Array<{ id: string; template_id: string; title: string | null; input_params: unknown }>) {
    const dedicatedTitle = typeof row.title === "string" && row.title.trim() ? row.title.trim() : null;
    const paramName = (() => {
      try {
        const params = typeof row.input_params === "string" ? JSON.parse(row.input_params) : row.input_params;
        const v = (params as Record<string, unknown>)?.["__agent_run_name"];
        return typeof v === "string" && v.trim() ? v.trim() : null;
      } catch { return null; }
    })();
    result.set(row.template_id, { runId: row.id, title: dedicatedTitle ?? paramName });
  }
  return result;
}

// Templates that have at least one run (any status, including pending_input = setup started).
// system:* templates are synthetic rows created for legacy agents and must not appear here.
export async function readTemplatesWithActivity(): Promise<AgentTemplateRecord[]> {
  const activeTemplateIds = db
    .selectDistinct({ id: agentRuns.templateId })
    .from(agentRuns);
  const rows = await db
    .select()
    .from(agentTemplates)
    .where(and(
      inArray(agentTemplates.id, activeTemplateIds),
      sql`${agentTemplates.status} != 'archived'`,
      sql`${agentTemplates.id} NOT LIKE 'system:%'`,
    ))
    .orderBy(desc(agentTemplates.updatedAt));
  return rows.map(deserializeTemplate);
}

// All non-archived, non-system templates — includes templates that were created
// but never run (setup started, not yet executed).
export async function readAllAgentBuilderTemplates(): Promise<AgentTemplateRecord[]> {
  const rows = await db
    .select()
    .from(agentTemplates)
    .where(and(
      sql`${agentTemplates.status} != 'archived'`,
      sql`${agentTemplates.id} NOT LIKE 'system:%'`,
    ))
    .orderBy(desc(agentTemplates.updatedAt));
  return rows.map(deserializeTemplate);
}

export async function readForkedTemplates(): Promise<AgentTemplateRecord[]> {
  const forks = await db.select({ forkedTemplateId: agentForks.forkedTemplateId }).from(agentForks);
  if (forks.length === 0) return [];
  const ids = forks.map((f) => f.forkedTemplateId);
  const rows = await db
    .select()
    .from(agentTemplates)
    .where(and(inArray(agentTemplates.id, ids), sql`${agentTemplates.status} != 'archived'`))
    .orderBy(desc(agentTemplates.updatedAt));
  return rows.map(deserializeTemplate);
}

// ---------------------------------------------------------------------------
// Permission check helper — checks user binding first, then org-wide binding
// ---------------------------------------------------------------------------

export async function checkRegistryPermission(
  entryId: string,
  userId: string,
  isAdmin: boolean,
  permission: "canView" | "canRun" | "canPublish" | "canApprove",
): Promise<boolean> {
  if (isAdmin) return true;
  const bindings = await readShareBindingsForEntry(entryId);
  const userBinding = bindings.find(b => b.subjectType === "user" && b.subjectId === userId);
  if (userBinding) return Boolean(userBinding[permission]);
  const orgBinding = bindings.find(b => b.subjectType === "org");
  if (orgBinding) return Boolean(orgBinding[permission]);
  return false;
}

// ---------------------------------------------------------------------------
// CRUD — agent_run_messages  — STRUCTURED payload for replay integrity
// ---------------------------------------------------------------------------

/**
 * Canonical, provider-neutral message payload. Persisted as JSON in
 * agent_run_messages.content_json. The resume path reads these rows
 * to reconstruct the LLM conversation after a HITL pause.
 *
 * tool_call and tool_result rows must carry
 * stable tool_call_id so the resume logic can match a paused call to its
 * eventual approved execution.
 */
export type AgentRunMessageBody =
  | { messageType: "text"; role: "user" | "assistant" | "system"; text: string }
  | {
      messageType: "tool_call";
      role: "assistant";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | {
      messageType: "tool_result";
      role: "tool";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError?: boolean;
    }
  | { messageType: "final"; role: "assistant"; text: string };

export type AgentRunMessageRecord = {
  id: string;
  runId: string;
  sequence: number;
  role: "user" | "assistant" | "tool" | "system";
  messageType: "text" | "tool_call" | "tool_result" | "final";
  toolCallId: string | null;
  toolName: string | null;
  body: AgentRunMessageBody; // parsed content_json
  createdAt: Date;
};

export type CreateAgentRunMessageInput = {
  runId: string;
  sequence: number;
  body: AgentRunMessageBody;
};

/**
 * Append a structured message to a run's conversation thread. The unique
 * (run_id, sequence) constraint enforced by the schema guarantees ordering
 * integrity — a duplicate sequence number for the same run raises an error.
 */
export async function appendAgentRunMessage(
  input: CreateAgentRunMessageInput,
): Promise<AgentRunMessageRecord> {
  const id = randomUUID();
  const body = input.body;
  const role: AgentRunMessageRecord["role"] =
    body.messageType === "tool_result" ? "tool" :
    body.messageType === "tool_call" ? "assistant" :
    (body.role as AgentRunMessageRecord["role"]);
  const toolCallId =
    body.messageType === "tool_call" || body.messageType === "tool_result"
      ? body.toolCallId
      : null;
  const toolName =
    body.messageType === "tool_call" || body.messageType === "tool_result"
      ? body.toolName
      : null;

  await db.insert(agentRunMessages).values({
    id,
    runId: input.runId,
    sequence: input.sequence,
    role,
    messageType: body.messageType,
    toolCallId,
    toolName,
    content: body.messageType === "text" || body.messageType === "final" ? body.text : "",
    contentJson: JSON.stringify(body),
  });

  const rows = await db
    .select()
    .from(agentRunMessages)
    .where(eq(agentRunMessages.id, id))
    .limit(1);
  const row = rows[0];
  return {
    id: row.id,
    runId: row.runId,
    sequence: row.sequence,
    role: row.role as AgentRunMessageRecord["role"],
    messageType: row.messageType as AgentRunMessageRecord["messageType"],
    toolCallId: row.toolCallId,
    toolName: row.toolName,
    body: JSON.parse(row.contentJson) as AgentRunMessageBody,
    createdAt: row.createdAt,
  };
}

/**
 * Load the full conversation thread for a run in strict sequence order.
 * The resume path uses this to restore prior LlmMessage[] context.
 */
export async function readAgentRunMessages(
  runId: string,
): Promise<AgentRunMessageRecord[]> {
  const rows = await db
    .select()
    .from(agentRunMessages)
    .where(eq(agentRunMessages.runId, runId))
    .orderBy(asc(agentRunMessages.sequence));
  return rows.map((row) => ({
    id: row.id,
    runId: row.runId,
    sequence: row.sequence,
    role: row.role as AgentRunMessageRecord["role"],
    messageType: row.messageType as AgentRunMessageRecord["messageType"],
    toolCallId: row.toolCallId,
    toolName: row.toolName,
    body: JSON.parse(row.contentJson) as AgentRunMessageBody,
    createdAt: row.createdAt,
  }));
}

// ---------------------------------------------------------------------------
// Default org resolution — for MCP handlers that lack a session context
// ---------------------------------------------------------------------------

/**
 * Read the first organization ID from the betterAuth `organization` table.
 * Used by MCP handlers (which have no cookie/session) to associate newly
 * created resources with the tenant org. Safe for single-tenant installs;
 * for multi-tenant, callers should pass orgId explicitly.
 */
export async function resolveDefaultOrgId(): Promise<string | null> {
  try {
    const result = await agentBuilderPool.query<{ id: string }>(
      `SELECT id FROM "public"."organization" ORDER BY "createdAt" ASC LIMIT 1`,
    );
    return result.rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pending-input run creation
// ---------------------------------------------------------------------------

/**
 * create an agent_runs row in `pending_input` status with the
 * supplied (typically empty) inputParams. The dispatcher's setup-interrupt
 * loop emits AG-UI INTERRUPTs for any required schema fields
 * once the run is triggered. versionId is pinned to the latest snapshot so
 * the run stays consistent across template recompiles after creation.
 *
 * Replaces the legacy `createAgentRunForSetup` + `findAgentRunBySetupNonce`
 * pair. Idempotency was nonce-based and only mattered
 * for the wizard's per-step save loop, which no longer exists.
 *
 * Added `orgId` so callers can clone
 * the originating run's organization onto the pending row.
 * `orgId` is now required — every caller must resolve it before insert.
 * run-actions.ts + 1 in trigger-release-job.ts) now populates it, and the
 * underlying column is NOT NULL.
 */
export async function createAgentRunPendingInput(input: {
  templateId: string;
  runBy: string | null;
  orgId: string;
  inputParams?: Record<string, unknown>;
  // nullable project refinement. Pending
  // runs inherit projectId from the same boundary as createAgentRun (chat
  // path / server action). Set NULL for non-project invocations.
  projectId?: string | null;
}): Promise<AgentRunRecord> {
  const id = randomUUID();
  const versionIdToPin = await readLatestAgentVersionIdForTemplate(input.templateId);
  await db.insert(agentRuns).values({
    id,
    templateId: input.templateId,
    versionId: versionIdToPin,
    runBy: input.runBy,
    // propagate org boundary; column is NOT NULL after the DDL.
    orgId: input.orgId,
    status: "pending_input",
    inputParams: JSON.stringify(input.inputParams ?? {}),
    // pending-input runs share the same AG-UI capability marker as
    // the main createAgentRun path. Without this, a setup → run transition
    // would appear as legacy (agUiEnabled=null) to the panel.
    agUiEnabled: true,
    // propagate projectId at pending-input
    // create time so the eventual queued→running transition's worker sees
    // the same project frame.
    projectId: input.projectId ?? null,
  });
  const created = await readAgentRunById(id);
  if (!created) throw new Error(`Failed to create pending_input agent run: ${id}`);
  return created;
}

/**
 * Returns the most recently created agent_versions row id for the template, or null
 * if the template has no versions yet.
 */
export async function readLatestAgentVersionIdForTemplate(
  templateId: string,
): Promise<string | null> {
  const rows = await db
    .select({ id: agentVersions.id })
    .from(agentVersions)
    .where(eq(agentVersions.templateId, templateId))
    .orderBy(desc(agentVersions.createdAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * Merge partial field values into an existing run's inputParams.
 * Used to patch runtime-collected values into a run (e.g. the setup-interrupt
 * approve path in the current implementation).
 */
export async function updateAgentRunInputParams(
  runId: string,
  partial: Record<string, unknown>,
): Promise<AgentRunRecord> {
  const existing = await readAgentRunById(runId);
  if (!existing) throw new Error(`Agent run not found: ${runId}`);
  const merged = { ...existing.inputParams, ...partial };
  await db
    .update(agentRuns)
    .set({ inputParams: JSON.stringify(merged) })
    .where(eq(agentRuns.id, runId));
  const updated = await readAgentRunById(runId);
  if (!updated) throw new Error(`Agent run vanished after update: ${runId}`);
  return updated;
}

// ---------------------------------------------------------------------------
// agent_template_versions
// Immutable per-save snapshots with semver, bump type, content hash, and diff.
// ---------------------------------------------------------------------------

export type AgentTemplateVersionSnapshot = {
  name: string;
  description: string | null;
  sourceNl: string;
  compiledPlan: unknown;
  inputSchema: unknown;
  outputSchema: unknown | null;
  approvalPolicy: unknown;
  type: string; // widened leaf|proxy|orchestrator|parallel|supervisor|iterative
  taskSpec: string | null;
  packageVersion: string | null;
  lgGraphCode: string | null;                         // null for non-LangGraph templates
  lgGraphId: string | null;                           // null for non-LangGraph templates
};

export type AgentTemplateVersionRecord = {
  id: string;
  templateId: string;
  versionNumber: number;
  semver: string;
  bumpType: "major" | "minor" | "patch";
  changelogLine: string | null;
  contentHash: string;
  snapshot: AgentTemplateVersionSnapshot; // parsed (not the raw JSON string)
  createdBy: string | null;
  createdAt: Date;
};

export type ReadAgentTemplateVersionsOptions = {
  limit?: number;  // default 20, max 100
  cursor?: string; // opaque: "versionNumber" of the last item of the previous page
};

export type AgentTemplateVersionListPage = {
  items: AgentTemplateVersionRecord[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
};

// ---------------------------------------------------------------------------
// Serialization helpers (private)
// ---------------------------------------------------------------------------

function serializeVersionSnapshot(snapshot: AgentTemplateVersionSnapshot): string {
  return JSON.stringify(snapshot);
}

function deserializeVersionRow(row: typeof agentTemplateVersions.$inferSelect): AgentTemplateVersionRecord {
  return {
    id: row.id,
    templateId: row.templateId,
    versionNumber: row.versionNumber,
    semver: row.semver,
    bumpType: row.bumpType as "major" | "minor" | "patch",
    changelogLine: row.changelogLine ?? null,
    contentHash: row.contentHash,
    snapshot: JSON.parse(row.snapshot) as AgentTemplateVersionSnapshot,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// computeSnapshotContentHash
// ---------------------------------------------------------------------------

export function computeSnapshotContentHash(snapshot: AgentTemplateVersionSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

// ---------------------------------------------------------------------------
// buildSnapshotFromTemplate
// ---------------------------------------------------------------------------

export function buildSnapshotFromTemplate(
  template: AgentTemplateRecord,
): AgentTemplateVersionSnapshot {
  return {
    name: template.name,
    description: template.description ?? null,
    sourceNl: template.sourceNl,
    compiledPlan: template.compiledPlan,
    inputSchema: template.inputSchema,
    outputSchema: template.outputSchema ?? null,
    approvalPolicy: template.approvalPolicy,
    type: template.type,
    taskSpec: template.taskSpec ?? null,
    packageVersion: template.packageVersion ?? null,
    lgGraphCode: template.lgGraphCode ?? null,         //
    lgGraphId: template.lgGraphId ?? null,             //
  };
}

// ---------------------------------------------------------------------------
// diffSnapshots — returns unified line diff string between two snapshots
// ---------------------------------------------------------------------------

export function diffSnapshots(
  oldSnapshot: AgentTemplateVersionSnapshot,
  newSnapshot: AgentTemplateVersionSnapshot,
): string {
  const oldJson = JSON.stringify(oldSnapshot, null, 2);
  const newJson = JSON.stringify(newSnapshot, null, 2);
  const parts = diffLines(oldJson, newJson);
  return parts
    .map((part) => {
      const prefix = part.added ? "+" : part.removed ? "-" : " ";
      return part.value
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => `${prefix} ${line}`)
        .join("\n");
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// createAgentTemplateVersion — insert with server-computed versionNumber
// ---------------------------------------------------------------------------

export async function createAgentTemplateVersion(input: {
  templateId: string;
  semver: string;
  bumpType: "major" | "minor" | "patch";
  changelogLine: string | null;
  contentHash: string;
  snapshot: AgentTemplateVersionSnapshot;
  createdBy: string | null;
}): Promise<AgentTemplateVersionRecord> {
  // Compute next versionNumber = MAX(version_number) + 1 (server-side, never client-provided)
  const existing = await db
    .select({ versionNumber: agentTemplateVersions.versionNumber })
    .from(agentTemplateVersions)
    .where(eq(agentTemplateVersions.templateId, input.templateId))
    .orderBy(desc(agentTemplateVersions.versionNumber))
    .limit(1);
  const nextVersionNumber = existing.length > 0 ? existing[0].versionNumber + 1 : 1;

  const id = randomUUID();
  const now = new Date();
  await db.insert(agentTemplateVersions).values({
    id,
    templateId: input.templateId,
    versionNumber: nextVersionNumber,
    semver: input.semver,
    bumpType: input.bumpType,
    changelogLine: input.changelogLine,
    contentHash: input.contentHash,
    snapshot: serializeVersionSnapshot(input.snapshot),
    createdBy: input.createdBy,
    createdAt: now,
  });

  return {
    id,
    templateId: input.templateId,
    versionNumber: nextVersionNumber,
    semver: input.semver,
    bumpType: input.bumpType,
    changelogLine: input.changelogLine,
    contentHash: input.contentHash,
    snapshot: input.snapshot,
    createdBy: input.createdBy,
    createdAt: now,
  };
}

// ---------------------------------------------------------------------------
// readLatestAgentTemplateVersion
// ---------------------------------------------------------------------------

export async function readLatestAgentTemplateVersion(
  templateId: string,
): Promise<AgentTemplateVersionRecord | null> {
  const rows = await db
    .select()
    .from(agentTemplateVersions)
    .where(eq(agentTemplateVersions.templateId, templateId))
    .orderBy(desc(agentTemplateVersions.versionNumber))
    .limit(1);
  return rows.length > 0 ? deserializeVersionRow(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// readAgentTemplateVersions — paginated list ordered by versionNumber DESC
// ---------------------------------------------------------------------------

export async function readAgentTemplateVersions(
  templateId: string,
  opts: ReadAgentTemplateVersionsOptions = {},
): Promise<AgentTemplateVersionListPage> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);

  // Total count
  const countRows = await db
    .select({ n: agentTemplateVersions.id })
    .from(agentTemplateVersions)
    .where(eq(agentTemplateVersions.templateId, templateId));
  const total = countRows.length;

  // Fetch page — cursor is the versionNumber we last saw; fetch items with versionNumber < cursor
  const whereClauses = opts.cursor
    ? and(
        eq(agentTemplateVersions.templateId, templateId),
        lt(agentTemplateVersions.versionNumber, Number(opts.cursor)),
      )
    : eq(agentTemplateVersions.templateId, templateId);

  const rows = await db
    .select()
    .from(agentTemplateVersions)
    .where(whereClauses)
    .orderBy(desc(agentTemplateVersions.versionNumber))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items = pageRows.map(deserializeVersionRow);
  const nextCursor = hasMore && items.length > 0
    ? String(items[items.length - 1].versionNumber)
    : null;

  return { items, total, hasMore, nextCursor };
}

// ---------------------------------------------------------------------------
// readAgentTemplateVersionById
// ---------------------------------------------------------------------------

export async function readAgentTemplateVersionById(
  versionId: string,
): Promise<AgentTemplateVersionRecord | null> {
  const rows = await db
    .select()
    .from(agentTemplateVersions)
    .where(eq(agentTemplateVersions.id, versionId))
    .limit(1);
  return rows.length > 0 ? deserializeVersionRow(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// readAgentTemplateVersionBySemver — lookup by (templateId, semver)
// ---------------------------------------------------------------------------
// Used by the A2A version-pinning path in runAgentBuilderExecutionJob: when a run
// carries a concrete packageVersion string, the worker loads the immutable
// snapshot for (templateId, semver) and applies it on top of the live template.
// Returns null when no matching row exists so the caller can fall back cleanly.
// ---------------------------------------------------------------------------

export async function readAgentTemplateVersionBySemver(
  templateId: string,
  semver: string,
): Promise<AgentTemplateVersionRecord | null> {
  const rows = await db
    .select()
    .from(agentTemplateVersions)
    .where(
      and(
        eq(agentTemplateVersions.templateId, templateId),
        eq(agentTemplateVersions.semver, semver),
      ),
    )
    .limit(1);
  return rows.length > 0 ? deserializeVersionRow(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// determineBumpType — classify a content change as major / minor / patch
// ---------------------------------------------------------------------------

export function determineBumpType(
  prev: AgentTemplateVersionSnapshot | null,
  next: AgentTemplateVersionSnapshot,
): "major" | "minor" | "patch" {
  if (!prev) return "patch"; // First version after initial save is always patch

  // MAJOR — type changed
  if (prev.type !== next.type) return "major";

  // MAJOR — required input fields removed
  const prevRequired = extractRequiredKeys(prev.inputSchema);
  const nextRequired = extractRequiredKeys(next.inputSchema);
  const removed = prevRequired.filter((k) => !nextRequired.includes(k));
  if (removed.length > 0) return "major";

  // MINOR — new properties added to inputSchema
  const prevProps = extractPropertyKeys(prev.inputSchema);
  const nextProps = extractPropertyKeys(next.inputSchema);
  const added = nextProps.filter((k) => !prevProps.includes(k));
  if (added.length > 0) return "minor";

  // MINOR — taskSpec materially changed (> 20% of lines)
  if (taskSpecDiffExceeds(prev.taskSpec, next.taskSpec, 0.2)) return "minor";

  // Everything else: name/description/sourceNl/approvalPolicy/minor compiledPlan edits
  return "patch";
}

function extractRequiredKeys(inputSchema: unknown): string[] {
  if (!inputSchema || typeof inputSchema !== "object") return [];
  const schema = inputSchema as Record<string, unknown>;
  return Array.isArray(schema.required) ? (schema.required as string[]) : [];
}

function extractPropertyKeys(inputSchema: unknown): string[] {
  if (!inputSchema || typeof inputSchema !== "object") return [];
  const schema = inputSchema as Record<string, unknown>;
  const props = schema.properties;
  if (!props || typeof props !== "object") return [];
  return Object.keys(props as Record<string, unknown>);
}

function taskSpecDiffExceeds(
  prev: string | null,
  next: string | null,
  threshold: number,
): boolean {
  if (!prev && !next) return false;
  if (!prev || !next) return true;
  const prevLines = prev.split("\n");
  const nextLines = next.split("\n");
  const shared = prevLines.filter((line) => nextLines.includes(line)).length;
  const total = Math.max(prevLines.length, nextLines.length);
  if (total === 0) return false;
  const changedRatio = 1 - shared / total;
  return changedRatio > threshold;
}

// ---------------------------------------------------------------------------
// createAgentTemplateVersionIfChanged — single entry point for save paths
// Returns the existing latest version (created: false) on content-hash match.
// First version is always the initial semver value (not derived from semver.inc).
// ---------------------------------------------------------------------------

export async function createAgentTemplateVersionIfChanged(
  template: AgentTemplateRecord,
  opts: {
    changelogLine?: string | null;
    bumpTypeOverride?: "major" | "minor" | "patch";
    createdBy?: string | null;
  } = {},
): Promise<{ version: AgentTemplateVersionRecord; created: boolean }> {
  const snapshot = buildSnapshotFromTemplate(template);
  const contentHash = computeSnapshotContentHash(snapshot);

  const latest = await readLatestAgentTemplateVersion(template.id);

  // Dedup — no-op save returns the existing latest version
  if (latest && latest.contentHash === contentHash) {
    return { version: latest, created: false };
  }

  // First version always uses the initial semver value regardless of bumpType
  if (!latest) {
    const version = await createAgentTemplateVersion({
      templateId: template.id,
      semver: "1.0.0",
      bumpType: opts.bumpTypeOverride ?? "patch",
      changelogLine: opts.changelogLine ?? "Initial save",
      contentHash,
      snapshot,
      createdBy: opts.createdBy ?? null,
    });
    // Advance current_version_id pointer to the new version
    await db.update(agentTemplates).set({ currentVersionId: version.id }).where(eq(agentTemplates.id, template.id));
    return { version, created: true };
  }

  const bumpType =
    opts.bumpTypeOverride ??
    determineBumpType(latest.snapshot, snapshot);

  const prevSemver = latest.semver;
  const nextSemver = semver.inc(prevSemver, bumpType);
  if (!nextSemver) {
    throw new Error(
      `createAgentTemplateVersionIfChanged: semver.inc returned null for ${prevSemver} / ${bumpType}`,
    );
  }

  const version = await createAgentTemplateVersion({
    templateId: template.id,
    semver: nextSemver,
    bumpType,
    changelogLine: opts.changelogLine ?? autoChangelog(bumpType, latest, snapshot),
    contentHash,
    snapshot,
    createdBy: opts.createdBy ?? null,
  });
  // Advance current_version_id pointer to the new version
  await db.update(agentTemplates).set({ currentVersionId: version.id }).where(eq(agentTemplates.id, template.id));

  return { version, created: true };
}

function autoChangelog(
  bumpType: "major" | "minor" | "patch",
  latest: AgentTemplateVersionRecord,
  next: AgentTemplateVersionSnapshot,
): string {
  if (bumpType === "major") return `Breaking: ${describeBreakingChange(latest.snapshot, next)}`;
  if (bumpType === "minor") return `Enhancement: ${describeMinorChange(latest.snapshot, next)}`;
  return "Patch update";
}

export function describeBreakingChange(
  prev: AgentTemplateVersionSnapshot,
  next: AgentTemplateVersionSnapshot,
): string {
  if (prev.type !== next.type) {
    return `type ${prev.type} → ${next.type}`;
  }
  return "input schema contract changed";
}

function describeMinorChange(
  prev: AgentTemplateVersionSnapshot,
  next: AgentTemplateVersionSnapshot,
): string {
  const prevProps = extractPropertyKeys(prev.inputSchema);
  const nextProps = extractPropertyKeys(next.inputSchema);
  const added = nextProps.filter((k) => !prevProps.includes(k));
  if (added.length > 0) return `added input field${added.length > 1 ? "s" : ""}: ${added.join(", ")}`;
  return "task spec updated";
}

// ---------------------------------------------------------------------------
// rollbackAgentTemplateToVersion — explicit rollback path (audit event row)
// Does NOT use createAgentTemplateVersionIfChanged — bypasses dedup to force
// an audit row even when content hash matches the target version.
// ---------------------------------------------------------------------------

export async function rollbackAgentTemplateToVersion(
  templateId: string,
  targetVersionId: string,
  actorId: string | null,
): Promise<{ template: AgentTemplateRecord; restoredVersionId: string }> {
  const target = await readAgentTemplateVersionById(targetVersionId);
  if (!target) throw new Error(`rollbackAgentTemplateToVersion: version ${targetVersionId} not found`);
  if (target.templateId !== templateId) {
    throw new Error(
      `rollbackAgentTemplateToVersion: version ${targetVersionId} does not belong to template ${templateId}`,
    );
  }

  // 1. Restore the live template content from the target snapshot.
  //    Calls updateAgentTemplate directly — does NOT go through save hooks,
  //    so createAgentTemplateVersionIfChanged is NOT triggered (no new version row).
  const updated = await updateAgentTemplate(templateId, {
    name: target.snapshot.name,
    description: target.snapshot.description ?? undefined,
    sourceNl: target.snapshot.sourceNl,
    compiledPlan: target.snapshot.compiledPlan as never,
    inputSchema: target.snapshot.inputSchema as never,
    outputSchema: target.snapshot.outputSchema as never,
    approvalPolicy: target.snapshot.approvalPolicy as never,
    type: ((target.snapshot as { type?: string }).type ?? "leaf") as never,
    taskSpec: target.snapshot.taskSpec ?? undefined,
    // restore LangGraph fields. Use `?? null` (not undefined) so
    // legacy snapshots clear the fields (no accidental retention of stale code).
    lgGraphCode: target.snapshot.lgGraphCode ?? null,
    lgGraphId: target.snapshot.lgGraphId ?? null,
  });
  if (!updated) throw new Error(`rollbackAgentTemplateToVersion: template ${templateId} not found`);

  // 2. Move the current_version_id pointer to the target version.
  //    No new version row — the history stays as-is; only the pointer moves.
  //    (The UI dialog makes this explicit: "the 'current' indicator simply moves to this version.")
  await db
    .update(agentTemplates)
    .set({ currentVersionId: targetVersionId })
    .where(eq(agentTemplates.id, templateId));

  return { template: updated, restoredVersionId: targetVersionId };
}

// ---------------------------------------------------------------------------
// LangGraph-side pending interrupt reader and its synthetic task
// type were removed in lockstep with the LangGraph dev container retirement.
// The approval inbox now returns an empty list until the WayFlow HITL inbox
// is implemented .
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// MCP Capability Autodiscovery
// ---------------------------------------------------------------------------

/**
 * Read all PUBLISHED agent_templates rows that have at least one HITL surface declared.
 * Used by the cinatra://protocols/a2ui MCP resource to expose surface inventory.
 *
 * The `eq(agentTemplates.status, "published")` filter prevents draft and archived
 * templates from being exposed to external MCP clients via the public a2ui resource.
 * Drafts and internal/archived templates are not part of the published surface
 * inventory.
 *
 * The hitlScreens column is text(JSON) . Parse in JS rather than
 * via -> JSON operators to keep Drizzle typing strict.
 */
export async function readAllTemplateHitlSurfaces(): Promise<
  Array<{ packageName: string; templateName: string; hitlScreens: string[] }>
> {
  const rows = await db
    .select({
      packageName: agentTemplates.packageName,
      templateName: agentTemplates.name,
      hitlScreens: agentTemplates.hitlScreens,
    })
    .from(agentTemplates)
    .where(
      and(
        eq(agentTemplates.status, "published"),
        isNotNull(agentTemplates.packageName),
        isNotNull(agentTemplates.hitlScreens),
        sql`${agentTemplates.hitlScreens} <> ''`,
        sql`${agentTemplates.hitlScreens} <> '[]'`,
        // Visibility policy: this feeds the GLOBAL MCP `cinatra://protocols/a2ui`
        // resource, so PRIVATE agents' package/display names + HITL surface IDs must
        // not leak. COALESCE so a missing visibility key grandfathers to 'public'
        // (strictly equivalent to isAgentPubliclyDiscoverable's `?? 'public'`, incl.
        // the non-null-origin-without-visibility case).
        sql`COALESCE(${agentTemplates.origin}->>'visibility', 'public') = 'public'`,
      ),
    );

  return rows
    .map((r) => {
      let parsed: string[] = [];
      try {
        const value = JSON.parse(r.hitlScreens ?? "[]");
        if (Array.isArray(value)) {
          parsed = value.filter((v): v is string => typeof v === "string");
        }
      } catch {
        parsed = [];
      }
      return {
        packageName: r.packageName ?? "",
        templateName: r.templateName,
        hitlScreens: parsed,
      };
    })
    .filter((r) => r.packageName.length > 0 && r.hitlScreens.length > 0);
}

// ---------------------------------------------------------------------------
// Run-name uniqueness helpers
// ---------------------------------------------------------------------------

/**
 * Count agent runs for the same template and user that have exactly the given
 * title, excluding the run identified by `excludeRunId` (the run being renamed).
 */
export async function countRunsByTitle(
  templateId: string,
  runBy: string,
  title: string,
  excludeRunId: string,
): Promise<number> {
  const [result] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.templateId, templateId),
        eq(agentRuns.runBy, runBy),
        eq(agentRuns.title, title),
        ne(agentRuns.id, excludeRunId),
      ),
    );
  return result?.count ?? 0;
}

/**
 * Server-side helper — ensures a run has a unique title without going through
 * the "use server" server-action boundary.  Called from RSCs (instance-screens,
 * orchestrator-screens) so the SSR-rendered initialRunName is already populated.
 *
 * If the run already has a title, returns it unchanged.
 * If not, generates "Base", "Base (1)", "Base (2)", … and persists the result.
 * Falls back to baseName for system runs (runBy = null).
 */
export async function ensureRunTitle(
  run: { id: string; title: string | null; templateId: string; runBy: string | null },
  baseName: string,
): Promise<string> {
  const existing = run.title?.trim();
  if (existing) return existing;
  if (!run.runBy) return baseName;

  // Always numbered from (1) — agent runs are numbered, not files.
  let name = `${baseName} (${Date.now()})`;
  for (let i = 1; i <= 999; i++) {
    const candidate = `${baseName} (${i})`;
    const count = await countRunsByTitle(run.templateId, run.runBy, candidate, run.id);
    if (count === 0) { name = candidate; break; }
  }

  await updateAgentRunTitle(run.id, name);
  return name;
}

// ---------------------------------------------------------------------------
// Extension lifecycle query helpers
// ---------------------------------------------------------------------------

/**
 * Returns the count of agent_runs rows for a given template_id.
 * Used by the extensionHasBeenUsed predicate to determine
 * whether an uninstall should archive instead of hard-delete.
 */
export async function countRunsForTemplate(templateId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(agentRuns)
    .where(eq(agentRuns.templateId, templateId))
    .limit(1);
  return row?.count ?? 0;
}

/**
 * batch variant of countRunsForTemplate.
 * Single SQL join + GROUP BY replaces N per-row queries in registry-catalog-screen.
 * Returns a Map<packageName, runCount> for all matching templates.
 * packageNames with no template row are absent from the result (treated as 0 runs).
 */
export async function countRunsForTemplates(
  packageNames: string[],
): Promise<Map<string, number>> {
  if (packageNames.length === 0) return new Map();
  const rows = await db
    .select({
      packageName: agentTemplates.packageName,
      count: sql<number>`cast(count(${agentRuns.id}) as int)`,
    })
    .from(agentTemplates)
    .leftJoin(agentRuns, eq(agentRuns.templateId, agentTemplates.id))
    .where(inArray(agentTemplates.packageName, packageNames))
    .groupBy(agentTemplates.packageName);
  return new Map(rows.map((r) => [r.packageName ?? "", r.count ?? 0]));
}

/**
 * Returns all agent_templates rows where packageName IS NOT NULL
 * AND extensionLifecycleStatus = 'active', ordered by name asc.
 *
 * Visibility filter; UI-only filtering is forbidden.
 * When vendorScope is provided, private rows for that scope are included.
 * Without vendorScope, only public rows are returned.
 * legacy rows (origin IS NULL) are treated as public (grandfather clause).
 *
 * @param vendorScope - optional npm scope e.g. "@cinatra" or "@vendorname"; when
 *   provided, private extensions matching this scope are included in results.
 */
// the per-kind extension_lifecycle_status column was dropped;
// extension lifecycle status is canonical (installed_extension). This helper
// resolves the EFFECTIVE legacy status for a set of agent_templates rows by
// EXACT identity (organization_id, owner_level, owner_id, package_name) with a
// platform-row fallback — exact wins to avoid status bleed
// across scopes). owner_level/owner_id are normalized to match the
// canonical normalization (null owner_level → "organization"; null owner_id →
// sentinel). `locked` collapses to legacy "active" (locked loads like active).
// A row with no matching canonical row defaults to "active" (grandfather).
//
// Implemented as a raw read via the agents pool (NOT an import of
// @cinatra-ai/extensions/canonical-store) to avoid an agents↔extensions
// workspace cycle. Mirrors the aggregate rule documented in canonical-store.ts.
const PLATFORM_OWNER_SENTINEL = "__platform__";

export type CanonicalManifestRow = {
  package_name: string;
  organization_id: string | null;
  owner_level: string;
  owner_id: string;
  status: string;
};

/**
 * Pure tie-break (exported for unit testing against status-bleed risk). Given a candidate agent_templates identity and the set
 * status-bleed risk). Given a candidate agent_templates identity and the set
 * of canonical rows for its package, resolve the EFFECTIVE legacy status:
 *   1. EXACT identity match (org_id, owner_level, owner_id, package_name) wins
 *   2. else PLATFORM fallback (org NULL, owner_level=platform, sentinel)
 *   3. else null (no canonical row → caller defaults to "active" grandfather)
 * owner_level/owner_id are normalized to match canonical backfill rules.
 * `locked` collapses to legacy "active" (locked loads like active).
 */
export function pickEffectiveStatusForIdentity(
  candidate: { orgId: string | null; ownerLevel: string | null; ownerId: string | null; packageName: string },
  rows: CanonicalManifestRow[],
): "active" | "archived" | null {
  const toLegacy = (s: string): "active" | "archived" => (s === "archived" ? "archived" : "active");
  const wantLevel = candidate.ownerLevel ?? "organization";
  const wantOwnerId =
    wantLevel === "platform" ? PLATFORM_OWNER_SENTINEL : candidate.ownerId ?? PLATFORM_OWNER_SENTINEL;
  const exact = rows.find(
    (r) =>
      r.package_name === candidate.packageName &&
      r.organization_id === candidate.orgId &&
      r.owner_level === wantLevel &&
      r.owner_id === wantOwnerId,
  );
  const chosen =
    exact ??
    rows.find(
      (r) =>
        r.package_name === candidate.packageName &&
        r.organization_id === null &&
        r.owner_level === "platform" &&
        r.owner_id === PLATFORM_OWNER_SENTINEL,
    );
  return chosen ? toLegacy(chosen.status) : null;
}

/**
 * @internal Build the SELECT fragment used by `readEffectiveExtensionStatusByIdentity`.
 *
 * Exported as an internal seam so the SQL shape is testable via
 * `PgDialect().sqlToQuery(...)` without a live DB. The `_` prefix + `@internal`
 * tag mark this as a test-visibility export — NOT part of the public store API.
 * Do not import it from other packages.
 *
 * Drizzle's `sql` tag spreads a JS array `${arr}` as a tuple of positional
 * parameters `($1, $2, ...)`. Inside `ANY(...)` that's parsed as a
 * row-expression and Postgres rejects it with `42809 op ANY/ALL (array)
 * requires array on right side`. Using `ANY(ARRAY[${sql.join(...)}])` with
 * one nested `sql\`${n}\`` per element preserves one bind param per name
 * (no concatenation, no injection surface) AND produces a real Postgres
 * array expression on the RHS.
 *
 * Matches the in-file precedent at line ~2950 (`ANY(ARRAY[${sql.join(...)}])`).
 */
export function _buildEffectiveStatusByIdentityQuery(
  schemaName: string,
  names: string[],
): SQL {
  return sql`SELECT package_name, organization_id, owner_level, owner_id, status
        FROM ${sql.raw(`"${schemaName.replaceAll('"', '""')}"."installed_extension"`)}
        WHERE package_name = ANY(ARRAY[${sql.join(
          names.map((n) => sql`${n}`),
          sql`, `,
        )}])`;
}

async function readEffectiveExtensionStatusByIdentity(
  candidates: { id: string; orgId: string | null; ownerLevel: string | null; ownerId: string | null; packageName: string }[],
): Promise<Map<string, "active" | "archived">> {
  const byTemplateId = new Map<string, "active" | "archived">();
  if (candidates.length === 0) return byTemplateId;
  const schemaName = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";
  const names = [...new Set(candidates.map((c) => c.packageName))];
  const res = await db.execute(_buildEffectiveStatusByIdentityQuery(schemaName, names));
  const rows = ((res as unknown as { rows?: unknown[] }).rows ?? []) as CanonicalManifestRow[];
  for (const c of candidates) {
    const status = pickEffectiveStatusForIdentity(c, rows);
    if (status) byTemplateId.set(c.id, status);
  }
  return byTemplateId;
}

export async function readActiveExtensionTemplates(vendorScope?: string): Promise<AgentTemplateRecord[]> {
  // status filter moved out of SQL onto the canonical
  // manifest (the per-kind column is dropped). Fetch the visibility-filtered
  // candidate set, then keep rows whose EFFECTIVE canonical status is active
  // (active|locked, or no canonical row → grandfather active).
  const rows = await db
    .select()
    .from(agentTemplates)
    .where(
      and(
        isNotNull(agentTemplates.packageName),
        // visibility filter
        or(
          sql`${agentTemplates.origin}->>'visibility' = 'public'`,
          sql`${agentTemplates.origin} IS NULL`,  // grandfather: legacy rows treated as public
          vendorScope
            ? sql`(${agentTemplates.origin}->>'visibility' = 'private' AND ${agentTemplates.origin}->>'scope' = ${vendorScope})`
            : sql`false`,
        ),
      ),
    )
    .orderBy(asc(agentTemplates.name));
  const statusByTemplateId = await readEffectiveExtensionStatusByIdentity(
    rows.map((r) => ({ id: r.id, orgId: r.orgId, ownerLevel: r.ownerLevel, ownerId: r.ownerId, packageName: r.packageName! })),
  );
  return rows
    .filter((r) => (statusByTemplateId.get(r.id) ?? "active") === "active")
    .map((r) => ({ ...deserializeTemplate(r), extensionLifecycleStatus: "active" as const }));
}

/**
 * Returns all agent_templates rows where packageName IS NOT NULL
 * AND extensionLifecycleStatus = 'archived', ordered by name asc.
 *
 * Visibility filter; UI-only filtering is forbidden.
 * See readActiveExtensionTemplates for the filter rationale.
 *
 * @param vendorScope - optional npm scope; when provided, private extensions
 *   matching this scope are included in results.
 */
export async function readArchivedExtensionTemplates(vendorScope?: string): Promise<AgentTemplateRecord[]> {
  // archived = EFFECTIVE canonical status archived (the row
  // HAS a canonical row and it is archived). A template with no canonical row
  // defaults to active and is therefore NOT listed as archived.
  const rows = await db
    .select()
    .from(agentTemplates)
    .where(
      and(
        isNotNull(agentTemplates.packageName),
        // visibility filter
        or(
          sql`${agentTemplates.origin}->>'visibility' = 'public'`,
          sql`${agentTemplates.origin} IS NULL`,  // grandfather: legacy rows treated as public
          vendorScope
            ? sql`(${agentTemplates.origin}->>'visibility' = 'private' AND ${agentTemplates.origin}->>'scope' = ${vendorScope})`
            : sql`false`,
        ),
      ),
    )
    .orderBy(asc(agentTemplates.name));
  const statusByTemplateId = await readEffectiveExtensionStatusByIdentity(
    rows.map((r) => ({ id: r.id, orgId: r.orgId, ownerLevel: r.ownerLevel, ownerId: r.ownerId, packageName: r.packageName! })),
  );
  return rows
    .filter((r) => statusByTemplateId.get(r.id) === "archived")
    .map((r) => ({ ...deserializeTemplate(r), extensionLifecycleStatus: "archived" as const }));
}

/**
 * Returns agent_templates rows whose agentDependencies JSONB object contains
 * the given packageName as a key (exact match via the `?` operator).
 * Used by the dep-cascade dispatcher.
 */
export async function readAgentTemplatesDependingOn(
  packageName: string,
): Promise<AgentTemplateRecord[]> {
  const rows = await db
    .select()
    .from(agentTemplates)
    .where(sql`${agentTemplates.agentDependencies}::jsonb ? ${packageName}`);
  return rows.map(deserializeTemplate);
}

/**
 * returns OTHER agent_templates whose COMPILED plan references
 * `packageName` as an embedded child (an orchestrator step's
 * `childAgent.packageName`, e.g. an orchestrator embedding a leaf agent as a
 * subflow). `agentDependencies` (the JSONB key set) is the declared
 * dep edge; the compiled `compiled_plan` / `approval_policy` JSON is the
 * *live runtime* edge and can exist independently. The
 * `extensions_purge` dependents hard-block must cover both. Substring match
 * on the JSON text intentionally errs toward over-detection — a false
 * positive blocks a destructive purge (fail-safe), never the reverse. Self
 * (the package being purged) is excluded.
 */
export async function readAgentTemplatesReferencingChildPackage(
  packageName: string,
): Promise<AgentTemplateRecord[]> {
  const needle = `%"${packageName}"%`;
  const rows = await db
    .select()
    .from(agentTemplates)
    .where(
      sql`(${agentTemplates.compiledPlan} LIKE ${needle} OR ${agentTemplates.approvalPolicy} LIKE ${needle}) AND ${agentTemplates.packageName} <> ${packageName}`,
    );
  return rows.map(deserializeTemplate);
}

// ---------------------------------------------------------------------------
// Destructive helper used ONLY by extensionRegistry
// .forceDelete(...) to satisfy the RESTRICT FKs that block raw template
// deletes. Removes every row whose FK targets the given template_id across:
//   - agent_runs.template_id
//   - agent_versions.template_id
//   - agent_template_versions.template_id
//   - agent_registry_entries.template_id
//   - agent_forks.forked_template_id
// Returns counts per table for audit/log visibility (caller may discard).
//
// IMPORTANT: this is the ONLY supported way to bypass the RESTRICT FKs added
// by the schema. Provenance is preserved by the
// extension_lifecycle_audit row that forceDelete writes BEFORE calling this
// helper — that audit row's destroyed_row_snapshot + dangling_references
// fields capture what was about to be removed. Direct callers outside the
// force-delete escape hatch will silently destroy run history; do not use
// this helper for any other purpose.
//
// The five deletes are wrapped in a single
// Drizzle transaction so they commit atomically. Without this, a partial
// failure (e.g. lock-timeout on delete #3) would commit deletes #1 and #2
// while leaving #3-#5 intact, and the audit row already written above would
// say "destroyed" — operators would have no signal that destruction was
// partial. There is still a small INSERT race window between this helper
// returning and handler.uninstall (which calls deleteAgentTemplate) —
// a concurrent INSERT into agent_runs referencing the same template_id
// would re-block the template delete with SQLSTATE 23503. That race is
// documented as an admin-only escape-hatch limitation; concurrent traffic
// against a force-delete target is unlikely in practice.
// ---------------------------------------------------------------------------
export async function removeReferencingRunRows(
  templateId: string,
): Promise<{
  agent_runs: number;
  agent_versions: number;
  agent_template_versions: number;
  agent_registry_entries: number;
  agent_forks: number;
}> {
  // Order matters: child rows (agent_runs, agent_run_messages, etc.) are
  // already FK-cascaded from agent_runs in the schema. We delete the FK
  // sources to agent_templates here. agent_runs deletion will cascade-delete
  // its own children (run_messages, hitl_prompts, run_co_owners, etc.).
  return await db.transaction(async (tx) => {
    // Clean up polymorphic
    // `extension_co_owners` + `extension_access_policy` rows for every
    // agent_run we're about to drop. The polymorphic tables have no FK
    // (one FK can't span multiple kind-specific resource tables), so the
    // app layer must do the cleanup BEFORE the agent_runs delete (after
    // would leave us with no way to find which run IDs to clean up).
    // Best-effort: log + continue on failure rather than abort the whole
    // force-delete.
    const schemaForCleanup = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";
    try {
      await tx.execute(sql.raw(
        `DELETE FROM "${schemaForCleanup.replaceAll('"', '""')}"."extension_co_owners"
         WHERE resource_kind = 'agent_run'
           AND resource_id IN (
             SELECT id FROM "${schemaForCleanup.replaceAll('"', '""')}"."agent_runs"
             WHERE template_id = '${templateId.replaceAll("'", "''")}'
           )`,
      ));
      await tx.execute(sql.raw(
        `DELETE FROM "${schemaForCleanup.replaceAll('"', '""')}"."extension_access_policy"
         WHERE resource_kind = 'agent_run'
           AND resource_id IN (
             SELECT id FROM "${schemaForCleanup.replaceAll('"', '""')}"."agent_runs"
             WHERE template_id = '${templateId.replaceAll("'", "''")}'
           )`,
      ));
    } catch (err) {
      console.warn(
        "[agents/store] polymorphic extension_co_owners/policy cleanup for force-delete agent_runs failed:",
        err instanceof Error ? err.message : err,
      );
    }
    const runsResult = await tx
      .delete(agentRuns)
      .where(eq(agentRuns.templateId, templateId));
    const versionsResult = await tx
      .delete(agentVersions)
      .where(eq(agentVersions.templateId, templateId));
    const templateVersionsResult = await tx
      .delete(agentTemplateVersions)
      .where(eq(agentTemplateVersions.templateId, templateId));
    const registryEntriesResult = await tx
      .delete(agentRegistryEntries)
      .where(eq(agentRegistryEntries.templateId, templateId));
    const forksResult = await tx
      .delete(agentForks)
      .where(eq(agentForks.forkedTemplateId, templateId));
    return {
      agent_runs: runsResult.rowCount ?? 0,
      agent_versions: versionsResult.rowCount ?? 0,
      agent_template_versions: templateVersionsResult.rowCount ?? 0,
      agent_registry_entries: registryEntriesResult.rowCount ?? 0,
      agent_forks: forksResult.rowCount ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// atomic DB purge for extensions_purge_execute.
//
// Atomicity guard: `removeReferencingRunRows` commits its own
// transaction, so doing it then a separate `deleteAgentTemplate` await
// leaves the DB mutated if the second step fails (partial = half-done).
// This helper does the WHOLE load-bearing DB delete in ONE transaction:
// polymorphic perms cleanup (agent_runs + the agent_template itself) → the
// 5 RESTRICT-FK source tables → the agent_templates row. Either all gone or
// none (tx rollback). Skills/skill_matches orphan cleanup stays best-effort
// AFTER commit (non-load-bearing — the template row being gone is the
// durable truth, mirrors the handler's existing semantics).
//
// Returns the FULL pre-delete row as `snapshot` for the audit/forensics
// trail (NOT used for rollback — the saga restores disk from quarantine,
// and once this tx commits the only remaining saga step is the irreversible
// Verdaccio unpublish, which has nothing after it to roll back).
// ---------------------------------------------------------------------------
export async function purgeAgentTemplateAtomic(
  packageName: string,
): Promise<{
  deleted: boolean;
  snapshot: AgentTemplateRecord | null;
  removed: {
    agent_runs: number;
    agent_versions: number;
    agent_template_versions: number;
    agent_registry_entries: number;
    agent_forks: number;
  };
}> {
  const schemaName = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";
  const q = (id: string) => id.replaceAll("'", "''");
  const s = schemaName.replaceAll('"', '""');

  const result = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(agentTemplates)
      .where(eq(agentTemplates.packageName, packageName))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return {
        deleted: false,
        snapshot: null,
        removed: {
          agent_runs: 0,
          agent_versions: 0,
          agent_template_versions: 0,
          agent_registry_entries: 0,
          agent_forks: 0,
        },
      };
    }
    const snapshot = deserializeTemplate(row);
    const templateId = row.id;

    // Polymorphic cleanup for the agent_runs we're about to drop + the
    // agent_template itself (no FK can span kind-specific resource tables).
    for (const polyTable of ["extension_co_owners", "extension_access_policy"]) {
      await tx.execute(
        sql.raw(
          `DELETE FROM "${s}"."${polyTable}"
             WHERE resource_kind = 'agent_run'
               AND resource_id IN (
                 SELECT id FROM "${s}"."agent_runs"
                 WHERE template_id = '${q(templateId)}'
               )`,
        ),
      );
      await tx.execute(
        sql.raw(
          `DELETE FROM "${s}"."${polyTable}"
             WHERE resource_kind = 'agent_template'
               AND resource_id = '${q(templateId)}'`,
        ),
      );
    }

    // The 5 RESTRICT-FK source tables (agent_runs cascade-deletes its own
    // children: run_messages, hitl_prompts, run_co_owners, ...).
    const runsResult = await tx
      .delete(agentRuns)
      .where(eq(agentRuns.templateId, templateId));
    const versionsResult = await tx
      .delete(agentVersions)
      .where(eq(agentVersions.templateId, templateId));
    const templateVersionsResult = await tx
      .delete(agentTemplateVersions)
      .where(eq(agentTemplateVersions.templateId, templateId));
    const registryEntriesResult = await tx
      .delete(agentRegistryEntries)
      .where(eq(agentRegistryEntries.templateId, templateId));
    const forksResult = await tx
      .delete(agentForks)
      .where(eq(agentForks.forkedTemplateId, templateId));

    // The template row itself — atomic with everything above.
    await tx.delete(agentTemplates).where(eq(agentTemplates.id, templateId));

    return {
      deleted: true,
      snapshot,
      removed: {
        agent_runs: runsResult.rowCount ?? 0,
        agent_versions: versionsResult.rowCount ?? 0,
        agent_template_versions: templateVersionsResult.rowCount ?? 0,
        agent_registry_entries: registryEntriesResult.rowCount ?? 0,
        agent_forks: forksResult.rowCount ?? 0,
      },
    };
  });
  // Mirror deleteAgentTemplate's object-shadow
  // cleanup so the objects shadow table does not point at a purged template.
  // pointing at a purged template). Post-commit, like deleteAgentTemplate.
  if (result.deleted && result.snapshot) {
    shadowDeleteObject(result.snapshot.id);
  }
  return result;
}

// ---------------------------------------------------------------------------
// origin JSONB helpers.
//
// readAgentTemplateOrigin — used by resolveInstallEnvironment to determine
// which registry URL + routing topology to use for a given extension.
//
// updateAgentTemplateOrigin — called by every publish path (publishToRegistry,
// handleAgentBuilderGitPublish, importAgentTemplateCore) after successful
// publish to persist coordinates. Tokens MUST NOT appear in origin;
// the caller writes only opaque destinationId.
// ---------------------------------------------------------------------------

/**
 * Reads the origin JSONB from the agent_templates row identified by packageName.
 * Returns null for legacy rows (origin IS NULL) — callers treat null as
 * "public" (grandfather clause).
 */
export async function readAgentTemplateOrigin(packageName: string): Promise<ExtensionOrigin | null> {
  const rows = await db
    .select({ origin: agentTemplates.origin })
    .from(agentTemplates)
    .where(eq(agentTemplates.packageName, packageName))
    .limit(1);
  return (rows[0]?.origin as ExtensionOrigin | null | undefined) ?? null;
}

/**
 * Persists origin coordinates on the agent_templates row after a successful publish.
 *
 * Tokens MUST NOT appear in origin. Only opaque coordinates are written:
 * packageName, version, destinationId (opaque key — no token), scope, visibility,
 * registryUrl, and optional importedFrom provenance.
 *
 * Called by: publishToRegistry (actions.ts), handleAgentBuilderGitPublish (mcp/handlers.ts),
 * importAgentTemplateCore (import-agent-core.ts).
 */
export async function updateAgentTemplateOrigin(
  packageName: string,
  origin: ExtensionOrigin,
): Promise<void> {
  await db
    .update(agentTemplates)
    .set({ origin })
    .where(eq(agentTemplates.packageName, packageName));
}

/**
 * updates the visibility field on the origin JSONB of an
 * agent_templates row after a successful promotion.
 *
 * Preserves all other origin fields (importedFrom, version, scope, etc.).
 * Current behavior supports only private→public. Callers are responsible for
 * enforcing that direction; this helper does NOT guard direction.
 *
 * Called exclusively by promoteExtensionToPublicAction after a successful
 * registry publish.
 */
export async function updateAgentTemplateVisibility(
  packageName: string,
  visibility: "public" | "private",
  registryUrl: string,
): Promise<void> {
  const existing = await readAgentTemplateOrigin(packageName);
  if (!existing) {
    throw new Error(`No origin row found for package ${packageName}`);
  }
  const updated: ExtensionOrigin = {
    ...existing,
    visibility,
    // When promoting to public, clear the private destinationId;
    // it is no longer the routing destination. When demoting (future), callers
    // must supply the destinationId explicitly.
    destinationId: visibility === "private" ? existing.destinationId : null,
    registryUrl,
  };
  await db
    .update(agentTemplates)
    .set({ origin: updated })
    .where(eq(agentTemplates.packageName, packageName));
}
