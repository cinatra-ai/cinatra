// Memory-scope projection lane derivation + recall entitlement
// (cinatra#1379 AC1 + AC4). Pure functions — no DB, no Graphiti. The module
// imports @/lib/postgres-sync + @/lib/database at the top (for the epoch
// helpers), so those are stubbed even though the functions under test never
// touch them.

import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: vi.fn(),
}));

vi.mock("@/lib/database", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "cinatra",
}));

import {
  deriveProjectionGroupId,
  deriveMemoryConceptLane,
  deriveEntitledMemoryLanes,
} from "../graphiti-projection-policy";

const ORG = "org-1";
const BASE = "cinatra-org-org-1";

describe("deriveMemoryConceptLane — AC1 derivation table (memory rows only)", () => {
  it("keeps deriveProjectionGroupId unchanged (the shared org lane memory nests under)", () => {
    expect(deriveProjectionGroupId(ORG)).toBe(BASE);
    expect(deriveProjectionGroupId(null)).toBe("cinatra-default");
  });

  it("user-private (ownerLevel=user AND visibility=private) -> <org-lane>-user-<ownerId>", () => {
    const d = deriveMemoryConceptLane(ORG, {
      ownerLevel: "user",
      ownerId: "user-42",
      visibility: "private",
      projectId: null,
    });
    expect(d).toEqual({ kind: "lane", groupId: `${BASE}-user-user-42` });
  });

  it("team (ownerLevel=team) -> <org-lane>-team-<ownerId>", () => {
    const d = deriveMemoryConceptLane(ORG, {
      ownerLevel: "team",
      ownerId: "team-7",
      visibility: "team",
      projectId: null,
    });
    expect(d).toEqual({ kind: "lane", groupId: `${BASE}-team-team-7` });
  });

  it("visibility=team but USER-owned lands the OWNING USER's lane, not a phantom team-<userId> lane", () => {
    // buildOwnershipFilter reads a user-owned row (owner_level='user') only for
    // the owning user — a visibility='team' row that is NOT team-owned is
    // readable by no team. The lane must be one the owner's entitlement names
    // (`-user-<ownerId>`); routing to `-team-<userId>` would make the concept
    // unrecallable (deriveEntitledMemoryLanes builds team lanes from real
    // teamIds only, never a user id).
    const d = deriveMemoryConceptLane(ORG, {
      ownerLevel: "user",
      ownerId: "u-9",
      visibility: "team",
      projectId: null,
    });
    expect(d).toEqual({ kind: "lane", groupId: `${BASE}-user-u-9` });
  });

  it("org (visibility=organization) -> the ambient <org-lane>", () => {
    const d = deriveMemoryConceptLane(ORG, {
      ownerLevel: "organization",
      ownerId: ORG,
      visibility: "organization",
      projectId: null,
    });
    expect(d).toEqual({ kind: "lane", groupId: BASE });
  });

  it("workspace (ownerLevel=workspace) -> the ambient <org-lane>", () => {
    const d = deriveMemoryConceptLane(ORG, {
      ownerLevel: "workspace",
      ownerId: "ws-1",
      visibility: "organization",
      projectId: null,
    });
    expect(d).toEqual({ kind: "lane", groupId: BASE });
  });

  it("visibility=public -> terminal skip (not projected in this iteration)", () => {
    const d = deriveMemoryConceptLane(ORG, {
      ownerLevel: "user",
      ownerId: "u-1",
      visibility: "public",
      projectId: null,
    });
    expect(d.kind).toBe("skip");
  });

  it("public is skipped even when the owner level would otherwise map to a lane", () => {
    // ownerLevel=organization would map to ambient, but public wins (checked first).
    const d = deriveMemoryConceptLane(ORG, {
      ownerLevel: "organization",
      ownerId: ORG,
      visibility: "public",
      projectId: "proj-x",
    });
    expect(d.kind).toBe("skip");
  });

  it("project axis suffixes the derived base lane for EVERY class", () => {
    expect(
      deriveMemoryConceptLane(ORG, { ownerLevel: "user", ownerId: "u-1", visibility: "private", projectId: "p-1" }),
    ).toEqual({ kind: "lane", groupId: `${BASE}-user-u-1-proj-p-1` });
    expect(
      deriveMemoryConceptLane(ORG, { ownerLevel: "team", ownerId: "t-1", visibility: "team", projectId: "p-1" }),
    ).toEqual({ kind: "lane", groupId: `${BASE}-team-t-1-proj-p-1` });
    expect(
      deriveMemoryConceptLane(ORG, { ownerLevel: "organization", ownerId: ORG, visibility: "organization", projectId: "p-1" }),
    ).toEqual({ kind: "lane", groupId: `${BASE}-proj-p-1` });
  });

  it("fail-closed: a user/team scope with no ownerId is skipped (no malformed lane)", () => {
    expect(
      deriveMemoryConceptLane(ORG, { ownerLevel: "user", ownerId: null, visibility: "private", projectId: null }).kind,
    ).toBe("skip");
    expect(
      deriveMemoryConceptLane(ORG, { ownerLevel: "team", ownerId: "", visibility: "team", projectId: null }).kind,
    ).toBe("skip");
  });

  it("fail-closed: an unclassifiable scope combination is skipped, never projected", () => {
    const d = deriveMemoryConceptLane(ORG, {
      ownerLevel: "user",
      ownerId: "u-1",
      visibility: "some-future-enum",
      projectId: null,
    });
    expect(d.kind).toBe("skip");
  });

  it("no client-supplied lane surface: identical scope always derives the SAME lane", () => {
    const scope = { ownerLevel: "user", ownerId: "u-1", visibility: "private", projectId: "p-2" } as const;
    expect(deriveMemoryConceptLane(ORG, scope)).toEqual(deriveMemoryConceptLane(ORG, scope));
  });
});

