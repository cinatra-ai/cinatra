import "server-only";

import { createHash } from "node:crypto";
import IORedis from "ioredis";

// ---------------------------------------------------------------------------
// Durable run-context binding (#1195 — #1192 run-identity spine).
//
// PROBLEM. Run-tagging for MCP `objects_save` used to ride an in-process Map
// that could not survive multiple app instances/workers, and whose shared
// per-provider client-id key could misattribute concurrent runs even in one
// process.
//
// STATE. The Map is DELETED (the #1195 flip). This run-token-keyed DURABLE
// binding is now the ONLY non-OBO run-context channel; there is nothing
// underneath it:
//
//   Writer  — /api/llm-bridge. When the OBO actor mint for a VERIFIED run
//             falls back to the per-step machine client_credentials token,
//             the bridge writes  sha256(exact access token) → { run token
//             hash } into redis BEFORE handing the tool to the provider.
//             Each machine token mint is unique (a random `jti` claim is
//             stamped at the token endpoint), so the key is per-invocation:
//             concurrent runs can never alias each other's binding.
//   Reader  — the MCP transport handler hashes the RAW bearer the provider
//             relay echoes back and resolves the binding VALUE through the
//             one fail-closed run-token seam: readAgentRunByTokenHash
//             (agent_runs.run_token_hash, unique index). The run ROW is the
//             durable source of truth — a rotated/cleared credential makes
//             the binding unresolvable and the resolution FAILS CLOSED.
//
// Storage is redis (REDIS_URL — already a hard runtime dependency via
// BullMQ): a transient cross-process correlation index, NOT another identity
// store. No migration. The RAW run token and RAW bearer material are NEVER
// persisted — keys are sha256 of the bearer, values carry only the run-token
// hash (same sensitivity class as the DB column: neither recovers a live
// credential).
//
// Classification contract (converged with Codex, #1195 round-1..3):
//   - redis GET null or redis transport failure        ⇒ "absent"
//     (no binding; post-flip there is no legacy channel to fall back TO — a
//     request with no verified run identity simply carries none, and a
//     header-only claim is REFUSED at the transport)
//   - present but malformed / schema-invalid / non-64-hex
//     token hash / DB miss / DB error after a binding
//     was found                                        ⇒ "invalid"
//     (FAIL CLOSED: the caller must suppress the header fallback and every
//     provenance field — a positive stale-credential signal is never
//     downgraded into a weaker, forgeable channel)
//   - unique-index hit                                 ⇒ "resolved"
// ---------------------------------------------------------------------------

const KEY_PREFIX = "cinatra:run-ctx:v1:";

/** A generous upper bound for any single LLM API call (it mirrors the TTL the
 *  deleted in-process registry used); the crash backstop when the
 *  finally-clear never runs. */
export const DURABLE_RUN_CONTEXT_TTL_SECONDS = 300;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The persisted binding value. `tokenHash` is the ONLY authoritative field
 *  (resolved back to a run via the unique-index probe); the rest is UNTRUSTED
 *  provenance carried for tagging only — never an authorization input. */
export type DurableRunContextBinding = {
  tokenHash: string;
  agentId?: string;
  packageVersion?: string;
  agentSpecVersion?: string;
};

export type DurableRunContextResolution =
  | {
      outcome: "resolved";
      ctx: {
        runId: string;
        agentId?: string;
        packageVersion?: string;
        agentSpecVersion?: string;
      };
    }
  | { outcome: "invalid" }
  | { outcome: "absent" };

/** Minimal redis surface this module needs — satisfied by ioredis and by the
 *  Map-backed fake in tests (which also simulates a second process). */
export type DurableBindingRedis = {
  set(
    key: string,
    value: string,
    expiryMode: "EX",
    ttlSeconds: number,
  ): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<unknown>;
};

declare global {
  var __cinatraDurableRunCtxRedis: DurableBindingRedis | undefined;
}

/** Per-process client, constructed on first use (never at module load —
 *  hermetic tests import this module without touching redis). The DEFAULT
 *  offline queue stays ON so the very first command after construction queues
 *  through the initial connect instead of being rejected cold (lazyConnect +
 *  enableOfflineQueue:false would deterministically fail the first healthy
 *  write). Outage behavior stays bounded — maxRetriesPerRequest:1 +
 *  commandTimeout fail a command fast when redis is down — and every caller
 *  treats a transport failure as "absent" (write skipped / no run
 *  attribution), so the bridge and the MCP handler are never held hostage. */
