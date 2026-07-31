import "server-only";

import { sql, type SQL } from "drizzle-orm";

import {
  guardOrgLifecycleMutation,
  OrgWriteRefusedError,
  snapshotLeasesQuery,
  invalidateLeasesBeforeEpochQuery,
  type OrgWriteDb,
  type OrgWriteTx,
} from "@cinatra-ai/org-write-kernel";

import { betterAuthDb } from "@/lib/better-auth-db";
import { resolveOrganizationLifecycleEligibility } from "@/lib/organization-lifecycle";
import { resolveOrgRoleForUser } from "@/lib/auth-session";
import { sessionAuthorityFromResolvedRole } from "@/lib/org-write/authority";

/**
 * Organization archive/unarchive — the REAL transaction (cinatra#1942 V5,
 * archive program S6), replacing the #1937 S1 refusing stub.
 *
 * This module still owns the default-OFF activation gate. The archive entry
 * point consults it FIRST (the stub's invariant, preserved exactly): while the
 * gate is off, production behavior is byte-identical to the stub — nothing can
 * be archived, so every read-side visibility surface (which keys on the org's
 * `archivedAt`, never on this gate) stays inert.
 *
 * Gate storage: its own connector_config row (`org_archive_activation`), read
 * FAIL-CLOSED — any read error means OFF. This deliberately inverts the
 * fail-open instance-mode toggles (see isRegistrationClosed's rationale):
 * a lifecycle feature behind a dark launch must never activate because a
 * config read failed. Only a stored literal `true` enables it, and the
 * activation closeout (V6, owner-gated) is the only place that will ever
 * write it in production; a staging/test environment may use
 * `scripts/ops/flip-org-archive-activation-staging.mjs`.
 *
 * The transaction itself (Decision 2, v-1942 design) structurally mirrors the
 * post-#2133 guarded delete and consumes the SAME kernel entry —
 * `guardOrgLifecycleMutation` (BOTH advisory locks, epoch→write order): the
 * exclusive org fence under which no guarded write, ticket redemption, or
 * competing lifecycle transition can interleave. The archive tx is that
 * entry point's second consumer (delete is the first), exactly as the
 * wave-3 #1939 design planned.
 *
 * ASYMMETRIC GATE (Decision 2): `unarchiveOrganization` deliberately does NOT
 * check the activation gate — an archived state must always be reversible,
 * especially during a gate-off rollback window; gating unarchive would make an
 * org archived-in-a-window unrecoverable after `--off`. Unarchive is likewise
 * deliberately LENIENT on the shared lifecycle-eligibility pre-fence:
 * recovery must always be possible, so it does not hard-refuse on
 * single-org-mode (an instance that toggled to single-org while an org sat
 * archived must still be able to unarchive it); the org-exists/not-default
 * checks are moot for an archived org (it exists, and the default org can
 * never be archived). Authorization is NOT relaxed: owner-only, re-verified
 * in-tx, under the same kernel guard.
 *
 * PARKED RUNS — TOTAL FREEZE (owner-ruled): the archive
 * transaction writes NO run rows. Parked/non-terminal runs stay exactly as
 * they are under archive; the documented drain path is unarchive → settle →
 * re-archive. Live runs get an `org_archive_lease` window instead (the kernel
 * `snapshotLeasesQuery` shape, executed verbatim in-fence, keyed to the NEW
 * epoch — Decision 2b), so an in-flight attempt can land its outputs while
 * everything else is frozen.
 *
 * BOUNDED LOCK WAIT (owner-ruled): Postgres advisory locks
 * have no fairness guarantee, so an unbounded `pg_advisory_xact_lock` wait
 * could starve under contention. Both transitions therefore run with an
 * explicit `lock_timeout` (SET LOCAL, applied before the kernel takes its
 * locks) and a bounded retry with backoff; exhaustion surfaces as a typed
 * `error` result, never an unbounded spin.
 */

