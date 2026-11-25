import "server-only";

import { createHash } from "node:crypto";

import { Redis } from "ioredis";

// ---------------------------------------------------------------------------
// Redis Streams durable per-run event log.
//
// Replaces the fire-and-forget pub/sub model with XADD'd streams so external
// A2A clients can reconnect via tasks/resubscribe + Last-Event-ID and replay
// any events they missed during a disconnect.
//
// KEYS:
//   cinatra:a2a:events:{runId}   — Redis Stream (XADD + XRANGE)
//   cinatra:a2a:notify:{runId}   — Pub/Sub wake-up channel (PUBLISH + SUBSCRIBE)
//
// CONTRACT:
//   - xaddRunEvent  : durable append; returns the Redis-assigned stream ID.
//   - readRunEvents : two-phase (XRANGE catch-up + notify-driven live tail).
//                     Yields { id, event } pairs; id is the SSE id: value.
//   - expireRunStream : set TTL on the stream key; call on terminal state.
//
// ORDERING: within a single runId, Redis Streams guarantees monotonic IDs
// and strict append order. Cross-run ordering is not guaranteed and not needed.
//
// SAFETY: Stream entry IDs are always "<unix-ms>-<seq>" — never contain
// U+0000/U+000A/U+000D, so they are safe to emit as SSE `id:` fields per
// the WHATWG SSE spec.
// ---------------------------------------------------------------------------

const STREAM_MAXLEN = 1000;
const TERMINAL_TTL_SECONDS = 3600;
const DEFAULT_INACTIVITY_MS = 5 * 60 * 1000;

function resolveRedisUrl(): string {
  return process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
}

function streamKey(runId: string): string {
  return `cinatra:a2a:events:${runId}`;
}

function notifyChannel(runId: string): string {
  return `cinatra:a2a:notify:${runId}`;
}

// Lazy-singleton publisher — a single non-subscribe-mode connection handles
// all XADD + PUBLISH calls for the process. Mirrors the pattern in
// streaming-bridge.ts:65-75.
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
 * Test-teardown helper. Releases the shared publisher connection so Vitest
 * doesn't leak a handle. Paralleling streaming-bridge.ts:__disconnectSharedPublisher.
 */
export async function __disconnectSharedEventLogPublisher(): Promise<void> {
  if (sharedPublisher) {
    const pub = sharedPublisher;
    sharedPublisher = null;
    await pub.quit().catch(() => {
      /* swallow */
    });
  }
}

/**
 * Durably append one event to the per-run stream and wake live-tail
 * subscribers. Returns the Redis-assigned stream entry ID.
 *
 * Pipeline:
 *   XADD <streamKey> MAXLEN ~ 1000 * data <json>
 *   PUBLISH <notifyChannel> <id>
 *
 * `MAXLEN ~ 1000` uses approximate trimming: whole macro-nodes are evicted
 * when the stream crosses the threshold, which is O(1) amortized. The
 * stream may carry a few tens of extra entries past 1000 — acceptable
 * because the replay window is bounded by run lifetime, not entry count.
 */
export async function xaddRunEvent(
  runId: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const r = getPublisher();
  const json = JSON.stringify(payload);
  try {
    const pipeline = r.pipeline();
    pipeline.xadd(
      streamKey(runId),
      "MAXLEN",
      "~",
      String(STREAM_MAXLEN),
      "*",
      "data",
      json,
    );
    const execResult = await pipeline.exec();
    // pipeline.exec returns Array<[err, result]> | null; the xadd result is at [0][1].
    if (!execResult || execResult.length === 0) {
      throw new Error(
        `xaddRunEvent: pipeline.exec returned null for runId=${runId}`,
      );
    }
    const [xaddErr, xaddId] = execResult[0] as [Error | null, string | null];
    if (xaddErr) throw xaddErr;
    const id = xaddId ?? "";
    // Second round-trip is acceptable — publish is fire-and-forget and live
    // subscribers also poll XRANGE after any notify, so an occasional lost
    // PUBLISH is not a correctness issue.
    await r.publish(notifyChannel(runId), id).catch(() => {
      /* best-effort */
    });
    return id;
  } catch (err) {
    // XADD failures must be observable. Upstream
    // wrappers (e.g. streaming-bridge.publishRunEvent) absorb via their own
    // .catch so business flow stays non-fatal, but replay durability gaps
    // would otherwise be invisible. Log before rethrowing.
    console.error("[event-log] XADD failed for run %s: %o", runId, err);
    throw err;
  }
}

