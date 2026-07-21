import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Authz regression for the two RETAINED chat MCP handlers after the PR2 CUTOVER
// final teardown (owner ruling 2026-07-21): the broad chat_thread_* tools are
// retired; only chat_mentions_poll + chat_mention_reply survive, both reading
// the AUTHORITATIVE structured store.
//
//   - chat_mentions_poll   requires an ASSISTANT user context.
//   - chat_mention_reply   requires an assistant identity AND a 'pending'
//     mention for THAT assistant on THE EXACT (threadId, messageId). Authz is
//     the mention's audience — no thread-ownership/grant is consulted; a
//     handled/absent/foreign mention is rejected.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  actorUserId: undefined as string | undefined,
  actorUserType: undefined as "human" | "assistant" | undefined,
  thread: null as Record<string, unknown> | null,
  pending: [] as Array<Record<string, unknown>>,
  upserts: [] as Array<Record<string, unknown>>,
}));

vi.mock("../actor-context", () => ({
  resolveActorFromRequest: async () => ({
    actorType: "model",
    source: "agent",
    userId: h.actorUserId,
    userType: h.actorUserType,
  }),
}));

vi.mock("@/lib/database", () => ({
  upsertChatThreadInDatabase: (t: Record<string, unknown>) => {
    h.upserts.push(t);
  },
}));

vi.mock("@/lib/assistant-thread-store", () => ({
  reconstructThreadPayload: () => h.thread,
  scanPendingMentionsForAssistant: () => h.pending,
}));

import { createChatPrimitiveHandlers } from "../handlers";

const handlers = createChatPrimitiveHandlers();
const ASSISTANT = "assistant-1";
const OTHER = "assistant-2";

const req = (input: Record<string, unknown>) => ({
  primitiveName: "x",
  input,
  actor: { actorType: "model", source: "agent" },
  mode: "run",
});

beforeEach(() => {
  h.actorUserId = undefined;
  h.actorUserType = undefined;
  h.thread = null;
  h.pending = [];
  h.upserts = [];
});

describe("chat_mentions_poll authz", () => {
  it("DENIES a non-assistant (human) caller", async () => {
    h.actorUserId = "human-1";
    h.actorUserType = "human";
    const res = (await handlers.chat_mentions_poll(req({}))) as { error?: string };
    expect(res.error).toContain("assistant user context");
  });

  it("returns the assistant's pending mentions from the structured store", async () => {
    h.actorUserId = ASSISTANT;
    h.actorUserType = "assistant";
    h.pending = [{ threadId: "t1", messageId: "m1", content: "hi", createdAt: "", threadTitle: "", mentions: [] }];
    const res = (await handlers.chat_mentions_poll(req({}))) as { items?: unknown[]; total?: number };
    expect(res.total).toBe(1);
    expect(res.items).toHaveLength(1);
  });
});

describe("chat_mention_reply authz — the mention's audience", () => {
  const seedThreadWithPendingMentionFor = (assistantUserId: string) => {
    h.thread = {
      id: "t1",
      title: "secret",
      messages: [
        {
          id: "m1",
          role: "user",
          content: "@a please",
          createdAt: "2026-01-01T00:00:00Z",
          mentionState: { [assistantUserId]: "pending" },
        },
      ],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
  };

  it("DENIES a non-assistant caller", async () => {
    h.actorUserId = "human-1";
    h.actorUserType = "human";
    seedThreadWithPendingMentionFor(ASSISTANT);
    const res = (await handlers.chat_mention_reply(
      req({ threadId: "t1", messageId: "m1", message: "reply" }),
    )) as { error?: string };
    expect(res.error).toContain("assistant identity");
    expect(h.upserts).toHaveLength(0);
  });

  it("DENIES when the pending mention is for a DIFFERENT assistant", async () => {
    h.actorUserId = ASSISTANT;
    h.actorUserType = "assistant";
    seedThreadWithPendingMentionFor(OTHER); // pending is for someone else
    const res = (await handlers.chat_mention_reply(
      req({ threadId: "t1", messageId: "m1", message: "reply" }),
    )) as { error?: string };
    expect(res.error).toContain("No pending mention");
    expect(h.upserts).toHaveLength(0);
  });

  it("DENIES a missing thread", async () => {
    h.actorUserId = ASSISTANT;
    h.actorUserType = "assistant";
    h.thread = null;
    const res = (await handlers.chat_mention_reply(
      req({ threadId: "gone", messageId: "m1", message: "reply" }),
    )) as { error?: string };
    expect(res.error).toContain("Thread not found");
    expect(h.upserts).toHaveLength(0);
  });

  it("ALLOWS the mentioned assistant, marks handled, and persists the reply", async () => {
    h.actorUserId = ASSISTANT;
    h.actorUserType = "assistant";
    seedThreadWithPendingMentionFor(ASSISTANT);
    const res = (await handlers.chat_mention_reply(
      req({ threadId: "t1", messageId: "m1", message: "here you go" }),
    )) as { handled?: boolean; assistantMessage?: string };
    expect(res.handled).toBe(true);
    expect(res.assistantMessage).toBe("here you go");
    expect(h.upserts).toHaveLength(1);
    const written = h.upserts[0] as { messages?: Array<Record<string, unknown>> };
    // the mention flipped to handled + the reply turn appended
    const userMsg = written.messages?.find((m) => m.id === "m1");
    expect((userMsg?.mentionState as Record<string, string>)[ASSISTANT]).toBe("handled");
    expect(written.messages?.some((m) => m.role === "assistant" && m.content === "here you go")).toBe(true);
  });
});
