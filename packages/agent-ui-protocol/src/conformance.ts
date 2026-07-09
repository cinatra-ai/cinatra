// ---------------------------------------------------------------------------
// Static conformance surface (cinatra#1217, epic #1216 S1).
//
// The render-parity conformance CI (S6) renders a fixture corpus of AG-UI event
// logs across three targets (`/chat`, the generic embedded view, each CMS
// iframe) and fails on divergence. This module gives S6 its structural
// foundation NOW — before the live assistant producer exists (#1037 P2):
//
//   - `isAgUiEvent`      — structural validator for a single wire event.
//   - `analyzeEventLog`  — turn-shape diagnostics over a whole log (ordering,
//                          terminal, unknown types) without asserting a live run.
//
// Live producer-conformance (a real assistant emitting these events) is gated
// on #1037 P2; STATIC-fixture conformance can begin against this contract today.
//
// Tier-neutral: pure validation, no I/O, no server-only constraint.
// ---------------------------------------------------------------------------

import { AG_UI_EVENT_TYPES, type AgUiEvent, type AgUiEventType } from "./events";
import { TERMINAL_EVENT_TYPES } from "./contract";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const AG_UI_EVENT_TYPE_SET = new Set<string>(AG_UI_EVENT_TYPES);

/** True when `type` is a known AG-UI event type. */
export function isAgUiEventType(type: unknown): type is AgUiEventType {
  return typeof type === "string" && AG_UI_EVENT_TYPE_SET.has(type);
}

/**
 * Structural validator for a single AG-UI wire event. Checks that `type` is a
 * known event type AND that the fields REQUIRED for that type are present and
 * well-typed. Deliberately shallow — it validates the wire envelope, not the
 * semantics of a `DATA_PART` payload or an `INTERRUPT` schema (those are the
 * renderable-view registry's / the renderer's concern). Suitable for gating a
 * fixture corpus and for a producer-side self-check.
 */
export function isAgUiEvent(value: unknown): value is AgUiEvent {
  if (!isRecord(value)) return false;
  const type = value.type;
  if (!isAgUiEventType(type)) return false;

  switch (type) {
    case "RUN_STARTED":
    case "RUN_FINISHED":
      return isNonEmptyString(value.threadId) && isNonEmptyString(value.runId);
    case "RUN_ERROR":
      return (
        isNonEmptyString(value.threadId) &&
        isNonEmptyString(value.runId) &&
        typeof value.message === "string"
      );
    case "TEXT_MESSAGE_START":
    case "TEXT_MESSAGE_END":
      return isNonEmptyString(value.messageId);
    case "TEXT_MESSAGE_CONTENT":
      return isNonEmptyString(value.messageId) && typeof value.delta === "string";
    case "TOOL_CALL_START":
      return (
        isNonEmptyString(value.toolCallId) &&
        isNonEmptyString(value.toolCallName)
      );
    case "TOOL_CALL_END":
      return isNonEmptyString(value.toolCallId);
    case "STATE_SNAPSHOT":
      return "snapshot" in value;
    case "INTERRUPT":
      return (
        isNonEmptyString(value.threadId) &&
        isNonEmptyString(value.runId) &&
        isRecord(value.schema) &&
        isNonEmptyString(value.xRenderer) &&
        isRecord(value.values) &&
        isNonEmptyString(value.reviewTaskId)
      );
    case "RESUME":
      return isNonEmptyString(value.threadId) && isNonEmptyString(value.runId);
    case "DATA_PART":
      return isRecord(value.data);
    default: {
      // Exhaustiveness: every AgUiEventType is handled above.
      const _never: never = type;
      void _never;
      return false;
    }
  }
}

/**
 * One entry of a durable event-log fixture: the wire event plus the optional
 * Redis-Streams cursor it was assigned (`id` is present on replayed logs, and
 * is what a client echoes as `Last-Event-ID` on resume).
 */
export type EventLogEntry = {
  readonly id?: string;
  readonly event: AgUiEvent;
};

/**
 * A named fixture corpus: a map from a scenario name to its ordered event log.
 * S6 extends this seed with live-run captures once #1037 P2 lands.
 */
export type ConformanceCorpus = Readonly<Record<string, readonly AgUiEvent[]>>;

/** Diagnostics describing the turn-shape of an event log. */
export type EventLogAnalysis = {
  readonly count: number;
  /** Indices whose event failed `isAgUiEvent`. */
  readonly invalidIndices: readonly number[];
  /** Event types encountered that are not known AG-UI types. */
  readonly unknownTypes: readonly string[];
  /** True when the first event is `RUN_STARTED`. */
  readonly startsWithRunStarted: boolean;
  /** The terminal event type when the last event is terminal, else null. */
  readonly terminal: (typeof TERMINAL_EVENT_TYPES)[number] | null;
  /**
   * True when the log is a COMPLETE turn: non-empty, all events valid, starts
   * with `RUN_STARTED`, ends with a terminal frame. A partial/streaming prefix
   * (a resumed mid-run capture) is valid-but-not-complete: `complete` is false
   * while `invalidIndices` stays empty.
   */
  readonly complete: boolean;
};

const TERMINAL_SET = new Set<string>(TERMINAL_EVENT_TYPES);

/**
 * Analyze an event log's turn-shape without asserting a live run. Returns
 * structural diagnostics: which entries are malformed, whether it opens with
 * `RUN_STARTED`, whether it closes on a terminal frame, and whether it is a
 * complete turn. A streaming/partial prefix is reported as valid (no invalid
 * indices) but not `complete` — the "resumed/partial stream" conformance case.
 */
export function analyzeEventLog(
  events: readonly unknown[],
): EventLogAnalysis {
  const invalidIndices: number[] = [];
  const unknownTypes = new Set<string>();

  events.forEach((e, i) => {
    if (!isAgUiEvent(e)) {
      invalidIndices.push(i);
      const t = isRecord(e) ? e.type : undefined;
      if (typeof t === "string" && !AG_UI_EVENT_TYPE_SET.has(t)) {
        unknownTypes.add(t);
      }
    }
  });

  const first = events[0];
  const last = events[events.length - 1];
  const startsWithRunStarted =
    isRecord(first) && first.type === "RUN_STARTED";
  const lastType = isRecord(last) && typeof last.type === "string"
    ? last.type
    : undefined;
  const terminal =
    lastType && TERMINAL_SET.has(lastType)
      ? (lastType as (typeof TERMINAL_EVENT_TYPES)[number])
      : null;

  const complete =
    events.length > 0 &&
    invalidIndices.length === 0 &&
    startsWithRunStarted &&
    terminal !== null;

  return {
    count: events.length,
    invalidIndices,
    unknownTypes: [...unknownTypes],
    startsWithRunStarted,
    terminal,
    complete,
  };
}
