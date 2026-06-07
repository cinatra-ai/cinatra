import "server-only";

import { Redis } from "ioredis";

import { xaddRunEvent } from "./event-log";

// ---------------------------------------------------------------------------
// Streaming Bridge — Redis pub/sub prototype
//
// Bridges BullMQ worker progress events to an A2A streaming consumer via a
// Redis pub/sub channel keyed by runId. Worker publishes `RunStreamEvent`s
// to `cinatra:a2a:run:{runId}`; streaming handler subscribes and yields.
//
// SCOPE BOUNDARY — PROTOTYPE ONLY.
// Public transport contract, SSE HTTP wiring, connection pooling,
// reconnection, multi-tenant channel isolation, auth, and backpressure
// are outside this module. This module is the minimum needed to prove
// viability end-to-end.
// ---------------------------------------------------------------------------

/**
 * RunStreamEvent — internal streaming prototype contract.
 *
 * Ordering: events are delivered in publish order on a single Redis channel
 *   per runId. Cross-run ordering is not guaranteed (not required).
 * Terminal event: exactly one `{ type: "done" }` per runId. Subscribers MUST
 *   close their generator after receiving it. Publishers MUST publish it
 *   exactly once when the underlying agent_run reaches a terminal state
 *   (succeeded / failed / stopped).
 * Loss acceptance: events published BEFORE a subscriber attaches are
 *   accepted as lost because pub/sub is ephemeral, with no replay.
 *   Bootstrap-from-DB is not implemented here.
 * No backfill, no replay, no per-subscriber buffering in this plan.
 */
export type RunStreamEvent =
  | { type: "status"; state: string }
  | {
      type: "artifact";
      artifact: {
        name?: string;
        parts: Array<{ kind: "text"; text: string }>;
      };
    }
  | { type: "error"; reason: string; detail?: string } // SSE proxy terminal semantics
  | { type: "done" };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function channelFor(runId: string): string {
  return `cinatra:a2a:run:${runId}`;
}

function resolveRedisUrl(): string {
  return process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
}

// ---------------------------------------------------------------------------
// Publisher
// ---------------------------------------------------------------------------

// A single shared publisher connection is sufficient — Redis PUBLISH can
// share a normal (non-subscribe-mode) client. Lazy-initialized.
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
 * Publish a single `RunStreamEvent` to the Redis channel for `runId`.
 *
 * Spike contract:
 *   - Fire-and-forget semantics. Returns after Redis acks the PUBLISH.
 *   - Subscribers that haven't attached yet will NOT see this event
 *     (pub/sub is ephemeral; no replay).
 *   - Publishers MUST emit exactly one `{ type: "done" }` per runId when
 *     the agent_run reaches a terminal state.
 */
export async function publishRunEvent(
  runId: string,
  event: RunStreamEvent,
): Promise<void> {
  // Dual-write: XADD to the durable per-run stream first so
  // external A2A clients using tasks/resubscribe + Last-Event-ID can replay.
  // The legacy PUBLISH remains for backward compat until all subscribers
  // migrate to readRunEvents; remove after subscribers migrate.
  await xaddRunEvent(runId, event as Record<string, unknown>).catch(() => {
    /* best-effort — do NOT block pub/sub on XADD failure */
  });
  const publisher = getPublisher();
  const channel = channelFor(runId);
  await publisher.publish(channel, JSON.stringify(event));
}

/**
 * Spike-only helper — release the shared publisher connection.
 * Tests call this in teardown to avoid leaking a handle past test end.
 * Not part of the public streaming API.
 */
export async function __disconnectSharedPublisher(): Promise<void> {
  if (sharedPublisher) {
    const pub = sharedPublisher;
    sharedPublisher = null;
    await pub.quit().catch(() => {
      /* swallow — best-effort teardown */
    });
  }
}

// ---------------------------------------------------------------------------
// Subscriber
// ---------------------------------------------------------------------------

