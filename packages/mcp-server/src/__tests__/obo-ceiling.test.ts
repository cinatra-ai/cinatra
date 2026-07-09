import { describe, it, expect } from "vitest";
import {
  deriveOboCeilingChain,
  oboCeilingContains,
  resourceWithinCeiling,
  isOboCeiling,
  isOboCeilingChain,
  parseOboCeilingChain,
  type OboCeilingChain,
} from "../obo-ceiling";

const ORG = "org-1";

describe("deriveOboCeilingChain", () => {
  it("user anchor → owner element + mandatory org floor", () => {
    expect(
      deriveOboCeilingChain({ ownerLevel: "user", ownerId: "u1", orgId: ORG, projectId: null }),
    ).toEqual([
      { tier: "user", id: "u1" },
      { tier: "organization", id: ORG },
    ]);
  });

  it("team anchor → team element + org floor", () => {
    expect(
      deriveOboCeilingChain({ ownerLevel: "team", ownerId: "t1", orgId: ORG, projectId: null }),
    ).toEqual([
      { tier: "team", id: "t1" },
      { tier: "organization", id: ORG },
    ]);
  });

  it("workspace anchor → workspace element + org floor", () => {
    expect(
      deriveOboCeilingChain({ ownerLevel: "workspace", ownerId: "w1", orgId: ORG, projectId: null }),
    ).toEqual([
      { tier: "workspace", id: "w1" },
      { tier: "organization", id: ORG },
    ]);
  });

  it("organization anchor with own id → single org element (dedup, no double floor)", () => {
    expect(
      deriveOboCeilingChain({ ownerLevel: "organization", ownerId: "org-x", orgId: ORG, projectId: null }),
    ).toEqual([{ tier: "organization", id: "org-x" }]);
  });

  it("organization anchor with EMPTY id → org floor from run org", () => {
    expect(
      deriveOboCeilingChain({ ownerLevel: "organization", ownerId: "", orgId: ORG, projectId: null }),
    ).toEqual([{ tier: "organization", id: ORG }]);
  });

  it("null anchor (pre-backfill) → org floor only — NOT fail-closed", () => {
    expect(
      deriveOboCeilingChain({ ownerLevel: null, ownerId: null, orgId: ORG, projectId: null }),
    ).toEqual([{ tier: "organization", id: ORG }]);
  });

  it("unrecognized tier → org floor only", () => {
    expect(
      deriveOboCeilingChain({ ownerLevel: "galaxy", ownerId: "g1", orgId: ORG, projectId: null }),
    ).toEqual([{ tier: "organization", id: ORG }]);
  });

  it("locked owner_level='project' install → project element + org floor", () => {
    expect(
      deriveOboCeilingChain({ ownerLevel: "project", ownerId: "p1", orgId: ORG, projectId: null }),
    ).toEqual([
      { tier: "project", id: "p1" },
      { tier: "organization", id: ORG },
    ]);
  });

  it("CORRUPT partial anchor (non-org tier, missing id) → null (fail closed, never widened)", () => {
    expect(
      deriveOboCeilingChain({ ownerLevel: "user", ownerId: null, orgId: ORG, projectId: null }),
    ).toBeNull();
    expect(
      deriveOboCeilingChain({ ownerLevel: "team", ownerId: "", orgId: ORG, projectId: null }),
    ).toBeNull();
    expect(
      deriveOboCeilingChain({ ownerLevel: "project", ownerId: null, orgId: ORG, projectId: null }),
    ).toBeNull();
  });

  it("explicit project launch → independent project element appended", () => {
    expect(
      deriveOboCeilingChain({ ownerLevel: "team", ownerId: "t1", orgId: ORG, projectId: "pl" }),
    ).toEqual([
      { tier: "team", id: "t1" },
      { tier: "organization", id: ORG },
      { tier: "project", id: "pl" },
    ]);
  });

  it("project launch equal to a project-install anchor → deduped (single project element)", () => {
    expect(
      deriveOboCeilingChain({ ownerLevel: "project", ownerId: "p1", orgId: ORG, projectId: "p1" }),
    ).toEqual([
      { tier: "project", id: "p1" },
      { tier: "organization", id: ORG },
    ]);
  });
});

describe("oboCeilingContains", () => {
  const recomputed: OboCeilingChain = [
    { tier: "team", id: "t1" },
    { tier: "organization", id: ORG },
  ];

  it("equal chain contains", () => {
    expect(oboCeilingContains(recomputed, recomputed)).toBe(true);
  });

  it("superset persisted contains (composed-child parent elements)", () => {
    const persisted: OboCeilingChain = [
      { tier: "team", id: "t1" },
      { tier: "organization", id: ORG },
      { tier: "project", id: "parent-project" },
    ];
    expect(oboCeilingContains(persisted, recomputed)).toBe(true);
  });

  it("persisted missing a recomputed element → not contained", () => {
    const persisted: OboCeilingChain = [{ tier: "organization", id: ORG }];
    expect(oboCeilingContains(persisted, recomputed)).toBe(false);
  });

  it("null / empty persisted → not contained (fail closed)", () => {
    expect(oboCeilingContains(null, recomputed)).toBe(false);
    expect(oboCeilingContains([], recomputed)).toBe(false);
    expect(oboCeilingContains(undefined, recomputed)).toBe(false);
  });
});