/**
 * Set a TTL on the per-run stream key. Call after the run transitions to a
 * terminal state so old streams are cleaned up automatically.
 */
export async function expireRunStream(
  runId: string,
  ttlSeconds: number = TERMINAL_TTL_SECONDS,
): Promise<void> {
  const r = getPublisher();
  await r.expire(streamKey(runId), ttlSeconds);
}

/**
 * Bounded reverse-read for REST callers.
 *
 * `readRunEvents()` is a live-tail generator that can wait on inactivity.
 * For REST snapshots (`/api/agents/runs/[runId]`) we want one bounded
 * `XREVRANGE` — return the most-recent N events newest-first, no
 * subscription, no live-tail.
 *
 * Caller layers the AG-UI semantics on top: filter by
 * `event.channel === "ag-ui"` and walk newest-first until you find the
 * latest `INTERRUPT` (or a `RESUME` / terminal frame, which means the
 * latest interrupt has already been dispositioned).
 */
export async function readRecentRunEventsReverse(
  runId: string,
  count = 200,
): Promise<Array<{ id: string; event: Record<string, unknown> }>> {
  const r = getPublisher();
  const entries = (await r.xrevrange(
    streamKey(runId),
    "+",
    "-",
    "COUNT",
    String(count),
  )) as Array<[string, string[]]>;

  const out: Array<{ id: string; event: Record<string, unknown> }> = [];
  for (const [id, fields] of entries) {
    // fields is flat: [key, value, key, value, ...] — find "data".
    let dataIdx = -1;
    for (let i = 0; i < fields.length; i += 2) {
      if (fields[i] === "data") {
        dataIdx = i + 1;
        break;
      }
    }
    if (dataIdx < 0) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(fields[dataIdx]) as Record<string, unknown>;
    } catch {
      continue;
    }
    out.push({ id, event });
  }
  return out;
}

export type StreamReadOptions = {
  /**
   * Lower bound for XRANGE catch-up. The reader yields events with IDs
   * STRICTLY GREATER than this value. Use "0" (or omit) to yield the full
   * stream history.
   */
  fromId?: string;
  /** Abort the generator — cancels live-tail loop. */
  signal?: AbortSignal;
  /**
   * Inactivity timeout — if no events arrive within this window the
   * generator returns. Default: 5 minutes.
   */
  inactivityMs?: number;
};

/**
 * Yield events from `fromId` (exclusive) onward, then live-tail until the
 * signal aborts, the inactivity timeout fires, or the caller returns.
 *
 * TWO-PHASE CURSOR (mitigates events arriving between catch-up and subscribe):
 *   1. Attach subscriber.on("message", ...) listener (no subscribe yet).
 *   2. subscriber.subscribe(notifyChannel) — listener is now live.
 *   3. XRANGE <streamKey> (<fromId> +  — catch-up; any events published
 *      in the window between step 1 and step 3 produce a notify that
 *      enqueues a wake-up (the listener is already attached), which we
 *      handle after catch-up by XRANGE-ing from the last-yielded id.
 *   4. Loop: on wake-up, XRANGE from last-yielded-id exclusive, yield deltas.
 */
