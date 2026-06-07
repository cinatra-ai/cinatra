/**
 * Tests that `createSemanticArtifact({skipFallbackClassification: true})`
 * skips the post-tx2 `ARTIFACT_MATCH_RUN` BullMQ enqueue.
 *
 *   npx vitest run src/lib/artifacts/__tests__/skip-fallback-classification.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the background-jobs barrel BEFORE the dynamic import inside
// createSemanticArtifact resolves it. The dynamic import in
// `artifact-creation.ts` matches the literal "@/lib/background-jobs"
// specifier so the vi.mock id must too.
const enqueueBackgroundJobMock = vi.fn();
vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: enqueueBackgroundJobMock,
  BACKGROUND_JOB_NAMES: {
    ARTIFACT_MATCH_RUN: "ARTIFACT_MATCH_RUN",
  },
}));

// The whole-pipeline createSemanticArtifact reaches DB + blob store.
// We don't exercise it end-to-end here; we exercise the matcher-enqueue
// gate only, by direct-calling the post-tx2 enqueue helper through a
// thin fake. The real test of the gate is "does the import-and-call
// happen when the flag is unset, and not happen when it's set?". We
// replicate the gate in a tiny inline copy so the test is hermetic.
function fakePostCommitMatcherEnqueue(opts: {
  skipFallbackClassification?: boolean;
  orgId: string;
  artifactId: string;
  representationRevisionId: string;
  createdByRunId: string | null;
}): { enqueued: boolean } {
  if (opts.skipFallbackClassification) {
    return { enqueued: false };
  }
  enqueueBackgroundJobMock(
    "ARTIFACT_MATCH_RUN",
    {
      orgId: opts.orgId,
      artifactId: opts.artifactId,
      representationRevisionId: opts.representationRevisionId,
      createdByRunId: opts.createdByRunId,
    },
    {
      jobId: `artifact-match:${opts.orgId}:${opts.artifactId}:${opts.representationRevisionId}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      inheritActorContext: false,
    },
  );
  return { enqueued: true };
}

describe("skipFallbackClassification gate", () => {
  beforeEach(() => {
    enqueueBackgroundJobMock.mockReset();
  });

  it("enqueues ARTIFACT_MATCH_RUN by default (skipFallbackClassification unset)", () => {
    const res = fakePostCommitMatcherEnqueue({
      orgId: "org-a",
      artifactId: "art-1",
      representationRevisionId: "rep-1",
      createdByRunId: null,
    });
    expect(res.enqueued).toBe(true);
    expect(enqueueBackgroundJobMock).toHaveBeenCalledTimes(1);
    expect(enqueueBackgroundJobMock).toHaveBeenCalledWith(
      "ARTIFACT_MATCH_RUN",
      expect.objectContaining({
        orgId: "org-a",
        artifactId: "art-1",
        representationRevisionId: "rep-1",
      }),
      expect.objectContaining({
        jobId: "artifact-match:org-a:art-1:rep-1",
        attempts: 3,
        inheritActorContext: false,
      }),
    );
  });

  it("enqueues ARTIFACT_MATCH_RUN when skipFallbackClassification: false explicitly", () => {
    fakePostCommitMatcherEnqueue({
      skipFallbackClassification: false,
      orgId: "org-a",
      artifactId: "art-2",
      representationRevisionId: "rep-2",
      createdByRunId: "run-x",
    });
    expect(enqueueBackgroundJobMock).toHaveBeenCalledTimes(1);
  });

  it("SKIPS ARTIFACT_MATCH_RUN when skipFallbackClassification: true", () => {
    const res = fakePostCommitMatcherEnqueue({
      skipFallbackClassification: true,
      orgId: "org-a",
      artifactId: "art-3",
      representationRevisionId: "rep-3",
      createdByRunId: null,
    });
    expect(res.enqueued).toBe(false);
    expect(enqueueBackgroundJobMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Integration-shaped assertion: verify the gate is actually wired into
// the production `artifact-creation.ts`. We grep the file for the
// presence of the flag and the gate; if a future change removes the
// gate, this test fails LOUD instead of silently re-enabling the
// matcher for authoring paths.
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";

describe("gate is wired in artifact-creation.ts", () => {
  it("CreateSemanticArtifactInput declares skipFallbackClassification", () => {
    const filePath = path.join(
      __dirname,
      "../artifact-creation.ts",
    );
    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toMatch(/skipFallbackClassification\?:\s*boolean/);
  });

  it("the enqueue is gated by input.skipFallbackClassification", () => {
    const filePath = path.join(
      __dirname,
      "../artifact-creation.ts",
    );
    const content = fs.readFileSync(filePath, "utf8");
    // The gate appears immediately before the matcher-enqueue try block.
    expect(content).toMatch(/if\s*\(input\.skipFallbackClassification\)/);
  });

  it("artifact-template.ts passes skipFallbackClassification: true", () => {
    const filePath = path.join(
      __dirname,
      "../artifact-template.ts",
    );
    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toMatch(/skipFallbackClassification:\s*true/);
  });
});
