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

  // A foreign value the grid never owned resolves to the default All tab but is
  // NOT stale — the grid renders "all" and LEAVES the value in the URL rather
  // than clobber it. Load-bearing: the design-conformance seeded harness
  // co-mounts this grid with the installed-extensions status filter, which owns
  // `?tab=archived` (cinatra#1645). A blanket "strip every unknown value" would
  // rewrite that filter's tab out from under it, reverting the selection.
  it("?tab=archived (owned by the co-mounted installed filter) → All tab, NOT stale (left untouched)", () => {
    expect(resolveMarketplaceTab("archived")).toEqual({ activeTab: "all", stale: false });
  });

  it.each(["", "  ", "Workflows", "context", "dashboard", "AGENT", "agent ", "garbage"])(
    "a foreign/unknown value %o → default All tab, NOT stale (rendered as All, left in the URL)",
    (raw) => {
      const resolved = resolveMarketplaceTab(raw);
      expect(resolved.activeTab).toBe("all");
      expect(resolved.stale).toBe(false);
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
