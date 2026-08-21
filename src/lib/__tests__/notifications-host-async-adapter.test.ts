/**
 * cinatra#2882 — the production host wires the ASYNC runner, and wires it to
 * the right thing.
 *
 * The seam's own proofs (`notification-delete-async-seam.integration.test.ts`)
 * register their own adapters, so they establish that the seam works but not
 * that anything in production reaches it. This closes that gap at the one place
 * it can be closed cheaply: `src/lib/notifications-host.ts` is the ONLY
 * production registrant of `NotificationsHostAdapters`, and the seam throws
 * rather than falling back if `runPostgresQueriesAsync` is missing — so a
 * half-wired host would turn every migrated clear into a swallowed warning.
 *
 * The first cut of this file asserted only that the adapter was a function and
 * a DIFFERENT function from the sync bridge. That is satisfied by any function
 * at all — `async () => []`, or a second reference to the sync bridge behind a
 * wrapper. So the arms below read the adapter's observable BEHAVIOUR instead:
 * what it delegates to, that its input reaches that delegate untouched and its
 * answer comes back, that it is genuinely asynchronous (the event loop runs
 * before it settles), that a rejection propagates rather than being softened
 * into a sync-bridge retry, and that the delegate is imported LAZILY — which is
 * the property that keeps `pg` off this boot-reachable module's graph.
 *
 * Unit-tier: `@/lib/postgres-async` is mocked and no query is ever issued.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getNotificationsHostAdapters } from "@cinatra-ai/notifications/host-adapters";

// Did anything actually EVALUATE `@/lib/postgres-async` yet? The adapter
// imports it from inside the function body precisely so that boot does not, and
// a `vi.mock` factory runs on first import — which makes it the observer.
let postgresAsyncEvaluated = false;
const runPostgresQueriesAsyncMock = vi.fn();

vi.mock("@/lib/postgres-async", () => {
  postgresAsyncEvaluated = true;
  return {
    runPostgresQueriesAsync: (...args: unknown[]) =>
      runPostgresQueriesAsyncMock(...args),
  };
});

// Side-effect import — this is what `setNotificationsHostAdapters` runs from.
import "@/lib/notifications-host";

const QUERY_INPUT = {
  connectionString: "postgres://stub-async-seam/db",
  queries: [
    { text: "DELETE FROM notifications WHERE id = $1", values: ["a"] },
  ],
};

beforeEach(() => {
  runPostgresQueriesAsyncMock.mockReset();
  runPostgresQueriesAsyncMock.mockResolvedValue([{ rows: [], rowCount: 0 }]);
});

describe("notifications host adapters", () => {
  it("supplies an async query runner for the cinatra#2882 seam", () => {
    const adapters = getNotificationsHostAdapters();
    expect(typeof adapters.runPostgresQueriesAsync).toBe("function");
  });

  it("keeps the synchronous bridge wired for the package's sync twins", () => {
    const adapters = getNotificationsHostAdapters();
    expect(typeof adapters.runPostgresQueriesSync).toBe("function");
    // Two distinct seams, not one aliased onto the other — a fallback that
    // pointed the async name at the sync bridge would silently restore the
    // `Atomics.wait` freeze this issue exists to remove.
    expect(adapters.runPostgresQueriesAsync).not.toBe(
      adapters.runPostgresQueriesSync,
    );
  });

  it("imports the runner LAZILY — nothing pulled `pg` in at module load", () => {
    // `src/lib/notifications-host.ts` is boot-reachable (background-jobs.ts),
    // and `@/lib/postgres-async` statically imports `pg` through
    // `@/lib/db/pooled`. The dynamic import inside the adapter body is what
    // keeps that off the boot graph — a top-level import would satisfy every
    // other arm in this file and quietly undo it. The side-effect import above
    // has already run by now, so this reading is meaningful.
    expect(postgresAsyncEvaluated).toBe(false);
  });

  it("delegates to @/lib/postgres-async, passing its input through untouched", async () => {
    const adapters = getNotificationsHostAdapters();
    const rows = [{ rows: [{ id: "n1" }], rowCount: 1 }];
    runPostgresQueriesAsyncMock.mockResolvedValue(rows);

    const result = await adapters.runPostgresQueriesAsync?.(QUERY_INPUT);

    // The delegate — this is the arm "it is a different function" could not
    // make. A wrapper around the sync bridge would never reach here.
    expect(runPostgresQueriesAsyncMock).toHaveBeenCalledTimes(1);
    expect(runPostgresQueriesAsyncMock).toHaveBeenCalledWith(QUERY_INPUT);
    // ...and the answer comes back, rather than being swallowed into a void.
    expect(result).toBe(rows);
    // The lazy import has now happened, which is what makes the arm above a
    // statement about ORDER and not about the mock never being reached.
    expect(postgresAsyncEvaluated).toBe(true);
  });

  it("is genuinely async — the event loop runs before it settles", async () => {
    // The DEFECT was a synchronous call that froze the loop for the whole round
    // trip. An adapter that resolves without ever yielding would be a
    // regression this file should catch, so the pin is that a timer due at 0ms
    // fires BEFORE the adapter's promise does.
    const adapters = getNotificationsHostAdapters();
    const order: string[] = [];
    runPostgresQueriesAsyncMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("query");
      return [];
    });

    setTimeout(() => order.push("timer"), 0);
    await adapters.runPostgresQueriesAsync?.(QUERY_INPUT);

    expect(order).toEqual(["timer", "query"]);
  });

  it("propagates a rejection instead of falling back to the sync bridge", async () => {
    // The seam's callers swallow their errors by design, so a fallback here
    // would be invisible: the freeze would be back under a name that promises
    // it is gone. The adapter must simply let the failure through.
    const adapters = getNotificationsHostAdapters();
    const failure = new Error("Query read timeout");
    runPostgresQueriesAsyncMock.mockRejectedValue(failure);

    await expect(
      adapters.runPostgresQueriesAsync?.(QUERY_INPUT),
    ).rejects.toBe(failure);
  });
});
