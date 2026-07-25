// Headless AG-UI chat client (cinatra#1218) — unit matrix.
// Drift pins (wire guard · contract-version literal · reducer view classifier)
// · SSE frame parsing · fail-closed handshake (server-executed negotiation) ·
// stream folding incl. the one-shot durable-log resume · UiMessage projection
// field-presence · the full turn driver lifecycle. The bespoke-vs-AG-UI
// equivalence lives in the S2 parity gate
// (src/lib/assistant-runtime/__tests__/ag-ui-cutover-parity.test.ts).

import { afterEach, describe, expect, it, vi } from "vitest";
import { AG_UI_EVENT_TYPES } from "@cinatra-ai/agent-ui-protocol";
import type { AgUiEvent } from "@cinatra-ai/agent-ui-protocol";
import { ASSISTANT_STREAM_CONTRACT_VERSION } from "@cinatra-ai/agent-ui-protocol/contract";
import { renderableViewType } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import {
  AG_UI_WIRE_EVENT_TYPES,
  CLIENT_SUPPORTED_CONTRACTS,
  __resetAssistantChatNegotiation,
  driveAssistantChatTurn,
  ensureAssistantChatWireNegotiated,
  isWireAgUiEvent,
  negotiateAssistantChatContract,
  parseSseFrame,
  projectConversationMessage,
  streamAssistantTurn,
  type AssistantChatTurnUiPort,
} from "../ag-ui-chat-client";
import { reduceAgUiEvents, renderableViewTypeOf } from "../renderer/ag-ui-reducer";
import type { UiMessage } from "../types";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  __resetAssistantChatNegotiation();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sseBody(frames: Array<{ id?: string; event: AgUiEvent }>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const { id, event } of frames) {
        const frame = id
          ? `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`
          : `data: ${JSON.stringify(event)}\n\n`;
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
}

