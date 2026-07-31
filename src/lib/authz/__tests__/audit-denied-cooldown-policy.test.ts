/**
 * The denied-cooldown POLICY — the kernel half of cinatra#2266 AC1.
 *
 * The cooldown exists to stop a retrying caller from flooding `audit_events`,
 * and for a producer whose refusals genuinely differ in
 * `(actor, resourceType, operation)` it is the right granularity. For a
 * producer that pins all three to constants it is not: every refusal collapses
 * onto one key and only the first in each 60 s window is ever written.
 *
 * The mechanism (recorded on `AuditEventInput.deniedCooldown`) is a
 * per-producer OPT-IN with two dispositions — `"record_every"` for a producer
 * with no repeat semantics, `{ discriminator }` for one that can say what makes
 * two denials the same event. These pin all three paths: each opt-in, and that
 * NOT opting in leaves the old key and the old map exactly as they were —
 * plus the bound that keeps a per-command key from becoming a memory leak.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Same interception point as `audit.test.ts`: mocking `pg` lets these tests
// count real INSERT attempts through the real cooldown gate, rather than
// asserting against a mock of the module under test.
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
  DENIED_COOLDOWN_MAX_SCOPED_KEYS,
  _deniedCooldownSizesForTests,
  _resetDeniedCooldownForTests,
  isDeniedCoolingDown,
  logAuditEvent,
  logDeniedAuditEventStrictWithCooldown,
  type AuditEventInput,
} from "@/lib/authz/audit";

/** A refusal shaped exactly like the execution plane's: constant everything. */
const REFUSAL: AuditEventInput = {
  actorPrincipalId: "user-1",
  resourceType: "execution_sandbox",
  operation: "sandbox_execute",
  decision: "denied",
  policyVersion: "v1",
};

/** The key the collapse used to happen on — one constant string per user. */
const COLLAPSED_KEY = "user-1:execution_sandbox:sandbox_execute";

