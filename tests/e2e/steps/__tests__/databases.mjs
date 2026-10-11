// The two databases a readRows case runs on, as backends.mjs gives the page
// steps their two pages.
//
// Every case runs on the DATABASE DOUBLE, which needs no server: it answers the
// query calls of a `pg` client from tables it holds, and knows exactly the
// queries readRows sends, so a query the step builds differently fails the case.
// With E2E_STEPS_UNIT_DATABASE_URL naming a PostgreSQL database the tests may
// create schemas in, the same cases also read a real database through the
// checkout's own `pg`, which is what keeps the double honest; without it, or
// where that database cannot be reached, that leg is skipped and its name says
// why. On the real database each case creates the two schemas it reads, with a
// suffix of its own on every schema and table name, and drops them after.
import { randomUUID } from "node:crypto";

/** The tables each case reads, by schema; `alpha` and `beta` stand for the product's two schemas. */
export const TABLES = Object.freeze({
  alpha: {
    step_member: {
      columns: [
        ["id", "text"],
        ["organizationId", "text"],
        ["userId", "text"],
        ["role", "text"],
        ["createdAt", "text"],
      ],
      rows: [
        ["member-one", "org-north", "user-ada", "owner", "day-one"],
        ["member-two", "org-north", "user-bo", "member", "day-two"],
        ["member-three", "org-south", "user-ada", "member", "day-three"],
      ],
    },
    step_run: {
      columns: [
        ["id", "text"],
        ["status", "text"],
        ["attempts", "integer"],
        ["archived", "boolean"],
        ["note", "text"],
      ],
      rows: [
        ["run-one", "running", 1, false, null],
        ["run-two", "failed", 2, false, "timed out"],
        ["run-three", "approved", 2, true, null],
      ],
    },
    step_shared: { columns: [["id", "text"]], rows: [["shared-alpha"]] },
  },
  beta: {
    step_shared: {
      columns: [
        ["id", "text"],
        ["label", "text"],
      ],
      rows: [["shared-beta", "the beta one"]],
    },
  },
});

// The queries readRows sends, spelled here on purpose: a query the step builds
// differently is one the double does not know.
const CATALOG_SCHEMAS = "table_schema NOT IN ('pg_catalog', 'information_schema')";
export const COLUMNS_QUERY = `SELECT table_schema, column_name FROM information_schema.columns WHERE table_name = $1 AND ${CATALOG_SCHEMAS} ORDER BY table_schema, ordinal_position`;
export const TABLES_QUERY = `SELECT DISTINCT table_schema, table_name FROM information_schema.columns WHERE ${CATALOG_SCHEMAS} ORDER BY table_schema, table_name`;
const ROWS_QUERY = /^SELECT ("(?:[^"]|"")+"(?:, "(?:[^"]|"")+")*) FROM "((?:[^"]|"")+)"\."((?:[^"]|"")+)"(?: WHERE (.+))? LIMIT \$(\d+)$/;
const IDENTIFIER = /"((?:[^"]|"")+)"/g;
const CONDITION = /^"((?:[^"]|"")+)" (?:= \$(\d+)|IS NULL)$/;
const unquote = (name) => name.replace(/""/g, '"');

/** An error as `pg` gives it: its class on its constructor, its `name` the protocol's word, and a message that can repeat a value. */
export class DatabaseError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "error";
    this.code = code;
  }
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/** The `query(text, values)` call of a pg client, over TABLES. */
export class DatabaseDouble {
  constructor({ answerAfterMs = 0, failWith = null } = {}) {
    this.answerAfterMs = answerAfterMs;
    this.failWith = failWith;
    /** Every query the double was sent, with its values. */
    this.queries = [];
  }

  /** The client a case hands the step: the double itself. */
  get client() {
    return this;
  }

  schema(name) {
    return name;
  }

  table(name) {
    return name;
  }

  async close() {}

