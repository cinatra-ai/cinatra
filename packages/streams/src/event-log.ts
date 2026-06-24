import { Redis } from "ioredis";

// ---------------------------------------------------------------------------
// Neutral durable Redis-Streams event log (cinatra#344).
//
// The vocabulary-free MECHANICS extracted from packages/a2a/src/event-log.ts:
// an XADD'd durable per-id log so a consumer can reconnect with a cursor
// (Last-Event-ID) and replay anything it missed during a disconnect. This
// package carries NO `cinatra:a2a:` key literal, NO AG-UI/WayFlow code, and NO
// `server-only` coupling — the caller injects the key namespace and tuning as
// PARAMETERS, so the A2A run-stream, a widget relay, or any other surface can
// reuse the same mechanics by supplying its own prefix.
//
// CONTRACT (per created log):
//   - append(id, payload)   : durable append; returns the Redis stream entry id.
//   - read(id, opts)        : two-phase (XRANGE catch-up + notify-driven live
//                             tail) async generator; yields { id, event } pairs.
//                             `id` is SSE-safe (always "<unix-ms>-<seq>").
//   - readRecentReverse(id) : bounded XREVRANGE snapshot, newest-first.
//   - expire(id, ttl?)      : set TTL on the stream key (call on terminal state).
//   - disconnect()          : release the shared publisher (test/teardown).
//
// ORDERING: within a single id, Redis Streams guarantees monotonic ids and
// strict append order. Cross-id ordering is neither guaranteed nor needed.
//
// SAFETY: stream entry ids are always "<unix-ms>-<seq>" — never contain
// U+0000/U+000A/U+000D, so they are safe to emit as SSE `id:` fields per the
// WHATWG SSE spec.
// ---------------------------------------------------------------------------

const DEFAULT_MAXLEN = 1000;
const DEFAULT_TERMINAL_TTL_SECONDS = 3600;
const DEFAULT_INACTIVITY_MS = 5 * 60 * 1000;
const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379";

export type StreamReadOptions = {
  /**
   * Lower bound for XRANGE catch-up. The reader yields events with ids
   * STRICTLY GREATER than this value. Use "0" (or omit) to yield the full
   * stream history.
   */
  fromId?: string;
  /** Abort the generator — cancels the live-tail loop. */
  signal?: AbortSignal;
  /**
   * Inactivity timeout — if no events arrive within this window the generator
   * returns. Default: the log's `inactivityMs` option (5 minutes).
   */
  inactivityMs?: number;
};

export type DurableEventLogOptions = {
  /**
   * Redis connection URL. Defaults to the `REDIS_URL` env var, then
   * `redis://127.0.0.1:6379`. NO host config module is read — the caller owns
   * resolution and may pass an explicit value.
   */
  redisUrl?: string;
  /** Map a logical id to its Redis Stream key. REQUIRED — this is the injected namespace. */
  streamKey: (id: string) => string;
  /** Map a logical id to its pub/sub wake-up channel. REQUIRED. */
  notifyChannel: (id: string) => string;
  /** Approximate MAXLEN trim threshold. Default 1000. */
  maxLen?: number;
  /** TTL (seconds) applied by `expire()` when no explicit ttl is passed. Default 3600. */
  terminalTtlSeconds?: number;
  /** Default inactivity timeout (ms) for `read()`. Default 5 minutes. */
  inactivityMs?: number;
};

export type DurableEventLogEntry = {
  id: string;
  event: Record<string, unknown>;
};

export type DurableEventLog = {
  /**
   * Durably append one event to the per-id stream and wake live-tail
   * subscribers. Returns the Redis-assigned stream entry id.
   *
   * Pipeline:
   *   XADD <streamKey> MAXLEN ~ <maxLen> * data <json>
   *   PUBLISH <notifyChannel> <id>
   */
  append: (id: string, payload: Record<string, unknown>) => Promise<string>;
  /**
   * Yield events from `fromId` (exclusive) onward, then live-tail until the
   * signal aborts, the inactivity timeout fires, or the caller returns.
   */
  read: (id: string, opts?: StreamReadOptions) => AsyncGenerator<DurableEventLogEntry>;
  /** Bounded reverse-read (XREVRANGE) — most-recent N events, newest-first. */
  readRecentReverse: (id: string, count?: number) => Promise<DurableEventLogEntry[]>;
  /** Set a TTL on the per-id stream key. Call after a terminal transition. */
  expire: (id: string, ttlSeconds?: number) => Promise<void>;
  /** Release the shared publisher connection (test/teardown). */
  disconnect: () => Promise<void>;
};

