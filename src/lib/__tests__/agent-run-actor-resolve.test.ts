// cinatra#408 — the OBO actor resolver's platform-admin SUPPRESSION for the
// public-site widget path, plus the load-bearing END-TO-END actor assertion
// (design test #13a): for a `public_site_widget` carrier run the actor handed
// to the MCP boundary / token mint is NEVER `platform_admin`, only `member`
// (or null). Resolver-only suppression (codex-converged O2) means the boundary's
// platform-admin immediate-allow is never reached for this path.
//
// The drizzle chain `betterAuthDb.select().from(<table>).where().limit()` is
// stubbed: the FIRST query reads betterAuthUsers (role row), the SECOND reads
// betterAuthMembers (membership row). We discriminate by the table passed to
// `from()` so a single resolver call drives both reads deterministically.

import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted; share the table sentinels + mutable fixture holder via
// vi.hoisted so the factory can reference them without a TDZ error.
const { USERS, MEMBERS, fixtures, buildActorContextFromRunMock } = vi.hoisted(() => ({
  USERS: { id: "users.id", role: "users.role" } as const,
  MEMBERS: {
    id: "members.id",
    userId: "members.userId",
    organizationId: "members.organizationId",
  } as const,
  fixtures: {
    userRow: undefined as { id: string; role: string | null } | undefined,
    memberRow: undefined as { id: string } | undefined,
  },
  // #1401 — resolveAssignedSkillsActorForRun composes the REAL
  // resolveAgentRunMcpActor gate (driven by the better-auth-db mock above) with
  // this stubbed membership-expansion builder.
  buildActorContextFromRunMock: vi.fn(),
}));

vi.mock("@/lib/better-auth-db", () => ({
  readOrganizationNameForUser: vi.fn(async () => null),
  listOrganizationsForUser: vi.fn(async () => []),
  betterAuthDb: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: () =>
            Promise.resolve(
              table === USERS
                ? fixtures.userRow
                  ? [fixtures.userRow]
                  : []
                : fixtures.memberRow
                  ? [fixtures.memberRow]
                  : [],
            ),
        }),
      }),
    }),
  },
  betterAuthUsers: USERS,
  betterAuthMembers: MEMBERS,
}));

vi.mock("@/lib/authz/build-actor-context-from-run", () => ({
  buildActorContextFromRun: buildActorContextFromRunMock,
}));

import {
  resolveAgentRunMcpActor,
  resolveAssignedSkillsActorForRun,
} from "@/lib/agent-run-actor-resolve";

const TRIPLE = { runId: "run_1", runBy: "u_1", orgId: "org_1" };

// Convenience accessors so the test bodies stay readable.
function setUser(row: { id: string; role: string | null } | undefined): void {
  fixtures.userRow = row;
}
function setMember(row: { id: string } | undefined): void {
  fixtures.memberRow = row;
}

beforeEach(() => {
  fixtures.userRow = undefined;
  fixtures.memberRow = undefined;
});

describe("resolveAgentRunMcpActor — platform-admin (default path, unchanged)", () => {
  it("returns platform_admin for an admin user regardless of membership (no sourceType)", async () => {
    setUser({ id: "u_1", role: "admin" });
    setMember(undefined); // not a member
    const actor = await resolveAgentRunMcpActor(TRIPLE);
    expect(actor?.platformRole).toBe("platform_admin");
  });

  it("returns platform_admin for an admin user on a NON-widget sourceType", async () => {
    setUser({ id: "u_1", role: "admin" });
    const actor = await resolveAgentRunMcpActor({ ...TRIPLE, sourceType: "content_editor_dispatch" });
    expect(actor?.platformRole).toBe("platform_admin");
  });

  it("returns member for a non-admin member", async () => {
    setUser({ id: "u_1", role: "user" });
    setMember({ id: "m_1" });
    const actor = await resolveAgentRunMcpActor(TRIPLE);
    expect(actor?.platformRole).toBe("member");
  });

  it("returns null for a non-admin non-member (boundary denies, never elevates)", async () => {
    setUser({ id: "u_1", role: "user" });
    setMember(undefined);
    const actor = await resolveAgentRunMcpActor(TRIPLE);
    expect(actor).toBeNull();
  });
});

