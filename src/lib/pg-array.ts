/**
 * Serialize a JS string array into a Postgres `text[]` array literal so it
 * can be bound as a SINGLE positional parameter that Postgres parses via
 * an explicit `::text[]` cast.
 *
 * Why this exists:
 * Drizzle-orm's `sql` tag interpolates a JS array `${arr}` as a SPREAD of
 * positional parameters (`($1, $2, $3)`), NOT as a single `text[]`
 * parameter. Inside `ANY(...)` that produces a row-expression, which
 * Postgres rejects with `42809 op ANY/ALL (array) requires array on right
 * side`. Adding `::text[]` to the spread (i.e. `($1, $2, $3)::text[]`) is
 * an invalid cast (rows can't be cast to arrays). The robust fix is to
 * pre-build the Postgres array LITERAL TEXT (e.g. `{"a","b"}`), bind it
 * as a single text parameter, and cast that text → text[] inside SQL.
 *
 * Postgres array literal rules (https://www.postgresql.org/docs/16/arrays.html#ARRAYS-IO):
 *  - `{}` for empty.
 *  - Elements separated by `,` and wrapped in `{...}`.
 *  - String elements: wrap each in `"..."`, backslash-escape `"` and `\`.
 *  - The result, cast as `::text[]`, parses back to the original JS array.
 */
export function toPgTextArrayLiteral(arr: readonly string[]): string {
  if (arr.length === 0) return "{}";
  const escaped = arr
    .map((s) => `"${String(s).replace(/[\\"]/g, (m) => `\\${m}`)}"`)
    .join(",");
  return `{${escaped}}`;
}
