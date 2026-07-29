"use server";

// Server actions for the destructive-confirmation cards (cinatra#2020 design
// §6.1, PR-4) — the chat package's established server surface (the actions.ts
// precedent), deliberately NOT an API route: nothing about the token-verifying
// chat route changes, and #1216 can later lift these same actions into a
// unified-stream approval view.
//
// The card data comes from the PERSISTED row (today's chat wire drops tool
// args): the list read returns the park-time REDACTED preview and mints TWO
// fresh short-lived decision tokens per pending row — one per button family
// (`confirm` / `reject`), so a reject token can never confirm (stage-2 token
// module). Decisions flow through the stage-4 executor, which owns token
// verify, requester-only ownership, the exactly-once consume CAS, the
// fingerprint drift checks, and the governed re-invoke.

import {
  requireActorContext,
  requireAuthSession,
} from "@/lib/auth-session";
import {
  listPendingCallsForViewer,
  type ConnectorInstancePendingCallRecord,
} from "@/lib/connector-instance-pending-call-store";
import {
  issuePendingCallDecisionToken,
  type PendingCallDecisionAction,
} from "@/lib/connector-instance-pending-call-decision-token";
import {
  decidePendingCall,
  type PendingCallDecisionResult,
} from "@/lib/connector-instance-pending-call-executor";
import { getExternalMcpServerById } from "@/lib/external-mcp-registry";

export type PendingToolConfirmationRow = {
  id: string;
  connectorKey: string;
  toolName: string;
  serverId: string;
  instanceId: string;
  /** Registry display label when known; falls back to the instance id. */
  instanceLabel: string;
  /** The park-time REDACTED, display-truncated preview (§6.2) — the row keeps
   * the full args server-side; this is the ONLY args form the client sees. */
  argsPreview: string;
  status: string;
  failureCode: string | null;
  resultSummary: unknown;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  /** Per-action decision tokens — minted fresh per read, PENDING rows only
   * (a stale card just re-reads; §4.1 `act` binding). */
  confirmToken: string | null;
  rejectToken: string | null;
};

type SessionShape = {
  user: { id: string };
  session?: { id?: string; activeOrganizationId?: string | null } | null;
};

function sessionIds(session: SessionShape): {
  userId: string;
  orgId: string | null;
  sessionId: string | null;
} {
  return {
    userId: session.user.id,
    orgId: session.session?.activeOrganizationId ?? null,
    sessionId: session.session?.id ?? null,
  };
}

/**
 * The `(org, user)`-scoped card list (§6.1) — NOT thread-scoped, so a park
 * from any require-surface shows in the viewer's cinatra chat panel. The
 * store read lazy-flips stale rows first (expiry needs no cron).
 */
export async function listPendingToolConfirmations(): Promise<{
  rows: PendingToolConfirmationRow[];
}> {
  const session = (await requireAuthSession()) as unknown as SessionShape;
  const { userId, orgId, sessionId } = sessionIds(session);
  if (!orgId || !sessionId) return { rows: [] };

  const records = await listPendingCallsForViewer({ orgId, userId });
  const rows = records.map((record: ConnectorInstancePendingCallRecord) => {
    const pending = record.status === "pending";
    const tokenInput = {
      pendingCallId: record.id,
      userId,
      orgId,
      sessionId,
    };
    return {
      id: record.id,
      connectorKey: record.connectorKey,
      toolName: record.toolName,
      serverId: record.serverId,
      instanceId: record.instanceId,
      instanceLabel:
        getExternalMcpServerById(record.instanceId)?.label ?? record.instanceId,
      argsPreview: record.argsPreview,
      status: record.status,
      failureCode: record.failureCode,
      resultSummary: record.resultSummary,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      confirmToken: pending
        ? issuePendingCallDecisionToken({ ...tokenInput, act: "confirm" })
        : null,
      rejectToken: pending
        ? issuePendingCallDecisionToken({ ...tokenInput, act: "reject" })
        : null,
    };
  });
  return { rows };
}

/**
 * Decide one pending call (§4.2 step 1 lives here: the LIVE cookie session +
 * actor; everything after is the executor's). Refusals are opaque — the audit
 * trail carries the reason.
 */
export async function decidePendingToolCall(
  pendingCallId: string,
  action: PendingCallDecisionAction,
  token: string,
): Promise<PendingCallDecisionResult> {
  // Boundary validation: server actions are network-callable, so the runtime
  // action value is checked HERE as well as in the executor (which also
  // restricts execution to the explicit `confirm` branch) and in the token
  // verifier (whose unknown-action mapping fails closed).
  if (action !== "confirm" && action !== "deny" && action !== "cancel") {
    return { outcome: "refused" };
  }
  const session = (await requireAuthSession()) as unknown as SessionShape;
  const { userId, orgId, sessionId } = sessionIds(session);
  if (!orgId || !sessionId) return { outcome: "refused" };
  const actor = await requireActorContext();
  return decidePendingCall({
    pendingCallId,
    action,
    token,
    session: { userId, orgId, sessionId },
    actor,
  });
}
