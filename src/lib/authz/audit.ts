/**
 * Authorization kernel — audit event type AND write helper.
 *
 * Defines the authorization audit payload and writes records to the Postgres
 * audit_events table for every authorization decision, including denied
 * decisions with rate/noise controls.
 *
 * All fields are JSON-serializable primitives — only string/number/
 * boolean/array/record types allowed (no JS reference types), so AuditEvent
 * can be safely snapshotted into BullMQ payloads.
 */
import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { lt } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { auditEvents } from "./audit-schema";

export type AuditEvent = {
  organizationId?: string;
  actorPrincipalId: string;
  actorPrincipalType:
    | "HumanUser"
    | "ServiceAccount"
    | "ExternalA2AAgent"
    | "InternalWorker"
    | "System";
  authSource: "ui" | "worker" | "mcp" | "a2a" | "agent";
  delegatedBy?: string;
  impersonatedUserId?: string;
  resourceType: string;
  resourceId: string;
  operation: string;
  decision: "allowed" | "denied";
  policyVersion: string;
  requestId?: string;
  runId?: string;
  a2aTaskId?: string;
};

// ---------------------------------------------------------------------------
// Write-side input type. Looser than AuditEvent: all fields
// optional so that call sites can log partial information without crashing
// when actor context is incomplete.
// ---------------------------------------------------------------------------

export type AuditEventInput = {
  organizationId?: string;
  actorPrincipalId?: string;
  actorPrincipalType?: "human" | "model" | "system" | "a2a";
  authSource?: "ui" | "route" | "worker" | "scheduler" | "agent" | "a2a" | "mcp";
  delegatedBy?: string;
  impersonatedUserId?: string;
  resourceType?: string;
  resourceId?: string;
  operation?: string;
  decision?: "allowed" | "denied";
  policyVersion?: string;
  requestId?: string;
  runId?: string;
  a2aTaskId?: string;
  ip?: string;
  metadata?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Sensitive-key blocklist. These keys are stripped silently: no warning,
// no log, no throw.
// ---------------------------------------------------------------------------

const SENSITIVE_KEYS = new Set<string>([
  "prompt",
  "content",
  "body",
  "draft",
  "email",
  "password",
  "token",
  "secret",
  "key",
  "credential",
  "payload",
]);

export function sanitizeMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (!SENSITIVE_KEYS.has(k)) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Denied-event cooldown.
// Module-level Map; resets on process restart (acceptable for noise control).
// Only `decision: "denied"` events are subject to cooldown — allowed events
// always insert.
// ---------------------------------------------------------------------------

const DENIED_COOLDOWN_MS = 60_000;
const _deniedCooldown = new Map<string, number>(); // key → expiresAt (ms)

function deniedCooldownKey(input: AuditEventInput): string {
  return `${input.actorPrincipalId ?? ""}:${input.resourceType ?? ""}:${input.operation ?? ""}`;
}

export function isDeniedCoolingDown(key: string): boolean {
  const expiresAt = _deniedCooldown.get(key);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    _deniedCooldown.delete(key);
    return false;
  }
  return true;
}

/** Test-only seam — drains the cooldown map between vitest runs. */
export function _resetDeniedCooldownForTests(): void {
  _deniedCooldown.clear();
}

// ---------------------------------------------------------------------------
// Pool + Drizzle bootstrap. Mirrors src/lib/projects-store.ts pattern:
// global pool cache for hot-reload safety; idle-error listener to keep
// the process alive when Supabase drops idle connections.
// ---------------------------------------------------------------------------

declare global {
  var __cinatraAuditPool: Pool | undefined;
}

// Lazy pool + drizzle bootstrap. The pool/db are internal to this module and
// created on first use (not at module import) so importing @/lib/authz/audit —
// including during `next build` page-data collection — does not require
// SUPABASE_DB_URL. `new Pool()` never opens a connection until the first query.
let auditPoolInstance: Pool | undefined;
function getAuditPool(): Pool {
  if (auditPoolInstance) return auditPoolInstance;
  if (globalThis.__cinatraAuditPool) {
    return (auditPoolInstance = globalThis.__cinatraAuditPool);
  }
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error("SUPABASE_DB_URL is required for @/lib/authz/audit");
  }
  const pool = new Pool({ connectionString });
  if (!pool.listenerCount("error")) {
    pool.on("error", (err: Error) => {
      console.error("[authz/audit] pg pool idle client error:", err.message);
    });
  }
  auditPoolInstance = pool;
  if (process.env.NODE_ENV !== "production") {
    globalThis.__cinatraAuditPool = pool;
  }
  return pool;
}

