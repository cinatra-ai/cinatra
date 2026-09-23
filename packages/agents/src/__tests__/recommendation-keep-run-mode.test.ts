/**
 * A KEEP IS AN INTERACTIVE ACT, AND ITS TENANCY IS THE RUN'S
 * (cinatra#2815 S3 part 4).
 *
 * Two rules the keep road stated nowhere:
 *
 *   - it checked the CONFIRMER's standing and never the RUN'S MODE, so an
 *     authorized human could keep skills on a run a schedule started. The issue
 *     binds persistence to interactive runs and headless runs to assigned-only,
 *     and what marks a run interactive here is `humanPresent` (cinatra#2067):
 *     the same field the hold that OFFERS a recommendation already gates on.
 *   - the scope fallback read `run.orgId ?? viewer.organizationId`, so a run
 *     that could name no organization of its own borrowed the CONFIRMER'S and
 *     the keep landed in a tenancy the run never named, decided by whoever
 *     happened to press the button.
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

const insertAssignedSkill = vi.fn();
vi.mock("@/lib/agent-assigned-skills-store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  insertAssignedSkill: (...args: unknown[]) => insertAssignedSkill(...args),
}));

import { writeRunSkillSelectionForActor } from "../run-recommendation-core";
import {
  RECOMMENDATION_KEEP_NOT_INTERACTIVE_CODE,
  RECOMMENDATION_KEEP_NOT_INTERACTIVE_REFUSAL,
  RECOMMENDATION_SCOPE_UNDECIDABLE_CODE,
} from "../recommendation-hold";

/** An authorized human confirming their own run. */
const who = {
  actor: { actorType: "human", source: "ui", userId: "user-1" },
  roleHints: { actorOrganizationId: "actor-org" },
};

function run(over: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    templateId: "tpl-1",
    orgId: "org-1",
    humanPresent: true,
    assignmentScopeSnapshot: {
      v: 1,
      orgId: "org-1",
      teamIds: [],
      originatingHumanUserId: "user-1",
    },
    ...over,
  };
}

const confirm = (over: Record<string, unknown> = {}) =>
  writeRunSkillSelectionForActor({
    runId: "run-1",
    confirmedSkillIds: ["skill-a"],
    who: who as never,
    keepRecommended: {},
    ...over,
  });

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
  insertAssignedSkill.mockResolvedValue({ outcome: "assigned" });
});

describe("the run's mode decides whether a keep may happen at all", () => {
  it("refuses the keep on a run nobody started by hand, and assigns nothing", async () => {
    readAgentRunById.mockResolvedValue(run({ humanPresent: false }));
    const result = await confirm();
    // The selection is an ordinary confirm and still lands.
    expect(result.ok).toBe(true);
    expect(confirmRunSkillSelection).toHaveBeenCalledTimes(1);
    // The keep does not.
    expect(insertAssignedSkill).not.toHaveBeenCalled();
    expect(result.kept).toBeUndefined();
    expect(result.refusalCode).toBe(RECOMMENDATION_KEEP_NOT_INTERACTIVE_CODE);
    expect(result.refusal).toBe(RECOMMENDATION_KEEP_NOT_INTERACTIVE_REFUSAL);
  });

  it("refuses it on a run that records no presence at all, fail-closed", async () => {
    readAgentRunById.mockResolvedValue(run({ humanPresent: null }));
    const result = await confirm();
    expect(result.ok).toBe(true);
    expect(insertAssignedSkill).not.toHaveBeenCalled();
    expect(result.refusalCode).toBe(RECOMMENDATION_KEEP_NOT_INTERACTIVE_CODE);
  });

  it("allows it on an interactive run", async () => {
    const result = await confirm();
    expect(result.ok).toBe(true);
    expect(result.refusalCode).toBeUndefined();
    expect(result.kept).toEqual(
      expect.objectContaining({ ok: true, scope: { scopeKind: "user", scopeId: "user-1" } }),
    );
  });

  it("leaves a confirm that asks for NO keep untouched on a headless run", async () => {
    readAgentRunById.mockResolvedValue(run({ humanPresent: false }));
    const result = await confirm({ keepRecommended: undefined });
    expect(result.ok).toBe(true);
    expect(result.refusalCode).toBeUndefined();
    expect(confirmRunSkillSelection).toHaveBeenCalledTimes(1);
  });
});

describe("the scope fallback uses the RUN's durable organization, never the confirmer's", () => {
  it("refuses the whole confirm when the run can name no organization of its own", async () => {
    // The confirmer IS in an organization. Borrowing it used to let this
    // commit, landing the keep in a tenancy the run never named.
    readAgentRunById.mockResolvedValue(
      run({ orgId: null, assignmentScopeSnapshot: "not a snapshot" }),
    );
    const result = await confirm();
    expect(result.ok).toBe(false);
    expect(result.refusalCode).toBe(RECOMMENDATION_SCOPE_UNDECIDABLE_CODE);
    expect(confirmRunSkillSelection).not.toHaveBeenCalled();
    expect(insertAssignedSkill).not.toHaveBeenCalled();
  });

  it("takes the sole legacy fallback when the RUN names one, and proceeds", async () => {
    readAgentRunById.mockResolvedValue(
      run({ orgId: "org-1", assignmentScopeSnapshot: "not a snapshot" }),
    );
    const result = await confirm();
    expect(result.ok).toBe(true);
    // The fallback names no originating human, so a member holds nothing
    // writable in it, but the scope was DECIDED, which is the point.
    expect(result.kept).toEqual({ ok: false, reason: "no-writable-scope" });
  });
});
