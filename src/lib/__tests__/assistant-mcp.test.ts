import { describe, it, expect, vi, beforeEach } from "vitest";

// Unit tests for the generalized assistant MCP surface (cinatra#1037 P5.5).
// The composed substrate — the handle registry, the structured thread/turn
// store, the assistant runtime, the auth-session context resolver, and the
// durable event log — is mocked; their own behavior is proven by their own
// suites. What THESE tests prove is the module's own contract:
//   * caller identity is resolved EXCLUSIVELY from mcpRequestContextStorage
//     (fail-closed without one; the `.strict()` schemas REFUSE a smuggled
//     identity operand — no assistantClientId self-assertion carried forward);
//   * an unresolvable handle 404-hides BYTE-IDENTICALLY to a denied thread
//     (the sealed-room contract);
//   * the thread/grant check is the generalized G2 decision over the
//     structured store (cross-user / cross-org / ownerless / cross-bound all
//     404-hide; owner / participant / admin pass);
//   * the assistant-level mcp.enabled/restriction target policy gates
//     addressability input-time;
//   * runtime-config resolution is handle-generic and fails CLOSED as the
//     sealed-room NOT_FOUND for a principal with no linked config (P1.3 not
//     landed) — never a distinguishable code (no handle-existence oracle);
//   * EVERY agent-run OBO caller (any oboCeiling on the frame, org floor
//     included, platform-admin included) is refused (defense-in-depth twin of
//     the boundary's cannot-express "assistant" class — this surface can honor
//     neither a sub-org bound nor the org floor, nor propagate the ceiling);
//   * assistant_send is REAL bounded-wait (timeout → running + runId +
//     streamRef; the turn still finalizes server-side);
//   * no raw exception text ever reaches the envelope (guarded/sanitize);
//   * the delegated-chat policy DENIES all three tools (the epic's open
//     decision, resolved as an intentional deny — no CarveOut, no rename).
// The REAL mcpRequestContextStorage carries the frame, and the REAL pure
// decision (evaluateAssistantThreadAccess) + the REAL zod schemas run unmocked.

const mocks = vi.hoisted(() => {
  const cinatraConfig = {
    persona: "You are the Cinatra AI assistant.",
    skillBundle: ["chat-assistant-core"],
    allowedTools: [] as string[],
    allowedAgents: [] as string[],
    modelPrefs: {},
    mcp: undefined as undefined | { enabled: boolean; restriction: "org-members" | "platform-admins" },
  };
  return {
    resolveAssistantHandles: vi.fn(),
    lookupAssistantHandlesByIds: vi.fn(),
    createAssistantThread: vi.fn(),
    getAssistantThread: vi.fn(),
    listAssistantThreadsForOrg: vi.fn(),
    listAssistantThreadsForOrgVisibleTo: vi.fn(),
    appendAssistantTurn: vi.fn(),
    updateAssistantTurn: vi.fn(),
    listAssistantTurns: vi.fn(),
    touchAssistantThread: vi.fn(),
    runAssistantTurn: vi.fn(),
    buildCinatraAssistantRuntimeConfig: vi.fn(),
    resolveUserContextForUserId: vi.fn(),
    xaddRunEvent: vi.fn(),
    readRecentRunEventsReverse: vi.fn(),
    expireRunStream: vi.fn(),
    cinatraConfig,
  };
});

