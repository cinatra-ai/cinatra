// ---------------------------------------------------------------------------
// Bespoke-sink → AG-UI producer adapter (cinatra#1218, epic #1216 S2).
// ---------------------------------------------------------------------------
// `runAssistantTurn` (the #1037 P2 assistant runtime) emits the BESPOKE sink
// vocabulary — `text` / `thinking_start` / `thinking_end` / `tool_call` /
// `tool_result` / `citations` / `error` / `done` — via its `send(event, data)`
// ChatStreamSink. This adapter wraps a durable-log `publish(AgUiEvent)` into
// that sink shape, mapping the bespoke vocabulary onto the S1 AG-UI event
// union (@cinatra-ai/agent-ui-protocol) so the runtime becomes an AG-UI
// producer WITHOUT the runtime module changing (keeping the locked /api/mcp
// route graph flat — the runtime is reachable from the MCP chat handlers).
//
// The mapping is the EXACT inverse the S3 reducer contract ratifies
// (packages/chat/src/renderer/ag-ui-reducer.ts — "the bespoke → AG-UI mapping
// gaps"):
//   text            → TEXT_MESSAGE_START (fresh per-segment messageId) +
//                     TEXT_MESSAGE_CONTENT deltas
//   tool_call       → seal any open text segment (TEXT_MESSAGE_END), then
//                     TOOL_CALL_START { toolCallId, toolCallName }
//   tool_result     → TOOL_CALL_END { toolCallId } — deliberately NO
//                     resultLabel/serverLabel/result payload (the ratified
//                     gap: chip labels derive from the tool NAME client-side);
//                     when the tool is `agent_run` and its result carries a
//                     runId, a `DATA_PART { kind: "agent_run", toolCallId,
//                     runId }` follows so the client pins the inline run card
//                     (NEVER from TOOL_CALL_END — the reducer contract).
//   thinking_start/ → dropped: AG-UI has no thinking frames. The tool-round
//   thinking_end      paragraph separator keys on TOOL_CALL_END client-side.
//   citations       → DATA_PART { kind: "citations", citations }
//   error           → seal open text, RUN_ERROR (terminal)
//   done            → seal open text, RUN_FINISHED (terminal)
//
// FRESH SEGMENT IDS (parity-critical): the reducer permanently seals a
// messageId at TEXT_MESSAGE_END — a replayed START for a sealed id is a no-op.
// So every text segment after a seal gets a NEW messageId
// (`${runId}#t<n>`); reusing one id would silently drop all post-tool text.
//
// TERMINAL EXACTLY-ONCE: the first terminal (RUN_ERROR / RUN_FINISHED) wins;
// every later sink event is ignored (the runtime's `catch` can follow its own
// `error` with nothing else, and `done` after `error` must not resurrect the
// run). The ROUTE owns the guarantee that a terminal is always published:
// `ensureTerminal()` covers runtime paths that return without `done` (the
// explicit-dispatch short-circuits and the pre-`try` error returns).
//
// SERIALIZED, AWAITED PUBLISHES: sink calls are synchronous (the runtime fires
// them from stream callbacks); publishes are chained so the durable log
// receives events IN ORDER. A publish failure marks the adapter broken —
// `drain()` rethrows it so the route can surface a transport-level failure
// instead of hanging a subscriber that will never see a terminal frame.
//
// Pure module: no imports beyond the S1 event types. Unit-tested in
// __tests__/ag-ui-sink-adapter.test.ts and exercised end-to-end by the S2
// parity gate (__tests__/ag-ui-cutover-parity.test.ts).
// ---------------------------------------------------------------------------

import type { AgUiEvent } from "@cinatra-ai/agent-ui-protocol";

export type AgUiPublish = (event: AgUiEvent) => Promise<void>;

export type AgUiSinkAdapter = {
  /** ChatStreamSink-shaped sink to hand to `runAssistantTurn`. */
  send: (event: string, data: unknown) => void;
  /** Publish RUN_STARTED. Call once, before the runtime runs. */
  start: () => void;
  /**
   * Guarantee exactly one terminal frame: publishes RUN_ERROR(message) when
   * given a message, else RUN_FINISHED — unless a terminal was already
   * emitted. Call after the runtime resolves (covers `done`-less returns) or
   * throws.
   */
  ensureTerminal: (errorMessage?: string) => void;
  /**
   * Await every queued publish. Rethrows the FIRST publish failure (the
   * durable log is the wire — a lost append means subscribers never complete).
   */
  drain: () => Promise<void>;
  /** True once a terminal frame (RUN_ERROR / RUN_FINISHED) has been queued. */
  readonly terminal: boolean;
  /** "error" | "completed" once terminal; null while running. */
  readonly outcome: "completed" | "error" | null;
};

/** Parse an `agent_run` tool result for the runId to pin on the run card.
 *  Mirrors the legacy client's `extractAgentRunId` (defensive: silent null). */
export function extractAgentRunIdFromResult(result: unknown): string | null {
  if (typeof result !== "string") return null;
  try {
    const parsed = JSON.parse(result) as { runId?: unknown };
    if (typeof parsed.runId === "string" && parsed.runId.length > 0) {
      return parsed.runId;
    }
  } catch {
    // Not JSON — no run pointer.
  }
  return null;
}

