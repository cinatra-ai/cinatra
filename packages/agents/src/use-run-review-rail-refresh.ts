"use client";

import { useEffect, useRef } from "react";

/**
 * The review reading is live; the run rail is composed by the server (#3942).
 * Recompose that tree when the existing reader finds a new gate, without a
 * second poller or navigation. Opaque tickets have a fresh nonce on each read,
 * so only the stable task identity can dedupe a gate. It grants no authority;
 * the card still resolves and acts through its opaque server-minted ticket.
 */
export function useRunReviewRailRefresh({
  runId,
  reviewTaskId,
  initialReviewTaskIds,
  refresh,
}: {
  runId: string;
  reviewTaskId: string | null | undefined;
  initialReviewTaskIds: readonly string[] | undefined;
  /** Supplied by the actual page owner; this hook needs no router context. */
  refresh: (() => void) | undefined;
}): void {
  const observed = useRef({ runId, tasks: new Set<string>() });

  useEffect(() => {
    if (observed.current.runId !== runId) {
      observed.current = { runId, tasks: new Set<string>() };
    }
    const tasks = observed.current.tasks;
    // Seed only gates actually included in the server's rail query. The later
    // slot read can discover a gate opened between those two reads; treating
    // that slot's identity as already painted would lose its rail refresh.
    // This also seeds refreshed/remounted trees without a refresh loop.
    for (const taskId of initialReviewTaskIds ?? []) tasks.add(taskId);
    if (!refresh || !reviewTaskId || tasks.has(reviewTaskId)) return;
    tasks.add(reviewTaskId);
    refresh();
  }, [initialReviewTaskIds, refresh, reviewTaskId, runId]);
}
