import { describe, expect, it } from "vitest";

import {
  threeWayMergeDashboardConfig,
  computeAppliedDefaultHash,
  stableStringify,
  type DashboardConfigLike,
} from "../contribution-upgrade-merge";

// A minimal portlet: only `instanceId` is the merge identity; `config` carries
// the "content" the merge compares structurally.
const p = (instanceId: string, config: Record<string, unknown> = {}): Record<string, unknown> => ({
  instanceId,
  kind: "object-list",
  version: "1.0.0",
  slot: "fixed",
  config,
});

const cfg = (portlets: Record<string, unknown>[]): DashboardConfigLike => ({
  apiVersion: "1.2",
  scopeLevel: "organization",
  portlets,
});

describe("threeWayMergeDashboardConfig", () => {
  it("takes THEIRS for a portlet the user never touched (ours == base)", () => {
    const base = cfg([p("a", { title: "old" })]);
    const theirs = cfg([p("a", { title: "new" })]);
    const ours = cfg([p("a", { title: "old" })]); // untouched
    const { merged, report } = threeWayMergeDashboardConfig({ base, theirs, ours });
    expect((merged.portlets![0] as any).config.title).toBe("new");
    expect(report.updated).toEqual(["a"]);
    expect(report.conflicts).toEqual([]);
  });

  it("KEEPS OURS for a user-customized portlet, even when theirs also changed (conflict)", () => {
    const base = cfg([p("a", { title: "old" })]);
    const theirs = cfg([p("a", { title: "vendor-new" })]);
    const ours = cfg([p("a", { title: "user-edited" })]); // customized
    const { merged, report } = threeWayMergeDashboardConfig({ base, theirs, ours });
    expect((merged.portlets![0] as any).config.title).toBe("user-edited");
    expect(report.keptCustomized).toEqual(["a"]);
    expect(report.conflicts).toEqual(["a"]); // both sides changed => true conflict
    expect(report.updated).toEqual([]);
  });

  it("keeps a user-customized portlet with NO conflict when only the user changed it", () => {
    const base = cfg([p("a", { title: "old" })]);
    const theirs = cfg([p("a", { title: "old" })]); // vendor unchanged
    const ours = cfg([p("a", { title: "user-edited" })]);
    const { report } = threeWayMergeDashboardConfig({ base, theirs, ours });
    expect(report.keptCustomized).toEqual(["a"]);
    expect(report.conflicts).toEqual([]);
  });

  it("ADDS a brand-new default portlet from theirs", () => {
    const base = cfg([p("a")]);
    const theirs = cfg([p("a"), p("b", { title: "brand new" })]);
    const ours = cfg([p("a")]);
    const { merged, report } = threeWayMergeDashboardConfig({ base, theirs, ours });
    const ids = (merged.portlets as any[]).map((x) => x.instanceId);
    expect(ids).toContain("b");
    expect(report.added).toEqual(["b"]);
  });

  it("REMOVES an extension-retired portlet the user left at default", () => {
    const base = cfg([p("a"), p("b")]);
    const theirs = cfg([p("a")]); // retired b
    const ours = cfg([p("a"), p("b")]); // untouched b
    const { merged, report } = threeWayMergeDashboardConfig({ base, theirs, ours });
    const ids = (merged.portlets as any[]).map((x) => x.instanceId);
    expect(ids).toEqual(["a"]);
    expect(report.removed).toEqual(["b"]);
  });

  it("KEEPS an extension-retired portlet the user CUSTOMIZED (never clobber)", () => {
    const base = cfg([p("a"), p("b", { title: "old" })]);
    const theirs = cfg([p("a")]); // retired b
    const ours = cfg([p("a"), p("b", { title: "user-edited" })]); // customized b
    const { merged, report } = threeWayMergeDashboardConfig({ base, theirs, ours });
    const ids = (merged.portlets as any[]).map((x) => x.instanceId);
    expect(ids).toContain("b");
    expect(report.keptCustomized).toContain("b");
    expect(report.removed).toEqual([]);
  });

  it("leaves a user-DELETED portlet deleted, even if theirs still ships it", () => {
    const base = cfg([p("a"), p("b")]);
    const theirs = cfg([p("a"), p("b", { title: "changed" })]); // still ships b
    const ours = cfg([p("a")]); // user deleted b
    const { merged } = threeWayMergeDashboardConfig({ base, theirs, ours });
    const ids = (merged.portlets as any[]).map((x) => x.instanceId);
    expect(ids).toEqual(["a"]); // b stays deleted
  });

  it("keeps a user-ADDED optional portlet not in base/theirs", () => {
    const base = cfg([p("a")]);
    const theirs = cfg([p("a")]);
    const ours = cfg([p("a"), p("user-added", { title: "mine" })]);
    const { merged } = threeWayMergeDashboardConfig({ base, theirs, ours });
    const ids = (merged.portlets as any[]).map((x) => x.instanceId);
    expect(ids).toContain("user-added");
  });

  it("reports unchanged when neither side changed the default", () => {
    const base = cfg([p("a", { title: "x" })]);
    const theirs = cfg([p("a", { title: "x" })]);
    const ours = cfg([p("a", { title: "x" })]);
    const { unchanged, report } = threeWayMergeDashboardConfig({ base, theirs, ours });
    expect(unchanged).toBe(true);
    expect(report.added).toEqual([]);
    expect(report.updated).toEqual([]);
  });

  it("preserves the OURS envelope (scopeLevel) — content-only merge", () => {
    const base = cfg([p("a")]);
    const theirs: DashboardConfigLike = { apiVersion: "1.2", scopeLevel: "user", portlets: [p("a")] };
    const ours: DashboardConfigLike = { apiVersion: "1.2", scopeLevel: "organization", portlets: [p("a")] };
    const { merged } = threeWayMergeDashboardConfig({ base, theirs, ours });
    expect(merged.scopeLevel).toBe("organization"); // ours preserved
  });

  it("is order-insensitive on the merge identity (re-ordered default is not a rewrite)", () => {
    const base = cfg([p("a"), p("b")]);
    const theirs = cfg([p("b"), p("a")]); // same portlets, re-ordered
    const ours = cfg([p("a"), p("b")]);
    const { report } = threeWayMergeDashboardConfig({ base, theirs, ours });
    expect(report.updated).toEqual([]); // nothing actually changed
    expect(report.added).toEqual([]);
    expect(report.removed).toEqual([]);
  });
});

describe("computeAppliedDefaultHash", () => {
  it("is stable across object-key order", () => {
    const a = { apiVersion: "1.2", scopeLevel: "organization", portlets: [p("x", { a: 1, b: 2 })] };
    const b = { portlets: [p("x", { b: 2, a: 1 })], scopeLevel: "organization", apiVersion: "1.2" };
    expect(computeAppliedDefaultHash(a)).toBe(computeAppliedDefaultHash(b));
  });

  it("is stable across portlet ORDER", () => {
    const a = cfg([p("a"), p("b")]);
    const b = cfg([p("b"), p("a")]);
    expect(computeAppliedDefaultHash(a)).toBe(computeAppliedDefaultHash(b));
  });

  it("changes when a portlet's content changes", () => {
    const a = cfg([p("a", { title: "x" })]);
    const b = cfg([p("a", { title: "y" })]);
    expect(computeAppliedDefaultHash(a)).not.toBe(computeAppliedDefaultHash(b));
  });

  it("stableStringify sorts keys deterministically", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });
});
