import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActorContext } from "@/lib/authz/actor-context";

// Verify the auto-attribution cascade in `enqueueBackgroundJob`. We don't spin
// up BullMQ; we mock the queue/runtime and assert `__actorContext` on the
// payload that lands in `queue.add()`.

const queueAddMock = vi.fn().mockResolvedValue({ id: "j-1" });
const ensureRuntimeMock = vi.fn(() => ({
  queue: { add: queueAddMock },
  waitUntilReady: Promise.resolve(),
}));

// background-jobs.ts uses an internal getRuntime() for skipWorker paths and
// ensureBackgroundJobRuntime() for the worker-attached path. We patch the
// module-level runtime accessor by mocking BullMQ's Queue + Worker to return
// our queueAddMock-backed shim.
vi.mock("bullmq", () => {
  // Queue / Worker / QueueEvents are constructed with `new`, so the mocks
  // need to be class-shaped (vi.fn() factory works as a constructor only
  // when invoked without `new`; calling with `new` requires a real class).
  class FakeQueue {
    add = queueAddMock;
    getJob = vi.fn().mockResolvedValue(null);
    waitUntilReady = vi.fn().mockResolvedValue(undefined);
    close = vi.fn();
  }
  class FakeWorker {
    on() {
      return this;
    }
    waitUntilReady() {
      return Promise.resolve(undefined);
    }
    close() {
      return Promise.resolve();
    }
  }
  class FakeQueueEvents {
    on() {
      return this;
    }
    close() {
      return Promise.resolve();
    }
  }
  return { Queue: FakeQueue, Worker: FakeWorker, QueueEvents: FakeQueueEvents };
});

vi.mock("ioredis", () => {
  // IORedis is constructed with `new IORedis(url, options)`, so the default
  // export must be a class-shaped constructor — a bare function returning
  // an object does not satisfy `new`.
  return {
    default: class FakeIORedis {
      on() {
        return this;
      }
      quit() {
        return Promise.resolve("OK");
      }
    },
  };
});

// The cascade's tier-2 source: getActorContext() from @cinatra-ai/llm.
let alsCurrent: ActorContext | undefined;
vi.mock("@cinatra-ai/llm", async () => {
  const actual =
    await vi.importActual<typeof import("@cinatra-ai/llm")>(
      "@cinatra-ai/llm",
    );
  return {
    ...actual,
    getActorContext: () => alsCurrent,
  };
});

// The cascade's tier-3 source: request-actor helper. We mock it so we can
// drive the headers()/session path without standing up Next.
//
// background-jobs.ts dynamically imports @cinatra-ai/notifications/server for
// request actor resolution. Mock that module directly so this test intercepts
// `resolveRequestActorContext` instead of silently exercising the real
// resolver. Use a single partial mock with importOriginal() to override only
// `resolveRequestActorContext`, leaving the rest of the /server surface intact.
const requestActorMock = vi.fn<() => Promise<ActorContext | undefined>>();
vi.mock("@cinatra-ai/notifications/server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@cinatra-ai/notifications/server")>();
  return {
    ...actual,
    resolveRequestActorContext: () => requestActorMock(),
  };
});

// background-jobs.ts has a top-level side-effect import of
// @/lib/notifications-host, which registers the host adapters for the worker
// /server path. No-op it here so this pure unit test does not run real host
// wiring (DB / auth) on module load.
vi.mock("@/lib/notifications-host", () => ({}));

import { BACKGROUND_JOB_NAMES, enqueueBackgroundJob } from "../background-jobs";

const humanUserCtx: ActorContext = {
  principalType: "HumanUser",
  principalId: "u-from-als",
  organizationId: "org-1",
  platformRole: "member",
  orgRole: "member",
  authSource: "ui",
  policyVersion: "v2",
};

const serviceAcctCtx: ActorContext = {
  principalType: "ServiceAccount",
  principalId: "svc-1",
  organizationId: "org-1",
  platformRole: "member",
  orgRole: "member",
  authSource: "worker",
  policyVersion: "v2",
};

function lastPayload(): { __actorContext?: ActorContext } | undefined {
  const calls = queueAddMock.mock.calls;
  if (!calls.length) return undefined;
  return calls[calls.length - 1]![1] as { __actorContext?: ActorContext };
}

