import "server-only";

// THE EXTENSION-DATA TOOL (cinatra#3031, epic #3023 W7; plan (C) enabler 0.25).
//
// "one tool on the passthrough and the self-served tool set, operating only on
// the calling extension's declared tables and declared columns — select,
// insert, update and delete on the caller's own rows — with the caller derived
// from the run's extension identity, the organisation column injected by the
// host, parameters only, no raw statement, and every write recorded with the
// table and the row keys."
//
// So: no statement crosses this boundary. A request names an operation, a
// DECLARED table, DECLARED columns and equality values; the host compiles that
// into one parameterized statement and executes it UNDER THE EXTENSION'S OWN
// DATABASE ROLE. Two independent fences, and the second one is not ours:
//
//   1. the builder refuses a table or a column the manifest does not declare,
//      with a named reason;
//   2. the role holds SELECT/INSERT/UPDATE/DELETE on the extension's prefixed
//      tables and nothing else, so a bug in (1) still cannot reach another
//      extension's table — PostgreSQL refuses it.
//
// THE ORGANISATION IS THE HOST'S TO WRITE. It is injected into every WHERE and
// every INSERT from the run's own organisation; a request that tries to name it
// is REFUSED rather than silently overridden, because a caller that believes it
// chose the tenant and did not is the shape a cross-tenant read hides in.
//
// The reserved `db` host port for server-entry code stays reserved (0.25): this
// is a flow's road, not a second general database surface.

import {
  declaredTablePhysicalName,
  extensionDatabaseRoleName,
  type DeclaredTable,
} from "@cinatra-ai/sdk-extensions/manifest";

export const EXTENSION_DATA_OPERATIONS = ["select", "insert", "update", "delete"] as const;
export type ExtensionDataOperation = (typeof EXTENSION_DATA_OPERATIONS)[number];

/** The default and the ceiling for a select. */
export const EXTENSION_DATA_DEFAULT_LIMIT = 100;
export const EXTENSION_DATA_MAX_LIMIT = 1000;

export type ExtensionDataRequest = {
  operation: ExtensionDataOperation;
  /** The DECLARATION-LOCAL table name, never the physical one. */
  table: string;
  /** Select projection. Absent = every declared column. */
  columns?: string[];
  /** insert / update column values. */
  values?: Record<string, unknown>;
  /** Equality predicates, declared columns only. */
  where?: Record<string, unknown>;
  limit?: number;
};

export type CompiledExtensionDataStatement = {
  text: string;
  values: unknown[];
  /** The physical table the statement touches — what the audit records. */
  physicalTable: string;
  /** The declared columns the statement writes or filters on — the row keys. */
  rowKeys: Record<string, unknown>;
};

export class ExtensionDataRefusal extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "ExtensionDataRefusal";
    this.reason = reason;
  }
}

const qi = (id: string) => `"${id.replaceAll('"', '""')}"`;

/**
 * Compile ONE request into ONE parameterized statement. Pure: what an extension
 * can make the database do is readable here rather than only in a log.
 */
export function buildExtensionDataStatement(input: {
  packageName: string;
  schemaName: string;
  tables: readonly DeclaredTable[];
  /** The run's organisation — the host's value, never the caller's. */
  orgId: string;
  request: ExtensionDataRequest;
}): CompiledExtensionDataStatement {
  const { request } = input;
  if (!(EXTENSION_DATA_OPERATIONS as readonly string[]).includes(request.operation)) {
    throw new ExtensionDataRefusal(
      "unknown-operation",
      `extension_data: "${request.operation}" is not one of ${EXTENSION_DATA_OPERATIONS.join(", ")}`,
    );
  }
  if (!input.orgId) {
    throw new ExtensionDataRefusal(
      "no-organisation",
      "extension_data: the run carries no organisation — refusing rather than reading across tenants",
    );
  }
  const table = input.tables.find((t) => t.name === request.table);
  if (!table) {
    throw new ExtensionDataRefusal(
      "table-not-declared",
      `extension_data: ${input.packageName} does not declare a table named "${request.table}" — ` +
        `the tool operates only on the calling extension's declared tables`,
    );
  }
  const declared = new Set(table.columns.map((c) => c.name));
  const orgCol = table.organizationColumn;
  const assertColumn = (name: string, role: string) => {
    if (!declared.has(name)) {
      throw new ExtensionDataRefusal(
        "column-not-declared",
        `extension_data: "${name}" (${role}) is not a declared column of "${table.name}"`,
      );
    }
    if (name === orgCol) {
      throw new ExtensionDataRefusal(
        "organisation-is-the-hosts",
        `extension_data: the organisation column "${orgCol}" is injected by the host — a request ` +
          `may not name it`,
      );
    }
  };

  const physical = declaredTablePhysicalName(input.packageName, table.name);
  const target = `${qi(input.schemaName)}.${qi(physical)}`;
  const values: unknown[] = [];
  const p = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };
  const rowKeys: Record<string, unknown> = {};

  const whereEntries = Object.entries(request.where ?? {});
  for (const [k] of whereEntries) assertColumn(k, "where");
  const buildWhere = () => {
    const parts = [`${qi(orgCol)} = ${p(input.orgId)}`];
    for (const [k, v] of whereEntries) {
      parts.push(`${qi(k)} = ${p(v)}`);
      rowKeys[k] = v;
    }
    return parts.join(" AND ");
  };

  const projection = (() => {
    if (!request.columns || request.columns.length === 0) {
      return table.columns.map((c) => qi(c.name)).join(", ");
    }
    for (const c of request.columns) {
      if (!declared.has(c)) {
        throw new ExtensionDataRefusal(
          "column-not-declared",
          `extension_data: "${c}" (projection) is not a declared column of "${table.name}"`,
        );
      }
    }
    return request.columns.map(qi).join(", ");
  })();

  if (request.operation === "select") {
    const limit = Math.min(
      Math.max(1, request.limit ?? EXTENSION_DATA_DEFAULT_LIMIT),
      EXTENSION_DATA_MAX_LIMIT,
    );
    const where = buildWhere();
    return {
      text: `SELECT ${projection} FROM ${target} WHERE ${where} LIMIT ${limit}`,
      values,
      physicalTable: physical,
      rowKeys,
    };
  }

  if (request.operation === "insert") {
    const entries = Object.entries(request.values ?? {});
    if (entries.length === 0) {
      throw new ExtensionDataRefusal("no-values", "extension_data: insert needs at least one value");
    }
    for (const [k] of entries) assertColumn(k, "value");
    const cols = [orgCol, ...entries.map(([k]) => k)];
    const placeholders = [p(input.orgId), ...entries.map(([, v]) => p(v))];
    for (const [k, v] of entries) rowKeys[k] = v;
    return {
      text:
        `INSERT INTO ${target} (${cols.map(qi).join(", ")}) VALUES (${placeholders.join(", ")}) ` +
        `RETURNING ${projection}`,
      values,
      physicalTable: physical,
      rowKeys,
    };
  }

  if (request.operation === "update") {
    const entries = Object.entries(request.values ?? {});
    if (entries.length === 0) {
      throw new ExtensionDataRefusal("no-values", "extension_data: update needs at least one value");
    }
    for (const [k] of entries) assertColumn(k, "value");
    const sets = entries.map(([k, v]) => `${qi(k)} = ${p(v)}`).join(", ");
    for (const [k, v] of entries) rowKeys[k] = v;
    const where = buildWhere();
    return {
      text: `UPDATE ${target} SET ${sets} WHERE ${where} RETURNING ${projection}`,
      values,
      physicalTable: physical,
      rowKeys,
    };
  }

  const where = buildWhere();
  return {
    text: `DELETE FROM ${target} WHERE ${where} RETURNING ${projection}`,
    values,
    physicalTable: physical,
    rowKeys,
  };
}

