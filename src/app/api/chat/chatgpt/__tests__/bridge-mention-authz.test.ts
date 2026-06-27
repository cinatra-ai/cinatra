import { describe, expect, it, vi, beforeEach } from "vitest";

import type { ActorContext } from "@/lib/authz/actor-context";

// Absolute path of the chat mentions module — the handler imports it via the
// relative `../mentions` specifier, so mock by resolved absolute path to
// intercept it regardless of the importer's specifier form. Computed inside
// vi.hoisted so it is available to the hoisted vi.mock factory below.
const { MENTIONS_MODULE } = vi.hoisted(() => {
  const nodePath = require("node:path") as typeof import("node:path");
  return {
    MENTIONS_MODULE: nodePath.resolve(
      __dirname,
      "../../../../../../packages/chat/src/mentions.ts",
    ),
  };
});

// ---------------------------------------------------------------------------
// Regression test for engineering#339:
//
// The in-process @chatgpt / @gemini chat-mention path (handleChatThreadSend in
// packages/chat/src/mcp/handlers.ts) spawns the host Codex / Gemini CLI on the
// host's provider credentials — the SAME operator power the /api/chat/chatgpt
// route gates. Before this fix that path was reachable by an ordinary
// authenticated org member via direct MCP (chat_thread_send is classified
// object.create, not operator-only): an authenticated credit-drain /
// host-context-disclosure vector.
//
// This test drives the real handler (createChatPrimitiveHandlers().
// chat_thread_send) through the REAL gate (authorizeChatBridgeMention -> real
// `can` kernel), so the platform-only authority check is exercised end to end.
// Only the bridges, DB, mention resolution, the runner, and the audit sink are
// mocked. Asserts:
//   - org member        -> DENIED, neither CLI bridge spawned, no audit row;
//   - platform operator  -> ALLOWED, bridge spawned, one strict audit row;
//   - oversized prompt    -> DENIED even for the operator (prompt-byte bound).
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  callCodexCliAssistant: vi.fn(),
  callGeminiCliAssistant: vi.fn(),
  resolveUserContextForUserId: vi.fn(),
  readChatThreadsFromDatabase: vi.fn(),
  readChatThreadsForSealedRoom: vi.fn(() => []),
  upsertChatThreadInDatabase: vi.fn(),
  logAuditEventStrict: vi.fn(),
  resolveMentions: vi.fn(),
  runChatTurn: vi.fn(),
}));

vi.mock("@/lib/codex-bridge", () => ({
  callCodexCliAssistant: mocks.callCodexCliAssistant,
}));
vi.mock("@/lib/gemini-cli-bridge", () => ({
  callGeminiCliAssistant: mocks.callGeminiCliAssistant,
}));
// Partial mock: only override resolveUserContextForUserId so the gate
// authorizes the ActorContext we choose; keep every other auth-session export
// real for any transitive importer.
vi.mock("@/lib/auth-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-session")>();
  return { ...actual, resolveUserContextForUserId: mocks.resolveUserContextForUserId };
});
// Partial mock: keep the root vitest `@/lib/database` stub's other exports
// (notifications-host / background-jobs pull getPostgresConnectionString etc.
// through the transitive import graph); override only the three chat-thread
// accessors this handler touches.
vi.mock("@/lib/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/database")>();
  return {
    ...actual,
    readChatThreadsFromDatabase: mocks.readChatThreadsFromDatabase,
    readChatThreadsForSealedRoom: mocks.readChatThreadsForSealedRoom,
    upsertChatThreadInDatabase: mocks.upsertChatThreadInDatabase,
  };
});
// The gate imports logAuditEventStrict from here; keep the rest real.
vi.mock("@/lib/authz/audit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/authz/audit")>(
    "@/lib/authz/audit",
  );
  return { ...actual, logAuditEventStrict: mocks.logAuditEventStrict };
});
// Force dev mode so the built-in @chatgpt / @gemini handles are active.
vi.mock("@/lib/runtime-mode", () => ({ isAppDevelopmentMode: () => true }));
// The LLM runner must not run for a bridge-only mention (no @cinatra).
vi.mock("@/app/api/chat/runner", () => ({ runChatTurn: mocks.runChatTurn }));
// parseMentions runs for real (light, no DB); resolveMentions is stubbed. The
// handler imports these from its relative `../mentions`; mocking by the
// module's resolved absolute path intercepts that import regardless of the
// specifier form used by the importer.
vi.mock(MENTIONS_MODULE, async () => {
  const actual = await vi.importActual<
    typeof import("../../../../../../packages/chat/src/mentions")
  >(MENTIONS_MODULE);
  return { ...actual, resolveMentions: mocks.resolveMentions };
});

