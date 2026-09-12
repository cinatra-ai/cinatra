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
//
// TWO CONDITIONAL OPERATIONS (cinatra#3249). A flow that reserves one row of
// its own table needs the decision to be the DATABASE'S, not a read followed
// by a write that another run can slip between. `insertIfAbsent` is ONE
// statement: it inserts, and where the table's own unique rule refuses the
// write it reports that refusal as a conflict together with the row that won,
// so the losing caller learns it lost inside the same round trip.
// `updateWhere` moves the rows a caller names only while the columns it names
// still carry the values it expects. Both stay type- and table-agnostic: the
// caller names its own declared table and its own declared columns, and no
// value carries a meaning the host reads.
//
// WHAT `inserted: false` MEANS, EXACTLY. `ON CONFLICT DO NOTHING` carries no
// conflict target: the host cannot know which unique rule the pack's own
// migration wrote, nor whether the organisation column takes part in it, and a
// target that matches no index raises instead of answering. So the flag reports
// what actually happened — the database refused the write under one of THAT
// TABLE'S OWN unique rules — and `existing` is a separate, honestly narrower
// thing: the row matching the conflict keys THE CALLER NAMED, inside the run's
// organisation, as this statement's own snapshot sees it. It is null when no
// such row is visible: the collision was on another of the table's unique
// rules, or the row that won was committed by a concurrent transaction this
// snapshot cannot see, or the winning row lies outside the caller's scope. A
// caller reads `existing` as the row under its key, never as proof of which
// constraint refused it.
//
// A null value in a caller's `conflictKeys` row value or in `expect` is matched
// with `IS NOT DISTINCT FROM` rather than `=`, because `x = NULL` is unknown
// and would silently never match — a conditional transition out of a null
// column is exactly what a reserve/complete flow needs.

import {
  declaredTablePhysicalName,
  extensionDatabaseRoleName,
  type DeclaredTable,
} from "@cinatra-ai/sdk-extensions/manifest";

export const EXTENSION_DATA_OPERATIONS = [
  "select",
  "insert",
  "update",
  "delete",
  "insertIfAbsent",
  "updateWhere",
] as const;
export type ExtensionDataOperation = (typeof EXTENSION_DATA_OPERATIONS)[number];

/** How the tool reads a compiled statement's result back for the caller. */
export type ExtensionDataResultShape = "rows" | "insertIfAbsent" | "updated";

/**
 * The conditional insert's own column and common-table names. A declared
 * column can never collide with either: a declared name must start with a
 * lowercase letter (the manifest's identifier rule), and these start with an
 * underscore.
 */
const ATTEMPT_CTE = "__attempted";
const INSERTED_FLAG = "__inserted";

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
  /** `insertIfAbsent`: the row to write, declared columns only. */
  row?: Record<string, unknown>;
  /**
   * `insertIfAbsent`: the declared columns that identify the row this write
   * would collide with. Their values are read back from `row`, so a caller
   * names its key once.
   */
  conflictKeys?: string[];
  /** `updateWhere`: the columns to set, declared columns only. */
  set?: Record<string, unknown>;
  /**
   * `updateWhere`: the columns that must STILL carry these values for the set
   * to happen. The caller's own guard; the host reads no meaning into a value.
   */
  expect?: Record<string, unknown>;
  limit?: number;
};

