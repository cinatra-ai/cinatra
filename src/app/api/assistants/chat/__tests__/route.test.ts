import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Route-handler tests for POST /api/assistants/chat (cinatra#1218):
//   - thread authorization derives from PERSISTED ownership axes (save-route
//     matrix): cross-user personal threads 403, team threads gated on
//     membership, absent threads claimed for the caller;
//   - team threads bind the structured row with a NULL org anchor (the P2b
//     mirror policy — never the caller's session org);
//   - the SSE body carries `id:`-cursored frames from the durable log, ends
//     after the terminal frame, and the turn row is finalized
//     completed/error;
//   - a done-less runtime return still yields exactly one RUN_FINISHED
//     (ensureTerminal), and a throwing runtime yields RUN_ERROR + an 'error'
//     turn status.
// ---------------------------------------------------------------------------

const getAuthSession = vi.fn();
const requireActorContext = vi.fn();
const isPlatformAdmin = vi.fn();
const hasConfiguredLlmRuntime = vi.fn();
const runChatTurn = vi.fn();
const readChatThreadOwnershipById = vi.fn();
const isActorTeamMemberForChat = vi.fn();
const createAssistantThread = vi.fn();
const getAssistantThread = vi.fn();
const appendAssistantTurn = vi.fn();
const updateAssistantTurn = vi.fn();
const touchAssistantThread = vi.fn();
const xaddRunEvent = vi.fn();
const expireRunStream = vi.fn();
const resolveAssistantHandles = vi.fn();
const resolveAssistantRuntimeConfigByPrincipal = vi.fn();
const runAssistantTurn = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: () => getAuthSession(),
  requireActorContext: () => requireActorContext(),
  isPlatformAdmin: (s: unknown) => isPlatformAdmin(s),
}));
vi.mock("@/app/api/chat/runner", () => ({
  hasConfiguredLlmRuntime: () => hasConfiguredLlmRuntime(),
  runChatTurn: (...a: unknown[]) => runChatTurn(...a),
}));
vi.mock("@/lib/better-auth-db", () => ({
  resolveAssistantHandles: (...a: unknown[]) => resolveAssistantHandles(...a),
}));
vi.mock("@/lib/assistant-runtime/resolve-runtime-config", () => ({
  resolveAssistantRuntimeConfigByPrincipal: (...a: unknown[]) =>
    resolveAssistantRuntimeConfigByPrincipal(...a),
}));
vi.mock("@/lib/assistant-runtime/runtime", () => ({
  runAssistantTurn: (...a: unknown[]) => runAssistantTurn(...a),
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
// The route tails the durable log; feed the subscriber from the events the
// mocked xaddRunEvent captured, with synthetic monotonic entry ids.
vi.mock("@cinatra-ai/agent-ui-protocol/server", () => ({
  subscribeToAgUiEventsWithId: async function* (runId: string) {
    // Wait until a terminal event has been appended, then replay everything —
    // an adequate model of the durable log for a completed-turn test.
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

function chatReq(body: unknown): Request {
  return new Request("https://app.test/api/assistants/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readSse(res: Response): Promise<string> {
  return await res.text();
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthSession.mockResolvedValue(sessionFor("user-1", "org-1"));
  requireActorContext.mockResolvedValue({ actorType: "human", source: "route", userId: "user-1" });
  isPlatformAdmin.mockReturnValue(false);
  hasConfiguredLlmRuntime.mockResolvedValue(true);
  readChatThreadOwnershipById.mockReturnValue(null);
  getAssistantThread.mockReturnValue(null);
  createAssistantThread.mockImplementation((input: Record<string, unknown>) => input);
  appendAssistantTurn.mockImplementation((input: Record<string, unknown>) => ({ id: "turn-1", ...input }));
  xaddRunEvent.mockResolvedValue("1-0");
  expireRunStream.mockResolvedValue(undefined);
  runChatTurn.mockImplementation(async (args: { send: (e: string, d: unknown) => void }) => {
    args.send("text", { content: "Hi there" });
    args.send("done", {});
  });
  // Default CMS-selector wiring: a registered handle -> a resolvable runtime.
  resolveAssistantHandles.mockResolvedValue(new Map([["wordpress", "wp-principal"]]));
  resolveAssistantRuntimeConfigByPrincipal.mockResolvedValue({
    ok: true,
    runtimeConfig: { systemSkillId: "@cinatra-ai/chat:wordpress-authoring-core" },
  });
  runAssistantTurn.mockImplementation(
    async (_cfg: unknown, args: { send: (e: string, d: unknown) => void }) => {
      args.send("text", { content: "WP reply" });
      args.send("done", {});
    },
  );
});

// cinatra#1823 (epic #1037 P4.1): the OPTIONAL `assistant` selector makes a
// registered assistant (WordPress/Drupal) reachable on THIS endpoint, driven by
// its OWN persisted config resolved through assistant_user_id — under the SAME
// authorization policy as @cinatra.
describe("POST /api/assistants/chat — the assistant selector (cinatra#1823)", () => {
  it("ABSENT selector keeps the @cinatra binding (runChatTurn), never the resolver", async () => {
    const res = await POST(chatReq({ threadId: "th1", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    await readSse(res);
    expect(runChatTurn).toHaveBeenCalledTimes(1);
    expect(runAssistantTurn).not.toHaveBeenCalled();
    expect(resolveAssistantHandles).not.toHaveBeenCalled();
  });

  it("a registered selector resolves the target's OWN runtime config and drives runAssistantTurn (NOT runChatTurn)", async () => {
    const res = await POST(
      chatReq({ threadId: "th1", messages: [{ role: "user", content: "hi" }], assistant: "wordpress" }),
    );
    expect(res.status).toBe(200);
    const body = await readSse(res);
    expect(body).toContain('"type":"RUN_FINISHED"');
    expect(resolveAssistantHandles).toHaveBeenCalledWith(["wordpress"]);
    expect(resolveAssistantRuntimeConfigByPrincipal).toHaveBeenCalledWith({
      assistantUserId: "wp-principal",
      handle: "wordpress",
    });
    // Driven by the resolved runtime config, not the hardcoded Cinatra binding.
    expect(runAssistantTurn).toHaveBeenCalledTimes(1);
    expect(runAssistantTurn.mock.calls[0][0]).toEqual({
      systemSkillId: "@cinatra-ai/chat:wordpress-authoring-core",
    });
    expect(runChatTurn).not.toHaveBeenCalled();
  });

  it("404s an unknown assistant handle (fail-closed) and never starts a turn", async () => {
    resolveAssistantHandles.mockResolvedValue(new Map());
    const res = await POST(
      chatReq({ threadId: "th1", messages: [{ role: "user", content: "hi" }], assistant: "ghost" }),
    );
    expect(res.status).toBe(404);
    expect(runAssistantTurn).not.toHaveBeenCalled();
    expect(appendAssistantTurn).not.toHaveBeenCalled();
  });

  it("404s a handle whose config is unresolvable/corrupt (fail-closed, no Cinatra fallback)", async () => {
    resolveAssistantRuntimeConfigByPrincipal.mockResolvedValue({
      ok: false,
      code: "ASSISTANT_CONFIG_UNAVAILABLE",
    });
    const res = await POST(
      chatReq({ threadId: "th1", messages: [{ role: "user", content: "hi" }], assistant: "wordpress" }),
    );
    expect(res.status).toBe(404);
    expect(runAssistantTurn).not.toHaveBeenCalled();
  });

  it("applies the SAME thread authorization regardless of selector: a cross-user personal thread 403s before any resolution", async () => {
    readChatThreadOwnershipById.mockReturnValue({ ownerUserId: "someone-else", teamId: null });
    const res = await POST(
      chatReq({ threadId: "th1", messages: [{ role: "user", content: "hi" }], assistant: "wordpress" }),
    );
    expect(res.status).toBe(403);
    expect(resolveAssistantHandles).not.toHaveBeenCalled();
    expect(runAssistantTurn).not.toHaveBeenCalled();
  });
});

describe("POST /api/assistants/chat — authorization", () => {
  it("rejects an unauthenticated caller", async () => {
    getAuthSession.mockResolvedValue(null);
    const res = await POST(chatReq({ threadId: "th1", messages: [] }));
    expect(res.status).toBe(401);
    expect(appendAssistantTurn).not.toHaveBeenCalled();
  });

  it("403s a cross-user personal thread and never binds a turn", async () => {
    readChatThreadOwnershipById.mockReturnValue({ ownerUserId: "someone-else", teamId: null });
    const res = await POST(chatReq({ threadId: "th1", messages: [] }));
    expect(res.status).toBe(403);
    expect(appendAssistantTurn).not.toHaveBeenCalled();
    expect(runChatTurn).not.toHaveBeenCalled();
  });

  it("403s a team thread for a non-member", async () => {
    readChatThreadOwnershipById.mockReturnValue({ ownerUserId: null, teamId: "team-9" });
    isActorTeamMemberForChat.mockReturnValue(false);
    const res = await POST(chatReq({ threadId: "th1", messages: [] }));
    expect(res.status).toBe(403);
    expect(runChatTurn).not.toHaveBeenCalled();
  });

  it("team member streams on a team thread; the structured row anchors org NULL", async () => {
    readChatThreadOwnershipById.mockReturnValue({ ownerUserId: null, teamId: "team-9" });
    isActorTeamMemberForChat.mockReturnValue(true);
    getAssistantThread.mockReturnValue(null);
    const res = await POST(chatReq({ threadId: "th1", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    await readSse(res);
    expect(createAssistantThread).toHaveBeenCalledWith(
      expect.objectContaining({ id: "th1", orgId: null }),
    );
  });

  it("claims an absent thread for the caller with the session org anchor", async () => {
    const res = await POST(chatReq({ threadId: "th-new", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    await readSse(res);
    expect(createAssistantThread).toHaveBeenCalledWith(
      expect.objectContaining({ id: "th-new", ownerUserId: "user-1", orgId: "org-1" }),
    );
  });

  it("rejects a malformed body (strict schema)", async () => {
    const res = await POST(chatReq({ messages: [{ role: "user", content: "hi", extra: 1 }] }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/assistants/chat — the SSE turn lifecycle", () => {
  it("streams cursored AG-UI frames ending on the terminal, finalizes the turn, TTLs the stream", async () => {
    const res = await POST(chatReq({ threadId: "th1", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const body = await readSse(res);
    // id: cursors present (S1 resume contract) and the vocabulary is AG-UI.
    expect(body).toContain("id: 1-0");
    expect(body).toContain('"type":"RUN_STARTED"');
    expect(body).toContain('"type":"TEXT_MESSAGE_CONTENT"');
    expect(body).toContain('"type":"RUN_FINISHED"');
    // No bespoke frame names on the wire.
    expect(body).not.toContain("event: text");
    // Turn row bound with the run pointer, finalized completed, stream TTL'd.
    expect(appendAssistantTurn).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "th1", role: "assistant", status: "running", runId: expect.any(String) }),
    );
    // Terminal finalize now ALSO persists the durable per-turn content
    // (cinatra#1037 P5.6 drop-history PR1 EXPAND) alongside the status.
    expect(updateAssistantTurn).toHaveBeenCalledWith("turn-1", {
      status: "completed",
      content: expect.objectContaining({ format: "assistant-turn-v1", role: "assistant", content: "Hi there" }),
    });
    expect(expireRunStream).toHaveBeenCalledTimes(1);
  });

  it("a done-less runtime return still terminates with exactly one RUN_FINISHED", async () => {
    runChatTurn.mockImplementation(async (args: { send: (e: string, d: unknown) => void }) => {
      args.send("text", { content: "explicit dispatch path" });
      // returns WITHOUT done (the explicit-dispatch short-circuit shape)
    });
    const res = await POST(chatReq({ threadId: "th1", messages: [{ role: "user", content: "hi" }] }));
    const body = await readSse(res);
    expect(body.match(/"type":"RUN_FINISHED"/g)).toHaveLength(1);
    expect(updateAssistantTurn).toHaveBeenCalledWith("turn-1", {
      status: "completed",
      content: expect.objectContaining({ format: "assistant-turn-v1", content: "explicit dispatch path" }),
    });
  });

  it("a throwing runtime yields RUN_ERROR and an 'error' turn status", async () => {
    runChatTurn.mockRejectedValue(new Error("runtime exploded"));
    const res = await POST(chatReq({ threadId: "th1", messages: [{ role: "user", content: "hi" }] }));
    const body = await readSse(res);
    expect(body).toContain('"type":"RUN_ERROR"');
    expect(body).toContain("runtime exploded");
    expect(updateAssistantTurn).toHaveBeenCalledWith("turn-1", { status: "error" });
  });

  it("a durable publish failure aborts the run, delivers a synthetic RUN_ERROR, and errors the turn", async () => {
    xaddRunEvent.mockRejectedValue(new Error("redis down"));
    let sawAbort = false;
    runChatTurn.mockImplementation(
      async (args: { send: (e: string, d: unknown) => void; signal?: AbortSignal }) => {
        args.signal?.addEventListener("abort", () => {
          sawAbort = true;
        });
        args.send("text", { content: "never lands" });
        args.send("done", {});
      },
    );
    const res = await POST(chatReq({ threadId: "th1", messages: [{ role: "user", content: "hi" }] }));
    const body = await readSse(res);
    expect(body).toContain('"type":"RUN_ERROR"');
    expect(body).toContain("The assistant stream failed");
    expect(updateAssistantTurn).toHaveBeenCalledWith("turn-1", { status: "error" });
    expect(expireRunStream).toHaveBeenCalledTimes(1);
    expect(sawAbort).toBe(true);
  });

  it("an error sink event after content terminates the run as an error", async () => {
    runChatTurn.mockImplementation(async (args: { send: (e: string, d: unknown) => void }) => {
      args.send("text", { content: "partial" });
      args.send("error", { message: "provider failed" });
    });
    const res = await POST(chatReq({ threadId: "th1", messages: [{ role: "user", content: "hi" }] }));
    const body = await readSse(res);
    expect(body).toContain('"type":"RUN_ERROR"');
    // An error terminal after partial content still persists the durable content
    // produced so far (PR1 EXPAND) — the wire did NOT fail, so the else-branch
    // writes both status and content.
    expect(updateAssistantTurn).toHaveBeenCalledWith("turn-1", {
      status: "error",
      content: expect.objectContaining({ format: "assistant-turn-v1", content: "partial" }),
    });
  });
});
