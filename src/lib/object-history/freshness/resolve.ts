// Freshness resolver: walks the events in a change_set, looks up the right
// adapter per event, and produces the ExternalFreshnessMap that the
// eligibility engine consumes.
//
// cinatra#2022 S7 freshness re-point — bounded fan-out: a sweep may span many remote instances in one change-set (a
// change-set touching several WordPress posts across different sites, or —
// once a second connector registers — a mix of connectors). Events are
// grouped into per-`(connector, instance)` BUCKETS so every object checked
// for the SAME remote instance in one sweep shares that instance's session
// (see ../wordpress-adapter.ts's header note on the invoker's own catalog
// cache reuse); a bucket's own objects are checked SEQUENTIALLY (never
// hammer one remote site with parallel probes from a single sweep), while
// DIFFERENT instances' buckets run concurrently, bounded by
// `maxConcurrentInstanceSessions` so an unbounded number of simultaneous
// instance sessions can never fan out against many sites at once. Each
// bucket additionally carries its own `instanceSessionTimeoutMs` budget:
// once spent, any of that bucket's objects not yet checked degrade to
// `state:"unknown"` — the SAME per-object degrade every other failure mode
// already uses — so a hung/slow instance (or a shared-cache load failure
// that manifests as a hang rather than a fast throw) can never stall or
// crash the whole sweep, and every OTHER instance's bucket is unaffected.
//
// Events without a connector-tagged `extra.instanceId` (or without a
// remoteRevisionRef at all) get their own singleton bucket, keyed on
// objectId — functionally identical to the pre-re-point per-event behavior, just
// running through the same bounded+timed machinery for consistency.

import {
  freshnessAllowsRestore,
  getFreshnessAdapter,
  type FreshnessState,
} from "./contract";
import type { LoadedChangeSet, ExternalFreshnessMap } from "../eligibility";
import type { ObjectChangeEvent } from "../types";

/** Cap on how many DISTINCT instances' freshness sessions run concurrently in
 * one sweep — bounds fan-out against many remote
 * sites at once. Overridable per-call (tests, and any future caller with a
 * different load profile); this default is a conservative, bounded value,
 * not tuned against production traffic. */
export const FRESHNESS_SWEEP_MAX_CONCURRENT_INSTANCE_SESSIONS = 4;

/** Per-instance-session time budget in ms — once
 * spent, that instance's remaining unchecked objects in this sweep degrade to
 * `unknown` rather than stalling the sweep. Overridable per-call (tests). */
export const FRESHNESS_SWEEP_INSTANCE_SESSION_TIMEOUT_MS = 30_000;

type FreshnessSweepOptions = {
  orgId: string | null;
  /** @default FRESHNESS_SWEEP_MAX_CONCURRENT_INSTANCE_SESSIONS */
  maxConcurrentInstanceSessions?: number;
  /** @default FRESHNESS_SWEEP_INSTANCE_SESSION_TIMEOUT_MS */
  instanceSessionTimeoutMs?: number;
};

type InstanceBucket = {
  key: string;
  events: ObjectChangeEvent[];
};

/** Bucket key: `(connector, instanceId)` when the event's ref carries a
 * generic `extra.instanceId` (the existing, documented convention — see
 * ../wordpress-adapter.ts's own header comment); otherwise a singleton bucket
 * keyed on the event id so such events never artificially serialize behind an
 * unrelated shared bucket (and duplicate objectIds never share one). */
function bucketKeyFor(event: ObjectChangeEvent): string {
  const ref = event.remoteRevisionRef;
  if (!ref) return `__no_ref__::${event.id}`;
  const instanceId = typeof ref.extra?.instanceId === "string" ? ref.extra.instanceId : null;
  return instanceId
    ? `${ref.connector}::${instanceId}`
    : `${ref.connector}::__no_instance__::${event.id}`;
}

function groupIntoInstanceBuckets(events: readonly ObjectChangeEvent[]): InstanceBucket[] {
  const byKey = new Map<string, ObjectChangeEvent[]>();
  for (const event of events) {
    const key = bucketKeyFor(event);
    const existing = byKey.get(key);
    if (existing) existing.push(event);
    else byKey.set(key, [event]);
  }
  return [...byKey.entries()].map(([key, bucketEvents]) => ({ key, events: bucketEvents }));
}

/** Check every event in one instance bucket SEQUENTIALLY (one session, one
 * object at a time), bounded by `timeoutMs` for the WHOLE bucket. Records
 * every event's verdict into `eventVerdicts` KEYED BY EVENT ID — including an
 * `unknown` verdict for any event the session timeout cut off before it was
 * reached — so no event that HAD a remoteRevisionRef is ever silently absent.
 * An event with no remoteRevisionRef is never added (unchanged pre-re-point
 * behavior — only CMS-tagged events participate).
 *
 * LATE-RESULT DISCIPLINE: once the session timeout fires, any adapter call
 * still in flight has its eventual result DISCARDED (the `timedOut` re-check
 * after the await) — the timeout's `unknown` verdict stands. Without this, a
 * slow probe resolving `fresh` AFTER the timeout backfill would overwrite the
 * blocking verdict in a map the caller may already hold — a restore-unblock
 * race. The in-flight wire call itself cannot be cancelled (the adapter
 * contract has no abort channel), so it may briefly outlive its bucket —
 * bounded in practice by the transport's own per-call network timeouts — but
 * its result can never reach the returned map.
 */
