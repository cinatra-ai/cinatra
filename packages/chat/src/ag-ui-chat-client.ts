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
//   - The thread-persistence fetch helpers (formerly `chat-persistence.ts`)
//     are ABSORBED below: they ride the same locked graph, and since the
//     cinatra#1218 predecessor 1 they target the first-class
//     /api/assistants/threads surface, so co-locating them keeps the module
//     count flat.
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
 *  per CONTRACT.md §5 — since the cinatra#1218 delete stage there is no
 *  legacy fallback: the caller surfaces a turn error. Cached — one round-trip
 *  per page load. */
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
 *  surface a fail-closed turn error (there is no legacy wire to fall back to). */
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
  /** OPTIONAL producer SELECTOR (cinatra#1875 W2 AC#2): the CANONICAL handle of a
   *  declared host-runtime assistant to drive this turn AS. Sent as `body.assistant`
   *  so the unified `/api/assistants/chat` endpoint resolves that assistant's own
   *  runtime config + audience gate. OMITTED for the @cinatra host default (an
   *  absent selector keeps the byte-identical `runChatTurn` path). */
  assistant?: string;
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
      // The producer selector — present ONLY for a declared host-runtime
      // assistant; an absent field keeps the endpoint's byte-identical @cinatra
      // default (`assistant === undefined` → `runChatTurn`).
      ...(options.assistant ? { assistant: options.assistant } : {}),
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
    // attempt the same one-shot resume rather than silently truncating. If
    // the resume itself fails — or replays another nonterminal log — fall
    // back to the ACCUMULATED state (legacy parity: render what arrived; a
    // one-shot policy never loops).
    if (
      state.status !== "finished" &&
      state.status !== "error" &&
      state.runId &&
      !options.signal.aborted
    ) {
      return await resumeOnce(state.runId).catch(() => state);
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
  /** AG-UI producer endpoint. Defaults to the unified Cinatra endpoint
   *  (`/api/assistants/chat`). Every declared assistant now streams over this
   *  ONE endpoint (cinatra#1875 W2 AC#2 — the per-built-in endpoints are retired);
   *  the target assistant is chosen by {@link assistant}. The durable-log resume
   *  endpoint is producer-agnostic (runId-keyed), so it stays default. */
  endpoint?: string;
  /** OPTIONAL producer SELECTOR — the CANONICAL handle of a declared host-runtime
   *  assistant to drive this turn AS (forwarded to the endpoint as `body.assistant`).
   *  Omitted for the @cinatra host default. */
  assistant?: string;
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
        // Propagated on BOTH the initial attempt and the retry (this closure
        // is re-invoked for the retry-once path) so the producer endpoint +
        // assistant selector are never silently downgraded to the default
        // @cinatra turn.
        ...(options.endpoint ? { endpoint: options.endpoint } : {}),
        ...(options.assistant ? { assistant: options.assistant } : {}),
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
// Thread persistence fetch helpers — absorbed from chat-persistence.ts
// ---------------------------------------------------------------------------
// Moved here VERBATIM (cinatra#918 extracted them from chat-page; cinatra#1218
// co-locates them with the stream client so the locked /chat route-graph
// budget stays flat through the cutover transition — one module replaces one).
//
// As of cinatra#1218 (predecessor 1 of the bespoke-wire delete stage) these
// target the FIRST-CLASS /api/assistants/threads persistence surface — the
// assistants handlers reproduce the legacy authz/session matrix exactly. The
// legacy /api/chat/{save,threads,thread/:id} subroutes were deleted by the
// delete stage itself.
//
// Plain fetch instead of a Next.js server action — avoids the RSC re-render
// that server actions trigger, which caused a corrective navigation (visible
// "page reload") when the URL had been changed via pushState while Next.js's
// internal router state still pointed at the old route. Keeping this
// fetch-based is a hard requirement (the reload regression must not return).

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
  await fetch("/api/assistants/threads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(thread),
  });
}

export async function fetchThreadByIdViaFetch(threadId: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`/api/assistants/threads/${threadId}`);
  if (!res.ok) return null;
  return res.json() as Promise<Record<string, unknown> | null>;
}

