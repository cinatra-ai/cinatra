// ---------------------------------------------------------------------------
// Seed conformance fixture corpus (cinatra#1217, epic #1216 S1).
//
// A small, typed corpus of AG-UI event logs — one per renderable class and
// edge case in the epic's render-parity checklist — that exercises the
// contract WITHOUT a live producer. Because each corpus is a typed
// `readonly AgUiEvent[]`, it is compile-checked against the contract itself:
// a breaking change to an event's shape fails the typecheck here. S6 renders
// this corpus across the three targets and extends it with live-run captures
// once #1037 P2 lands.
//
// Tier-neutral: pure data, no I/O, no server-only constraint.
// ---------------------------------------------------------------------------

import type { AgUiEvent } from "./events";
import type { ConformanceCorpus } from "./conformance";
import { renderableViewDataPart } from "./renderable-views";

const THREAD = "thread_fixture";

/**
 * A complete turn covering streamed text, a tool call, and a renderable-view
 * `DATA_PART` (the change-diff, carried as the `content_change_proposal`
 * viewType registered by S4). Opens with `RUN_STARTED`, closes with
 * `RUN_FINISHED`.
 */
export const FIXTURE_FULL_TURN: readonly AgUiEvent[] = [
  { type: "RUN_STARTED", threadId: THREAD, runId: "run_full" },
  { type: "TEXT_MESSAGE_START", messageId: "m1" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Updating the " },
  { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "post title." },
  { type: "TEXT_MESSAGE_END", messageId: "m1" },
  { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "edit_post" },
  { type: "TOOL_CALL_END", toolCallId: "t1" },
  // Renderable view: the change-diff, as a typed DATA_PART payload. S4
  // registered this viewType (`renderable-views/content-change-proposal`), so
  // the payload MUST stay valid against the registered schema: this corpus is
  // what S6 drives through every render target, and an invalid payload would
  // draw the safe unknown-view fallback instead of the proposal card. Locked
  // by the registered-inventory validation block in `conformance.test.ts`.
  renderableViewDataPart({
    viewType: "content_change_proposal",
    schemaVersion: 1,
    fields: [{ field: "title", before: "Old title", after: "New title" }],
    postId: "42",
    // Option A correlation ids (owner decision 2026-07-10, #1220): the card
    // correlates to the draft the agent already saved during the run — the
    // corpus carries them so downstream targets exercise the real wire shape.
    proposalId: "prop_fixture_1",
    changeSetId: "rev_fixture_9",
    rich: false,
  }),
  { type: "RUN_FINISHED", threadId: THREAD, runId: "run_full", status: "completed" },
];

/**
 * A human-in-the-loop turn: an `INTERRUPT` gate (an approval form) followed by
 * `RESUME` and completion. Exercises the interactive HITL renderable.
 */
export const FIXTURE_INTERRUPT_RESUME: readonly AgUiEvent[] = [
  { type: "RUN_STARTED", threadId: THREAD, runId: "run_hitl" },
  {
    type: "INTERRUPT",
    threadId: THREAD,
    runId: "run_hitl",
    schema: { type: "object", properties: { confirm: { type: "boolean" } } },
    // Placeholder renderer id — deliberately NOT a real extension name: a core
    // fixture must route through the manifest/registry, never hardcode a
    // specific extension (core-extension-instance-coupling-ban).
    xRenderer: "@example/hitl-agent:send-confirmation",
    values: { confirm: false },
    reviewTaskId: "review_1",
  },
  { type: "RESUME", threadId: THREAD, runId: "run_hitl", reviewTaskId: "review_1" },
  { type: "RUN_FINISHED", threadId: THREAD, runId: "run_hitl", status: "completed" },
];

/**
 * A run that fails mid-turn — closes on `RUN_ERROR`, the terminal error frame
 * (successor to the bespoke `error` frame).
 */
export const FIXTURE_RUN_ERROR: readonly AgUiEvent[] = [
  { type: "RUN_STARTED", threadId: THREAD, runId: "run_err" },
  { type: "TEXT_MESSAGE_START", messageId: "m1" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Working on it" },
  { type: "TEXT_MESSAGE_END", messageId: "m1" },
  { type: "RUN_ERROR", threadId: THREAD, runId: "run_err", message: "upstream timeout" },
];

/**
 * A streaming/partial prefix: a run captured mid-flight (no terminal frame) —
 * the "resumed/partial stream" case. Structurally valid, deliberately NOT a
 * complete turn.
 */
export const FIXTURE_STREAMING_PARTIAL: readonly AgUiEvent[] = [
  { type: "RUN_STARTED", threadId: THREAD, runId: "run_partial" },
  { type: "TEXT_MESSAGE_START", messageId: "m1" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Half a sen" },
];

/**
 * Hostile/forward-compat edge: a `DATA_PART` carrying a renderable view whose
 * `viewType` is NOT registered (a newer producer), plus a plain `DATA_PART`
 * with no `viewType` at all. A conforming renderer falls back safely for both
 * and never crashes — the "unknown DATA_PART payloads" checklist case.
 */
export const FIXTURE_UNKNOWN_RENDERABLE_VIEW: readonly AgUiEvent[] = [
  { type: "RUN_STARTED", threadId: THREAD, runId: "run_unknown" },
  renderableViewDataPart({
    viewType: "future_view_not_yet_registered",
    payload: { anything: true },
  }),
  { type: "DATA_PART", data: { plain: "structured-data-with-no-viewType" } },
  { type: "RUN_FINISHED", threadId: THREAD, runId: "run_unknown", status: "completed" },
];

/**
 * The seed corpus, keyed by scenario name. S6 renders each across the three
 * targets and compares DOM-normalized + visual snapshots.
 */
export const CONFORMANCE_CORPUS: ConformanceCorpus = {
  full_turn: FIXTURE_FULL_TURN,
  interrupt_resume: FIXTURE_INTERRUPT_RESUME,
  run_error: FIXTURE_RUN_ERROR,
  streaming_partial: FIXTURE_STREAMING_PARTIAL,
  unknown_renderable_view: FIXTURE_UNKNOWN_RENDERABLE_VIEW,
};
