import { describe, it, expect } from "vitest";
import {
  deriveOboCeilingChain,
  oboCeilingContains,
  resourceWithinCeiling,
  composeOboCeilingChain,
  OboCeilingCompositionError,
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

// ---------------------------------------------------------------------------
// Child-run composition (epic W5): child effective chain = child anchor ∪
// parent chain (satisfy-all), incomparable axes carried, same-axis/cross-org
// disjoint pre-denies.
// ---------------------------------------------------------------------------
describe("composeOboCeilingChain — child = child anchor ∪ parent chain", () => {
  const orgFloor = { tier: "organization", id: ORG } as const;

  // Helper: assert an ok chain contains exactly the expected member set (order-
  // insensitive) with no duplicates.
  function expectChainMembers(
    result: ReturnType<typeof composeOboCeilingChain>,
    expected: OboCeilingChain,
  ) {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.chain).toEqual(expect.arrayContaining(expected));
    expect(result.chain).toHaveLength(expected.length);
  }

  it("SAME-tier equal ids dedup to a single element (identical chains)", () => {
    const chain: OboCeilingChain = [{ tier: "team", id: "t1" }, orgFloor];
    expectChainMembers(composeOboCeilingChain(chain, chain), [
      { tier: "team", id: "t1" },
      orgFloor,
    ]);
  });

  it("org-only parent + user child → user anchor kept + shared org floor", () => {
    const parent: OboCeilingChain = [orgFloor];
    const child: OboCeilingChain = [{ tier: "user", id: "u1" }, orgFloor];
    expectChainMembers(composeOboCeilingChain(parent, child), [
      { tier: "user", id: "u1" },
      orgFloor,
    ]);
  });

  it("MIXED owner tiers with NO verified containment (parent team T, child user U) → fail closed", () => {
    // user/team are tiers of the ONE owner slot; no single-owner row satisfies
    // both. Absent a verified containment relation the composition fails CLOSED
    // (a structured error, never a silently-unsatisfiable persisted chain).
    const parent: OboCeilingChain = [{ tier: "team", id: "t1" }, orgFloor];
    const child: OboCeilingChain = [{ tier: "user", id: "u1" }, orgFloor];
    const result = composeOboCeilingChain(parent, child);
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "unverified_owner_containment") {
      throw new Error("expected unverified_owner_containment denial");
    }
    expect(result.ceilings).toEqual(
      expect.arrayContaining([
        { tier: "user", id: "u1" },
        { tier: "team", id: "t1" },
      ]),
    );
  });

  it("MIXED owner tiers WITH a verified containment fact (user U ∈ team T) → collapse to the narrowest (user U), satisfiable", () => {
    // The acceptance case: a team-anchored parent dispatching a user-scoped child.
    // Given the dispatch-verified membership fact, the owner axis collapses to the
    // narrower user tier; a user-U-owned row then satisfies the composed chain.
    const parent: OboCeilingChain = [{ tier: "team", id: "t1" }, orgFloor];
    const child: OboCeilingChain = [{ tier: "user", id: "u1" }, orgFloor];
    const result = composeOboCeilingChain(parent, child, [
      { narrower: { tier: "user", id: "u1" }, wider: { tier: "team", id: "t1" } },
    ]);
    expectChainMembers(result, [{ tier: "user", id: "u1" }, orgFloor]);
    if (!result.ok) return;
    // A user-U row in the org is WITHIN the collapsed chain (previously denied).
    expect(
      resourceWithinCeiling(
        { orgId: ORG, owner: { tier: "user", id: "u1" } },
        result.chain,
      ),
    ).toBe(true);
    // A team-T row is NOT within (the collapse narrowed to the user tier).
    expect(
      resourceWithinCeiling(
        { orgId: ORG, owner: { tier: "team", id: "t1" } },
        result.chain,
      ),
    ).toBe(false);
  });

  it("MIXED owner tiers, collapse keeps the PARENT's narrower tier (parent user U ∈ child team T) → user U", () => {
    // Reverse anchoring: a user-anchored parent, a team-anchored child. The
    // verified-narrowest is still the user; collapse drops the wider team element.
    const parent: OboCeilingChain = [{ tier: "user", id: "u1" }, orgFloor];
    const child: OboCeilingChain = [{ tier: "team", id: "t1" }, orgFloor];
    const result = composeOboCeilingChain(parent, child, [
      { narrower: { tier: "user", id: "u1" }, wider: { tier: "team", id: "t1" } },
    ]);
    expectChainMembers(result, [{ tier: "user", id: "u1" }, orgFloor]);
  });

  it("MIXED workspace+team with a verified fact (team T ∈ workspace W) → collapse to team T", () => {
    const parent: OboCeilingChain = [{ tier: "workspace", id: "w1" }, orgFloor];
    const child: OboCeilingChain = [{ tier: "team", id: "t1" }, orgFloor];
    const result = composeOboCeilingChain(parent, child, [
      { narrower: { tier: "team", id: "t1" }, wider: { tier: "workspace", id: "w1" } },
    ]);
    expectChainMembers(result, [{ tier: "team", id: "t1" }, orgFloor]);
  });

  it("MIXED owner tiers keep the org floor + project when collapsing (parent project P, mixed owners)", () => {
    // The collapse touches ONLY the owner axis; org floor + project pass through.
    const parent: OboCeilingChain = [
      { tier: "team", id: "t1" },
      { tier: "project", id: "p1" },
      orgFloor,
    ];
    const child: OboCeilingChain = [{ tier: "user", id: "u1" }, orgFloor];
    const result = composeOboCeilingChain(parent, child, [
      { narrower: { tier: "user", id: "u1" }, wider: { tier: "team", id: "t1" } },
    ]);
    expectChainMembers(result, [
      { tier: "user", id: "u1" },
      { tier: "project", id: "p1" },
      orgFloor,
    ]);
  });

  it("INCOMPARABLE cross-axis pair (parent project P, child team T) → BOTH carried", () => {
    const parent: OboCeilingChain = [{ tier: "project", id: "p1" }, orgFloor];
    const child: OboCeilingChain = [{ tier: "team", id: "t1" }, orgFloor];
    expectChainMembers(composeOboCeilingChain(parent, child), [
      { tier: "team", id: "t1" },
      { tier: "project", id: "p1" },
      orgFloor,
    ]);
  });

  it("SAME-axis disjoint teams (parent T1, child T2) → pre-deny disjoint_axis", () => {
    const parent: OboCeilingChain = [{ tier: "team", id: "t1" }, orgFloor];
    const child: OboCeilingChain = [{ tier: "team", id: "t2" }, orgFloor];
    const result = composeOboCeilingChain(parent, child);
    expect(result.ok).toBe(false);
    if (result.ok || result.reason === "unverified_owner_containment") {
      throw new Error("expected disjoint_axis denial");
    }
    expect(result.reason).toBe("disjoint_axis");
    expect(result.tier).toBe("team");
    expect(result.ids).toEqual(["t2", "t1"]);
  });

  it("SAME-axis disjoint projects (parent P1, child P2) → pre-deny disjoint_axis", () => {
    const parent: OboCeilingChain = [{ tier: "project", id: "p1" }, orgFloor];
    const child: OboCeilingChain = [{ tier: "project", id: "p2" }, orgFloor];
    const result = composeOboCeilingChain(parent, child);
    expect(result.ok).toBe(false);
    if (result.ok || result.reason === "unverified_owner_containment") {
      throw new Error("expected disjoint_axis denial");
    }
    expect(result.reason).toBe("disjoint_axis");
    expect(result.tier).toBe("project");
  });

  it("CROSS-ORG (parent org O1, child org O2) → pre-deny cross_org on the org floor", () => {
    const parent: OboCeilingChain = [{ tier: "organization", id: "org-A" }];
    const child: OboCeilingChain = [{ tier: "user", id: "u1" }, { tier: "organization", id: "org-B" }];
    const result = composeOboCeilingChain(parent, child);
    expect(result.ok).toBe(false);
    if (result.ok || result.reason === "unverified_owner_containment") {
      throw new Error("expected cross_org denial");
    }
    expect(result.reason).toBe("cross_org");
    expect(result.tier).toBe("organization");
  });

  it("SAME-axis disjoint user anchors (parent U1, child U2) → pre-deny", () => {
    const parent: OboCeilingChain = [{ tier: "user", id: "u1" }, orgFloor];
    const child: OboCeilingChain = [{ tier: "user", id: "u2" }, orgFloor];
    expect(composeOboCeilingChain(parent, child).ok).toBe(false);
  });

  it("SAME-axis disjoint workspace anchors → pre-deny", () => {
    const parent: OboCeilingChain = [{ tier: "workspace", id: "w1" }, orgFloor];
    const child: OboCeilingChain = [{ tier: "workspace", id: "w2" }, orgFloor];
    expect(composeOboCeilingChain(parent, child).ok).toBe(false);
  });

  it("TRANSITIVE grandchild: cross-axis ancestors carried, owner axis collapsed to the verified-narrowest", () => {
    // gp anchors a project (independent axis), parent a team, child a user. With
    // the verified user ∈ team fact the owner axis collapses to the user tier; the
    // project + org floor (different facets) are carried un-collapsed.
    const grandparent: OboCeilingChain = [{ tier: "project", id: "pj" }, orgFloor];
    const parent: OboCeilingChain = [{ tier: "team", id: "t1" }, orgFloor];
    const child: OboCeilingChain = [{ tier: "user", id: "u1" }, orgFloor];
    const membership = [
      { narrower: { tier: "user" as const, id: "u1" }, wider: { tier: "team" as const, id: "t1" } },
    ];

    // gp ∪ parent: only ONE owner tier (team) → no collapse yet.
    const gpParent = composeOboCeilingChain(grandparent, parent, membership);
    expect(gpParent.ok).toBe(true);
    if (!gpParent.ok) return;

    const grand = composeOboCeilingChain(gpParent.chain, child, membership);
    expect(grand.ok).toBe(true);
    if (!grand.ok) return;

    // Owner axis collapsed to user u1; team t1 dropped (subsumed under the fact).
    expect(grand.chain).toEqual(
      expect.arrayContaining([
        { tier: "user", id: "u1" },
        { tier: "project", id: "pj" },
        orgFloor,
      ]),
    );
    expect(grand.chain).toHaveLength(3);
    expect(grand.chain.some((c) => c.tier === "team")).toBe(false);
  });

  it("TRANSITIVE containment (user ∈ team ∈ workspace) collapses all three owner tiers to the user", () => {
    // Only user⊆team and team⊆workspace are supplied; the closure yields user⊆workspace.
    const parent: OboCeilingChain = [{ tier: "workspace", id: "w1" }, orgFloor];
    const mid = composeOboCeilingChain(
      parent,
      [{ tier: "team", id: "t1" }, orgFloor],
      [{ narrower: { tier: "team", id: "t1" }, wider: { tier: "workspace", id: "w1" } }],
    );
    expect(mid.ok).toBe(true);
    if (!mid.ok) return;
    const result = composeOboCeilingChain(
      mid.chain,
      [{ tier: "user", id: "u1" }, orgFloor],
      [
        { narrower: { tier: "user", id: "u1" }, wider: { tier: "team", id: "t1" } },
        { narrower: { tier: "team", id: "t1" }, wider: { tier: "workspace", id: "w1" } },
      ],
    );
    expectChainMembers(result, [{ tier: "user", id: "u1" }, orgFloor]);
  });

  it("MIXED owner tiers, INCOMPLETE facts (no single global-narrowest) → fail closed", () => {
    // Two owner elements, only an unrelated fact supplied → neither ⊆ the other.
    const parent: OboCeilingChain = [{ tier: "team", id: "t1" }, orgFloor];
    const child: OboCeilingChain = [{ tier: "user", id: "u1" }, orgFloor];
    const result = composeOboCeilingChain(parent, child, [
      // A fact about a DIFFERENT team — irrelevant to (user u1, team t1).
      { narrower: { tier: "user", id: "u1" }, wider: { tier: "team", id: "t-other" } },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unverified_owner_containment");
  });

  it("composed child chain PASSES mint containment; a tampered chain (missing a child element) FAILS closed", () => {
    // Child anchor freshly derived at mint = team T1 + org floor.
    const childAnchor = deriveOboCeilingChain({
      ownerLevel: "team",
      ownerId: "t1",
      orgId: ORG,
      projectId: null,
    })!;
    const parent: OboCeilingChain = [{ tier: "project", id: "parent-pj" }, orgFloor];
    const composed = composeOboCeilingChain(parent, childAnchor);
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;

    // The mint path re-derives ONLY the child anchor and checks containment.
    expect(oboCeilingContains(composed.chain, childAnchor)).toBe(true);

    // Tamper: drop the child's own team element → mint no longer contains the
    // re-derived anchor → fail closed.
    const tampered = composed.chain.filter((c) => c.tier !== "team");
    expect(oboCeilingContains(tampered, childAnchor)).toBe(false);
  });

  it("OboCeilingCompositionError carries the structured denial + stable code", () => {
    const parent: OboCeilingChain = [{ tier: "team", id: "t1" }, orgFloor];
    const child: OboCeilingChain = [{ tier: "team", id: "t2" }, orgFloor];
    const result = composeOboCeilingChain(parent, child);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const err = new OboCeilingCompositionError(result);
    expect(err.code).toBe("AGENT_OBO_CEILING_DISJOINT");
    expect(err.denial.reason).toBe("disjoint_axis");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("disjoint");
  });

  it("OboCeilingCompositionError message branches for the unverified-containment denial", () => {
    const parent: OboCeilingChain = [{ tier: "team", id: "t1" }, orgFloor];
    const child: OboCeilingChain = [{ tier: "user", id: "u1" }, orgFloor];
    const result = composeOboCeilingChain(parent, child);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const err = new OboCeilingCompositionError(result);
    expect(err.code).toBe("AGENT_OBO_CEILING_DISJOINT");
    expect(err.denial.reason).toBe("unverified_owner_containment");
    expect(err.message).toContain("no verified containment");
    expect(err.message).toContain("user:u1");
    expect(err.message).toContain("team:t1");
  });
});