/**
 * Extract the JSON-decoded event payload from a flat XRANGE/XREVRANGE field
 * array `[key, value, key, value, ...]`. Returns null when no parseable `data`
 * field is present (the caller still advances its cursor past such entries).
 */
function parseEventFields(fields: string[]): Record<string, unknown> | null {
  let dataIdx = -1;
  for (let i = 0; i < fields.length; i += 2) {
    if (fields[i] === "data") {
      dataIdx = i + 1;
      break;
    }
  }
  if (dataIdx < 0) return null;
  try {
    return JSON.parse(fields[dataIdx]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Create a durable event log bound to an injected key namespace. The returned
 * object owns a lazily-created shared publisher connection (one non-subscribe
 * connection for all XADD/PUBLISH/XRANGE/XREVRANGE/EXPIRE in this process); each
 * `read()` opens its own dedicated subscriber connection (subscribe-mode clients
 * cannot issue normal commands) and tears it down in a `finally`.
 */
export function createDurableEventLog(opts: DurableEventLogOptions): DurableEventLog {
  const redisUrl = opts.redisUrl ?? process.env.REDIS_URL ?? DEFAULT_REDIS_URL;
  const maxLen = opts.maxLen ?? DEFAULT_MAXLEN;
  const terminalTtlSeconds = opts.terminalTtlSeconds ?? DEFAULT_TERMINAL_TTL_SECONDS;
  const defaultInactivityMs = opts.inactivityMs ?? DEFAULT_INACTIVITY_MS;
  const { streamKey, notifyChannel } = opts;

  // Lazy-singleton publisher — a single non-subscribe-mode connection handles
  // all XADD + PUBLISH + XRANGE/XREVRANGE + EXPIRE for this log.
  let sharedPublisher: Redis | null = null;
  function getPublisher(): Redis {
    if (!sharedPublisher) {
      sharedPublisher = new Redis(redisUrl, {
        lazyConnect: false,
        maxRetriesPerRequest: 3,
      });
    }
    return sharedPublisher;
  }

  async function append(id: string, payload: Record<string, unknown>): Promise<string> {
    const r = getPublisher();
    const json = JSON.stringify(payload);
    try {
      const pipeline = r.pipeline();
      pipeline.xadd(streamKey(id), "MAXLEN", "~", String(maxLen), "*", "data", json);
      const execResult = await pipeline.exec();
      // pipeline.exec returns Array<[err, result]> | null; the xadd result is at [0][1].
      if (!execResult || execResult.length === 0) {
        throw new Error(`createDurableEventLog.append: pipeline.exec returned null for id=${id}`);
      }
      const [xaddErr, xaddId] = execResult[0] as [Error | null, string | null];
      if (xaddErr) throw xaddErr;
      const entryId = xaddId ?? "";
      // Second round-trip is acceptable — publish is fire-and-forget and live
      // subscribers also poll XRANGE after any notify, so an occasional lost
      // PUBLISH is not a correctness issue.
      await r.publish(notifyChannel(id), entryId).catch(() => {
        /* best-effort */
      });
      return entryId;
    } catch (err) {
      // XADD failures must be observable — replay durability gaps would
      // otherwise be invisible. Log before rethrowing (callers may absorb).
      console.error("[streams:event-log] XADD failed for id %s: %o", id, err);
      throw err;
    }
  }

  async function expire(id: string, ttlSeconds: number = terminalTtlSeconds): Promise<void> {
    const r = getPublisher();
    await r.expire(streamKey(id), ttlSeconds);
  }

  async function readRecentReverse(id: string, count = 200): Promise<DurableEventLogEntry[]> {
    const r = getPublisher();
    const entries = (await r.xrevrange(streamKey(id), "+", "-", "COUNT", String(count))) as Array<
      [string, string[]]
    >;
    const out: DurableEventLogEntry[] = [];
    for (const [entryId, fields] of entries) {
      const event = parseEventFields(fields);
      if (event === null) continue;
      out.push({ id: entryId, event });
    }
    return out;
  }

  /**
   * TWO-PHASE CURSOR (mitigates events arriving between catch-up and subscribe):
   *   1. Attach subscriber.on("message", ...) listener (no subscribe yet).
   *   2. subscriber.subscribe(notifyChannel) — listener is now live.
   *   3. XRANGE <streamKey> (<fromId> +  — catch-up; any events published in
   *      the window between step 1 and step 3 produce a notify that enqueues a
   *      wake-up (the listener is already attached), handled by re-XRANGE-ing
   *      from the last-yielded id.
   *   4. Loop: on wake-up, XRANGE from last-yielded-id exclusive, yield deltas.
   */
  async function* read(
    id: string,
    readOpts: StreamReadOptions = {},
  ): AsyncGenerator<DurableEventLogEntry> {
    const inactivityMs = readOpts.inactivityMs ?? defaultInactivityMs;
    const sKey = streamKey(id);
    const nChan = notifyChannel(id);

    // Dedicated subscriber connection — subscribe-mode clients cannot issue
    // normal commands, and maxRetriesPerRequest must be null (per ioredis docs).
    const subscriber = new Redis(redisUrl, {
      lazyConnect: false,
      maxRetriesPerRequest: null,
    });

    // Separate reader connection for XRANGE — cannot share with subscriber.
    const reader = getPublisher();

    let closed = false;
    let wakeUp: (() => void) | null = null;
    // A notify that arrives while no waiter is armed (between an XRANGE loop and
    // the next wait, or during a catch-up XRANGE) MUST NOT be lost — otherwise a
    // durable event published in that window would only surface after the
    // inactivity timeout (or never). Latch it so the next wait-arm short-circuits
    // into an immediate re-XRANGE instead of sleeping.
    let pendingNotify = false;

    const onMessage = (incomingChannel: string): void => {
      if (incomingChannel !== nChan) return;
      if (wakeUp) {
        const w = wakeUp;
        wakeUp = null;
        w();
      } else {
        pendingNotify = true;
      }
    };
    subscriber.on("message", onMessage);

    const onAbort = (): void => {
      closed = true;
      if (wakeUp) {
        const w = wakeUp;
        wakeUp = null;
        w();
      }
    };
    if (readOpts.signal) {
      if (readOpts.signal.aborted) closed = true;
      else readOpts.signal.addEventListener("abort", onAbort, { once: true });
    }

    // Cursor — exclusive lower bound. XRANGE accepts "(<id>" for exclusive
    // start; we convert from readOpts.fromId (inclusive-semantics in our API)
    // to Redis's exclusive syntax on first read, then track our own
    // last-yielded id and use "(<id>" for subsequent XRANGE calls.
    let lastYieldedId: string | null =
      readOpts.fromId && readOpts.fromId !== "0" ? readOpts.fromId : null;

    try {
      await subscriber.subscribe(nChan);

      while (!closed) {
        const start = lastYieldedId ? `(${lastYieldedId}` : "-";
        const entries = (await reader.xrange(sKey, start, "+")) as Array<[string, string[]]>;
        for (const [entryId, fields] of entries) {
          if (closed) return;
          const event = parseEventFields(fields);
          if (event === null) {
            lastYieldedId = entryId;
            continue;
          }
          yield { id: entryId, event };
          lastYieldedId = entryId;
        }

        if (closed) return;

        // A notify landed during catch-up / between iterations — re-XRANGE now
        // rather than arming a wait that would miss the already-published event.
        if (pendingNotify) {
          pendingNotify = false;
          continue;
        }

        // Wait for a notify or the inactivity timeout.
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        const waitPromise = new Promise<void>((resolve) => {
          wakeUp = resolve;
        });
        const timeoutPromise = new Promise<"timeout">((resolve) => {
          timeoutHandle = setTimeout(() => resolve("timeout"), inactivityMs);
        });
        const result = await Promise.race([
          waitPromise.then(() => "wake" as const),
          timeoutPromise,
        ]);
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (closed) return;
        if (result === "timeout") return;
        // Loop — next XRANGE reads any events published since lastYieldedId.
      }
    } finally {
      subscriber.off("message", onMessage);
      if (readOpts.signal) readOpts.signal.removeEventListener("abort", onAbort);
      try {
        await subscriber.unsubscribe(nChan);
      } catch {
        /* best-effort */
      }
      try {
        await subscriber.quit();
      } catch {
        /* best-effort */
      }
    }
  }

  async function disconnect(): Promise<void> {
    if (sharedPublisher) {
      const pub = sharedPublisher;
      sharedPublisher = null;
      await pub.quit().catch(() => {
        /* swallow */
      });
    }
  }

  return { append, read, readRecentReverse, expire, disconnect };
}
