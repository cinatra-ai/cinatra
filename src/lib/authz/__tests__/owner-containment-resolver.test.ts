import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Live owner-axis containment resolver (#1885 C1). Membership reads are mocked;
// this pins the LATTICE semantics (user ⊆ team, user ⊆ workspace, team ⊆
// workspace) and the conservative "prove or omit" posture.

const readTeamsForUser = vi.fn();
const readUserIsOrgMember = vi.fn();
const readTeamsByIdsForOrg = vi.fn();

vi.mock("@/lib/better-auth-db", () => ({
  readTeamsForUser: (...a: unknown[]) => readTeamsForUser(...a),
  readUserIsOrgMember: (...a: unknown[]) => readUserIsOrgMember(...a),
  readTeamsByIdsForOrg: (...a: unknown[]) => readTeamsByIdsForOrg(...a),
}));

const ORG = "org-1";

async function resolver(elements: Array<{ tier: string; id: string }>) {
  const { resolveOwnerContainments } = await import(
    "@/lib/authz/owner-containment-resolver"
  );
  return resolveOwnerContainments({
    orgId: ORG,
    ownerElements: elements as never,
  });
}

beforeEach(() => {
  readTeamsForUser.mockReset().mockResolvedValue([]);
  readUserIsOrgMember.mockReset().mockResolvedValue(false);
  readTeamsByIdsForOrg.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.resetModules();
});

describe("resolveOwnerContainments", () => {
  it("user ⊆ team: emits the fact when the user is a live team member", async () => {
    readTeamsForUser.mockResolvedValue([{ id: "t1", name: "T1" }]);
    const facts = await resolver([
      { tier: "user", id: "u1" },
      { tier: "team", id: "t1" },
    ]);
    expect(facts).toEqual([
      { narrower: { tier: "user", id: "u1" }, wider: { tier: "team", id: "t1" } },
    ]);
    expect(readTeamsForUser).toHaveBeenCalledWith("u1", ORG);
  });

  it("user NOT a member of the team → no fact (fail closed: prove or omit)", async () => {
    readTeamsForUser.mockResolvedValue([{ id: "t-other", name: "X" }]);
    const facts = await resolver([
      { tier: "user", id: "u1" },
      { tier: "team", id: "t1" },
    ]);
    expect(facts).toEqual([]);
  });

  it("user ⊆ workspace: a live org member is contained in org-local-public", async () => {
    readUserIsOrgMember.mockResolvedValue(true);
    const facts = await resolver([
      { tier: "user", id: "u1" },
      { tier: "workspace", id: "w1" },
    ]);
    expect(facts).toEqual([
      { narrower: { tier: "user", id: "u1" }, wider: { tier: "workspace", id: "w1" } },
    ]);
  });

  it("user NOT an org member → no workspace containment fact", async () => {
    readUserIsOrgMember.mockResolvedValue(false);
    const facts = await resolver([
      { tier: "user", id: "u1" },
      { tier: "workspace", id: "w1" },
    ]);
    expect(facts).toEqual([]);
  });

  it("team ⊆ workspace: the in-org team is contained in org-public", async () => {
    readTeamsByIdsForOrg.mockResolvedValue([{ id: "t1", name: "T1" }]);
    const facts = await resolver([
      { tier: "team", id: "t1" },
      { tier: "workspace", id: "w1" },
    ]);
    expect(facts).toEqual([
      { narrower: { tier: "team", id: "t1" }, wider: { tier: "workspace", id: "w1" } },
    ]);
  });

  it("transitive chain user ∈ team ∈ workspace: emits the direct edges (closure done by composer)", async () => {
    readTeamsForUser.mockResolvedValue([{ id: "t1", name: "T1" }]);
    readUserIsOrgMember.mockResolvedValue(true);
    readTeamsByIdsForOrg.mockResolvedValue([{ id: "t1", name: "T1" }]);
    const facts = await resolver([
      { tier: "user", id: "u1" },
      { tier: "team", id: "t1" },
      { tier: "workspace", id: "w1" },
    ]);
    expect(facts).toEqual(
      expect.arrayContaining([
        { narrower: { tier: "user", id: "u1" }, wider: { tier: "team", id: "t1" } },
        { narrower: { tier: "user", id: "u1" }, wider: { tier: "workspace", id: "w1" } },
        { narrower: { tier: "team", id: "t1" }, wider: { tier: "workspace", id: "w1" } },
      ]),
    );
    expect(facts).toHaveLength(3);
  });
});