describe("denied cooldown — opt-in discriminator (cinatra#2266 AC1)", () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    _resetDeniedCooldownForTests();
  });

  it("records BOTH refusals when the discriminator differs inside one window", async () => {
    await logAuditEvent({ ...REFUSAL, deniedCooldown: { discriminator: "job-a|voucher_invalid|" } });
    await logAuditEvent({ ...REFUSAL, deniedCooldown: { discriminator: "job-b|voucher_invalid|" } });
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("still suppresses a repeat carrying the IDENTICAL discriminator", async () => {
    const repeated = { ...REFUSAL, deniedCooldown: { discriminator: "job-a|voucher_replayed|cmd-1" } };
    await logAuditEvent(repeated);
    await logAuditEvent(repeated);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("leaves the key BYTE-IDENTICAL for every caller that does not opt in", async () => {
    await logAuditEvent(REFUSAL);
    // The pre-existing key, unchanged — a discriminator-free caller must not
    // notice this change at all.
    expect(isDeniedCoolingDown(COLLAPSED_KEY)).toBe(true);
    await logAuditEvent(REFUSAL);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("does not let an opted-in producer suppress a discriminator-free caller", async () => {
    await logAuditEvent({ ...REFUSAL, deniedCooldown: { discriminator: "job-a|voucher_invalid|" } });
    // A different producer on the same triple has its own (base) key and is
    // still recorded — the discriminator EXTENDS the key, it does not replace
    // the namespace.
    await logAuditEvent(REFUSAL);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("never suppresses allowed events, discriminator or not", async () => {
    const allowed: AuditEventInput = { ...REFUSAL, decision: "allowed" };
    await logAuditEvent({ ...allowed, deniedCooldown: { discriminator: "job-a||" } });
    await logAuditEvent({ ...allowed, deniedCooldown: { discriminator: "job-a||" } });
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("bounds the live key space so a per-command discriminator cannot leak", async () => {
    const overshoot = 50;
    for (let i = 0; i < DENIED_COOLDOWN_MAX_SCOPED_KEYS + overshoot; i += 1) {
      await logAuditEvent({ ...REFUSAL, deniedCooldown: { discriminator: `job-${i}|denied|cmd-${i}` } });
    }
    // Every one of them was WRITTEN — the bound evicts cooldown bookkeeping,
    // never an audit row.
    expect(queryMock).toHaveBeenCalledTimes(DENIED_COOLDOWN_MAX_SCOPED_KEYS + overshoot);
    expect(_deniedCooldownSizesForTests().scoped).toBeLessThanOrEqual(
      DENIED_COOLDOWN_MAX_SCOPED_KEYS,
    );
  });

  it("an opted-in flood cannot evict an opted-OUT caller's live key", async () => {
    // The reason the two key classes do not share a map. Without the split, a
    // producer discriminating per command would push a legacy caller's live
    // suppression out of a shared bound and let its retry write a second row.
    await logAuditEvent(REFUSAL);
    expect(isDeniedCoolingDown(COLLAPSED_KEY)).toBe(true);

    for (let i = 0; i < DENIED_COOLDOWN_MAX_SCOPED_KEYS + 50; i += 1) {
      await logAuditEvent({ ...REFUSAL, deniedCooldown: { discriminator: `job-${i}|denied|cmd-${i}` } });
    }

    expect(isDeniedCoolingDown(COLLAPSED_KEY)).toBe(true);
    expect(_deniedCooldownSizesForTests().base).toBe(1);
  });

  it("records EVERY denial for a producer that declares record_every", async () => {
    // The command sink's posture: no identity to key on, so no suppression.
    for (let i = 0; i < 10; i += 1) {
      await logAuditEvent({ ...REFUSAL, deniedCooldown: "record_every" });
    }
    expect(queryMock).toHaveBeenCalledTimes(10);
  });

  it("record_every costs NO cooldown bookkeeping at all", async () => {
    for (let i = 0; i < 100; i += 1) {
      await logAuditEvent({ ...REFUSAL, deniedCooldown: "record_every" });
    }
    // Nothing to remember means nothing to bound — the map a suppression-free
    // producer needs is the empty one.
    expect(_deniedCooldownSizesForTests()).toEqual({ base: 0, scoped: 0 });
  });

  it("record_every does not suppress, and is not suppressed BY, the base key", async () => {
    await logAuditEvent(REFUSAL);
    expect(isDeniedCoolingDown(COLLAPSED_KEY)).toBe(true);
    // A producer that opted out is written even while the shared base key for
    // the same triple is cooling down.
    await logAuditEvent({ ...REFUSAL, deniedCooldown: "record_every" });
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("record_every is honoured on the STRICT deny path too", async () => {
    for (let i = 0; i < 5; i += 1) {
      await logDeniedAuditEventStrictWithCooldown({
        ...REFUSAL,
        deniedCooldown: "record_every",
      });
    }
    expect(queryMock).toHaveBeenCalledTimes(5);
  });

  it("keeps the classes isolated even when their keys SPELL the same string", async () => {
    // Both keys are colon-joined over caller-supplied text, so a base triple
    // whose operation ends in `:x` serializes exactly like a scoped key whose
    // discriminator is `x`. The write paths resolve the map from the input's
    // own policy, so the collision is inert.
    const collidingBase: AuditEventInput = {
      ...REFUSAL,
      operation: "sandbox_execute:x",
    };
    await logAuditEvent({ ...REFUSAL, deniedCooldown: { discriminator: "x" } });
    expect(queryMock).toHaveBeenCalledTimes(1);
    // The scoped entry must not suppress the identically-spelled base key...
    await logAuditEvent(collidingBase);
    expect(queryMock).toHaveBeenCalledTimes(2);
    // ...nor the other way round.
    await logAuditEvent({ ...REFUSAL, deniedCooldown: { discriminator: "y" } });
    expect(queryMock).toHaveBeenCalledTimes(3);
    expect(_deniedCooldownSizesForTests()).toEqual({ base: 1, scoped: 2 });
  });

  it("an EMPTY discriminator is scoped, and cannot suppress a legacy caller", async () => {
    // The key's shape and the map it lands in come from the same union, so an
    // empty discriminator produces `<base>:` in the scoped map — not a
    // base-shaped key that a discriminator-free caller would collide with.
    await logAuditEvent({ ...REFUSAL, deniedCooldown: { discriminator: "" } });
    expect(isDeniedCoolingDown(COLLAPSED_KEY)).toBe(false);
    expect(_deniedCooldownSizesForTests()).toEqual({ base: 0, scoped: 1 });

    await logAuditEvent(REFUSAL);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("bounds the strict deny path too — every writer shares the one helper", async () => {
    // `logDeniedAuditEventStrictWithCooldown` takes the same input type, so it
    // can carry a discriminator; a bare `.set` here would have escaped the
    // bound entirely.
    for (let i = 0; i < DENIED_COOLDOWN_MAX_SCOPED_KEYS + 50; i += 1) {
      await logDeniedAuditEventStrictWithCooldown({
        ...REFUSAL,
        deniedCooldown: { discriminator: `strict-${i}` },
      });
    }
    expect(_deniedCooldownSizesForTests().scoped).toBeLessThanOrEqual(
      DENIED_COOLDOWN_MAX_SCOPED_KEYS,
    );
  });
});
