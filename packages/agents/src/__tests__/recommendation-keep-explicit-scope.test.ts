/**
 * THE KEEP ROAD ASKS FOR A SCOPE, REPORTS WHAT IT DID, AND WRITES ONLY WHAT
 * THE CONFIRMATION SELECTED (cinatra#2815 S3 part 4, epic #2812).
 *
 * Three rules the road stated nowhere.
 *
 *   1. A keep request with NO scope reached a resolver that chose one for it,
 *      so a confirmation that selected no scope at all had organization-wide
 *      assignment rows written on it. The scope is REQUIRED now, and a keep
 *      without one is refused and writes nothing.
 *   2. The keep's outcome was discarded by the entry the widget calls, so a
 *      keep the authority refused still answered as a plain success and the
 *      caller could not learn that nothing was persisted.
 *   3. The keep wrote the SUBMITTED ids rather than the confirmation's own
 *      selection. On the path with no recorded offer the confirmation drops a
 *      submitted id that its scored set does not carry, so a skill the
 *      recommender's cap excluded was inserted as a kept recommendation
 *      although the confirmation selected nothing of the sort.
 *
 * The confirm UI's scope OFFER is still not drawn: that half waits for the
 * maintainer's ruling on cinatra#2815.
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

const readRecommendationParkForRun = vi.fn();
const releaseRecommendationParkForRun = vi.fn();
const publishRecommendationHoldResume = vi.fn();
vi.mock("../recommendation-hold", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readRecommendationParkForRun: (...a: unknown[]) => readRecommendationParkForRun(...a),
  releaseRecommendationParkForRun: (...a: unknown[]) => releaseRecommendationParkForRun(...a),
  publishRecommendationHoldResume: (...a: unknown[]) => publishRecommendationHoldResume(...a),
}));

import {
  confirmRecommendationForActor,
  keepConfirmedRecommendationInScope,
  resolveRecommendationPersistenceScope,
  writeRunSkillSelectionForActor,
} from "../run-recommendation-core";

/** An organization administrator confirming their own interactive run. */
const who = {
  actor: { actorType: "human", source: "ui", userId: "user-1" },
  roleHints: { actorOrganizationId: "org-1", orgRole: "org_owner" },
};

const SNAPSHOT = {
  v: 1,
  orgId: "org-1",
  teamIds: [] as string[],
  originatingHumanUserId: "user-1",
};

function run(over: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    templateId: "tpl-1",
    orgId: "org-1",
    humanPresent: true,
    assignmentScopeSnapshot: SNAPSHOT,
    ...over,
  };
}

const ORG_SCOPE = { scopeKind: "organization" as const, scopeId: "org-1" };

const confirm = (over: Record<string, unknown> = {}) =>
  writeRunSkillSelectionForActor({
    runId: "run-1",
    confirmedSkillIds: ["skill-a"],
    who: who as never,
    keepRecommended: { scope: ORG_SCOPE },
    ...over,
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  readAgentRunById.mockResolvedValue(run());
  readAgentTemplateById.mockResolvedValue({ packageName: "@cinatra-ai/some-agent" });
  readRunCoOwners.mockResolvedValue([]);
  enforceRunAccess.mockResolvedValue(undefined);
  getAssignedSkillIdsForAgent.mockResolvedValue(["skill-a", "skill-b"]);
  confirmRunSkillSelection.mockResolvedValue({
    ok: true,
    written: 1,
    selection: [{ skillId: "skill-a", skillRevisionId: "rev-a", selectionSource: "x" }],
    efficacy: { accepted: ["skill-a"], rejected: [] },
  });
  insertAssignedSkill.mockResolvedValue({ outcome: "assigned" });
  readRecommendationParkForRun.mockResolvedValue(null);
  releaseRecommendationParkForRun.mockResolvedValue(undefined);
  publishRecommendationHoldResume.mockResolvedValue(undefined);
});

describe("a keep REQUIRES the scope it writes into", () => {
  it("has no default-scope arm left to reach", () => {
    // The resolver once answered a scopeless request with the narrowest
    // writable scope. That answer is what wrote organization-wide rows for a
    // confirmation that chose nothing, so it is gone.
    const verdict = resolveRecommendationPersistenceScope({
      snapshot: SNAPSHOT as never,
      writable: { actorUserId: "user-1", mayWrite: () => true, mayWriteWorkspace: false },
    } as never);
    expect(verdict).toEqual({ ok: false, reason: "scope-required" });
  });

  it("refuses a keep write that names no scope, and inserts nothing", async () => {
    const kept = await keepConfirmedRecommendationInScope({
      agentPackageName: "@cinatra-ai/some-agent",
      runId: "run-1",
      confirmedSkillIds: ["skill-a"],
      createdBy: "user-1",
      snapshot: SNAPSHOT as never,
      writable: { actorUserId: "user-1", mayWrite: () => true, mayWriteWorkspace: false },
      insert: insertAssignedSkill as never,
    } as never);
    expect(kept).toEqual({ ok: false, reason: "scope-required" });
    expect(insertAssignedSkill).not.toHaveBeenCalled();
  });

  it("refuses the keep at the shared write when the request carries an empty scope", async () => {
    const result = await confirm({ keepRecommended: {} });
    // The selection is an ordinary confirm and still lands.
    expect(result.ok).toBe(true);
    expect(confirmRunSkillSelection).toHaveBeenCalledTimes(1);
    // The keep does not.
    expect(insertAssignedSkill).not.toHaveBeenCalled();
    expect(result.kept).toEqual({ ok: false, reason: "scope-required" });
  });

  it("refuses a scope whose kind or id is not a usable string", async () => {
    const result = await confirm({
      keepRecommended: { scope: { scopeKind: "organization", scopeId: "  " } },
    });
    expect(insertAssignedSkill).not.toHaveBeenCalled();
    expect(result.kept).toEqual({ ok: false, reason: "scope-required" });
  });

  it("still writes the keep when the confirmation names its scope", async () => {
    const result = await confirm();
    expect(result.kept).toMatchObject({ ok: true, scope: ORG_SCOPE, written: 1 });
    expect(insertAssignedSkill).toHaveBeenCalledTimes(1);
  });
});

