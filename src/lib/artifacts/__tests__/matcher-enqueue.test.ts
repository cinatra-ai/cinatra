import { beforeEach, describe, expect, it, vi } from "vitest";

// ARTIFACT_MATCH_RUN enqueue seam (cinatra#1891 scopes 6 + 7). The helper both
// upload-commit (createSemanticArtifact) and agent-emit materialization
// (run-artifact-materializer) route through. Contract:
//   - passes the ARTIFACT_MATCH_RETRY_POLICY (attempts + exponential backoff);
//   - System context (inheritActorContext:false);
//   - deterministic jobId for crash-restart dedup;
//   - best-effort: a queue failure is swallowed, never thrown (never fails the
//     already-committed artifact write).

const enqueueMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: enqueueMock,
}));
vi.mock("@/lib/background-jobs-names", () => ({
  BACKGROUND_JOB_NAMES: { ARTIFACT_MATCH_RUN: "artifact-match-run" },
}));

import {
  enqueueArtifactMatchRun,
  ARTIFACT_MATCH_RETRY_POLICY,
  artifactMatchJobId,
} from "../matcher-enqueue";

describe("enqueueArtifactMatchRun", () => {
  beforeEach(() => {
    enqueueMock.mockReset().mockResolvedValue(undefined);
  });

  it("retry policy is 3 attempts with exponential backoff", () => {
    expect(ARTIFACT_MATCH_RETRY_POLICY.attempts).toBe(3);
    expect(ARTIFACT_MATCH_RETRY_POLICY.backoff).toEqual({
      type: "exponential",
      delay: 5_000,
    });
  });

  it("enqueues ARTIFACT_MATCH_RUN with retry policy, System context, deterministic jobId", async () => {
    await enqueueArtifactMatchRun({
      orgId: "org-a",
      artifactId: "art-1",
      representationRevisionId: "rep-1",
      createdByRunId: "run-9",
    });
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const [name, payload, opts] = enqueueMock.mock.calls[0];
    expect(name).toBe("artifact-match-run");
    expect(payload).toEqual({
      orgId: "org-a",
      artifactId: "art-1",
      representationRevisionId: "rep-1",
      createdByRunId: "run-9",
    });
    expect(opts.attempts).toBe(3);
    expect(opts.backoff).toEqual({ type: "exponential", delay: 5_000 });
    expect(opts.inheritActorContext).toBe(false);
    expect(opts.jobId).toBe("artifact-match__org-a__art-1__rep-1");
  });

  // Regression guard (cinatra#1891 codex round): BullMQ REJECTS a custom jobId
  // that contains ':' unless it splits into EXACTLY three colon components; a
  // four-component colon id throws `Custom Id cannot contain :` inside
  // `queue.add`, which the best-effort catch swallows — silently dropping EVERY
  // enqueue while the mocked enqueue tests above stay green. The dedup jobId
  // must therefore be colon-FREE (or a valid 3-part colon id). Asserting the
  // string shape alone (the original test) did NOT catch this; assert the
  // BullMQ-validity invariant directly.
  it("dedup jobId is BullMQ-valid (colon-free — no silent enqueue drop)", async () => {
    await enqueueArtifactMatchRun({
      orgId: "org-a",
      artifactId: "art-1",
      representationRevisionId: "rep-1",
    });
    const [, , opts] = enqueueMock.mock.calls[0];
    const jobId = opts.jobId as string;
    // The exact BullMQ guard: includes(':') => split(':').length must be 3.
    const bullmqValid = !jobId.includes(":") || jobId.split(":").length === 3;
    expect(bullmqValid).toBe(true);
    expect(jobId).not.toContain(":");
    // Deterministic + carries all three dedup fields.
    expect(jobId).toBe(artifactMatchJobId({
      orgId: "org-a",
      artifactId: "art-1",
      representationRevisionId: "rep-1",
    }));
  });

  it("normalizes a missing createdByRunId to null", async () => {
    await enqueueArtifactMatchRun({
      orgId: "org-a",
      artifactId: "art-1",
      representationRevisionId: "rep-1",
    });
    const [, payload] = enqueueMock.mock.calls[0];
    expect(payload.createdByRunId).toBeNull();
  });

  it("best-effort: a queue failure is SWALLOWED (never throws)", async () => {
    enqueueMock.mockRejectedValue(new Error("redis unavailable"));
    await expect(
      enqueueArtifactMatchRun({
        orgId: "org-a",
        artifactId: "art-1",
        representationRevisionId: "rep-1",
      }),
    ).resolves.toBeUndefined();
  });
});