import { createChatPrimitiveHandlers } from "@cinatra-ai/chat/mcp-handlers";

function actorCtx(platformRole: "platform_admin" | "member"): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: "user-1",
    organizationId: "org-1",
    platformRole,
    orgRole: "member",
    authSource: "mcp",
    policyVersion: "v2",
  };
}

function sendRequest(message: string) {
  return {
    primitiveName: "chat_thread_send",
    mode: "live",
    actor: {
      actorType: "model",
      source: "agent",
      userId: "user-1",
      userType: "human",
      orgId: "org-1",
      platformRole: "member",
    },
    input: { message, newThread: true },
  };
}

const send = () => createChatPrimitiveHandlers().chat_thread_send;

describe("in-process @chatgpt / @gemini bridge operator-authz gate (engineering#339)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readChatThreadsFromDatabase.mockReturnValue([]);
    mocks.readChatThreadsForSealedRoom.mockReturnValue([]);
    mocks.upsertChatThreadInDatabase.mockReturnValue(undefined);
    mocks.logAuditEventStrict.mockResolvedValue({ id: "audit-1" });
    mocks.callCodexCliAssistant.mockResolvedValue("codex reply");
    mocks.callGeminiCliAssistant.mockResolvedValue("gemini reply");
  });

  it("denies an ordinary org member — Codex bridge never spawned, no audit row", async () => {
    mocks.resolveUserContextForUserId.mockResolvedValue({
      actorContext: actorCtx("member"),
      platformRole: "member",
      sessionOrgId: "org-1",
    });
    mocks.resolveMentions.mockResolvedValue([
      { handle: "chatgpt", assistantUserId: "asst-chatgpt", offset: 0, length: 8 },
    ]);

    await send()(sendRequest("@chatgpt drain my credits please"));

    expect(mocks.callCodexCliAssistant).not.toHaveBeenCalled();
    expect(mocks.logAuditEventStrict).not.toHaveBeenCalled();

    const persisted = mocks.upsertChatThreadInDatabase.mock.calls
      .map((c) => c[0] as { messages?: Array<{ role: string; content: string }> })
      .flatMap((t) => t.messages ?? []);
    const reply = persisted.find((m) => m.role === "assistant");
    expect(reply?.content).toContain("operator authorization required");
  });

  it("allows a platform operator — Codex bridge spawned, one strict audit row", async () => {
    mocks.resolveUserContextForUserId.mockResolvedValue({
      actorContext: actorCtx("platform_admin"),
      platformRole: "platform_admin",
      sessionOrgId: "org-1",
    });
    mocks.resolveMentions.mockResolvedValue([
      { handle: "chatgpt", assistantUserId: "asst-chatgpt", offset: 0, length: 8 },
    ]);

    await send()(sendRequest("@chatgpt hello"));

    expect(mocks.callCodexCliAssistant).toHaveBeenCalledTimes(1);
    expect(mocks.logAuditEventStrict).toHaveBeenCalledTimes(1);
    const auditArg = mocks.logAuditEventStrict.mock.calls[0][0];
    expect(auditArg).toMatchObject({
      resourceType: "operations",
      resourceId: "chat:codex-bridge",
      operation: "chat.codex.invoke",
      decision: "allowed",
    });
  });

  it("applies the same gate to the @gemini bridge — org member denied", async () => {
    mocks.resolveUserContextForUserId.mockResolvedValue({
      actorContext: actorCtx("member"),
      platformRole: "member",
      sessionOrgId: "org-1",
    });
    mocks.resolveMentions.mockResolvedValue([
      { handle: "gemini", assistantUserId: "asst-gemini", offset: 0, length: 7 },
    ]);

    await send()(sendRequest("@gemini hi"));

    expect(mocks.callGeminiCliAssistant).not.toHaveBeenCalled();
    expect(mocks.logAuditEventStrict).not.toHaveBeenCalled();
  });

  it("enforces the prompt-byte bound even for an operator — bridge never spawned", async () => {
    mocks.resolveUserContextForUserId.mockResolvedValue({
      actorContext: actorCtx("platform_admin"),
      platformRole: "platform_admin",
      sessionOrgId: "org-1",
    });
    mocks.resolveMentions.mockResolvedValue([
      { handle: "chatgpt", assistantUserId: "asst-chatgpt", offset: 0, length: 8 },
    ]);

    const huge = "@chatgpt " + "x".repeat(40 * 1024);
    await send()(sendRequest(huge));

    expect(mocks.callCodexCliAssistant).not.toHaveBeenCalled();
    expect(mocks.logAuditEventStrict).not.toHaveBeenCalled();
  });
});
