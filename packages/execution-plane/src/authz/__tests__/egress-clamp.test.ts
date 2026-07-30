// Deployment egress CLAMP — per-axis acceptance battery (exec-plane, epic #1705).
//
// The voucher's egress policy is SIGNED, which stops a client forging one. It
// does not stop tenant settings from asking for more than the deployment
// permits, so the broker clamps on all THREE axes independently — and a clamp on
// one axis must never leave another unclamped. Each axis is asserted on its own,
// and then in combination, because "mode narrowed" silently leaving a wider host
// list in place is exactly the defect shape here.

import { describe, expect, it } from "vitest";

import { clampEgressPolicy, intersectAllowlists } from "../egress-clamp";
import type { EgressPolicy } from "../../types";

describe("axis 1 — mode", () => {
  it("takes the NARROWER tier of signed and deployment maximum", () => {
    const cases: Array<[EgressPolicy["mode"], EgressPolicy["mode"], EgressPolicy["mode"]]> = [
      ["default_internet", "none", "none"],
      ["default_internet", "allowlist", "allowlist"],
      ["default_internet", "default_internet", "default_internet"],
      ["allowlist", "none", "none"],
      ["allowlist", "default_internet", "allowlist"],
      ["none", "default_internet", "none"],
    ];
    for (const [signed, maximum, expected] of cases) {
      const { policy, clamped } = clampEgressPolicy({ mode: signed }, { mode: maximum });
      expect(policy.mode).toBe(expected);
      expect(clamped.includes("mode")).toBe(expected !== signed);
    }
  });

  it("a deployment HOST ceiling forces the mode down even at the widest tier", () => {
    // A deployment that names hosts is declaring a host bound, which
    // `default_internet` ("any host") cannot satisfy.
    const { policy, clamped } = clampEgressPolicy(
      { mode: "default_internet" },
      { mode: "default_internet", allowlist: ["pypi.org"] },
    );
    expect(policy.mode).toBe("allowlist");
    expect(policy.allowlist).toEqual(["pypi.org"]);
    expect(clamped).toEqual(expect.arrayContaining(["mode", "allowlist"]));
  });

  it("no deployment maximum ⇒ the signed policy passes through untouched", () => {
    const signed: EgressPolicy = { mode: "allowlist", allowlist: ["pypi.org"], maxBytesPerJob: 10 };
    expect(clampEgressPolicy(signed)).toEqual({ policy: signed, clamped: [] });
  });
});

describe("axis 2 — allowlist INTERSECTION", () => {
  it("intersects rather than preferring one side's list", () => {
    const { policy, clamped } = clampEgressPolicy(
      { mode: "allowlist", allowlist: ["pypi.org", "example.com"] },
      { mode: "allowlist", allowlist: ["pypi.org", "npmjs.org"] },
    );
    expect(policy.allowlist).toEqual(["pypi.org"]);
    expect(clamped).toContain("allowlist");
  });

  it("keeps the NARROWER host under the dot-suffix grammar, never the wider one", () => {
    // A ⊃ D on this host: the intersection is the deployment's narrower host.
    expect(intersectAllowlists(["pypi.org"], ["files.pypi.org"])).toEqual(["files.pypi.org"]);
    // Symmetric.
    expect(intersectAllowlists(["files.pypi.org"], ["pypi.org"])).toEqual(["files.pypi.org"]);
    // Disjoint ⇒ empty (deny every host), never a union.
    expect(intersectAllowlists(["a.example"], ["b.example"])).toEqual([]);
  });

  it("normalizes hosts (case, whitespace, wildcard and trailing dot) before intersecting", () => {
    expect(intersectAllowlists([" PyPI.org. "], ["*.pypi.org"])).toEqual(["pypi.org"]);
  });

  it("an empty intersection denies every host and is reported as a clamp", () => {
    const { policy, clamped } = clampEgressPolicy(
      { mode: "allowlist", allowlist: ["evil.example"] },
      { mode: "allowlist", allowlist: ["pypi.org"] },
    );
    expect(policy).toEqual({ mode: "allowlist", allowlist: [] });
    expect(clamped).toContain("allowlist");
  });

  it("an unchanged list is NOT reported as a clamp", () => {
    const { policy, clamped } = clampEgressPolicy(
      { mode: "allowlist", allowlist: ["pypi.org"] },
      { mode: "allowlist", allowlist: ["pypi.org"] },
    );
    expect(policy.allowlist).toEqual(["pypi.org"]);
    expect(clamped).toEqual([]);
  });

  it("a deployment with no host ceiling leaves the signed list alone", () => {
    const { policy, clamped } = clampEgressPolicy(
      { mode: "allowlist", allowlist: ["pypi.org"] },
      { mode: "default_internet" },
    );
    expect(policy).toEqual({ mode: "allowlist", allowlist: ["pypi.org"] });
    expect(clamped).toEqual([]);
  });
});

