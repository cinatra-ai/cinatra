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
