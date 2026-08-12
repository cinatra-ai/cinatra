"use client";

/**
 * Destructive-tool confirmation cards (cinatra#2020 design §6.1, PR-4).
 *
 * Renders the viewer's parked destructive connector-tool calls from the
 * PERSISTED rows (today's chat wire drops tool args — the card is the
 * args-bearing surface, showing the park-time redacted preview) with
 * one-click Confirm / Deny / Cancel. Decisions carry the per-action decision
 * token the server minted WITH the card data; the server action re-verifies
 * session, ownership, and token before the exactly-once execute.
 *
 * Poll model (deliberately v1-minimal — #1216 owns a first-class stream
 * event): refresh on mount, on window focus/visibility, and when the mount
 * site signals that a streamed turn carried a parked-call tool result
 * (`pollSignal` bumps — the mount site matches the stable
 * `pending_confirmation:` prefix on tool results). The deciding client gets
 * its outcome synchronously from the action's return value.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  brokerRequestInit,
  useConversationCredential,
  type ConversationCredential,
} from "./conversation-credential";
import {
  decidePendingToolCall,
  listPendingToolConfirmations,
  type PendingToolConfirmationRow,
} from "./pending-call-actions";
import type { PendingCallDecisionResult } from "@/lib/connector-instance-pending-call-executor";

/** The widget's door onto the SAME server module the action reaches. */
const PENDING_CALLS_ROUTE = "/api/chat/pending-tool-calls";

/**
 * Read the caller's parked calls with whichever credential the host declared.
 *
 * `refused` asks nothing — no request, not merely no render — because a surface
 * that cannot say who it is must not be answered by an ambient session.
 */
async function loadRows(
  credential: ConversationCredential,
): Promise<PendingToolConfirmationRow[] | null> {
  if (credential.kind === "refused") return null;
  if (credential.kind === "cookie") {
    return (await listPendingToolConfirmations()).rows;
  }
  const res = await fetch(PENDING_CALLS_ROUTE, brokerRequestInit(credential.auth));
  if (!res.ok) return null;
  const body = (await res.json()) as { rows?: PendingToolConfirmationRow[] };
  return Array.isArray(body.rows) ? body.rows : null;
}

/**
 * Decide one call. Both branches reach the SAME server module — the stage-4
 * executor, which owns the token verify, the requester-only ownership check and
 * the exactly-once consume CAS. There is no widget decision path.
 */
async function submitDecision(
  credential: ConversationCredential,
  pendingCallId: string,
  action: "confirm" | "deny" | "cancel",
  token: string,
): Promise<PendingCallDecisionResult> {
  if (credential.kind === "refused") return { outcome: "refused" };
  if (credential.kind === "cookie") {
    return decidePendingToolCall(pendingCallId, action, token);
  }
  const res = await fetch(
    PENDING_CALLS_ROUTE,
    brokerRequestInit(credential.auth, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pendingCallId, action, token }),
    }),
  );
  if (!res.ok) return { outcome: "refused" };
  return (await res.json()) as PendingCallDecisionResult;
}

/**
 * STABLE machine prefix of a parked-call tool result (§2.1). LOCAL COPY of
 * `PENDING_CONFIRMATION_MESSAGE_PREFIX` from
 * `src/lib/connector-instance-mcp-transport.ts` — the canonical export lives
 * beside the error code in a server module whose import graph (MCP SDK
 * client) must not enter the client bundle; a unit test pins byte-equality
 * with the canonical constant so the two can never drift.
 */
export const PENDING_CONFIRMATION_RESULT_PREFIX = "pending_confirmation:";

/** Terminal cards stay visible this long after their decision (then only the
 * audit/history retains them — the list itself keeps 30 days server-side). */
const TERMINAL_VISIBLE_MS = 15 * 60 * 1000;

/** The stable empty list, so a credential with no readable state renders the
 *  same "nothing" every time rather than a new array each render. */
const NO_ROWS: PendingToolConfirmationRow[] = [];