vi.mock("@/lib/better-auth-db", () => ({
  resolveAssistantHandles: mocks.resolveAssistantHandles,
  lookupAssistantHandlesByIds: mocks.lookupAssistantHandlesByIds,
}));
vi.mock("@/lib/assistant-thread-store", () => ({
  createAssistantThread: mocks.createAssistantThread,
  getAssistantThread: mocks.getAssistantThread,
  listAssistantThreadsForOrg: mocks.listAssistantThreadsForOrg,
  listAssistantThreadsForOrgVisibleTo: mocks.listAssistantThreadsForOrgVisibleTo,
  appendAssistantTurn: mocks.appendAssistantTurn,
  updateAssistantTurn: mocks.updateAssistantTurn,
  listAssistantTurns: mocks.listAssistantTurns,
  touchAssistantThread: mocks.touchAssistantThread,
}));
vi.mock("@/lib/assistant-runtime/runtime", () => ({
  runAssistantTurn: mocks.runAssistantTurn,
}));
vi.mock("@/lib/assistant-runtime/cinatra-assistant-config", () => ({
  cinatraAssistantConfig: mocks.cinatraConfig,
  buildCinatraAssistantRuntimeConfig: mocks.buildCinatraAssistantRuntimeConfig,
}));
vi.mock("@/lib/auth-session", () => ({
  resolveUserContextForUserId: mocks.resolveUserContextForUserId,
}));
vi.mock("@cinatra-ai/a2a", () => ({
  xaddRunEvent: mocks.xaddRunEvent,
  readRecentRunEventsReverse: mocks.readRecentRunEventsReverse,
  expireRunStream: mocks.expireRunStream,
}));

import { mcpRequestContextStorage, isDelegatedChatMcpToolAllowed } from "@cinatra-ai/mcp-server";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { registerAssistantMcpPrimitives } from "@/lib/assistant-mcp";

// ── fixtures ─────────────────────────────────────────────────────────────────

const ORG = "org-1";
const USER = "user-1";
const CINATRA_ID = "assistant-cinatra";
const HELPER_ID = "assistant-helper";

type EnvelopeResult = { structuredContent: Record<string, unknown> };
type CapturedHandler = (input: unknown) => Promise<EnvelopeResult>;

function captureTools() {
  const tools = new Map<string, { config: { inputSchema: unknown }; handler: CapturedHandler }>();
  const server = {
    registerTool: (name: string, config: { inputSchema: unknown }, handler: CapturedHandler) => {
      tools.set(name, { config, handler });
    },
  } as unknown as McpRuntimeToolServer;
  registerAssistantMcpPrimitives(server);
  return tools;
}

type Frame = {
  userId?: string | null;
  orgId?: string | null;
  platformRole?: "platform_admin" | "member";
  delegatedRestricted?: boolean;
  oboCeiling?: Array<{ tier: string; id: string }>;
};

async function call(tool: string, input: unknown, frame: Frame | null): Promise<Record<string, unknown>> {
  const tools = captureTools();
  const entry = tools.get(tool);
  if (!entry) throw new Error(`tool ${tool} not registered`);
  const invoke = () => entry.handler(input);
  const res = frame
    ? await mcpRequestContextStorage.run(frame as never, invoke)
    : await invoke();
  return res.structuredContent;
}

const memberFrame: Frame = { userId: USER, orgId: ORG, platformRole: "member" };
const adminFrame: Frame = { userId: "admin-1", orgId: ORG, platformRole: "platform_admin" };

