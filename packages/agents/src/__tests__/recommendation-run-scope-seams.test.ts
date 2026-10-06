/**
 * THE RUN'S FROZEN SCOPES DECIDE WHICH SKILLS A CONFIRM MAY TOUCH
 * (cinatra#2815 S3, epic #2812).
 *
 * `getAssignedSkillIdsForAgent` takes the run's frozen snapshot as its third
 * argument. Without it the resolution takes the SOLE legacy fallback: the
 * workspace layer plus whatever organization the caller's own frame names. Two
 * seams on the recommendation road omitted it, so a run's project, team and
 * personal assignments vanished from the allowed set, and the confirmer's
 * organization supplied the tenancy floor instead of the run's.
 *
 * The allowed set is what bounds the write, so a skill missing from it is a
 * skill the confirm silently drops.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const readAgentRunById = vi.fn();
const readAgentTemplateById = vi.fn();
const readRunCoOwners = vi.fn();
vi.mock("../store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readAgentRunById: (...args: unknown[]) => readAgentRunById(...args),
  readAgentTemplateById: (...args: unknown[]) => readAgentTemplateById(...args),
  readRunCoOwners: (...args: unknown[]) => readRunCoOwners(...args),
}));

const enforceRunAccess = vi.fn();
vi.mock("../auth-policy", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  enforceRunAccess: (...args: unknown[]) => enforceRunAccess(...args),
  resolveEffectivePolicy: () => ({}),
}));

const confirmRunSkillSelection = vi.fn();
vi.mock("../recommendation-interception", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  confirmRunSkillSelection: (...args: unknown[]) => confirmRunSkillSelection(...args),
}));

const getAssignedSkillIdsForAgent = vi.fn();
vi.mock("@/lib/agents-store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAssignedSkillIdsForAgent: (...args: unknown[]) => getAssignedSkillIdsForAgent(...args),
}));

import { writeRunSkillSelectionForActor } from "../run-recommendation-core";

const SNAPSHOT = {
  v: 1,
  orgId: "org-run",
  projectId: "proj-run",
  teamIds: ["team-run"],
  originatingHumanUserId: "user-1",
};

function run(over: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    templateId: "tpl-1",
    orgId: "org-run",
    runBy: "user-1",
    humanPresent: true,
    assignmentScopeSnapshot: SNAPSHOT,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  readAgentRunById.mockResolvedValue(run());
  readAgentTemplateById.mockResolvedValue({ packageName: "@cinatra-ai/some-agent" });
  readRunCoOwners.mockResolvedValue([]);
  enforceRunAccess.mockResolvedValue(undefined);
  getAssignedSkillIdsForAgent.mockResolvedValue(["skill-a"]);
  confirmRunSkillSelection.mockResolvedValue({
    ok: true,
    written: 1,
    efficacy: { accepted: ["skill-a"], rejected: [] },
  });
});

describe("the authoritative selection write", () => {
  it("resolves the allowed set with the RUN'S frozen scopes", async () => {
    await writeRunSkillSelectionForActor({
      runId: "run-1",
      confirmedSkillIds: ["skill-a"],
      who: {
        actor: { actorType: "human", source: "ui", userId: "user-1" },
        roleHints: { actorOrganizationId: "org-confirmer" },
      } as never,
    });
    const [, , runScope] = getAssignedSkillIdsForAgent.mock.calls[0] as [
      string,
      unknown,
      { snapshot?: unknown; durableOrgId?: string | null } | undefined,
    ];
    expect(runScope?.snapshot).toEqual(SNAPSHOT);
    // The RUN'S organization is the floor, never the confirmer's.
    expect(runScope?.durableOrgId).toBe("org-run");
  });
});
