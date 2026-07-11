// cinatra-ai/cinatra#1037 P2b — chat_thread_send RUNTIME-PORT PARITY.
//
// P2a proved runAssistantTurn(cinatraConfig, args) is byte-identical to the
// legacy runChatTurn shim (src/lib/assistant-runtime/__tests__/
// cinatra-parity.test.ts). P2b ports the in-process MCP path off the
// /api/chat runner shim onto the runtime DIRECTLY; this suite pins that the
// port changed NOTHING observable:
//   - the runtime is invoked with EXACTLY the Cinatra reference config (the
//     REAL buildCinatraAssistantRuntimeConfig output, not a stand-in);
//   - the argument mapping (messages/{role,content}, userId, platformRole,
//     sessionOrgId) is the legacy mapping, byte-for-byte;
//   - the send-sink accumulation (text append, tool_result collection, error
//     capture, tool-summary fallback) and the MCP result shape
//     {threadId, assistantMessage} are unchanged;
//   - the structured-mirror org anchor rides the upsert options
//     (assistantMirrorOrgId = the transport-verified org).

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  threads: [] as Array<Record<string, unknown>>,
  upserts: [] as Array<{ thread: Record<string, unknown>; options?: Record<string, unknown> }>,
  runtimeCalls: [] as Array<{ config: unknown; args: Record<string, unknown> }>,
  runtimeDrive: undefined as
    | ((send: (event: string, data?: unknown) => void) => void)
    | undefined,
}));

vi.mock("../actor-context", () => ({
  resolveActorFromRequest: async () => ({
    actorType: "model",
    source: "agent",
    userId: "human-1",
    userType: "human",
  }),
}));

vi.mock("@/lib/database", () => ({
  readChatThreadsFromDatabase: () => h.threads,
  readChatThreadsForSealedRoom: () => h.threads,
  upsertChatThreadInDatabase: (
    thread: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => {
    h.upserts.push({ thread, options });
  },
}));

// The RUNTIME is mocked (captured); the Cinatra reference CONFIG is REAL, so
// the deep-equality below is a genuine byte-parity pin, not mock-vs-mock.
vi.mock("@/lib/assistant-runtime/runtime", () => ({
  runAssistantTurn: vi.fn(async (config: unknown, args: Record<string, unknown>) => {
    h.runtimeCalls.push({ config, args });
    h.runtimeDrive?.(args.send as (event: string, data?: unknown) => void);
  }),
}));

vi.mock("@/lib/chat-thread-store", () => ({ isActorTeamMemberForChat: () => false }));
vi.mock("@/lib/auth-session", () => ({
  resolveUserContextForUserId: vi.fn(async (_userId: string, ctx?: Record<string, unknown>) => ({
    actorContext: { actorType: "user", userId: "human-1" },
    platformRole: (ctx?.platformRole as string) ?? "member",
    sessionOrgId: (ctx?.activeOrganizationId as string) ?? null,
  })),
}));
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
  resolveMentionsWithDefault: vi.fn(async () => [
    { handle: "cinatra", assistantUserId: "cinatra-principal", offset: 0, length: 0 },
  ]),
  resolveAssistantsByIds: vi.fn(async () => []),
}));

import { createChatPrimitiveHandlers } from "../handlers";
import { buildCinatraAssistantRuntimeConfig } from "@/lib/assistant-runtime/cinatra-assistant-config";

const handlers = createChatPrimitiveHandlers();

const sendReq = (input: Record<string, unknown>) => ({
  primitiveName: "chat_thread_send",
  input,
  actor: { actorType: "model", source: "agent", orgId: "org-77", platformRole: "member" },
  mode: "run",
});

beforeEach(() => {
  h.threads = [
    {
      id: "t1",
      title: "existing",
      ownerUserId: "human-1",
      messages: [
        { id: "m0", role: "assistant", content: "earlier reply", createdAt: "2026-01-01T00:00:00Z" },
      ],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  ];
  h.upserts = [];
  h.runtimeCalls = [];
  h.runtimeDrive = (send) => {
    send("text", { content: "Hello" });
    send("done", {});
  };
});

describe("chat_thread_send → assistant runtime port parity (P2b)", () => {
  it("invokes the runtime with EXACTLY the Cinatra reference config (byte parity)", async () => {
    await handlers.chat_thread_send(sendReq({ threadId: "t1", message: "hi there" }));
    expect(h.runtimeCalls).toHaveLength(1);
    expect(h.runtimeCalls[0].config).toEqual(buildCinatraAssistantRuntimeConfig());
  });

  it("maps the args exactly as the legacy runChatTurn call did", async () => {
    await handlers.chat_thread_send(sendReq({ threadId: "t1", message: "hi there" }));
    const args = h.runtimeCalls[0].args;
    // Full prior history + the new user message, reduced to {role, content}.
    expect(args.messages).toEqual([
      { role: "assistant", content: "earlier reply" },
      { role: "user", content: "hi there" },
    ]);
    expect(args.userId).toBe("human-1");
    // Transport-supplied org/role flow through resolveUserContextForUserId.
    expect(args.platformRole).toBe("member");
    expect(args.sessionOrgId).toBe("org-77");
    expect(args.actorContext).toEqual({ actorType: "user", userId: "human-1" });
    expect(typeof args.send).toBe("function");
  });

  it("keeps the send-sink accumulation and the {threadId, assistantMessage} result shape", async () => {
    h.runtimeDrive = (send) => {
      send("text", { content: "Hello " });
      send("text", { content: "world" });
      send("tool_result", { name: "some_tool", resultLabel: "ok" });
      send("done", {});
    };
    const res = (await handlers.chat_thread_send(
      sendReq({ threadId: "t1", message: "hi" }),
    )) as Record<string, unknown>;
    expect(res).toEqual({ threadId: "t1", assistantMessage: "Hello world" });
  });

  it("keeps the tool-summary fallback when the run produced no text", async () => {
    h.runtimeDrive = (send) => {
      send("tool_result", { name: "agent_run", resultLabel: "Launched" });
      send("done", {});
    };
    const res = (await handlers.chat_thread_send(
      sendReq({ threadId: "t1", message: "hi" }),
    )) as Record<string, unknown>;
    expect(res.assistantMessage).toBe(
      "The assistant completed the following actions:\n- agent_run: Launched",
    );
  });

  it("keeps the orchestration-error result shape", async () => {
    h.runtimeDrive = (send) => {
      send("error", { message: "boom" });
    };
    const res = (await handlers.chat_thread_send(
      sendReq({ threadId: "t1", message: "hi" }),
    )) as Record<string, unknown>;
    expect(res).toEqual({
      threadId: "t1",
      assistantMessage: "",
      error: "Chat orchestration error: boom",
    });
  });

  it("threads the transport-verified org into the structured-mirror option on every persist", async () => {
    await handlers.chat_thread_send(sendReq({ threadId: "t1", message: "hi" }));
    // Two persists on this path: the immediate user-message write + the final
    // assistant-reply write. Both carry the mirror org (and NOT the pin orgId).
    expect(h.upserts.length).toBeGreaterThanOrEqual(2);
    for (const { options } of h.upserts) {
      expect(options).toEqual({ assistantMirrorOrgId: "org-77" });
    }
  });
});
