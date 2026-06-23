import { beforeEach, describe, expect, it, vi } from "vitest";

// deliverMentionWebhook (cinatra#341) ENQUEUES onto the host-owned outbound
// webhook engine instead of doing a fire-and-forget HMAC POST. We don't spin up
// BullMQ; we mock the queue and assert what lands in
// `queue.add(name, payload, jobOpts)`.
//
// Contract under test:
//   - enqueues WEBHOOK_OUTBOUND_DELIVERY with
//     { assistantUserId, eventKind:"assistant.mention", messageId, payload };
//   - NEITHER the webhook url NOR the secret appears in the job data (F1);
//   - attempts:5 + exponential backoff + inheritActorContext:false;
//   - no enqueue (and no throw) when the assistant has no webhookUrl;
//   - a failed enqueue is swallowed, never an unhandled rejection (F3).

const queueAddMock = vi.fn().mockResolvedValue({ id: "j-1" });

vi.mock("bullmq", () => {
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

// No-op the top-level host-adapter side-effect import (DB/auth wiring).
vi.mock("@/lib/notifications-host", () => ({}));

// Control the resolved assistant profile per test.
const readAssistantProfileMock = vi.fn();
vi.mock("../assistant-profiles", () => ({
  readAssistantProfile: (...args: unknown[]) => readAssistantProfileMock(...args),
}));

import { deliverMentionWebhook } from "../assistant-webhook";

const PAYLOAD = {
  threadId: "t-1",
  messageId: "chat-msg-1",
  content: "hello @assistant",
  createdAt: "2026-06-23T00:00:00.000Z",
};

describe("deliverMentionWebhook — enqueues onto the outbound engine", () => {
  beforeEach(() => {
    queueAddMock.mockClear();
    readAssistantProfileMock.mockReset();
  });

  it("enqueues WEBHOOK_OUTBOUND_DELIVERY with identity-free job data + retry opts", async () => {
    readAssistantProfileMock.mockReturnValue({
      assistantUserId: "assistant-1",
      webhookUrl: "https://example.test/hook",
      webhookSecret: "whsec_supersecretvalue",
      updatedAt: "2026-06-23T00:00:00.000Z",
    });

    await deliverMentionWebhook("assistant-1", PAYLOAD);

    expect(queueAddMock).toHaveBeenCalledTimes(1);
    const [name, data, jobOpts] = queueAddMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(name).toBe("webhook-outbound-delivery");

    // Job data shape.
    expect(data.assistantUserId).toBe("assistant-1");
    expect(data.eventKind).toBe("assistant.mention");
    expect(typeof data.messageId).toBe("string");
    expect((data.messageId as string).length).toBeGreaterThan(0);
    expect(data.payload).toEqual(PAYLOAD);

    // SECRET HYGIENE (F1): NO url and NO secret anywhere in the enqueued data.
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain("whsec_supersecretvalue");
    expect(serialized).not.toContain("https://example.test/hook");
    expect("webhookSecret" in data).toBe(false);
    expect("webhookUrl" in data).toBe(false);
    expect("secret" in data).toBe(false);
    expect("url" in data).toBe(false);

    // Retry opts + system context.
    expect(jobOpts.attempts).toBe(5);
    expect(jobOpts.backoff).toEqual({ type: "exponential", delay: 2000 });
  });

  it("uses a FRESH messageId per delivery (Standard-Webhooks webhook-id / idempotency key)", async () => {
    readAssistantProfileMock.mockReturnValue({
      assistantUserId: "assistant-1",
      webhookUrl: "https://example.test/hook",
      webhookSecret: "whsec_x",
      updatedAt: "2026-06-23T00:00:00.000Z",
    });
    await deliverMentionWebhook("assistant-1", PAYLOAD);
    await deliverMentionWebhook("assistant-1", PAYLOAD);
    const id1 = (queueAddMock.mock.calls[0]![1] as { messageId: string }).messageId;
    const id2 = (queueAddMock.mock.calls[1]![1] as { messageId: string }).messageId;
    expect(id1).not.toBe(id2);
  });

  it("does NOT enqueue (and does not throw) when the assistant has no webhookUrl", async () => {
    readAssistantProfileMock.mockReturnValue({
      assistantUserId: "assistant-2",
      updatedAt: "2026-06-23T00:00:00.000Z",
    });
    await expect(deliverMentionWebhook("assistant-2", PAYLOAD)).resolves.toBeUndefined();
    expect(queueAddMock).not.toHaveBeenCalled();
  });

  it("does NOT enqueue when there is no profile at all", async () => {
    readAssistantProfileMock.mockReturnValue(null);
    await expect(deliverMentionWebhook("ghost", PAYLOAD)).resolves.toBeUndefined();
    expect(queueAddMock).not.toHaveBeenCalled();
  });

  it("swallows an enqueue failure (F3 — never an unhandled rejection)", async () => {
    readAssistantProfileMock.mockReturnValue({
      assistantUserId: "assistant-3",
      webhookUrl: "https://example.test/hook",
      webhookSecret: "whsec_x",
      updatedAt: "2026-06-23T00:00:00.000Z",
    });
    queueAddMock.mockRejectedValueOnce(new Error("redis down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(deliverMentionWebhook("assistant-3", PAYLOAD)).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
