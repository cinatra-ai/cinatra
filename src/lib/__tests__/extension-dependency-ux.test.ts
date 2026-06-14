// cinatra #209 item 2 — dependency-UX presenters. PURE derivations over the
// REAL data shapes (manifest edges + ledger batch); no DB, no React.
import { describe, expect, it } from "vitest";

import {
  formatVersionConstraint,
  summarizeRequiredDependencies,
  summarizeBatchOutcome,
  toMemberProgressRows,
} from "@/lib/extension-dependency-ux";
import type {
  InstallBatch,
  InstallBatchMember,
} from "@/lib/extension-install-batch-ops";
import type { ExtensionDependency } from "@cinatra-ai/extensions/canonical-types";

function edge(over: Partial<ExtensionDependency> & { packageName: string }): ExtensionDependency {
  return {
    edgeType: "runtime",
    requirement: "required",
    versionConstraint: { kind: "semver-range", range: "^1.0.0" },
    ...over,
  };
}

function member(over: Partial<InstallBatchMember> & { packageName: string }): InstallBatchMember {
  return {
    version: "1.0.0",
    typeId: "agent",
    status: "planned",
    preState: { present: false },
    ...over,
  };
}

function batch(over: Partial<InstallBatch> & { rootPackage: string; members: InstallBatchMember[] }): InstallBatch {
  return {
    batchId: "b-1",
    orgId: null,
    phase: "installing",
    createdAt: "2026-06-15T00:00:00.000Z",
    updatedAt: "2026-06-15T00:01:00.000Z",
    ...over,
  };
}

describe("formatVersionConstraint", () => {
  it("renders semver ranges, exact pins, git refs, and 'any'", () => {
    expect(formatVersionConstraint({ kind: "semver-range", range: "^1.2.0" })).toBe("^1.2.0");
    expect(formatVersionConstraint({ kind: "semver-range", range: "*" })).toBe("any version");
    expect(formatVersionConstraint({ kind: "exact", version: "1.2.3" })).toBe("=1.2.3");
    expect(formatVersionConstraint({ kind: "git-ref", ref: "abc123" })).toBe("git:abc123");
  });
});

describe("summarizeRequiredDependencies", () => {
  it("buckets required runtime/install-time edges as auto-installed", () => {
    const s = summarizeRequiredDependencies([
      edge({ packageName: "@scope/runtime-dep", edgeType: "runtime", requirement: "required" }),
      edge({ packageName: "@scope/install-dep", edgeType: "install-time", requirement: "required" }),
    ]);
    expect(s.autoInstalled.map((r) => r.packageName)).toEqual([
      "@scope/install-dep",
      "@scope/runtime-dep",
    ]);
    expect(s.autoInstalled.every((r) => r.relationship === "auto")).toBe(true);
    expect(s.peer).toHaveLength(0);
    expect(s.optional).toHaveLength(0);
    expect(s.hasAny).toBe(true);
  });

  it("classifies peer edges separately and never as auto-installed", () => {
    const s = summarizeRequiredDependencies([
      edge({ packageName: "@scope/peer-req", edgeType: "peer", requirement: "required" }),
      edge({ packageName: "@scope/peer-opt", edgeType: "peer", requirement: "optional" }),
    ]);
    expect(s.autoInstalled).toHaveLength(0);
    expect(s.peer.map((r) => r.packageName)).toEqual(["@scope/peer-opt", "@scope/peer-req"]);
    expect(s.peer.every((r) => r.relationship === "peer")).toBe(true);
  });

  it("classifies optional non-peer edges as optional", () => {
    const s = summarizeRequiredDependencies([
      edge({ packageName: "@scope/opt-dep", edgeType: "runtime", requirement: "optional" }),
    ]);
    expect(s.optional.map((r) => r.packageName)).toEqual(["@scope/opt-dep"]);
    expect(s.optional[0]!.relationship).toBe("optional");
    expect(s.autoInstalled).toHaveLength(0);
  });

  it("carries the declared kind and version constraint through to the row", () => {
    const s = summarizeRequiredDependencies([
      edge({
        packageName: "@scope/skill-dep",
        kind: "skill",
        versionConstraint: { kind: "exact", version: "2.0.0" },
      }),
    ]);
    expect(s.autoInstalled[0]).toMatchObject({
      packageName: "@scope/skill-dep",
      kind: "skill",
      constraint: "=2.0.0",
    });
  });

  it("returns hasAny=false for no edges", () => {
    expect(summarizeRequiredDependencies([]).hasAny).toBe(false);
  });
});

