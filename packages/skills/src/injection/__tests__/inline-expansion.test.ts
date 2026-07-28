/**
 * Core-owned inline delivery: one-hop expansion under a byte budget
 * (cinatra#2091, epic #2086 S4).
 *
 * A router skill with references must behave EQUIVALENTLY across providers —
 * tool-read on OpenAI/Anthropic, core-side expansion on an inline provider —
 * and an over-budget request must drop WHOLE skills, never half a skill.
 */
import { describe, it, expect } from "vitest";
import {
  extractOneHopReferences,
  normalizeReferencePath,
  planInlineExpansion,
  type InlineExpansionUnit,
  DEFAULT_INLINE_SKILL_BUDGET_BYTES,
  PROVIDER_SKILL_DELIVERY_MECHANISM,
  UnknownSkillDeliveryMechanismError,
  isInlineSkillMechanism,
  resolveInlineSkillBudgetBytes,
  resolveSkillDeliveryMechanism,
} from "..";

describe("normalizeReferencePath", () => {
  it("accepts a bundle-relative path and normalizes it", () => {
    expect(normalizeReferencePath("./references/a.md")).toBe("references/a.md");
    expect(normalizeReferencePath("references\\\\b.md")).toBe("references/b.md");
    expect(normalizeReferencePath("<references/c.md>")).toBe("references/c.md");
    expect(normalizeReferencePath("references/d.md#section")).toBe("references/d.md");
  });

  it("refuses anything that escapes the bundle or is not a bundle file", () => {
    for (const bad of [
      "../secrets.md",
      "references/../../etc/passwd",
      "/etc/passwd",
      "https://example.test/x.md",
      "//example.test/x.md",
      "mailto:a@b.test",
      "SKILL.md",
      "",
      "   ",
      "#anchor",
    ]) {
      expect(normalizeReferencePath(bad)).toBeNull();
    }
  });
});

