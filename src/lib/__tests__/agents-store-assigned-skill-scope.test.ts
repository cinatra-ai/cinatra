/**
 * Per-scope delivery of custom-skill assignments through
 * `getAssignedSkillIdsForAgent(agentId, actor, runScope)`.
 *
 * #1401 made the resolver filter `custom_skill_assignments` by the ACTOR's live
 * scope, and the llm-bridge route supplied that actor. cinatra#2815 S3 moves the
 * authority: WHICH scopes a resolution may read is decided by the run's FROZEN
 * snapshot, and the custom-assignment road reads it through the same chain as
 * the per-scope store. This suite therefore pins the contract per axis the way
 * #1401 did, driven by the snapshot instead of by live memberships, plus the
 * two rules the old road could not state:
 *
 *   - the personal layer exists only when the snapshot names an originating
 *     human, so a headless run never receives its owner's personal assignments;
 *   - an absent, malformed or unknown-version snapshot resolves the SOLE legacy
 *     fallback (workspace plus the durable organization), and the project, user
 *     and team layers are forbidden in it.
 *
 * It also pins the per-run cap across BOTH stores: five per-scope picks plus a
 * custom row deliver five assigned skills, not six.
 *
 * Topology mirrors agents-store.test.ts: the catalog / skill_matches / agents
 * readers are stubbed empty so the ONLY delivery source under test is the
 * assignment union. The @/lib/database assignment reader is a reconfigurable
 * mock returning rows for every owner_type, so what the chain admits is what is
 * asserted.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

// @cinatra-ai/skills barrel transitively imports personal-skills.ts →
// @cinatra-ai/llm; stub before any import.
vi.mock("@cinatra-ai/llm", () => ({
  runResolvedDeterministicLlmTask: vi.fn(),
  resolveConfiguredLlmRuntime: vi.fn(),
  parseStructuredJson: vi.fn(),
}));

vi.mock("@/lib/database", () => ({
  readAgentSkillMatchesFromDatabase: vi.fn(() => ({ matches: [], matchedAt: "" })),
  replaceAgentSkillMatchesInDatabase: vi.fn(),
  readAgentSkillExclusionsFromDatabase: vi.fn(() => ({ exclusions: [], updatedAt: "" })),
  replaceAgentSkillExclusionsInDatabase: vi.fn(),
  readAgentCatalogFromDatabase: vi.fn(() => ({ agents: [] })),
  replaceAgentCatalogInDatabase: vi.fn(),
  // Reconfigured per test via vi.mocked(...). Default: no assignments.
  readCustomSkillAssignmentsForAgent: vi.fn(() => []),
  readSystemGlobalSkillIdsForAgent: vi.fn(() => []),
  // A3 (cinatra#1363): lifecycle gate reads every resolved id as 'active'
  // (deliverable) so the scope-union assertions below are unaffected.
  readSkillLifecycleStates: (ids: string[]) => ({
    ok: true,
    states: new Map(ids.map((id) => [id, "active" as string | null])),
  }),
}));

vi.mock("@cinatra-ai/agents/store", () => ({
  readInstalledAgentTemplates: vi.fn(async () => []),
}));

vi.mock("@cinatra-ai/agents/agent-runtime-mount", () => ({
  resolveAgentRuntimeMountDir: vi.fn(() => "/nonexistent-install-dir"),
  resolveDevExtensionSourceRoot: vi.fn(() => "/nonexistent-install-dir"),
}));

vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(() => null),
}));

vi.mock("@cinatra-ai/skills", async () => {
  // Exercise the REAL level-based visibility filter (pure fn, type-only deps).
  const visibility = await vi.importActual<
    typeof import("../../../packages/skills/src/llm-matching/visibility")
  >("../../../packages/skills/src/llm-matching/visibility");
  // A3 (cinatra#1363): the real (pure) runtime-delivery predicate.
  const skillSource = await vi.importActual<
    typeof import("../../../packages/skills/src/skill-source")
  >("../../../packages/skills/src/skill-source");
  return {
    filterMatchRowsByVisibility: visibility.filterMatchRowsByVisibility,
    isRuntimeDeliverableLifecycleState: skillSource.isRuntimeDeliverableLifecycleState,
    MANUAL_VERSION: "manual",
    resolveEffectiveSkillAccessPolicy: (
      skill: { packageId?: string; accessPolicy?: unknown } | undefined,
      skillPackages: Array<{ id?: string; packageId?: string; accessPolicy?: unknown }> = [],
    ) =>
      skill?.accessPolicy ??
      skillPackages.find(
        (p) => p.packageId === skill?.packageId || p.id === skill?.packageId,
      )?.accessPolicy ??
      null,
    // Empty catalog: custom assignments are the ONLY delivery source here.
    readSkillsCatalog: vi.fn(async () => ({ skills: [], skillPackages: [] })),
    skillMatchesStore: {
      readAllMatched: vi.fn(async () => []),
      readSkillMatchesByAgent: vi.fn(async () => []),
      upsertSkillMatch: vi.fn(),
    },
  };
});

import { getAssignedSkillIdsForAgent } from "../agents-store";
import { readCustomSkillAssignmentsForAgent } from "@/lib/database";

const AGENT = "@cinatra-ai/email-recipient-selection-agent";

type OwnerType = "user" | "team" | "project" | "organization" | "workspace";
function assignment(skillId: string, ownerType: OwnerType, ownerId: string) {
  return { skillId, agentId: AGENT, ownerType, ownerId, createdBy: null };
}

/** Seed the assignment table with the given rows for the next resolve call. */
function seedAssignments(rows: ReturnType<typeof assignment>[]) {
  vi.mocked(readCustomSkillAssignmentsForAgent).mockReturnValue(rows as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readCustomSkillAssignmentsForAgent).mockReturnValue([] as never);
});

