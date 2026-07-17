import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Route-handler tests for POST /api/assistants/chatgpt (cinatra#1218
// predecessor 3): the @chatgpt bridge migrated onto the unified AG-UI wire.
//   - the Codex OPERATOR gate ordering is preserved: same-origin → operator
//     authz/audit → bounded body read → parse, all BEFORE any thread bind /
//     spawn; a denied caller yields the gate status and binds no turn;
//   - a Codex reply streams as AG-UI frames (RUN_STARTED / TEXT_MESSAGE_* /
//     RUN_FINISHED) — never the bespoke `event: text`;
//   - a Codex bridge failure terminates the run as RUN_ERROR;
//   - thread authorization reuses the SAME persisted-ownership matrix as the
//     Cinatra endpoint (cross-user personal thread 403).
//
// The REAL harness (`streamAgUiChatTurn`) + REAL adapter run here; only the
// codex bridge, the gate, the origin guard, auth, and the durable-log
// substrate are mocked (same substrate mocks as the Cinatra route test).
// ---------------------------------------------------------------------------

const getAuthSession = vi.fn();
const getActorContext = vi.fn();
const isPlatformAdmin = vi.fn();
const callCodexCliAssistant = vi.fn();
const rejectCrossOrigin = vi.fn();
const authorizeCodexBridgeRequest = vi.fn();
const readChatThreadOwnershipById = vi.fn();
const isActorTeamMemberForChat = vi.fn();
const createAssistantThread = vi.fn();
const getAssistantThread = vi.fn();
const appendAssistantTurn = vi.fn();
const updateAssistantTurn = vi.fn();
const touchAssistantThread = vi.fn();
const xaddRunEvent = vi.fn();
const expireRunStream = vi.fn();

const MOCK_MAX_BODY = 200; // small cap so the oversize test stays cheap

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: () => getAuthSession(),
  getActorContext: () => getActorContext(),
  isPlatformAdmin: (s: unknown) => isPlatformAdmin(s),
}));
vi.mock("@/lib/codex-bridge", () => ({
  callCodexCliAssistant: (...a: unknown[]) => callCodexCliAssistant(...a),
}));
vi.mock("@/lib/admin-origin-guard", () => ({
  rejectCrossOrigin: (r: Request) => rejectCrossOrigin(r),
}));
vi.mock("@/app/api/chat/chatgpt/gate", () => ({
  authorizeCodexBridgeRequest: (...a: unknown[]) => authorizeCodexBridgeRequest(...a),
  // Inline literal (vi.mock factory is hoisted — no top-level refs); MUST equal
  // MOCK_MAX_BODY below.
  MAX_CHAT_BODY_BYTES: 200,
}));
vi.mock("@/lib/chat-thread-store", () => ({
  readChatThreadOwnershipById: (id: string) => readChatThreadOwnershipById(id),
  isActorTeamMemberForChat: (t: string, u: string) => isActorTeamMemberForChat(t, u),
}));
vi.mock("@/lib/assistant-thread-store", () => ({
  createAssistantThread: (...a: unknown[]) => createAssistantThread(...a),
  getAssistantThread: (id: string) => getAssistantThread(id),
  appendAssistantTurn: (...a: unknown[]) => appendAssistantTurn(...a),
  updateAssistantTurn: (...a: unknown[]) => updateAssistantTurn(...a),
  touchAssistantThread: (id: string) => touchAssistantThread(id),
}));
vi.mock("@cinatra-ai/a2a", () => ({
  xaddRunEvent: (...a: unknown[]) => xaddRunEvent(...a),
  expireRunStream: (...a: unknown[]) => expireRunStream(...a),
}));
vi.mock("@cinatra-ai/agent-ui-protocol/server", () => ({
  subscribeToAgUiEventsWithId: async function* (runId: string) {
    for (let i = 0; i < 200; i++) {
      const events = xaddRunEvent.mock.calls.map((c) => c[1] as Record<string, unknown>);
      const terminalIdx = events.findIndex(
        (e) => e.type === "RUN_FINISHED" || e.type === "RUN_ERROR",
      );
      if (terminalIdx >= 0) {
        for (let j = 0; j <= terminalIdx; j++) {
          const { channel: _c, ...event } = events[j];
          yield { id: `${j + 1}-0`, event };
          void _c;
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`no terminal event appended for ${runId}`);
  },
}));

import { POST } from "../route";

function sessionFor(userId: string, orgId: string | null) {
  return { user: { id: userId }, session: { activeOrganizationId: orgId } };
}

function req(body: unknown): Request {
  return new Request("https://app.test/api/assistants/chatgpt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  rejectCrossOrigin.mockReturnValue(null); // same-origin by default
  getAuthSession.mockResolvedValue(sessionFor("op-1", "org-1"));
  getActorContext.mockResolvedValue({ principalId: "op-1", organizationId: "org-1" });
  isPlatformAdmin.mockReturnValue(false);
  authorizeCodexBridgeRequest.mockResolvedValue({ kind: "allow" });
  readChatThreadOwnershipById.mockReturnValue(null);
  getAssistantThread.mockReturnValue(null);
  createAssistantThread.mockImplementation((input: Record<string, unknown>) => input);
  appendAssistantTurn.mockImplementation((input: Record<string, unknown>) => ({ id: "turn-1", ...input }));
  xaddRunEvent.mockResolvedValue("1-0");
  expireRunStream.mockResolvedValue(undefined);
  callCodexCliAssistant.mockResolvedValue("Codex says hello.");
});

describe("POST /api/assistants/chatgpt — gate ordering", () => {
  it("rejects a cross-origin request before anything is authorized or spawned", async () => {
    rejectCrossOrigin.mockReturnValue(new Response("forbidden", { status: 403 }));
    const res = await POST(req({ threadId: "th1", messages: [] }));
    expect(res.status).toBe(403);
    expect(authorizeCodexBridgeRequest).not.toHaveBeenCalled();
    expect(callCodexCliAssistant).not.toHaveBeenCalled();
    expect(appendAssistantTurn).not.toHaveBeenCalled();
  });

  it("denies a non-operator at the operator gate — no turn bound, no spawn", async () => {
    authorizeCodexBridgeRequest.mockResolvedValue({ kind: "deny", status: 403, reason: "Operator authorization required." });
    const res = await POST(req({ threadId: "th1", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(403);
    expect(callCodexCliAssistant).not.toHaveBeenCalled();
    expect(appendAssistantTurn).not.toHaveBeenCalled();
  });

  it("413s an oversize body before parse", async () => {
    const big = "x".repeat(MOCK_MAX_BODY + 50);
    const res = await POST(req({ threadId: "th1", messages: [{ role: "user", content: big }] }));
    expect(res.status).toBe(413);
    expect(callCodexCliAssistant).not.toHaveBeenCalled();
  });

  it("aborts the body read EARLY once the cap is exceeded (streaming-bounded, not buffer-then-check)", async () => {
    // A body that would be 1000 bytes across 10 chunks; the cap is 200. A
    // buffer-then-check read would pull all 10 chunks first — the bounded read
    // must cancel the stream long before that.
    let chunksPulled = 0;
    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunksPulled >= 10) {
          controller.close();
          return;
        }
        chunksPulled += 1;
        controller.enqueue(encoder.encode("y".repeat(100)));
      },
    });
    const streamingReq = new Request("https://app.test/api/assistants/chatgpt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: streamBody,
      // Node/undici requires an explicit duplex for a streaming request body.
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const res = await POST(streamingReq);
    expect(res.status).toBe(413);
    // The read cancelled after crossing 200 bytes (3 × 100) — far fewer than
    // all 10 chunks. This is the property a buffer-then-check read would fail.
    expect(chunksPulled).toBeLessThan(10);
    expect(callCodexCliAssistant).not.toHaveBeenCalled();
  });

  it("403s a cross-user personal thread (persisted-ownership matrix parity)", async () => {
    readChatThreadOwnershipById.mockReturnValue({ ownerUserId: "someone-else", teamId: null });
    const res = await POST(req({ threadId: "th1", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(403);
    expect(callCodexCliAssistant).not.toHaveBeenCalled();
    expect(appendAssistantTurn).not.toHaveBeenCalled();
  });
});

describe("POST /api/assistants/chatgpt — the Codex reply on the AG-UI wire", () => {
  it("streams the Codex reply as AG-UI frames, never bespoke `event: text`", async () => {
    const res = await POST(req({ threadId: "th1", messages: [{ role: "user", content: "hi @chatgpt" }] }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const body = await res.text();
    expect(body).toContain("id: 1-0");
    expect(body).toContain('"type":"RUN_STARTED"');
    expect(body).toContain('"type":"TEXT_MESSAGE_CONTENT"');
    expect(body).toContain("Codex says hello.");
    expect(body).toContain('"type":"RUN_FINISHED"');
    expect(body).not.toContain("event: text");
    expect(updateAssistantTurn).toHaveBeenCalledWith("turn-1", { status: "completed" });
    // The bridge saw the last user message.
    expect(callCodexCliAssistant).toHaveBeenCalledWith(
      expect.objectContaining({ messages: expect.any(Array) }),
      "hi @chatgpt",
    );
  });

  it("terminates the run as RUN_ERROR when the Codex bridge fails", async () => {
    callCodexCliAssistant.mockRejectedValue(new Error("codex spawn failed"));
    const res = await POST(req({ threadId: "th1", messages: [{ role: "user", content: "hi" }] }));
    const body = await res.text();
    expect(body).toContain('"type":"RUN_ERROR"');
    expect(body).toContain("codex spawn failed");
    expect(updateAssistantTurn).toHaveBeenCalledWith("turn-1", { status: "error" });
  });
});