function thread(overrides: Record<string, unknown> = {}) {
  return {
    id: "thread-1",
    assistantUserId: CINATRA_ID,
    ownerUserId: USER,
    orgId: ORG,
    title: "t",
    contextId: null,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cinatraConfig.mcp = undefined;
  mocks.resolveAssistantHandles.mockImplementation(async (handles: string[]) => {
    const map = new Map<string, string>();
    for (const h of handles) {
      if (h === "cinatra") map.set(h, CINATRA_ID);
      if (h === "helper") map.set(h, HELPER_ID);
    }
    return map;
  });
  mocks.lookupAssistantHandlesByIds.mockImplementation(async (ids: string[]) => {
    const map = new Map<string, string>();
    for (const id of ids) {
      if (id === CINATRA_ID) map.set(id, "cinatra");
      if (id === HELPER_ID) map.set(id, "helper");
    }
    return map;
  });
  mocks.getAssistantThread.mockReturnValue(null);
  mocks.listAssistantThreadsForOrg.mockReturnValue([]);
  mocks.listAssistantThreadsForOrgVisibleTo.mockReturnValue([]);
  mocks.listAssistantTurns.mockReturnValue([]);
  let turnSeq = 0;
  mocks.appendAssistantTurn.mockImplementation((input: Record<string, unknown>) => ({
    id: `turn-${++turnSeq}`,
    threadId: input.threadId,
    runId: input.runId ?? null,
    assistantUserId: input.assistantUserId ?? null,
    role: input.role ?? "assistant",
    status: input.status ?? "running",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
  }));
  mocks.createAssistantThread.mockImplementation((input: Record<string, unknown>) =>
    thread({ id: "thread-new", ...input }),
  );
  mocks.buildCinatraAssistantRuntimeConfig.mockReturnValue({
    skillIdNamespace: "@cinatra-ai/chat",
    skillIds: ["@cinatra-ai/chat:chat-assistant-core"],
    systemSkillId: "@cinatra-ai/chat:chat-assistant-core",
    fallbackPersona: "p",
    allowedTools: [],
    allowedAgents: [],
    modelPrefs: {},
    maxToolRounds: 24,
  });
  mocks.resolveUserContextForUserId.mockResolvedValue({
    actorContext: { actorType: "user" },
    platformRole: "member",
    sessionOrgId: ORG,
  });
  mocks.runAssistantTurn.mockImplementation(async (_cfg: unknown, args: { send: (e: string, d: unknown) => void }) => {
    args.send("text", { content: "hello from the assistant" });
  });
  mocks.xaddRunEvent.mockResolvedValue("1-1");
  mocks.readRecentRunEventsReverse.mockResolvedValue([]);
  mocks.expireRunStream.mockResolvedValue(undefined);
});

// ── registration + schema pin ────────────────────────────────────────────────

describe("registration", () => {
  it("registers exactly the three assistant tools", () => {
    const tools = captureTools();
    expect([...tools.keys()].sort()).toEqual([
      "assistant_send",
      "assistant_thread_get",
      "assistant_thread_list",
    ]);
  });

  it("every advertised schema is .strict() — an unknown key is refused", async () => {
    for (const [tool, ok] of [
      ["assistant_send", { handle: "cinatra", message: "hi" }],
      ["assistant_thread_list", {}],
      ["assistant_thread_get", { threadId: "thread-1" }],
    ] as const) {
      const smuggled = await call(tool, { ...ok, orgId: "attacker-org" }, memberFrame);
      expect(smuggled.status).toBe("rejected");
      expect(smuggled.code).toBe("INVALID_INPUT");
    }
  });
});

// ── caller identity (fail-closed; never from input) ──────────────────────────

describe("caller identity", () => {
  it("refuses every tool without a transport-verified identity frame", async () => {
    for (const [tool, input] of [
      ["assistant_send", { handle: "cinatra", message: "hi" }],
      ["assistant_thread_list", {}],
      ["assistant_thread_get", { threadId: "thread-1" }],
    ] as const) {
      const out = await call(tool, input, null);
      expect(out.status).toBe("rejected");
      expect(out.code).toBe("AUTH_REQUIRED");
    }
  });

  it("refuses a userId without an orgId (and vice versa)", async () => {
    const noOrg = await call("assistant_send", { handle: "cinatra", message: "hi" }, { userId: USER });
    expect(noOrg.code).toBe("AUTH_REQUIRED");
    const noUser = await call("assistant_send", { handle: "cinatra", message: "hi" }, { orgId: ORG });
    expect(noUser.code).toBe("AUTH_REQUIRED");
  });

  it("refuses the delegated-chat restricted perimeter explicitly (defense-in-depth)", async () => {
    const out = await call(
      "assistant_send",
      { handle: "cinatra", message: "hi" },
      { ...memberFrame, delegatedRestricted: true },
    );
    expect(out.code).toBe("AUTH_REQUIRED");
  });

  it("refuses EVERY agent-run OBO caller on all three tools — sub-org AND org-only (this surface cannot honor the ceiling)", async () => {
    const ceilings: Array<Array<{ tier: string; id: string }>> = [
      // sub-org
      [
        { tier: "project", id: "p1" },
        { tier: "organization", id: ORG },
      ],
      // org-only (the mandatory floor is STILL unhonorable here: the admin
      // thread-access allow ignores it and the nested turn escapes it)
      [{ tier: "organization", id: ORG }],
    ];
    for (const oboCeiling of ceilings) {
      for (const [tool, input] of [
        ["assistant_send", { handle: "cinatra", message: "hi" }],
        ["assistant_thread_list", {}],
        ["assistant_thread_get", { threadId: "thread-1" }],
      ] as const) {
        const out = await call(tool, input, { ...memberFrame, oboCeiling });
        expect(out.status).toBe("rejected");
        expect(out.code).toBe("AUTH_REQUIRED");
      }
    }
    expect(mocks.runAssistantTurn).not.toHaveBeenCalled();
    expect(mocks.createAssistantThread).not.toHaveBeenCalled();
  });

  it("refuses an agent-run OBO platform-admin too (the admin bypass never nullifies the ceiling here)", async () => {
    const out = await call(
      "assistant_thread_get",
      { threadId: "thread-1" },
      { ...adminFrame, oboCeiling: [{ tier: "organization", id: ORG }] },
    );
    expect(out.status).toBe("rejected");
    expect(out.code).toBe("AUTH_REQUIRED");
  });

  it("REFUSES a spoofed identity operand in tool input (no self-assertion carried forward)", async () => {
    for (const spoof of [
      { assistantClientId: "attacker-client" },
      { userId: "attacker" },
      { orgId: "attacker-org" },
      { platformRole: "platform_admin" },
    ]) {
      const out = await call(
        "assistant_send",
        { handle: "cinatra", message: "hi", ...spoof },
        memberFrame,
      );
      expect(out.status).toBe("rejected");
      expect(out.code).toBe("INVALID_INPUT");
    }
    expect(mocks.runAssistantTurn).not.toHaveBeenCalled();
    expect(mocks.createAssistantThread).not.toHaveBeenCalled();
  });
});