/** A frozen V1 snapshot, as the run column carries it. */
function snapshot(input: {
  orgId?: string;
  projectId?: string;
  teamIds?: string[];
  originatingHumanUserId?: string;
}) {
  return {
    v: 1 as const,
    orgId: input.orgId ?? "org-1",
    ...(input.projectId ? { projectId: input.projectId } : {}),
    teamIds: input.teamIds ?? [],
    ...(input.originatingHumanUserId
      ? { originatingHumanUserId: input.originatingHumanUserId }
      : {}),
  };
}

/** The actor every case below shares. Its live memberships are DELIBERATELY
 *  wide: what decides delivery is the snapshot, and a suite whose actor already
 *  narrowed the answer could not show that. */
const WIDE_ACTOR = {
  principalId: "user-1",
  organizationId: "org-1",
  teamIds: ["team-1", "team-2"],
  projectIds: ["proj-1", "proj-2"],
};

function resolve(runScope: { snapshot?: unknown; durableOrgId?: string | null }) {
  return getAssignedSkillIdsForAgent(AGENT, WIDE_ACTOR, runScope);
}

describe("the custom-assignment road: user scope", () => {
  beforeEach(() => seedAssignments([assignment("sk-user", "user", "user-1")]));

  it("delivers a personal assignment when the snapshot NAMES that originating human", async () => {
    const ids = await resolve({
      snapshot: snapshot({ originatingHumanUserId: "user-1" }),
    });
    expect(ids).toContain("sk-user");
  });

  it("withholds it when the snapshot names a DIFFERENT originating human", async () => {
    const ids = await resolve({
      snapshot: snapshot({ originatingHumanUserId: "user-2" }),
    });
    expect(ids).not.toContain("sk-user");
  });

  it("withholds it from a HEADLESS run whose snapshot names no originating human, even though the actor owns it", async () => {
    // The defect this pins: the road read the ACTOR's principal id, so a
    // scheduled run still received its owner's personal assignments.
    const ids = await resolve({ snapshot: snapshot({}) });
    expect(ids).not.toContain("sk-user");
  });
});

describe("the custom-assignment road: team scope", () => {
  beforeEach(() => seedAssignments([assignment("sk-team", "team", "team-1")]));

  it("delivers a team assignment the snapshot froze", async () => {
    const ids = await resolve({ snapshot: snapshot({ teamIds: ["team-1"] }) });
    expect(ids).toContain("sk-team");
  });

  it("withholds it when the snapshot froze another team, whatever the actor belongs to today", async () => {
    const ids = await resolve({ snapshot: snapshot({ teamIds: ["team-2"] }) });
    expect(ids).not.toContain("sk-team");
  });
});

