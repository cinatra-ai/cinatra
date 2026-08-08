// cinatra#2485 items A + B — the HITL approve/reject server actions.
//
// A (deleted): the run-side separation-of-duties self-approval guard (#563) and
//   its `connector_config.agent_run.allowSelfApproval` escape hatch. The run
//   initiator clearing their OWN gate is no longer refused.
// B (re-authorized): `requireAdminSession()` is replaced by ACTOR-AWARE
//   authorization — a verified actor context built from the session, enforcing
//   `run.execute` + `run.approveHitl` on the RESOLVED run.
//
// Together these two were the observed deadlock: a non-platform-admin member
// could not submit the setup input their own run was waiting on (admin gate),
// and a platform-admin initiator could not either (SoD guard) once a second
// admin existed — so the run sat in `pending_approval` forever.
//
// This pins:
//   - approve: a NON-ADMIN member drives their own run's HITL — no admin session
//     is ever demanded and no "self-approval is disallowed" is thrown, even when
//     the member IS the run initiator;
//   - approve: the actorContext + roleHints are ALWAYS threaded into
//     approveReviewTaskInternal. This is the load-bearing pin: the helper SKIPS
//     its run-access gate when actorContext is absent, so an
//     `actorContext`-less call from this entry point would hand every
//     authenticated user authority over every run. The absent-actorContext path
//     must be unreachable from here;
//   - approve: a denial raised by that gate propagates (out-of-scope refused);
//   - reject: the SAME pair of checks (`execute` THEN `approveHitl`) runs against
//     the resolved run BEFORE the status transition, with a CONCRETE
//     (owner-only-by-default) effective policy on the probe — a null policy
//     makes enforceRunAccess skip policy tightening, and the kernel's `member`
//     role grants both run.resume and run.approveHitl to every same-org member;
//   - reject: a denial refuses the transition entirely (out-of-scope refused);
//   - reject: a MISSING run is gated before the existence-revealing error, so a
//     caller cannot probe foreign setup-<runId> ids.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_AGENT_AUTH_POLICY } from "../auth-policy-types";

// A plain, NON-ADMIN member session. `requireAdminSession` is wired to throw:
// if any production path still reaches for it, these tests fail loudly rather
// than silently passing because the mock happened to return a session.
const { requireAuthSessionMock, requireAdminSessionMock, requireActorContextMock, resolveOrgRoleForUserMock } =
  vi.hoisted(() => ({
    requireAuthSessionMock: vi.fn(async () => ({
      user: { id: "member-1", email: "member@example.com", role: "user" },
      session: { activeOrganizationId: "org-1" },
    })),
    requireAdminSessionMock: vi.fn(async () => {
      throw new Error("requireAdminSession must not gate the HITL path (cinatra#2485 B)");
    }),
    requireActorContextMock: vi.fn(async () => ({
      principalId: "member-1",
      organizationId: "org-1",
      orgRole: "member" as const,
      platformRole: "member" as const,
      teamIds: ["team-1"],
      teamRoles: { "team-1": "member" as const },
      projectGrants: [],
    })),
    resolveOrgRoleForUserMock: vi.fn(async () => "member" as string | undefined),
  }));
vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: requireAuthSessionMock,
  requireAdminSession: requireAdminSessionMock,
  requireActorContext: requireActorContextMock,
  resolveOrgRoleForUser: resolveOrgRoleForUserMock,
  buildCanDoOptsFromSession: vi.fn(() => ({})),
  isPlatformAdmin: vi.fn(() => false),
}));

const { FakeAuthzError } = vi.hoisted(() => ({
  FakeAuthzError: class FakeAuthzError extends Error {
    statusCode: number;
    reason: string;
    constructor(init: { statusCode: number; reason: string; message: string }) {
      super(init.message);
      this.statusCode = init.statusCode;
      this.reason = init.reason;
    }
  },
}));
vi.mock("@/lib/authz", () => ({
  canDo: vi.fn(async () => ({ ok: true })),
  AuthzError: FakeAuthzError,
  logAuditEvent: vi.fn(async () => {}),
}));

