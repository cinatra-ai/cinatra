/**
 * Kernel-aware test fakes — cinatra#1939 (archive epic S3).
 *
 * S3 wires production writers through `guardOrgMutation`, which issues the
 * kernel's own queries (org advisory locks → locked org-state read → optional
 * lease check) inside the SAME transaction as the writer's payload. Every
 * writer's existing unit-test fake would otherwise have to learn those query
 * shapes — and would silently rot when the kernel's SQL evolves. This module
 * is the ONE place that knows how to recognize and answer them:
 *
 *   - `wrapTxWithOrgWriteKernel(tx, opts)` — wrap an existing per-suite fake
 *     transaction: kernel queries are intercepted and answered from `opts`,
 *     EVERYTHING else (the writer's own statements) delegates to the wrapped
 *     fake untouched. Content-matched, not order-matched, so writer queries
 *     interleave freely.
 *   - `fakeOrgWriteDb(opts)` — a standalone minimal `{ db, tx }` pair for
 *     tests that have no fake of their own.
 *
 * Ships from the kernel package (exports "./testing") because the kernel owns
 * its query shapes: if a kernel query changes, this module and its pin tests
 * change in the same commit, and every consumer suite keeps working.
 * TEST-ONLY: never import from production code.
 */

import { sql, type SQL } from "drizzle-orm";
import {
  acquireOrgLocks,
  orgLockQueries,
  type OrgWriteDb,
  type OrgWriteTx,
} from "./locks";
import { readOrgWriteState } from "./org-state";
import {
  snapshotLeasesQuery,
  invalidateLeasesBeforeEpochQuery,
} from "./leases";

export type FakeOrgWriteOrganizationState = {
  readonly archivedAt?: Date | string | null;
  readonly archiveEpoch?: number;
};

export interface KernelQueryAnswers {
  /** The organization row the kernel's locked state read returns; `null`
   *  means "no such organization" (the kernel refuses fail-closed). */
  readonly organization: FakeOrgWriteOrganizationState | null;
  /** Whether the lease-held probe finds an unexpired lease (lease-gated
   *  rulings only; irrelevant for plain allow/deny). Default false —
   *  fail-closed, like the kernel. */
  readonly leaseHeld?: boolean;
}

/** Normalize a query (drizzle `SQL` object or `{ text }` input) to a plain
 *  string for content matching. Drizzle SQL objects serialize their string
 *  chunks through JSON; unescaping quotes makes the needles readable. */
function queryTextOf(query: unknown): string {
  if (typeof query === "string") return query;
  if (query !== null && typeof query === "object") {
    const text = (query as { text?: unknown }).text;
    if (typeof text === "string") return text;
    try {
      return JSON.stringify(query)?.replaceAll('\\"', '"') ?? "";
    } catch {
      return "";
    }
  }
  return "";
}

/** True when the query is one the kernel itself issues inside
 *  `guardOrgMutation` (locks / state read / lease probe). The needles are
 *  deliberately kernel-distinctive (pinned by this module's tests) so a
 *  writer's own statements — even ones mentioning "organization" — are never
 *  intercepted. */
export function isKernelOrgWriteQuery(query: unknown): boolean {
  const text = queryTextOf(query);
  return (
    isKernelOrgLockQuery(text) ||
    text.includes('COALESCE("archiveEpoch"') ||
    text.includes('"org_archive_lease"')
  );
}

/** The kernel's org locks are the TWO-ARG advisory form
 *  `pg_advisory_xact_lock(hashtext(ns), hashtext(orgId))`. Writers' own
 *  per-row locks use the single-arg form (e.g. mutation-service's per-id
 *  twin lock) and must stay THEIR statements — never intercepted here. */
function isKernelOrgLockQuery(text: string): boolean {
  return text.includes("pg_advisory_xact_lock") && text.includes("), hashtext(");
}

/**
 * Answer one kernel query from the configured state, or return `undefined`
 * when the query is not the kernel's (the caller delegates it).
 */
