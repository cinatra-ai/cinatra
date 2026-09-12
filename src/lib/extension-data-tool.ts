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
// THE RUN IS THE HOST'S TO WRITE TOO, for a table that declares a run column
// (cinatra#3249). A pack whose rows belong to one run — a reservation, a
// per-run draft — needs the run in the row and in the predicate, and a caller
// that could name it could name another run's. So the run column is bound the
// way the organisation column is: written from the BOUND run on an insert,
// never nameable in a request, and substituted where the caller asks for THIS
// RUN'S rows through the one explicit marker below. A literal value on that
// column is refused rather than silently overridden. A table that declares no
// run column is untouched by any of it.
//
// AND THE SCOPE THAT RUN BELONGS TO, for a table that declares the scope pair
// (cinatra#3249, decided per scope). A run is launched FROM a vantage — the
// workspace, an organisation, a team, a project, a person's own scope — and a
// pack whose rows are that vantage's own (a reservation another run of the same
// project must see) needs the scope in the row and in the predicate. So the
// scope columns are bound exactly as the run column is: the kind and the id
// written from the BOUND scope on an insert, never nameable in a request, and
// substituted where the caller asks for THIS SCOPE'S rows through the second
// marker below. The vocabulary is the host's own per-scope model's, never one
// invented here. A table that declares no scope pair is untouched by any of it.
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
// The scope vocabulary is the host's OWN per-scope model's — the launch anchor's
// closed union of the vantages a run can be launched from — read from that model
// rather than restated here, together with its fail-closed decoder and the
// storage sentinel the sibling per-scope model already uses for the id-less
// workspace kind. Restating either here would be inventing a second scope
// vocabulary, which is exactly what this binding may not do.
import { WORKSPACE_SCOPE_SENTINEL } from "@/lib/assignment-scope";
import {
  readLaunchScopeAnchor,
  type LaunchScopeAnchorKind,
} from "@/lib/launch-scope-anchor";

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

/**
 * THE BOUND-RUN MARKER (cinatra#3249) — the ONE way a request asks for this
 * run's own rows, and the whole of what the dispatch contract says about the
 * run column:
 *
 *   { operation: "select", table: "…", where: { <the run column>: { boundRun: true } } }
 *
 * It is a marker and not a value on purpose: the caller says "this run" and the
 * host supplies which run, so a module never holds a run identity. The marker
 * is admitted on the declared run column and nowhere else; any other value on
 * that column is refused.
 */
export const EXTENSION_DATA_BOUND_RUN = { boundRun: true } as const;
export type ExtensionDataBoundRun = typeof EXTENSION_DATA_BOUND_RUN;

/** Whether a caller's `where` value is exactly the bound-run marker. */
export function isBoundRunMarker(value: unknown): value is ExtensionDataBoundRun {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length === 1 && (value as Record<string, unknown>).boundRun === true;
}

/**
 * THE BOUND-SCOPE MARKER (cinatra#3249) — the ONE way a request asks for the
 * rows of the scope its run was launched from, on either declared scope column:
 *
 *   { operation: "select", table: "…",
 *     where: { <the scope kind column>: { boundScope: true },
 *              <the scope id column>:   { boundScope: true } } }
 *
 * Same reason as the run's: the caller says "this scope" and the host supplies
 * which one, so a module never holds a scope identity either. Admitted on the
 * declared scope columns and nowhere else; any other value on one of them is
 * refused, and the two markers never stand in for each other.
 */
export const EXTENSION_DATA_BOUND_SCOPE = { boundScope: true } as const;
export type ExtensionDataBoundScope = typeof EXTENSION_DATA_BOUND_SCOPE;

/** Whether a caller's `where` value is exactly the bound-scope marker. */
export function isBoundScopeMarker(value: unknown): value is ExtensionDataBoundScope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length === 1 && (value as Record<string, unknown>).boundScope === true;
}

