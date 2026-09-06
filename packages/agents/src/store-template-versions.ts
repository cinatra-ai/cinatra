// Agent-template version rows — create, read, bump classification, changelog.
//
// Extracted VERTICAL SLICE out of ./store (cinatra#2653 fix round): the
// executor-threaded publish cores pushed store.ts over its one-way file-size
// ratchet ceiling, and the version-row concern (immutable per-save snapshots
// with semver, bump type and content hash) is a cohesive seam that stands
// alone — the same split ./template-snapshot took in #1708. ./store
// re-exports every public name here, so every existing `from "./store"` /
// `@cinatra-ai/agents` consumer is untouched. The `_`-prefixed executor cores
// are exported for ./store's `publishAgentTemplateAndBindVersion` only.
//
// NOTE for the route-graph ratchet: this module is reachable wherever ./store
// is (the re-export edge), but it pulls NO new subtree — its only first-party
// imports are the already-reachable ./db, ./schema, ./template-snapshot and
// type-only ./store types.

import { eq, and, desc, lt } from "drizzle-orm";
import { EXECUTION_ENVIRONMENT_INVALID_DECLARATION_KEY } from "@cinatra-ai/sdk-extensions";
import type { AgentIOSpec } from "@cinatra-ai/objects";
import type { ExtensionOrigin, ConnectorDependencyMap, AgentDependencyMap } from "./schema";
import type { GatedStep } from "./trigger-infer-side-effects";
import { derivePackageName } from "./agent-template-identity";
import { parseAuthPolicySafe } from "./agent-run-serde";
import { randomUUID } from "node:crypto";
import semver from "semver";
import { db } from "./db";
import { agentTemplates, agentTemplateVersions } from "./schema";
import {
  buildSnapshotFromTemplate,
  computeSnapshotContentHash,
} from "./template-snapshot";
import type {
  AgentTemplateRecord,
  ApprovalPolicy,
  CompiledStep,
  CreateAgentTemplateInput,
  AgentTemplateWriteExecutor,
  AgentTemplateVersionRecord,
  AgentTemplateVersionSnapshot,
  ReadAgentTemplateVersionsOptions,
  AgentTemplateVersionListPage,
} from "./store";

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
  return _createAgentTemplateVersion(db, input);
}

/**
 * Executor-threaded core of {@link createAgentTemplateVersion} (cinatra#2653
 * rework). The MAX(version_number)+1 read-then-insert below is race-prone on
 * the pool; running it on a caller-supplied transaction closes that window in
 * addition to making multi-statement publish flows atomic.
 */