describe("toMemberProgressRows", () => {
  it("preserves ledger order, labels statuses, flags root + pre-existing", () => {
    const b = batch({
      rootPackage: "@scope/root",
      members: [
        member({ packageName: "@scope/dep", status: "installed" }),
        member({ packageName: "@scope/preexisting", status: "already-installed", preState: { present: true, version: "1.0.0" } }),
        member({ packageName: "@scope/root", status: "installing" }),
      ],
    });
    const rows = toMemberProgressRows(b);
    expect(rows.map((r) => r.packageName)).toEqual([
      "@scope/dep",
      "@scope/preexisting",
      "@scope/root",
    ]);
    expect(rows[0]).toMatchObject({ status: "installed", tone: "done", label: "Installed", isRoot: false });
    expect(rows[1]).toMatchObject({ tone: "skipped", label: "Already installed", preExisting: true });
    expect(rows[2]).toMatchObject({ tone: "active", label: "Installing", isRoot: true });
  });

  it("surfaces failure/compensation detail and the failed/rollback tones", () => {
    const b = batch({
      rootPackage: "@scope/root",
      phase: "failed",
      members: [
        member({ packageName: "@scope/dep", status: "compensated" }),
        member({ packageName: "@scope/root", status: "failed", detail: "boom" }),
      ],
    });
    const rows = toMemberProgressRows(b);
    expect(rows[0]).toMatchObject({ status: "compensated", tone: "skipped", label: "Rolled back" });
    expect(rows[1]).toMatchObject({ status: "failed", tone: "failed", label: "Failed", detail: "boom" });
  });
});

describe("summarizeBatchOutcome", () => {
  it("finalized → success headline, terminal", () => {
    const o = summarizeBatchOutcome(
      batch({
        rootPackage: "@scope/root",
        phase: "finalized",
        members: [member({ packageName: "@scope/root", status: "installed" })],
      }),
    );
    expect(o.tone).toBe("success");
    expect(o.terminal).toBe(true);
    expect(o.headline).toContain("Installed @scope/root");
    expect(o.compensated).toHaveLength(0);
  });

  it("compensated → names rolled-back members, clean-rollback headline", () => {
    const o = summarizeBatchOutcome(
      batch({
        rootPackage: "@scope/root",
        phase: "compensated",
        members: [
          member({ packageName: "@scope/dep", status: "compensated" }),
          member({ packageName: "@scope/root", status: "failed", detail: "gate refused" }),
        ],
      }),
    );
    expect(o.tone).toBe("compensated");
    expect(o.compensated).toEqual(["@scope/dep"]);
    expect(o.failedMember).toBe("@scope/root");
    expect(o.headline).toContain("rolled back cleanly");
  });

  it("failed with compensation-failed → names manual-cleanup members", () => {
    const o = summarizeBatchOutcome(
      batch({
        rootPackage: "@scope/root",
        phase: "failed",
        members: [
          member({ packageName: "@scope/dep", status: "compensation-failed", detail: "uninstall threw" }),
          member({ packageName: "@scope/root", status: "failed" }),
        ],
      }),
    );
    expect(o.tone).toBe("failed");
    expect(o.compensationFailed).toEqual(["@scope/dep"]);
    expect(o.headline).toContain("manual cleanup");
  });

  it("compensated with no rolled-back members → 'no dependencies needed rollback'", () => {
    const o = summarizeBatchOutcome(
      batch({
        rootPackage: "@scope/root",
        phase: "compensated",
        members: [member({ packageName: "@scope/root", status: "failed" })],
      }),
    );
    expect(o.headline).toContain("no dependencies needed rollback");
  });

  it("active phases are non-terminal with an installing headline", () => {
    const o = summarizeBatchOutcome(
      batch({
        rootPackage: "@scope/root",
        phase: "installing",
        members: [member({ packageName: "@scope/root", status: "installing" })],
      }),
    );
    expect(o.tone).toBe("active");
    expect(o.terminal).toBe(false);
    expect(o.headline).toContain("Installing @scope/root");
  });
});
