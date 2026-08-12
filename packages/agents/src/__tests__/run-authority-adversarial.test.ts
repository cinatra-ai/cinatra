/**
 * cinatra#1943 A0 — deep unit-level adversarial cases for "stale-attempt
 * lease reuse denied" / "forged/ambient run identity refused", BEYOND the
 * DB-integration file's coverage (org-write-archive-race.integration.test.ts
 * proves the same refusal against a REAL org_archive_lease row; this file
 * proves the CONSUMPTION seam (`guardedRunWrite`) fails closed even against
 * malformed/type-confused authority shapes a real caller could never
 * construct through the typed `OrgWriteAuthority` interface but a `.ts`
 * cast, a JSON round-trip, or a bug could still smuggle past compile time).
 *
 * Uses the kernel's own exported test fakes (`fakeOrgWriteDb` /
 * `wrapTxWithOrgWriteKernel` from `@cinatra-ai/org-write-kernel/testing`) —
 * no live Postgres, no module mocking of the kernel itself: `guardedRunWrite`
 * and the REAL `guardOrgMutation`/`assertLeaseHeld` it calls both run for
 * real; only the DB layer is faked. This is the same fixture already proven
 * in packages/agents/src/__tests__/org-write-run-seam.test.ts (the
 * missing/org-mismatch/run-mismatch envelope) — this file goes one layer
 * deeper into the LEASE-GATED ruling specifically (run.complete on an
 * archived org), which that file's fixture (`archivedAt: null`, i.e. an
 * ACTIVE org where run.complete is a plain allow) never reaches.
 */
import { describe, it, expect, vi } from "vitest";
import { fakeOrgWriteDb } from "@cinatra-ai/org-write-kernel/testing";
import { guardedRunWrite } from "../org-write-run-seam";

const ORG = "org-1";
const RUN = "run-1";
const OTHER_RUN = "run-OTHER";
const LEASED_ATTEMPT = "att-real-leased";

/** An ARCHIVED-org fake db: run.complete is "lease-gated" in this state
 *  (packages/org-write-kernel/src/capabilities.ts), so every call here
 *  exercises `assertLeaseHeld`, not a plain allow/deny. `leaseHeld` controls
 *  whether the fake's canned lease-query answer reports a match. */
function archivedDb(leaseHeld: boolean) {
  return fakeOrgWriteDb({ organization: { archivedAt: new Date("2026-01-01") }, leaseHeld });
}

