"use client";

// ---------------------------------------------------------------------------
// Headless AG-UI chat client (cinatra#1218, epic #1216 S2).
// ---------------------------------------------------------------------------
// The browser half of the unified assistant stream for first-party `/chat`:
// framework-free (no React), renders nothing. It
//   1. asserts the S1 capability handshake (fail-closed; cached per page),
//   2. POSTs a turn to the assistant endpoint (/api/assistants/chat),
//   3. parses the SSE frames (`id:` = the S1 Redis-entry resume cursor),
//   4. folds every event through the S3 reducer (`agUiReduce`) into the
//      `ConversationViewState` view model, invoking `onState` per fold,
//   5. on a mid-run transport drop (not an abort) resumes ONCE via the
//      durable-log tail (GET /api/assistants/runs/{runId}/stream), folding a
//      FULL replay into a FRESH state — replay-into-fresh-state is always
//      duplicate-free, so the resume needs no client-side cursor arithmetic —
//      and
//   6. exposes `driveAssistantChatTurn`, the complete `/chat` turn lifecycle
//      (bubble insert / per-fold projection / Slack atomic reveal / typing
//      indicators / retry-once / error surfacing) behind a small UI port, so
//      the chat page wires it with a ~25-line closure bundle and the whole
//      lifecycle is unit-testable without React.
//
// `projectConversationMessage` maps the reduced state onto the legacy
// `UiMessage` shape so the EXISTING `/chat` renderer (chat-messages-view)
// consumes the AG-UI wire unchanged — the zero-visual-regression seam the S3
// reducer was designed for. Slack mode deliberately omits `parts` (the
// bespoke Slack reveal never populated them; the renderer's
// thoughtGroups+content fallback is the pinned Slack layout).
//
// ROUTE-GRAPH BUDGET (the locked /chat dev-perf ceiling) shaped three choices:
//   - The wire-event guard is a LOCAL structural check, drift-pinned by a
//     unit test against the package's `AG_UI_EVENT_TYPES`, instead of pulling
//     the conformance module in for one function.
//   - The S1 handshake's pure negotiation runs SERVER-side (the capabilities
//     route executes `negotiateStreamContract` against this client's posted
//     hello) so `contract.ts`/`handshake.ts` stay off the /chat graph; this
//     module keeps only type-only (erased) imports and a drift-pinned literal
//     for the contract version. Fail-closed semantics are unchanged — the
//     surface mounts the AG-UI wire only on an `ok` negotiation, and both
//     sides of this first-party handshake are served by the same deployment.
//   - The legacy thread-persistence fetch helpers (formerly
//     `chat-persistence.ts`) are ABSORBED below: they ride the same locked
//     graph, and the S2 delete stage removes them together with the legacy
//     wire, so co-locating them keeps the module count flat through the
//     transition.
// ---------------------------------------------------------------------------

import type { AgUiEvent } from "@cinatra-ai/agent-ui-protocol";
import type {
  StreamClientHello,
  StreamNegotiation,
} from "@cinatra-ai/agent-ui-protocol/handshake";
import {
  agUiReduce,
  initialConversationState,
  type ConversationViewState,
} from "./renderer/ag-ui-reducer";
import type { UiMessage, UiThread, UiThreadSummary } from "./types";
import type { LlmAttachmentRef } from "@cinatra-ai/llm";

// ---------------------------------------------------------------------------
// Wire-event guard (drift-pinned local mirror of AG_UI_EVENT_TYPES)
// ---------------------------------------------------------------------------

/** Local mirror of the S1 event-type union. A unit test pins this set equal
 *  to `AG_UI_EVENT_TYPES` from `@cinatra-ai/agent-ui-protocol`. */
