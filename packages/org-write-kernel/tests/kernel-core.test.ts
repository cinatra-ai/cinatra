/**
 * cinatra#1938 — kernel core: capability table totality + archived denials,
 * global lock order, the shared live-attempt predicate (incl. the
 * reset-to-input refusal codex round-0 forced), and runtime permit
 * unforgeability (the WeakSet claim, not the type brand).
 */
import { describe, it, expect } from "vitest";
import {
  ORG_WRITE_CAPABILITIES,
  ORG_LIFECYCLE_STATES,
  ORG_WRITE_CAPABILITY_TABLE,
  lifecycleStateOf,
  ruleFor,
  orgLockQueries,
  orgLockStatements,
  ORG_WRITE_LOCK_NAMESPACE,
  ORG_ARCHIVE_EPOCH_LOCK_NAMESPACE,
  isLiveAttempt,
  liveAttemptSqlCondition,
  assertPermitUsable,
  OrgWritePermitError,
  type OrgWritePermit,
  type LiveAttemptRow,
} from "../src/index";
import { mintPermit, revokePermit } from "../src/permit";

const NOW = { nowMs: Date.parse("2026-07-22T12:00:00Z") };
const FUTURE = new Date(NOW.nowMs + 60_000).toISOString();
const PAST = new Date(NOW.nowMs - 60_000).toISOString();

function liveRow(overrides: Partial<LiveAttemptRow> = {}): LiveAttemptRow {
  return {
    status: "running",
    executionAttemptId: "attempt-1",
    executionDeadlineAt: FUTURE,
    humanWaitAttemptId: null,
    ...overrides,
  };
}

describe("capability table (#1938)", () => {
  it("is total over every state × capability", () => {
    for (const state of ORG_LIFECYCLE_STATES) {
      for (const capability of ORG_WRITE_CAPABILITIES) {
        expect(["allow", "deny", "lease-gated"]).toContain(
          ORG_WRITE_CAPABILITY_TABLE[state][capability],
        );
      }
    }
  });

  it("archived denies everything except lease-gated completion and lifecycle exit", () => {
    expect(ruleFor("archived", "content.write")).toBe("deny");
    expect(ruleFor("archived", "run.execute")).toBe("deny");
    expect(ruleFor("archived", "membership.write")).toBe("deny");
    expect(ruleFor("archived", "org.settings")).toBe("deny");
    expect(ruleFor("archived", "run.complete")).toBe("lease-gated");
    expect(ruleFor("archived", "org.lifecycle")).toBe("allow");
  });

  it("active allows every capability", () => {
    for (const capability of ORG_WRITE_CAPABILITIES) {
      expect(ruleFor("active", capability)).toBe("allow");
    }
  });

  it("derives state from the archive marker", () => {
    expect(lifecycleStateOf({ archivedAt: null })).toBe("active");
    expect(lifecycleStateOf({ archivedAt: new Date() })).toBe("archived");
  });
});

describe("org locks (#1938)", () => {
  it("epoch lock always precedes the write lock (global order)", () => {
    const queries = orgLockQueries({ orgId: "org-1", epoch: true });
    expect(queries).toHaveLength(2);
    expect(queries[0].values[0]).toBe(ORG_ARCHIVE_EPOCH_LOCK_NAMESPACE);
    expect(queries[1].values[0]).toBe(ORG_WRITE_LOCK_NAMESPACE);
    expect(orgLockStatements({ orgId: "org-1", epoch: true })).toHaveLength(2);
  });

  it("write-only requests never touch the epoch namespace", () => {
    const queries = orgLockQueries({ orgId: "org-1", epoch: false });
    expect(queries).toHaveLength(1);
    expect(queries[0].values[0]).toBe(ORG_WRITE_LOCK_NAMESPACE);
  });

  it("uses the two-argument lock space (disjoint from single-key bigint locks)", () => {
    for (const q of orgLockQueries({ orgId: "org-1", epoch: true })) {
      expect(q.text).toContain("pg_advisory_xact_lock(hashtext($1), hashtext($2))");
    }
  });

  it("namespaces are novel (never reused from existing lock sites)", () => {
    expect(ORG_WRITE_LOCK_NAMESPACE).toBe("cinatra-org-write");
    expect(ORG_ARCHIVE_EPOCH_LOCK_NAMESPACE).toBe("cinatra-org-archive-epoch");
    for (const taken of ["cinatra", "cinatra-migrations", "cinatra-team-members"]) {
      expect(ORG_WRITE_LOCK_NAMESPACE).not.toBe(taken);
      expect(ORG_ARCHIVE_EPOCH_LOCK_NAMESPACE).not.toBe(taken);
    }
  });
});

