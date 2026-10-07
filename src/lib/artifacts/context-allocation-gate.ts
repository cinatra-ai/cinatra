import "server-only";

import { readAgentContextSlotsFromOas } from "@cinatra-ai/extensions/agent-context-slots-reader";
import type { ActorContext } from "@/lib/authz/actor-context";
import { readInstalledOasForPackage, resolveCandidates } from "./context-route-io";
import {
  computeContextAllocationToken,
  computeContextManifestDigest,
  planContextAllocation,
  type ContextAllocation,
  type PlannerSlotInput,
} from "./context-allocation-planner";

// ---------------------------------------------------------------------------
// THE GATE HALF of the manifest-wide planner (cinatra#2815 S3 part 3).
//
// The planner itself is pure; this is the one place that feeds it. It reads
// EVERY slot the trusted package declares — not just the one the callback
// names — resolves each slot's candidates, and plans the whole manifest once.
//
// CACHED PER GATE. One human gate produces several callbacks (a resolve for
// the slot being drawn, then the finalize when the human answers, and in a
// composed workflow one pair per child slot). Re-resolving the entire manifest
// for each of them would multiply the resolver's work by the slot count, so the
// computed allocation is memoized under the gate's identity for a few seconds.
//
// THE MANIFEST DIGEST IS PART OF THE GATE'S IDENTITY. Keyed on the run, the
// package and the project alone, a republished agent whose slot declaration
// changed would be served the PREVIOUS allocation and, worse, the previous
// token: the drift the token exists to catch would be hidden by the very cache
// meant to spare a repeated read. The manifest is therefore read first, on
// every call, and its digest joins the key, so a declaration that moved can
// only ever MISS. Reading the manifest is one read; resolving every slot's
// candidates is what the cache is actually for.
//
// ONE ALLOCATION PER GATE, EVEN UNDER CONCURRENCY. The cache holds the
// in-flight PROMISE, not only the finished value. Two callbacks that miss
// together therefore share one computation and receive the same allocation and
// the same token; storing completed values only let them plan independently
// against a world that moved between their two reads, and answer differently
// for one gate. A computation that rejects is evicted, so a failure is never
// the cached answer.
//
// AND FINALIZE NEVER READS IT. The finalize that lands after the human has
// answered must re-plan against the world as it is THEN: a finalize served a
// cached allocation could not detect a candidate that moved while the human was
// deciding, which is exactly the drift the token exists to catch. It asks with
// `fresh`, which recomputes and then REPLACES the entry, so a later callback in
// the same gate reads the newer world rather than the one finalize just proved
// stale.
// ---------------------------------------------------------------------------

/** How long one gate's allocation is reused. Shorter than any human gate. */
const GATE_CACHE_TTL_MS = 5_000;
/** A hard bound on the cache so a long-lived process cannot grow one entry per
 *  run forever. Oldest-inserted entries are evicted first. */
const GATE_CACHE_MAX_ENTRIES = 200;

export type GateAllocation = {
  allocation: ContextAllocation;
  /** The `ContextAllocationTokenV1` for that allocation. */
  token: string;
};

type CacheEntry = { expiresAt: number; inFlight: Promise<GateAllocation> };

const gateCache = new Map<string, CacheEntry>();

function gateCacheKey(input: {
  runId: string;
  trustedSlotPackageName: string;
  projectId: string | undefined;
  manifestDigest: string;
}): string {
  return JSON.stringify([
    input.runId,
    input.trustedSlotPackageName,
    input.projectId ?? null,
    input.manifestDigest,
  ]);
}

function readCache(key: string, now: number): Promise<GateAllocation> | null {
  const hit = gateCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= now) {
    gateCache.delete(key);
    return null;
  }
  return hit.inFlight;
}

function writeCache(key: string, inFlight: Promise<GateAllocation>, now: number): void {
  // Capacity is only ever spent by a NEW key. Replacing an entry the cache
  // already holds (the `fresh` recompute a finalize asks for) needs none, and
  // evicting for it threw away an unrelated gate's allocation: the next
  // ordinary callback for that gate then started a second computation instead
  // of reading the one already there.
  if (!gateCache.has(key) && gateCache.size >= GATE_CACHE_MAX_ENTRIES) {
    const oldest = gateCache.keys().next();
    if (!oldest.done) gateCache.delete(oldest.value);
  }
  gateCache.set(key, { expiresAt: now + GATE_CACHE_TTL_MS, inFlight });
}

/** Test seam: drop every memoized gate allocation. */
export function __clearContextAllocationGateCache(): void {
  gateCache.clear();
}

/**
 * Plan the WHOLE manifest for one gate and content-address the result.
 *
 * Throws whatever the OAS read or the resolver throws — the resolve route
 * treats that as "no token this time" (the landed per-slot contract is
 * unchanged without one), while the finalize route fails closed.
 *
 * `fresh` skips the memo and recomputes. Finalize asks with it, because a
 * finalize that replayed a cached allocation could never detect the drift the
 * token exists to catch.
 */
export async function planAllocationForGate(
  input: {
    actor: ActorContext;
    runId: string;
    trustedSlotPackageName: string;
    projectId: string | undefined;
  },
  options: { fresh?: boolean } = {},
): Promise<GateAllocation> {
  // Read the manifest FIRST, on every call: its digest is part of the gate's
  // identity, so a declaration that moved cannot be served from the memo.
  const oas = await readInstalledOasForPackage(input.trustedSlotPackageName);
  // A manifest that declares nothing still plans — to an empty allocation with
  // its own stable token, which is a perfectly good thing to compare.
  const slots = oas ? readAgentContextSlotsFromOas(oas) : [];
  const key = gateCacheKey({ ...input, manifestDigest: computeContextManifestDigest(slots) });
  const now = Date.now();
  if (!options.fresh) {
    const cached = readCache(key, now);
    if (cached) return cached;
  }

  const inFlight = (async (): Promise<GateAllocation> => {
    const planned: PlannerSlotInput[] = [];
    for (const slot of slots) {
      const candidates = await resolveCandidates({
        actor: input.actor,
        slot,
        projectId: input.projectId,
        // THE POOL, NOT THE SLOT'S OWN CUT. Each slot's resolver trims to
        // `maxItems` for the per-slot contract the resolve route serves, and
        // that trim ran BEFORE the manifest-wide dedupe here: the first slot
        // claimed a ref, the second slot's resolver had already discarded
        // everything past its own cap, and the slot ended EMPTY where the full
        // pool would have filled it. The planner applies `maxItems` itself,
        // after the merge and the dedupe, which is the order the rules state.
        applyMaxItems: false,
      });
      // The resolver emits no assigned/ambient tag today, so every candidate
      // enters the planner as ambient and the assigned-layer rule is inert until
      // an assigned context source feeds it. The RULE lives in the planner, not
      // in its callers, so that day needs no second decision here.
      planned.push({ slot, candidates });
    }
    const allocation = planContextAllocation(planned);
    return { allocation, token: computeContextAllocationToken(allocation) };
  })();

  // Published BEFORE the first await on it, so a concurrent caller shares this
  // computation instead of starting a second one.
  writeCache(key, inFlight, now);
  try {
    return await inFlight;
  } catch (err) {
    // A failure is never the cached answer. Only evict OUR entry: a fresher
    // computation may already have replaced it.
    if (gateCache.get(key)?.inFlight === inFlight) gateCache.delete(key);
    throw err;
  }
}