vi.mock("@/lib/agent-url", () => ({
  buildAgentWorkspacePath: vi.fn(() => "/agents/foo"),
}));

vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: vi.fn(async () => {}),
  BACKGROUND_JOB_NAMES: {} as Record<string, string>,
}));

vi.mock("@/lib/primitive-handlers", () => ({
  collectAllPrimitiveHandlers: vi.fn(() => []),
}));

vi.mock("@/lib/better-auth-db", () => ({
  readTeamForOrg: vi.fn(async () => null),
}));

const { sessionAuthorityFromResolvedRoleMock } = vi.hoisted(() => ({
  sessionAuthorityFromResolvedRoleMock: vi.fn(() => ({ kind: "session" })),
}));
vi.mock("@/lib/org-write/authority", () => ({
  sessionAuthorityFromResolvedRole: sessionAuthorityFromResolvedRoleMock,
  verifySessionAuthority: vi.fn(),
}));

// Run resolution + the reject path's transition (dynamically imported from
// "./store" inside rejectReviewTask, so it must live on this same mock).
const {
  readAgentRunByIdMock,
  readAgentTemplateByIdMock,
  readRunCoOwnersMock,
  transitionRunStatusMock,
} = vi.hoisted(() => ({
  readAgentRunByIdMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  readAgentTemplateByIdMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  readRunCoOwnersMock: vi.fn<(...args: unknown[]) => Promise<Array<{ userId: string }>>>(),
  transitionRunStatusMock: vi.fn<(...args: unknown[]) => Promise<void>>(),
}));
vi.mock("../store", () => ({
  readAgentRunById: readAgentRunByIdMock,
  readAgentTemplateById: readAgentTemplateByIdMock,
  readRunCoOwners: readRunCoOwnersMock,
  transitionRunStatus: transitionRunStatusMock,
  RunTransitionError: class RunTransitionError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
  // Remaining store exports are referenced at module load but unused here.
  createAuditEvent: vi.fn(),
  deleteAgentTemplate: vi.fn(),
  readAgentTemplateByPackageName: vi.fn(),
  readAgentVersionsByTemplate: vi.fn(),
  readAgentVersionById: vi.fn(),
  createAgentTemplate: vi.fn(),
  createAgentVersion: vi.fn(),
  createAgentRun: vi.fn(),
  createShareBinding: vi.fn(),
  createAgentFork: vi.fn(),
  checkRegistryPermission: vi.fn(),
  readRegistryEntryById: vi.fn(),
  updateAgentTemplate: vi.fn(),
  updateShareBinding: vi.fn(),
  createAgentTemplateVersionIfChanged: vi.fn(),
  rollbackAgentTemplateToVersion: vi.fn(),
  updateAgentTemplateOrigin: vi.fn(),
}));

// Only `enforceRunAccess` is stubbed — `resolveEffectivePolicy` stays REAL so
// the owner-only-default assertion below exercises the production resolution
// order rather than a re-implementation.
const { enforceRunAccessMock } = vi.hoisted(() => ({
  enforceRunAccessMock: vi.fn<(...args: unknown[]) => Promise<void>>(),
}));
vi.mock("../auth-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth-policy")>();
  return { ...actual, enforceRunAccess: enforceRunAccessMock };
});

const { approveReviewTaskInternalMock } = vi.hoisted(() => ({
  approveReviewTaskInternalMock: vi.fn<(...args: unknown[]) => Promise<void>>(),
}));
vi.mock("../review-task-actions", () => ({
  approveReviewTaskInternal: approveReviewTaskInternalMock,
}));

vi.mock("../compiler", () => ({ compileWorkflow: vi.fn() }));

vi.mock("../verdaccio/publish-metadata", () => ({
  derivePublishMetadataFromSnapshot: vi.fn(() => ({
    riskLevel: "low",
    toolAccess: [],
    hasApprovalGates: false,
  })),
}));

vi.mock("@cinatra-ai/registries", async () => {
  const actual = await vi.importActual<typeof import("@cinatra-ai/registries")>("@cinatra-ai/registries");
  return { ...actual };
});

