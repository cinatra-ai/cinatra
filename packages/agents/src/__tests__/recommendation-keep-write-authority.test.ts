/**
 * A KEEP IS AN ASSIGNMENT WRITE, AND THE ASSIGNMENT AUTHORITY DECIDES IT
 * (cinatra#2815 S3 part 4, epic #2812).
 *
 * The epic states the rule in one sentence: whoever writes an assignment must
 * ADMINISTER the scope it affects. `src/lib/authz/assignment-authority.ts` is
 * where that rule lives, and it wants an organization owner or admin, a team
 * admin, or a project owner or admin. The keep asked a different question:
 * whether the confirmer BELONGS to the scope. So an ordinary member of the
 * run's organization could have `source=recommended` organization assignments
 * written on their confirm.
 *
 * The workspace tier has no grant road at all. A platform administrator reaches
 * it only through the audited bypass, which writes its audit row BEFORE the
 * mutation; a direct insert is exactly what that convention exists to prevent.
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

const withPlatformAdminBypass = vi.fn();
vi.mock("@/lib/authz/admin-bypass", () => ({
  withPlatformAdminBypass: (...args: unknown[]) => withPlatformAdminBypass(...args),
}));

import { WORKSPACE_SCOPE_SENTINEL } from "@/lib/assignment-scope";
import { writeRunSkillSelectionForActor } from "../run-recommendation-core";

const ORG = "org-1";

function who(roleHints: Record<string, unknown>) {
  return {
    actor: { actorType: "human", source: "ui", userId: "user-1" },
    roleHints: { actorOrganizationId: ORG, ...roleHints },
  };
}

function run(over: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    templateId: "tpl-1",
    orgId: ORG,
    humanPresent: true,
    assignmentScopeSnapshot: { v: 1, orgId: ORG, teamIds: ["team-a"], projectId: "proj-1" },
    ...over,
  };
}

const confirm = (roleHints: Record<string, unknown>, keep: Record<string, unknown>) =>
  writeRunSkillSelectionForActor({
    runId: "run-1",
    confirmedSkillIds: ["skill-a"],
    who: who(roleHints) as never,
    keepRecommended: keep,
  } as never);

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
    // cinatra#2815 S3 part 4: the confirm ALWAYS answers with the selection it
    // resolved, and the keep now writes THAT rather than the submitted ids.
    // This mock omitted the field the real function always returns, so it could
    // no longer stand in for it.
    selection: [{ skillId: "skill-a", skillRevisionId: "rev-a", selectionSource: "x" }],
    efficacy: { accepted: ["skill-a"], rejected: [] },
  });
  insertAssignedSkill.mockResolvedValue({ outcome: "assigned" });
  withPlatformAdminBypass.mockResolvedValue({ auditEventId: "audit-1" });
});

describe("membership is not assignment-write authority", () => {
  it("refuses an ORGANIZATION keep from an ordinary member of that organization", async () => {
    const result = await confirm(
      { orgRole: "member" },
      { scope: { scopeKind: "organization", scopeId: ORG } },
    );
    expect(result.ok).toBe(true);
    expect(insertAssignedSkill).not.toHaveBeenCalled();
    expect(result.kept).toEqual({ ok: false, reason: "no-writable-scope" });
  });

  it("allows it for an organization ADMIN of that same organization", async () => {
    const result = await confirm(
      { orgRole: "org_admin" },
      { scope: { scopeKind: "organization", scopeId: ORG } },
    );
    expect(result.kept).toMatchObject({ ok: true });
    expect(insertAssignedSkill).toHaveBeenCalledTimes(1);
  });

  it("refuses a TEAM keep from a plain team member", async () => {
    const result = await confirm(
      { teamIds: ["team-a"], teamRoles: { "team-a": "member" } },
      { scope: { scopeKind: "team", scopeId: "team-a" } },
    );
    expect(insertAssignedSkill).not.toHaveBeenCalled();
    expect(result.kept).toEqual({ ok: false, reason: "no-writable-scope" });
  });

  it("allows it for a team ADMIN", async () => {
    const result = await confirm(
      { teamIds: ["team-a"], teamRoles: { "team-a": "team_admin" } },
      { scope: { scopeKind: "team", scopeId: "team-a" } },
    );
    expect(result.kept).toMatchObject({ ok: true });
  });

  it("refuses a PROJECT keep from a project reader", async () => {
    const result = await confirm(
      { projectGrants: [{ projectId: "proj-1", effectiveRole: "read" }] },
      { scope: { scopeKind: "project", scopeId: "proj-1" } },
    );
    expect(insertAssignedSkill).not.toHaveBeenCalled();
    expect(result.kept).toEqual({ ok: false, reason: "no-writable-scope" });
  });

  it("allows it for a project ADMIN", async () => {
    const result = await confirm(
      { projectGrants: [{ projectId: "proj-1", effectiveRole: "admin" }] },
      { scope: { scopeKind: "project", scopeId: "proj-1" } },
    );
    expect(result.kept).toMatchObject({ ok: true });
  });
});

describe("a workspace keep travels the audited bypass", () => {
  it("writes the audit row BEFORE the first insert", async () => {
    const order: string[] = [];
    withPlatformAdminBypass.mockImplementation(async () => {
      order.push("audit");
      return { auditEventId: "audit-1" };
    });
    insertAssignedSkill.mockImplementation(async () => {
      order.push("insert");
      return { outcome: "assigned" };
    });
    const result = await confirm(
      { platformRole: "platform_admin" },
      { scope: { scopeKind: "workspace", scopeId: WORKSPACE_SCOPE_SENTINEL } },
    );
    expect(result.kept).toMatchObject({ ok: true });
    expect(order).toEqual(["audit", "insert"]);
    expect(withPlatformAdminBypass).toHaveBeenCalledTimes(1);
    expect(withPlatformAdminBypass.mock.calls[0][3]).toBe("workspace_configuration");
  });

  it("writes nothing when the audited road refuses", async () => {
    withPlatformAdminBypass.mockRejectedValue(new Error("forbidden"));
    const result = await confirm(
      { platformRole: "platform_admin" },
      { scope: { scopeKind: "workspace", scopeId: WORKSPACE_SCOPE_SENTINEL } },
    );
    expect(result.ok).toBe(true);
    expect(insertAssignedSkill).not.toHaveBeenCalled();
    expect(result.kept).toEqual({ ok: false, reason: "workspace-audit-unavailable" });
  });
});