export type SubscribeToRunEventsOptions = {
  signal?: AbortSignal;
  /**
   * Spike-only override (tests use a short value to validate the inactivity
   * branch without waiting 5 minutes). Not part of the public streaming API.
   */
  inactivityTimeoutMs?: number;
  /**
   * Spike-only override — use an explicit redis URL. Defaults to
   * `process.env.REDIS_URL || redis://127.0.0.1:6379`.
   */
  redisUrl?: string;
};

/**
 * Subscribe to run events for `runId` and yield them in arrival order.
 *
 * Spike contract:
 *   - Creates a dedicated Redis subscriber connection (Redis requires a
 *     separate connection for subscribe mode — cannot share the publisher).
 *   - Inactivity guard: if no events arrive within `inactivityTimeoutMs`
 *     (default 5 min), yields `{ type: "done" }` and closes.
 *   - Closes cleanly on generator return/throw and on `signal.aborted`.
 *   - Events published BEFORE the subscriber attaches are lost (no replay).
 *
 * Cleanup contract: when the generator is returned (either because the
 * caller `break`s/`return`s out of the `for await` loop, or because `done`
 * was yielded, or because `signal` aborted), the Redis subscriber connection
 * is `.quit()`'d — no leaked connections.
 */
export async function* subscribeToRunEvents(
  runId: string,
  options: SubscribeToRunEventsOptions = {},
): AsyncGenerator<RunStreamEvent> {
  const inactivityTimeoutMs =
    options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
  const redisUrl = options.redisUrl ?? resolveRedisUrl();
  const channel = channelFor(runId);

  // Dedicated subscriber connection — Redis enters subscribe mode on this
  // client and cannot issue normal commands until unsubscribed.
  const subscriber = new Redis(redisUrl, {
    lazyConnect: false,
    maxRetriesPerRequest: null, // subscribe-mode clients should not limit retries
  });

  // Queue of received events plus a resolver for awaiting the next one.
  const queue: RunStreamEvent[] = [];
  let resolveNext: (() => void) | null = null;
  let closed = false;

  function pushEvent(event: RunStreamEvent): void {
    queue.push(event);
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  }

  function wakeUp(): void {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  }

  const onMessage = (incomingChannel: string, raw: string): void => {
    if (incomingChannel !== channel) return;
    try {
      const parsed = JSON.parse(raw) as RunStreamEvent;
      pushEvent(parsed);
    } catch {
      // Malformed message — drop silently; structured validation and logging
      // are outside this prototype.
    }
  };

  subscriber.on("message", onMessage);

  // Abort signal wiring — flip closed + wake up any pending awaiter.
  const onAbort = (): void => {
    closed = true;
    wakeUp();
  };
  if (options.signal) {
    if (options.signal.aborted) {
      closed = true;
    } else {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  try {
    await subscriber.subscribe(channel);

    while (!closed) {
      if (queue.length > 0) {
        const event = queue.shift()!;
        yield event;
        if (event.type === "done") {
          return;
        }
        continue;
      }

      // Wait for either a new event, an abort, or the inactivity timeout.
      let timeoutHandle: NodeJS.Timeout | null = null;
      const waitPromise = new Promise<void>((resolve) => {
        resolveNext = resolve;
      });
      const timeoutPromise = new Promise<"timeout">((resolve) => {
        timeoutHandle = setTimeout(() => resolve("timeout"), inactivityTimeoutMs);
      });

      const result = await Promise.race([
        waitPromise.then(() => "event" as const),
        timeoutPromise,
      ]);

      if (timeoutHandle) clearTimeout(timeoutHandle);

      if (closed) return;

      if (result === "timeout") {
        // Inactivity guard — yield a synthetic done and close.
        yield { type: "done" };
        return;
      }
      // Loop; queue now has at least one event.
    }
  } finally {
    subscriber.off("message", onMessage);
    if (options.signal) {
      options.signal.removeEventListener("abort", onAbort);
    }
    try {
      await subscriber.unsubscribe(channel);
    } catch {
      /* best-effort */
    }
    try {
      await subscriber.quit();
    } catch {
      /* best-effort — connection may already be closed */
    }
  }
}
