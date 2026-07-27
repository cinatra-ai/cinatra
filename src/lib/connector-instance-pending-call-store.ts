import "server-only";

// Persisted parked-destructive-call store (cinatra#2020 S5 / design §3 / §4 /
// D2). This module owns PERSISTENCE + the pure park/consume helpers for the two
// host-owned bootstrap-DDL tables:
//   - `connector_instance_pending_call`          — one row per destructive call
//     parked pending the requester's confirmation. The state machine
//     `pending → executing → executed|failed` ∪ `denied|cancelled|expired`, the
//     DB-enforced park-dedup arbiter, the exactly-once `pending → executing` CAS
//     (the `org_write_completion_ticket` / resume-run precedent), the pessimistic
//     reader flips and the late-upgrade CAS all live here.
//   - `connector_instance_confirmation_policy`   — the per-instance org override
//     (`readConfirmationPolicy` / `setConfirmationPolicy`), co-located per the
//     design's module map (§8).
//
// SCOPE (cinatra#2020 PR-1): the CAS + store PRIMITIVES land here; their CALLERS
// land later — the destructive hook that calls `parkPendingCall` (PR-3) and the
// resume executor that calls `consumePendingCall` / `recordOutcome` (PR-4). The
// pure fingerprint/digest/redaction helpers are EXPORTED so park (here) and
// resume (PR-4) share ONE implementation (codex r2 discipline pin: the endpoint
// fingerprint is computed by the same helper at both sites).
//
// DB access mirrors connector-instance-tool-policy-store / -server-store: an
// INJECTED query fn (unit-testable without a DB) + a lazy pooled connection + a
// schema-qualified table + an injected audit sink. `parkPendingCall` ALSO needs
// a MULTI-statement transaction (its `pg_advisory_xact_lock` is xact-scoped), so
// it runs under an injected transaction runner; the default acquires a pooled
// client and BEGIN/COMMITs, while a unit test injects a pass-through over its
// in-memory query double. Time is read via SQL `now()` / `now() +
// make_interval(...)` (the widget-token-broker precedent) so a test double can
// model expiry against a synthetic clock. The backing tables are the ADDITIVE
// bootstrap DDL in connector-instance-pending-call-schema.ts /
// connector-instance-confirmation-policy-schema.ts (no numbered migration —
// migrations/README.md).
//
// AUDIT SPLIT: the store audits ONLY the transitions it alone detects — the lazy
// expiry / executing-deadline flips (`pending_call_expired` /
// `pending_call_execution_interrupted`), the late-upgrade
// (`pending_call_outcome_late`) and the policy change
// (`confirmation_policy_changed`). The park / confirm / deny / execute audits
// carry richer caller context (surface, decidedBy, failureCode) and are written
// by the PR-3 hook and PR-4 executor/action callers per the §7.3 taxonomy.

import { createHash, randomUUID } from "node:crypto";
import { getPooledDb } from "@/lib/db/pooled";
import { logAuditEvent } from "@/lib/authz/audit";

const schemaName = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";
const PENDING_CALL_TABLE = "connector_instance_pending_call";
const CONFIRMATION_POLICY_TABLE = "connector_instance_confirmation_policy";

/** The audit `policyVersion` for every confirmation-subsystem row (§7.3). */
export const CONFIRMATION_POLICY_VERSION = "connector-instance-confirmation";

// ---------------------------------------------------------------------------
// Constants (single source; the design's exported knobs — codex r1 M3)
// ---------------------------------------------------------------------------

/** Hard cap on the canonical-JSON byte size of parked args (256 KB). An
 * uninspectable blob must never be one-click-approved (DB CHECK mirrors this). */
export const ARGS_MAX_BYTES = 262144;
/** Cap on the redacted display copy persisted at park (8 KB, §6.2). */
export const ARGS_PREVIEW_MAX_BYTES = 8192;
/** A parked call is actionable for this long (`expires_at = created_at + this`). */
export const PENDING_CALL_EXPIRY_MS = 15 * 60 * 1000;
/** The ONE 15-min hard deadline (codex r1 M3): a reader may flip `executing →
 * failed('execution_interrupted')` only PAST `consumed_at + this` — no
 * in-process execution (2-min abort + transport timeouts) can outlive it, so the
 * flip only ever hits a CRASHED executor. */
export const EXECUTING_HARD_DEADLINE_MS = 15 * 60 * 1000;
/** ≥ this many `pending` rows for one (viewer, instance, tool) refuses further
 * parks — spam bounded at the durable layer (codex r0 #9c). */
export const PENDING_CALL_CAP = 3;
/** Terminal rows are swept this long after their last update (30 days, §3). */
export const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Bound on the on-write sweep per park (never a full-table scan-delete). */
export const SWEEP_LIMIT = 500;
/** Host-minted pending-call id prefix (`cipc_` + 32 hex). */
export const PENDING_CALL_ID_PREFIX = "cipc_";