describe("resourceWithinCeiling — satisfy-all", () => {
  it("null / empty chain → false (never vacuously allow)", () => {
    expect(resourceWithinCeiling({ orgId: ORG }, null)).toBe(false);
    expect(resourceWithinCeiling({ orgId: ORG }, [])).toBe(false);
    expect(resourceWithinCeiling({ orgId: ORG }, undefined)).toBe(false);
  });

  it("user ceiling: only a user-owned-by-U resource is within", () => {
    const chain: OboCeilingChain = [
      { tier: "user", id: "u1" },
      { tier: "organization", id: ORG },
    ];
    expect(
      resourceWithinCeiling({ orgId: ORG, owner: { tier: "user", id: "u1" } }, chain),
    ).toBe(true);
    // team-owned resource is NOT within a user ceiling
    expect(
      resourceWithinCeiling({ orgId: ORG, owner: { tier: "team", id: "t1" } }, chain),
    ).toBe(false);
    // org-owned resource is NOT within a user ceiling
    expect(
      resourceWithinCeiling({ orgId: ORG, owner: { tier: "organization", id: ORG } }, chain),
    ).toBe(false);
  });

  it("organization ceiling: cross-org resource fails", () => {
    const chain: OboCeilingChain = [{ tier: "organization", id: ORG }];
    expect(resourceWithinCeiling({ orgId: ORG }, chain)).toBe(true);
    expect(resourceWithinCeiling({ orgId: "org-2" }, chain)).toBe(false);
    expect(resourceWithinCeiling({ orgId: null }, chain)).toBe(false);
  });

  it("project ceiling: matching projectId within; null/other not", () => {
    const chain: OboCeilingChain = [
      { tier: "project", id: "p1" },
      { tier: "organization", id: ORG },
    ];
    expect(resourceWithinCeiling({ orgId: ORG, projectId: "p1" }, chain)).toBe(true);
    expect(resourceWithinCeiling({ orgId: ORG, projectId: "p2" }, chain)).toBe(false);
    expect(resourceWithinCeiling({ orgId: ORG, projectId: null }, chain)).toBe(false);
  });

  it("INCOMPARABLE axis (team vs project) → satisfy-ALL", () => {
    const chain: OboCeilingChain = [
      { tier: "team", id: "t1" },
      { tier: "organization", id: ORG },
      { tier: "project", id: "p1" },
    ];
    // team-owned-t1 AND in project p1 → within
    expect(
      resourceWithinCeiling(
        { orgId: ORG, owner: { tier: "team", id: "t1" }, projectId: "p1" },
        chain,
      ),
    ).toBe(true);
    // right team, WRONG project → not within
    expect(
      resourceWithinCeiling(
        { orgId: ORG, owner: { tier: "team", id: "t1" }, projectId: "pX" },
        chain,
      ),
    ).toBe(false);
    // right project, WRONG owner (user, not team) → not within
    expect(
      resourceWithinCeiling(
        { orgId: ORG, owner: { tier: "user", id: "u1" }, projectId: "p1" },
        chain,
      ),
    ).toBe(false);
  });

  it("same-axis DISJOINT project ceilings → empty ceiling (nothing within)", () => {
    const chain: OboCeilingChain = [
      { tier: "project", id: "p1" },
      { tier: "project", id: "p2" },
      { tier: "organization", id: ORG },
    ];
    expect(resourceWithinCeiling({ orgId: ORG, projectId: "p1" }, chain)).toBe(false);
    expect(resourceWithinCeiling({ orgId: ORG, projectId: "p2" }, chain)).toBe(false);
  });

  it("owner_level='project' derived chain: resource in project P + org O is within", () => {
    const chain = deriveOboCeilingChain({
      ownerLevel: "project",
      ownerId: "p1",
      orgId: ORG,
      projectId: null,
    })!;
    expect(resourceWithinCeiling({ orgId: ORG, projectId: "p1" }, chain)).toBe(true);
    expect(resourceWithinCeiling({ orgId: ORG, projectId: null }, chain)).toBe(false);
    // cross-org even with the right project fails on the org floor
    expect(resourceWithinCeiling({ orgId: "org-2", projectId: "p1" }, chain)).toBe(false);
  });
});

describe("isOboCeiling / isOboCeilingChain / parseOboCeilingChain", () => {
  it("isOboCeiling validates tier + non-empty id", () => {
    expect(isOboCeiling({ tier: "user", id: "u1" })).toBe(true);
    expect(isOboCeiling({ tier: "project", id: "p1" })).toBe(true);
    expect(isOboCeiling({ tier: "galaxy", id: "x" })).toBe(false);
    expect(isOboCeiling({ tier: "user", id: "" })).toBe(false);
    expect(isOboCeiling({ tier: "user" })).toBe(false);
    expect(isOboCeiling(null)).toBe(false);
  });

  it("isOboCeilingChain rejects empty + malformed arrays", () => {
    expect(isOboCeilingChain([{ tier: "user", id: "u1" }])).toBe(true);
    expect(isOboCeilingChain([])).toBe(false);
    expect(isOboCeilingChain([{ tier: "user", id: "u1" }, { bad: 1 }])).toBe(false);
    expect(isOboCeilingChain("nope")).toBe(false);
  });

  it("parseOboCeilingChain: JSON round-trip + defensive null on malformed", () => {
    const chain: OboCeilingChain = [
      { tier: "user", id: "u1" },
      { tier: "organization", id: ORG },
    ];
    expect(parseOboCeilingChain(JSON.stringify(chain))).toEqual(chain);
    expect(parseOboCeilingChain("[]")).toBeNull();
    expect(parseOboCeilingChain("not-json")).toBeNull();
    expect(parseOboCeilingChain(null)).toBeNull();
    expect(parseOboCeilingChain(undefined)).toBeNull();
    expect(parseOboCeilingChain('[{"tier":"bad","id":"x"}]')).toBeNull();
  });
});