function turnFrames(): Array<{ id: string; event: AgUiEvent }> {
  return [
    { id: "1-0", event: { type: "RUN_STARTED", threadId: "th1", runId: "r1" } },
    { id: "2-0", event: { type: "TEXT_MESSAGE_START", messageId: "m1" } },
    { id: "3-0", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Hello" } },
    { id: "4-0", event: { type: "TEXT_MESSAGE_END", messageId: "m1" } },
    { id: "5-0", event: { type: "RUN_FINISHED", threadId: "th1", runId: "r1" } },
  ];
}

// ---------------------------------------------------------------------------
// Drift pins — the local mirrors stay equal to the S1 modules
// ---------------------------------------------------------------------------

describe("drift pins", () => {
  it("AG_UI_WIRE_EVENT_TYPES is EXACTLY the S1 AG_UI_EVENT_TYPES vocabulary", () => {
    expect(new Set(AG_UI_EVENT_TYPES)).toEqual(AG_UI_WIRE_EVENT_TYPES);
  });

  it("CLIENT_SUPPORTED_CONTRACTS carries the S1 contract version", () => {
    expect(CLIENT_SUPPORTED_CONTRACTS).toContain(ASSISTANT_STREAM_CONTRACT_VERSION);
  });

  it("the reducer's local renderableViewTypeOf matches the S1 classifier", () => {
    const matrix: unknown[] = [
      { viewType: "content_change_proposal", fields: [] }, // registered view
      { viewType: "totally_unknown_view" }, // unregistered view
      { viewType: "" }, // empty discriminator
      { viewType: 42 }, // non-string discriminator
      { kind: "citations", citations: [] }, // plain structural payload
      {},
      [],
      null,
      "viewType",
    ];
    for (const payload of matrix) {
      expect(renderableViewTypeOf(payload)).toBe(renderableViewType(payload));
    }
    // Hostile getter: both sides THROW (the reducer's guarded call site treats
    // a throw as "is a view" so the safe fallback renders).
    const hostile = new Proxy({}, { get() { throw new Error("trap"); } });
    expect(() => renderableViewTypeOf(hostile)).toThrow();
    expect(() => renderableViewType(hostile)).toThrow();
  });

  it("isWireAgUiEvent accepts every S1 type and rejects junk", () => {
    for (const type of AG_UI_EVENT_TYPES) {
      expect(isWireAgUiEvent({ type })).toBe(true);
    }
    expect(isWireAgUiEvent(null)).toBe(false);
    expect(isWireAgUiEvent("RUN_STARTED")).toBe(false);
    expect(isWireAgUiEvent({ type: "text" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SSE frame parsing
// ---------------------------------------------------------------------------

describe("parseSseFrame", () => {
  it("parses id + data frames", () => {
    expect(parseSseFrame('id: 12-0\ndata: {"type":"RUN_STARTED"}')).toEqual({
      id: "12-0",
      data: '{"type":"RUN_STARTED"}',
    });
  });
  it("returns null for keepalive comments and data-less blocks", () => {
    expect(parseSseFrame(": keepalive")).toBeNull();
    expect(parseSseFrame("id: 1-0")).toBeNull();
  });
  it("joins multiple data lines per the SSE spec", () => {
    expect(parseSseFrame("data: a\ndata: b")).toEqual({ data: "a\nb" });
  });
});

// ---------------------------------------------------------------------------
// Fail-closed capability handshake (the negotiation executes server-side; the
// client posts its hello and ENFORCES the outcome)
// ---------------------------------------------------------------------------

describe("negotiateAssistantChatContract", () => {
  it("posts the client hello and caches an ok negotiation", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ ok: true, contract: "1.0.0", authMode: "session", requiredViews: [] }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const first = await negotiateAssistantChatContract();
    const second = await negotiateAssistantChatContract();
    expect(first.ok).toBe(true);
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/assistants/chat/capabilities");
    expect(init.method).toBe("POST");
    const hello = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(hello).toEqual({
      supportedContracts: ["1.0.0"],
      authMode: "session",
      requiresResumable: true,
    });
  });

  it("ensureAssistantChatWireNegotiated fails CLOSED on a non-ok negotiation", async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        ok: false,
        reason: "no_mutual_contract",
        clientSupported: ["1.0.0"],
        serverSupported: ["9.0.0"],
      }),
    ) as unknown as typeof fetch;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await ensureAssistantChatWireNegotiated()).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("fails CLOSED (false) on a transport failure and does not cache it", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(
        Response.json({ ok: true, contract: "1.0.0", authMode: "session", requiredViews: [] }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await ensureAssistantChatWireNegotiated()).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    expect(await ensureAssistantChatWireNegotiated()).toBe(true); // retried
  });
});

// ---------------------------------------------------------------------------
// streamAssistantTurn — fold + resume
// ---------------------------------------------------------------------------

describe("streamAssistantTurn", () => {
  it("folds a full turn and reports every state to onState", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(sseBody(turnFrames()), { status: 200 }),
    ) as unknown as typeof fetch;
    const states: string[] = [];
    const final = await streamAssistantTurn({
      threadId: "th1",
      messages: [{ role: "user", content: "hi" }],
      signal: new AbortController().signal,
      onState: (s) => states.push(s.status),
    });
    expect(final.status).toBe("finished");
    expect(final.message.content).toBe("Hello");
    expect(states[0]).toBe("running");
    expect(states[states.length - 1]).toBe("finished");
  });

  it("throws on a non-ok response (legacy error-message parity)", async () => {
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(
      streamAssistantTurn({
        threadId: "th1",
        messages: [],
        signal: new AbortController().signal,
        onState: () => {},
      }),
    ).rejects.toThrow("Chat request failed.");
  });

  it("resumes ONCE from the durable-log tail after a mid-stream transport drop", async () => {
    const frames = turnFrames();
    // POST body: RUN_STARTED delivered, then the stream ERRORS mid-run.
    // (Erroring in start() would DISCARD the queued chunk per the streams
    // spec — error on the second pull so the first frame is actually read.)
    let pulls = 0;
    const brokenBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          const enc = new TextEncoder();
          controller.enqueue(
            enc.encode(`id: 1-0\ndata: ${JSON.stringify(frames[0].event)}\n\n`),
          );
        } else {
          controller.error(new Error("connection reset"));
        }
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(brokenBody, { status: 200 }))
      // Resume GET: the FULL replay from the durable log.
      .mockResolvedValueOnce(new Response(sseBody(frames), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const final = await streamAssistantTurn({
      threadId: "th1",
      messages: [{ role: "user", content: "hi" }],
      signal: new AbortController().signal,
      onState: () => {},
    });
    expect(final.status).toBe("finished");
    expect(final.message.content).toBe("Hello");
    const resumeUrl = fetchMock.mock.calls[1][0] as string;
    expect(resumeUrl).toBe("/api/assistants/runs/r1/stream");
  });

  it("resumes when the stream closes CLEANLY without a terminal frame", async () => {
    const frames = turnFrames();
    const fetchMock = vi
      .fn()
      // POST body: RUN_STARTED + one delta, then a clean close (no terminal).
      .mockResolvedValueOnce(new Response(sseBody(frames.slice(0, 3)), { status: 200 }))
      .mockResolvedValueOnce(new Response(sseBody(frames), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const final = await streamAssistantTurn({
      threadId: "th1",
      messages: [],
      signal: new AbortController().signal,
      onState: () => {},
    });
    expect(final.status).toBe("finished");
    expect(final.message.content).toBe("Hello");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not resume when aborted (clean AbortError propagation)", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(sc) {
            const enc = new TextEncoder();
            sc.enqueue(enc.encode(`data: ${JSON.stringify(turnFrames()[0].event)}\n\n`));
            signal?.addEventListener("abort", () => {
              const err = new Error("The operation was aborted.");
              err.name = "AbortError";
              sc.error(err);
            });
          },
        }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const pending = streamAssistantTurn({
      threadId: "th1",
      messages: [],
      signal: controller.signal,
      onState: (s) => {
        if (s.runId) controller.abort();
      },
    });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1); // no resume attempt
  });
});

