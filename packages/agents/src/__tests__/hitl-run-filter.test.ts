import { describe, it, expect } from "vitest";
import {
  selectHitlRunVisibleTemplates,
  templateHasOwnHitl,
  type HitlRunFilterTemplate,
} from "../hitl-run-filter";

function template(
  overrides: Partial<HitlRunFilterTemplate> & { id: string },
): HitlRunFilterTemplate {
  return {
    packageName: null,
    hitlRequired: false,
    hitlScreens: null,
    gatedSteps: null,
    agentDependencies: undefined,
    sourceType: "internal",
    ...overrides,
  };
}

describe("templateHasOwnHitl", () => {
  it("returns true when hitlRequired flag is set", () => {
    expect(
      templateHasOwnHitl(template({ id: "a", hitlRequired: true })),
    ).toBe(true);
  });

  it("returns true when hitlScreens is non-empty", () => {
    expect(
      templateHasOwnHitl(
        template({ id: "a", hitlScreens: ["@cinatra/auditor-review-renderer"] }),
      ),
    ).toBe(true);
  });

  it("returns true when gatedSteps is non-empty", () => {
    expect(
      templateHasOwnHitl(
        template({
          id: "a",
          // gatedSteps shape is intentionally minimal here — the filter only
          // looks at .length, never at field contents.
          gatedSteps: [{ stepName: "review", mode: "approval" } as never],
        }),
      ),
    ).toBe(true);
  });

  it("returns false when all three signals are absent or empty", () => {
    expect(
      templateHasOwnHitl(
        template({ id: "a", hitlScreens: [], gatedSteps: [] }),
      ),
    ).toBe(false);
  });

  it("treats null hitlScreens / gatedSteps as absent by default", () => {
    expect(
      templateHasOwnHitl(
        template({ id: "a", hitlScreens: null, gatedSteps: null }),
      ),
    ).toBe(false);
  });
});

describe("selectHitlRunVisibleTemplates", () => {
  it("keeps templates with their own HITL signal", () => {
    const hitl = template({
      id: "hitl",
      packageName: "@cinatra-ai/list-curator-agent",
      hitlScreens: ["@cinatra/list-curator-renderer"],
    });
    const result = selectHitlRunVisibleTemplates([hitl]);
    expect(result.map((t) => t.id)).toEqual(["hitl"]);
  });

  it("drops internal templates with no HITL and no HITL-parent", () => {
    const leaf = template({
      id: "leaf",
      packageName: "@cinatra-ai/web-scrape-agent",
    });
    expect(selectHitlRunVisibleTemplates([leaf])).toEqual([]);
  });

  it("keeps direct sub-agents of a HITL parent (via agentDependencies)", () => {
    const parent = template({
      id: "parent",
      packageName: "@cinatra-ai/list-curator-agent",
      hitlRequired: true,
      agentDependencies: {
        "@cinatra-ai/email-test-delivery-agent": "^0.1.0",
      },
    });
    const child = template({
      id: "child",
      packageName: "@cinatra-ai/email-test-delivery-agent",
    });
    const unrelated = template({
      id: "unrelated",
      packageName: "@cinatra-ai/web-scrape-agent",
    });
    const ids = selectHitlRunVisibleTemplates([parent, child, unrelated])
      .map((t) => t.id)
      .sort();
    expect(ids).toEqual(["child", "parent"]);
  });

  it("keeps transitive (grandchild) sub-agents of a HITL parent", () => {
    const grandparent = template({
      id: "gp",
      packageName: "@cinatra-ai/email-outreach-agent",
      gatedSteps: [{ stepName: "final" } as never],
      agentDependencies: { "@cinatra-ai/reviewer-agent": "^0.1.0" },
    });
    const child = template({
      id: "child",
      packageName: "@cinatra-ai/reviewer-agent",
      agentDependencies: { "@cinatra-ai/email-test-delivery-agent": "^0.1.0" },
    });
    const grandchild = template({
      id: "gc",
      packageName: "@cinatra-ai/email-test-delivery-agent",
    });
    const ids = selectHitlRunVisibleTemplates([grandparent, child, grandchild])
      .map((t) => t.id)
      .sort();
    expect(ids).toEqual(["child", "gc", "gp"]);
  });

  it("does NOT include a wrapper orchestrator just because its sub-agent has HITL", () => {
    // The user request is "HITL agents + their sub-agents." A pure orchestrator
    // that has zero HITL signals of its own but depends on a HITL leaf is NOT
    // included — only the leaf is. (Today's installed orchestrators with HITL
    // leaves already carry hitlRequired/hitlScreens themselves, so this is
    // the documented design choice, not a regression risk.)
    const orchestrator = template({
      id: "orch",
      packageName: "@cinatra/wrapper-agent",
      agentDependencies: { "@cinatra-ai/list-curator-agent": "^0.1.0" },
    });
    const leaf = template({
      id: "leaf",
      packageName: "@cinatra-ai/list-curator-agent",
      hitlRequired: true,
    });
    const ids = selectHitlRunVisibleTemplates([orchestrator, leaf])
      .map((t) => t.id)
      .sort();
    expect(ids).toEqual(["leaf"]);
  });

  it("always keeps external templates (Cinatra cannot pre-classify their HITL)", () => {
    const external = template({
      id: "ext",
      packageName: null,
      sourceType: "external",
    });
    expect(selectHitlRunVisibleTemplates([external]).map((t) => t.id)).toEqual([
      "ext",
    ]);
  });

  it("survives missing agentDependencies and empty input", () => {
    expect(selectHitlRunVisibleTemplates([])).toEqual([]);
    const lone = template({
      id: "lone",
      packageName: "@cinatra/x",
      hitlRequired: true,
      agentDependencies: undefined,
    });
    expect(selectHitlRunVisibleTemplates([lone]).map((t) => t.id)).toEqual([
      "lone",
    ]);
  });

  it("tolerates an agentDependencies entry that points to a package not present in the install set", () => {
    const parent = template({
      id: "parent",
      packageName: "@cinatra/p",
      hitlRequired: true,
      agentDependencies: { "@cinatra/unknown": "^0.1.0" },
    });
    expect(
      selectHitlRunVisibleTemplates([parent]).map((t) => t.id),
    ).toEqual(["parent"]);
  });

  it("preserves input order in the returned list", () => {
    const a = template({
      id: "a",
      packageName: "@cinatra/a",
      hitlRequired: true,
    });
    const b = template({ id: "b", packageName: "@cinatra/b" });
    const c = template({
      id: "c",
      packageName: "@cinatra/c",
      hitlRequired: true,
      agentDependencies: { "@cinatra/b": "^0.1.0" },
    });
    expect(
      selectHitlRunVisibleTemplates([a, b, c]).map((t) => t.id),
    ).toEqual(["a", "b", "c"]);
  });

  it("does not loop on cyclic agentDependencies", () => {
    const a = template({
      id: "a",
      packageName: "@cinatra/a",
      hitlRequired: true,
      agentDependencies: { "@cinatra/b": "^0.1.0" },
    });
    const b = template({
      id: "b",
      packageName: "@cinatra/b",
      agentDependencies: { "@cinatra/a": "^0.1.0" },
    });
    const ids = selectHitlRunVisibleTemplates([a, b])
      .map((t) => t.id)
      .sort();
    expect(ids).toEqual(["a", "b"]);
  });
});