// cinatra#1940 P3 (Decision 7, design review) — compile-time structural
// coupling, not merely an S6 checklist item: this module is the ONE gate
// every activation consumer already flows through (the S1 stub consulted it
// first; the real archive transaction below does too). Statically importing
// the dispatch-freeze module HERE means no build can evaluate the activation
// gate without also containing the dispatch freeze. A module-graph test
// pins this import edge so a future refactor that drops it fails CI here —
// independent of the S6 activation runbook. `dispatch-freeze.ts` is a leaf
// (zero further dependencies), so this adds no real module weight.
import { DISPATCH_FREEZE_S3 } from "@/lib/org-write/dispatch-freeze";

export const ORG_ARCHIVE_ACTIVATION_CONFIG_KEY = "org_archive_activation";

export async function isArchiveActivationEnabled(): Promise<boolean> {
  // Keep the sentinel a real (non-elidable) value use — see the import
  // comment above — so a bundler can never tree-shake the coupling away.
  void DISPATCH_FREEZE_S3;
  try {
    const { readConnectorConfigFromDatabase } = await import("@/lib/database");
    const cfg = readConnectorConfigFromDatabase<{ enabled?: boolean } | null>(
      ORG_ARCHIVE_ACTIVATION_CONFIG_KEY,
      null,
    );
    return cfg?.enabled === true;
  } catch {
    return false;
  }
}

export type OrganizationArchiveResult =
  | { readonly ok: true; readonly idempotent?: true }
  | {
      readonly ok: false;
      readonly reason:
        | "activation-gate-off"
        | "single-org-mode"
        | "default-org"
        | "not-found"
        | "denied"
        | "error";
      readonly error?: string;
    };

type SqlExecutor = Pick<typeof betterAuthDb, "execute">;

function appSchema(): string {
  return (process.env.SUPABASE_SCHEMA?.trim() || "cinatra").replaceAll(
    '"',
    '""',
  );
}

// ---------------------------------------------------------------------------
// Bounded lock wait (owner-ruled)
// ---------------------------------------------------------------------------

/** Defaults for the bounded advisory-lock wait. Overridable per call ONLY for
 *  tests (deterministic, fast retry cells); production callers pass nothing. */
export interface ArchiveLockRetryOptions {
  readonly lockTimeoutMs?: number;
  readonly maxAttempts?: number;
  readonly backoffBaseMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_LOCK_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_BASE_MS = 150;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));

/** `lock_timeout` expiry surfaces as SQLSTATE 55P03 (lock_not_available).
 *  Drizzle may wrap the driver error, so walk the cause chain. */
function isLockTimeoutError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    if (
      typeof current === "object" &&
      (current as { code?: unknown }).code === "55P03"
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Wrap the db handle so the transaction sets `SET LOCAL lock_timeout` as its
 * FIRST statement — before `guardOrgLifecycleMutation` acquires the advisory
 * locks inside the same transaction. SET LOCAL scopes to this transaction
 * only (resets on commit/rollback), so nothing leaks to the pool. The value
 * is a validated integer spliced via sql.raw (SET cannot take bind params).
 */
function withLockTimeout<TTx extends OrgWriteTx>(
  db: OrgWriteDb<TTx>,
  lockTimeoutMs: number,
): OrgWriteDb<TTx> {
  const ms = Math.floor(lockTimeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`organization-archive: invalid lock_timeout ${String(lockTimeoutMs)}`);
  }
  return {
    transaction: <R>(fn: (tx: TTx) => Promise<R>): Promise<R> =>
      db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${ms}ms'`));
        return fn(tx);
      }),
  };
}

/** Bounded retry with exponential backoff, ONLY for advisory-lock timeouts
 *  (55P03). Every other error propagates on the first attempt. Each attempt
 *  is a fresh transaction, so a retry never observes partial state. */
async function runWithBoundedLockRetry<R>(
  attempt: () => Promise<R>,
  opts: ArchiveLockRetryOptions,
): Promise<R> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const sleep = opts.sleep ?? defaultSleep;
  let lastErr: unknown;
  for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo += 1) {
    try {
      return await attempt();
    } catch (err) {
      if (!isLockTimeoutError(err)) throw err;
      lastErr = err;
      if (attemptNo < maxAttempts) {
        await sleep(backoffBaseMs * 2 ** (attemptNo - 1));
      }
    }
  }
  throw new ArchiveLockContentionError(maxAttempts, lastErr);
}