const EXPIRY_SECONDS = PENDING_CALL_EXPIRY_MS / 1000;
const EXECUTING_DEADLINE_SECONDS = EXECUTING_HARD_DEADLINE_MS / 1000;
const TERMINAL_RETENTION_SECONDS = TERMINAL_RETENTION_MS / 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PendingCallStatus =
  | "pending"
  | "executing"
  | "executed"
  | "failed"
  | "denied"
  | "cancelled"
  | "expired";

/** The park-TRIGGER reason: an annotation `destructive` verdict, or a
 * floor-only (known-destructive-name) trigger on an otherwise weak annotation. */
export type PendingCallDerivedClass = "destructive" | "floor";

export type ConnectorInstanceConfirmationPolicyMode = "default" | "disabled";

/** The full persisted pending-call row. `args` is NULL once terminal (the
 * status↔args DB CHECK); `argsPreview`/`argsHash`/`argsBytes` survive for the
 * card's history. */
export type ConnectorInstancePendingCallRecord = {
  id: string;
  connectorKey: string;
  instanceId: string;
  serverId: string;
  toolName: string;
  args: Record<string, unknown> | null;
  argsHash: string;
  argsBytes: number;
  argsPreview: string;
  toolFingerprint: string;
  targetFingerprint: string;
  derivedClass: PendingCallDerivedClass;
  surface: string;
  userId: string;
  orgId: string;
  primitiveName: string | null;
  intent: string | null;
  causation: string | null;
  context: Record<string, unknown> | null;
  status: PendingCallStatus;
  failureCode: string | null;
  resultSummary: unknown;
  decidedBy: string | null;
  decidedAt: string | null;
  consumedAt: string | null;
  executingDeadline: string | null;
  executedAt: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

export type ConnectorInstanceConfirmationPolicyRecord = {
  connectorKey: string;
  instanceId: string;
  /** Raw stored mode. The reader fail-SAFES an unknown value to NOT-disabled
   * (require stays on) — only the exact literal `disabled` turns confirmation
   * off, so a garbled value can never silently drop the confirmation gate. */
  mode: string;
  updatedBy: string;
  updatedAt: string;
};

export type PendingCallStoreQuery = <T = unknown>(
  text: string,
  values?: readonly unknown[],
) => Promise<T[]>;

/** Runs `fn` inside a single DB transaction (park needs the xact-scoped advisory
 * lock + multi-statement atomicity). Tests inject a pass-through over the query
 * double; the default BEGIN/COMMITs on a pooled client. */
export type PendingCallTransaction = <T>(
  fn: (txQuery: PendingCallStoreQuery) => Promise<T>,
) => Promise<T>;

export type PendingCallStoreDeps = {
  /** Injected query fn (tests pass a mock). Default = the pooled connection. */
  query?: PendingCallStoreQuery;
  /** Injected transaction runner. Default = a pooled BEGIN/COMMIT, or a
   * pass-through over an injected `query` when one is supplied (test mode). */
  transaction?: PendingCallTransaction;
  /** Injected schema (tests may override). Default = SUPABASE_SCHEMA / "cinatra". */
  schema?: string;
  /** Injected audit sink (tests may spy). Default = the host audit log. */
  audit?: (event: Parameters<typeof logAuditEvent>[0]) => Promise<void> | void;
};

// ---------------------------------------------------------------------------
// Pure helpers (no DB) — SHARED by park (here) and resume (PR-4)
// ---------------------------------------------------------------------------

/** Deterministic canonical form (recursively sorted object keys) so a hash /
 * dedup key is stable regardless of the wire ordering of the args object. */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) out[key] = canonicalize(obj[key]);
  return out;
}

/** Canonical JSON string for the args object (stable-key-ordered). */
export function canonicalizeArgs(args: Record<string, unknown> | null | undefined): string {
  return JSON.stringify(canonicalize(args ?? {}));
}

/** Canonical args digest: sha256 hash (dedup + integrity) + UTF-8 byte size (the
 * 256 KB cap input). */
export function computeArgsDigest(args: Record<string, unknown> | null | undefined): {
  hash: string;
  bytes: number;
} {
  const canonical = canonicalizeArgs(args);
  return {
    hash: createHash("sha256").update(canonical, "utf8").digest("hex"),
    bytes: Buffer.byteLength(canonical, "utf8"),
  };
}

/** Park-time TOOL fingerprint (codex r0 #3/#8): sha256 over the canonical
 * `{name, serverId, inputSchema, rawAnnotations}`. Resume (PR-4) recomputes from
 * the CURRENT catalog and denies `tool_changed` on mismatch — annotations are
 * INSIDE the hash, so a destructive→write relabel also denies. */
