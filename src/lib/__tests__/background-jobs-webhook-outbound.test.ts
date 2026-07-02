import { beforeEach, describe, expect, it, vi } from "vitest";

// WEBHOOK_OUTBOUND_DELIVERY dispatcher arm (cinatra#341). Drives a single
// switch case via the test-only `__dispatchBackgroundJobForTests` export — no
// live BullMQ/Redis. We mock the lib delivery primitive + the DLQ writer + the
// assistant-profile resolver and assert the DLQ-ownership contract (F4):
//   delivered           → return, no DLQ
//   retryable (not last) → throw, no DLQ
//   retryable (last)     → DLQ then throw
//   permanent            → DLQ, no throw
//   missing url/secret   → permanent → DLQ
//   bad legacy secret    → permanent (lib classifies) → DLQ, no crash
//   DLQ insert idempotent (ON CONFLICT) — the writer is called with stable
//   (eventKind, messageId).

vi.mock("bullmq", () => {
  class FakeQueue {
    add = vi.fn().mockResolvedValue({ id: "j-1" });
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
  // The arm throws a plain Error on retryable; DelayedError is unused here but
  // background-jobs.ts imports it at module top.
  class DelayedError extends Error {}
  return { Queue: FakeQueue, Worker: FakeWorker, DelayedError };
});

vi.mock("ioredis", () => ({
  default: class FakeIORedis {
    on() {
      return this;
    }
    quit() {
      return Promise.resolve("OK");
    }
  },
}));

vi.mock("@/lib/notifications-host", () => ({}));

// Lib delivery primitive — controlled per test.
const deliverOutboundMock = vi.fn();
vi.mock("@cinatra-ai/webhooks", () => ({
  deliverOutbound: (...args: unknown[]) => deliverOutboundMock(...args),
}));

// DLQ writer — spy on the insert + provide a real-ish digest. Keep the REAL
// sanitizeError (via importOriginal) so we can assert the reporting path actually
// scrubs; mock postgres-sync so importOriginal never reaches a live DB (the insert
// is overridden by the spy regardless).
vi.mock("@/lib/postgres-sync", () => ({ runPostgresQueriesSync: vi.fn() }));
const recordOutboundDeadLetterMock = vi.fn();
vi.mock("@/lib/webhook-outbound-deadletter.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/webhook-outbound-deadletter.server")>();
  return {
    ...actual,
    recordOutboundDeadLetter: (...args: unknown[]) => recordOutboundDeadLetterMock(...args),
    digestPayload: () => "deadbeef-digest",
  };
});

// Assistant profile resolver.
const readAssistantProfileMock = vi.fn();
vi.mock("@/lib/assistant-profiles", () => ({
  readAssistantProfile: (...args: unknown[]) => readAssistantProfileMock(...args),
}));

import { BACKGROUND_JOB_NAMES, __dispatchBackgroundJobForTests } from "../background-jobs";

type FakeJobInit = {
  data: Record<string, unknown>;
  attemptsMade?: number;
  attempts?: number;
};

function makeJob(init: FakeJobInit) {
  return {
    id: "job-1",
    name: BACKGROUND_JOB_NAMES.WEBHOOK_OUTBOUND_DELIVERY,
    data: init.data,
    attemptsMade: init.attemptsMade ?? 0,
    opts: { attempts: init.attempts ?? 5 },
    // token + moveToDelayed unused by this arm.
  } as never;
}

const GOOD_PROFILE = {
  assistantUserId: "assistant-1",
  webhookUrl: "https://example.test/hook?token=secret123",
  webhookSecret: "whsec_x",
  updatedAt: "2026-06-23T00:00:00.000Z",
};

const BASE_DATA = {
  assistantUserId: "assistant-1",
  eventKind: "assistant.mention",
  messageId: "msg-abc",
  payload: { threadId: "t", messageId: "m", content: "hi", createdAt: "now" },
};