// ── sealed-room 404-hide ─────────────────────────────────────────────────────

describe("404-hide parity", () => {
  it("an unresolvable handle and a denied thread produce BYTE-IDENTICAL envelopes", async () => {
    const unknownHandle = await call(
      "assistant_send",
      { handle: "nope", message: "hi" },
      memberFrame,
    );
    mocks.getAssistantThread.mockReturnValue(thread({ ownerUserId: "someone-else" }));
    const deniedThread = await call(
      "assistant_send",
      { handle: "cinatra", threadId: "thread-1", message: "hi" },
      memberFrame,
    );
    expect(unknownHandle).toEqual(deniedThread);
    expect(unknownHandle.status).toBe("rejected");
    expect(unknownHandle.code).toBe("NOT_FOUND");
  });

  it("denies a cross-org thread as NOT_FOUND", async () => {
    mocks.getAssistantThread.mockReturnValue(thread({ orgId: "org-2" }));
    const out = await call(
      "assistant_send",
      { handle: "cinatra", threadId: "thread-1", message: "hi" },
      memberFrame,
    );
    expect(out.code).toBe("NOT_FOUND");
  });

  it("denies a legacy ownerless thread to a non-admin, allows a platform admin", async () => {
    mocks.getAssistantThread.mockReturnValue(thread({ ownerUserId: null, assistantUserId: null }));
    const member = await call(
      "assistant_thread_get",
      { threadId: "thread-1" },
      memberFrame,
    );
    expect(member.code).toBe("NOT_FOUND");
    const admin = await call("assistant_thread_get", { threadId: "thread-1" }, adminFrame);
    expect(admin.status).toBe("ok");
  });

  it("denies a thread bound to a DIFFERENT assistant principal for the requested handle", async () => {
    mocks.getAssistantThread.mockReturnValue(thread({ assistantUserId: HELPER_ID }));
    const out = await call(
      "assistant_send",
      { handle: "cinatra", threadId: "thread-1", message: "hi" },
      memberFrame,
    );
    expect(out.code).toBe("NOT_FOUND");
  });
});

// ── target policy (mcp.enabled/restriction) ──────────────────────────────────