describe("the keep outcome reaches the caller of the decision entry", () => {
  it("carries a REFUSED keep onto the decision's own answer", async () => {
    const writeSelection = vi.fn().mockResolvedValue({
      ok: true,
      kept: { ok: false, reason: "no-writable-scope" },
    });
    const result = await confirmRecommendationForActor({
      runId: "run-1",
      confirmedSkillIds: ["skill-a"],
      who: who as never,
      writeSelection: writeSelection as never,
      keepRecommended: { scope: ORG_SCOPE },
    } as never);
    expect(result).toMatchObject({
      ok: true,
      kept: { ok: false, reason: "no-writable-scope" },
    });
  });

  it("carries a WRITTEN keep just the same", async () => {
    const writeSelection = vi.fn().mockResolvedValue({
      ok: true,
      kept: { ok: true, scope: ORG_SCOPE, written: 2, skipped: [] },
    });
    const result = await confirmRecommendationForActor({
      runId: "run-1",
      confirmedSkillIds: ["skill-a"],
      who: who as never,
      writeSelection: writeSelection as never,
      keepRecommended: { scope: ORG_SCOPE },
    } as never);
    expect(result).toMatchObject({
      kept: { ok: true, scope: ORG_SCOPE, written: 2, skipped: [] },
    });
  });

  it("says nothing about a keep the caller never asked for", async () => {
    const writeSelection = vi.fn().mockResolvedValue({ ok: true });
    const result = await confirmRecommendationForActor({
      runId: "run-1",
      confirmedSkillIds: ["skill-a"],
      who: who as never,
      writeSelection: writeSelection as never,
    } as never);
    expect(result).not.toHaveProperty("kept");
  });
});

describe("the keep writes the CONFIRMATION'S selection, not the submitted ids", () => {
  it("skips a submitted id the confirmation did not select", async () => {
    // The no-recorded-offer path scores at confirm time and drops an id its
    // scored set does not carry. `skill-b` is assigned and was submitted, and
    // the confirmation selected nothing for it, so keeping it would persist a
    // recommendation nobody accepted.
    confirmRunSkillSelection.mockResolvedValue({
      ok: true,
      written: 1,
      selection: [{ skillId: "skill-a", skillRevisionId: "rev-a", selectionSource: "x" }],
      efficacy: { accepted: ["skill-a"], rejected: [] },
    });
    const result = await confirm({ confirmedSkillIds: ["skill-a", "skill-b"] });
    expect(insertAssignedSkill).toHaveBeenCalledTimes(1);
    expect(insertAssignedSkill.mock.calls[0][0]).toMatchObject({ skillId: "skill-a" });
    expect(result.kept).toMatchObject({ ok: true, written: 1, skipped: ["skill-b"] });
  });

  it("keeps nothing at all when the confirmation selected nothing", async () => {
    confirmRunSkillSelection.mockResolvedValue({
      ok: true,
      written: 0,
      selection: [],
      efficacy: { accepted: [], rejected: ["skill-a"] },
    });
    const result = await confirm();
    expect(insertAssignedSkill).not.toHaveBeenCalled();
    expect(result.kept).toMatchObject({ ok: true, written: 0, skipped: ["skill-a"] });
  });

  it("never keeps a selected skill the run's scopes do not allow", async () => {
    getAssignedSkillIdsForAgent.mockResolvedValue(["skill-a"]);
    confirmRunSkillSelection.mockResolvedValue({
      ok: true,
      written: 2,
      selection: [
        { skillId: "skill-a", skillRevisionId: "rev-a", selectionSource: "x" },
        { skillId: "skill-z", skillRevisionId: "rev-z", selectionSource: "x" },
      ],
      efficacy: { accepted: ["skill-a"], rejected: [] },
    });
    await confirm();
    expect(insertAssignedSkill).toHaveBeenCalledTimes(1);
    expect(insertAssignedSkill.mock.calls[0][0]).toMatchObject({ skillId: "skill-a" });
  });
});

type ConfirmAction = typeof import("../server-actions").confirmRunSkillSelectionAction;

describe("the session action carries the same two answers", () => {
  it("declares the keep outcome on its own result, so a reader can see it", () => {
    // A COMPILE-TIME pin as much as a runtime one: the action used to declare a
    // result shape with no keep field at all, so the outcome the write produced
    // could not be read through it even though it was there. The type-only
    // import loads no module, which is what keeps this a pin on the CONTRACT.
    const result: Awaited<ReturnType<ConfirmAction>> = {
      ok: true,
      written: 1,
      efficacy: { accepted: [], rejected: [] },
      kept: { ok: false, reason: "no-writable-scope" },
    };
    expect(result.kept).toEqual({ ok: false, reason: "no-writable-scope" });
  });

  it("declares a keep request that must name its scope", () => {
    const input: Parameters<ConfirmAction>[0] = {
      runId: "run-1",
      agentPackageName: "@cinatra-ai/some-agent",
      confirmedSkillIds: ["skill-a"],
      keepRecommended: { scope: ORG_SCOPE },
    };
    expect(input.keepRecommended?.scope).toEqual(ORG_SCOPE);
  });
});
