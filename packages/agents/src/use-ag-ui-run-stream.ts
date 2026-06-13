"use client";

import { useEffect, useRef, useState } from "react";
import type { PresentationHint } from "./result-renderers";
import type { DataPartEvent } from "@cinatra-ai/agent-ui-protocol";
import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "./agent-builder-ids";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgUiRunStreamOptions = {
  /** Open the EventSource only when true. Pass run.agUiEnabled === true. */
  enabled: boolean;
  /** Initial status — seeded from the DB-backed REST endpoint before the SSE stream opens. Required. */
  initialStatus: string;
  /**
   * DB-seeded initial text for Results-tab hydration on page load.
   * Non-empty only for external runs that completed cleanly (persisted by
   * external-sse-proxy.ts). Empty or absent for internal runs, incomplete
   * externals, and legacy rows. When the SSE stream is open, live TEXT_MESSAGE_*
   * deltas overwrite this seed starting at the reset inside the main useEffect.
   */
  initialStreamedText?: string;
};

export type InterruptContext = {
  schema: Record<string, unknown>;
  xRenderer: string;
  /**
   * May optionally include a ``presentation`` key whose
   * value is a ``PresentationHint``. Consumers (AgenticRunPanel, HitlApprovalPanel)
   * narrow locally via ``(values as { presentation?: PresentationHint }).presentation``
   * and short-circuit to ``<DispatchRenderer hint={...} mode="edit" />`` when set.
   * The hook forwards ``values`` by reference (see INTERRUPT case below) —
   * no restructuring, no key stripping.
   */
  values: Record<string, unknown>;
  reviewTaskId: string;
  /**
   * Schema property name carried on INTERRUPT (5th arg of
   * `AgUiAdapter.onInterrupt`). Set by the setup-loop in execution.ts —
   * tells the chat-side panel which key to wrap primitive onChange values
   * into when calling `approveReviewTask({ [fieldName]: value }, fieldName)`.
   * `undefined` for non-setup-loop INTERRUPTs (WayFlow A2A gates, output
   * renderers) — those paths already operate on full schemas.
   */
  fieldName?: string;
};

