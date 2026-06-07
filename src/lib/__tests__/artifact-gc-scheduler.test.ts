import { describe, it, expect, vi, beforeEach } from "vitest";
import { DelayedError } from "bullmq";

// Unit tests for the ARTIFACT_PROVIDER_CACHE_EVICT scheduled job.
//
// SCOPE NOTES:
//   - The sibling `ARTIFACT_RESOURCE_GC` scheduler remains inactive:
//     enabling it before pin/representation writers share the
//     resource-level advisory lock would expose the known GC vs
//     pin-INSERT race window.
//   - The handler re-delays the canonical loop job in place via
//     `job.moveToDelayed` (graphiti pattern), NOT a fresh
//     `enqueueBackgroundJob` successor. We drive the dispatcher with a mock
//     job exposing `moveToDelayed` + `token`, so both branches are asserted
//     directly: a non-canonical id runs the sweep once and dies
//     (run-once-and-die drain), and the canonical id re-delays + throws
//     DelayedError.

const {
  evictExpiredProviderFilesMock,
  listOrgProvidersWithExpiredCacheMock,
  orchestrateDeleteFileMock,
} = vi.hoisted(() => ({
  evictExpiredProviderFilesMock: vi.fn(),
  listOrgProvidersWithExpiredCacheMock: vi.fn(),
  orchestrateDeleteFileMock: vi.fn(),
}));

vi.mock("@/lib/artifacts/provider-file-cache", () => ({
  evictExpiredProviderFiles: evictExpiredProviderFilesMock,
  listOrgProvidersWithExpiredCache: listOrgProvidersWithExpiredCacheMock,
}));

vi.mock("@cinatra-ai/llm", () => ({
  deleteFile: orchestrateDeleteFileMock,
}));

import {
  ARTIFACT_PROVIDER_CACHE_EVICT_LOOP_JOB_ID,
  BACKGROUND_JOB_NAMES,
  __dispatchBackgroundJobForTests as dispatchBackgroundJob,
} from "@/lib/background-jobs";

function makeJob(
  name: string,
  overrides?: { id?: string; moveToDelayed?: (...args: unknown[]) => unknown },
) {
  return {
    name,
    data: {},
    id: overrides?.id ?? "test-job",
    token: "test-token",
    moveToDelayed: overrides?.moveToDelayed ?? vi.fn(),
  } as Parameters<typeof dispatchBackgroundJob>[0];
}