vi.mock("../verdaccio/client", () => ({ publishAgentPackage: vi.fn(async () => {}) }));

vi.mock("../install-package-with-dependencies", () => ({
  installAgentPackageWithDependencies: vi.fn(async () => {}),
}));

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { approveReviewTask, rejectReviewTask } from "../actions";

const OWN_RUN = {
  id: "run-1",
  templateId: "tpl-1",
  orgId: "org-1",
  // The member is the run INITIATOR — the exact case the deleted SoD guard
  // refused.
  runBy: "member-1",
  authPolicy: null,
  status: "pending_approval",
};

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthSessionMock.mockResolvedValue({
    user: { id: "member-1", email: "member@example.com", role: "user" },
    session: { activeOrganizationId: "org-1" },
  });
  requireAdminSessionMock.mockRejectedValue(
    new Error("requireAdminSession must not gate the HITL path (cinatra#2485 B)"),
  );
  requireActorContextMock.mockResolvedValue({
    principalId: "member-1",
    organizationId: "org-1",
    orgRole: "member",
    platformRole: "member",
    teamIds: ["team-1"],
    teamRoles: { "team-1": "member" },
    projectGrants: [],
  });
  resolveOrgRoleForUserMock.mockResolvedValue("member");
  readAgentTemplateByIdMock.mockResolvedValue(null);
  readRunCoOwnersMock.mockResolvedValue([]);
  enforceRunAccessMock.mockResolvedValue(undefined);
  approveReviewTaskInternalMock.mockResolvedValue(undefined);
  transitionRunStatusMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("approveReviewTask — actor-aware HITL authorization (cinatra#2485 A+B)", () => {
  it("a NON-ADMIN member drives their OWN run's gate — no admin session, no self-approval refusal", async () => {
    await expect(
      approveReviewTask("setup-run-1", { idea: "ship it" }, "idea"),
    ).resolves.toBeUndefined();

    // Item B: the platform-admin gate is gone from this path entirely.
    expect(requireAdminSessionMock).not.toHaveBeenCalled();
    // Item A: the run initiator approving their own gate is NOT refused, and the
    // guard's admin-count / connector-config reads are gone with it.
    expect(approveReviewTaskInternalMock).toHaveBeenCalledTimes(1);
  });

  it("ALWAYS threads the verified actorContext + roleHints (the absent-actorContext path is unreachable)", async () => {
    await approveReviewTask("setup-run-1", { idea: "ship it" }, "idea", { type: "object" });

    const call = approveReviewTaskInternalMock.mock.calls[0] as unknown[];
    expect(call[0]).toBe("setup-run-1");
    expect(call[1]).toBe("member-1");
    expect(call[2]).toEqual({ idea: "ship it" });
    expect(call[3]).toBe("idea");
    expect(call[4]).toEqual({ type: "object" });
    // arg 6 — WITHOUT this the internal helper skips its run-access gate.
    expect(call[5]).toBeDefined();
    expect(call[5]).toMatchObject({ userId: "member-1", organizationId: "org-1" });
    // arg 7 — role hints; actorOrganizationId must come from the SESSION's
    // active org, never from run.orgId (that would weaken the cross-org guard).
    expect(call[6]).toMatchObject({
      actorOrganizationId: "org-1",
      orgRole: "member",
      teamIds: ["team-1"],
    });
  });

  it("threads the actorContext on the wayflow- prefix too (run resolution stays in the gated helper)", async () => {
    await approveReviewTask("wayflow-task-9");

    const call = approveReviewTaskInternalMock.mock.calls[0] as unknown[];
    expect(call[0]).toBe("wayflow-task-9");
    expect(call[5]).toMatchObject({ userId: "member-1" });
    expect(call[6]).toMatchObject({ actorOrganizationId: "org-1" });
  });

  it("refuses an OUT-OF-SCOPE actor — the gate's denial propagates", async () => {
    approveReviewTaskInternalMock.mockRejectedValue(
      new FakeAuthzError({ statusCode: 403, reason: "forbidden", message: "Run access denied." }),
    );

    await expect(approveReviewTask("setup-run-1")).rejects.toThrow(/Run access denied/);
  });
});

