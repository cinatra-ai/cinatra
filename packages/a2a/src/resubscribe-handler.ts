import "server-only";

import type { Task, TaskIdParams, TaskState, TaskStatusUpdateEvent, TaskArtifactUpdateEvent } from "@a2a-js/sdk";
import type { TaskStore } from "@a2a-js/sdk/server";
import { DefaultRequestHandler, ServerCallContext, A2AError } from "@a2a-js/sdk/server";

import { TERMINAL_A2A_STATES } from "./types";
import { readRunEvents } from "./event-log";

// ---------------------------------------------------------------------------
// CinatraResubscribeHandler
//
// Extends DefaultRequestHandler to replace the default in-memory EventBus
// resubscribe path with a durable Redis Streams replay (readRunEvents).
//
// The default SDK `resubscribe`:
//   1. Yields the current Task from taskStore.
//   2. If terminal: returns immediately.
//   3. Otherwise: subscribes to an in-memory ExecutionEventBus — which is
//      useless for reconnected clients because the bus dies with the process.
//
// CinatraResubscribeHandler overrides step 3:
//   1. Yields the current Task from taskStore (same as default).
//   2. If terminal: yields Task with metadata.eventId (for SSE id: frame) and returns.
//   3. Otherwise: reads from readRunEvents(taskId, { fromId, signal }) and
//      yields each event with metadata.eventId stamped so the route's
//      `extractId` callback can emit SSE `id:` frames.
//
// METADATA CONTRACT:
//   The route's extractId reads `chunk.result?.metadata?.eventId`.
//   The JsonRpcTransportHandler wraps our yielded events as:
//     { jsonrpc: "2.0", id: reqId, result: <event> }
//   So <event>.metadata.eventId is the path the route reads.
//   Both Task and TaskStatusUpdateEvent have `metadata?: { [k: string]: unknown }`.
//
// LAST-EVENT-ID CONTRACT:
//   The route threads `lastEventId` from the HTTP header into the context
//   as a plain property (the SDK opaque cast). We read it with:
//     (context as unknown as { lastEventId?: string }).lastEventId
//
// TERMINAL DETECTION:
//   Use TERMINAL_A2A_STATES from ./types — same set used by InProcessAgentExecutor.
// ---------------------------------------------------------------------------

/**
 * The shape Cinatra adds to ServerCallContext. The route casts a plain object
 * `{ lastEventId: string | undefined }` to `ServerCallContext` before passing
 * to `mount.handle`. We read it back here with an explicit cast.
 */
type CinatraServerCallContext = {
  lastEventId?: string;
};

/**
 * Extends DefaultRequestHandler to replace the default in-memory EventBus
 * resubscribe path with a durable Redis Streams replay via `readRunEvents`.
 *
 * Drop-in replacement for DefaultRequestHandler in `src/lib/a2a-server.ts`.
 * The constructor signature is identical to DefaultRequestHandler; only
 * `resubscribe` is overridden.
 */
export class CinatraResubscribeHandler extends DefaultRequestHandler {
  // Explicit passthrough constructor so the class is typed as constructable
  // with the same parameters as DefaultRequestHandler at the root tsconfig
  // level (where @a2a-js/sdk is not in scope and the parent becomes `any`).
  // Without this, tsc infers a 0-argument constructor from the implicit
  // no-args class definition, causing TS2554 at call sites.
  constructor(...args: ConstructorParameters<typeof DefaultRequestHandler>) {
    super(...args);
  }

  /**
   * Override resubscribe to replay from the Redis Streams durable event log
   * instead of the default in-memory ExecutionEventBus.
   *
   * Yields:
   *   1. The current Task (with metadata.eventId = "") so the first SSE frame
   *      carries the task snapshot. The eventId for the Task frame is left
   *      blank — the client's Last-Event-ID cursor is stream-event granular,
   *      not task-snapshot granular.
   *   2. For non-terminal tasks: all Redis Streams events after `lastEventId`
   *      (exclusive), each stamped with metadata.eventId = <redis-streams-id>.
   *      Returns when the stream returns a terminal `final: true` event, the
   *      inactivity window expires, or the request signal is aborted.
   */
  async *resubscribe(
    params: TaskIdParams,
    context?: ServerCallContext,
  ): AsyncGenerator<Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent, void, undefined> {
    // 1. Streaming capability check (same guard as DefaultRequestHandler).
    const agentCard = await this.getAgentCard();
    if (!agentCard.capabilities?.streaming) {
      throw A2AError.unsupportedOperation(
        "Streaming (and thus resubscription) is not supported.",
      );
    }

    // 2. Load the current task snapshot.
    const task = await (this as unknown as { taskStore: TaskStore }).taskStore.load(
      params.id,
      context,
    );
    if (!task) {
      throw A2AError.taskNotFound(params.id);
    }

    // 3. Yield the current Task snapshot (no eventId — this is a state snapshot,
    //    not a Redis Streams entry).
    yield task;

    // 4. If the task is already terminal, return immediately.
    if (TERMINAL_A2A_STATES.has(task.status.state as TaskState)) {
      return;
    }

    // 5. Read Last-Event-ID from the context. The route sets this from the
    //    HTTP header before calling mount.handle.
    const cinatraCtx = context as unknown as CinatraServerCallContext;
    const fromId = cinatraCtx?.lastEventId;

    // 6. Derive AbortSignal from request context if available (best-effort;
    //    the context may not carry a signal in all call paths).
    // The SDK's ServerCallContext does not expose a signal; we check for the
    // Cinatra extension field which could be added in future changes. For now
    // signal is undefined and readRunEvents will rely on the inactivity timeout.
    const signal: AbortSignal | undefined = cinatraCtx
      ? (cinatraCtx as unknown as { signal?: AbortSignal }).signal
      : undefined;

    // 7. Replay from the durable event log.
    for await (const { id: eventId, event } of readRunEvents(params.id, {
      fromId,
      signal,
    })) {
      // Map raw persisted event (Record<string,unknown>) to a typed A2A event.
      // publishRunEvent stores the original event payload as JSON — it will be
      // a TaskStatusUpdateEvent or TaskArtifactUpdateEvent shape.
      const kind = (event as { kind?: string }).kind;

      if (kind === "status-update") {
        const statusEvent = event as unknown as TaskStatusUpdateEvent;
        // Stamp the Redis Streams ID so the route's extractId emits `id:` frames.
        const enriched: TaskStatusUpdateEvent = {
          ...statusEvent,
          metadata: {
            ...(statusEvent.metadata ?? {}),
            eventId,
          },
        };
        yield enriched;
        // If this is the final event, stop reading from the log.
        if (statusEvent.final) {
          return;
        }
      } else if (kind === "artifact-update") {
        const artifactEvent = event as unknown as TaskArtifactUpdateEvent;
        // TaskArtifactUpdateEvent has metadata?: { [k: string]: unknown }.
        const enriched: TaskArtifactUpdateEvent = {
          ...artifactEvent,
          metadata: {
            ...(artifactEvent.metadata ?? {}),
            eventId,
          },
        };
        yield enriched;
      } else if (kind === "task") {
        // Task updates from the stream (rare; executor may republish full Task).
        const taskEvent = event as unknown as Task;
        const enriched: Task = {
          ...taskEvent,
          metadata: {
            ...(taskEvent.metadata ?? {}),
            eventId,
          },
        };
        yield enriched;
        // If this task is terminal, stop.
        if (TERMINAL_A2A_STATES.has(taskEvent.status.state as TaskState)) {
          return;
        }
      }
      // Unknown event kinds are skipped — forward compat for future event types.
    }
  }
}
