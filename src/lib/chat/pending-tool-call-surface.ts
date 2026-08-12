import "server-only";

// ---------------------------------------------------------------------------
// THE parked-destructive-call surface — one implementation, two credentials
// (cinatra#2683, epic #2564 S8f).
// ---------------------------------------------------------------------------
// The confirmation cards (cinatra#2020 §6.1) used to exist only as a pair of
// COOKIE-bound server actions. S8f made `/chat` and the widget render the same
// conversation column, and the cards came with it — but a server action resolves
// its identity from the ambient session, and the embed frame is same-origin to
// the Cinatra app, so firing one from the widget would have listed ANOTHER
// PERSON's parked destructive calls, with freshly minted decision tokens, inside
// chrome a third-party site controls. The cards were therefore fail-closed on the
// widget and the gap was carried as an open question.
//
// This module closes it the way the lifecycle slices closed theirs: the LOGIC
// moves here, takes its principal as an ARGUMENT, and both entries call it.
//   · the cookie entry is the unchanged server action (`pending-call-actions.ts`),
//     which passes the session's own ids;
//   · the widget entry is `/api/chat/pending-tool-calls`, which passes the
//     WIDGET PRINCIPAL the `cwu_` proved.
// There is one list query, one token mint, one executor call. Nothing about the
// decision is re-implemented for the widget and nothing is relaxed for it.
//
// THE PRINCIPAL IS THE WHOLE SCOPE. `listPendingCallsForViewer` is
// `(org, user)`-scoped, so a caller sees THEIR OWN parked calls and no others —
// on either surface, by the same query. The decision tokens are minted for that
// same principal and bound to it at verify, so a token minted for one reader can
// never decide as another.
//
// THE SESSION BINDING IS REAL ON BOTH SURFACES. The decision token binds `sid` —
// "the client the server actually served this card to, in this session". On
// `/chat` that is the Better-Auth session id. On the widget it is the `cwu_`
// token's `jti`: one widget login, one identity, minted per login and dead when
// the token expires. A token exfiltrated from one widget session is useless in
// another, which is exactly the property `sid` exists to carry — so the binding
// is preserved rather than dropped for the surface that has no cookie.
//
// §3.D IS UNTOUCHED. This module decides nothing itself: it reads rows the
// runtime parked, and hands a decision to the stage-4 executor, which owns the
// token verify, the requester-only ownership check, the exactly-once consume CAS,
// the fingerprint drift checks and the governed re-invoke — unchanged.
// ---------------------------------------------------------------------------

import type { ActorContext } from "@/lib/authz/actor-context";
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

/**
 * WHO is asking, on either surface. Three ids and nothing else — deliberately
 * not a session and not a token, so neither entry can pass something the other
 * could not, and so this module can never reach for an ambient identity.
 */
export type PendingToolCallPrincipal = {
  userId: string;
  orgId: string;
  /** The Better-Auth session id (`/chat`) or the `cwu_` jti (the widget). */
  sessionId: string;
};

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
   * (a stale card just re-reads; §4.1 `act` binding). Null when the caller holds
   * no authority to decide (see `canDecide`). */
  confirmToken: string | null;
  rejectToken: string | null;
};

/**
 * The `(org, user)`-scoped card list (§6.1) — NOT thread-scoped, so a park from
 * any require-surface shows in the viewer's chat panel. The store read lazy-flips
 * stale rows first (expiry needs no cron).
 *
 * `canDecide` is what makes the read and the decision SEPARATELY consentable on
 * the widget: a session that carries the list grant but not the confirm grant
 * gets its own rows and NO decision tokens, so the surface can show what is
 * waiting without handing out the authority to act on it. On `/chat` it is
 * always true — a cookie session that can read the card is the session that can
 * decide it, which is the behaviour that surface has always had.
 */
export async function listPendingToolCallsFor(
  principal: PendingToolCallPrincipal,
  options: { canDecide: boolean },
): Promise<{ rows: PendingToolConfirmationRow[] }> {
  const { userId, orgId, sessionId } = principal;
  if (!orgId || !userId || !sessionId) return { rows: [] };

  const records = await listPendingCallsForViewer({ orgId, userId });
  const rows = records.map((record: ConnectorInstancePendingCallRecord) => {
    const mintable = record.status === "pending" && options.canDecide;
    const tokenInput = { pendingCallId: record.id, userId, orgId, sessionId };
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
      confirmToken: mintable
        ? issuePendingCallDecisionToken({ ...tokenInput, act: "confirm" })
        : null,
      rejectToken: mintable
        ? issuePendingCallDecisionToken({ ...tokenInput, act: "reject" })
        : null,
    };
  });
  return { rows };
}

/**
 * Decide one parked call. Step 1 of §4.2 (the live principal) belongs to the
 * CALLER — the cookie entry proves it with a session, the widget entry with the
 * `cwu_` consume — and everything after it is the executor's, unchanged.
 *
 * Refusals are opaque: one `refused` outcome for a bad action, a bad token, a
 * foreign row and a stale card alike. The audit trail carries the reason.
 */
export async function decidePendingToolCallFor(input: {
  pendingCallId: string;
  action: PendingCallDecisionAction;
  token: string;
  principal: PendingToolCallPrincipal;
  actor: ActorContext;
}): Promise<PendingCallDecisionResult> {
  // Boundary validation: both entries are network-callable, so the runtime
  // action value is checked HERE as well as in the executor (which also
  // restricts execution to the explicit `confirm` branch) and in the token
  // verifier (whose unknown-action mapping fails closed).
  const { action } = input;
  if (action !== "confirm" && action !== "deny" && action !== "cancel") {
    return { outcome: "refused" };
  }
  const { userId, orgId, sessionId } = input.principal;
  if (!orgId || !userId || !sessionId) return { outcome: "refused" };
  return decidePendingCall({
    pendingCallId: input.pendingCallId,
    action,
    token: input.token,
    session: { userId, orgId, sessionId },
    actor: input.actor,
  });
}
