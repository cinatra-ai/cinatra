import "server-only";

// ---------------------------------------------------------------------------
// #1197 — context-route observability: diagnostic counters + structured logs.
//
// The context routes (/api/context-resolve, /api/context-finalize) return
// machine-readable, stable rejection codes (context-route-support.ts /
// context-attestation.ts), but until #1197 an outcome produced no server-side
// signal — a lost binding surfaced only as an opaque failed agent run (#1151).
// This module makes every outcome observable:
//
//   - REJECTIONS log one queryable warn-level line carrying the stable code
//     plus the run/context/slot identifiers, and bump a per-(kind, code)
//     counter.
//   - SUCCESSES log a debug-level lifecycle trace (quiet by default in most
//     log pipelines) and bump the per-kind `ok` counter.
//   - The #1193 W2 which-path-served metric (token-first vs legacy resolution)
//     lives here too: a per-(kind, via) counter + the info-level line that
//     feeds the W3 legacy-removal gate.
//
// Counters are process-local and anchored on `globalThis` so every route
// bundle shares ONE registry (Next.js may instantiate a module per compiled
// route in dev). Every log line embeds the running `count` for its key, so a
// log-based alerting pipeline can see per-code rates without scraping process
// memory; `getContextRouteCounterSnapshot` exposes the registry for tests and
// any future ops surface / OTel meter export.
//
// PII/secret discipline: ONLY identifiers and stable codes are logged — never
// payloads, candidate contents, envelopes, or the run token / its hash.
// Identifier values are sanitized (charset-restricted + length-capped) because
// a rejection can echo a CALLER-SUPPLIED id (e.g. a forged body parentRunId).
// ---------------------------------------------------------------------------

export type ContextRouteKind = "resolve" | "finalize";

/** Which binding selected the run in deriveContextRouteContext (#1193 W2):
 *  the dispatch-minted run token, the legacy a2a context-id header, or the
 *  legacy dev-loopback body id. */
export type ContextRouteServedBy = "run_token" | "context_id" | "body";

type CounterStore = {
  /** `${kind}.${code}` → count. `code` is a stable rejection code or "ok". */
  outcome: Map<string, number>;
  /** `${kind}.${via}` → count (token-first vs legacy split, W3 gate input). */
  resolutionPath: Map<string, number>;
};

// globalThis-anchored singleton (Symbol.for = one shared key per process).
const STORE_KEY = Symbol.for("cinatra.contextRouteObservability.counters");

function store(): CounterStore {
  const g = globalThis as { [STORE_KEY]?: CounterStore };
  if (!g[STORE_KEY]) {
    g[STORE_KEY] = { outcome: new Map(), resolutionPath: new Map() };
  }
  return g[STORE_KEY];
}

function bump(map: Map<string, number>, key: string): number {
  const next = (map.get(key) ?? 0) + 1;
  map.set(key, next);
  return next;
}

/** Sanitize an identifier for a single-line logfmt log: charset-restrict
 *  (defeats log-line injection via a caller-supplied id) and length-cap.
 *  Absent/empty/non-string values render as "-". */
function id(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "-";
  const cleaned = value.replace(/[^A-Za-z0-9._:@/-]/g, "?");
  return cleaned.length > 64 ? `${cleaned.slice(0, 64)}…` : cleaned;
}

/** Best-effort {runId, slotId} extraction from an UNVALIDATED request body for
 *  the invalid_body rejection line (ids only; values are sanitized by `id`). */
export function extractContextRouteLogIds(raw: unknown): {
  runId: string | null;
  slotId: string | null;
} {
  if (typeof raw !== "object" || raw === null) return { runId: null, slotId: null };
  const o = raw as Record<string, unknown>;
  return {
    runId: typeof o.parentRunId === "string" ? o.parentRunId : null,
    slotId: typeof o.slotId === "string" ? o.slotId : null,
  };
}

/** A context-route request was REJECTED with a stable code. Bumps the
 *  per-(kind, code) counter and emits ONE queryable warn-level line. */
export function recordContextRouteRejection(input: {
  kind: ContextRouteKind;
  code: string;
  status: number;
  runId?: string | null;
  contextId?: string | null;
  slotId?: string | null;
}): void {
  const count = bump(store().outcome, `${input.kind}.${input.code}`);
  console.warn(
    `[context-route] rejected kind=${input.kind} code=${id(input.code)} ` +
      `status=${input.status} run=${id(input.runId)} ctx=${id(input.contextId)} ` +
      `slot=${id(input.slotId)} count=${count}`,
  );
}

/** A context-route request SUCCEEDED. Bumps the per-kind `ok` counter and
 *  emits a debug-level lifecycle trace (not noisy at default log levels). */
export function recordContextRouteSuccess(input: {
  kind: ContextRouteKind;
  servedBy?: ContextRouteServedBy;
  runId?: string | null;
  contextId?: string | null;
  slotId?: string | null;
}): void {
  const count = bump(store().outcome, `${input.kind}.ok`);
  console.debug(
    `[context-route] ok kind=${input.kind} via=${id(input.servedBy)} ` +
      `run=${id(input.runId)} ctx=${id(input.contextId)} ` +
      `slot=${id(input.slotId)} count=${count}`,
  );
}

/** #1193 W2 which-path-served metric: which binding resolved the run. Bumps
 *  the per-(kind, via) counter and emits the info-level line that feeds the
 *  W3 legacy-removal gate. Ids only — the raw token / its hash are NEVER
 *  logged. */
export function recordContextRouteResolutionPath(input: {
  kind: ContextRouteKind;
  via: ContextRouteServedBy;
  runId: string;
  contextId?: string | null;
}): void {
  const count = bump(store().resolutionPath, `${input.kind}.${input.via}`);
  console.info(
    `[context-route] run resolved kind=${input.kind} via=${input.via} ` +
      `run=${id(input.runId)} ctx=${id(input.contextId)} count=${count}`,
  );
}

/** Snapshot of both counter families (tests + future ops/metrics export). */
export function getContextRouteCounterSnapshot(): {
  outcome: Record<string, number>;
  resolutionPath: Record<string, number>;
} {
  const s = store();
  return {
    outcome: Object.fromEntries(s.outcome),
    resolutionPath: Object.fromEntries(s.resolutionPath),
  };
}

/** Test hook: zero both counter families. */
export function resetContextRouteCountersForTest(): void {
  const s = store();
  s.outcome.clear();
  s.resolutionPath.clear();
}