export const AG_UI_WIRE_EVENT_TYPES = new Set([
  "RUN_STARTED",
  "RUN_FINISHED",
  "RUN_ERROR",
  "TEXT_MESSAGE_START",
  "TEXT_MESSAGE_CONTENT",
  "TEXT_MESSAGE_END",
  "TOOL_CALL_START",
  "TOOL_CALL_END",
  "STATE_SNAPSHOT",
  "INTERRUPT",
  "RESUME",
  "DATA_PART",
]);

/** Structural wire-event check. Unknown/malformed frames are dropped by the
 *  read loop (never crash a live stream over one bad frame). */
export function isWireAgUiEvent(value: unknown): value is AgUiEvent {
  if (value === null || typeof value !== "object") return false;
  const t = (value as { type?: unknown }).type;
  return typeof t === "string" && AG_UI_WIRE_EVENT_TYPES.has(t);
}

// ---------------------------------------------------------------------------
// SSE frame parsing (id: / data: blocks, WHATWG-shaped)
// ---------------------------------------------------------------------------

export type SseFrame = { id?: string; data: string };

/** Parse one `\n\n`-delimited SSE block into { id?, data }. Comment-only
 *  blocks (`: keepalive`) and data-less blocks return null. Multiple `data:`
 *  lines are joined with `\n` per the SSE spec. */
export function parseSseFrame(block: string): SseFrame | null {
  let id: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue; // comment / keepalive
    if (line.startsWith("id:")) {
      id = line.slice(3).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
    // `event:` fields are not used by this wire (type travels in the JSON).
  }
  if (dataLines.length === 0) return null;
  return { id, data: dataLines.join("\n") };
}

// ---------------------------------------------------------------------------
// Capability handshake (fail-closed, cached per page load)
// ---------------------------------------------------------------------------

/** The contract versions this client speaks. LITERAL by design (importing the
 *  constant would pull `contract.ts` onto the locked /chat graph); a unit
 *  test pins it equal to `ASSISTANT_STREAM_CONTRACT_VERSION`. */
export const CLIENT_SUPPORTED_CONTRACTS: readonly string[] = ["1.0.0"];

const CLIENT_HELLO: StreamClientHello = {
  supportedContracts: CLIENT_SUPPORTED_CONTRACTS,
  authMode: "session",
  requiresResumable: true,
};

let negotiationCache: Promise<StreamNegotiation> | null = null;

/** Negotiate the S1 stream contract for the `/chat` surface (session auth).
 *  The pure negotiation executes SERVER-side against this client's posted
 *  hello (see the module docstring); the outcome is enforced HERE, fail-closed
 *  per CONTRACT.md §5 — the caller decides the fallback (during the flagged
 *  transition the legacy wire is the safe harbor). Cached — one round-trip per
 *  page load. */
export function negotiateAssistantChatContract(): Promise<StreamNegotiation> {
  if (!negotiationCache) {
    negotiationCache = (async (): Promise<StreamNegotiation> => {
      const res = await fetch("/api/assistants/chat/capabilities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(CLIENT_HELLO),
      });
      if (!res.ok) {
        throw new Error(`stream handshake request failed (${res.status})`);
      }
      return (await res.json()) as StreamNegotiation;
    })().catch((err) => {
      negotiationCache = null; // transient failure — retry on next call
      throw err;
    });
  }
  return negotiationCache;
}

/** Convenience: true only on an `ok` negotiation; every failure (fail-closed
 *  reason or transport error) logs loudly and returns false so the caller can
 *  pin the page to the retained legacy wire. */
