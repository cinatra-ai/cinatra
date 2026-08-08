/**
 * Unit proof for the non-redirecting agent-creation-request decision helper and
 * its error classifier — the SHARED decide the unified inbox server action, the
 * detail-page server action, and the future approvals_* MCP tools all call.
 *
 * Guarantees asserted here:
 *  - a business refusal is a VALUE, never a throw (SoD / stale / invalid-state);
 *  - the classifier maps each REAL primitive error string to a stable code+kind,
 *    and an UNRECOGNISED message is `transient` (not a false policy `refused`);
 *  - the pre-flight guards (unknown action, reject-without-reason, missing CAS
 *    token) refuse WITHOUT calling the audited primitive;
 *  - the actor's platformRole is claimed only for an admin viewer (the primitive
 *    re-checks, so this never widens authority) and the CAS token flows through.
 *
 * The audited `agent_creation_request_decide` primitive is mocked so the helper
 * is exercised in isolation with no DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const decideHandler = vi.fn();

vi.mock("@cinatra-ai/agents/mcp-handlers", () => ({
  createAgentBuilderPrimitiveHandlers: () => ({
    agent_creation_request_decide: decideHandler,
  }),
}));

// cinatra#1327 — the helper persists the chosen access scope through the shared
// install path (lazy-imported). Mock it so the persistence is asserted without a
// live DB. agentApprovalAccessPolicy (@cinatra-ai/agents/agent-approval-access)
// is left REAL — pure — so the org→workspace mapping is proven end-to-end.
const extMock = vi.hoisted(() => ({
  setExtensionInstallAccess: vi.fn(async () => {}),
}));
vi.mock("@cinatra-ai/extensions/install-access-contract", () => extMock);

// cinatra#1327 — the helper authorizes the chosen access target with the shared
// install gates before publishing. Mocked to the org tenant rule (cross-org id
// => throw) so the WIRING (gate call + denial classification) is asserted here;
// the gates' internal logic is covered by install-target-authz's own tests.
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

const ORG_SCOPE = { level: "organization" as const, id: "org-1" };

import {
  classifyAgentDecideError,
  decideAgentCreationRequest,
} from "../decision-helpers";
import type { ApprovalViewer } from "../sources/types";

const admin: ApprovalViewer = { userId: "u-admin", orgId: "org-1", isAdmin: true };
const member: ApprovalViewer = { userId: "u-member", orgId: "org-1", isAdmin: false };

// The EXACT strings the real primitive/store emit (grounded against
// packages/agents/src/mcp/agent-creation-request-handlers.ts + the store errors)
// so a drift in those messages fails this test rather than silently
// mis-classifying a refusal.
const MSG = {
  unauthorized:
    "Unauthorized — admin session required to decide an agent creation request.",
  selfApproval:
    "self-approval is disallowed (set connector_config.agent_creation.allowSelfApproval=true to override).",
  stale:
    "agent_creation_request abc snapshot changed since this decision was prepared; refresh and try again",
  invalidTransition: "agent_creation_request invalid transition: approved → approved",
  notFound: "agent_creation_request 'abc' not found",
  collision:
    "package-name collision: an agent_template already uses packageName 'acme'. Choose another name.",
  weird: "ECONNRESET while talking to the registry",
};

describe("classifyAgentDecideError", () => {
  it("unauthorized / admin-session → forbidden:not_admin", () => {
    expect(classifyAgentDecideError(MSG.unauthorized)).toMatchObject({
      ok: false,
      kind: "forbidden",
      code: "not_admin",
    });
  });

  it("self-approval disallowed → refused:self_approval_forbidden", () => {
    expect(classifyAgentDecideError(MSG.selfApproval)).toMatchObject({
      ok: false,
      kind: "refused",
      code: "self_approval_forbidden",
    });
  });

  it("stale snapshot → refused:stale_snapshot", () => {
    expect(classifyAgentDecideError(MSG.stale)).toMatchObject({
      ok: false,
      kind: "refused",
      code: "stale_snapshot",
    });
  });

  it("invalid transition → refused:invalid_state", () => {
    expect(classifyAgentDecideError(MSG.invalidTransition)).toMatchObject({
      ok: false,
      kind: "refused",
      code: "invalid_state",
    });
  });

  it("not found → refused:not_found", () => {
    expect(classifyAgentDecideError(MSG.notFound)).toMatchObject({
      ok: false,
      kind: "refused",
      code: "not_found",
    });
  });

  it("publish collision → refused:name_collision", () => {
    expect(classifyAgentDecideError(MSG.collision)).toMatchObject({
      ok: false,
      kind: "refused",
      code: "name_collision",
    });
  });

  it("an UNRECOGNISED message is transient (retryable), NOT a policy refusal", () => {
    expect(classifyAgentDecideError(MSG.weird)).toMatchObject({
      ok: false,
      kind: "transient",
      code: "unknown",
    });
  });
});

describe("decideAgentCreationRequest — pre-flight guards refuse without calling the primitive", () => {
  beforeEach(() => {
    decideHandler.mockReset();
  });

  it("unknown action → refused:unknown_action, primitive not called", async () => {
    const r = await decideAgentCreationRequest(
      { rowId: "abc", action: "nuke", expectedVersion: "h1" },
      admin,
    );
    expect(r).toMatchObject({ ok: false, kind: "refused", code: "unknown_action" });
    expect(decideHandler).not.toHaveBeenCalled();
  });

  it("reject without a reason → refused:reason_required, primitive not called", async () => {
    const r = await decideAgentCreationRequest(
      { rowId: "abc", action: "reject", expectedVersion: "h1" },
      admin,
    );
    expect(r).toMatchObject({ ok: false, kind: "refused", code: "reason_required" });
    expect(decideHandler).not.toHaveBeenCalled();
  });

  it("missing CAS token → refused:version_required (never reads a fresh hash)", async () => {
    const r = await decideAgentCreationRequest(
      { rowId: "abc", action: "approve" },
      admin,
    );
    expect(r).toMatchObject({ ok: false, kind: "refused", code: "version_required" });
    expect(decideHandler).not.toHaveBeenCalled();
  });

  it("approve WITHOUT an access scope → refused:access_scope_required, primitive not called (cinatra#1327)", async () => {
    const r = await decideAgentCreationRequest(
      { rowId: "abc", action: "approve", expectedVersion: "h1" },
      admin,
    );
    expect(r).toMatchObject({ ok: false, kind: "refused", code: "access_scope_required" });
    expect(decideHandler).not.toHaveBeenCalled();
    expect(extMock.setExtensionInstallAccess).not.toHaveBeenCalled();
  });

  it("a cross-org / unauthorized access target → forbidden:target_forbidden BEFORE the primitive or any persist (cinatra#1327)", async () => {
    const r = await decideAgentCreationRequest(
      { rowId: "abc", action: "approve", expectedVersion: "h", accessTarget: { level: "organization", id: "OTHER-ORG" } },
      admin,
    );
    expect(r).toMatchObject({ ok: false, kind: "forbidden", code: "target_forbidden" });
    expect(decideHandler).not.toHaveBeenCalled();
    expect(extMock.setExtensionInstallAccess).not.toHaveBeenCalled();
  });
});

describe("decideAgentCreationRequest — delegates to the audited primitive", () => {
  beforeEach(() => {
    decideHandler.mockReset();
    extMock.setExtensionInstallAccess.mockReset();
    extMock.setExtensionInstallAccess.mockResolvedValue(undefined);
  });

  it("happy approve → ok:true; CAS token + admin actor + access scope flow through", async () => {
    decideHandler.mockResolvedValue({ structuredContent: { agentTemplateId: "tmpl-1" } });
    const r = await decideAgentCreationRequest(
      { rowId: "abc", action: "approve", expectedVersion: "hash-xyz", accessTarget: ORG_SCOPE },
      admin,
    );
    expect(r).toEqual({ ok: true });
    expect(decideHandler).toHaveBeenCalledTimes(1);
    const call = decideHandler.mock.calls[0][0];
    expect(call.primitiveName).toBe("agent_creation_request_decide");
    expect(call.input).toMatchObject({
      id: "abc",
      decision: "approve",
      expectedSnapshotHash: "hash-xyz",
      // The chosen scope is threaded to the primitive (audit + server re-check).
      accessTarget: { level: "organization", id: "org-1" },
    });
    expect(call.actor).toMatchObject({
      userId: "u-admin",
      organizationId: "org-1",
      platformRole: "platform_admin",
    });
    // Persisted through the SAME install path, keyed by the returned template id.
    expect(extMock.setExtensionInstallAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "agent_template",
        resourceId: "tmpl-1",
        installedByUserId: "u-admin",
      }),
    );
  });

  it("reject with reason forwards the reason", async () => {
    decideHandler.mockResolvedValue({ id: "abc", status: "rejected" });
    const r = await decideAgentCreationRequest(
      { rowId: "abc", action: "reject", reason: "unsafe scopes", expectedVersion: "h" },
      admin,
    );
    expect(r).toEqual({ ok: true });
    expect(decideHandler.mock.calls[0][0].input).toMatchObject({
      decision: "reject",
      reason: "unsafe scopes",
    });
  });

  it("a non-admin viewer claims only 'member' (defence in depth)", async () => {
    decideHandler.mockResolvedValue({ error: MSG.unauthorized });
    const r = await decideAgentCreationRequest(
      { rowId: "abc", action: "approve", expectedVersion: "h", accessTarget: ORG_SCOPE },
      member,
    );
    expect(r).toMatchObject({ ok: false, kind: "forbidden" });
    expect(decideHandler.mock.calls[0][0].actor.platformRole).toBe("member");
  });

  it("a self-approval refusal is a VALUE, never a throw", async () => {
    decideHandler.mockResolvedValue({ error: MSG.selfApproval });
    await expect(
      decideAgentCreationRequest(
        { rowId: "abc", action: "approve", expectedVersion: "h", accessTarget: ORG_SCOPE },
        admin,
      ),
    ).resolves.toMatchObject({ ok: false, kind: "refused", code: "self_approval_forbidden" });
  });

  it("a stale-snapshot refusal is a VALUE, never a throw", async () => {
    decideHandler.mockResolvedValue({ error: MSG.stale });
    await expect(
      decideAgentCreationRequest(
        { rowId: "abc", action: "approve", expectedVersion: "h", accessTarget: ORG_SCOPE },
        admin,
      ),
    ).resolves.toMatchObject({ ok: false, kind: "refused", code: "stale_snapshot" });
  });

  it("an unrecognised primitive error is surfaced as transient, not refused", async () => {
    decideHandler.mockResolvedValue({ error: MSG.weird });
    const r = await decideAgentCreationRequest(
      { rowId: "abc", action: "approve", expectedVersion: "h", accessTarget: ORG_SCOPE },
      admin,
    );
    expect(r).toMatchObject({ ok: false, kind: "transient", code: "unknown" });
  });

  it("a scoped approve persists access via the shared install path (org → workspace, real mapper)", async () => {
    decideHandler.mockResolvedValue({ structuredContent: { agentTemplateId: "tmpl-9" } });
    const r = await decideAgentCreationRequest(
      { rowId: "abc", action: "approve", expectedVersion: "h", accessTarget: ORG_SCOPE },
      admin,
    );
    expect(r).toEqual({ ok: true });
    // The org target maps to workspace visibility (every same-org member) — NOT
    // the agent_template owner-only default — proven end-to-end through the real
    // agentApprovalAccessPolicy mapper.
    expect(extMock.setExtensionInstallAccess).toHaveBeenCalledWith({
      kind: "agent_template",
      resourceId: "tmpl-9",
      policy: {
        runListVisibility: ["workspace"],
        runDataVisibility: ["workspace"],
        runExecuteVisibility: ["workspace"],
        allowRunSharing: false,
      },
      installedByUserId: "u-admin",
    });
  });

  it("a reject never persists an access scope", async () => {
    decideHandler.mockResolvedValue({ id: "abc", status: "rejected" });
    const r = await decideAgentCreationRequest(
      { rowId: "abc", action: "reject", reason: "no", expectedVersion: "h" },
      admin,
    );
    expect(r).toEqual({ ok: true });
    expect(extMock.setExtensionInstallAccess).not.toHaveBeenCalled();
  });

  it("published but no resolvable template id → transient:template_unresolved (fail-closed, not ok)", async () => {
    // Missing agentTemplateId in the envelope — the agent published but we cannot
    // key the access write; surface a retryable failure rather than a false ok.
    decideHandler.mockResolvedValue({ id: "abc", status: "approved" });
    const r = await decideAgentCreationRequest(
      { rowId: "abc", action: "approve", expectedVersion: "h", accessTarget: { level: "team", id: "t1" } },
      admin,
    );
    expect(r).toMatchObject({ ok: false, kind: "transient", code: "template_unresolved" });
    expect(extMock.setExtensionInstallAccess).not.toHaveBeenCalled();
  });

  it("access write throws → transient:access_persist_failed (agent stays restricted, never over-broad)", async () => {
    decideHandler.mockResolvedValue({ structuredContent: { agentTemplateId: "tmpl-x" } });
    extMock.setExtensionInstallAccess.mockRejectedValueOnce(new Error("db down"));
    const r = await decideAgentCreationRequest(
      { rowId: "abc", action: "approve", expectedVersion: "h", accessTarget: { level: "project", id: "p1" } },
      admin,
    );
    expect(r).toMatchObject({ ok: false, kind: "transient", code: "access_persist_failed" });
  });
});
