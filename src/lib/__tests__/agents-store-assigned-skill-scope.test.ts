/**
 * #1401 — per-scope-axis delivery of custom-skill assignments through
 * `getAssignedSkillIdsForAgent(agentId, actor)`.
 *
 * The resolver already knows how to filter `custom_skill_assignments` by the
 * actor's scope; #1401's fix is that the llm-bridge route now SUPPLIES that
 * actor. This suite pins the resolver contract the route depends on:
 *
 *   - a skill assigned at user / team / project / org / workspace scope is
 *     delivered to an actor INSIDE that scope and withheld from one OUTSIDE it
 *     (acceptance #1, one describe per axis);
 *   - the actor-LESS call delivers NONE of those scoped assignments and never
 *     even reads the assignment table — a regression-pin of today's behavior
 *     that the route's fail-closed path falls back to (acceptance #2).
 *
 * Topology mirrors agents-store.test.ts: the catalog / skill_matches / agents
 * readers are stubbed empty so the ONLY delivery source under test is the
 * custom-assignment union. The @/lib/database assignment reader is a
 * reconfigurable mock returning rows for every owner_type; the resolver's
 * JS-side visibility filter (test parity with the parameterized SQL) is what we
 * assert.
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

describe("getAssignedSkillIdsForAgent — user scope", () => {
  beforeEach(() => seedAssignments([assignment("sk-user", "user", "user-1")]));

  it("delivers a user-scoped assignment to the owning principal", async () => {
    const ids = await getAssignedSkillIdsForAgent(AGENT, {
      principalId: "user-1",
      organizationId: "org-1",
      teamIds: [],
      projectIds: [],
    });
    expect(ids).toContain("sk-user");
  });

  it("withholds it from a different principal", async () => {
    const ids = await getAssignedSkillIdsForAgent(AGENT, {
      principalId: "user-2",
      organizationId: "org-1",
      teamIds: [],
      projectIds: [],
    });
    expect(ids).not.toContain("sk-user");
  });
});

describe("getAssignedSkillIdsForAgent — team scope", () => {
  beforeEach(() => seedAssignments([assignment("sk-team", "team", "team-1")]));

  it("delivers a team-scoped assignment to a member of that team", async () => {
    const ids = await getAssignedSkillIdsForAgent(AGENT, {
      principalId: "user-1",
      organizationId: "org-1",
      teamIds: ["team-1"],
      projectIds: [],
    });
    expect(ids).toContain("sk-team");
  });

  it("withholds it from an actor not in that team", async () => {
    const ids = await getAssignedSkillIdsForAgent(AGENT, {
      principalId: "user-1",
      organizationId: "org-1",
      teamIds: ["team-2"],
      projectIds: [],
    });
    expect(ids).not.toContain("sk-team");
  });
});

describe("getAssignedSkillIdsForAgent — project scope", () => {
  beforeEach(() => seedAssignments([assignment("sk-project", "project", "proj-1")]));

  it("delivers a project-scoped assignment to an actor granted that project", async () => {
    const ids = await getAssignedSkillIdsForAgent(AGENT, {
      principalId: "user-1",
      organizationId: "org-1",
      teamIds: [],
      projectIds: ["proj-1"],
    });
    expect(ids).toContain("sk-project");
  });

  it("withholds it from an actor without that project grant", async () => {
    const ids = await getAssignedSkillIdsForAgent(AGENT, {
      principalId: "user-1",
      organizationId: "org-1",
      teamIds: [],
      projectIds: [],
    });
    expect(ids).not.toContain("sk-project");
  });
});

describe("getAssignedSkillIdsForAgent — organization scope", () => {
  beforeEach(() => seedAssignments([assignment("sk-org", "organization", "org-1")]));

  it("delivers an org-scoped assignment to an actor in that org", async () => {
    const ids = await getAssignedSkillIdsForAgent(AGENT, {
      principalId: "user-1",
      organizationId: "org-1",
      teamIds: [],
      projectIds: [],
    });
    expect(ids).toContain("sk-org");
  });

  it("withholds it from an actor in a different org", async () => {
    const ids = await getAssignedSkillIdsForAgent(AGENT, {
      principalId: "user-1",
      organizationId: "org-2",
      teamIds: [],
      projectIds: [],
    });
    expect(ids).not.toContain("sk-org");
  });
});

describe("getAssignedSkillIdsForAgent — workspace scope", () => {
  beforeEach(() => seedAssignments([assignment("sk-workspace", "workspace", "ws-marker")]));

  it("delivers a workspace-scoped assignment to any actor with a resolved org", async () => {
    const ids = await getAssignedSkillIdsForAgent(AGENT, {
      principalId: "user-1",
      organizationId: "org-1",
      teamIds: [],
      projectIds: [],
    });
    expect(ids).toContain("sk-workspace");
  });

  it("withholds it from an org-less (unauthenticated) actor", async () => {
    const ids = await getAssignedSkillIdsForAgent(AGENT, {
      principalId: "user-1",
      organizationId: undefined,
      teamIds: [],
      projectIds: [],
    });
    expect(ids).not.toContain("sk-workspace");
  });
});

describe("getAssignedSkillIdsForAgent — actor-less delivery (regression pin, #1401 acceptance #2)", () => {
  const ALL_SCOPES = [
    assignment("sk-user", "user", "user-1"),
    assignment("sk-team", "team", "team-1"),
    assignment("sk-project", "project", "proj-1"),
    assignment("sk-org", "organization", "org-1"),
    assignment("sk-workspace", "workspace", "ws-marker"),
  ];

  it("delivers NONE of the ownership-scoped assignments and never reads the assignment table", async () => {
    seedAssignments(ALL_SCOPES);
    const ids = await getAssignedSkillIdsForAgent(AGENT);
    for (const row of ALL_SCOPES) {
      expect(ids).not.toContain(row.skillId);
    }
    // The assignment table is only consulted when an actor is supplied.
    expect(vi.mocked(readCustomSkillAssignmentsForAgent)).not.toHaveBeenCalled();
  });

  it("delivers EVERY scoped assignment once a fully-scoped actor is supplied (proves the same rows WERE reachable)", async () => {
    seedAssignments(ALL_SCOPES);
    const ids = await getAssignedSkillIdsForAgent(AGENT, {
      principalId: "user-1",
      organizationId: "org-1",
      teamIds: ["team-1"],
      projectIds: ["proj-1"],
    });
    for (const row of ALL_SCOPES) {
      expect(ids).toContain(row.skillId);
    }
  });
});
