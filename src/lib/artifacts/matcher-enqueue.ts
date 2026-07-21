import "server-only";
import type { JobsOptions } from "bullmq";

// ---------------------------------------------------------------------------
// ARTIFACT_MATCH_RUN enqueue seam (epic #1883, slice A3, cinatra#1891).
//
// The meaning-matcher is enqueued at TWO write seams, both POST-COMMIT:
//   1. upload / non-agent creation commit (`createSemanticArtifact`, when the
//      caller has NOT deterministically typed the row — `skipFallbackClassification`
//      false);
//   2. agent-emit materialization (`run-artifact-materializer`) after the
//      artifact + its producer assertion have committed.
//
// Both seams route through THIS helper so the retry policy is single-sourced and
// the enqueue is uniformly best-effort (a failed enqueue must NEVER fail an
// already-committed artifact write — the row simply stays at its structural
// identity until a later reclassification).
//
// RETRY POLICY (cinatra#1891 scope 6 — honest retry semantics). The matcher
// worker's transient failures (LLM provider hiccup, a DB read/write blip) throw
// out of `runArtifactMatch` as `MatcherRetryableError`; BullMQ then retries per
// THIS policy. Terminal conditions (no runtime configured, orphaned row, a
// malformed LLM response for one candidate) resolve cleanly and are NOT retried.
// ---------------------------------------------------------------------------

/** attempts/backoff BullMQ options applied to every ARTIFACT_MATCH_RUN enqueue.
 *  3 attempts (1 initial + 2 retries) with exponential backoff so a transient
 *  provider/DB failure gets a bounded, honest retry instead of the previous
 *  swallow-everything behavior (which made the job single-shot regardless of
 *  the attempts the registry claimed to honor). */
export const ARTIFACT_MATCH_RETRY_POLICY: Pick<JobsOptions, "attempts" | "backoff"> = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
};

export type ArtifactMatchEnqueuePayload = {
  orgId: string;
  artifactId: string;
  representationRevisionId: string;
  createdByRunId?: string | null;
};

/**
 * Deterministic, BullMQ-SAFE dedup jobId for one representation revision.
 *
 * BullMQ (`Job.addJob`) REJECTS a custom jobId that contains ':' UNLESS it
 * splits into EXACTLY three colon components (a legacy repeatable-job carve-out
 * — see bullmq `job.js`: `jobId.includes(':') && jobId.split(':').length !== 3`
 * throws `Custom Id cannot contain :`). A colon id built from org + artifact +
 * representation ids has FOUR components, so `queue.add` throws — and the
 * best-effort catch in `enqueueArtifactMatchRun` would swallow it, silently
 * dropping EVERY matcher enqueue (the whole feature would no-op in prod while
 * the mocked unit tests stayed green). The id is therefore colon-FREE:
 * `artifact-match__<org>__<artifact>__<representation>` (the ids are UUIDs / hex
 * — never containing '__'), preserving crash-restart dedup without tripping the
 * BullMQ guard.
 */
export function artifactMatchJobId(payload: {
  orgId: string;
  artifactId: string;
  representationRevisionId: string;
}): string {
  return `artifact-match__${payload.orgId}__${payload.artifactId}__${payload.representationRevisionId}`;
}

/**
 * Best-effort POST-COMMIT enqueue of the meaning-matcher for one artifact. Never
 * throws — a failed enqueue is logged and swallowed so it cannot roll back or
 * fail the committed creation. The job is enqueued as a SYSTEM context
 * (`inheritActorContext: false`) because the matcher worker anchors its own
 * org-scoped System actor; it must not inherit the uploading user's frame.
 */
export async function enqueueArtifactMatchRun(
  payload: ArtifactMatchEnqueuePayload,
): Promise<void> {
  try {
    const { enqueueBackgroundJob } = await import("@/lib/background-jobs");
    const { BACKGROUND_JOB_NAMES } = await import("@/lib/background-jobs-names");
    await enqueueBackgroundJob(
      BACKGROUND_JOB_NAMES.ARTIFACT_MATCH_RUN,
      {
        orgId: payload.orgId,
        artifactId: payload.artifactId,
        representationRevisionId: payload.representationRevisionId,
        createdByRunId: payload.createdByRunId ?? null,
      },
      {
        ...ARTIFACT_MATCH_RETRY_POLICY,
        // Deterministic jobId so a crash-restart re-enqueue for the same
        // representation revision de-dupes rather than double-classifying.
        jobId: artifactMatchJobId(payload),
        inheritActorContext: false,
      },
    );
  } catch (err) {
    console.warn(
      `[artifact-matcher] enqueue failed for ${payload.artifactId} (creation already committed; row stays at structural identity):`,
      err instanceof Error ? err.message : err,
    );
  }
}
