import { describe, expect, it } from "vitest";

import {
  claimPrecedenceRank,
  isDefaultClaimDominated,
  isValidClaimScope,
  isWinnerEligible,
  orgClaimScope,
  parseClaimDispositions,
  resolveClaimWinner,
  type ArbitrableClaim,
} from "../claims";

function claim(partial: Partial<ArbitrableClaim> & Pick<ArbitrableClaim, "id" | "scope" | "claimKind">): ArbitrableClaim {
  return {
    objectTypeId: "@vendor/pkg:thing",
    status: "active",
    extensionPackage: "@vendor/pkg-artifact",
    extensionVersion: "1.0.0",
    generation: 1,
    ...partial,
  };
}

describe("claim scopes", () => {
  it("accepts platform and org:<id>, rejects everything else", () => {
    expect(isValidClaimScope("platform")).toBe(true);
    expect(isValidClaimScope(orgClaimScope("org-1"))).toBe(true);
    expect(isValidClaimScope("org:")).toBe(false); // empty org id
    expect(isValidClaimScope("workspace")).toBe(false);
    expect(isValidClaimScope("user:u1")).toBe(false);
  });
});

describe("kind-over-scope precedence", () => {
  it("ranks dedicated-org > dedicated-platform > default-org > default-platform", () => {
    const orgId = "org-1";
    expect(claimPrecedenceRank({ claimKind: "dedicated", scope: "org:org-1" }, orgId)).toBe(0);
    expect(claimPrecedenceRank({ claimKind: "dedicated", scope: "platform" }, orgId)).toBe(1);
    expect(claimPrecedenceRank({ claimKind: "default", scope: "org:org-1" }, orgId)).toBe(2);
    expect(claimPrecedenceRank({ claimKind: "default", scope: "platform" }, orgId)).toBe(3);
  });

  it("never ranks another org's claim", () => {
    expect(claimPrecedenceRank({ claimKind: "dedicated", scope: "org:other" }, "org-1")).toBeNull();
  });
});

describe("resolveClaimWinner", () => {
  it("org claim overrides platform claim (AC-2)", () => {
    const winner = resolveClaimWinner(
      [
        claim({ id: "p", scope: "platform", claimKind: "dedicated" }),
        claim({ id: "o", scope: "org:org-1", claimKind: "dedicated" }),
      ],
      { orgId: "org-1", objectTypeId: "@vendor/pkg:thing" },
    );
    expect(winner?.id).toBe("o");
  });

  it("kind dominates scope: a platform DEDICATED claim beats an org DEFAULT claim", () => {
    const winner = resolveClaimWinner(
      [
        claim({ id: "d", scope: "platform", claimKind: "dedicated" }),
        claim({ id: "f", scope: "org:org-1", claimKind: "default" }),
      ],
      { orgId: "org-1", objectTypeId: "@vendor/pkg:thing" },
    );
    expect(winner?.id).toBe("d");
  });

  it("ignores dormant / reserved / retired claims and other orgs' claims", () => {
    const winner = resolveClaimWinner(
      [
        claim({ id: "dormant", scope: "org:org-1", claimKind: "default", status: "dormant" }),
        claim({ id: "reserved", scope: "org:org-1", claimKind: "dedicated", status: "reserved" }),
        claim({ id: "retired", scope: "org:org-1", claimKind: "dedicated", status: "retired" }),
        claim({ id: "foreign", scope: "org:other", claimKind: "dedicated" }),
        claim({ id: "live", scope: "platform", claimKind: "default" }),
      ],
      { orgId: "org-1", objectTypeId: "@vendor/pkg:thing" },
    );
    expect(winner?.id).toBe("live");
  });

  it("a RETIRING claim remains the winner until retired (transition safety)", () => {
    expect(isWinnerEligible("retiring")).toBe(true);
    const winner = resolveClaimWinner(
      [claim({ id: "r", scope: "platform", claimKind: "dedicated", status: "retiring" })],
      { orgId: "org-1", objectTypeId: "@vendor/pkg:thing" },
    );
    expect(winner?.id).toBe("r");
  });

  it("returns null when nothing claims the type", () => {
    expect(
      resolveClaimWinner([], { orgId: "org-1", objectTypeId: "@vendor/pkg:thing" }),
    ).toBeNull();
  });
});

describe("isDefaultClaimDominated (the dormancy rule)", () => {
  const type = "@vendor/pkg:thing";

  it("an org default is dominated by a dedicated claim at its org OR at platform", () => {
    const orgDefault = { scope: "org:org-1", objectTypeId: type, claimKind: "default" as const };
    expect(
      isDefaultClaimDominated(orgDefault, [claim({ id: "d", scope: "org:org-1", claimKind: "dedicated" })]),
    ).toBe(true);
    expect(
      isDefaultClaimDominated(orgDefault, [claim({ id: "d", scope: "platform", claimKind: "dedicated" })]),
    ).toBe(true);
    // A dedicated claim in ANOTHER org never dominates this org's default.
    expect(
      isDefaultClaimDominated(orgDefault, [claim({ id: "d", scope: "org:other", claimKind: "dedicated" })]),
    ).toBe(false);
  });

  it("a platform default is dominated ONLY by a platform dedicated claim (an org dedicated claim shadows it for that org alone)", () => {
    const platformDefault = { scope: "platform", objectTypeId: type, claimKind: "default" as const };
    expect(
      isDefaultClaimDominated(platformDefault, [claim({ id: "d", scope: "platform", claimKind: "dedicated" })]),
    ).toBe(true);
    expect(
      isDefaultClaimDominated(platformDefault, [claim({ id: "d", scope: "org:org-1", claimKind: "dedicated" })]),
    ).toBe(false);
  });

  it("a retired dedicated claim dominates nothing; another DEFAULT claim dominates nothing", () => {
    const orgDefault = { scope: "org:org-1", objectTypeId: type, claimKind: "default" as const };
    expect(
      isDefaultClaimDominated(orgDefault, [
        claim({ id: "d", scope: "platform", claimKind: "dedicated", status: "retired" }),
      ]),
    ).toBe(false);
    expect(
      isDefaultClaimDominated(orgDefault, [claim({ id: "d", scope: "platform", claimKind: "default" })]),
    ).toBe(false);
  });
});

describe("claim dispositions union", () => {
  it("parses a full artifact-safe payload", () => {
    const parsed = parseClaimDispositions({
      projection: "artifact-safe",
      snapshotPolicy: "content",
      redactionPolicyVersion: "v1",
      pinnable: true,
      sensitivity: "sensitive",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.dispositions.projection).toBe("artifact-safe");
      expect(parsed.dispositions.pinnable).toBe(true);
    }
  });

  it("applies defaults (snapshotPolicy none, sensitivity normal, pinnable false)", () => {
    const parsed = parseClaimDispositions({ projection: "raw" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.dispositions).toMatchObject({
        projection: "raw",
        snapshotPolicy: "none",
        sensitivity: "normal",
        pinnable: false,
      });
    }
  });

  it("rejects pinnable on a never-projected claim (projection none)", () => {
    const parsed = parseClaimDispositions({ projection: "none", pinnable: true });
    expect(parsed.ok).toBe(false);
  });

  it("rejects unknown keys and unknown projections (fail-closed strict union)", () => {
    expect(parseClaimDispositions({ projection: "raw", surprise: 1 }).ok).toBe(false);
    expect(parseClaimDispositions({ projection: "full" }).ok).toBe(false);
    expect(parseClaimDispositions("raw").ok).toBe(false);
  });
});