function getClient(): DurableBindingRedis {
  if (!globalThis.__cinatraDurableRunCtxRedis) {
    globalThis.__cinatraDurableRunCtxRedis = new IORedis(
      process.env.REDIS_URL?.trim() || "redis://127.0.0.1:6379",
      {
        maxRetriesPerRequest: 1,
        connectTimeout: 2_000,
        commandTimeout: 1_500,
      },
    );
  }
  return globalThis.__cinatraDurableRunCtxRedis;
}

/** sha256-hex of the raw bearer — the ONLY key form that ever reaches redis
 *  (raw bearer material must never be persisted). */
export function durableRunContextKey(rawBearerToken: string): string {
  return (
    KEY_PREFIX + createHash("sha256").update(rawBearerToken, "utf8").digest("hex")
  );
}

// --- cutover counters (ids only; snapshot exported for tests/ops) -----------

/** Kept in lockstep with RunContextServedBy in the mcp-server request-context
 *  module. `"registry"` was REMOVED with the in-process registry (#1195 flip)
 *  and can no longer be emitted; the cutover analyzer still RECOGNIZES it so a
 *  historical log stream stays readable (see agent-run-context-cutover.ts). */
export type RunContextServedBy = "obo" | "durable" | "header" | "none";

type DurableCounters = {
  servedBy: Map<string, number>;
  durableOutcome: Map<string, number>;
};

declare global {
  var __cinatraDurableRunCtxCounters: DurableCounters | undefined;
}

function counters(): DurableCounters {
  if (!globalThis.__cinatraDurableRunCtxCounters) {
    globalThis.__cinatraDurableRunCtxCounters = {
      servedBy: new Map(),
      durableOutcome: new Map(),
    };
  }
  return globalThis.__cinatraDurableRunCtxCounters;
}

function bump(map: Map<string, number>, key: string): number {
  const next = (map.get(key) ?? 0) + 1;
  map.set(key, next);
  return next;
}

/** #1195 which-channel-served metric. It once fed the registry-removal cutover
 *  gate; the removal has LANDED (owner ruling — the observation fence was
 *  waived), so it is now ongoing observability over the surviving channels.
 *  The LINE SHAPE is deliberately unchanged so an existing log pipeline and the
 *  cutover analyzer both keep parsing it. Ids only — never a key or a hash. */
export function recordMcpRunContextServedBy(
  channel: RunContextServedBy,
  ids: { runId?: string; suppressed?: boolean },
): void {
  const count = bump(counters().servedBy, channel);
  console.info(
    `[mcp-run-ctx] served-by=${channel} run=${ids.runId ?? "-"} ` +
      `suppressed=${ids.suppressed === true} count=${count}`,
  );
}

export function getDurableRunContextCounterSnapshot(): {
  servedBy: Record<string, number>;
  durableOutcome: Record<string, number>;
} {
  const c = counters();
  return {
    servedBy: Object.fromEntries(c.servedBy),
    durableOutcome: Object.fromEntries(c.durableOutcome),
  };
}

export function resetDurableRunContextCountersForTest(): void {
  const c = counters();
  c.servedBy.clear();
  c.durableOutcome.clear();
}

// --- cutover readiness gate (#1195, HISTORICAL) ------------------------------
//
// The registry cutover it gated is DONE: the in-process registry is deleted and
// the fail-closed posture is enforced at the transport. The predicate is kept
// (not deleted) as the honest record of how the cutover was meant to be judged
// and so an archived log stream can still be evaluated after the fact.
//
// The readiness predicate `evaluateRegistryCutoverReadiness` and the fleet
// log-stream parser live in the PURE, dependency-free leaf
// src/lib/agent-run-context-cutover.ts (no `server-only`, no `ioredis`), so the
// offline "judge parity" analysis can be imported by a plain ops script and so
// this module — reachable from the LOCKED /api/mcp route — gains no dependency
// edge to it. It is deliberately NOT re-exported here (a re-export would
// recreate that edge and grow the route's reachable-module graph).
//
// The runtime metric that feeds it is `recordMcpRunContextServedBy` above (one
// `[mcp-run-ctx] served-by=` line per request); `getDurableRunContextCounterSnapshot`
// is a single-instance convenience and is NOT fleet-wide proof on its own — the
// authoritative input is the aggregated log stream (see the cutover leaf).

// --- writer ------------------------------------------------------------------

/**
 * Write the durable binding for one freshly-minted machine access token.
 * Returns the redis key written (for the request-scoped finally-clear) or
 * null when the write was skipped/failed — the caller proceeds either way
 * (binding absent ⇒ the step simply carries no run attribution; availability is
 * never worse, and an unattributed write is never a MISattributed one).
 *
 * Refuses a value whose tokenHash is not 64-hex: a malformed hash could never
 * resolve and would only manufacture "invalid" (fail-closed) reads.
 */
