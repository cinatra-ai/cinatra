// ---------------------------------------------------------------------------
// Server-side agent export / import (cinatra#255 G2).
//
// Re-homes the read (`cinatra agent export`) and authoring write
// (`cinatra agent import`) that the CLI performs directly against the
// `agent_templates` / `agent_versions` tables today onto authenticated server
// contracts. The portable `agent.json` document shape (formatVersion 1) stays
// CLI-archive-compatible so a ZIP exported by either path imports cleanly.
//
// SCHEMA NOTE — this writes the CURRENT `agent_templates` schema, NOT the
// CLI's stale legacy INSERT:
//   * `execution_mode` was DROPPED from the table (drizzle-store.ts boot
//     migration "DROP COLUMN IF EXISTS execution_mode"). We keep it ONLY at the
//     archive boundary (a vestigial `executionMode` field in `agent.json` for
//     back-compat with old archives) and never read/write the column.
//   * `package_name` is now NOT NULL. The import generates a deterministic,
//     unique identity (`cli-import/<slug>-<uuid>`) so the row is schema-valid.
//   * `type` defaults to `leaf` server-side; we do not set it.
//
// AUTHORING, NON-DESTRUCTIVE: `importAgentTemplate` INSERTs a brand-new draft
// template (fresh UUID) + an initial version row. It never updates or deletes
// an existing template — safe to expose ahead of the G3 hardening.
//
// SCOPING: these helpers query/insert by id/name with NO org predicate, so the
// routes that call them are platform-admin-only (see route-guard + the route
// handlers). Org-admins are NOT given cross-org agent reach here.
// ---------------------------------------------------------------------------

import { createHash, randomUUID } from "node:crypto";

import { betterAuthPool } from "@/lib/better-auth-db";

/** The configured Cinatra schema (mirrors the CLI's resolution exactly). */
function getSchemaName(): string {
  return process.env.SUPABASE_SCHEMA?.trim() || "cinatra";
}

/** Quote a Postgres identifier, doubling embedded quotes. */
function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** The portable agent document, formatVersion 1 (CLI-archive-compatible). */
export type AgentExportDocument = {
  formatVersion: 1;
  id: string;
  name: string;
  description: string | null;
  sourceNl: string;
  /**
   * Vestigial archive-format field. The DB column was dropped; we emit a
   * constant so old importers that still read it do not break. Never sourced
   * from or written to the table.
   */
  executionMode: string;
  compiledPlan: unknown[];
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  approvalPolicy: Record<string, unknown>;
  taskSpec: string | null;
  status: string;
  exportedAt: string;
};

export type AgentManifest = {
  version: 1;
  exportedAt: string;
  cinatra: "agent-builder-v1";
};

function parseToArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return [];
  try {
    const p: unknown = JSON.parse(raw);
    if (Array.isArray(p)) return p;
    if (typeof p === "string") return parseToArray(p);
    return [];
  } catch {
    return [];
  }
}

function parseToObject<T>(raw: unknown, fallback: T): T {
  if (raw !== null && typeof raw === "object") return raw as T;
  if (typeof raw !== "string") return fallback;
  try {
    const p: unknown = JSON.parse(raw);
    return p !== null && typeof p === "object" ? (p as T) : fallback;
  } catch {
    return fallback;
  }
}

type AgentTemplateRow = {
  id: string;
  name: string;
  description: string | null;
  source_nl: string | null;
  compiled_plan: unknown;
  input_schema: unknown;
  output_schema: unknown;
  approval_policy: unknown;
  task_spec: string | null;
  status: string | null;
};

// The exact (non-`SELECT *`) column set the export reads. Pinning the columns
// keeps the read resilient to unrelated schema additions and documents the
// contract. `execution_mode` is deliberately absent (dropped column).
const EXPORT_COLUMNS =
  "id, name, description, source_nl, compiled_plan, input_schema, output_schema, approval_policy, task_spec, status";

/**
 * Export an agent template by id or (case-insensitive) name into the portable
 * document shape. Returns `null` when no template matches — the route turns
 * that into a 404. Read-only.
 */