export function computeToolFingerprint(input: {
  name: string;
  serverId: string;
  inputSchema?: unknown;
  rawAnnotations?: unknown;
}): string {
  const canonical = JSON.stringify(
    canonicalize({
      name: input.name,
      serverId: input.serverId,
      inputSchema: input.inputSchema ?? null,
      rawAnnotations: input.rawAnnotations ?? null,
    }),
  );
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Park-time execution-TARGET fingerprint (codex r1 High): sha256 over the
 * resolved endpoint URL string ONLY (siteUrl + rest_route path; the auth header
 * is NEVER part of the hash input). Resume (PR-4) re-resolves via the SAME
 * `deps.resolveInstanceEndpoint` and denies `target_changed` on mismatch (an
 * instance siteUrl repoint invalidates consent). No canonicalization — a missing
 * one can only cause SAFE false-denials (codex r2). */
export function computeTargetFingerprint(endpointUrl: string): string {
  return createHash("sha256").update(endpointUrl, "utf8").digest("hex");
}

const SECRET_KEY_PATTERN = /pass(word)?|secret|token|api[_-]?key|credential|authorization/i;

/** Depth-recursive redaction of secret-ish keys (§6.2). */
function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? "[redacted]" : redactValue(v);
    }
    return out;
  }
  return value;
}

/** The REDACTED, display-truncated args preview persisted at park (survives the
 * terminal args-nulling — card history). Secret-ish keys → `"[redacted]"`
 * (depth-recursive); pretty JSON display-truncated at `maxBytes` with an
 * explicit marker. The row keeps the FULL args the execution uses. */
export function redactArgsPreview(
  args: Record<string, unknown> | null | undefined,
  maxBytes: number = ARGS_PREVIEW_MAX_BYTES,
): string {
  const pretty = JSON.stringify(redactValue(args ?? {}), null, 2) ?? "";
  const bytes = Buffer.byteLength(pretty, "utf8");
  if (bytes <= maxBytes) return pretty;
  let truncated = Buffer.from(pretty, "utf8").subarray(0, maxBytes).toString("utf8");
  // A byte cut inside a multibyte code point yields a trailing U+FFFD (3 bytes);
  // drop it so the slice never exceeds maxBytes and no invalid glyph leaks in.
  if (truncated.endsWith("�")) truncated = truncated.slice(0, -1);
  return `${truncated}\n…truncated for display (${Math.ceil(bytes / 1024)} KB total)`;
}

/** Mint a host-side pending-call id: `cipc_` + 32 hex (randomUUID-derived). */
export function mintPendingCallId(): string {
  return `${PENDING_CALL_ID_PREFIX}${randomUUID().replaceAll("-", "")}`;
}

// ---------------------------------------------------------------------------
// Deps + connection plumbing
// ---------------------------------------------------------------------------

async function defaultQuery<T = unknown>(
  text: string,
  values?: readonly unknown[],
): Promise<T[]> {
  const pool = await getPooledDb({ name: "connector-instance-pending-call" });
  const result = await pool.query(text, values ? [...values] : undefined);
  return result.rows as T[];
}

async function defaultTransaction<T>(
  fn: (txQuery: PendingCallStoreQuery) => Promise<T>,
): Promise<T> {
  const pool = await getPooledDb({ name: "connector-instance-pending-call" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const txQuery: PendingCallStoreQuery = async <U = unknown>(
      text: string,
      values?: readonly unknown[],
    ) => {
      const result = await client.query(text, values ? [...values] : undefined);
      return result.rows as U[];
    };
    const out = await fn(txQuery);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* the original error is the one worth surfacing */
    }
    throw err;
  } finally {
    client.release();
  }
}

function passthroughTransaction(query: PendingCallStoreQuery): PendingCallTransaction {
  return async (fn) => fn(query);
}

