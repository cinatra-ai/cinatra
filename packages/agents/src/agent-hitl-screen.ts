// ---------------------------------------------------------------------------
// THE HITL SCREEN'S SHAPE — what the card is told, and nothing that tells it
// (cinatra#2930, lifecycle-b W3).
//
// PURE ON PURPOSE. The card runs in a browser bundle and the reader runs on a
// server, and the two need the same vocabulary: the state, the gate, and the
// parse that turns a transport answer back into either. Keeping that here — no
// store, no `"use server"`, no React — is what lets the transcript's leaf import
// the shape without dragging the server graph into every consumer that mounts
// the conversation column. The reader itself lives next door in
// `agent-hitl-screen-core.ts`.
// ---------------------------------------------------------------------------

import {
  LIFECYCLE_MOMENT_CARD_KIND,
  type LifecycleCardKind,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";

/** The moment this card is the card OF, and the kind that moment mounts. */
export const AGENT_HITL_MOMENT = "hitl" as const;
export const AGENT_HITL_CARD_KIND: LifecycleCardKind =
  LIFECYCLE_MOMENT_CARD_KIND[AGENT_HITL_MOMENT];

/**
 * The gate the screen asks on — the four fields a renderer needs and nothing
 * else. Deliberately a projection of the run's derived HITL context rather than
 * the whole of it: `childRunId` is an execution detail no drawing reads, and a
 * card should not carry a field it cannot use.
 */
export type AgentHitlScreenGate = {
  /** The review-task identity the answer is submitted against. */
  reviewTaskId: string;
  /** Which renderer draws the fields. Empty ⇒ there is no screen to draw. */
  xRenderer: string;
  /** The schema the renderer draws from. */
  inputSchema: Record<string, unknown>;
  /** What is already filled in. */
  currentValues: Record<string, unknown>;
  /** The setup-loop field identity, or `null` for a mid-run gate. */
  fieldName: string | null;
};

/**
 * What this run's HITL screen is, including "there is none".
 *
 * Two states and only two, on the audit card's precedent: `asking` draws the
 * screen, `none` draws NO DOM AT ALL and is the collapse of every denial.
 */
export type AgentHitlScreenState =
  | { state: "none" }
  | {
      state: "asking";
      runId: string;
      /** The server-checked reference the run recorded for the screen. */
      screenRef: string | null;
      gate: AgentHitlScreenGate;
    };

export const AGENT_HITL_SCREEN_NONE: AgentHitlScreenState = Object.freeze({
  state: "none",
});

/**
 * Does the run STATE that it is at the HITL moment?
 *
 * Both halves are required. The moment says which moment the run is at; the
 * card kind says which card that moment mounts. A row carrying one without the
 * other is a half-written record, and a half-written record is not a moment.
 */
export function runStatesHitlMoment(run: {
  lifecycleMoment?: string | null;
  lifecycleCardKind?: string | null;
}): boolean {
  return (
    run.lifecycleMoment === AGENT_HITL_MOMENT &&
    run.lifecycleCardKind === AGENT_HITL_CARD_KIND
  );
}

/**
 * Parse a transport answer back into the state, or `null` for anything this
 * build cannot read.
 *
 * `null` is a FAILURE, never a state: the card keeps its last authorized answer
 * (or none at all) rather than settling on a shape it did not understand.
 */
export function parseAgentHitlScreenState(data: unknown): AgentHitlScreenState | null {
  if (data === null || typeof data !== "object") return null;
  const state = (data as { state?: unknown }).state;
  if (state === "none") return AGENT_HITL_SCREEN_NONE;
  if (state !== "asking") return null;
  const runId = (data as { runId?: unknown }).runId;
  const gate = (data as { gate?: unknown }).gate;
  if (typeof runId !== "string" || runId.length === 0) return null;
  if (gate === null || typeof gate !== "object") return null;
  const reviewTaskId = (gate as { reviewTaskId?: unknown }).reviewTaskId;
  const xRenderer = (gate as { xRenderer?: unknown }).xRenderer;
  if (typeof reviewTaskId !== "string" || reviewTaskId.length === 0) return null;
  if (typeof xRenderer !== "string" || xRenderer.length === 0) return null;
  const screenRef = (data as { screenRef?: unknown }).screenRef;
  const fieldName = (gate as { fieldName?: unknown }).fieldName;
  const asRecord = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    state: "asking",
    runId,
    screenRef: typeof screenRef === "string" ? screenRef : null,
    gate: {
      reviewTaskId,
      xRenderer,
      inputSchema: asRecord((gate as { inputSchema?: unknown }).inputSchema),
      currentValues: asRecord((gate as { currentValues?: unknown }).currentValues),
      fieldName: typeof fieldName === "string" ? fieldName : null,
    },
  };
}