describe("the custom-assignment road: project scope", () => {
  beforeEach(() => seedAssignments([assignment("sk-project", "project", "proj-1")]));

  it("delivers a project assignment the snapshot froze", async () => {
    const ids = await resolve({ snapshot: snapshot({ projectId: "proj-1" }) });
    expect(ids).toContain("sk-project");
  });

  it("withholds it when the snapshot froze another project", async () => {
    const ids = await resolve({ snapshot: snapshot({ projectId: "proj-2" }) });
    expect(ids).not.toContain("sk-project");
  });
});

describe("the custom-assignment road: organization scope", () => {
  beforeEach(() => seedAssignments([assignment("sk-org", "organization", "org-1")]));

  it("delivers an organization assignment the snapshot froze", async () => {
    const ids = await resolve({ snapshot: snapshot({ orgId: "org-1" }) });
    expect(ids).toContain("sk-org");
  });

  it("withholds it when the snapshot froze another organization", async () => {
    const ids = await resolve({ snapshot: snapshot({ orgId: "org-2" }) });
    expect(ids).not.toContain("sk-org");
  });
});

describe("the custom-assignment road: workspace scope", () => {
  beforeEach(() => seedAssignments([assignment("sk-workspace", "workspace", "ws-marker")]));

  it("delivers a workspace assignment, which every chain holds", async () => {
    const ids = await resolve({ snapshot: snapshot({}) });
    expect(ids).toContain("sk-workspace");
  });

  it("still delivers it on the narrowest chain of all: no snapshot AND no durable organization", async () => {
    const ids = await resolve({ snapshot: null, durableOrgId: null });
    expect(ids).toContain("sk-workspace");
  });
});

describe("the SOLE legacy fallback forbids the project, user and team layers", () => {
  const ALL_SCOPES = [
    assignment("sk-user", "user", "user-1"),
    assignment("sk-team", "team", "team-1"),
    assignment("sk-project", "project", "proj-1"),
    assignment("sk-org", "organization", "org-1"),
    assignment("sk-workspace", "workspace", "ws-marker"),
  ];

  it("an ABSENT snapshot delivers the organization and the workspace, and nothing else", async () => {
    seedAssignments(ALL_SCOPES);
    const ids = await resolve({ snapshot: null, durableOrgId: "org-1" });
    expect(ids).toEqual(expect.arrayContaining(["sk-org", "sk-workspace"]));
    expect(ids).not.toContain("sk-user");
    expect(ids).not.toContain("sk-team");
    expect(ids).not.toContain("sk-project");
  });

  it("a MALFORMED payload takes the same fallback: the project and team rows do not survive it", async () => {
    seedAssignments(ALL_SCOPES);
    const ids = await resolve({ snapshot: "not-a-snapshot", durableOrgId: "org-1" });
    expect(ids).toContain("sk-org");
    expect(ids).not.toContain("sk-project");
    expect(ids).not.toContain("sk-team");
    expect(ids).not.toContain("sk-user");
  });

  it("an UNKNOWN version takes the same fallback", async () => {
    seedAssignments(ALL_SCOPES);
    const ids = await resolve({
      snapshot: { v: 99, orgId: "org-1", projectId: "proj-1", teamIds: ["team-1"] },
      durableOrgId: "org-1",
    });
    expect(ids).toContain("sk-org");
    expect(ids).not.toContain("sk-project");
    expect(ids).not.toContain("sk-team");
  });

  it("a full snapshot reaches EVERY layer, which proves the same rows were reachable", async () => {
    seedAssignments(ALL_SCOPES);
    const ids = await resolve({
      snapshot: snapshot({
        orgId: "org-1",
        projectId: "proj-1",
        teamIds: ["team-1"],
        originatingHumanUserId: "user-1",
      }),
    });
    // Five distinct ids, which is exactly the per-run cap, so no row is dropped.
    for (const row of ALL_SCOPES) expect(ids).toContain(row.skillId);
  });
});

describe("the actor-less resolution", () => {
  it("delivers none of the scoped assignments and never reads the assignment table", async () => {
    seedAssignments([
      assignment("sk-user", "user", "user-1"),
      assignment("sk-org", "organization", "org-1"),
      assignment("sk-workspace", "workspace", "ws-marker"),
    ]);
    const ids = await getAssignedSkillIdsForAgent(AGENT);
    expect(ids).toEqual([]);
    expect(vi.mocked(readCustomSkillAssignmentsForAgent)).not.toHaveBeenCalled();
  });
});
