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

/** See `AuditEventInput.deniedCooldown` (cinatra#2266 AC1). */
export type DeniedCooldownPolicy = "record_every" | { discriminator: string };

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
  /**
   * OPT-IN override of the denied-event cooldown, for a producer that knows
   * the default key is wrong for it (cinatra#2266 AC1).
   *
   * The cooldown keys on `(actorPrincipalId, resourceType, operation)`, which
   * is the right granularity for a producer whose refusals differ in those
   * three fields. It is the WRONG granularity for one that pins all three to
   * constants: every execution-plane refusal a user received mapped to the
   * single key `<userId>:execution_sandbox:sandbox_execute`, so inside one 60 s
   * window the first was recorded and every later one — a different job, a
   * different command, a forged voucher, a replayed nonce — was silently
   * discarded before insert.
   *
   * THE CHOSEN MECHANISM, stated rather than implied: a per-producer opt-in
   * with two dispositions, so a producer declares what a repeat MEANS for it
   * instead of inheriting an answer that does not fit.
   *
   *   - `"record_every"` — this producer has no repeat semantics at all;
   *     suppress nothing. For a producer whose events are individually
   *     load-bearing (an authorization refusal is a decision, and discarding
   *     one makes an investigation read "no record" as "it did not happen")
   *     and which cannot always supply an identity: a voucher is rejected
   *     BEFORE its claims are trusted, so a forged one has no command id to
   *     key on.
   *   - `{ discriminator }` — the default key EXTENDED by a producer-supplied
   *     identity. For a producer that CAN say what makes two denials the same
   *     event, so a genuine retry is still absorbed.
   *
   * ABSENT (every pre-existing caller) the key and the behaviour are exactly
   * what they always were. The noise control that stops a retry loop from
   * flooding `audit_events` is deliberately NOT weakened globally: a key that
   * included `resourceId` for every producer would let a scan over 10 000 ids
   * write 10 000 rows a minute.
   *
   * This is a CONTROL field: it participates in the cooldown decision only and
   * is never persisted. The event's own identity already rides `resourceId` /
   * `metadata`.
   *
   * NOT a delivery de-dup key. It bounds noise; it does not make a write
   * idempotent. The durable spool's delivery identity (#2266 G2/AC2) is a
   * separate mechanism and is not in this slice.
   *
   * BOUNDED, AND SEPARATE. A discriminator that varies per command makes each
   * key effectively single-use, which nothing would ever expire lazily — so
   * opted-in keys live in their own hard-capped map
   * (`DENIED_COOLDOWN_MAX_SCOPED_KEYS`) rather than growing, or evicting from,
   * the map every other caller shares. Build a discriminator from bounded
   * identifiers, not from free text.
   */
  deniedCooldown?: DeniedCooldownPolicy;
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

/**
 * Cooldown keys for callers that did NOT opt into a discriminator — the
 * original map, with the original semantics. Its key space is the
 * `(actor, resourceType, operation)` triple, which is why it was never bounded
 * and is deliberately still not: nothing an opted-in producer does may change
 * how an opted-out caller behaves, and a shared bound would let one producer's
 * volume evict the other's live keys (Codex convergence, adopted).
 */
const _deniedCooldown = new Map<string, number>(); // key → expiresAt (ms)

/**
 * Cooldown keys for producers that DID opt in (cinatra#2266 AC1). Kept apart
 * from the map above and BOUNDED, because a discriminator that varies per
 * command makes every key effectively single-use: nothing looks one up a second
 * time, so nothing triggers the lazy expiry below and the map would grow for
 * the life of the process.
 */
const _deniedCooldownScoped = new Map<string, number>(); // key → expiresAt (ms)

/**
 * The cooldown key. `(actor, resourceType, operation)` by default — unchanged
 * for every caller that does not opt in — extended by the producer-supplied
 * discriminator when the policy carries one. See
 * `AuditEventInput.deniedCooldown` (cinatra#2266 AC1).
 *
 * The key SHAPE and the map choice are both derived from the same
 * discriminated union, deliberately (Codex convergence, adopted): deciding one
 * on the policy's type and the other on the discriminator's truthiness let an
 * EMPTY discriminator produce an unscoped-looking key inside the scoped map,
 * where it could both suppress and be evicted on a legacy caller's behalf.
 */
function deniedCooldownKey(input: AuditEventInput): string {
  const base = `${input.actorPrincipalId ?? ""}:${input.resourceType ?? ""}:${input.operation ?? ""}`;
  const policy = input.deniedCooldown;
  return typeof policy === "object" ? `${base}:${policy.discriminator}` : base;
}

function coolingDownIn(live: Map<string, number>, key: string): boolean {
  const expiresAt = live.get(key);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    live.delete(key);
    return false;
  }
  return true;
}

/**
 * The UNSCOPED cooldown map only — the exported signature takes a bare key,
 * which carries no evidence of which class it belongs to, so this answers for
 * the map it always answered for and its behaviour is unchanged.
 *
 * It must not fall back to the scoped map (Codex convergence, adopted). Both
 * keys are colon-joined strings over caller-supplied text, so a base triple
 * whose `operation` ends in `:x` serializes identically to a scoped key whose
 * discriminator is `x` — and a probe that consulted both would let one class
 * silently suppress the other, which is exactly the isolation the split
 * exists to provide. The write paths below resolve the map from the INPUT's
 * own policy instead, so the two classes never meet whatever their keys spell.
 */
export function isDeniedCoolingDown(key: string): boolean {
  return coolingDownIn(_deniedCooldown, key);
}

