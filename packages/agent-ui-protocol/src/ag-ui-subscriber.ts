import "server-only";

import { readRecentRunEventsReverse, readRunEvents } from "@cinatra-ai/a2a";

import type { AgUiEvent } from "./events";

/**
 * Snapshot the latest active AG-UI INTERRUPT for a run, walking the Redis
 * Streams log newest-first.
 *
 * Returns the most-recent INTERRUPT payload unless a terminal frame
 * (RUN_FINISHED / RUN_ERROR) was emitted after it - in that case the run
 * has ended and there's no active interrupt to surface. Bounded reverse
 * read; no subscription, no live-tail. Suitable for REST snapshot
 * responses (e.g. `/api/agents/runs/[runId]`).
 *
 * Used by the run-detail REST route so SSR + `page.reload()` deliver the
 * gate's `xRenderer` + `schema` + `values` on first paint without waiting
 * for the SSE INTERRUPT to re-arrive. This avoids returning an empty
 * `xRenderer` for WayFlow gates and removes dependence on SSE hydration,
 * which can race with page reload and dev-server timing.
 */
export type LatestAgUiInterrupt = {
  xRenderer: string;
  schema: Record<string, unknown>;
  values: Record<string, unknown>;
  reviewTaskId: string;
  fieldName?: string;
};

export async function readLatestAgUiInterrupt(
  runId: string,
): Promise<LatestAgUiInterrupt | null> {
  const events = await readRecentRunEventsReverse(runId, 300);

  for (const { event } of events) {
    if ((event as { channel?: string }).channel !== "ag-ui") continue;
    const t = (event as { type?: string }).type;

    // Newer terminal frame means the run is over -> no active interrupt.
    if (t === "RUN_FINISHED" || t === "RUN_ERROR") return null;

    if (t === "INTERRUPT") {
      const xRenderer =
        typeof (event as { xRenderer?: unknown }).xRenderer === "string"
          ? ((event as { xRenderer: string }).xRenderer)
          : "";
      if (!xRenderer) continue;
      const schema =
        typeof (event as { schema?: unknown }).schema === "object" &&
        (event as { schema?: unknown }).schema !== null
          ? ((event as { schema: Record<string, unknown> }).schema)
          : {};
      const values =
        typeof (event as { values?: unknown }).values === "object" &&
        (event as { values?: unknown }).values !== null
          ? ((event as { values: Record<string, unknown> }).values)
          : {};
      const reviewTaskId =
        typeof (event as { reviewTaskId?: unknown }).reviewTaskId === "string"
          ? ((event as { reviewTaskId: string }).reviewTaskId)
          : "";
      const fieldName =
        typeof (event as { fieldName?: unknown }).fieldName === "string"
          ? ((event as { fieldName: string }).fieldName)
          : undefined;
      return { xRenderer, schema, values, reviewTaskId, fieldName };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// AG-UI subscriber backed by the unified Redis Streams event log
// (packages/a2a/src/event-log.ts). Using the durable stream avoids the race
// window where events published during subscriber startup can be lost by
// fire-and-forget pub/sub.
//
// The unified stream (cinatra:a2a:events:{runId}) carries events from both
// A2A producers and AG-UI producers. Each payload carries a `channel`
// discriminator; this subscriber filters to `channel === "ag-ui"`.
//
// API:
//   - subscribeToAgUiEvents -> yields AgUiEvent (backwards compatible)
//   - subscribeToAgUiEventsWithId -> yields { id, event } for SSE id: frames
//
// Terminal detection: the generator returns on RUN_FINISHED or RUN_ERROR.
// ---------------------------------------------------------------------------

const DEFAULT_INACTIVITY_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

export type AgUiSubscribeOptions = {
  signal?: AbortSignal;
  /**
   * Inactivity guard - if no events arrive within this window the
   * generator returns without yielding a synthetic terminal. Default: 2
   * minutes.
   */
  inactivityTimeoutMs?: number;
  /**
   * Resume from a specific Redis Streams entry ID. Value must match
   * /^\d+-\d+$/ (unvalidated here; the route validates before passing
   * through). When undefined, yields from the beginning of the stream.
   */
  fromId?: string;
  /** Kept for backwards compatibility with existing callers; ignored here. */
  redisUrl?: string;
};

/**
 * Yield AG-UI events for the given run, filtered from the unified Redis
 * Streams log. Closes after terminal (RUN_FINISHED or RUN_ERROR) or
 * inactivity.
 *
 * Callers that don't supply fromId get the full history.
 */
export async function* subscribeToAgUiEvents(
  runId: string,
  options: AgUiSubscribeOptions = {},
): AsyncGenerator<AgUiEvent> {
  for await (const { event } of subscribeToAgUiEventsWithId(runId, options)) {
    yield event;
  }
}

/**
 * Variant that also yields the Redis Streams entry ID so SSE routes can emit
 * `id: <id>\n` frames and browser EventSource auto-resumes on reconnect.
 */
export async function* subscribeToAgUiEventsWithId(
  runId: string,
  options: AgUiSubscribeOptions = {},
): AsyncGenerator<{ id: string; event: AgUiEvent }> {
  const inactivityMs =
    options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;

  for await (const { id, event: payload } of readRunEvents(runId, {
    fromId: options.fromId,
    signal: options.signal,
    inactivityMs,
  })) {
    // Filter - unified stream also carries A2A-channel events from the
    // same run (e.g. when both producers emit during a single run).
    const channel = (payload as { channel?: string }).channel;
    if (channel !== "ag-ui") continue;

    // Strip the channel discriminator before yielding so the event matches
    // the on-the-wire AgUiEvent shape.
    const { channel: _discriminator, ...rest } = payload as Record<
      string,
      unknown
    > & { channel?: string };
    void _discriminator;
    const event = rest as unknown as AgUiEvent;

    yield { id, event };

    // Terminal detection follows the AG-UI stream contract.
    if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") {
      return;
    }
  }
}
