/**
 * The STRICT, IDEMPOTENT execution-audit kernel path (cinatra#2266 G4/AC6).
 *
 * The property this closes: the durable spool removes a record only after the
 * app says "this is durably in the kernel", so the write it acknowledges has to
 * be able to make that claim. Neither existing helper could —
 * `logAuditEvent` mints a fresh `randomUUID()`, has no unique delivery key and
 * SWALLOWS insert failures; `logAuditEventStrict` propagates failures but has
 * no delivery key, so at-least-once delivery becomes duplicate rows.
 *
 * Driven through the REAL drizzle statement against a mocked `pg` — the same
 * interception point the other audit tests use — so the assertions are about
 * the SQL that actually reaches Postgres (its conflict target, its parameters)
 * rather than about a mock of the module under test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  executionAuditRowId,
  logExecutionAuditEventDurable,
  _resetDeniedCooldownForTests,
} from "@/lib/authz/audit";

function lastSql(): { text: string; values: unknown[] } {
  const call = queryMock.mock.calls.at(-1) ?? [];
  const a0 = call[0];
  if (a0 && typeof a0 === "object" && "text" in (a0 as object)) {
    const cfg = a0 as { text: string; values?: unknown[] };
    const positional = (call[1] as unknown[]) ?? [];
    return { text: cfg.text, values: positional.length > 0 ? positional : (cfg.values ?? []) };
  }
  return { text: String(a0), values: (call[1] as unknown[]) ?? [] };
}

/**
 * A Postgres that actually HONOURS the unique index: the second insert of a
 * delivery key returns zero rows, exactly as `ON CONFLICT DO NOTHING RETURNING`
 * does. Without this the "duplicate" arm would be asserting against a mock that
 * agreed with it by construction.
 */
function uniqueIndexBackedPg(): { seen: Set<string> } {
  const seen = new Set<string>();
  queryMock.mockImplementation((...args: unknown[]) => {
    const cfg = args[0] as { text: string };
    const values = ((args[1] as unknown[]) ?? []) as unknown[];
    // The delivery key is the value that matches `<uuid>:<n>`.
    const key = values.find(
      (v): v is string => typeof v === "string" && /^[0-9a-f-]{36}:\d+$/.test(v),
    );
    if (!/insert into/i.test(cfg.text) || key === undefined) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (seen.has(key)) return Promise.resolve({ rows: [], rowCount: 0 });
    seen.add(key);
    const id = values[0];
    return Promise.resolve({ rows: [[id]], rowCount: 1 });
  });
  return { seen };
}

const SPOOL = "8f7a3d1e-0000-4000-8000-000000000001";

const input = (deliveryKey: string) => ({
  organizationId: "org-1",
  actorPrincipalId: "user-1",
  actorPrincipalType: "model" as const,
  authSource: "agent" as const,
  resourceType: "execution_sandbox",
  resourceId: "job-1",
  operation: "sandbox_execute",
  decision: "denied" as const,
  executionDeliveryKey: deliveryKey,
  metadata: { seq: 0, reason: "voucher_invalid" },
});

describe("logExecutionAuditEventDurable — idempotent on the delivery key", () => {
  beforeEach(() => {
    queryMock.mockReset();
    _resetDeniedCooldownForTests();
  });

  it("reports `inserted` the first time and `duplicate` on a re-delivery, with ONE row id", async () => {
    uniqueIndexBackedPg();
    const first = await logExecutionAuditEventDurable(input(`${SPOOL}:7`));
    const second = await logExecutionAuditEventDurable(input(`${SPOOL}:7`));

    expect(first.state).toBe("inserted");
    expect(second.state).toBe("duplicate");
    // The SAME row is named both times — no fresh randomUUID on the retry,
    // which is the `randomUUID` de-dup loss this path exists to remove.
    expect(second.id).toBe(first.id);
    expect(first.id).toBe(executionAuditRowId(`${SPOOL}:7`));
    // Both attempts really did reach Postgres: the second is a genuine
    // constraint outcome, not a client-side short-circuit that could go stale.
    expect(queryMock.mock.calls).toHaveLength(2);
  });

  it("conflicts on the DELIVERY KEY column, not on the primary key", async () => {
    uniqueIndexBackedPg();
    await logExecutionAuditEventDurable(input(`${SPOOL}:1`));
    const { text, values } = lastSql();
    expect(text.toLowerCase()).toContain("on conflict");
    expect(text).toContain("execution_delivery_key");
    expect(text.toLowerCase()).toContain("do nothing");
    expect(text.toLowerCase()).toContain("returning");
    expect(values).toContain(`${SPOOL}:1`);
  });

  it("treats two DIFFERENT delivery keys as two rows", async () => {
    const { seen } = uniqueIndexBackedPg();
    const a = await logExecutionAuditEventDurable(input(`${SPOOL}:1`));
    const b = await logExecutionAuditEventDurable(input(`${SPOOL}:2`));
    expect(a.state).toBe("inserted");
    expect(b.state).toBe("inserted");
    expect(a.id).not.toBe(b.id);
    expect(seen.size).toBe(2);
  });

  it("BYPASSES the denied cooldown — two denials with the same key triple both insert", async () => {
    // The exact collapse #2266 opens with: every execution-plane refusal pins
    // `(actor, resourceType, operation)` to constants. The cooldown is a NOISE
    // control on a time window; this path's de-dup is an IDENTITY control on
    // the delivery key. Running both would discard a record whose delivery key
    // says it is new — and the spool would then ACK a row never inserted.
    uniqueIndexBackedPg();
    const first = await logExecutionAuditEventDurable(input(`${SPOOL}:10`));
    const second = await logExecutionAuditEventDurable(input(`${SPOOL}:11`));
    expect(first.state).toBe("inserted");
    expect(second.state).toBe("inserted");
    expect(queryMock.mock.calls).toHaveLength(2);
  });

  it("PROPAGATES an insert failure instead of swallowing it", async () => {
    const dbErr = new Error("pg-down");
    queryMock.mockRejectedValue(dbErr);
    await expect(logExecutionAuditEventDurable(input(`${SPOOL}:3`))).rejects.toMatchObject({
      cause: dbErr,
    });
  });

  it("refuses a record with no delivery key rather than writing an unackable row", async () => {
    uniqueIndexBackedPg();
    await expect(
      logExecutionAuditEventDurable({ ...input(""), executionDeliveryKey: "" }),
    ).rejects.toThrow(/requires a non-empty executionDeliveryKey/);
    expect(queryMock.mock.calls).toHaveLength(0);
  });

  it("still strips the sensitive-key blocklist from metadata", async () => {
    uniqueIndexBackedPg();
    await logExecutionAuditEventDurable({
      ...input(`${SPOOL}:4`),
      metadata: { seq: 1, token: "sk-live-should-never-land" },
    });
    const { values } = lastSql();
    expect(JSON.stringify(values)).not.toContain("sk-live-should-never-land");
  });
});
