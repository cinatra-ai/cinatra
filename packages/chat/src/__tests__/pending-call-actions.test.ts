import { describe, expect, it, vi, beforeEach } from "vitest";

// cinatra#2020 S5 PR-4 — the chat server actions: session wiring, the
// per-action token pair on PENDING rows only, viewer scoping, and the thin
// decide passthrough into the executor (which owns all security decisions).

const requireAuthSession = vi.fn();
const requireActorContext = vi.fn(async () => ({ principalType: "HumanUser" }) as never);
vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: () => requireAuthSession(),
  requireActorContext: () => requireActorContext(),
}));

const listPendingCallsForViewer = vi.fn(async (_input: never) => [] as unknown[]);
vi.mock("@/lib/connector-instance-pending-call-store", () => ({
  listPendingCallsForViewer: (input: unknown) => listPendingCallsForViewer(input as never),
}));

const issuePendingCallDecisionToken = vi.fn(
  (input: { pendingCallId: string; act: string }) => `tok-${input.act}-${input.pendingCallId}`,
);
vi.mock("@/lib/connector-instance-pending-call-decision-token", () => ({
  issuePendingCallDecisionToken: (input: { pendingCallId: string; act: string }) =>
    issuePendingCallDecisionToken(input),
}));

const decidePendingCall = vi.fn(async (_input: never) => ({ outcome: "refused" }) as const);
vi.mock("@/lib/connector-instance-pending-call-executor", () => ({
  decidePendingCall: (input: unknown) => decidePendingCall(input as never),
}));

const getExternalMcpServerById = vi.fn((_id: never) => ({ label: "My Site" }));
vi.mock("@/lib/external-mcp-registry", () => ({
  getExternalMcpServerById: (id: unknown) => getExternalMcpServerById(id as never),
}));

import {
  decidePendingToolCall,
  listPendingToolConfirmations,
} from "../pending-call-actions";
import { PENDING_CONFIRMATION_RESULT_PREFIX } from "../pending-tool-confirmation-card";
import { PENDING_CONFIRMATION_MESSAGE_PREFIX } from "@/lib/connector-instance-mcp-transport";

const SESSION = {
  user: { id: "u1" },
  session: { id: "s1", activeOrganizationId: "org1" },
};

function storeRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "cipc_1",
    connectorKey: "wordpress",
    toolName: "core/delete-post",
    serverId: "wps_1",
    instanceId: "inst-1",
    argsPreview: '{\n  "id": 7\n}',
    status: "pending",
    failureCode: null,
    resultSummary: null,
    expiresAt: "2026-07-28T12:00:00.000Z",
    createdAt: "2026-07-28T11:45:00.000Z",
    updatedAt: "2026-07-28T11:45:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthSession.mockResolvedValue(SESSION);
  getExternalMcpServerById.mockReturnValue({ label: "My Site" });
});

describe("client↔server prefix pin", () => {
  it("the card's client-safe prefix copy is byte-identical to the canonical transport export", () => {
    expect(PENDING_CONFIRMATION_RESULT_PREFIX).toBe(PENDING_CONFIRMATION_MESSAGE_PREFIX);
  });
});

describe("listPendingToolConfirmations", () => {
  it("no active org → empty rows, store never read", async () => {
    requireAuthSession.mockResolvedValue({ user: { id: "u1" }, session: { id: "s1" } });
    await expect(listPendingToolConfirmations()).resolves.toEqual({ rows: [] });
    expect(listPendingCallsForViewer).not.toHaveBeenCalled();
  });

  it("maps rows viewer-scoped and mints TWO DISTINCT per-action tokens on pending rows only", async () => {
    listPendingCallsForViewer.mockResolvedValue([
      storeRecord(),
      storeRecord({ id: "cipc_2", status: "executed" }),
    ]);
    const { rows } = await listPendingToolConfirmations();
    expect(listPendingCallsForViewer).toHaveBeenCalledWith({ orgId: "org1", userId: "u1" });

    expect(rows[0]).toMatchObject({
      id: "cipc_1",
      toolName: "core/delete-post",
      instanceLabel: "My Site",
      argsPreview: '{\n  "id": 7\n}',
      confirmToken: "tok-confirm-cipc_1",
      rejectToken: "tok-reject-cipc_1",
    });
    expect(rows[0].confirmToken).not.toBe(rows[0].rejectToken);
    // Token mint inputs bind the row + session material per action family.
    expect(issuePendingCallDecisionToken).toHaveBeenCalledWith({
      pendingCallId: "cipc_1",
      userId: "u1",
      orgId: "org1",
      sessionId: "s1",
      act: "confirm",
    });
    // Terminal rows carry NO tokens (a stale card just re-reads).
    expect(rows[1]).toMatchObject({ id: "cipc_2", confirmToken: null, rejectToken: null });
    expect(issuePendingCallDecisionToken).toHaveBeenCalledTimes(2);
  });

  it("falls back to the instance id when the registry has no label", async () => {
    getExternalMcpServerById.mockReturnValue(null as never);
    listPendingCallsForViewer.mockResolvedValue([storeRecord()]);
    const { rows } = await listPendingToolConfirmations();
    expect(rows[0].instanceLabel).toBe("inst-1");
  });
});

describe("decidePendingToolCall", () => {
  it("passes the live session + actor through to the executor verbatim", async () => {
    decidePendingCall.mockResolvedValue({
      outcome: "decided",
      id: "cipc_1",
      status: "executed",
      alreadyDecided: false,
      failureCode: null,
      resultSummary: { ok: true },
    } as never);
    const result = await decidePendingToolCall("cipc_1", "confirm", "tok-confirm-cipc_1");
    expect(result).toMatchObject({ outcome: "decided", status: "executed" });
    expect(decidePendingCall).toHaveBeenCalledWith({
      pendingCallId: "cipc_1",
      action: "confirm",
      token: "tok-confirm-cipc_1",
      session: { userId: "u1", orgId: "org1", sessionId: "s1" },
      actor: { principalType: "HumanUser" },
    });
  });

  it("no active org → opaque refusal, executor never called", async () => {
    requireAuthSession.mockResolvedValue({ user: { id: "u1" }, session: { id: "s1" } });
    await expect(decidePendingToolCall("cipc_1", "confirm", "t")).resolves.toEqual({
      outcome: "refused",
    });
    expect(decidePendingCall).not.toHaveBeenCalled();
  });
});
