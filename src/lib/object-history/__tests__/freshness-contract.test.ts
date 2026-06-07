// Freshness contract + restore-decision tests.

import { describe, expect, it } from "vitest";

import { freshnessAllowsRestore } from "../freshness/contract";

describe("freshnessAllowsRestore", () => {
  it("allows fresh", () => {
    const v = freshnessAllowsRestore(
      { state: "fresh", baseRevision: "rev_1" },
      { isCmsObject: true },
    );
    expect(v.allowed).toBe(true);
  });

  it("blocks missing", () => {
    const v = freshnessAllowsRestore(
      { state: "missing" },
      { isCmsObject: true },
    );
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/missing/);
  });

  it("blocks changed", () => {
    const v = freshnessAllowsRestore(
      {
        state: "changed",
        baseRevision: "rev_1",
        changedFields: ["title", "content"],
      },
      { isCmsObject: true },
    );
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/changed/);
  });

  it("blocks unknown by default", () => {
    const v = freshnessAllowsRestore(
      { state: "unknown", reason: "network" },
      { isCmsObject: true },
    );
    expect(v.allowed).toBe(false);
  });

  it("blocks unsupported for CMS-tagged objects", () => {
    const v = freshnessAllowsRestore(
      { state: "unsupported" },
      { isCmsObject: true },
    );
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/unsupported/);
  });

  it("allows unsupported for non-CMS objects", () => {
    const v = freshnessAllowsRestore(
      { state: "unsupported" },
      { isCmsObject: false },
    );
    expect(v.allowed).toBe(true);
  });
});