export async function ensureAssistantChatWireNegotiated(): Promise<boolean> {
  try {
    const negotiation = await negotiateAssistantChatContract();
    if (!negotiation.ok) {
      console.error("[chat] AG-UI stream handshake failed (fail-closed):", negotiation);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[chat] AG-UI stream handshake request failed:", err);
    return false;
  }
}

/** Test seam: reset the cached negotiation. */
export function __resetAssistantChatNegotiation(): void {
  negotiationCache = null;
}

// ---------------------------------------------------------------------------
// The headless turn stream
// ---------------------------------------------------------------------------

export type AssistantTurnRequestMessage = {
  role: "user" | "assistant";
  content: string;
  attachments?: LlmAttachmentRef[];
};

export type StreamAssistantTurnOptions = {
  threadId: string;
  messages: AssistantTurnRequestMessage[];
  signal: AbortSignal;
  /** Invoked after every folded event with the CURRENT reduced state. */
  onState: (state: ConversationViewState) => void;
  /** Optional per-event hook (widget-refresh detection, diagnostics). */
  onEvent?: (event: AgUiEvent, state: ConversationViewState) => void;
  endpoint?: string;
  resumeEndpointFor?: (runId: string) => string;
};

function defaultResumeEndpoint(runId: string): string {
  return `/api/assistants/runs/${encodeURIComponent(runId)}/stream`;
}

/** Read an SSE body, folding each valid AG-UI event. Throws on transport
 *  failure; stops (and releases the reader) after a terminal event. */
async function foldSseBody(
  body: ReadableStream<Uint8Array>,
  initial: ConversationViewState,
  emit: (event: AgUiEvent, state: ConversationViewState) => void,
): Promise<ConversationViewState> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let state = initial;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const frame = parseSseFrame(block);
        if (!frame) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(frame.data);
        } catch {
          continue; // malformed frame — skip, never crash the stream
        }
        if (!isWireAgUiEvent(parsed)) continue;
        state = agUiReduce(state, parsed);
        emit(parsed, state);
        if (state.status === "finished" || state.status === "error") {
          return state;
        }
      }
    }
    return state;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Drive one assistant turn over the AG-UI wire. Resolves with the final
 * reduced state (status "finished" | "error", or the last folded state when
 * the server closed without a terminal — legacy-parity: the caller renders
 * what accumulated). Throws on abort (AbortError, caller-cleanup parity with
 * the legacy fetch) and on unrecoverable transport failure.
 */
export async function streamAssistantTurn(
  options: StreamAssistantTurnOptions,
): Promise<ConversationViewState> {
  const endpoint = options.endpoint ?? "/api/assistants/chat";
  const resumeFor = options.resumeEndpointFor ?? defaultResumeEndpoint;

  let state = initialConversationState();
  const emit = (event: AgUiEvent, next: ConversationViewState): void => {
    options.onState(next);
    options.onEvent?.(event, next);
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      threadId: options.threadId,
      messages: options.messages,
    }),
    signal: options.signal,
  });
  if (!response.ok) throw new Error("Chat request failed.");
  if (!response.body) throw new Error("No response stream.");

  // One-shot durable-log resume: a FULL replay folded into a FRESH state
  // (replay into fresh state cannot duplicate — the reducer's
  // completed-segment idempotence covers the overlap).
  const resumeOnce = async (runId: string): Promise<ConversationViewState> => {
    const resume = await fetch(resumeFor(runId), {
      credentials: "include",
      signal: options.signal,
    });
    if (!resume.ok || !resume.body) throw new Error("Chat request failed.");
    let fresh = initialConversationState();
    fresh = await foldSseBody(resume.body, fresh, (event, next) => {
      fresh = next;
      emit(event, next);
    });
    return fresh;
  };

  try {
    state = await foldSseBody(response.body, state, (event, next) => {
      state = next;
      emit(event, next);
    });
    // A clean close WITHOUT a terminal frame is still a broken wire (the
    // server closes only after the terminal, a synthetic error, or an abort):
    // attempt the same one-shot resume rather than silently truncating.
    if (
      state.status !== "finished" &&
      state.status !== "error" &&
      state.runId &&
      !options.signal.aborted
    ) {
      return await resumeOnce(state.runId);
    }
    return state;
  } catch (err) {
    if (options.signal.aborted) throw err; // user abort / thread switch
    // Mid-run transport drop — resume from the durable run-stream tail.
    const runId = state.runId;
    if (!runId) throw err;
    return await resumeOnce(runId).catch(() => {
      throw err; // surface the ORIGINAL transport failure
    });
  }
}

