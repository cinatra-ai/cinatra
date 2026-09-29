/**
 * getAssignedSkillIdsForAgent unions custom_skill_assignments rows with the
 * existing system globals + agent self-match set.
 *
 * WHICH of those rows a resolution receives is decided by the run's FROZEN
 * assignment scopes (cinatra#2815 S3, epic #2812), not by the calling actor's
 * live memberships: the custom-assignment road reads the same snapshot chain as
 * the per-scope store. An actor is still required, because a resolution with
 * none consults the assignment table at all, but the actor no longer selects the
 * layers.
 *
 * The read path must consume readCustomSkillAssignmentsForAgent so custom
 * assignments reach the union.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — registered BEFORE module-under-test imports
// ---------------------------------------------------------------------------

const {
  readCustomSkillAssignmentsForAgentMock,
  readSystemGlobalSkillIdsForAgentMock,
} = vi.hoisted(() => ({
  readCustomSkillAssignmentsForAgentMock: vi.fn(async () => [
    { skillId: "s1", ownerType: "team", ownerId: "t1" },
    { skillId: "s2", ownerType: "organization", ownerId: "org1" },
    { skillId: "s3", ownerType: "user", ownerId: "u-other" },
  ]),
  readSystemGlobalSkillIdsForAgentMock: vi.fn(async () => [] as string[]),
}));

vi.mock("server-only", () => ({}));

// Spread the REAL module (its readers connect lazily — no DB hit at import) and
// override ONLY the two assignment readers this suite drives. Importing
// @/lib/agents-store transitively loads the @cinatra-ai/skills barrel + the
// connector/notifications boot graph, which statically pull ~30 other symbols
// from @/lib/database at module-load; importOriginal keeps every one of them
// present (real, but never called here) so the mock never rots as that graph
// grows.
vi.mock("@/lib/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/database")>()),
  readCustomSkillAssignmentsForAgent: readCustomSkillAssignmentsForAgentMock,
  readSystemGlobalSkillIdsForAgent: readSystemGlobalSkillIdsForAgentMock,
  // A3 (cinatra#1363): stub the lifecycle gate to deliverable ('active') for
  // every resolved id — the real reader would hit an unavailable DB and
  // fail-closed, withholding the union this test asserts. The gate's own
  // fail-closed/exclusion behaviour is covered by the agents-store suite.
  readSkillLifecycleStates: (ids: string[]) => ({
    ok: true as const,
    states: new Map(ids.map((id) => [id, "active" as string | null])),
  }),
}));

// Module under test consumes readCustomSkillAssignmentsForAgent + ActorContext.
import { getAssignedSkillIdsForAgent } from "@/lib/agents-store";

type ActorContext = {
  principalId: string;
  principalType?: "HumanUser";
  organizationId?: string;
  teamIds?: string[];
};

beforeEach(() => {
  readCustomSkillAssignmentsForAgentMock.mockClear();
  readSystemGlobalSkillIdsForAgentMock.mockClear();
});

type RunScope = { snapshot?: unknown; durableOrgId?: string | null };

function snapshot(input: {
  orgId?: string;
  teamIds?: string[];
  originatingHumanUserId?: string;
}) {
  return {
    v: 1 as const,
    orgId: input.orgId ?? "org1",
    teamIds: input.teamIds ?? [],
    ...(input.originatingHumanUserId
      ? { originatingHumanUserId: input.originatingHumanUserId }
      : {}),
  };
}

const resolve = getAssignedSkillIdsForAgent as unknown as (
  agentId: string,
  actor: ActorContext,
  runScope?: RunScope,
) => Promise<string[]>;

describe("getAssignedSkillIdsForAgent: the scopes the run froze", () => {
  it("a run whose snapshot names team t1 sees the team row, and neither the other organization's nor another person's", async () => {
    const actor: ActorContext = { principalId: "u1", teamIds: ["t1"], organizationId: "orgX" };
    const ids = await resolve("a1", actor, {
      snapshot: snapshot({ orgId: "orgX", teamIds: ["t1"] }),
    });
    expect(ids).toContain("s1");
    expect(ids).not.toContain("s2");
    expect(ids).not.toContain("s3");
  });

  it("a run whose snapshot names org1 sees the organization row", async () => {
    const actor: ActorContext = { principalId: "u1", organizationId: "org1" };
    const ids = await resolve("a1", actor, { snapshot: snapshot({ orgId: "org1" }) });
    expect(ids).toContain("s2");
  });

  it("a run whose snapshot names u-other as the originating human sees that person's row", async () => {
    const actor: ActorContext = { principalId: "u-other" };
    const ids = await resolve("a1", actor, {
      snapshot: snapshot({ originatingHumanUserId: "u-other" }),
    });
    expect(ids).toContain("s3");
  });

  it("a HEADLESS run does not see the personal row, even for the actor that owns it", async () => {
    const actor: ActorContext = { principalId: "u-other" };
    const ids = await resolve("a1", actor, { snapshot: snapshot({}) });
    expect(ids).not.toContain("s3");
  });

  it("no snapshot and no teams coerce to the sole legacy fallback without crashing", async () => {
    const actor: ActorContext = { principalId: "u1" };
    const ids = await resolve("a1", actor);
    expect(Array.isArray(ids)).toBe(true);
    // The fallback holds no team layer.
    expect(ids).not.toContain("s1");
  });

  it("the result is still a union with system globals + agent self-match", async () => {
    readSystemGlobalSkillIdsForAgentMock.mockResolvedValueOnce(["sys-1"]);
    const actor: ActorContext = { principalId: "u1", teamIds: ["t1"], organizationId: "org1" };
    const ids = await resolve("a1", actor, {
      snapshot: snapshot({ orgId: "org1", teamIds: ["t1"] }),
    });
    expect(ids).toContain("sys-1");
    expect(ids).toContain("s1");
    expect(ids).toContain("s2");
  });
});
