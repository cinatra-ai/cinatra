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
 * SCOPE — this file is the no-DB tier. Controls whose green test needs real
 * raced Postgres transactions live adjacent to that test in
 * src/lib/__tests__/integration/org-write-archive-race.integration.test.ts;
 * the packages/agents seam controls live in that package's own suites. The
 * manifest's `negativeControl` refs are the index of where each one lives.
 *
 * Runs in the root vitest tier (`pnpm test:root`, the
 * perpetual-loops-invariants CI job) — no database, no network.
 */
import { describe, it, expect, vi } from "vitest";
import type { Job } from "bullmq";

vi.mock("server-only", () => ({}));

const { logAuditEventMock } = vi.hoisted(() => ({
  logAuditEventMock: vi.fn(async () => undefined),
}));
vi.mock("@/lib/authz/audit", () => ({ logAuditEvent: logAuditEventMock }));

import { ORG_WRITE_CAPABILITIES } from "@cinatra-ai/org-write-kernel";
import type { OrgWriteAuthority, OrgWriteCapability } from "@cinatra-ai/org-write-kernel";
import {
  isVerifiedRunRef,
  verifyRunAuthority,
  OrgWriteAuthorityError,
  type RunRowForAuthority,
  type VerifiedRunRef,
} from "../org-write/authority";
import { mintSystemAuthorityForJob } from "../org-write/job-system-authority-mint";
import { runWithJobFrame } from "@/lib/background-jobs-system-frame";
import {
  BACKGROUND_JOB_REGISTRY,
  type JobAuthorityMetadata,
  type JobHandler,
} from "@/lib/background-jobs-registry";

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
// ("negative control (row 5): …guard mutant with ONLY the org-scope check
// removed…"). Asserting here that an authority declared `can: () => true`
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

// ---------------------------------------------------------------------------
// Row 8 — "Cross-job capability misuse"
// ---------------------------------------------------------------------------

/** Every REAL registry entry that can mint and declares purposes — the same
 *  universe the row-8 sweep walks. */
const MINTABLE_REAL_ENTRIES: ReadonlyArray<[string, JobAuthorityMetadata]> = Object.entries(
  BACKGROUND_JOB_REGISTRY,
)
  .filter(([, handler]) => {
    const a = handler.authority;
    return (
      (a.authorityKind === "system-maintenance" || a.authorityKind === "grandfathered-run") &&
      Array.isArray(a.allowedPurposes) &&
      a.allowedPurposes.length > 0
    );
  })
  .map(([name, handler]) => [name, handler.authority] as [string, JobAuthorityMetadata]);


describe("row 8 negative control — the cross-job attack is stopped by the job's own two declarations, and lands once both are neutralized", () => {
  it("negative control (row 8): the SAME foreign job, purpose, org and payload MINTS real capabilities once its allowedPurposes AND capabilities declarations are both tampered — each check refuses on its own, neither is redundant", async () => {
    // PAIRS WITH: src/lib/org-write/__tests__/job-system-authority-mint-adversarial.test.ts
    //   "every real mintable job refuses every purpose NOT in its own declared allowedPurposes"
    //
    // The principal, the purpose, the org and the payload are held FIXED
    // across all three calls below — the only thing that changes is the job's
    // OWN authority declaration, which is precisely the guard. That is the
    // revert: the sweep's refusal is caused by those declarations, not by the
    // purpose being inert, retired, or unreachable for this job by some other
    // route. (Contrast a control that switched to the job which legitimately
    // owns the purpose: that changes the principal, so it shows the purpose is
    // alive but never shows the cross-job attack succeeding.)
    const ORG = "org-neg-ctrl-8";

    const PURPOSE = "lease-expiry-finalizer";
    // The capability that purpose actually grants — asserted at step 3 below,
    // and required ABSENT from the foreign job's ceiling so step 2 genuinely
    // refuses on the ceiling rather than passing through.
    const PURPOSE_GRANT = "run.lease-expire";

    // Select the foreign job by the EXACT properties this control needs, not
    // by registry order: a newly inserted first entry must not silently change
    // what is being tested (it would either mint at step 2 — because its
    // ceiling already covers the grant — or refuse for org-mismatch instead of
    // the ceiling, and the test would still be green while proving something
    // else). If no such job exists any more, this fails loudly and the pairing
    // gets re-derived deliberately.
    const foreign = MINTABLE_REAL_ENTRIES.find(
      ([, a]) =>
        !(a.allowedPurposes ?? []).includes(PURPOSE) &&
        !((a.capabilities ?? []) as readonly string[]).includes(PURPOSE_GRANT) &&
        a.orgExtractor?.source !== "payload",
    );
    expect(
      foreign,
      `expected a real mintable job that (a) does not declare "${PURPOSE}", (b) does not already ` +
        `hold "${PURPOSE_GRANT}" in its ceiling, and (c) is not payload-org-bound`,
    ).toBeDefined();
    const [foreignJobName, foreignAuthority] = foreign!;
    const payload = foreignAuthority.runExtractor ? { runId: "run-neg-ctrl-8" } : {};

    const mintUnder = (authority: JobAuthorityMetadata) =>
      Promise.resolve(
        runWithJobFrame(
          { jobName: foreignJobName, jobId: "neg-ctrl-8", authority, payload },
          () => {
            try {
              const minted = mintSystemAuthorityForJob(PURPOSE, ORG);
              return {
                minted: true as const,
                grants: ORG_WRITE_CAPABILITIES.filter((c) => minted.can(c)),
                orgId: minted.orgId,
              };
            } catch (err) {
              return { minted: false as const, error: err };
            }
          },
        ),
      );

    // 1. UNTAMPERED — the green sweep's own claim: refused by the
    //    allowedPurposes membership check.
    const untampered = await mintUnder(foreignAuthority);
    expect(untampered.minted).toBe(false);
    expect((untampered as { error: unknown }).error).toBeInstanceOf(OrgWriteAuthorityError);
    expect(String((untampered as { error: Error }).error.message)).toContain("allowedPurposes");

    // 2. MEMBERSHIP CHECK NEUTRALIZED (allowedPurposes tampered to include the
    //    foreign purpose) — STILL refused, now by the independent capability
    //    ceiling. Proves the two declarations are not one check spelled twice.
    const purposesTampered: JobAuthorityMetadata = Object.assign({}, foreignAuthority, {
      allowedPurposes: [...(foreignAuthority.allowedPurposes ?? []), PURPOSE],
    });
    const half = await mintUnder(purposesTampered);
    expect(half.minted).toBe(false);
    expect(String((half as { error: Error }).error.message)).toContain("ceiling");

    // 3. BOTH NEUTRALIZED — the attack LANDS. Same job, same purpose, same
    //    org, same payload: a cross-job mint that yields real, non-empty
    //    power. So the sweep in the green test is guarding something that
    //    genuinely works once the guard is gone.
    const bothTampered: JobAuthorityMetadata = Object.assign({}, purposesTampered, {
      capabilities: [...ORG_WRITE_CAPABILITIES],
    });
    const landed = await mintUnder(bothTampered);
    expect(landed.minted).toBe(true);
    expect((landed as { grants: string[] }).grants).toContain(PURPOSE_GRANT);
    expect((landed as { orgId: string }).orgId).toBe(ORG);
  });
});