describe("assistant-level MCP target policy", () => {
  it("mcp.enabled=false 404-hides the target", async () => {
    mocks.cinatraConfig.mcp = { enabled: false, restriction: "org-members" };
    const out = await call("assistant_send", { handle: "cinatra", message: "hi" }, memberFrame);
    expect(out.code).toBe("NOT_FOUND");
    expect(mocks.runAssistantTurn).not.toHaveBeenCalled();
  });

  it("restriction platform-admins hides the target from members but not admins", async () => {
    mocks.cinatraConfig.mcp = { enabled: true, restriction: "platform-admins" };
    const member = await call("assistant_send", { handle: "cinatra", message: "hi" }, memberFrame);
    expect(member.code).toBe("NOT_FOUND");
    const admin = await call("assistant_send", { handle: "cinatra", message: "hi" }, adminFrame);
    expect(admin.status).toBe("completed");
  });
});

// ── handle-generic config resolution (P1.3 not landed) ───────────────────────

describe("runtime-config resolution", () => {
  it("404-hides a resolvable handle with no linked config, BYTE-IDENTICAL with an unresolvable one (no handle-existence oracle)", async () => {
    const noConfig = await call("assistant_send", { handle: "helper", message: "hi" }, memberFrame);
    const unknown = await call("assistant_send", { handle: "nope", message: "hi" }, memberFrame);
    expect(noConfig).toEqual(unknown);
    expect(noConfig.status).toBe("rejected");
    expect(noConfig.code).toBe("NOT_FOUND");
    expect(mocks.runAssistantTurn).not.toHaveBeenCalled();
    expect(mocks.createAssistantThread).not.toHaveBeenCalled();
  });

  it("resolves the built-in Cinatra principal through the reference config", async () => {
    const out = await call("assistant_send", { handle: "cinatra", message: "hi" }, memberFrame);
    expect(out.status).toBe("completed");
    expect(mocks.buildCinatraAssistantRuntimeConfig).toHaveBeenCalledTimes(1);
  });
});

// ── assistant_send happy path + bounded wait ─────────────────────────────────