// ---------------------------------------------------------------------------
// UiMessage projection — the zero-visual-regression seam
// ---------------------------------------------------------------------------

export type ProjectConversationMessageOptions = {
  /** The client-minted assistant bubble id (list identity in `/chat`). */
  assistantId: string;
  /** Set for external-author turns (Slack mode attribution). */
  authorUserId?: string;
  /** Slack mode: whole-turn atomic reveal — deliberately NO `parts`. */
  slackMode?: boolean;
};

/**
 * Project the reduced conversation state onto the legacy `UiMessage` shape the
 * existing `/chat` renderer consumes. Field-presence mirrors the bespoke
 * appliers (keys appear only once populated) so persisted thread JSON keeps
 * the legacy shape.
 */
export function projectConversationMessage(
  state: ConversationViewState,
  opts: ProjectConversationMessageOptions,
): UiMessage {
  const m = state.message;
  if (opts.slackMode) {
    return {
      id: opts.assistantId,
      role: "assistant",
      content: m.content,
      ...(opts.authorUserId ? { authorUserId: opts.authorUserId } : {}),
      // Slack layout parity: thoughtGroups + flat content, never `parts`.
      ...(m.thoughtGroups.length > 0 ? { thoughtGroups: m.thoughtGroups } : {}),
      ...(m.citations.length > 0 ? { citations: m.citations } : {}),
      ...(m.error ? { error: m.error } : {}),
    };
  }
  return {
    id: opts.assistantId,
    role: "assistant",
    content: m.content,
    parts: m.parts,
    thoughtGroups: m.thoughtGroups,
    ...(opts.authorUserId ? { authorUserId: opts.authorUserId } : {}),
    ...(m.citations.length > 0 ? { citations: m.citations } : {}),
    ...(m.error ? { error: m.error, errorRaw: m.errorRaw } : {}),
    ...(m.liveStatus !== undefined ? { liveStatus: m.liveStatus } : {}),
  };
}

// ---------------------------------------------------------------------------
// The `/chat` turn DRIVER — the full lifecycle behind a small UI port
// ---------------------------------------------------------------------------

/** The UI operations the chat page injects. Every message write goes through
 *  `updateMessages`, which the page wraps with its thread-switch guard. */
export type AssistantChatTurnUiPort = {
  /** Guarded setMessages: the page short-circuits when the origin thread is
   *  no longer active (its `stillOnOriginThread` invariant). */
  updateMessages: (updater: (prev: UiMessage[]) => UiMessage[]) => void;
  /** Slack typing indicator on/off for this turn's assistant bubble id. */
  setTypingIndicator: (on: boolean) => void;
  /** Widget-refresh parity: the bespoke wire keyed on tool_result's name. */
  isWidgetRefreshTool: (toolName: string) => boolean;
  onWidgetRefresh: () => void;
};

export type DriveAssistantChatTurnOptions = {
  threadId: string;
  /** The client-minted assistant bubble id (list identity in `/chat`). */
  assistantId: string;
  messages: AssistantTurnRequestMessage[];
  slack: boolean;
  authorUserId?: string;
  signal: AbortSignal;
  ui: AssistantChatTurnUiPort;
};

/**
 * Drive one complete `/chat` turn over the AG-UI wire — the unified-wire
 * counterpart of the bespoke `streamResponse` driver, lifecycle-identical:
 * empty-bubble insert (ChatGPT mode) / typing indicator (Slack), per-fold
 * projection, retry-once on a pre-stream network error (Turbopack
 * lazy-compile window parity), Slack whole-turn atomic reveal, AbortError
 * silence, transport-error surfacing on the bubble. NEVER throws — callers
 * `void`-dispatch it exactly like the legacy driver.
 */