describe("extractOneHopReferences", () => {
  it("finds markdown links, back-ticked paths and bare references/ mentions, deduped in first-seen order", () => {
    const router = [
      "# Router",
      "See [the guide](references/guide.md) first.",
      "Then read `references/deep-dive.md`.",
      "Also references/extra.md is useful.",
      "Duplicate: [again](./references/guide.md)",
      "External: [docs](https://example.test/x)",
    ].join("\n");
    expect(extractOneHopReferences(router)).toEqual([
      "references/guide.md",
      "references/deep-dive.md",
      "references/extra.md",
    ]);
  });

  it("stays linear on adversarial input (no polynomial backtracking)", () => {
    // Two pathological shapes for a reference scanner: a long run of `[` (the
    // classic `\[[^\]]*\]\(` blow-up) and a long run of `](` (which makes an
    // UNBOUNDED target group re-scan to the end of the router on every match
    // before backtracking to find its `)`). Both are quadratic without the
    // closing anchor + the length bounds; both are milliseconds with them.
    //
    // The budget is deliberately loose: this asserts an ORDER OF MAGNITUDE, not
    // a wall-clock figure, so it does not turn into a flake on a shared runner.
    // A quadratic form takes tens of seconds at this size.
    const started = Date.now();
    expect(extractOneHopReferences("[".repeat(20000))).toEqual([]);
    expect(extractOneHopReferences("](".repeat(20000))).toEqual([]);
    expect(extractOneHopReferences("[](".repeat(20000))).toEqual([]);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("returns nothing for an empty or reference-free router", () => {
    expect(extractOneHopReferences("")).toEqual([]);
    expect(extractOneHopReferences("no refs here")).toEqual([]);
  });
});

describe("planInlineExpansion", () => {
  const unit = (
    skillId: string,
    body: string,
    references: Array<{ path: string; content: string }> = [],
  ): InlineExpansionUnit => ({
    skillId,
    rank: "declared_dependency",
    body,
    references,
  });

  it("inlines the router AND its one-hop references, at whole-file granularity", () => {
    const plan = planInlineExpansion({
      units: [unit("s1", "ROUTER BODY", [{ path: "references/a.md", content: "REF A" }])],
      budgetBytes: DEFAULT_INLINE_SKILL_BUDGET_BYTES,
    });
    expect(plan.includedSkillIds).toEqual(["s1"]);
    expect(plan.systemContext).toContain("ROUTER BODY");
    expect(plan.systemContext).toContain("REF A");
    expect(plan.systemContext).toContain("s1 :: references/a.md");
    expect(plan.dropped).toEqual([]);
  });

  it("drops the WHOLE skill on budget overflow — never a partial body", () => {
    const big = "X".repeat(400);
    const plan = planInlineExpansion({
      units: [
        unit("keeps", "SMALL"),
        unit("drops", "ROUTER", [{ path: "references/big.md", content: big }]),
      ],
      budgetBytes: 200,
    });
    expect(plan.includedSkillIds).toEqual(["keeps"]);
    expect(plan.systemContext).not.toContain("ROUTER");
    expect(plan.systemContext).not.toContain("X".repeat(50));
    expect(plan.dropped).toEqual([
      { skillId: "drops", rank: "declared_dependency", reason: "inline_budget_exhausted" },
    ]);
  });

  it("consumes the budget in RANK ORDER — the highest-ranked skills claim it first", () => {
    const body = "Y".repeat(120);
    const plan = planInlineExpansion({
      units: [
        { skillId: "delta", rank: "personal_delta", body },
        { skillId: "dep", rank: "declared_dependency", body },
        { skillId: "rec", rank: "recommendation", body },
      ],
      budgetBytes: 320,
    });
    expect(plan.includedSkillIds).toEqual(["delta", "dep"]);
    expect(plan.dropped.map((d) => d.skillId)).toEqual(["rec"]);
  });

  it("records an unresolvable body with its own reason rather than emitting an empty skill", () => {
    const plan = planInlineExpansion({
      units: [unit("missing", ""), { skillId: "nullish", rank: "recommendation", body: null }],
      budgetBytes: DEFAULT_INLINE_SKILL_BUDGET_BYTES,
    });
    expect(plan.includedSkillIds).toEqual([]);
    expect(plan.systemContext).toBe("");
    expect(plan.dropped.map((d) => d.reason)).toEqual([
      "inline_body_unresolvable",
      "inline_body_unresolvable",
    ]);
  });

  it("an OVERSIZED reference drops the whole skill (whole-file granularity)", () => {
    const plan = planInlineExpansion({
      units: [
        { skillId: "keeps", rank: "declared_dependency", body: "SMALL" },
        {
          skillId: "oversized",
          rank: "declared_dependency",
          body: "ROUTER",
          references: [],
          oversized: true,
        },
      ],
      budgetBytes: DEFAULT_INLINE_SKILL_BUDGET_BYTES,
    });
    expect(plan.includedSkillIds).toEqual(["keeps"]);
    expect(plan.systemContext).not.toContain("ROUTER");
    expect(plan.dropped).toEqual([
      { skillId: "oversized", rank: "declared_dependency", reason: "inline_budget_exhausted" },
    ]);
  });

  it("the EMITTED fragment never exceeds the budget (header + separators counted)", () => {
    const encoder = new TextEncoder();
    for (const budget of [40, 80, 160, 320, 640]) {
      const plan = planInlineExpansion({
        units: Array.from({ length: 6 }, (_, i) => ({
          skillId: `s${i}`,
          rank: "declared_dependency" as const,
          body: "B".repeat(40),
        })),
        budgetBytes: budget,
      });
      expect(encoder.encode(plan.systemContext).length).toBeLessThanOrEqual(budget);
      expect(plan.totalBytes).toBe(encoder.encode(plan.systemContext).length);
    }
  });

  it("a zero budget drops everything and emits nothing", () => {
    const plan = planInlineExpansion({
      units: [unit("s1", "BODY")],
      budgetBytes: 0,
    });
    expect(plan.systemContext).toBe("");
    expect(plan.totalBytes).toBe(0);
    expect(plan.dropped).toHaveLength(1);
  });
});

describe("provider -> mechanism map", () => {
  it("declares one mechanism per provider", () => {
    expect(PROVIDER_SKILL_DELIVERY_MECHANISM).toEqual({
      openai: "tool-mount",
      gemini: "inline",
      anthropic: "container",
    });
    expect(resolveSkillDeliveryMechanism("openai")).toBe("tool-mount");
    expect(isInlineSkillMechanism("gemini")).toBe(true);
    expect(isInlineSkillMechanism("anthropic")).toBe(false);
  });

  it("fails CLOSED for a provider with no declared mechanism", () => {
    expect(() => resolveSkillDeliveryMechanism("brand-new")).toThrow(
      UnknownSkillDeliveryMechanismError,
    );
  });

  it("the budget is 200,000 bytes and deployment-configurable", () => {
    expect(DEFAULT_INLINE_SKILL_BUDGET_BYTES).toBe(200_000);
    expect(resolveInlineSkillBudgetBytes({})).toBe(200_000);
    expect(
      resolveInlineSkillBudgetBytes({ CINATRA_INLINE_SKILL_BUDGET_BYTES: "50000" }),
    ).toBe(50_000);
    // Garbage / non-positive falls back rather than disabling the budget.
    for (const raw of ["", "  ", "nonsense", "0", "-5"]) {
      expect(
        resolveInlineSkillBudgetBytes({ CINATRA_INLINE_SKILL_BUDGET_BYTES: raw }),
      ).toBe(200_000);
    }
  });
});