/** Thrown when every bounded attempt hit the lock timeout — mapped to a typed
 *  `error` result (the bounded-contention criterion: a ceiling, not a spin). */
class ArchiveLockContentionError extends Error {
  constructor(attempts: number, cause: unknown) {
    super(
      `organization lifecycle transition could not acquire the org locks within ` +
        `${String(attempts)} bounded attempts (advisory-lock contention)`,
      { cause },
    );
  }
}

// ---------------------------------------------------------------------------
// Kernel lease-shape adapter
// ---------------------------------------------------------------------------

/**
 * Re-express a kernel `{ text, values }` fixed-batch query (positional `$n`
 * placeholders, possibly out of order — `snapshotLeasesQuery` emits `$2::int`
 * before `$1`) as a bound drizzle `SQL` so the VERBATIM kernel lease shapes
 * run on this callback-world transaction. `$n` maps to `values[n-1]`; the
 * static text between placeholders is spliced with `sql.raw` (the schema name
 * it contains was already fenced by the kernel's `assertSafeSchemaName`).
 * Twin of the kernel testing harness's private `rawPgQueryToSql`
 * (packages/org-write-kernel/src/testing.ts) — kept in lockstep so the
 * production tx and `simulateArchiveTransition` execute identical SQL.
 */
function kernelQueryToSql(query: { text: string; values: unknown[] }): SQL {
  let out: SQL = sql.raw("");
  let last = 0;
  for (const match of query.text.matchAll(/\$(\d+)/g)) {
    const at = match.index ?? 0;
    const value = query.values[Number(match[1]) - 1];
    out = sql`${out}${sql.raw(query.text.slice(last, at))}${value}`;
    last = at + match[0].length;
  }
  return sql`${out}${sql.raw(query.text.slice(last))}`;
}

// ---------------------------------------------------------------------------
// Shared in-tx helpers
// ---------------------------------------------------------------------------

class ArchiveNotFoundError extends Error {}
class ArchiveDefaultOrgError extends Error {}
class ArchiveDeniedError extends Error {}
class ArchiveIdempotentError extends Error {}

/** FOR UPDATE row pin AFTER the advisory locks (the kernel's locked FOR SHARE
 *  state read already ran): pins the row and reads slug + archive marker +
 *  epoch for the in-tx re-checks. */
async function pinOrgRowForUpdate(
  tx: SqlExecutor,
  organizationId: string,
): Promise<{ slug: string | null; archivedAt: unknown; archiveEpoch: number }> {
  const locked = await tx.execute<{
    id: string;
    slug: string | null;
    archivedAt: unknown;
    archiveEpoch: number | string;
  }>(sql`
    SELECT id, slug, "archivedAt", COALESCE("archiveEpoch", 0)::int AS "archiveEpoch"
    FROM public."organization"
    WHERE id = ${organizationId}
    FOR UPDATE
  `);
  const org = locked.rows[0];
  if (!org) throw new ArchiveNotFoundError();
  return {
    slug: org.slug,
    archivedAt: org.archivedAt ?? null,
    archiveEpoch: Number(org.archiveEpoch ?? 0),
  };
}

/** In-tx authz re-verify (runs BEFORE any idempotent return, so
 *  success is never leaked to a non-owner): the actor must STILL be an owner.
 *  A demotion/removal racing the pre-fence role read rolls the whole tx back. */
async function assertActorStillOwner(
  tx: SqlExecutor,
  organizationId: string,
  actorUserId: string,
): Promise<void> {
  const ownerRow = await tx.execute(sql`
    SELECT 1 AS is_owner FROM public."member"
    WHERE "organizationId" = ${organizationId}
      AND "userId" = ${actorUserId}
      AND role = 'owner'
    LIMIT 1
  `);
  if (ownerRow.rows.length === 0) throw new ArchiveDeniedError();
}

