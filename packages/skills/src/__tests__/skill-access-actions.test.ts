/**
 * saveSkillVisibility server action authorization tests.
 *
 * Behavior matrix (system-level skill rejection):
 *   1. Non-admin user on system-level skill  → { ok: false, error: "forbidden" }
 *   2. Platform admin on system-level skill  → { ok: true }
 *   3. No session                            → { ok: false, error: "unauthorized" }
 *   4. Skill not found                       → { ok: false, error: "not_found" }
 *   5. Owner (personal skill) can save       → { ok: true }
 *   6. Non-owner non-admin on personal skill → { ok: false, error: "forbidden" }
 *
 * Run targeted:
 *   cd packages/skills && pnpm exec vitest run src/__tests__/skill-access-actions.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (hoisted so they apply before module under test loads)
// ---------------------------------------------------------------------------

const authMock = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  isPlatformAdmin: vi.fn(
    (session?: { user?: { role?: string | null } | null } | null) =>
      String(session?.user?.role ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean)
        .includes("admin"),
  ),
}));
vi.mock("@/lib/auth-session", () => authMock);

const registryMock = vi.hoisted(() => ({
  getInstalledSkillById: vi.fn(),
}));
vi.mock("../skills-registry", () => registryMock);

const storeMock = vi.hoisted(() => ({
  updateSkillVisibility: vi.fn(),
}));
vi.mock("../skills-store", () => storeMock);

import { saveSkillVisibility } from "../skill-access-actions";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SKILL_ID = "skill-system-1";
const OWNER_ID = "user-owner";
const OTHER_ID = "user-other";

function makeSession(userId: string, role: string | null = null) {
  return { user: { id: userId, role } };
}

/** A system-level skill row — no personal owner (level="system"). */
function makeSystemSkill() {
  return {
    id: SKILL_ID,
    level: "system",
    scope: undefined,
  };
}

/** A personal skill owned by OWNER_ID. */
function makePersonalSkill(ownerId = OWNER_ID) {
  return {
    id: SKILL_ID,
    level: "personal",
    scope: ownerId,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  storeMock.updateSkillVisibility.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Tests — system-level skill rejection
// ---------------------------------------------------------------------------

describe("saveSkillVisibility — system-level skill", () => {
  it("non-admin user targeting system-level skill returns forbidden", async () => {
    authMock.getAuthSession.mockResolvedValue(makeSession(OTHER_ID, null));
    registryMock.getInstalledSkillById.mockResolvedValue(makeSystemSkill());

    const result = await saveSkillVisibility(SKILL_ID, "org");

    expect(result).toEqual({ ok: false, error: "forbidden" });
    expect(storeMock.updateSkillVisibility).not.toHaveBeenCalled();
  });

  it("platform admin targeting system-level skill succeeds", async () => {
    authMock.getAuthSession.mockResolvedValue(makeSession(OTHER_ID, "admin"));
    registryMock.getInstalledSkillById.mockResolvedValue(makeSystemSkill());

    const result = await saveSkillVisibility(SKILL_ID, "org");

    expect(result).toEqual({ ok: true });
    expect(storeMock.updateSkillVisibility).toHaveBeenCalledTimes(1);
    expect(storeMock.updateSkillVisibility).toHaveBeenCalledWith(SKILL_ID, "org");
  });
});

// ---------------------------------------------------------------------------
// Tests — basic auth gates
// ---------------------------------------------------------------------------

describe("saveSkillVisibility — auth gates", () => {
  it("returns unauthorized when no session", async () => {
    authMock.getAuthSession.mockResolvedValue(null);

    const result = await saveSkillVisibility(SKILL_ID, "org");

    expect(result).toEqual({ ok: false, error: "unauthorized" });
    expect(registryMock.getInstalledSkillById).not.toHaveBeenCalled();
  });

  it("returns not_found when skill does not exist", async () => {
    authMock.getAuthSession.mockResolvedValue(makeSession(OWNER_ID, "admin"));
    registryMock.getInstalledSkillById.mockResolvedValue(null);

    const result = await saveSkillVisibility(SKILL_ID, "org");

    expect(result).toEqual({ ok: false, error: "not_found" });
    expect(storeMock.updateSkillVisibility).not.toHaveBeenCalled();
  });

  it("owner of personal skill can save visibility", async () => {
    authMock.getAuthSession.mockResolvedValue(makeSession(OWNER_ID, null));
    registryMock.getInstalledSkillById.mockResolvedValue(makePersonalSkill(OWNER_ID));

    const result = await saveSkillVisibility(SKILL_ID, "owner");

    expect(result).toEqual({ ok: true });
    expect(storeMock.updateSkillVisibility).toHaveBeenCalledWith(SKILL_ID, "owner");
  });

  it("non-owner non-admin on personal skill returns forbidden", async () => {
    authMock.getAuthSession.mockResolvedValue(makeSession(OTHER_ID, null));
    registryMock.getInstalledSkillById.mockResolvedValue(makePersonalSkill(OWNER_ID));

    const result = await saveSkillVisibility(SKILL_ID, "owner");

    expect(result).toEqual({ ok: false, error: "forbidden" });
    expect(storeMock.updateSkillVisibility).not.toHaveBeenCalled();
  });

  it("returns invalid for unrecognized visibility token", async () => {
    authMock.getAuthSession.mockResolvedValue(makeSession(OWNER_ID, "admin"));
    registryMock.getInstalledSkillById.mockResolvedValue(makeSystemSkill());

    const result = await saveSkillVisibility(SKILL_ID, "public" as never);

    expect(result).toEqual({ ok: false, error: "invalid" });
    expect(storeMock.updateSkillVisibility).not.toHaveBeenCalled();
  });
});
