import "server-only";

import { sql, type SQL } from "drizzle-orm";

/**
 * `rawWithParams` — the pure bridge that lets the host dashboards-artifact TWIN
 * WRITER (cinatra#1894, epic #1883 §D7 / decomposition #1944 B1b) reuse the
 * existing host `{ text, values }` substrate builders (`buildBindingReconcile-
 * Queries`, `buildSoftDeleteObjectQuery`, the objects+outbox CTE) VERBATIM on a
 * Drizzle connection.
 *
 * The two transactional worlds — the dashboards mutation service (async Drizzle
 * over a node-postgres Pool) and the artifact substrate (a separate sync pg
 * client; `objects` is raw-SQL only) — write the SAME physical Postgres/db but
 * cannot share a transaction, and `packages/dashboards` cannot import host
 * `src/lib`. The twin therefore runs the substrate writes INSIDE the dashboards
 * Drizzle tx via `tx.execute(rawWithParams(text, values))`, splicing a host
 * builder's numbered-parameter SQL into a Drizzle `SQL` so Drizzle re-numbers
 * the placeholders on the SAME connection — one atomic transaction, no
 * second-writer, no post-commit reconcile.
 *
 * === SQL-AWARENESS (cinatra#1894 delta D1 — the codex-r2 REBUT fix) ===
 * A naive regex splice is NOT SQL-aware: it would bind a parameter into a `$n`
 * that occurs INSIDE a single-quoted string literal (`SELECT '$1', $1::int`
 * splices inside the quoted `'$1'`), a dollar-quoted body (`$$ … $1 … $$` or
 * `$tag$ … $tag$`), or a line comment or a block comment. This scanner
 * recognizes a `$n` as a placeholder ONLY when it is OUTSIDE all of those spans.
 * A `$` that opens a dollar-quote (`$$` or `$ident$`) is consumed as a quote,
 * never a parameter — and since a dollar-quote tag can never START with a digit,
 * a genuine positional parameter (`$1`) is never mistaken for a dollar-quote
 * open.
 *
 * Preserved verbatim:
 *   - REPEATED params: each textual occurrence of `$1` emits its OWN Drizzle
 *     parameter bound to `values[0]`, so a builder that references `$1` twice
 *     stays correct after Drizzle re-numbers.
 *   - LONGEST digit run: `$10` reads as parameter 10, never `$1` then `0`.
 *   - `::casts`: `$1::int` splices the value at `$1` and leaves `::int` as
 *     literal SQL — casts are untouched.
 *
 * PURE: builds and returns a Drizzle `SQL`; it never executes. The caller
 * (`tx.execute(...)`) runs it inside the already-open dashboards transaction.
 *
 * CAVEAT (documented, out of scope for the substrate builders, which use
 * standard_conforming_strings literals only): a PostgreSQL escape-string
 * literal (`E'…\'…'`) uses a backslash-escaped quote rather than the doubled
 * `''`. The substrate builders never emit E-strings, and the bridge contract
 * test (`raw-with-params.test.ts`) round-trips each real builder to catch any
 * future drift, so this scanner handles the standard `''` doubling only.
 */
export function rawWithParams(text: string, values: readonly unknown[]): SQL {
  const parts: SQL[] = [];
  let literal = "";
  let i = 0;
  const n = text.length;

  const flushLiteral = (): void => {
    if (literal.length > 0) {
      parts.push(sql.raw(literal));
      literal = "";
    }
  };

  while (i < n) {
    const c = text[i];

    // ── single-quoted string literal: '…' with '' as the embedded-quote escape ──
    if (c === "'") {
      literal += c;
      i += 1;
      while (i < n) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            // doubled quote — an escaped ' that does NOT close the literal
            literal += "''";
            i += 2;
            continue;
          }
          literal += "'";
          i += 1;
          break;
        }
        literal += text[i];
        i += 1;
      }
      continue;
    }

    // ── line comment: -- … <newline> ──
    if (c === "-" && text[i + 1] === "-") {
      while (i < n && text[i] !== "\n") {
        literal += text[i];
        i += 1;
      }
      continue;
    }

    // ── block comment: /* … */ (PostgreSQL block comments nest) ──
    if (c === "/" && text[i + 1] === "*") {
      literal += "/*";
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        if (text[i] === "/" && text[i + 1] === "*") {
          literal += "/*";
          i += 2;
          depth += 1;
          continue;
        }
        if (text[i] === "*" && text[i + 1] === "/") {
          literal += "*/";
          i += 2;
          depth -= 1;
          continue;
        }
        literal += text[i];
        i += 1;
      }
      continue;
    }

    if (c === "$") {
      // ── dollar-quoted body: $$ … $$ or $tag$ … $tag$ ──
      // A tag is empty or an identifier ([A-Za-z_][A-Za-z0-9_]*); it can never
      // start with a digit, so `$1` is never a dollar-quote open — it falls
      // through to positional-parameter detection below.
      const openTag = matchDollarQuoteOpenTag(text, i);
      if (openTag !== null) {
        const delimiter = `$${openTag}$`;
        literal += delimiter;
        i += delimiter.length;
        const closeIdx = text.indexOf(delimiter, i);
        if (closeIdx === -1) {
          // Unterminated (malformed input) — treat the remainder as literal.
          literal += text.slice(i);
          i = n;
        } else {
          literal += text.slice(i, closeIdx + delimiter.length);
          i = closeIdx + delimiter.length;
        }
        continue;
      }

      // ── positional parameter: $<digits> (longest digit run) ──
      let j = i + 1;
      while (j < n && text[j] >= "0" && text[j] <= "9") j += 1;
      if (j > i + 1) {
        const index = Number(text.slice(i + 1, j));
        if (index < 1 || index > values.length) {
          throw new Error(
            `rawWithParams: placeholder $${index} has no bound value ` +
              `(values.length=${values.length})`,
          );
        }
        flushLiteral();
        // A fresh Drizzle Param per occurrence — repeated $n stays repeated.
        parts.push(sql`${values[index - 1]}`);
        i = j;
        continue;
      }

      // A bare `$` (not a quote open, not a parameter) — literal.
      literal += c;
      i += 1;
      continue;
    }

    literal += c;
    i += 1;
  }

  flushLiteral();
  return sql.join(parts);
}

/**
 * At `text[i] === '$'`, return the dollar-quote TAG (`""` for `$$`, or the
 * identifier for `$tag$`) when a dollar-quote delimiter opens here, else null.
 * A tag is empty or `[A-Za-z_][A-Za-z0-9_]*` (never digit-initial), so a
 * positional parameter `$1` yields null.
 */
function matchDollarQuoteOpenTag(text: string, i: number): string | null {
  // Empty tag: `$$`
  if (text[i + 1] === "$") return "";
  const first = text[i + 1];
  if (first === undefined || !/[A-Za-z_]/.test(first)) return null;
  let k = i + 2;
  while (k < text.length && /[A-Za-z0-9_]/.test(text[k]!)) k += 1;
  if (text[k] === "$") return text.slice(i + 1, k);
  return null;
}