function mapTransitionError(err: unknown): OrganizationArchiveResult {
  if (err instanceof ArchiveIdempotentError) {
    return { ok: true, idempotent: true };
  }
  if (err instanceof ArchiveNotFoundError) {
    return { ok: false, reason: "not-found" };
  }
  if (err instanceof ArchiveDefaultOrgError) {
    return { ok: false, reason: "default-org" };
  }
  if (err instanceof ArchiveDeniedError) {
    return { ok: false, reason: "denied" };
  }
  if (err instanceof OrgWriteRefusedError) {
    // org.lifecycle is "allow" in BOTH lifecycle states, so a capability
    // refusal here can only be an authority failure — map to denied.
    // organization-not-found is the race backstop for a concurrent delete.
    if (err.reason === "organization-not-found") {
      return { ok: false, reason: "not-found" };
    }
    return { ok: false, reason: "denied" };
  }
  const message =
    err instanceof Error && err.message ? err.message : "lifecycle transition failed";
  return { ok: false, reason: "error", error: message };
}

// ---------------------------------------------------------------------------
// ARCHIVE — checks the activation gate FIRST (the stub's invariant)
// ---------------------------------------------------------------------------

/**
 * Archive the organization: set `archivedAt`, bump `archiveEpoch`, mint the
 * lease snapshot for live runs, and atomically deactivate every session
 * pointing at the org (directly, or at one of its teams) — all inside the
 * kernel's exclusive org fence. Refuses `activation-gate-off` while the
 * `org_archive_activation` gate is off — the FIRST check, before anything
 * else runs, so merging this module pre-flip leaves production byte-identical.
 *
 * Owner-only: the pre-fence role resolve + authority mint (org.lifecycle →
 * organization.archive) refuse a non-owner at the kernel, and the in-tx
 * owner re-verify (BEFORE the idempotent check) refuses a raced demotion.
 * Re-archiving an already-archived org is an idempotent no-op `{ok:true,
 * idempotent:true}` — owner-verified first, never leaked.
 */
export async function archiveOrganization(
  organizationId: string,
  actorUserId: string,
  retryOptions: ArchiveLockRetryOptions = {},
): Promise<OrganizationArchiveResult> {
  if (!(await isArchiveActivationEnabled())) {
    return { ok: false, reason: "activation-gate-off" };
  }
  const schema = appSchema();
  try {
    // Structural pre-tx fence via the shared lifecycle primitive (#1937):
    // single-org mode, default org, missing row — fail-closed.
    const eligibility =
      await resolveOrganizationLifecycleEligibility(organizationId);
    if (!eligibility.eligible) {
      switch (eligibility.reason) {
        case "single-org-mode":
          return { ok: false, reason: "single-org-mode" };
        case "default-org":
          return { ok: false, reason: "default-org" };
        case "not-found":
          return { ok: false, reason: "not-found" };
        case "mode-unavailable":
        case "lookup-failed":
          return {
            ok: false,
            reason: "error",
            error: `lifecycle eligibility unavailable (${eligibility.reason}); refusing fail-closed`,
          };
      }
    }

    const role = await resolveOrgRoleForUser(organizationId, actorUserId);
    if (role === undefined) {
      return { ok: false, reason: "denied" };
    }
    // org.lifecycle maps to organization.archive in the session authority —
    // a non-owner mints an authority whose can() is false and the kernel
    // refuses (authority-lacks-capability → denied).
    const authority = sessionAuthorityFromResolvedRole(organizationId, role);

    const db = withLockTimeout(
      betterAuthDb as unknown as OrgWriteDb<OrgWriteTx>,
      retryOptions.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    );
    await runWithBoundedLockRetry(
      () =>
        guardOrgLifecycleMutation(
          db,
          { orgId: organizationId, capability: "org.lifecycle", authority },
          async (rawTx) => {
            const tx = rawTx as unknown as SqlExecutor;
            const pinned = await pinOrgRowForUpdate(tx, organizationId);
            if (pinned.slug === "default") throw new ArchiveDefaultOrgError();
            // Owner re-verify BEFORE the idempotent check (never leak success to a non-owner).
            await assertActorStillOwner(tx, organizationId, actorUserId);
            if (pinned.archivedAt !== null) throw new ArchiveIdempotentError();

            const newEpoch = pinned.archiveEpoch + 1;
            await tx.execute(sql`
              UPDATE public."organization"
              SET "archivedAt" = now(), "archiveEpoch" = ${newEpoch}
              WHERE id = ${organizationId}
            `);
            // Decision 2b: the lease snapshot runs INSIDE the fence, keyed to
            // the NEW epoch, so every run passing the kernel's live-attempt
            // predicate at this instant gets a window and none can escape
            // (the exclusive fence blocks any interleaving run write).
            await tx.execute(
              kernelQueryToSql(
                snapshotLeasesQuery({ schema, orgId: organizationId, archiveEpoch: newEpoch }),
              ),
            );
            // Decision 2a: atomic session deactivation — org sessions AND
            // team-by-ownership sessions. Clearing to NULL is the narrow
            // cleanup class the #1937 session-activation guard permits by
            // construction (its trigger only fires on non-null values), so
            // this cannot trip the auth floor.
            await tx.execute(sql`
              UPDATE public."session" SET "activeOrganizationId" = NULL
              WHERE "activeOrganizationId" = ${organizationId}
            `);
            await tx.execute(sql`
              UPDATE public."session" SET "activeTeamId" = NULL
              WHERE "activeTeamId" IN (
                SELECT id FROM public."team" WHERE "organizationId" = ${organizationId}
              )
            `);
            // Owner-ruled: NO run writes — parked runs
            // stay frozen; the drain path is unarchive → settle → re-archive.
          },
        ),
      retryOptions,
    );
    return { ok: true };
  } catch (err) {
    return mapTransitionError(err);
  }
}

