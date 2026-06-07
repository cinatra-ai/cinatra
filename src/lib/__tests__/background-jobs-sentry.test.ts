import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock @sentry/nextjs before importing the helper. The helper uses dynamic
// `import("@sentry/nextjs")`, so vi.mock here intercepts that path.
vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

// The Sentry helper is what the worker.on('failed') hook in
// src/lib/background-jobs.ts dynamically imports and calls. This test
// verifies the helper's tagging contract directly — the same contract the
// failed hook depends on. We don't spin up a BullMQ Worker.
// captureBackgroundJobError lives in @cinatra-ai/errors/server. The `../sentry`
// shim re-exports it, but the test points directly at the package for clarity.
// This file does NOT import @/lib/background-jobs — it tests the helper contract
// directly — so it needs no @/lib/notifications-host no-op mock.
import { captureBackgroundJobError } from "@cinatra-ai/errors/server";

describe("captureBackgroundJobError (BullMQ failed hook)", () => {
  const originalDsn = process.env.SENTRY_DSN;

  beforeEach(() => {
    process.env.SENTRY_DSN = "https://abc@example.com/1";
  });

  afterEach(() => {
    if (originalDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = originalDsn;
    vi.clearAllMocks();
  });

  it("tags the captured exception with jobName, jobId, queueName", async () => {
    const sentry = await import("@sentry/nextjs");
    const capture = vi.mocked(sentry.captureException);
    const err = new Error("worker failed");

    await captureBackgroundJobError(err, {
      jobName: "blog-post-idea-generation",
      jobId: "j-42",
      queueName: "cinatra-bg-test",
    });

    expect(capture).toHaveBeenCalledTimes(1);
    const [thrown, options] = capture.mock.calls[0]!;
    expect(thrown).toBe(err);
    expect(options).toMatchObject({
      tags: {
        component: "background-jobs",
        jobName: "blog-post-idea-generation",
        jobId: "j-42",
        queueName: "cinatra-bg-test",
      },
    });
  });

  it("emits 'unknown' fallbacks when metadata fields are missing", async () => {
    const sentry = await import("@sentry/nextjs");
    const capture = vi.mocked(sentry.captureException);
    await captureBackgroundJobError(new Error("x"), {});
    const [, options] = capture.mock.calls[0]!;
    expect(options).toMatchObject({
      tags: {
        jobName: "unknown",
        jobId: "unknown",
        queueName: "unknown",
      },
    });
  });

  it("is a no-op when SENTRY_DSN is unset", async () => {
    delete process.env.SENTRY_DSN;
    // Force reset of the lazy-loaded sentry namespace so the unset DSN takes
    // effect on this call (the helper caches the result of getSentry()).
    vi.resetModules();
    const { captureBackgroundJobError: freshHelper } = await import(
      "@cinatra-ai/errors/server"
    );
    const sentry = await import("@sentry/nextjs");
    const capture = vi.mocked(sentry.captureException);
    capture.mockClear();

    await freshHelper(new Error("ignored"), { jobName: "x", jobId: "y" });
    expect(capture).not.toHaveBeenCalled();
  });

  it("swallows internal Sentry errors instead of throwing", async () => {
    const sentry = await import("@sentry/nextjs");
    const capture = vi.mocked(sentry.captureException);
    capture.mockImplementationOnce(() => {
      throw new Error("sentry-internal-boom");
    });

    await expect(
      captureBackgroundJobError(new Error("worker err"), {
        jobName: "x",
        jobId: "y",
      }),
    ).resolves.toBeUndefined();
  });
});
