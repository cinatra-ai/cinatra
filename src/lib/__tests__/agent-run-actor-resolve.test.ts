// The OBO actor resolver.
//
// cinatra#408 SUPPRESSED the platform-admin short-circuit for the
// `public_site_widget` carrier path; cinatra#2674 (epic #2564 S8e) REMOVED that
// suppression, in the change set that removed its justification — the embedding
// site's possession of the widget bearer. The assertions below are the parity
// leg of #2674's AC: a widget carrier run resolves the SAME standing the same
// person's run resolves on any other source type, and an ordinary member is not
// elevated by the removal.
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

describe("resolveAgentRunMcpActor — the widget carrier resolves real standing (cinatra#2674)", () => {
  it("an admin MEMBER on the widget path resolves platform_admin, as on any other source", async () => {
    setUser({ id: "u_1", role: "admin" });
    setMember({ id: "m_1" });
    const widget = await resolveAgentRunMcpActor({
      ...TRIPLE,
      sourceType: "public_site_widget",
    });
    const other = await resolveAgentRunMcpActor({
      ...TRIPLE,
      sourceType: "content_editor_dispatch",
    });
    expect(widget?.platformRole).toBe("platform_admin");
    expect(widget).toEqual(other);
  });

  it("but an admin who is NO LONGER A MEMBER is denied on the widget path (codex round 0, finding 2)", async () => {
    // The removed suppression was also, incidentally, requiring a live
    // membership row here. Dropping it wholesale would have let a platform admin
    // removed from the org keep authorizing an in-flight widget carrier run —
    // a revocation bypass, not parity. The tier is carried; the check is kept.
    setUser({ id: "u_1", role: "admin" });
    setMember(undefined);
    expect(
      await resolveAgentRunMcpActor({ ...TRIPLE, sourceType: "public_site_widget" }),
    ).toBeNull();
    // NEGATIVE CONTROL — on a NON-widget carrier the same admin still
    // short-circuits, because an operator acts across orgs they do not belong to.
    expect(
      (await resolveAgentRunMcpActor({ ...TRIPLE, sourceType: "content_editor_dispatch" }))
        ?.platformRole,
    ).toBe("platform_admin");
  });

  it("a comma-roled admin ('user,admin') resolves the same way on the widget path", async () => {
    setUser({ id: "u_1", role: "user,admin" });
    setMember({ id: "m_1" });
    const actor = await resolveAgentRunMcpActor({ ...TRIPLE, sourceType: "public_site_widget" });
    expect(actor?.platformRole).toBe("platform_admin");
  });

  it("NEGATIVE CONTROL: an ordinary user on the widget path is NOT elevated", async () => {
    setUser({ id: "u_1", role: "user" });
    setMember({ id: "m_1" });
    const actor = await resolveAgentRunMcpActor({ ...TRIPLE, sourceType: "public_site_widget" });
    expect(actor?.platformRole).toBe("member");
  });

  it("a non-member NON-admin on the widget path is still denied (the membership gate stands)", async () => {
    setUser({ id: "u_1", role: "user" });
    setMember(undefined);
    const actor = await resolveAgentRunMcpActor({ ...TRIPLE, sourceType: "public_site_widget" });
    expect(actor).toBeNull();
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

  it("cinatra#2674 (ASSIGNED-SKILL leg): a widget-carried platform admin MEMBER keeps platform_admin", async () => {
    setUser({ id: "u_1", role: "admin" }); // global platform admin...
    setMember({ id: "m_1" }); // ...who is also a member
    const widget = await resolveAssignedSkillsActorForRun({
      ...RUN,
      sourceType: "public_site_widget",
    });
    const inApp = await resolveAssignedSkillsActorForRun({
      ...RUN,
      sourceType: "content_editor_dispatch",
    });
    expect(widget).toBeDefined();
    expect(widget!.platformRole).toBe("platform_admin");
    // …and it is the SAME actor the non-widget carrier produces (parity).
    expect(widget!.platformRole).toBe(inApp!.platformRole);
  });

  it("NEGATIVE CONTROL: a widget-carried ORDINARY member is not elevated", async () => {
    setUser({ id: "u_1", role: "user" });
    setMember({ id: "m_1" });
    const actor = await resolveAssignedSkillsActorForRun({
      ...RUN,
      sourceType: "public_site_widget",
    });
    expect(actor).toBeDefined();
    expect(actor!.platformRole).toBe("member");
  });

  it("a widget carrier owned by a NON-member — admin or not — is undefined (the gate stands)", async () => {
    setUser({ id: "u_1", role: "admin" });
    setMember(undefined);
    expect(
      await resolveAssignedSkillsActorForRun({ ...RUN, sourceType: "public_site_widget" }),
    ).toBeUndefined();
    buildActorContextFromRunMock.mockClear();
    setUser({ id: "u_1", role: "user" });
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
