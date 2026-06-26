import { describe, it, expect } from "vitest";
import { ANALYTICS_NAV } from "../section-nav";

describe("ANALYTICS_NAV (#493) — single source for tabs + sidebar", () => {
  it("has the three consistent entries, including the previously-orphaned Usage", () => {
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

  it("maps cleanly to sidebar sub-items ({ title, url })", () => {
    const sidebar = ANALYTICS_NAV.map((i) => ({ title: i.label, url: i.href }));
    expect(sidebar).toContainEqual({ title: "Usage", url: "/analytics/llm-usage" });
    expect(sidebar).toHaveLength(3);
  });
});