export async function driveAssistantChatTurn(
  options: DriveAssistantChatTurnOptions,
): Promise<void> {
  const { assistantId, authorUserId, slack, signal, ui } = options;
  let caughtError = "";
  try {
    if (slack) {
      ui.setTypingIndicator(true);
    } else {
      ui.updateMessages((prev) => [
        ...prev,
        {
          id: assistantId,
          role: "assistant",
          content: "",
          thoughtGroups: [],
          parts: [],
          liveStatus: "Thinking",
          ...(authorUserId ? { authorUserId } : {}),
        },
      ]);
    }

    // Track whether any wire event arrived — the retry below only covers a
    // pre-stream network failure; a mid-stream failure is resumed by
    // streamAssistantTurn itself via the durable-log tail.
    let anyEventSeen = false;
    // Widget refreshes fire ONCE per toolCallId across the whole turn — a
    // durable-log resume replays completed TOOL_CALL_ENDs, and side effects
    // are not covered by the reducer's fold idempotence.
    const widgetRefreshFired = new Set<string>();
    const drive = () =>
      streamAssistantTurn({
        threadId: options.threadId,
        messages: options.messages,
        signal,
        onState: (state) => {
          anyEventSeen = true;
          if (slack) return; // whole-turn atomic reveal below
          ui.updateMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantId
                ? projectConversationMessage(state, { assistantId, authorUserId })
                : msg,
            ),
          );
        },
        onEvent: (event, state) => {
          // TOOL_CALL_END carries only the id; the name resolves from the
          // folded state (TOOL_CALL_START recorded it).
          if (event.type === "TOOL_CALL_END" && !widgetRefreshFired.has(event.toolCallId)) {
            const name = state.message.thoughtGroups[0]?.toolCalls.find(
              (tc) => tc.id === event.toolCallId,
            )?.name;
            if (name && ui.isWidgetRefreshTool(name)) {
              widgetRefreshFired.add(event.toolCallId);
              ui.onWidgetRefresh();
            }
          }
        },
      });

    let finalState: ConversationViewState;
    try {
      finalState = await drive();
    } catch (err) {
      if (signal.aborted || anyEventSeen) throw err;
      // Network error before any event (TypeError: Failed to fetch) — wait
      // briefly and retry once, mirroring the legacy driver's handling of
      // Turbopack's lazy-compilation window.
      if (!(err instanceof TypeError)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (signal.aborted) throw err;
      finalState = await drive();
    }

    // Slack mode: reveal the fully reduced turn in one atomic write. The
    // projection deliberately omits `parts` (the pinned Slack layout).
    if (slack) {
      const revealed = projectConversationMessage(finalState, {
        assistantId,
        authorUserId,
        slackMode: true,
      });
      if (
        revealed.content.length > 0 ||
        (revealed.thoughtGroups?.length ?? 0) > 0 ||
        revealed.error
      ) {
        ui.updateMessages((prev) => [...prev, revealed]);
      }
    }
  } catch (error) {
    // Internal error boundary — never rethrow (void-dispatched by callers).
    if (error instanceof Error && error.name === "AbortError") {
      // Stop button or thread switch — clean exit, no toast.
    } else {
      const rawError =
        error instanceof Error ? error.stack ?? error.message : "Something went wrong.";
      const message = error instanceof Error ? error.message : "Something went wrong.";
      if (!slack) {
        ui.updateMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantId ? { ...msg, error: message, errorRaw: rawError } : msg,
          ),
        );
      } else {
        caughtError = message;
      }
    }
  } finally {
    if (slack) {
      ui.setTypingIndicator(false);
      if (caughtError) {
        ui.updateMessages((prev) => {
          const alreadyInserted = prev.some((m) => m.id === assistantId);
          if (alreadyInserted) return prev;
          return [
            ...prev,
            { id: assistantId, role: "assistant" as const, content: "", error: caughtError },
          ];
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// LEGACY thread persistence fetch helpers — absorbed from chat-persistence.ts
// ---------------------------------------------------------------------------
// Moved here VERBATIM (cinatra#918 extracted them from chat-page; cinatra#1218
// co-locates them with the stream client so the locked /chat route-graph
// budget stays flat through the cutover transition — one module replaces
// one). They target the LEGACY /api/chat persistence subroutes and are
// deleted together with them at the S2 delete stage. Plain fetch instead of a
// Next.js server action — avoids the RSC re-render that server actions
// trigger, which caused a corrective navigation (visible "page reload") when
// the URL had been changed via pushState while Next.js's internal router
// state still pointed at the old route.

export const MAX_STORED_THREADS = 50;

export function generateId() {
  return crypto.randomUUID();
}

export function deriveThreadTitle(firstUserMessage: string) {
  const cleaned = firstUserMessage.replace(/\n/g, " ").trim();
  return cleaned.length > 60 ? `${cleaned.slice(0, 57)}...` : cleaned;
}

export function extractAgentName(text: string): string | null {
  const match = text.match(/the agent'?s?\s+name\s+is[:\s]+([^\n.!?,]+)/i);
  const name = match?.[1]?.trim();
  return name && name.length > 0 ? name : null;
}

export async function saveChatThreadViaFetch(thread: Record<string, unknown> & { id: string }): Promise<void> {
  await fetch("/api/chat/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(thread),
  });
}

export async function fetchThreadByIdViaFetch(threadId: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`/api/chat/thread/${threadId}`);
  if (!res.ok) return null;
  return res.json() as Promise<Record<string, unknown> | null>;
}

export async function fetchThreadListViaFetch(): Promise<UiThreadSummary[]> {
  const res = await fetch("/api/chat/threads");
  if (!res.ok) return [];
  return res.json() as Promise<UiThreadSummary[]>;
}

export async function fetchThreadList(): Promise<UiThreadSummary[]> {
  try {
    const list = await fetchThreadListViaFetch();
    return list.slice(0, MAX_STORED_THREADS);
  } catch {
    return [];
  }
}

export async function fetchThreadById(threadId: string): Promise<UiThread | null> {
  try {
    return await fetchThreadByIdViaFetch(threadId) as UiThread | null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Attachment upload (moved VERBATIM from chat-page.tsx by cinatra#1218 —
// plain-fetch client transport belongs in this seam; chat-page.tsx is a
// tracked file-size bottleneck at its ceiling).
// ---------------------------------------------------------------------------

/** Upload picked files to /api/artifacts/upload, returning enriched refs.
 *  Failures per file are swallowed (the user can retry the file). */
export async function uploadChatAttachments(files: File[]): Promise<LlmAttachmentRef[]> {
  const refs: LlmAttachmentRef[] = [];
  for (const file of files) {
    try {
      const r = await fetch("/api/artifacts/upload", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "X-Artifact-Filename": file.name,
          "X-Artifact-Title": file.name,
        },
        body: file,
      });
      const j = (await r.json().catch(() => null)) as
        | { ok?: boolean; ref?: LlmAttachmentRef }
        | null;
      if (r.ok && j?.ok && j.ref) {
        // The server's ArtifactRef is the minimal {artifactId,
        // representationRevisionId, digest, mime, originKind} shape.
        // Enrich with the original File metadata so the host-side
        // providerUpload (attachment-resolver-ports.ts) can pass a
        // real filename to OpenAI/Anthropic/Gemini Files-API
        // — otherwise it falls back to ref.artifactId (a UUID),
        // and OpenAI rejects the file with "context stuffing file
        // type ... but got none" because the .pdf extension is lost.
        refs.push({
          ...j.ref,
          filename: file.name,
          title: file.name,
          size: file.size,
        });
      }
    } catch {
      // Network/parse failures are swallowed; the user can retry the file.
    }
  }
  return refs;
}
