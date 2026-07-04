/**
 * logDeniedAuditEventStrictWithCooldown unit tests (cinatra#952 W2).
 *
 * The per-connection use-gate's DENY writes need BOTH properties the two
 * existing helpers each miss: durability (logAuditEvent swallows insert
 * failures) AND flood control (logAuditEventStrict skips the denied
 * cooldown). This helper lives inside audit.ts (the private cooldown map's
 * owner) and:
 *   1. skips the write (caller still denies) while the key is cooling;
 *   2. otherwise AWAITS the strict insert and registers the cooldown key
 *      ONLY after the durable insert succeeded;
 *   3. propagates insert failures WITHOUT registering the cooldown (the next
 *      deny retries the durable write — no 60s blind spot).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const queryMock = vi.fn();
vi.mock("pg", async () => {
  const actual = await vi.importActual<typeof import("pg")>("pg");
  class MockPool {
    on() { return this; }
    listenerCount() { return 1; }
    query(...args: unknown[]) { return queryMock(...args); }
    connect() { return Promise.resolve({ release: () => {}, query: queryMock }); }
    end() { return Promise.resolve(); }
  }
  return { ...actual, Pool: MockPool };
});

import {
  logDeniedAuditEventStrictWithCooldown,
  _resetDeniedCooldownForTests,
} from "@/lib/authz/audit";

const input = {
  actorPrincipalId: "user-1",
  resourceType: "connection",
  resourceId: "conn-1",
  operation: "use",
  decision: "denied" as const,
};

describe("logDeniedAuditEventStrictWithCooldown", () => {
  beforeEach(() => {
    queryMock.mockReset();
    _resetDeniedCooldownForTests();
    process.env.SUPABASE_DB_URL ??= "postgres://unit:unit@localhost:5432/unit";
  });

  it("writes durably, then suppresses repeat denies within the cooldown window", async () => {
    queryMock.mockResolvedValue({ rows: [{ id: "row-1" }] });
    const first = await logDeniedAuditEventStrictWithCooldown(input);
    expect(first).toHaveProperty("id"); // durable write, not skipped
    expect(queryMock).toHaveBeenCalledTimes(1);

    const second = await logDeniedAuditEventStrictWithCooldown(input);
    expect(second).toEqual({ skipped: true });
    expect(queryMock).toHaveBeenCalledTimes(1); // no second write while cooling
  });

  it("propagates an insert failure and does NOT register the cooldown (no blind spot)", async () => {
    queryMock.mockRejectedValueOnce(new Error("db down"));
    await expect(logDeniedAuditEventStrictWithCooldown(input)).rejects.toThrow(/db down|Failed query/);

    // The failed write must not have armed the cooldown — the next deny
    // retries the durable write.
    queryMock.mockResolvedValueOnce({ rows: [{ id: "row-2" }] });
    const retried = await logDeniedAuditEventStrictWithCooldown(input);
    expect(retried).toHaveProperty("id"); // durable write retried, not skipped
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("cooldown keys are per (actor, resourceType, operation)", async () => {
    queryMock.mockResolvedValue({ rows: [{ id: "r" }] });
    await logDeniedAuditEventStrictWithCooldown(input);
    const other = await logDeniedAuditEventStrictWithCooldown({
      ...input,
      actorPrincipalId: "user-2",
    });
    expect(other).toHaveProperty("id"); // different actor key → not suppressed
    expect(queryMock).toHaveBeenCalledTimes(2);
  });
});
