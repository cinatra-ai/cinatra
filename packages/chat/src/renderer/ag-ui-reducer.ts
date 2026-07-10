// ---------------------------------------------------------------------------
// AG-UI event-to-UI reducer — the deferred S3 half (cinatra#1311).
// ---------------------------------------------------------------------------
// S3 (#1219) extracted the /chat CONTENT renderer into `@cinatra-ai/chat/renderer`
// and DEFERRED this half — the AG-UI event-to-UI reducer + interactive layer —
// because it was coupled to the bespoke `chat-stream-events` SSE vocabulary and
// could not be extracted until the versioned AG-UI event schema existed. That
// schema now exists (S1 / #1217: `@cinatra-ai/agent-ui-protocol`). See
// `packages/chat/src/renderer/README.md` ("Scope & the S1 follow-up").
//
// This module is a PURE `(state, event) => state` fold from the S1 AG-UI event
// union into the S3 renderer's view model (`UiMessage`-shaped: an ordered
// `parts` trace, `thoughtGroups`, `citations`, `error`, `liveStatus`) plus an
// open-interrupt (HITL) slice. It MIRRORS the behavior of the bespoke
// `chat-stream-events` appliers, mapped from the bespoke SSE vocabulary onto the
// AG-UI vocabulary, and REUSES the same tested pure helpers those appliers use
// (`assistant-parts` + `chat-stream-events` normalizers) so behavior matches by
// construction.
//
// UNCONSUMED. Nothing imports this yet. Wiring /chat onto it — replacing the
// bespoke `streamResponse` event loop — is S2's job (#1218). `chat-page.tsx`
// and `chat-stream-events.ts` stay untouched; this ships the reusable module
// only. Because it is unconsumed, the /chat route-graph (and its dev-perf
// ratchet) is unchanged.
//
// The bespoke -> AG-UI mapping, event by event:
//
//   bespoke SSE            AG-UI event                notes
//   ------------------     ----------------------     ----------------------------
//   (n/a)                  RUN_STARTED                lifecycle: seed run/thread ids
//   (n/a)                  TEXT_MESSAGE_START         lifecycle: text-run boundary
//   text {content}         TEXT_MESSAGE_CONTENT       append delta (+ round sep)
//   (n/a)                  TEXT_MESSAGE_END           lifecycle: text-run boundary
//   tool_call {id,name}    TOOL_CALL_START            add running chip + parts entry
//   tool_result {id,...}   TOOL_CALL_END              complete chip; derive label from
//                                                     the tool NAME (AG-UI carries no
//                                                     resultLabel on the wire); mark the
//                                                     next text as a new round (paragraph
//                                                     break) — the bespoke `thinking_end`
//                                                     round-separator role, at the point
//                                                     the tool round actually ends.
//   citations {citations}  DATA_PART {citations}      normalize + merge by url
//   (agent_run runId)      DATA_PART {toolCallId,     pin runId onto the matching
//                            runId}                    tool_call part (bespoke mined this
//                                                     from the tool_result `result` JSON;
//                                                     AG-UI TOOL_CALL_END has no result, so
//                                                     it arrives as a structured DATA_PART).
//   (frozen HITL frame)    INTERRUPT / RESUME         open / clear the HITL slice
//   error {message}        RUN_ERROR                  set message.error (+ raw)
//   (stream close)         RUN_FINISHED               clear liveStatus
//   (resume)               STATE_SNAPSHOT             rehydrate-then-resume (see below)
//
// STATE_SNAPSHOT semantics: a snapshot REPLACES the reduced view-model state
// wholesale (the durable-log resume seam). A client that reconnects discards its
// prior state, adopts the snapshot, then folds only the events AFTER the
// snapshot cursor. This makes resume deterministic and non-duplicating:
//   reduce(SNAPSHOT(reduceAll(prefix)), suffix)  deep-equals  reduceAll(prefix ++ suffix)
// (proven in the test matrix). Streaming appends (TEXT_MESSAGE_CONTENT) are NOT
// individually idempotent — that is exactly why resume ships a snapshot instead
// of replaying already-applied deltas.

import type { AgUiEvent } from "@cinatra-ai/agent-ui-protocol";

