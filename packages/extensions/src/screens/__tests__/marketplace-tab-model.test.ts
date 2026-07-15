import { describe, it, expect } from "vitest";

import {
  MARKETPLACE_TABS,
  isCanonicalTabValue,
  resolveMarketplaceTab,
} from "../marketplace-tab-model";

describe("MARKETPLACE_TABS", () => {
  it("renders exactly All + the four extension kinds — no 'workflow' tab (cinatra#1035)", () => {
    expect(MARKETPLACE_TABS.map((t) => t.value)).toEqual([
      "all",
      "agent",
      "skill",
      "connector",
      "artifact",
    ]);
    expect(MARKETPLACE_TABS.map((t) => t.value)).not.toContain("workflow");
    expect(MARKETPLACE_TABS.map((t) => t.label)).not.toContain("Workflows");
  });
});

describe("resolveMarketplaceTab — canonicalization", () => {
  // The resolver is the single decision point the client applies identically to
  // a direct load, a client-side navigation, and back/forward (its input is
  // useSearchParams().get("tab") in every case), so exercising it over the value
  // space covers all three navigation paths.

  it("absent tab (null) → default All tab, canonical (no strip)", () => {
    expect(resolveMarketplaceTab(null)).toEqual({ activeTab: "all", stale: false });
  });

  it("explicit ?tab=all → All tab, canonical (no strip)", () => {
    expect(resolveMarketplaceTab("all")).toEqual({ activeTab: "all", stale: false });
  });

  it.each(["agent", "skill", "connector", "artifact"] as const)(
    "a live kind value %s selects that tab, canonical (no strip)",
    (kind) => {
      expect(resolveMarketplaceTab(kind)).toEqual({ activeTab: kind, stale: false });
    },
  );

  it("the removed ?tab=workflow → default All tab, STALE (client strips it — never a 404, never a dead tab)", () => {
    expect(resolveMarketplaceTab("workflow")).toEqual({ activeTab: "all", stale: true });
  });

  it.each(["", "  ", "Workflows", "context", "dashboard", "AGENT", "agent ", "garbage"])(
    "an invalid/removed value %o → default All tab, STALE",
    (raw) => {
      const resolved = resolveMarketplaceTab(raw);
      expect(resolved.activeTab).toBe("all");
      expect(resolved.stale).toBe(true);
    },
  );
});

describe("isCanonicalTabValue", () => {
  it("null and the five rendered values are canonical", () => {
    expect(isCanonicalTabValue(null)).toBe(true);
    for (const t of MARKETPLACE_TABS) {
      expect(isCanonicalTabValue(t.value)).toBe(true);
    }
  });

  it("the removed 'workflow' and other unknowns are not canonical", () => {
    expect(isCanonicalTabValue("workflow")).toBe(false);
    expect(isCanonicalTabValue("")).toBe(false);
    expect(isCanonicalTabValue("context")).toBe(false);
  });
});