function resolveDeps(deps?: PendingCallStoreDeps): {
  query: PendingCallStoreQuery;
  transaction: PendingCallTransaction;
  pendingCallTable: string;
  confirmationPolicyTable: string;
  audit: NonNullable<PendingCallStoreDeps["audit"]>;
} {
  const schema = deps?.schema ?? schemaName;
  // schemaName / SUPABASE_SCHEMA is operator config, never user input; quote
  // defensively all the same (mirrors the policy/server stores).
  const s = schema.replaceAll('"', '""');
  const injectedQuery = deps?.query;
  const query = injectedQuery ?? defaultQuery;
  const transaction =
    deps?.transaction ?? (injectedQuery ? passthroughTransaction(injectedQuery) : defaultTransaction);
  return {
    query,
    transaction,
    pendingCallTable: `"${s}"."${PENDING_CALL_TABLE}"`,
    confirmationPolicyTable: `"${s}"."${CONFIRMATION_POLICY_TABLE}"`,
    audit: deps?.audit ?? ((event) => logAuditEvent(event)),
  };
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

const PENDING_CALL_COLUMNS = `id, connector_key, instance_id, server_id, tool_name,
      args, args_hash, args_bytes, args_preview, tool_fingerprint, target_fingerprint,
      derived_class, surface, user_id, org_id, primitive_name, intent, causation,
      context, status, failure_code, result_summary, decided_by, decided_at,
      consumed_at, executing_deadline, executed_at, expires_at, created_at, updated_at`;

type PendingCallRow = {
  id: string;
  connector_key: string;
  instance_id: string;
  server_id: string;
  tool_name: string;
  args: unknown;
  args_hash: string;
  args_bytes: number | string;
  args_preview: string;
  tool_fingerprint: string;
  target_fingerprint: string;
  derived_class: string;
  surface: string;
  user_id: string;
  org_id: string;
  primitive_name: string | null;
  intent: string | null;
  causation: string | null;
  context: unknown;
  status: string;
  failure_code: string | null;
  result_summary: unknown;
  decided_by: string | null;
  decided_at: string | Date | null;
  consumed_at: string | Date | null;
  executing_deadline: string | Date | null;
  executed_at: string | Date | null;
  expires_at: string | Date;
  created_at: string | Date;
  updated_at: string | Date;
};

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoOrNull(value: string | Date | null | undefined): string | null {
  return value === null || value === undefined ? null : toIso(value);
}

function rowToPendingCallRecord(row: PendingCallRow): ConnectorInstancePendingCallRecord {
  return {
    id: row.id,
    connectorKey: row.connector_key,
    instanceId: row.instance_id,
    serverId: row.server_id,
    toolName: row.tool_name,
    args: (row.args ?? null) as Record<string, unknown> | null,
    argsHash: row.args_hash,
    argsBytes: Number(row.args_bytes),
    argsPreview: row.args_preview,
    toolFingerprint: row.tool_fingerprint,
    targetFingerprint: row.target_fingerprint,
    // Stored strings are cast; a garbage value never loosens a gate (the reader
    // treats an unknown status as non-actionable).
    derivedClass: row.derived_class as PendingCallDerivedClass,
    surface: row.surface,
    userId: row.user_id,
    orgId: row.org_id,
    primitiveName: row.primitive_name,
    intent: row.intent,
    causation: row.causation,
    context: (row.context ?? null) as Record<string, unknown> | null,
    status: row.status as PendingCallStatus,
    failureCode: row.failure_code,
    resultSummary: row.result_summary ?? null,
    decidedBy: row.decided_by,
    decidedAt: toIsoOrNull(row.decided_at),
    consumedAt: toIsoOrNull(row.consumed_at),
    executingDeadline: toIsoOrNull(row.executing_deadline),
    executedAt: toIsoOrNull(row.executed_at),
    expiresAt: toIso(row.expires_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Audit helpers
// ---------------------------------------------------------------------------

type FlippedRow = {
  id: string;
  connector_key: string;
  instance_id: string;
  status: string;
  failure_code: string | null;
};

async function auditSystemTransition(
  audit: NonNullable<PendingCallStoreDeps["audit"]>,
  input: {
    operation: string;
    decision: "allowed" | "denied";
    connectorKey: string;
    instanceId: string;
    pendingCallId: string;
    extra?: Record<string, unknown>;
  },
): Promise<void> {
  await audit({
    resourceType: "connector_instance",
    resourceId: input.instanceId,
    actorPrincipalType: "system",
    authSource: "worker",
    operation: input.operation,
    decision: input.decision,
    policyVersion: CONFIRMATION_POLICY_VERSION,
    metadata: {
      connectorKey: input.connectorKey,
      pendingCallId: input.pendingCallId,
      ...input.extra,
    },
  });
}

/** Audit each row a lazy flip terminalized: expired-pending → `pending_call_expired`;
 * crashed-executing → `pending_call_execution_interrupted`. */
async function auditFlips(
  audit: NonNullable<PendingCallStoreDeps["audit"]>,
  flipped: readonly FlippedRow[],
): Promise<void> {
  for (const row of flipped) {
    const interrupted = row.status === "failed" && row.failure_code === "execution_interrupted";
    await auditSystemTransition(audit, {
      operation: interrupted ? "pending_call_execution_interrupted" : "pending_call_expired",
      decision: "denied",
      connectorKey: row.connector_key,
      instanceId: row.instance_id,
      pendingCallId: row.id,
      extra: interrupted ? { failureCode: "execution_interrupted" } : {},
    });
  }
}

// The lazy-flip UPDATE shared by the viewer list + the point read. Scoped by the
// caller's WHERE tail. Terminalizes stale rows the DB clock proves are past
// their boundary (readers never flip a LIVE execution — codex r0 #2): a
// `pending` row past `expires_at` → `expired`; an `executing` row past the
// 15-min hard `executing_deadline` (only a CRASHED executor) → `failed
// ('execution_interrupted')`. Both null `args` (the status↔args CHECK).
function buildFlipStaleSql(table: string, whereTail: string): string {
  return `UPDATE ${table}
        SET status = CASE WHEN status = 'pending' THEN 'expired' ELSE 'failed' END,
            failure_code = CASE WHEN status = 'executing' THEN 'execution_interrupted' ELSE failure_code END,
            args = NULL,
            updated_at = now()
      WHERE ${whereTail}
        AND ( (status = 'pending' AND expires_at <= now())
           OR (status = 'executing' AND executing_deadline IS NOT NULL AND executing_deadline <= now()) )
      RETURNING id, connector_key, instance_id, status, failure_code`;
}

// ---------------------------------------------------------------------------
// connector_instance_pending_call — park (the one transactional writer)
// ---------------------------------------------------------------------------

export type ParkPendingCallInput = {
  connectorKey: string;
  instanceId: string;
  serverId: string;
  toolName: string;
  /** FULL execution args (persisted while actionable; nulled at terminalization). */
  args: Record<string, unknown>;
  /** Resolved endpoint URL string (siteUrl + rest_route; NO credentials). */
  endpointUrl: string;
  /** Tool-shape material for the park-time `tool_fingerprint`. */
  inputSchema?: unknown;
  rawAnnotations?: unknown;
  derivedClass: PendingCallDerivedClass;
  surface: string;
  userId: string;
  orgId: string;
  primitiveName?: string | null;
  intent?: string | null;
  causation?: string | null;
  /** {runId?, clientId?, catalogRevision?} — forensics/correlation only. */
  context?: Record<string, unknown> | null;
};

export type ParkPendingCallResult =
  | { outcome: "parked"; id: string; expiresAt: string; reused: boolean }
  | { outcome: "args_too_large"; argsBytes: number }
  | { outcome: "cap_exceeded"; pendingCount: number };

/**
 * Park a destructive call pending confirmation. ONE transaction, serialized per
 * cap key (codex r1 M1): advisory-lock → flip THIS dedup key's expired pendings
 * → EXACT-DUP COLLAPSE (a duplicate retry returns the existing id, BYPASSING the
 * cap) → cap check → `INSERT … ON CONFLICT (<dedup cols>) WHERE status='pending'
 * DO NOTHING RETURNING` (a cross-lock loser selects the winner). Args over the
 * 256 KB cap refuse BEFORE the transaction. An on-write terminal-row sweep
 * piggybacks after commit (bounded). The dedup arbiter names the partial-index
 * predicate exactly.
 */
export async function parkPendingCall(
  input: ParkPendingCallInput,
  deps?: PendingCallStoreDeps,
): Promise<ParkPendingCallResult> {
  const { transaction, query, pendingCallTable, audit } = resolveDeps(deps);

  const { hash: argsHash, bytes: argsBytes } = computeArgsDigest(input.args);
  if (argsBytes > ARGS_MAX_BYTES) {
    return { outcome: "args_too_large", argsBytes };
  }
  const argsPreview = redactArgsPreview(input.args);
  const toolFingerprint = computeToolFingerprint({
    name: input.toolName,
    serverId: input.serverId,
    inputSchema: input.inputSchema,
    rawAnnotations: input.rawAnnotations,
  });
  const targetFingerprint = computeTargetFingerprint(input.endpointUrl);

  // The full dedup key (arbiter + collapse) and cap key (advisory lock + count).
  const dedupKey = [
    input.orgId,
    input.connectorKey,
    input.instanceId,
    input.serverId,
    input.userId,
    input.surface,
    input.toolName,
    argsHash,
  ] as const;

  const result = await transaction(async (tx) => {
    // (1) Serialize the whole park section per (org, user, connector, instance,
    // tool) — the cap key. hashtextextended over the concatenated key.
    await tx(
      `SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2 || ':' || $3 || ':' || $4 || ':' || $5, 0))`,
      [input.orgId, input.userId, input.connectorKey, input.instanceId, input.toolName],
    );

    // (2) Flip THIS dedup key's expired pendings so a stale row never blocks the
    // arbiter or masquerades as a live duplicate.
    const flipped = await tx<FlippedRow>(
      `UPDATE ${pendingCallTable}
          SET status = 'expired', args = NULL, updated_at = now()
        WHERE org_id = $1 AND connector_key = $2 AND instance_id = $3 AND server_id = $4
          AND user_id = $5 AND surface = $6 AND tool_name = $7 AND args_hash = $8
          AND status = 'pending' AND expires_at <= now()
        RETURNING id, connector_key, instance_id, status, failure_code`,
      dedupKey,
    );
    await auditFlips(audit, flipped);

    // (3) EXACT-DUP COLLAPSE FIRST (codex r1 M1): a live duplicate returns its
    // id and BYPASSES the cap — a retry at cap must collapse, never refuse.
    const dup = await tx<{ id: string; expires_at: string | Date }>(
      `SELECT id, expires_at FROM ${pendingCallTable}
        WHERE org_id = $1 AND connector_key = $2 AND instance_id = $3 AND server_id = $4
          AND user_id = $5 AND surface = $6 AND tool_name = $7 AND args_hash = $8
          AND status = 'pending'
        LIMIT 1`,
      dedupKey,
    );
    if (dup[0]) {
      return { outcome: "parked", id: dup[0].id, expiresAt: toIso(dup[0].expires_at), reused: true } as const;
    }

    // (4) Cap check: ≥ PENDING_CALL_CAP LIVE pending rows for this (viewer,
    // instance, tool) refuses further parks. `expires_at > now()` excludes
    // expired-but-not-yet-flipped rows of OTHER dedup keys (step 2 only flips
    // THIS key) so a stale card can never spuriously force `cap_exceeded`
    // (codex r1).
    const capRows = await tx<{ n: number | string }>(
      `SELECT count(*)::int AS n FROM ${pendingCallTable}
        WHERE org_id = $1 AND user_id = $2 AND connector_key = $3 AND instance_id = $4
          AND tool_name = $5 AND status = 'pending' AND expires_at > now()`,
      [input.orgId, input.userId, input.connectorKey, input.instanceId, input.toolName],
    );
    const pendingCount = Number(capRows[0]?.n ?? 0);
    if (pendingCount >= PENDING_CALL_CAP) {
      return { outcome: "cap_exceeded", pendingCount } as const;
    }

    // (5) Insert; the partial-unique arbiter (named predicate) collapses a
    // cross-lock racer to DO NOTHING → the loser selects the winner.
    const id = mintPendingCallId();
    const inserted = await tx<{ id: string; expires_at: string | Date }>(
      `INSERT INTO ${pendingCallTable} (
         id, connector_key, instance_id, server_id, tool_name,
         args, args_hash, args_bytes, args_preview, tool_fingerprint, target_fingerprint,
         derived_class, surface, user_id, org_id, primitive_name, intent, causation,
         context, status, expires_at, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6::jsonb, $7, $8, $9, $10, $11,
         $12, $13, $14, $15, $16, $17, $18,
         $19::jsonb, 'pending', now() + make_interval(secs => $20), now(), now()
       )
       ON CONFLICT (org_id, connector_key, instance_id, server_id, user_id, surface, tool_name, args_hash)
         WHERE status = 'pending'
         DO NOTHING
       RETURNING id, expires_at`,
      [
        id,
        input.connectorKey,
        input.instanceId,
        input.serverId,
        input.toolName,
        JSON.stringify(input.args ?? {}),
        argsHash,
        argsBytes,
        argsPreview,
        toolFingerprint,
        targetFingerprint,
        input.derivedClass,
        input.surface,
        input.userId,
        input.orgId,
        input.primitiveName ?? null,
        input.intent ?? null,
        input.causation ?? null,
        input.context ? JSON.stringify(input.context) : null,
        EXPIRY_SECONDS,
      ],
    );
    if (inserted[0]) {
      return { outcome: "parked", id: inserted[0].id, expiresAt: toIso(inserted[0].expires_at), reused: false } as const;
    }

    // Cross-lock racer lost the arbiter: the winner's row now exists.
    const winner = await tx<{ id: string; expires_at: string | Date }>(
      `SELECT id, expires_at FROM ${pendingCallTable}
        WHERE org_id = $1 AND connector_key = $2 AND instance_id = $3 AND server_id = $4
          AND user_id = $5 AND surface = $6 AND tool_name = $7 AND args_hash = $8
          AND status = 'pending'
        LIMIT 1`,
      dedupKey,
    );
    if (winner[0]) {
      return { outcome: "parked", id: winner[0].id, expiresAt: toIso(winner[0].expires_at), reused: true } as const;
    }
    // Should be unreachable (we hold the lock); surface loudly rather than lie.
    throw new Error("parkPendingCall: insert produced no row and no live duplicate under the advisory lock");
  });

  // On-write sweep (best-effort, bounded) — the widget-tables precedent: no cron.
  await sweepTerminalPendingCalls(query, pendingCallTable);

  return result;
}

/** Delete terminal rows older than the retention window (bounded). Best-effort;
 * a sweep failure never fails the park it piggybacks on. */
async function sweepTerminalPendingCalls(
  query: PendingCallStoreQuery,
  table: string,
): Promise<void> {
  try {
    await query(
      `DELETE FROM ${table}
        WHERE ctid IN (
          SELECT ctid FROM ${table}
           WHERE status IN ('executed','failed','denied','cancelled','expired')
             AND updated_at < now() - make_interval(secs => $1)
           LIMIT ${SWEEP_LIMIT}
        )`,
      [TERMINAL_RETENTION_SECONDS],
    );
  } catch {
    /* best-effort retention; never fails the park */
  }
}

// ---------------------------------------------------------------------------
// connector_instance_pending_call — exactly-once CAS surfaces
// ---------------------------------------------------------------------------

/**
 * THE exactly-once edge (design §4): `pending → executing` CAS. Stamps
 * `decided_by`/`decided_at`/`consumed_at` and a `consumed_at + 15 min` hard
 * `executing_deadline`. Returns the executing row, or `null` when 0 rows matched
 * (already decided / expired / unknown) — the caller then reads the row and
 * returns its terminal outcome (same-output no-op). Args are retained (execution
 * needs them). Caller-owned `pending_call_confirmed` audit (PR-4).
 */
export async function consumePendingCall(
  id: string,
  input: { decidedBy: string },
  deps?: PendingCallStoreDeps,
): Promise<ConnectorInstancePendingCallRecord | null> {
  const { query, pendingCallTable } = resolveDeps(deps);
  const rows = await query<PendingCallRow>(
    `UPDATE ${pendingCallTable}
        SET status = 'executing',
            decided_by = $2,
            decided_at = now(),
            consumed_at = now(),
            executing_deadline = now() + make_interval(secs => $3),
            updated_at = now()
      WHERE id = $1 AND status = 'pending' AND expires_at > now()
      RETURNING ${PENDING_CALL_COLUMNS}`,
    [id, input.decidedBy, EXECUTING_DEADLINE_SECONDS],
  );
  const row = rows[0];
  return row ? rowToPendingCallRecord(row) : null;
}

/**
 * Terminal negative decision (`denied` | `cancelled`) — the same CAS shape, no
 * execution; nulls `args`. Returns the terminal row, or `null` when 0 rows
 * matched. Caller-owned `pending_call_denied` / `pending_call_cancelled` audit
 * (PR-4).
 */
export async function denyPendingCall(
  id: string,
  input: { decidedBy: string; as: "denied" | "cancelled" },
  deps?: PendingCallStoreDeps,
): Promise<ConnectorInstancePendingCallRecord | null> {
  const { query, pendingCallTable } = resolveDeps(deps);
  const rows = await query<PendingCallRow>(
    `UPDATE ${pendingCallTable}
        SET status = $3,
            decided_by = $2,
            decided_at = now(),
            args = NULL,
            updated_at = now()
      WHERE id = $1 AND status = 'pending' AND expires_at > now()
      RETURNING ${PENDING_CALL_COLUMNS}`,
    [id, input.decidedBy, input.as],
  );
  const row = rows[0];
  return row ? rowToPendingCallRecord(row) : null;
}

export type RecordOutcomeResult = {
  record: ConnectorInstancePendingCallRecord;
  /** true when the row was a reader-flipped `execution_interrupted` that this
   * call upgraded to the REAL outcome (audited `pending_call_outcome_late`). */
  lateUpgrade: boolean;
};

/**
 * Record the terminal execution outcome (`executed` | `failed`); nulls `args`.
 * Primary CAS: `WHERE status='executing'`. On 0 rows, a LATE-UPGRADE fallback
 * (`WHERE status='failed' AND failure_code='execution_interrupted'`) turns a
 * pessimistic reader flip into the real outcome — so "the wire ran exactly once"
 * survives a slow execution that outlived a reader flip (codex r0 #2), audited
 * `pending_call_outcome_late`. Returns `null` when neither matched (already
 * terminal in another state). The normal-path `pending_call_executed` /
 * `pending_call_execution_failed` audit is the executor's (PR-4).
 */
export async function recordOutcome(
  id: string,
  input: { status: "executed" | "failed"; failureCode?: string | null; resultSummary?: unknown },
  deps?: PendingCallStoreDeps,
): Promise<RecordOutcomeResult | null> {
  const { query, pendingCallTable, audit } = resolveDeps(deps);
  const summaryJson = input.resultSummary === undefined ? null : JSON.stringify(input.resultSummary);

  const primary = await query<PendingCallRow>(
    `UPDATE ${pendingCallTable}
        SET status = $2,
            failure_code = $3,
            result_summary = $4::jsonb,
            executed_at = CASE WHEN $2 = 'executed' THEN now() ELSE executed_at END,
            args = NULL,
            updated_at = now()
      WHERE id = $1 AND status = 'executing'
      RETURNING ${PENDING_CALL_COLUMNS}`,
    [id, input.status, input.failureCode ?? null, summaryJson],
  );
  if (primary[0]) {
    return { record: rowToPendingCallRecord(primary[0]), lateUpgrade: false };
  }

  // LATE-UPGRADE: a reader pessimistically flipped a crashed-executing row to
  // execution_interrupted, but the real outcome arrived late (args already NULL
  // from the flip). Re-null `args` for parity with the primary terminal path so
  // the status↔args CHECK holds regardless of how the row reached this state.
  const late = await query<PendingCallRow>(
    `UPDATE ${pendingCallTable}
        SET status = $2,
            failure_code = $3,
            result_summary = $4::jsonb,
            executed_at = CASE WHEN $2 = 'executed' THEN now() ELSE executed_at END,
            args = NULL,
            updated_at = now()
      WHERE id = $1 AND status = 'failed' AND failure_code = 'execution_interrupted'
      RETURNING ${PENDING_CALL_COLUMNS}`,
    [id, input.status, input.failureCode ?? null, summaryJson],
  );
  if (late[0]) {
    const record = rowToPendingCallRecord(late[0]);
    await auditSystemTransition(audit, {
      operation: "pending_call_outcome_late",
      decision: input.status === "executed" ? "allowed" : "denied",
      connectorKey: record.connectorKey,
      instanceId: record.instanceId,
      pendingCallId: record.id,
      extra: { status: input.status, ...(input.failureCode ? { failureCode: input.failureCode } : {}) },
    });
    return { record, lateUpgrade: true };
  }

  return null;
}

// ---------------------------------------------------------------------------
// connector_instance_pending_call — reads (with lazy expiry)
// ---------------------------------------------------------------------------

/**
 * The `(org, user)`-scoped card list (NOT thread-scoped — a park from any
 * require-surface is visible in the user's cinatra chat panel). Lazy-flips stale
 * rows (expired pendings / crashed executions past the hard deadline) BEFORE
 * returning, auditing each flip.
 */
export async function listPendingCallsForViewer(
  input: { orgId: string; userId: string },
  deps?: PendingCallStoreDeps,
): Promise<ConnectorInstancePendingCallRecord[]> {
  const { query, pendingCallTable, audit } = resolveDeps(deps);
  const flipped = await query<FlippedRow>(
    buildFlipStaleSql(pendingCallTable, "org_id = $1 AND user_id = $2"),
    [input.orgId, input.userId],
  );
  await auditFlips(audit, flipped);
  const rows = await query<PendingCallRow>(
    `SELECT ${PENDING_CALL_COLUMNS}
       FROM ${pendingCallTable}
      WHERE org_id = $1 AND user_id = $2
      ORDER BY created_at DESC, id ASC`,
    [input.orgId, input.userId],
  );
  return rows.map(rowToPendingCallRecord);
}

/** Point read by id, lazy-flipping the row first if stale. `null` when absent. */
export async function readPendingCall(
  id: string,
  deps?: PendingCallStoreDeps,
): Promise<ConnectorInstancePendingCallRecord | null> {
  const { query, pendingCallTable, audit } = resolveDeps(deps);
  const flipped = await query<FlippedRow>(
    buildFlipStaleSql(pendingCallTable, "id = $1"),
    [id],
  );
  await auditFlips(audit, flipped);
  const rows = await query<PendingCallRow>(
    `SELECT ${PENDING_CALL_COLUMNS} FROM ${pendingCallTable} WHERE id = $1 LIMIT 1`,
    [id],
  );
  const row = rows[0];
  return row ? rowToPendingCallRecord(row) : null;
}

// ---------------------------------------------------------------------------
// connector_instance_confirmation_policy — per-instance org override
// ---------------------------------------------------------------------------

type ConfirmationPolicyRow = {
  connector_key: string;
  instance_id: string;
  mode: string;
  updated_by: string;
  updated_at: string | Date;
};

function rowToPolicyRecord(row: ConfirmationPolicyRow): ConnectorInstanceConfirmationPolicyRecord {
  return {
    connectorKey: row.connector_key,
    instanceId: row.instance_id,
    mode: row.mode,
    updatedBy: row.updated_by,
    updatedAt: toIso(row.updated_at),
  };
}

/** Read the per-instance confirmation override, or `null` (defaults apply — the
 * hook keeps require ON for chat/session). Point read on the primary key. */
export async function readConfirmationPolicy(
  connectorKey: string,
  instanceId: string,
  deps?: PendingCallStoreDeps,
): Promise<ConnectorInstanceConfirmationPolicyRecord | null> {
  const { query, confirmationPolicyTable } = resolveDeps(deps);
  const rows = await query<ConfirmationPolicyRow>(
    `SELECT connector_key, instance_id, mode, updated_by, updated_at
       FROM ${confirmationPolicyTable}
      WHERE connector_key = $1 AND instance_id = $2
      LIMIT 1`,
    [connectorKey, instanceId],
  );
  const row = rows[0];
  return row ? rowToPolicyRecord(row) : null;
}

/**
 * Set the per-instance confirmation override (`default` | `disabled`). Upserts
 * the row and audits `confirmation_policy_changed` (from→to, updatedBy). The
 * org-admin gate lives at the caller (the host member — S3 manual-route pattern).
 */
export async function setConfirmationPolicy(
  input: {
    connectorKey: string;
    instanceId: string;
    mode: ConnectorInstanceConfirmationPolicyMode;
    updatedBy: string;
  },
  deps?: PendingCallStoreDeps,
): Promise<void> {
  const { query, confirmationPolicyTable, audit } = resolveDeps(deps);
  const prior = await readConfirmationPolicy(input.connectorKey, input.instanceId, deps);
  await query(
    `INSERT INTO ${confirmationPolicyTable} (connector_key, instance_id, mode, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (connector_key, instance_id) DO UPDATE SET
       mode = EXCLUDED.mode,
       updated_by = EXCLUDED.updated_by,
       updated_at = EXCLUDED.updated_at`,
    [input.connectorKey, input.instanceId, input.mode, input.updatedBy],
  );
  await audit({
    resourceType: "connector_instance",
    resourceId: input.instanceId,
    actorPrincipalType: "human",
    actorPrincipalId: input.updatedBy,
    authSource: "mcp",
    operation: "confirmation_policy_changed",
    decision: "allowed",
    policyVersion: CONFIRMATION_POLICY_VERSION,
    metadata: {
      connectorKey: input.connectorKey,
      instanceId: input.instanceId,
      from: prior?.mode ?? "default",
      to: input.mode,
      updatedBy: input.updatedBy,
    },
  });
}
