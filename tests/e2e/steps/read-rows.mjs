// readRows: rows of one table, read by named columns, with every name checked
// against the database's own catalog first.
//
// WHY IT EXISTS. A row read by hand was selected by `user_id` where the table's
// column is `userId`: the query failed at the database, far from the line that
// wrote it, and the run died there. This step reads the table's column names
// from the catalog (`information_schema.columns`) before anything else, and
// refuses an unknown table or column at once, naming the closest one there is.
//
// NEVER A FREE QUERY STRING. The caller names a table, the columns to read and
// the column values to match; the step builds the one query from names the
// catalog listed, each quoted as an identifier, and hands every value to the
// database as a bound parameter. A value is never written into the query, and
// no line the step writes carries one.
//
// THE DATABASE. The caller hands the step the client it already holds on the
// product's database, a connected `pg` client or pool, or anything with the same
// `query(text, values)` road that answers `{ rows }`; the steps themselves import
// nothing but Node's builtins. The product keeps its tables in two schemas of
// one database: the sign-in tables (camel-case columns such as `userId`) in
// `public`, the product's own tables in its configured schema. Without `schema`
// the step reads the one schema that holds the table, and refuses a name two
// schemas hold.
import { readBounds, refuse, requireRecord } from "./step-kit.mjs";

const STEP = "readRows";

/** One reading of the database: the catalog, or the rows. */
export const READ_ROWS_BOUND_MS = 10_000;
/** The most rows one reading returns; more matching rows are refused, never cut. */
export const READ_ROWS_LIMIT = 100;

/** Every bound of the step, by the name `bounds` overrides it with. */
export const READ_ROWS_BOUNDS = Object.freeze({ readingMs: READ_ROWS_BOUND_MS });

/** The columns of every table of a name, outside the database's own catalog. */
export const READ_ROWS_COLUMNS_QUERY =
  "SELECT table_schema, column_name FROM information_schema.columns WHERE table_name = $1 AND table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, ordinal_position";
/** Every table outside the database's own catalog, for the closest name to an unknown one. */
export const READ_ROWS_TABLES_QUERY =
  "SELECT DISTINCT table_schema, table_name FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name";

/** An identifier as the query carries it: in double quotes, a double quote in it doubled. */
const identifier = (/** @type {string} */ name) => `"${name.replace(/"/g, '""')}"`;

/**
 * How many single-character edits turn `a` into `b`.
 * @param {string} a
 * @param {string} b
 */
function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

/**
 * The words of a name: split at `_`, `-`, white space and a capital that
 * follows a small letter or a digit, without case.
 * @param {string} name
 */
const wordsOf = (name) =>
  name
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean);

/**
 * Whether two words are the same word: one begins the other (an abbreviation,
 * such as `org` for `organization`), or, from three letters on, one edit apart.
 * @param {string} a
 * @param {string} b
 */
const sameWord = (a, b) => a.startsWith(b) || b.startsWith(a) || (Math.min(a.length, b.length) >= 3 && editDistance(a, b) <= 1);

/**
 * The candidate closest to `name`: the fewest words either has that the other
 * does not, so `user_id` finds `userId` and `org_id` finds `organizationId`;
 * then the fewest edits without case and separators; then as written. Of equal
 * candidates, the first in the catalog's order.
 * @param {string} name
 * @param {string[]} candidates
 */