describe("resolveAgentRunMcpActor — public_site_widget suppression (cinatra#408)", () => {
  it("SUPPRESSES platform_admin for an admin user on the widget path → resolves member (if a member)", async () => {
    setUser({ id: "u_1", role: "admin" }); // platform admin...
    setMember({ id: "m_1" }); // ...who IS also an org member
    const actor = await resolveAgentRunMcpActor({ ...TRIPLE, sourceType: "public_site_widget" });
    // The admin short-circuit is suppressed; they resolve as a plain member,
    // gated by per-user rights downstream (#409) — NOT platform_admin.
    expect(actor?.platformRole).toBe("member");
    expect(actor?.platformRole).not.toBe("platform_admin");
  });

  it("an admin who is NOT an org member resolves to null on the widget path (denied, no bypass)", async () => {
    setUser({ id: "u_1", role: "admin" });
    setMember(undefined); // not a member of this org
    const actor = await resolveAgentRunMcpActor({ ...TRIPLE, sourceType: "public_site_widget" });
    expect(actor).toBeNull();
  });

  it("a comma-roled admin (e.g. 'user,admin') is ALSO suppressed on the widget path", async () => {
    setUser({ id: "u_1", role: "user,admin" });
    setMember({ id: "m_1" });
    const actor = await resolveAgentRunMcpActor({ ...TRIPLE, sourceType: "public_site_widget" });
    expect(actor?.platformRole).toBe("member");
  });

  // ---- design test #13a — the LOAD-BEARING end-to-end actor assertion --------
  it("(#13a) the actor object reaching the MCP boundary is NOT platform_admin for a public_site_widget run", async () => {
    setUser({ id: "u_1", role: "admin" });
    setMember({ id: "m_1" });
    const actor = await resolveAgentRunMcpActor({ ...TRIPLE, sourceType: "public_site_widget" });
    // This is the exact object handed to buildLlmMcpServerToolForAgentRun →
    // enforceMcpBoundary. Asserting on the ACTOR (not merely "resolver returned
    // member") proves the boundary's platform-admin immediate-allow
    // (mcp-boundary.ts:207) is never reached for this path.
    expect(actor).not.toBeNull();
    expect(actor!.platformRole).not.toBe("platform_admin");
    expect(actor!.userId).toBe("u_1");
    expect(actor!.delegation).toBe("agent_run");
  });
});

// ---------------------------------------------------------------------------
// #1401 — resolveAssignedSkillsActorForRun: the trustworthy actor for
// llm-bridge assigned-skill delivery. Drives the REAL resolveAgentRunMcpActor
// gate via the better-auth-db mock (setUser/setMember) and stubs the
// membership-expansion builder, so these assertions pin the security-critical
// composition: live-membership gating + cinatra#408 platform-admin suppression
// + fail-closed fallback.
// ---------------------------------------------------------------------------
const RUN = { id: "run_1", runBy: "u_1", orgId: "org_1" };
// The builder's expanded actor. platformRole is deliberately "platform_admin"
// so the gate's suppression-aware override is OBSERVABLE (a member/widget owner
// must end up "member" regardless of what the builder returns).
const EXPANDED = {
  principalType: "HumanUser" as const,
  principalId: "u_1",
  organizationId: "org_1",
  teamIds: ["team_1"],
  projectIds: ["proj_1"],
  platformRole: "platform_admin" as const,
  orgRole: "member" as const,
  authSource: "a2a" as const,
  policyVersion: "v2",
};