import {
  applyTextDelta,
  applyToolCallEvent,
  applyToolResultEvent,
  formatToolCallLabel,
  formatToolProgressStatus,
  hasVisibleStreamingText,
  type AssistantMessagePart,
} from "../assistant-parts";
import {
  extractErrorMessage,
  mergeCitations,
  normalizeCitations,
} from "../chat-stream-events";
import type { UiCitation, UiMessage, UiThoughtGroup, UiToolCall } from "../types";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * An open human-in-the-loop interrupt. Carried as a discrete slice (not on the
 * message) so the interactive layer can render the approval form beside the
 * transcript and clear it on RESUME/RUN_ERROR. Mirrors the S1 `InterruptEvent`
 * fields the renderer needs — `values` may optionally carry a `presentation`
 * hint (see the S1 contract) that the host's HITL renderer narrows locally.
 */
export type AgUiInterrupt = {
  runId: string;
  threadId: string;
  schema: Record<string, unknown>;
  xRenderer: string;
  values: Record<string, unknown>;
  reviewTaskId: string;
  fieldName?: string;
};

/** A structured DATA_PART payload that is neither citations nor a runId-pin. */
export type AgUiDataPart = {
  data: Record<string, unknown>;
  partIndex?: number;
};

export type AgUiRunStatus =
  | "idle"
  | "running"
  | "finished"
  | "stopped"
  | "error";

/**
 * The reduced view model for ONE streaming assistant turn (one run -> one
 * assistant `UiMessage`). All text deltas fold into the single `message`
 * regardless of their `messageId` — mirroring the bespoke path, where every
 * delta of a turn accumulates on one client-assigned assistant message.
 */
export type AgUiReducerState = {
  /** The streaming assistant message being built — the S3 view-model shape. */
  message: UiMessage;
  /**
   * Latch: the next text delta opens a new paragraph (a tool round just ended).
   * Read-and-cleared inside TEXT_MESSAGE_CONTENT so the fold stays pure — the
   * caller never mutates an outer flag (cf. the bespoke round-separator note).
   */
  pendingRoundSeparator: boolean;
  runId?: string;
  threadId?: string;
  runStatus: AgUiRunStatus;
  /** The open HITL interrupt, or null when none is pending. */
  interrupt: AgUiInterrupt | null;
  /** Structured renderable-view DATA_PARTs (S4 registry renders these). */
  dataParts: AgUiDataPart[];
};

/**
 * Fresh reducer state. `messageId` seeds the assistant message id when known up
 * front; otherwise it is filled by the first RUN_STARTED (runId) or
 * TEXT_MESSAGE_START (messageId) that arrives.
 */
