/**
 * cinatra#2815 S3 part (4): the keep's SCOPE is decided BEFORE the selection
 * write, never after it.
 *
 * `readAssignmentScopeSnapshot` throws when the persisted payload is unusable
 * and no durable organization can be named. Read after the write, that throw
 * reached the outer catch and the caller was told the confirm failed while the
 * run's selection had already been committed. These fixtures pin the order.
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
  RECOMMENDATION_SCOPE_UNDECIDABLE_CODE,
  RECOMMENDATION_SCOPE_UNDECIDABLE_REFUSAL,
} from "../recommendation-hold";

/** A run whose frozen payload is unusable AND that can name no organization of
 *  its own. That is the one state in which the scope is undecidable rather
 *  than merely narrow. */
const undecidableRun = {
  id: "run-1",
  templateId: "tpl-1",
  orgId: null,
  // A keep is an INTERACTIVE act (cinatra#2815 S3 part 4), so every run in this
  // suite is one. The run-mode rule has its own fixtures.
  humanPresent: true,
  assignmentScopeSnapshot: "not a snapshot",
};

const usableRun = {
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
};

/** The actor names no organization either, so nothing can stand in for the
 *  run's own. */
const who = {
  actor: { actorType: "human", source: "ui", userId: "user-1" },
  roleHints: { actorOrganizationId: null },
};

const confirm = (over: Record<string, unknown> = {}) =>
  writeRunSkillSelectionForActor({
    runId: "run-1",
    confirmedSkillIds: ["skill-a"],
    who: who as never,
    // cinatra#2815 S3 part 4: a keep NAMES its scope. This fixture asked for
    // one with no scope at all, which the road used to answer with the
    // narrowest writable one; it is refused now, and these cases are about the
    // run's mode and its tenancy, so they name the one scope this actor can
    // actually write, which is the one the default used to pick for them.
    keepRecommended: { scope: { scopeKind: "user" as const, scopeId: "user-1" } },
    ...over,
  });

beforeEach(() => {
  vi.clearAllMocks();
  readAgentRunById.mockResolvedValue(undecidableRun);
  readAgentTemplateById.mockResolvedValue({ packageName: "@cinatra-ai/some-agent" });
  readRunCoOwners.mockResolvedValue([]);
  enforceRunAccess.mockResolvedValue(undefined);
  getAssignedSkillIdsForAgent.mockResolvedValue(["skill-a"]);
  confirmRunSkillSelection.mockResolvedValue({
    ok: true,
    written: 1,
    // cinatra#2815 S3 part 4: the confirm ALWAYS answers with the selection it
    // resolved, and the keep now writes THAT rather than the submitted ids.
    // This mock omitted the field the real function always returns, so it could
    // no longer stand in for it.
    selection: [{ skillId: "skill-a", skillRevisionId: "rev-a", selectionSource: "x" }],
    efficacy: { accepted: ["skill-a"], rejected: [] },
  });
  insertAssignedSkill.mockResolvedValue({ outcome: "assigned" });
});

describe("an undecidable assignment scope on a confirm that asks for a keep", () => {
  it("refuses BEFORE the selection write, and commits nothing", async () => {
    const result = await confirm();
    expect(confirmRunSkillSelection).not.toHaveBeenCalled();
    expect(insertAssignedSkill).not.toHaveBeenCalled();
    expect(result.written).toBe(0);
  });

  it("NAMES the refusal in the result instead of the generic denial", async () => {
    const result = await confirm();
    expect(result.ok).toBe(false);
    // The typed code is pinned as a literal as well as compared, so an absent
    // export cannot quietly match an absent field.
    expect(RECOMMENDATION_SCOPE_UNDECIDABLE_CODE).toBe("recommendation_scope_undecidable");
    expect(typeof RECOMMENDATION_SCOPE_UNDECIDABLE_REFUSAL).toBe("string");
    expect(result.refusalCode).toBe(RECOMMENDATION_SCOPE_UNDECIDABLE_CODE);
    expect(result.refusal).toBe(RECOMMENDATION_SCOPE_UNDECIDABLE_REFUSAL);
  });

  it("is the KEEP'S business only: a confirm that asks for none still writes", async () => {
    const result = await confirm({ keepRecommended: undefined });
    expect(confirmRunSkillSelection).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, written: 1 });
    expect(result.refusalCode).toBeUndefined();
  });

  it("an unusable payload that CAN name a durable organization still falls back", async () => {
    // The sole legacy fallback (workspace plus the durable organization) is
    // a decided scope, not an undecidable one. The confirm proceeds.
    readAgentRunById.mockResolvedValue({
      ...undecidableRun,
      orgId: "org-1",
    });
    const result = await confirm();
    expect(confirmRunSkillSelection).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    // The fallback names no originating human and no project or team, so a
    // member holds nothing writable in it.
    expect(result.kept).toEqual({ ok: false, reason: "no-writable-scope" });
  });
});

describe("a usable snapshot", () => {
  it("keeps the landed behaviour exactly: the write lands and the keep lands", async () => {
    readAgentRunById.mockResolvedValue(usableRun);
    const result = await confirm({
      who: { ...who, roleHints: { actorOrganizationId: "org-1" } },
    });
    expect(confirmRunSkillSelection).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, written: 1 });
    expect(result.refusalCode).toBeUndefined();
    expect(result.kept).toMatchObject({
      ok: true,
      scope: { scopeKind: "user", scopeId: "user-1" },
      written: 1,
    });
  });
});