describe("resolveAssignedSkillsActorForRun — live-membership gate (#1401)", () => {
  beforeEach(() => {
    buildActorContextFromRunMock.mockReset();
    buildActorContextFromRunMock.mockResolvedValue({ ...EXPANDED });
  });

  it("nonmember non-admin owner → undefined; the fresh gate (evaluated LAST) discards the built actor (TOCTOU pin)", async () => {
    setUser({ id: "u_1", role: "user" });
    setMember(undefined); // removed from / never in the run's org (fresh read)
    // The builder returns a full org_1-bearing actor (as it would if membership
    // held at build time); the gate is evaluated LAST, so a revoked/absent
    // membership at the FRESHEST read discards it — org/workspace rows for
    // run.orgId are never returned to a nonmember.
    const actor = await resolveAssignedSkillsActorForRun(RUN);
    expect(actor).toBeUndefined();
    expect(buildActorContextFromRunMock).toHaveBeenCalledOnce();
  });

  it("member owner → expanded actor built from ONLY the run's own fields", async () => {
    setUser({ id: "u_1", role: "user" });
    setMember({ id: "m_1" });
    const actor = await resolveAssignedSkillsActorForRun({
      ...RUN,
      dependentInstallId: "inst_7",
    });
    expect(actor).toBeDefined();
    // Built from the trusted run projection only — no caller identity (#4).
    expect(buildActorContextFromRunMock).toHaveBeenCalledWith({
      id: "run_1",
      runBy: "u_1",
      orgId: "org_1",
      dependentInstallId: "inst_7",
    });
    expect(actor!.teamIds).toEqual(["team_1"]);
    // Gate resolved "member" → platformRole floored to member (override).
    expect(actor!.platformRole).toBe("member");
  });

  it("dependentInstallId defaults to null when the run carries none", async () => {
    setUser({ id: "u_1", role: "user" });
    setMember({ id: "m_1" });
    await resolveAssignedSkillsActorForRun(RUN);
    expect(buildActorContextFromRunMock).toHaveBeenCalledWith({
      id: "run_1",
      runBy: "u_1",
      orgId: "org_1",
      dependentInstallId: null,
    });
  });

  it("platform-admin owner on a NON-widget run → actor carries platform_admin", async () => {
    setUser({ id: "u_1", role: "admin" });
    setMember(undefined); // admin short-circuits the member check
    const actor = await resolveAssignedSkillsActorForRun({
      ...RUN,
      sourceType: "content_editor_dispatch",
    });
    expect(actor?.platformRole).toBe("platform_admin");
  });

  it("public_site_widget owned by a platform admin → platformRole floored to member (cinatra#408)", async () => {
    setUser({ id: "u_1", role: "admin" }); // global platform admin...
    setMember({ id: "m_1" }); // ...who is also a member
    const actor = await resolveAssignedSkillsActorForRun({
      ...RUN,
      sourceType: "public_site_widget",
    });
    // Even though the builder returned platform_admin, the widget carrier must
    // NOT admin-bypass the scoped-skill visibility filter.
    expect(actor).toBeDefined();
    expect(actor!.platformRole).toBe("member");
    expect(actor!.platformRole).not.toBe("platform_admin");
  });

  it("public_site_widget owned by an admin who is NOT a member → undefined (denied, no bypass)", async () => {
    setUser({ id: "u_1", role: "admin" });
    setMember(undefined);
    const actor = await resolveAssignedSkillsActorForRun({
      ...RUN,
      sourceType: "public_site_widget",
    });
    expect(actor).toBeUndefined();
    // Built then discarded by the fresh gate (build-then-gate ordering).
    expect(buildActorContextFromRunMock).toHaveBeenCalledOnce();
  });

  it("worker-originated run (runBy === null) → undefined; gate/builder never called (pre-check short-circuit)", async () => {
    setUser({ id: "u_1", role: "user" });
    setMember({ id: "m_1" });
    const actor = await resolveAssignedSkillsActorForRun({ ...RUN, runBy: null });
    expect(actor).toBeUndefined();
    expect(buildActorContextFromRunMock).not.toHaveBeenCalled();
  });

  it.each([
    ["null run", null],
    ["undefined run", undefined],
  ])("%s → undefined", async (_label, run) => {
    const actor = await resolveAssignedSkillsActorForRun(run as null | undefined);
    expect(actor).toBeUndefined();
    expect(buildActorContextFromRunMock).not.toHaveBeenCalled();
  });

  it("empty orgId → undefined (cannot anchor scope)", async () => {
    setUser({ id: "u_1", role: "user" });
    setMember({ id: "m_1" });
    const actor = await resolveAssignedSkillsActorForRun({ ...RUN, orgId: "" });
    expect(actor).toBeUndefined();
    expect(buildActorContextFromRunMock).not.toHaveBeenCalled();
  });

  it("builder failure → undefined (fail-closed, not a partial actor)", async () => {
    setUser({ id: "u_1", role: "user" });
    setMember({ id: "m_1" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    buildActorContextFromRunMock.mockRejectedValueOnce(new Error("membership DB down"));
    const actor = await resolveAssignedSkillsActorForRun(RUN);
    expect(actor).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