export async function writeDurableRunContextBinding(
  rawBearerToken: string,
  binding: DurableRunContextBinding,
  client: DurableBindingRedis = getClient(),
): Promise<string | null> {
  if (!rawBearerToken || !SHA256_HEX.test(binding.tokenHash)) return null;
  const key = durableRunContextKey(rawBearerToken);
  try {
    await client.set(
      key,
      JSON.stringify(binding),
      "EX",
      DURABLE_RUN_CONTEXT_TTL_SECONDS,
    );
    return key;
  } catch {
    // transport failure — binding absent; the step carries no attribution.
    return null;
  }
}

/** Best-effort DEL of the exact keys this request wrote. Keys are
 *  per-invocation-unique (unique machine token per mint), so a plain DEL can
 *  never remove another request's binding; the TTL is the crash backstop. */
export async function clearDurableRunContextBindings(
  keys: string[],
  client: DurableBindingRedis = getClient(),
): Promise<void> {
  if (keys.length === 0) return;
  try {
    await client.del(...keys);
  } catch {
    // best-effort — TTL reaps the entries.
  }
}

// --- reader ------------------------------------------------------------------

function parseBinding(raw: string): DurableRunContextBinding | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.tokenHash !== "string" ||
    !SHA256_HEX.test(candidate.tokenHash)
  ) {
    return null;
  }
  // Schema-STRICT on the provenance fields too: a present-but-wrong-type
  // value is a corrupt binding and must classify "invalid" (fail closed),
  // never be silently dropped and refilled from the weaker legacy channels.
  for (const field of ["agentId", "packageVersion", "agentSpecVersion"] as const) {
    const value = candidate[field];
    if (value !== undefined && typeof value !== "string") return null;
  }
  const optional = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined;
  return {
    tokenHash: candidate.tokenHash,
    agentId: optional(candidate.agentId),
    packageVersion: optional(candidate.packageVersion),
    agentSpecVersion: optional(candidate.agentSpecVersion),
  };
}

/**
 * Resolve the durable run context for one MCP request bearer. NEVER throws —
 * the outcome IS the classification (see the module contract above). The
 * lookup is injected so hermetic tests never need a database:
 * production wires `readAgentRunByTokenHash` (the single W1 run-token seam).
 */
export async function resolveDurableRunContext(
  rawBearerToken: string,
  lookupByHash: (
    hash: string,
  ) => Promise<{ id: string; orgId: string; runBy: string | null } | null>,
  client: DurableBindingRedis = getClient(),
): Promise<DurableRunContextResolution> {
  if (!rawBearerToken) return { outcome: "absent" };

  let raw: string | null;
  try {
    raw = await client.get(durableRunContextKey(rawBearerToken));
  } catch {
    // redis transport failure ⇒ absent (availability policy: a redis outage
    // must not fail every MCP call; the request simply carries no run
    // attribution — there is no weaker channel left to fall back to).
    bump(counters().durableOutcome, "absent_transport");
    return { outcome: "absent" };
  }
  if (raw === null) {
    bump(counters().durableOutcome, "absent");
    return { outcome: "absent" };
  }

  const binding = parseBinding(raw);
  if (!binding) {
    // present-but-malformed is a POSITIVE corrupt-state signal, never a
    // downgrade into header attribution.
    bump(counters().durableOutcome, "invalid_malformed");
    console.warn("[mcp-run-ctx] durable binding malformed — failing closed");
    return { outcome: "invalid" };
  }

  let run: { id: string; orgId: string; runBy: string | null } | null;
  try {
    run = await lookupByHash(binding.tokenHash);
  } catch {
    // A binding WAS found; the verification layer failing is not "absent" —
    // fail closed rather than reattribute through weaker channels.
    bump(counters().durableOutcome, "invalid_lookup_error");
    console.warn("[mcp-run-ctx] durable binding lookup failed — failing closed");
    return { outcome: "invalid" };
  }
  if (!run) {
    // Token-miss: the credential was rotated/cleared or the run is gone.
    bump(counters().durableOutcome, "invalid_token_miss");
    console.warn("[mcp-run-ctx] durable binding unresolvable — failing closed");
    return { outcome: "invalid" };
  }

  bump(counters().durableOutcome, "resolved");
  return {
    outcome: "resolved",
    ctx: {
      runId: run.id,
      agentId: binding.agentId,
      packageVersion: binding.packageVersion,
      agentSpecVersion: binding.agentSpecVersion,
    },
  };
}
