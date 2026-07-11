import "server-only";

import { createHash } from "node:crypto";
import IORedis from "ioredis";

// ---------------------------------------------------------------------------
// Durable run-context binding (#1195, first slice — #1192 run-identity spine).
//
// PROBLEM. Run-tagging for MCP `objects_save` rides an in-process Map
// (src/lib/agent-run-context-registry.ts) that cannot survive multiple app
// instances/workers, and its shared per-provider client-id key can
// misattribute concurrent runs even in one process.
//
// THIS SLICE. A run-token-keyed DURABLE binding replaces the Map as the
// primary channel; the Map stays as a measured legacy fallback during the
// cutover:
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
//     (this transitional slice allows the legacy registry fallback)
//   - present but malformed / schema-invalid / non-64-hex
//     token hash / DB miss / DB error after a binding
//     was found                                        ⇒ "invalid"
//     (FAIL CLOSED: the caller must suppress the registry AND header
//     fallbacks and every provenance field — a positive stale-credential
//     signal is never downgraded into weaker, forgeable channels)
//   - unique-index hit                                 ⇒ "resolved"
// ---------------------------------------------------------------------------

const KEY_PREFIX = "cinatra:run-ctx:v1:";

/** Mirrors the legacy in-process registry TTL — a generous upper bound for a
 *  single LLM API call; the crash backstop when the finally-clear never runs. */
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
 *  treats a transport failure as "absent" (write skipped / registry
 *  fallback), so the bridge and the MCP handler are never held hostage. */
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

export type RunContextServedBy =
  | "obo"
  | "durable"
  | "registry"
  | "header"
  | "none";

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

/** #1195 which-channel-served metric: feeds the registry-removal cutover gate
 *  (the acceptance requires proof that no production traffic still needs the
 *  legacy registry before it is deleted). Ids only — never a key or a hash. */
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

// --- writer ------------------------------------------------------------------

/**
 * Write the durable binding for one freshly-minted machine access token.
 * Returns the redis key written (for the request-scoped finally-clear) or
 * null when the write was skipped/failed — the caller proceeds either way
 * (binding absent ⇒ the legacy registry fallback covers, availability is
 * never worse than today).
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
    // transport failure — binding absent; legacy registry covers.
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
    // redis transport failure ⇒ absent (transitional availability policy —
    // the legacy registry fallback still covers attribution).
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
    // downgrade into registry/header attribution.
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