beforeEach(() => {
  queueAddMock.mockClear();
  ensureRuntimeMock.mockClear();
  requestActorMock.mockReset();
  requestActorMock.mockResolvedValue(undefined);
  alsCurrent = undefined;
});

describe("enqueueBackgroundJob auto-attribution cascade", () => {
  it("explicit options.actorContext wins over ALS and request fallbacks", async () => {
    alsCurrent = humanUserCtx; // would be picked up by tier-2
    requestActorMock.mockResolvedValue(humanUserCtx); // tier-3
    const explicit: ActorContext = { ...humanUserCtx, principalId: "u-explicit" };
    await enqueueBackgroundJob(
      BACKGROUND_JOB_NAMES.BLOG_POST_IMAGE_REGENERATION,
      { foo: 1 },
      { actorContext: explicit, skipWorker: true, jobId: "test-explicit" },
    );
    expect(lastPayload()?.__actorContext).toEqual(explicit);
    expect(requestActorMock).not.toHaveBeenCalled();
  });

  it("inherits a HumanUser ALS frame when no explicit context", async () => {
    alsCurrent = humanUserCtx;
    await enqueueBackgroundJob(
      BACKGROUND_JOB_NAMES.BLOG_POST_IMAGE_REGENERATION,
      { foo: 2 },
      { skipWorker: true, jobId: "test-als-human" },
    );
    expect(lastPayload()?.__actorContext).toEqual(humanUserCtx);
    expect(requestActorMock).not.toHaveBeenCalled();
  });

  it("does NOT inherit a non-HumanUser ALS frame (no silent ServiceAccount leakage)", async () => {
    alsCurrent = serviceAcctCtx;
    await enqueueBackgroundJob(
      BACKGROUND_JOB_NAMES.AGENT_BUILDER_EXECUTION,
      { runId: "r-1" },
      { skipWorker: true, jobId: "test-als-svc" },
    );
    expect(lastPayload()?.__actorContext).toBeUndefined();
    expect(requestActorMock).not.toHaveBeenCalled();
  });

  it("falls back to request-actor when ALS frame is empty", async () => {
    alsCurrent = undefined;
    const sessionCtx: ActorContext = {
      ...humanUserCtx,
      principalId: "u-from-session",
    };
    requestActorMock.mockResolvedValue(sessionCtx);
    await enqueueBackgroundJob(
      BACKGROUND_JOB_NAMES.BLOG_POST_WORDPRESS_DRAFT_CREATION,
      { foo: 3 },
      { skipWorker: true, jobId: "test-session-fallback" },
    );
    expect(requestActorMock).toHaveBeenCalledTimes(1);
    expect(lastPayload()?.__actorContext).toEqual(sessionCtx);
  });

  it("leaves __actorContext undefined when no source resolves (system context)", async () => {
    alsCurrent = undefined;
    requestActorMock.mockResolvedValue(undefined);
    await enqueueBackgroundJob(
      BACKGROUND_JOB_NAMES.LITELLM_PRICING_SYNC,
      {},
      { skipWorker: true, jobId: "test-no-attribution" },
    );
    expect(lastPayload()?.__actorContext).toBeUndefined();
  });

  it("inheritActorContext: false skips the cascade entirely", async () => {
    alsCurrent = humanUserCtx; // would attribute if not opted out
    requestActorMock.mockResolvedValue(humanUserCtx);
    await enqueueBackgroundJob(
      BACKGROUND_JOB_NAMES.LITELLM_PRICING_SYNC,
      {},
      {
        skipWorker: true,
        jobId: "test-opt-out",
        inheritActorContext: false,
      },
    );
    expect(lastPayload()?.__actorContext).toBeUndefined();
    expect(requestActorMock).not.toHaveBeenCalled();
  });

  it("strips the inheritActorContext option before forwarding to BullMQ jobOpts", async () => {
    alsCurrent = humanUserCtx;
    await enqueueBackgroundJob(
      BACKGROUND_JOB_NAMES.AGENT_BUILDER_EXECUTION,
      { runId: "r-1" },
      { skipWorker: true, jobId: "test-jobopts", inheritActorContext: true },
    );
    const opts = queueAddMock.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts).not.toHaveProperty("inheritActorContext");
    expect(opts).not.toHaveProperty("actorContext");
  });
});
