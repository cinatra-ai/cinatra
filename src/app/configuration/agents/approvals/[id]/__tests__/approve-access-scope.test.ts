/**
 * cinatra#2597 — the approvals DETAIL page's approve seam.
 *
 * #1327 made an access scope REQUIRED to approve-and-publish an agent-creation
 * request (fail-closed, server-side). This page's approve action never sent one,
 * so every approve from the detail surface hit the server gate and the page was
 * a structural DEAD END: an unavoidable failure whose only message was the
 * generic "The decision could not be recorded. See server logs for details."
 *
 * These are the seam tests the fix has to keep true:
 *
 *  - scope SUPPLIED  → the decide primitive runs WITH the accessTarget, and the
 *    chosen scope is persisted through the shared install-access write path
 *    (setExtensionInstallAccess) — the same contract the inbox approve honours;
 *  - scope MISSING (or malformed, i.e. not one of the three selectable levels)
 *    → an ACTIONABLE refusal code, and NOTHING is half-approved: the audited
 *    decide primitive never runs, so the request is untouched at `proposed`;
 *  - a target the reviewer may not grant → a distinct actionable code, again
 *    BEFORE the primitive (fail-fast, so a bad target never publishes);
 *  - the primitive's own known refusals map to their own actionable codes
 *    rather than collapsing into the opaque `decision-failed`;
 *  - every code these actions can emit HAS a message in the flash map (an
 *    unmapped code is silently ignored by the toast island — a dead end again).
 *
 * The audited primitive and the two install-access seams are mocked, so the
 * approve path is exercised end-to-end with no DB and no registry.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthSession = vi.fn();
const decideHandler = vi.fn(
  async (_req: unknown) =>
    ({ structuredContent: { agentTemplateId: "tpl-1" } }) as {
      error?: string;
      structuredContent?: { agentTemplateId?: string | null };
    },
);

const redirect = vi.fn((url: string) => {
  // next/navigation's redirect throws a control-flow signal (NEXT_REDIRECT);
  // mirror that so the action body halts at the redirect line.
  throw Object.assign(new Error("NEXT_REDIRECT"), { __redirectTo: url });
});

vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirect(url),
}));

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: () => getAuthSession(),
  isPlatformAdmin: (s: { user?: { role?: string | null } | null } | null | undefined) =>
    String(s?.user?.role ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
      .includes("admin"),
}));

vi.mock("@cinatra-ai/agents/mcp-handlers", () => ({
  createAgentBuilderPrimitiveHandlers: () => ({
    agent_creation_request_decide: (req: unknown) => decideHandler(req as never),
    agent_creation_request_retry_publish: vi.fn(),
  }),
}));

// #1327 persistence seam (lazy-imported by the shared helper).
const extMock = vi.hoisted(() => ({
  setExtensionInstallAccess: vi.fn(async () => {}),
}));
vi.mock("@cinatra-ai/extensions/install-access-contract", () => extMock);

// #1327 target-authorization seam (lazy-imported by the shared helper). Mocked
// to the tenant rule (an org id that is not the active org throws) so the
// WIRING is asserted here; the gates' own logic has its own tests.
vi.mock("@cinatra-ai/agents/install-target-authz", () => ({
  assertTargetBelongsToActiveOrg: vi.fn(
    async (_actor: unknown, target: { level: string; id: string }, orgId: string) => {
      if (target.level === "organization" && target.id !== orgId) {
        throw new Error("Target organization is not the active organization.");
      }
      return {};
    },
  ),
  assertCanInstallAtTarget: vi.fn(async () => {}),
}));

import { approveAgentCreationRequest, rejectAgentCreationRequest } from "../actions";
import { APPROVAL_DECISION_TOASTS } from "../approval-decision-flash";

const ADMIN_SESSION = {
  user: { id: "admin-1", role: "user,admin" },
  session: { activeOrganizationId: "org-1" },
};

function approveForm(extra: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("id", "req-1");
  fd.set("snapshotHash", "hash-1");
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}

const SCOPED = { accessTargetLevel: "organization", accessTargetId: "org-1" };

beforeEach(() => {
  vi.clearAllMocks();
  getAuthSession.mockResolvedValue(ADMIN_SESSION);
  decideHandler.mockResolvedValue({ structuredContent: { agentTemplateId: "tpl-1" } });
});

describe("approve WITH a scope — the approval lands and the scope is recorded", () => {
  it("threads the chosen accessTarget into the decide primitive input", async () => {
    await expect(approveAgentCreationRequest(approveForm(SCOPED))).rejects.toMatchObject({
      __redirectTo: "/configuration/agents/approvals/req-1?status=approved",
    });
    expect(decideHandler).toHaveBeenCalledTimes(1);
    expect(decideHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        primitiveName: "agent_creation_request_decide",
        input: expect.objectContaining({
          id: "req-1",
          decision: "approve",
          expectedSnapshotHash: "hash-1",
          accessTarget: { level: "organization", id: "org-1" },
        }),
        actor: expect.objectContaining({ platformRole: "platform_admin", userId: "admin-1" }),
      }),
    );
  });

  it("persists the scope through the shared install-access write path", async () => {
    await expect(
      approveAgentCreationRequest(approveForm({ accessTargetLevel: "team", accessTargetId: "t-9" })),
    ).rejects.toMatchObject({
      __redirectTo: "/configuration/agents/approvals/req-1?status=approved",
    });
    expect(extMock.setExtensionInstallAccess).toHaveBeenCalledTimes(1);
    expect(extMock.setExtensionInstallAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "agent_template",
        resourceId: "tpl-1",
        installedByUserId: "admin-1",
        policy: expect.objectContaining({
          runExecuteVisibility: ["team:t-9"],
        }),
      }),
    );
  });
});

describe("approve WITHOUT a usable scope — actionable refusal, nothing half-approved", () => {
  it("refuses with ?error=scope-required and never runs the decide primitive", async () => {
    await expect(approveAgentCreationRequest(approveForm())).rejects.toMatchObject({
      __redirectTo: "/configuration/agents/approvals/req-1?error=scope-required",
    });
    expect(decideHandler).not.toHaveBeenCalled();
    expect(extMock.setExtensionInstallAccess).not.toHaveBeenCalled();
  });

  it("treats a NON-selectable level as no scope (fail-closed), not as a half-valid target", async () => {
    for (const level of ["workspace", "user", "owner", "admin", "ORGANIZATION", ""]) {
      vi.clearAllMocks();
      getAuthSession.mockResolvedValue(ADMIN_SESSION);
      await expect(
        approveAgentCreationRequest(
          approveForm({ accessTargetLevel: level, accessTargetId: "x-1" }),
        ),
      ).rejects.toMatchObject({
        __redirectTo: "/configuration/agents/approvals/req-1?error=scope-required",
      });
      expect(decideHandler).not.toHaveBeenCalled();
    }
  });

  it("treats an EMPTY target id as no scope", async () => {
    await expect(
      approveAgentCreationRequest(
        approveForm({ accessTargetLevel: "organization", accessTargetId: "   " }),
      ),
    ).rejects.toMatchObject({
      __redirectTo: "/configuration/agents/approvals/req-1?error=scope-required",
    });
    expect(decideHandler).not.toHaveBeenCalled();
  });
});

describe("approve with a target the reviewer may not grant", () => {
  it("refuses with ?error=scope-forbidden BEFORE the primitive (nothing publishes)", async () => {
    await expect(
      approveAgentCreationRequest(
        // A different org's id — the tenant gate rejects it.
        approveForm({ accessTargetLevel: "organization", accessTargetId: "org-OTHER" }),
      ),
    ).rejects.toMatchObject({
      __redirectTo: "/configuration/agents/approvals/req-1?error=scope-forbidden",
    });
    expect(decideHandler).not.toHaveBeenCalled();
    expect(extMock.setExtensionInstallAccess).not.toHaveBeenCalled();
  });
});

describe("the primitive's own refusals get their own actionable codes", () => {
  it("a stale snapshot maps to ?error=stale-snapshot", async () => {
    decideHandler.mockResolvedValue({
      error:
        "agent_creation_request req-1 snapshot changed since this decision was prepared; refresh and try again",
    });
    await expect(approveAgentCreationRequest(approveForm(SCOPED))).rejects.toMatchObject({
      __redirectTo: "/configuration/agents/approvals/req-1?error=stale-snapshot",
    });
    expect(extMock.setExtensionInstallAccess).not.toHaveBeenCalled();
  });

  it("a self-approval refusal maps to ?error=self-approval", async () => {
    decideHandler.mockResolvedValue({
      error:
        "self-approval is disallowed (set connector_config.agent_creation.allowSelfApproval=true to override).",
    });
    await expect(approveAgentCreationRequest(approveForm(SCOPED))).rejects.toMatchObject({
      __redirectTo: "/configuration/agents/approvals/req-1?error=self-approval",
    });
  });

  it("a request that left `proposed` maps to ?error=already-decided (reload, do not retry)", async () => {
    decideHandler.mockResolvedValue({
      error: "agent_creation_request invalid transition: approved → approved",
    });
    await expect(approveAgentCreationRequest(approveForm(SCOPED))).rejects.toMatchObject({
      __redirectTo: "/configuration/agents/approvals/req-1?error=already-decided",
    });
  });

  it("a vanished request maps to ?error=not-found", async () => {
    decideHandler.mockResolvedValue({ error: "agent_creation_request 'req-1' not found" });
    await expect(approveAgentCreationRequest(approveForm(SCOPED))).rejects.toMatchObject({
      __redirectTo: "/configuration/agents/approvals/req-1?error=not-found",
    });
  });

  it("a package-name collision maps to ?error=name-collision", async () => {
    decideHandler.mockResolvedValue({
      error:
        "package-name collision: an agent_template already uses packageName 'acme'. Choose another name.",
    });
    await expect(approveAgentCreationRequest(approveForm(SCOPED))).rejects.toMatchObject({
      __redirectTo: "/configuration/agents/approvals/req-1?error=name-collision",
    });
  });

  it("a MISSING snapshot token maps to ?error=snapshot-missing, NOT to stale-snapshot", async () => {
    // A missing CAS token is not evidence the proposal changed — saying so
    // would be a guess presented as a fact.
    const fd = new FormData();
    fd.set("id", "req-1");
    fd.set("snapshotHash", "");
    fd.set("accessTargetLevel", "organization");
    fd.set("accessTargetId", "org-1");
    await expect(approveAgentCreationRequest(fd)).rejects.toMatchObject({
      __redirectTo: "/configuration/agents/approvals/req-1?error=snapshot-missing",
    });
    expect(decideHandler).not.toHaveBeenCalled();
  });

  it("an unrecognised failure still falls back to ?error=decision-failed", async () => {
    decideHandler.mockResolvedValue({ error: "ECONNRESET while talking to the registry" });
    await expect(approveAgentCreationRequest(approveForm(SCOPED))).rejects.toMatchObject({
      __redirectTo: "/configuration/agents/approvals/req-1?error=decision-failed",
    });
  });

  it("a published agent whose scope write fails maps to ?error=scope-not-applied", async () => {
    extMock.setExtensionInstallAccess.mockRejectedValueOnce(new Error("db down"));
    await expect(approveAgentCreationRequest(approveForm(SCOPED))).rejects.toMatchObject({
      __redirectTo: "/configuration/agents/approvals/req-1?error=scope-not-applied",
    });
  });
});

describe("reject is unaffected by the scope requirement", () => {
  it("rejects with a reason and no scope, and never touches the access write path", async () => {
    await expect(
      rejectAgentCreationRequest(approveForm({ reason: "needs work" })),
    ).rejects.toMatchObject({
      __redirectTo: "/configuration/agents/approvals/req-1?status=rejected",
    });
    expect(decideHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ decision: "reject", reason: "needs work" }),
      }),
    );
    expect(extMock.setExtensionInstallAccess).not.toHaveBeenCalled();
  });
});

describe("flash-map completeness — no emitted code is a silent dead end", () => {
  it("every error code the approve/reject actions can emit has a static message", async () => {
    const mapped = new Set(
      APPROVAL_DECISION_TOASTS.filter((t) => t.param === "error").map((t) => t.value),
    );
    // The codes exercised above, plus the two session guards the actions emit
    // without reaching the helper.
    for (const code of [
      "scope-required",
      "scope-forbidden",
      "scope-not-applied",
      "stale-snapshot",
      "snapshot-missing",
      "already-decided",
      "not-found",
      "name-collision",
      "self-approval",
      "reason-required",
      "decision-failed",
      "publish-failed",
      "unauthorized",
      "no-active-org",
    ]) {
      expect(mapped, `missing flash message for ?error=${code}`).toContain(code);
    }
  });

  it("states only what the refusal proves — no message asserts an unknowable cause", () => {
    const byCode = (code: string) =>
      APPROVAL_DECISION_TOASTS.find((t) => t.param === "error" && t.value === code)?.message ?? "";
    // The request read is org-scoped, so a miss does NOT prove deletion.
    expect(byCode("not-found")).toMatch(/active organization/i);
    expect(byCode("not-found")).not.toMatch(/no longer exists/i);
    // The collision fires at publish, AFTER the CAS to approved — so the
    // proposal cannot be edited or resubmitted; Retry publish is the route.
    expect(byCode("name-collision")).toMatch(/Retry publish/);
    expect(byCode("name-collision")).not.toMatch(/resubmit/i);
    // A missing CAS token is not evidence the proposal changed.
    expect(byCode("snapshot-missing")).not.toMatch(/changed/i);
  });

  it("no message tells the reviewer to retry a decision this page can no longer offer", () => {
    // The agent is already published when `scope-not-applied` fires, so the
    // decision affordances are gone — pointing at "retry" would send them into
    // an invalid-transition wall.
    const notApplied = APPROVAL_DECISION_TOASTS.find(
      (t) => t.param === "error" && t.value === "scope-not-applied",
    );
    expect(notApplied?.message).toMatch(/Permissions/);
    expect(notApplied?.message).not.toMatch(/retry/i);
  });

  it("no flash message still promises a private-scoped publish (the #1327 contract)", () => {
    const approved = APPROVAL_DECISION_TOASTS.find(
      (t) => t.param === "status" && t.value === "approved",
    );
    expect(approved?.message).not.toMatch(/private/i);
  });
});
