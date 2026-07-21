import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Retroactive dormant-history durable-content purge (cinatra#1037 PR2 CUTOVER,
// codex decision-3). RELOCATED from the retired mirror-backfill module.
// Pins: an unbounded destructive purge is REFUSED (cutoff required); a dry-run
// audit is unbounded and count-only; a cutoff-bounded purge runs the audit then
// the scoped UPDATE, threading the cutoff as $1 through both.
// ---------------------------------------------------------------------------

const runPostgresQueriesSync = vi.fn();

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (...a: unknown[]) => runPostgresQueriesSync(...a),
}));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "cinatra_test",
}));
vi.mock("@/lib/postgres-schema-init", () => ({
  ensurePostgresSchema: () => {},
}));

import { purgeBackfilledDormantContentTurns } from "../assistant-thread-dormant-content-purge";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("purgeBackfilledDormantContentTurns (drop-history purge, codex convergence)", () => {
  it("a DESTRUCTIVE purge (dryRun:false) without a cutoff is REFUSED (no unbounded wipe)", () => {
    expect(() => purgeBackfilledDormantContentTurns({ dryRun: false })).toThrow(/cutoff/i);
    // ...and it never issued a query (thrown before any DB write).
    expect(runPostgresQueriesSync).not.toHaveBeenCalled();
  });

  it("a dry-run AUDIT is permitted unbounded and only COUNTS (no purge query)", () => {
    runPostgresQueriesSync.mockReturnValueOnce([{ rows: [{ n: 3 }] }]);
    const r = purgeBackfilledDormantContentTurns({ dryRun: true });
    expect(r).toEqual({ auditedContentTurns: 3, purged: 0, dryRun: true });
    // exactly one call — the audit SELECT; no UPDATE.
    expect(runPostgresQueriesSync).toHaveBeenCalledTimes(1);
  });

  it("a cutoff-bounded destructive purge runs the audit then the scoped UPDATE", () => {
    runPostgresQueriesSync
      .mockReturnValueOnce([{ rows: [{ n: 2 }] }]) // audit
      .mockReturnValueOnce([{ rowCount: 2 }]); // purge UPDATE
    const r = purgeBackfilledDormantContentTurns({
      dryRun: false,
      beforeUpdatedAt: "2021-01-01T00:00:00Z",
    });
    expect(r).toEqual({ auditedContentTurns: 2, purged: 2, dryRun: false });
    // The audit + the UPDATE both carry the cutoff as $1.
    const auditCall = runPostgresQueriesSync.mock.calls[0][0] as { queries: Array<{ values: unknown[]; text: string }> };
    const purgeCall = runPostgresQueriesSync.mock.calls[1][0] as { queries: Array<{ values: unknown[]; text: string }> };
    expect(auditCall.queries[0].values).toEqual(["2021-01-01T00:00:00Z"]);
    expect(purgeCall.queries[0].values).toEqual(["2021-01-01T00:00:00Z"]);
    expect(purgeCall.queries[0].text).toMatch(/SET content = NULL, ordinal = NULL/);
  });
});
