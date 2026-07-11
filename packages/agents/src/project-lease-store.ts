import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "./db";
import { projectLeases } from "./schema";

// ---------------------------------------------------------------------------
// project-lease-store (cinatra#1032 deliverable 2)
// ---------------------------------------------------------------------------
// Pure DB layer for the `project_leases` table — the project-level lease that
// serializes ticks per PM project scope. Every mutation is a SINGLE atomic
// statement (no read-modify-write), so two concurrent ticks can never both
// believe they hold the lease:
//   - acquireProjectLease: conditional upsert that only wins when the row is
//     absent, expired, or already held by the SAME holder (a refresh). Every
//     win bumps `version` — the FENCING token the dispatch ledger's
//     lease-fenced claim checks (see project-dispatch-ledger-store.ts).
//   - heartbeatProjectLease: extends expiry ONLY while the caller is still the
//     live holder at the SAME fencing version.
//   - releaseProjectLease: expires the lease in place (holder+version fenced);
//     the row is kept — the next acquire recovers it via the expiry branch.
// Server-only: never imported by client bundles.
// ---------------------------------------------------------------------------

export type ProjectLeaseRecord = {
  orgId: string;
  projectRef: string;
  holderId: string;
  acquiredAt: Date;
  heartbeatAt: Date;
  expiresAt: Date;
  /** Fencing token — bumped on every (re)acquisition. */
  version: number;
};

function deserialize(row: typeof projectLeases.$inferSelect): ProjectLeaseRecord {
  return {
    orgId:       row.orgId,
    projectRef:  row.projectRef,
    holderId:    row.holderId,
    acquiredAt:  row.acquiredAt,
    heartbeatAt: row.heartbeatAt,
    expiresAt:   row.expiresAt,
    version:     row.version,
  };
}

/** Validate a caller-supplied TTL: finite, positive milliseconds. Bound as a
 *  SQL parameter (seconds into make_interval) — never interpolated. */
function ttlSeconds(ttlMs: number): number {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error(`project lease ttlMs must be a finite positive number, got ${ttlMs}`);
  }
  return ttlMs / 1000;
}

export async function readProjectLease(
  orgId: string,
  projectRef: string,
): Promise<ProjectLeaseRecord | null> {
  const [row] = await db
    .select()
    .from(projectLeases)
    .where(and(eq(projectLeases.orgId, orgId), eq(projectLeases.projectRef, projectRef)));
  return row ? deserialize(row) : null;
}

/**
 * Atomically acquire (or refresh) the project lease. Returns the acquired
 * lease — including the NEW fencing `version` the caller must present on
 * heartbeat/release and on every ledger claim — or `null` when another holder
 * currently holds the lease live (not expired). Stale-lease recovery is the
 * `expires_at <= now()` branch of the conditional upsert: a crashed holder's
 * lease is stealable the moment it expires, and the steal bumps the fencing
 * version so the crashed holder's late writes are rejected.
 */
export async function acquireProjectLease(input: {
  orgId: string;
  projectRef: string;
  holderId: string;
  ttlMs: number;
}): Promise<ProjectLeaseRecord | null> {
  const secs = ttlSeconds(input.ttlMs);
  const res = await db.execute(sql`
    INSERT INTO ${projectLeases}
      (org_id, project_ref, holder_id, acquired_at, heartbeat_at, expires_at, version)
    VALUES
      (${input.orgId}, ${input.projectRef}, ${input.holderId}, now(), now(),
       now() + make_interval(secs => ${secs}), 1)
    ON CONFLICT (org_id, project_ref) DO UPDATE SET
      holder_id    = excluded.holder_id,
      acquired_at  = now(),
      heartbeat_at = now(),
      expires_at   = now() + make_interval(secs => ${secs}),
      version      = ${projectLeases}.version + 1
    WHERE ${projectLeases}.expires_at <= now()
       OR ${projectLeases}.holder_id = excluded.holder_id
    RETURNING org_id, project_ref, holder_id, acquired_at, heartbeat_at, expires_at, version
  `);
  const row = (res.rows as Array<Record<string, unknown>>)[0];
  if (!row) return null;
  return {
    orgId:       row.org_id as string,
    projectRef:  row.project_ref as string,
    holderId:    row.holder_id as string,
    acquiredAt:  new Date(row.acquired_at as string | Date),
    heartbeatAt: new Date(row.heartbeat_at as string | Date),
    expiresAt:   new Date(row.expires_at as string | Date),
    version:     Number(row.version),
  };
}

/**
 * Extend the lease while still its live holder at the presented fencing
 * version. Returns true iff the heartbeat landed; false means the lease was
 * lost (expired and possibly stolen — the caller must stop dispatching and
 * re-acquire, receiving a NEW fencing version).
 */
export async function heartbeatProjectLease(input: {
  orgId: string;
  projectRef: string;
  holderId: string;
  version: number;
  ttlMs: number;
}): Promise<boolean> {
  const secs = ttlSeconds(input.ttlMs);
  const res = await db.execute(sql`
    UPDATE ${projectLeases} SET
      heartbeat_at = now(),
      expires_at   = now() + make_interval(secs => ${secs})
    WHERE org_id = ${input.orgId}
      AND project_ref = ${input.projectRef}
      AND holder_id = ${input.holderId}
      AND version = ${input.version}
      AND expires_at > now()
    RETURNING version
  `);
  return (res.rows as unknown[]).length > 0;
}

/**
 * Release the lease in place: expire it now (fenced by holder + version). The
 * row is kept — the next acquire recovers it via the expiry branch. Returns
 * true iff this call released a live lease held by the caller.
 */
export async function releaseProjectLease(input: {
  orgId: string;
  projectRef: string;
  holderId: string;
  version: number;
}): Promise<boolean> {
  const res = await db.execute(sql`
    UPDATE ${projectLeases} SET
      heartbeat_at = now(),
      expires_at   = now()
    WHERE org_id = ${input.orgId}
      AND project_ref = ${input.projectRef}
      AND holder_id = ${input.holderId}
      AND version = ${input.version}
      AND expires_at > now()
    RETURNING version
  `);
  return (res.rows as unknown[]).length > 0;
}