export type ExtensionDataResult = {
  rows: Record<string, unknown>[];
  rowCount: number;
  table: string;
};

type MinimalClient = {
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: unknown[]; rowCount: number | null }>;
};

/**
 * Execute one compiled statement under the EXTENSION'S OWN ROLE.
 *
 * `SET LOCAL ROLE` inside the statement's own transaction: the role is scoped to
 * that transaction and cannot outlive it even if the statement raises, so a
 * pooled connection is never handed back wearing an extension's identity.
 */
export async function executeExtensionDataStatement(input: {
  client: MinimalClient;
  roleName: string;
  compiled: CompiledExtensionDataStatement;
}): Promise<ExtensionDataResult> {
  const { client, compiled } = input;
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL ROLE ${qi(input.roleName)}`);
    const res = await client.query(compiled.text, compiled.values);
    await client.query("COMMIT");
    return {
      rows: res.rows as Record<string, unknown>[],
      rowCount: res.rowCount ?? (res.rows as unknown[]).length,
      table: compiled.physicalTable,
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

/**
 * The tool, end to end: compile, execute under the extension's role, audit.
 * Every outcome — allowed and refused alike — is recorded with the calling
 * extension, the table and the row keys (§8.7, "audited with the calling
 * extension"; 0.25, "every write recorded with the table and the row keys").
 */
export async function runExtensionDataOperation(input: {
  client: MinimalClient;
  schemaName: string;
  packageName: string;
  tables: readonly DeclaredTable[];
  orgId: string;
  runId: string;
  actorPrincipalId?: string | null;
  request: ExtensionDataRequest;
  audit?: (event: Record<string, unknown>) => Promise<void>;
}): Promise<ExtensionDataResult> {
  const audit =
    input.audit ??
    (async (event) => {
      const { logAuditEvent } = await import("@/lib/authz/audit");
      await logAuditEvent(event as Parameters<typeof logAuditEvent>[0]);
    });
  const base = {
    organizationId: input.orgId,
    actorPrincipalId: input.actorPrincipalId ?? undefined,
    actorPrincipalType: "a2a" as const,
    authSource: "agent" as const,
    resourceType: "extension_table",
    operation: `extension_data.${input.request.operation}`,
    runId: input.runId,
  };
  let compiled: CompiledExtensionDataStatement;
  try {
    compiled = buildExtensionDataStatement({
      packageName: input.packageName,
      schemaName: input.schemaName,
      tables: input.tables,
      orgId: input.orgId,
      request: input.request,
    });
  } catch (e) {
    await audit({
      ...base,
      resourceId: `${input.packageName}:${input.request.table}`,
      decision: "denied",
      metadata: {
        extension: input.packageName,
        table: input.request.table,
        reason: e instanceof ExtensionDataRefusal ? e.reason : "invalid-request",
      },
    }).catch(() => {});
    throw e;
  }
  const roleName = extensionDatabaseRoleName(input.packageName);
  try {
    const result = await executeExtensionDataStatement({
      client: input.client,
      roleName,
      compiled: compiled,
    });
    await audit({
      ...base,
      resourceId: compiled.physicalTable,
      decision: "allowed",
      metadata: {
        extension: input.packageName,
        table: compiled.physicalTable,
        rowKeys: compiled.rowKeys,
        rowCount: result.rowCount,
      },
    }).catch(() => {});
    return result;
  } catch (e) {
    await audit({
      ...base,
      resourceId: compiled.physicalTable,
      decision: "denied",
      metadata: {
        extension: input.packageName,
        table: compiled.physicalTable,
        rowKeys: compiled.rowKeys,
        reason: "database-refused",
      },
    }).catch(() => {});
    throw e;
  }
}
