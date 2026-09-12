import "server-only";

import { readAgentContextSlotsFromOas } from "@cinatra-ai/extensions/agent-context-slots-reader";
import type { ActorContext } from "@/lib/authz/actor-context";
import { readInstalledOasForPackage, resolveCandidates } from "./context-route-io";
import {
  computeContextAllocationToken,
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
// computed allocation is memoized under the gate's identity — the run, the
// trusted package and the project refinement — for a few seconds.
//
// The TTL is deliberately SHORT and deliberately shorter than a human gate:
// the finalize that lands after the human has answered MUST re-plan against
// the world as it is then, because a finalize that replayed a cached
// allocation could never detect the drift the token exists to catch.
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

type CacheEntry = { expiresAt: number; value: GateAllocation };

const gateCache = new Map<string, CacheEntry>();

function gateCacheKey(input: {
  runId: string;
  trustedSlotPackageName: string;
  projectId: string | undefined;
}): string {
  return JSON.stringify([
    input.runId,
    input.trustedSlotPackageName,
    input.projectId ?? null,
  ]);
}

function readCache(key: string, now: number): GateAllocation | null {
  const hit = gateCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= now) {
    gateCache.delete(key);
    return null;
  }
  return hit.value;
}

function writeCache(key: string, value: GateAllocation, now: number): void {
  if (gateCache.size >= GATE_CACHE_MAX_ENTRIES) {
    const oldest = gateCache.keys().next();
    if (!oldest.done) gateCache.delete(oldest.value);
  }
  gateCache.set(key, { expiresAt: now + GATE_CACHE_TTL_MS, value });
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
 * unchanged without one), while the finalize route, which only asks when the
 * renderer actually carried a token, fails closed.
 */
export async function planAllocationForGate(input: {
  actor: ActorContext;
  runId: string;
  trustedSlotPackageName: string;
  projectId: string | undefined;
}): Promise<GateAllocation> {
  const key = gateCacheKey(input);
  const now = Date.now();
  const cached = readCache(key, now);
  if (cached) return cached;

  const oas = await readInstalledOasForPackage(input.trustedSlotPackageName);
  // A manifest that declares nothing still plans — to an empty allocation with
  // its own stable token, which is a perfectly good thing to compare.
  const slots = oas ? readAgentContextSlotsFromOas(oas) : [];
  const planned: PlannerSlotInput[] = [];
  for (const slot of slots) {
    const candidates = await resolveCandidates({
      actor: input.actor,
      slot,
      projectId: input.projectId,
    });
    // The resolver emits no assigned/ambient tag today, so every candidate
    // enters the planner as ambient and the assigned-layer rule is inert until
    // an assigned context source feeds it. The RULE lives in the planner, not
    // in its callers, so that day needs no second decision here.
    planned.push({ slot, candidates });
  }
  const allocation = planContextAllocation(planned);
  const value: GateAllocation = {
    allocation,
    token: computeContextAllocationToken(allocation),
  };
  writeCache(key, value, now);
  return value;
}
