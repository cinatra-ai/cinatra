/**
 * cinatra#2815 S3 part (4): the WORKSPACE layer of the offered keep set is
 * decided by the verified actor's platform role, not refused by construction.
 *
 * Every store the selection write touches is mocked, so what is under test is
 * the authority derivation and the refusals around it, never the store.
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

// The workspace tier's AUDITED ROAD (cinatra#2813 S1): the keep now travels
// `withPlatformAdminBypass` with the `workspace_configuration` reason, which
// writes its audit row before the mutation. Mocked here because this suite's
// subject is the AUTHORITY, not the audit store.
const withPlatformAdminBypass = vi.fn();
vi.mock("@/lib/authz/admin-bypass", () => ({
  withPlatformAdminBypass: (...args: unknown[]) => withPlatformAdminBypass(...args),
}));

import { WORKSPACE_SCOPE_SENTINEL } from "@/lib/assignment-scope";
import type { AssignmentScope } from "@/lib/assignment-scope";
import {
  offeredRecommendationScopes,
  writeRunSkillSelectionForActor,
} from "../run-recommendation-core";

const WORKSPACE: AssignmentScope = {
  scopeKind: "workspace",
  scopeId: WORKSPACE_SCOPE_SENTINEL,
};

/** The run the confirm resolves: started by `user-1`, in `org-1`, no project
 *  and no teams, so the WORKSPACE layer is the only one the platform role can
 *  add for a confirmer who holds nothing else. */
const runRow = (over: Record<string, unknown> = {}) => ({
  id: "run-1",
  templateId: "tpl-1",
  orgId: "org-1",
  // A keep is an INTERACTIVE act (cinatra#2815 S3 part 4); the run-mode rule
  // has its own fixtures.
  humanPresent: true,
  assignmentScopeSnapshot: {
    v: 1,
    orgId: "org-1",
    teamIds: [],
    originatingHumanUserId: "user-1",
  },
  ...over,
});

const actor = (over: Record<string, unknown> = {}) => ({
  actor: { actorType: "human", source: "ui", userId: "user-1" },
  roleHints: { actorOrganizationId: "org-1", ...over },
});

const confirm = (over: Record<string, unknown> = {}) =>
  writeRunSkillSelectionForActor({
    runId: "run-1",
    confirmedSkillIds: ["skill-a"],
    who: actor({ platformRole: "platform_admin" }) as never,
    keepRecommended: { scope: WORKSPACE },
    ...over,
  });

beforeEach(() => {
  vi.clearAllMocks();
  withPlatformAdminBypass.mockResolvedValue({ auditEventId: "audit-1" });
  readAgentRunById.mockResolvedValue(runRow());
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

describe("the workspace layer of a recommendation keep", () => {
  it("a PLATFORM ADMINISTRATOR confirming their own run lands the keep at workspace", async () => {
    const result = await confirm();
    expect(result.ok).toBe(true);
    expect(result.kept).toMatchObject({ ok: true, scope: WORKSPACE, written: 1 });
    expect(insertAssignedSkill).toHaveBeenCalledWith({
      agentPackageName: "@cinatra-ai/some-agent",
      skillId: "skill-a",
      createdBy: "user-1",
      scope: WORKSPACE,
      source: "recommended",
      originRunId: "run-1",
    });
  });

  it("a MEMBER is not offered workspace, and a requested workspace scope is REFUSED", async () => {
    const result = await confirm({ who: actor({ platformRole: "member" }) });
    // The run's own selection still lands: a keep that finds no scope refuses
    // the keep, never the selection.
    expect(result.ok).toBe(true);
    expect(result.kept).toEqual({ ok: false, reason: "scope-not-offered" });
    expect(insertAssignedSkill).not.toHaveBeenCalled();
  });

  it("FAIL-CLOSED: an absent platform-role hint is not workspace authority", async () => {
    const result = await confirm({ who: actor() });
    expect(result.kept).toEqual({ ok: false, reason: "scope-not-offered" });
    expect(insertAssignedSkill).not.toHaveBeenCalled();
  });

  it("a MEMBER keeping in their own personal scope still lands it, unchanged", async () => {
    // These two cases asserted the DEFAULT until cinatra#2815 S3 part 4: a keep
    // that named no scope was answered with the narrowest writable one. That
    // default wrote real rows for a confirmation that chose nowhere, so it is
    // gone and a scopeless keep is refused. What the cases really pin survives:
    // the personal scope is reachable for a member, and it stays FIRST in the
    // offered order even once workspace joins the set, which is what a chooser
    // preselects.
    const result = await confirm({
      who: actor({ platformRole: "member" }),
      keepRecommended: { scope: { scopeKind: "user", scopeId: "user-1" } },
    });
    expect(result.kept).toMatchObject({
      ok: true,
      scope: { scopeKind: "user", scopeId: "user-1" },
      written: 1,
    });
  });

  it("a PLATFORM ADMINISTRATOR's NARROWEST writable scope is still offered first", async () => {
    // Workspace joins the offered set, but it joins it LAST.
    const offered = offeredRecommendationScopes({
      snapshot: runRow().assignmentScopeSnapshot as never,
      writable: {
        actorUserId: "user-1",
        mayWrite: (scope) => scope.scopeKind === "user" && scope.scopeId === "user-1",
        mayWriteWorkspace: true,
      },
    });
    expect(offered[0]).toEqual({ scopeKind: "user", scopeId: "user-1" });
    expect(offered.at(-1)).toEqual(WORKSPACE);
  });

  it("refuses a keep that names no scope at all, and writes nothing", async () => {
    const result = await confirm({ keepRecommended: {} });
    expect(result.kept).toEqual({ ok: false, reason: "scope-required" });
    expect(insertAssignedSkill).not.toHaveBeenCalled();
  });

  it("a FOREIGN confirmer is still refused the PERSONAL scope, platform role or not", async () => {
    readAgentRunById.mockResolvedValue(
      runRow({
        humanPresent: true,
        assignmentScopeSnapshot: {
          v: 1,
          orgId: "org-1",
          teamIds: [],
          originatingHumanUserId: "someone-else",
        },
      }),
    );
    const result = await confirm({
      keepRecommended: { scope: { scopeKind: "user", scopeId: "user-1" } },
    });
    expect(result.kept).toEqual({ ok: false, reason: "scope-not-offered" });
    expect(insertAssignedSkill).not.toHaveBeenCalled();
  });
});