function isVisibleRow(row: PendingToolConfirmationRow, nowMs: number): boolean {
  if (row.status === "pending" || row.status === "executing") return true;
  const updated = Date.parse(row.updatedAt);
  return Number.isFinite(updated) && nowMs - updated <= TERMINAL_VISIBLE_MS;
}

function expiresInLabel(expiresAt: string): string {
  const remaining = Date.parse(expiresAt) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return "expiring";
  const minutes = Math.ceil(remaining / 60_000);
  return `expires in ${minutes} min`;
}

function statusLine(row: PendingToolConfirmationRow): string | null {
  switch (row.status) {
    case "executing":
      return "Executing…";
    case "executed":
      return "Executed.";
    case "failed":
      // The INDETERMINATE rendering (§3): an interrupted execution may or may
      // not have run — never present it as an ordinary failure.
      return row.failureCode === "execution_interrupted"
        ? "Outcome unknown — the confirmation was processed but the result did not come back in time. Verify on the site before retrying."
        : `Not executed — ${row.failureCode ?? "failed"}.`;
    case "denied":
      return "Denied — not executed.";
    case "cancelled":
      return "Cancelled — not executed.";
    case "expired":
      return "Expired unconfirmed — not executed.";
    default:
      return null;
  }
}

export function PendingToolConfirmationCards({
  pollSignal = 0,
}: {
  /** Bump to trigger a refresh (the mount site's parked-result prefix match). */
  pollSignal?: number;
}) {
  // THE CREDENTIAL THIS SURFACE ASKS WITH (cinatra#2683, epic #2564 S8f).
  //
  // This component READS and DECIDES, so it needs a proof of identity, and until
  // the second half of S8f it had exactly one: the ambient cookie. That made it
  // fail closed on the widget — the embed frame is SAME-ORIGIN to the Cinatra
  // app, so the list would have returned ANOTHER PERSON's parked destructive
  // calls, with freshly minted decision tokens, inside chrome a third-party site
  // controls.
  //
  // It now asks with whatever the host declared: a cookie host keeps the server
  // action byte-for-byte, and a broker host presents its `cwu_` at the route that
  // reaches the SAME server module. A host whose declaration is unclear or
  // refused asks NOTHING — no request, not merely no render — which is the
  // fail-closed default this slice established and did not move.
  //
  // Keyed on the CREDENTIAL, never on a surface name, in ONE place.
  const credential = useConversationCredential();

  // STATE IS STORED WITH THE CREDENTIAL IT WAS FETCHED UNDER, and read back only
  // while that credential is still the one this subtree has (codex round 1
  // finding 3, tightened in the confirming round).
  //
  // Rows carry another person's-eyes-only data and LIVE decision tokens, so
  // "authorized once" must not become "rendered afterwards". Clearing them in an
  // effect was not enough twice over: an effect leaves one rendered frame with
  // the previous credential's rows, and a decision issued under the OLD
  // credential could still finish, refresh, and file its answer under the new
  // one. Stamping the state and guarding the read closes both — there is no
  // frame in between, and a stale answer is simply never read.
  const [resolved, setResolved] = useState<{
    credential: ConversationCredential;
    rows: PendingToolConfirmationRow[];
  } | null>(null);
  const rows = resolved && resolved.credential === credential ? resolved.rows : NO_ROWS;
  const [busy, setBusy] = useState<{ credential: ConversationCredential; id: string } | null>(
    null,
  );
  const busyId = busy && busy.credential === credential ? busy.id : null;
  const mountedRef = useRef(true);

  /**
   * Load under ONE credential. The credential is an argument, not a read of the
   * current one, so a refresh triggered by an old decision cannot file its rows
   * under whatever the subtree has become in the meantime.
   */
  const loadFor = useCallback(async (asCredential: ConversationCredential) => {
    try {
      const fresh = await loadRows(asCredential);
      if (!mountedRef.current || fresh === null) return;
      const now = Date.now();
      setResolved({
        credential: asCredential,
        rows: fresh.filter((row) => isVisibleRow(row, now)),
      });
    } catch {
      // A failed refresh keeps the current cards; the next signal retries.
    }
  }, []);

  const load = useCallback(() => loadFor(credential), [loadFor, credential]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    const onFocus = () => void load();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  useEffect(() => {
    if (pollSignal > 0) void load();
  }, [pollSignal, load]);

  const decide = useCallback(
    async (
      row: PendingToolConfirmationRow,
      action: "confirm" | "deny" | "cancel",
      token: string | null,
    ) => {
      if (!token || busyId) return;
      // The credential this decision is TAKEN under, captured once. Every write
      // below is stamped with it, so a decision that outlives its credential
      // updates nothing a later credential can read.
      const asCredential = credential;
      setBusy({ credential: asCredential, id: row.id });
      try {
        const result = await submitDecision(asCredential, row.id, action, token);
        if (!mountedRef.current) return;
        if (result.outcome === "decided") {
          setResolved((prev) =>
            prev && prev.credential === asCredential
              ? {
                  credential: asCredential,
                  rows: prev.rows.map((r) =>
                    r.id === result.id
                      ? {
                          ...r,
                          status: result.status,
                          failureCode: result.failureCode,
                          resultSummary: result.resultSummary,
                          updatedAt: new Date().toISOString(),
                          confirmToken: null,
                          rejectToken: null,
                        }
                      : r,
                  ),
                }
              : prev,
          );
        }
        // Refresh under the SAME credential — outcome states + fresh tokens for
        // the other rows.
        void loadFor(asCredential);
      } finally {
        // Only this decision's own busy marker is cleared: a newer credential's
        // decision must not be un-marked by an older one finishing.
        if (mountedRef.current) {
          setBusy((prev) =>
            prev && prev.credential === asCredential && prev.id === row.id ? null : prev,
          );
        }
      }
    },
    [credential, busyId, loadFor],
  );

  if (rows.length === 0) return null;

  return (
    <div
      data-testid="pending-tool-confirmations"
      className="sticky bottom-0 z-10 mt-2 flex flex-col gap-2 bg-background/95 pb-1 pt-2 backdrop-blur supports-[backdrop-filter]:bg-background/80"
    >
      {rows.map((row) => {
        const pending = row.status === "pending";
        const busy = busyId === row.id;
        const line = statusLine(row);
        return (
          <div
            key={row.id}
            className={cn(
              "w-full rounded-control border px-4 py-3 shadow-sm",
              pending ? "border-amber-500/40 bg-surface-muted/70" : "border-border bg-surface-muted/40",
            )}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <div className="min-w-0">
                <span className="text-sm font-medium">
                  Destructive action needs your confirmation
                </span>
                <div className="truncate font-mono text-xs text-muted-foreground">
                  {row.toolName} · {row.serverId} · {row.instanceLabel}
                </div>
              </div>
              <span className="text-xs text-muted-foreground">
                {pending ? expiresInLabel(row.expiresAt) : row.status}
              </span>
            </div>
            {pending && (
              <pre className="mt-2 max-h-40 overflow-auto rounded bg-background/60 p-2 text-xs leading-relaxed">
                {row.argsPreview}
              </pre>
            )}
            {line && <div className="mt-2 text-xs text-muted-foreground">{line}</div>}
            {pending && (
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  // Any row in flight disables every row's buttons — `decide()`
                  // itself early-returns while `busyId` is set, so a non-busy
                  // row must not look clickable during another row's decision.
                  //
                  // A row with NO token is a row this caller may see but not
                  // decide (a widget session granted the list and not the
                  // confirmation). `decide()` refuses it either way; disabling
                  // the control says so instead of offering a dead button.
                  disabled={busyId !== null || !row.confirmToken}
                  onClick={() => void decide(row, "confirm", row.confirmToken)}
                >
                  {busy ? "Working…" : "Confirm"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busyId !== null || !row.rejectToken}
                  onClick={() => void decide(row, "deny", row.rejectToken)}
                >
                  Deny
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busyId !== null || !row.rejectToken}
                  onClick={() => void decide(row, "cancel", row.rejectToken)}
                >
                  Cancel
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
