import { describe, it, expect } from "vitest";

import {
  DEFAULT_INSTALLED_TAB,
  INSTALLED_TABS,
  isInstalledTabValue,
  resolveInstalledTab,
} from "../installed-tab-model";

describe("INSTALLED_TABS", () => {
  it("offers the full status set in the stated order: All, Active, Locked, Archived (cinatra#1571 AC1)", () => {
    expect(INSTALLED_TABS.map((t) => t.value)).toEqual([
      "all",
      "active",
      "locked",
      "archived",
    ]);
    expect(INSTALLED_TABS.map((t) => t.label)).toEqual([
      "All",
      "Active",
      "Locked",
      "Archived",
    ]);
  });

  it("defaults to Active — adding options must not change the default landing view (AC2)", () => {
    expect(DEFAULT_INSTALLED_TAB).toBe("active");
  });
});

describe("resolveInstalledTab — the ?tab= URL contract (cinatra#1571 AC2)", () => {
  it("absent / no-query (undefined | null) → the default Active view", () => {
    expect(resolveInstalledTab(undefined)).toBe("active");
    expect(resolveInstalledTab(null)).toBe("active");
  });

  it.each(["all", "active", "locked", "archived"] as const)(
    "?tab=%s resolves to its own view",
    (value) => {
      expect(resolveInstalledTab(value)).toBe(value);
    },
  );

  it.each([
    "",
    "   ",
    "Active",
    "ACTIVE",
    "active ",
    "workflow",
    "garbage",
    "all,active",
  ])(
    "an invalid/unknown value %o falls back to the default Active view (a defined, tested fallback replacing the old silent → active)",
    (raw) => {
      expect(resolveInstalledTab(raw)).toBe("active");
    },
  );

  it("a string[] search param resolves from its first element (Next.js repeated-param shape)", () => {
    expect(resolveInstalledTab(["locked", "archived"])).toBe("locked");
    expect(resolveInstalledTab(["all"])).toBe("all");
    // An invalid first element still falls back to Active.
    expect(resolveInstalledTab(["nonsense", "locked"])).toBe("active");
    // An empty array has no first element → the default.
    expect(resolveInstalledTab([])).toBe("active");
  });
});

describe("isInstalledTabValue", () => {
  it("recognizes exactly the four canonical values", () => {
    for (const t of INSTALLED_TABS) {
      expect(isInstalledTabValue(t.value)).toBe(true);
    }
  });

  it("rejects unknown / mis-cased / legacy values", () => {
    for (const raw of ["", "Active", "workflow", "ARCHIVED", "lock", "actives"]) {
      expect(isInstalledTabValue(raw)).toBe(false);
    }
  });
});