async function runInstanceBucket(
  bucket: InstanceBucket,
  eventVerdicts: Map<string, FreshnessState>,
  orgId: string | null,
  timeoutMs: number,
): Promise<void> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const TIMED_OUT = Symbol("freshness-sweep-instance-session-timeout");
  const timeoutPromise = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(TIMED_OUT);
    }, timeoutMs);
  });

  const work = (async () => {
    for (const event of bucket.events) {
      if (timedOut) break;
      const ref = event.remoteRevisionRef;
      if (!ref) continue;
      const adapter = getFreshnessAdapter(ref.connector);
      if (!adapter) {
        eventVerdicts.set(event.id, { state: "unsupported" });
        continue;
      }
      let verdict: FreshnessState;
      try {
        verdict = await adapter.check({
          objectId: event.objectId,
          orgId,
          remoteRevisionRef: ref,
        });
      } catch (e) {
        verdict = {
          state: "unknown",
          reason: `adapter '${ref.connector}' threw: ${(e as Error).message}`,
        };
      }
      // Late-result discipline (see the doc comment above): a result landing
      // after the timeout is discarded — the timeout verdict stands.
      if (timedOut) break;
      eventVerdicts.set(event.id, verdict);
    }
  })();

  await Promise.race([work, timeoutPromise]);
  if (timer) clearTimeout(timer);

  // Anything the session timeout cut off before it was reached still needs
  // an explicit verdict. Only for events that WOULD have gotten one (a
  // remoteRevisionRef present) — never invent an entry for a local-only
  // event that was always meant to be skipped.
  for (const event of bucket.events) {
    if (!event.remoteRevisionRef) continue;
    if (!eventVerdicts.has(event.id)) {
      eventVerdicts.set(event.id, {
        state: "unknown",
        reason: "freshness sweep instance-session timed out before this object was checked",
      });
    }
  }
}

/** Run every bucket to completion, at most `maxConcurrent` buckets in flight
 * at once — a simple bounded worker pool, no new
 * dependency. */
async function runBucketsBounded(
  buckets: InstanceBucket[],
  maxConcurrent: number,
  runOne: (bucket: InstanceBucket) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workerCount = Math.max(1, Math.min(maxConcurrent, buckets.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const i = next++;
      if (i >= buckets.length) return;
      await runOne(buckets[i]!);
    }
  });
  await Promise.all(workers);
}

export async function resolveExternalFreshness(
  loaded: LoadedChangeSet,
  options: FreshnessSweepOptions = { orgId: null },
): Promise<ExternalFreshnessMap> {
  const eventVerdicts = new Map<string, FreshnessState>();
  const buckets = groupIntoInstanceBuckets(loaded.events);
  const maxConcurrent =
    options.maxConcurrentInstanceSessions ?? FRESHNESS_SWEEP_MAX_CONCURRENT_INSTANCE_SESSIONS;
  const timeoutMs =
    options.instanceSessionTimeoutMs ?? FRESHNESS_SWEEP_INSTANCE_SESSION_TIMEOUT_MS;
  await runBucketsBounded(buckets, maxConcurrent, (bucket) =>
    runInstanceBucket(bucket, eventVerdicts, options.orgId, timeoutMs),
  );
  // Compose the per-object map ONLY after every bucket has settled, walking
  // `loaded.events` in order — so (a) a duplicate objectId across events
  // resolves deterministically to the LATEST event's verdict, byte-identical
  // to the pre-re-point sequential loop's last-write-wins-in-event-order
  // semantics (never bucket-completion-order), and (b) the returned map is a
  // fresh composition no in-flight probe holds a reference to — a late
  // result can never mutate it after return.
  const out = new Map<string, FreshnessState>();
  for (const event of loaded.events) {
    const verdict = eventVerdicts.get(event.id);
    if (verdict) out.set(event.objectId, verdict);
  }
  return out;
}

// Per-event helper used by single-object surfaces.
export async function resolveEventFreshness(
  event: Pick<ObjectChangeEvent, "objectId" | "remoteRevisionRef">,
  options: { orgId: string | null } = { orgId: null },
): Promise<FreshnessState> {
  const ref = event.remoteRevisionRef;
  if (!ref) return { state: "unsupported" };
  const adapter = getFreshnessAdapter(ref.connector);
  if (!adapter) return { state: "unsupported" };
  try {
    return await adapter.check({
      objectId: event.objectId,
      orgId: options.orgId,
      remoteRevisionRef: ref,
    });
  } catch (e) {
    return {
      state: "unknown",
      reason: `adapter '${ref.connector}' threw: ${(e as Error).message}`,
    };
  }
}

export { freshnessAllowsRestore };