describe("assistant_send", () => {
  it("completes within the wait window: finalMessage + runId + threadId + streamRef, turns persisted", async () => {
    const out = await call("assistant_send", { handle: "cinatra", message: "hi" }, memberFrame);
    expect(out.status).toBe("completed");
    expect(out.finalMessage).toBe("hello from the assistant");
    expect(out.threadId).toBe("thread-new");
    expect(typeof out.runId).toBe("string");
    expect(out.streamRef).toBe(`cinatra:a2a:events:${out.runId}`);

    // Thread created with SERVER-derived owner/org — never input.
    expect(mocks.createAssistantThread).toHaveBeenCalledWith(
      expect.objectContaining({ assistantUserId: CINATRA_ID, ownerUserId: USER, orgId: ORG }),
    );
    // One user turn + one running assistant turn, then finalized completed.
    const roles = mocks.appendAssistantTurn.mock.calls.map((c) => c[0].role);
    expect(roles).toEqual(["user", "assistant"]);
    expect(mocks.updateAssistantTurn).toHaveBeenCalledWith("turn-2", { status: "completed" });
    // Durable trail: user_message then final_message on the SAME run stream.
    const types = mocks.xaddRunEvent.mock.calls.map((c) => c[1].type);
    expect(types).toEqual(["user_message", "final_message"]);
    expect(mocks.expireRunStream).toHaveBeenCalledWith(out.runId);
  });

  it("times out into status running + runId + streamRef, then STILL finalizes server-side", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mocks.runAssistantTurn.mockImplementation(async (_cfg: unknown, args: { send: (e: string, d: unknown) => void }) => {
      await gate;
      args.send("text", { content: "late answer" });
    });

    const out = await call(
      "assistant_send",
      { handle: "cinatra", message: "hi", waitMs: 1000 },
      memberFrame,
    );
    expect(out.status).toBe("running");
    expect(typeof out.runId).toBe("string");
    expect(out.streamRef).toBe(`cinatra:a2a:events:${out.runId}`);
    expect(out.finalMessage).toBeUndefined();
    expect(mocks.updateAssistantTurn).not.toHaveBeenCalled();

    // Let the turn finish AFTER the bounded wait returned.
    release();
    await vi.waitFor(() => {
      expect(mocks.updateAssistantTurn).toHaveBeenCalledWith("turn-2", { status: "completed" });
    });
    const types = mocks.xaddRunEvent.mock.calls.map((c) => c[1].type);
    expect(types).toContain("final_message");
  });

  it("reconstructs prior-turn history (best-effort) for a continuation send", async () => {
    mocks.getAssistantThread.mockReturnValue(thread());
    mocks.listAssistantTurns.mockReturnValue([
      { id: "t1", threadId: "thread-1", runId: null, assistantUserId: null, role: "user", status: "completed", createdAt: "", updatedAt: "" },
      { id: "t2", threadId: "thread-1", runId: "run-old", assistantUserId: CINATRA_ID, role: "assistant", status: "completed", createdAt: "", updatedAt: "" },
    ]);
    mocks.readRecentRunEventsReverse.mockResolvedValue([
      { id: "2-1", event: { channel: "assistant-mcp", type: "final_message", content: "old answer" } },
      { id: "1-1", event: { channel: "assistant-mcp", type: "user_message", content: "old question" } },
    ]);

    const out = await call(
      "assistant_send",
      { handle: "cinatra", threadId: "thread-1", message: "follow-up" },
      memberFrame,
    );
    expect(out.status).toBe("completed");
    const args = mocks.runAssistantTurn.mock.calls[0][1] as { messages: Array<{ role: string; content: string }> };
    expect(args.messages).toEqual([
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "follow-up" },
    ]);
  });

  it("surfaces a runtime failure as a structured code with NO raw exception text", async () => {
    mocks.runAssistantTurn.mockRejectedValue(new Error("SECRET_INTERNAL_DETAIL"));
    const out = await call("assistant_send", { handle: "cinatra", message: "hi" }, memberFrame);
    expect(out.status).toBe("failed");
    expect(out.code).toBe("TURN_FAILED");
    expect(JSON.stringify(out)).not.toContain("SECRET_INTERNAL_DETAIL");
    // The turn row is finalized as an error, never left running.
    expect(mocks.updateAssistantTurn).toHaveBeenCalledWith("turn-2", { status: "error" });
  });

  it("sanitizes a runtime 'error' EVENT (provider/SDK text) — envelope AND durable log get the generic message", async () => {
    mocks.runAssistantTurn.mockImplementation(async (_cfg: unknown, args: { send: (e: string, d: unknown) => void }) => {
      args.send("error", { message: "401 invalid api key sk-UPSTREAM-SECRET" });
    });
    const out = await call("assistant_send", { handle: "cinatra", message: "hi" }, memberFrame);
    expect(out.status).toBe("failed");
    expect(out.code).toBe("TURN_FAILED");
    expect(JSON.stringify(out)).not.toContain("sk-UPSTREAM-SECRET");
    // The persisted turn_error frame carries the generic message only.
    const errorFrames = mocks.xaddRunEvent.mock.calls.filter((c) => c[1].type === "turn_error");
    expect(errorFrames).toHaveLength(1);
    expect(JSON.stringify(errorFrames[0][1])).not.toContain("sk-UPSTREAM-SECRET");
    expect(mocks.updateAssistantTurn).toHaveBeenCalledWith("turn-2", { status: "error" });
  });

  it("a runtime 'error' EVENT after PARTIAL text completes with the streamed text, logs the raw error server-side, and never surfaces it", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mocks.runAssistantTurn.mockImplementation(async (_cfg: unknown, args: { send: (e: string, d: unknown) => void }) => {
        args.send("text", { content: "partial answer" });
        args.send("error", { message: "503 upstream sk-LATE-SECRET" });
      });
      const out = await call("assistant_send", { handle: "cinatra", message: "hi" }, memberFrame);
      expect(out.status).toBe("completed");
      expect(out.finalMessage).toBe("partial answer");
      expect(JSON.stringify(out)).not.toContain("sk-LATE-SECRET");
      // The raw error is NOT dropped silently: it lands in the server-side log…
      expect(warnSpy.mock.calls.some((c) => c.join(" ").includes("sk-LATE-SECRET"))).toBe(true);
      // …and never in the durable event log (the terminal frame is the final text).
      const frames = mocks.xaddRunEvent.mock.calls.map((c) => JSON.stringify(c[1])).join("|");
      expect(frames).not.toContain("sk-LATE-SECRET");
      expect(mocks.updateAssistantTurn).toHaveBeenCalledWith("turn-2", { status: "completed" });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("finalizes the turn row as error when a PRE-DRIVE fault occurs after the running row exists", async () => {
    mocks.touchAssistantThread.mockImplementation(() => {
      throw new Error("DB_WRITE_FAULT");
    });
    const out = await call("assistant_send", { handle: "cinatra", message: "hi" }, memberFrame);
    expect(out.status).toBe("failed");
    expect(out.code).toBe("TURN_FAILED");
    expect(JSON.stringify(out)).not.toContain("DB_WRITE_FAULT");
    // The running assistant turn (turn-2) is terminalized, never stranded.
    expect(mocks.updateAssistantTurn).toHaveBeenCalledWith("turn-2", { status: "error" });
    expect(mocks.runAssistantTurn).not.toHaveBeenCalled();
  });

  it("never throws to the transport — an unexpected substrate fault is a sanitized failed envelope", async () => {
    mocks.resolveAssistantHandles.mockRejectedValue(new Error("DB_CONNECTION_SECRET"));
    const out = await call("assistant_send", { handle: "cinatra", message: "hi" }, memberFrame);
    expect(out.status).toBe("failed");
    expect(out.code).toBe("ASSISTANT_MCP_ERROR");
    expect(JSON.stringify(out)).not.toContain("DB_CONNECTION_SECRET");
  });
});

