/**
 * The metadata DELETE query builders.
 *
 * These back the true row-delete + prefix-delete helpers used by the extension
 * data-teardown hook. They are pure string/param builders (no DB), so they are
 * unit-testable without a live Postgres. The LIKE-escaping is the load-bearing
 * correctness property: a caller-supplied prefix (a package name) must NEVER be
 * able to widen the match via `%` / `_` / `\`.
 */
import { describe, it, expect } from "vitest";
import {
  buildDeleteMetadataQuery,
  buildDeleteMetadataByPrefixQuery,
} from "@/lib/drizzle-store";

describe("buildDeleteMetadataQuery", () => {
  it("emits a parameterized single-key DELETE against the schema-qualified table", () => {
    const q = buildDeleteMetadataQuery("cinatra", "connector_config:ext:@x/p:org1:k");
    expect(q.text).toBe(`DELETE FROM "cinatra"."metadata" WHERE key = $1`);
    expect(q.values).toEqual(["connector_config:ext:@x/p:org1:k"]);
  });

  it("escapes a double-quote in the schema name (identifier-injection guard)", () => {
    const q = buildDeleteMetadataQuery(`ev"il`, "k");
    expect(q.text).toBe(`DELETE FROM "ev""il"."metadata" WHERE key = $1`);
  });
});

describe("buildDeleteMetadataByPrefixQuery", () => {
  it("emits a parameterized prefix LIKE DELETE with an explicit ESCAPE clause", () => {
    // Use a wildcard-free prefix here so the appended trailing `%` is the only
    // wildcard (a literal `_`, e.g. inside `connector_config`, is escaped — see
    // the next test).
    const q = buildDeleteMetadataByPrefixQuery("cinatra", "ext:@x/p:");
    expect(q.text).toBe(`DELETE FROM "cinatra"."metadata" WHERE key LIKE $1 ESCAPE '\\'`);
    expect(q.values).toEqual(["ext:@x/p:%"]);
  });

  it("escapes LIKE wildcards in the prefix so it cannot be widened", () => {
    // `%`, `_`, and `\` in the literal prefix must each be backslash-escaped —
    // including the `_` inside the real-world `connector_config:` prefix. An
    // escaped `\_` still matches a literal `_`, so correctness is preserved.
    const q = buildDeleteMetadataByPrefixQuery("cinatra", "connector_config:ext:@x/p%_\\:");
    expect(q.values).toEqual(["connector\\_config:ext:@x/p\\%\\_\\\\:%"]);
    // The trailing `%` (the wildcard we DO want) is appended AFTER escaping, so
    // it stays a real wildcard.
    expect((q.values?.[0] as string).endsWith("%")).toBe(true);
    // No UNescaped `%`/`_` survives inside the literal portion.
    const literal = (q.values?.[0] as string).slice(0, -1); // drop trailing wildcard
    expect(/(?<!\\)[%_]/.test(literal)).toBe(false);
  });
});
