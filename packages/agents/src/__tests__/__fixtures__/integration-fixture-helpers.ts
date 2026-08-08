/**
 * Shared helpers for the DB-backed integration suites (cinatra#2485 C review).
 *
 * Both helpers exist because these suites share ONE database: the Better Auth
 * fixture rows live unqualified in `public` (outside each suite's private
 * TEST_SCHEMA), and `agent_templates.package_name` is globally UNIQUE. Anything
 * shared across suites needs teardown that cannot silently no-op and setup that
 * cannot lose a create race.
 */

/**
 * Run every cleanup, then throw if any of them failed.
 *
 * The anti-pattern this replaces is `await del(...).catch(() => {})`: a
 * swallowed teardown failure leaves shared fixture rows behind, and the next run
 * inherits them — so a broken-isolation suite reports green. Simply removing the
 * `.catch` is not enough either, because the FIRST throw would skip the
 * remaining deletes and leak even more. So: attempt all, collect, then fail.
 */
export async function runAllCleanups(
  cleanups: Array<() => Promise<unknown> | undefined>,
): Promise<void> {
  const failures: string[] = [];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `fixture teardown failed (${failures.length}); shared rows may leak into the ` +
        `next run: ${failures.join(" | ")}`,
    );
  }
}

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = "23505";

export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === UNIQUE_VIOLATION;
}

/**
 * Resolve a row that is keyed by a GLOBALLY UNIQUE column, tolerating a
 * concurrent creator.
 *
 * A bare read-then-create is a race: two suites resolving the same
 * `agent_templates.package_name` can both miss the read, and the loser's INSERT
 * dies on the unique constraint during fixture setup. The constraint is the
 * arbiter — on a unique violation, re-read and adopt whatever the winner wrote.
 */
export async function getOrCreateByUniqueKey<T>(opts: {
  read: () => Promise<T | null | undefined>;
  create: () => Promise<unknown>;
}): Promise<T> {
  const existing = await opts.read();
  if (existing) return existing;
  try {
    await opts.create();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Lost the race — the winner's row is the shared fixture.
  }
  const row = await opts.read();
  if (!row) {
    throw new Error(
      "fixture: the row is still absent after create — neither this suite nor a " +
        "concurrent one produced it",
    );
  }
  return row;
}
