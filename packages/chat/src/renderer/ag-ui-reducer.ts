// ---------------------------------------------------------------------------
// AG-UI event-to-UI reducer — the deferred S3 half (cinatra#1311).
// ---------------------------------------------------------------------------
// S3 (#1219) extracted the `/chat` CONTENT renderer into `@cinatra-ai/chat/
// renderer`. It deliberately deferred the OTHER half — the AG-UI event-to-UI
// reducer + interactive layer — because that half was coupled to the bespoke
// `chat-stream-events` SSE vocabulary and could not be extracted until the
// versioned AG-UI event schema existed. That schema now exists: S1 (#1217)
// merged `@cinatra-ai/agent-ui-protocol` on `main`. This module is that
// deferred half's state layer.
//
// It is a PURE fold `(state, event) => state` over the S1 AG-UI event union,
// producing the S3 renderer's view model (a single reduced assistant turn:
// ordered `parts` trace + `thoughtGroups` + `citations` + `error` + a live
// `liveStatus`, plus an open-interrupt / HITL slice). One AG-UI *run* is one
// assistant turn in a thread, so the reduced view model is a single assistant
// message that accretes as events fold.
//
// It MIRRORS the behavior of the former bespoke `chat-stream-events` appliers
// (deleted by the cinatra#1218 delete stage), mapped from that SSE vocabulary
// (`text` / `thinking_*` / `tool_call` / `tool_result` / `citations` /
// `error`) onto the AG-UI vocabulary (`TEXT_MESSAGE_*` / `TOOL_CALL_*` /
// `INTERRUPT`/`RESUME` / `DATA_PART` / `RUN_*`). To guarantee identical
// trace/label/status behavior it REUSES the existing tested pure helpers
// (`assistant-parts.ts` + the wire-agnostic normalizers relocated to
// `./stream-normalizers`) rather than re-deriving them.
//
// CONSUMED BY `/chat` since S2 (#1218): the headless AG-UI chat client
// (../ag-ui-chat-client.ts) folds the live wire through this reducer and
// projects the reduced state onto the legacy UiMessage list, so the existing
// renderer draws the unified stream unchanged. Since the delete stage this is
// the ONLY `/chat` wire — the bespoke path and its kill-switch are gone.
//
// ── The bespoke → AG-UI mapping gaps (the reducer contract) ─────────────────
//  • TOOL_CALL_END carries ONLY `toolCallId` — no `resultLabel`, no `result`
//    payload (the bespoke `tool_result` carried all three). So the tool chip
//    label derives from the tool NAME (`formatToolCallLabel`), and the inline
//    agent-run-card `runId` is pinned from a `DATA_PART` — NEVER from
//    TOOL_CALL_END.
//  • AG-UI has no `thinking_start`/`thinking_end` frames, so a thought group's
//    `thinkingSeconds` is not on the wire (stays undefined). The tool-round
//    boundary that the bespoke path keyed on `thinking_end` is keyed here on
//    TOOL_CALL_END → the next text segment gets the paragraph separator.
//  • AG-UI has no dedicated `citations` frame — citations arrive as a
//    `DATA_PART` (`{ kind: "citations", citations }`), merged/deduped by url.
//
// ── Determinism / idempotence (durable-log resume) ──────────────────────────
//  • STATE_SNAPSHOT REPLACES the reduced state wholesale (the resume seam);
//    subsequent events fold on top as normal.
//  • A text message is SEALED at TEXT_MESSAGE_END. A replayed START/CONTENT for
//    a sealed message is a no-op, so re-folding an already-completed event
//    prefix — or replaying a completed prefix after a STATE_SNAPSHOT — never
//    duplicates text, `parts`, tool chips, citations, or thought groups.
//  • Tool calls dedupe by `toolCallId`; a `DATA_PART` `agent_run` pin is a
//    no-op once the runId is already pinned; citations dedupe by url; an
//    unrecognized `DATA_PART` is deduped by structural equality. All naturally
//    idempotent WITHOUT relying on `partIndex` — `partIndex` is only a within-
//    artifact ordinal (not unique across a run), so it is NOT a dedupe key.
//  • BOUNDARY: idempotence covers COMPLETED (sealed) segments. Text still
//    accreting in an OPEN, unsealed message is additive by nature — replaying
//    its already-applied deltas on top of a mid-stream snapshot would duplicate.
//    That is the transport's contract (durable-log resume delivers only the
//    post-`Last-Event-ID` suffix for the open message); the reducer does not
//    and cannot dedupe an open text stream without per-delta identity.
// ---------------------------------------------------------------------------

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
} from "./stream-normalizers";
import type { UiCitation, UiThoughtGroup } from "../types";
import type {
  AgUiEvent,
  DataPartEvent,
  InterruptEvent,
  RunErrorEvent,
  StateSnapshotEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
} from "@cinatra-ai/agent-ui-protocol";