export type AgUiRunStreamResult = {
  /** Live run status derived from SSE events. Seeded from options.initialStatus — never null. */
  status: string;
  /** Error message from RUN_ERROR event. Null until failure. */
  error: string | null;
  /** PresentationHint from the latest STATE_SNAPSHOT event. Null until received. */
  presentationHint: PresentationHint | null;
  /** True while status is "running", "queued", or "pending_approval". */
  isLive: boolean;
  /** Active INTERRUPT context when the run is paused for HITL. Null when no interrupt active. */
  interruptContext: InterruptContext | null;
  /**
   * Accumulated text from AG-UI TEXT_MESSAGE_CONTENT deltas.
   * Empty string until the first TEXT_MESSAGE_CONTENT event with a string delta arrives.
   * External A2A runs (helloworld-style peers) surface their output here; internal
   * LangGraph runs never emit TEXT_MESSAGE_* so this stays "".
   */
  streamedText: string;
  /**
   * Structured JSON frames from AG-UI DATA_PART events. Empty
   * array until the first DATA_PART arrives. Non-object payloads are dropped
   * at ingestion (typeof !== "object" OR Array.isArray) so consumers can
   * safely JSON.stringify without a guard.
   */
  dataPartFrames: Record<string, unknown>[];
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Subscribe to the AG-UI SSE stream for a run and derive status + presentationHint.
 *
 * Scope: handles the AG-UI run lifecycle events:
 *   RUN_STARTED, STATE_SNAPSHOT, INTERRUPT, RESUME, RUN_FINISHED, RUN_ERROR.
 *
 * Does NOT build a message array — messages and HITL context come from the
 * existing polling path in AgenticRunPanel. Text/tool event handling will be
 * added in a later phase when the execution engine emits those events.
 *
 * Bootstrap contract: caller must seed options.initialStatus from the DB-backed
 * REST endpoint before this hook is called. The SSE stream is delta-only — it
 * does not replay events that occurred before subscription. status is always a
 * string (seeded from initialStatus) — callers never need a null guard on it.
 */
export function useAgUiRunStream(
  runId: string,
  options: AgUiRunStreamOptions,
): AgUiRunStreamResult {
  const { enabled, initialStatus, initialStreamedText } = options;

  const [status, setStatus] = useState<string>(initialStatus);
  const [error, setError] = useState<string | null>(null);
  const [presentationHint, setPresentationHint] = useState<PresentationHint | null>(null);
  const [interruptContext, setInterruptContext] = useState<InterruptContext | null>(null);
  const [streamedText, setStreamedText] = useState<string>(initialStreamedText ?? "");
  const [dataPartFrames, setDataPartFrames] = useState<Record<string, unknown>[]>([]);

  // Ref to track current EventSource for cleanup — avoids stale closure issues.
  const esRef = useRef<EventSource | null>(null);

  const isLive =
    status === "running" || status === "queued" || status === "pending_approval";

  useEffect(() => {
    if (!enabled) return;

    // reset run-scoped state so prior run output never leaks into a new runId.
    // Reset to the DB seed, not to "". The EventSource opens AFTER
    // this reset; any live TEXT_MESSAGE_CONTENT deltas overwrite the seed via
    // the existing accumulator branches below.
    setStreamedText(initialStreamedText ?? "");
    // Reset data-part frames on runId change to prevent leakage
    // across runs. Must live in the SAME useEffect as setStreamedText for
    // lifecycle parity.
    setDataPartFrames([]);
    setError(null);
    setPresentationHint(null);
    setInterruptContext(null);

    const url = `/api/agents/runs/${encodeURIComponent(runId)}/stream`;
    const es = new EventSource(url);
    esRef.current = es;

    es.onmessage = (ev: MessageEvent<string>) => {
      let event: { type: string; [key: string]: unknown };
      try {
        event = JSON.parse(ev.data) as { type: string; [key: string]: unknown };
      } catch {
        return; // Malformed frame — skip
      }

      switch (event.type) {
        case "RUN_STARTED":
          setStatus("running");
          // Clear stale interrupt context when run (re-)starts — covers the setup-loop
          // path which never emits RESUME before dispatching to LangGraph.
          setInterruptContext(null);
          break;

        case "STATE_SNAPSHOT":
          // Cast is safe — DispatchRenderer has a default:return null for unknown types.
          setPresentationHint((event.snapshot as PresentationHint) ?? null);
          break;

        case "INTERRUPT": {
          // Read the 5th INTERRUPT arg (`fieldName`) that the
          // setup-loop sets on `adapter.onInterrupt(schema, xRenderer, values,
          // reviewTaskId, fieldName)` in execution.ts. Without surfacing it
          // to InterruptCtx, the schema-field-fallback panel had no way to
          // wrap primitive onChange values (`"https://example.com"` string)
          // into the `{[fieldName]: value}` shape that approveReviewTask
          // requires. Without the wrap the setup-loop re-emits the same gate
          // forever because inputParams stays empty (review-task-actions.ts
          // setup-* branch silently no-ops when values is a primitive AND
          // fieldName is undefined).
          const interruptEvent = event as unknown as {
            schema: Record<string, unknown>;
            xRenderer: string;
            values?: Record<string, unknown>;
            reviewTaskId: string;
            fieldName?: string;
          };
          setStatus("pending_approval");
          setInterruptContext({
            schema: interruptEvent.schema,
            xRenderer: interruptEvent.xRenderer || SCHEMA_FIELD_FALLBACK_RENDERER_ID,
            values: interruptEvent.values ?? {},
            reviewTaskId: interruptEvent.reviewTaskId,
            fieldName: interruptEvent.fieldName,
          });
          break;
        }

        case "RESUME": {
          // INTERRUPT and RESUME do NOT close the stream — the run continues
          // and the next RUN_STARTED or terminal event drives the status.
          setInterruptContext(null);
          break;
        }

        case "RUN_FINISHED": {
          const finishedStatus = event.status === "stopped" ? "stopped" : "completed";
          setStatus(finishedStatus);
          es.close();
          esRef.current = null;
          break;
        }

        case "RUN_ERROR":
          setStatus("failed");
          setError(typeof event.message === "string" ? event.message : "Unknown error");
          es.close();
          esRef.current = null;
          break;

        case "TEXT_MESSAGE_START":
          // New message sequence. If we already have
          // accumulated text from a prior sequence, separate with a blank line.
          // On the first sequence (streamedText === ""), keep it empty so no
          // leading newlines appear.
          setStreamedText((prev) => (prev ? prev + "\n\n" : prev));
          break;

        case "TEXT_MESSAGE_CONTENT": {
          // AG-UI protocol: `delta` is the incremental chunk. Defensive narrowing
          // matches the RUN_ERROR pattern above (`typeof event.message === "string"`).
          const delta = typeof event.delta === "string" ? event.delta : "";
          if (delta.length > 0) setStreamedText((prev) => prev + delta);
          break;
        }

        case "TEXT_MESSAGE_END":
          // No-op — content is already accumulated via TEXT_MESSAGE_CONTENT.
          break;

        case "DATA_PART": {
          const data = (event as { data?: unknown }).data;
          // Narrow to plain object. Arrays, primitives, null, and undefined drop silently.
          if (data && typeof data === "object" && !Array.isArray(data)) {
            setDataPartFrames((prev) => [...prev, data as Record<string, unknown>]);
          }
          break;
        }

        default:
          // Unknown or future event types (TOOL_CALL_*) — silently skip.
          break;
      }
    };

    es.onerror = () => {
      // do NOT read `status` here — the closure is seeded when the
      // effect ran and will be stale after state updates. EventSource auto-
      // reconnects on transient transport errors. Terminal events (RUN_FINISHED,
      // RUN_ERROR) close the stream explicitly from their handlers above, so by
      // the time onerror fires after a terminal event the status is already
      // correct. No fallback work is needed here.
    };

    return () => {
      es.close();
      esRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, enabled, initialStreamedText]); // Re-seed on prop change

  return { status, error, presentationHint, isLive, interruptContext, streamedText, dataPartFrames };
}