describe("ARTIFACT_PROVIDER_CACHE_EVICT scheduled job", () => {
  beforeEach(() => {
    listOrgProvidersWithExpiredCacheMock.mockReset();
    evictExpiredProviderFilesMock.mockReset();
    orchestrateDeleteFileMock.mockReset();
  });

  it("iterates every (orgId, provider) pair returned by the enumerator", async () => {
    listOrgProvidersWithExpiredCacheMock.mockReturnValue([
      { orgId: "org-a", provider: "openai" },
      { orgId: "org-b", provider: "anthropic" },
      { orgId: "org-c", provider: "gemini" },
    ]);
    evictExpiredProviderFilesMock.mockResolvedValue({
      reaped: 1,
      remoteDeleteFailures: 0,
    });
    await dispatchBackgroundJob(
      makeJob(BACKGROUND_JOB_NAMES.ARTIFACT_PROVIDER_CACHE_EVICT),
    );
    expect(evictExpiredProviderFilesMock).toHaveBeenCalledTimes(3);
    const calls = evictExpiredProviderFilesMock.mock.calls.map(
      (c) => c[0] as { orgId: string; provider: string },
    );
    expect(calls.map((c) => c.orgId)).toEqual(["org-a", "org-b", "org-c"]);
    expect(calls.map((c) => c.provider)).toEqual([
      "openai",
      "anthropic",
      "gemini",
    ]);
  });

  it("a single failing pair does NOT abort the rest of the sweep", async () => {
    listOrgProvidersWithExpiredCacheMock.mockReturnValue([
      { orgId: "org-a", provider: "openai" },
      { orgId: "org-b", provider: "openai" },
      { orgId: "org-c", provider: "openai" },
    ]);
    evictExpiredProviderFilesMock
      .mockResolvedValueOnce({ reaped: 1, remoteDeleteFailures: 0 })
      .mockRejectedValueOnce(new Error("middle pair failed"))
      .mockResolvedValueOnce({ reaped: 2, remoteDeleteFailures: 0 });
    await dispatchBackgroundJob(
      makeJob(BACKGROUND_JOB_NAMES.ARTIFACT_PROVIDER_CACHE_EVICT),
    );
    // All three pairs MUST be attempted — the loop does not abort.
    expect(evictExpiredProviderFilesMock).toHaveBeenCalledTimes(3);
  });

  it("an unknown provider's deleteRemote is a no-op (never calls deleteFile)", async () => {
    listOrgProvidersWithExpiredCacheMock.mockReturnValue([
      { orgId: "org-a", provider: "some-future-provider" },
    ]);
    evictExpiredProviderFilesMock.mockImplementation(async (input) => {
      // Drive the inner loop's deleteRemote callback once.
      await input.deleteRemote("file_xyz");
      return { reaped: 1, remoteDeleteFailures: 0 };
    });
    await dispatchBackgroundJob(
      makeJob(BACKGROUND_JOB_NAMES.ARTIFACT_PROVIDER_CACHE_EVICT),
    );
    expect(orchestrateDeleteFileMock).not.toHaveBeenCalled();
  });

  it("a known provider's deleteRemote routes through deleteFile", async () => {
    listOrgProvidersWithExpiredCacheMock.mockReturnValue([
      { orgId: "org-a", provider: "anthropic" },
    ]);
    evictExpiredProviderFilesMock.mockImplementation(async (input) => {
      await input.deleteRemote("file_anth_123");
      return { reaped: 1, remoteDeleteFailures: 0 };
    });
    orchestrateDeleteFileMock.mockResolvedValue(undefined);
    await dispatchBackgroundJob(
      makeJob(BACKGROUND_JOB_NAMES.ARTIFACT_PROVIDER_CACHE_EVICT),
    );
    expect(orchestrateDeleteFileMock).toHaveBeenCalledWith({
      id: "file_anth_123",
      provider: "anthropic",
    });
  });

  it("aggregates remoteDeleteFailures across pairs and warns when non-zero", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    listOrgProvidersWithExpiredCacheMock.mockReturnValue([
      { orgId: "org-a", provider: "openai" },
      { orgId: "org-b", provider: "anthropic" },
    ]);
    evictExpiredProviderFilesMock
      .mockResolvedValueOnce({ reaped: 5, remoteDeleteFailures: 2 })
      .mockResolvedValueOnce({ reaped: 3, remoteDeleteFailures: 3 });
    await dispatchBackgroundJob(
      makeJob(BACKGROUND_JOB_NAMES.ARTIFACT_PROVIDER_CACHE_EVICT),
    );
    // 2 + 3 = 5 failures total across 8 reaped rows; the warn line
    // must surface those numbers (else operators never see a broken
    // provider SDK route).
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/5 of 8 remote deletes FAILED/),
    );
    warnSpy.mockRestore();
  });

  it("does NOT warn when there are zero remote-delete failures", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    listOrgProvidersWithExpiredCacheMock.mockReturnValue([
      { orgId: "org-a", provider: "openai" },
    ]);
    evictExpiredProviderFilesMock.mockResolvedValue({
      reaped: 4,
      remoteDeleteFailures: 0,
    });
    await dispatchBackgroundJob(
      makeJob(BACKGROUND_JOB_NAMES.ARTIFACT_PROVIDER_CACHE_EVICT),
    );
    const warnCalls = warnSpy.mock.calls.filter((c) =>
      typeof c[0] === "string" &&
      (c[0] as string).includes("remote deletes FAILED"),
    );
    expect(warnCalls).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it("an anonymous duplicate (non-canonical id) runs the sweep once and does NOT reschedule", async () => {
    listOrgProvidersWithExpiredCacheMock.mockReturnValue([
      { orgId: "org-a", provider: "openai" },
    ]);
    evictExpiredProviderFilesMock.mockResolvedValue({
      reaped: 1,
      remoteDeleteFailures: 0,
    });
    const moveToDelayed = vi.fn();
    await dispatchBackgroundJob(
      makeJob(BACKGROUND_JOB_NAMES.ARTIFACT_PROVIDER_CACHE_EVICT, {
        id: "anonymous-duplicate-xyz",
        moveToDelayed,
      }),
    );
    // The sweep still runs once for a legacy/anonymous duplicate...
    expect(evictExpiredProviderFilesMock).toHaveBeenCalledTimes(1);
    // ...but a non-canonical id must NOT perpetuate the loop. This is the
    // run-once-and-die guard that drains the pre-fix queue storm.
    expect(moveToDelayed).not.toHaveBeenCalled();
  });

  it("the canonical loop job re-delays in place via moveToDelayed and throws DelayedError", async () => {
    listOrgProvidersWithExpiredCacheMock.mockReturnValue([]);
    const moveToDelayed = vi.fn().mockResolvedValue(undefined);
    const job = makeJob(BACKGROUND_JOB_NAMES.ARTIFACT_PROVIDER_CACHE_EVICT, {
      id: ARTIFACT_PROVIDER_CACHE_EVICT_LOOP_JOB_ID,
      moveToDelayed,
    });
    // BullMQ v5 contract: a successful moveToDelayed from an active processor
    // is followed by a thrown DelayedError so the worker acknowledges the move
    // (and does not also complete/fail the now-delayed job).
    await expect(dispatchBackgroundJob(job)).rejects.toBeInstanceOf(
      DelayedError,
    );
    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    const [whenMs, token] = moveToDelayed.mock.calls[0] as [number, string];
    // Re-delayed ~4h out, using the job token to release the active slot.
    expect(token).toBe("test-token");
    expect(whenMs).toBeGreaterThan(Date.now() + 3 * 60 * 60 * 1000);
  });
});