// ---------------------------------------------------------------------------
// The reduced view model
// ---------------------------------------------------------------------------

/**
 * The reduced assistant turn — a `UiMessage`-shaped view model the S3 renderer
 * (and the interactive layer in `./ag-ui-interactive`) draws. Structurally a
 * subset of `UiMessage` (`../types`) restricted to assistant turns: the same
 * `content` / `parts` / `thoughtGroups` / `citations` / `error` / `liveStatus`
 * fields the bespoke appliers populate, so the existing renderer consumes it
 * unchanged.
 */
export type ReducedAssistantMessage = {
  id: string;
  role: "assistant";
  content: string;
  parts: AssistantMessagePart[];
  thoughtGroups: UiThoughtGroup[];
  citations: UiCitation[];
  error?: string;
  errorRaw?: string;
  liveStatus?: string;
};

/**
 * The open HITL interrupt slice — mirrors the fields the chat prompt-window
 * HITL drive reads off an `INTERRUPT` event to render an approval form. `null`
 * when no interrupt is open. Cleared on `RESUME` (and defensively on
 * `RUN_FINISHED` / `RUN_ERROR`).
 */
export type HitlInterruptSlice = {
  reviewTaskId: string;
  xRenderer: string;
  schema: Record<string, unknown>;
  values: Record<string, unknown>;
  fieldName?: string;
  threadId: string;
  runId: string;
};

export type ConversationRunStatus =
  | "idle"
  | "running"
  | "finished"
  | "error";

/**
 * The full reduced state. `message` + `interrupt` + `dataParts` are the render
 * inputs; the remaining fields are lifecycle / idempotence bookkeeping.
 */
export type ConversationViewState = {
  message: ReducedAssistantMessage;
  interrupt: HitlInterruptSlice | null;
  /**
   * Structured `DATA_PART` payloads the reducer did not consume itself (i.e.
   * not `kind: "agent_run"` / `kind: "citations"`) — carried through for the
   * interactive layer to dispatch to the S4 renderable-view registry. Deduped
   * by `partIndex` when present.
   */
  dataParts: Record<string, unknown>[];
  runId: string | null;
  threadId: string | null;
  status: ConversationRunStatus;
  // ── bookkeeping (not rendered) ──
  /** The messageId currently accreting text, or `null` between text segments. */
  openTextMessageId: string | null;
  /** messageIds whose TEXT_MESSAGE_END has been folded — replay-sealed. */
  sealedMessageIds: string[];
  /** Set by TOOL_CALL_END; the next applied text delta gets a paragraph break. */
  pendingRoundSeparator: boolean;
};

// ---------------------------------------------------------------------------
// DATA_PART payload shapes the reducer recognizes
// ---------------------------------------------------------------------------

/** `{ kind: "agent_run", toolCallId, runId }` — pins the inline run card. */
export type AgentRunDataPart = {
  kind: "agent_run";
  toolCallId: string;
  runId: string;
};

/** `{ kind: "citations", citations: [...] }` — merged/deduped by url. */
export type CitationsDataPart = {
  kind: "citations";
  citations: unknown;
};