  async query(text, values = []) {
    this.queries.push({ text, values: [...values] });
    if (this.answerAfterMs > 0) await pause(this.answerAfterMs);
    if (this.failWith) throw this.failWith;
    const tables = Object.entries(TABLES).flatMap(([schema, held]) => Object.entries(held).map(([table, shape]) => ({ schema, table, ...shape })));
    if (text === COLUMNS_QUERY) {
      return { rows: tables.filter((one) => one.table === values[0]).flatMap((one) => one.columns.map(([column]) => ({ table_schema: one.schema, column_name: column }))) };
    }
    if (text === TABLES_QUERY) return { rows: tables.map((one) => ({ table_schema: one.schema, table_name: one.table })) };
    const shape = ROWS_QUERY.exec(text);
    if (!shape) throw new Error("the database double does not know this query");
    const [, selected, schemaName, tableName, conditions, limitAt] = shape;
    const table = tables.find((one) => one.schema === unquote(schemaName) && one.table === unquote(tableName));
    if (!table) throw new DatabaseError("relation does not exist", "42P01");
    const columns = table.columns.map(([column]) => column);
    const at = (column) => {
      const index = columns.indexOf(column);
      if (index < 0) throw new DatabaseError(`column "${column}" does not exist`, "42703");
      return index;
    };
    const picked = [...selected.matchAll(IDENTIFIER)].map((match) => at(unquote(match[1])));
    const tests = (conditions ? conditions.split(" AND ") : []).map((condition) => {
      const parts = CONDITION.exec(condition);
      if (!parts) throw new Error("the database double does not know this condition");
      const index = at(unquote(parts[1]));
      if (parts[2] === undefined) return (row) => row[index] === null;
      const value = values[Number(parts[2]) - 1];
      // Postgres reads a parameter as the column's type, and refuses a value that is not one.
      const type = table.columns[index][1];
      if (type === "integer" && !/^-?\d+$/.test(String(value))) throw new DatabaseError(`invalid input syntax for type integer: "${value}"`, "22P02");
      if (type === "boolean" && !["true", "false"].includes(String(value))) throw new DatabaseError(`invalid input syntax for type boolean: "${value}"`, "22P02");
      return (row) => row[index] !== null && String(row[index]) === String(value);
    });
    const limit = Number(values[Number(limitAt) - 1]);
    const rows = table.rows
      .filter((row) => tests.every((test) => test(row)))
      .slice(0, limit)
      .map((row) => Object.fromEntries(picked.map((index) => [columns[index], row[index]])));
    return { rows };
  }
}

/** A real database: each case's own schemas and tables, created now and dropped on close. */
async function openRealDatabase(pg, url) {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const schema = (name) => `steps_rows_${suffix}_${name}`;
  const table = (name) => `${name}_${suffix}`;
  const quoted = (name) => `"${name.replace(/"/g, '""')}"`;
  const raw = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await raw.connect();
  const queries = [];
  const database = {
    queries,
    schema,
    table,
    client: {
      query: (text, values = []) => {
        queries.push({ text, values: [...values] });
        return raw.query(text, values);
      },
    },
    close: async () => {
      try {
        for (const name of Object.keys(TABLES)) await raw.query(`DROP SCHEMA IF EXISTS ${quoted(schema(name))} CASCADE`);
      } finally {
        await raw.end();
      }
    },
  };
  try {
    for (const [name, held] of Object.entries(TABLES)) {
      await raw.query(`CREATE SCHEMA ${quoted(schema(name))}`);
      for (const [tableName, shape] of Object.entries(held)) {
        const target = `${quoted(schema(name))}.${quoted(table(tableName))}`;
        await raw.query(`CREATE TABLE ${target} (${shape.columns.map(([column, type]) => `${quoted(column)} ${type}`).join(", ")})`);
        for (const row of shape.rows) {
          const places = row.map((_, index) => `$${index + 1}`).join(", ");
          await raw.query(`INSERT INTO ${target} VALUES (${places})`, row);
        }
      }
    }
  } catch (error) {
    await database.close();
    throw error;
  }
  return database;
}

const DATABASE_URL = process.env.E2E_STEPS_UNIT_DATABASE_URL ?? "";
let pg = null;
let databaseSkip = "set E2E_STEPS_UNIT_DATABASE_URL to a database the tests may create schemas in, to read a real one as well";
if (DATABASE_URL) {
  try {
    pg = (await import("pg")).default;
    const probe = new pg.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5_000 });
    await probe.connect();
    await probe.end();
    databaseSkip = false;
  } catch (error) {
    databaseSkip = `no database could be reached here (${error?.name ?? "Error"})`;
  }
}

// Each case opens a database of its own, and closes it after.
export const DATABASES = [
  { name: "database double", skip: false, open: async () => new DatabaseDouble() },
  { name: "database", skip: databaseSkip, open: () => openRealDatabase(pg, DATABASE_URL) },
];

/**
 * One case on one database: the database with its tables, and a record that
 * keeps every line the step wrote.
 */
export async function rowsScene(database, body) {
  const db = await database.open();
  const lines = [];
  const record = (line) => lines.push(String(line));
  try {
    await body({ db, record, lines });
  } finally {
    await db.close();
  }
}