export function createAgUiSinkAdapter(params: {
  runId: string;
  threadId: string;
  publish: AgUiPublish;
  /** Invoked ONCE, on the FIRST publish failure (the wire is broken for this
   *  run). Lets the route abort the runtime + the log tail immediately
   *  instead of discovering the failure only at drain(). */
  onPublishFailure?: (error: unknown) => void;
}): AgUiSinkAdapter {
  const { runId, threadId, publish, onPublishFailure } = params;

  let openMessageId: string | null = null;
  let segmentCounter = 0;
  let terminal = false;
  let outcome: "completed" | "error" | null = null;
  let chain: Promise<void> = Promise.resolve();
  // Separate broken flag: a thrown `null`/`undefined` must still trip the
  // sentinel (never keyed on the error VALUE).
  let broken = false;
  let publishError: unknown = null;

  function emit(event: AgUiEvent): void {
    chain = chain.then(async () => {
      if (broken) return; // broken wire — stop appending
      try {
        await publish(event);
      } catch (err) {
        broken = true;
        publishError = err;
        try {
          onPublishFailure?.(err);
        } catch {
          // The failure hook must never break the chain.
        }
      }
    });
  }

  function sealOpenText(): void {
    if (openMessageId === null) return;
    emit({ type: "TEXT_MESSAGE_END", messageId: openMessageId, timestamp: Date.now() });
    openMessageId = null;
  }

  function emitTerminal(kind: "finished" | "error", message?: string): void {
    if (terminal) return;
    terminal = true;
    sealOpenText();
    if (kind === "error") {
      outcome = "error";
      emit({
        type: "RUN_ERROR",
        threadId,
        runId,
        message: message ?? "Chat request failed.",
        timestamp: Date.now(),
      });
    } else {
      outcome = "completed";
      emit({
        type: "RUN_FINISHED",
        threadId,
        runId,
        status: "completed",
        timestamp: Date.now(),
      });
    }
  }

  function send(event: string, data: unknown): void {
    if (terminal) return; // terminal exactly-once: later sink events are ignored
    const d = (data ?? {}) as Record<string, unknown>;
    switch (event) {
      case "text": {
        const delta = typeof d.content === "string" ? d.content : "";
        if (!delta) return;
        if (openMessageId === null) {
          segmentCounter += 1;
          openMessageId = `${runId}#t${segmentCounter}`;
          emit({ type: "TEXT_MESSAGE_START", messageId: openMessageId, timestamp: Date.now() });
        }
        emit({
          type: "TEXT_MESSAGE_CONTENT",
          messageId: openMessageId,
          delta,
          timestamp: Date.now(),
        });
        return;
      }
      case "tool_call": {
        const id = typeof d.id === "string" ? d.id : String(d.id ?? "");
        const name = typeof d.name === "string" ? d.name : String(d.name ?? "");
        if (!id || !name) return;
        sealOpenText();
        emit({ type: "TOOL_CALL_START", toolCallId: id, toolCallName: name, timestamp: Date.now() });
        return;
      }
      case "tool_result": {
        const id = typeof d.id === "string" ? d.id : String(d.id ?? "");
        if (!id) return;
        sealOpenText();
        emit({ type: "TOOL_CALL_END", toolCallId: id, timestamp: Date.now() });
        // agent_run results carry the spawned run's id — pinned client-side on
        // the tool_call part via DATA_PART (the reducer contract's only
        // sanctioned source for the inline-run-card runId).
        if (d.name === "agent_run") {
          const agentRunId = extractAgentRunIdFromResult(d.result);
          if (agentRunId) {
            emit({
              type: "DATA_PART",
              data: { kind: "agent_run", toolCallId: id, runId: agentRunId },
              timestamp: Date.now(),
            });
          }
        }
        return;
      }
      case "citations": {
        emit({
          type: "DATA_PART",
          data: { kind: "citations", citations: d.citations ?? [] },
          timestamp: Date.now(),
        });
        return;
      }
      case "thinking_start":
      case "thinking_end":
        // No AG-UI equivalent (ratified mapping gap) — the client keys the
        // tool-round separator on TOOL_CALL_END.
        return;
      case "error": {
        const message = typeof d.message === "string" ? d.message : "Chat request failed.";
        emitTerminal("error", message);
        return;
      }
      case "done": {
        emitTerminal("finished");
        return;
      }
      default:
        // Unknown bespoke event — never crash the producer over vocabulary
        // drift; the durable log simply doesn't carry it.
        return;
    }
  }

  return {
    send,
    start(): void {
      emit({ type: "RUN_STARTED", threadId, runId, timestamp: Date.now() });
    },
    ensureTerminal(errorMessage?: string): void {
      emitTerminal(errorMessage !== undefined ? "error" : "finished", errorMessage);
    },
    async drain(): Promise<void> {
      await chain;
      if (broken) {
        throw publishError instanceof Error
          ? publishError
          : new Error("assistant stream durable publish failed");
      }
    },
    get terminal(): boolean {
      return terminal;
    },
    get outcome(): "completed" | "error" | null {
      return outcome;
    },
  };
}
