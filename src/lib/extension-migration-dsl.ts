// Pure, IO-free constrained migration DSL for extension-owned storage
// (the installer's declarative-migration runner).
//
// Extensions NEVER run arbitrary SQL. They declare
// a small JSON spec — `createTable` / `addColumn` / `addIndex` / a constrained
// `backfill` — over tables they OWN (the enforced `ext_<scope>_<pkg>_<table>`
// prefix). A validator rejects anything that touches another extension's or a
// core table; a compiler turns the validated spec into parameterized DDL with
// identifier-allowlisting (so post-validation interpolation is safe). The
// runtime `ctx.db.query()` write path stays UNWIRED — backfills run host-side
// with `org_id` injected; this module only DESCRIBES + COMPILES the migration.
//
// Everything here is deterministic + dependency-free (createHash for the
// content hash only), so it is exhaustively unit-testable.

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Spec types
// ---------------------------------------------------------------------------

/** Postgres column types an extension migration may use (allowlist). */
export const ALLOWED_COLUMN_TYPES = [
  "text",
  "integer",
  "bigint",
  "boolean",
  "timestamptz",
  "jsonb",
  "uuid",
  "numeric",
  "double precision",
] as const;
export type AllowedColumnType = (typeof ALLOWED_COLUMN_TYPES)[number];

export type ColumnSpec = {
  name: string;
  type: AllowedColumnType;
  notNull?: boolean;
  /** A literal default (string/number/boolean/null) — never raw SQL. */
  default?: string | number | boolean | null;
  unique?: boolean;
};

export type ForeignKeySpec = {
  column: string;
  /** FK target table — MUST be one of the extension's OWN prefixed tables. */
  referencesTable: string;
  referencesColumn: string;
  onDelete?: "cascade" | "set null" | "restrict";
};

export type CreateTableOp = {
  op: "createTable";
  table: string;
  columns: ColumnSpec[];
  primaryKey?: string[];
  foreignKeys?: ForeignKeySpec[];
};

export type AddColumnOp = { op: "addColumn"; table: string; column: ColumnSpec };

export type AddIndexOp = {
  op: "addIndex";
  table: string;
  name: string;
  columns: string[];
  unique?: boolean;
};

/** Constrained backfill: set columns to literals WHERE a column is null. */
export type BackfillOp = {
  op: "backfill";
  table: string;
  set: Record<string, string | number | boolean | null>;
  whereColumnIsNull: string;
};

export type MigrationOp = CreateTableOp | AddColumnOp | AddIndexOp | BackfillOp;

export type ExtensionMigrationSpec = {
  /** Migration id, unique within the package (ledger key). */
  id: string;
  ops: MigrationOp[];
};

// ---------------------------------------------------------------------------
// Table prefix — `ext_<scope>_<pkg>_<table>` (sanitized, length-bounded)
// ---------------------------------------------------------------------------

const IDENT_RE = /^[a-z][a-z0-9_]*$/;
const PG_IDENT_MAX = 63;
const FK_ON_DELETE_ACTIONS = new Set<ForeignKeySpec["onDelete"]>(["cascade", "set null", "restrict"]);