export async function fetchThreadListViaFetch(): Promise<UiThreadSummary[]> {
  const res = await fetch("/api/assistants/threads");
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

/** One upload that the server (or transport) refused, surfaced to the user
 *  instead of being silently dropped (cinatra#1890 — the "chat silent-drop
 *  failure"). A `415` refusal for an unsupported MIME carries `marketplaceHref`
 *  (the "install a type that accepts this" recourse deep link). Other failures
 *  (413 too large, 5xx, network) carry no link — nothing to install. */
export type ChatAttachmentRefusal = {
  filename: string;
  /** The refused MIME, echoed by the server when known. */
  mime?: string;
  /** HTTP status (0 for a network/parse failure). */
  status: number;
  /** Human-readable reason for the refusal surface. */
  message: string;
  /** Marketplace deep link for the refused MIME — present only when installing
   *  a type is the recourse (a `no_type` 415). */
  marketplaceHref?: string;
};

export type UploadChatAttachmentsResult = {
  /** Successfully uploaded, enriched attachment refs. */
  refs: LlmAttachmentRef[];
  /** Per-file refusals to surface in the thread. Empty on full success. */
  refusals: ChatAttachmentRefusal[];
};

export type UploadChatAttachmentsOptions = {
  /** The active chat thread id — sent as `X-Artifact-Chat-Thread-Id` so the
   *  server's classifier-signals composer captures the conversation context.
   *  Omitted (or absent thread) means no thread context is captured; the upload
   *  still succeeds. */
  threadId?: string;
};

/** Upload picked files to /api/artifacts/upload.
 *
 *  Sends `X-Artifact-Chat-Thread-Id` when a thread id is supplied so the
 *  server captures chat context into the upload's classifier signals
 *  (cinatra#1890). Returns BOTH the enriched refs AND per-file refusals — a
 *  refused upload is no longer swallowed silently; the caller surfaces it with
 *  recourse. */
export async function uploadChatAttachments(
  files: File[],
  options: UploadChatAttachmentsOptions = {},
): Promise<UploadChatAttachmentsResult> {
  const refs: LlmAttachmentRef[] = [];
  const refusals: ChatAttachmentRefusal[] = [];
  const threadId =
    typeof options.threadId === "string" && options.threadId.length > 0
      ? options.threadId
      : undefined;
  for (const file of files) {
    try {
      const r = await fetch("/api/artifacts/upload", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "X-Artifact-Filename": file.name,
          "X-Artifact-Title": file.name,
          // Opt-in chat-context signal — only when a thread id is known.
          ...(threadId ? { "X-Artifact-Chat-Thread-Id": threadId } : {}),
        },
        body: file,
      });
      const j = (await r.json().catch(() => null)) as
        | {
            ok?: boolean;
            ref?: LlmAttachmentRef;
            error?: string;
            mime?: string;
            marketplaceHref?: string;
          }
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
      } else {
        // A refused/failed upload is SURFACED, not swallowed (cinatra#1890).
        // A 415 WITH a marketplaceHref is the "no installed type accepts this"
        // recourse case; a 415 WITHOUT one (e.g. an AMBIGUOUS refusal — multiple
        // types accept it) must NOT claim no type accepts it, so the copy falls
        // back to the server's reason / neutral wording.
        refusals.push({
          filename: file.name,
          status: r.status,
          mime: j?.mime ?? (file.type || undefined),
          message: refusalMessageFor(
            r.status,
            file.name,
            j?.error,
            !!j?.marketplaceHref,
          ),
          ...(j?.marketplaceHref ? { marketplaceHref: j.marketplaceHref } : {}),
        });
      }
    } catch {
      // Network/parse failures still surface a refusal so the user knows the
      // file did not attach (no marketplace link — nothing to install).
      refusals.push({
        filename: file.name,
        status: 0,
        mime: file.type || undefined,
        message: `"${file.name}" could not be uploaded (network error). Try again.`,
      });
    }
  }
  return { refs, refusals };
}

/** Human-readable refusal copy per HTTP status. Keeps the transport module the
 *  single source of the refusal wording so the UI stays presentation-only. */
function refusalMessageFor(
  status: number,
  filename: string,
  serverError?: string,
  hasInstallRecourse = false,
): string {
  if (status === 415) {
    // Only claim "no installed type accepts it" when installing a type is the
    // actual recourse (the server offered a marketplace link). Otherwise
    // (ambiguous / no-MIME) prefer the server reason or neutral copy.
    if (hasInstallRecourse) {
      return `"${filename}" can't be attached — no installed type accepts this file format.`;
    }
    return serverError
      ? `"${filename}" can't be attached: ${serverError}`
      : `"${filename}" can't be attached — this file type isn't supported here.`;
  }
  if (status === 413) {
    return `"${filename}" is too large to attach.`;
  }
  if (status === 401 || status === 403) {
    return `"${filename}" could not be attached — you are not authorized to upload here.`;
  }
  return serverError
    ? `"${filename}" could not be attached: ${serverError}`
    : `"${filename}" could not be attached. Try again.`;
}