export function answerKernelOrgWriteQuery(
  query: unknown,
  answers: KernelQueryAnswers,
): { rows: Record<string, unknown>[] } | undefined {
  const text = queryTextOf(query);
  if (isKernelOrgLockQuery(text)) {
    return { rows: [] };
  }
  if (text.includes('COALESCE("archiveEpoch"')) {
    if (answers.organization === null) return { rows: [] };
    return {
      rows: [
        {
          archivedAt: answers.organization.archivedAt ?? null,
          archiveEpoch: answers.organization.archiveEpoch ?? 0,
        },
      ],
    };
  }
  if (text.includes('"org_archive_lease"')) {
    return answers.leaseHeld === true ? { rows: [{ held: 1 }] } : { rows: [] };
  }
  return undefined;
}

type ExecuteLike = { execute(query: unknown): Promise<unknown> };

/**
 * Wrap an existing fake transaction so the kernel's queries are answered from
 * `answers` while every other statement delegates to the wrapped fake. The
 * returned object preserves the fake's full surface (drizzle builder members,
 * spies, …) — only `execute` is layered.
 */
export function wrapTxWithOrgWriteKernel<TTx extends object>(
  tx: TTx,
  answers: KernelQueryAnswers,
): TTx & ExecuteLike {
  const wrapped = Object.create(tx) as TTx & ExecuteLike;
  Object.defineProperty(wrapped, "execute", {
    enumerable: true,
    value: async (query: unknown): Promise<unknown> => {
      const answered = answerKernelOrgWriteQuery(query, answers);
      if (answered !== undefined) return answered;
      const inner = (tx as Partial<ExecuteLike>).execute;
      if (typeof inner !== "function") {
        throw new Error(
          "org-write-kernel/testing: the wrapped fake tx has no execute() for a non-kernel query",
        );
      }
      return inner.call(tx, query);
    },
  });
  return wrapped;
}

/**
 * Standalone minimal `{ db, tx, executed }` for suites without their own
 * fake: kernel queries answered from `answers`, every other executed query
 * recorded on `executed` (and answered `{ rows: [] }`).
 */
export function fakeOrgWriteDb(answers: KernelQueryAnswers): {
  db: { transaction<R>(fn: (tx: ExecuteLike) => Promise<R>): Promise<R> };
  tx: ExecuteLike;
  executed: unknown[];
} {
  const executed: unknown[] = [];
  const base: ExecuteLike = {
    execute: async (query: unknown) => {
      executed.push(query);
      return { rows: [] };
    },
  };
  const tx = wrapTxWithOrgWriteKernel(base, answers);
  return {
    db: {
      transaction: async <R>(fn: (t: ExecuteLike) => Promise<R>): Promise<R> => fn(tx),
    },
    tx,
    executed,
  };
}

// ---------------------------------------------------------------------------
// R-acc archive-transition harness (cinatra#1939 wave 3, S3) — INTEGRATION
// tier (two real connections, advisory-lock choreography, no timing sleeps).
//
// Built ONLY from kernel-exported shapes (locks.ts / org-state.ts / leases.ts)
// so it cannot drift from what the S6 archive transaction will do AT THE
// KERNEL LAYER: the archive epoch bumped and the lifecycle state flipped under
// BOTH org locks. It is the kernel-truthful ORACLE the R-acc races assert
// against — NOT the S6 archive transaction's business logic (session
// deactivation and the rest are S6's and are deliberately untested here). When
// S6 lands the real archive transaction, the integration races re-point at it
// with the same assertions; this stays the fast kernel-level tier. TEST-ONLY.
// ---------------------------------------------------------------------------

/** The minimal raw node-postgres `Client`/`PoolClient` surface the lock-hold
 *  choreography needs — a structural type so the kernel keeps its pure-leaf
 *  dependency set (no `pg` import). */
export interface RawPgClientLike {
  query(queryText: string, values?: unknown[]): Promise<unknown>;
}