function createAuditDb() {
  return drizzle(getAuditPool(), { schema: { auditEvents } });
}
let auditDbInstance: ReturnType<typeof createAuditDb> | undefined;
function getAuditDb(): ReturnType<typeof createAuditDb> {
  return (auditDbInstance ??= createAuditDb());
}

// ---------------------------------------------------------------------------
// logAuditEvent — fire-and-forget write helper.
//
// Contract:
//   1. NEVER throws. Returns Promise<void>; even if the underlying insert
//      rejects, we swallow with .catch(() => {}).
//   2. NEVER blocks the caller's main code path. The await is on a single
//      Postgres INSERT (fast); any failure is silently ignored.
//   3. Sanitizes metadata via the SENSITIVE_KEYS blocklist before insert.
//   4. Denied events are cooldown-suppressed within a 60s window per
//      (actorPrincipalId, resourceType, operation) key.
// ---------------------------------------------------------------------------

export async function logAuditEvent(input: AuditEventInput): Promise<void> {
  // Cooldown gate — denied events only.
  let deniedCooldownKey_: string | undefined;
  if (input.decision === "denied") {
    const key = deniedCooldownKey(input);
    if (isDeniedCoolingDown(key)) return;
    // Record the key to register AFTER a successful insert attempt so that a
    // failed insert (DB down, constraint error) does not set the cooldown and
    // create a 60-second blind spot where all subsequent denied events are
    // silently dropped without any write attempt.
    deniedCooldownKey_ = key;
  }

  // Sanitize metadata then fire-and-forget insert.
  let inserted = false;
  await getAuditDb()
    .insert(auditEvents)
    .values({
      id: randomUUID(),
      organizationId: input.organizationId ?? null,
      actorPrincipalId: input.actorPrincipalId ?? null,
      actorPrincipalType: input.actorPrincipalType ?? null,
      authSource: input.authSource ?? null,
      delegatedBy: input.delegatedBy ?? null,
      impersonatedUserId: input.impersonatedUserId ?? null,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      operation: input.operation ?? null,
      decision: input.decision ?? null,
      policyVersion: input.policyVersion ?? null,
      requestId: input.requestId ?? null,
      runId: input.runId ?? null,
      a2aTaskId: input.a2aTaskId ?? null,
      ip: input.ip ?? null,
      metadata: sanitizeMetadata(input.metadata) ?? null,
      // createdAt is defaulted by Postgres (timestamptz NOT NULL DEFAULT now()).
    })
    .then(() => {
      inserted = true;
    })
    .catch(() => {
      // Silent swallow — fire-and-forget.
      // No console.error to avoid log spam if Postgres is briefly down.
    });

  // Only suppress future denied events for this key once the insert was
  // actually attempted and succeeded — avoids a 60-second blind spot on
  // transient DB failures.
  if (inserted && deniedCooldownKey_) {
    _deniedCooldown.set(deniedCooldownKey_, Date.now() + DENIED_COOLDOWN_MS);
  }
}

// ---------------------------------------------------------------------------
// logAuditEventStrict — strict sibling of logAuditEvent.
//
// Differences from logAuditEvent:
//   1. Propagates insert errors (NO .catch swallow). The caller treats an
//      audit-write failure as a hard error and aborts the privileged
//      mutation it was about to perform.
//   2. Returns the inserted row id via Drizzle's .returning() so the
//      caller can correlate the audit row with the resulting state change.
//   3. Skips the denied-cooldown logic entirely — the strict variant is
//      called from withPlatformAdminBypass which only ever logs
//      decision: "allowed".
//
// Reuses sanitizeMetadata for consistency with the fail-silent variant
// (same SENSITIVE_KEYS stripping).
//
// DO NOT replace logAuditEvent with this. Many callers rely on
// fail-silent semantics (route guards, MCP boundary checks). This is an
// additive sibling, not a migration.
// ---------------------------------------------------------------------------

