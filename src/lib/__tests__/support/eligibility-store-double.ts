/**
 * THE STORE DOUBLE the package-eligibility readers are exercised against
 * (cinatra#2814, the fix leg of the per-scope assignment page).
 *
 * A minimal replay of the drizzle read chain those readers use,
 * `db.select({…}).from(t)[.where(c)][.limit(n)]` to rows, keyed on the TABLE,
 * so each read answers from its own rows.
 *
 * The double APPLIES the `where` condition it is handed, rather than returning
 * every seeded row. A double that drops the predicate cannot tell a right read
 * from a wrong one: the production `agent_kind = 'assistant'` filter could be
 * deleted and every fixture would stay green. So the condition is walked and
 * evaluated against each row, and a shape the walk does not know THROWS. A
 * silently unread predicate is the failure this double exists to prevent.
 *
 * It lives beside the suites rather than inside one because two of them read
 * the same production readers: the one that calls them directly, and the one
 * that reaches them through the assignment slice's write road.
 */
import { Column, Param, SQL, getTableColumns, getTableName, is } from "drizzle-orm";

export type Row = Record<string, unknown>;

/** The chunks of one drizzle condition, in order: literal text, or an operand
 *  (a column, a bound parameter, or a nested condition). */
type Chunk = { text: string } | { operand: unknown };

function chunksOf(condition: SQL): Chunk[] {
  const out: Chunk[] = [];
  for (const chunk of condition.queryChunks as unknown[]) {
    if (typeof chunk === "string") {
      out.push({ text: chunk });
    } else if (is(chunk, Column) || is(chunk, Param) || is(chunk, SQL)) {
      out.push({ operand: chunk });
    } else {
      // A StringChunk: the literal SQL text around the operands.
      const value = (chunk as { value?: unknown }).value;
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
        throw new Error("store double: unreadable condition chunk");
      }
      out.push({ text: value.join("") });
    }
  }
  return out;
}

/** Does `row` satisfy `condition`? Understands exactly the three shapes the
 *  eligibility reader builds: `column = value`, `column is not null`, and an
 *  `and(…)` / `or(…)` of those. Anything else throws. */
function rowSatisfies(condition: unknown, row: Row, propertyOf: (dbName: string) => string): boolean {
  if (!is(condition, SQL)) throw new Error("store double: predicate is not a condition");
  const chunks = chunksOf(condition);
  const operands = chunks.flatMap((c) => ("operand" in c ? [c.operand] : []));
  const operator = chunks
    .flatMap((c) => ("text" in c ? [c.text.trim()] : []))
    .filter((t) => t !== "" && t !== "(" && t !== ")")
    .join(" ")
    .trim();

  // `and(a, b)` / `or(a, b)`, and the single-arm wrapper `or(a)`.
  if (operands.length > 0 && operands.every((o) => is(o, SQL))) {
    const arms = operands.map((o) => rowSatisfies(o, row, propertyOf));
    if (operator === "" || /^and( and)*$/.test(operator)) return arms.every(Boolean);
    if (/^or( or)*$/.test(operator)) return arms.some(Boolean);
    throw new Error(`store double: unknown combiner "${operator}"`);
  }
  // `column = value`.
  if (operands.length === 2 && is(operands[0], Column) && is(operands[1], Param) && operator === "=") {
    return row[propertyOf((operands[0] as Column).name)] === (operands[1] as Param).value;
  }
  // `column is not null`.
  if (operands.length === 1 && is(operands[0], Column) && operator === "is not null") {
    return row[propertyOf((operands[0] as Column).name)] != null;
  }
  throw new Error(`store double: unknown predicate "${operator}"`);
}

export function storeDouble(opts: { installs?: Row[]; templates?: Row[] } = {}) {
  const rowsFor = (table: string): Row[] =>
    table === "agent_templates" ? (opts.templates ?? []) : (opts.installs ?? []);
  const select = () => ({
    from(table: Parameters<typeof getTableName>[0]) {
      const seeded = rowsFor(getTableName(table));
      // The reader's rows are keyed by PROPERTY name; a condition names the
      // COLUMN. The table itself carries the map between them.
      const properties = new Map(
        Object.entries(getTableColumns(table as Parameters<typeof getTableColumns>[0])).map(
          ([property, column]) => [(column as Column).name, property],
        ),
      );
      const propertyOf = (dbName: string) => properties.get(dbName) ?? dbName;
      let rows = seeded;
      const chain = {
        where(condition: unknown) {
          rows = rows.filter((row) => rowSatisfies(condition, row, propertyOf));
          return chain;
        },
        limit(n: number) {
          rows = rows.slice(0, n);
          return chain;
        },
        then: (resolve: (r: Row[]) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject),
      };
      return chain;
    },
  });
  return { select } as never;
}