/**
 * LOCAL mirror of the S1 `renderableViewType` classification (a `DATA_PART`
 * payload is a renderable view iff it carries a non-empty string `viewType` —
 * the documented S1 rule this module's DATA_PART contract already states).
 * Mirrored instead of imported because the tsconfig subpath for the S1
 * classifier resolves the FULL S4 registry index (five schema modules), and
 * this reducer rides the locked /chat route-graph budget. A drift pin in
 * ag-ui-chat-client.test.ts asserts equality with the real
 * `renderableViewType` across the classification matrix (registered /
 * unregistered / absent / empty / hostile-getter payloads).
 */
export function renderableViewTypeOf(data: unknown): string | undefined {
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const vt = (data as { viewType?: unknown }).viewType;
    if (typeof vt === "string" && vt.length > 0) return vt;
  }
  return undefined;
}

function isAgentRunDataPart(d: Record<string, unknown>): d is AgentRunDataPart {
  return (
    d.kind === "agent_run" &&
    typeof d.toolCallId === "string" &&
    d.toolCallId.length > 0 &&
    typeof d.runId === "string" &&
    d.runId.length > 0
  );
}

function isCitationsDataPart(d: Record<string, unknown>): d is CitationsDataPart {
  return d.kind === "citations" && "citations" in d;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function initialConversationState(): ConversationViewState {
  return {
    message: {
      id: "",
      role: "assistant",
      content: "",
      parts: [],
      thoughtGroups: [],
      citations: [],
    },
    interrupt: null,
    dataParts: [],
    runId: null,
    threadId: null,
    status: "idle",
    openTextMessageId: null,
    sealedMessageIds: [],
    pendingRoundSeparator: false,
  };
}

// ---------------------------------------------------------------------------
// Per-event transitions — each returns the next state (pure / immutable)
// ---------------------------------------------------------------------------

function withMessage(
  state: ConversationViewState,
  next: Partial<ReducedAssistantMessage>,
): ConversationViewState {
  return { ...state, message: { ...state.message, ...next } };
}

/** Clear `liveStatus` once visible streaming text exists (mirrors bespoke). */
function deriveTextLiveStatus(
  parts: AssistantMessagePart[],
  fallback: string | undefined,
): string | undefined {
  const latestTextPart = parts.findLast((p) => p.kind === "text");
  return latestTextPart && hasVisibleStreamingText(latestTextPart.content)
    ? undefined
    : fallback;
}

function reduceTextStart(
  state: ConversationViewState,
  event: TextMessageStartEvent,
): ConversationViewState {
  // Replay-sealed message — the whole segment is already folded. No-op.
  if (state.sealedMessageIds.includes(event.messageId)) return state;
  const id = state.message.id || state.runId || event.messageId;
  return {
    ...state,
    openTextMessageId: event.messageId,
    message: { ...state.message, id },
  };
}

function reduceTextContent(
  state: ConversationViewState,
  event: TextMessageContentEvent,
): ConversationViewState {
  // Only the currently-open (non-sealed) message accretes text. Orphan,
  // stale, or replayed-after-seal content deltas are no-ops → idempotent.
  if (event.messageId !== state.openTextMessageId) return state;
  const delta = event.delta;
  if (!delta) return state;

  const existing = state.message.content;
  // Paragraph break when text resumes after a tool round (bespoke keyed this
  // on `thinking_end`; the AG-UI equivalent is TOOL_CALL_END). Never insert
  // whitespace between ordinary streaming chunks — providers split tokens
  // arbitrarily and stray spaces break markdown (`**bold**`).
  const separator =
    state.pendingRoundSeparator && existing.length > 0 && !/\s$/.test(existing)
      ? "\n\n"
      : "";
  const deltaWithSeparator = separator + delta;
  const nextParts = applyTextDelta(state.message.parts, deltaWithSeparator);
  const liveStatus = deriveTextLiveStatus(nextParts, state.message.liveStatus);
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

function reduceTextEnd(
  state: ConversationViewState,
  event: TextMessageEndEvent,
): ConversationViewState {
  const sealed = state.sealedMessageIds.includes(event.messageId)
    ? state.sealedMessageIds
    : [...state.sealedMessageIds, event.messageId];
  return {
    ...state,
    sealedMessageIds: sealed,
    openTextMessageId:
      state.openTextMessageId === event.messageId
        ? null
        : state.openTextMessageId,
  };
}

function reduceToolCallStart(
  state: ConversationViewState,
  event: ToolCallStartEvent,
): ConversationViewState {
  // Ensure a thought group exists (mirrors the bespoke thinking_start /
  // tool_call fallback: `msg.thoughtGroups?.[0] ?? { id: "main", ... }`).
  const group = state.message.thoughtGroups[0] ?? { id: "main", toolCalls: [] };
  // Dedupe by id — a retried TOOL_CALL_START is a no-op (server retry / replay).
  if (group.toolCalls.some((tc) => tc.id === event.toolCallId)) return state;

  const nextParts = applyToolCallEvent(state.message.parts, {
    id: event.toolCallId,
    name: event.toolCallName,
  });
  const nextGroup: UiThoughtGroup = {
    ...group,
    toolCalls: [
      ...group.toolCalls,
      {
        id: event.toolCallId,
        name: event.toolCallName,
        status: "running" as const,
      },
    ],
  };
  return withMessage(state, {
    thoughtGroups: [nextGroup, ...state.message.thoughtGroups.slice(1)],
    parts: nextParts,
    liveStatus: formatToolProgressStatus({ name: event.toolCallName }),
  });
}

function reduceToolCallEnd(
  state: ConversationViewState,
  event: ToolCallEndEvent,
): ConversationViewState {
  const group = state.message.thoughtGroups[0];
  // Orphan TOOL_CALL_END (no prior TOOL_CALL_START) — no-op (matches the
  // `applyToolResultEvent` "no match → original reference" contract).
  if (!group) return state;
  const tc = group.toolCalls.find((t) => t.id === event.toolCallId);
  if (!tc) return state;
  // Already completed — replay no-op (idempotent).
  if (tc.status === "completed") return state;

  // TOOL_CALL_END carries no `resultLabel` — derive the chip label from the
  // tool NAME, exactly the mapping-gap the contract requires.
  const resultLabel = formatToolCallLabel({ name: tc.name, serverLabel: tc.serverLabel });
  const nextParts = applyToolResultEvent(state.message.parts, {
    id: event.toolCallId,
    status: "completed",
    resultLabel,
    serverLabel: tc.serverLabel,
  });
  const nextGroup: UiThoughtGroup = {
    ...group,
    toolCalls: group.toolCalls.map((t) =>
      t.id === event.toolCallId
        ? { ...t, status: "completed" as const, resultLabel, serverLabel: tc.serverLabel }
        : t,
    ),
  };
  return {
    ...state,
    // A tool round just ended → the next text segment gets a paragraph break.
    pendingRoundSeparator: true,
    message: {
      ...state.message,
      thoughtGroups: [nextGroup, ...state.message.thoughtGroups.slice(1)],
      parts: nextParts,
      liveStatus: "Reviewing tool results",
    },
  };
}

function reduceInterrupt(
  state: ConversationViewState,
  event: InterruptEvent,
): ConversationViewState {
  return {
    ...state,
    interrupt: {
      reviewTaskId: event.reviewTaskId,
      xRenderer: event.xRenderer,
      schema: event.schema,
      values: event.values,
      fieldName: event.fieldName,
      threadId: event.threadId,
      runId: event.runId,
    },
    message: { ...state.message, liveStatus: "Waiting for your input" },
  };
}

function reduceResume(state: ConversationViewState): ConversationViewState {
  if (!state.interrupt) return state;
  return {
    ...state,
    interrupt: null,
    message: { ...state.message, liveStatus: "Thinking" },
  };
}

function pinRunIdOnToolCall(
  state: ConversationViewState,
  toolCallId: string,
  runId: string,
): ConversationViewState {
  const parts = state.message.parts.map((p) =>
    p.kind === "tool_call" && p.id === toolCallId ? { ...p, runId } : p,
  );
  const thoughtGroups = state.message.thoughtGroups.map((g) => ({
    ...g,
    // UiToolCall has no runId field; the runId lives on the tool_call PART
    // (which the renderer reads to mount <InlineAgentRunCard runId={...}/>).
    toolCalls: g.toolCalls,
  }));
  return withMessage(state, { parts, thoughtGroups });
}

function reduceDataPart(
  state: ConversationViewState,
  event: DataPartEvent,
): ConversationViewState {
  // NOTE: `partIndex` is a WITHIN-ARTIFACT ordinal (see events.ts) — it is NOT
  // unique across a run, so it is deliberately NOT used as a dedupe key.
  // Idempotence comes from each branch being a natural no-op on replay.
  const data = event.data;

  // Renderable-view classification takes PRECEDENCE over the legacy structural
  // `kind` shapes: any payload carrying a non-empty string `viewType` is a
  // renderable view and MUST reach the interactive layer's dispatch — even if
  // it also happens to carry a legacy `kind` (the S1 contract promises every
  // renderable view registered rendering or the safe fallback, never a silent
  // structural consume). A payload whose classification THROWS (hostile
  // getter / Proxy trap) is treated as a view so the guarded dispatch renders
  // its safe fallback instead of the reducer crashing.
  let isRenderableView: boolean;
  try {
    isRenderableView = renderableViewTypeOf(data) !== undefined;
  } catch {
    isRenderableView = true;
  }

  if (!isRenderableView && isAgentRunDataPart(data)) {
    // Pin the inline agent-run-card runId — the mapping-gap requires this comes
    // from a DATA_PART, NEVER from TOOL_CALL_END.
    const target = state.message.parts.find(
      (p) => p.kind === "tool_call" && p.id === data.toolCallId,
    );
    if (!target) return state; // unknown toolCallId — no-op
    if (target.kind === "tool_call" && target.runId === data.runId) {
      return state; // already pinned — replay no-op
    }
    return pinRunIdOnToolCall(state, data.toolCallId, data.runId);
  }

  if (!isRenderableView && isCitationsDataPart(data)) {
    const normalized = normalizeCitations(data.citations);
    if (normalized.length === 0) return state;
    const merged = mergeCitations(state.message.citations, normalized);
    // mergeCitations dedupes by url; a replay adds nothing → no-op.
    if (merged.length === state.message.citations.length) return state;
    return withMessage(state, { citations: merged });
  }

  // Renderable view or unknown structured payload — carry it through for the
  // interactive layer's renderable-view dispatch. Dedupe by structural
  // equality so a replayed identical payload is a no-op; a payload that fails
  // to serialize (hostile getter / circular) skips dedupe rather than throwing.
  try {
    const serialized = JSON.stringify(data);
    if (
      serialized !== undefined &&
      state.dataParts.some((d) => JSON.stringify(d) === serialized)
    ) {
      return state;
    }
  } catch {
    // Unserializable payload — cannot dedupe structurally; append and let the
    // guarded dispatch render its safe fallback.
  }
  return { ...state, dataParts: [...state.dataParts, data] };
}

function reduceRunError(
  state: ConversationViewState,
  event: RunErrorEvent,
): ConversationViewState {
  return {
    ...state,
    status: "error",
    openTextMessageId: null,
    // A terminal error supersedes any open interrupt — clear the HITL slice so
    // no stale approval form outlives the run (matches the HitlInterruptSlice
    // doc: cleared on RESUME and defensively on RUN_ERROR / RUN_FINISHED).
    interrupt: null,
    message: {
      ...state.message,
      error: extractErrorMessage(event.message),
      errorRaw: event.message,
      liveStatus: undefined,
    },
  };
}

// ── STATE_SNAPSHOT: wholesale rehydrate ──────────────────────────────────────

function isReducedMessage(v: unknown): v is ReducedAssistantMessage {
  if (v === null || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.content === "string" &&
    Array.isArray(m.parts) &&
    Array.isArray(m.thoughtGroups) &&
    Array.isArray(m.citations)
  );
}

/**
 * A STATE_SNAPSHOT replaces the reduced state wholesale (the durable-log resume
 * seam). The snapshot payload is the previously-reduced `ConversationViewState`
 * (or its render-relevant subset). Defensive: an unrecognized snapshot shape is
 * a no-op (keep the current state) rather than a crash.
 */
function reduceStateSnapshot(
  state: ConversationViewState,
  event: StateSnapshotEvent,
): ConversationViewState {
  const snap = event.snapshot;
  if (snap === null || typeof snap !== "object") return state;
  const s = snap as Partial<ConversationViewState>;
  if (!isReducedMessage(s.message)) return state;
  const base = initialConversationState();
  return {
    ...base,
    message: {
      id: typeof s.message.id === "string" ? s.message.id : "",
      role: "assistant",
      content: s.message.content,
      parts: s.message.parts,
      thoughtGroups: s.message.thoughtGroups,
      citations: s.message.citations,
      error: s.message.error,
      errorRaw: s.message.errorRaw,
      liveStatus: s.message.liveStatus,
    },
    interrupt: s.interrupt ?? null,
    dataParts: Array.isArray(s.dataParts) ? s.dataParts : [],
    runId: typeof s.runId === "string" ? s.runId : null,
    threadId: typeof s.threadId === "string" ? s.threadId : null,
    status: s.status ?? "running",
    // Rehydrate the idempotence bookkeeping so a replayed completed prefix
    // after the snapshot does not re-apply.
    openTextMessageId:
      typeof s.openTextMessageId === "string" ? s.openTextMessageId : null,
    sealedMessageIds: Array.isArray(s.sealedMessageIds)
      ? s.sealedMessageIds.filter((x): x is string => typeof x === "string")
      : [],
    pendingRoundSeparator: Boolean(s.pendingRoundSeparator),
  };
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

/**
 * Fold one AG-UI event into the reduced conversation view state. Pure: returns
 * the same reference when an event is a no-op so a consumer memoizing on
 * identity skips a re-render. Every event type in the S1 union has a defined
 * transition (an explicit no-op where the event is non-rendering).
 */
export function agUiReduce(
  state: ConversationViewState,
  event: AgUiEvent,
): ConversationViewState {
  switch (event.type) {
    case "RUN_STARTED":
      // Idempotent: a second RUN_STARTED for the same run does not reset.
      if (state.runId === event.runId && state.status !== "idle") return state;
      return {
        ...state,
        runId: event.runId,
        threadId: event.threadId,
        status: "running",
        message: {
          ...state.message,
          id: state.message.id || event.runId,
          liveStatus: state.message.liveStatus ?? "Thinking",
        },
      };
    case "TEXT_MESSAGE_START":
      return reduceTextStart(state, event);
    case "TEXT_MESSAGE_CONTENT":
      return reduceTextContent(state, event);
    case "TEXT_MESSAGE_END":
      return reduceTextEnd(state, event);
    case "TOOL_CALL_START":
      return reduceToolCallStart(state, event);
    case "TOOL_CALL_END":
      return reduceToolCallEnd(state, event);
    case "INTERRUPT":
      return reduceInterrupt(state, event);
    case "RESUME":
      return reduceResume(state);
    case "DATA_PART":
      return reduceDataPart(state, event);
    case "STATE_SNAPSHOT":
      return reduceStateSnapshot(state, event);
    case "RUN_ERROR":
      return reduceRunError(state, event);
    case "RUN_FINISHED":
      return {
        ...state,
        status: "finished",
        openTextMessageId: null,
        // Clear any open interrupt defensively — a finished run leaves no HITL
        // form outstanding (see the HitlInterruptSlice doc).
        interrupt: null,
        message: { ...state.message, liveStatus: undefined },
      };
    default: {
      // Exhaustiveness guard — a new event type must add a transition here.
      const _never: never = event;
      return _never;
    }
  }
}

/** Fold a whole event sequence from a fresh (or supplied) initial state. */
export function reduceAgUiEvents(
  events: readonly AgUiEvent[],
  initial: ConversationViewState = initialConversationState(),
): ConversationViewState {
  return events.reduce(agUiReduce, initial);
}