/** The cooling-down check the write paths use: map chosen by the input. */
function isDeniedCoolingDownFor(input: AuditEventInput, key: string): boolean {
  return coolingDownIn(isScoped(input) ? _deniedCooldownScoped : _deniedCooldown, key);
}

/**
 * Hard cap on live SCOPED cooldown keys (cinatra#2266 AC1). Applies to the
 * opted-in map only — the unscoped map above is left exactly as it was.
 *
 * Every entry carries the SAME ttl and a key is only ever inserted while
 * absent (the cooling-down branch returns before the write, and the expiry
 * branch deletes it), so Map insertion order IS expiry order — the front of
 * the map is always the closest to expiring. Sweeping the expired prefix
 * therefore costs only what it reclaims, and the eviction that follows, if the
 * sweep was not enough, drops the entries with the least cooldown left.
 *
 * Evicting early re-opens a key for one extra row before its 60 s elapsed —
 * the failure direction that writes an audit row it could have suppressed,
 * never the direction that discards one.
 */
export const DENIED_COOLDOWN_MAX_SCOPED_KEYS = 10_000;

/**
 * Register a cooldown key. `scoped` selects the map — and therefore whether
 * the bound applies. EVERY write to either map goes through here, so the
 * bound cannot be bypassed by a second entry point growing its own `.set`
 * (Codex convergence, adopted: `logDeniedAuditEventStrictWithCooldown` was
 * exactly such an entry point).
 */
function rememberDeniedCooldown(key: string, nowMs: number, scoped: boolean): void {
  const live = scoped ? _deniedCooldownScoped : _deniedCooldown;
  if (scoped && live.size >= DENIED_COOLDOWN_MAX_SCOPED_KEYS) {
    for (const [candidate, expiresAt] of live) {
      if (expiresAt > nowMs) break; // ordered by expiry — the rest are live
      live.delete(candidate);
    }
    while (live.size >= DENIED_COOLDOWN_MAX_SCOPED_KEYS) {
      const oldest = live.keys().next();
      if (oldest.done) break;
      live.delete(oldest.value);
    }
  }
  // Delete-then-set so a re-insert moves to the back and the ordering
  // invariant above holds unconditionally, not only on the paths that
  // currently reach here.
  live.delete(key);
  live.set(key, nowMs + DENIED_COOLDOWN_MS);
}

/** True when this input opted into the finer key — i.e. which map it uses. */
function isScoped(input: AuditEventInput): boolean {
  return typeof input.deniedCooldown === "object";
}

/** Test-only seam — drains both cooldown maps between vitest runs. */
export function _resetDeniedCooldownForTests(): void {
  _deniedCooldown.clear();
  _deniedCooldownScoped.clear();
}

/** Test-only seam — live key counts per map, for the bound's own test. */
export function _deniedCooldownSizesForTests(): { base: number; scoped: number } {
  return { base: _deniedCooldown.size, scoped: _deniedCooldownScoped.size };
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
//      (actorPrincipalId, resourceType, operation) key — unless the producer
//      opted out or supplied a finer key via `deniedCooldown`, which exists
//      for producers that pin those three to constants (cinatra#2266 AC1).
// ---------------------------------------------------------------------------

export async function logAuditEvent(input: AuditEventInput): Promise<void> {
  // Cooldown gate — denied events only, and only for producers that did not
  // declare themselves out of it.
  let deniedCooldownKey_: string | undefined;
  if (input.decision === "denied" && input.deniedCooldown !== "record_every") {
    const key = deniedCooldownKey(input);
    if (isDeniedCoolingDownFor(input, key)) return;
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
    rememberDeniedCooldown(deniedCooldownKey_, Date.now(), isScoped(input));
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
// logDeniedAuditEventStrictWithCooldown — durable DENY writes WITH the
// denied-event flood control (cinatra#952 W2, codex round-1 finding 1 of the
// W2 convergence).
//
// The two existing helpers each miss one property the per-connection use-gate
// needs for its DENY rows:
//   • logAuditEvent respects the cooldown but SWALLOWS insert failures — a
//     deny could proceed un-audited.
//   • logAuditEventStrict is durable but SKIPS the cooldown entirely — a
//     retry loop would flood audit_events.
//
// This helper lives HERE (not in the use-gate) because the cooldown map is
// module-private: check the cooldown first (cooling → skip the write, the
// caller still denies), else AWAIT the strict insert and register the
// cooldown key ONLY after the durable insert succeeded. An insert failure
// registers nothing (the next deny retries the durable write) and propagates
// — the caller treats a failed deny-audit write as a hard error and still
// denies.
// ---------------------------------------------------------------------------

export async function logDeniedAuditEventStrictWithCooldown(
  input: AuditEventInput,
): Promise<{ id: string } | { skipped: true }> {
  // `deniedCooldown` is honoured here for the same reason it exists on the
  // fail-silent path: a producer that declares its denials individually
  // load-bearing must not have them collapsed by whichever helper it reached.
  if (input.deniedCooldown === "record_every") {
    return logAuditEventStrict({ ...input, decision: "denied" });
  }
  const key = deniedCooldownKey({ ...input, decision: "denied" });
  if (isDeniedCoolingDownFor(input, key)) return { skipped: true };
  const result = await logAuditEventStrict({ ...input, decision: "denied" });
  // Through the shared helper, not a bare `.set`: this path accepts the same
  // AuditEventInput, so it can carry a discriminator, and a second writer that
  // grew its own insert would have escaped the scoped map's bound entirely
  // (Codex convergence, adopted).
  rememberDeniedCooldown(key, Date.now(), isScoped(input));
  return result;
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
