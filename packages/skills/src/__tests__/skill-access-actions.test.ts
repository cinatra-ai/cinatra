/**
 * saveSkillVisibility server action authorization tests.
 *
 * The action authenticates the caller via `getAuthSession()` (presence gate)
 * and then runs the central `requireResourceAccess(actor, ref, "manage")`
 * gate using the `requireActorContext()` ActorContext. Forbidden + missing
 * are deliberately COLLAPSED to a single `"not_found"` wire shape so a
 * non-admin caller cannot probe skill existence by ID (see the action's catch
 * block). The behavior matrix reflects that collapse — denial never surfaces
 * `"forbidden"`.
 *
 * Behavior matrix:
 *   1. Non-admin user on system-level skill  → { ok: false, error: "not_found" }
 *   2. Platform admin on system-level skill  → { ok: true }
 *   3. No session                            → { ok: false, error: "unauthorized" }
 *   4. Skill not found                       → { ok: false, error: "not_found" }
 *   5. Owner (personal skill) can save       → { ok: true }
 *   6. Non-owner non-admin on personal skill → { ok: false, error: "not_found" }
 *
 * Run targeted:
 *   cd packages/skills && pnpm exec vitest run src/__tests__/skill-access-actions.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (hoisted so they apply before module under test loads)
// ---------------------------------------------------------------------------

// `@/lib/auth-session` is mocked rather than imported because the real module
// pulls Better Auth + the DB graph (unresolvable in the package test sandbox).
// The action statically imports `getAuthSession` and dynamically imports
// `requireActorContext`; both must be on the mock surface.
const authMock = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  requireActorContext: vi.fn(),
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

// The action dynamically imports the central authz gate from the agents
// package. Mock it with the canonical skills-package surface
// (requireResourceAccess + buildSkillResourceRef). The real gate transitively
// imports `@/lib/authz` (server-only + DB), so it is never loaded here; the
// mock reproduces the two policy branches this action exercises (system-level
// admin-only, personal-level owner-only) driven by the actor + resource ref.
const authPolicyMock = vi.hoisted(() => ({
  // Mirrors the real `buildSkillResourceRef`: projects a stored skill row onto
  // the SkillResourceRef shape the gate consumes.
  buildSkillResourceRef: vi.fn(
    (skill: { id: string; level?: string; scope?: string | null }) => ({
      resourceType: "skill" as const,
      resourceId: skill.id,
      level: skill.level,
      ownerId: skill.scope ?? undefined,
      organizationId:
        skill.level === "organization" ? (skill.scope ?? undefined) : undefined,
      isWidgetChatSkill: false,
    }),
  ),
  // Default: mirror the real gate's allow/deny for the branches under test.
  // Resolves silently on allow; throws on deny (the action's catch collapses
  // any throw to `not_found`).
  requireResourceAccess: vi.fn(
    (
      actor: { platformRole?: string; principalId?: string },
      resource: { level?: string; ownerId?: string },
      _mode: "read" | "manage" = "read",
    ) => {
      if (actor.platformRole === "platform_admin") return;
      if (resource.level === "system") {
        throw new Error("hidden");
      }
      // Owner short-circuit for personal/agent/undefined levels.
      if (resource.ownerId && actor.principalId === resource.ownerId) return;
      throw new Error("forbidden");
    },
  ),
}));
vi.mock("@cinatra-ai/agents/auth-policy", () => authPolicyMock);

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

/**
 * Build the ActorContext that `requireActorContext()` would resolve for the
 * given session, including the `platform_admin` derivation the real
 * `buildActorContext` performs from the comma-split role string.
 */
function makeActor(userId: string, role: string | null = null) {
  const isAdmin = String(role ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .includes("admin");
  return {
    principalId: userId,
    principalType: "HumanUser" as const,
    platformRole: isAdmin ? ("platform_admin" as const) : ("member" as const),
    authSource: "ui" as const,
    policyVersion: "v2",
  };
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
  it("non-admin user targeting system-level skill returns not_found (denial collapsed)", async () => {
    authMock.getAuthSession.mockResolvedValue(makeSession(OTHER_ID, null));
    authMock.requireActorContext.mockResolvedValue(makeActor(OTHER_ID, null));
    registryMock.getInstalledSkillById.mockResolvedValue(makeSystemSkill());

    const result = await saveSkillVisibility(SKILL_ID, "org");

    expect(result).toEqual({ ok: false, error: "not_found" });
    expect(storeMock.updateSkillVisibility).not.toHaveBeenCalled();
  });

  it("platform admin targeting system-level skill succeeds", async () => {
    authMock.getAuthSession.mockResolvedValue(makeSession(OTHER_ID, "admin"));
    authMock.requireActorContext.mockResolvedValue(makeActor(OTHER_ID, "admin"));
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
    authMock.requireActorContext.mockResolvedValue(makeActor(OWNER_ID, "admin"));
    registryMock.getInstalledSkillById.mockResolvedValue(null);

    const result = await saveSkillVisibility(SKILL_ID, "org");

    expect(result).toEqual({ ok: false, error: "not_found" });
    expect(storeMock.updateSkillVisibility).not.toHaveBeenCalled();
  });

  it("owner of personal skill can save visibility", async () => {
    authMock.getAuthSession.mockResolvedValue(makeSession(OWNER_ID, null));
    authMock.requireActorContext.mockResolvedValue(makeActor(OWNER_ID, null));
    registryMock.getInstalledSkillById.mockResolvedValue(makePersonalSkill(OWNER_ID));

    const result = await saveSkillVisibility(SKILL_ID, "owner");

    expect(result).toEqual({ ok: true });
    expect(storeMock.updateSkillVisibility).toHaveBeenCalledWith(SKILL_ID, "owner");
  });

  it("non-owner non-admin on personal skill returns not_found (denial collapsed)", async () => {
    authMock.getAuthSession.mockResolvedValue(makeSession(OTHER_ID, null));
    authMock.requireActorContext.mockResolvedValue(makeActor(OTHER_ID, null));
    registryMock.getInstalledSkillById.mockResolvedValue(makePersonalSkill(OWNER_ID));

    const result = await saveSkillVisibility(SKILL_ID, "owner");

    expect(result).toEqual({ ok: false, error: "not_found" });
    expect(storeMock.updateSkillVisibility).not.toHaveBeenCalled();
  });

  it("returns invalid for unrecognized visibility token", async () => {
    authMock.getAuthSession.mockResolvedValue(makeSession(OWNER_ID, "admin"));
    authMock.requireActorContext.mockResolvedValue(makeActor(OWNER_ID, "admin"));
    registryMock.getInstalledSkillById.mockResolvedValue(makeSystemSkill());

    const result = await saveSkillVisibility(SKILL_ID, "public" as never);

    expect(result).toEqual({ ok: false, error: "invalid" });
    expect(storeMock.updateSkillVisibility).not.toHaveBeenCalled();
  });
});
