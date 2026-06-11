// Boot policy for the core migration runner (cinatra#116).
//
// The policy under test (see src/lib/core-migrations.ts):
//   - no SUPABASE_DB_URL            -> skip quietly (fresh install pre-setup)
//   - bootstrap DDL / DB unreachable -> warn + skip (lazy-tolerant boot parity)
//   - migration failure              -> dev: loud + continue; prod: THROW
//     (abort boot — never serve new code against a half-migrated schema in
//     production).
import { describe, expect, it, vi } from "vitest";

import { runCoreMigrationsAtBoot } from "@/lib/core-migrations";

const noop = () => {};

function baseDeps(overrides: Parameters<typeof runCoreMigrationsAtBoot>[0] = {}) {
  return {
    getConnectionString: () => "postgres://example/db",
    ensureSchema: vi.fn(),
    run: vi.fn(async () => ({ ranNames: [], direction: "up" as const, faked: false })),
    isDevMode: () => true,
    log: noop,
    logError: noop,
    ...overrides,
  };
}

describe("runCoreMigrationsAtBoot", () => {
  it("runs the chain after the bootstrap DDL and reports applied migrations", async () => {
    const order: string[] = [];
    const deps = baseDeps({
      ensureSchema: vi.fn(() => order.push("bootstrap")) as () => void,
      run: vi.fn(async () => {
        order.push("migrate");
        return { ranNames: ["core__0001_x"], direction: "up" as const, faked: false };
      }),
    });
    const outcome = await runCoreMigrationsAtBoot(deps);
    expect(outcome).toEqual({ status: "applied", ranNames: ["core__0001_x"] });
    expect(order).toEqual(["bootstrap", "migrate"]);
  });

  it("skips quietly when SUPABASE_DB_URL is not configured (fresh install)", async () => {
    const run = vi.fn();
    const outcome = await runCoreMigrationsAtBoot(
      baseDeps({
        getConnectionString: () => {
          throw new Error("SUPABASE_DB_URL is required.");
        },
        run,
      }),
    );
    expect(outcome).toEqual({ status: "skipped", reason: "no-database-url" });
    expect(run).not.toHaveBeenCalled();
  });

  it("warns and skips when the bootstrap DDL is unavailable (DB down / pre-auth schema)", async () => {
    const run = vi.fn();
    const outcome = await runCoreMigrationsAtBoot(
      baseDeps({
        ensureSchema: vi.fn(() => {
          throw new Error("connect ECONNREFUSED");
        }) as () => void,
        run,
      }),
    );
    expect(outcome).toEqual({ status: "skipped", reason: "bootstrap-unavailable" });
    expect(run).not.toHaveBeenCalled();
  });

  it("warns and skips on a connection-phase runner failure (err.phase === 'connect')", async () => {
    const outcome = await runCoreMigrationsAtBoot(
      baseDeps({
        run: vi.fn(async () => {
          const err = new Error("ECONNREFUSED") as Error & { phase?: string };
          err.phase = "connect";
          throw err;
        }),
      }),
    );
    expect(outcome).toEqual({ status: "skipped", reason: "bootstrap-unavailable" });
  });

  it("continues loudly in development when a migration fails", async () => {
    const logError = vi.fn();
    const outcome = await runCoreMigrationsAtBoot(
      baseDeps({
        run: vi.fn(async () => {
          throw new Error("column does not exist");
        }),
        isDevMode: () => true,
        logError,
      }),
    );
    expect(outcome).toEqual({ status: "failed-dev" });
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("MIGRATION FAILED"), expect.anything());
  });

  it("rethrows in production when a migration fails (boot must abort)", async () => {
    await expect(
      runCoreMigrationsAtBoot(
        baseDeps({
          run: vi.fn(async () => {
            throw new Error("column does not exist");
          }),
          isDevMode: () => false,
        }),
      ),
    ).rejects.toThrow("column does not exist");
  });

  it("returns noop when the ledger is already current", async () => {
    const outcome = await runCoreMigrationsAtBoot(baseDeps());
    expect(outcome).toEqual({ status: "noop" });
  });
});