// ---------------------------------------------------------------------------
// UNARCHIVE — deliberately NOT gated on the activation flag (Decision 2)
// ---------------------------------------------------------------------------

/**
 * Unarchive the organization: clear `archivedAt`, bump `archiveEpoch`, and
 * invalidate every lease of a superseded epoch (the kernel
 * `invalidateLeasesBeforeEpochQuery` shape, verbatim) — inside the same
 * exclusive fence. Sessions are NOT touched (users re-select normally).
 *
 * NO activation-gate check and NO single-org-mode refusal — recovery from an
 * archived state must always be possible (the gate-off rollback path depends
 * on it). Authorization is NOT relaxed: owner-only via the same authority
 * mint and in-tx owner re-verify. Unarchiving an already-active org is an
 * idempotent no-op.
 */
export async function unarchiveOrganization(
  organizationId: string,
  actorUserId: string,
  retryOptions: ArchiveLockRetryOptions = {},
): Promise<OrganizationArchiveResult> {
  const schema = appSchema();
  try {
    const role = await resolveOrgRoleForUser(organizationId, actorUserId);
    if (role === undefined) {
      return { ok: false, reason: "denied" };
    }
    const authority = sessionAuthorityFromResolvedRole(organizationId, role);

    const db = withLockTimeout(
      betterAuthDb as unknown as OrgWriteDb<OrgWriteTx>,
      retryOptions.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    );
    await runWithBoundedLockRetry(
      () =>
        guardOrgLifecycleMutation(
          db,
          { orgId: organizationId, capability: "org.lifecycle", authority },
          async (rawTx) => {
            const tx = rawTx as unknown as SqlExecutor;
            const pinned = await pinOrgRowForUpdate(tx, organizationId);
            // Owner re-verify BEFORE the idempotent check (never leak success to a non-owner).
            await assertActorStillOwner(tx, organizationId, actorUserId);
            if (pinned.archivedAt === null) throw new ArchiveIdempotentError();

            const newEpoch = pinned.archiveEpoch + 1;
            await tx.execute(sql`
              UPDATE public."organization"
              SET "archivedAt" = NULL, "archiveEpoch" = ${newEpoch}
              WHERE id = ${organizationId}
            `);
            // Every lease of a superseded epoch dies with the epoch.
            await tx.execute(
              kernelQueryToSql(
                invalidateLeasesBeforeEpochQuery({ schema, orgId: organizationId, newEpoch }),
              ),
            );
            // Sessions deliberately untouched — users re-select normally.
          },
        ),
      retryOptions,
    );
    return { ok: true };
  } catch (err) {
    return mapTransitionError(err);
  }
}