export function closestName(name, candidates) {
  const folded = (/** @type {string} */ value) => value.toLowerCase().replace(/[_\-\s]/g, "");
  const words = wordsOf(name);
  const unmatched = (/** @type {string[]} */ from, /** @type {string[]} */ to) => from.filter((word) => !to.some((other) => sameWord(word, other))).length;
  let best = null;
  let bestScore = [Infinity, Infinity, Infinity];
  for (const candidate of candidates) {
    const theirs = wordsOf(candidate);
    const score = [unmatched(words, theirs) + unmatched(theirs, words), editDistance(folded(name), folded(candidate)), editDistance(name, candidate)];
    const better = score.findIndex((value, index) => value !== bestScore[index]);
    if (better >= 0 && score[better] < bestScore[better]) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/**
 * The class of a database error, never its message: a message can repeat the
 * value it could not take. A `pg` error names its class on its constructor.
 * @param {unknown} error
 */
function classOf(error) {
  const named = /** @type {{ name?: unknown, constructor?: { name?: unknown } } | null} */ (error);
  const name = String(named?.constructor?.name || named?.name || "Error");
  return name.replace(/[^A-Za-z]/g, "") || "Error";
}

/** @param {unknown} value */
const isValue = (value) =>
  value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "bigint" || (typeof value === "number" && Number.isFinite(value));

/**
 * Read the rows of `table` by the columns named in `columns`, matching every
 * column of `where` to its value (`null` matches an empty column), through the
 * caller's database client, and resolve `{ schema, table, columns, rows }` with
 * the rows in the order the database gives them. Writes one line naming the
 * table, the columns and the matched columns, never a value. Refuses, as a
 * StepRefusal, arguments it cannot use (`input`), a table no schema holds
 * (`unknown-table`, naming the closest), a table two schemas hold without
 * `schema` (`ambiguous`), a column the table does not have (`unknown-column`,
 * naming the closest), more matching rows than `limit` (`too-many-rows`), a
 * reading the database refused (`unreadable`, with the error's class and code
 * only) and one it did not answer within the bound (`no-answer`).
 *
 * @param {{ query: (text: string, values: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }} database
 * @param {{
 *   table: string,
 *   columns: string[],
 *   where?: Record<string, string | number | boolean | bigint | null>,
 *   schema?: string,
 *   limit?: number,
 *   record: import("./step-kit.mjs").StepRecord,
 *   bounds?: Partial<Record<keyof typeof READ_ROWS_BOUNDS, number>>,
 * }} options
 * @returns {Promise<{ schema: string, table: string, columns: string[], rows: Record<string, unknown>[] }>}
 */
export async function readRows(database, { table, columns, where = {}, schema, limit = READ_ROWS_LIMIT, record, bounds } = /** @type {any} */ ({})) {
  requireRecord(STEP, record);
  const nothing = "nothing was read";
  const input = (/** @type {string} */ why) => refuse(STEP, record, "input", `${why} — ${nothing}`);
  if (!database || typeof (/** @type {any} */ (database).query) !== "function") {
    throw input("hand the step a database client with a query(text, values) method, such as a connected pg client");
  }
  if (typeof table !== "string" || table.trim() === "") throw input("name the table, such as member");
  if (!Array.isArray(columns) || columns.length === 0 || columns.some((column) => typeof column !== "string" || column === "")) {
    throw input("name one or more columns to read");
  }
  if (new Set(columns).size !== columns.length) throw input("name each column to read once");
  if (!where || typeof where !== "object" || Array.isArray(where)) throw input("where must be an object of column names and values");
  for (const [column, value] of Object.entries(where)) {
    if (column === "") throw input("where names a column without a name");
    if (!isValue(value)) throw input(`the value for ${column} must be a string, a number, a boolean or null`);
  }
  if (schema !== undefined && (typeof schema !== "string" || schema.trim() === "")) throw input("schema must be a non-empty name");
  if (!Number.isInteger(limit) || limit < 1) throw input("limit must be a whole number of rows, at least 1");
  const bound = readBounds(STEP, record, READ_ROWS_BOUNDS, bounds, nothing);

  // Every reading goes through here: bounded, and a refusal keeps only the error's class and code.
  const ask = async (/** @type {string} */ what, /** @type {string} */ text, /** @type {unknown[]} */ values) => {
    const EXPIRED = Symbol("expired");
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const expired = new Promise((done) => {
      timer = setTimeout(() => done(EXPIRED), bound.readingMs);
    });
    /** @type {any} */
    let answer;
    try {
      answer = await Promise.race([Promise.resolve().then(() => database.query(text, values)), expired]);
    } catch (error) {
      const code = /** @type {{ code?: unknown }} */ (error)?.code;
      const coded = typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? `, code ${code}` : "";
      throw refuse(STEP, record, "unreadable", `the database could not read ${what} (${classOf(error)}${coded})`);
    } finally {
      clearTimeout(timer);
    }
    if (answer === EXPIRED) throw refuse(STEP, record, "no-answer", `the database gave no answer to the reading of ${what} within ${bound.readingMs} ms`);
    if (!answer || !Array.isArray(answer.rows)) throw refuse(STEP, record, "unreadable", `the database answered the reading of ${what} without rows`);
    return /** @type {Record<string, unknown>[]} */ (answer.rows);
  };

  // The catalog first: the columns of every table of this name.
  const catalog = await ask(`the columns of ${table}`, READ_ROWS_COLUMNS_QUERY, [table]);
  /** @type {Map<string, string[]>} */
  const bySchema = new Map();
  for (const row of catalog) {
    const holder = String(row.table_schema);
    bySchema.set(holder, [...(bySchema.get(holder) ?? []), String(row.column_name)]);
  }
  const holders = [...bySchema.keys()];
  const held = schema !== undefined ? (bySchema.has(schema) ? [schema] : []) : holders;
  if (held.length === 0) {
    const place = schema !== undefined ? `${schema}.${table}` : `${table} in any schema`;
    if (holders.length > 0) {
      throw refuse(STEP, record, "unknown-table", `there is no table ${place}; a table ${table} is in ${holders.join(" and ")}; ${nothing}`);
    }
    // The closest table: in the schema named, when it holds any, else in every schema.
    const tables = (await ask("the tables", READ_ROWS_TABLES_QUERY, [])).map((row) => ({ schema: String(row.table_schema), table: String(row.table_name) }));
    const pool = schema !== undefined && tables.some((one) => one.schema === schema) ? tables.filter((one) => one.schema === schema) : tables;
    const best = closestName(table, pool.map((one) => one.table));
    const found = pool.find((one) => one.table === best);
    const closest = found ? `the closest is ${found.schema}.${found.table}` : "the database lists no table";
    throw refuse(STEP, record, "unknown-table", `there is no table ${place} — ${closest}; ${nothing}`);
  }
  if (held.length > 1) {
    throw refuse(STEP, record, "ambiguous", `a table ${table} is in ${held.length} schemas, ${held.join(" and ")} — name the schema; ${nothing}`);
  }
  const [holder] = held;
  const known = /** @type {string[]} */ (bySchema.get(holder));
  const filters = Object.keys(where);
  const unknown = [...new Set([...columns, ...filters])].filter((column) => !known.includes(column));
  if (unknown.length > 0) {
    const named = unknown.map((column) => `no column ${column} (the closest is ${closestName(column, known)})`).join(", ");
    throw refuse(STEP, record, "unknown-column", `${holder}.${table} has ${named}; ${nothing}`);
  }

  // The one query, from names the catalog listed; every value a bound parameter.
  /** @type {unknown[]} */
  const values = [];
  const conditions = filters.map((column) => {
    const value = where[column];
    if (value === null) return `${identifier(column)} IS NULL`;
    values.push(value);
    return `${identifier(column)} = $${values.length}`;
  });
  values.push(limit + 1);
  const text = [
    `SELECT ${columns.map(identifier).join(", ")} FROM ${identifier(holder)}.${identifier(table)}`,
    conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "",
    ` LIMIT $${values.length}`,
  ].join("");
  const rows = await ask(`the rows of ${holder}.${table}`, text, values);
  const matched = filters.length > 0 ? ` where ${filters.join(", ")}` : "";
  if (rows.length > limit) {
    throw refuse(STEP, record, "too-many-rows", `more than ${limit} rows of ${holder}.${table}${matched} match — narrow the where, or raise the limit; no rows were returned`);
  }
  record(`${STEP}: ${rows.length} ${rows.length === 1 ? "row" : "rows"} of ${holder}.${table} (${columns.join(", ")})${matched}`);
  return { schema: holder, table, columns: [...columns], rows };
}