export function createAgUiReducerState(messageId = ""): AgUiReducerState {
  return {
    message: {
      id: messageId,
      role: "assistant",
      content: "",
      parts: [],
      thoughtGroups: [],
    },
    pendingRoundSeparator: false,
    runStatus: "idle",
    interrupt: null,
    dataParts: [],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function firstGroup(message: UiMessage): UiThoughtGroup | undefined {
  return message.thoughtGroups?.[0];
}

/** The single "main" thought group, created on first use (bespoke fallback). */
function ensureGroup(message: UiMessage): UiThoughtGroup {
  return message.thoughtGroups?.[0] ?? { id: "main", toolCalls: [] };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * Fold a single AG-UI event into the view model. Pure and total: every event
 * type in the S1 union has a defined transition (including explicit no-ops for
 * non-rendering lifecycle events). Unknown/late events return the SAME state
 * reference so a consumer diffing on identity skips the update.
 */
export function agUiReduce(
  state: AgUiReducerState,
  event: AgUiEvent,
): AgUiReducerState {
  switch (event.type) {
    case "RUN_STARTED": {
      // Seed run/thread ids; adopt the runId as the message id only if none was
      // supplied. Replaying RUN_STARTED must not wipe accumulated content.
      const message = state.message.id
        ? state.message
        : { ...state.message, id: event.runId };
      return {
        ...state,
        runId: event.runId,
        threadId: event.threadId,
        runStatus: "running",
        message,
      };
    }

    case "TEXT_MESSAGE_START": {
      // Text-run boundary. Fill the message id if we still have none; otherwise
      // a no-op (all deltas fold into the one turn message).
      if (state.message.id) return state;
      return { ...state, message: { ...state.message, id: event.messageId } };
    }

    case "TEXT_MESSAGE_CONTENT": {
      const delta = event.delta;
      if (!delta) return state;
      const existing = state.message.content;
      // Paragraph break when text resumes after a tool round — never insert a
      // space between ordinary streaming chunks (providers split tokens
      // arbitrarily; a stray space breaks markdown like **bold**). Mirrors
      // applyTextDeltaToMessages exactly.
      const separator =
        state.pendingRoundSeparator && existing.length > 0 && !/\s$/.test(existing)
          ? "\n\n"
          : "";
      const deltaWithSeparator = separator + delta;
      const nextParts = applyTextDelta(state.message.parts ?? [], deltaWithSeparator);
      const latestTextPart = nextParts.findLast((p) => p.kind === "text");
      const liveStatus =
        latestTextPart && hasVisibleStreamingText(latestTextPart.content)
          ? undefined
          : state.message.liveStatus;
      return {
        ...state,
        pendingRoundSeparator: false,
        message: {
          ...state.message,
          content: existing + deltaWithSeparator,
          parts: nextParts,
          liveStatus,
        },
      };
    }

    case "TEXT_MESSAGE_END":
      // Text-run boundary; content already applied delta-by-delta. No-op.
      return state;

    case "TOOL_CALL_START": {
      const group = ensureGroup(state.message);
      // Dedupe by id — a retried TOOL_CALL_START is a no-op (server-retry safety).
      if (group.toolCalls.some((tc) => tc.id === event.toolCallId)) return state;
      const nextParts = applyToolCallEvent(state.message.parts ?? [], {
        id: event.toolCallId,
        name: event.toolCallName,
      });
      const nextToolCall: UiToolCall = {
        id: event.toolCallId,
        name: event.toolCallName,
        status: "running",
      };
      return {
        ...state,
        message: {
          ...state.message,
          thoughtGroups: [
            { ...group, toolCalls: [...group.toolCalls, nextToolCall] },
          ],
          parts: nextParts,
          liveStatus: formatToolProgressStatus({ name: event.toolCallName }),
        },
      };
    }

    case "TOOL_CALL_END": {
      const group = firstGroup(state.message);
      if (!group) return state; // orphan end — no matching group
      const toolCall = group.toolCalls.find((tc) => tc.id === event.toolCallId);
      if (!toolCall) return state; // orphan end — no matching start
      // AG-UI TOOL_CALL_END carries only the id — derive the completed label
      // from the tool NAME (+ any serverLabel), the same label the running chip
      // shows, via the shared formatter.
      const resultLabel = formatToolCallLabel({
        name: toolCall.name,
        serverLabel: toolCall.serverLabel,
      });
      const nextParts = state.message.parts
        ? applyToolResultEvent(state.message.parts, {
            id: event.toolCallId,
            resultLabel,
            status: "completed",
          })
        : undefined;
      return {
        ...state,
        // Text resuming after this round opens a new paragraph.
        pendingRoundSeparator: true,
        message: {
          ...state.message,
          thoughtGroups: [
            {
              ...group,
              toolCalls: group.toolCalls.map((tc) =>
                tc.id === event.toolCallId
                  ? { ...tc, status: "completed" as const, resultLabel }
                  : tc,
              ),
            },
          ],
          ...(nextParts ? { parts: nextParts } : {}),
          liveStatus: "Reviewing tool results",
        },
      };
    }

    case "STATE_SNAPSHOT":
      return rehydrateFromSnapshot(state, event.snapshot);

    case "INTERRUPT":
      return {
        ...state,
        interrupt: {
          runId: event.runId,
          threadId: event.threadId,
          schema: event.schema,
          xRenderer: event.xRenderer,
          values: event.values,
          reviewTaskId: event.reviewTaskId,
          ...(event.fieldName ? { fieldName: event.fieldName } : {}),
        },
        message: { ...state.message, liveStatus: "Waiting for approval" },
      };

    case "RESUME": {
      // Clear the open interrupt. When the RESUME names a reviewTaskId, only
      // clear the matching one (a stray resume for a different task is a no-op).
      if (
        state.interrupt &&
        event.reviewTaskId &&
        state.interrupt.reviewTaskId !== event.reviewTaskId
      ) {
        return state;
      }
      if (!state.interrupt) return state;
      return {
        ...state,
        interrupt: null,
        message: { ...state.message, liveStatus: undefined },
      };
    }

    case "RUN_ERROR":
      return {
        ...state,
        runStatus: "error",
        interrupt: null,
        message: {
          ...state.message,
          error: extractErrorMessage(event.message),
          errorRaw: event.message,
          liveStatus: undefined,
        },
      };

    case "RUN_FINISHED":
      return {
        ...state,
        runStatus: event.status === "stopped" ? "stopped" : "finished",
        message: { ...state.message, liveStatus: undefined },
      };

    case "DATA_PART":
      return applyDataPart(state, event.data, event.partIndex);

    default:
      // Exhaustive over the S1 union; a future/unknown tag is an explicit no-op.
      return state;
  }
}

/** Fold an ordered event log into a single reduced state. */
export function agUiReduceAll(
  events: readonly AgUiEvent[],
  initial?: AgUiReducerState,
): AgUiReducerState {
  return events.reduce(agUiReduce, initial ?? createAgUiReducerState());
}

// ---------------------------------------------------------------------------
// DATA_PART routing
// ---------------------------------------------------------------------------

function applyDataPart(
  state: AgUiReducerState,
  data: Record<string, unknown>,
  partIndex: number | undefined,
): AgUiReducerState {
  // 1. Citations payload -> normalize + merge by url (mirrors the bespoke
  //    `citations` SSE event -> applyCitationsToMessages).
  if (Array.isArray((data as { citations?: unknown }).citations)) {
    const normalized = normalizeCitations((data as { citations: unknown }).citations);
    if (normalized.length === 0) return state;
    const merged: UiCitation[] = mergeCitations(
      state.message.citations ?? [],
      normalized,
    );
    return {
      ...state,
      message: { ...state.message, citations: merged },
    };
  }

  // 2. agent_run runId pin -> attach runId onto the matching tool_call part so
  //    the interactive layer mounts the inline run card (mirrors the bespoke
  //    `extractAgentRunId` pin, which mined the tool_result `result` JSON;
  //    AG-UI TOOL_CALL_END has no result, so this arrives as a DATA_PART).
  const toolCallId =
    typeof data.toolCallId === "string" ? data.toolCallId : undefined;
  const runId =
    typeof data.runId === "string" && data.runId.length > 0
      ? data.runId
      : undefined;
  if (toolCallId && runId && state.message.parts) {
    let changed = false;
    const nextParts: AssistantMessagePart[] = state.message.parts.map((p) => {
      // Only a matching tool_call whose runId is not already this value is a
      // real change. No match, or a retried identical pin, is a no-op with the
      // SAME state reference (idempotent under replay).
      if (p.kind === "tool_call" && p.id === toolCallId && p.runId !== runId) {
        changed = true;
        return { ...p, runId };
      }
      return p;
    });
    return changed
      ? { ...state, message: { ...state.message, parts: nextParts } }
      : state;
  }

  // 3. Otherwise: a structured renderable view (S4). Accumulate for the
  //    view-registry to render beside the transcript.
  return {
    ...state,
    dataParts: [
      ...state.dataParts,
      { data, ...(partIndex !== undefined ? { partIndex } : {}) },
    ],
  };
}

// ---------------------------------------------------------------------------
// STATE_SNAPSHOT — rehydrate-then-resume
// ---------------------------------------------------------------------------

/**
 * Replace the reduced state wholesale from a snapshot payload (a previously
 * serialized `AgUiReducerState`). Defensive: a malformed / shape-less snapshot
 * is ignored (state unchanged) rather than corrupting the view model.
 */
function rehydrateFromSnapshot(
  state: AgUiReducerState,
  snapshot: unknown,
): AgUiReducerState {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return state;
  }
  const s = snapshot as Partial<AgUiReducerState>;
  if (!s.message || typeof s.message !== "object" || Array.isArray(s.message)) {
    return state;
  }
  const message = s.message as UiMessage;
  if (typeof message.id !== "string" || typeof message.content !== "string") {
    return state;
  }
  // Wholesale replace: derive EVERY field from the snapshot (or a default),
  // never fall back to the prior state — a snapshot that intentionally omits a
  // runId/threadId, or is from a different run, must not leak the old values in
  // (rehydrate-then-resume, not merge).
  return {
    message,
    pendingRoundSeparator: Boolean(s.pendingRoundSeparator),
    runId: typeof s.runId === "string" ? s.runId : undefined,
    threadId: typeof s.threadId === "string" ? s.threadId : undefined,
    runStatus: s.runStatus ?? "idle",
    interrupt: s.interrupt ?? null,
    dataParts: Array.isArray(s.dataParts) ? s.dataParts : [],
  };
}
