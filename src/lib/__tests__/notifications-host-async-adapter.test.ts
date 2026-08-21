/**
 * cinatra#2882 — the production host wires the ASYNC runner.
 *
 * The seam's own proofs (`notification-delete-async-seam.integration.test.ts`)
 * register their own adapters, so they establish that the seam works but not
 * that anything in production reaches it. This closes that gap at the one place
 * it can be closed cheaply: `src/lib/notifications-host.ts` is the ONLY
 * production registrant of `NotificationsHostAdapters`, and the seam throws
 * rather than falling back if `runPostgresQueriesAsync` is missing — so a
 * half-wired host would turn every migrated clear into a swallowed warning.
 *
 * Unit-tier: `@/lib/database` is the root config's inert stub and no query is
 * ever issued. The assertion is on the SHAPE the host registers.
 */
import { describe, expect, it } from "vitest";

import { getNotificationsHostAdapters } from "@cinatra-ai/notifications/host-adapters";

// Side-effect import — this is what `setNotificationsHostAdapters` runs from.
import "@/lib/notifications-host";

describe("notifications host adapters", () => {
  it("supplies an async query runner for the @cinatra#2882 seam", () => {
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
});
