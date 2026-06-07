/**
 * Ownership invariant test.
 *
 * Verifies the ownership invariants:
 *   1. Catalog `ownerUserId` never drifts from the assignment row's
 *      (ownerType, ownerId) when ownerType === 'user'.
 *   2. Re-upserting with a different ownerType (user → team) clears the
 *      legacy `ownerUserId` field (no phantom user owner alongside team).
 *   3. deleteCustomSkill cascades the assignment row in the same logical
 *      operation (no orphaned rows).
 *   4. The runtime drift guard throws on payload/assignment mismatch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks for the @/lib/database seam
// ---------------------------------------------------------------------------

const {
  upsertCustomSkillAssignmentMock,
  deleteCustomSkillAssignmentMock,
  replaceSkillCatalogInDatabaseMock,
  readSkillCatalogFromDatabaseMock,
} = vi.hoisted(() => ({
  upsertCustomSkillAssignmentMock: vi.fn((_input: Record<string, unknown>) => undefined),
  deleteCustomSkillAssignmentMock: vi.fn((_skillId: string, _agentId: string) => undefined),
  replaceSkillCatalogInDatabaseMock: vi.fn(
    (_input: { skillPackages: unknown[]; skills: Array<Record<string, unknown>> }) =>
      undefined,
  ),
  readSkillCatalogFromDatabaseMock: vi.fn(
    (): { skillPackages: unknown[]; skills: Array<Record<string, unknown>> } => ({
      skillPackages: [],
      skills: [],
    }),
  ),
}));

vi.mock("server-only", () => ({}));

vi.mock("@cinatra-ai/llm", () => ({
  runResolvedDeterministicLlmTask: vi.fn(),
  resolveConfiguredLlmRuntime: vi.fn(),
  parseStructuredJson: vi.fn(),
}));

vi.mock("@/lib/agents-store", () => ({
  readAgentsCatalog: vi.fn(async () => []),
  getAssignedSkillIdsForAgent: vi.fn(async () => []),
  readAgentSkillMatches: vi.fn(async () => ({ matches: [], matchedAt: "" })),
}));

vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: vi.fn(() => ({})),
  writeConnectorConfigToDatabase: vi.fn(),
  readSkillCatalogFromDatabase: readSkillCatalogFromDatabaseMock,
  replaceSkillCatalogInDatabase: replaceSkillCatalogInDatabaseMock,
  upsertCustomSkillAssignment: upsertCustomSkillAssignmentMock,
  deleteCustomSkillAssignment: deleteCustomSkillAssignmentMock,
}));

vi.mock("./skill-packages", () => ({
  installedSkillPackages: [],
}));

// Avoid disk + git side-effects from upsertSkill().
vi.mock("./storage/git-commit", () => ({
  commitSkillChange: vi.fn(async () => undefined),
}));

vi.mock("fs/promises", async () => {
  const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises");
  return {
    ...actual,
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
  };
});

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Module under test — imported AFTER all mocks are registered.
import { upsertCustomSkill, deleteCustomSkill } from "../skills-store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  upsertCustomSkillAssignmentMock.mockClear();
  deleteCustomSkillAssignmentMock.mockClear();
  replaceSkillCatalogInDatabaseMock.mockClear();
  readSkillCatalogFromDatabaseMock.mockClear();
  readSkillCatalogFromDatabaseMock.mockReturnValue({
    skillPackages: [],
    skills: [],
  });
});

function lastReplacedSkill() {
  const calls = replaceSkillCatalogInDatabaseMock.mock.calls;
  const last = calls[calls.length - 1]?.[0] as
    | { skills: Array<{ id?: string; ownerUserId?: string; agentId?: string }> }
    | undefined;
  return last?.skills?.find((s) => s.agentId !== undefined) ?? last?.skills?.[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ownership invariant", () => {
  it("Test 1: user-owned upsert writes catalog.ownerUserId === assignment.ownerId", async () => {
    await upsertCustomSkill({
      agentId: "a1",
      name: "n1",
      content: "c",
      ownerUserId: "u1",
      ownerType: "user",
      ownerId: "u1",
    });

    expect(upsertCustomSkillAssignmentMock).toHaveBeenCalledTimes(1);
    const [arg] = upsertCustomSkillAssignmentMock.mock.calls[0] ?? [];
    expect(arg).toMatchObject({
      agentId: "a1",
      ownerType: "user",
      ownerId: "u1",
    });

    const skill = lastReplacedSkill();
    expect(skill?.ownerUserId).toBe("u1");
  });

  it("Test 2: team-owned upsert clears catalog.ownerUserId (no phantom user owner)", async () => {
    await upsertCustomSkill({
      agentId: "a1",
      name: "n2",
      content: "c",
      ownerUserId: "creator-u-ignored",
      ownerType: "team",
      ownerId: "t1",
    });

    expect(upsertCustomSkillAssignmentMock).toHaveBeenCalledTimes(1);
    const [arg] = upsertCustomSkillAssignmentMock.mock.calls[0] ?? [];
    expect(arg).toMatchObject({
      agentId: "a1",
      ownerType: "team",
      ownerId: "t1",
    });

    const skill = lastReplacedSkill();
    expect(skill?.ownerUserId).toBeUndefined();
  });

  it("Test 3: deleteCustomSkill cascades to deleteCustomSkillAssignment(skillId, agentId)", async () => {
    readSkillCatalogFromDatabaseMock.mockReturnValue({
      skillPackages: [],
      skills: [
        {
          id: "custom:personal-skills:s1",
          name: "n",
          slug: "s1",
          description: "d",
          content: "c",
          packageId: "custom:personal-skills",
          packageName: "Custom Skills",
          packageSlug: "personal-skills",
          sourcePath: "/tmp/SKILL.md",
          usedBy: [],
          isCustom: true,
          isCustomSkill: true,
          ownerUserId: "u1",
          agentId: "a1",
          level: "personal",
        },
      ],
    });

    const result = await deleteCustomSkill({
      ownerUserId: "u1",
      skillId: "custom:personal-skills:s1",
    });

    expect(result).toBe(true);
    expect(deleteCustomSkillAssignmentMock).toHaveBeenCalledTimes(1);
    expect(deleteCustomSkillAssignmentMock).toHaveBeenCalledWith(
      "custom:personal-skills:s1",
      "a1",
    );
  });

  it("Test 4: re-upsert flips user → team — assignment row updates, catalog ownerUserId cleared", async () => {
    // First upsert: user-owned.
    await upsertCustomSkill({
      agentId: "a1",
      name: "shared",
      content: "c",
      ownerUserId: "u1",
      ownerType: "user",
      ownerId: "u1",
    });
    const firstSkill = lastReplacedSkill();
    expect(firstSkill?.ownerUserId).toBe("u1");

    // Seed catalog so the second upsert finds the same skill.
    readSkillCatalogFromDatabaseMock.mockReturnValue({
      skillPackages: [],
      skills: firstSkill ? [firstSkill] : [],
    });

    // Second upsert: now team-owned.
    await upsertCustomSkill({
      skillId: firstSkill?.id,
      agentId: "a1",
      name: "shared",
      content: "c",
      ownerType: "team",
      ownerId: "t1",
    });

    expect(upsertCustomSkillAssignmentMock).toHaveBeenCalledTimes(2);
    const second = upsertCustomSkillAssignmentMock.mock.calls[1]?.[0] as
      | { ownerType?: string; ownerId?: string }
      | undefined;
    expect(second?.ownerType).toBe("team");
    expect(second?.ownerId).toBe("t1");

    const flipped = lastReplacedSkill();
    expect(flipped?.ownerUserId).toBeUndefined();
  });

  it("Drift guard: throws when ownerType==='user' and ownerUserId !== ownerId", async () => {
    await expect(
      upsertCustomSkill({
        agentId: "a1",
        name: "n",
        content: "c",
        ownerUserId: "u1",
        ownerType: "user",
        ownerId: "u-DIFFERENT",
      }),
    ).rejects.toThrow(/drift/i);

    expect(upsertCustomSkillAssignmentMock).not.toHaveBeenCalled();
  });
});
