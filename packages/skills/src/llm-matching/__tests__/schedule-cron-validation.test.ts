/**
 * Cron expression validation tests.
 *
 * Covers two layers:
 *   1. `isValidCronExpression()` pure-function unit tests.
 *   2. `writeSchedule()` store-side defense-in-depth: when `enabled === true`
 *      and the cron is malformed, the call MUST throw and NOT write a row.
 *
 * The MCP handler layer is covered separately via the existing
 * `admin-gate.test.ts` harness; the handler delegates to `writeSchedule()`
 * after its PrimitiveInvocationError validation, so a green test here
 * proves the persistence boundary is also guarded.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// Mock the postgres-sync layer so writeSchedule() never opens a real
// connection. We capture the queries that would have been sent so the test
// can assert "no INSERT/UPDATE was run for the malformed cron case".
const runPostgresQueriesSyncMock = vi.fn();
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (...args: unknown[]) => runPostgresQueriesSyncMock(...args),
}));
vi.mock("@/lib/database", () => ({
  getPostgresConnectionString: () => "postgres://test:test@localhost:5432/test",
  postgresSchema: "test_schema",
}));

import { isValidCronExpression } from "../cron-validate";
import { writeSchedule } from "../schedule-store";

describe("isValidCronExpression", () => {
  it("CRON-01: accepts a canonical 5-field expression", () => {
    expect(isValidCronExpression("0 3 * * *")).toBe(true);
  });

  it("CRON-02: accepts a 6-field (Quartz seconds-leading) expression", () => {
    expect(isValidCronExpression("0 0 3 * * *")).toBe(true);
  });

  it("CRON-03: accepts step/range/list field syntax", () => {
    expect(isValidCronExpression("*/15 * * * *")).toBe(true);
    expect(isValidCronExpression("0 9-17 * * 1-5")).toBe(true);
    expect(isValidCronExpression("0 0,12 * * *")).toBe(true);
    expect(isValidCronExpression("0 0 1-15/2 * *")).toBe(true);
  });

  it("CRON-04: rejects an empty string", () => {
    expect(isValidCronExpression("")).toBe(false);
    expect(isValidCronExpression("   ")).toBe(false);
  });

  it("CRON-05: rejects a string with too few fields", () => {
    expect(isValidCronExpression("0 3 *")).toBe(false);
    expect(isValidCronExpression("0 3 * *")).toBe(false);
  });

  it("CRON-06: rejects a string with too many fields (7+)", () => {
    expect(isValidCronExpression("0 0 0 3 * * *")).toBe(false);
  });

  it("CRON-07: rejects fields with garbage characters", () => {
    expect(isValidCronExpression("foo bar baz qux quux")).toBe(false);
    expect(isValidCronExpression("0 3 * * #")).toBe(false);
    expect(isValidCronExpression("0 3 ! ? *")).toBe(false);
  });

  it("CRON-08: rejects non-string inputs", () => {
    expect(isValidCronExpression(null)).toBe(false);
    expect(isValidCronExpression(undefined)).toBe(false);
    expect(isValidCronExpression(123)).toBe(false);
    expect(isValidCronExpression({})).toBe(false);
  });

  it("CRON-09: rejects out-of-range minute (>=60)", () => {
    expect(isValidCronExpression("60 * * * *")).toBe(false);
    expect(isValidCronExpression("99 * * * *")).toBe(false);
  });

  it("CRON-10: rejects out-of-range hour (>=24)", () => {
    expect(isValidCronExpression("0 24 * * *")).toBe(false);
    expect(isValidCronExpression("0 99 * * *")).toBe(false);
  });

  it("CRON-11: rejects garbage classic — '99 99 * * *'", () => {
    expect(isValidCronExpression("99 99 * * *")).toBe(false);
  });

  it("CRON-12: rejects out-of-range day-of-month (0 or 32+)", () => {
    expect(isValidCronExpression("0 0 0 * *")).toBe(false);
    expect(isValidCronExpression("0 0 32 * *")).toBe(false);
  });

  it("CRON-13: rejects out-of-range month (0 or 13+)", () => {
    expect(isValidCronExpression("0 0 1 0 *")).toBe(false);
    expect(isValidCronExpression("0 0 1 13 *")).toBe(false);
  });

  it("CRON-14: rejects out-of-range day-of-week (>7)", () => {
    expect(isValidCronExpression("0 0 * * 8")).toBe(false);
    expect(isValidCronExpression("0 0 * * 9")).toBe(false);
  });

  it("CRON-15: accepts boundary day-of-week (0 and 7 both Sunday)", () => {
    expect(isValidCronExpression("0 0 * * 0")).toBe(true);
    expect(isValidCronExpression("0 0 * * 7")).toBe(true);
  });

  it("CRON-16: rejects out-of-range range endpoints in 5-field", () => {
    expect(isValidCronExpression("0 0-25 * * *")).toBe(false);
    expect(isValidCronExpression("0 9-60 * * *")).toBe(false);
  });

  it("CRON-17: rejects out-of-range numbers in step expressions", () => {
    expect(isValidCronExpression("60/5 * * * *")).toBe(false);
    expect(isValidCronExpression("0 25/2 * * *")).toBe(false);
  });

  it("CRON-18: rejects out-of-range numbers in comma-list expressions", () => {
    expect(isValidCronExpression("0,15,30,60 * * * *")).toBe(false);
  });
});

