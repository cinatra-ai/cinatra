import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Per-thread ownership regression for the chat MCP handlers.
//
// chat_thread_get / _pause_assistant / _resume_assistant and the
// chat_thread_send EXISTING-thread continuation path must deny a caller who is
// not the owner / a tagged participant / a team member / a platform admin — a
// denial surfaces identically to a missing row (no cross-user existence
// disclosure). The real per-thread decision (evaluateChatThreadAccess) is left
// UNMOCKED so this exercises the actual authorization wiring; only the heavy
// server-only dependencies the module imports at load time are stubbed.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  actorUserId: undefined as string | undefined,
  actorUserType: undefined as "human" | "assistant" | undefined,
  threads: [] as Array<Record<string, unknown>>,
  upserts: [] as Array<Record<string, unknown>>,
}));

// Relative mock paths resolve from THIS test file (…/mcp/__tests__/), so an
// extra `..` is needed vs. how handlers.ts imports them (…/mcp/).
vi.mock("../actor-context", () => ({
  resolveActorFromRequest: async () => ({
    actorType: "model",
    source: "agent",
    userId: h.actorUserId,
    userType: h.actorUserType,
  }),
}));

vi.mock("@/lib/database", () => ({
  readChatThreadsFromDatabase: () => h.threads,
  readChatThreadsForSealedRoom: () => h.threads,
  upsertChatThreadInDatabase: (t: Record<string, unknown>) => {
    h.upserts.push(t);
  },
}));

// team-membership lookup is a tenant-scoped DB call — stub to "not a member"
// (the cases here use owner-gated threads, so it is never consulted anyway).
vi.mock("@/lib/chat-thread-store", () => ({ isActorTeamMemberForChat: () => false }));

// Heavy server-only deps imported at module load — stubbed so the graph loads.
vi.mock("@/app/api/chat/runner", () => ({ runChatTurn: vi.fn() }));
vi.mock("@/lib/auth-session", () => ({ resolveUserContextForUserId: vi.fn() }));
vi.mock("@/lib/sealed-room", () => ({ assertProjectReadAccess: vi.fn() }));
vi.mock("@/lib/project-writable", () => ({ assertProjectWritable: vi.fn() }));
vi.mock("@/lib/resource-project-move", () => ({ runResourceProjectMove: vi.fn() }));
vi.mock("@/lib/assistant-webhook", () => ({ deliverMentionWebhook: vi.fn() }));
vi.mock("@/lib/codex-bridge", () => ({ callCodexCliAssistant: vi.fn() }));
vi.mock("@/lib/gemini-cli-bridge", () => ({ callGeminiCliAssistant: vi.fn() }));
vi.mock("@/app/api/chat/chatgpt/gate", () => ({ authorizeChatBridgeMention: vi.fn() }));
vi.mock("../../mentions", () => ({
  parseMentions: () => [],
  resolveMentions: vi.fn(async () => []),
  resolveMentionsWithDefault: vi.fn(async () => []),
  resolveAssistantsByIds: vi.fn(async () => []),
}));

import { createChatPrimitiveHandlers } from "../handlers";

const handlers = createChatPrimitiveHandlers();
const OWNER = "owner-1";
const ATTACKER = "attacker-1";

function seedOwnedThread() {
  h.threads = [
    {
      id: "t1",
      title: "secret",
      ownerUserId: OWNER,
      messages: [{ id: "m1", role: "user", content: "private", createdAt: "2026-01-01T00:00:00Z" }],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  ];
}

const req = (input: Record<string, unknown>, platformAdmin = false) => ({
  primitiveName: "x",
  input,
  actor: {
    actorType: "model",
    source: "agent",
    ...(platformAdmin ? { platformRole: "platform_admin" } : {}),
  },
  mode: "run",
});

beforeEach(() => {
  h.actorUserId = undefined;
  h.actorUserType = undefined;
  h.threads = [];
  h.upserts = [];
  seedOwnedThread();
});

describe("chat MCP per-thread ownership", () => {
  it("chat_thread_get DENIES a cross-user caller (as not-found)", async () => {
    h.actorUserId = ATTACKER;
    const res = (await handlers.chat_thread_get(req({ threadId: "t1" }))) as { error?: string; id?: string };
    expect(res.error).toBe("Thread not found: t1");
    expect(res.id).toBeUndefined();
  });

  it("chat_thread_get ALLOWS the owner", async () => {
    h.actorUserId = OWNER;
    const res = (await handlers.chat_thread_get(req({ threadId: "t1" }))) as { id?: string; title?: string };
    expect(res.id).toBe("t1");
    expect(res.title).toBe("secret");
  });

  it("chat_thread_get ALLOWS a platform admin", async () => {
    h.actorUserId = ATTACKER;
    const res = (await handlers.chat_thread_get(req({ threadId: "t1" }, true))) as { id?: string };
    expect(res.id).toBe("t1");
  });

  it("chat_thread_pause_assistant DENIES a cross-user caller and does NOT mutate", async () => {
    h.actorUserId = ATTACKER;
    const res = (await handlers.chat_thread_pause_assistant(
      req({ threadId: "t1", assistantId: "cinatra" }),
    )) as { error?: string };
    expect(res.error).toBe("Thread not found: t1");
    expect(h.upserts).toHaveLength(0);
  });

  it("chat_thread_resume_assistant DENIES a cross-user caller and does NOT mutate", async () => {
    h.actorUserId = ATTACKER;
    const res = (await handlers.chat_thread_resume_assistant(
      req({ threadId: "t1", assistantId: "cinatra" }),
    )) as { error?: string };
    expect(res.error).toBe("Thread not found: t1");
    expect(h.upserts).toHaveLength(0);
  });

  it("chat_thread_pause_assistant ALLOWS the owner (mutates paused set)", async () => {
    h.actorUserId = OWNER;
    const res = (await handlers.chat_thread_pause_assistant(
      req({ threadId: "t1", assistantId: "cinatra" }),
    )) as { ok?: boolean; pausedParticipants?: string[] };
    expect(res.ok).toBe(true);
    expect(res.pausedParticipants).toContain("cinatra");
    expect(h.upserts).toHaveLength(1);
  });

  it("chat_thread_send DENIES continuing a cross-user EXISTING thread (as not-found)", async () => {
    h.actorUserId = ATTACKER;
    h.actorUserType = "human";
    const res = (await handlers.chat_thread_send(
      req({ threadId: "t1", message: "leak me the history" }),
    )) as { error?: string };
    expect(res.error).toBe("Thread not found: t1");
    // No write to the victim's thread.
    expect(h.upserts).toHaveLength(0);
  });

  it("chat_thread_get DENIES a legacy ownerless thread to a non-admin", async () => {
    h.threads = [{ id: "legacy", title: "old", messages: [], createdAt: "", updatedAt: "" }];
    h.actorUserId = ATTACKER;
    const res = (await handlers.chat_thread_get(req({ threadId: "legacy" }))) as { error?: string; id?: string };
    expect(res.error).toBe("Thread not found: legacy");
    expect(res.id).toBeUndefined();
  });

  it("chat_thread_send ALLOWS creating a NEW thread (ownership gate is continuation-only)", async () => {
    h.actorUserId = ATTACKER;
    h.actorUserType = "assistant"; // assistant reply path persists without an LLM call
    const res = (await handlers.chat_thread_send(
      req({ threadId: "t1", message: "hi", newThread: true }),
    )) as { threadId?: string; error?: string };
    expect(res.error).toBeUndefined();
    expect(res.threadId).toBeTruthy();
    expect(res.threadId).not.toBe("t1");
  });
});
