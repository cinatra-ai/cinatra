// Semantic assertion write-policy + precedence pure-decision contract. These
// pure helpers are the unit contract; the DB CHECK/trigger guards in
// drizzle-store.ts are the defense-in-depth backstop. The default-artifact
// floor — and its "never directly assertable" / shouldDefaultBeEligible
// invariants — was retired with the extension (epic cinatra#1785 wave A5).
import { describe, it, expect } from "vitest";
import {
  initialEligibility,
  sourceOutranks,
} from "@/lib/artifacts/semantic-assertion-store";

const ICP = "@cinatra-ai/marketing-icp-artifact";

describe("initialEligibility — write policy", () => {
  it("matcher ⇒ draft; everyone else ⇒ eligible (never archived as an initial state)", () => {
    expect(initialEligibility("matcher")).toBe("draft");
    expect(initialEligibility("user")).toBe("eligible");
    expect(initialEligibility("authoring_skill")).toBe("eligible");
    expect(initialEligibility("agent")).toBe("eligible");
  });
});

describe("sourceOutranks — precedence user>authoring_skill>agent>matcher", () => {
  it("orders the four sources correctly", () => {
    expect(sourceOutranks("user", "authoring_skill")).toBe(true);
    expect(sourceOutranks("authoring_skill", "agent")).toBe(true);
    expect(sourceOutranks("agent", "matcher")).toBe(true);
    expect(sourceOutranks("user", "matcher")).toBe(true);
  });
  it("a matcher never outranks anyone (incl. another matcher — equal, not greater)", () => {
    expect(sourceOutranks("matcher", "agent")).toBe(false);
    expect(sourceOutranks("matcher", "matcher")).toBe(false);
    expect(sourceOutranks("agent", "agent")).toBe(false);
  });
});

// Tx-composable assertion builder and result shape. These are PURE (no
// DB): the builder produces the query pair and a parser; we drive the
// parser with synthetic result arrays to pin the inserted-vs-blocked
// detection contract.
describe("buildAssertSemanticTypeQueries — tx-composable builder", () => {
  it("produces exactly the archive + insert-RETURNING op pair (no advisory lock / no refresh tail)", async () => {
    const { buildAssertSemanticTypeQueries } = await import(
      "@/lib/artifacts/semantic-assertion-store"
    );
    const { queries } = buildAssertSemanticTypeQueries({
      orgId: "o",
      artifactId: "a",
      extension: ICP,
      assertedBy: "agent",
    });
    expect(queries).toHaveLength(2);
    expect(queries[0].text).toMatch(/UPDATE[\s\S]*semantic_assertion[\s\S]*SET eligibility='archived'/);
    expect(queries[1].text).toMatch(/INSERT INTO[\s\S]*semantic_assertion[\s\S]*RETURNING id/);
    // The composable builder must NOT smuggle the advisory lock or the
    // graphiti-refresh tail — the caller's outer tx owns those.
    expect(queries.some((q) => /pg_advisory_xact_lock/.test(q.text))).toBe(false);
    expect(queries.some((q) => /graphiti_projection_outbox/.test(q.text))).toBe(false);
  });

  it("parseResult: a RETURNING row at the spliced offset ⇒ {inserted:true, blockedByPrecedence:false}", async () => {
    const { buildAssertSemanticTypeQueries } = await import(
      "@/lib/artifacts/semantic-assertion-store"
    );
    const { parseResult } = buildAssertSemanticTypeQueries({
      orgId: "o",
      artifactId: "a",
      extension: ICP,
      assertedBy: "agent",
    });
    // Caller spliced the 2 ops at offset 3 (e.g. after their own lock +
    // 2 creation writes). insertOpIndex is 1, so the INSERT result is
    // at results[3 + 1] = results[4].
    const fakeResults = [
      { rows: [], rowCount: 0 }, // 0 caller lock
      { rows: [], rowCount: 0 }, // 1 caller write
      { rows: [], rowCount: 0 }, // 2 caller write
      { rows: [], rowCount: 0 }, // 3 archive op
      { rows: [{ id: "new-assertion-id" }], rowCount: 1 }, // 4 insert RETURNING
    ];
    expect(parseResult(fakeResults, 3)).toEqual({
      inserted: true,
      blockedByPrecedence: false,
    });
  });

  it("parseResult: zero RETURNING rows ⇒ {inserted:false, blockedByPrecedence:true} (the matcher's EXPECTED no-op)", async () => {
    const { buildAssertSemanticTypeQueries } = await import(
      "@/lib/artifacts/semantic-assertion-store"
    );
    const { parseResult } = buildAssertSemanticTypeQueries({
      orgId: "o",
      artifactId: "a",
      extension: ICP,
      assertedBy: "matcher",
    });
    const fakeResults = [
      { rows: [], rowCount: 0 }, // 0 archive op (blocked by higher rank)
      { rows: [], rowCount: 0 }, // 1 insert RETURNING (no row → blocked)
    ];
    expect(parseResult(fakeResults, 0)).toEqual({
      inserted: false,
      blockedByPrecedence: true,
    });
  });
});