/** Re-express a kernel `{ text, values }` fixed-batch query (positional
 *  `$n` placeholders, possibly out of order — e.g. `snapshotLeasesQuery`
 *  emits `$2::int` before `$1`) as a bound drizzle `SQL` so the VERBATIM
 *  kernel lease shapes run on the callback-world transaction. `$n` maps to
 *  `values[n-1]`; the static text between placeholders is spliced with
 *  `sql.raw` (the schema names it contains were already fenced by
 *  `assertSafeSchemaName` when the kernel built the query). */
function rawPgQueryToSql(query: { text: string; values: unknown[] }): SQL {
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

export interface SimulateArchiveTransitionOptions {
  readonly schema: string;
  readonly orgId: string;
  /** Target lifecycle state: `"archived"` snapshots leases at the new epoch;
   *  `"active"` (unarchive) invalidates every lease of a superseded epoch. */
  readonly to: "archived" | "active";
}

/**
 * Run one archive/unarchive transition the way S6 will at the kernel layer:
 * ONE transaction taking BOTH org locks in epoch→write order, a locked
 * lifecycle-state read, the archive-marker + epoch bump, then the epoch's
 * lease bookkeeping (`snapshotLeasesQuery` on archive, verbatim;
 * `invalidateLeasesBeforeEpochQuery` on unarchive). Returns the new archive
 * epoch. Throws if the organization row does not exist (fail-closed, like the
 * kernel's own state read).
 */
export async function simulateArchiveTransition<TTx extends OrgWriteTx>(
  db: OrgWriteDb<TTx>,
  options: SimulateArchiveTransitionOptions,
): Promise<{ archiveEpoch: number }> {
  const { schema, orgId, to } = options;
  return db.transaction(async (tx) => {
    await acquireOrgLocks(tx, { orgId, epoch: true });
    const state = await readOrgWriteState(tx, orgId);
    if (state === null) {
      throw new Error(
        `simulateArchiveTransition: no such organization ${JSON.stringify(orgId)}`,
      );
    }
    const newEpoch = state.archiveEpoch + 1;
    await tx.execute(
      to === "archived"
        ? sql`UPDATE public."organization" SET "archivedAt" = now(), "archiveEpoch" = COALESCE("archiveEpoch", 0) + 1 WHERE id = ${orgId}`
        : sql`UPDATE public."organization" SET "archivedAt" = NULL, "archiveEpoch" = COALESCE("archiveEpoch", 0) + 1 WHERE id = ${orgId}`,
    );
    await tx.execute(
      rawPgQueryToSql(
        to === "archived"
          ? snapshotLeasesQuery({ schema, orgId, archiveEpoch: newEpoch })
          : invalidateLeasesBeforeEpochQuery({ schema, orgId, newEpoch }),
      ),
    );
    return { archiveEpoch: newEpoch };
  });
}

export interface HoldOrgLocksOptions {
  readonly orgId: string;
  /** Also take the archive-epoch lock (epoch→write order); `false` holds only
   *  the write lock. */
  readonly epoch: boolean;
}

/**
 * Open a transaction on a raw pg client and hold the org advisory lock(s) until
 * `release()` commits — the deterministic interleaving primitive for the
 * two-connection races. A second connection issuing a guarded write (write
 * lock) or lifecycle mutation (epoch→write) provably BLOCKS on
 * `pg_advisory_xact_lock` until `release()` runs — no timing sleeps. The
 * caller owns the client's lifecycle (connect/end); `release()` only ends the
 * held transaction.
 */
export async function holdOrgLocks(
  client: RawPgClientLike,
  options: HoldOrgLocksOptions,
): Promise<{ release: () => Promise<void> }> {
  await client.query("BEGIN");
  for (const q of orgLockQueries({ orgId: options.orgId, epoch: options.epoch })) {
    await client.query(q.text, q.values);
  }
  return {
    release: async () => {
      await client.query("COMMIT");
    },
  };
}