describe("guardedRunWrite — adversarial authority shapes (#1943 A0, row 2: stale-attempt lease reuse denied)", () => {
  it("an ambient authority (no run binding) is refused for a lease-gated capability without querying the lease table", async () => {
    const fake = archivedDb(true); // even a fake that WOULD answer "held" must not matter — the
    // undefined-check short-circuits before any lease query.
    const fn = vi.fn(async () => "unreached");
    const ambient = { orgId: ORG, can: () => true }; // no runId, no executionAttemptId
    await expect(
      guardedRunWrite(ambient, { orgId: ORG, runId: RUN, capability: "run.complete", db: fake.db }, fn),
    ).rejects.toMatchObject({ reason: "lease-required-but-not-held" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("a forged execution-attempt id (well-typed but not the leased one) is refused", async () => {
    const fake = archivedDb(false); // the fake's canned answer for THIS scenario: no matching row.
    const fn = vi.fn(async () => "unreached");
    const forged = { orgId: ORG, runId: RUN, executionAttemptId: "att-forged-not-leased", can: () => true };
    await expect(
      guardedRunWrite(forged, { orgId: ORG, runId: RUN, capability: "run.complete", db: fake.db }, fn),
    ).rejects.toMatchObject({ reason: "lease-required-but-not-held" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("a stale/empty-string execution-attempt id is refused, not silently treated as ambient", async () => {
    const fake = archivedDb(false);
    const fn = vi.fn(async () => "unreached");
    // Empty string is a well-typed `string`, so the `=== undefined` presence
    // check passes it through to the (fake) lease query rather than
    // short-circuiting — proving an empty value isn't accidentally treated
    // as "no binding" (which would be a DIFFERENT, less precise refusal
    // reason and could mask a real bug in a future refactor).
    const staleEmpty = { orgId: ORG, runId: RUN, executionAttemptId: "", can: () => true };
    await expect(
      guardedRunWrite(staleEmpty, { orgId: ORG, runId: RUN, capability: "run.complete", db: fake.db }, fn),
    ).rejects.toMatchObject({ reason: "lease-required-but-not-held" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("a type-confused execution-attempt id (null via an unsafe cast) fails closed rather than crashing or silently matching", async () => {
    const fake = archivedDb(false);
    const fn = vi.fn(async () => "unreached");
    // `null` is not a legal `OrgWriteAuthority.executionAttemptId` (typed
    // `string | undefined`) but a JSON round-trip, a loose `as` cast, or a
    // bug upstream could still produce it at runtime. `null !== undefined`,
    // so this does NOT hit the "ambient" short-circuit — it must still
    // refuse cleanly via the lease-gated path, never throw an unrelated
    // TypeError and never silently proceed.
    const typeConfused = {
      orgId: ORG,
      runId: RUN,
      executionAttemptId: null as unknown as string,
      can: () => true,
    };
    await expect(
      guardedRunWrite(typeConfused, { orgId: ORG, runId: RUN, capability: "run.complete", db: fake.db }, fn),
    ).rejects.toMatchObject({ reason: "lease-required-but-not-held" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("an authority for a DIFFERENT run in the same org cannot ride this run's lease-gated capability", async () => {
    // The seam's own run-mismatch check refuses first here (authority.runId
    // is set and differs from opts.runId) — this is the packages/agents
    // SEAM layer's binding, complementing the kernel's own run_id-keyed
    // lease-row match proven against a real lease row in the DB-integration
    // file (both layers independently enforce "this run's authority may
    // never drive a different run").
    const fake = archivedDb(true);
    const fn = vi.fn(async () => "unreached");
    const crossRun = { orgId: ORG, runId: OTHER_RUN, executionAttemptId: LEASED_ATTEMPT, can: () => true };
    await expect(
      guardedRunWrite(crossRun, { orgId: ORG, runId: RUN, capability: "run.complete", db: fake.db }, fn),
    ).rejects.toMatchObject({ reason: "run-mismatch" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("a malformed 'can' predicate fails closed (throws) rather than silently permitting the write", async () => {
    // `can` is required by the `OrgWriteAuthority` interface, but an unsafe
    // cast could still smuggle a non-function through. The kernel calls
    // `authority.can(capability)` directly (guard.ts) — a non-function
    // throws a TypeError, which is fail-CLOSED (the guarded callback never
    // runs) even though the error is not one of the kernel's own typed
    // OrgWriteRefusedError reasons. Documented here as a finding, not fixed:
    // #1943 is a test-authoring lane and does not change kernel/product code.
    const fake = archivedDb(true);
    const fn = vi.fn(async () => "unreached");
    const malformed = { orgId: ORG, runId: RUN, executionAttemptId: LEASED_ATTEMPT, can: undefined as unknown as () => boolean };
    await expect(
      guardedRunWrite(malformed, { orgId: ORG, runId: RUN, capability: "run.complete", db: fake.db }, fn),
    ).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });

  it("positive control: the exact leased run/attempt on an archived org DOES run the guarded body (the gate isn't just permanently closed)", async () => {
    const fake = archivedDb(true);
    const fn = vi.fn(async () => "landed");
    const exact = { orgId: ORG, runId: RUN, executionAttemptId: LEASED_ATTEMPT, can: () => true };
    const result = await guardedRunWrite(
      exact,
      { orgId: ORG, runId: RUN, capability: "run.complete", db: fake.db },
      fn,
    );
    expect(result).toBe("landed");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // cinatra#1943 — REVERT-STYLE NEGATIVE CONTROL for manifest row 2
  // ("Stale-attempt lease reuse denied"). The green test above asserts the
  // forged attempt id is refused and the write body never runs. That claim is
  // only load-bearing if the body WOULD have run — i.e. if `guardedRunWrite`
  // is the sole thing stopping it, and not some incidental breakage in the
  // forged authority itself. This control re-issues the IDENTICAL forged
  // authority and the IDENTICAL write body against the unguarded path: a
  // plain `db.transaction(...)`, which is exactly what an agent-run writer
  // looks like BEFORE it is converted onto this seam (the seam's own header
  // documents that per-writer ratchet). The attack lands there.
  //
  // See src/lib/__tests__/archive-acceptance-negative-controls.test.ts for
  // the rest of the no-DB controls and the rationale in full.
  // -------------------------------------------------------------------------
  it("negative control (row 2): the SAME forged attempt id lands the write when the SAME body runs outside guardedRunWrite — the seam, not the payload, is what refuses", async () => {
    // PAIRS WITH: "a forged execution-attempt id (well-typed but not the leased one) is refused"
    const forged = {
      orgId: ORG,
      runId: RUN,
      executionAttemptId: "att-forged-not-leased",
      can: () => true,
    };
    // Sanity: this is the same payload the green test above refuses, and it is
    // NOT the leased attempt.
    expect(forged.executionAttemptId).not.toBe(LEASED_ATTEMPT);

    // ONE completion body, used by both halves. It records the attempt id it
    // was driven with, so "the write landed" means the FORGED identity was the
    // one that completed the run — not merely that some callback ran.
    const completed: string[] = [];
    const completionBody = async () => {
      completed.push(forged.executionAttemptId);
      return `completed-by:${forged.executionAttemptId}`;
    };

    // GUARDED — the green test's claim, re-pinned here so both halves of the
    // pair sit together: refused, and the body never executes.
    const guardedFake = archivedDb(false); // no matching lease row for the forged id.
    await expect(
      guardedRunWrite(
        forged,
        { orgId: ORG, runId: RUN, capability: "run.complete", db: guardedFake.db },
        completionBody,
      ),
    ).rejects.toMatchObject({ reason: "lease-required-but-not-held" });
    expect(completed).toEqual([]);

    // UNGUARDED — the same body, same forged identity, on a plain transaction:
    // exactly what an agent-run writer looks like BEFORE it is converted onto
    // this seam (the seam's own header documents that per-writer ratchet). No
    // authority is consulted, no lease is re-derived, and the forged attempt
    // completes the run.
    const unguardedFake = archivedDb(false); // identical DB answers.
    const result = await unguardedFake.db.transaction(completionBody);

    expect(result).toBe("completed-by:att-forged-not-leased");
    expect(completed).toEqual(["att-forged-not-leased"]);
  });
});