describe("WEBHOOK_OUTBOUND_DELIVERY dispatcher arm", () => {
  beforeEach(() => {
    deliverOutboundMock.mockReset();
    recordOutboundDeadLetterMock.mockReset();
    readAssistantProfileMock.mockReset();
    readAssistantProfileMock.mockReturnValue(GOOD_PROFILE);
  });

  it("resolves url+secret in the worker and passes them to deliverOutbound (not from job data)", async () => {
    deliverOutboundMock.mockResolvedValue({ kind: "delivered", status: 200 });
    await __dispatchBackgroundJobForTests(makeJob({ data: BASE_DATA }));
    expect(deliverOutboundMock).toHaveBeenCalledTimes(1);
    const req = deliverOutboundMock.mock.calls[0]![0] as {
      url: string;
      secret: string;
      messageId: string;
      extraHeaders?: Record<string, string>;
    };
    expect(req.url).toBe(GOOD_PROFILE.webhookUrl);
    expect(req.secret).toBe("whsec_x");
    expect(req.messageId).toBe("msg-abc");
    // Assistant identity preserved as an extra header (F2).
    expect(req.extraHeaders).toEqual({ "X-Cinatra-Assistant-Id": "assistant-1" });
  });

  it("delivered → returns, NO DLQ", async () => {
    deliverOutboundMock.mockResolvedValue({ kind: "delivered", status: 200 });
    await expect(__dispatchBackgroundJobForTests(makeJob({ data: BASE_DATA }))).resolves.toBeUndefined();
    expect(recordOutboundDeadLetterMock).not.toHaveBeenCalled();
  });

  it("retryable (not last attempt) → THROWS, NO DLQ", async () => {
    deliverOutboundMock.mockResolvedValue({ kind: "retryable", status: 503 });
    await expect(
      __dispatchBackgroundJobForTests(makeJob({ data: BASE_DATA, attemptsMade: 0, attempts: 5 })),
    ).rejects.toThrow(/retryable/);
    expect(recordOutboundDeadLetterMock).not.toHaveBeenCalled();
  });

  it("retryable (LAST attempt) → DLQ then THROWS", async () => {
    deliverOutboundMock.mockResolvedValue({ kind: "retryable", status: 503 });
    // attemptsMade 4 → this is attempt 5 of 5 (last).
    await expect(
      __dispatchBackgroundJobForTests(makeJob({ data: BASE_DATA, attemptsMade: 4, attempts: 5 })),
    ).rejects.toThrow(/retryable/);
    expect(recordOutboundDeadLetterMock).toHaveBeenCalledTimes(1);
    const row = recordOutboundDeadLetterMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.eventKind).toBe("assistant.mention");
    expect(row.messageId).toBe("msg-abc");
    expect(row.lastStatus).toBe(503);
    expect(row.attempts).toBe(5);
    expect(row.payloadDigest).toBe("deadbeef-digest");
  });

  it("retryable → the THROWN error is scrubbed of credentialed-URL secrets (reporting path never leaks)", async () => {
    // undici fills fetch error messages with the FULL target URL — userinfo
    // creds + ?token= query secret. The DLQ scrubs on store; the THROWN error
    // (which feeds worker.on("failed") → Sentry + failed-job notifications) must
    // scrub too, or a retryable failure leaks a credentialed URL. (cinatra#341 R3)
    // The credentialed URL is assembled from fragments at runtime so the
    // secret-scanner never sees a literal credentialed URI in this test source.
    const user = "user";
    const pass = "pass";
    const tok = "tok-1234567890";
    const credUrl = ["https://", user, ":", pass, "@example.test/hook?token=", tok].join("");
    deliverOutboundMock.mockResolvedValue({
      kind: "retryable",
      error: `request to ${credUrl} failed, reason: ECONNRESET`,
    });
    let thrown: Error | undefined;
    try {
      await __dispatchBackgroundJobForTests(
        makeJob({ data: BASE_DATA, attemptsMade: 0, attempts: 5 }),
      );
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).not.toContain(tok);
    expect(thrown!.message).not.toContain(`${user}:${pass}`);
    // origin+path retained (scrubbed, not blanked) so the error is still useful.
    expect(thrown!.message).toContain("https://example.test/hook");
  });

  it("permanent → DLQ, NO throw", async () => {
    deliverOutboundMock.mockResolvedValue({ kind: "permanent", status: 404 });
    await expect(__dispatchBackgroundJobForTests(makeJob({ data: BASE_DATA }))).resolves.toBeUndefined();
    expect(recordOutboundDeadLetterMock).toHaveBeenCalledTimes(1);
    expect((recordOutboundDeadLetterMock.mock.calls[0]![0] as { lastStatus: number }).lastStatus).toBe(404);
  });

  it("permanent + DLQ write FAILS → THROWS so the loss is observable (no silent complete)", async () => {
    deliverOutboundMock.mockResolvedValue({ kind: "permanent", status: 404 });
    recordOutboundDeadLetterMock.mockImplementation(() => {
      throw new Error("db down");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      __dispatchBackgroundJobForTests(makeJob({ data: BASE_DATA })),
    ).rejects.toThrow(/dead-letter write failed/);
    errSpy.mockRestore();
  });

  it("missing target + DLQ write FAILS → THROWS", async () => {
    readAssistantProfileMock.mockReturnValue(null);
    recordOutboundDeadLetterMock.mockImplementation(() => {
      throw new Error("db down");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      __dispatchBackgroundJobForTests(makeJob({ data: BASE_DATA })),
    ).rejects.toThrow(/dead-letter write failed/);
    errSpy.mockRestore();
  });

  it("missing webhookUrl → permanent → DLQ, no deliverOutbound call", async () => {
    readAssistantProfileMock.mockReturnValue({ assistantUserId: "assistant-1", updatedAt: "now" });
    await expect(__dispatchBackgroundJobForTests(makeJob({ data: BASE_DATA }))).resolves.toBeUndefined();
    expect(deliverOutboundMock).not.toHaveBeenCalled();
    expect(recordOutboundDeadLetterMock).toHaveBeenCalledTimes(1);
    expect((recordOutboundDeadLetterMock.mock.calls[0]![0] as { lastStatus: number | null }).lastStatus).toBeNull();
  });

  it("missing profile (deleted between enqueue and run) → permanent → DLQ", async () => {
    readAssistantProfileMock.mockReturnValue(null);
    await expect(__dispatchBackgroundJobForTests(makeJob({ data: BASE_DATA }))).resolves.toBeUndefined();
    expect(deliverOutboundMock).not.toHaveBeenCalled();
    expect(recordOutboundDeadLetterMock).toHaveBeenCalledTimes(1);
  });

  it("non-base64 legacy secret → lib classifies permanent → DLQ, NO crash (F2)", async () => {
    readAssistantProfileMock.mockReturnValue({
      ...GOOD_PROFILE,
      webhookSecret: "!!! not base64 @@@",
    });
    // The real deliverOutbound would catch the signer throw and return
    // permanent; here we assert the arm dead-letters a permanent result.
    deliverOutboundMock.mockResolvedValue({ kind: "permanent", error: "outbound signing failed" });
    await expect(__dispatchBackgroundJobForTests(makeJob({ data: BASE_DATA }))).resolves.toBeUndefined();
    expect(recordOutboundDeadLetterMock).toHaveBeenCalledTimes(1);
  });

  it("unknown eventKind → permanent → DLQ, no deliverOutbound call", async () => {
    await expect(
      __dispatchBackgroundJobForTests(
        makeJob({ data: { ...BASE_DATA, eventKind: "totally.unknown" } }),
      ),
    ).resolves.toBeUndefined();
    expect(deliverOutboundMock).not.toHaveBeenCalled();
    expect(recordOutboundDeadLetterMock).toHaveBeenCalledTimes(1);
  });

  it("malformed payload (no messageId) → skip, no DLQ, no delivery", async () => {
    await expect(
      __dispatchBackgroundJobForTests(
        makeJob({ data: { assistantUserId: "assistant-1", eventKind: "assistant.mention" } }),
      ),
    ).resolves.toBeUndefined();
    expect(deliverOutboundMock).not.toHaveBeenCalled();
    expect(recordOutboundDeadLetterMock).not.toHaveBeenCalled();
  });

  it("DLQ write uses STABLE (eventKind, messageId) so the writer's ON CONFLICT collapses dupes", async () => {
    deliverOutboundMock.mockResolvedValue({ kind: "permanent", status: 410 });
    await __dispatchBackgroundJobForTests(makeJob({ data: BASE_DATA }));
    deliverOutboundMock.mockResolvedValue({ kind: "retryable", status: 503 });
    await expect(
      __dispatchBackgroundJobForTests(makeJob({ data: BASE_DATA, attemptsMade: 4, attempts: 5 })),
    ).rejects.toThrow();
    // Both DLQ writes carry the same identity — the writer's ON CONFLICT DO
    // NOTHING (tested at the writer level) makes them idempotent.
    const ids = recordOutboundDeadLetterMock.mock.calls.map(
      (c) => (c[0] as { eventKind: string; messageId: string }),
    );
    expect(ids).toHaveLength(2);
    expect(ids[0]!.eventKind).toBe("assistant.mention");
    expect(ids[0]!.messageId).toBe("msg-abc");
    expect(ids[1]!.eventKind).toBe("assistant.mention");
    expect(ids[1]!.messageId).toBe("msg-abc");
  });
});