// ── assistant_thread_list / assistant_thread_get ─────────────────────────────

describe("assistant_thread_list", () => {
  it("lists via the store-side VISIBILITY predicate for non-admins and re-filters per row", async () => {
    // The store-side predicate already excludes foreign rows in production;
    // the mock returns one anyway to prove the pure decision re-filters it
    // (defense-in-depth against predicate drift).
    mocks.listAssistantThreadsForOrgVisibleTo.mockReturnValue([
      thread({ id: "mine" }),
      thread({ id: "foreign", ownerUserId: "someone-else", assistantUserId: HELPER_ID }),
    ]);
    const out = await call("assistant_thread_list", {}, memberFrame);
    expect(out.status).toBe("ok");
    const threads = out.threads as Array<Record<string, unknown>>;
    expect(threads.map((t) => t.threadId)).toEqual(["mine"]);
    expect(threads[0].assistantHandle).toBe("cinatra");
    // Non-admins page through the store-side owner/participant predicate so a
    // newer foreign thread can never crowd a visible one out of the page
    // (codex round-1 #1); admins keep the org-wide read.
    expect(mocks.listAssistantThreadsForOrgVisibleTo).toHaveBeenCalledWith(ORG, USER, 50);
    expect(mocks.listAssistantThreadsForOrg).not.toHaveBeenCalled();
  });

  it("admins list the org-wide window", async () => {
    mocks.listAssistantThreadsForOrg.mockReturnValue([thread({ id: "any" })]);
    const out = await call("assistant_thread_list", {}, adminFrame);
    expect(out.status).toBe("ok");
    expect(mocks.listAssistantThreadsForOrg).toHaveBeenCalledWith(ORG, 50);
    expect(mocks.listAssistantThreadsForOrgVisibleTo).not.toHaveBeenCalled();
  });
});