export async function* readRunEvents(
  runId: string,
  opts: StreamReadOptions = {},
): AsyncGenerator<{ id: string; event: Record<string, unknown> }> {
  const inactivityMs = opts.inactivityMs ?? DEFAULT_INACTIVITY_MS;
  const redisUrl = resolveRedisUrl();
  const sKey = streamKey(runId);
  const nChan = notifyChannel(runId);

  // Dedicated subscriber connection — subscribe-mode clients cannot issue
  // normal commands, and maxRetriesPerRequest must be null (per ioredis docs
  // and the precedent in streaming-bridge.ts:155-159).
  const subscriber = new Redis(redisUrl, {
    lazyConnect: false,
    maxRetriesPerRequest: null,
  });

  // Separate reader connection for XRANGE — cannot share with subscriber.
  const reader = getPublisher();

  let closed = false;
  let wakeUp: (() => void) | null = null;

  const onMessage = (incomingChannel: string): void => {
    if (incomingChannel !== nChan) return;
    if (wakeUp) {
      const w = wakeUp;
      wakeUp = null;
      w();
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
  if (opts.signal) {
    if (opts.signal.aborted) closed = true;
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  // Cursor — exclusive lower bound. XRANGE accepts "(<id>" for exclusive
  // start; we convert from opts.fromId (inclusive-semantics in our API)
  // to Redis's exclusive syntax on first read, then track our own
  // last-yielded ID and use "(<id>" for subsequent XRANGE calls.
  let lastYieldedId: string | null =
    opts.fromId && opts.fromId !== "0" ? opts.fromId : null;

  try {
    await subscriber.subscribe(nChan);

    while (!closed) {
      const start = lastYieldedId ? `(${lastYieldedId}` : "-";
      const entries = (await reader.xrange(sKey, start, "+")) as Array<
        [string, string[]]
      >;
      for (const [id, fields] of entries) {
        if (closed) return;
        // fields is flat: [key, value, key, value, ...] — find "data".
        let dataIdx = -1;
        for (let i = 0; i < fields.length; i += 2) {
          if (fields[i] === "data") {
            dataIdx = i + 1;
            break;
          }
        }
        if (dataIdx < 0) {
          lastYieldedId = id;
          continue;
        }
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(fields[dataIdx]) as Record<string, unknown>;
        } catch {
          lastYieldedId = id;
          continue;
        }
        yield { id, event };
        lastYieldedId = id;
      }

      if (closed) return;

      // Wait for a notify or the inactivity timeout.
      let timeoutHandle: NodeJS.Timeout | null = null;
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
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
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

// ---------------------------------------------------------------------------
// WayFlow gate-sequence tracking persists the task-id map in Redis. The
// sequence survives Next.js hot-reloads and server restarts, eliminating the
// idx=0 re-trigger bug when the module-level map is cleared between the
// initial dispatch (BullMQ worker) and the approval (Next.js server action).
// ---------------------------------------------------------------------------

const GATE_SEQUENCE_TTL_S = 7 * 24 * 3600; // 7 days

/**
 * Returns the zero-based index of `taskId` in the per-run gate sequence.
 * If `taskId` is not yet in the list, appends it and returns the new index.
 * Idempotent: repeated calls for the same taskId return the same index.
 *
 * Also writes a Redis reverse-map `cinatra:wayflow:task-run:<taskId>`
 * → `runId`. A multi-gate WayFlow flow assigns a NEW task id per gate, and the
 * `agent_runs.a2a_task_id` column (a single value) is overwritten per gate by
 * `handleWayflowTaskState`. That overwrite races the BullMQ worker's status
 * transition on the same row and can fail with `tuple concurrently updated` —
 * the error is swallowed by a `.catch(() => undefined)`, leaving the column
 * stale. When the NEXT gate's approval reverse-looks-up the run by the new
 * task id, the stale column misses and the resume hard-fails. The reverse-map
 * here is written at INTERRUPT-emit time (when both ids are known for certain)
 * and is read as a fallback by `resolveRunIdByWayflowTaskId` — independent of
 * the racy DB column.
 */
export async function getOrAddWayflowGateIndex(
  runId: string,
  taskId: string,
): Promise<number> {
  const key = `cinatra:wayflow:gates:${runId}`;
  const r = getPublisher();
  const list = (await r.lrange(key, 0, -1)) as string[];
  // Reverse-map write is idempotent + cheap — do it every call so a re-emit
  // of the same gate (SSE reconnect) keeps the mapping fresh.
  await r.set(`cinatra:wayflow:task-run:${taskId}`, runId, "EX", GATE_SEQUENCE_TTL_S);
  const existing = list.indexOf(taskId);
  if (existing !== -1) return existing;
  await r.rpush(key, taskId);
  await r.expire(key, GATE_SEQUENCE_TTL_S);
  return list.length; // new index = old list length
}

/**
 * #824: record a WayFlow gate task WITHOUT assigning it a renderer-gate index.
 * Keeps the all-gate list (`cinatra:wayflow:gates:<runId>`) + the task→run
 * reverse-map complete for EVERY gate (so `resolveRunIdByWayflowTaskId` still
 * resolves context gates), but does not advance the renderer-gate sequence.
 * Used for context-selection gates, whose renderer is resolved by payload shape
 * (not by policy index), so they must be transparent to the renderer index that
 * maps xRenderer-bearing policy steps to gate events.
 */
export async function rememberWayflowGateTask(
  runId: string,
  taskId: string,
): Promise<void> {
  const key = `cinatra:wayflow:gates:${runId}`;
  const r = getPublisher();
  await r.set(`cinatra:wayflow:task-run:${taskId}`, runId, "EX", GATE_SEQUENCE_TTL_S);
  const list = (await r.lrange(key, 0, -1)) as string[];
  if (list.indexOf(taskId) !== -1) return;
  await r.rpush(key, taskId);
  await r.expire(key, GATE_SEQUENCE_TTL_S);
}

/**
 * #824: index into the RENDERER-gate sequence — the ordered set of gates that
 * consume an xRenderer-bearing approvalPolicy step. Context-selection gates are
 * excluded (they call `rememberWayflowGateTask` only), so this index stays
 * aligned with `resolveWayflowXRenderer`'s `childSteps` list even when context
 * gates interleave. Mirrors `getOrAddWayflowGateIndex` but on a separate list
 * (`cinatra:wayflow:renderer-gates:<runId>`); also keeps the all-gate list +
 * reverse-map current via `rememberWayflowGateTask`.
 */
export async function getOrAddWayflowRendererGateIndex(
  runId: string,
  taskId: string,
): Promise<number> {
  await rememberWayflowGateTask(runId, taskId);
  const key = `cinatra:wayflow:renderer-gates:${runId}`;
  const r = getPublisher();
  const repeatKey = rendererGateRepeatKey(runId);
  const replacedKey = rendererGateReplacedKey(runId);
  // cinatra#3562: a pause that follows a list step's refresh is that same step
  // again. Its fresh task id takes the refreshed task's place in the list, so
  // the position does not advance. A read fault throws: no later index is guessed.
  //
  // Every write of the list goes through one commit (RENDERER_GATE_COMMIT_LUA)
  // that applies only when the list and the refresh note are still as read
  // here; when another report changed them in between, they are read again.
  // So two reports of one pause, or of two pauses, never both take a place.
  for (let attempt = 0; attempt < RENDERER_GATE_COMMIT_ATTEMPTS; attempt += 1) {
    const list = (await r.lrange(key, 0, -1)) as string[];
    const existing = list.indexOf(taskId);
    const repeatRaw = await r.get(repeatKey);
    // The same pause reported again (a reconnect, a retry) keeps its place. A
    // note stays until the next pause takes the refreshed task's place.
    if (existing !== -1) {
      if (repeatRaw !== null) await r.expire(repeatKey, GATE_SEQUENCE_TTL_S);
      await r.expire(key, GATE_SEQUENCE_TTL_S);
      return existing;
    }
    const repeat = repeatRaw === null ? null : readRendererGateRepeat(repeatRaw);
    // The refreshed task reported again while its list entry is gone (the list
    // expired): it is not the next pause, so it keeps the note's place and the
    // note stays.
    if (repeat !== null && repeat.taskId === taskId) {
      await r.expire(repeatKey, GATE_SEQUENCE_TTL_S);
      return repeat.index;
    }
    // A refreshed task reported after the next pause took its place keeps that place.
    const replacedAt = await r.hget(replacedKey, taskId);
    if (replacedAt !== null) {
      const at = Number(replacedAt);
      if (!Number.isInteger(at) || at < 0) {
        throw new Error(`renderer gate ${taskId} on run ${runId} was replaced at a place that cannot be read`);
      }
      return at;
    }
    let at: number;
    let push: string[];
    if (repeatRaw === null) {
      at = list.length; // new renderer-gate index = old list length
      push = [taskId];
    } else {
      // A note that cannot be used is kept (not consumed): every later pause is
      // refused in the same way until the note expires, and none is given a guessed place.
      if (repeat === null) {
        throw new Error(`renderer gate ${taskId} on run ${runId} follows a refresh whose position cannot be read`);
      }
      at = repeat.index;
      if (list.length > at) {
        // The list is still there: the refreshed task must be its last entry.
        if (at !== list.length - 1 || list[at] !== repeat.taskId) {
          throw new Error(`renderer gate ${taskId} on run ${runId} follows a refresh of a task that is not the last renderer gate`);
        }
        push = [];
      } else {
        // The list expired before or after the refresh (or lost its tail): the
        // position is restored from the note. Only this function reads the list, and only by
        // `indexOf(taskId)` and by length, so the earlier places it cannot know
        // are filled with a value that is never a task id.
        push = [...Array.from({ length: at - list.length }, () => VACANT_RENDERER_GATE), taskId];
      }
    }
    const committed = await r.eval(
      RENDERER_GATE_COMMIT_LUA,
      3,
      key,
      repeatKey,
      replacedKey,
      repeatRaw ?? "",
      String(GATE_SEQUENCE_TTL_S),
      taskId,
      String(at),
      repeat === null ? "" : repeat.taskId,
      String(list.length),
      String(push.length),
      ...list,
      ...push,
    );
    if (Number(committed) === 1) return at;
  }
  throw new Error(`renderer gate ${taskId} on run ${runId} was not given a place: the run's renderer gates kept changing`);
}

/** How often a renderer gate report reads the list again after another report changed it. */
const RENDERER_GATE_COMMIT_ATTEMPTS = 8;

/**
 * cinatra#3562: the one write of a run's renderer gate list, in one server-side
 * step. It applies only when the list (KEYS[1]) and the refresh note (KEYS[2])
 * are exactly as the caller read them; otherwise it changes nothing and returns 0.
 *
 * ARGV: 1 the note as read ('' = none), 2 the time to live, 3 the arriving task
 * id, 4 its place, 5 the refreshed task the note names ('' = none), 6 the list's
 * length as read (n), 7 the count of values to push (m), then the n entries as
 * read, then the m values to push.
 *
 * With a note, the note is consumed here and nowhere else: the arriving task
 * takes the refreshed task's place (set in place when nothing is pushed, or
 * pushed after the vacant places), and the refreshed task's place is kept in
 * KEYS[3] for a late report of it. Without a note, the values are pushed.
 */
const RENDERER_GATE_COMMIT_LUA = `
local note = redis.call('GET', KEYS[2]) or ''
if note ~= ARGV[1] then return 0 end
local n = tonumber(ARGV[6])
local m = tonumber(ARGV[7])
local list = redis.call('LRANGE', KEYS[1], 0, -1)
if #list ~= n then return 0 end
for i = 1, n do
  if list[i] ~= ARGV[7 + i] then return 0 end
end
local ttl = tonumber(ARGV[2])
if m == 0 then
  redis.call('LSET', KEYS[1], tonumber(ARGV[4]), ARGV[3])
else
  for i = 1, m do
    redis.call('RPUSH', KEYS[1], ARGV[7 + n + i])
  end
end
redis.call('EXPIRE', KEYS[1], ttl)
if ARGV[1] ~= '' then
  redis.call('DEL', KEYS[2])
  redis.call('HSET', KEYS[3], ARGV[5], ARGV[4])
  redis.call('EXPIRE', KEYS[3], ttl)
end
return 1
`;

/** Fills a renderer gate place whose task id is not known; never equal to a task id. */
const VACANT_RENDERER_GATE = "";

function rendererGateRepeatKey(runId: string): string {
  return `cinatra:wayflow:renderer-gate-repeat:${runId}`;
}

/** The places of refreshed tasks whose place a later pause took: task id -> place. */
function rendererGateReplacedKey(runId: string): string {
  return `cinatra:wayflow:renderer-gate-replaced:${runId}`;
}

function readRendererGateRepeat(raw: string): { taskId: string; index: number } | null {
  try {
    const parsed = JSON.parse(raw) as { taskId?: unknown; index?: unknown };
    if (typeof parsed?.taskId !== "string" || parsed.taskId.length === 0) return null;
    if (typeof parsed.index !== "number" || !Number.isInteger(parsed.index) || parsed.index < 0) return null;
    return { taskId: parsed.taskId, index: parsed.index };
  } catch {
    return null;
  }
}

/**
 * cinatra#3562: record that the resume about to be sent for the renderer gate
 * `taskId` is a list step's refresh, so the run parks at the same step again.
 * The note carries the task id and its place in the run's renderer gate list,
 * so the next renderer pause keeps that place even when the list has expired
 * in between (`getOrAddWayflowRendererGateIndex`). The list's time to live is
 * renewed with the note's, so a live run keeps both.
 *
 * When the list is gone (it expires seven days after the run's last pause),
 * the place is `placeFromSteps`: the caller reads it from the step's durable
 * gate record and the compiled flow, which do not expire.
 *
 * Throws, and writes nothing, when the list holds entries and `taskId` is not
 * its last entry (the task is not the current renderer gate), or when the list
 * is gone and `placeFromSteps` is not a place: the place of the next pause
 * cannot be known, so the caller must not send the refresh.
 */
export async function rememberWayflowRendererGateRepeat(
  runId: string,
  taskId: string,
  placeFromSteps: number | null = null,
): Promise<void> {
  const key = `cinatra:wayflow:renderer-gates:${runId}`;
  const r = getPublisher();
  const list = (await r.lrange(key, 0, -1)) as string[];
  let index = list.length - 1;
  if (index < 0 && typeof placeFromSteps === "number" && Number.isInteger(placeFromSteps) && placeFromSteps >= 0) {
    index = placeFromSteps;
  } else if (index < 0 || list[index] !== taskId) {
    throw new Error(`the refresh of renderer gate ${taskId} on run ${runId} was not sent: its place in the run's steps is not known`);
  }
  await r.expire(key, GATE_SEQUENCE_TTL_S);
  await r.set(rendererGateRepeatKey(runId), JSON.stringify({ taskId, index }), "EX", GATE_SEQUENCE_TTL_S);
}

/** Deletes KEYS[1] only when it still holds ARGV[1] exactly; 1 when deleted, else 0. */
const RENDERER_GATE_REPEAT_FORGET_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;

/**
 * cinatra#3562: remove the refresh note of the renderer gate `taskId`, and only
 * that note: a note that names another task is left as it is. Called when the
 * refresh of `taskId` was not sent (the gate is put back), and when a real
 * answer to `taskId` is sent (the next pause is a new step, so a note for
 * `taskId` cannot be pending). The note is deleted only while it still holds
 * the text read here; when another write changed it in between, it is read again.
 * A read or write fault throws.
 */
export async function forgetWayflowRendererGateRepeat(runId: string, taskId: string): Promise<void> {
  const r = getPublisher();
  const repeatKey = rendererGateRepeatKey(runId);
  for (let attempt = 0; attempt < RENDERER_GATE_COMMIT_ATTEMPTS; attempt += 1) {
    const raw = await r.get(repeatKey);
    if (raw === null || readRendererGateRepeat(raw)?.taskId !== taskId) return;
    if (Number(await r.eval(RENDERER_GATE_REPEAT_FORGET_LUA, 1, repeatKey, raw)) === 1) return;
  }
  throw new Error(`the refresh note of renderer gate ${taskId} on run ${runId} was not removed: it kept changing`);
}

/**
 * #1625 (F1) — the AUTHORITATIVE, non-racing source of the CURRENT gate
 * visit's a2a task id for a run. Written UNCONDITIONALLY at each input-required
 * interrupt (execution.ts) BEFORE the interrupt is published, so the run-scoped
 * test-delivery send resolves a fresh-guaranteed submission identity that CANNOT
 * be stale — unlike `agent_runs.a2a_task_id`, whose best-effort Postgres write
 * can LOSE a "tuple concurrently updated" race and leave the column pointing at
 * a PREVIOUS visit's id. A plain Redis SET (no compare-and-swap), so it never
 * races a Postgres row. The experiment (Stage-1) proved each gate visit mints a
 * DISTINCT a2a task id, so this key is a distinct-per-visit submission identity.
 *
 * MUST be awaited and treated as correctness-critical by the caller: a Redis
 * failure here THROWS so the interrupt is NOT published (fail closed) rather than
 * emitting a gate whose send would resolve a stale identity. Redis is already
 * load-bearing for gate resume (the reverse-map below is the resume fallback), so
 * this adds no new hard dependency.
 */
export async function rememberLatestWayflowGateTask(
  runId: string,
  taskId: string,
): Promise<void> {
  const r = getPublisher();
  await r.set(`cinatra:wayflow:latest-task:${runId}`, taskId, "EX", GATE_SEQUENCE_TTL_S);
}

/**
 * #1625 (F1) — read the current gate visit's a2a task id for a run,
 * written by `rememberLatestWayflowGateTask` at interrupt-emit. The passthrough
 * seam stamps this as the run-scoped send's `verifiedSubmissionId`. Returns null
 * when absent/expired; the seam then fails CLOSED (omits the id) rather than
 * trusting the racy DB column.
 */
export async function resolveLatestWayflowGateTaskId(
  runId: string,
): Promise<string | null> {
  if (!runId) return null;
  const r = getPublisher();
  const taskId = await r.get(`cinatra:wayflow:latest-task:${runId}`);
  return typeof taskId === "string" && taskId.length > 0 ? taskId : null;
}

/**
 * cinatra#3745 — the step of the flow that paused a run at a gate, as the flow
 * runtime signed it: `{ node, attestation }`, where `attestation` is
 * `g1:<hex>` over (context id, gate task id, node id) with the runtime's
 * dedicated key. Stored beside the gate's task id, as signed, under
 * `cinatra:wayflow:gate-node:<runId>:<taskId>` with the gate sequence's time
 * to live. A reader verifies the claim before it relies on the node.
 *
 * Written best-effort by the caller: this record never gates the interrupt.
 */
export type WayflowGateNodeClaim = { node: string; attestation: string };

function gateNodeClaimKey(runId: string, taskId: string): string {
  return `cinatra:wayflow:gate-node:${runId}:${taskId}`;
}

function parseWayflowGateNodeClaim(value: unknown): WayflowGateNodeClaim | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { node, attestation } = value as { node?: unknown; attestation?: unknown };
  if (typeof node !== "string" || node.length === 0) return null;
  if (typeof attestation !== "string" || attestation.length === 0) return null;
  return { node, attestation };
}

export async function rememberWayflowGateNodeClaim(
  runId: string,
  taskId: string,
  claim: WayflowGateNodeClaim,
): Promise<void> {
  const parsed = parseWayflowGateNodeClaim(claim);
  if (!runId || !taskId || !parsed) return;
  const r = getPublisher();
  await r.set(gateNodeClaimKey(runId, taskId), JSON.stringify(parsed), "EX", GATE_SEQUENCE_TTL_S);
}

/** Read back the claim `rememberWayflowGateNodeClaim` stored for (run, gate
 *  task); null when absent, expired or malformed. */
export async function resolveWayflowGateNodeClaim(
  runId: string,
  taskId: string,
): Promise<WayflowGateNodeClaim | null> {
  if (!runId || !taskId) return null;
  const r = getPublisher();
  const raw = await r.get(gateNodeClaimKey(runId, taskId));
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return parseWayflowGateNodeClaim(JSON.parse(raw));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// #1987 (F1 deferred from #1960) — ANSWERED-gate-submission provenance.
//
// GENERALIZES the #1625 `verifiedSubmissionId` substrate (the `latest-task` map
// above) from a single-consumer dedupe key into a REQUIRED, single-use authz
// binding for run-scoped PERSIST primitives (#1959 drafts / #1960 recipients /
// future #1946-template members). The gap it closes: the `latest-task` map is
// set at INTERRUPT-EMIT and is therefore present while a gate is merely PENDING,
// so on its own it cannot tell "the operator ANSWERED this gate" apart from "an
// in-run OBO node ran while the gate is open". A persist primitive authorized on
// the run frame alone (verified run + declaring package + `respondToHitl`) — all
// properties of the whole agent-run OBO context, NOT of the individual gate
// answer — could therefore write a payload the operator never submitted.
//
// This record is minted ONLY at the operator's ANSWER (approveReviewTaskInternal
// wayflow- branch, BEFORE the WayFlow resume dispatch), keyed by the EXACT gate
// a2a task id, carrying a digest of the operator's canonical resume payload. The
// persist seam consumes it ATOMICALLY (single-use) at the post-resume `apply`
// node, binding (run, exact gate identity, canonical payload) — so a persist that
// cannot present valid, unconsumed answered-gate provenance for its own gate +
// payload FAILS CLOSED, is not replayable, and cannot be presented for a mutated
// payload. The join key is the gate a2a task id: the passthrough seam already
// stamps `verifiedSubmissionId = resolveLatestWayflowGateTaskId(runId)` (this
// gate's id, unchanged until the NEXT interrupt, which the post-resume apply node
// precedes), so the consume side re-derives the same identity from the trusted
// frame, never caller input.
// ---------------------------------------------------------------------------

function answeredGateKey(runId: string, taskId: string): string {
  return `cinatra:wayflow:answered-gate:${runId}:${taskId}`;
}

// The canonical binding digest over the operator's resume payload string. The
// mint (the operator's `userResponse`) and the consume (the apply node's
// verbatim-forwarded `resumePayloadJson`) hash the SAME byte string — WayFlow
// passes the InputMessageNode's user text through UNCHANGED (the documented
// byte-identical invariant the #1959/#1960 seams already rely on) — so any
// mutation of the persisted payload changes the digest and fails the bind.
export function answeredGatePayloadDigest(resumePayload: string): string {
  return createHash("sha256").update(resumePayload, "utf8").digest("hex");
}

/**
 * #1987 — mint the ANSWERED-gate-submission provenance for a run's gate at the
 * operator's answer. Keyed by the exact gate a2a task id, valued with the
 * canonical payload digest. A plain Redis SET with the same TTL as the gate
 * sequence substrate. MUST be awaited and treated as correctness-critical: a
 * Redis failure THROWS so the resume is NOT dispatched (fail closed) — an
 * unrecorded answer means the post-resume persist denies, never persists an
 * unbound write. Mirrors `rememberLatestWayflowGateTask`'s fail-closed posture.
 */
export async function rememberAnsweredGateSubmission(
  runId: string,
  taskId: string,
  resumePayload: string,
): Promise<void> {
  if (!runId || !taskId) return;
  const r = getPublisher();
  await r.set(
    answeredGateKey(runId, taskId),
    answeredGatePayloadDigest(resumePayload),
    "EX",
    GATE_SEQUENCE_TTL_S,
  );
}

export type AnsweredGateConsumeResult = "consumed" | "mismatch" | "absent";

// Atomic compare-and-consume: GET the stored digest, DEL it iff it equals the
// presented payload's digest, in ONE server-side Lua step so no interleaving can
// double-consume. Returns which arm fired. `mismatch` deliberately does NOT
// delete — a wrong-payload attempt must not burn the operator's genuine answer
// (the real apply node can still consume it), and a second correct consume after
// a `consumed` returns `absent` (single-use / replay-safe).
const ANSWERED_GATE_CONSUME_LUA = `
local v = redis.call('GET', KEYS[1])
if not v then return 'absent' end
if v == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 'consumed'
end
return 'mismatch'
`;

/**
 * #1987 — atomically consume a run's answered-gate provenance for the EXACT gate
 * task id, binding the presented resume payload to the operator's answer.
 *   - `consumed`: a record existed for (run, gate) AND its digest matched the
 *     presented payload → it is atomically DELETED (single-use). The persist is
 *     authorized exactly once.
 *   - `mismatch`: a record existed but the presented payload's digest differed →
 *     NOT consumed (payload substitution/mutation). The persist must deny.
 *   - `absent`: no record — the gate was never answered, its answer was already
 *     applied (replay), or it expired. The persist must deny (fail closed).
 * The caller treats a THROW (Redis unreadable) as `absent`-equivalent and fails
 * closed — never a run-frame-only decision.
 */
export async function consumeAnsweredGateSubmission(
  runId: string,
  taskId: string,
  resumePayload: string,
): Promise<AnsweredGateConsumeResult> {
  if (!runId || !taskId) return "absent";
  const r = getPublisher();
  const res = await r.eval(
    ANSWERED_GATE_CONSUME_LUA,
    1,
    answeredGateKey(runId, taskId),
    answeredGatePayloadDigest(resumePayload),
  );
  return res === "consumed" ? "consumed" : res === "mismatch" ? "mismatch" : "absent";
}

/**
 * Reverse lookup: WayFlow task id → agent run id.
 *
 * Backs the multi-gate resume path: when `readAgentRunByTaskId` misses
 * because `agent_runs.a2a_task_id` is stale (lost an update race), the
 * wayflow- approval branch falls back to this map, which was written by
 * `getOrAddWayflowGateIndex` at INTERRUPT-emit time. Returns null when the
 * task id was never seen or the key expired (7-day TTL).
 */
export async function resolveRunIdByWayflowTaskId(
  taskId: string,
): Promise<string | null> {
  if (!taskId) return null;
  const r = getPublisher();
  const runId = await r.get(`cinatra:wayflow:task-run:${taskId}`);
  return typeof runId === "string" && runId.length > 0 ? runId : null;
}