function sanitizeIdentPart(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * The required table prefix for an extension's owned tables, derived from its
 * package name (`@scope/name` → `ext_<scope>_<name>_`). Bounded to leave room
 * for the table suffix within Postgres' 63-char identifier limit; a hash suffix
 * preserves uniqueness when the readable part is truncated.
 */
export function extTablePrefix(packageName: string): string {
  const noScopeAt = packageName.replace(/^@/, "");
  const [scopeRaw, nameRaw] = noScopeAt.includes("/") ? noScopeAt.split("/", 2) : ["", noScopeAt];
  const scope = sanitizeIdentPart(scopeRaw);
  const name = sanitizeIdentPart(nameRaw);
  const base = scope ? `ext_${scope}_${name}_` : `ext_${name}_`;
  if (base.length <= 40) return base;
  // Too long → truncate readable part + append a stable short hash for uniqueness.
  const hash = createHash("sha256").update(packageName).digest("hex").slice(0, 8);
  return `${base.slice(0, 31)}_${hash}_`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

/**
 * Validate a migration spec for a package: every table must carry the package's
 * `ext_<scope>_<pkg>_` prefix, identifiers must be safe, types allowlisted, a
 * mandatory `org_id text not null` column on every created table (host-injected
 * tenancy), and FKs may only reference the extension's own tables.
 */
export function validateMigrationSpec(spec: ExtensionMigrationSpec, packageName: string): ValidationResult {
  const errors: string[] = [];
  const prefix = extTablePrefix(packageName);

  if (!spec.id || typeof spec.id !== "string" || !/^[A-Za-z0-9._-]+$/.test(spec.id)) {
    errors.push(`invalid migration id: ${JSON.stringify(spec.id)}`);
  }
  if (!Array.isArray(spec.ops) || spec.ops.length === 0) {
    errors.push("migration has no ops");
    return { ok: false, errors };
  }

  const ownedTables = new Set<string>();
  for (const op of spec.ops) {
    if (op.op === "createTable") ownedTables.add(op.table);
  }

  const requireOwned = (table: string, ctx: string) => {
    if (!isValidIdent(table) || table.length > PG_IDENT_MAX) errors.push(`${ctx}: invalid table identifier "${table}"`);
    if (!table.startsWith(prefix)) {
      errors.push(`${ctx}: table "${table}" is outside this extension's prefix "${prefix}" (cross-table writes are forbidden)`);
    }
  };

  for (const op of spec.ops) {
    switch (op.op) {
      case "createTable": {
        requireOwned(op.table, "createTable");
        if (!op.columns?.length) errors.push(`createTable ${op.table}: no columns`);
        const colNames = new Set<string>();
        for (const c of op.columns ?? []) validateColumn(c, `createTable ${op.table}`, errors, colNames);
        // Tenancy: every owned table MUST carry `org_id text NOT NULL` so the
        // host can inject + enforce the org filter.
        const orgIdCol = (op.columns ?? []).find((c) => c?.name === "org_id");
        if (!orgIdCol) {
          errors.push(`createTable ${op.table}: missing required "org_id" column (host-injected tenancy)`);
        } else if (orgIdCol.type !== "text" || orgIdCol.notNull !== true) {
          errors.push(`createTable ${op.table}: "org_id" must be declared as text NOT NULL (host-injected tenancy)`);
        }
        for (const pk of op.primaryKey ?? []) {
          if (!colNames.has(pk)) errors.push(`createTable ${op.table}: primaryKey column "${pk}" not defined`);
        }
        for (const fk of op.foreignKeys ?? []) {
          if (!colNames.has(fk.column)) errors.push(`createTable ${op.table}: FK column "${fk.column}" not defined`);
          // The FK target table + column are interpolated into DDL — they MUST be
          // safe identifiers AND inside this extension's own tables (no escape).
          if (!isValidIdent(fk.referencesColumn)) errors.push(`createTable ${op.table}: invalid FK ref column "${fk.referencesColumn}"`);
          if (!isValidIdent(fk.referencesTable) || fk.referencesTable.length > PG_IDENT_MAX) {
            errors.push(`createTable ${op.table}: invalid FK ref table identifier "${fk.referencesTable}"`);
          } else if (!fk.referencesTable.startsWith(prefix) && !ownedTables.has(fk.referencesTable)) {
            errors.push(`createTable ${op.table}: FK may only reference this extension's own tables (got "${fk.referencesTable}")`);
          }
          // onDelete is interpolated into DDL — allowlist it (JSON-fed value).
          if (fk.onDelete !== undefined && !FK_ON_DELETE_ACTIONS.has(fk.onDelete)) {
            errors.push(`createTable ${op.table}: invalid FK onDelete "${String(fk.onDelete)}" (cascade | set null | restrict)`);
          }
        }
        break;
      }
      case "addColumn": {
        requireOwned(op.table, "addColumn");
        validateColumn(op.column, `addColumn ${op.table}`, errors, new Set());
        break;
      }
      case "addIndex": {
        requireOwned(op.table, "addIndex");
        if (!isValidIdent(op.name) || op.name.length > PG_IDENT_MAX) errors.push(`addIndex: invalid index name "${op.name}"`);
        if (!op.name.startsWith(prefix) && !op.name.startsWith(`idx_${prefix}`)) {
          errors.push(`addIndex "${op.name}": index name must carry the extension prefix`);
        }
        if (!op.columns?.length) errors.push(`addIndex ${op.name}: no columns`);
        for (const c of op.columns ?? []) if (!isValidIdent(c)) errors.push(`addIndex ${op.name}: invalid column "${c}"`);
        break;
      }
      case "backfill": {
        requireOwned(op.table, "backfill");
        if (!isValidIdent(op.whereColumnIsNull)) errors.push(`backfill ${op.table}: invalid whereColumnIsNull`);
        for (const k of Object.keys(op.set ?? {})) if (!isValidIdent(k)) errors.push(`backfill ${op.table}: invalid set column "${k}"`);
        if (Object.keys(op.set ?? {}).length === 0) errors.push(`backfill ${op.table}: empty set`);
        break;
      }
      default:
        errors.push(`unknown op: ${JSON.stringify((op as { op?: string }).op)}`);
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function isValidIdent(s: string): boolean {
  return typeof s === "string" && IDENT_RE.test(s);
}

function validateColumn(c: ColumnSpec, ctx: string, errors: string[], seen: Set<string>): void {
  if (!c || !isValidIdent(c.name) || c.name.length > PG_IDENT_MAX) {
    errors.push(`${ctx}: invalid column name "${c?.name}"`);
    return;
  }
  if (seen.has(c.name)) errors.push(`${ctx}: duplicate column "${c.name}"`);
  seen.add(c.name);
  if (!ALLOWED_COLUMN_TYPES.includes(c.type)) errors.push(`${ctx}: column "${c.name}" has disallowed type "${c.type}"`);
  if (c.default !== undefined && typeof c.default !== "string" && typeof c.default !== "number" && typeof c.default !== "boolean" && c.default !== null) {
    errors.push(`${ctx}: column "${c.name}" default must be a literal`);
  }
}

// ---------------------------------------------------------------------------
// Compilation → parameterized DDL (called ONLY after validation passes)
// ---------------------------------------------------------------------------

export type CompiledQuery = { text: string };

/**
 * Compile a VALIDATED spec into idempotent DDL for `schema`. Identifiers are
 * re-checked + double-quoted; literal defaults are emitted via a safe literal
 * encoder. Throws if called on an unvalidated/invalid spec (defense-in-depth).
 */
export function compileMigrationSpec(spec: ExtensionMigrationSpec, packageName: string, schema: string): CompiledQuery[] {
  const v = validateMigrationSpec(spec, packageName);
  if (!v.ok) throw new Error(`[ext-migration] refusing to compile invalid spec ${spec.id}: ${v.errors.join("; ")}`);
  if (!isValidIdent(schema)) throw new Error(`[ext-migration] invalid schema name "${schema}"`);
  const q = (id: string) => `"${id}"`;
  const t = (table: string) => `${q(schema)}.${q(table)}`;
  const out: CompiledQuery[] = [];

  for (const op of spec.ops) {
    if (op.op === "createTable") {
      const cols = op.columns.map((c) => columnDdl(c));
      if (op.primaryKey?.length) cols.push(`PRIMARY KEY (${op.primaryKey.map(q).join(", ")})`);
      for (const fk of op.foreignKeys ?? []) {
        cols.push(
          `FOREIGN KEY (${q(fk.column)}) REFERENCES ${t(fk.referencesTable)} (${q(fk.referencesColumn)})` +
            (fk.onDelete ? ` ON DELETE ${fk.onDelete.toUpperCase()}` : ""),
        );
      }
      out.push({ text: `CREATE TABLE IF NOT EXISTS ${t(op.table)} (\n  ${cols.join(",\n  ")}\n)` });
    } else if (op.op === "addColumn") {
      out.push({ text: `ALTER TABLE ${t(op.table)} ADD COLUMN IF NOT EXISTS ${columnDdl(op.column)}` });
    } else if (op.op === "addIndex") {
      out.push({
        text: `CREATE ${op.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${q(op.name)} ON ${t(op.table)} (${op.columns.map(q).join(", ")})`,
      });
    } else if (op.op === "backfill") {
      const sets = Object.entries(op.set).map(([k, val]) => `${q(k)} = ${literal(val)}`);
      out.push({ text: `UPDATE ${t(op.table)} SET ${sets.join(", ")} WHERE ${q(op.whereColumnIsNull)} IS NULL` });
    }
  }
  return out;
}

function columnDdl(c: ColumnSpec): string {
  let s = `"${c.name}" ${c.type}`;
  if (c.notNull) s += " NOT NULL";
  if (c.default !== undefined) s += ` DEFAULT ${literal(c.default)}`;
  if (c.unique) s += " UNIQUE";
  return s;
}

/** Safe SQL literal for the constrained literal set (string/number/boolean/null). */
function literal(v: string | number | boolean | null): string {
  if (v === null) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return `'${v.replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// Stable content hash (ledger immutability check)
// ---------------------------------------------------------------------------

/** Deterministic hash of a migration spec (key order independent). */
export function migrationSpecHash(spec: ExtensionMigrationSpec): string {
  return createHash("sha256").update(stableStringify(spec)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
