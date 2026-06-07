"use client";

/**
 * Live SSE creation-progress timeline hook.
 *
 * Upgrades the append-only polling surface to a live subscription over the
 * existing notifications SSE stream (`/api/notifications/stream`). No second
 * SSE server is needed: creation progress rows are INSERT-only `kind:"info"`
 * notification rows that already flow through that channel for the session
 * user.
 *
 * Append-only semantics preserved: SSE is a live overlay only. The durable
 * INSERT-only event log (`/api/notifications`) remains the replay source on
 * reload. No row is ever mutated.
 *
 * Race-free merge invariant: EVERY state update goes through `mergeProgress`
 * — union by per-event UUID `id`, then sort ascending by `createdAt`. This
 * makes the initial fetch, the safety-net poll, and each SSE append
 * commutative + idempotent, so arrival order is irrelevant: a stale fetch
 * snapshot cannot drop an SSE-appended row, and a duplicate (same `id`) from
 * any source never double-renders.
 *
 * Sources (all merge, never replace):
 *   - Initial `/api/notifications` fetch — reload-replay + headless/no-SSE
 *     fallback.
 *   - Live `EventSource("/api/notifications/stream")` `notification` events —
 *     the primary real-time path. Native reconnect (no manual retry, matches
 *     notifications-flyout doctrine).
 *   - Safety-net `/api/notifications` poll @15s — backstop for
 *     EventSource-unavailable + missed SSE frames.
 *   - `/api/agents/runs/<runId>` status poll @5s — terminal owner; on
 *     terminal it does a final sweep then closes the EventSource + clears
 *     intervals.
 *
 * Accepted latency note: when SSE is live the timeline is real-time; with no
 * SSE the worst case is 15s. This is an explicit trade: SSE is the primary
 * path, and fast polling per tab defeats that purpose.
 */

import { useEffect, useRef, useState } from "react";
// Notifications types and client helpers go through the public package surface;
// the client barrel is browser-safe.
import type { AppNotification } from "@cinatra-ai/notifications/types";
import { filterAgentCreationProgressByRunId } from "@cinatra-ai/notifications/client";

const SAFETY_NET_POLL_MS = 15000;
const STATUS_POLL_MS = 5000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "stopped"]);

/**
 * Race-free reducer: union `prev` ∪ `incoming` keyed by `id` (durable
 * per-event UUID), then sort ascending by `createdAt` (the timeline order
 * contract — oldest first). Pure; commutative + idempotent by construction.
 */
export function mergeProgress(
  prev: AppNotification[],
  incoming: AppNotification[],
): AppNotification[] {
  if (incoming.length === 0) return prev;
  const byId = new Map<string, AppNotification>();
  for (const n of prev) byId.set(n.id, n);
  let changed = false;
  for (const n of incoming) {
    if (!byId.has(n.id)) changed = true;
    byId.set(n.id, n);
  }
  // If every incoming id was already present, return prev unchanged so React
  // can bail out of a re-render.
  if (!changed) return prev;
  return Array.from(byId.values()).sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

export function useAgentCreationProgress(runId: string): AppNotification[] {
  const [items, setItems] = useState<AppNotification[]>([]);
  // Browser `window.setInterval` handles (NOT NodeJS.Timeout) held in refs so
  // the status poll can clear the safety-net poll (and itself) on terminal
  // without re-running the effect.
  const safetyTimerRef = useRef<number | null>(null);
  const statusTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let eventSource: EventSource | null = null;

    const clearTimers = (): void => {
      if (safetyTimerRef.current !== null) {
        window.clearInterval(safetyTimerRef.current);
        safetyTimerRef.current = null;
      }
      if (statusTimerRef.current !== null) {
        window.clearInterval(statusTimerRef.current);
        statusTimerRef.current = null;
      }
    };

    const closeStream = (): void => {
      if (eventSource) {
        try {
          eventSource.close();
        } catch {
          // ignore — already closed by an error/abort race.
        }
        eventSource = null;
      }
    };

    const fetchAndMerge = async (): Promise<void> => {
      try {
        const res = await fetch("/api/notifications", {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        if (cancelled || !res.ok) return;
        const payload = (await res.json().catch(() => null)) as
          | { notifications?: AppNotification[] }
          | null;
        if (cancelled || !payload?.notifications) return;
        const filtered = filterAgentCreationProgressByRunId(
          payload.notifications,
          runId,
        );
        // MERGE, never replace: a snapshot taken before an SSE insert must not
        // drop the SSE-appended row.
        setItems((prev) => mergeProgress(prev, filtered));
      } catch {
        // Transient fetch failure — next interval tick (or SSE) recovers.
      }
    };

    const handleSseEvent = (ev: MessageEvent): void => {
      if (cancelled) return;
      const data = ev.data;
      if (typeof data !== "string" || !data) return;
      let parsed: AppNotification | null = null;
      try {
        parsed = JSON.parse(data) as AppNotification;
      } catch {
        return;
      }
      if (!parsed?.id) return;
      const filtered = filterAgentCreationProgressByRunId([parsed], runId);
      if (filtered.length === 0) return;
      setItems((prev) => mergeProgress(prev, filtered));
    };

    const pollStatus = async (): Promise<void> => {
      try {
        const res = await fetch(
          `/api/agents/runs/${encodeURIComponent(runId)}`,
          {
            method: "GET",
            headers: { Accept: "application/json" },
            cache: "no-store",
          },
        );
        if (cancelled || !res.ok) return;
        const body = (await res.json().catch(() => null)) as
          | { status?: string }
          | null;
        if (cancelled || !body?.status) return;
        if (TERMINAL_STATUSES.has(body.status)) {
          // Final durable sweep so terminal event(s) emitted around job
          // completion are not missed, then tear the live subscription down.
          void fetchAndMerge();
          closeStream();
          clearTimers();
        }
      } catch {
        // Transient — next interval tick retries.
      }
    };

    // 1. Initial replay fetch (reload + headless/no-SSE fallback).
    void fetchAndMerge();

    // 2. Live SSE subscription (primary real-time path). Native EventSource
    //    handles reconnect with the browser's default retry policy; we do NOT
    //    layer manual retry (matches notifications-flyout.tsx behavior — it
    //    fights the browser and spawns duplicate connections). The safety-net
    //    poll covers a hard-failed/absent stream.
    if (
      typeof window !== "undefined" &&
      typeof window.EventSource === "function"
    ) {
      try {
        eventSource = new window.EventSource("/api/notifications/stream");
        eventSource.addEventListener("notification", handleSseEvent);
        eventSource.addEventListener("error", () => {
          // Native reconnect — safety-net poll continues as the fallback.
        });
      } catch {
        eventSource = null;
      }
    }

    // 3. Safety-net poll (backstop for no-SSE + missed frames). Merge, never
    //    replace, so it cannot drop an SSE-appended row.
    safetyTimerRef.current = window.setInterval(
      () => void fetchAndMerge(),
      SAFETY_NET_POLL_MS,
    );

    // 4. Status poll — terminal owner.
    void pollStatus();
    statusTimerRef.current = window.setInterval(
      () => void pollStatus(),
      STATUS_POLL_MS,
    );

    return () => {
      cancelled = true;
      clearTimers();
      closeStream();
    };
  }, [runId]);

  return items;
}