/**
 * The scope a run belongs to, as the host's own per-scope model names it: the
 * launch anchor's kind and the id inside it. The workspace kind has no id of
 * its own, and carries the storage sentinel the sibling per-scope model already
 * uses for exactly that — a NOT NULL column needs a total value.
 */
export type ExtensionDataBoundScopeValue = {
  kind: LaunchScopeAnchorKind;
  id: string;
};

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
  /**
   * Equality predicates, declared columns only. On a run-bound table's run
   * column the one admitted value is the bound-run marker, which the host
   * substitutes with the run it bound (`EXTENSION_DATA_BOUND_RUN`); on a
   * scope-bound table's scope columns it is the bound-scope marker
   * (`EXTENSION_DATA_BOUND_SCOPE`), substituted with that run's own scope.
   */
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
  /** The bound run — the host's value, never the caller's. Required only for a
   *  table that declares a run column. */
  runId?: string;
  /** The scope the bound run belongs to — the host's value, read off the run,
   *  never the caller's. Required only for a table that declares the pair. */
  scope?: ExtensionDataBoundScopeValue;
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
  const runCol = table.runColumn;
  const scopeKindCol = table.scopeKindColumn;
  const scopeIdCol = table.scopeIdColumn;
  /** The bound run, refused rather than guessed when the call carries none. */
  const boundRun = () => {
    if (!input.runId) {
      throw new ExtensionDataRefusal(
        "no-run",
        `extension_data: "${table.name}" binds its rows to a run and this call carries none — ` +
          `refusing rather than reaching across runs`,
      );
    }
    return input.runId;
  };
  /** The bound scope, refused rather than guessed the same way. */
  const boundScope = () => {
    if (!input.scope || !input.scope.kind || !input.scope.id) {
      throw new ExtensionDataRefusal(
        "no-scope",
        `extension_data: "${table.name}" binds its rows to the scope their run belongs to and ` +
          `this call carries none — refusing rather than reaching across scopes`,
      );
    }
    return input.scope;
  };
  /** Which of the bound scope's two halves a declared scope column carries. */
  const boundScopeValueFor = (column: string) =>
    column === scopeIdCol ? boundScope().id : boundScope().kind;
  const isScopeColumn = (column: string) =>
    (scopeKindCol !== null && column === scopeKindCol) ||
    (scopeIdCol !== null && column === scopeIdCol);
  /** The host-bound columns, in the order every statement writes them. */
  const boundCols: string[] = [
    ...(runCol ? [runCol] : []),
    ...(scopeKindCol ? [scopeKindCol] : []),
    ...(scopeIdCol ? [scopeIdCol] : []),
  ];
  const boundValueFor = (column: string) =>
    column === runCol ? boundRun() : boundScopeValueFor(column);
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
    if (runCol && name === runCol) {
      throw new ExtensionDataRefusal(
        "run-is-the-hosts",
        `extension_data: the run column "${runCol}" is bound by the host — a request may not name ` +
          `it, and asks for this run's own rows with \`{ boundRun: true }\` in \`where\``,
      );
    }
    if (isScopeColumn(name)) {
      throw new ExtensionDataRefusal(
        "scope-is-the-hosts",
        `extension_data: the scope column "${name}" is bound by the host — a request may not name ` +
          `it, and asks for this scope's own rows with \`{ boundScope: true }\` in \`where\``,
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
  for (const [k, v] of whereEntries) {
    if (isBoundRunMarker(v)) {
      if (!runCol || k !== runCol) {
        throw new ExtensionDataRefusal(
          "bound-run-marker-not-the-run-column",
          `extension_data: \`{ boundRun: true }\` asks for this run's own rows and only the ` +
            `declared run column takes it — "${k}" (where) is not one`,
        );
      }
      continue;
    }
    if (isBoundScopeMarker(v)) {
      if (!isScopeColumn(k)) {
        throw new ExtensionDataRefusal(
          "bound-scope-marker-not-a-scope-column",
          `extension_data: \`{ boundScope: true }\` asks for the rows of the scope this run ` +
            `belongs to and only the declared scope columns take it — "${k}" (where) is not one`,
        );
      }
      continue;
    }
    assertColumn(k, "where");
  }
  /**
   * One `where` predicate. The marker is the host's own value: it carries the
   * bound run into the parameter list and NOTHING into the audit's row keys,
   * exactly as the organisation does.
   */
  const wherePredicate = (
    column: string,
    value: unknown,
    equality: (column: string, value: unknown) => string,
  ) => {
    if (isBoundRunMarker(value)) return `${qi(column)} = ${p(boundRun())}`;
    if (isBoundScopeMarker(value)) return `${qi(column)} = ${p(boundScopeValueFor(column))}`;
    rowKeys[column] = value;
    return equality(column, value);
  };
  const plainEq = (column: string, value: unknown) => `${qi(column)} = ${p(value)}`;
  /**
   * THE SCOPE FLOOR (cinatra#3249, adopted from the convergence round). The
   * bound scope is not an OPTION a request may leave out: for a table that
   * declares the pair, every statement stands inside that scope exactly as it
   * stands inside the organisation. Without this floor a request that simply
   * omitted the marker — or named only the kind half of it — read, updated or
   * deleted every OTHER scope's rows of the same organisation, which is the
   * cross-scope reach the binding exists to make impossible. So the pair is
   * appended to every predicate list here, the explicit `{ boundScope: true }`
   * marker becomes the same predicate the host adds anyway (and is dropped from
   * the caller's entries below rather than written twice), and a scope that
   * cannot be resolved refuses the call on EVERY operation, not only on a write.
   *
   * THE RUN IS NOT A FLOOR, deliberately. The per-scope decision is that a
   * sibling run of the same scope must be able to see the rows (a reservation
   * one run took is exactly what the next run must not take again), so which
   * rows of its own scope a request reads — this run's, or the whole scope's —
   * stays the caller's choice, made with the run marker.
   */
  const scopeFloor = () => {
    if (!scopeKindCol || !scopeIdCol) return [] as string[];
    const scope = boundScope();
    return [`${qi(scopeKindCol)} = ${p(scope.kind)}`, `${qi(scopeIdCol)} = ${p(scope.id)}`];
  };
  /** The caller's own predicates. A bound-scope marker carries no predicate of
   *  its own: the floor above already stands for it. */
  const callerPredicates = (equality: (column: string, value: unknown) => string) => {
    const parts: string[] = [];
    for (const [k, v] of whereEntries) {
      if (isBoundScopeMarker(v)) continue;
      parts.push(wherePredicate(k, v, equality));
    }
    return parts;
  };
  const buildWhere = () => {
    const parts = [`${qi(orgCol)} = ${p(input.orgId)}`, ...scopeFloor()];
    parts.push(...callerPredicates(plainEq));
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
    const cols = [orgCol, ...boundCols, ...entries.map(([k]) => k)];
    const placeholders = [
      p(input.orgId),
      ...boundCols.map((c) => p(boundValueFor(c))),
      ...entries.map(([, v]) => p(v)),
    ];
    for (const [k, v] of entries) rowKeys[k] = v;
    // The row the conflict keys stand under is looked for inside the bound run
    // and the bound scope as it is looked for inside the organisation: a bound
    // table's rows belong to one run and one scope, so another run's or another
    // scope's row is never "the row that won".
    const conflictWhere = [
      `${qi(orgCol)} = ${p(input.orgId)}`,
      ...boundCols.map((c) => `${qi(c)} = ${p(boundValueFor(c))}`),
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
    const predicates = [`${qi(orgCol)} = ${p(input.orgId)}`, ...scopeFloor()];
    predicates.push(...callerPredicates(eq));
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
    const cols = [orgCol, ...boundCols, ...entries.map(([k]) => k)];
    const placeholders = [
      p(input.orgId),
      ...boundCols.map((c) => p(boundValueFor(c))),
      ...entries.map(([, v]) => p(v)),
    ];
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
 * THE BOUND SCOPE IS READ OFF THE BOUND RUN (cinatra#3249, decided per scope).
 *
 * A caller on the passthrough hands this port the RUN — that is the whole
 * identity a tool call carries — so the scope cannot arrive with the call
 * either: it is the run's own immutable launch anchor, and a caller that could
 * hand a scope across could hand another scope's across. So the port reads it
 * here, from the run row's `launch_scope_anchor`, and only for a request whose
 * declared table actually binds the pair — a table that declares no scope
 * columns costs no read.
 *
 * UNDER THE HOST'S ROLE, BEFORE THE EXTENSION'S TRANSACTION OPENS. The
 * extension's own role holds nothing but its prefixed tables, so this read
 * deliberately happens outside `executeExtensionDataStatement`'s
 * `SET LOCAL ROLE` transaction and never inside it.
 *
 * FAIL CLOSED. An absent run row, or an anchor this build cannot vouch for,
 * resolves to NO scope — and the statement builder then refuses the call with
 * `no-scope` rather than stamping a scope nobody recorded.
 */
async function readBoundScopeForRun(input: {
  client: MinimalClient;
  schemaName: string;
  orgId: string;
  runId: string;
}): Promise<ExtensionDataBoundScopeValue | undefined> {
  // TENANT-CONSTRAINED (adopted from the convergence round). The read runs
  // under the HOST'S role, so it is not narrowed by anything but its own
  // predicate: a run id that did not belong to the organisation this call was
  // bound to would otherwise hand back ANOTHER tenant's anchor, and that scope
  // would then be stamped into this tenant's rows. The organisation and the run
  // are both the host's own values and must agree; where they do not, the row
  // reads as absent and the call refuses with `no-scope`.
  const res = await input.client.query(
    `SELECT launch_scope_anchor FROM ${qi(input.schemaName)}."agent_runs" ` +
      `WHERE id = $1 AND org_id = $2 LIMIT 1`,
    [input.runId, input.orgId],
  );
  const row = res.rows[0] as Record<string, unknown> | undefined;
  const reading = readLaunchScopeAnchor(row?.launch_scope_anchor);
  if (reading.kind !== "anchored") return undefined;
  const anchor = reading.anchor;
  return {
    kind: anchor.kind,
    // The workspace arm carries no id of its own: the sentinel keeps a NOT NULL
    // scope column total, exactly as the sibling per-scope model keys its rows.
    id: anchor.kind === "workspace" ? WORKSPACE_SCOPE_SENTINEL : anchor.id,
  };
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
  /** The scope the run belongs to — read off the run, never off the request.
   *  Absent on the passthrough, where this function reads it off the run row. */
  scope?: ExtensionDataBoundScopeValue;
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
    // The scope the bound run belongs to. A caller may hand it in (the tests
    // that pin the binding do), and where it does not — every caller on the
    // passthrough, which carries the run and nothing else — the port reads it
    // off the run itself, for a scope-binding table only.
    const declaredTable = input.tables.find((t) => t.name === input.request.table);
    const bindsScope = Boolean(
      declaredTable && (declaredTable.scopeKindColumn || declaredTable.scopeIdColumn),
    );
    const scope =
      input.scope ??
      (bindsScope
        ? await readBoundScopeForRun({
            client: input.client,
            schemaName: input.schemaName,
            orgId: input.orgId,
            runId: input.runId,
          })
        : undefined);
    compiled = buildExtensionDataStatement({
      packageName: input.packageName,
      schemaName: input.schemaName,
      tables: input.tables,
      orgId: input.orgId,
      runId: input.runId,
      scope,
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