export async function logAuditEventStrict(
  input: AuditEventInput,
): Promise<{ id: string }> {
  const id = randomUUID();
  const rows = await getAuditDb()
    .insert(auditEvents)
    .values({
      id,
      organizationId: input.organizationId ?? null,
      actorPrincipalId: input.actorPrincipalId ?? null,
      actorPrincipalType: input.actorPrincipalType ?? null,
      authSource: input.authSource ?? null,
      delegatedBy: input.delegatedBy ?? null,
      impersonatedUserId: input.impersonatedUserId ?? null,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      operation: input.operation ?? null,
      decision: input.decision ?? null,
      policyVersion: input.policyVersion ?? null,
      requestId: input.requestId ?? null,
      runId: input.runId ?? null,
      a2aTaskId: input.a2aTaskId ?? null,
      ip: input.ip ?? null,
      metadata: sanitizeMetadata(input.metadata) ?? null,
      // createdAt is defaulted by Postgres (timestamptz NOT NULL DEFAULT now()).
    })
    .returning({ id: auditEvents.id });
  // .returning() yields exactly one row for a single INSERT; fall back to
  // the locally generated id if the driver returns an empty array (defensive).
  return { id: rows[0]?.id ?? id };
}

// ---------------------------------------------------------------------------
// Durable audit-log retention.
//
// Authz audit events are retained for a default of 12 months. The window is
// admin-configurable via the `audit_retention` metadata key; the deletion
// path (`enforceAuditRetention`) is invoked by the scheduled job /
// `pnpm authz:retention` script. Advanced features (legal hold, per-resource
// retention policies) are not part of this retention helper.
// ---------------------------------------------------------------------------

/** Default retention window — 12 months. */
export const DEFAULT_AUDIT_RETENTION_DAYS = 365;
/** Minimum the admin knob may be set to (a week — guards against fat-finger 0). */
export const MIN_AUDIT_RETENTION_DAYS = 7;

/**
 * Resolve the configured retention window in days. Reads the
 * `audit_retention` metadata key (admin knob); falls back to the 12-month
 * default. Clamped to >= MIN_AUDIT_RETENTION_DAYS so a misconfiguration can
 * never wipe recent events.
 */
export async function getAuditRetentionDays(): Promise<number> {
  try {
    const { readConnectorConfigFromDatabase } = await import("@/lib/database");
    const cfg = readConnectorConfigFromDatabase<{ retentionDays?: number } | null>("audit_retention", null);
    const raw = cfg?.retentionDays;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return Math.max(MIN_AUDIT_RETENTION_DAYS, Math.floor(raw));
    }
  } catch {
    // Metadata store unavailable (e.g. unit env) → default.
  }
  return DEFAULT_AUDIT_RETENTION_DAYS;
}

/**
 * Admin knob — persist the retention window. Throws on a sub-minimum value
 * so the deletion path can never be configured to wipe recent history.
 */
export async function setAuditRetentionDays(days: number): Promise<void> {
  if (!Number.isFinite(days) || days < MIN_AUDIT_RETENTION_DAYS) {
    throw new Error(`Audit retention must be >= ${MIN_AUDIT_RETENTION_DAYS} days (got ${days}).`);
  }
  const { writeConnectorConfigToDatabase } = await import("@/lib/database");
  writeConnectorConfigToDatabase("audit_retention", { retentionDays: Math.floor(days) });
}

/**
 * Documented deletion path — delete audit events older than the retention
 * window. Returns the cutoff used + the deleted-row count. Idempotent and
 * safe to run repeatedly (the scheduled job calls it daily).
 *
 * `opts.retentionDays` overrides the configured window (used by the CLI for
 * a one-off purge); `opts.dryRun` reports the cutoff without deleting.
 */
export async function enforceAuditRetention(
  opts: { retentionDays?: number; dryRun?: boolean } = {},
): Promise<{ cutoffIso: string; retentionDays: number; deleted: number }> {
  const retentionDays = opts.retentionDays ?? (await getAuditRetentionDays());
  const clamped = Math.max(MIN_AUDIT_RETENTION_DAYS, Math.floor(retentionDays));
  const cutoff = new Date(Date.now() - clamped * 24 * 60 * 60 * 1000);
  if (opts.dryRun) {
    return { cutoffIso: cutoff.toISOString(), retentionDays: clamped, deleted: 0 };
  }
  const rows = await getAuditDb()
    .delete(auditEvents)
    .where(lt(auditEvents.createdAt, cutoff))
    .returning({ id: auditEvents.id });
  return { cutoffIso: cutoff.toISOString(), retentionDays: clamped, deleted: rows.length };
}
