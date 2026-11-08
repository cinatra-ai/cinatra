/**
 * Skill autosave must not let a FALLBACK organization's teams widen the
 * matched-skill catalog read (cinatra#4536).
 *
 * `resolveUserContextForUserId` now carries the person's `teamIds` of the
 * organization it resolves. For a legacy run with a NULL `org_id`, autosave
 * passes no organization, so the resolver anchors on the person's session or
 * default organization, which the run never named. Inside
 * `createOrUpdateCustomSkillForAgent`, `actor.teamIds` feeds the visibility
 * filter of positive skill matches (`teamIds ?? []`) and `requireResourceAccess`
 * (`teamIds?.includes(...)`); an admitted team-scoped skill's body is embedded
 * in the generation prompt. Before the resolver carried `teamIds`, the axis
 * was absent and both gates denied team-scoped skills.
 *
 * Contract pinned here, at the caller boundary:
 *   - a run with NO organization hands the generator an actor WITHOUT a team
 *     axis (no `teamIds` key); every other resolved field is kept, and the
 *     resolver's own actor object is not changed;
 *   - a run WITH its organization hands the generator the resolved actor
 *     unchanged, team ids included (the #4536 parity this PR is for).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const USER = "user-4536";
const FALLBACK_ORG = "org-fallback-a";
const RUN_ORG = "org-run-a";
const TEAM_T = "team-t";

const skillsMock = vi.hoisted(() => ({
  createOrUpdateCustomSkillForAgent: vi.fn(),
  listCustomSkillsForCurrentUserAndAgent: vi.fn(),
  buildDefaultPersonalSkillName: vi.fn(() => "Default Skill Name"),
}));
vi.mock("@cinatra-ai/skills", () => skillsMock);

const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateByPackageName: vi.fn(),
  readHitlPromptsForRun: vi.fn(),
  readNonExcludedAgentIdsForRun: vi.fn(),
}));
vi.mock("../store", () => storeMock);

vi.mock("@/lib/skill-autosave", () => ({
  readSkillAutosaveConfig: vi.fn(() => ({ enabled: true })),
}));

const authMock = vi.hoisted(() => ({
  resolveUserContextForUserId: vi.fn(),
}));
vi.mock("@/lib/auth-session", () => authMock);

import { runSkillAutosaveOnRunCompletion } from "../skill-autosave";

// The actor the resolver builds for the person in organization `orgId`: the
// shape of `resolveUserContextForUserId` after this PR (team ids, team roles,
// org role and project grants of that one organization).
function resolvedActorFor(orgId: string) {
  return {
    principalType: "User",
    principalId: USER,
    authSource: "ui",
    organizationId: orgId,
    teamIds: [TEAM_T],
    teamRoles: { [TEAM_T]: "member" },
    orgRole: "member",
    projectGrants: [],
    platformRole: "member",
    policyVersion: "v1",
  };
}

function actorHandedToGenerator(): Record<string, unknown> {
  expect(skillsMock.createOrUpdateCustomSkillForAgent).toHaveBeenCalledTimes(1);
  const arg = skillsMock.createOrUpdateCustomSkillForAgent.mock.calls[0]?.[0] as
    | { actor?: Record<string, unknown> }
    | undefined;
  expect(arg?.actor).toBeDefined();
  return arg?.actor as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  skillsMock.createOrUpdateCustomSkillForAgent.mockResolvedValue({
    id: "sk-out-1",
    name: "Skill",
    description: "desc",
    content: "content",
    basedOnSkillIds: [],
  });
  skillsMock.listCustomSkillsForCurrentUserAndAgent.mockResolvedValue([]);
  storeMock.readNonExcludedAgentIdsForRun.mockResolvedValue(["agent-pkg-1"]);
  storeMock.readHitlPromptsForRun.mockResolvedValue([
    { id: "p1", message: "Some prompt", stepKey: "step1", capturedAt: new Date() },
  ]);
  storeMock.readAgentTemplateByPackageName.mockResolvedValue({ name: "Template" });
});

describe("skill autosave: a fallback organization's teams never reach the catalog read", () => {
  it("a: a run with a NULL org hands the generator an actor without a team axis", async () => {
    storeMock.readAgentRunById.mockResolvedValue({
      id: "run-null-org",
      title: "Legacy run",
      runBy: USER,
      orgId: null,
    });
    const resolved = resolvedActorFor(FALLBACK_ORG);
    authMock.resolveUserContextForUserId.mockResolvedValue({
      actorContext: resolved,
      platformRole: "member",
      sessionOrgId: FALLBACK_ORG,
    });

    await runSkillAutosaveOnRunCompletion("run-null-org");

    // No organization is passed: the resolver picks the fallback itself.
    expect(authMock.resolveUserContextForUserId.mock.calls).toEqual([[USER, undefined]]);
    const actor = actorHandedToGenerator();
    // The team membership of the fallback organization is not handed on.
    expect(actor.teamIds).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(actor, "teamIds")).toBe(false);
    // Every other resolved field is kept as the resolver built it.
    const expected: Record<string, unknown> = { ...resolved };
    delete expected.teamIds;
    expect(actor).toStrictEqual(expected);
    // The resolver's own actor object is not changed.
    expect(resolved.teamIds).toEqual([TEAM_T]);
  });

  it("b: a run whose org field is absent is treated like a NULL org", async () => {
    storeMock.readAgentRunById.mockResolvedValue({
      id: "run-no-org-field",
      title: "Legacy run",
      runBy: USER,
    });
    authMock.resolveUserContextForUserId.mockResolvedValue({
      actorContext: resolvedActorFor(FALLBACK_ORG),
      platformRole: "member",
      sessionOrgId: FALLBACK_ORG,
    });

    await runSkillAutosaveOnRunCompletion("run-no-org-field");

    expect(authMock.resolveUserContextForUserId.mock.calls).toEqual([[USER, undefined]]);
    const actor = actorHandedToGenerator();
    expect(actor.teamIds).toBeUndefined();
    expect(actor.principalId).toBe(USER);
    expect(actor.organizationId).toBe(FALLBACK_ORG);
  });

  it("c: a run with its own org hands the generator the resolved actor unchanged, team ids included", async () => {
    storeMock.readAgentRunById.mockResolvedValue({
      id: "run-with-org",
      title: "Run",
      runBy: USER,
      orgId: RUN_ORG,
    });
    const resolved = resolvedActorFor(RUN_ORG);
    authMock.resolveUserContextForUserId.mockResolvedValue({
      actorContext: resolved,
      platformRole: "member",
      sessionOrgId: RUN_ORG,
    });

    await runSkillAutosaveOnRunCompletion("run-with-org");

    expect(authMock.resolveUserContextForUserId.mock.calls).toEqual([
      [USER, { activeOrganizationId: RUN_ORG }],
    ]);
    const actor = actorHandedToGenerator();
    expect(actor).toBe(resolved);
    expect(actor.teamIds).toEqual([TEAM_T]);
  });
});