// cinatra#2047 D-8. The archive op has ALWAYS excluded binding rows ("a classic
// never displaces a binding" — epic #1424); the INSERT did not treat one as a
// precedence block, so an active same-extension binding left the
// `sa_active_unique_idx (org_id, artifact_id, extension)` slot occupied while the
// INSERT still fired → duplicate key, rolling back the caller's whole write. That
// is the D-8 throw on every org holding an artifact pack's claim (the writer mints
// the binding in Tx2 since cinatra#1868). These pin the SQL-level symmetry; the
// real-Postgres behaviour is proven in
// `src/lib/artifacts/__tests__/claimed-production-write-serve-review-2047.integration.test.ts`.
describe("buildAssertSemanticTypeQueries — an active BINDING blocks the classic INSERT (cinatra#2047 D-8)", () => {
  it("the archive EXCLUDES bindings and the insert guard BLOCKS on one — symmetric, so a same-ext binding is a precedence no-op, never a duplicate key", async () => {
    const { buildAssertSemanticTypeQueries } = await import(
      "@/lib/artifacts/semantic-assertion-store"
    );
    const { queries } = buildAssertSemanticTypeQueries({
      orgId: "o",
      artifactId: "a",
      extension: ICP,
      assertedBy: "agent",
    });
    // Archive half (unchanged): binding rows are never superseded by a classic.
    expect(queries[0].text).toMatch(/assertion_basis <> 'binding'/);
    // Insert half: an active same-ext binding is an UNCONDITIONAL block, ORed
    // ahead of the rank comparison (a binding carries asserted_by='system',
    // which the rank CASE floors to 0 — no rank comparison can ever block on it).
    expect(queries[1].text).toMatch(/s3\.assertion_basis = 'binding'/);
    const insertGuard = queries[1].text.slice(queries[1].text.indexOf("WHERE NOT EXISTS"));
    expect(insertGuard.indexOf("s3.assertion_basis = 'binding'")).toBeLessThan(
      insertGuard.indexOf("CASE s3.asserted_by"),
    );
  });

  it("EVERY source (incl. matcher and user) is blocked by an active same-ext binding", async () => {
    const { buildAssertSemanticTypeQueries } = await import(
      "@/lib/artifacts/semantic-assertion-store"
    );
    for (const assertedBy of ["user", "authoring_skill", "agent", "matcher"] as const) {
      const { queries } = buildAssertSemanticTypeQueries({
        orgId: "o",
        artifactId: "a",
        extension: ICP,
        assertedBy,
      });
      expect(queries[1].text).toMatch(/s3\.assertion_basis = 'binding'/);
    }
  });
});

describe("parseResult invariant — missing/malformed slot THROWS", () => {
  it("a wrong offset (slot absent) throws rather than silently reporting blockedByPrecedence", async () => {
    const { buildAssertSemanticTypeQueries } = await import(
      "@/lib/artifacts/semantic-assertion-store"
    );
    const { parseResult } = buildAssertSemanticTypeQueries({
      orgId: "o",
      artifactId: "a",
      extension: ICP,
      assertedBy: "agent",
    });
    // Only 2 results but caller claims offset 10 → slot 11 missing.
    const tooShort = [
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ];
    expect(() => parseResult(tooShort, 10)).toThrow(
      /insert result missing\/malformed at index 11/,
    );
  });

  it("a malformed slot (rows not an array) throws", async () => {
    const { buildAssertSemanticTypeQueries } = await import(
      "@/lib/artifacts/semantic-assertion-store"
    );
    const { parseResult } = buildAssertSemanticTypeQueries({
      orgId: "o",
      artifactId: "a",
      extension: ICP,
      assertedBy: "agent",
    });
    const malformed = [
      { rows: [], rowCount: 0 }, // 0 archive op
      { rows: null as unknown as Array<Record<string, unknown>>, rowCount: 0 }, // 1 insert (malformed)
    ];
    expect(() => parseResult(malformed, 0)).toThrow(
      /insert result missing\/malformed at index 1/,
    );
  });
});