describe("deriveEntitledMemoryLanes — AC4 recall entitlement", () => {
  it("user+org entitlement: candidates from own user lane AND the org lane, NONE from an unentitled team/project lane", () => {
    const lanes = deriveEntitledMemoryLanes({
      orgId: ORG,
      userId: "user-1",
      teamIds: [],
      projectId: null,
    });
    // Entitled: org (ambient) + own user lane.
    expect(lanes).toContain(BASE);
    expect(lanes).toContain(`${BASE}-user-user-1`);
    // NOT entitled: an arbitrary team lane, any project lane.
    expect(lanes).not.toContain(`${BASE}-team-team-99`);
    expect(lanes.some((l) => l.includes("-proj-"))).toBe(false);
  });

  it("includes a team lane for EVERY team the actor is a member of", () => {
    const lanes = deriveEntitledMemoryLanes({
      orgId: ORG,
      userId: "user-1",
      teamIds: ["team-a", "team-b"],
      projectId: null,
    });
    expect(lanes).toContain(`${BASE}-team-team-a`);
    expect(lanes).toContain(`${BASE}-team-team-b`);
    // A team the actor is NOT in stays absent.
    expect(lanes).not.toContain(`${BASE}-team-team-c`);
  });

  it("with a projectId in context: each entitled base lane ALSO in its -proj-<id> form", () => {
    const lanes = deriveEntitledMemoryLanes({
      orgId: ORG,
      userId: "user-1",
      teamIds: ["team-a"],
      projectId: "proj-9",
    });
    // Ambient forms.
    expect(lanes).toContain(BASE);
    expect(lanes).toContain(`${BASE}-user-user-1`);
    expect(lanes).toContain(`${BASE}-team-team-a`);
    // Project forms of each.
    expect(lanes).toContain(`${BASE}-proj-proj-9`);
    expect(lanes).toContain(`${BASE}-user-user-1-proj-proj-9`);
    expect(lanes).toContain(`${BASE}-team-team-a-proj-proj-9`);
    // An unentitled project is never fabricated.
    expect(lanes.some((l) => l.includes("-proj-other"))).toBe(false);
  });

  it("a sessionless (userId=null) caller gets the org lane only — no user lane", () => {
    const lanes = deriveEntitledMemoryLanes({
      orgId: ORG,
      userId: null,
      teamIds: [],
      projectId: null,
    });
    expect(lanes).toEqual([BASE]);
  });

  it("deduplicates and stays deterministic", () => {
    const lanes = deriveEntitledMemoryLanes({
      orgId: ORG,
      userId: "user-1",
      teamIds: ["team-a", "team-a"],
      projectId: null,
    });
    expect(new Set(lanes).size).toBe(lanes.length);
  });
});