export async function exportAgentTemplate(
  query: string,
): Promise<{ document: AgentExportDocument; manifest: AgentManifest } | null> {
  const schema = quoteIdentifier(getSchemaName());

  let row = (
    await betterAuthPool.query<AgentTemplateRow>(
      `SELECT ${EXPORT_COLUMNS} FROM ${schema}.agent_templates WHERE id = $1 LIMIT 1`,
      [query],
    )
  ).rows[0];

  if (!row) {
    row = (
      await betterAuthPool.query<AgentTemplateRow>(
        `SELECT ${EXPORT_COLUMNS} FROM ${schema}.agent_templates WHERE lower(name) = lower($1) LIMIT 1`,
        [query],
      )
    ).rows[0];
  }

  if (!row) return null;

  const exportedAt = new Date().toISOString();
  const document: AgentExportDocument = {
    formatVersion: 1,
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    sourceNl: row.source_nl ?? "",
    // Archive-format vestige; the column no longer exists.
    executionMode: "deterministic",
    compiledPlan: parseToArray(row.compiled_plan),
    inputSchema: parseToObject<Record<string, unknown>>(row.input_schema, {}),
    outputSchema: row.output_schema
      ? parseToObject<Record<string, unknown> | null>(row.output_schema, null)
      : null,
    approvalPolicy: parseToObject<Record<string, unknown>>(row.approval_policy, {
      steps: [],
    }),
    taskSpec: row.task_spec ?? null,
    status: row.status ?? "draft",
    exportedAt,
  };

  const manifest: AgentManifest = {
    version: 1,
    exportedAt,
    cinatra: "agent-builder-v1",
  };

  return { document, manifest };
}

export type ImportAgentResult = {
  id: string;
  name: string;
  packageName: string;
};

/** Build a slug from a name for the generated package identity. */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "imported";
}

/**
 * Import a portable agent document as a NEW draft template (fresh UUID) plus an
 * initial version row, writing the CURRENT schema (no `execution_mode`,
 * NOT-NULL `package_name`). Authoring-only: never mutates or deletes an
 * existing template.
 *
 * @throws when the document is not a recognized formatVersion-1 agent.
 */
export async function importAgentTemplate(
  document: unknown,
  options?: { nameOverride?: string | null; creatorId?: string | null },
): Promise<ImportAgentResult> {
  if (
    document === null ||
    typeof document !== "object" ||
    (document as { formatVersion?: unknown }).formatVersion !== 1
  ) {
    const fv = (document as { formatVersion?: unknown } | null)?.formatVersion;
    throw new Error(`Unsupported agent.json formatVersion: ${String(fv)}`);
  }

  const agent = document as Partial<AgentExportDocument>;
  const importedName =
    options?.nameOverride?.trim() || agent.name || "Imported Agent";

  const schema = quoteIdentifier(getSchemaName());
  const newId = randomUUID();
  // Globally-unique, ROUTEABLE package identity. Must match the strict
  // `@vendor/slug` regex the agent runtime enforces
  // (`/^@([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/`, see
  // packages/agents/src/wayflow-url.ts + mcp/discovery.ts) — otherwise the
  // template is marked unrouteable. The trailing lowercase-hex UUID guarantees
  // uniqueness so re-importing the same archive never collides on package_name.
  const packageName = `@cli-import/${slugify(importedName)}-${newId}`;

  // Serialize structured fields to the stored string form (NOT NULL columns).
  const compiledPlan = serializeForStore(agent.compiledPlan, "[]");
  const inputSchema = serializeForStore(agent.inputSchema, "{}");
  const outputSchema =
    agent.outputSchema == null ? null : serializeForStore(agent.outputSchema, "null");
  const approvalPolicy = serializeForStore(agent.approvalPolicy, "{}");

  await betterAuthPool.query(
    `INSERT INTO ${schema}.agent_templates
       (id, name, description, source_nl, compiled_plan, input_schema, output_schema, approval_policy, task_spec, status, package_name, creator_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft', $10, $11)`,
    [
      newId,
      importedName,
      agent.description ?? null,
      agent.sourceNl ?? "",
      compiledPlan,
      inputSchema,
      outputSchema,
      approvalPolicy,
      agent.taskSpec ?? null,
      packageName,
      options?.creatorId ?? null,
    ],
  );

  const snapshotStr = JSON.stringify({
    compiledPlan: agent.compiledPlan,
    inputSchema: agent.inputSchema,
    taskSpec: agent.taskSpec,
  });
  const contentHash = createHash("sha256").update(snapshotStr).digest("hex");

  await betterAuthPool.query(
    `INSERT INTO ${schema}.agent_versions (id, template_id, content_hash, snapshot)
     VALUES ($1, $2, $3, $4)`,
    [randomUUID(), newId, contentHash, snapshotStr],
  );

  return { id: newId, name: importedName, packageName };
}

/** Coerce a structured value to its stored string form, defaulting on null. */
function serializeForStore(value: unknown, fallback: string): string {
  if (value == null) return fallback;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export { getSchemaName, quoteIdentifier };