// ---------------------------------------------------------------------------
// Projection field-presence (the persisted-JSON shape seam)
// ---------------------------------------------------------------------------

describe("projectConversationMessage", () => {
  const finishedState = reduceAgUiEvents(turnFrames().map((f) => f.event));

  it("ChatGPT mode carries parts/thoughtGroups and drops cleared liveStatus", () => {
    const msg = projectConversationMessage(finishedState, { assistantId: "a1" });
    expect(msg.id).toBe("a1");
    expect(msg.content).toBe("Hello");
    expect(Array.isArray(msg.parts)).toBe(true);
    expect("liveStatus" in msg).toBe(false);
    expect("citations" in msg).toBe(false);
    expect("error" in msg).toBe(false);
  });

  it("attributes external authors only when supplied", () => {
    const withAuthor = projectConversationMessage(finishedState, { assistantId: "a1", authorUserId: "u9" });
    const without = projectConversationMessage(finishedState, { assistantId: "a1" });
    expect(withAuthor.authorUserId).toBe("u9");
    expect("authorUserId" in without).toBe(false);
  });

  it("Slack mode NEVER carries parts (the pinned Slack layout)", () => {
    const msg = projectConversationMessage(finishedState, { assistantId: "a1", slackMode: true });
    expect("parts" in msg).toBe(false);
    expect(msg.content).toBe("Hello");
  });
});

// ---------------------------------------------------------------------------
// driveAssistantChatTurn — the full lifecycle behind the UI port
// ---------------------------------------------------------------------------

function fakePort() {
  let messages: UiMessage[] = [];
  const typing: boolean[] = [];
  const refreshes: string[] = [];
  const port: AssistantChatTurnUiPort = {
    updateMessages: (updater) => {
      messages = updater(messages);
    },
    setTypingIndicator: (on) => typing.push(on),
    isWidgetRefreshTool: (name) => name === "widget_update",
    onWidgetRefresh: () => refreshes.push("hit"),
  };
  return { port, get messages() { return messages; }, typing, refreshes };
}

