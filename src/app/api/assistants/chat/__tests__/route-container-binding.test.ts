// POST /api/assistants/chat — the CONTAINER a turn binds its thread to
// (cinatra#2650). The wiring proof: what reaches the store is the SERVER's
// resolution of the container, on BOTH create orderings, and no
// client-controlled field can move it.
//
// A separate file from route.test.ts so that suite stays byte-unchanged.
//
// The container gate itself runs FOR REAL here — `resolveChatContainer` is the
// shipped function, driven through the shipped route, with only its two data
// sources (the actor's audience-filtered registry, the per-instance authority)
// injected. So a refusal below is the real refusal, not a mocked one.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ASSISTANT_PACKAGE } from "@cinatra-ai/chat/chat-path-codec";
import type { AssistantRegistryEntry } from "@/lib/assistant-registry-reader";

const getAuthSession = vi.fn();
const requireActorContext = vi.fn();
const isPlatformAdmin = vi.fn();
const describeLlmRuntimeUnavailability = vi.fn();
const runChatTurn = vi.fn();
const readChatThreadOwnershipById = vi.fn();
const createAssistantThread = vi.fn();
const getAssistantThread = vi.fn();
const bindThreadContainerIfUnbound = vi.fn();
const appendAssistantTurn = vi.fn();
const updateAssistantTurn = vi.fn();
const touchAssistantThread = vi.fn();
const xaddRunEvent = vi.fn();
const expireRunStream = vi.fn();
const resolveAssistantHandles = vi.fn();
const resolveAssistantRuntimeConfigByPrincipal = vi.fn();
const runAssistantTurn = vi.fn();
const isSelectedAssistantVisible = vi.fn();
const authorizeInstance = vi.fn();
const readVisibleRegistry = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: () => getAuthSession(),
  requireActorContext: () => requireActorContext(),
  isPlatformAdmin: (s: unknown) => isPlatformAdmin(s),
}));
vi.mock("@/app/api/chat/runner", () => ({
  describeLlmRuntimeUnavailability: () => describeLlmRuntimeUnavailability(),
  runChatTurn: (...a: unknown[]) => runChatTurn(...a),
}));
vi.mock("@/lib/better-auth-db", () => ({
  resolveAssistantHandles: (...a: unknown[]) => resolveAssistantHandles(...a),
  // cinatra#2674 — the widget branch resolves the person's real platform tier
  // here. `false` is the ordinary case; the elevated one is asserted in the
  // parity suites, not by re-running the whole route.
  readUserIsPlatformAdmin: async () => false,
}));
vi.mock("@/lib/assistant-registry-reader", () => ({
  isBuiltinAssistantByPackage: () => Promise.resolve(false),
}));
vi.mock("@/lib/assistant-runtime/resolve-runtime-config", () => ({
  resolveAssistantRuntimeConfigByPrincipal: (...a: unknown[]) =>
    resolveAssistantRuntimeConfigByPrincipal(...a),
}));
vi.mock("@/lib/assistant-runtime/runtime", () => ({
  runAssistantTurn: (...a: unknown[]) => runAssistantTurn(...a),
}));
vi.mock("@/lib/assistant-selector-audience", () => ({
  isSelectedAssistantVisible: (...a: unknown[]) => isSelectedAssistantVisible(...a),
  sessionSelectorCaller: (userId: string, orgId: string | null, platformRole: string) => ({
    userId,
    orgId: orgId ?? "",
    platformRole,
  }),
  widgetSelectorCaller: (p: { userId: string; orgId: string }) => ({
    userId: p.userId,
    orgId: p.orgId,
    platformRole: "member",
  }),
}));
vi.mock("@/lib/chat-thread-store", () => ({
  readChatThreadOwnershipById: (id: string) => readChatThreadOwnershipById(id),
  isActorTeamMemberForChat: () => false,
}));
vi.mock("@/lib/assistant-thread-store", () => ({
  createAssistantThread: (...a: unknown[]) => createAssistantThread(...a),
  getAssistantThread: (id: string) => getAssistantThread(id),
  bindThreadContainerIfUnbound: (...a: unknown[]) => bindThreadContainerIfUnbound(...a),
  appendAssistantTurn: (...a: unknown[]) => appendAssistantTurn(...a),
  updateAssistantTurn: (...a: unknown[]) => updateAssistantTurn(...a),
  touchAssistantThread: (id: string) => touchAssistantThread(id),
}));
// The REAL container gate, with only its two data sources injected.
vi.mock("@/lib/chat-route-resolver", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/chat-route-resolver");
  return {
    ...actual,
    resolveChatContainerForCurrentActor: (assertion: unknown) =>
      actual.resolveChatContainer(assertion as never, {
        readVisibleRegistry: () => readVisibleRegistry(),
        authorizeInstance: (...a: unknown[]) => authorizeInstance(...a),
      }),
  };
});
vi.mock("@cinatra-ai/a2a", () => ({
  xaddRunEvent: (...a: unknown[]) => xaddRunEvent(...a),
  expireRunStream: (...a: unknown[]) => expireRunStream(...a),
}));
vi.mock("@cinatra-ai/agent-ui-protocol/server", () => ({
  subscribeToAgUiEventsWithId: async function* () {
    for (let i = 0; i < 200; i++) {
      const events = xaddRunEvent.mock.calls.map((c) => c[1] as Record<string, unknown>);
      const terminalIdx = events.findIndex(
        (e) => e.type === "RUN_FINISHED" || e.type === "RUN_ERROR",
      );
      if (terminalIdx >= 0) {
        for (let j = 0; j <= terminalIdx; j++) {
          const { channel: _c, ...event } = events[j]!;
          yield { id: `${j + 1}-0`, event };
          void _c;
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("no terminal event appended");
  },
}));

import { POST } from "../route";

const LOCAL = "@acme/helper-assistant";
const REMOTE = "@cinatra-ai/wordpress-assistant";
const THREAD_ID = "cc862657-cbad-4aa9-b815-36eb839510da";

function entry(
  over: Partial<AssistantRegistryEntry> & { packageName: string },
): AssistantRegistryEntry {
  return {
    templateId: "t",
    assistantUserId: "au",
    handle: "h",
    displayName: "N",
    origin: "extension",
    aliases: [],
    isBuiltin: false,
    delivery: "host-runtime",
    launch: { kind: "local", targetProvider: null },
    ...over,
  };
}

function chatReq(body: unknown): Request {
  return new Request("https://app.test/api/assistants/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const turn = { threadId: THREAD_ID, messages: [{ role: "user" as const, content: "hi" }] };

beforeEach(() => {
  vi.clearAllMocks();
  getAuthSession.mockResolvedValue({
    user: { id: "user-1" },
    session: { activeOrganizationId: "org-1" },
  });
  requireActorContext.mockResolvedValue({ actorType: "human", userId: "user-1" });
  isPlatformAdmin.mockReturnValue(false);
  describeLlmRuntimeUnavailability.mockResolvedValue(null);
  readChatThreadOwnershipById.mockReturnValue(null);
  getAssistantThread.mockReturnValue(null);
  createAssistantThread.mockImplementation((input: Record<string, unknown>) => input);
  bindThreadContainerIfUnbound.mockReturnValue({ kind: "bound" });
  appendAssistantTurn.mockImplementation((i: Record<string, unknown>) => ({ id: "turn-1", ...i }));
  xaddRunEvent.mockResolvedValue("1-0");
  expireRunStream.mockResolvedValue(undefined);
  readVisibleRegistry.mockResolvedValue([
    entry({ packageName: DEFAULT_ASSISTANT_PACKAGE, isBuiltin: true }),
    entry({ packageName: LOCAL }),
    entry({ packageName: REMOTE, launch: { kind: "remote", targetProvider: "wordpress" } }),
  ]);
  authorizeInstance.mockResolvedValue(true);
  runChatTurn.mockImplementation(async (args: { send: (e: string, d: unknown) => void }) => {
    args.send("done", {});
  });
});

/** Drain the SSE body so the turn completes before assertions. */
async function run(body: unknown): Promise<Response> {
  const res = await POST(chatReq(body));
  if (res.body) await res.text();
  return res;
}

describe("the container a new thread is bound to", () => {
  it("NO assertion ⇒ the implicit default container is bound AT THE INSERT", async () => {
    await run(turn);
    expect(createAssistantThread).toHaveBeenCalledWith(
      expect.objectContaining({
        id: THREAD_ID,
        ownerUserId: "user-1",
        assistantPackage: DEFAULT_ASSISTANT_PACKAGE,
        instanceId: null,
      }),
    );
  });

  it("an in-audience NON-DEFAULT assertion binds that container at the insert", async () => {
    await run({ ...turn, chatContainer: { assistantPackage: LOCAL } });
    expect(createAssistantThread).toHaveBeenCalledWith(
      expect.objectContaining({ assistantPackage: LOCAL, instanceId: null }),
    );
  });

  it("an AUTHORIZED instance-scoped assertion binds both halves", async () => {
    await run({ ...turn, chatContainer: { assistantPackage: REMOTE, instanceId: "site-1" } });
    expect(authorizeInstance).toHaveBeenCalledWith("wordpress", "site-1");
    expect(createAssistantThread).toHaveBeenCalledWith(
      expect.objectContaining({ assistantPackage: REMOTE, instanceId: "site-1" }),
    );
  });

  // AC#3 — the binding cannot be moved by what the caller writes.
  it("the CANONICAL registry spelling is bound, never the caller's casing", async () => {
    await run({ ...turn, chatContainer: { assistantPackage: "@ACME/HELPER-ASSISTANT" } });
    expect(createAssistantThread).toHaveBeenCalledWith(
      expect.objectContaining({ assistantPackage: LOCAL }),
    );
  });

  it("an OUT-OF-AUDIENCE assertion 404s and persists NOTHING — never silently downgraded to the default", async () => {
    // POST directly (not the draining `run` helper) so the refusal BODY is
    // readable — the shape matters: it is the same 404-hide a forged producer
    // selection gets, disclosing nothing about the container's existence.
    const res = await POST(chatReq({ ...turn, chatContainer: { assistantPackage: "@evil/not-installed" } }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Assistant not found" });
    expect(createAssistantThread).not.toHaveBeenCalled();
    expect(bindThreadContainerIfUnbound).not.toHaveBeenCalled();
    expect(appendAssistantTurn).not.toHaveBeenCalled();
  });

  it("an UNAUTHORIZED instance 404s and persists nothing", async () => {
    authorizeInstance.mockResolvedValue(false);
    const res = await run({
      ...turn,
      chatContainer: { assistantPackage: REMOTE, instanceId: "someone-elses-site" },
    });
    expect(res.status).toBe(404);
    expect(createAssistantThread).not.toHaveBeenCalled();
  });

  // The container is the thread's HOME; `assistant` is this turn's PRODUCER.
  // A @mention must never re-home the conversation out of the container the
  // client's own URL addresses it at.
  it("the PRODUCER selector never moves the binding — an @mentioned assistant answers the turn, the container stays", async () => {
    resolveAssistantHandles.mockResolvedValue(new Map([["wordpress", "assistant-user-9"]]));
    isSelectedAssistantVisible.mockResolvedValue(true);
    resolveAssistantRuntimeConfigByPrincipal.mockResolvedValue({ ok: true, runtimeConfig: {} });
    runAssistantTurn.mockImplementation(async (_c: unknown, args: { send: (e: string, d: unknown) => void }) => {
      args.send("done", {});
    });

    await run({ ...turn, assistant: "wordpress" });

    expect(runAssistantTurn).toHaveBeenCalled(); // the mention DID drive the turn
    expect(createAssistantThread).toHaveBeenCalledWith(
      expect.objectContaining({ assistantPackage: DEFAULT_ASSISTANT_PACKAGE }),
    );
  });

  it("an unknown `assistant` selector cannot become a container either — it 404s on its own gate", async () => {
    resolveAssistantHandles.mockResolvedValue(new Map());
    const res = await run({ ...turn, assistant: "nope" });
    expect(res.status).toBe(404);
  });
});

describe("the MIRROR-WON ordering (the field's normal one)", () => {
  beforeEach(() => {
    // The client's unawaited save already INSERTed the row, so the turn does not
    // create it — `needsStructuredRow` is false.
    readChatThreadOwnershipById.mockReturnValue({ ownerUserId: "user-1", teamId: null });
    getAssistantThread.mockReturnValue({ id: THREAD_ID, ownerUserId: "user-1" });
  });

  it("binds the resolved container through the set-once primitive instead of the insert", async () => {
    await run({ ...turn, chatContainer: { assistantPackage: LOCAL } });
    expect(createAssistantThread).not.toHaveBeenCalled();
    expect(bindThreadContainerIfUnbound).toHaveBeenCalledWith(
      THREAD_ID,
      { assistantPackage: LOCAL, instanceId: null },
      { userId: "user-1", orgId: "org-1" },
    );
  });

  it("binds BEFORE the turn row is appended — so a first turn that fails afterwards still leaves a bound thread", async () => {
    await run(turn);
    const bindOrder = bindThreadContainerIfUnbound.mock.invocationCallOrder[0]!;
    const appendOrder = appendAssistantTurn.mock.invocationCallOrder[0]!;
    expect(bindOrder).toBeLessThan(appendOrder);
  });

  it("a REFUSED bind does not fail the turn — the row stays exactly as unbound as it is today, where the #2649 backstop still reaches it", async () => {
    bindThreadContainerIfUnbound.mockReturnValue({ kind: "refused-ineligible" });
    const res = await run(turn);
    expect(res.status).toBe(200);
    expect(appendAssistantTurn).toHaveBeenCalled();
  });

  it("an ALREADY-BOUND thread is left in the home it has — a later turn is a producer change, never a re-homing", async () => {
    bindThreadContainerIfUnbound.mockReturnValue({
      kind: "bound-elsewhere",
      container: { assistantPackage: REMOTE, instanceId: null },
    });
    const res = await run({ ...turn, chatContainer: { assistantPackage: LOCAL } });
    expect(res.status).toBe(200);
    // exactly one bind attempt, and no compensating write
    expect(bindThreadContainerIfUnbound).toHaveBeenCalledTimes(1);
  });
});

describe("the create arm does not double-write", () => {
  it("a thread this request CREATES is bound by its INSERT and never touches the set-once primitive", async () => {
    await run({ ...turn, chatContainer: { assistantPackage: LOCAL } });
    expect(createAssistantThread).toHaveBeenCalledTimes(1);
    expect(bindThreadContainerIfUnbound).not.toHaveBeenCalled();
  });

  it("a LOST create race falls through to the set-once bind against the row that won", async () => {
    createAssistantThread.mockImplementation(() => {
      throw new Error("duplicate key value violates unique constraint");
    });
    getAssistantThread.mockReturnValue({ id: THREAD_ID, ownerUserId: "user-1" });
    await run({ ...turn, chatContainer: { assistantPackage: LOCAL } });
    expect(bindThreadContainerIfUnbound).toHaveBeenCalledWith(
      THREAD_ID,
      { assistantPackage: LOCAL, instanceId: null },
      { userId: "user-1", orgId: "org-1" },
    );
  });
});