describe("writeSchedule() defense-in-depth", () => {
  beforeEach(() => {
    runPostgresQueriesSyncMock.mockReset();
    // Default mock: readSchedule (the first call) returns an empty result.
    // The second call is the INSERT (in the happy path) or never fires (in
    // the rejection path).
    runPostgresQueriesSyncMock.mockReturnValue([{ rows: [] }]);
  });

  it("CRON-WRITE-01: writeSchedule throws and writes NO INSERT row when enabled=true with invalid cron", async () => {
    await expect(
      writeSchedule({
        enabled: true,
        cronExpression: "garbage not cron",
        timezone: "UTC",
      }),
    ).rejects.toThrow(/invalid_cron_expression/);

    // The first call is readSchedule; the SECOND call (the INSERT) must NOT
    // have happened. Verify by inspecting all mock invocations: none of them
    // should contain "INSERT INTO".
    const insertCalls = runPostgresQueriesSyncMock.mock.calls.filter((call) => {
      const queries = (call[0] as { queries: Array<{ text: string }> }).queries;
      return queries.some((q) => q.text.includes("INSERT INTO"));
    });
    expect(insertCalls.length).toBe(0);
  });

  it("CRON-WRITE-02: writeSchedule throws when enabled=true with null cron", async () => {
    await expect(
      writeSchedule({
        enabled: true,
        cronExpression: null,
        timezone: "UTC",
      }),
    ).rejects.toThrow(/invalid_cron_expression/);
  });

  it("CRON-WRITE-03: writeSchedule succeeds (no throw) when enabled=false even with null cron", async () => {
    await expect(
      writeSchedule({
        enabled: false,
        cronExpression: null,
        timezone: "UTC",
      }),
    ).resolves.toMatchObject({
      enabled: false,
      cronExpression: null,
    });

    // Verify the INSERT happened.
    const insertCalls = runPostgresQueriesSyncMock.mock.calls.filter((call) => {
      const queries = (call[0] as { queries: Array<{ text: string }> }).queries;
      return queries.some((q) => q.text.includes("INSERT INTO"));
    });
    expect(insertCalls.length).toBe(1);
  });

  it("CRON-WRITE-04: writeSchedule accepts a valid 5-field cron when enabled=true", async () => {
    await expect(
      writeSchedule({
        enabled: true,
        cronExpression: "0 3 * * *",
        timezone: "UTC",
      }),
    ).resolves.toMatchObject({
      enabled: true,
      cronExpression: "0 3 * * *",
    });
  });

  it("CRON-WRITE-05: writeSchedule accepts a valid 6-field cron when enabled=true", async () => {
    await expect(
      writeSchedule({
        enabled: true,
        cronExpression: "0 0 3 * * *",
        timezone: "UTC",
      }),
    ).resolves.toMatchObject({
      enabled: true,
      cronExpression: "0 0 3 * * *",
    });
  });
});