describe("driveAssistantChatTurn", () => {
  it("ChatGPT mode: inserts the empty bubble then projects per fold", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(sseBody(turnFrames()), { status: 200 }),
    ) as unknown as typeof fetch;
    const f = fakePort();
    await driveAssistantChatTurn({
      threadId: "th1",
      assistantId: "a1",
      messages: [{ role: "user", content: "hi" }],
      slack: false,
      signal: new AbortController().signal,
      ui: f.port,
    });
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0].id).toBe("a1");
    expect(f.messages[0].content).toBe("Hello");
    expect(f.typing).toEqual([]); // no indicator in ChatGPT mode
  });

  it("Slack mode: typing indicator on/off and ONE atomic parts-less reveal", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(sseBody(turnFrames()), { status: 200 }),
    ) as unknown as typeof fetch;
    const f = fakePort();
    await driveAssistantChatTurn({
      threadId: "th1",
      assistantId: "a1",
      messages: [{ role: "user", content: "hi" }],
      slack: true,
      authorUserId: "u7",
      signal: new AbortController().signal,
      ui: f.port,
    });
    expect(f.typing).toEqual([true, false]);
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0].authorUserId).toBe("u7");
    expect("parts" in f.messages[0]).toBe(false);
  });

  it("fires the widget-refresh hook from TOOL_CALL_END via the folded tool name", async () => {
    const frames: Array<{ id: string; event: AgUiEvent }> = [
      { id: "1-0", event: { type: "RUN_STARTED", threadId: "th1", runId: "r1" } },
      { id: "2-0", event: { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "widget_update" } },
      { id: "3-0", event: { type: "TOOL_CALL_END", toolCallId: "t1" } },
      { id: "4-0", event: { type: "RUN_FINISHED", threadId: "th1", runId: "r1" } },
    ];
    globalThis.fetch = vi.fn(async () =>
      new Response(sseBody(frames), { status: 200 }),
    ) as unknown as typeof fetch;
    const f = fakePort();
    await driveAssistantChatTurn({
      threadId: "th1",
      assistantId: "a1",
      messages: [],
      slack: false,
      signal: new AbortController().signal,
      ui: f.port,
    });
    expect(f.refreshes).toEqual(["hit"]);
  });

  it("surfaces a transport error on the bubble (never throws)", async () => {
    globalThis.fetch = vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const f = fakePort();
    await driveAssistantChatTurn({
      threadId: "th1",
      assistantId: "a1",
      messages: [],
      slack: false,
      signal: new AbortController().signal,
      ui: f.port,
    });
    expect(f.messages[0].error).toBe("Chat request failed.");
  });

  it("Slack mode surfaces a caught error as an error bubble in finally", async () => {
    globalThis.fetch = vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const f = fakePort();
    await driveAssistantChatTurn({
      threadId: "th1",
      assistantId: "a1",
      messages: [],
      slack: true,
      signal: new AbortController().signal,
      ui: f.port,
    });
    expect(f.typing).toEqual([true, false]);
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0].error).toBe("Chat request failed.");
    expect(f.messages[0].content).toBe("");
  });

  it("defaults to the Cinatra producer endpoint when none is given", async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(sseBody(turnFrames()), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const f = fakePort();
    await driveAssistantChatTurn({
      threadId: "th1",
      assistantId: "a1",
      messages: [{ role: "user", content: "hi" }],
      slack: false,
      signal: new AbortController().signal,
      ui: f.port,
    });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/assistants/chat");
  });

  it("routes to a custom producer endpoint when one is given", async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(sseBody(turnFrames()), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const f = fakePort();
    await driveAssistantChatTurn({
      threadId: "th1",
      assistantId: "a1",
      messages: [{ role: "user", content: "hi" }],
      slack: false,
      endpoint: "/api/assistants/custom-producer",
      signal: new AbortController().signal,
      ui: f.port,
    });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/assistants/custom-producer");
    expect(f.messages[0].content).toBe("Hello");
  });

  it("preserves the custom endpoint on the retry-once (pre-stream network failure) path", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        // First attempt: a pre-stream network failure (TypeError: Failed to fetch).
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        // Retry: succeeds.
        .mockResolvedValueOnce(new Response(sseBody(turnFrames()), { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const f = fakePort();
      const pending = driveAssistantChatTurn({
        threadId: "th1",
        assistantId: "a1",
        messages: [{ role: "user", content: "retry me" }],
        slack: false,
        endpoint: "/api/assistants/custom-producer",
        signal: new AbortController().signal,
        ui: f.port,
      });
      await vi.advanceTimersByTimeAsync(3000); // the retry-once backoff
      await pending;
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // BOTH the initial attempt and the retry target the custom endpoint —
      // never a silent downgrade to the Cinatra default endpoint.
      expect(fetchMock.mock.calls[0][0]).toBe("/api/assistants/custom-producer");
      expect(fetchMock.mock.calls[1][0]).toBe("/api/assistants/custom-producer");
    } finally {
      vi.useRealTimers();
    }
  });

  it("is silent on abort (no error patch, indicator cleaned up)", async () => {
    const controller = new AbortController();
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(sc) {
            const enc = new TextEncoder();
            sc.enqueue(enc.encode(`data: ${JSON.stringify(turnFrames()[0].event)}\n\n`));
            signal?.addEventListener("abort", () => {
              const err = new Error("The operation was aborted.");
              err.name = "AbortError";
              sc.error(err);
            });
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const f = fakePort();
    let writes = 0;
    const pending = driveAssistantChatTurn({
      threadId: "th1",
      assistantId: "a1",
      messages: [],
      slack: false,
      signal: controller.signal,
      ui: {
        ...f.port,
        updateMessages: (updater) => {
          f.port.updateMessages(updater);
          // Abort once the FIRST projection lands (write 1 is the empty
          // bubble insert, which happens before the fetch).
          writes += 1;
          if (writes === 2) controller.abort();
        },
      },
    });
    await pending; // resolves silently
    for (const m of f.messages) expect(m.error).toBeUndefined();
  });
});
