// ---------------------------------------------------------------------------
// AG-UI event types for @cinatra-ai/agent-ui-protocol
// Plain TypeScript types — no zod import, no server-only constraint.
// ---------------------------------------------------------------------------

export const AG_UI_EVENT_TYPES = [
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
  "DATA_PART", // local extension for structured JSON payloads from A2A data parts
] as const;

export type AgUiEventType = (typeof AG_UI_EVENT_TYPES)[number];

type BaseAgUiEvent = {
  timestamp?: number;
};

export type RunStartedEvent = BaseAgUiEvent & {
  type: "RUN_STARTED";
  threadId: string;
  runId: string;
};

export type RunFinishedEvent = BaseAgUiEvent & {
  type: "RUN_FINISHED";
  threadId: string;
  runId: string;
  status?: "completed" | "stopped";
};

export type RunErrorEvent = BaseAgUiEvent & {
  type: "RUN_ERROR";
  threadId: string;
  runId: string;
  message: string;
  /**
   * OPTIONAL stable machine-readable classification of the failure
   * (cinatra#2390 S5 — classified runtime recovery): a domain error code such
   * as `anthropic_skill_not_synced`, or the fallback `assistant_run_failed`.
   * Absent on producers that predate the classification; consumers must treat
   * absence as unclassified, never as success.
   */
  code?: string;
};

export type TextMessageStartEvent = BaseAgUiEvent & {
  type: "TEXT_MESSAGE_START";
  messageId: string;
};

export type TextMessageContentEvent = BaseAgUiEvent & {
  type: "TEXT_MESSAGE_CONTENT";
  messageId: string;
  delta: string;
};

export type TextMessageEndEvent = BaseAgUiEvent & {
  type: "TEXT_MESSAGE_END";
  messageId: string;
};

export type ToolCallStartEvent = BaseAgUiEvent & {
  type: "TOOL_CALL_START";
  toolCallId: string;
  toolCallName: string;
};

export type ToolCallEndEvent = BaseAgUiEvent & {
  type: "TOOL_CALL_END";
  toolCallId: string;
};

export type StateSnapshotEvent = BaseAgUiEvent & {
  type: "STATE_SNAPSHOT";
  snapshot: unknown;
};

export type InterruptEvent = BaseAgUiEvent & {
  type: "INTERRUPT";
  threadId: string;
  runId: string;
  /** JSON Schema describing the input the renderer needs. */
  schema: Record<string, unknown>;
  /** Namespaced renderer ID, e.g. "@cinatra-ai/email-delivery-agent:send-confirmation". */
  xRenderer: string;
  /**
   * Current field values pre-populated for the renderer. Empty object when none.
   *
   * May optionally include a ``presentation`` key whose value is a
   * ``PresentationHint``-shaped object (discriminated union: ``contacts_table`` |
   * ``card_list`` | ``text_sections`` | ``tool_call_summary``; see
   * ``packages/agent-builder/src/result-renderers``). When present, the A2UI
   * adapter and the frontend HITL renderer both route through
   * ``translateHintToA2UiMessages`` / ``DispatchRenderer`` instead of the
   * per-xRenderer dispatch table. Consumers narrow locally with
   * ``(values as { presentation?: PresentationHint }).presentation`` and also
   * verify ``typeof presentation.type === "string"`` to reject arrays and
   * shape-less objects.
   *
   * NOTE: ``PresentationHint`` is intentionally NOT imported here — this module
   * is plain-types (no zod, no server-only, no cross-package type dependency).
   * Keeping the field as ``Record<string, unknown>`` preserves that constraint.
   */
  values: Record<string, unknown>;
  /** Opaque identifier the client passes back on RESUME to route approveReviewTask. */
  reviewTaskId: string;
  /**
   * Setup-field name the interrupt is gated on. When present, the UI approval
   * flow forwards it back to `approveReviewTaskInternal` as the `fieldName`
   * argument so the langgraph path can merge into `agent_runs.inputParams`
   * WITHOUT re-reading `planned_action.provenance`. Optional — absent for legacy
   * paths.
   */
  fieldName?: string;
  /**
   * OPTIONAL typed lifecycle-interaction discriminator (cinatra#2568, epic
   * #2564 S4). Present ONLY on an interrupt that carries a lifecycle
   * interaction whose declared carriage is `interrupt` — today the run-start
   * `recommendation_hold`. Absent on every ordinary review-task gate, which is
   * what keeps the addition handshake-compatible: the event union gains one
   * optional key, no existing key moves, and no contract version bumps.
   *
   * ROUTING RULE: an interrupt carrying this field is NOT a review task and
   * must never be submitted to the review-task approve path; it routes by
   * `kind` to that interaction's own decision actions. An interrupt WITHOUT it
   * keeps exactly today's behaviour.
   *
   * `ref` is an OPAQUE, server-minted handle to the interaction instance — it
   * addresses a row and grants nothing; the card resolves the authoritative
   * state server-side against the reader. No state, no content, no ids ride
   * here.
   *
   * NOTE: typed structurally rather than by importing
   * `LifecycleInterruptInteraction` — this module is deliberately plain-types
   * (no zod, no server-only, no cross-module dependency), the same constraint
   * that keeps `values`' presentation hint a bare `Record`. The validator is
   * `lifecycleInterruptInteractionSchema` / `readLifecycleInterruptInteraction`
   * in `renderable-views/lifecycle-cards.ts`; consumers narrow through it and
   * never hand-read these fields.
   */
  interaction?: {
    kind: string;
    schemaVersion: number;
    ref: string;
  };
};