describe("assistant_thread_get", () => {
  it("returns turns with recovered text + streamRef for terminal turns", async () => {
    mocks.getAssistantThread.mockReturnValue(thread());
    mocks.listAssistantTurns.mockReturnValue([
      { id: "t1", threadId: "thread-1", runId: null, assistantUserId: null, role: "user", status: "completed", createdAt: "", updatedAt: "" },
      { id: "t2", threadId: "thread-1", runId: "run-1", assistantUserId: CINATRA_ID, role: "assistant", status: "completed", createdAt: "", updatedAt: "" },
    ]);
    mocks.readRecentRunEventsReverse.mockResolvedValue([
      { id: "2-1", event: { channel: "assistant-mcp", type: "final_message", content: "recovered" } },
    ]);
    const out = await call("assistant_thread_get", { threadId: "thread-1" }, memberFrame);
    expect(out.status).toBe("ok");
    const turns = out.turns as Array<Record<string, unknown>>;
    expect(turns).toHaveLength(2);
    expect(turns[1].text).toBe("recovered");
    expect(turns[1].streamRef).toBe("cinatra:a2a:events:run-1");
    expect((out.thread as Record<string, unknown>).assistantHandle).toBe("cinatra");
  });

  it("allows the bound assistant principal (participant axis) to read the thread", async () => {
    mocks.getAssistantThread.mockReturnValue(thread({ ownerUserId: "someone-else" }));
    const out = await call(
      "assistant_thread_get",
      { threadId: "thread-1" },
      { userId: CINATRA_ID, orgId: ORG, platformRole: "member" },
    );
    expect(out.status).toBe("ok");
  });

  it("reconciles a stranded 'running' row from the durable terminal frame (read-time repair)", async () => {
    mocks.getAssistantThread.mockReturnValue(thread());
    mocks.listAssistantTurns.mockReturnValue([
      { id: "t2", threadId: "thread-1", runId: "run-1", assistantUserId: CINATRA_ID, role: "assistant", status: "running", createdAt: "", updatedAt: "" },
    ]);
    mocks.readRecentRunEventsReverse.mockResolvedValue([
      { id: "2-1", event: { channel: "assistant-mcp", type: "final_message", content: "late but done" } },
    ]);
    const out = await call("assistant_thread_get", { threadId: "thread-1" }, memberFrame);
    const turns = out.turns as Array<Record<string, unknown>>;
    // The terminal frame is authoritative: the poller sees completed + text
    // even though the row missed its status update (codex round-1 #2)...
    expect(turns[0].status).toBe("completed");
    expect(turns[0].text).toBe("late but done");
    // ...and the row is best-effort repaired.
    expect(mocks.updateAssistantTurn).toHaveBeenCalledWith("t2", { status: "completed" });
  });

  it("leaves a genuinely running turn as 'running' (no terminal frame yet)", async () => {
    mocks.getAssistantThread.mockReturnValue(thread());
    mocks.listAssistantTurns.mockReturnValue([
      { id: "t2", threadId: "thread-1", runId: "run-1", assistantUserId: CINATRA_ID, role: "assistant", status: "running", createdAt: "", updatedAt: "" },
    ]);
    mocks.readRecentRunEventsReverse.mockResolvedValue([
      { id: "1-1", event: { channel: "assistant-mcp", type: "user_message", content: "hi" } },
    ]);
    const out = await call("assistant_thread_get", { threadId: "thread-1" }, memberFrame);
    const turns = out.turns as Array<Record<string, unknown>>;
    expect(turns[0].status).toBe("running");
    expect(turns[0].text).toBeUndefined();
    expect(mocks.updateAssistantTurn).not.toHaveBeenCalled();
  });

  it("404-hides a missing thread and a denied thread identically", async () => {
    const missing = await call("assistant_thread_get", { threadId: "nope" }, memberFrame);
    mocks.getAssistantThread.mockReturnValue(thread({ ownerUserId: "someone-else" }));
    const denied = await call("assistant_thread_get", { threadId: "thread-1" }, memberFrame);
    expect(missing).toEqual(denied);
    expect(missing.code).toBe("NOT_FOUND");
  });
});

// ── delegated-chat policy (the epic's open decision, resolved) ───────────────

describe("delegated-chat tool policy", () => {
  it("DENIES all three assistant tools on the delegated-chat perimeter (intentional; no CarveOut, no rename)", () => {
    expect(isDelegatedChatMcpToolAllowed("assistant_send")).toBe(false);
    expect(isDelegatedChatMcpToolAllowed("assistant_thread_list")).toBe(false);
    expect(isDelegatedChatMcpToolAllowed("assistant_thread_get")).toBe(false);
  });
});
