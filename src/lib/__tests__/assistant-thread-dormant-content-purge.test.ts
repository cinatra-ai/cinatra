import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Retroactive dormant-history durable-content purge (cinatra#1037 PR2 CUTOVER,
// codex decision-3). RELOCATED from the retired mirror-backfill module.
// Pins: an unbounded destructive purge is REFUSED (cutoff required); a dry-run
// audit is unbounded and count-only; a cutoff-bounded purge runs the audit then
// the scoped UPDATE, threading the cutoff as $1 through both.
//
// cinatra#2365: the destructive purge additionally reads the cutover marker
// and REFUSES a cutoff that is not strictly earlier than the marker's own
// `cutover_at` — the first-upgrade footgun where a naive cutoff equal to the
// marker's just-stamped activation instant would classify EVERY pre-existing
// thread as dormant. The companion repair (`restoreDurableContentFromChatThreads`
// / `findLegacyThreadIdsMissingDurableContent`) re-hydrates already-affected
// threads' durable content from the surviving legacy `chat_threads.payload`.
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

import {
  purgeBackfilledDormantContentTurns,
  findLegacyThreadIdsMissingDurableContent,
  restoreDurableContentFromChatThreads,
} from "../assistant-thread-dormant-content-purge";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("purgeBackfilledDormantContentTurns (drop-history purge, codex convergence)", () => {
  it("a DESTRUCTIVE purge (dryRun:false) without a cutoff is REFUSED (no unbounded wipe)", () => {
    expect(() => purgeBackfilledDormantContentTurns({ dryRun: false })).toThrow(/cutoff/i);
    // ...and it never issued a query (thrown before any DB write).
    expect(runPostgresQueriesSync).not.toHaveBeenCalled();
  });

  it("a dry-run AUDIT is permitted unbounded and only COUNTS (no purge query, no marker read)", () => {
    runPostgresQueriesSync.mockReturnValueOnce([{ rows: [{ n: 3 }] }]);
    const r = purgeBackfilledDormantContentTurns({ dryRun: true });
    expect(r).toEqual({ auditedContentTurns: 3, purged: 0, dryRun: true });
    // exactly one call — the audit SELECT; no marker read, no UPDATE (the
    // marker-cutoff guard only runs on the destructive path).
    expect(runPostgresQueriesSync).toHaveBeenCalledTimes(1);
  });

  it("a cutoff-bounded destructive purge reads the marker, then runs the audit then the scoped UPDATE", () => {
    runPostgresQueriesSync
      .mockReturnValueOnce([{ rows: [{ cutover_at: "2026-08-02T09:17:00Z" }] }]) // marker read
      .mockReturnValueOnce([{ rows: [{ n: 2 }] }]) // audit
      .mockReturnValueOnce([{ rowCount: 2 }]); // purge UPDATE
    const r = purgeBackfilledDormantContentTurns({
      dryRun: false,
      beforeUpdatedAt: "2021-01-01T00:00:00Z",
    });
    expect(r).toEqual({ auditedContentTurns: 2, purged: 2, dryRun: false });
    expect(runPostgresQueriesSync).toHaveBeenCalledTimes(3);
    const auditCall = runPostgresQueriesSync.mock.calls[1][0] as { queries: Array<{ values: unknown[]; text: string }> };
    const purgeCall = runPostgresQueriesSync.mock.calls[2][0] as { queries: Array<{ values: unknown[]; text: string }> };
    expect(auditCall.queries[0].values).toEqual(["2021-01-01T00:00:00Z"]);
    expect(purgeCall.queries[0].values).toEqual(["2021-01-01T00:00:00Z"]);
    expect(purgeCall.queries[0].text).toMatch(/SET content = NULL, ordinal = NULL/);
  });

  it("no cutover marker row (cutover never activated): the destructive purge proceeds unchanged", () => {
    runPostgresQueriesSync
      .mockReturnValueOnce([{ rows: [] }]) // marker read — no row
      .mockReturnValueOnce([{ rows: [{ n: 1 }] }]) // audit
      .mockReturnValueOnce([{ rowCount: 1 }]); // purge UPDATE
    const r = purgeBackfilledDormantContentTurns({
      dryRun: false,
      beforeUpdatedAt: "2021-01-01T00:00:00Z",
    });
    expect(r).toEqual({ auditedContentTurns: 1, purged: 1, dryRun: false });
  });

  describe("cinatra#2365 — the first-upgrade footgun: cutover marker == migration timestamp must NOT purge everything", () => {
    it("REFUSES a destructive purge whose cutoff equals the cutover marker's own cutover_at", () => {
      runPostgresQueriesSync.mockReturnValueOnce([
        { rows: [{ cutover_at: "2026-08-02T09:17:00Z" }] },
      ]); // marker read
      expect(() =>
        purgeBackfilledDormantContentTurns({
          dryRun: false,
          beforeUpdatedAt: "2026-08-02T09:17:00Z", // == the just-stamped marker — the reported bug's exact recipe
        }),
      ).toThrow(/cutover marker/i);
      // Refused BEFORE the audit/UPDATE ever ran — only the marker read happened.
      expect(runPostgresQueriesSync).toHaveBeenCalledTimes(1);
    });

    it("REFUSES a destructive purge whose cutoff is LATER than the cutover marker's cutover_at", () => {
      runPostgresQueriesSync.mockReturnValueOnce([
        { rows: [{ cutover_at: "2026-08-02T09:17:00Z" }] },
      ]);
      expect(() =>
        purgeBackfilledDormantContentTurns({
          dryRun: false,
          beforeUpdatedAt: "2026-08-02T10:00:00Z",
        }),
      ).toThrow(/cutover marker/i);
      expect(runPostgresQueriesSync).toHaveBeenCalledTimes(1);
    });

    it("threads survive: a refused purge nulls nothing, so a subsequent durable-content read is untouched", () => {
      // Simulates the exact reproduction: an operator runs the cutover cleanup
      // with beforeUpdatedAt == the marker's own cutover_at right after a
      // first upgrade. The purge must refuse rather than nulling every
      // pre-existing thread's durable content.
      runPostgresQueriesSync.mockReturnValueOnce([
        { rows: [{ cutover_at: "2026-08-02T09:17:00Z" }] },
      ]);
      expect(() =>
        purgeBackfilledDormantContentTurns({
          dryRun: false,
          beforeUpdatedAt: "2026-08-02T09:17:00Z",
        }),
      ).toThrow();
      // No UPDATE was ever issued (only the marker SELECT ran) — durable
      // content stays exactly as it was, so the owner's /chat list — which
      // gates on that same content — remains non-empty.
      expect(runPostgresQueriesSync).toHaveBeenCalledTimes(1);
      for (const call of runPostgresQueriesSync.mock.calls) {
        const { queries } = call[0] as { queries: Array<{ text: string }> };
        for (const q of queries) expect(q.text).not.toMatch(/UPDATE/i);
      }
    });
  });
});

describe("findLegacyThreadIdsMissingDurableContent (cinatra#2365 repair discovery)", () => {
  it("returns the thread ids the read-only SELECT reports, and issues no write", () => {
    runPostgresQueriesSync.mockReturnValueOnce([
      { rows: [{ id: "thread-a" }, { id: "thread-b" }] },
    ]);
    const ids = findLegacyThreadIdsMissingDurableContent();
    expect(ids).toEqual(["thread-a", "thread-b"]);
    expect(runPostgresQueriesSync).toHaveBeenCalledTimes(1);
    const call = runPostgresQueriesSync.mock.calls[0][0] as { queries: Array<{ text: string }> };
    expect(call.queries[0].text).toMatch(/NOT EXISTS/i);
    expect(call.queries[0].text).toMatch(/chat_threads/);
  });
});

describe("restoreDurableContentFromChatThreads (cinatra#2365 repair)", () => {
  it("dry-run only audits — no payload read, no mirror write", () => {
    runPostgresQueriesSync.mockReturnValueOnce([{ rows: [{ id: "thread-a" }] }]); // discovery SELECT
    const r = restoreDurableContentFromChatThreads({ dryRun: true });
    expect(r).toEqual({ auditedThreads: 1, restored: 0, dryRun: true });
    expect(runPostgresQueriesSync).toHaveBeenCalledTimes(1);
  });

  it("nothing to repair: an empty candidate set is a no-op", () => {
    runPostgresQueriesSync.mockReturnValueOnce([{ rows: [] }]);
    const r = restoreDurableContentFromChatThreads({ dryRun: false });
    expect(r).toEqual({ auditedThreads: 0, restored: 0, dryRun: false });
    expect(runPostgresQueriesSync).toHaveBeenCalledTimes(1);
  });

  it("restores durable content from the surviving chat_threads.payload for a content-less thread", () => {
    const payload = JSON.stringify({
      id: "thread-a",
      title: "Recovered thread",
      messages: [
        { id: "m1", role: "user", content: "hello" },
        { id: "m2", role: "assistant", content: "hi there" },
      ],
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-01T00:05:00Z",
    });
    runPostgresQueriesSync
      .mockReturnValueOnce([{ rows: [{ id: "thread-a" }] }]) // discovery SELECT
      .mockReturnValueOnce([{ rows: [{ payload }] }]) // chat_threads payload read
      .mockReturnValueOnce([{ rowCount: 1 }]); // the mirror-projection write transaction

    const r = restoreDurableContentFromChatThreads({ dryRun: false });
    expect(r).toEqual({ auditedThreads: 1, restored: 1, dryRun: false });
    expect(runPostgresQueriesSync).toHaveBeenCalledTimes(3);

    // The 3rd call is the mirror-projection transaction: it must carry an
    // assistant_turns upsert with the restored message content.
    const writeCall = runPostgresQueriesSync.mock.calls[2][0] as {
      transaction?: boolean;
      queries: Array<{ text: string; values: unknown[] }>;
    };
    expect(writeCall.transaction).toBe(true);
    const insertQuery = writeCall.queries.find((q) => /INSERT INTO/i.test(q.text) && /assistant_turns/i.test(q.text));
    expect(insertQuery).toBeDefined();
    const serializedContents = insertQuery!.values.flat(Infinity) as unknown[];
    expect(serializedContents.some((v) => typeof v === "string" && v.includes("hello"))).toBe(true);
  });

  it("skips a candidate with no surviving chat_threads row (nothing to restore from)", () => {
    runPostgresQueriesSync
      .mockReturnValueOnce([{ rows: [{ id: "thread-gone" }] }]) // discovery
      .mockReturnValueOnce([{ rows: [] }]); // no chat_threads row
    const r = restoreDurableContentFromChatThreads({ dryRun: false });
    expect(r).toEqual({ auditedThreads: 1, restored: 0, dryRun: false });
    expect(runPostgresQueriesSync).toHaveBeenCalledTimes(2); // discovery + the failed payload read only
  });

  it("skips a candidate whose legacy payload is corrupt JSON (defensive, never aborts the pass)", () => {
    runPostgresQueriesSync
      .mockReturnValueOnce([{ rows: [{ id: "thread-corrupt" }] }])
      .mockReturnValueOnce([{ rows: [{ payload: "{not json" }] }]);
    const r = restoreDurableContentFromChatThreads({ dryRun: false });
    expect(r).toEqual({ auditedThreads: 1, restored: 0, dryRun: false });
    expect(runPostgresQueriesSync).toHaveBeenCalledTimes(2);
  });
});