describe("axis 3 — maxBytesPerJob = min(client, cap)", () => {
  it("takes the minimum of the two ceilings", () => {
    expect(
      clampEgressPolicy({ mode: "none", maxBytesPerJob: 5_000 }, { mode: "none", maxBytesPerJob: 1_000 }),
    ).toEqual({ policy: { mode: "none", maxBytesPerJob: 1_000 }, clamped: ["max_bytes"] });
    expect(
      clampEgressPolicy({ mode: "none", maxBytesPerJob: 500 }, { mode: "none", maxBytesPerJob: 1_000 }),
    ).toEqual({ policy: { mode: "none", maxBytesPerJob: 500 }, clamped: [] });
  });

  it("an absent signed cap adopts the deployment cap (and reports the clamp)", () => {
    expect(clampEgressPolicy({ mode: "none" }, { mode: "none", maxBytesPerJob: 1_000 })).toEqual({
      policy: { mode: "none", maxBytesPerJob: 1_000 },
      clamped: ["max_bytes"],
    });
  });

  it("an absent deployment cap keeps the signed cap unchanged", () => {
    expect(clampEgressPolicy({ mode: "none", maxBytesPerJob: 42 }, { mode: "none" })).toEqual({
      policy: { mode: "none", maxBytesPerJob: 42 },
      clamped: [],
    });
  });

  it("treats 0 as `no ceiling` on either side rather than as `deny everything`", () => {
    expect(clampEgressPolicy({ mode: "none", maxBytesPerJob: 0 }, { mode: "none", maxBytesPerJob: 7 })).toEqual(
      { policy: { mode: "none", maxBytesPerJob: 7 }, clamped: ["max_bytes"] },
    );
    expect(clampEgressPolicy({ mode: "none", maxBytesPerJob: 7 }, { mode: "none", maxBytesPerJob: 0 })).toEqual(
      { policy: { mode: "none", maxBytesPerJob: 7 }, clamped: [] },
    );
  });
});

describe("degenerate inputs cannot widen the ceiling (Codex round 1)", () => {
  it("a FRACTIONAL deployment cap clamps to 1, never floors to 0 (0 = uncapped downstream)", () => {
    // `registerJobEgress` / `gatewayEnvironment` both send `maxBytesPerJob ?? 0`
    // and the gateway reads 0 as "no cap", so flooring the tightest possible
    // ceiling to 0 would turn it into NO ceiling.
    const { policy, clamped } = clampEgressPolicy(
      { mode: "default_internet", maxBytesPerJob: 10_000 },
      { mode: "default_internet", maxBytesPerJob: 0.5 },
    );
    expect(policy.maxBytesPerJob).toBe(1);
    expect(clamped).toContain("max_bytes");
  });

  it("a fractional SIGNED cap is also normalized upward to a real ceiling", () => {
    expect(
      clampEgressPolicy({ mode: "none", maxBytesPerJob: 0.25 }, { mode: "none" }).policy
        .maxBytesPerJob,
    ).toBe(1);
  });

  it("a non-finite cap on either side is `no ceiling on that side`, never NaN", () => {
    expect(
      clampEgressPolicy(
        { mode: "none", maxBytesPerJob: Number.NaN },
        { mode: "none", maxBytesPerJob: 100 },
      ).policy.maxBytesPerJob,
    ).toBe(100);
    expect(
      clampEgressPolicy(
        { mode: "none", maxBytesPerJob: 100 },
        { mode: "none", maxBytesPerJob: Number.POSITIVE_INFINITY },
      ).policy.maxBytesPerJob,
    ).toBe(100);
  });

  it("a malformed deployment allowlist entry is DROPPED, not thrown on", () => {
    // The maximum comes from the broker's environment, not a validated payload.
    const maximum = {
      mode: "allowlist" as const,
      allowlist: [null, 42, "pypi.org", ""] as unknown as string[],
    };
    const { policy } = clampEgressPolicy({ mode: "allowlist", allowlist: ["pypi.org"] }, maximum);
    expect(policy.allowlist).toEqual(["pypi.org"]);
  });
});

describe("all three axes at once", () => {
  it("clamps mode, allowlist and byte cap in a single pass", () => {
    const { policy, clamped } = clampEgressPolicy(
      { mode: "default_internet", maxBytesPerJob: 10_000_000 },
      { mode: "default_internet", allowlist: ["files.pypi.org"], maxBytesPerJob: 1_000 },
    );
    expect(policy).toEqual({
      mode: "allowlist",
      allowlist: ["files.pypi.org"],
      maxBytesPerJob: 1_000,
    });
    expect([...clamped].sort()).toEqual(["allowlist", "max_bytes", "mode"]);
  });

  it("clamping to `none` drops the host list entirely — no residual widening", () => {
    const { policy, clamped } = clampEgressPolicy(
      { mode: "allowlist", allowlist: ["pypi.org"] },
      { mode: "none" },
    );
    expect(policy).toEqual({ mode: "none" });
    expect(policy.allowlist).toBeUndefined();
    expect(clamped).toContain("mode");
  });
});