describe("rejectReviewTask — actor-aware HITL authorization (cinatra#2485 B)", () => {
  it("a NON-ADMIN member rejects their OWN run's gate after execute + approveHitl both pass", async () => {
    readAgentRunByIdMock.mockResolvedValue(OWN_RUN);

    await expect(rejectReviewTask("setup-run-1", "changed my mind")).resolves.toBeUndefined();

    expect(requireAdminSessionMock).not.toHaveBeenCalled();
    // execute FIRST, then approveHitl — the order agent_run_resume and the A2A
    // resume seam use.
    expect(enforceRunAccessMock).toHaveBeenCalledTimes(2);
    expect(enforceRunAccessMock.mock.calls[0]?.[2]).toBe("execute");
    expect(enforceRunAccessMock.mock.calls[1]?.[2]).toBe("approveHitl");
    expect(transitionRunStatusMock).toHaveBeenCalledTimes(1);
    expect(transitionRunStatusMock.mock.calls[0]?.slice(0, 3)).toEqual([
      "run-1",
      "pending_approval",
      "failed",
    ]);
  });

  it("probes with a CONCRETE owner-only policy — never a null policy that skips policy tightening", async () => {
    readAgentRunByIdMock.mockResolvedValue(OWN_RUN);
    readAgentTemplateByIdMock.mockResolvedValue({ id: "tpl-1", agentAuthPolicy: null });
    readRunCoOwnersMock.mockResolvedValue([{ userId: "co-owner-1" }]);

    await rejectReviewTask("setup-run-1");

    const probe = enforceRunAccessMock.mock.calls[0]?.[0] as {
      id: string;
      runBy: string;
      orgId: string;
      effectivePolicy: unknown;
      coOwnerUserIds: string[];
    };
    expect(probe.id).toBe("run-1");
    expect(probe.runBy).toBe("member-1");
    expect(probe.orgId).toBe("org-1");
    expect(probe.coOwnerUserIds).toEqual(["co-owner-1"]);
    // Neither the run nor the template declares a policy -> the owner-only
    // default, NOT null. A null here would let every same-org member drive a
    // stranger's gate (kernel `member` grants run.resume + run.approveHitl).
    expect(probe.effectivePolicy).toBeTruthy();
    expect(probe.effectivePolicy).toEqual(DEFAULT_AGENT_AUTH_POLICY);
  });

  it("refuses an OUT-OF-SCOPE actor and performs NO transition", async () => {
    readAgentRunByIdMock.mockResolvedValue({ ...OWN_RUN, runBy: "someone-else" });
    enforceRunAccessMock.mockRejectedValue(
      new FakeAuthzError({ statusCode: 403, reason: "forbidden", message: "Run access denied." }),
    );

    await expect(rejectReviewTask("setup-run-1")).rejects.toThrow(/Run access denied/);

    expect(transitionRunStatusMock).not.toHaveBeenCalled();
    expect(sessionAuthorityFromResolvedRoleMock).not.toHaveBeenCalled();
  });

  it("gates a MISSING run BEFORE the existence-revealing error (no foreign-id probing)", async () => {
    readAgentRunByIdMock.mockResolvedValue(null);
    // enforceRunAccess raises the 404-shaped AuthzError for a null probe in
    // production; assert this entry point hands it the null probe rather than
    // short-circuiting to its own "run not found".
    enforceRunAccessMock.mockRejectedValue(
      new FakeAuthzError({ statusCode: 404, reason: "hidden", message: "Not found." }),
    );

    await expect(rejectReviewTask("setup-missing")).rejects.toThrow(/Not found\./);

    expect(enforceRunAccessMock).toHaveBeenCalledTimes(1);
    expect(enforceRunAccessMock.mock.calls[0]?.[0]).toBeNull();
    expect(transitionRunStatusMock).not.toHaveBeenCalled();
  });
});