export type ResumeEvent = BaseAgUiEvent & {
  type: "RESUME";
  threadId: string;
  runId: string;
  /** reviewTaskId from the paired INTERRUPT event. Optional — not required by the client reducer. */
  reviewTaskId?: string;
  /**
   * The typed lifecycle-interaction discriminator of the interaction this
   * RESUME RETIRES (cinatra#2568) — same shape and same rules as the INTERRUPT
   * field above.
   *
   * PAIRING, not decoration: a RESUME that carries it retires THAT interaction
   * and nothing else, and a RESUME WITHOUT it retires only an ordinary
   * review-task gate. Without the pairing, an unrelated gate's RESUME would
   * clear a live hold's card (and a stale hold's RESUME would clear the current
   * hold), which is precisely the "the wire says the run was freed while it is
   * still waiting" failure this program refuses.
   */
  interaction?: {
    kind: string;
    schemaVersion: number;
    ref: string;
  };
};

/**
 * Local extension carrying a single structured JSON payload emitted when an
 * external A2A artifact-update contains a `{ kind: "data", data }` part.
 * Mirrors the INTERRUPT/RESUME pattern: this is NOT in the upstream AG-UI spec
 * (which uses CUSTOM for arbitrary payloads) but is the established Cinatra
 * extension idiom. Consumers narrow `data` with `typeof === "object" &&
 * !Array.isArray` before using.
 */
export type DataPartEvent = BaseAgUiEvent & {
  type: "DATA_PART";
  /** Structured JSON payload from an A2A artifact part with `kind: "data"`. */
  data: Record<string, unknown>;
  /** Zero-based index of the part within its source artifact. Optional — the bridge emits it for ordering. */
  partIndex?: number;
  /**
   * SLOT IDENTITY — the id of the tool call this part was PRODUCED BY
   * (cinatra#2827, epic #2784 S9i). Optional, and absent on every part that has
   * no producing call (a citations part, an A2A artifact part, a bridge part).
   *
   * WHY IT IS ON THE EVENT AND NOT IN `data`. A renderable-view payload is
   * validated by a `.strict()` schema whose whole point is "the wire payload is
   * a ref, never content" — a producer may not attach a field to it, and the
   * lifecycle kinds refuse one that tries. The slot is not part of the payload:
   * it says WHERE in the turn the part was produced, which is transport
   * information about the event, exactly like `partIndex` beside it. Putting it
   * here keeps the payload byte-identical to what a strict parser already
   * accepts, and lets a consumer read the slot WITHOUT parsing the payload.
   *
   * WHAT A CONSUMER DOES WITH IT. A renderable view carrying one belongs in the
   * ordered trace at that call's own position rather than appended after it, so
   * the card the person is asked to act on sits at the step that produced it. A
   * consumer that does not know this field, or receives an id matching no tool
   * call it holds, keeps EXACTLY the previous behaviour (the view is carried as
   * a turn-level adjunct) — the field adds a position, it never gates a render.
   *
   * Handshake-compatible: additive and optional, so every already-published
   * event stays valid, `isAgUiEvent` accepts both shapes, and the contract
   * version does not move (CONTRACT.md §8).
   *
   * NOT AN AUTHORIZATION. Like every other id on this wire it is an opaque
   * correlation string; forging one buys a card drawn at the wrong step of the
   * forger's own turn and nothing else, because what the card may show is
   * re-authorized server-side from its ref on every resolve.
   */
  toolCallId?: string;
};

export type AgUiEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallEndEvent
  | StateSnapshotEvent
  | InterruptEvent
  | ResumeEvent
  | DataPartEvent; // local DATA_PART extension
