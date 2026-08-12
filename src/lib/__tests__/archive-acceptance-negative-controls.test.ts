/**
 * cinatra#1943 — the RED half of the acceptance suite's red-then-green
 * pairings (no-DB tier).
 *
 * WHY THIS FILE EXISTS. Every row of the archive acceptance manifest asserts
 * that an attack LOSES. An assertion of that shape is only worth the CI
 * minutes it burns if the attack would otherwise WIN: a refusal test whose
 * subject is inert — a purpose nothing grants, a payload no code path would
 * have accepted anyway, a check that a *different* layer already made
 * unreachable — passes forever while proving nothing, and keeps passing after
 * the guard it claims to cover is deleted. That is the exact failure class
 * this program has already been bitten by twice (a test file wired into no
 * workflow; a manifest row green on a proof that never ran).
 *
 * So each test below is a REVERT-STYLE NEGATIVE CONTROL: it re-runs the
 * paired green test's OWN attack payload against the UNPROTECTED path — the
 * same call with the one guard under test removed, bypassed, or evaluated in
 * the state where it does not apply — and asserts the attack LANDS. Green
 * test + control together are the red-then-green pair: the green one shows
 * the guard refuses, this one shows there was something real to refuse.
 *
 * (The suite's rows whose PROOF is a success claim rather than a refusal —
 * the lease settle, the bounded eventual archive — invert the other way:
 * their control shows the same operation REFUSED without its precondition.
 * Those live beside their proofs; the manifest's `negativeControl` field is
 * the index. See the gate script's CONTROL_KIND comment for the full rule.)
 *
 * Each control names its paired green test in a `PAIRS WITH:` line, and the
 * manifest (scripts/audit/archive-acceptance-manifest.json) records the same
 * pairing machine-readably in each row's `negativeControl` — so the coverage
 * gate re-verifies on every run that both halves still exist and are still
 * live test declarations, not prose that rotted.
 *
 * NOTHING HERE MUTATES PRODUCT CODE. A control never patches, monkey-patches
 * or re-exports a guard: it either (a) calls the unguarded entry point that
 * sits one layer below the guard, or (b) re-evaluates the identical payload
 * in the state where the guard's own predicate is false (for an
 * archive-conditioned guard, an ACTIVE org). Both are honest reverts — they
 * are what the code does today with the guard's contribution removed.
 *
 * SCOPE — this file is the no-DB tier, minus the controls that cannot live
 * here. Controls whose green test needs real raced Postgres transactions live
 * adjacent to that test in
 * src/lib/__tests__/integration/org-write-archive-race.integration.test.ts;
 * the packages/agents seam controls live in that package's own suites; and the
 * row-8 control lives in src/lib/org-write/__tests__/ because the kernel
 * boundary gate's R5-job-system-mint rule restricts naming that mint seam to
 * the seam's own test directory. The manifest's `negativeControl` refs are the
 * index of where each one lives — always consult those, not this list.
 *
 * Runs in the root vitest tier (`pnpm test:root`, the
 * perpetual-loops-invariants CI job) — no database, no network.
 */
import { describe, it, expect, vi } from "vitest";
import type { Job } from "bullmq";

vi.mock("server-only", () => ({}));

import {
  isVerifiedRunRef,
  verifyRunAuthority,
  type RunRowForAuthority,
  type VerifiedRunRef,
} from "../org-write/authority";
import { BACKGROUND_JOB_REGISTRY, type JobHandler } from "@/lib/background-jobs-registry";

// ---------------------------------------------------------------------------
// Row 1 — "Forged/ambient run identity refused"
// ---------------------------------------------------------------------------