export type CompiledExtensionDataStatement = {
  text: string;
  values: unknown[];
  /** The physical table the statement touches — what the audit records. */
  physicalTable: string;
  /** The declared columns the statement writes or filters on — the row keys. */
  rowKeys: Record<string, unknown>;
  /** How the tool reads this statement's result back for the caller. */
  resultShape: ExtensionDataResultShape;
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
 * Validate a database role/identifier is exactly what
 * `extensionDatabaseRoleName` derives (lowercase ASCII, digits, underscore) —
 * belt-and-suspenders on top of `qi`'s quoting, since `SET LOCAL ROLE` cannot
 * be parameterized like an ordinary value.
 */
const SAFE_ROLE_IDENTIFIER_RE = /^[a-z0-9_]+$/;
function assertSafeRoleIdentifier(id: string): string {
  if (!SAFE_ROLE_IDENTIFIER_RE.test(id)) {
    throw new Error(`[extension-data-tool] refused: "${id}" is not a safe role identifier`);
  }
  return id;
}

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
      "extension_data: `table` must name one of the calling extension's own declared tables",
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
  /**
   * One equality predicate for the CONDITIONAL operations. A null is matched
   * with `IS NOT DISTINCT FROM`, since `= NULL` is unknown and would never
   * match; a non-null keeps the plain, index-usable `=`.
   */
  const eq = (column: string, value: unknown) =>
    value === null
      ? `${qi(column)} IS NOT DISTINCT FROM ${p(value)}`
      : `${qi(column)} = ${p(value)}`;

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

  const projectionColumns = (() => {
    if (!request.columns || request.columns.length === 0) {
      return table.columns.map((c) => c.name);
    }
    for (const c of request.columns) {
      if (!declared.has(c)) {
        throw new ExtensionDataRefusal(
          "column-not-declared",
          `extension_data: "${c}" (projection) is not a declared column of "${table.name}"`,
        );
      }
    }
    return request.columns;
  })();
  const projection = projectionColumns.map(qi).join(", ");
  /**
   * The conditional insert names its projection THREE times — once in the
   * CTE's RETURNING and once in each arm of the union — so a repeated column
   * would give the common table two columns of one name and make the outer
   * reference ambiguous. Deduplicated for that statement only; every other
   * operation keeps the projection the caller wrote.
   */
  const distinctProjection = [...new Set(projectionColumns)].map(qi).join(", ");

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
      resultShape: "rows",
    };
  }

  if (request.operation === "insertIfAbsent") {
    const entries = Object.entries(request.row ?? {});
    if (entries.length === 0) {
      throw new ExtensionDataRefusal(
        "no-values",
        "extension_data: insertIfAbsent needs a `row` with at least one declared column",
      );
    }
    for (const [k] of entries) assertColumn(k, "row");
    const keys = request.conflictKeys ?? [];
    if (keys.length === 0) {
      throw new ExtensionDataRefusal(
        "no-conflict-keys",
        "extension_data: insertIfAbsent needs `conflictKeys` naming the declared columns that " +
          "identify the row it would collide with",
      );
    }
    const row = Object.fromEntries(entries);
    for (const k of keys) {
      assertColumn(k, "conflict key");
      if (!(k in row)) {
        throw new ExtensionDataRefusal(
          "conflict-key-not-in-row",
          `extension_data: "${k}" (conflict key) is not one of the columns the row carries`,
        );
      }
    }
    const cols = [orgCol, ...entries.map(([k]) => k)];
    const placeholders = [p(input.orgId), ...entries.map(([, v]) => p(v))];
    for (const [k, v] of entries) rowKeys[k] = v;
    const conflictWhere = [
      `${qi(orgCol)} = ${p(input.orgId)}`,
      ...keys.map((k) => eq(k, row[k])),
    ].join(" AND ");
    return {
      text:
        `WITH ${qi(ATTEMPT_CTE)} AS (` +
        `INSERT INTO ${target} (${cols.map(qi).join(", ")}) ` +
        `VALUES (${placeholders.join(", ")}) ON CONFLICT DO NOTHING ` +
        `RETURNING ${distinctProjection}) ` +
        `SELECT true AS ${qi(INSERTED_FLAG)}, ${distinctProjection} FROM ${qi(ATTEMPT_CTE)} ` +
        `UNION ALL ` +
        `SELECT false AS ${qi(INSERTED_FLAG)}, ${distinctProjection} FROM ${target} ` +
        `WHERE ${conflictWhere} AND NOT EXISTS (SELECT 1 FROM ${qi(ATTEMPT_CTE)}) ` +
        `LIMIT 1`,
      values,
      physicalTable: physical,
      rowKeys,
      resultShape: "insertIfAbsent",
    };
  }

  if (request.operation === "updateWhere") {
    const sets = Object.entries(request.set ?? {});
    if (sets.length === 0) {
      throw new ExtensionDataRefusal(
        "no-values",
        "extension_data: updateWhere needs a `set` with at least one declared column",
      );
    }
    for (const [k] of sets) assertColumn(k, "set");
    const expected = Object.entries(request.expect ?? {});
    for (const [k] of expected) assertColumn(k, "expect");
    const assignments = sets.map(([k, v]) => `${qi(k)} = ${p(v)}`).join(", ");
    for (const [k, v] of sets) rowKeys[k] = v;
    const predicates = [`${qi(orgCol)} = ${p(input.orgId)}`];
    for (const [k, v] of whereEntries) {
      predicates.push(eq(k, v));
      rowKeys[k] = v;
    }
    for (const [k, v] of expected) predicates.push(eq(k, v));
    return {
      text: `UPDATE ${target} SET ${assignments} WHERE ${predicates.join(" AND ")}`,
      values,
      physicalTable: physical,
      rowKeys,
      resultShape: "updated",
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
      resultShape: "rows",
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
      resultShape: "rows",
    };
  }

  const where = buildWhere();
  return {
    text: `DELETE FROM ${target} WHERE ${where} RETURNING ${projection}`,
    values,
    physicalTable: physical,
    rowKeys,
    resultShape: "rows",
  };
}

export type ExtensionDataResult = {
  rows: Record<string, unknown>[];
  rowCount: number;
  table: string;
};

/**
 * The conditional insert's answer: the row this call wrote, or — where the
 * table's own unique rule refused the write — that conflict together with the
 * row standing under the conflict keys the caller named. `existing` is null
 * whenever no such row is visible to this statement: the collision was on
 * another of the table's unique rules, the winning row was committed
 * concurrently, or it lies outside the caller's own scope. It is the row under
 * the caller's key, never proof of which constraint refused the write.
 */
export type ExtensionDataInsertIfAbsentResult =
  | { inserted: true; row: Record<string, unknown> }
  | { inserted: false; conflict: true; existing: Record<string, unknown> | null };

/** The conditional update's answer: how many rows actually moved. */
export type ExtensionDataUpdateWhereResult = { updated: number };

export type ExtensionDataToolResult =
  | ExtensionDataResult
  | ExtensionDataInsertIfAbsentResult
  | ExtensionDataUpdateWhereResult;

/**
 * Read one executed statement as the operation's own answer. Pure, so the
 * shape a calling pack sees is readable here rather than inferred from a
 * driver's row array.
 */
export function shapeExtensionDataResult(
  compiled: CompiledExtensionDataStatement,
  result: ExtensionDataResult,
): ExtensionDataToolResult {
  if (compiled.resultShape === "updated") return { updated: result.rowCount };
  if (compiled.resultShape !== "insertIfAbsent") return result;
  const first = result.rows[0];
  if (!first) return { inserted: false, conflict: true, existing: null };
  const { [INSERTED_FLAG]: inserted, ...row } = first;
  return inserted === true
    ? { inserted: true, row }
    : { inserted: false, conflict: true, existing: row };
}

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
    await client.query(`SET LOCAL ROLE ${qi(assertSafeRoleIdentifier(input.roleName))}`);
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
}): Promise<ExtensionDataToolResult> {
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
    return shapeExtensionDataResult(compiled, result);
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
