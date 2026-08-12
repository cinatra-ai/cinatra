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
import { useBrokeredSurface } from "./app-route-link";
import {
  decidePendingToolCall,
  listPendingToolConfirmations,
  type PendingToolConfirmationRow,
} from "./pending-call-actions";

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
  // CREDENTIAL-KEYED FAIL-CLOSED (cinatra#2683, epic #2564 S8f) — the same
  // guard, for the same reason, as `RunRecommendationHoldCard` (#2577 codex
  // round 0, finding 4). This component reads and decides through COOKIE-BOUND
  // server actions (`listPendingToolConfirmations`, `decidePendingToolCall`),
  // which resolve their identity from the ambient session and cannot carry a
  // host credential.
  //
  // Until S8f the widget conversation column did not mount this component at
  // all, so the question never arose. It now mounts the SAME shared list `/chat`
  // does — and the embed frame is SAME-ORIGIN to the Cinatra app, so a server
  // action fired from it would ride whatever Cinatra cookie is in that browser.
  // That is not a cosmetic mismatch: the list returns another person's parked
  // DESTRUCTIVE calls together with freshly minted decision tokens, inside
  // chrome a third-party site controls. Drawing it there would be the worst
  // shape of the ambient-session fallback the contract forbids.
  //
  // Keyed on the CREDENTIAL, not on a surface list: a host that declares one
  // draws nothing and issues no request; every cookie-session host is untouched.
  // When these actions become broker-aware, this guard is what gets deleted — no
  // surface list to edit. Recorded as an OPEN QUESTION on the S8f PR, never as a
  // quiet reduction.
  const brokerSurface = useBrokeredSurface();

  const [rows, setRows] = useState<PendingToolConfirmationRow[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    if (brokerSurface) return; // no request, not just no render
    try {
      const { rows: fresh } = await listPendingToolConfirmations();
      if (!mountedRef.current) return;
      const now = Date.now();
      setRows(fresh.filter((row) => isVisibleRow(row, now)));
    } catch {
      // A failed refresh keeps the current cards; the next signal retries.
    }
  }, [brokerSurface]);

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
      if (brokerSurface || !token || busyId) return;
      setBusyId(row.id);
      try {
        const result = await decidePendingToolCall(row.id, action, token);
        if (!mountedRef.current) return;
        if (result.outcome === "decided") {
          setRows((prev) =>
            prev.map((r) =>
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
          );
        }
        // Refresh regardless — outcome states + fresh tokens for other rows.
        void load();
      } finally {
        if (mountedRef.current) setBusyId(null);
      }
    },
    [brokerSurface, busyId, load],
  );

  if (brokerSurface) return null;
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
                  disabled={busyId !== null}
                  onClick={() => void decide(row, "confirm", row.confirmToken)}
                >
                  {busy ? "Working…" : "Confirm"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busyId !== null}
                  onClick={() => void decide(row, "deny", row.rejectToken)}
                >
                  Deny
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busyId !== null}
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
