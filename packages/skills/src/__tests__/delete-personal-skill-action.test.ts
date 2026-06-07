/**
 * deletePersonalSkillAction — F1 detail-page delete-race fix (behavioral).
 *
 * On SUCCESS the action must REDIRECT server-side, mirroring savePersonalSkillAction.
 * A returned MutationResult would let the Next Server Action's RSC refresh re-render
 * the /skills/<id>/edit page, which calls notFound() once the row is gone, unmounting
 * <DeleteItemForm> before its success useEffect (toast + nav) can fire — the user would
 * see a 404. On FAILURE the action still returns a MutationResult so the edit page can
 * surface an in-place error toast.
 *
 * redirect() is modeled as a THROWING sentinel (it throws NEXT_REDIRECT in real Next),
 * so the success assertion only passes if control actually transfers — never falling
 * through to a {ok:true} return.
 *
 * Run targeted:
 *   cd packages/skills && pnpm exec vitest run src/__tests__/delete-personal-skill-action.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (hoisted so they apply before the module under test loads)
// ---------------------------------------------------------------------------

const navMock = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    const err = new Error("NEXT_REDIRECT");
    (err as Error & { redirectUrl?: string }).redirectUrl = url;
    throw err;
  }),
}));
vi.mock("next/navigation", () => navMock);

const authMock = vi.hoisted(() => ({
  requireActorContext: vi.fn(),
}));
vi.mock("@/lib/auth-session", () => authMock);

const storeMock = vi.hoisted(() => ({
  deleteCustomSkill: vi.fn(),
}));
vi.mock("../skills-store", () => storeMock);

// actions.ts imports this at module top level; avoid loading the real module graph.
const agentsMock = vi.hoisted(() => ({
  readAgentsForSkillMatching: vi.fn(),
}));
vi.mock("@/lib/agents-store", () => agentsMock);

import { deletePersonalSkillAction } from "../actions";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACTOR = {
  principalId: "user-1",
  teamIds: ["team-1"],
  projectIds: ["proj-1"],
  organizationId: "org-1",
};

function formDataWith(skillId?: string): FormData {
  const fd = new FormData();
  if (skillId !== undefined) fd.set("skillId", skillId);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.requireActorContext.mockResolvedValue(ACTOR);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deletePersonalSkillAction", () => {
  it("redirects to the scoped skills list on success (does NOT return {ok:true})", async () => {
    storeMock.deleteCustomSkill.mockResolvedValue(true);

    // The redirect sentinel throws, so the call rejects rather than resolving to a value.
    await expect(deletePersonalSkillAction(formDataWith("skill-1"))).rejects.toThrow(
      "NEXT_REDIRECT",
    );

    expect(navMock.redirect).toHaveBeenCalledTimes(1);
    expect(navMock.redirect).toHaveBeenCalledWith("/skills?scope=personal&deleted=1");
    // The actor-scoped delete path is unchanged: skillId + full actor scope are threaded.
    expect(storeMock.deleteCustomSkill).toHaveBeenCalledWith({
      ownerUserId: ACTOR.principalId,
      skillId: "skill-1",
      actor: {
        principalId: ACTOR.principalId,
        teamIds: ACTOR.teamIds,
        projectIds: ACTOR.projectIds,
        organizationId: ACTOR.organizationId,
      },
    });
  });

  it("returns a MutationResult error (no redirect) when the store reports the row could not be deleted", async () => {
    storeMock.deleteCustomSkill.mockResolvedValue(false);

    const result = await deletePersonalSkillAction(formDataWith("skill-1"));

    expect(result).toEqual({ ok: false, error: "The custom skill could not be deleted." });
    expect(navMock.redirect).not.toHaveBeenCalled();
  });

  it("returns a MutationResult error (no redirect, no store call) when skillId is missing", async () => {
    const result = await deletePersonalSkillAction(formDataWith());

    expect(result).toEqual({ ok: false, error: "No custom skill was selected." });
    expect(storeMock.deleteCustomSkill).not.toHaveBeenCalled();
    expect(navMock.redirect).not.toHaveBeenCalled();
  });
});
