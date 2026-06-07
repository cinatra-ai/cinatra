/**
 * Admin-gate enforcement on the four MCP handlers.
 *
 * The four primitives covered here:
 *  - skills_match_schedule_get
 *  - skills_match_schedule_set
 *  - skills_match_batch_run_now
 *  - skills_match_evaluate_pair
 *
 * MUST throw `PrimitiveInvocationError({ code: "not_admin" })` when the
 * actor's resolved role is not `platform_admin`. The gate is implemented
 * by the helper `requireAdminActor` in `packages/skills/src/mcp/auth.ts`
 * and called as the FIRST line of each of the four handler bodies.
 *
 * Coverage targets (5 cases):
 *  - GATE-01..04: each of the four handlers throws PrimitiveInvocationError
 *    with code="not_admin" for a non-admin actor.
 *  - GATE-05: a platform_admin actor proceeds past the gate (the throw, if
 *    any, is something OTHER than "not_admin"). This guards against the
 *    inverse regression — a future refactor that broke the bypass would
 *    silently lock admins out.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// --- Mocks needed for handlers.ts to import cleanly. ---
vi.mock("../../skills-store", () => ({
  readSkillsCatalog: vi.fn(),
  uninstallSkillPackage: vi.fn(),
  listCustomSkills: vi.fn(),
  getCustomSkillById: vi.fn(),
  upsertCustomSkill: vi.fn(),
  upsertSkill: vi.fn(),
  deleteCustomSkill: vi.fn(),
  listCustomSkillsForAgent: vi.fn(),
}));
vi.mock("../../personal-skills", () => ({
  createOrUpdateCustomSkillForAgent: vi.fn(),
  resolveCustomSkillContent: vi.fn(),
}));
vi.mock("../../skills-registry", () => ({
  getInstalledSkillById: vi.fn(),
  listInstalledSkills: vi.fn().mockResolvedValue([]),
  listInstalledSkillPackages: vi.fn(),
  parseFrontmatter: vi.fn(),
}));
vi.mock("@/lib/agents-store", () => ({
  getAssignedSkillIdsForAgent: vi.fn(),
  matchAgentsToSkills: vi.fn(),
  readAgentsCatalog: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/mcp-pagination", () => ({
  decodeCursor: vi.fn(() => 0),
  buildListPage: vi.fn((items: unknown[]) => ({ items, total: items.length })),
}));
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn().mockResolvedValue(null),
  isPlatformAdmin: vi.fn().mockReturnValue(false),
}));
vi.mock("@/lib/better-auth-db", () => ({
  readTeamsForUser: vi.fn().mockResolvedValue([]),
  readProjectsForUser: vi.fn().mockResolvedValue([]),
}));
vi.mock("@cinatra-ai/agents/auth-policy", () => ({
  requireResourceAccess: vi.fn(),
  actorContextFromMcpRequest: vi.fn(),
}));
vi.mock("../../llm-matching/event-hooks", () => ({
  enqueueInlineForSkill: vi.fn(),
  cleanupForSkill: vi.fn(),
}));
vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: vi.fn(),
  BACKGROUND_JOB_NAMES: { SKILL_MATCH_BATCH_SUBMIT: "skill-match-batch-submit" },
}));

// Mock the llm-matching surface used by the four admin-gated handlers.
// Note: we only mock the named exports the handlers actually consume.
vi.mock("../../llm-matching", async () => {
  const actual = await vi.importActual<typeof import("../../llm-matching")>(
    "../../llm-matching",
  );
  return {
    ...actual,
    evaluatePair: vi.fn(),
    estimateBatchCost: vi.fn().mockReturnValue({ pairCount: 0, estimatedUsd: 0 }),
    readSchedule: vi.fn().mockResolvedValue({ enabled: false, cronExpression: null, timezone: "UTC" }),
    writeSchedule: vi.fn(),
    registerSkillMatchScheduleAtBoot: vi.fn(),
  };
});

import { PrimitiveInvocationError } from "@cinatra-ai/mcp-client";
import { createSkillsPrimitiveHandlers } from "../../mcp/handlers";
import { actorContextFromMcpRequest } from "@cinatra-ai/agents/auth-policy";
import { getAuthSession, isPlatformAdmin } from "@/lib/auth-session";

const memberRequest = {
  primitiveName: "",
  input: {},
  actor: { source: "ui", userId: "user-1", platformRole: "member" } as unknown as Record<string, unknown>,
  mode: "deterministic" as const,
};

const adminRequest = {
  primitiveName: "",
  input: {},
  actor: { source: "ui", userId: "admin-1", platformRole: "platform_admin" } as unknown as Record<string, unknown>,
  mode: "deterministic" as const,
};

describe("admin-gate enforcement for skill matching primitives", () => {
  beforeEach(() => {
    vi.mocked(actorContextFromMcpRequest).mockReset();
    vi.mocked(getAuthSession).mockReset();
    vi.mocked(isPlatformAdmin).mockReset();
  });

  describe("non-admin actor — all four handlers throw not_admin", () => {
    beforeEach(() => {
      // Resolve the actor as a non-admin via both auth probes.
      vi.mocked(actorContextFromMcpRequest).mockResolvedValue({
        platformRole: "member",
        principalId: "user-1",
      } as never);
      vi.mocked(getAuthSession).mockResolvedValue(null);
      vi.mocked(isPlatformAdmin).mockReturnValue(false);
    });

    const each = [
      { name: "GATE-01: skills_match_schedule_get", primitive: "skills_match_schedule_get", input: {} },
      {
        name: "GATE-02: skills_match_schedule_set",
        primitive: "skills_match_schedule_set",
        input: { enabled: true, cronExpression: "0 3 * * *", timezone: "UTC" },
      },
      { name: "GATE-03: skills_match_batch_run_now", primitive: "skills_match_batch_run_now", input: {} },
      {
        name: "GATE-04: skills_match_evaluate_pair",
        primitive: "skills_match_evaluate_pair",
        input: { agentId: "@cinatra/email-agent", skillId: "skill-1" },
      },
    ];

    for (const { name, primitive, input } of each) {
      it(`${name} → throws PrimitiveInvocationError code="not_admin"`, async () => {
        const handlers = createSkillsPrimitiveHandlers();
        const handler = (handlers as Record<string, (req: unknown) => Promise<unknown>>)[primitive];
        expect(handler).toBeDefined();

        const req = { ...memberRequest, primitiveName: primitive, input };
        let caught: unknown = null;
        try {
          await handler(req);
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(PrimitiveInvocationError);
        if (caught instanceof PrimitiveInvocationError) {
          expect(caught.code).toBe("not_admin");
        }
      });
    }
  });

  it("GATE-05: platform_admin actor proceeds past the gate (any throw is NOT not_admin)", async () => {
    vi.mocked(actorContextFromMcpRequest).mockResolvedValue({
      platformRole: "platform_admin",
      principalId: "admin-1",
    } as never);
    vi.mocked(getAuthSession).mockResolvedValue({} as never);
    vi.mocked(isPlatformAdmin).mockReturnValue(true);

    const handlers = createSkillsPrimitiveHandlers();
    // Use schedule_get since it has the simplest happy path (no DB writes).
    const result = await handlers["skills_match_schedule_get"]({
      ...adminRequest,
      primitiveName: "skills_match_schedule_get",
    } as never);
    // Mock returns the schedule object — the gate did not trip.
    expect(result).toEqual({
      enabled: false,
      cronExpression: null,
      timezone: "UTC",
    });
  });
});
