// cinatra#1943 A0 — adversarial variant of the #1941 S1 "unclassified job
// fails closed" proof (src/lib/__tests__/background-jobs-authority-classification.test.ts's
// "runtime fail-closed guard" describe block). That landed test proves the
// runtime guard against a SYNTHETIC fake registry key that never had
// `authority` to begin with. This file proves the RUNTIME arm protects a
// REAL, already-classified production job entry too: something reaching in
// and stripping/corrupting `authority` on an EXISTING entry post-hoc (a
// shared-reference mutation bug, a hot-patch, test pollution from another
// suite) is caught exactly the same way — not just a contrived new key that
// was never wired to compile-time coverage in the first place.

import { describe, it, expect, vi, afterEach } from "vitest";
import type { Job } from "bullmq";

vi.mock("server-only", () => ({}));

import {
  BACKGROUND_JOB_REGISTRY,
  dispatchRegisteredJob,
  UnclassifiedBackgroundJobError,
  type JobHandler,
} from "@/lib/background-jobs-registry";
import { BACKGROUND_JOB_NAMES } from "@/lib/background-jobs-names";

// A real, currently no-org-write-classified job (see the #1941 S1 per-row
// snapshot test) — any real registry entry works for this proof; this one is
// picked because it is a simple no-org-write job with no payload
// side effects relevant to the assertion.
const REAL_JOB_NAME = BACKGROUND_JOB_NAMES.LITELLM_PRICING_SYNC;

// A SECOND, untouched real job — the positive control proving the mutation
// below is scoped to the one entry, not a global registry break.
const UNTOUCHED_JOB_NAME = BACKGROUND_JOB_NAMES.SKILL_MATCH_DRIFT_SAMPLE;

describe("background-jobs authority — adversarial runtime mutation of a REAL registry entry (#1943 A0, row 6)", () => {
  const registry = BACKGROUND_JOB_REGISTRY as unknown as Record<string, JobHandler>;
  let original: JobHandler;

  afterEach(() => {
    // Restore the exact original entry — BACKGROUND_JOB_REGISTRY is a
    // shared module-level singleton; leaking a mutation here would corrupt
    // every other suite that imports it.
    registry[REAL_JOB_NAME] = original;
    vi.restoreAllMocks();
  });

  it("a real job's authority stripped post-hoc via Object.assign is refused at dispatch and never runs its handler", async () => {
    original = registry[REAL_JOB_NAME];
    expect(original.authority).toBeDefined(); // sanity: it WAS classified before the attack.

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handle = vi.fn(async () => {});
    const mutated: JobHandler = Object.assign({}, original, { authority: undefined, handle });
    registry[REAL_JOB_NAME] = mutated;

    const job = { name: REAL_JOB_NAME, data: {}, id: "adv-job-1" } as unknown as Job;
    await expect(dispatchRegisteredJob(job, "adv-job-1")).rejects.toBeInstanceOf(
      UnclassifiedBackgroundJobError,
    );
    expect(handle).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
  });

  it("a real job's authority corrupted to a bogus authorityKind post-hoc is refused at dispatch", async () => {
    original = registry[REAL_JOB_NAME];
    vi.spyOn(console, "error").mockImplementation(() => {});
    const handle = vi.fn(async () => {});
    const mutated: JobHandler = Object.assign({}, original, {
      authority: { authorityKind: "totally-bogus-kind" },
      handle,
    });
    registry[REAL_JOB_NAME] = mutated;

    const job = { name: REAL_JOB_NAME, data: {}, id: "adv-job-2" } as unknown as Job;
    await expect(dispatchRegisteredJob(job, "adv-job-2")).rejects.toBeInstanceOf(
      UnclassifiedBackgroundJobError,
    );
    expect(handle).not.toHaveBeenCalled();
  });

  it("an unrelated real job dispatches normally while the mutated entry is refused (the guard is scoped, not globally broken)", async () => {
    original = registry[REAL_JOB_NAME];
    vi.spyOn(console, "error").mockImplementation(() => {});
    registry[REAL_JOB_NAME] = Object.assign({}, original, { authority: undefined });

    // The mutated job still refuses…
    const mutatedJob = { name: REAL_JOB_NAME, data: {}, id: "adv-job-3a" } as unknown as Job;
    await expect(dispatchRegisteredJob(mutatedJob, "adv-job-3a")).rejects.toBeInstanceOf(
      UnclassifiedBackgroundJobError,
    );

    // …while a DIFFERENT, untouched real job's authority is still intact and
    // dispatches through the validator normally (proves the attack is
    // scoped to the one entry we mutated, not a registry-wide regression).
    const untouched = registry[UNTOUCHED_JOB_NAME];
    expect(untouched.authority).toBeDefined();
    const untouchedHandle = vi.fn(async () => {});
    registry[UNTOUCHED_JOB_NAME] = Object.assign({}, untouched, { handle: untouchedHandle });
    try {
      const untouchedJob = { name: UNTOUCHED_JOB_NAME, data: {}, id: "adv-job-3b" } as unknown as Job;
      await dispatchRegisteredJob(untouchedJob, "adv-job-3b");
      expect(untouchedHandle).toHaveBeenCalledTimes(1);
    } finally {
      registry[UNTOUCHED_JOB_NAME] = untouched;
    }
  });
});
