// Semantic assertion write-policy, precedence, and default-floor
// pure-decision contract. These pure helpers are the unit contract; the
// DB CHECK/trigger guards in drizzle-store.ts are the defense-in-depth
// backstop.
import { describe, it, expect } from "vitest";
import {
  initialEligibility,
  sourceOutranks,
  shouldDefaultBeEligible,
  assertSemanticType,
  confirmAssertion,
  DefaultArtifactNotDirectlyAssertableError,
} from "@/lib/artifacts/semantic-assertion-store";

const DEF = "@cinatra-ai/default-artifact";
const ICP = "@cinatra-ai/marketing-icp-artifact";

describe("default/floor type is NEVER directly assertable", () => {
  it("assertSemanticType + confirmAssertion reject the default extension before any DB call", () => {
    const base = { orgId: "o", artifactId: "a", extension: DEF };
    expect(() => assertSemanticType({ ...base, assertedBy: "matcher" })).toThrow(
      DefaultArtifactNotDirectlyAssertableError,
    );
    expect(() => assertSemanticType({ ...base, assertedBy: "user" })).toThrow(
      DefaultArtifactNotDirectlyAssertableError,
    );
    expect(() => confirmAssertion({ ...base, confirmedBy: "agent" })).toThrow(
      DefaultArtifactNotDirectlyAssertableError,
    );
  });
});

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

describe("shouldDefaultBeEligible — floor invariant: never typeless, never co-asserted", () => {
  it("TRUE when there is NO non-default eligible assertion (floor must hold the type)", () => {
    expect(shouldDefaultBeEligible([])).toBe(true);
    expect(shouldDefaultBeEligible([{ extension: ICP, eligibility: "draft" }])).toBe(true);
    expect(shouldDefaultBeEligible([{ extension: ICP, eligibility: "archived" }])).toBe(true);
    // a default-eligible already present still "should be eligible" (idempotent)
    expect(shouldDefaultBeEligible([{ extension: DEF, eligibility: "eligible" }])).toBe(true);
  });
  it("FALSE when a non-default eligible exists (default must NOT be co-asserted — confident match wins)", () => {
    expect(shouldDefaultBeEligible([{ extension: ICP, eligibility: "eligible" }])).toBe(false);
    expect(
      shouldDefaultBeEligible([
        { extension: ICP, eligibility: "eligible" },
        { extension: DEF, eligibility: "eligible" },
      ]),
    ).toBe(false); // ⇒ caller archives the now-redundant default
  });
  it("a matcher DRAFT alone never suppresses the floor (no typeless window while a draft is pending)", () => {
    expect(
      shouldDefaultBeEligible([
        { extension: ICP, eligibility: "draft" },
        { extension: DEF, eligibility: "eligible" },
      ]),
    ).toBe(true);
  });
});

// Tx-composable assertion builder and result shape. These are PURE (no
// DB): the builder produces the query pair and a parser; we drive the
// parser with synthetic result arrays to pin the inserted-vs-blocked
// detection contract.
describe("buildAssertSemanticTypeQueries — tx-composable builder", () => {
  it("throws on the default-floor extension BEFORE producing any query", async () => {
    const { buildAssertSemanticTypeQueries } = await import(
      "@/lib/artifacts/semantic-assertion-store"
    );
    expect(() =>
      buildAssertSemanticTypeQueries({
        orgId: "o",
        artifactId: "a",
        extension: DEF,
        assertedBy: "agent",
      }),
    ).toThrow(DefaultArtifactNotDirectlyAssertableError);
  });

  it("produces exactly the archive + insert-RETURNING op pair (no advisory lock / no floor rebalance)", async () => {
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
    // floor rebalance — the caller's outer tx owns those.
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