async function _createAgentTemplateVersion(
  exec: AgentTemplateWriteExecutor,
  input: {
    templateId: string;
    semver: string;
    bumpType: "major" | "minor" | "patch";
    changelogLine: string | null;
    contentHash: string;
    snapshot: AgentTemplateVersionSnapshot;
    createdBy: string | null;
  },
): Promise<AgentTemplateVersionRecord> {
  // Compute next versionNumber = MAX(version_number) + 1 (server-side, never client-provided)
  const existing = await exec
    .select({ versionNumber: agentTemplateVersions.versionNumber })
    .from(agentTemplateVersions)
    .where(eq(agentTemplateVersions.templateId, input.templateId))
    .orderBy(desc(agentTemplateVersions.versionNumber))
    .limit(1);
  const nextVersionNumber = existing.length > 0 ? existing[0].versionNumber + 1 : 1;

  const id = randomUUID();
  const now = new Date();
  await exec.insert(agentTemplateVersions).values({
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
  return _readLatestAgentTemplateVersion(db, templateId);
}

/** Executor-threaded core of {@link readLatestAgentTemplateVersion}. */
async function _readLatestAgentTemplateVersion(
  exec: AgentTemplateWriteExecutor,
  templateId: string,
): Promise<AgentTemplateVersionRecord | null> {
  const rows = await exec
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

  // Fetch page — cursor is the versionNumber we last saw; fetch items with
  // versionNumber < cursor. The cursor arrives from the caller and can be
  // arbitrary: a non-integer value would bind NaN to an integer column
  // (CodeRabbit finding), so a malformed cursor is treated as absent.
  const cursorValue = opts.cursor !== undefined ? Number(opts.cursor) : undefined;
  const whereClauses = cursorValue !== undefined && Number.isInteger(cursorValue)
    ? and(
        eq(agentTemplateVersions.templateId, templateId),
        lt(agentTemplateVersions.versionNumber, cursorValue),
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
  semverValue: string,
): Promise<AgentTemplateVersionRecord | null> {
  const rows = await db
    .select()
    .from(agentTemplateVersions)
    .where(
      and(
        eq(agentTemplateVersions.templateId, templateId),
        eq(agentTemplateVersions.semver, semverValue),
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
  return _createAgentTemplateVersionIfChanged(db, template, opts);
}

/**
 * Executor-threaded core of {@link createAgentTemplateVersionIfChanged}
 * (cinatra#2653 rework): the latest-version read, the version insert AND the
 * `current_version_id` pointer advance all run on the SAME executor, so a
 * caller-supplied transaction makes the whole save atomic. Public callers keep
 * the pool-backed wrapper above, byte-compatible. Exported ONLY for ./store's
 * `publishAgentTemplateAndBindVersion` transaction.
 */
export async function _createAgentTemplateVersionIfChanged(
  exec: AgentTemplateWriteExecutor,
  template: AgentTemplateRecord,
  opts: {
    changelogLine?: string | null;
    bumpTypeOverride?: "major" | "minor" | "patch";
    createdBy?: string | null;
  } = {},
): Promise<{ version: AgentTemplateVersionRecord; created: boolean }> {
  const snapshot = buildSnapshotFromTemplate(template);
  const contentHash = computeSnapshotContentHash(snapshot);

  const latest = await _readLatestAgentTemplateVersion(exec, template.id);

  // Dedup — a no-op save returns the existing latest version. REPAIR
  // (cinatra#2653): even in the dedup case, re-point `current_version_id`
  // when it is not already bound to this latest version — a partially-failed
  // earlier publish (flip landed, binding did not) must be healed by retry,
  // never masked.
  if (latest && latest.contentHash === contentHash) {
    if (template.currentVersionId !== latest.id) {
      await exec
        .update(agentTemplates)
        .set({ currentVersionId: latest.id })
        .where(eq(agentTemplates.id, template.id));
    }
    return { version: latest, created: false };
  }

  // First version always uses the initial semver value regardless of bumpType
  if (!latest) {
    const version = await _createAgentTemplateVersion(exec, {
      templateId: template.id,
      semver: "1.0.0",
      bumpType: opts.bumpTypeOverride ?? "patch",
      changelogLine: opts.changelogLine ?? "Initial save",
      contentHash,
      snapshot,
      createdBy: opts.createdBy ?? null,
    });
    // Advance current_version_id pointer to the new version
    await exec.update(agentTemplates).set({ currentVersionId: version.id }).where(eq(agentTemplates.id, template.id));
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

  const version = await _createAgentTemplateVersion(exec, {
    templateId: template.id,
    semver: nextSemver,
    bumpType,
    changelogLine: opts.changelogLine ?? autoChangelog(bumpType, latest, snapshot),
    contentHash,
    snapshot,
    createdBy: opts.createdBy ?? null,
  });
  // Advance current_version_id pointer to the new version
  await exec.update(agentTemplates).set({ currentVersionId: version.id }).where(eq(agentTemplates.id, template.id));

  return { version, created: true };
}

/**
 * Auto-generated changelog line for a save that did not supply one.
 */
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
// agent_templates row codec
// ---------------------------------------------------------------------------
// The row <-> record mapping lives with the other agent_templates row work
// instead of in a module of its own: a separate file put a NEW node on every
// locked route graph that reaches ./store (cinatra#3208 route-graph ratchet).
// Pure row mapping: no db handle, no query, no side effect. ./store re-exports
// deserializeTemplate, so every existing ./store importer is unchanged.


export function serializeTemplate(input: CreateAgentTemplateInput) {
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
    // The compiled manifest lifecycle declaration (already JSON-as-text from the
    // install seed / builder). null on create when the manifest declares none.
    lifecycleConfig: input.lifecycleConfig ?? null,
    // The locally-persisted binding-presence authority (cinatra#2498). null on
    // create when the caller does not derive it from a compile (e.g. a legacy
    // fixture) — treated as "unknown", the same fail-closed posture every row
    // had before this column existed.
    hasArtifactBindings: input.hasArtifactBindings ?? null,
    // The executed artifact-binding declaration (cinatra#3208), already
    // JSON-as-text from the install seed. null on create when the caller does
    // not derive it from a compile — "unknown", the pre-#3208 fallback.
    artifactBindings: input.artifactBindings ?? null,
    // template-level AgentAuthPolicy as JSON-as-text. null = use
    // DEFAULT_AGENT_AUTH_POLICY at read time.
    agentAuthPolicy: input.agentAuthPolicy ? JSON.stringify(input.agentAuthPolicy) : null,
  };
}

export function deserializeTemplate(row: typeof agentTemplates.$inferSelect): AgentTemplateRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    ownerLevel: row.ownerLevel ?? null,
    ownerId: row.ownerId ?? null,
    creatorId: row.creatorId,
    name: row.name,
    description: row.description,
    sourceNl: row.sourceNl,
    compiledPlan: JSON.parse(row.compiledPlan) as CompiledStep[],
    inputSchema: JSON.parse(row.inputSchema) as Record<string, unknown>,
    outputSchema: row.outputSchema ? (JSON.parse(row.outputSchema) as Record<string, unknown>) : null,
    approvalPolicy: JSON.parse(row.approvalPolicy) as ApprovalPolicy,
    status: row.status,
    // Normalize null / legacy / unknown values to "leaf"; OAS-aligned "flow"|"node" preserved.
    type: (row.type === "proxy" ? "proxy"
         : row.type === "orchestrator" ? "orchestrator"
         : row.type === "parallel" ? "parallel"
         : row.type === "supervisor" ? "supervisor"
         : row.type === "iterative" ? "iterative"
         : row.type === "node" ? "node"
         : row.type === "flow" ? "flow"
         : "leaf") as AgentTemplateRecord["type"],
    agentKind: row.agentKind === "assistant" ? "assistant" : "executor", // #1037: only an explicit "assistant" opts in; else the column DEFAULT ("executor")
    taskSpec: row.taskSpec,
    packageName: row.packageName ?? null,
    packageVersion: row.packageVersion ?? null,
    currentVersionId: row.currentVersionId ?? null,
    hitlScreens: row.hitlScreens ? (JSON.parse(row.hitlScreens) as string[]) : null,
    agentDependencies: row.agentDependencies
      ? (JSON.parse(row.agentDependencies) as AgentDependencyMap)
      : {},
    connectorDependencies: row.connectorDependencies
      ? (JSON.parse(row.connectorDependencies) as ConnectorDependencyMap)
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
    // Compiled manifest lifecycle stays JSON-as-text on the record; the lifecycle
    // readers parse it fail-soft at their own call sites.
    lifecycleConfig: row.lifecycleConfig ?? null,
    // The locally-persisted binding-presence authority (cinatra#2498). Native
    // boolean column; null (unknown) passes through unchanged.
    hasArtifactBindings: row.hasArtifactBindings ?? null,
    // The executed artifact-binding declaration (cinatra#3208) stays
    // JSON-as-text on the record; the materializer parses it fail-closed
    // through the single grammar (parseArtifactBindingDeclaration).
    artifactBindings: row.artifactBindings ?? null,
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
    // Per-agent execution config (cinatra#1708 slice B). The declared
    // environment stays RAW on the record — every consumer runs it through the
    // fail-closed `parseExecutionEnvironment` (a JSON.parse here would have to
    // choose a failure mode for malformed stored text, and "silently no
    // environment" is exactly the outcome the fail-closed doctrine forbids).
    // Unparseable text therefore surfaces as an INVALID declaration downstream,
    // never as "no environment".
    executionEnvironment: parseStoredExecutionEnvironment(row.executionEnvironment),
    executionEnabled: row.executionEnabled ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * JSON-as-text → the RAW declared value handed to `parseExecutionEnvironment`.
 * `null`/empty column ⇒ `null` ("no declared environment"). Text that is not
 * JSON at all cannot be "no environment" (that would silently drop a
 * declaration the author made), so it resolves to the sdk leaf's
 * present-but-malformed POISON marker, which the parser rejects with a precise
 * error at consumption — the same doctrine the manifest claim resolver uses.
 */
function parseStoredExecutionEnvironment(stored: string | null | undefined): unknown {
  if (stored == null || stored.trim() === "") return null;
  try {
    return JSON.parse(stored) as unknown;
  } catch {
    return { [EXECUTION_ENVIRONMENT_INVALID_DECLARATION_KEY]: true };
  }
}