describe("row 1 negative control — the forged run ref is only refused BECAUSE of the WeakSet brand", () => {
  /** The exact object the green test forges. Kept identical on purpose: a
   *  control that attacks with a *different*, weaker payload would prove
   *  nothing about the green test's payload. */
  function forgedRef(): VerifiedRunRef {
    return {
      orgId: "org-1",
      runId: "run-1",
      executionAttemptId: "att-1",
      can: () => true,
    } as unknown as VerifiedRunRef;
  }

  /**
   * The UNPROTECTED path: structural/duck-typed verification — what a
   * consumer that trusted the object's SHAPE (rather than the module-private
   * WeakSet only `verifyRunAuthority` can add to) would do, and what
   * `isVerifiedRunRef` looked like before the brand. Deliberately spelled out
   * here rather than imported: the point is that this is the implementation
   * the brand REPLACED, so it must not be reachable from product code.
   */
  function shapeOnlyIsVerifiedRunRef(value: unknown): boolean {
    return (
      typeof value === "object" &&
      value !== null &&
      typeof (value as { runId?: unknown }).runId === "string" &&
      typeof (value as { orgId?: unknown }).orgId === "string" &&
      typeof (value as { executionAttemptId?: unknown }).executionAttemptId === "string" &&
      typeof (value as { can?: unknown }).can === "function"
    );
  }

  it("negative control (row 1): a shape-only verifier ACCEPTS the very ref isVerifiedRunRef rejects — the brand, not the shape, is what refuses", () => {
    // PAIRS WITH: src/lib/org-write/__tests__/authority-1938.test.ts
    //   "a cast cannot forge a VerifiedRunRef"
    const forged = forgedRef();

    // The unprotected path admits it: every field is well-typed and `can()`
    // answers yes to everything, so a shape-trusting consumer sees a
    // perfectly valid run authority.
    expect(shapeOnlyIsVerifiedRunRef(forged)).toBe(true);
    expect(forged.can("run.complete")).toBe(true);

    // The guarded path refuses the identical object. The delta between these
    // two lines IS the guard's contribution — remove the WeakSet and the
    // forgery lands.
    expect(isVerifiedRunRef(forged)).toBe(false);
  });

  it("negative control (row 1, completeness): the shape-only verifier accepts a ref for an org/run the caller never proved — a genuinely minted ref carries a DB-verified live attempt", async () => {
    // The forgery is not merely "unbranded": it also asserts an org, a run and
    // an attempt id that nothing checked. The real mint reaches a run row and
    // re-derives all three, so the two paths differ in substance, not
    // bookkeeping. Same live row the #1938 suite uses.
    const NOW = Date.parse("2026-07-23T00:00:00Z");
    const liveRow: RunRowForAuthority = {
      orgId: "org-1",
      status: "running",
      executionAttemptId: "att-1",
      executionDeadlineAt: new Date(NOW + 60_000).toISOString(),
      humanWaitAttemptId: null,
    };
    const minted = await verifyRunAuthority(
      { runId: "run-1", orgId: "org-1", claimedAttemptId: "att-1" },
      { readRunRow: async () => liveRow, nowMs: () => NOW },
    );
    expect(isVerifiedRunRef(minted)).toBe(true);

    // The forged twin is field-for-field indistinguishable to a shape check…
    const forged = forgedRef();
    expect(shapeOnlyIsVerifiedRunRef(forged)).toBe(shapeOnlyIsVerifiedRunRef(minted));
    // …and yet the same claim, made without a live run row, is refused at the
    // mint: the run does not exist. The forgery exists precisely to skip this.
    await expect(
      verifyRunAuthority(
        { runId: "run-1", orgId: "org-1", claimedAttemptId: "att-1" },
        { readRunRow: async () => null, nowMs: () => NOW },
      ),
    ).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// Row 5 — "Platform-admin denial"
//
// Its control needs the REAL kernel guard on a real transaction to contrast
// against, so it lives beside its proof in
// src/lib/__tests__/integration/org-write-archive-race.integration.test.ts
// ("negative control (row 5): the SAME permissive authority, differing ONLY
// in the org it is scoped to, lands the SAME write through the SAME kernel
// guard"). Asserting here that an authority declared `can: () => true`
// returns true would be a tautology, not a control.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Row 6 — "Unclassified job fails closed"
// ---------------------------------------------------------------------------

describe("row 6 negative control — the stripped job is refused by the DISPATCH validator, and its handler is otherwise perfectly runnable", () => {
  it("negative control (row 6): the identically-stripped handler RUNS when invoked directly, bypassing dispatchRegisteredJob's authority check", async () => {
    // PAIRS WITH: src/lib/__tests__/background-jobs-authority-adversarial.test.ts
    //   "a real job's authority stripped post-hoc via Object.assign is refused at
    //    dispatch and never runs its handler"
    //
    // The green test asserts the handler never runs. That is only meaningful
    // if the handler WOULD have run — i.e. if the sole thing stopping it is
    // the classification check `dispatchRegisteredJob` performs, and not some
    // unrelated breakage introduced by the mutation itself.
    //
    // Deliberately does NOT write to BACKGROUND_JOB_REGISTRY: the registry is
    // a shared module singleton, and this control needs no mutation of it —
    // the unprotected path is `handler.handle(...)`, the last line of
    // dispatchRegisteredJob, reached here directly.
    const real: JobHandler = BACKGROUND_JOB_REGISTRY[
      "litellm-pricing-sync" as keyof typeof BACKGROUND_JOB_REGISTRY
    ];
    expect(real.authority).toBeDefined(); // it IS classified in production.

    const handle = vi.fn(async () => {});
    const stripped: JobHandler = Object.assign({}, real, { authority: undefined, handle });
    const job = { name: "litellm-pricing-sync", data: {}, id: "neg-ctrl-6" } as unknown as Job;

    // The unprotected path: the same stripped entry, dispatched without the
    // validator, runs its handler happily. Nothing about the mutation is
    // self-limiting — the guard is the whole defense.
    await stripped.handle(job, "neg-ctrl-6");
    expect(handle).toHaveBeenCalledTimes(1);
  });
});
