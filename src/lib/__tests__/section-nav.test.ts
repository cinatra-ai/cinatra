import { describe, it, expect } from "vitest";
import {
  ANALYTICS_NAV,
  ANALYTICS_CATEGORIES,
  ANALYTICS_CATEGORY_PATHS,
  analyticsTabDescription,
} from "../section-nav";

describe("ANALYTICS_NAV — LLM category tabs (#493 vocabulary, #617 tabs-only)", () => {
  it("has the three consistent tabs, including the previously-orphaned Usage", () => {
    expect(ANALYTICS_NAV.map((i) => i.label)).toEqual([
      "Costs",
      "Usage",
      "API Requests",
    ]);
    expect(ANALYTICS_NAV.map((i) => i.href)).toEqual([
      "/analytics/llm",
      "/analytics/llm-usage",
      "/analytics/api",
    ]);
  });

  it("has unique values and hrefs (guards against drift/dupes)", () => {
    const values = ANALYTICS_NAV.map((i) => i.value);
    const hrefs = ANALYTICS_NAV.map((i) => i.href);
    expect(new Set(values).size).toBe(values.length);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("carries a non-empty per-tab description for every tab", () => {
    for (const tab of ANALYTICS_NAV) {
      expect(tab.description.trim().length).toBeGreaterThan(0);
    }
  });

  it("exposes the exact per-tab descriptions (#617)", () => {
    expect(analyticsTabDescription("costs")).toBe(
      "LLM spend broken down by model, agent, and time period.",
    );
    expect(analyticsTabDescription("usage")).toBe(
      "Token and request volume across models and agents over time.",
    );
    expect(analyticsTabDescription("traces")).toBe(
      "API request traces and span-level execution visibility for agents",
    );
  });
});

describe("ANALYTICS_CATEGORIES — sidebar Level 1 (#617)", () => {
  it("lists exactly one category, LLM, decoupled from the tab list", () => {
    expect(ANALYTICS_CATEGORIES).toHaveLength(1);
    expect(ANALYTICS_CATEGORIES[0]).toEqual({
      key: "llm",
      label: "LLM",
      href: "/analytics/llm",
    });
  });

  it("does NOT surface the per-tab labels (Costs/Usage/API Requests) as sidebar entries", () => {
    const sidebarLabels = ANALYTICS_CATEGORIES.map((c) => c.label);
    expect(sidebarLabels).not.toContain("Costs");
    expect(sidebarLabels).not.toContain("Usage");
    expect(sidebarLabels).not.toContain("API Requests");
    // The dropped "API" sidebar entry is gone too.
    expect(sidebarLabels).not.toContain("API");
  });

  it("maps cleanly to a single sidebar sub-item ({ title, url })", () => {
    const sidebar = ANALYTICS_CATEGORIES.map((c) => ({ title: c.label, url: c.href }));
    expect(sidebar).toEqual([{ title: "LLM", url: "/analytics/llm" }]);
  });

  it("owns every LLM tab route so the category stays active across tabs (#581 caveat)", () => {
    // Derived from the tab list — the LLM category lights up on all of its
    // tabs (Costs / Usage / API Requests), incl. /analytics/llm-usage which
    // does not share the /analytics/llm/ url-prefix boundary.
    expect(ANALYTICS_CATEGORY_PATHS.llm).toEqual([
      "/analytics/llm",
      "/analytics/llm-usage",
      "/analytics/api",
    ]);
  });
});