describe("live-attempt predicate (#1938, shared by leases AND authority)", () => {
  it("running and waiting_trigger with a live deadline are live (mid-attempt beyond doubt)", () => {
    for (const status of ["running", "waiting_trigger"]) {
      expect(isLiveAttempt(liveRow({ status }), NOW)).toBe(true);
    }
  });

  it("never-dispatched runs are not live regardless of status", () => {
    expect(
      isLiveAttempt(liveRow({ executionAttemptId: null }), NOW),
    ).toBe(false);
  });

  it("an expired execution deadline kills liveness", () => {
    expect(isLiveAttempt(liveRow({ executionDeadlineAt: PAST }), NOW)).toBe(false);
  });

  it("pending_approval is live ONLY under a matching mid-attempt marker (the one ambiguous state)", () => {
    expect(
      isLiveAttempt(
        liveRow({ status: "pending_approval", humanWaitAttemptId: "attempt-1" }),
        NOW,
      ),
    ).toBe(true);
    // Setup interrupt (queued→pending_approval): marker cleared — parked.
    expect(
      isLiveAttempt(
        liveRow({ status: "pending_approval", humanWaitAttemptId: null }),
        NOW,
      ),
    ).toBe(false);
    // A marker from a PREVIOUS attempt does not carry into a new one.
    expect(
      isLiveAttempt(
        liveRow({ status: "pending_approval", humanWaitAttemptId: "attempt-0" }),
        NOW,
      ),
    ).toBe(false);
  });

  it("parked, pre-dispatch, and terminal states are never live — including queued and ALL pending_input", () => {
    for (const status of [
      "queued",
      "pending_input",
      "completed",
      "failed",
      "stopped",
      "armed",
      "pending_trigger",
    ]) {
      expect(isLiveAttempt(liveRow({ status }), NOW)).toBe(false);
    }
    // Even a (stale) marker cannot make pending_input live — the state is
    // categorically parked (the #1058 human wait fires pre-dispatch).
    expect(
      isLiveAttempt(
        liveRow({ status: "pending_input", humanWaitAttemptId: "attempt-1" }),
        NOW,
      ),
    ).toBe(false);
  });

  it("the SQL condition mirrors the predicate structure (single source)", () => {
    const cond = liveAttemptSqlCondition("r");
    expect(cond).toContain("r.execution_attempt_id IS NOT NULL");
    expect(cond).toContain("r.execution_deadline_at IS NOT NULL AND r.execution_deadline_at > now()");
    expect(cond).toContain("'running','waiting_trigger'");
    expect(cond).toContain("r.status = 'pending_approval'");
    expect(cond).toContain("r.human_wait_attempt_id = r.execution_attempt_id");
  });
});

describe("permit unforgeability (#1938, runtime WeakSet — codex r0 #4)", () => {
  const tx = {};
  const fields = {
    txIdentity: tx,
    orgId: "org-1",
    capability: "content.write" as const,
    archiveEpoch: 0,
  };

  it("a minted, live permit asserts cleanly for its exact binding", () => {
    const permit = mintPermit(fields);
    expect(() => assertPermitUsable(permit, fields)).not.toThrow();
  });

  it("a forged cast fails WeakSet membership", () => {
    const forged = {
      txIdentity: tx,
      orgId: "org-1",
      capability: "content.write",
      archiveEpoch: 0,
    } as unknown as OrgWritePermit;
    expect(() => assertPermitUsable(forged, fields)).toThrow(OrgWritePermitError);
    expect(() => assertPermitUsable(forged, fields)).toThrow(/forged/);
  });

  it("a revoked permit (guard callback exited) is unusable", () => {
    const permit = mintPermit(fields);
    revokePermit(permit);
    expect(() => assertPermitUsable(permit, fields)).toThrow(/already exited/);
  });

  it("binding mismatches are each refused: tx, org, capability, epoch", () => {
    const permit = mintPermit(fields);
    expect(() =>
      assertPermitUsable(permit, { ...fields, txIdentity: {} }),
    ).toThrow(/different transaction/);
    expect(() =>
      assertPermitUsable(permit, { ...fields, orgId: "org-2" }),
    ).toThrow(/different organization/);
    expect(() =>
      assertPermitUsable(permit, { ...fields, capability: "org.settings" }),
    ).toThrow(/different capability/);
    expect(() =>
      assertPermitUsable(permit, { ...fields, archiveEpoch: 1 }),
    ).toThrow(/epoch changed/);
  });

  it("permits are frozen values", () => {
    const permit = mintPermit(fields);
    expect(Object.isFrozen(permit)).toBe(true);
  });
});

describe("null execution deadline is fail-closed (codex diff round)", () => {
  it("a run with no deadline is never live — a bounded window needs a bound", () => {
    expect(
      isLiveAttempt(liveRow({ executionDeadlineAt: null }), NOW),
    ).toBe(false);
    const cond = liveAttemptSqlCondition("r");
    expect(cond).toContain("r.execution_deadline_at IS NOT NULL");
    expect(cond).not.toContain("execution_deadline_at IS NULL OR");
  });
});
