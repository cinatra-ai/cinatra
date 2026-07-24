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
    text.includes("pg_advisory_xact_lock") ||
    text.includes('COALESCE("archiveEpoch"') ||
    text.includes('"org_archive_lease"')
  );
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
  if (text.includes("pg_advisory_xact_lock")) {
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
