import "server-only";
import { Redis } from "ioredis";
import { xaddRunEvent } from "@cinatra-ai/a2a";
import type { AgentUIAdapter } from "./adapter";
import type { AgUiEvent } from "./events";
import { channelFor } from "./channel";

// ---------------------------------------------------------------------------
// Redis publisher — lazy-init singleton (mirroring streaming-bridge.ts pattern)
// ---------------------------------------------------------------------------

function resolveRedisUrl(): string {
  return process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
}

let sharedPublisher: Redis | null = null;

function getPublisher(): Redis {
  if (!sharedPublisher) {
    sharedPublisher = new Redis(resolveRedisUrl(), {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
    });
  }
  return sharedPublisher;
}

/**
 * Publish a single AG-UI event to the Redis channel for `runId`.
 *
 * Durably appends to the unified Redis Streams event log (shared with A2A)
 * AND publishes to the legacy pub/sub channel for backward compatibility.
 *
 * XADD is best-effort (non-fatal). Legacy PUBLISH still runs regardless so
 * live UI continues working even if the durable log is temporarily
 * unavailable. XADD failures are logged so durability gaps are observable.
 */
export async function publishAgUiEvent(
  runId: string,
  event: AgUiEvent,
): Promise<void> {
  // Durably append to the unified Redis Streams event log (shared with A2A)
  // so both AG-UI workspace SSE and A2A tasks/resubscribe can replay the same
  // timeline. Stamped with channel: "ag-ui" so subscribers can filter.
  await xaddRunEvent(runId, {
    channel: "ag-ui",
    ...(event as unknown as Record<string, unknown>),
  }).catch((err) => {
    // XADD failures must be observable. Business flow stays non-fatal (we
    // still legacy-PUBLISH below so live UI works), but without this log
    // replay durability gaps are invisible.
    console.error("[ag-ui-adapter] XADD failed for run %s: %o", runId, err);
    // XADD failure is non-fatal — live pub/sub still works via legacy publish
  });

  // Legacy PUBLISH — retained for backward compat until subscribeToAgUiEvents
  // callers migrate to the Streams-backed reader. Remove in a follow-up.
  const publisher = getPublisher();
  await publisher.publish(channelFor(runId), JSON.stringify(event));
}

/**
 * Release the shared publisher connection.
 * Tests call this in afterAll() to avoid leaking handles past test end.
 */
export async function __disconnectSharedAgUiPublisher(): Promise<void> {
  if (sharedPublisher) {
    const pub = sharedPublisher;
    sharedPublisher = null;
    await pub.quit().catch(() => { /* swallow — best-effort teardown */ });
  }
}

// ---------------------------------------------------------------------------
// AgUiAdapter — fully functional implementation of AgentUIAdapter.
//
// Dependency-injected publish fn: callers (BullMQ workers) pass publishAgUiEvent;
// tests pass an in-memory mock — no Redis required for unit tests.
//
// CRITICAL: every `void this.publish(...)` call MUST have `.catch(() => {})`
// to prevent unhandled promise rejections when Redis is unavailable.
// The fire-and-forget contract means Redis failures are silently swallowed —
// execution continues regardless (DB write is the source of truth).
// ---------------------------------------------------------------------------

export class AgUiAdapter implements AgentUIAdapter {
  constructor(
    private readonly runId: string,
    private readonly threadId: string,
    private readonly publish: (event: AgUiEvent) => Promise<void>,
  ) {}

  onRunStarted(): void {
    void this.publish({
      type: "RUN_STARTED",
      threadId: this.threadId,
      runId: this.runId,
      timestamp: Date.now(),
    }).catch(() => {});
  }

  onRunFinished(status: "completed" | "failed" | "stopped", error?: string): void {
    if (status === "failed") {
      void this.publish({
        type: "RUN_ERROR",
        threadId: this.threadId,
        runId: this.runId,
        message: error ?? "unknown error",
        timestamp: Date.now(),
      }).catch(() => {});
    } else {
      // "completed" or "stopped" — both emit RUN_FINISHED; status field distinguishes them.
      void this.publish({
        type: "RUN_FINISHED",
        threadId: this.threadId,
        runId: this.runId,
        status,
        timestamp: Date.now(),
      }).catch(() => {});
    }
  }

  onTextDelta(messageId: string, delta: string): void {
    void this.publish({
      type: "TEXT_MESSAGE_CONTENT",
      messageId,
      delta,
      timestamp: Date.now(),
    }).catch(() => {});
  }

  onToolCallStart(toolCallId: string, toolName: string, _args: unknown): void {
    void this.publish({
      type: "TOOL_CALL_START",
      toolCallId,
      toolCallName: toolName,
      timestamp: Date.now(),
    }).catch(() => {});
  }

  onToolCallEnd(toolCallId: string, _toolName: string, _result: unknown): void {
    void this.publish({
      type: "TOOL_CALL_END",
      toolCallId,
      timestamp: Date.now(),
    }).catch(() => {});
  }

  onStateSnapshot(snapshot: unknown): void {
    void this.publish({
      type: "STATE_SNAPSHOT",
      snapshot,
      timestamp: Date.now(),
    }).catch(() => {});
  }

  // HITL resume clears interruptContext on the client.
  onResume(): void {
    void this.publish({
      type: "RESUME",
      threadId: this.threadId,
      runId: this.runId,
      timestamp: Date.now(),
    }).catch(() => {});
  }

  // HITL interrupt published as first-class AG-UI event.
  //
  // fieldName (5th arg, optional) is carried on the INTERRUPT event so the UI
  // approval flow can round-trip it into the resume payload (see
  // LangGraphResumeJobData.resume.fieldName). Legacy callers that omit the 5th
  // arg continue to work — the event gains a new optional key, not a mutation
  // of existing ones; the 5 required keys remain byte-identical.
  onInterrupt(
    schema: Record<string, unknown>,
    xRenderer: string,
    values: Record<string, unknown>,
    reviewTaskId: string,
    fieldName?: string,
  ): void {
    // `values` is forwarded by reference — any `presentation` key inside
    // survives JSON.stringify in publishAgUiEvent and xaddRunEvent (no field
    // filter anywhere). No code change needed here.
    void this.publish({
      type: "INTERRUPT",
      threadId: this.threadId,
      runId: this.runId,
      schema,
      xRenderer,
      values,
      reviewTaskId,
      fieldName, // optional; absent for legacy paths
      timestamp: Date.now(),
    }).catch(() => {});
  }
}
